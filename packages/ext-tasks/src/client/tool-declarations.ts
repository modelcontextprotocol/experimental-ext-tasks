import type { JsonValue } from "../core/index.js";
import { ToolV1Schema } from "../core/v1/index.js";
import { ToolV2Schema } from "../core/v2/index.js";
import {
  JsonRpcResponseError,
  type ToolDeclaration,
  type ToolDeclarationProvider,
} from "./api.js";
import { projectTool } from "./internal.js";
import type { ConnectedMcpSessionPort } from "./port.js";
import { throwIfAborted } from "./input-routing.js";

export class ManagedToolDeclarations implements ToolDeclarationProvider {
  private tools = new Map<string, ToolDeclaration>();
  private refreshSequence = 0;
  private refreshController: AbortController | undefined;
  private initialReady: Promise<void>;
  private closed = false;

  constructor(
    private readonly port: ConnectedMcpSessionPort,
    private readonly reportError: (error: Error) => void,
  ) {
    this.initialReady = this.refresh();
    void this.initialReady.catch(() => {});
  }

  currentTool(name: string): ToolDeclaration | undefined {
    return this.tools.get(name);
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const wait = async (): Promise<void> => {
      try {
        await this.initialReady;
      } catch (error) {
        if (
          this.closed ||
          (error instanceof DOMException && error.name === "AbortError")
        )
          throw error;
        this.initialReady = this.refresh();
        void this.initialReady.catch(() => {});
        await this.initialReady;
      }
    };
    const waiting = wait();
    if (signal === undefined) return waiting;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted", "AbortError"),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([waiting, aborted]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.refreshController?.abort();
  }

  onNotification(notification: JsonValue): void {
    if (this.closed) return;
    if (
      notification === null ||
      Array.isArray(notification) ||
      typeof notification !== "object"
    )
      return;
    const record = notification as Readonly<Record<string, JsonValue>>;
    if (record.method !== "notifications/tools/list_changed") return;
    void this.refresh().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.reportError(
          error instanceof Error
            ? error
            : new Error("Tool refresh failed", { cause: error }),
        );
      }
    });
  }

  private async refresh(): Promise<void> {
    if (this.closed)
      throw new DOMException("Tool declarations are closed", "AbortError");
    const sequence = ++this.refreshSequence;
    this.refreshController?.abort();
    const controller = new AbortController();
    this.refreshController = controller;
    const decoded = new Map<string, ToolDeclaration>();
    let cursor: string | undefined;
    do {
      const response = await this.port.dispatch(
        {
          method: "tools/list",
          params: cursor === undefined ? {} : { cursor },
        },
        { signal: controller.signal },
      );
      if (response.kind === "error")
        throw new JsonRpcResponseError(response.error);
      if (
        response.result === null ||
        Array.isArray(response.result) ||
        typeof response.result !== "object"
      ) {
        throw new Error("tools/list result must be an object");
      }
      const result = response.result as Readonly<Record<string, JsonValue>>;
      const listed = result.tools;
      if (!Array.isArray(listed))
        throw new Error("tools/list result must contain tools");
      const generation = this.port.taskCapabilities.generation;
      for (const value of listed) {
        let declaration: ToolDeclaration;
        if (generation === "v1") {
          const parsed = ToolV1Schema.safeParse(value);
          if (!parsed.success) throw parsed.error;
          declaration = projectTool(parsed.data);
        } else {
          const parsed = ToolV2Schema.safeParse(value);
          if (!parsed.success) throw parsed.error;
          declaration = projectTool(parsed.data);
        }
        if (decoded.has(declaration.name))
          throw new Error(`Duplicate tool declaration: ${declaration.name}`);
        decoded.set(declaration.name, declaration);
      }
      cursor =
        typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    if (sequence === this.refreshSequence) this.tools = decoded;
  }
}
