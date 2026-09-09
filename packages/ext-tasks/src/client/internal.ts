/** Internal generation-aware records and neutral client projections. */

import type { JsonValue, TaskGeneration, TaskId } from "../core/index.js";
import type {
  CallToolResultV1,
  ServerTaskCapabilitiesV1,
  TaskV1,
  ToolV1,
} from "../core/v1/index.js";
import type {
  CallToolResultV2,
  DetailedTaskV2,
  TaskV2,
  ToolV2,
} from "../core/v2/index.js";
import {
  JsonRpcResponseError,
  TaskCancelledError,
  TaskFailedError,
} from "./api.js";
import type {
  TaskCapabilities,
  TaskHandle,
  TaskOutcome,
  TaskView,
  ToolDeclaration,
} from "./api.js";
import type { SessionTaskCapabilities } from "./port.js";

export type InternalTaskHandle =
  | {
      readonly generation: "v1";
      readonly taskId: TaskId;
      readonly originalOperation: "tools/call";
    }
  | {
      readonly generation: "v2";
      readonly taskId: TaskId;
      readonly originalOperation: "tools/call";
    };

export type InternalTaskSnapshot =
  | { readonly generation: "v1"; readonly task: TaskV1 }
  | { readonly generation: "v2"; readonly task: TaskV2 | DetailedTaskV2 };

/** Projects an internal handle to the opaque primary handle. */
export function publicTaskHandle(handle: InternalTaskHandle): TaskHandle {
  return { taskId: handle.taskId, operation: handle.originalOperation };
}

function jsonRecord(value: object): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
  );
}

/** Projects a generation-specific task snapshot to the primary task view. */
export function projectTask(snapshot: InternalTaskSnapshot): TaskView {
  const task = snapshot.task;
  const raw = cloneJson(jsonRecord(task)) as Readonly<
    Record<string, JsonValue>
  >;
  const known = new Set([
    "taskId",
    "status",
    "statusMessage",
    "createdAt",
    "lastUpdatedAt",
    "ttl",
    "ttlMs",
    "pollInterval",
    "pollIntervalMs",
  ]);
  const extensions = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !known.has(key)),
  );
  const protocolFields =
    snapshot.generation === "v1"
      ? {
          retentionMs: snapshot.task.ttl,
          ttl: snapshot.task.ttl,
          ...(snapshot.task.pollInterval === undefined
            ? {}
            : {
                suggestedPollIntervalMs: snapshot.task.pollInterval,
                pollInterval: snapshot.task.pollInterval,
              }),
        }
      : {
          retentionMs: snapshot.task.ttlMs,
          ttl: snapshot.task.ttlMs,
          ...(snapshot.task.pollIntervalMs === undefined
            ? {}
            : {
                suggestedPollIntervalMs: snapshot.task.pollIntervalMs,
                pollInterval: snapshot.task.pollIntervalMs,
              }),
        };
  return {
    taskId: task.taskId as TaskId,
    status: task.status,
    ...(task.statusMessage === undefined
      ? {}
      : { statusMessage: task.statusMessage }),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ...protocolFields,
    raw,
    extensions,
  };
}

/** Projects a generated tool declaration to the neutral declaration shape. */
export function projectTool(tool: ToolV1 | ToolV2): ToolDeclaration {
  const raw = jsonRecord(tool);
  const taskSupport =
    "execution" in tool &&
    tool.execution !== undefined &&
    tool.execution !== null &&
    typeof tool.execution === "object" &&
    "taskSupport" in tool.execution &&
    (tool.execution.taskSupport === "forbidden" ||
      tool.execution.taskSupport === "optional" ||
      tool.execution.taskSupport === "required")
      ? tool.execution.taskSupport
      : undefined;
  const known = new Set([
    "name",
    "title",
    "description",
    "inputSchema",
    "outputSchema",
    "annotations",
    "icons",
    "_meta",
    "execution",
  ]);
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations }),
    ...(tool.icons === undefined ? {} : { icons: tool.icons }),
    ...(tool._meta === undefined ? {} : { metadata: tool._meta }),
    ...(taskSupport === undefined ? {} : { taskSupport }),
    extensions: Object.fromEntries(
      Object.entries(raw).filter(([key]) => !known.has(key)),
    ),
  };
}

/** Projects a neutral declaration to the negotiated generated tool shape. */
export function projectToolForGeneration(
  declaration: ToolDeclaration,
  generation: "v1",
): ToolV1;
export function projectToolForGeneration(
  declaration: ToolDeclaration,
  generation: "v2",
): ToolV2;
export function projectToolForGeneration(
  declaration: ToolDeclaration,
  generation: TaskGeneration,
): ToolV1 | ToolV2 {
  const inputSchema = { type: "object" as const, ...declaration.inputSchema };
  const outputSchema =
    declaration.outputSchema === undefined
      ? undefined
      : { type: "object" as const, ...declaration.outputSchema };
  const common = {
    ...declaration.extensions,
    name: declaration.name,
    ...(declaration.title === undefined ? {} : { title: declaration.title }),
    ...(declaration.description === undefined
      ? {}
      : { description: declaration.description }),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(declaration.annotations === undefined
      ? {}
      : { annotations: declaration.annotations }),
    ...(declaration.icons === undefined
      ? {}
      : { icons: [...declaration.icons] }),
    ...(declaration.metadata === undefined
      ? {}
      : { _meta: declaration.metadata }),
  };
  return generation === "v1"
    ? {
        ...common,
        ...(declaration.taskSupport === undefined
          ? {}
          : { execution: { taskSupport: declaration.taskSupport } }),
      }
    : common;
}

/** Derives primary semantic capabilities from negotiated wire capabilities. */
export function semanticCapabilities(
  negotiated: SessionTaskCapabilities,
): TaskCapabilities {
  if (negotiated.generation === "none") {
    return {
      inventory: "unsupported",
      execution: false,
      cancellation: false,
      inputResponses: false,
      requestedRetention: false,
    };
  }
  if (negotiated.generation === "v1") {
    const capabilities: ServerTaskCapabilitiesV1 = negotiated.capabilities;
    return {
      inventory:
        capabilities.list === undefined ? "known-handles" : "server-list",
      execution: capabilities.requests?.tools?.call !== undefined,
      cancellation: capabilities.cancel !== undefined,
      inputResponses: false,
      requestedRetention: true,
    };
  }
  return {
    inventory: "known-handles",
    execution: true,
    cancellation: true,
    inputResponses: true,
    requestedRetention: false,
  };
}

/** Converts a result promise into a uniformly resolving semantic outcome. */
export async function completedOutcome<TResult>(
  result: Promise<TResult>,
  task?: TaskView,
): Promise<TaskOutcome<TResult>> {
  try {
    return {
      status: "completed",
      result: await result,
      ...(task === undefined ? {} : { task }),
    };
  } catch (error) {
    if (error instanceof TaskCancelledError) {
      return { status: "cancelled", ...(task === undefined ? {} : { task }) };
    }
    const failure =
      error instanceof TaskFailedError
        ? error
        : error instanceof JsonRpcResponseError
          ? new TaskFailedError(
              error.message,
              { code: error.code, data: error.data },
              { cause: error },
            )
          : new TaskFailedError(
              error instanceof Error ? error.message : String(error),
              {},
              error instanceof Error ? { cause: error } : undefined,
            );
    return {
      status: "failed",
      error: failure,
      ...(task === undefined ? {} : { task }),
    };
  }
}

export type DefaultCallToolResult = CallToolResultV1 | CallToolResultV2;
