import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";

import {
  CallToolRequestV1Schema,
  CallToolResultV1Schema,
  CancelTaskRequestV1Schema,
  CancelTaskResultV1Schema,
  CreateTaskResultV1Schema,
  GetTaskRequestV1Schema,
  GetTaskResultRequestV1Schema,
  GetTaskResultV1Schema,
  ListTasksRequestV1Schema,
  ListTasksResultV1Schema,
  ServerTaskCapabilitiesV1Schema,
  TaskResultV1Schema,
  TaskStatusNotificationV1Schema,
  TaskStatusV1Schema,
  TaskV1Schema,
  ToolV1Schema,
  callToolAsTaskV1,
  hasTaskCancelCapabilityV1,
  hasTaskListCapabilityV1,
  hasTaskToolCallCapabilityV1,
  isTaskEligibleMethodV1,
  shouldCallToolAsTaskV1,
  type ServerTaskCapabilitiesV1,
  type TaskStatusV1,
  type ToolV1,
} from "./index.js";

const statuses: readonly TaskStatusV1[] = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
];
const taskArb = fc.record({
  taskId: fc.string(),
  status: fc.constantFrom(...statuses),
  statusMessage: fc.option(fc.string(), { nil: undefined }),
  createdAt: fc.string(),
  lastUpdatedAt: fc.string(),
  ttl: fc.oneof(fc.integer(), fc.constant(null)),
  pollInterval: fc.option(fc.integer(), { nil: undefined }),
});
const idArb = fc.oneof(fc.string(), fc.integer());
const jsonRecordArb = fc.dictionary(
  fc.string().filter((key) => key !== "__proto__"),
  fc.jsonValue(),
);
const taskRequestArb = (
  method: "tasks/get" | "tasks/result" | "tasks/cancel",
) =>
  fc.record({
    jsonrpc: fc.constant("2.0" as const),
    id: idArb,
    method: fc.constant(method),
    params: fc.record({ taskId: fc.string() }),
  });

type Schema = z.ZodType;
const asWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function expectRoundTrip(schema: Schema, value: unknown): void {
  const wire = asWire(value);
  expect(schema.parse(wire)).toEqual(wire);
}

describe("V1 Zod wire schemas", () => {
  it("accepts every Task output and rejects missing fields, null exceptions, fractions, and statuses", () => {
    fc.assert(
      fc.property(taskArb, (task) => expectRoundTrip(TaskV1Schema, task)),
    );
    fc.assert(
      fc.property(
        taskArb,
        fc.constantFrom(
          "taskId",
          "status",
          "createdAt",
          "lastUpdatedAt",
          "ttl",
        ),
        (task, key) => {
          const invalid = { ...task };
          delete invalid[key];
          expect(TaskV1Schema.safeParse(invalid).success).toBe(false);
        },
      ),
    );
    fc.assert(
      fc.property(
        taskArb,
        fc
          .string()
          .filter((value) => !statuses.includes(value as TaskStatusV1)),
        (task, status) => {
          expect(TaskStatusV1Schema.safeParse(status).success).toBe(false);
          expect(TaskV1Schema.safeParse({ ...task, status }).success).toBe(
            false,
          );
        },
      ),
    );
    fc.assert(
      fc.property(
        taskArb,
        fc
          .double({ noNaN: true, noDefaultInfinity: true })
          .filter((value) => !Number.isInteger(value)),
        (task, fraction) => {
          expect(
            TaskV1Schema.safeParse({ ...task, ttl: fraction }).success,
          ).toBe(false);
          expect(
            TaskV1Schema.safeParse({ ...task, pollInterval: fraction }).success,
          ).toBe(false);
          expect(
            CallToolRequestV1Schema.safeParse({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "x", task: { ttl: fraction } },
            }).success,
          ).toBe(false);
        },
      ),
    );
    const [task] = fc.sample(taskArb, 1);
    expect(TaskV1Schema.safeParse({ ...task, ttl: null }).success).toBe(true);
    expect(
      TaskV1Schema.safeParse({ ...task, pollInterval: null }).success,
    ).toBe(false);
    expect(
      CallToolRequestV1Schema.safeParse({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "x", task: { ttl: null } },
      }).success,
    ).toBe(false);
  });

  it("enforces exact JSON-RPC literals and required request fields", () => {
    const cases = [
      [GetTaskRequestV1Schema, taskRequestArb("tasks/get")],
      [GetTaskResultRequestV1Schema, taskRequestArb("tasks/result")],
      [CancelTaskRequestV1Schema, taskRequestArb("tasks/cancel")],
    ] as const;
    for (const [schema, arbitrary] of cases) {
      fc.assert(
        fc.property(arbitrary, (request) => {
          expectRoundTrip(schema, request);
          expect(schema.safeParse({ ...request, jsonrpc: "1.0" }).success).toBe(
            false,
          );
          expect(
            schema.safeParse({ ...request, method: "tasks/nope" }).success,
          ).toBe(false);
          for (const key of ["jsonrpc", "id", "method", "params"] as const) {
            const invalid = { ...request };
            delete invalid[key];
            expect(schema.safeParse(invalid).success).toBe(false);
          }
          expect(schema.safeParse({ ...request, params: {} }).success).toBe(
            false,
          );
        }),
      );
    }
    expect(
      ListTasksRequestV1Schema.safeParse({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/nope",
      }).success,
    ).toBe(false);
    expect(
      TaskStatusNotificationV1Schema.safeParse({
        jsonrpc: "2.0",
        method: "notifications/tasks/nope",
        params: {},
      }).success,
    ).toBe(false);
  });

  it("parses all result and notification schema outputs", () => {
    fc.assert(
      fc.property(taskArb, jsonRecordArb, (task, metadata) => {
        expectRoundTrip(GetTaskResultV1Schema, { ...task, _meta: metadata });
        expectRoundTrip(CancelTaskResultV1Schema, { ...task, _meta: metadata });
        expectRoundTrip(CreateTaskResultV1Schema, { task, _meta: metadata });
        expectRoundTrip(TaskStatusNotificationV1Schema, {
          jsonrpc: "2.0",
          method: "notifications/tasks/status",
          params: { ...task, _meta: metadata },
        });
      }),
    );
    fc.assert(
      fc.property(
        fc.array(taskArb),
        fc.option(fc.string(), { nil: undefined }),
        (tasks, nextCursor) =>
          expectRoundTrip(ListTasksResultV1Schema, {
            tasks,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          }),
      ),
    );
    fc.assert(
      fc.property(
        idArb,
        fc.option(fc.string(), { nil: undefined }),
        (id, cursor) =>
          expectRoundTrip(ListTasksRequestV1Schema, {
            jsonrpc: "2.0",
            id,
            method: "tasks/list",
            ...(cursor === undefined ? {} : { params: { cursor } }),
          }),
      ),
    );
    fc.assert(
      fc.property(jsonRecordArb, (result) =>
        expectRoundTrip(TaskResultV1Schema, result),
      ),
    );
  });

  it("validates tool content discriminators and required fields", () => {
    const content = [
      { type: "text", text: "hello", extension: true },
      { type: "image", data: "x", mimeType: "image/png" },
      { type: "audio", data: "x", mimeType: "audio/wav" },
      { type: "resource_link", name: "n", uri: "https://x" },
      { type: "resource", resource: { uri: "https://x", text: "body" } },
    ];
    expectRoundTrip(CallToolResultV1Schema, {
      content,
      structuredContent: { ok: true },
      isError: false,
    });
    fc.assert(
      fc.property(
        fc
          .string()
          .filter(
            (type) =>
              !["text", "image", "audio", "resource_link", "resource"].includes(
                type,
              ),
          ),
        (type) => {
          expect(
            CallToolResultV1Schema.safeParse({ content: [{ type }] }).success,
          ).toBe(false);
        },
      ),
    );
    expect(
      CallToolResultV1Schema.safeParse({ content: [{ type: "text" }] }).success,
    ).toBe(false);
    expect(CallToolResultV1Schema.safeParse({}).success).toBe(false);
  });

  it("preserves the pinned unknown-key projection and open-record policy", () => {
    const [task] = fc.sample(taskArb, 1);
    expect(TaskV1Schema.parse({ ...task, extension: true })).toEqual(task);
    expect(
      GetTaskRequestV1Schema.parse({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: { taskId: "t", extension: true },
        extension: true,
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { taskId: "t" },
    });
    expect(
      CallToolResultV1Schema.parse({
        content: [{ type: "text", text: "x", extension: true }],
        extension: { ok: true },
      }),
    ).toEqual({
      content: [{ type: "text", text: "x", extension: true }],
      extension: { ok: true },
    });
    expect(
      ToolV1Schema.parse({
        name: "x",
        inputSchema: { type: "object", extension: true },
        execution: { taskSupport: "optional", extension: true },
        extension: true,
      }),
    ).toEqual({
      name: "x",
      inputSchema: { type: "object", extension: true },
      execution: { taskSupport: "optional" },
    });
  });

  it("parses tools, task calls, and nested capabilities", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(fc.constantFrom("forbidden", "optional", "required"), {
          nil: undefined,
        }),
        jsonRecordArb,
        fc.array(jsonRecordArb),
        (name, taskSupport, metadata, icons) =>
          expectRoundTrip(ToolV1Schema, {
            name,
            title: "title",
            description: "description",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: {} },
            execution: {
              ...(taskSupport === undefined ? {} : { taskSupport }),
            },
            annotations: metadata,
            icons,
            _meta: metadata,
          }),
      ),
    );
    expect(ToolV1Schema.safeParse({ name: "x", inputSchema: {} }).success).toBe(
      false,
    );
    expect(
      ToolV1Schema.safeParse({
        name: "x",
        inputSchema: { type: "object" },
        execution: { taskSupport: "sometimes" },
      }).success,
    ).toBe(false);
    fc.assert(
      fc.property(idArb, fc.string(), jsonRecordArb, (id, name, args) =>
        expectRoundTrip(CallToolRequestV1Schema, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args, task: {} },
        }),
      ),
    );
    expectRoundTrip(ServerTaskCapabilitiesV1Schema, {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    });
    expect(
      ServerTaskCapabilitiesV1Schema.safeParse({
        requests: { tools: { call: true } },
      }).success,
    ).toBe(false);
  });

  it("follows every capability-first negotiation row", () => {
    const support = fc.option(
      fc.constantFrom("forbidden", "optional", "required"),
      { nil: undefined },
    );
    fc.assert(
      fc.property(
        fc.boolean(),
        support,
        fc.boolean(),
        (present, taskSupport, preferTask) => {
          const capabilities: ServerTaskCapabilitiesV1 = present
            ? { requests: { tools: { call: {} } } }
            : {};
          const tool: ToolV1 = {
            name: "tool",
            inputSchema: { type: "object" },
            execution: { taskSupport },
          };
          expect(shouldCallToolAsTaskV1(capabilities, tool, preferTask)).toBe(
            present &&
              (taskSupport === "required" ||
                (taskSupport === "optional" && preferTask)),
          );
          expect(hasTaskToolCallCapabilityV1(capabilities)).toBe(present);
        },
      ),
    );
    expect(hasTaskListCapabilityV1({ list: {} })).toBe(true);
    expect(hasTaskListCapabilityV1({})).toBe(false);
    expect(hasTaskCancelCapabilityV1({ cancel: {} })).toBe(true);
    expect(hasTaskCancelCapabilityV1({})).toBe(false);
    fc.assert(
      fc.property(fc.string(), (method) => {
        expect(isTaskEligibleMethodV1(method)).toBe(method === "tools/call");
      }),
    );
  });

  it("constructs exact call augmentation", () => {
    expect(callToolAsTaskV1("tool", { x: 1 })).toEqual({
      method: "tools/call",
      params: { name: "tool", arguments: { x: 1 }, task: {} },
    });
    expect(callToolAsTaskV1("tool")).toEqual({
      method: "tools/call",
      params: { name: "tool", task: {} },
    });
  });
});
