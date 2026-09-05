/** Requester-side MCP Tasks session and execution support. */

import {
  Client,
  ProtocolError,
  type StandardSchemaV1,
} from "@modelcontextprotocol/client";
import {
  isJsonValue,
  isJsonArray,
  type JsonValue,
  type RuntimeCodec,
  type TaskGeneration,
  type TaskId,
  type TaskSnapshot,
} from "../core/index.js";
import {
  CallToolResultV1Codec,
  CancelTaskResultV1Codec,
  CreateTaskResultV1Codec,
  GetTaskResultV1Codec,
  TaskResultV1Codec,
  TaskStatusNotificationV1Codec,
  ToolV1Codec,
  shouldCallToolAsTaskV1,
  type CallToolResultV1,
  type ServerTaskCapabilitiesV1,
  type TaskEligibleMethodV1,
  type TaskV1,
  type ToolV1,
} from "../core/v1/index.js";
import {
  CallToolResultV2Codec,
  CancelTaskResultV2Codec,
  CreateMessageResultV2Codec,
  CreateTaskResultV2Codec,
  ElicitResultV2Codec,
  GetTaskResultV2Codec,
  ListRootsResultV2Codec,
  TaskStatusNotificationV2Codec,
  ToolV2Codec,
  UpdateTaskResultV2Codec,
  isCreateTaskResultV2,
  withTaskCapabilityV2,
  type CallToolResultV2,
  type DetailedTaskV2,
  type ErrorV2,
  type InputRequestV2,
  type InputResponseV2,
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
  readonly endpointId: string;
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

const jsonValueSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "@modelcontextprotocol/ext-tasks",
    validate(value) {
      return isJsonValue(value)
        ? { value }
        : { issues: [{ message: "Expected a JSON value" }] };
    },
  },
};

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return (
    isJsonValue(value) &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object"
  );
}

function clientTaskCapabilities(
  client: ClientPublicSurface,
): SessionTaskCapabilities {
  const capabilities = client.getServerCapabilities();
  if (client.getProtocolEra() === "modern") {
    const extension =
      capabilities?.extensions?.["io.modelcontextprotocol/tasks"];
    if (
      extension !== null &&
      typeof extension === "object" &&
      !Array.isArray(extension) &&
      Object.keys(extension).length === 0
    )
      return { generation: "v2", capabilities: {} };
    return { generation: "none" };
  }
  const tasks = capabilities?.tasks;
  return tasks === undefined
    ? { generation: "none" }
    : { generation: "v1", capabilities: structuredClone(tasks) };
}

function asClientRequest(request: JsonValue): {
  readonly method: string;
  readonly params?: Readonly<Record<string, JsonValue>>;
} {
  if (!isJsonRecord(request))
    throw new DispatchError("MCP request must be a JSON object");
  const method = request.method;
  if (typeof method !== "string")
    throw new DispatchError("MCP request method must be a string");
  const params = request.params;
  if (params === undefined) return { method };
  if (!isJsonRecord(params))
    throw new DispatchError("MCP request params must be a JSON object");
  return { method, params };
}

function isTaskInputMethod(method: string): boolean {
  return (
    method === "elicitation/create" ||
    method === "sampling/createMessage" ||
    method === "roots/list"
  );
}

type ClientPublicSurface = Pick<
  Client,
  | "request"
  | "getProtocolEra"
  | "getServerCapabilities"
  | "fallbackRequestHandler"
  | "fallbackNotificationHandler"
  | "onclose"
>;

const adaptedClients = new WeakSet<object>();

function isConnectedMcpSessionPort(
  value: unknown,
): value is ConnectedMcpSessionPort {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ConnectedMcpSessionPort>;
  return (
    typeof candidate.endpointId === "string" &&
    candidate.taskCapabilities !== undefined &&
    typeof candidate.dispatch === "function" &&
    typeof candidate.onServerRequest === "function" &&
    typeof candidate.onNotification === "function" &&
    typeof candidate.onInvalidated === "function" &&
    typeof candidate.invalidated === "boolean"
  );
}

function isClientPublicSurface(value: unknown): value is ClientPublicSurface {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ClientPublicSurface>;
  return (
    typeof candidate.request === "function" &&
    typeof candidate.getProtocolEra === "function" &&
    typeof candidate.getServerCapabilities === "function"
  );
}

class ClientSessionPort implements ConnectedMcpSessionPort {
  readonly taskCapabilities: SessionTaskCapabilities;
  private readonly serverRequestListeners = new Set<
    (incoming: IncomingServerRequest) => Promise<JsonRpcResponse>
  >();
  private readonly notificationListeners = new Set<
    (notification: JsonValue) => void
  >();
  private readonly invalidationListeners = new Set<(reason: unknown) => void>();
  private readonly previousFallbackRequestHandler: ClientPublicSurface["fallbackRequestHandler"];
  private readonly previousFallbackNotificationHandler: ClientPublicSurface["fallbackNotificationHandler"];
  private readonly previousOnclose: ClientPublicSurface["onclose"];
  private disposed = false;
  private isInvalidated = false;

  private readonly fallbackRequestHandler: NonNullable<
    ClientPublicSurface["fallbackRequestHandler"]
  > = async (request, context) => {
    if (!isTaskInputMethod(request.method)) {
      if (this.previousFallbackRequestHandler !== undefined)
        return this.previousFallbackRequestHandler(request, context);
      throw new ProtocolError(-32601, `Method not found: ${request.method}`);
    }
    const listener = this.serverRequestListeners.values().next().value;
    if (listener === undefined) {
      if (this.previousFallbackRequestHandler !== undefined)
        return this.previousFallbackRequestHandler(request, context);
      throw new ProtocolError(-32601, `Method not found: ${request.method}`);
    }
    if (!isJsonValue(request))
      throw new ProtocolError(-32600, "Inbound request is not JSON");
    const response = await listener({ request, requestContext: context });
    if (response.kind === "error")
      throw new ProtocolError(
        response.error.code,
        response.error.message,
        response.error.data,
      );
    if (!isJsonRecord(response.result))
      throw new ProtocolError(
        -32603,
        "Inbound handler returned a non-object result",
      );
    return response.result;
  };

  private readonly fallbackNotificationHandler: NonNullable<
    ClientPublicSurface["fallbackNotificationHandler"]
  > = async (notification) => {
    await this.previousFallbackNotificationHandler?.(notification);
    if (!isJsonValue(notification)) return;
    for (const listener of [...this.notificationListeners])
      listener(notification);
  };

  private readonly onclose = (): void => {
    try {
      this.previousOnclose?.();
    } finally {
      this.invalidate(new Error("MCP client connection closed"));
    }
  };

  constructor(
    private readonly client: ClientPublicSurface,
    readonly endpointId: string,
  ) {
    if (adaptedClients.has(client))
      throw new TypeError(
        "An ext-tasks adapter is already active for this Client",
      );
    this.previousFallbackRequestHandler = client.fallbackRequestHandler;
    this.previousFallbackNotificationHandler =
      client.fallbackNotificationHandler;
    this.previousOnclose = client.onclose;
    this.taskCapabilities = clientTaskCapabilities(client);
    adaptedClients.add(client);
    client.fallbackRequestHandler = this.fallbackRequestHandler;
    client.fallbackNotificationHandler = this.fallbackNotificationHandler;
    client.onclose = this.onclose;
  }

  get invalidated(): boolean {
    return this.isInvalidated;
  }

  async dispatch(
    request: JsonValue,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonRpcResponse> {
    try {
      const result = await this.client.request(
        asClientRequest(request),
        jsonValueSchema,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      return { kind: "result", result };
    } catch (error) {
      if (error instanceof ProtocolError) {
        const data = error.data;
        return {
          kind: "error",
          error: {
            code: error.code,
            message: error.message,
            ...(data === undefined || !isJsonValue(data) ? {} : { data }),
          },
        };
      }
      throw new DispatchError("MCP client request failed", false, {
        cause: error,
      });
    }
  }

  onServerRequest(
    handler: (incoming: IncomingServerRequest) => Promise<JsonRpcResponse>,
  ): () => void {
    this.serverRequestListeners.add(handler);
    return () => this.serverRequestListeners.delete(handler);
  }

  onNotification(listener: (notification: JsonValue) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onInvalidated(listener: (reason: unknown) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.client.fallbackRequestHandler === this.fallbackRequestHandler)
      this.client.fallbackRequestHandler = this.previousFallbackRequestHandler;
    if (
      this.client.fallbackNotificationHandler ===
      this.fallbackNotificationHandler
    )
      this.client.fallbackNotificationHandler =
        this.previousFallbackNotificationHandler;
    if (this.client.onclose === this.onclose)
      this.client.onclose = this.previousOnclose;
    adaptedClients.delete(this.client);
    this.serverRequestListeners.clear();
    this.notificationListeners.clear();
    this.invalidationListeners.clear();
  }

  private invalidate(reason: unknown): void {
    if (this.isInvalidated) return;
    this.isInvalidated = true;
    for (const listener of [...this.invalidationListeners]) listener(reason);
  }
}

export function createSessionPortFromClient(
  client: Client,
  endpointId: string,
): ConnectedMcpSessionPort & Disposable {
  return new ClientSessionPort(client, endpointId);
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
  currentTool(name: string):
    | {
        readonly name: string;
        readonly inputSchema: Readonly<Record<string, JsonValue>>;
        readonly execution?: {
          readonly taskSupport?: "forbidden" | "optional" | "required";
        };
      }
    | undefined;
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
      serializeReference(): SerializedTaskReference;
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

export class TaskCancellationUnsupportedError extends Error {
  constructor() {
    super("Task cancellation is not supported");
    this.name = "TaskCancellationUnsupportedError";
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

const DEFAULT_TASK_POLL_INTERVAL_MS = 10;

type TaskTurn =
  { readonly sequence: number; readonly snapshot: TaskSnapshot } | undefined;

type TaskDriver<TResult> = (
  accept: (snapshot: TaskSnapshot) => void,
  waitForTurn: (
    afterSequence: number,
    delayMs: number | undefined,
  ) => Promise<TaskTurn>,
  observe: (
    afterSequence: number,
    observation: (signal: AbortSignal) => Promise<TaskSnapshot>,
  ) => Promise<TaskTurn>,
  signal: AbortSignal,
  cancelledError: Error,
  closedError: Error,
  isClosed: () => boolean,
  inputSignal: AbortSignal,
) => Promise<TResult>;

class TaskExecution<
  TResult,
  TApplicationContext,
> implements ToolExecutionCommon<TResult, TApplicationContext> {
  readonly kind = "task" as const;
  private readonly controller = new AbortController();
  private readonly inputController = new AbortController();
  private readonly cancellationController = new AbortController();
  private readonly resultPromise: Promise<TResult>;
  private readonly cancelledError = new Error("Task was cancelled");
  private readonly closedError = new TaskExecutionClosedError();
  private readonly notificationWaiters = new Set<() => void>();
  private readonly updateWaiters = new Set<() => void>();
  private initialSnapshot: TaskSnapshot | undefined;
  private pendingSnapshot: TaskSnapshot | undefined;
  private terminalSnapshot: TaskSnapshot | undefined;
  private terminalSnapshotBytes: string | undefined;
  private lastAcceptedBytes: string;
  private notificationSequence = 0;
  private latestNotification: TaskSnapshot | undefined;
  private updatesAcquired = false;
  private cancelPromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    readonly applicationContext: TApplicationContext,
    readonly handle: TaskHandle,
    private readonly endpointId: string,
    initialSnapshot: TaskSnapshot,
    driver: TaskDriver<TResult>,
    private readonly cancelTask: (signal?: AbortSignal) => Promise<void>,
    lifecycleSignal?: AbortSignal,
  ) {
    this.initialSnapshot = initialSnapshot;
    if (terminalStatus(initialSnapshot.task.status))
      this.inputController.abort();
    this.lastAcceptedBytes = deterministicJson(initialSnapshot);
    if (lifecycleSignal !== undefined) {
      const abort = (): void => this.controller.abort(lifecycleSignal.reason);
      if (lifecycleSignal.aborted) abort();
      else lifecycleSignal.addEventListener("abort", abort, { once: true });
    }
    this.resultPromise = driver(
      (snapshot) => this.accept(snapshot),
      (afterSequence, delayMs) => this.waitForTurn(afterSequence, delayMs),
      (afterSequence, observation) =>
        this.observeOrNotification(afterSequence, observation),
      this.controller.signal,
      this.cancelledError,
      this.closedError,
      () => this.closed,
      this.inputController.signal,
    );
  }

  serializeReference(): SerializedTaskReference {
    return { endpointId: this.endpointId, ...this.handle };
  }

  onNotification(snapshot: TaskSnapshot): void {
    if (this.closed || snapshot.generation !== this.handle.generation) return;
    if (snapshot.task.taskId !== this.handle.taskId) return;
    const bytes = deterministicJson(snapshot);
    if (terminalStatus(snapshot.task.status)) {
      this.inputController.abort();
      if (this.terminalSnapshotBytes === undefined) {
        this.terminalSnapshot = snapshot;
        this.terminalSnapshotBytes = bytes;
      }
    } else if (this.terminalSnapshotBytes !== undefined) {
      return;
    }
    this.latestNotification = snapshot;
    this.notificationSequence += 1;
    for (const wake of this.notificationWaiters) wake();
    this.notificationWaiters.clear();
    for (const wake of this.updateWaiters) wake();
    this.updateWaiters.clear();
  }

  updates(signal?: AbortSignal): AsyncIterable<TaskSnapshot> {
    if (this.updatesAcquired) throw new TaskUpdatesAlreadyAcquiredError();
    this.updatesAcquired = true;
    return this.iterateUpdates(signal);
  }

  private async *iterateUpdates(
    signal?: AbortSignal,
  ): AsyncIterable<TaskSnapshot> {
    while (true) {
      throwIfAborted(signal);
      if (this.initialSnapshot !== undefined) {
        const snapshot = this.initialSnapshot;
        this.initialSnapshot = undefined;
        yield snapshot;
        continue;
      }
      if (this.pendingSnapshot !== undefined) {
        const snapshot = this.pendingSnapshot;
        this.pendingSnapshot = undefined;
        yield snapshot;
        continue;
      }
      if (this.terminalSnapshot !== undefined) {
        const snapshot = this.terminalSnapshot;
        this.terminalSnapshot = undefined;
        yield snapshot;
        continue;
      }
      const settled = await this.waitForUpdateOrResult(signal);
      if (
        !settled &&
        this.initialSnapshot === undefined &&
        this.pendingSnapshot === undefined &&
        this.terminalSnapshot === undefined
      )
        return;
    }
  }

  private accept(snapshot: TaskSnapshot): void {
    if (this.closed) return;
    const bytes = deterministicJson(snapshot);
    if (bytes === this.lastAcceptedBytes) return;
    this.lastAcceptedBytes = bytes;
    if (terminalStatus(snapshot.task.status)) {
      this.inputController.abort();
      if (bytes !== this.terminalSnapshotBytes) {
        this.terminalSnapshot ??= snapshot;
        this.terminalSnapshotBytes ??= bytes;
      }
    } else if (this.terminalSnapshotBytes === undefined) {
      this.pendingSnapshot = snapshot;
    }
    for (const wake of this.updateWaiters) wake();
    this.updateWaiters.clear();
  }

  private async waitForUpdateOrResult(signal?: AbortSignal): Promise<boolean> {
    if (
      this.pendingSnapshot !== undefined ||
      this.terminalSnapshot !== undefined
    )
      return true;
    let wake: (() => void) | undefined;
    const updated = new Promise<true>((resolve) => {
      wake = () => resolve(true);
      this.updateWaiters.add(wake);
    });
    try {
      return await withAbort(
        Promise.race([
          updated,
          this.resultPromise.then(
            () => false,
            () => false,
          ),
        ]),
        signal,
      );
    } finally {
      if (wake !== undefined) this.updateWaiters.delete(wake);
    }
  }

  private currentTurn(afterSequence: number): TaskTurn {
    if (
      this.notificationSequence > afterSequence &&
      this.latestNotification !== undefined
    ) {
      return {
        sequence: this.notificationSequence,
        snapshot: this.latestNotification,
      };
    }
    return undefined;
  }

  private async waitForTurn(
    afterSequence: number,
    delayMs: number | undefined,
  ): Promise<TaskTurn> {
    const current = this.currentTurn(afterSequence);
    if (current !== undefined) return current;
    if (delayMs === undefined) {
      await Promise.resolve();
      throwIfAborted(this.controller.signal);
      return this.currentTurn(afterSequence);
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        clearTimeout(timeout);
        this.notificationWaiters.delete(onNotification);
        this.controller.signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(reasonAsError(error));
      };
      const onNotification = (): void => finish();
      const onAbort = (): void => finish(this.controller.signal.reason);
      const timeout = setTimeout(onNotification, Math.max(0, delayMs));
      this.notificationWaiters.add(onNotification);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return this.currentTurn(afterSequence);
  }

  private async observeOrNotification(
    afterSequence: number,
    observation: (signal: AbortSignal) => Promise<TaskSnapshot>,
  ): Promise<TaskTurn> {
    const current = this.currentTurn(afterSequence);
    if (current !== undefined) return current;
    const observationLifecycle = linkAbortSignals(this.controller.signal);
    const observationPromise = observation(observationLifecycle.signal);
    void observationPromise.catch(() => {});
    let wake: (() => void) | undefined;
    const notified = new Promise<TaskTurn>((resolve) => {
      wake = () => resolve(this.currentTurn(afterSequence));
      this.notificationWaiters.add(wake);
    });
    try {
      return await withAbort(
        Promise.race([
          observationPromise.then((snapshot) => ({
            sequence: afterSequence,
            snapshot,
          })),
          notified,
        ]),
        this.controller.signal,
      );
    } finally {
      if (!observationLifecycle.signal.aborted) observationLifecycle.abort();
      observationLifecycle.dispose();
      if (wake !== undefined) this.notificationWaiters.delete(wake);
    }
  }

  result(): Promise<TResult> {
    return this.resultPromise;
  }

  inputSignal(): AbortSignal {
    return this.inputController.signal;
  }

  endInputLifetime(): void {
    this.inputController.abort();
  }

  cancel(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.cancelPromise ??= this.cancelTask(this.cancellationController.signal);
    return signal === undefined
      ? this.cancelPromise
      : withAbort(this.cancelPromise, signal);
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.controller.abort(this.closedError);
      this.inputController.abort(this.closedError);
      void this.cancel().catch(() => {
        // Cooperative cancellation is best effort during close.
      });
    }
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

function deterministicJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(deterministicJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${deterministicJson(record[key])}`)
    .join(",")}}`;
}

async function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
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
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function linkAbortSignals(...signals: readonly (AbortSignal | undefined)[]): {
  readonly signal: AbortSignal;
  readonly abort: (reason?: unknown) => void;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: (() => void)[] = [];
  for (const signal of signals) {
    if (signal === undefined) continue;
    const abort = (): void => controller.abort(signal.reason);
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", abort));
  }
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => {
      for (const remove of listeners) remove();
    },
  };
}

async function dispatchWithRetry(
  port: ConnectedMcpSessionPort,
  request: JsonValue,
  signal: AbortSignal | undefined,
  retry: "observe" | "mutate",
): Promise<JsonRpcResponse> {
  const options = signal === undefined ? undefined : { signal };
  try {
    return await port.dispatch(request, options);
  } catch (error) {
    throwIfAborted(signal);
    if (
      !(error instanceof DispatchError) ||
      (retry === "mutate" && !error.retryable)
    ) {
      throw error;
    }
    return port.dispatch(request, options);
  }
}

function decodeResult<T>(codec: RuntimeCodec<T>, value: JsonValue): T {
  const decoded = codec.parse(value);
  if (!decoded.success) throw decoded.error;
  return decoded.value;
}

function responseResult(response: JsonRpcResponse): JsonValue {
  if (response.kind === "error") throw new JsonRpcResponseError(response.error);
  return response.result;
}

function terminalStatus(status: TaskV1["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

class ImmediateExecution<
  TResult,
  TApplicationContext,
> implements ToolExecutionCommon<TResult, TApplicationContext> {
  readonly kind = "immediate" as const;
  readonly handle = undefined;

  constructor(
    readonly applicationContext: TApplicationContext,
    private readonly resultPromise: Promise<TResult>,
  ) {}

  updates(signal?: AbortSignal): AsyncIterable<TaskSnapshot> {
    throwIfAborted(signal);
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve({ done: true as const, value: undefined }),
        };
      },
    };
  }

  result(): Promise<TResult> {
    return this.resultPromise;
  }

  cancel(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
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
      if (!isJsonArray(listed))
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
  readonly lifetime: "basic";
  readonly generation: TaskGeneration;
  readonly toolName: string;
  readonly executionId: string;
  readonly applicationContext: TApplicationContext;
  readonly signal?: AbortSignal;
}

interface V1TaskInputCandidate<TApplicationContext> {
  readonly lifetime: "task-v1";
  readonly generation: "v1";
  readonly taskId: TaskId;
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
  private closeError: Error | undefined;
  private readonly lifecycleController = new AbortController();
  private invalidationError: Error | undefined;
  private readonly disposeListeners: readonly (() => void)[];
  private readonly declarations: ToolDeclarationProvider;
  private readonly managedDeclarations: ManagedToolDeclarations | undefined;
  private readonly ordinaryInputCandidates = new Map<
    string,
    OrdinaryInputCandidate<TApplicationContext>
  >();
  private readonly v1TaskInputCandidates = new Map<
    string,
    V1TaskInputCandidate<TApplicationContext>
  >();
  private readonly activeTaskExecutions = new Set<
    TaskExecution<unknown, TApplicationContext>
  >();

  constructor(
    private readonly port: ConnectedMcpSessionPort,
    private readonly options: WithTasksOptions<TApplicationContext>,
    disposePort?: () => void,
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
      const error =
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new DOMException("The session was aborted", "AbortError");
      this.invalidationError ??= error;
      this.lifecycleController.abort(error);
      this.managedDeclarations?.close();
    };
    options.signal?.addEventListener("abort", onSessionAbort, { once: true });
    this.disposeListeners = [
      port.onServerRequest(async (incoming) =>
        this.handleServerRequest(incoming),
      ),
      port.onNotification((notification) =>
        this.handleNotification(notification),
      ),
      port.onInvalidated((reason) => {
        const error = reasonAsError(reason);
        this.invalidationError ??= error;
        this.lifecycleController.abort(error);
        this.managedDeclarations?.close();
      }),
      () => options.signal?.removeEventListener("abort", onSessionAbort),
      () => this.managedDeclarations?.close(),
      ...(disposePort === undefined ? [] : [disposePort]),
    ];
    if (options.signal?.aborted === true) onSessionAbort();
    if (port.invalidated) {
      const error = new Error("MCP session was invalidated");
      this.invalidationError = error;
      this.lifecycleController.abort(error);
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
    const callLifecycle = linkAbortSignals(
      this.lifecycleController.signal,
      options.signal,
    );
    const callSignal = callLifecycle.signal;
    let declaration: ReturnType<ToolDeclarationProvider["currentTool"]>;
    try {
      throwIfAborted(callSignal);
      await this.managedDeclarations?.ensureReady(callSignal);
      this.assertUsable();
      declaration = this.declarations.currentTool(name);
    } catch (error) {
      callLifecycle.dispose();
      throw error;
    }
    if (
      this.port.taskCapabilities.generation === "v2" &&
      declaration !== undefined &&
      "execution" in declaration
    ) {
      callLifecycle.dispose();
      throw new Error(
        "V1 tool declaration is incompatible with the V2 session",
      );
    }
    const requestParams: Record<string, JsonValue> = { name };
    if (params !== undefined) requestParams.arguments = params;
    const generation = this.port.taskCapabilities.generation;
    const callAsTaskV1 =
      generation === "v1" &&
      declaration !== undefined &&
      "execution" in declaration &&
      shouldCallToolAsTaskV1(
        this.port.taskCapabilities.capabilities,
        declaration as ToolV1,
        options.preferTask,
      );
    if (callAsTaskV1) requestParams.task = {};
    const executionId = `execution-${++nextExecutionId}`;
    if (!callAsTaskV1) {
      this.ordinaryInputCandidates.set(executionId, {
        lifetime: "basic",
        generation: generation === "none" ? "v1" : generation,
        toolName: name,
        executionId,
        applicationContext: options.applicationContext as TApplicationContext,
        signal: callSignal,
      });
    }
    const dispatchPromise = dispatchWithRetry(
      this.port,
      {
        method: "tools/call",
        params:
          generation === "v2"
            ? withTaskCapabilityV2(requestParams)
            : requestParams,
      },
      callSignal,
      "mutate",
    );
    let response: JsonRpcResponse;
    try {
      response = await withAbort(dispatchPromise, callSignal);
    } catch (error) {
      void dispatchPromise.then(
        (lateResponse) =>
          this.cleanupLateTaskCreation(lateResponse, generation, callAsTaskV1),
        () => {},
      );
      throw error;
    } finally {
      this.ordinaryInputCandidates.delete(executionId);
      callLifecycle.dispose();
    }
    try {
      this.assertUsable();
      throwIfAborted(callSignal);
    } catch (error) {
      this.cleanupLateTaskCreation(response, generation, callAsTaskV1);
      throw error;
    }
    const wireResult = responseResult(response);
    const codec =
      options.resultCodec ??
      (defaultResultCodec(generation) as RuntimeCodec<TResult>);

    if (generation === "v1" && callAsTaskV1) {
      const created = decodeResult(CreateTaskResultV1Codec, wireResult);
      const handle: TaskHandle = {
        generation: "v1",
        taskId: created.task.taskId as TaskId,
        originalOperation: "tools/call",
      };
      const initial: TaskSnapshot = { generation: "v1", task: created.task };
      const execution = new TaskExecution(
        options.applicationContext as TApplicationContext,
        handle,
        this.port.endpointId,
        initial,
        async (
          accept,
          waitForTurn,
          observe,
          signal,
          cancelledError,
          closedError,
          isClosed,
        ) => {
          let task = created.task;
          let notificationSequence = 0;
          while (!terminalStatus(task.status)) {
            const turn = await waitForTurn(
              notificationSequence,
              Math.max(
                DEFAULT_TASK_POLL_INTERVAL_MS,
                task.pollInterval ?? DEFAULT_TASK_POLL_INTERVAL_MS,
              ),
            );
            const observed =
              turn ??
              (await observe(notificationSequence, (observationSignal) =>
                dispatchWithRetry(
                  this.port,
                  { method: "tasks/get", params: { taskId: task.taskId } },
                  observationSignal,
                  "observe",
                ).then((response) => ({
                  generation: "v1" as const,
                  task: decodeResult(
                    GetTaskResultV1Codec,
                    responseResult(response),
                  ),
                })),
              ));
            if (observed?.snapshot.generation !== "v1") continue;
            notificationSequence = observed.sequence;
            task = observed.snapshot.task;
            if (!isClosed()) accept({ generation: "v1", task });
          }
          if (isClosed()) throw closedError;
          if (task.status === "cancelled") throw cancelledError;
          if (task.status === "failed")
            throw new Error(task.statusMessage ?? "Task failed");
          const taskResult = responseResult(
            await dispatchWithRetry(
              this.port,
              { method: "tasks/result", params: { taskId: task.taskId } },
              signal,
              "observe",
            ),
          );
          decodeResult(TaskResultV1Codec, taskResult);
          return decodeResult(codec, taskResult);
        },
        async (signal) => {
          const capabilities = this.port.taskCapabilities;
          if (
            capabilities.generation !== "v1" ||
            capabilities.capabilities.cancel === undefined
          )
            throw new TaskCancellationUnsupportedError();
          const cancelled = responseResult(
            await dispatchWithRetry(
              this.port,
              {
                method: "tasks/cancel",
                params: { taskId: created.task.taskId },
              },
              signal,
              "mutate",
            ),
          );
          decodeResult(CancelTaskResultV1Codec, cancelled);
        },
        this.lifecycleController.signal,
      );
      return this.trackTaskExecution(execution, {
        lifetime: "task-v1",
        generation: "v1",
        taskId: created.task.taskId as TaskId,
        toolName: name,
        executionId,
        applicationContext: options.applicationContext as TApplicationContext,
        signal: execution.inputSignal(),
      });
    }

    if (generation === "v2" && isCreateTaskResultV2(wireResult)) {
      const created = decodeResult(CreateTaskResultV2Codec, wireResult);
      const handle: TaskHandle = {
        generation: "v2",
        taskId: created.taskId as TaskId,
        originalOperation: "tools/call",
      };
      const initial: TaskSnapshot = { generation: "v2", task: created };
      return this.trackTaskExecution(
        new TaskExecution(
          options.applicationContext as TApplicationContext,
          handle,
          this.port.endpointId,
          initial,
          async (
            accept,
            waitForTurn,
            observe,
            signal,
            cancelledError,
            closedError,
            isClosed,
            inputSignal,
          ) => {
            let status = created.status;
            let current: DetailedTaskV2 | undefined;
            let notificationSequence = 0;
            const acquiredInputs = new Map<string, string>();
            const acquireInputs = async (
              task: DetailedTaskV2,
            ): Promise<void> => {
              if (task.status !== "input_required") return;
              const inputResponses: Record<string, InputResponseV2> = {};
              for (const [inputKey, inputRequest] of Object.entries(
                task.inputRequests,
              )) {
                const signature = deterministicJson(inputRequest);
                const acquiredSignature = acquiredInputs.get(inputKey);
                if (acquiredSignature !== undefined) {
                  if (acquiredSignature !== signature)
                    this.reportBackgroundError(
                      new Error(
                        `V2 task input key ${inputKey} was reused incompatibly`,
                      ),
                    );
                  continue;
                }
                acquiredInputs.set(inputKey, signature);
                const request: InputRequestV2 = inputRequest;
                const projected: ApplicationInputRequest | undefined =
                  request.method === "sampling/createMessage"
                    ? { kind: "sampling", params: request.params }
                    : request.method === "roots/list"
                      ? {
                          kind: "roots",
                          ...(request.params === undefined
                            ? {}
                            : { params: request.params }),
                        }
                      : request.method === "elicitation/create"
                        ? { kind: "elicitation", params: request.params }
                        : undefined;
                if (projected === undefined) {
                  this.reportBackgroundError(
                    new Error(
                      `Unknown V2 task input method for key ${inputKey}`,
                    ),
                  );
                  continue;
                }
                let result: unknown;
                if (this.options.onInputRequest === undefined) {
                  if (request.method !== "elicitation/create") continue;
                  result = { action: "cancel" };
                } else {
                  try {
                    result = await this.options.onInputRequest(projected, {
                      lifetime: "task-v2",
                      taskId: task.taskId,
                      inputKey,
                      applicationContext:
                        options.applicationContext as TApplicationContext,
                      signal: inputSignal,
                    });
                  } catch {
                    if (inputSignal.aborted) return;
                    if (request.method !== "elicitation/create") continue;
                    result = { action: "cancel" };
                  }
                }
                try {
                  const codec =
                    request.method === "sampling/createMessage"
                      ? CreateMessageResultV2Codec
                      : request.method === "roots/list"
                        ? ListRootsResultV2Codec
                        : ElicitResultV2Codec;
                  inputResponses[inputKey] = decodeResult(
                    codec as RuntimeCodec<InputResponseV2>,
                    result as JsonValue,
                  );
                } catch (error) {
                  this.reportBackgroundError(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                }
              }
              if (inputSignal.aborted) return;
              if (Object.keys(inputResponses).length === 0) return;
              const updated = responseResult(
                await dispatchWithRetry(
                  this.port,
                  {
                    method: "tasks/update",
                    params: withTaskCapabilityV2({
                      taskId: task.taskId,
                      inputResponses,
                    }),
                  },
                  signal,
                  "mutate",
                ),
              );
              decodeResult(UpdateTaskResultV2Codec, updated);
            };
            while (!terminalStatus(status)) {
              const delayMs = Math.max(
                DEFAULT_TASK_POLL_INTERVAL_MS,
                current?.pollIntervalMs ??
                  created.pollIntervalMs ??
                  DEFAULT_TASK_POLL_INTERVAL_MS,
              );
              const turn = await waitForTurn(notificationSequence, delayMs);
              const observed =
                turn ??
                (await observe(notificationSequence, (observationSignal) =>
                  dispatchWithRetry(
                    this.port,
                    {
                      method: "tasks/get",
                      params: withTaskCapabilityV2({ taskId: created.taskId }),
                    },
                    observationSignal,
                    "observe",
                  ).then((response) => ({
                    generation: "v2" as const,
                    task: decodeResult(
                      GetTaskResultV2Codec,
                      responseResult(response),
                    ),
                  })),
                ));
              if (observed?.snapshot.generation !== "v2") continue;
              notificationSequence = observed.sequence;
              const next = observed.snapshot.task as DetailedTaskV2;
              current = next;
              status = next.status;
              if (!isClosed()) accept({ generation: "v2", task: next });
              await acquireInputs(next);
            }
            if (isClosed()) throw closedError;
            if (current === undefined) {
              current = decodeResult(
                GetTaskResultV2Codec,
                responseResult(
                  await dispatchWithRetry(
                    this.port,
                    {
                      method: "tasks/get",
                      params: withTaskCapabilityV2({ taskId: created.taskId }),
                    },
                    signal,
                    "observe",
                  ),
                ),
              );
              if (!isClosed()) accept({ generation: "v2", task: current });
            }
            if (current.status === "cancelled") throw cancelledError;
            if (current.status === "failed")
              throw new JsonRpcResponseError(current.error);
            if (current.status !== "completed")
              throw new Error(
                `Unsupported terminal task status: ${current.status}`,
              );
            return decodeResult(codec, current.result);
          },
          async (signal) => {
            const cancelled = responseResult(
              await dispatchWithRetry(
                this.port,
                {
                  method: "tasks/cancel",
                  params: withTaskCapabilityV2({ taskId: created.taskId }),
                },
                signal,
                "mutate",
              ),
            );
            decodeResult(CancelTaskResultV2Codec, cancelled);
          },
          this.lifecycleController.signal,
        ),
      );
    }

    const resultPromise = Promise.resolve(decodeResult(codec, wireResult));
    return new ImmediateExecution(
      options.applicationContext as TApplicationContext,
      resultPromise,
    );
  }

  async resumeTask<TResult = CallToolResultV1 | CallToolResultV2>(
    reference: SerializedTaskReference,
    options: {
      readonly resultCodec?: RuntimeCodec<TResult>;
      readonly applicationContext?: TApplicationContext;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ToolExecution<TResult, TApplicationContext>> {
    this.assertUsable();
    const capabilities = this.port.taskCapabilities;
    if (reference.endpointId !== this.port.endpointId)
      throw new Error("Task reference belongs to a different endpoint");
    if (reference.generation !== capabilities.generation)
      throw new Error("Task reference generation does not match this session");
    if (reference.originalOperation !== "tools/call")
      throw new Error("Task reference operation is not supported");

    const resumeLifecycle = linkAbortSignals(
      this.lifecycleController.signal,
      options.signal,
    );
    const resumeSignal = resumeLifecycle.signal;
    const executionId = `execution-${++nextExecutionId}`;
    const codec =
      options.resultCodec ??
      (defaultResultCodec(reference.generation) as RuntimeCodec<TResult>);
    try {
      throwIfAborted(resumeSignal);
      const response = await dispatchWithRetry(
        this.port,
        {
          method: "tasks/get",
          params:
            reference.generation === "v2"
              ? withTaskCapabilityV2({ taskId: reference.taskId })
              : { taskId: reference.taskId },
        },
        resumeSignal,
        "observe",
      );
      this.assertUsable();
      throwIfAborted(resumeSignal);

      if (reference.generation === "v1") {
        const task = decodeResult(
          GetTaskResultV1Codec,
          responseResult(response),
        );
        const execution = new TaskExecution(
          options.applicationContext as TApplicationContext,
          reference,
          this.port.endpointId,
          { generation: "v1", task },
          async (
            accept,
            waitForTurn,
            observe,
            signal,
            cancelledError,
            closedError,
            isClosed,
          ) => {
            let current = task;
            let notificationSequence = 0;
            while (!terminalStatus(current.status)) {
              const turn = await waitForTurn(
                notificationSequence,
                Math.max(
                  DEFAULT_TASK_POLL_INTERVAL_MS,
                  current.pollInterval ?? DEFAULT_TASK_POLL_INTERVAL_MS,
                ),
              );
              const observed =
                turn ??
                (await observe(notificationSequence, (observationSignal) =>
                  dispatchWithRetry(
                    this.port,
                    {
                      method: "tasks/get",
                      params: { taskId: reference.taskId },
                    },
                    observationSignal,
                    "observe",
                  ).then((nextResponse) => ({
                    generation: "v1" as const,
                    task: decodeResult(
                      GetTaskResultV1Codec,
                      responseResult(nextResponse),
                    ),
                  })),
                ));
              if (observed?.snapshot.generation !== "v1") continue;
              notificationSequence = observed.sequence;
              current = observed.snapshot.task;
              if (!isClosed()) accept({ generation: "v1", task: current });
            }
            if (isClosed()) throw closedError;
            if (current.status === "cancelled") throw cancelledError;
            if (current.status === "failed")
              throw new Error(current.statusMessage ?? "Task failed");
            const taskResult = responseResult(
              await dispatchWithRetry(
                this.port,
                {
                  method: "tasks/result",
                  params: { taskId: reference.taskId },
                },
                signal,
                "observe",
              ),
            );
            decodeResult(TaskResultV1Codec, taskResult);
            return decodeResult(codec, taskResult);
          },
          async (signal) => {
            const currentCapabilities = this.port.taskCapabilities;
            if (
              currentCapabilities.generation !== "v1" ||
              currentCapabilities.capabilities.cancel === undefined
            )
              throw new TaskCancellationUnsupportedError();
            decodeResult(
              CancelTaskResultV1Codec,
              responseResult(
                await dispatchWithRetry(
                  this.port,
                  {
                    method: "tasks/cancel",
                    params: { taskId: reference.taskId },
                  },
                  signal,
                  "mutate",
                ),
              ),
            );
          },
          this.lifecycleController.signal,
        );
        return this.trackTaskExecution(execution, {
          lifetime: "task-v1",
          generation: "v1",
          taskId: reference.taskId,
          toolName: "<resumed>",
          executionId,
          applicationContext: options.applicationContext as TApplicationContext,
          signal: execution.inputSignal(),
        });
      }

      const task = decodeResult(GetTaskResultV2Codec, responseResult(response));
      return this.trackTaskExecution(
        new TaskExecution(
          options.applicationContext as TApplicationContext,
          reference,
          this.port.endpointId,
          { generation: "v2", task },
          async (
            accept,
            waitForTurn,
            observe,
            signal,
            cancelledError,
            closedError,
            isClosed,
            inputSignal,
          ) => {
            let current: DetailedTaskV2 = task;
            let notificationSequence = 0;
            const acquiredInputs = new Map<string, string>();
            await this.acquireV2TaskInputs(
              current,
              options.applicationContext as TApplicationContext,
              inputSignal,
              signal,
              acquiredInputs,
            );
            while (!terminalStatus(current.status)) {
              const turn = await waitForTurn(
                notificationSequence,
                Math.max(
                  DEFAULT_TASK_POLL_INTERVAL_MS,
                  current.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS,
                ),
              );
              const observed =
                turn ??
                (await observe(notificationSequence, (observationSignal) =>
                  dispatchWithRetry(
                    this.port,
                    {
                      method: "tasks/get",
                      params: withTaskCapabilityV2({
                        taskId: reference.taskId,
                      }),
                    },
                    observationSignal,
                    "observe",
                  ).then((nextResponse) => ({
                    generation: "v2" as const,
                    task: decodeResult(
                      GetTaskResultV2Codec,
                      responseResult(nextResponse),
                    ),
                  })),
                ));
              if (observed?.snapshot.generation !== "v2") continue;
              notificationSequence = observed.sequence;
              current = observed.snapshot.task as DetailedTaskV2;
              if (!isClosed()) accept({ generation: "v2", task: current });
              await this.acquireV2TaskInputs(
                current,
                options.applicationContext as TApplicationContext,
                inputSignal,
                signal,
                acquiredInputs,
              );
            }
            if (isClosed()) throw closedError;
            if (current.status === "cancelled") throw cancelledError;
            if (current.status === "failed")
              throw new JsonRpcResponseError(current.error);
            if (current.status !== "completed")
              throw new Error(
                `Unsupported terminal task status: ${current.status}`,
              );
            return decodeResult(codec, current.result);
          },
          async (signal) => {
            decodeResult(
              CancelTaskResultV2Codec,
              responseResult(
                await dispatchWithRetry(
                  this.port,
                  {
                    method: "tasks/cancel",
                    params: withTaskCapabilityV2({ taskId: reference.taskId }),
                  },
                  signal,
                  "mutate",
                ),
              ),
            );
          },
          this.lifecycleController.signal,
        ),
      );
    } finally {
      resumeLifecycle.dispose();
    }
  }

  private async acquireV2TaskInputs(
    task: DetailedTaskV2,
    applicationContext: TApplicationContext,
    inputSignal: AbortSignal,
    signal: AbortSignal,
    acquiredInputs: Map<string, string>,
  ): Promise<void> {
    if (task.status !== "input_required") return;
    const inputResponses: Record<string, InputResponseV2> = {};
    for (const [inputKey, inputRequest] of Object.entries(task.inputRequests)) {
      const signature = deterministicJson(inputRequest);
      const acquiredSignature = acquiredInputs.get(inputKey);
      if (acquiredSignature !== undefined) {
        if (acquiredSignature !== signature)
          this.reportBackgroundError(
            new Error(`V2 task input key ${inputKey} was reused incompatibly`),
          );
        continue;
      }
      acquiredInputs.set(inputKey, signature);
      const request: InputRequestV2 = inputRequest;
      const projected: ApplicationInputRequest | undefined =
        request.method === "sampling/createMessage"
          ? { kind: "sampling", params: request.params }
          : request.method === "roots/list"
            ? {
                kind: "roots",
                ...(request.params === undefined
                  ? {}
                  : { params: request.params }),
              }
            : request.method === "elicitation/create"
              ? { kind: "elicitation", params: request.params }
              : undefined;
      if (projected === undefined) {
        this.reportBackgroundError(
          new Error(`Unknown V2 task input method for key ${inputKey}`),
        );
        continue;
      }
      let result: unknown;
      if (this.options.onInputRequest === undefined) {
        if (request.method !== "elicitation/create") continue;
        result = { action: "cancel" };
      } else {
        try {
          result = await this.options.onInputRequest(projected, {
            lifetime: "task-v2",
            taskId: task.taskId,
            inputKey,
            applicationContext,
            signal: inputSignal,
          });
        } catch {
          if (inputSignal.aborted) return;
          if (request.method !== "elicitation/create") continue;
          result = { action: "cancel" };
        }
      }
      try {
        const responseCodec =
          request.method === "sampling/createMessage"
            ? CreateMessageResultV2Codec
            : request.method === "roots/list"
              ? ListRootsResultV2Codec
              : ElicitResultV2Codec;
        inputResponses[inputKey] = decodeResult(
          responseCodec as RuntimeCodec<InputResponseV2>,
          result as JsonValue,
        );
      } catch (error) {
        this.reportBackgroundError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (inputSignal.aborted || Object.keys(inputResponses).length === 0) return;
    decodeResult(
      UpdateTaskResultV2Codec,
      responseResult(
        await dispatchWithRetry(
          this.port,
          {
            method: "tasks/update",
            params: withTaskCapabilityV2({
              taskId: task.taskId,
              inputResponses,
            }),
          },
          signal,
          "mutate",
        ),
      ),
    );
  }

  private cleanupLateTaskCreation(
    response: JsonRpcResponse,
    generation: SessionTaskCapabilities["generation"],
    callAsTaskV1: boolean,
  ): void {
    if (response.kind !== "result") return;
    let taskId: TaskId | undefined;
    let params: JsonValue | undefined;
    if (generation === "v1" && callAsTaskV1) {
      const parsed = CreateTaskResultV1Codec.parse(response.result);
      if (parsed.success) {
        taskId = parsed.value.task.taskId as TaskId;
        params = { taskId };
      }
    } else if (generation === "v2" && isCreateTaskResultV2(response.result)) {
      const parsed = CreateTaskResultV2Codec.parse(response.result);
      if (parsed.success) {
        taskId = parsed.value.taskId as TaskId;
        params = withTaskCapabilityV2({ taskId });
      }
    }
    if (taskId === undefined || params === undefined) return;
    void dispatchWithRetry(
      this.port,
      { method: "tasks/cancel", params },
      undefined,
      "mutate",
    ).catch(() => {
      // A task returned after call abort is cleaned up on a best-effort basis.
    });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const execution of this.activeTaskExecutions) {
        void execution.close().catch(() => {});
      }
      this.lifecycleController.abort(
        new Error("Task-enabled session is closed"),
      );
      for (const dispose of this.disposeListeners) {
        try {
          dispose();
        } catch (error) {
          this.closeError ??= reasonAsError(error);
        }
      }
    }
    return this.closeError === undefined
      ? Promise.resolve()
      : Promise.reject(this.closeError);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private trackTaskExecution<TResult>(
    execution: TaskExecution<TResult, TApplicationContext>,
    v1InputCandidate?: V1TaskInputCandidate<TApplicationContext>,
  ): TaskExecution<TResult, TApplicationContext> {
    const tracked = execution as TaskExecution<unknown, TApplicationContext>;
    this.activeTaskExecutions.add(tracked);
    if (
      v1InputCandidate !== undefined &&
      v1InputCandidate.signal?.aborted !== true
    ) {
      this.v1TaskInputCandidates.set(
        v1InputCandidate.executionId,
        v1InputCandidate,
      );
      v1InputCandidate.signal?.addEventListener(
        "abort",
        () => this.v1TaskInputCandidates.delete(v1InputCandidate.executionId),
        { once: true },
      );
    }
    void execution
      .result()
      .catch(() => {})
      .finally(() => {
        execution.endInputLifetime();
        this.activeTaskExecutions.delete(tracked);
        if (v1InputCandidate !== undefined)
          this.v1TaskInputCandidates.delete(v1InputCandidate.executionId);
      });
    return execution;
  }

  private handleNotification(notification: JsonValue): void {
    this.managedDeclarations?.onNotification(notification);
    if (
      notification === null ||
      Array.isArray(notification) ||
      typeof notification !== "object"
    )
      return;
    const method = (notification as Readonly<Record<string, JsonValue>>).method;
    const generation = this.port.taskCapabilities.generation;
    const parsed =
      generation === "v1" && method === "notifications/tasks/status"
        ? TaskStatusNotificationV1Codec.parse(notification)
        : generation === "v2" && method === "notifications/tasks"
          ? TaskStatusNotificationV2Codec.parse(notification)
          : undefined;
    if (parsed === undefined) return;
    if (!parsed.success) {
      this.reportBackgroundError(parsed.error);
      return;
    }
    const snapshot: TaskSnapshot =
      generation === "v1"
        ? { generation: "v1", task: parsed.value.params as TaskV1 }
        : { generation: "v2", task: parsed.value.params as DetailedTaskV2 };
    for (const execution of this.activeTaskExecutions) {
      execution.onNotification(snapshot);
    }
  }

  private async handleServerRequest(
    incoming: IncomingServerRequest,
  ): Promise<JsonRpcResponse> {
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
    const taskCandidates = [...this.v1TaskInputCandidates.values()];
    const ordinaryCandidates = [...this.ordinaryInputCandidates.values()];
    const params = request.params;
    const meta = params?._meta;
    const relatedTaskKey = "io.modelcontextprotocol/related-task";
    let evidence: "absent" | "invalid" | { readonly taskId: string };
    if (meta === undefined) evidence = "absent";
    else if (meta === null || Array.isArray(meta) || typeof meta !== "object")
      evidence = "invalid";
    else {
      const relatedTask = (meta as Readonly<Record<string, JsonValue>>)[
        relatedTaskKey
      ];
      if (relatedTask === undefined) evidence = "absent";
      else if (
        relatedTask === null ||
        Array.isArray(relatedTask) ||
        typeof relatedTask !== "object" ||
        typeof (relatedTask as Readonly<Record<string, JsonValue>>).taskId !==
          "string"
      )
        evidence = "invalid";
      else
        evidence = {
          taskId: (relatedTask as Readonly<Record<string, JsonValue>>)
            .taskId as string,
        };
    }
    const allCandidates = [...ordinaryCandidates, ...taskCandidates];
    const matches =
      evidence === "absent" || evidence === "invalid"
        ? allCandidates
        : taskCandidates.filter(
            (candidate) => candidate.taskId === evidence.taskId,
          );
    const failureReason: InputCorrelationFailureReason | undefined =
      evidence === "invalid"
        ? "invalid-evidence"
        : evidence === "absent" && matches.length === 0
          ? "missing-evidence"
          : matches.length === 0
            ? "zero-matches"
            : matches.length > 1
              ? "ambiguous-matches"
              : undefined;
    if (failureReason !== undefined) {
      const candidates = matches.map((candidate) => ({
        generation: candidate.generation,
        toolName: candidate.toolName,
        executionId: candidate.executionId,
        applicationContext: candidate.applicationContext,
      }));
      this.reportBackgroundError(
        new InputCorrelationError(
          this.port.taskCapabilities.generation === "none"
            ? "v1"
            : this.port.taskCapabilities.generation,
          request.kind,
          candidates,
          failureReason,
        ),
      );
      return defaultServerRequestResponse(incoming);
    }
    const candidate = matches[0];
    if (this.options.onInputRequest === undefined)
      return defaultServerRequestResponse(incoming);
    try {
      const context: ResolvedInputExchangeContext<TApplicationContext> =
        candidate.lifetime === "task-v1"
          ? {
              lifetime: "task-v1",
              taskId: candidate.taskId,
              applicationContext: candidate.applicationContext,
              ...(candidate.signal === undefined
                ? {}
                : { signal: candidate.signal }),
            }
          : {
              lifetime: "basic",
              executionId: candidate.executionId,
              applicationContext: candidate.applicationContext,
              ...(candidate.signal === undefined
                ? {}
                : { signal: candidate.signal }),
            };
      const result = await this.options.onInputRequest(request, context);
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

export function withTasks<TApplicationContext = void>(
  session: ConnectedMcpSessionPort,
  options?: WithTasksOptions<TApplicationContext>,
): TaskEnabledSession<TApplicationContext>;
export function withTasks<TApplicationContext = void>(
  client: Client,
  options: WithTasksOptions<TApplicationContext> & {
    readonly endpointId: string;
  },
): TaskEnabledSession<TApplicationContext>;
export function withTasks<TApplicationContext = void>(
  session: ConnectedMcpSessionPort | Client,
  options: WithTasksOptions<TApplicationContext> & {
    readonly endpointId?: string;
  } = {},
): TaskEnabledSession<TApplicationContext> {
  if (isConnectedMcpSessionPort(session))
    return new PortTaskEnabledSession(session, options);
  if (!isClientPublicSurface(session))
    throw new TypeError(
      "withTasks requires a ConnectedMcpSessionPort or Client-compatible object",
    );
  const endpointId = options.endpointId;
  if (endpointId === undefined)
    throw new TypeError("withTasks(Client) requires options.endpointId");
  const port = new ClientSessionPort(session, endpointId);
  try {
    return new PortTaskEnabledSession(port, options, () =>
      port[Symbol.dispose](),
    );
  } catch (error) {
    port[Symbol.dispose]();
    throw error;
  }
}
