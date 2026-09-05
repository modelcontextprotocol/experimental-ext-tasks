/** Requester-side MCP Tasks session and execution support. */

import {
  isJsonValue,
  type JsonValue,
  type RuntimeCodec,
  type TaskGeneration,
  type TaskId,
  type TaskSnapshot,
} from "../core/index.js";
import {
  CallToolResultV1Codec,
  CreateTaskResultV1Codec,
  ToolV1Codec,
  shouldCallToolAsTaskV1,
  type CallToolResultV1,
  type ServerTaskCapabilitiesV1,
  type TaskEligibleMethodV1,
  type ToolV1,
} from "../core/v1/index.js";
import {
  CallToolResultV2Codec,
  ToolV2Codec,
  isCreateTaskResultV2,
  type CallToolResultV2,
  type ErrorV2,
  type TaskExtensionCapabilitiesV2,
  type TaskEligibleMethodV2,
  type ToolV2,
} from "../core/v2/index.js";

export type SessionTaskCapabilities =
  | { readonly generation: "none" }
  | {
      readonly generation: "v1";
      readonly capabilities: ServerTaskCapabilitiesV1;
    }
  | {
      readonly generation: "v2";
      readonly capabilities: TaskExtensionCapabilitiesV2;
    };

export type JsonRpcResponse =
  | { readonly kind: "result"; readonly result: JsonValue }
  | { readonly kind: "error"; readonly error: ErrorV2 };

export interface IncomingServerRequest {
  readonly request: JsonValue;
  readonly requestContext: unknown;
}

export interface ConnectedMcpSessionPort {
  readonly taskCapabilities: SessionTaskCapabilities;
  dispatch(
    request: JsonValue,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JsonRpcResponse>;
  onServerRequest(
    handler: (incoming: IncomingServerRequest) => Promise<JsonRpcResponse>,
  ): () => void;
  onNotification(listener: (notification: JsonValue) => void): () => void;
  onInvalidated(listener: (reason: unknown) => void): () => void;
  readonly invalidated: boolean;
}

export class DispatchError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "DispatchError";
    this.retryable = retryable;
  }
}

export class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data?: JsonValue;
  readonly response: ErrorV2;

  constructor(error: ErrorV2, options?: ErrorOptions) {
    super(error.message, options);
    this.name = "JsonRpcResponseError";
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
    this.response = error;
  }
}

export interface ToolDeclarationProvider {
  currentTool(name: string): ToolV1 | ToolV2 | undefined;
}

export type ApplicationInputRequest =
  | {
      readonly kind: "elicitation";
      readonly params: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly kind: "sampling";
      readonly params: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly kind: "roots";
      readonly params?: Readonly<Record<string, JsonValue>>;
    };

export interface ApplicationElicitResult {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Readonly<Record<string, JsonValue>>;
}

export type ApplicationCreateMessageResult = Readonly<
  Record<string, JsonValue>
> & {
  readonly model: string;
  readonly role: "assistant" | "user";
  readonly content: JsonValue;
};

export interface ApplicationListRootsResult {
  readonly roots: readonly Readonly<Record<string, JsonValue>>[];
}

export type ApplicationInputResult<TRequest extends ApplicationInputRequest> =
  TRequest extends { readonly kind: "elicitation" }
    ? ApplicationElicitResult
    : TRequest extends { readonly kind: "sampling" }
      ? ApplicationCreateMessageResult
      : TRequest extends { readonly kind: "roots" }
        ? ApplicationListRootsResult
        : never;

export type ResolvedInputExchangeContext<TApplicationContext = void> =
  | {
      readonly lifetime: "basic";
      readonly executionId: string;
      readonly applicationContext: TApplicationContext;
      readonly signal?: AbortSignal;
    }
  | {
      readonly lifetime: "task-v1";
      readonly taskId: string;
      readonly applicationContext: TApplicationContext;
      readonly signal?: AbortSignal;
    }
  | {
      readonly lifetime: "task-v2";
      readonly taskId: string;
      readonly inputKey: string;
      readonly applicationContext: TApplicationContext;
      readonly signal?: AbortSignal;
    };

export interface ApplicationInputHandler<TApplicationContext = void> {
  handle<TRequest extends ApplicationInputRequest>(
    request: TRequest,
    context: ResolvedInputExchangeContext<TApplicationContext>,
  ): Promise<ApplicationInputResult<TRequest>>;
}

export type InputCorrelationFailureReason =
  | "missing-evidence"
  | "invalid-evidence"
  | "zero-matches"
  | "ambiguous-matches";

export interface InputCorrelationCandidate<TApplicationContext = void> {
  readonly generation: TaskGeneration;
  readonly toolName: string;
  readonly executionId: string;
  readonly applicationContext: TApplicationContext;
}

export class InputCorrelationError<TApplicationContext = void> extends Error {
  constructor(
    readonly generation: TaskGeneration,
    readonly requestKind: ApplicationInputRequest["kind"],
    readonly candidates: readonly InputCorrelationCandidate<TApplicationContext>[],
    readonly reason: InputCorrelationFailureReason,
  ) {
    super(`Input request correlation failed: ${reason}`);
    this.name = "InputCorrelationError";
  }
}

export interface WithTasksOptions<TApplicationContext = void> {
  readonly tools?: ToolDeclarationProvider;
  readonly onInputRequest?: ApplicationInputHandler<TApplicationContext>["handle"];
  readonly onError?: (error: Error) => void;
  readonly signal?: AbortSignal;
}

export type { TaskEligibleMethodV2 } from "../core/v2/index.js";

export type TaskHandle =
  | {
      readonly generation: "v1";
      readonly taskId: TaskId;
      readonly originalOperation: TaskEligibleMethodV1;
    }
  | {
      readonly generation: "v2";
      readonly taskId: TaskId;
      readonly originalOperation: TaskEligibleMethodV2;
    };

export interface ToolExecutionCommon<TResult, TApplicationContext = void> {
  readonly applicationContext: TApplicationContext;
  updates(signal?: AbortSignal): AsyncIterable<TaskSnapshot>;
  result(): Promise<TResult>;
  cancel(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type ToolExecution<TResult, TApplicationContext = void> =
  | (ToolExecutionCommon<TResult, TApplicationContext> & {
      readonly kind: "immediate";
      readonly handle?: undefined;
    })
  | (ToolExecutionCommon<TResult, TApplicationContext> & {
      readonly kind: "task";
      readonly handle: TaskHandle;
    });

export class TaskUpdatesAlreadyAcquiredError extends Error {
  constructor() {
    super("Task updates have already been acquired");
    this.name = "TaskUpdatesAlreadyAcquiredError";
  }
}

export class TaskExecutionClosedError extends Error {
  constructor() {
    super("Task execution is closed");
    this.name = "TaskExecutionClosedError";
  }
}

export interface TaskEnabledSession<TApplicationContext = void> {
  callTool<TResult = CallToolResultV1 | CallToolResultV2>(
    name: string,
    params?: Readonly<Record<string, JsonValue>>,
    options?: {
      readonly resultCodec?: RuntimeCodec<TResult>;
      readonly applicationContext?: TApplicationContext;
      readonly signal?: AbortSignal;
      readonly preferTask?: boolean;
    },
  ): Promise<ToolExecution<TResult, TApplicationContext>>;
  resumeTask<TResult = CallToolResultV1 | CallToolResultV2>(
    reference: SerializedTaskReference,
    options?: {
      readonly resultCodec?: RuntimeCodec<TResult>;
      readonly applicationContext?: TApplicationContext;
      readonly signal?: AbortSignal;
    },
  ): Promise<ToolExecution<TResult, TApplicationContext>>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type SerializedTaskReference =
  | {
      readonly endpointId: string;
      readonly generation: "v1";
      readonly taskId: TaskId;
      readonly originalOperation: TaskEligibleMethodV1;
    }
  | {
      readonly endpointId: string;
      readonly generation: "v2";
      readonly taskId: TaskId;
      readonly originalOperation: TaskEligibleMethodV2;
    };

function defaultResultCodec(
  generation: SessionTaskCapabilities["generation"],
): RuntimeCodec<CallToolResultV1 | CallToolResultV2> {
  return generation === "v2" ? CallToolResultV2Codec : CallToolResultV1Codec;
}

function reasonAsError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(
    typeof reason === "string" ? reason : "MCP session was invalidated",
    { cause: reason },
  );
}

function unsupported(feature: string): Error {
  return new Error(`${feature} is not supported`);
}

class ImmediateExecution<
  TResult,
  TApplicationContext,
> implements ToolExecutionCommon<TResult, TApplicationContext> {
  readonly kind = "immediate" as const;
  readonly handle = undefined;
  private closed = false;

  constructor(
    readonly applicationContext: TApplicationContext,
    private readonly resultPromise: Promise<TResult>,
  ) {}

  async *updates(_signal?: AbortSignal): AsyncIterable<TaskSnapshot> {}

  result(): Promise<TResult> {
    return this.resultPromise;
  }

  async cancel(_signal?: AbortSignal): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

class ManagedToolDeclarations implements ToolDeclarationProvider {
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
      for (const value of listed) {
        const parsed =
          this.port.taskCapabilities.generation === "v1"
            ? ToolV1Codec.parse(value)
            : this.port.taskCapabilities.generation === "v2"
              ? ToolV2Codec.parse(value)
              : (() => {
                  const v2 = ToolV2Codec.parse(value);
                  return v2.success ? v2 : ToolV1Codec.parse(value);
                })();
        if (!parsed.success) throw parsed.error;
        if (decoded.has(parsed.value.name)) {
          this.reportError(
            new Error(`Duplicate tool declaration: ${parsed.value.name}`),
          );
        }
        decoded.set(parsed.value.name, parsed.value);
      }
      cursor =
        typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    if (sequence === this.refreshSequence) this.tools = decoded;
  }
}

function requestParams(
  request: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  if (request.params === undefined) return {};
  if (
    request.params === null ||
    Array.isArray(request.params) ||
    typeof request.params !== "object"
  ) {
    throw new Error("Input request params must be an object");
  }
  return request.params as Readonly<Record<string, JsonValue>>;
}

interface OrdinaryInputCandidate<TApplicationContext> {
  readonly generation: TaskGeneration;
  readonly toolName: string;
  readonly executionId: string;
  readonly applicationContext: TApplicationContext;
  readonly signal?: AbortSignal;
}

let nextExecutionId = 0;

function defaultServerRequestResponse(
  incoming: IncomingServerRequest,
): JsonRpcResponse {
  if (
    incoming.request !== null &&
    !Array.isArray(incoming.request) &&
    typeof incoming.request === "object"
  ) {
    const request = incoming.request as Readonly<Record<string, JsonValue>>;
    if (request.method === "elicitation/create") {
      return { kind: "result", result: { action: "cancel" } };
    }
  }
  return { kind: "error", error: { code: -32603, message: "Internal error" } };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

class PortTaskEnabledSession<
  TApplicationContext,
> implements TaskEnabledSession<TApplicationContext> {
  private closed = false;
  private invalidationError: Error | undefined;
  private readonly disposeListeners: readonly (() => void)[];
  private readonly declarations: ToolDeclarationProvider;
  private readonly managedDeclarations: ManagedToolDeclarations | undefined;
  private readonly ordinaryInputCandidates = new Map<
    string,
    OrdinaryInputCandidate<TApplicationContext>
  >();

  constructor(
    private readonly port: ConnectedMcpSessionPort,
    private readonly options: WithTasksOptions<TApplicationContext>,
  ) {
    const reportError = (error: Error): void => {
      try {
        this.options.onError?.(error);
      } catch (sinkError) {
        console.error(sinkError);
      }
    };
    this.managedDeclarations =
      options.tools === undefined
        ? new ManagedToolDeclarations(port, reportError)
        : undefined;
    this.declarations = options.tools ?? this.managedDeclarations!;
    const onSessionAbort = (): void => {
      if (this.invalidationError === undefined) {
        this.invalidationError =
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new DOMException("The session was aborted", "AbortError");
      }
      this.managedDeclarations?.close();
    };
    options.signal?.addEventListener("abort", onSessionAbort, { once: true });
    this.disposeListeners = [
      port.onServerRequest(async (incoming) =>
        this.handleServerRequest(incoming),
      ),
      port.onNotification((notification) =>
        this.managedDeclarations?.onNotification(notification),
      ),
      port.onInvalidated((reason) => {
        if (this.invalidationError === undefined)
          this.invalidationError = reasonAsError(reason);
        this.managedDeclarations?.close();
      }),
      () => options.signal?.removeEventListener("abort", onSessionAbort),
      () => this.managedDeclarations?.close(),
    ];
    if (options.signal?.aborted === true) onSessionAbort();
    if (port.invalidated) {
      this.invalidationError = new Error("MCP session was invalidated");
      this.managedDeclarations?.close();
    }
  }

  async callTool<TResult = CallToolResultV1 | CallToolResultV2>(
    name: string,
    params?: Readonly<Record<string, JsonValue>>,
    options: {
      readonly resultCodec?: RuntimeCodec<TResult>;
      readonly applicationContext?: TApplicationContext;
      readonly signal?: AbortSignal;
      readonly preferTask?: boolean;
    } = {},
  ): Promise<ToolExecution<TResult, TApplicationContext>> {
    this.assertUsable();
    throwIfAborted(options.signal);
    await this.managedDeclarations?.ensureReady(options.signal);
    this.assertUsable();
    const declaration = this.declarations.currentTool(name);
    if (
      this.port.taskCapabilities.generation === "v2" &&
      declaration !== undefined &&
      "execution" in declaration
    ) {
      throw new Error(
        "Tool declaration generation does not match the V2 session",
      );
    }
    const requestParams: Record<string, JsonValue> = { name };
    if (params !== undefined) requestParams.arguments = params;
    if (
      this.port.taskCapabilities.generation === "v1" &&
      declaration !== undefined &&
      "execution" in declaration &&
      shouldCallToolAsTaskV1(
        this.port.taskCapabilities.capabilities,
        declaration as ToolV1,
        options.preferTask,
      )
    ) {
      throw unsupported("Task execution");
    }
    const executionId = `execution-${++nextExecutionId}`;
    this.ordinaryInputCandidates.set(executionId, {
      generation:
        this.port.taskCapabilities.generation === "none"
          ? "v1"
          : this.port.taskCapabilities.generation,
      toolName: name,
      executionId,
      applicationContext: options.applicationContext as TApplicationContext,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let response: JsonRpcResponse;
    try {
      response = await this.port.dispatch(
        { method: "tools/call", params: requestParams },
        options.signal === undefined ? undefined : { signal: options.signal },
      );
    } finally {
      this.ordinaryInputCandidates.delete(executionId);
    }
    this.assertUsable();
    throwIfAborted(options.signal);
    if (response.kind === "error")
      throw new JsonRpcResponseError(response.error);
    if (
      isTaskResultForGeneration(
        this.port.taskCapabilities.generation,
        response.result,
      )
    ) {
      throw unsupported("Task-result execution");
    }

    const codec =
      options.resultCodec ??
      (defaultResultCodec(
        this.port.taskCapabilities.generation,
      ) as RuntimeCodec<TResult>);
    const decoded = codec.parse(response.result);
    if (!decoded.success) throw decoded.error;
    const resultPromise = Promise.resolve(decoded.value);
    return new ImmediateExecution(
      options.applicationContext as TApplicationContext,
      resultPromise,
    );
  }

  async resumeTask<TResult = CallToolResultV1 | CallToolResultV2>(
    _reference: SerializedTaskReference,
    _options?: {
      readonly resultCodec?: RuntimeCodec<TResult>;
      readonly applicationContext?: TApplicationContext;
      readonly signal?: AbortSignal;
    },
  ): Promise<ToolExecution<TResult, TApplicationContext>> {
    this.assertUsable();
    throw unsupported("resumeTask");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const dispose of this.disposeListeners) dispose();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async handleServerRequest(
    incoming: IncomingServerRequest,
  ): Promise<JsonRpcResponse> {
    if (this.options.onInputRequest === undefined)
      return defaultServerRequestResponse(incoming);
    if (
      incoming.request === null ||
      Array.isArray(incoming.request) ||
      typeof incoming.request !== "object"
    ) {
      return defaultServerRequestResponse(incoming);
    }
    const wire = incoming.request as Readonly<Record<string, JsonValue>>;
    const method = wire.method;
    const request: ApplicationInputRequest | undefined =
      method === "elicitation/create"
        ? { kind: "elicitation", params: requestParams(wire) }
        : method === "sampling/createMessage"
          ? { kind: "sampling", params: requestParams(wire) }
          : method === "roots/list"
            ? {
                kind: "roots",
                ...(wire.params === undefined
                  ? {}
                  : { params: requestParams(wire) }),
              }
            : undefined;
    if (request === undefined) return defaultServerRequestResponse(incoming);
    if (this.ordinaryInputCandidates.size !== 1) {
      const candidates = [...this.ordinaryInputCandidates.values()].map(
        (candidate) => ({
          generation: candidate.generation,
          toolName: candidate.toolName,
          executionId: candidate.executionId,
          applicationContext: candidate.applicationContext,
        }),
      );
      this.reportBackgroundError(
        new InputCorrelationError(
          this.port.taskCapabilities.generation === "none"
            ? "v1"
            : this.port.taskCapabilities.generation,
          request.kind,
          candidates,
          candidates.length === 0 ? "zero-matches" : "ambiguous-matches",
        ),
      );
      return defaultServerRequestResponse(incoming);
    }
    const candidate = this.ordinaryInputCandidates.values().next()
      .value as OrdinaryInputCandidate<TApplicationContext>;
    try {
      const result = await this.options.onInputRequest(request, {
        lifetime: "basic",
        executionId: candidate.executionId,
        applicationContext: candidate.applicationContext,
        ...(candidate.signal === undefined ? {} : { signal: candidate.signal }),
      });
      if (!isJsonValue(result))
        throw new Error("Input handler returned a non-JSON value");
      return { kind: "result", result };
    } catch {
      return defaultServerRequestResponse(incoming);
    }
  }

  private reportBackgroundError(error: Error): void {
    try {
      if (this.options.onError === undefined) console.error(error);
      else this.options.onError(error);
    } catch (sinkError) {
      console.error(sinkError);
    }
  }

  private assertUsable(): void {
    if (this.invalidationError !== undefined) throw this.invalidationError;
    if (this.closed) throw new Error("Task-enabled session is closed");
  }
}

function isTaskResultForGeneration(
  generation: SessionTaskCapabilities["generation"],
  value: JsonValue,
): boolean {
  if (generation === "v1") return CreateTaskResultV1Codec.parse(value).success;
  if (generation === "v2") return isCreateTaskResultV2(value);
  return false;
}

export function withTasks<TApplicationContext = void>(
  session: ConnectedMcpSessionPort,
  options: WithTasksOptions<TApplicationContext> = {},
): TaskEnabledSession<TApplicationContext> {
  return new PortTaskEnabledSession(session, options);
}
