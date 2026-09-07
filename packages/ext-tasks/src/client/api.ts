import type {
  JsonValue,
  RuntimeCodec,
  TaskGeneration,
  TaskId,
  TaskSnapshot,
} from "../core/index.js";
import type {
  CallToolResultV1,
  TaskEligibleMethodV1,
  ToolV1,
} from "../core/v1/index.js";
import type {
  CallToolResultV2,
  ErrorV2,
  TaskEligibleMethodV2,
  ToolV2,
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

export class TaskRecoveryOwnershipError extends Error {
  constructor(
    readonly generation: TaskGeneration,
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

export type ToolDeclaration =
  | {
      readonly generation: "v1";
      readonly tool: ToolV1;
    }
  | {
      readonly generation: "v2";
      readonly tool: ToolV2;
    };

/** Tags a generated V1 tool declaration for a host-supplied provider. */
export function toolDeclarationV1(tool: ToolV1): ToolDeclaration {
  return { generation: "v1", tool };
}

/** Tags a generated V2 tool declaration for a host-supplied provider. */
export function toolDeclarationV2(tool: ToolV2): ToolDeclaration {
  return { generation: "v2", tool };
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

export interface InputCorrelationCandidate {
  readonly generation: TaskGeneration;
  readonly toolName: string;
  readonly executionId: string;
}

export class InputCorrelationError extends Error {
  constructor(
    readonly generation: TaskGeneration,
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

/** Options for one tool call, including host-owned wire context. */
export interface ToolCallOptions<TResult, TApplicationContext = void> {
  readonly resultCodec?: RuntimeCodec<TResult>;
  readonly applicationContext?: TApplicationContext;
  readonly signal?: AbortSignal;
  readonly preferTask?: boolean;
  /** Arbitrary request metadata preserved alongside package-owned keys. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  /** Additional headers for the initiating call and task follow-up requests. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Requested V1 task lifetime in milliseconds. Ignored when no V1 task is requested. */
  readonly taskTtl?: number;
}

export interface TaskEnabledSession<TApplicationContext = void> {
  callTool<TResult = CallToolResultV1 | CallToolResultV2>(
    name: string,
    params?: Readonly<Record<string, JsonValue>>,
    options?: ToolCallOptions<TResult, TApplicationContext>,
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
