/** MCP Tasks V2 runtime codecs. */
import {
  ProtocolDecodeError,
  createRuntimeCodec,
  expectEnum,
  expectInteger,
  expectLiteralProperty,
  expectNumber,
  expectOptionalBooleanProperty,
  expectOptionalRecordProperty,
  expectRecord,
  expectRequiredRecord,
  expectString,
  hasOwn,
  isJsonArray,
  type DecodePath,
} from "../internal/codec.js";
import { type JsonValue, type RuntimeCodec } from "../index.js";
import {
  type CallToolResultV2,
  type ContentBlockV2,
  type CancelTaskRequestV2,
  type CancelTaskResultV2,
  type CancelledTaskV2,
  type CompletedTaskV2,
  type CreateMessageRequestV2,
  type CreateMessageResultV2,
  type CreateTaskResultV2,
  type DetailedTaskV2,
  type ElicitRequestV2,
  type ElicitResultV2,
  type ErrorV2,
  type FailedTaskV2,
  type GetTaskRequestV2,
  type GetTaskResultV2,
  type InputRequestV2,
  type InputRequestsV2,
  type InputRequiredTaskV2,
  type InputResponseV2,
  type InputResponsesV2,
  type ListRootsRequestV2,
  type ListRootsResultV2,
  type RequestIdV2,
  type TaskStatusNotificationParamsV2,
  type TaskStatusNotificationV2,
  type TaskSubscriptionAcknowledgedNotificationsV2,
  type TaskSubscriptionNotificationsV2,
  type TasksExtensionCapabilityV2,
  type TaskV2,
  type ToolV2,
  type UpdateTaskRequestV2,
  type UpdateTaskResultV2,
  type WorkingTaskV2,
} from "./wire.js";
const statuses = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;
const inputMethods = [
  "sampling/createMessage",
  "roots/list",
  "elicitation/create",
] as const;

function expectRequestId(
  value: JsonValue | undefined,
  path: DecodePath,
): RequestIdV2 {
  if (typeof value === "string") return value;
  return expectInteger(value, path);
}
function optionalString(
  object: Record<string, JsonValue>,
  key: string,
  path: DecodePath,
): void {
  if (object[key] !== undefined) expectString(object[key], [...path, key]);
}
function optionalStringArray(
  object: Record<string, JsonValue>,
  key: string,
  path: DecodePath,
): void {
  const value = object[key];
  if (
    value !== undefined &&
    (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
  ) {
    throw new ProtocolDecodeError("expected string array", [...path, key]);
  }
}

function decodeAnnotations(value: JsonValue, path: DecodePath): void {
  const object = expectRecord(value, path);
  if (object.audience !== undefined) {
    if (
      !Array.isArray(object.audience) ||
      !object.audience.every((role) => role === "user" || role === "assistant")
    ) {
      throw new ProtocolDecodeError("expected role array", [
        ...path,
        "audience",
      ]);
    }
  }
  if (object.priority !== undefined) {
    const priority = expectNumber(object.priority, [...path, "priority"]);
    if (priority < 0 || priority > 1)
      throw new ProtocolDecodeError("expected number from 0 to 1", [
        ...path,
        "priority",
      ]);
  }
  optionalString(object, "lastModified", path);
}

function decodeIcon(value: JsonValue, path: DecodePath): void {
  const object = expectRecord(value, path);
  expectString(object.src, [...path, "src"]);
  optionalString(object, "mimeType", path);
  optionalStringArray(object, "sizes", path);
  if (object.theme !== undefined)
    expectEnum(object.theme, ["light", "dark"], [...path, "theme"]);
}

function decodeImplementation(value: JsonValue, path: DecodePath): void {
  const object = expectRecord(value, path);
  expectString(object.name, [...path, "name"]);
  expectString(object.version, [...path, "version"]);
  optionalString(object, "title", path);
  optionalString(object, "description", path);
  optionalString(object, "websiteUrl", path);
  if (object.icons !== undefined) {
    if (!isJsonArray(object.icons))
      throw new ProtocolDecodeError("expected array", [...path, "icons"]);
    object.icons.forEach((icon, index) =>
      decodeIcon(icon, [...path, "icons", index]),
    );
  }
}

function decodeContentBlock(
  value: JsonValue,
  path: DecodePath,
): ContentBlockV2 {
  const object = expectRecord(value, path);
  const type = expectEnum(
    object.type,
    ["text", "image", "audio", "resource_link", "resource"],
    [...path, "type"],
  );
  if (type === "text") expectString(object.text, [...path, "text"]);
  else if (type === "image" || type === "audio") {
    expectString(object.data, [...path, "data"]);
    expectString(object.mimeType, [...path, "mimeType"]);
  } else if (type === "resource_link") {
    expectString(object.name, [...path, "name"]);
    expectString(object.uri, [...path, "uri"]);
    optionalString(object, "title", path);
    optionalString(object, "description", path);
    optionalString(object, "mimeType", path);
    if (object.size !== undefined)
      expectInteger(object.size, [...path, "size"]);
    if (object.icons !== undefined) {
      if (!isJsonArray(object.icons))
        throw new ProtocolDecodeError("expected array", [...path, "icons"]);
      object.icons.forEach((icon, index) =>
        decodeIcon(icon, [...path, "icons", index]),
      );
    }
  } else {
    const resource = expectRequiredRecord(object.resource, [
      ...path,
      "resource",
    ]);
    expectString(resource.uri, [...path, "resource", "uri"]);
    optionalString(resource, "mimeType", [...path, "resource"]);
    expectOptionalRecordProperty(resource, "_meta", [...path, "resource"]);
    const hasText = resource.text !== undefined;
    const hasBlob = resource.blob !== undefined;
    if (!hasText && !hasBlob)
      throw new ProtocolDecodeError("expected text or blob", [
        ...path,
        "resource",
      ]);
    if (hasText) expectString(resource.text, [...path, "resource", "text"]);
    if (hasBlob) expectString(resource.blob, [...path, "resource", "blob"]);
  }
  if (object.annotations !== undefined)
    decodeAnnotations(object.annotations, [...path, "annotations"]);
  expectOptionalRecordProperty(object, "_meta", path);
  return object as ContentBlockV2;
}

function decodeTool(value: JsonValue, path: DecodePath): ToolV2 {
  const object = expectRecord(value, path);
  expectString(object.name, [...path, "name"]);
  optionalString(object, "title", path);
  optionalString(object, "description", path);
  const inputSchema = expectRecord(object.inputSchema, [
    ...path,
    "inputSchema",
  ]);
  expectLiteralProperty(inputSchema, "type", "object", [
    ...path,
    "inputSchema",
  ]);
  optionalString(inputSchema, "$schema", [...path, "inputSchema"]);
  if (object.outputSchema !== undefined) {
    const outputSchema = expectRecord(object.outputSchema, [
      ...path,
      "outputSchema",
    ]);
    optionalString(outputSchema, "$schema", [...path, "outputSchema"]);
  }
  if (object.annotations !== undefined) {
    const annotations = expectRecord(object.annotations, [
      ...path,
      "annotations",
    ]);
    optionalString(annotations, "title", [...path, "annotations"]);
    for (const key of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ])
      expectOptionalBooleanProperty(annotations, key, [...path, "annotations"]);
  }
  if (object.icons !== undefined) {
    if (!isJsonArray(object.icons))
      throw new ProtocolDecodeError("expected array", [...path, "icons"]);
    object.icons.forEach((icon, index) =>
      decodeIcon(icon, [...path, "icons", index]),
    );
  }
  expectOptionalRecordProperty(object, "_meta", path);
  return object as ToolV2;
}

function decodeCallToolResult(
  value: JsonValue,
  path: DecodePath,
): CallToolResultV2 {
  const object = expectRecord(value, path);
  expectString(object.resultType, [...path, "resultType"]);
  if (!isJsonArray(object.content))
    throw new ProtocolDecodeError("expected array", [...path, "content"]);
  object.content.forEach((block, index) =>
    decodeContentBlock(block, [...path, "content", index]),
  );
  expectOptionalBooleanProperty(object, "isError", path);
  const meta = expectOptionalRecordProperty(object, "_meta", path);
  if (meta?.["io.modelcontextprotocol/serverInfo"] !== undefined) {
    decodeImplementation(meta["io.modelcontextprotocol/serverInfo"], [
      ...path,
      "_meta",
      "io.modelcontextprotocol/serverInfo",
    ]);
  }
  return object as CallToolResultV2;
}

function decodeTask(value: JsonValue, path: DecodePath): TaskV2 {
  const object = expectRecord(value, path);
  const ttl = object.ttlMs;
  if (!hasOwn(object, "ttlMs"))
    throw new ProtocolDecodeError("required field", [...path, "ttlMs"]);
  // Task is a closed wire shape; wrappers preserve extension data through `_meta`.
  const task: TaskV2 = {
    taskId: expectString(object.taskId, [...path, "taskId"]),
    status: expectEnum(object.status, statuses, [...path, "status"]),
    createdAt: expectString(object.createdAt, [...path, "createdAt"]),
    lastUpdatedAt: expectString(object.lastUpdatedAt, [
      ...path,
      "lastUpdatedAt",
    ]),
    ttlMs: ttl === null ? null : expectInteger(ttl, [...path, "ttlMs"]),
    ...(object.statusMessage === undefined
      ? {}
      : {
          statusMessage: expectString(object.statusMessage, [
            ...path,
            "statusMessage",
          ]),
        }),
    ...(object.pollIntervalMs === undefined
      ? {}
      : {
          pollIntervalMs: expectInteger(object.pollIntervalMs, [
            ...path,
            "pollIntervalMs",
          ]),
        }),
  };
  return task;
}

function decodeError(value: JsonValue, path: DecodePath): ErrorV2 {
  const object = expectRecord(value, path);
  return {
    code: expectInteger(object.code, [...path, "code"]),
    message: expectString(object.message, [...path, "message"]),
    ...(hasOwn(object, "data") ? { data: object.data } : {}),
  };
}

function decodeInputRequest(
  value: JsonValue,
  path: DecodePath,
): InputRequestV2 {
  const object = expectRecord(value, path);
  const method = expectEnum(object.method, inputMethods, [...path, "method"]);
  if (method === "roots/list") {
    return {
      method,
      ...(object.params === undefined
        ? {}
        : { params: expectRecord(object.params, [...path, "params"]) }),
    };
  }
  return {
    method,
    params: expectRequiredRecord(object.params, [...path, "params"]),
  };
}
function decodeInputRequests(
  value: JsonValue,
  path: DecodePath,
): InputRequestsV2 {
  const object = expectRecord(value, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, request]) => [
      key,
      decodeInputRequest(request, [...path, key]),
    ]),
  );
}

function decodeInputResponse(
  value: JsonValue,
  path: DecodePath,
): InputResponseV2 {
  const object = expectRecord(value, path);
  if (hasOwn(object, "action")) {
    expectEnum(
      object.action,
      ["accept", "decline", "cancel"],
      [...path, "action"],
    );
  } else if (hasOwn(object, "roots")) {
    if (!Array.isArray(object.roots))
      throw new ProtocolDecodeError("expected array", [...path, "roots"]);
  } else {
    if (!hasOwn(object, "content"))
      throw new ProtocolDecodeError("required field", [...path, "content"]);
    expectString(object.model, [...path, "model"]);
    expectEnum(object.role, ["user", "assistant"], [...path, "role"]);
  }
  return object as InputResponseV2;
}
function decodeInputResponses(
  value: JsonValue,
  path: DecodePath,
): InputResponsesV2 {
  const object = expectRecord(value, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, response]) => [
      key,
      decodeInputResponse(response, [...path, key]),
    ]),
  );
}

function decodeDetailedTask(
  value: JsonValue,
  path: DecodePath,
): DetailedTaskV2 {
  const object = expectRecord(value, path);
  const task = decodeTask(value, path);
  switch (task.status) {
    case "input_required":
      return {
        ...task,
        status: task.status,
        inputRequests: decodeInputRequests(object.inputRequests, [
          ...path,
          "inputRequests",
        ]),
      };
    case "completed":
      return {
        ...task,
        status: task.status,
        result: expectRequiredRecord(object.result, [...path, "result"]),
      };
    case "failed":
      return {
        ...task,
        status: task.status,
        error: decodeError(object.error, [...path, "error"]),
      };
    case "working":
      return { ...task, status: task.status };
    case "cancelled":
      return { ...task, status: task.status };
  }
}

function decodeRpcRequest(value: JsonValue, path: DecodePath, method: string) {
  const object = expectRecord(value, path);
  expectLiteralProperty(object, "jsonrpc", "2.0", path);
  expectLiteralProperty(object, "method", method, path);
  return {
    object,
    id: expectRequestId(object.id, [...path, "id"]),
    params: expectRequiredRecord(object.params, [...path, "params"]),
  };
}
function decodeCompleteResult(value: JsonValue, path: DecodePath) {
  const object = expectRecord(value, path);
  expectLiteralProperty(object, "resultType", "complete", path);
  expectOptionalRecordProperty(object, "_meta", path);
  return object;
}

export const ToolV2Codec: RuntimeCodec<ToolV2> =
  createRuntimeCodec<ToolV2>(decodeTool);
export const CallToolResultV2Codec: RuntimeCodec<CallToolResultV2> =
  createRuntimeCodec<CallToolResultV2>(decodeCallToolResult);
export const TaskV2Codec: RuntimeCodec<TaskV2> =
  createRuntimeCodec<TaskV2>(decodeTask);
export const DetailedTaskV2Codec: RuntimeCodec<DetailedTaskV2> =
  createRuntimeCodec<DetailedTaskV2>(decodeDetailedTask);
export const ErrorV2Codec: RuntimeCodec<ErrorV2> =
  createRuntimeCodec<ErrorV2>(decodeError);
export const InputRequestV2Codec: RuntimeCodec<InputRequestV2> =
  createRuntimeCodec<InputRequestV2>(decodeInputRequest);
export const InputRequestsV2Codec: RuntimeCodec<InputRequestsV2> =
  createRuntimeCodec<InputRequestsV2>(decodeInputRequests);
export const InputResponseV2Codec: RuntimeCodec<InputResponseV2> =
  createRuntimeCodec<InputResponseV2>(decodeInputResponse);
export const InputResponsesV2Codec: RuntimeCodec<InputResponsesV2> =
  createRuntimeCodec<InputResponsesV2>(decodeInputResponses);
export const CreateMessageRequestV2Codec: RuntimeCodec<CreateMessageRequestV2> =
  createRuntimeCodec<CreateMessageRequestV2>((value, path) => {
    const request = decodeInputRequest(value, path);
    if (request.method !== "sampling/createMessage")
      throw new ProtocolDecodeError("expected sampling/createMessage", [
        ...path,
        "method",
      ]);
    return request;
  });
export const ListRootsRequestV2Codec: RuntimeCodec<ListRootsRequestV2> =
  createRuntimeCodec<ListRootsRequestV2>((value, path) => {
    const request = decodeInputRequest(value, path);
    if (request.method !== "roots/list")
      throw new ProtocolDecodeError("expected roots/list", [...path, "method"]);
    return request;
  });
export const ElicitRequestV2Codec: RuntimeCodec<ElicitRequestV2> =
  createRuntimeCodec<ElicitRequestV2>((value, path) => {
    const request = decodeInputRequest(value, path);
    if (request.method !== "elicitation/create")
      throw new ProtocolDecodeError("expected elicitation/create", [
        ...path,
        "method",
      ]);
    return request;
  });
export const CreateMessageResultV2Codec: RuntimeCodec<CreateMessageResultV2> =
  createRuntimeCodec<CreateMessageResultV2>((value, path) => {
    const response = decodeInputResponse(value, path);
    if (
      !("content" in response) ||
      !("model" in response) ||
      !("role" in response)
    )
      throw new ProtocolDecodeError("expected sampling result", path);
    return response as CreateMessageResultV2;
  });
export const ListRootsResultV2Codec: RuntimeCodec<ListRootsResultV2> =
  createRuntimeCodec<ListRootsResultV2>((value, path) => {
    const response = decodeInputResponse(value, path);
    if (!("roots" in response))
      throw new ProtocolDecodeError("expected roots result", path);
    return response as ListRootsResultV2;
  });
export const ElicitResultV2Codec: RuntimeCodec<ElicitResultV2> =
  createRuntimeCodec<ElicitResultV2>((value, path) => {
    const response = decodeInputResponse(value, path);
    if (!("action" in response))
      throw new ProtocolDecodeError("expected elicitation result", path);
    return response as ElicitResultV2;
  });
export const CreateTaskResultV2Codec: RuntimeCodec<CreateTaskResultV2> =
  createRuntimeCodec<CreateTaskResultV2>((value, path) => {
    const object = expectRecord(value, path);
    expectLiteralProperty(object, "resultType", "task", path);
    expectOptionalRecordProperty(object, "_meta", path);
    return {
      ...decodeTask(value, path),
      resultType: "task",
      ...(object._meta === undefined
        ? {}
        : { _meta: expectRecord(object._meta, [...path, "_meta"]) }),
    };
  });
export const GetTaskRequestV2Codec: RuntimeCodec<GetTaskRequestV2> =
  createRuntimeCodec<GetTaskRequestV2>((value, path) => {
    const { id, params } = decodeRpcRequest(value, path, "tasks/get");
    return {
      jsonrpc: "2.0",
      id,
      method: "tasks/get",
      params: {
        taskId: expectString(params.taskId, [...path, "params", "taskId"]),
      },
    };
  });
export const UpdateTaskRequestV2Codec: RuntimeCodec<UpdateTaskRequestV2> =
  createRuntimeCodec<UpdateTaskRequestV2>((value, path) => {
    const { id, params } = decodeRpcRequest(value, path, "tasks/update");
    return {
      jsonrpc: "2.0",
      id,
      method: "tasks/update",
      params: {
        taskId: expectString(params.taskId, [...path, "params", "taskId"]),
        inputResponses: decodeInputResponses(params.inputResponses, [
          ...path,
          "params",
          "inputResponses",
        ]),
      },
    };
  });
export const CancelTaskRequestV2Codec: RuntimeCodec<CancelTaskRequestV2> =
  createRuntimeCodec<CancelTaskRequestV2>((value, path) => {
    const { id, params } = decodeRpcRequest(value, path, "tasks/cancel");
    return {
      jsonrpc: "2.0",
      id,
      method: "tasks/cancel",
      params: {
        taskId: expectString(params.taskId, [...path, "params", "taskId"]),
      },
    };
  });
export const GetTaskResultV2Codec: RuntimeCodec<GetTaskResultV2> =
  createRuntimeCodec<GetTaskResultV2>((value, path) => {
    const object = decodeCompleteResult(value, path);
    return {
      ...decodeDetailedTask(value, path),
      resultType: "complete",
      ...(object._meta === undefined
        ? {}
        : { _meta: expectRecord(object._meta, [...path, "_meta"]) }),
    };
  });
export const UpdateTaskResultV2Codec: RuntimeCodec<UpdateTaskResultV2> =
  createRuntimeCodec<UpdateTaskResultV2>(
    (value, path) => decodeCompleteResult(value, path) as UpdateTaskResultV2,
  );
export const CancelTaskResultV2Codec: RuntimeCodec<CancelTaskResultV2> =
  createRuntimeCodec<CancelTaskResultV2>(
    (value, path) => decodeCompleteResult(value, path) as CancelTaskResultV2,
  );
export const WorkingTaskV2Codec: RuntimeCodec<WorkingTaskV2> =
  createRuntimeCodec<WorkingTaskV2>((value, path) => {
    const task = decodeDetailedTask(value, path);
    if (task.status !== "working")
      throw new ProtocolDecodeError("expected working", [...path, "status"]);
    return task;
  });
export const InputRequiredTaskV2Codec: RuntimeCodec<InputRequiredTaskV2> =
  createRuntimeCodec<InputRequiredTaskV2>((value, path) => {
    const task = decodeDetailedTask(value, path);
    if (task.status !== "input_required")
      throw new ProtocolDecodeError("expected input_required", [
        ...path,
        "status",
      ]);
    return task;
  });
export const CompletedTaskV2Codec: RuntimeCodec<CompletedTaskV2> =
  createRuntimeCodec<CompletedTaskV2>((value, path) => {
    const task = decodeDetailedTask(value, path);
    if (task.status !== "completed")
      throw new ProtocolDecodeError("expected completed", [...path, "status"]);
    return task;
  });
export const FailedTaskV2Codec: RuntimeCodec<FailedTaskV2> =
  createRuntimeCodec<FailedTaskV2>((value, path) => {
    const task = decodeDetailedTask(value, path);
    if (task.status !== "failed")
      throw new ProtocolDecodeError("expected failed", [...path, "status"]);
    return task;
  });
export const CancelledTaskV2Codec: RuntimeCodec<CancelledTaskV2> =
  createRuntimeCodec<CancelledTaskV2>((value, path) => {
    const task = decodeDetailedTask(value, path);
    if (task.status !== "cancelled")
      throw new ProtocolDecodeError("expected cancelled", [...path, "status"]);
    return task;
  });
function decodeTaskStatusNotificationParams(
  value: JsonValue,
  path: DecodePath,
): TaskStatusNotificationParamsV2 {
  const object = expectRecord(value, path);
  return {
    ...decodeDetailedTask(value, path),
    ...(object._meta === undefined
      ? {}
      : { _meta: expectRecord(object._meta, [...path, "_meta"]) }),
  };
}

export const TaskStatusNotificationParamsV2Codec: RuntimeCodec<TaskStatusNotificationParamsV2> =
  createRuntimeCodec<TaskStatusNotificationParamsV2>(
    decodeTaskStatusNotificationParams,
  );
export const TaskSubscriptionNotificationsV2Codec: RuntimeCodec<TaskSubscriptionNotificationsV2> =
  createRuntimeCodec<TaskSubscriptionNotificationsV2>((value, path) => {
    const object = expectRecord(value, path);
    if (object.taskIds === undefined) return {};
    if (
      !Array.isArray(object.taskIds) ||
      !object.taskIds.every((id) => typeof id === "string")
    )
      throw new ProtocolDecodeError("expected string array", [
        ...path,
        "taskIds",
      ]);
    return { taskIds: object.taskIds };
  });
export const TaskSubscriptionAcknowledgedNotificationsV2Codec: RuntimeCodec<TaskSubscriptionAcknowledgedNotificationsV2> =
  TaskSubscriptionNotificationsV2Codec;
export const TasksExtensionCapabilityV2Codec: RuntimeCodec<TasksExtensionCapabilityV2> =
  createRuntimeCodec<TasksExtensionCapabilityV2>((value, path) => {
    const object = expectRecord(value, path);
    if (Object.keys(object).length !== 0)
      throw new ProtocolDecodeError("expected empty object", path);
    return {};
  });
export const TaskStatusNotificationV2Codec: RuntimeCodec<TaskStatusNotificationV2> =
  createRuntimeCodec<TaskStatusNotificationV2>((value, path) => {
    const object = expectRecord(value, path);
    expectLiteralProperty(object, "jsonrpc", "2.0", path);
    expectLiteralProperty(object, "method", "notifications/tasks", path);
    return {
      jsonrpc: "2.0",
      method: "notifications/tasks",
      params: decodeTaskStatusNotificationParams(object.params, [
        ...path,
        "params",
      ]),
    };
  });
