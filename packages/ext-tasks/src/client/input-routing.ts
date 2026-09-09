import type { JsonValue, TaskGeneration, TaskId } from "../core/index.js";
import { withRelatedTaskMetadata } from "./api.js";
import type {
  ApplicationInputCallbacks,
  ApplicationInputHandler,
  ApplicationInputRequest,
  ApplicationInputResult,
  InputCorrelationFailureReason,
  ResolvedInputExchangeContext,
} from "./api.js";
import type { IncomingServerRequest, JsonRpcResponse } from "./port.js";

/** Returns object-valued request parameters, defaulting an omitted value to empty. */
export function requestParams(
  request: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  if (!Object.hasOwn(request, "params")) return {};
  if (
    request.params === null ||
    Array.isArray(request.params) ||
    typeof request.params !== "object"
  ) {
    throw new Error("Input request params must be an object");
  }
  return request.params as Readonly<Record<string, JsonValue>>;
}

export interface OrdinaryInputCandidate<TApplicationContext> {
  readonly lifetime: "basic";
  readonly generation: TaskGeneration;
  readonly toolName: string;
  readonly executionId: string;
  readonly applicationContext: TApplicationContext;
  readonly signal?: AbortSignal;
}

export interface V1TaskInputCandidate<TApplicationContext> {
  readonly lifetime: "task-v1";
  readonly generation: "v1";
  readonly taskId: TaskId;
  readonly toolName: string;
  readonly executionId: string;
  readonly applicationContext: TApplicationContext;
  readonly signal?: AbortSignal;
}

export type InputCandidate<TApplicationContext> =
  | OrdinaryInputCandidate<TApplicationContext>
  | V1TaskInputCandidate<TApplicationContext>;

export type RelatedTaskEvidence =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "task-id"; readonly taskId: string };

export interface InputCandidateProjection {
  readonly toolName: string;
  readonly executionId: string;
}

export type InputCandidateResolution<TApplicationContext> =
  | {
      readonly kind: "resolved";
      readonly candidate: InputCandidate<TApplicationContext>;
    }
  | {
      readonly kind: "failed";
      readonly reason: InputCorrelationFailureReason;
      readonly candidates: readonly InputCandidateProjection[];
    };

function existingMetadata(
  request: ApplicationInputRequest,
): Readonly<Record<string, JsonValue>> | undefined {
  const metadata = request.params?._meta;
  if (
    metadata === null ||
    Array.isArray(metadata) ||
    typeof metadata !== "object"
  )
    return undefined;
  return metadata as Readonly<Record<string, JsonValue>>;
}

function withContextRelatedTask<TRequest extends ApplicationInputRequest>(
  request: TRequest,
  context: ResolvedInputExchangeContext<unknown>,
): TRequest {
  if (context.scope !== "task" || context.taskId === undefined) return request;
  return {
    ...request,
    params: {
      ...request.params,
      _meta: withRelatedTaskMetadata(existingMetadata(request), {
        taskId: context.taskId,
      }),
    },
  };
}

function unreachableInputRequest(request: never): never {
  throw new TypeError(
    `Unsupported application input request: ${String(request)}`,
  );
}

/** Creates an exhaustive application input handler from kind-specific callbacks. */
export function createApplicationInputHandler<TApplicationContext = void>(
  callbacks: ApplicationInputCallbacks<TApplicationContext>,
): ApplicationInputHandler<TApplicationContext>["handle"] {
  return async <TRequest extends ApplicationInputRequest>(
    originalRequest: TRequest,
    context: ResolvedInputExchangeContext<TApplicationContext>,
  ): Promise<ApplicationInputResult<TRequest>> => {
    const request = withContextRelatedTask(originalRequest, context);
    switch (request.kind) {
      case "elicitation":
        return (await callbacks.elicitation(
          request,
          context,
        )) as ApplicationInputResult<TRequest>;
      case "sampling":
        return (await callbacks.sampling(
          request,
          context,
        )) as ApplicationInputResult<TRequest>;
      case "roots":
        return (await callbacks.roots(
          request,
          context,
        )) as ApplicationInputResult<TRequest>;
      default:
        return unreachableInputRequest(request);
    }
  };
}

/** Projects a supported wire request into the application input request shape. */
export function projectApplicationInputRequest(
  incoming: IncomingServerRequest,
): ApplicationInputRequest | undefined {
  if (
    incoming.request === null ||
    Array.isArray(incoming.request) ||
    typeof incoming.request !== "object"
  ) {
    return undefined;
  }
  const wire = incoming.request as Readonly<Record<string, JsonValue>>;
  if (wire.method === "elicitation/create") {
    return { kind: "elicitation", params: requestParams(wire) };
  }
  if (wire.method === "sampling/createMessage") {
    return { kind: "sampling", params: requestParams(wire) };
  }
  if (wire.method === "roots/list") {
    return {
      kind: "roots",
      ...(Object.hasOwn(wire, "params") ? { params: requestParams(wire) } : {}),
    };
  }
  return undefined;
}

/** Reads related-task metadata without conflating absence with malformed evidence. */
export function readRelatedTaskEvidence(
  request: ApplicationInputRequest,
): RelatedTaskEvidence {
  const meta = request.params?._meta;
  const relatedTaskKey = "io.modelcontextprotocol/related-task";
  if (meta === undefined) return { kind: "absent" };
  if (meta === null || Array.isArray(meta) || typeof meta !== "object")
    return { kind: "invalid" };
  if (!Object.hasOwn(meta, relatedTaskKey)) return { kind: "absent" };
  const relatedTask = (meta as Readonly<Record<string, JsonValue>>)[
    relatedTaskKey
  ];
  if (
    relatedTask === null ||
    Array.isArray(relatedTask) ||
    typeof relatedTask !== "object" ||
    typeof (relatedTask as Readonly<Record<string, JsonValue>>).taskId !==
      "string"
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "task-id",
    taskId: (relatedTask as Readonly<Record<string, JsonValue>>)
      .taskId as string,
  };
}

function correlationFailureReason(
  evidence: RelatedTaskEvidence,
  matchCount: number,
): InputCorrelationFailureReason | undefined {
  if (evidence.kind === "invalid") return "invalid-evidence";
  if (matchCount > 1) return "ambiguous-matches";
  if (matchCount === 0)
    return evidence.kind === "absent" ? "missing-evidence" : "zero-matches";
  return undefined;
}

/** Resolves the unique input candidate while preserving correlation diagnostics. */
export function resolveInputCandidate<TApplicationContext>(
  evidence: RelatedTaskEvidence,
  ordinaryCandidates: readonly OrdinaryInputCandidate<TApplicationContext>[],
  taskCandidates: readonly V1TaskInputCandidate<TApplicationContext>[],
): InputCandidateResolution<TApplicationContext> {
  const matches: readonly InputCandidate<TApplicationContext>[] =
    evidence.kind === "task-id"
      ? taskCandidates.filter(
          (candidate) => candidate.taskId === evidence.taskId,
        )
      : evidence.kind === "absent"
        ? ordinaryCandidates
        : [];
  const reason = correlationFailureReason(evidence, matches.length);
  if (reason !== undefined) {
    return {
      kind: "failed",
      reason,
      candidates: matches.map((candidate) => ({
        toolName: candidate.toolName,
        executionId: candidate.executionId,
      })),
    };
  }
  return { kind: "resolved", candidate: matches[0] };
}

/** Converts a matched candidate to handler context. */
export function buildResolvedInputContext<TApplicationContext>(
  candidate: InputCandidate<TApplicationContext>,
): ResolvedInputExchangeContext<TApplicationContext> {
  if (candidate.lifetime === "task-v1") {
    return {
      scope: "task",
      delivery: "peer-request",
      taskId: candidate.taskId,
      applicationContext: candidate.applicationContext,
      ...(candidate.signal === undefined ? {} : { signal: candidate.signal }),
    };
  }
  return {
    scope: "request",
    delivery: "peer-request",
    inputId: candidate.executionId,
    applicationContext: candidate.applicationContext,
    ...(candidate.signal === undefined ? {} : { signal: candidate.signal }),
  };
}

let nextExecutionId = 0;

/** Allocates a process-local identifier for an ordinary tool execution. */
export function nextExecutionIdentifier(): string {
  return `execution-${String(++nextExecutionId)}`;
}

/** Returns the conservative fallback response for an unhandled server request. */
export function defaultServerRequestResponse(
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

/** Throws if the signal is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
