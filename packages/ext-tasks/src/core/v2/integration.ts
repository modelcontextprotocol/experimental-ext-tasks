/** MCP Tasks V2 guards, capability integration, and subscription helpers. */
import type { z } from "zod/v4";
import { type JsonValue } from "../index.js";
import {
  CreateTaskResultV2Schema,
  DetailedTaskV2Schema,
  GetTaskRequestV2Schema,
  TaskStatusNotificationV2Schema,
  TaskV2Schema,
  UpdateTaskRequestV2Schema,
  CancelTaskRequestV2Schema,
} from "./schemas.js";
import {
  CLIENT_CAPABILITIES_META_KEY_V2,
  TASKS_EXTENSION_ID_V2,
  type CreateTaskResultV2,
  type DetailedTaskV2,
  type GetTaskRequestV2,
  type ServerTaskCapabilityEnvelopeV2,
  type TaskStatusNotificationV2,
  type TaskV2,
  type UpdateTaskRequestV2,
  type CancelTaskRequestV2,
} from "./schemas.js";
function parsed<T>(schema: z.ZodType<T>, value: unknown): value is T {
  return schema.safeParse(value).success;
}

function asObjectRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function hasOwnTaskExtension(value: unknown): boolean {
  const extensions = asObjectRecord(value);
  return (
    extensions !== undefined &&
    Object.prototype.hasOwnProperty.call(extensions, TASKS_EXTENSION_ID_V2)
  );
}
export const isTaskV2: (value: unknown) => value is TaskV2 = (
  value: unknown,
): value is TaskV2 => parsed<TaskV2>(TaskV2Schema, value);
export const isDetailedTaskV2: (value: unknown) => value is DetailedTaskV2 = (
  value: unknown,
): value is DetailedTaskV2 =>
  parsed<DetailedTaskV2>(DetailedTaskV2Schema, value);
export const isCreateTaskResultV2: (
  value: unknown,
) => value is CreateTaskResultV2 = (
  value: unknown,
): value is CreateTaskResultV2 =>
  parsed<CreateTaskResultV2>(CreateTaskResultV2Schema, value);
export const isGetTaskRequestV2: (
  value: unknown,
) => value is GetTaskRequestV2 = (value: unknown): value is GetTaskRequestV2 =>
  parsed<GetTaskRequestV2>(GetTaskRequestV2Schema, value);
export const isUpdateTaskRequestV2: (
  value: unknown,
) => value is UpdateTaskRequestV2 = (
  value: unknown,
): value is UpdateTaskRequestV2 =>
  parsed<UpdateTaskRequestV2>(UpdateTaskRequestV2Schema, value);
export const isCancelTaskRequestV2: (
  value: unknown,
) => value is CancelTaskRequestV2 = (
  value: unknown,
): value is CancelTaskRequestV2 =>
  parsed<CancelTaskRequestV2>(CancelTaskRequestV2Schema, value);
export const isTaskStatusNotificationV2: (
  value: unknown,
) => value is TaskStatusNotificationV2 = (
  value: unknown,
): value is TaskStatusNotificationV2 =>
  parsed<TaskStatusNotificationV2>(TaskStatusNotificationV2Schema, value);

/**
 * Recognizes a decoded task-creation result only when it belongs to `tools/call`.
 */
export function isToolCallTaskResultV2(
  method: string,
  value: unknown,
): value is CreateTaskResultV2 {
  return method === "tools/call" && isCreateTaskResultV2(value);
}

/**
 * Checks for the tasks extension inside object-shaped client capability metadata,
 * returning false for malformed or missing containers.
 */
export function hasTaskClientCapabilityV2(value: unknown): boolean {
  const params = asObjectRecord(value);
  const metadata = asObjectRecord(params?._meta);
  const clientCapabilities = asObjectRecord(
    metadata?.[CLIENT_CAPABILITIES_META_KEY_V2],
  );
  return hasOwnTaskExtension(clientCapabilities?.extensions);
}
/**
 * Narrows an object-shaped server capability envelope when its extensions own the tasks key.
 */
export function hasTaskServerCapabilityV2(
  value: unknown,
): value is ServerTaskCapabilityEnvelopeV2 {
  const serverCapabilities = asObjectRecord(value);
  return hasOwnTaskExtension(serverCapabilities?.extensions);
}

/**
 * Returns a copy with the client tasks capability installed in `_meta`, preserving existing
 * object-shaped metadata and replacing malformed metadata with a fresh object.
 */
export function withTaskCapabilityV2<
  T extends Readonly<Record<string, JsonValue>>,
>(params: T): T & Readonly<Record<string, JsonValue>> {
  const existingMetadata = asObjectRecord(params._meta) ?? {};
  const capability = { extensions: { [TASKS_EXTENSION_ID_V2]: {} } };
  return {
    ...params,
    _meta: {
      ...existingMetadata,
      [CLIENT_CAPABILITIES_META_KEY_V2]: capability,
    },
  };
}

/**
 * Returns a filter with deduplicated task IDs, preserving existing object-shaped
 * notification fields and replacing malformed notification data.
 */
export function contributeTaskFilterV2<
  T extends Readonly<Record<string, JsonValue>>,
>(
  filter: T,
  taskIds: readonly string[],
): T & {
  readonly notifications: Readonly<Record<string, JsonValue>> & {
    readonly taskIds: readonly string[];
  };
} {
  const existingNotifications = asObjectRecord(filter.notifications) ?? {};
  return {
    ...filter,
    notifications: {
      ...existingNotifications,
      taskIds: [...new Set(taskIds)],
    },
  };
}
/**
 * Copies task IDs from an accepted notification filter, or returns an empty array when
 * any enclosing value is malformed or any ID is not a string.
 */
export function readAcceptedTaskIdsV2(value: unknown): readonly string[] {
  const acceptedFilter = asObjectRecord(value);
  const notifications = asObjectRecord(acceptedFilter?.notifications);
  const acceptedTaskIds = notifications?.taskIds;
  return Array.isArray(acceptedTaskIds) &&
    acceptedTaskIds.every((taskId) => typeof taskId === "string")
    ? [...acceptedTaskIds]
    : [];
}
