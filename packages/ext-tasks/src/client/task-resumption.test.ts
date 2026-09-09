import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TaskId } from "../core/index.js";
import {
  DispatchError,
  TaskRecoveryOwnershipError,
  toolDeclaration,
  withTasks,
} from "./index.js";
import type {
  JsonRpcResponse,
  SessionTaskCapabilities,
  SerializedTaskReference,
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

  it("does not misroute evidence-free initiating input to a resumed task", async () => {
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
    const contexts: unknown[] = [];
    const session = withTasks(port, {
      tools: {
        currentTool: (name) =>
          name === "ordinary"
            ? toolDeclaration({
                name,
                inputSchema: { type: "object" },
              })
            : undefined,
      },
      onInputRequest: async (_request, context) => {
        await Promise.resolve();
        contexts.push(context);
        return { action: "accept" } as never;
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
    await expect(
      port.serve({ method: "elicitation/create", params: {} }),
    ).resolves.toEqual({ kind: "result", result: { action: "accept" } });
    expect(errors).toEqual([]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      scope: "request",
      delivery: "peer-request",
      applicationContext: undefined,
    });
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
                  ? toolDeclaration({
                      name: "roundtrip",
                      inputSchema: { type: "object" },
                      execution: { taskSupport: "required" },
                    })
                  : toolDeclaration({
                      name: "roundtrip",
                      inputSchema: { type: "object" },
                    }),
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
          await expect(legacyResult(resumed)).resolves.toEqual(
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

  it("retries the initial resumed observation only for retryable DispatchError", async () => {
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
        const resume = session.resumeTask({
          endpointId: port.endpointId,
          generation: "v2",
          taskId: "retry-resume" as TaskId,
          originalOperation: "tools/call",
        });
        if (retryable) {
          const execution = await resume;
          await expect(legacyResult(execution)).resolves.toMatchObject({
            content: [],
          });
        } else await expect(resume).rejects.toBeInstanceOf(DispatchError);
        expect(calls).toBe(retryable ? 2 : 1);
        await session.close();
      }),
      { numRuns: 10 },
    );
  });

  it("gives one concurrent V2 resume ownership of input handling and updates", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let releaseGet: ((response: JsonRpcResponse) => void) | undefined;
    let getCalls = 0;
    let handlerCalls = 0;
    port.dispatchHandler = async (request) => {
      const method = expectRecord(request).method;
      if (method === "tasks/get") {
        getCalls += 1;
        if (getCalls === 1)
          return new Promise((resolve) => {
            releaseGet = resolve;
          });
        return {
          kind: "result",
          result: asJson({
            resultType: "complete",
            taskId: "owned-resume",
            status: "completed",
            createdAt: "a",
            lastUpdatedAt: "c",
            ttlMs: null,
            result: { content: [] },
          }),
        };
      }
      if (method === "tasks/update")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(method)}`);
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
      onInputRequest: async () => {
        await Promise.resolve();
        handlerCalls += 1;
        return { roots: [] } as never;
      },
    });
    const reference = {
      endpointId: port.endpointId,
      generation: "v2",
      taskId: "owned-resume" as TaskId,
      originalOperation: "tools/call",
    } as const;
    const first = session.resumeTask(reference);
    await Promise.resolve();
    await expect(session.resumeTask(reference)).rejects.toBeInstanceOf(
      TaskRecoveryOwnershipError,
    );
    expect(getCalls).toBe(1);
    releaseGet?.({
      kind: "result",
      result: asJson({
        resultType: "complete",
        taskId: "owned-resume",
        status: "input_required",
        createdAt: "a",
        lastUpdatedAt: "b",
        ttlMs: null,
        inputRequests: { only: { method: "roots/list" } },
      }),
    });
    const execution = await first;
    await expect(legacyResult(execution)).resolves.toMatchObject({
      content: [],
    });
    expect(handlerCalls).toBe(1);
    expect(
      port.requests.filter(
        (request) => expectRecord(request).method === "tasks/update",
      ),
    ).toHaveLength(1);
    await session.close();
  });

  it("fails closed when an active task identity uses another original operation", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async () =>
      new Promise<JsonRpcResponse>(() => {
        // Keep the first recovery active while collision identity is checked.
      });
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const reference = {
      endpointId: port.endpointId,
      generation: "v2",
      taskId: "operation-collision" as TaskId,
      originalOperation: "tools/call",
    } as const;
    void session.resumeTask(reference).catch(() => {});
    await Promise.resolve();
    const collision = {
      ...reference,
      originalOperation: "resources/read",
    } as never;
    await expect(session.resumeTask(collision)).rejects.toMatchObject({
      name: "TaskRecoveryOwnershipError",
      activeOriginalOperation: "tools/call",
      originalOperation: "resources/read",
    });
    expect(port.requests).toHaveLength(1);
    await session.close();
  });

  it("releases a failed resume reservation", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let calls = 0;
    port.dispatchHandler = async () => {
      await Promise.resolve();
      calls += 1;
      if (calls === 1) throw new Error("resume failed");
      return {
        kind: "result",
        result: asJson({
          resultType: "complete",
          taskId: "failed-resume",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttlMs: null,
          result: { content: [] },
        }),
      };
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const reference = {
      endpointId: port.endpointId,
      generation: "v2",
      taskId: "failed-resume" as TaskId,
      originalOperation: "tools/call",
    } as const;
    await expect(session.resumeTask(reference)).rejects.toThrow(
      "resume failed",
    );
    const execution = await session.resumeTask(reference);
    await expect(legacyResult(execution)).resolves.toMatchObject({
      content: [],
    });
    expect(calls).toBe(2);
    await session.close();
  });

  it("allows a new resume after the prior owner settles terminally", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async () => {
      await Promise.resolve();
      return {
        kind: "result",
        result: asJson({
          resultType: "complete",
          taskId: "terminal-resume",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttlMs: null,
          result: { content: [] },
        }),
      };
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const reference = {
      endpointId: port.endpointId,
      generation: "v2",
      taskId: "terminal-resume" as TaskId,
      originalOperation: "tools/call",
    } as const;
    const first = await session.resumeTask(reference);
    await legacyResult(first);
    await Promise.resolve();
    const second = await session.resumeTask(reference);
    await expect(legacyResult(second)).resolves.toMatchObject({ content: [] });
    expect(port.requests).toHaveLength(2);
    await session.close();
  });
});
import { legacyResult } from "../../test-support/client/semantic.js";
