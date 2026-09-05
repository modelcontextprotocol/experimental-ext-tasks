/** MCP Tasks V2 guards, capability integration, and subscription helpers. */
import { type JsonValue } from "../index.js";
import {
  CreateTaskResultV2Codec,
  DetailedTaskV2Codec,
  GetTaskRequestV2Codec,
  TaskStatusNotificationV2Codec,
  TaskV2Codec,
  UpdateTaskRequestV2Codec,
  CancelTaskRequestV2Codec,
} from "./codecs.js";
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
} from "./wire.js";
function parsed<T>(
  codec: { parse(value: unknown): { success: boolean } },
  value: unknown,
): value is T {
  return codec.parse(value).success;
}
export const isTaskV2: (value: unknown) => value is TaskV2 = (
  value: unknown,
): value is TaskV2 => parsed<TaskV2>(TaskV2Codec, value);
export const isDetailedTaskV2: (value: unknown) => value is DetailedTaskV2 = (
  value: unknown,
): value is DetailedTaskV2 =>
  parsed<DetailedTaskV2>(DetailedTaskV2Codec, value);
export const isCreateTaskResultV2: (
  value: unknown,
) => value is CreateTaskResultV2 = (
  value: unknown,
): value is CreateTaskResultV2 =>
  parsed<CreateTaskResultV2>(CreateTaskResultV2Codec, value);
export const isGetTaskRequestV2: (
  value: unknown,
) => value is GetTaskRequestV2 = (value: unknown): value is GetTaskRequestV2 =>
  parsed<GetTaskRequestV2>(GetTaskRequestV2Codec, value);
export const isUpdateTaskRequestV2: (
  value: unknown,
) => value is UpdateTaskRequestV2 = (
  value: unknown,
): value is UpdateTaskRequestV2 =>
  parsed<UpdateTaskRequestV2>(UpdateTaskRequestV2Codec, value);
export const isCancelTaskRequestV2: (
  value: unknown,
) => value is CancelTaskRequestV2 = (
  value: unknown,
): value is CancelTaskRequestV2 =>
  parsed<CancelTaskRequestV2>(CancelTaskRequestV2Codec, value);
export const isTaskStatusNotificationV2: (
  value: unknown,
) => value is TaskStatusNotificationV2 = (
  value: unknown,
): value is TaskStatusNotificationV2 =>
  parsed<TaskStatusNotificationV2>(TaskStatusNotificationV2Codec, value);

export function isToolCallTaskResultV2(
  method: string,
  value: unknown,
): value is CreateTaskResultV2 {
  return method === "tools/call" && isCreateTaskResultV2(value);
}

export function hasTaskClientCapabilityV2(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const meta = (value as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta))
    return false;
  const capabilities = (meta as Record<string, unknown>)[
    CLIENT_CAPABILITIES_META_KEY_V2
  ];
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  )
    return false;
  const extensions = (capabilities as { extensions?: unknown }).extensions;
  return (
    extensions !== null &&
    typeof extensions === "object" &&
    !Array.isArray(extensions) &&
    Object.prototype.hasOwnProperty.call(extensions, TASKS_EXTENSION_ID_V2)
  );
}
export function hasTaskServerCapabilityV2(
  value: unknown,
): value is ServerTaskCapabilityEnvelopeV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const extensions = (value as { extensions?: unknown }).extensions;
  return (
    extensions !== null &&
    typeof extensions === "object" &&
    !Array.isArray(extensions) &&
    Object.prototype.hasOwnProperty.call(extensions, TASKS_EXTENSION_ID_V2)
  );
}

export function withTaskCapabilityV2<
  T extends Readonly<Record<string, JsonValue>>,
>(params: T): T & Readonly<Record<string, JsonValue>> {
  const wireMeta = params._meta;
  const base =
    wireMeta !== null &&
    typeof wireMeta === "object" &&
    !Array.isArray(wireMeta)
      ? wireMeta
      : {};
  const capability = { extensions: { [TASKS_EXTENSION_ID_V2]: {} } };
  return {
    ...params,
    _meta: { ...base, [CLIENT_CAPABILITIES_META_KEY_V2]: capability },
  };
}

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
  const notifications = filter.notifications;
  const prior: Readonly<Record<string, JsonValue>> =
    notifications !== null &&
    typeof notifications === "object" &&
    !Array.isArray(notifications)
      ? (notifications as Readonly<Record<string, JsonValue>>)
      : {};
  return {
    ...filter,
    notifications: { ...prior, taskIds: [...new Set(taskIds)] },
  };
}
export function readAcceptedTaskIdsV2(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [];
  const notifications = (value as { notifications?: unknown }).notifications;
  if (
    notifications === null ||
    typeof notifications !== "object" ||
    Array.isArray(notifications)
  )
    return [];
  const ids = (notifications as { taskIds?: unknown }).taskIds;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string")
    ? [...ids]
    : [];
}
