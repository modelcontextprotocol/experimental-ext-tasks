/** MCP Tasks V1 wire declarations. */
import { type JsonValue } from "../index.js";

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

export interface TaskMetadataV1 {
  readonly ttl?: number;
}
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

export interface ToolExecutionV1 {
  readonly taskSupport?: TaskSupportV1;
}
export interface ToolV1 {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>> & {
    readonly type: "object";
  };
  readonly outputSchema?: Readonly<Record<string, JsonValue>> & {
    readonly type: "object";
  };
  readonly execution?: ToolExecutionV1;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly icons?: readonly Readonly<Record<string, JsonValue>>[];
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}

export type ContentBlockV1 =
  | {
      readonly type: "text";
      readonly text: string;
      readonly [key: string]: JsonValue;
    }
  | {
      readonly type: "image" | "audio";
      readonly data: string;
      readonly mimeType: string;
      readonly [key: string]: JsonValue;
    }
  | {
      readonly type: "resource_link";
      readonly name: string;
      readonly uri: string;
      readonly [key: string]: JsonValue;
    }
  | {
      readonly type: "resource";
      readonly resource: Readonly<Record<string, JsonValue>>;
      readonly [key: string]: JsonValue;
    };
export interface CallToolRequestV1 {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcRequestIdV1;
  readonly method: "tools/call";
  readonly params: {
    readonly name: string;
    readonly arguments?: Readonly<Record<string, JsonValue>>;
    readonly task?: TaskMetadataV1;
  };
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
  readonly requests?: {
    readonly tools?: { readonly call?: Readonly<Record<string, JsonValue>> };
  };
}
export interface ServerCapabilitiesV1 {
  readonly tasks?: ServerTaskCapabilitiesV1;
}

interface JsonRpcRequestV1<M extends string, P> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcRequestIdV1;
  readonly method: M;
  readonly params: P;
}
export type GetTaskRequestV1 = JsonRpcRequestV1<
  "tasks/get",
  { readonly taskId: string }
>;
export type GetTaskResultV1 = TaskV1 & {
  readonly _meta?: Readonly<Record<string, JsonValue>>;
};
export type GetTaskResultRequestV1 = JsonRpcRequestV1<
  "tasks/result",
  { readonly taskId: string }
>;
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
export type CancelTaskRequestV1 = JsonRpcRequestV1<
  "tasks/cancel",
  { readonly taskId: string }
>;
export type CancelTaskResultV1 = TaskV1 & {
  readonly _meta?: Readonly<Record<string, JsonValue>>;
};
export interface TaskStatusNotificationV1 {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/tasks/status";
  readonly params: TaskV1 & {
    readonly _meta?: Readonly<Record<string, JsonValue>>;
  };
}

export interface CallToolAsTaskRequestV1 {
  readonly method: "tools/call";
  readonly params: {
    readonly name: string;
    readonly arguments?: Readonly<Record<string, JsonValue>>;
    readonly task: Record<string, never>;
  };
}
