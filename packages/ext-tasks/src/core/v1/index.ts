/** MCP Tasks V1 wire declarations, codecs, and generation-specific guards. */
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

export const TaskStatusesV1 = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatusV1 = (typeof TaskStatusesV1)[number];
export type TaskSupportV1 = "forbidden" | "optional" | "required";
export type TaskEligibleMethodV1 = "tools/call";
export type JsonRpcRequestIdV1 = string | number;

export interface TaskMetadataV1 { readonly ttl?: number }
export interface TaskV1 {
  readonly taskId: string;
  readonly status: TaskStatusV1;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  /** Normative V1 source permits null for unlimited retention; the pinned JSON Schema omitted this union. */
  readonly ttl: number | null;
  readonly pollInterval?: number;
}

export interface CreateTaskResultV1 {
  readonly task: TaskV1;
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}

export interface ToolExecutionV1 { readonly taskSupport?: TaskSupportV1 }
export interface ToolV1 {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>> & { readonly type: "object" };
  readonly outputSchema?: Readonly<Record<string, JsonValue>> & { readonly type: "object" };
  readonly execution?: ToolExecutionV1;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly icons?: readonly Readonly<Record<string, JsonValue>>[];
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}

export type ContentBlockV1 =
  | { readonly type: "text"; readonly text: string; readonly [key: string]: JsonValue }
  | { readonly type: "image" | "audio"; readonly data: string; readonly mimeType: string; readonly [key: string]: JsonValue }
  | { readonly type: "resource_link"; readonly name: string; readonly uri: string; readonly [key: string]: JsonValue }
  | { readonly type: "resource"; readonly resource: Readonly<Record<string, JsonValue>>; readonly [key: string]: JsonValue };
export interface CallToolRequestV1 {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcRequestIdV1;
  readonly method: "tools/call";
  readonly params: { readonly name: string; readonly arguments?: Readonly<Record<string, JsonValue>>; readonly task?: TaskMetadataV1 };
}

export interface CallToolResultV1 {
  readonly content: readonly ContentBlockV1[];
  readonly structuredContent?: Readonly<Record<string, JsonValue>>;
  readonly isError?: boolean;
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}

export interface ServerTaskCapabilitiesV1 {
  readonly list?: Readonly<Record<string, JsonValue>>;
  readonly cancel?: Readonly<Record<string, JsonValue>>;
  readonly requests?: { readonly tools?: { readonly call?: Readonly<Record<string, JsonValue>> } };
}
export interface ServerCapabilitiesV1 { readonly tasks?: ServerTaskCapabilitiesV1 }

interface JsonRpcRequestV1<M extends string, P> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcRequestIdV1;
  readonly method: M;
  readonly params: P;
}
export type GetTaskRequestV1 = JsonRpcRequestV1<"tasks/get", { readonly taskId: string }>;
export type GetTaskResultV1 = TaskV1 & { readonly _meta?: Readonly<Record<string, JsonValue>> };
export type GetTaskResultRequestV1 = JsonRpcRequestV1<"tasks/result", { readonly taskId: string }>;
export type TaskResultV1 = Readonly<Record<string, JsonValue>>;
export interface ListTasksRequestV1 {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcRequestIdV1;
  readonly method: "tasks/list";
  readonly params?: { readonly cursor?: string };
}
export interface ListTasksResultV1 {
  readonly tasks: readonly TaskV1[];
  readonly nextCursor?: string;
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}
export type CancelTaskRequestV1 = JsonRpcRequestV1<"tasks/cancel", { readonly taskId: string }>;
export type CancelTaskResultV1 = TaskV1 & { readonly _meta?: Readonly<Record<string, JsonValue>> };
export interface TaskStatusNotificationV1 {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/tasks/status";
  readonly params: TaskV1 & { readonly _meta?: Readonly<Record<string, JsonValue>> };
}

export interface CallToolAsTaskRequestV1 {
  readonly method: "tools/call";
  readonly params: {
    readonly name: string;
    readonly arguments?: Readonly<Record<string, JsonValue>>;
    readonly task: Record<string, never>;
  };
}

function at(path: DecodePath, key: string | number): DecodePath { return [...path, key] }
function optionalBoolean(record: Record<string, JsonValue>, key: string, path: DecodePath): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ProtocolDecodeError("expected boolean", at(path, key));
  return value;
}
function jsonRecord(value: JsonValue | undefined, path: DecodePath): Readonly<Record<string, JsonValue>> {
  if (value === undefined) throw new ProtocolDecodeError("expected object", path);
  return expectRecord(value, path);
}
function optionalJsonRecord(record: Record<string, JsonValue>, key: string, path: DecodePath) {
  return record[key] === undefined ? undefined : jsonRecord(record[key], at(path, key));
}
function literal(record: Record<string, JsonValue>, key: string, expected: string, path: DecodePath): void {
  if (record[key] !== expected) throw new ProtocolDecodeError(`expected ${expected}`, at(path, key));
}
function decodeId(value: JsonValue | undefined, path: DecodePath): JsonRpcRequestIdV1 {
  if (typeof value !== "string" && typeof value !== "number") throw new ProtocolDecodeError("expected request id", path);
  return value;
}
function expectInteger(value: JsonValue | undefined, path: DecodePath): number {
  const number = expectNumber(value, path);
  if (!Number.isInteger(number)) throw new ProtocolDecodeError("expected integer", path);
  return number;
}
function decodeContentBlock(value: JsonValue, path: DecodePath): ContentBlockV1 {
  const record = expectRecord(value, path);
  const type = expectEnum(record.type, ["text", "image", "audio", "resource_link", "resource"] as const, at(path, "type"));
  if (type === "text") { expectString(record.text, at(path, "text")); }
  else if (type === "image" || type === "audio") { expectString(record.data, at(path, "data")); expectString(record.mimeType, at(path, "mimeType")); }
  else if (type === "resource_link") { expectString(record.name, at(path, "name")); expectString(record.uri, at(path, "uri")); }
  else { jsonRecord(record.resource, at(path, "resource")); }
  return record as ContentBlockV1;
}
function decodeTask(value: JsonValue, path: DecodePath): TaskV1 {
  const record = expectRecord(value, path);
  const ttlValue = record.ttl;
  const ttl = ttlValue === null ? null : expectInteger(ttlValue, at(path, "ttl"));
  return {
    taskId: expectString(record.taskId, at(path, "taskId")),
    status: expectEnum(record.status, TaskStatusesV1, at(path, "status")),
    ...(record.statusMessage === undefined ? {} : { statusMessage: expectString(record.statusMessage, at(path, "statusMessage")) }),
    createdAt: expectString(record.createdAt, at(path, "createdAt")),
    lastUpdatedAt: expectString(record.lastUpdatedAt, at(path, "lastUpdatedAt")),
    ttl,
    ...(record.pollInterval === undefined ? {} : { pollInterval: expectInteger(record.pollInterval, at(path, "pollInterval")) }),
  };
}
function decodeTaskRequest<M extends "tasks/get" | "tasks/result" | "tasks/cancel">(value: JsonValue, path: DecodePath, method: M): JsonRpcRequestV1<M, { readonly taskId: string }> {
  const record = expectRecord(value, path);
  literal(record, "jsonrpc", "2.0", path); literal(record, "method", method, path);
  const params = jsonRecord(record.params, at(path, "params"));
  return { jsonrpc: "2.0", id: decodeId(record.id, at(path, "id")), method, params: { taskId: expectString(params.taskId, at(at(path, "params"), "taskId")) } };
}

export const ToolV1Codec: RuntimeCodec<ToolV1> = createRuntimeCodec<ToolV1>((value, path) => {
  const record = expectRecord(value, path);
  const inputSchema = jsonRecord(record.inputSchema, at(path, "inputSchema"));
  literal(inputSchema as Record<string, JsonValue>, "type", "object", at(path, "inputSchema"));
  let outputSchema: ToolV1["outputSchema"];
  if (record.outputSchema !== undefined) {
    const decoded = jsonRecord(record.outputSchema, at(path, "outputSchema"));
    literal(decoded as Record<string, JsonValue>, "type", "object", at(path, "outputSchema"));
    outputSchema = decoded as ToolV1["outputSchema"];
  }
  let execution: ToolExecutionV1 | undefined;
  if (record.execution !== undefined) {
    const decoded = jsonRecord(record.execution, at(path, "execution"));
    execution = decoded.taskSupport === undefined ? {} : { taskSupport: expectEnum(decoded.taskSupport, ["forbidden", "optional", "required"] as const, at(at(path, "execution"), "taskSupport")) };
  }
  let icons: ToolV1["icons"];
  if (record.icons !== undefined) {
    if (!Array.isArray(record.icons)) throw new ProtocolDecodeError("expected array", at(path, "icons"));
    icons = record.icons.map((icon, index) => jsonRecord(icon, at(at(path, "icons"), index)));
  }
  return {
    name: expectString(record.name, at(path, "name")),
    inputSchema: inputSchema as ToolV1["inputSchema"],
    ...(record.title === undefined ? {} : { title: expectString(record.title, at(path, "title")) }),
    ...(record.description === undefined ? {} : { description: expectString(record.description, at(path, "description")) }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(execution === undefined ? {} : { execution }),
    ...(record.annotations === undefined ? {} : { annotations: jsonRecord(record.annotations, at(path, "annotations")) }),
    ...(icons === undefined ? {} : { icons }),
    ...(record._meta === undefined ? {} : { _meta: jsonRecord(record._meta, at(path, "_meta")) }),
  };
});
export const ServerTaskCapabilitiesV1Codec: RuntimeCodec<ServerTaskCapabilitiesV1> = createRuntimeCodec<ServerTaskCapabilitiesV1>((value, path) => {
  const record = expectRecord(value, path);
  const list = optionalJsonRecord(record, "list", path); const cancel = optionalJsonRecord(record, "cancel", path);
  let requests: ServerTaskCapabilitiesV1["requests"];
  if (record.requests !== undefined) { const r = jsonRecord(record.requests, at(path, "requests")); let tools: NonNullable<ServerTaskCapabilitiesV1["requests"]>["tools"]; if (r.tools !== undefined) { const t = jsonRecord(r.tools, at(at(path, "requests"), "tools")); tools = t.call === undefined ? {} : { call: jsonRecord(t.call, at(at(at(path, "requests"), "tools"), "call")) }; } requests = tools === undefined ? {} : { tools }; }
  return { ...(list === undefined ? {} : { list }), ...(cancel === undefined ? {} : { cancel }), ...(requests === undefined ? {} : { requests }) };
});
export const CallToolRequestV1Codec: RuntimeCodec<CallToolRequestV1> = createRuntimeCodec<CallToolRequestV1>((value, path) => {
  const record = expectRecord(value, path); literal(record, "jsonrpc", "2.0", path); literal(record, "method", "tools/call", path); const params = jsonRecord(record.params, at(path, "params"));
  return { jsonrpc: "2.0", id: decodeId(record.id, at(path, "id")), method: "tools/call", params: { name: expectString(params.name, at(at(path, "params"), "name")), ...(params.arguments === undefined ? {} : { arguments: jsonRecord(params.arguments, at(at(path, "params"), "arguments")) }), ...(params.task === undefined ? {} : { task: (() => { const t = jsonRecord(params.task, at(at(path, "params"), "task")); return t.ttl === undefined ? {} : { ttl: expectInteger(t.ttl, at(at(at(path, "params"), "task"), "ttl")) }; })() }) } };
});
export const TaskStatusV1Codec: RuntimeCodec<TaskStatusV1> = createRuntimeCodec((value, path) => expectEnum(value, TaskStatusesV1, path));
export const TaskV1Codec: RuntimeCodec<TaskV1> = createRuntimeCodec(decodeTask);
export const CreateTaskResultV1Codec: RuntimeCodec<CreateTaskResultV1> = createRuntimeCodec<CreateTaskResultV1>((value, path) => {
  const record = expectRecord(value, path);
  return { task: decodeTask(record.task as JsonValue, at(path, "task")), ...(record._meta === undefined ? {} : { _meta: jsonRecord(record._meta, at(path, "_meta")) }) };
});
export const CallToolResultV1Codec: RuntimeCodec<CallToolResultV1> = createRuntimeCodec<CallToolResultV1>((value, path) => {
  const record = expectRecord(value, path);
  if (!Array.isArray(record.content)) throw new ProtocolDecodeError("expected array", at(path, "content"));
  const content = record.content.map((item, index) => decodeContentBlock(item, at(at(path, "content"), index)));
  return { content, ...(record.structuredContent === undefined ? {} : { structuredContent: jsonRecord(record.structuredContent, at(path, "structuredContent")) }), ...(record.isError === undefined ? {} : { isError: optionalBoolean(record, "isError", path) }), ...(record._meta === undefined ? {} : { _meta: jsonRecord(record._meta, at(path, "_meta")) }) };
});
export const GetTaskRequestV1Codec: RuntimeCodec<GetTaskRequestV1> = createRuntimeCodec<GetTaskRequestV1>((v, p) => decodeTaskRequest(v, p, "tasks/get"));
export const GetTaskResultV1Codec: RuntimeCodec<GetTaskResultV1> = createRuntimeCodec<GetTaskResultV1>((v, p) => { const record = expectRecord(v, p); return { ...decodeTask(v, p), ...(record._meta === undefined ? {} : { _meta: jsonRecord(record._meta, at(p, "_meta")) }) }; });
export const GetTaskResultRequestV1Codec: RuntimeCodec<GetTaskResultRequestV1> = createRuntimeCodec<GetTaskResultRequestV1>((v, p) => decodeTaskRequest(v, p, "tasks/result"));
export const TaskResultV1Codec: RuntimeCodec<TaskResultV1> = createRuntimeCodec<TaskResultV1>((v, p) => expectRecord(v, p));
export const CancelTaskRequestV1Codec: RuntimeCodec<CancelTaskRequestV1> = createRuntimeCodec<CancelTaskRequestV1>((v, p) => decodeTaskRequest(v, p, "tasks/cancel"));
export const CancelTaskResultV1Codec: RuntimeCodec<CancelTaskResultV1> = createRuntimeCodec<CancelTaskResultV1>((v, p) => { const record = expectRecord(v, p); return { ...decodeTask(v, p), ...(record._meta === undefined ? {} : { _meta: jsonRecord(record._meta, at(p, "_meta")) }) }; });
export const ListTasksRequestV1Codec: RuntimeCodec<ListTasksRequestV1> = createRuntimeCodec<ListTasksRequestV1>((value, path) => {
  const record = expectRecord(value, path); literal(record, "jsonrpc", "2.0", path); literal(record, "method", "tasks/list", path);
  const result: ListTasksRequestV1 = { jsonrpc: "2.0", id: decodeId(record.id, at(path, "id")), method: "tasks/list" };
  if (record.params === undefined) return result;
  const params = jsonRecord(record.params, at(path, "params"));
  return { ...result, params: { ...(params.cursor === undefined ? {} : { cursor: expectString(params.cursor, at(at(path, "params"), "cursor")) }) } };
});
export const ListTasksResultV1Codec: RuntimeCodec<ListTasksResultV1> = createRuntimeCodec<ListTasksResultV1>((value, path) => {
  const record = expectRecord(value, path);
  if (!Array.isArray(record.tasks)) throw new ProtocolDecodeError("expected array", at(path, "tasks"));
  return { tasks: record.tasks.map((task, index) => decodeTask(task, at(at(path, "tasks"), index))), ...(record.nextCursor === undefined ? {} : { nextCursor: expectString(record.nextCursor, at(path, "nextCursor")) }), ...(record._meta === undefined ? {} : { _meta: jsonRecord(record._meta, at(path, "_meta")) }) };
});
export const TaskStatusNotificationV1Codec: RuntimeCodec<TaskStatusNotificationV1> = createRuntimeCodec<TaskStatusNotificationV1>((value, path) => {
  const record = expectRecord(value, path); literal(record, "jsonrpc", "2.0", path); literal(record, "method", "notifications/tasks/status", path);
  const paramsRecord = jsonRecord(record.params, at(path, "params"));
  return { jsonrpc: "2.0", method: "notifications/tasks/status", params: { ...decodeTask(record.params as JsonValue, at(path, "params")), ...(paramsRecord._meta === undefined ? {} : { _meta: jsonRecord(paramsRecord._meta, at(at(path, "params"), "_meta")) }) } };
});

export function hasTaskListCapabilityV1(capabilities: ServerTaskCapabilitiesV1): boolean { return capabilities.list !== undefined }
export function hasTaskCancelCapabilityV1(capabilities: ServerTaskCapabilitiesV1): boolean { return capabilities.cancel !== undefined }
export function hasTaskToolCallCapabilityV1(capabilities: ServerTaskCapabilitiesV1): boolean { return capabilities.requests?.tools?.call !== undefined }
export function isTaskEligibleMethodV1(method: string): method is TaskEligibleMethodV1 { return method === "tools/call" }
export function shouldCallToolAsTaskV1(capabilities: ServerTaskCapabilitiesV1, tool: ToolV1, preferTask = false): boolean {
  if (!hasTaskToolCallCapabilityV1(capabilities)) return false;
  return tool.execution?.taskSupport === "required" || (tool.execution?.taskSupport === "optional" && preferTask);
}
export function callToolAsTaskV1(name: string, arguments_?: Readonly<Record<string, JsonValue>>): CallToolAsTaskRequestV1 {
  return { method: "tools/call", params: { name, ...(arguments_ === undefined ? {} : { arguments: arguments_ }), task: {} } };
}
