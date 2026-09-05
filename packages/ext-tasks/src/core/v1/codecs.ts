/** MCP Tasks V1 runtime codecs. */
import {
  ProtocolDecodeError,
  createRuntimeCodec,
  expectEnum,
  expectNumber,
  expectRecord,
  expectString,
  isJsonArray,
  type DecodePath,
} from "../internal/codec.js";
import { type JsonValue, type RuntimeCodec } from "../index.js";
import {
  TaskStatusesV1,
  type CallToolRequestV1,
  type CallToolResultV1,
  type CancelTaskRequestV1,
  type CancelTaskResultV1,
  type ContentBlockV1,
  type CreateTaskResultV1,
  type GetTaskRequestV1,
  type GetTaskResultRequestV1,
  type GetTaskResultV1,
  type JsonRpcRequestIdV1,
  type ListTasksRequestV1,
  type ListTasksResultV1,
  type ServerTaskCapabilitiesV1,
  type TaskResultV1,
  type TaskStatusNotificationV1,
  type TaskStatusV1,
  type TaskV1,
  type ToolExecutionV1,
  type ToolV1,
} from "./wire.js";
interface JsonRpcRequestV1<M extends string, P> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcRequestIdV1;
  readonly method: M;
  readonly params: P;
}

function at(path: DecodePath, key: string | number): DecodePath {
  return [...path, key];
}
function optionalBoolean(
  record: Record<string, JsonValue>,
  key: string,
  path: DecodePath,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new ProtocolDecodeError("expected boolean", at(path, key));
  return value;
}
function jsonRecord(
  value: JsonValue | undefined,
  path: DecodePath,
): Readonly<Record<string, JsonValue>> {
  if (value === undefined)
    throw new ProtocolDecodeError("expected object", path);
  return expectRecord(value, path);
}
function optionalJsonRecord(
  record: Record<string, JsonValue>,
  key: string,
  path: DecodePath,
) {
  return record[key] === undefined
    ? undefined
    : jsonRecord(record[key], at(path, key));
}
function literal(
  record: Record<string, JsonValue>,
  key: string,
  expected: string,
  path: DecodePath,
): void {
  if (record[key] !== expected)
    throw new ProtocolDecodeError(`expected ${expected}`, at(path, key));
}
function decodeId(
  value: JsonValue | undefined,
  path: DecodePath,
): JsonRpcRequestIdV1 {
  if (typeof value !== "string" && typeof value !== "number")
    throw new ProtocolDecodeError("expected request id", path);
  return value;
}
function expectInteger(value: JsonValue | undefined, path: DecodePath): number {
  const number = expectNumber(value, path);
  if (!Number.isInteger(number))
    throw new ProtocolDecodeError("expected integer", path);
  return number;
}
function decodeContentBlock(
  value: JsonValue,
  path: DecodePath,
): ContentBlockV1 {
  const record = expectRecord(value, path);
  const type = expectEnum(
    record.type,
    ["text", "image", "audio", "resource_link", "resource"] as const,
    at(path, "type"),
  );
  if (type === "text") {
    expectString(record.text, at(path, "text"));
  } else if (type === "image" || type === "audio") {
    expectString(record.data, at(path, "data"));
    expectString(record.mimeType, at(path, "mimeType"));
  } else if (type === "resource_link") {
    expectString(record.name, at(path, "name"));
    expectString(record.uri, at(path, "uri"));
  } else {
    jsonRecord(record.resource, at(path, "resource"));
  }
  return record as ContentBlockV1;
}
function decodeTask(value: JsonValue, path: DecodePath): TaskV1 {
  const record = expectRecord(value, path);
  const ttlValue = record.ttl;
  const ttl =
    ttlValue === null ? null : expectInteger(ttlValue, at(path, "ttl"));
  return {
    taskId: expectString(record.taskId, at(path, "taskId")),
    status: expectEnum(record.status, TaskStatusesV1, at(path, "status")),
    ...(record.statusMessage === undefined
      ? {}
      : {
          statusMessage: expectString(
            record.statusMessage,
            at(path, "statusMessage"),
          ),
        }),
    createdAt: expectString(record.createdAt, at(path, "createdAt")),
    lastUpdatedAt: expectString(
      record.lastUpdatedAt,
      at(path, "lastUpdatedAt"),
    ),
    ttl,
    ...(record.pollInterval === undefined
      ? {}
      : {
          pollInterval: expectInteger(
            record.pollInterval,
            at(path, "pollInterval"),
          ),
        }),
  };
}
function decodeTaskRequest<
  M extends "tasks/get" | "tasks/result" | "tasks/cancel",
>(
  value: JsonValue,
  path: DecodePath,
  method: M,
): JsonRpcRequestV1<M, { readonly taskId: string }> {
  const record = expectRecord(value, path);
  literal(record, "jsonrpc", "2.0", path);
  literal(record, "method", method, path);
  const params = jsonRecord(record.params, at(path, "params"));
  return {
    jsonrpc: "2.0",
    id: decodeId(record.id, at(path, "id")),
    method,
    params: {
      taskId: expectString(params.taskId, at(at(path, "params"), "taskId")),
    },
  };
}

export const ToolV1Codec: RuntimeCodec<ToolV1> = createRuntimeCodec<ToolV1>(
  (value, path) => {
    const record = expectRecord(value, path);
    const inputSchema = jsonRecord(record.inputSchema, at(path, "inputSchema"));
    literal(inputSchema, "type", "object", at(path, "inputSchema"));
    let outputSchema: ToolV1["outputSchema"];
    if (record.outputSchema !== undefined) {
      const decoded = jsonRecord(record.outputSchema, at(path, "outputSchema"));
      literal(decoded, "type", "object", at(path, "outputSchema"));
      outputSchema = decoded as ToolV1["outputSchema"];
    }
    let execution: ToolExecutionV1 | undefined;
    if (record.execution !== undefined) {
      const decoded = jsonRecord(record.execution, at(path, "execution"));
      execution =
        decoded.taskSupport === undefined
          ? {}
          : {
              taskSupport: expectEnum(
                decoded.taskSupport,
                ["forbidden", "optional", "required"] as const,
                at(at(path, "execution"), "taskSupport"),
              ),
            };
    }
    let icons: ToolV1["icons"];
    if (record.icons !== undefined) {
      if (!isJsonArray(record.icons))
        throw new ProtocolDecodeError("expected array", at(path, "icons"));
      icons = record.icons.map((icon, index) =>
        jsonRecord(icon, at(at(path, "icons"), index)),
      );
    }
    return {
      name: expectString(record.name, at(path, "name")),
      inputSchema: inputSchema as ToolV1["inputSchema"],
      ...(record.title === undefined
        ? {}
        : { title: expectString(record.title, at(path, "title")) }),
      ...(record.description === undefined
        ? {}
        : {
            description: expectString(
              record.description,
              at(path, "description"),
            ),
          }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(execution === undefined ? {} : { execution }),
      ...(record.annotations === undefined
        ? {}
        : {
            annotations: jsonRecord(
              record.annotations,
              at(path, "annotations"),
            ),
          }),
      ...(icons === undefined ? {} : { icons }),
      ...(record._meta === undefined
        ? {}
        : { _meta: jsonRecord(record._meta, at(path, "_meta")) }),
    };
  },
);
export const ServerTaskCapabilitiesV1Codec: RuntimeCodec<ServerTaskCapabilitiesV1> =
  createRuntimeCodec<ServerTaskCapabilitiesV1>((value, path) => {
    const record = expectRecord(value, path);
    const list = optionalJsonRecord(record, "list", path);
    const cancel = optionalJsonRecord(record, "cancel", path);
    let requests: ServerTaskCapabilitiesV1["requests"];
    if (record.requests !== undefined) {
      const r = jsonRecord(record.requests, at(path, "requests"));
      let tools: NonNullable<ServerTaskCapabilitiesV1["requests"]>["tools"];
      if (r.tools !== undefined) {
        const t = jsonRecord(r.tools, at(at(path, "requests"), "tools"));
        tools =
          t.call === undefined
            ? {}
            : {
                call: jsonRecord(
                  t.call,
                  at(at(at(path, "requests"), "tools"), "call"),
                ),
              };
      }
      requests = tools === undefined ? {} : { tools };
    }
    return {
      ...(list === undefined ? {} : { list }),
      ...(cancel === undefined ? {} : { cancel }),
      ...(requests === undefined ? {} : { requests }),
    };
  });
export const CallToolRequestV1Codec: RuntimeCodec<CallToolRequestV1> =
  createRuntimeCodec<CallToolRequestV1>((value, path) => {
    const record = expectRecord(value, path);
    literal(record, "jsonrpc", "2.0", path);
    literal(record, "method", "tools/call", path);
    const params = jsonRecord(record.params, at(path, "params"));
    return {
      jsonrpc: "2.0",
      id: decodeId(record.id, at(path, "id")),
      method: "tools/call",
      params: {
        name: expectString(params.name, at(at(path, "params"), "name")),
        ...(params.arguments === undefined
          ? {}
          : {
              arguments: jsonRecord(
                params.arguments,
                at(at(path, "params"), "arguments"),
              ),
            }),
        ...(params.task === undefined
          ? {}
          : {
              task: (() => {
                const t = jsonRecord(
                  params.task,
                  at(at(path, "params"), "task"),
                );
                return t.ttl === undefined
                  ? {}
                  : {
                      ttl: expectInteger(
                        t.ttl,
                        at(at(at(path, "params"), "task"), "ttl"),
                      ),
                    };
              })(),
            }),
      },
    };
  });
export const TaskStatusV1Codec: RuntimeCodec<TaskStatusV1> = createRuntimeCodec(
  (value, path) => expectEnum(value, TaskStatusesV1, path),
);
export const TaskV1Codec: RuntimeCodec<TaskV1> = createRuntimeCodec(decodeTask);
export const CreateTaskResultV1Codec: RuntimeCodec<CreateTaskResultV1> =
  createRuntimeCodec<CreateTaskResultV1>((value, path) => {
    const record = expectRecord(value, path);
    return {
      task: decodeTask(record.task, at(path, "task")),
      ...(record._meta === undefined
        ? {}
        : { _meta: jsonRecord(record._meta, at(path, "_meta")) }),
    };
  });
export const CallToolResultV1Codec: RuntimeCodec<CallToolResultV1> =
  createRuntimeCodec<CallToolResultV1>((value, path) => {
    const record = expectRecord(value, path);
    if (!isJsonArray(record.content))
      throw new ProtocolDecodeError("expected array", at(path, "content"));
    record.content.forEach((item, index) =>
      decodeContentBlock(item, at(at(path, "content"), index)),
    );
    if (record.structuredContent !== undefined)
      jsonRecord(record.structuredContent, at(path, "structuredContent"));
    if (record.isError !== undefined) optionalBoolean(record, "isError", path);
    if (record._meta !== undefined) jsonRecord(record._meta, at(path, "_meta"));
    return record as unknown as CallToolResultV1;
  });
export const GetTaskRequestV1Codec: RuntimeCodec<GetTaskRequestV1> =
  createRuntimeCodec<GetTaskRequestV1>((v, p) =>
    decodeTaskRequest(v, p, "tasks/get"),
  );
export const GetTaskResultV1Codec: RuntimeCodec<GetTaskResultV1> =
  createRuntimeCodec<GetTaskResultV1>((v, p) => {
    const record = expectRecord(v, p);
    return {
      ...decodeTask(v, p),
      ...(record._meta === undefined
        ? {}
        : { _meta: jsonRecord(record._meta, at(p, "_meta")) }),
    };
  });
export const GetTaskResultRequestV1Codec: RuntimeCodec<GetTaskResultRequestV1> =
  createRuntimeCodec<GetTaskResultRequestV1>((v, p) =>
    decodeTaskRequest(v, p, "tasks/result"),
  );
export const TaskResultV1Codec: RuntimeCodec<TaskResultV1> =
  createRuntimeCodec<TaskResultV1>((v, p) => expectRecord(v, p));
export const CancelTaskRequestV1Codec: RuntimeCodec<CancelTaskRequestV1> =
  createRuntimeCodec<CancelTaskRequestV1>((v, p) =>
    decodeTaskRequest(v, p, "tasks/cancel"),
  );
export const CancelTaskResultV1Codec: RuntimeCodec<CancelTaskResultV1> =
  createRuntimeCodec<CancelTaskResultV1>((v, p) => {
    const record = expectRecord(v, p);
    return {
      ...decodeTask(v, p),
      ...(record._meta === undefined
        ? {}
        : { _meta: jsonRecord(record._meta, at(p, "_meta")) }),
    };
  });
export const ListTasksRequestV1Codec: RuntimeCodec<ListTasksRequestV1> =
  createRuntimeCodec<ListTasksRequestV1>((value, path) => {
    const record = expectRecord(value, path);
    literal(record, "jsonrpc", "2.0", path);
    literal(record, "method", "tasks/list", path);
    const result: ListTasksRequestV1 = {
      jsonrpc: "2.0",
      id: decodeId(record.id, at(path, "id")),
      method: "tasks/list",
    };
    if (record.params === undefined) return result;
    const params = jsonRecord(record.params, at(path, "params"));
    return {
      ...result,
      params: {
        ...(params.cursor === undefined
          ? {}
          : {
              cursor: expectString(
                params.cursor,
                at(at(path, "params"), "cursor"),
              ),
            }),
      },
    };
  });
export const ListTasksResultV1Codec: RuntimeCodec<ListTasksResultV1> =
  createRuntimeCodec<ListTasksResultV1>((value, path) => {
    const record = expectRecord(value, path);
    if (!isJsonArray(record.tasks))
      throw new ProtocolDecodeError("expected array", at(path, "tasks"));
    return {
      tasks: record.tasks.map((task, index) =>
        decodeTask(task, at(at(path, "tasks"), index)),
      ),
      ...(record.nextCursor === undefined
        ? {}
        : {
            nextCursor: expectString(record.nextCursor, at(path, "nextCursor")),
          }),
      ...(record._meta === undefined
        ? {}
        : { _meta: jsonRecord(record._meta, at(path, "_meta")) }),
    };
  });
export const TaskStatusNotificationV1Codec: RuntimeCodec<TaskStatusNotificationV1> =
  createRuntimeCodec<TaskStatusNotificationV1>((value, path) => {
    const record = expectRecord(value, path);
    literal(record, "jsonrpc", "2.0", path);
    literal(record, "method", "notifications/tasks/status", path);
    const paramsRecord = jsonRecord(record.params, at(path, "params"));
    return {
      jsonrpc: "2.0",
      method: "notifications/tasks/status",
      params: {
        ...decodeTask(record.params, at(path, "params")),
        ...(paramsRecord._meta === undefined
          ? {}
          : {
              _meta: jsonRecord(
                paramsRecord._meta,
                at(at(path, "params"), "_meta"),
              ),
            }),
      },
    };
  });
