import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CallToolRequestV1Codec,
  CallToolResultV1Codec,
  CancelTaskRequestV1Codec,
  CancelTaskResultV1Codec,
  CreateTaskResultV1Codec,
  GetTaskRequestV1Codec,
  GetTaskResultRequestV1Codec,
  GetTaskResultV1Codec,
  ListTasksRequestV1Codec,
  ListTasksResultV1Codec,
  ServerTaskCapabilitiesV1Codec,
  TaskResultV1Codec,
  TaskStatusNotificationV1Codec,
  TaskStatusV1Codec,
  TaskV1Codec,
  ToolV1Codec,
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
const taskRequestArb = (
  method: "tasks/get" | "tasks/result" | "tasks/cancel",
) =>
  fc.record({
    jsonrpc: fc.constant("2.0" as const),
    id: idArb,
    method: fc.constant(method),
    params: fc.record({ taskId: fc.string() }),
  });

function expectRoundTrip(
  codec: { parse(value: never): { success: boolean; value?: unknown } },
  value: unknown,
): void {
  const decoded = codec.parse(value as never);
  expect(decoded.success).toBe(true);
  if (decoded.success) expect(decoded.value).toEqual(value);
}

describe("V1 generated wire contracts", () => {
  it("round-trips Tasks and rejects missing fields, fractions, and unknown statuses", () => {
    fc.assert(
      fc.property(taskArb, (task) => {
        expectRoundTrip(TaskV1Codec, task);
      }),
    );
    fc.assert(
      fc.property(
        fc.string().filter((v) => !statuses.includes(v as TaskStatusV1)),
        (value) => {
          expect(TaskStatusV1Codec.parse(value).success).toBe(false);
        },
      ),
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
          const { [key]: ignored, ...incomplete } = task;
          void ignored;
          expect(TaskV1Codec.parse(incomplete as never).success).toBe(false);
        },
      ),
    );
    fc.assert(
      fc.property(
        taskArb,
        fc
          .double({ noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Number.isInteger(n)),
        (task, fraction) => {
          expect(
            TaskV1Codec.parse({ ...task, ttl: fraction } as never).success,
          ).toBe(false);
          expect(
            TaskV1Codec.parse({ ...task, pollInterval: fraction } as never)
              .success,
          ).toBe(false);
        },
      ),
    );
  });

  it("round-trips strict task operation requests and rejects discriminator changes", () => {
    const cases = [
      [GetTaskRequestV1Codec, taskRequestArb("tasks/get")],
      [GetTaskResultRequestV1Codec, taskRequestArb("tasks/result")],
      [CancelTaskRequestV1Codec, taskRequestArb("tasks/cancel")],
    ] as const;
    for (const [codec, arbitrary] of cases)
      fc.assert(
        fc.property(arbitrary, (request) => {
          expectRoundTrip(codec, request);
          expect(
            codec.parse({ ...request, method: "tasks/nope" }).success,
          ).toBe(false);
          expect(codec.parse({ ...request, jsonrpc: "1.0" }).success).toBe(
            false,
          );
          const { params: ignored, ...withoutParams } = request;
          void ignored;
          expect(codec.parse(withoutParams as never).success).toBe(false);
        }),
      );
  });

  it("round-trips get/cancel/list/create results and notifications", () => {
    fc.assert(
      fc.property(taskArb, (task) => {
        expectRoundTrip(GetTaskResultV1Codec, task);
        expectRoundTrip(CancelTaskResultV1Codec, task);
        expectRoundTrip(CreateTaskResultV1Codec, { task });
        expectRoundTrip(TaskStatusNotificationV1Codec, {
          jsonrpc: "2.0",
          method: "notifications/tasks/status",
          params: task,
        });
      }),
    );
    fc.assert(
      fc.property(
        fc.array(taskArb),
        fc.option(fc.string(), { nil: undefined }),
        (tasks, nextCursor) => {
          expectRoundTrip(ListTasksResultV1Codec, {
            tasks,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          });
        },
      ),
    );
    fc.assert(
      fc.property(
        idArb,
        fc.option(fc.string(), { nil: undefined }),
        (id, cursor) => {
          expectRoundTrip(ListTasksRequestV1Codec, {
            jsonrpc: "2.0",
            id,
            method: "tasks/list",
            ...(cursor === undefined ? {} : { params: { cursor } }),
          });
        },
      ),
    );
    expect(
      TaskStatusNotificationV1Codec.parse({
        jsonrpc: "2.0",
        method: "notifications/tasks/nope",
        params: {},
      }).success,
    ).toBe(false);
  });

  it("decodes arbitrary task results and strict tool call content discriminators", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (result) => {
        expectRoundTrip(TaskResultV1Codec, result);
      }),
    );
    const content = [
      { type: "text", text: "hello" },
      { type: "image", data: "x", mimeType: "image/png" },
      { type: "audio", data: "x", mimeType: "audio/wav" },
      { type: "resource_link", name: "n", uri: "https://x" },
      { type: "resource", resource: { uri: "https://x", text: "body" } },
    ];
    expectRoundTrip(CallToolResultV1Codec, {
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
            CallToolResultV1Codec.parse({ content: [{ type }] }).success,
          ).toBe(false);
        },
      ),
    );
    expect(
      CallToolResultV1Codec.parse({ content: [{ type: "text" }] }).success,
    ).toBe(false);
  });

  it("decodes tools, task-augmented calls, and nested capabilities strictly", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(fc.constantFrom("forbidden", "optional", "required"), {
          nil: undefined,
        }),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.array(fc.dictionary(fc.string(), fc.jsonValue())),
        (name, taskSupport, metadata, icons) => {
          expectRoundTrip(ToolV1Codec, {
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
          });
        },
      ),
    );
    expect(ToolV1Codec.parse({ name: "x", inputSchema: {} }).success).toBe(
      false,
    );
    expect(
      ToolV1Codec.parse({
        name: "x",
        inputSchema: { type: "object" },
        execution: { taskSupport: "sometimes" },
      }).success,
    ).toBe(false);
    for (const [field, invalid] of [
      ["outputSchema", true],
      ["annotations", true],
      ["icons", true],
      ["_meta", true],
    ] as const) {
      expect(
        ToolV1Codec.parse({
          name: "x",
          inputSchema: { type: "object" },
          [field]: invalid,
        }).success,
      ).toBe(false);
    }
    expect(
      ToolV1Codec.parse({
        name: "x",
        inputSchema: { type: "object" },
        icons: [true],
      }).success,
    ).toBe(false);
    fc.assert(
      fc.property(
        idArb,
        fc.string(),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (id, name, args) => {
          expectRoundTrip(CallToolRequestV1Codec, {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args, task: {} },
          });
        },
      ),
    );
    expect(
      CallToolRequestV1Codec.parse({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/nope",
        params: { name: "x" },
      }).success,
    ).toBe(false);
    expectRoundTrip(ServerTaskCapabilitiesV1Codec, {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    });
    expect(
      ServerTaskCapabilitiesV1Codec.parse({
        requests: { tools: { call: true } },
      }).success,
    ).toBe(false);
  });

  it("follows every capability-first negotiation row and narrow guard", () => {
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
