import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { JsonValue } from "../index.js";

import {
  CancelTaskRequestV2Codec, CancelTaskResultV2Codec, CreateTaskResultV2Codec,
  DetailedTaskV2Codec, ErrorV2Codec, GetTaskRequestV2Codec, GetTaskResultV2Codec,
  InputRequestsV2Codec, InputResponsesV2Codec, TaskStatusNotificationV2Codec,
  TaskV2Codec, UpdateTaskRequestV2Codec, UpdateTaskResultV2Codec,
  contributeTaskFilterV2, hasTaskClientCapabilityV2, hasTaskServerCapabilityV2,
  isEligibleTaskResultV2, readAcceptedTaskIdsV2, withTaskCapabilityV2,
  type TaskStatusV2,
} from "./index.js";

const statuses: readonly TaskStatusV2[] = ["working", "input_required", "completed", "failed", "cancelled"];
const baseTask = fc.record({
  taskId: fc.string(),
  status: fc.constantFrom(...statuses),
  statusMessage: fc.option(fc.string(), { nil: undefined }),
  createdAt: fc.string(),
  lastUpdatedAt: fc.string(),
  ttlMs: fc.oneof(fc.integer(), fc.constant(null)),
  pollIntervalMs: fc.option(fc.integer(), { nil: undefined }),
});
const taskFor = (status: TaskStatusV2) => baseTask.map((task) => ({ ...task, status }));
const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

describe("V2 generated wire contracts", () => {
  it("accepts every valid base Task and rejects missing required fields, invalid integers, and statuses", () => {
    fc.assert(fc.property(baseTask, (task) => { expect(TaskV2Codec.parse(asJson(task)).success).toBe(true); }));
    fc.assert(fc.property(baseTask, fc.constantFrom("taskId", "status", "createdAt", "lastUpdatedAt", "ttlMs"), (task, key) => {
      const invalid = { ...task }; delete invalid[key];
      expect(TaskV2Codec.parse(asJson(invalid)).success).toBe(false);
    }));
    fc.assert(fc.property(baseTask, fc.string().filter((status) => !statuses.includes(status as TaskStatusV2)), (task, status) => {
      expect(TaskV2Codec.parse(asJson({ ...task, status })).success).toBe(false);
    }));
    fc.assert(fc.property(baseTask, fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)), (task, ttlMs) => {
      expect(TaskV2Codec.parse(asJson({ ...task, ttlMs })).success).toBe(false);
    }));
  });

  it("enforces status-owned DetailedTask payloads", () => {
    fc.assert(fc.property(taskFor("working"), (task) => { expect(DetailedTaskV2Codec.parse(asJson(task)).success).toBe(true); }));
    fc.assert(fc.property(taskFor("cancelled"), (task) => { expect(DetailedTaskV2Codec.parse(asJson(task)).success).toBe(true); }));
    fc.assert(fc.property(taskFor("input_required"), fc.dictionary(fc.string(), fc.constant({ method: "roots/list" as const })), (task, inputRequests) => {
      expect(DetailedTaskV2Codec.parse(asJson({ ...task, inputRequests })).success).toBe(true);
    }));
    fc.assert(fc.property(taskFor("completed"), fc.dictionary(fc.string(), fc.jsonValue()), (task, result) => {
      expect(DetailedTaskV2Codec.parse(asJson({ ...task, result })).success).toBe(true);
    }));
    fc.assert(fc.property(taskFor("failed"), fc.integer(), fc.string(), (task, code, message) => {
      expect(DetailedTaskV2Codec.parse(asJson({ ...task, error: { code, message } })).success).toBe(true);
    }));
    fc.assert(fc.property(fc.constantFrom("input_required", "completed", "failed"), (status) => {
      expect(DetailedTaskV2Codec.parse({ taskId: "id", status, createdAt: "a", lastUpdatedAt: "b", ttlMs: null }).success).toBe(false);
    }));
  });

  it("strictly decodes input request and response maps", () => {
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.oneof(
      fc.record({ method: fc.constant("roots/list" as const) }),
      fc.record({ method: fc.constant("sampling/createMessage" as const), params: fc.dictionary(fc.string(), fc.jsonValue()) }),
      fc.record({ method: fc.constant("elicitation/create" as const), params: fc.dictionary(fc.string(), fc.jsonValue()) }),
    )), (requests) => { expect(InputRequestsV2Codec.parse(asJson(requests)).success).toBe(true); }));
    expect(InputRequestsV2Codec.parse({ key: { method: "unknown", params: {} } }).success).toBe(false);
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.oneof(
      fc.record({ action: fc.constantFrom("accept" as const, "decline" as const, "cancel" as const) }),
      fc.record({ roots: fc.array(fc.jsonValue()) }),
      fc.record({ content: fc.jsonValue(), model: fc.string(), role: fc.constantFrom("user" as const, "assistant" as const) }),
    )), (responses) => { expect(InputResponsesV2Codec.parse(asJson(responses)).success).toBe(true); }));
    expect(InputResponsesV2Codec.parse({ key: {} }).success).toBe(false);
  });

  it("decodes complete JSON-RPC errors", () => {
    fc.assert(fc.property(fc.integer(), fc.string(), fc.option(fc.jsonValue(), { nil: undefined }), (code, message, data) => {
      expect(ErrorV2Codec.parse(asJson({ code, message, ...(data === undefined ? {} : { data }) })).success).toBe(true);
    }));
    expect(ErrorV2Codec.parse({ code: 1 }).success).toBe(false);
    expect(ErrorV2Codec.parse({ code: 1.5, message: "bad" }).success).toBe(false);
  });

  it("binds strict get, update, and cancel request/result discriminators", () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.integer()), fc.string(), (id, taskId) => {
      expect(GetTaskRequestV2Codec.parse({ jsonrpc: "2.0", id, method: "tasks/get", params: { taskId } }).success).toBe(true);
      expect(CancelTaskRequestV2Codec.parse({ jsonrpc: "2.0", id, method: "tasks/cancel", params: { taskId } }).success).toBe(true);
      expect(UpdateTaskRequestV2Codec.parse({ jsonrpc: "2.0", id, method: "tasks/update", params: { taskId, inputResponses: {} } }).success).toBe(true);
    }));
    for (const codec of [GetTaskRequestV2Codec, UpdateTaskRequestV2Codec, CancelTaskRequestV2Codec]) {
      expect(codec.parse({ jsonrpc: "2.0", id: 1, method: "wrong", params: {} }).success).toBe(false);
    }
    expect(UpdateTaskResultV2Codec.parse({ resultType: "complete" }).success).toBe(true);
    expect(CancelTaskResultV2Codec.parse({ resultType: "complete" }).success).toBe(true);
    expect(UpdateTaskResultV2Codec.parse({}).success).toBe(false);
    fc.assert(fc.property(taskFor("completed"), fc.dictionary(fc.string(), fc.jsonValue()), (task, result) => {
      expect(GetTaskResultV2Codec.parse(asJson({ ...task, result, resultType: "complete" })).success).toBe(true);
    }));
  });

  it("discriminates Task creation only for eligible tools/call results", () => {
    fc.assert(fc.property(baseTask, (task) => {
      const result = { ...task, resultType: "task" };
      expect(CreateTaskResultV2Codec.parse(asJson(result)).success).toBe(true);
      expect(isEligibleTaskResultV2("tools/call", result)).toBe(true);
      expect(isEligibleTaskResultV2("prompts/get", result)).toBe(false);
    }));
    expect(CreateTaskResultV2Codec.parse({ resultType: "complete" }).success).toBe(false);
  });

  it("decodes detailed task notifications with exact envelope discriminators", () => {
    fc.assert(fc.property(taskFor("working"), (task) => {
      expect(TaskStatusNotificationV2Codec.parse(asJson({ jsonrpc: "2.0", method: "notifications/tasks", params: task })).success).toBe(true);
    }));
    expect(TaskStatusNotificationV2Codec.parse({ jsonrpc: "2.0", method: "notifications/wrong", params: {} }).success).toBe(false);
  });

  it("contributes task IDs without changing unrelated filters or prior notification fields", () => {
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.dictionary(fc.string(), fc.jsonValue()), fc.array(fc.string()), (filter, notifications, ids) => {
      const source = asJson({ ...filter, notifications }) as Readonly<Record<string, JsonValue>>;
      const result = contributeTaskFilterV2(source, ids);
      for (const [key, value] of Object.entries(source)) if (key !== "notifications") expect(result[key]).toEqual(value);
      const normalizedNotifications = source.notifications as Readonly<Record<string, JsonValue>>;
      for (const [key, value] of Object.entries(normalizedNotifications)) if (key !== "taskIds") expect(result.notifications[key]).toEqual(value);
      expect(result.notifications.taskIds).toEqual([...new Set(ids)]);
    }));
  });

  it("reads only fully valid acknowledged task IDs", () => {
    fc.assert(fc.property(fc.array(fc.string()), (ids) => { expect(readAcceptedTaskIdsV2({ notifications: { taskIds: ids } })).toEqual(ids); }));
    fc.assert(fc.property(fc.array(fc.oneof(fc.string(), fc.integer())).filter((ids) => ids.some((id) => typeof id !== "string")), (ids) => {
      expect(readAcceptedTaskIdsV2({ notifications: { taskIds: ids } })).toEqual([]);
    }));
  });

  it("uses exact client and server capability envelopes", () => {
    const wire = withTaskCapabilityV2({ _meta: { trace: "x" } });
    expect(wire).toEqual({ _meta: { trace: "x", "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } } });
    expect(hasTaskClientCapabilityV2(wire)).toBe(true);
    expect(hasTaskServerCapabilityV2({ extensions: { "io.modelcontextprotocol/tasks": {} } })).toBe(true);
    expect(hasTaskServerCapabilityV2({ extensions: {} })).toBe(false);
  });
});
