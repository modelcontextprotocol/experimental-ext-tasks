/** MCP Tasks V2 wire declarations. */
import { type JsonValue } from "../index.js";

export const TASKS_EXTENSION_ID_V2 = "io.modelcontextprotocol/tasks" as const;
export const CLIENT_CAPABILITIES_META_KEY_V2 =
  "io.modelcontextprotocol/clientCapabilities" as const;

type OpenObjectV2 = Readonly<Record<string, JsonValue>>;
type ToolAnnotationsV2 = OpenObjectV2 & {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
};
type IconV2 = OpenObjectV2 & {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
  readonly theme?: "light" | "dark";
};
export type ContentBlockV2 = OpenObjectV2 &
  (
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image" | "audio";
        readonly data: string;
        readonly mimeType: string;
      }
    | {
        readonly type: "resource_link";
        readonly name: string;
        readonly uri: string;
      }
    | { readonly type: "resource"; readonly resource: OpenObjectV2 }
  );

export type ToolV2 = OpenObjectV2 & {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: OpenObjectV2 & {
    readonly type: "object";
    readonly $schema?: string;
  };
  readonly outputSchema?: OpenObjectV2 & { readonly $schema?: string };
  readonly annotations?: ToolAnnotationsV2;
  readonly icons?: readonly IconV2[];
  readonly _meta?: OpenObjectV2;
};
export type RequestIdV2 = string | number;
export type TaskStatusV2 =
  "working" | "input_required" | "completed" | "failed" | "cancelled";

export type TaskEligibleMethodV2 = "tools/call";

export interface TaskV2 {
  readonly taskId: string;
  readonly status: TaskStatusV2;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
}

export interface WorkingTaskV2 extends TaskV2 {
  readonly status: "working";
}
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
export interface CancelledTaskV2 extends TaskV2 {
  readonly status: "cancelled";
}
export type DetailedTaskV2 =
  | WorkingTaskV2
  | InputRequiredTaskV2
  | CompletedTaskV2
  | FailedTaskV2
  | CancelledTaskV2;

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
export type InputRequestV2 =
  CreateMessageRequestV2 | ListRootsRequestV2 | ElicitRequestV2;
export type InputRequestsV2 = Readonly<Record<string, InputRequestV2>>;

export interface CreateMessageResultV2 extends Readonly<
  Record<string, JsonValue>
> {
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
export type InputResponseV2 =
  CreateMessageResultV2 | ListRootsResultV2 | ElicitResultV2;
export type InputResponsesV2 = Readonly<Record<string, InputResponseV2>>;

export interface CreateTaskResultV2 extends TaskV2 {
  readonly resultType: "task";
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}
export type CallToolResultV2 = OpenObjectV2 & {
  readonly resultType: string;
  readonly content: readonly ContentBlockV2[];
  readonly structuredContent?: JsonValue;
  readonly isError?: boolean;
  readonly _meta?: OpenObjectV2;
};

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
  readonly params: {
    readonly taskId: string;
    readonly inputResponses: InputResponsesV2;
  };
}
export interface CancelTaskRequestV2 extends JsonRpcRequestV2 {
  readonly method: "tasks/cancel";
  readonly params: { readonly taskId: string };
}
export type GetTaskResultV2 = DetailedTaskV2 & {
  readonly resultType: "complete";
  readonly _meta?: Readonly<Record<string, JsonValue>>;
};
export interface UpdateTaskResultV2 extends Readonly<
  Record<string, JsonValue>
> {
  readonly resultType: "complete";
}
export interface CancelTaskResultV2 extends Readonly<
  Record<string, JsonValue>
> {
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
export interface TaskSubscriptionNotificationsV2 {
  readonly taskIds?: readonly string[];
}
export interface TaskSubscriptionAcknowledgedNotificationsV2 {
  readonly taskIds?: readonly string[];
}
export type TasksExtensionCapabilityV2 = Readonly<Record<string, never>>;

export interface ClientTaskCapabilityEnvelopeV2 {
  readonly extensions: {
    readonly [TASKS_EXTENSION_ID_V2]: TasksExtensionCapabilityV2;
  };
}
export interface ServerTaskCapabilityEnvelopeV2 {
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}
