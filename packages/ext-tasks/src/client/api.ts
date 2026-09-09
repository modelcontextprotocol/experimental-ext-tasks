import { toJsonValue } from "../core/index.js";
import type { JsonValue, RuntimeCodec, TaskId } from "../core/index.js";
import type {
  CallToolResultV1,
  TaskEligibleMethodV1,
} from "../core/v1/index.js";
import type {
  CallToolResultV2,
  ErrorV2,
  InputResponsesV2,
  TaskEligibleMethodV2,
} from "../core/v2/index.js";

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

/** Generation-neutral terminal task failure, preserving protocol details when present. */
export class TaskFailedError extends Error {
  readonly code?: number;
  readonly data?: JsonValue;

  constructor(
    message: string,
    details: { readonly code?: number; readonly data?: JsonValue } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskFailedError";
    if (details.code !== undefined) this.code = details.code;
    if (details.data !== undefined) this.data = details.data;
  }
}

/** Typed sentinel used when remote task execution terminates by cancellation. */
export class TaskCancelledError extends Error {
  constructor(options?: ErrorOptions) {
    super("Task was cancelled", options);
    this.name = "TaskCancelledError";
  }
}

export class TaskRetentionUnsupportedError extends Error {
  constructor() {
    super("Requested task retention is not supported by this session");
    this.name = "TaskRetentionUnsupportedError";
  }
}

export class TaskRecoveryOwnershipError extends Error {
  constructor(
    readonly taskId: TaskId,
    readonly originalOperation: string,
    readonly activeOriginalOperation: string,
  ) {
    const collision = originalOperation !== activeOriginalOperation;
    super(
      collision
        ? `Task recovery identity collides with active operation ${activeOriginalOperation}`
        : "Task recovery already has an active owner",
    );
    this.name = "TaskRecoveryOwnershipError";
  }
}

/** Structural tool declaration independent of a negotiated Tasks generation. */
export interface ToolDeclaration {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchema?: Readonly<Record<string, JsonValue>>;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly icons?: readonly Readonly<Record<string, JsonValue>>[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly taskSupport?: "forbidden" | "optional" | "required";
  /** Unrecognized top-level declaration data retained for inspection and projection. */
  readonly extensions?: Readonly<Record<string, JsonValue>>;
  /** Unrecognized fields nested under the MCP tool execution declaration. */
  readonly executionExtensions?: Readonly<Record<string, JsonValue>>;
}

/** Creates a generation-neutral structural tool declaration. */
export function toolDeclaration(
  declaration: ToolDeclaration & {
    readonly execution?: {
      readonly taskSupport?: ToolDeclaration["taskSupport"];
      readonly extensions?: Readonly<Record<string, JsonValue>>;
    };
  },
): ToolDeclaration {
  const { execution, ...neutral } = declaration;
  return {
    ...neutral,
    ...(neutral.taskSupport === undefined &&
    execution?.taskSupport !== undefined
      ? { taskSupport: execution.taskSupport }
      : {}),
    ...(neutral.executionExtensions === undefined &&
    execution?.extensions !== undefined
      ? { executionExtensions: execution.extensions }
      : {}),
  };
}

/** Returns request metadata with standard related-task evidence installed. */
export function withRelatedTaskMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined,
  task: Pick<TaskHandle, "taskId">,
): Readonly<Record<string, JsonValue>> {
  return {
    ...metadata,
    "io.modelcontextprotocol/related-task": { taskId: task.taskId },
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => {
    const serializedLeft = JSON.stringify(left);
    const serializedRight = JSON.stringify(right);
    return serializedLeft < serializedRight
      ? -1
      : serializedLeft > serializedRight
        ? 1
        : 0;
  });
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export interface ToolDeclarationProvider {
  currentTool(name: string): ToolDeclaration | undefined;
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

export interface ResolvedInputExchangeContext<TApplicationContext = void> {
  readonly scope: "request" | "task";
  readonly delivery: "peer-request" | "request-retry" | "task-update";
  readonly taskId?: TaskId;
  readonly inputId?: string;
  readonly applicationContext: TApplicationContext;
  readonly signal?: AbortSignal;
}

export interface ApplicationInputHandler<TApplicationContext = void> {
  handle<TRequest extends ApplicationInputRequest>(
    request: TRequest,
    context: ResolvedInputExchangeContext<TApplicationContext>,
  ): Promise<ApplicationInputResult<TRequest>>;
}

export interface ApplicationInputCallbacks<TApplicationContext = void> {
  readonly elicitation: (
    request: Extract<ApplicationInputRequest, { readonly kind: "elicitation" }>,
    context: ResolvedInputExchangeContext<TApplicationContext>,
  ) => ApplicationElicitResult | Promise<ApplicationElicitResult>;
  readonly sampling: (
    request: Extract<ApplicationInputRequest, { readonly kind: "sampling" }>,
    context: ResolvedInputExchangeContext<TApplicationContext>,
  ) => ApplicationCreateMessageResult | Promise<ApplicationCreateMessageResult>;
  readonly roots: (
    request: Extract<ApplicationInputRequest, { readonly kind: "roots" }>,
    context: ResolvedInputExchangeContext<TApplicationContext>,
  ) => ApplicationListRootsResult | Promise<ApplicationListRootsResult>;
}

export type InputCorrelationFailureReason =
  | "missing-evidence"
  | "invalid-evidence"
  | "zero-matches"
  | "ambiguous-matches";

export interface InputCorrelationCandidate {
  readonly toolName: string;
  readonly executionId: string;
}

export class InputCorrelationError extends Error {
  constructor(
    readonly requestKind: ApplicationInputRequest["kind"],
    readonly candidates: readonly InputCorrelationCandidate[],
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

/** Opaque current-session identity for a managed task. */
export interface TaskHandle {
  readonly taskId: TaskId;
  readonly operation: string;
}

export type TaskState =
  "working" | "input_required" | "completed" | "failed" | "cancelled";

/** Generation-neutral task data suitable for application and UI use. */
export interface TaskView {
  readonly taskId: TaskId;
  readonly status: TaskState;
  readonly statusMessage?: string;
  readonly createdAt?: string;
  readonly lastUpdatedAt?: string;
  readonly retentionMs: number | null;
  readonly suggestedPollIntervalMs?: number;
  /** Compatibility alias for retentionMs; prefer retentionMs in new code. */
  readonly ttl: number | null;
  /** Compatibility alias for suggestedPollIntervalMs; prefer that primary name in new code. */
  readonly pollInterval?: number;
  readonly raw: Readonly<Record<string, JsonValue>>;
  readonly extensions: Readonly<Record<string, JsonValue>>;
}

/** One page of server-owned task inventory. */
export interface TaskListPage {
  readonly tasks: readonly TaskView[];
  readonly nextCursor?: string;
}

export type TaskOutcome<TResult> =
  | {
      readonly status: "completed";
      readonly result: TResult;
      readonly task?: TaskView;
    }
  | {
      readonly status: "failed";
      readonly error: TaskFailedError;
      readonly task?: TaskView;
    }
  | { readonly status: "cancelled"; readonly task?: TaskView };

export type TaskExecutionEvent<TResult> =
  | { readonly type: "task"; readonly task: TaskView }
  | { readonly type: "outcome"; readonly outcome: TaskOutcome<TResult> };

/** Returns the task represented by an execution event, when one is available. */
export function taskViewFromExecutionEvent<TResult>(
  event: TaskExecutionEvent<TResult>,
): TaskView | undefined {
  return event.type === "task" ? event.task : event.outcome.task;
}

/** Unwraps a completed outcome or throws its typed failure/cancellation error. */
export function resultFromTaskOutcome<TResult>(
  outcome: TaskOutcome<TResult>,
): TResult {
  if (outcome.status === "completed") return outcome.result;
  if (outcome.status === "failed") throw outcome.error;
  throw new TaskCancelledError();
}

export interface ToolExecutionSettleOptions<TResult = unknown> {
  /** Stops local waiting and observation without cancelling the remote task. */
  readonly signal?: AbortSignal;
  readonly onEvent?: (
    event: TaskExecutionEvent<TResult>,
  ) => void | Promise<void>;
  /** Best-effort closes the execution after natural settlement. Defaults to true. */
  readonly close?: boolean;
}

export interface ToolExecutionSettlement<TResult> {
  readonly outcome: TaskOutcome<TResult>;
  readonly lastTask: TaskView | undefined;
}

export interface ToolExecutionCommon<TResult, TApplicationContext = void> {
  readonly applicationContext: TApplicationContext;
  readonly declaration: ToolDeclaration | undefined;
  /**
   * Acquires the one-owner update stream. A second acquisition throws.
   * Settlement observes independently and does not acquire or drain this stream.
   */
  updates(signal?: AbortSignal): AsyncIterable<TaskExecutionEvent<TResult>>;
  result(): Promise<TaskOutcome<TResult>>;
  /**
   * Returns one cached settlement. The first call owns observation/cleanup options;
   * later calls return that same promise regardless of their supplied options.
   */
  settle(
    options?: ToolExecutionSettleOptions<TResult>,
  ): Promise<ToolExecutionSettlement<TResult>>;
  cancel(signal?: AbortSignal): Promise<void>;
  /** Stops local driving and releases ownership without cancelling the remote task. */
  detach(): Promise<void>;
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
      /** Persists a resumable reference, then releases local ownership. */
      handoff(
        persist: (reference: SerializedTaskReference) => void | Promise<void>,
      ): Promise<void>;
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

export type TaskPreference = "allow" | "prefer" | "require" | "forbid";
export type TaskRetentionPolicy = "best-effort" | "require-capability";

export interface TaskOptions {
  readonly preference?: TaskPreference;
  readonly retentionMs?: number;
  /** Defaults to best-effort; strict mode rejects before dispatch if unsupported. */
  readonly retention?: TaskRetentionPolicy;
}

/** Options for one tool call, including host-owned wire context. */
export interface ToolCallOptions<TResult, TApplicationContext = void> {
  readonly resultCodec?: RuntimeCodec<TResult>;
  /** Execution-scoped declaration. Takes precedence over the session provider. */
  readonly declaration?: ToolDeclaration;
  readonly applicationContext?: TApplicationContext;
  readonly signal?: AbortSignal;
  readonly task?: TaskOptions;
  /** Arbitrary request metadata preserved alongside package-owned keys. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  /** Additional headers for the initiating call and task follow-up requests. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-request timeout in milliseconds for the initiating call and task follow-ups. */
  readonly requestTimeoutMs?: number;
}

export interface TaskControllerOptions {
  /** Additional headers preserved on every task request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-request timeout in milliseconds preserved on every task request. */
  readonly requestTimeoutMs?: number;
}

export interface TaskResultOptions<TResult> {
  readonly resultCodec?: RuntimeCodec<TResult>;
  readonly signal?: AbortSignal;
}

export interface TaskController {
  readonly taskId: TaskId;
  readonly capabilities: TaskCapabilities;
  snapshot(signal?: AbortSignal): Promise<TaskView>;
  result<TResult = CallToolResultV1 | CallToolResultV2>(
    options?: TaskResultOptions<TResult>,
  ): Promise<TaskOutcome<TResult>>;
  cancel(signal?: AbortSignal): Promise<void>;
  update(inputResponses: InputResponsesV2, signal?: AbortSignal): Promise<void>;
  updateJson(inputResponses: unknown, signal?: AbortSignal): Promise<void>;
}

export interface TaskCapabilities {
  readonly inventory: "server-list" | "known-handles" | "unsupported";
  readonly execution: boolean;
  readonly cancellation: boolean;
  readonly inputResponses: boolean;
  readonly requestedRetention: boolean;
}

export class TaskInputUpdateUnsupportedError extends Error {
  constructor() {
    super("Task input response updates require a V2 task session");
    this.name = "TaskInputUpdateUnsupportedError";
  }
}

export type TaskSessionEndpointId = string & {
  readonly __taskSessionEndpointId: unique symbol;
};

/**
 * Creates a stable endpoint identity from host-owned connection semantics.
 * Object keys in the descriptor are sorted recursively before a versioned SHA-256 digest.
 */
export async function createTaskSessionEndpointId(
  namespace: string,
  descriptor: unknown,
): Promise<TaskSessionEndpointId> {
  if (namespace.length === 0)
    throw new TypeError("Endpoint namespace must not be empty");
  const payload = new TextEncoder().encode(
    canonicalJson(toJsonValue(descriptor)),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${namespace}:v1:sha256:${hex}` as TaskSessionEndpointId;
}

export interface TaskRecoveryOptions<TResult, TApplicationContext = void> {
  readonly resultCodec?: RuntimeCodec<TResult>;
  readonly applicationContext?: TApplicationContext;
  readonly signal?: AbortSignal;
  /** Execution-scoped declaration. Takes precedence over the session provider. */
  readonly declaration?: ToolDeclaration;
}

export interface TaskEnabledSession<TApplicationContext = void> {
  readonly endpointId: TaskSessionEndpointId;
  readonly capabilities: TaskCapabilities;
  task(taskId: TaskId, options?: TaskControllerOptions): TaskController;
  /** Lists one page of server inventory. */
  listTasks(cursor?: string, signal?: AbortSignal): Promise<TaskListPage>;
  /** Cancels a live owned execution or a detached task controller by identity. */
  cancelTask(taskId: TaskId, signal?: AbortSignal): Promise<void>;
  callTool<TResult = CallToolResultV1 | CallToolResultV2>(
    name: string,
    params?: Readonly<Record<string, JsonValue>>,
    options?: ToolCallOptions<TResult, TApplicationContext>,
  ): Promise<ToolExecution<TResult, TApplicationContext>>;
  resumeTask<TResult = CallToolResultV1 | CallToolResultV2>(
    reference: SerializedTaskReference,
    options?: TaskRecoveryOptions<TResult, TApplicationContext>,
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
