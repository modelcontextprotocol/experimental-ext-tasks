import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type TaskId } from "../core/index.js";
import {
  DispatchError,
  InputCorrelationError,
  withTasks,
  type JsonRpcResponse,
  type SessionTaskCapabilities,
  type SerializedTaskReference,
} from "./index.js";
import {
  FakePort,
  asJson,
  formatJson,
  asError,
  expectRecord,
} from "../../test-support/client/fake-port.js";

describe("task reference resumption", () => {
  it("does not expose reference serialization on immediate executions", async () => {
    const port = new FakePort();
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("immediate");
    expect(execution.kind).toBe("immediate");
    expect("serializeReference" in execution).toBe(false);
    await session.close();
  });

  it("rejects endpoint, generation, and operation mismatches before dispatch", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("endpoint", "generation", "operation"),
        fc.string({ minLength: 1 }),
        async (mismatch, suffix) => {
          const port = new FakePort(
            { generation: "v2", capabilities: {} },
            "endpoint-a",
          );
          const session = withTasks(port, {
            tools: { currentTool: () => undefined },
          });
          const reference = {
            endpointId:
              mismatch === "endpoint" ? `other-${suffix}` : "endpoint-a",
            generation: mismatch === "generation" ? "v1" : "v2",
            taskId: `task-${suffix}`,
            originalOperation:
              mismatch === "operation" ? "unsupported/operation" : "tools/call",
          } as SerializedTaskReference;
          await expect(session.resumeTask(reference)).rejects.toThrow();
          expect(port.requests).toHaveLength(0);
          await session.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it("labels resumed V1 candidates without inventing a tool name", async () => {
    const port = new FakePort(
      {
        generation: "v1",
        capabilities: { requests: { tools: { call: {} } }, cancel: {} },
      },
      "resume-endpoint",
    );
    let finishOrdinary: ((response: JsonRpcResponse) => void) | undefined;
    let getCalls = 0;
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tasks/get") {
        getCalls += 1;
        if (getCalls === 1)
          return {
            kind: "result",
            result: asJson({
              taskId: "resumed-task",
              status: "working",
              createdAt: "a",
              lastUpdatedAt: "a",
              ttl: null,
            }),
          };
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          ),
        );
      }
      if (record.method === "tools/call")
        return new Promise((resolve) => {
          finishOrdinary = resolve;
        });
      if (record.method === "tasks/cancel")
        return {
          kind: "result",
          result: asJson({
            taskId: "resumed-task",
            status: "cancelled",
            createdAt: "a",
            lastUpdatedAt: "b",
            ttl: null,
          }),
        };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const errors: Error[] = [];
    const session = withTasks(port, {
      tools: {
        currentTool: (name) =>
          name === "ordinary"
            ? { name, inputSchema: { type: "object" } }
            : undefined,
      },
      onError: (error) => errors.push(error),
    });
    const resumed = await session.resumeTask({
      endpointId: port.endpointId,
      generation: "v1",
      taskId: "resumed-task" as TaskId,
      originalOperation: "tools/call",
    });
    const ordinary = session.callTool("ordinary");
    while (finishOrdinary === undefined) await Promise.resolve();
    await port.serve({ method: "elicitation/create", params: {} });
    expect(errors).toHaveLength(1);
    const candidates = (errors[0] as InputCorrelationError).candidates;
    expect(candidates.map((candidate) => candidate.toolName)).toEqual([
      "ordinary",
      "<resumed>",
    ]);
    expect(candidates.every((candidate) => !("taskId" in candidate))).toBe(
      true,
    );
    finishOrdinary({ kind: "result", result: { content: [] } });
    await ordinary;
    await resumed.close();
    await session.close();
  });

  it("roundtrips serialized task references across V1/V2 terminal and nonterminal tasks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("v1", "v2"),
        fc.boolean(),
        fc.stringMatching(/^[a-z0-9]{1,12}$/),
        async (generation, initiallyTerminal, taskSuffix) => {
          const taskId = `task-${taskSuffix}`;
          const endpointId = `endpoint-${taskSuffix}`;
          const capabilities: SessionTaskCapabilities =
            generation === "v1"
              ? {
                  generation: "v1",
                  capabilities: {
                    requests: { tools: { call: {} } },
                    cancel: {},
                  },
                }
              : { generation: "v2", capabilities: {} };
          const sourcePort = new FakePort(capabilities, endpointId);
          sourcePort.dispatchHandler = async (request) => {
            await Promise.resolve();
            const method = expectRecord(request).method;
            if (method === "tools/call")
              return generation === "v1"
                ? {
                    kind: "result",
                    result: asJson({
                      task: {
                        taskId,
                        status: "working",
                        createdAt: "a",
                        lastUpdatedAt: "a",
                        ttl: null,
                        pollInterval: 1000,
                      },
                    }),
                  }
                : {
                    kind: "result",
                    result: asJson({
                      resultType: "task",
                      taskId,
                      status: "working",
                      createdAt: "a",
                      lastUpdatedAt: "a",
                      ttlMs: null,
                      pollIntervalMs: 1000,
                    }),
                  };
            if (method === "tasks/cancel")
              return {
                kind: "result",
                result: asJson(
                  generation === "v2" ? { resultType: "complete" } : {},
                ),
              };
            throw new Error(`unexpected source method ${formatJson(method)}`);
          };
          const sourceSession = withTasks(sourcePort, {
            tools: {
              currentTool: () =>
                generation === "v1"
                  ? {
                      name: "roundtrip",
                      inputSchema: {},
                      execution: { taskSupport: "required" },
                    }
                  : { name: "roundtrip", inputSchema: {} },
            },
          });
          const sourceExecution = await sourceSession.callTool("roundtrip");
          expect(sourceExecution.kind).toBe("task");
          if (sourceExecution.kind !== "task") throw new Error("expected task");
          const reference = sourceExecution.serializeReference();
          expect(reference).toEqual({
            endpointId,
            generation,
            taskId,
            originalOperation: "tools/call",
          });

          const resumedPort = new FakePort(capabilities, endpointId);
          let getCalls = 0;
          resumedPort.dispatchHandler = async (request) => {
            await Promise.resolve();
            const method = expectRecord(request).method;
            if (method === "tasks/get") {
              getCalls += 1;
              const terminal = initiallyTerminal || getCalls > 1;
              return generation === "v1"
                ? {
                    kind: "result",
                    result: asJson({
                      taskId,
                      status: terminal ? "completed" : "working",
                      createdAt: "a",
                      lastUpdatedAt: terminal ? "b" : "a",
                      ttl: null,
                      pollInterval: 0,
                    }),
                  }
                : {
                    kind: "result",
                    result: asJson({
                      resultType: "complete",
                      taskId,
                      status: terminal ? "completed" : "working",
                      createdAt: "a",
                      lastUpdatedAt: terminal ? "b" : "a",
                      ttlMs: null,
                      pollIntervalMs: 0,
                      ...(terminal
                        ? { result: { resultType: "complete", content: [] } }
                        : {}),
                    }),
                  };
            }
            if (method === "tasks/result")
              return {
                kind: "result",
                result: asJson({
                  content: [{ type: "text", text: taskSuffix }],
                }),
              };
            if (method === "tasks/cancel")
              return {
                kind: "result",
                result: asJson(
                  generation === "v2" ? { resultType: "complete" } : {},
                ),
              };
            throw new Error(`unexpected resumed method ${formatJson(method)}`);
          };
          const applicationContext = { taskSuffix };
          const resumedSession = withTasks<typeof applicationContext>(
            resumedPort,
            {
              tools: { currentTool: () => undefined },
            },
          );
          const resumed = await resumedSession.resumeTask(reference, {
            applicationContext,
          });
          expect(resumed.kind).toBe("task");
          if (resumed.kind !== "task") throw new Error("expected resumed task");
          expect(resumed.applicationContext).toBe(applicationContext);
          expect(resumed.serializeReference()).toEqual(reference);
          await expect(resumed.result()).resolves.toEqual(
            generation === "v1"
              ? { content: [{ type: "text", text: taskSuffix }] }
              : { resultType: "complete", content: [] },
          );
          expect(getCalls).toBe(initiallyTerminal ? 1 : 2);
          const firstRequest = expectRecord(resumedPort.requests[0]);
          expect(firstRequest.method).toBe("tasks/get");
          if (generation === "v2")
            expect(firstRequest.params).toMatchObject({
              _meta: {
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { "io.modelcontextprotocol/tasks": {} },
                },
              },
            });
          expect(
            resumedPort.requests.some(
              (request) => expectRecord(request).method === "tasks/result",
            ),
          ).toBe(generation === "v1");
          await resumedSession.close();
          await sourceSession.close();
        },
      ),
      { numRuns: 12 },
    );
  });

  it("retries the initial resumed observation once for any DispatchError", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (retryable) => {
        const port = new FakePort({ generation: "v2", capabilities: {} });
        let calls = 0;
        port.dispatchHandler = async () => {
          await Promise.resolve();
          calls += 1;
          if (calls === 1)
            throw new DispatchError("initial get failed", retryable);
          return {
            kind: "result",
            result: asJson({
              resultType: "complete",
              taskId: "retry-resume",
              status: "completed",
              createdAt: "a",
              lastUpdatedAt: "b",
              ttlMs: null,
              result: { resultType: "complete", content: [] },
            }),
          };
        };
        const session = withTasks(port, {
          tools: { currentTool: () => undefined },
        });
        const execution = await session.resumeTask({
          endpointId: port.endpointId,
          generation: "v2",
          taskId: "retry-resume" as TaskId,
          originalOperation: "tools/call",
        });
        await expect(execution.result()).resolves.toMatchObject({
          content: [],
        });
        expect(calls).toBe(2);
        await session.close();
      }),
      { numRuns: 10 },
    );
  });
});
