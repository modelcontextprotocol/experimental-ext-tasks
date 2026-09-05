import type { JsonValue } from "../core/index.js";
import { ToolV1Schema, type ToolV1 } from "../core/v1/index.js";
import { ToolV2Schema, type ToolV2 } from "../core/v2/index.js";
import type { z } from "zod/v4";
import { JsonRpcResponseError, type ToolDeclarationProvider } from "./api.js";
import type { ConnectedMcpSessionPort } from "./port.js";
import { throwIfAborted } from "./input-routing.js";

const ToolV1Parser = ToolV1Schema as unknown as z.ZodType<unknown>;
const ToolV2Parser = ToolV2Schema as unknown as z.ZodType<unknown>;

export class ManagedToolDeclarations implements ToolDeclarationProvider {
  private tools = new Map<string, ToolV1 | ToolV2>();
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

  currentTool(name: string): ToolV1 | ToolV2 | undefined {
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
      onAbort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted", "AbortError"),
        );
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
    const decoded = new Map<string, ToolV1 | ToolV2>();
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
      const generation = (
        this.port.taskCapabilities as {
          readonly generation: "none" | "v1" | "v2";
        }
      ).generation;
      for (const value of listed) {
        const parsed =
          generation === "v1"
            ? ToolV1Parser.safeParse(value)
            : generation === "v2"
              ? ToolV2Parser.safeParse(value)
              : (() => {
                  const v2 = ToolV2Parser.safeParse(value);
                  return v2.success ? v2 : ToolV1Parser.safeParse(value);
                })();
        if (!parsed.success) throw parsed.error;
        const tool = parsed.data as ToolV1 | ToolV2;
        if (decoded.has(tool.name)) {
          this.reportError(
            new Error(`Duplicate tool declaration: ${tool.name}`),
          );
        }
        decoded.set(tool.name, tool);
      }
      cursor =
        typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    if (sequence === this.refreshSequence) this.tools = decoded;
  }
}
