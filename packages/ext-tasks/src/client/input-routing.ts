import type { JsonValue, TaskGeneration, TaskId } from "../core/index.js";
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

/** Throws the abort reason when a signal has already been aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}
