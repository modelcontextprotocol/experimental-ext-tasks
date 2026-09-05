import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type JsonValue } from "../index.js";

import * as coreV2 from "./index.js";

import {
  CallToolResultV2Schema,
  CancelTaskRequestV2Schema,
  CancelTaskResultV2Schema,
  CreateTaskResultV2Schema,
  DetailedTaskV2Schema,
  ErrorV2Schema,
  GetTaskRequestV2Schema,
  GetTaskResultV2Schema,
  InputRequestsV2Schema,
  InputResponsesV2Schema,
  TaskStatusNotificationParamsV2Schema,
  TaskStatusNotificationV2Schema,
  TasksExtensionCapabilityV2Schema,
  TaskV2Schema,
  ToolV2Schema,
  UpdateTaskRequestV2Schema,
  UpdateTaskResultV2Schema,
  contributeTaskFilterV2,
  hasTaskClientCapabilityV2,
  hasTaskServerCapabilityV2,
  isToolCallTaskResultV2,
  readAcceptedTaskIdsV2,
  withTaskCapabilityV2,
  type CallToolResultV2,
  type TasksExtensionCapabilityV2,
  type TaskStatusV2,
} from "./index.js";

const statuses: readonly TaskStatusV2[] = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
];
const baseTask = fc.record({
  taskId: fc.string(),
  status: fc.constantFrom(...statuses),
  statusMessage: fc.option(fc.string(), { nil: undefined }),
  createdAt: fc.string(),
  lastUpdatedAt: fc.string(),
  ttlMs: fc.oneof(fc.integer(), fc.constant(null)),
  pollIntervalMs: fc.option(fc.integer(), { nil: undefined }),
});
const taskFor = (status: TaskStatusV2) =>
  baseTask.map((task) => ({ ...task, status }));
const asJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

describe("V2 runtime wire contracts", () => {
  it("accepts every valid base Task and rejects missing required fields, invalid integers, and statuses", () => {
    fc.assert(
      fc.property(baseTask, (task) => {
        expect(TaskV2Schema.safeParse(asJson(task)).success).toBe(true);
      }),
    );
    fc.assert(
      fc.property(
        baseTask,
        fc.constantFrom(
          "taskId",
          "status",
          "createdAt",
          "lastUpdatedAt",
          "ttlMs",
        ),
        (task, key) => {
          const invalid = { ...task };
          delete invalid[key];
          expect(TaskV2Schema.safeParse(asJson(invalid)).success).toBe(false);
        },
      ),
    );
    fc.assert(
      fc.property(
        baseTask,
        fc
          .string()
          .filter((status) => !statuses.includes(status as TaskStatusV2)),
        (task, status) => {
          expect(
            TaskV2Schema.safeParse(asJson({ ...task, status })).success,
          ).toBe(false);
        },
      ),
    );
    fc.assert(
      fc.property(
        baseTask,
        fc
          .double({ noNaN: true, noDefaultInfinity: true })
          .filter((n) => !Number.isInteger(n)),
        (task, ttlMs) => {
          expect(
            TaskV2Schema.safeParse(asJson({ ...task, ttlMs })).success,
          ).toBe(false);
        },
      ),
    );
  });

  it("keeps Task closed while preserving wrapper metadata", () => {
    const decoded = TaskV2Schema.safeParse({
      taskId: "task",
      status: "working",
      createdAt: "created",
      lastUpdatedAt: "updated",
      ttlMs: null,
      vendorHint: 1,
    });
    expect(decoded.success).toBe(true);
    if (decoded.success) expect("vendorHint" in decoded.data).toBe(false);

    const notification = TaskStatusNotificationParamsV2Schema.safeParse({
      taskId: "task",
      status: "working",
      createdAt: "created",
      lastUpdatedAt: "updated",
      ttlMs: null,
      _meta: { vendorHint: 1 },
    });
    expect(notification.success).toBe(true);
    if (notification.success)
      expect(notification.data._meta).toEqual({ vendorHint: 1 });
  });

  it("enforces status-owned DetailedTask payloads", () => {
    fc.assert(
      fc.property(taskFor("working"), (task) => {
        expect(DetailedTaskV2Schema.safeParse(asJson(task)).success).toBe(true);
      }),
    );
    fc.assert(
      fc.property(taskFor("cancelled"), (task) => {
        expect(DetailedTaskV2Schema.safeParse(asJson(task)).success).toBe(true);
      }),
    );
    fc.assert(
      fc.property(
        taskFor("input_required"),
        fc.dictionary(
          fc.string(),
          fc.constant({ method: "roots/list" as const }),
        ),
        (task, inputRequests) => {
          expect(
            DetailedTaskV2Schema.safeParse(asJson({ ...task, inputRequests }))
              .success,
          ).toBe(true);
        },
      ),
    );
    fc.assert(
      fc.property(
        taskFor("completed"),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (task, result) => {
          expect(
            DetailedTaskV2Schema.safeParse(asJson({ ...task, result })).success,
          ).toBe(true);
        },
      ),
    );
    fc.assert(
      fc.property(
        taskFor("failed"),
        fc.integer(),
        fc.string(),
        (task, code, message) => {
          expect(
            DetailedTaskV2Schema.safeParse(
              asJson({ ...task, error: { code, message } }),
            ).success,
          ).toBe(true);
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.constantFrom("input_required", "completed", "failed"),
        (status) => {
          expect(
            DetailedTaskV2Schema.safeParse({
              taskId: "id",
              status,
              createdAt: "a",
              lastUpdatedAt: "b",
              ttlMs: null,
            }).success,
          ).toBe(false);
        },
      ),
    );
  });

  it("strictly decodes input request and response maps", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string(),
          fc.oneof(
            fc.record({ method: fc.constant("roots/list" as const) }),
            fc.record({
              method: fc.constant("sampling/createMessage" as const),
              params: fc.dictionary(fc.string(), fc.jsonValue()),
            }),
            fc.record({
              method: fc.constant("elicitation/create" as const),
              params: fc.dictionary(fc.string(), fc.jsonValue()),
            }),
          ),
        ),
        (requests) => {
          expect(
            InputRequestsV2Schema.safeParse(asJson(requests)).success,
          ).toBe(true);
        },
      ),
    );
    expect(
      InputRequestsV2Schema.safeParse({
        key: { method: "unknown", params: {} },
      }).success,
    ).toBe(false);
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string(),
          fc.oneof(
            fc.record({
              action: fc.constantFrom(
                "accept" as const,
                "decline" as const,
                "cancel" as const,
              ),
            }),
            fc.record({ roots: fc.array(fc.jsonValue()) }),
            fc.record({
              content: fc.jsonValue(),
              model: fc.string(),
              role: fc.constantFrom("user" as const, "assistant" as const),
            }),
          ),
        ),
        (responses) => {
          expect(
            InputResponsesV2Schema.safeParse(asJson(responses)).success,
          ).toBe(true);
        },
      ),
    );
    expect(InputResponsesV2Schema.safeParse({ key: {} }).success).toBe(false);
  });

  it("decodes complete JSON-RPC errors", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.string(),
        fc.option(fc.jsonValue(), { nil: undefined }),
        (code, message, data) => {
          expect(
            ErrorV2Schema.safeParse(
              asJson({
                code,
                message,
                ...(data === undefined ? {} : { data }),
              }),
            ).success,
          ).toBe(true);
        },
      ),
    );
    expect(ErrorV2Schema.safeParse({ code: 1 }).success).toBe(false);
    expect(ErrorV2Schema.safeParse({ code: 1.5, message: "bad" }).success).toBe(
      false,
    );
  });

  it("round-trips open ToolV2 objects while validating every declared field", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (name, rootExtra, inputExtra, outputExtra) => {
          const tool = asJson({
            ...rootExtra,
            name,
            title: "Display name",
            description: "Description",
            inputSchema: {
              ...inputExtra,
              type: "object",
              $schema: "https://json-schema.org/draft/2020-12/schema",
            },
            outputSchema: {
              ...outputExtra,
              $schema: "https://json-schema.org/draft/2020-12/schema",
            },
            annotations: {
              title: "Annotated",
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
              extension: 1,
            },
            icons: [
              {
                src: "https://example.test/icon.png",
                mimeType: "image/png",
                sizes: ["16x16", "32x32"],
                theme: "dark",
                extension: true,
              },
            ],
            _meta: { trace: "test" },
          });
          const parsed = ToolV2Schema.safeParse(tool);
          expect(parsed.success).toBe(true);
          if (parsed.success) expect(parsed.data).toEqual(tool);
        },
      ),
    );
    expect(ToolV2Schema.safeParse({ name: "x", inputSchema: {} }).success).toBe(
      false,
    );
    expect(
      ToolV2Schema.safeParse({ name: "x", inputSchema: { type: "array" } })
        .success,
    ).toBe(false);
    for (const [field, invalid] of [
      ["outputSchema", true],
      ["annotations", true],
      ["icons", true],
      ["_meta", true],
    ] as const) {
      expect(
        ToolV2Schema.safeParse({
          name: "x",
          inputSchema: { type: "object" },
          [field]: invalid,
        }).success,
      ).toBe(false);
    }
    expect(
      ToolV2Schema.safeParse({
        name: "x",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: "yes" },
      }).success,
    ).toBe(false);
    expect(
      ToolV2Schema.safeParse({
        name: "x",
        inputSchema: { type: "object" },
        icons: [{}],
      }).success,
    ).toBe(false);
  });

  it("round-trips open CallToolResultV2 objects with required string result/content discriminators", () => {
    const content = [
      {
        type: "text",
        text: "hello",
        annotations: { audience: ["user"], priority: 0.5, lastModified: "now" },
        _meta: { a: 1 },
        extension: true,
      },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png", extension: 1 },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav", extension: 2 },
      {
        type: "resource_link",
        name: "docs",
        uri: "https://example.test",
        title: "Docs",
        description: "d",
        mimeType: "text/html",
        size: 1,
        icons: [{ src: "icon.png" }],
        extension: 3,
      },
      {
        type: "resource",
        resource: {
          uri: "file:///x",
          text: "body",
          blob: "Ym9keQ==",
          mimeType: "text/plain",
          _meta: { r: 1 },
          extension: 4,
        },
      },
    ];
    fc.assert(
      fc.property(
        fc.constant("complete" as const),
        fc.jsonValue(),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (resultType, structuredContent, extra) => {
          const result = asJson({
            ...extra,
            resultType,
            content,
            structuredContent,
            isError: false,
            _meta: { trace: "test" },
          });
          const parsed = CallToolResultV2Schema.safeParse(result);
          expect(parsed.success).toBe(true);
          if (parsed.success) expect(parsed.data).toEqual(result);
        },
      ),
    );
    expect(CallToolResultV2Schema.parse({ content: [] })).toEqual({
      resultType: "complete",
      content: [],
    });
    expect(
      CallToolResultV2Schema.safeParse({ resultType: "complete" }).success,
    ).toBe(false);
    expect(
      CallToolResultV2Schema.safeParse({ resultType: 1, content: [] }).success,
    ).toBe(false);
    expect(
      CallToolResultV2Schema.safeParse({ resultType: "task", content: [] })
        .success,
    ).toBe(false);
    expect(
      CallToolResultV2Schema.safeParse({
        resultType: "complete",
        content: [{ type: "text" }],
      }).success,
    ).toBe(false);
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
            CallToolResultV2Schema.safeParse({
              resultType: "complete",
              content: [{ type }],
            }).success,
          ).toBe(false);
        },
      ),
    );
    expect(
      CallToolResultV2Schema.safeParse({
        resultType: "complete",
        content: [],
        isError: "no",
      }).success,
    ).toBe(false);
  });

  it("binds strict get, update, and cancel request/result discriminators", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer()),
        fc.string(),
        (id, taskId) => {
          expect(
            GetTaskRequestV2Schema.safeParse({
              jsonrpc: "2.0",
              id,
              method: "tasks/get",
              params: { taskId },
            }).success,
          ).toBe(true);
          expect(
            CancelTaskRequestV2Schema.safeParse({
              jsonrpc: "2.0",
              id,
              method: "tasks/cancel",
              params: { taskId },
            }).success,
          ).toBe(true);
          expect(
            UpdateTaskRequestV2Schema.safeParse({
              jsonrpc: "2.0",
              id,
              method: "tasks/update",
              params: { taskId, inputResponses: {} },
            }).success,
          ).toBe(true);
        },
      ),
    );
    for (const schema of [
      GetTaskRequestV2Schema,
      UpdateTaskRequestV2Schema,
      CancelTaskRequestV2Schema,
    ]) {
      expect(
        schema.safeParse({ jsonrpc: "2.0", id: 1, method: "wrong", params: {} })
          .success,
      ).toBe(false);
    }
    expect(UpdateTaskResultV2Schema.parse({})).toEqual({
      resultType: "complete",
    });
    expect(CancelTaskResultV2Schema.parse({})).toEqual({
      resultType: "complete",
    });
    expect(
      UpdateTaskResultV2Schema.safeParse({ resultType: "task" }).success,
    ).toBe(false);
    fc.assert(
      fc.property(
        taskFor("completed"),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (task, result) => {
          const parsed = GetTaskResultV2Schema.parse(
            asJson({ ...task, result }),
          );
          expect(parsed.resultType).toBe("complete");
        },
      ),
    );
  });

  it("discriminates Task creation only for eligible tools/call results", () => {
    fc.assert(
      fc.property(baseTask, (task) => {
        const result = asJson({ ...task, resultType: "task" });
        expect(CreateTaskResultV2Schema.safeParse(result).success).toBe(true);
        expect(isToolCallTaskResultV2("tools/call", result)).toBe(true);
        expect(isToolCallTaskResultV2("prompts/get", result)).toBe(false);
      }),
    );
    expect(
      CreateTaskResultV2Schema.safeParse({ resultType: "complete" }).success,
    ).toBe(false);
  });

  it("decodes detailed task notifications with exact envelope discriminators", () => {
    fc.assert(
      fc.property(taskFor("working"), (task) => {
        expect(
          TaskStatusNotificationV2Schema.safeParse(
            asJson({
              jsonrpc: "2.0",
              method: "notifications/tasks",
              params: task,
            }),
          ).success,
        ).toBe(true);
      }),
    );
    expect(
      TaskStatusNotificationV2Schema.safeParse({
        jsonrpc: "2.0",
        method: "notifications/wrong",
        params: {},
      }).success,
    ).toBe(false);
  });

  it("preserves optional notification params _meta as a strict JSON record", () => {
    fc.assert(
      fc.property(
        taskFor("working"),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (task, meta) => {
          const params = asJson({ ...task, _meta: meta });
          const paramsResult =
            TaskStatusNotificationParamsV2Schema.safeParse(params);
          expect(paramsResult.success).toBe(true);
          if (paramsResult.success)
            expect(paramsResult.data._meta).toEqual(asJson(meta));

          const notificationResult = TaskStatusNotificationV2Schema.safeParse({
            jsonrpc: "2.0",
            method: "notifications/tasks",
            params,
          });
          expect(notificationResult.success).toBe(true);
          if (notificationResult.success)
            expect(notificationResult.data.params._meta).toEqual(asJson(meta));
        },
      ),
    );

    for (const meta of [null, [], "meta", 1, true] as const) {
      const params = {
        taskId: "task",
        status: "working",
        createdAt: "created",
        lastUpdatedAt: "updated",
        ttlMs: null,
        _meta: meta,
      };
      const paramsResult =
        TaskStatusNotificationParamsV2Schema.safeParse(params);
      expect(paramsResult.success).toBe(false);
      if (!paramsResult.success) {
        expect(paramsResult.error.issues[0]?.path).toEqual(["_meta"]);
      }

      const notificationResult = TaskStatusNotificationV2Schema.safeParse({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params,
      });
      expect(notificationResult.success).toBe(false);
      if (!notificationResult.success)
        expect(notificationResult.error.issues[0]?.path).toEqual([
          "params",
          "_meta",
        ]);
    }
  });

  it("accepts valid input responses despite colliding extension keys", () => {
    expect(
      InputResponsesV2Schema.safeParse({
        response: {
          action: "invalid",
          roots: [],
          content: {},
          model: "model",
          role: "assistant",
        },
      }).success,
    ).toBe(true);
    expect(
      InputResponsesV2Schema.safeParse({
        response: {
          roots: "invalid",
          content: {},
          model: "model",
          role: "assistant",
        },
      }).success,
    ).toBe(true);
    expect(
      InputResponsesV2Schema.safeParse({
        response: {
          action: "accept",
          roots: "ignored extension value",
          content: {},
          model: 1,
          role: "invalid",
        },
      }).success,
    ).toBe(true);
    expect(
      InputResponsesV2Schema.safeParse({
        response: { action: "invalid", roots: "invalid" },
      }).success,
    ).toBe(false);
  });

  it("preserves open result output and rejects wrong literals, fractions, and capability extras", () => {
    const openResult = {
      resultType: "complete",
      content: [],
      structuredContent: { answer: 42 },
      vendorOutput: { trace: true },
    };
    expect(CallToolResultV2Schema.parse(openResult)).toEqual(openResult);
    expect(UpdateTaskResultV2Schema.parse({ ...openResult })).toEqual(
      openResult,
    );
    expect(CancelTaskResultV2Schema.parse({ ...openResult })).toEqual(
      openResult,
    );
    expect(
      CreateTaskResultV2Schema.safeParse({
        taskId: "task",
        resultType: "complete",
        status: "working",
        createdAt: "created",
        lastUpdatedAt: "updated",
        ttlMs: null,
      }).success,
    ).toBe(false);
    expect(
      TaskV2Schema.safeParse({
        taskId: "task",
        status: "working",
        createdAt: "created",
        lastUpdatedAt: "updated",
        ttlMs: null,
        pollIntervalMs: 1.5,
      }).success,
    ).toBe(false);
    expect(
      TasksExtensionCapabilityV2Schema.safeParse({ extra: true }).success,
    ).toBe(false);
  });

  it("exports only the canonical V2 task result and capability names", () => {
    const capability: TasksExtensionCapabilityV2 = {};
    const result: CallToolResultV2 = { resultType: "complete", content: [] };

    expect(TasksExtensionCapabilityV2Schema.safeParse(capability)).toEqual({
      success: true,
      data: {},
    });
    expect(CallToolResultV2Schema.safeParse(result).success).toBe(true);
    expect(
      isToolCallTaskResultV2("tools/call", {
        taskId: "task",
        resultType: "task",
        status: "working",
        createdAt: "created",
        lastUpdatedAt: "updated",
        ttlMs: null,
      }),
    ).toBe(true);
    for (const removed of [
      "ToolCallResultV2Schema",
      "isEligibleTaskResultV2",
      "TaskExtensionCapabilitiesV2Schema",
      "supportsTasksExtensionV2",
      ...Object.keys(coreV2).filter((name) => name.endsWith("Codec")),
    ]) {
      expect(removed in coreV2).toBe(false);
    }
  });

  it("contributes task IDs without changing unrelated filters or prior notification fields", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.array(fc.string()),
        (filter, notifications, ids) => {
          const source = asJson({ ...filter, notifications }) as Readonly<
            Record<string, JsonValue>
          >;
          const result = contributeTaskFilterV2(source, ids);
          for (const [key, value] of Object.entries(source))
            if (key !== "notifications") expect(result[key]).toEqual(value);
          const normalizedNotifications = source.notifications as Readonly<
            Record<string, JsonValue>
          >;
          for (const [key, value] of Object.entries(normalizedNotifications))
            if (key !== "taskIds")
              expect(result.notifications[key]).toEqual(value);
          expect(result.notifications.taskIds).toEqual([...new Set(ids)]);
        },
      ),
    );
  });

  it("reads only fully valid acknowledged task IDs", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (ids) => {
        expect(
          readAcceptedTaskIdsV2({ notifications: { taskIds: ids } }),
        ).toEqual(ids);
      }),
    );
    fc.assert(
      fc.property(
        fc
          .array(fc.oneof(fc.string(), fc.integer()))
          .filter((ids) => ids.some((id) => typeof id !== "string")),
        (ids) => {
          expect(
            readAcceptedTaskIdsV2({ notifications: { taskIds: ids } }),
          ).toEqual([]);
        },
      ),
    );
  });

  it("uses exact client and server capability envelopes", () => {
    const wire = withTaskCapabilityV2({ _meta: { trace: "x" } });
    expect(wire).toEqual({
      _meta: {
        trace: "x",
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
      },
    });
    expect(hasTaskClientCapabilityV2(wire)).toBe(true);
    expect(
      hasTaskServerCapabilityV2({
        extensions: { "io.modelcontextprotocol/tasks": {} },
      }),
    ).toBe(true);
    expect(hasTaskServerCapabilityV2({ extensions: {} })).toBe(false);
  });
});
