/** Protocol matrix proving generation-neutral primary client semantics across V1 and V2. */

import { describe, expect, it } from "vitest";
import type { JsonValue } from "../core/index.js";
import { toolDeclaration, withTasks } from "./index.js";
import type { TaskExecutionEvent } from "./index.js";
import { FakePort, expectRecord } from "../../test-support/client/fake-port.js";

const declaration = toolDeclaration({
  name: "matrix",
  inputSchema: { type: "object" },
  taskSupport: "required",
  extensions: { extensionFlag: true },
});

interface MatrixCase {
  readonly generation: "v1" | "v2";
  readonly capabilities: ConstructorParameters<typeof FakePort>[0];
  readonly created: JsonValue;
  readonly terminal: JsonValue;
}

const cases: readonly MatrixCase[] = [
  {
    generation: "v1",
    capabilities: {
      generation: "v1",
      capabilities: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
    },
    created: {
      task: {
        taskId: "matrix-v1",
        status: "working",
        statusMessage: "started",
        createdAt: "a",
        lastUpdatedAt: "a",
        ttl: 4000,
        pollInterval: 1,
      },
    },
    terminal: {
      taskId: "matrix-v1",
      status: "completed",
      createdAt: "a",
      lastUpdatedAt: "b",
      ttl: 4000,
      pollInterval: 1,
    },
  },
  {
    generation: "v2",
    capabilities: { generation: "v2", capabilities: {} },
    created: {
      resultType: "task",
      taskId: "matrix-v2",
      status: "working",
      statusMessage: "started",
      createdAt: "a",
      lastUpdatedAt: "a",
      ttlMs: 4000,
      pollIntervalMs: 1,
    },
    terminal: {
      resultType: "complete",
      taskId: "matrix-v2",
      status: "completed",
      createdAt: "a",
      lastUpdatedAt: "b",
      ttlMs: 4000,
      pollIntervalMs: 1,
      result: { content: [{ type: "text", text: "done" }] },
    },
  },
];

describe.each(cases)("neutral $generation protocol matrix", (matrix) => {
  it("normalizes state, one terminal outcome event, projection, retention, and capabilities", async () => {
    const port = new FakePort(matrix.capabilities);
    port.dispatchHandler = (request) => {
      const method = expectRecord(request).method;
      if (method === "tools/call")
        return Promise.resolve({
          kind: "result" as const,
          result: matrix.created,
        });
      if (method === "tasks/get")
        return Promise.resolve({
          kind: "result" as const,
          result: matrix.terminal,
        });
      if (method === "tasks/result") {
        return Promise.resolve({
          kind: "result" as const,
          result: { content: [{ type: "text", text: "done" }] },
        });
      }
      return Promise.reject(new Error(`Unexpected method ${String(method)}`));
    };
    const session = withTasks(port, {
      tools: { currentTool: () => declaration },
    });
    const execution = await session.callTool("matrix", undefined, {
      task: { preference: "require", retentionMs: 4000 },
    });
    expect(execution.declaration).toBe(declaration);
    expect(execution.handle).toEqual({
      taskId: `matrix-${matrix.generation}`,
      operation: "tools/call",
    });
    expect(session).not.toHaveProperty("taskGeneration");
    expect(session.capabilities).toEqual(
      matrix.generation === "v1"
        ? {
            inventory: "server-list",
            execution: true,
            cancellation: true,
            inputResponses: false,
            requestedRetention: true,
          }
        : {
            inventory: "known-handles",
            execution: true,
            cancellation: true,
            inputResponses: true,
            requestedRetention: false,
          },
    );
    if (matrix.generation === "v1") {
      expect(port.requests[0]).toMatchObject({
        params: { task: { ttl: 4000 } },
      });
    } else {
      const request = expectRecord(port.requests[0]);
      const params = expectRecord(request.params);
      expect(params._meta).toBeDefined();
    }

    const events: TaskExecutionEvent<unknown>[] = [];
    for await (const event of execution.updates()) events.push(event);
    const taskEvents = events.filter((event) => event.type === "task");
    const outcomeEvents = events.filter((event) => event.type === "outcome");
    expect(taskEvents.map((event) => event.task.status)).toEqual([
      "working",
      "completed",
    ]);
    expect(taskEvents[0]).toMatchObject({
      task: {
        statusMessage: "started",
        createdAt: "a",
        lastUpdatedAt: "a",
        retentionMs: 4000,
        suggestedPollIntervalMs: 1,
      },
    });
    expect(taskEvents[0]?.task).not.toHaveProperty("generation");
    const createdRecord = expectRecord(matrix.created);
    const wireTask =
      matrix.generation === "v1"
        ? expectRecord(createdRecord.task)
        : createdRecord;
    expect(taskEvents[0]?.task.raw).not.toBe(wireTask);
    expect(taskEvents[0]?.task.raw).toEqual(wireTask);
    expect(outcomeEvents).toHaveLength(1);
    expect(outcomeEvents[0]).toMatchObject({
      outcome: {
        status: "completed",
        result: { content: [{ type: "text", text: "done" }] },
      },
    });
    expect(await execution.result()).toEqual(outcomeEvents[0]?.outcome);
    const settlementPromise = execution.settle({ close: false });
    expect(execution.settle({ close: true })).toBe(settlementPromise);
    const settlement = await settlementPromise;
    expect(settlement.outcome).toEqual(outcomeEvents[0]?.outcome);
    expect(settlement.lastTask).toMatchObject({ status: "completed" });
    expect(execution.declaration?.taskSupport).toBe("required");

    await execution.detach();
    await session.close();
  });
});
