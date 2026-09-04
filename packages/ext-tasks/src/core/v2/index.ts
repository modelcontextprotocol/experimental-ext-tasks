/** MCP Tasks V2 wire declarations, codecs, guards, and request bindings. */
import {
  ProtocolDecodeError,
  createRuntimeCodec,
  expectEnum,
  expectNumber,
  expectRecord,
  expectString,
  type DecodePath,
  type JsonValue,
  type RuntimeCodec,
} from "../index.js";

export const TASKS_EXTENSION_ID_V2 = "io.modelcontextprotocol/tasks" as const;
export const CLIENT_CAPABILITIES_META_KEY_V2 =
  "io.modelcontextprotocol/clientCapabilities" as const;

export type RequestIdV2 = string | number;
export type TaskStatusV2 =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskV2 {
  readonly taskId: string;
  readonly status: TaskStatusV2;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
}

export interface WorkingTaskV2 extends TaskV2 { readonly status: "working"; }
export interface InputRequiredTaskV2 extends TaskV2 {
  readonly status: "input_required";
  readonly inputRequests: InputRequestsV2;
}
export interface CompletedTaskV2 extends TaskV2 {
  readonly status: "completed";
  readonly result: Readonly<Record<string, JsonValue>>;
}
export interface FailedTaskV2 extends TaskV2 {
  readonly status: "failed";
  readonly error: ErrorV2;
}
export interface CancelledTaskV2 extends TaskV2 { readonly status: "cancelled"; }
export type DetailedTaskV2 =
  | WorkingTaskV2 | InputRequiredTaskV2 | CompletedTaskV2 | FailedTaskV2 | CancelledTaskV2;

export interface ErrorV2 {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface CreateMessageRequestV2 {
  readonly method: "sampling/createMessage";
  readonly params: Readonly<Record<string, JsonValue>>;
}
export interface ListRootsRequestV2 {
  readonly method: "roots/list";
  readonly params?: Readonly<Record<string, JsonValue>>;
}
export interface ElicitRequestV2 {
  readonly method: "elicitation/create";
  readonly params: Readonly<Record<string, JsonValue>>;
}
export type InputRequestV2 = CreateMessageRequestV2 | ListRootsRequestV2 | ElicitRequestV2;
export type InputRequestsV2 = Readonly<Record<string, InputRequestV2>>;

export interface CreateMessageResultV2 extends Readonly<Record<string, JsonValue>> {
  readonly content: JsonValue;
  readonly model: string;
  readonly role: "user" | "assistant";
}
export interface ListRootsResultV2 extends Readonly<Record<string, JsonValue>> {
  readonly roots: readonly JsonValue[];
}
export interface ElicitResultV2 extends Readonly<Record<string, JsonValue>> {
  readonly action: "accept" | "decline" | "cancel";
}
export type InputResponseV2 = CreateMessageResultV2 | ListRootsResultV2 | ElicitResultV2;
export type InputResponsesV2 = Readonly<Record<string, InputResponseV2>>;

export interface CreateTaskResultV2 extends TaskV2 {
  readonly resultType: "task";
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}
export type ToolCallResultV2 = Readonly<Record<string, JsonValue>> & { readonly resultType: string };
export type EligibleTaskResultV2 = ToolCallResultV2 | CreateTaskResultV2;

interface JsonRpcRequestV2 {
  readonly jsonrpc: "2.0";
  readonly id: RequestIdV2;
}
export interface GetTaskRequestV2 extends JsonRpcRequestV2 {
  readonly method: "tasks/get";
  readonly params: { readonly taskId: string };
}
export interface UpdateTaskRequestV2 extends JsonRpcRequestV2 {
  readonly method: "tasks/update";
  readonly params: { readonly taskId: string; readonly inputResponses: InputResponsesV2 };
}
export interface CancelTaskRequestV2 extends JsonRpcRequestV2 {
  readonly method: "tasks/cancel";
  readonly params: { readonly taskId: string };
}
export type GetTaskResultV2 = DetailedTaskV2 & {
  readonly resultType: "complete";
  readonly _meta?: Readonly<Record<string, JsonValue>>;
};
export interface UpdateTaskResultV2 extends Readonly<Record<string, JsonValue>> {
  readonly resultType: "complete";
}
export interface CancelTaskResultV2 extends Readonly<Record<string, JsonValue>> {
  readonly resultType: "complete";
}

export type TaskStatusNotificationParamsV2 = DetailedTaskV2 & {
  readonly _meta?: Readonly<Record<string, JsonValue>>;
};
export interface TaskStatusNotificationV2 {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/tasks";
  readonly params: TaskStatusNotificationParamsV2;
}
export interface TaskSubscriptionNotificationsV2 { readonly taskIds?: readonly string[]; }
export interface TaskSubscriptionAcknowledgedNotificationsV2 { readonly taskIds?: readonly string[]; }
export type TaskExtensionCapabilitiesV2 = Readonly<Record<string, never>>;
export type TasksExtensionCapabilityV2 = TaskExtensionCapabilitiesV2;

export interface ClientTaskCapabilityEnvelopeV2 {
  readonly extensions: { readonly [TASKS_EXTENSION_ID_V2]: TaskExtensionCapabilitiesV2 };
}
export interface ServerTaskCapabilityEnvelopeV2 {
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

const statuses = ["working", "input_required", "completed", "failed", "cancelled"] as const;
const inputMethods = ["sampling/createMessage", "roots/list", "elicitation/create"] as const;

function has(record: Record<string, JsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
function expectInteger(value: JsonValue | undefined, path: DecodePath): number {
  const number = expectNumber(value, path);
  if (!Number.isInteger(number)) throw new ProtocolDecodeError("expected integer", path);
  return number;
}
function expectRequestId(value: JsonValue | undefined, path: DecodePath): RequestIdV2 {
  if (typeof value === "string") return value;
  return expectInteger(value, path);
}
function expectConst(value: JsonValue | undefined, expected: string, path: DecodePath): void {
  if (value !== expected) throw new ProtocolDecodeError(`expected ${expected}`, path);
}
function optionalRecord(value: JsonValue | undefined, path: DecodePath) {
  return value === undefined ? undefined : expectRecord(value, path);
}

function decodeTask(value: JsonValue, path: DecodePath): TaskV2 {
  const object = expectRecord(value, path);
  const ttl = object.ttlMs;
  if (ttl !== null && ttl === undefined) throw new ProtocolDecodeError("required field", [...path, "ttlMs"]);
  const task: TaskV2 = {
    taskId: expectString(object.taskId, [...path, "taskId"]),
    status: expectEnum(object.status, statuses, [...path, "status"]),
    createdAt: expectString(object.createdAt, [...path, "createdAt"]),
    lastUpdatedAt: expectString(object.lastUpdatedAt, [...path, "lastUpdatedAt"]),
    ttlMs: ttl === null ? null : expectInteger(ttl, [...path, "ttlMs"]),
    ...(object.statusMessage === undefined ? {} : { statusMessage: expectString(object.statusMessage, [...path, "statusMessage"]) }),
    ...(object.pollIntervalMs === undefined ? {} : { pollIntervalMs: expectInteger(object.pollIntervalMs, [...path, "pollIntervalMs"]) }),
  };
  return task;
}

function decodeError(value: JsonValue, path: DecodePath): ErrorV2 {
  const object = expectRecord(value, path);
  return {
    code: expectInteger(object.code, [...path, "code"]),
    message: expectString(object.message, [...path, "message"]),
    ...(has(object, "data") ? { data: object.data as JsonValue } : {}),
  };
}

function decodeInputRequest(value: JsonValue, path: DecodePath): InputRequestV2 {
  const object = expectRecord(value, path);
  const method = expectEnum(object.method, inputMethods, [...path, "method"]);
  if (method === "roots/list") {
    return { method, ...(object.params === undefined ? {} : { params: expectRecord(object.params, [...path, "params"]) }) };
  }
  return { method, params: expectRecord(object.params as JsonValue, [...path, "params"]) };
}
function decodeInputRequests(value: JsonValue, path: DecodePath): InputRequestsV2 {
  const object = expectRecord(value, path);
  return Object.fromEntries(Object.entries(object).map(([key, request]) => [key, decodeInputRequest(request, [...path, key])]));
}

function decodeInputResponse(value: JsonValue, path: DecodePath): InputResponseV2 {
  const object = expectRecord(value, path);
  if (has(object, "action")) {
    expectEnum(object.action, ["accept", "decline", "cancel"], [...path, "action"]);
  } else if (has(object, "roots")) {
    if (!Array.isArray(object.roots)) throw new ProtocolDecodeError("expected array", [...path, "roots"]);
  } else {
    if (!has(object, "content")) throw new ProtocolDecodeError("required field", [...path, "content"]);
    expectString(object.model, [...path, "model"]);
    expectEnum(object.role, ["user", "assistant"], [...path, "role"]);
  }
  return object as InputResponseV2;
}
function decodeInputResponses(value: JsonValue, path: DecodePath): InputResponsesV2 {
  const object = expectRecord(value, path);
  return Object.fromEntries(Object.entries(object).map(([key, response]) => [key, decodeInputResponse(response, [...path, key])]));
}

function decodeDetailedTask(value: JsonValue, path: DecodePath): DetailedTaskV2 {
  const object = expectRecord(value, path);
  const task = decodeTask(value, path);
  switch (task.status) {
    case "input_required": return { ...task, status: task.status, inputRequests: decodeInputRequests(object.inputRequests as JsonValue, [...path, "inputRequests"]) };
    case "completed": return { ...task, status: task.status, result: expectRecord(object.result as JsonValue, [...path, "result"]) };
    case "failed": return { ...task, status: task.status, error: decodeError(object.error as JsonValue, [...path, "error"]) };
    case "working": return { ...task, status: task.status };
    case "cancelled": return { ...task, status: task.status };
  }
}

function decodeRpcRequest(value: JsonValue, path: DecodePath, method: string) {
  const object = expectRecord(value, path);
  expectConst(object.jsonrpc, "2.0", [...path, "jsonrpc"]);
  expectConst(object.method, method, [...path, "method"]);
  return { object, id: expectRequestId(object.id, [...path, "id"]), params: expectRecord(object.params as JsonValue, [...path, "params"]) };
}
function decodeCompleteResult(value: JsonValue, path: DecodePath) {
  const object = expectRecord(value, path);
  expectConst(object.resultType, "complete", [...path, "resultType"]);
  optionalRecord(object._meta, [...path, "_meta"]);
  return object;
}

export const TaskV2Codec: RuntimeCodec<TaskV2> = createRuntimeCodec<TaskV2>(decodeTask);
export const DetailedTaskV2Codec: RuntimeCodec<DetailedTaskV2> = createRuntimeCodec<DetailedTaskV2>(decodeDetailedTask);
export const ErrorV2Codec: RuntimeCodec<ErrorV2> = createRuntimeCodec<ErrorV2>(decodeError);
export const InputRequestV2Codec: RuntimeCodec<InputRequestV2> = createRuntimeCodec<InputRequestV2>(decodeInputRequest);
export const InputRequestsV2Codec: RuntimeCodec<InputRequestsV2> = createRuntimeCodec<InputRequestsV2>(decodeInputRequests);
export const InputResponseV2Codec: RuntimeCodec<InputResponseV2> = createRuntimeCodec<InputResponseV2>(decodeInputResponse);
export const InputResponsesV2Codec: RuntimeCodec<InputResponsesV2> = createRuntimeCodec<InputResponsesV2>(decodeInputResponses);
export const CreateMessageRequestV2Codec: RuntimeCodec<CreateMessageRequestV2> = createRuntimeCodec<CreateMessageRequestV2>((value, path) => {
  const request = decodeInputRequest(value, path);
  if (request.method !== "sampling/createMessage") throw new ProtocolDecodeError("expected sampling/createMessage", [...path, "method"]);
  return request;
});
export const ListRootsRequestV2Codec: RuntimeCodec<ListRootsRequestV2> = createRuntimeCodec<ListRootsRequestV2>((value, path) => {
  const request = decodeInputRequest(value, path);
  if (request.method !== "roots/list") throw new ProtocolDecodeError("expected roots/list", [...path, "method"]);
  return request;
});
export const ElicitRequestV2Codec: RuntimeCodec<ElicitRequestV2> = createRuntimeCodec<ElicitRequestV2>((value, path) => {
  const request = decodeInputRequest(value, path);
  if (request.method !== "elicitation/create") throw new ProtocolDecodeError("expected elicitation/create", [...path, "method"]);
  return request;
});
export const CreateMessageResultV2Codec: RuntimeCodec<CreateMessageResultV2> = createRuntimeCodec<CreateMessageResultV2>((value, path) => {
  const response = decodeInputResponse(value, path);
  if (!("content" in response) || !("model" in response) || !("role" in response)) throw new ProtocolDecodeError("expected sampling result", path);
  return response as CreateMessageResultV2;
});
export const ListRootsResultV2Codec: RuntimeCodec<ListRootsResultV2> = createRuntimeCodec<ListRootsResultV2>((value, path) => {
  const response = decodeInputResponse(value, path);
  if (!("roots" in response)) throw new ProtocolDecodeError("expected roots result", path);
  return response as ListRootsResultV2;
});
export const ElicitResultV2Codec: RuntimeCodec<ElicitResultV2> = createRuntimeCodec<ElicitResultV2>((value, path) => {
  const response = decodeInputResponse(value, path);
  if (!("action" in response)) throw new ProtocolDecodeError("expected elicitation result", path);
  return response as ElicitResultV2;
});
export const CreateTaskResultV2Codec: RuntimeCodec<CreateTaskResultV2> = createRuntimeCodec<CreateTaskResultV2>((value, path) => {
  const object = expectRecord(value, path);
  expectConst(object.resultType, "task", [...path, "resultType"]);
  optionalRecord(object._meta, [...path, "_meta"]);
  return { ...decodeTask(value, path), resultType: "task", ...(object._meta === undefined ? {} : { _meta: expectRecord(object._meta, [...path, "_meta"]) }) };
});
export const GetTaskRequestV2Codec: RuntimeCodec<GetTaskRequestV2> = createRuntimeCodec<GetTaskRequestV2>((value, path) => {
  const { id, params } = decodeRpcRequest(value, path, "tasks/get");
  return { jsonrpc: "2.0", id, method: "tasks/get", params: { taskId: expectString(params.taskId, [...path, "params", "taskId"]) } };
});
export const UpdateTaskRequestV2Codec: RuntimeCodec<UpdateTaskRequestV2> = createRuntimeCodec<UpdateTaskRequestV2>((value, path) => {
  const { id, params } = decodeRpcRequest(value, path, "tasks/update");
  return { jsonrpc: "2.0", id, method: "tasks/update", params: { taskId: expectString(params.taskId, [...path, "params", "taskId"]), inputResponses: decodeInputResponses(params.inputResponses as JsonValue, [...path, "params", "inputResponses"]) } };
});
export const CancelTaskRequestV2Codec: RuntimeCodec<CancelTaskRequestV2> = createRuntimeCodec<CancelTaskRequestV2>((value, path) => {
  const { id, params } = decodeRpcRequest(value, path, "tasks/cancel");
  return { jsonrpc: "2.0", id, method: "tasks/cancel", params: { taskId: expectString(params.taskId, [...path, "params", "taskId"]) } };
});
export const GetTaskResultV2Codec: RuntimeCodec<GetTaskResultV2> = createRuntimeCodec<GetTaskResultV2>((value, path) => {
  const object = decodeCompleteResult(value, path);
  return { ...decodeDetailedTask(value, path), resultType: "complete", ...(object._meta === undefined ? {} : { _meta: expectRecord(object._meta, [...path, "_meta"]) }) };
});
export const UpdateTaskResultV2Codec: RuntimeCodec<UpdateTaskResultV2> = createRuntimeCodec<UpdateTaskResultV2>((value, path) => decodeCompleteResult(value, path) as UpdateTaskResultV2);
export const CancelTaskResultV2Codec: RuntimeCodec<CancelTaskResultV2> = createRuntimeCodec<CancelTaskResultV2>((value, path) => decodeCompleteResult(value, path) as CancelTaskResultV2);
export const WorkingTaskV2Codec: RuntimeCodec<WorkingTaskV2> = createRuntimeCodec<WorkingTaskV2>((value, path) => { const task = decodeDetailedTask(value, path); if (task.status !== "working") throw new ProtocolDecodeError("expected working", [...path, "status"]); return task; });
export const InputRequiredTaskV2Codec: RuntimeCodec<InputRequiredTaskV2> = createRuntimeCodec<InputRequiredTaskV2>((value, path) => { const task = decodeDetailedTask(value, path); if (task.status !== "input_required") throw new ProtocolDecodeError("expected input_required", [...path, "status"]); return task; });
export const CompletedTaskV2Codec: RuntimeCodec<CompletedTaskV2> = createRuntimeCodec<CompletedTaskV2>((value, path) => { const task = decodeDetailedTask(value, path); if (task.status !== "completed") throw new ProtocolDecodeError("expected completed", [...path, "status"]); return task; });
export const FailedTaskV2Codec: RuntimeCodec<FailedTaskV2> = createRuntimeCodec<FailedTaskV2>((value, path) => { const task = decodeDetailedTask(value, path); if (task.status !== "failed") throw new ProtocolDecodeError("expected failed", [...path, "status"]); return task; });
export const CancelledTaskV2Codec: RuntimeCodec<CancelledTaskV2> = createRuntimeCodec<CancelledTaskV2>((value, path) => { const task = decodeDetailedTask(value, path); if (task.status !== "cancelled") throw new ProtocolDecodeError("expected cancelled", [...path, "status"]); return task; });
export const TaskStatusNotificationParamsV2Codec: RuntimeCodec<TaskStatusNotificationParamsV2> = createRuntimeCodec<TaskStatusNotificationParamsV2>(decodeDetailedTask);
export const TaskSubscriptionNotificationsV2Codec: RuntimeCodec<TaskSubscriptionNotificationsV2> = createRuntimeCodec<TaskSubscriptionNotificationsV2>((value, path) => {
  const object = expectRecord(value, path);
  if (object.taskIds === undefined) return {};
  if (!Array.isArray(object.taskIds) || !object.taskIds.every((id) => typeof id === "string")) throw new ProtocolDecodeError("expected string array", [...path, "taskIds"]);
  return { taskIds: object.taskIds };
});
export const TaskSubscriptionAcknowledgedNotificationsV2Codec: RuntimeCodec<TaskSubscriptionAcknowledgedNotificationsV2> = TaskSubscriptionNotificationsV2Codec;
export const TaskExtensionCapabilitiesV2Codec: RuntimeCodec<TaskExtensionCapabilitiesV2> = createRuntimeCodec<TaskExtensionCapabilitiesV2>((value, path) => {
  const object = expectRecord(value, path);
  if (Object.keys(object).length !== 0) throw new ProtocolDecodeError("expected empty object", path);
  return {};
});
export const TasksExtensionCapabilityV2Codec: RuntimeCodec<TasksExtensionCapabilityV2> = TaskExtensionCapabilitiesV2Codec;
export const TaskStatusNotificationV2Codec: RuntimeCodec<TaskStatusNotificationV2> = createRuntimeCodec<TaskStatusNotificationV2>((value, path) => {
  const object = expectRecord(value, path);
  expectConst(object.jsonrpc, "2.0", [...path, "jsonrpc"]);
  expectConst(object.method, "notifications/tasks", [...path, "method"]);
  return { jsonrpc: "2.0", method: "notifications/tasks", params: decodeDetailedTask(object.params as JsonValue, [...path, "params"]) };
});

function parsed<T>(codec: { parse(value: JsonValue): { success: boolean } }, value: unknown): value is T {
  return value !== undefined && codec.parse(value as JsonValue).success;
}
export const isTaskV2: (value: unknown) => value is TaskV2 = (value: unknown): value is TaskV2 => parsed<TaskV2>(TaskV2Codec, value);
export const isDetailedTaskV2: (value: unknown) => value is DetailedTaskV2 = (value: unknown): value is DetailedTaskV2 => parsed<DetailedTaskV2>(DetailedTaskV2Codec, value);
export const isCreateTaskResultV2: (value: unknown) => value is CreateTaskResultV2 = (value: unknown): value is CreateTaskResultV2 => parsed<CreateTaskResultV2>(CreateTaskResultV2Codec, value);
export const isGetTaskRequestV2: (value: unknown) => value is GetTaskRequestV2 = (value: unknown): value is GetTaskRequestV2 => parsed<GetTaskRequestV2>(GetTaskRequestV2Codec, value);
export const isUpdateTaskRequestV2: (value: unknown) => value is UpdateTaskRequestV2 = (value: unknown): value is UpdateTaskRequestV2 => parsed<UpdateTaskRequestV2>(UpdateTaskRequestV2Codec, value);
export const isCancelTaskRequestV2: (value: unknown) => value is CancelTaskRequestV2 = (value: unknown): value is CancelTaskRequestV2 => parsed<CancelTaskRequestV2>(CancelTaskRequestV2Codec, value);
export const isTaskStatusNotificationV2: (value: unknown) => value is TaskStatusNotificationV2 = (value: unknown): value is TaskStatusNotificationV2 => parsed<TaskStatusNotificationV2>(TaskStatusNotificationV2Codec, value);

export function isToolCallTaskResultV2(method: string, value: unknown): value is CreateTaskResultV2 {
  return method === "tools/call" && isCreateTaskResultV2(value);
}
export const isEligibleTaskResultV2: typeof isToolCallTaskResultV2 = isToolCallTaskResultV2;

export function hasTaskClientCapabilityV2(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = (value as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return false;
  const capabilities = (meta as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY_V2];
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const extensions = (capabilities as { extensions?: unknown }).extensions;
  return extensions !== null && typeof extensions === "object" && !Array.isArray(extensions) &&
    Object.prototype.hasOwnProperty.call(extensions, TASKS_EXTENSION_ID_V2);
}
export function hasTaskServerCapabilityV2(value: unknown): value is ServerTaskCapabilityEnvelopeV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const extensions = (value as { extensions?: unknown }).extensions;
  return extensions !== null && typeof extensions === "object" && !Array.isArray(extensions) &&
    Object.prototype.hasOwnProperty.call(extensions, TASKS_EXTENSION_ID_V2);
}
export const supportsTasksExtensionV2: typeof hasTaskServerCapabilityV2 = hasTaskServerCapabilityV2;

export function withTaskCapabilityV2<T extends Readonly<Record<string, JsonValue>>>(params: T): T & Readonly<Record<string, JsonValue>> {
  const wireMeta = params._meta;
  const base = wireMeta !== null && typeof wireMeta === "object" && !Array.isArray(wireMeta) ? wireMeta : {};
  const capability = { extensions: { [TASKS_EXTENSION_ID_V2]: {} } };
  return { ...params, _meta: { ...base, [CLIENT_CAPABILITIES_META_KEY_V2]: capability } };
}

export function contributeTaskFilterV2<T extends Readonly<Record<string, JsonValue>>>(filter: T, taskIds: readonly string[]): T & { readonly notifications: Readonly<Record<string, JsonValue>> & { readonly taskIds: readonly string[] } } {
  const notifications = filter.notifications;
  const prior: Readonly<Record<string, JsonValue>> = notifications !== null && typeof notifications === "object" && !Array.isArray(notifications) ? notifications as Readonly<Record<string, JsonValue>> : {};
  return { ...filter, notifications: { ...prior, taskIds: [...new Set(taskIds)] } };
}
export function readAcceptedTaskIdsV2(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const notifications = (value as { notifications?: unknown }).notifications;
  if (notifications === null || typeof notifications !== "object" || Array.isArray(notifications)) return [];
  const ids = (notifications as { taskIds?: unknown }).taskIds;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? [...ids] : [];
}
