/** Requester-side MCP Tasks session and execution support. */

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
  CreateTaskResultV2Codec,
  GetTaskResultV2Codec,
  TaskStatusNotificationV2Codec,
  ToolV2Codec,
  isCreateTaskResultV2,
  withTaskCapabilityV2,
  type CallToolResultV2,
  type DetailedTaskV2,
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

function unsupported(feature: string): Error {
  return new Error(`${feature} is not supported`);
}

const DEFAULT_TASK_POLL_INTERVAL_MS = 10;
const V2_INPUT_REQUIRED_UNSUPPORTED_MESSAGE =
  "V2 input_required tasks are not supported until tasks/update is available";

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
) => Promise<TResult>;

class TaskExecution<
  TResult,
  TApplicationContext,
> implements ToolExecutionCommon<TResult, TApplicationContext> {
  readonly kind = "task" as const;
  private readonly controller = new AbortController();
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
    initialSnapshot: TaskSnapshot,
    driver: TaskDriver<TResult>,
    private readonly cancelTask: (signal?: AbortSignal) => Promise<void>,
    lifecycleSignal?: AbortSignal,
  ) {
    this.initialSnapshot = initialSnapshot;
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
    );
  }

  onNotification(snapshot: TaskSnapshot): void {
    if (this.closed || snapshot.generation !== this.handle.generation) return;
    if (snapshot.task.taskId !== this.handle.taskId) return;
    const bytes = deterministicJson(snapshot);
    if (terminalStatus(snapshot.task.status)) {
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
  private readonly lifecycleController = new AbortController();
  private invalidationError: Error | undefined;
  private readonly disposeListeners: readonly (() => void)[];
  private readonly declarations: ToolDeclarationProvider;
  private readonly managedDeclarations: ManagedToolDeclarations | undefined;
  private readonly ordinaryInputCandidates = new Map<
    string,
    OrdinaryInputCandidate<TApplicationContext>
  >();
  private readonly activeTaskExecutions = new Set<
    TaskExecution<unknown, TApplicationContext>
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
      return this.trackTaskExecution(
        new TaskExecution(
          options.applicationContext as TApplicationContext,
          handle,
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
        ),
      );
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
            let status = created.status;
            let current: DetailedTaskV2 | undefined;
            let notificationSequence = 0;
            if (status === "input_required")
              throw new Error(V2_INPUT_REQUIRED_UNSUPPORTED_MESSAGE);
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
              if (status === "input_required")
                throw new Error(V2_INPUT_REQUIRED_UNSUPPORTED_MESSAGE);
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

  resumeTask<TResult = CallToolResultV1 | CallToolResultV2>(
    reference: SerializedTaskReference,
    options?: {
      readonly resultCodec?: RuntimeCodec<TResult>;
      readonly applicationContext?: TApplicationContext;
      readonly signal?: AbortSignal;
    },
  ): Promise<ToolExecution<TResult, TApplicationContext>> {
    void reference;
    void options;
    this.assertUsable();
    return Promise.reject(unsupported("Task resumption"));
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
      for (const dispose of this.disposeListeners) dispose();
    }
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private trackTaskExecution<TResult>(
    execution: TaskExecution<TResult, TApplicationContext>,
  ): TaskExecution<TResult, TApplicationContext> {
    const tracked = execution as TaskExecution<unknown, TApplicationContext>;
    this.activeTaskExecutions.add(tracked);
    void execution
      .result()
      .catch(() => {})
      .finally(() => this.activeTaskExecutions.delete(tracked));
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

export function withTasks<TApplicationContext = void>(
  session: ConnectedMcpSessionPort,
  options: WithTasksOptions<TApplicationContext> = {},
): TaskEnabledSession<TApplicationContext> {
  return new PortTaskEnabledSession(session, options);
}
