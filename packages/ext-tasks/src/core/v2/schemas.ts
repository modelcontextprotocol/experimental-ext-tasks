/** MCP Tasks V2 Zod schemas and schema-inferred wire declarations. */
import { z } from "zod/v4";

import { isJsonValue } from "../index.js";
import type { JsonValue } from "../index.js";

const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  isJsonValue,
  "Expected a JSON value",
);
export const TASKS_EXTENSION_ID_V2 = "io.modelcontextprotocol/tasks" as const;
export const CLIENT_CAPABILITIES_META_KEY_V2 =
  "io.modelcontextprotocol/clientCapabilities" as const;

const JsonObjectSchema = z.custom<Readonly<Record<string, JsonValue>>>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isJsonValue(value),
  "Expected a JSON object",
);
const MetaSchema = JsonObjectSchema;
const copyUndeclaredJsonKeys = (
  target: Record<string, unknown>,
  source: Readonly<Record<string, JsonValue>>,
  declaredKeys: ReadonlySet<string>,
): void => {
  for (const key of Object.keys(source)) {
    if (declaredKeys.has(key)) continue;
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: source[key],
      writable: true,
    });
  }
};

const openObject = <T extends z.ZodRawShape>(shape: T) => {
  const validator = z.object(shape).catchall(JsonValueSchema);
  const declaredKeys = new Set(Object.keys(shape));
  return z.unknown().transform((value, context) => {
    const parsed = validator.safeParse(value);
    if (parsed.success) {
      const data = parsed.data;
      copyUndeclaredJsonKeys(
        data,
        value as Readonly<Record<string, JsonValue>>,
        declaredKeys,
      );
      return data;
    }
    for (const issue of parsed.error.issues)
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    return z.NEVER;
  });
};

const IconV2Schema = openObject({
  src: z.string(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});
const AnnotationsV2Schema = openObject({
  audience: z.array(z.enum(["user", "assistant"])).optional(),
  priority: z.number().min(0).max(1).optional(),
  lastModified: z.string().optional(),
});
const ResourceContentsV2Schema = openObject({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string().optional(),
  blob: z.string().optional(),
  _meta: MetaSchema.optional(),
}).refine(
  (resource) => resource.text !== undefined || resource.blob !== undefined,
  {
    message: "expected text or blob",
  },
);

const ContentBaseShape = {
  annotations: AnnotationsV2Schema.optional(),
  _meta: MetaSchema.optional(),
};
const TextContentBlockV2Schema = openObject({
  ...ContentBaseShape,
  type: z.literal("text"),
  text: z.string(),
});
const ImageContentBlockV2Schema = openObject({
  ...ContentBaseShape,
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
const AudioContentBlockV2Schema = openObject({
  ...ContentBaseShape,
  type: z.literal("audio"),
  data: z.string(),
  mimeType: z.string(),
});
const ResourceLinkContentBlockV2Schema = openObject({
  ...ContentBaseShape,
  type: z.literal("resource_link"),
  name: z.string(),
  uri: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.int().optional(),
  icons: z.array(IconV2Schema).optional(),
});
const EmbeddedResourceContentBlockV2Schema = openObject({
  ...ContentBaseShape,
  type: z.literal("resource"),
  resource: ResourceContentsV2Schema,
});
const ContentBlockV2Schema = z.union([
  TextContentBlockV2Schema,
  ImageContentBlockV2Schema,
  AudioContentBlockV2Schema,
  ResourceLinkContentBlockV2Schema,
  EmbeddedResourceContentBlockV2Schema,
]);

const ToolV2Schema = openObject({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: openObject({
    type: z.literal("object"),
    $schema: z.string().optional(),
  }),
  outputSchema: openObject({ $schema: z.string().optional() }).optional(),
  annotations: openObject({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }).optional(),
  icons: z.array(IconV2Schema).optional(),
  _meta: MetaSchema.optional(),
});

const CompleteResultTypeSchema = z.literal("complete").default("complete");
const CallToolResultV2Schema = openObject({
  resultType: CompleteResultTypeSchema,
  content: z.array(ContentBlockV2Schema),
  structuredContent: JsonValueSchema.optional(),
  isError: z.boolean().optional(),
  _meta: MetaSchema.optional(),
});

const RequestIdV2Schema = z.union([z.string(), z.int()]);
const TaskStatusV2Schema = z.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);
const TaskEligibleMethodV2Schema = z.literal("tools/call");
const TaskBaseShape = {
  taskId: z.string(),
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttlMs: z.int().nullable(),
  pollIntervalMs: z.int().optional(),
};
const TaskV2Schema = z.object({
  ...TaskBaseShape,
  status: TaskStatusV2Schema,
});

const ErrorV2Schema = z.object({
  code: z.int(),
  message: z.string(),
  data: JsonValueSchema.optional(),
});

const CreateMessageRequestV2Schema = z.object({
  method: z.literal("sampling/createMessage"),
  params: JsonObjectSchema,
});
const ListRootsRequestV2Schema = z.object({
  method: z.literal("roots/list"),
  params: JsonObjectSchema.optional(),
});
const ElicitRequestV2Schema = z.object({
  method: z.literal("elicitation/create"),
  params: JsonObjectSchema,
});
const InputRequestV2Schema = z.discriminatedUnion("method", [
  CreateMessageRequestV2Schema,
  ListRootsRequestV2Schema,
  ElicitRequestV2Schema,
]);
const InputRequestsV2Schema = z.record(z.string(), InputRequestV2Schema);

const CreateMessageResultV2Schema = openObject({
  content: JsonValueSchema,
  model: z.string(),
  role: z.enum(["user", "assistant"]),
});
const ListRootsResultV2Schema = openObject({
  roots: z.array(JsonValueSchema),
});
const ElicitResultV2Schema = openObject({
  action: z.enum(["accept", "decline", "cancel"]),
});
// Response shapes overlap, so this union is intentionally non-discriminated.
const InputResponseUnionV2Schema = z.union([
  ElicitResultV2Schema,
  ListRootsResultV2Schema,
  CreateMessageResultV2Schema,
]);
const InputResponseV2Schema = InputResponseUnionV2Schema;
const InputResponsesV2Schema = z.record(z.string(), InputResponseV2Schema);

const WorkingTaskV2Schema = z.object({
  ...TaskBaseShape,
  status: z.literal("working"),
});
const InputRequiredTaskV2Schema = z.object({
  ...TaskBaseShape,
  status: z.literal("input_required"),
  inputRequests: InputRequestsV2Schema,
});
const CompletedTaskV2Schema = z.object({
  ...TaskBaseShape,
  status: z.literal("completed"),
  result: JsonObjectSchema,
});
const FailedTaskV2Schema = z.object({
  ...TaskBaseShape,
  status: z.literal("failed"),
  error: ErrorV2Schema,
});
const CancelledTaskV2Schema = z.object({
  ...TaskBaseShape,
  status: z.literal("cancelled"),
});
const DetailedTaskV2Schema = z.discriminatedUnion("status", [
  WorkingTaskV2Schema,
  InputRequiredTaskV2Schema,
  CompletedTaskV2Schema,
  FailedTaskV2Schema,
  CancelledTaskV2Schema,
]);

const CreateTaskResultV2Schema = z.object({
  ...TaskBaseShape,
  status: TaskStatusV2Schema,
  resultType: z.literal("task"),
  _meta: MetaSchema.optional(),
});
const RpcBaseShape = { jsonrpc: z.literal("2.0"), id: RequestIdV2Schema };
const taskIdRequestV2Schema = <TMethod extends "tasks/get" | "tasks/cancel">(
  method: TMethod,
) =>
  z.object({
    ...RpcBaseShape,
    method: z.literal(method),
    params: z.object({ taskId: z.string() }),
  });
const GetTaskRequestV2Schema = taskIdRequestV2Schema("tasks/get");
const UpdateTaskRequestV2Schema = z.object({
  ...RpcBaseShape,
  method: z.literal("tasks/update"),
  params: z.object({
    taskId: z.string(),
    inputResponses: InputResponsesV2Schema,
  }),
});
const CancelTaskRequestV2Schema = taskIdRequestV2Schema("tasks/cancel");
const GetTaskResultV2Schema = z.intersection(
  DetailedTaskV2Schema,
  z.object({
    resultType: CompleteResultTypeSchema,
    _meta: MetaSchema.optional(),
  }),
);
const CompleteOperationResultShape = {
  resultType: CompleteResultTypeSchema,
  _meta: MetaSchema.optional(),
};
const completeOperationResultV2Schema = () =>
  openObject(CompleteOperationResultShape);
const UpdateTaskResultV2Schema = completeOperationResultV2Schema();
const CancelTaskResultV2Schema = completeOperationResultV2Schema();

const TaskStatusNotificationParamsV2Schema = z.intersection(
  DetailedTaskV2Schema,
  z.object({ _meta: MetaSchema.optional() }),
);
const TaskStatusNotificationV2Schema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("notifications/tasks"),
  params: TaskStatusNotificationParamsV2Schema,
});
const TaskSubscriptionNotificationsV2Schema = z.object({
  taskIds: z.array(z.string()).optional(),
});
const TaskSubscriptionAcknowledgedNotificationsV2Schema =
  TaskSubscriptionNotificationsV2Schema;
const TasksExtensionCapabilityV2Schema = z.strictObject({});

const ClientTaskCapabilityEnvelopeV2Schema = z.object({
  extensions: z.object({
    [TASKS_EXTENSION_ID_V2]: TasksExtensionCapabilityV2Schema,
  }),
});
const ServerTaskCapabilityEnvelopeV2Schema = z.object({
  extensions: z.record(z.string(), JsonValueSchema).optional(),
});

export {
  ContentBlockV2Schema,
  ToolV2Schema,
  CallToolResultV2Schema,
  RequestIdV2Schema,
  TaskStatusV2Schema,
  TaskEligibleMethodV2Schema,
  TaskV2Schema,
  ErrorV2Schema,
  CreateMessageRequestV2Schema,
  ListRootsRequestV2Schema,
  ElicitRequestV2Schema,
  InputRequestV2Schema,
  InputRequestsV2Schema,
  CreateMessageResultV2Schema,
  ListRootsResultV2Schema,
  ElicitResultV2Schema,
  InputResponseV2Schema,
  InputResponsesV2Schema,
  WorkingTaskV2Schema,
  InputRequiredTaskV2Schema,
  CompletedTaskV2Schema,
  FailedTaskV2Schema,
  CancelledTaskV2Schema,
  DetailedTaskV2Schema,
  CreateTaskResultV2Schema,
  GetTaskRequestV2Schema,
  UpdateTaskRequestV2Schema,
  CancelTaskRequestV2Schema,
  GetTaskResultV2Schema,
  UpdateTaskResultV2Schema,
  CancelTaskResultV2Schema,
  TaskStatusNotificationParamsV2Schema,
  TaskStatusNotificationV2Schema,
  TaskSubscriptionNotificationsV2Schema,
  TaskSubscriptionAcknowledgedNotificationsV2Schema,
  TasksExtensionCapabilityV2Schema,
  ClientTaskCapabilityEnvelopeV2Schema,
  ServerTaskCapabilityEnvelopeV2Schema,
};

export type ContentBlockV2 = z.infer<typeof ContentBlockV2Schema>;
export type ToolV2 = z.infer<typeof ToolV2Schema>;
export type CallToolResultV2 = z.infer<typeof CallToolResultV2Schema>;
export type RequestIdV2 = z.infer<typeof RequestIdV2Schema>;
export type TaskStatusV2 = z.infer<typeof TaskStatusV2Schema>;
export type TaskEligibleMethodV2 = z.infer<typeof TaskEligibleMethodV2Schema>;
export type TaskV2 = z.infer<typeof TaskV2Schema>;
export type ErrorV2 = z.infer<typeof ErrorV2Schema>;
export type CreateMessageRequestV2 = z.infer<
  typeof CreateMessageRequestV2Schema
>;
export type ListRootsRequestV2 = z.infer<typeof ListRootsRequestV2Schema>;
export type ElicitRequestV2 = z.infer<typeof ElicitRequestV2Schema>;
export type InputRequestV2 = z.infer<typeof InputRequestV2Schema>;
export type InputRequestsV2 = z.infer<typeof InputRequestsV2Schema>;
export type CreateMessageResultV2 = z.infer<typeof CreateMessageResultV2Schema>;
export type ListRootsResultV2 = z.infer<typeof ListRootsResultV2Schema>;
export type ElicitResultV2 = z.infer<typeof ElicitResultV2Schema>;
export type InputResponseV2 = z.infer<typeof InputResponseV2Schema>;
export type InputResponsesV2 = z.infer<typeof InputResponsesV2Schema>;
export type WorkingTaskV2 = z.infer<typeof WorkingTaskV2Schema>;
export type InputRequiredTaskV2 = z.infer<typeof InputRequiredTaskV2Schema>;
export type CompletedTaskV2 = z.infer<typeof CompletedTaskV2Schema>;
export type FailedTaskV2 = z.infer<typeof FailedTaskV2Schema>;
export type CancelledTaskV2 = z.infer<typeof CancelledTaskV2Schema>;
export type DetailedTaskV2 = z.infer<typeof DetailedTaskV2Schema>;
export type CreateTaskResultV2 = z.infer<typeof CreateTaskResultV2Schema>;
export type GetTaskRequestV2 = z.infer<typeof GetTaskRequestV2Schema>;
export type UpdateTaskRequestV2 = z.infer<typeof UpdateTaskRequestV2Schema>;
export type CancelTaskRequestV2 = z.infer<typeof CancelTaskRequestV2Schema>;
export type GetTaskResultV2 = z.infer<typeof GetTaskResultV2Schema>;
export type UpdateTaskResultV2 = z.infer<typeof UpdateTaskResultV2Schema>;
export type CancelTaskResultV2 = z.infer<typeof CancelTaskResultV2Schema>;
export type TaskStatusNotificationParamsV2 = z.infer<
  typeof TaskStatusNotificationParamsV2Schema
>;
export type TaskStatusNotificationV2 = z.infer<
  typeof TaskStatusNotificationV2Schema
>;
export type TaskSubscriptionNotificationsV2 = z.infer<
  typeof TaskSubscriptionNotificationsV2Schema
>;
export type TaskSubscriptionAcknowledgedNotificationsV2 = z.infer<
  typeof TaskSubscriptionAcknowledgedNotificationsV2Schema
>;
export type TasksExtensionCapabilityV2 = z.infer<
  typeof TasksExtensionCapabilityV2Schema
>;
export type ClientTaskCapabilityEnvelopeV2 = z.infer<
  typeof ClientTaskCapabilityEnvelopeV2Schema
>;
export type ServerTaskCapabilityEnvelopeV2 = z.infer<
  typeof ServerTaskCapabilityEnvelopeV2Schema
>;
