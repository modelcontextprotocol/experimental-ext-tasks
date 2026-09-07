/** MCP Tasks V1 runtime schemas and schema-derived wire types. */
import * as z from "zod/v4";

import { isJsonValue } from "../index.js";
import type { JsonValue } from "../index.js";

const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  isJsonValue,
  "Expected a JSON value",
);
const JsonRecordSchema = z.record(z.string(), JsonValueSchema);
const ObjectJsonSchema = z
  .object({ type: z.literal("object") })
  .catchall(JsonValueSchema);

export const TaskStatusesV1 = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;
export const TaskStatusV1Schema = z.enum(TaskStatusesV1);
export type TaskStatusV1 = z.output<typeof TaskStatusV1Schema>;

export const TaskSupportV1Schema = z.enum([
  "forbidden",
  "optional",
  "required",
]);
export type TaskSupportV1 = z.output<typeof TaskSupportV1Schema>;

export const TaskEligibleMethodV1Schema = z.literal("tools/call");
export type TaskEligibleMethodV1 = z.output<typeof TaskEligibleMethodV1Schema>;

export const JsonRpcRequestIdV1Schema = z.union([z.string(), z.number()]);
export type JsonRpcRequestIdV1 = z.output<typeof JsonRpcRequestIdV1Schema>;

export const TaskMetadataV1Schema = z.object({
  ttl: z.number().int().optional(),
});
export type TaskMetadataV1 = z.output<typeof TaskMetadataV1Schema>;

export const TaskV1Schema = z.object({
  taskId: z.string(),
  status: TaskStatusV1Schema,
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  /** Normative V1 permits null for unlimited retention; the pinned JSON Schema omitted it. */
  ttl: z.number().int().nullable(),
  pollInterval: z.number().int().optional(),
});
export type TaskV1 = z.output<typeof TaskV1Schema>;

export const CreateTaskResultV1Schema = z.object({
  task: TaskV1Schema,
  _meta: JsonRecordSchema.optional(),
});
export type CreateTaskResultV1 = z.output<typeof CreateTaskResultV1Schema>;

export const ToolExecutionV1Schema = z.object({
  taskSupport: TaskSupportV1Schema.optional(),
});
export type ToolExecutionV1 = z.output<typeof ToolExecutionV1Schema>;

export const ToolV1Schema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: ObjectJsonSchema,
  outputSchema: ObjectJsonSchema.optional(),
  execution: ToolExecutionV1Schema.optional(),
  annotations: JsonRecordSchema.optional(),
  icons: z.array(JsonRecordSchema).optional(),
  _meta: JsonRecordSchema.optional(),
});
export type ToolV1 = z.output<typeof ToolV1Schema>;

const TextContentBlockV1Schema = z
  .object({ type: z.literal("text"), text: z.string() })
  .catchall(JsonValueSchema);
const MediaContentBlockV1Schema = z
  .object({
    type: z.enum(["image", "audio"]),
    data: z.string(),
    mimeType: z.string(),
  })
  .catchall(JsonValueSchema);
const ResourceLinkContentBlockV1Schema = z
  .object({
    type: z.literal("resource_link"),
    name: z.string(),
    uri: z.string(),
  })
  .catchall(JsonValueSchema);
const EmbeddedResourceContentBlockV1Schema = z
  .object({ type: z.literal("resource"), resource: JsonRecordSchema })
  .catchall(JsonValueSchema);

export const ContentBlockV1Schema = z.union([
  TextContentBlockV1Schema,
  MediaContentBlockV1Schema,
  ResourceLinkContentBlockV1Schema,
  EmbeddedResourceContentBlockV1Schema,
]);
export type ContentBlockV1 = z.output<typeof ContentBlockV1Schema>;

export const CallToolRequestV1Schema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcRequestIdV1Schema,
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: JsonRecordSchema.optional(),
    task: TaskMetadataV1Schema.optional(),
  }),
});
export type CallToolRequestV1 = z.output<typeof CallToolRequestV1Schema>;

export const CallToolResultV1Schema = z
  .object({
    content: z.array(ContentBlockV1Schema),
    structuredContent: JsonRecordSchema.optional(),
    isError: z.boolean().optional(),
    _meta: JsonRecordSchema.optional(),
  })
  .catchall(JsonValueSchema);
export type CallToolResultV1 = z.output<typeof CallToolResultV1Schema>;

export const ServerTaskCapabilitiesV1Schema = z.object({
  list: JsonRecordSchema.optional(),
  cancel: JsonRecordSchema.optional(),
  requests: z
    .object({
      tools: z
        .object({
          call: JsonRecordSchema.optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ServerTaskCapabilitiesV1 = z.output<
  typeof ServerTaskCapabilitiesV1Schema
>;

export const ServerCapabilitiesV1Schema = z.object({
  tasks: ServerTaskCapabilitiesV1Schema.optional(),
});
export type ServerCapabilitiesV1 = z.output<typeof ServerCapabilitiesV1Schema>;

function taskRequestSchema<
  M extends "tasks/get" | "tasks/result" | "tasks/cancel",
>(method: M) {
  return z.object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcRequestIdV1Schema,
    method: z.literal(method),
    params: z.object({ taskId: z.string() }),
  });
}

export const GetTaskRequestV1Schema = taskRequestSchema("tasks/get");
export type GetTaskRequestV1 = z.output<typeof GetTaskRequestV1Schema>;

export const GetTaskResultV1Schema = TaskV1Schema.extend({
  _meta: JsonRecordSchema.optional(),
});
export type GetTaskResultV1 = z.output<typeof GetTaskResultV1Schema>;

export const GetTaskResultRequestV1Schema = taskRequestSchema("tasks/result");
export type GetTaskResultRequestV1 = z.output<
  typeof GetTaskResultRequestV1Schema
>;

export const TaskResultV1Schema = JsonRecordSchema;
export type TaskResultV1 = z.output<typeof TaskResultV1Schema>;

export const ListTasksRequestV1Schema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcRequestIdV1Schema,
  method: z.literal("tasks/list"),
  params: z.object({ cursor: z.string().optional() }).optional(),
});
export type ListTasksRequestV1 = z.output<typeof ListTasksRequestV1Schema>;

export const ListTasksResultV1Schema = z.object({
  tasks: z.array(TaskV1Schema),
  nextCursor: z.string().optional(),
  _meta: JsonRecordSchema.optional(),
});
export type ListTasksResultV1 = z.output<typeof ListTasksResultV1Schema>;

export const CancelTaskRequestV1Schema = taskRequestSchema("tasks/cancel");
export type CancelTaskRequestV1 = z.output<typeof CancelTaskRequestV1Schema>;

export const CancelTaskResultV1Schema = TaskV1Schema.extend({
  _meta: JsonRecordSchema.optional(),
});
export type CancelTaskResultV1 = z.output<typeof CancelTaskResultV1Schema>;

export const TaskStatusNotificationV1Schema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("notifications/tasks/status"),
  params: TaskV1Schema.extend({ _meta: JsonRecordSchema.optional() }),
});
export type TaskStatusNotificationV1 = z.output<
  typeof TaskStatusNotificationV1Schema
>;

export const CallToolAsTaskRequestV1Schema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: JsonRecordSchema.optional(),
    task: z.object({}),
  }),
});
export type CallToolAsTaskRequestV1 = z.output<
  typeof CallToolAsTaskRequestV1Schema
>;
