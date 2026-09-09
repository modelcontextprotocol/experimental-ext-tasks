import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DispatchError,
  JsonRpcResponseError,
  TaskExecutionClosedError,
  TaskFailedError,
  TaskUpdatesAlreadyAcquiredError,
  toolDeclaration,
  withTasks,
} from "./index.js";
import { deterministicJson } from "./execution.js";
import {
  FakePort,
  asJson,
  formatJson,
  asError,
  expectRecord,
} from "../../test-support/client/fake-port.js";

describe("task lifecycle and races", () => {
  it("canonicalizes undefined values deterministically", () => {
    expect(deterministicJson(undefined)).toBe("[undefined]");
    expect(deterministicJson({ keep: 1, omit: undefined })).toBe('{"keep":1}');
  });
  it("shares cancellation and enforces single-consumer task updates", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let cancelCalls = 0;
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "pending",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (record.method === "tasks/get")
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          );
        });
      if (record.method === "tasks/cancel") {
        cancelCalls += 1;
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    execution.updates();
    expect(() => execution.updates()).toThrow(TaskUpdatesAlreadyAcquiredError);
    const firstCancel = execution.cancel();
    expect(execution.cancel()).toBe(firstCancel);
    await firstCancel;
    expect(cancelCalls).toBe(1);
    expect(
      port.requests.find(
        (request) => expectRecord(request).method === "tasks/cancel",
      ),
    ).toMatchObject({
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      },
    });
    await execution.close();
    await expect(legacyResult(execution)).rejects.toBeInstanceOf(
      TaskExecutionClosedError,
    );
    await session.close();
  });

  it("does not emit an unhandled rejection when cancellation is followed by close", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "cancel-close-consumers",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (record.method === "tasks/get")
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          );
        });
      if (record.method === "tasks/cancel")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const result = execution.result();
    const updates = legacyUpdates(execution)[Symbol.asyncIterator]();
    await expect(updates.next()).resolves.toMatchObject({
      value: { task: { status: "working" } },
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await execution.cancel();
      await execution.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      const outcome = await result;
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed")
        throw new Error("Expected failed outcome");
      expect(outcome.error).toBeInstanceOf(TaskFailedError);
      expect(outcome.error.cause).toBeInstanceOf(TaskExecutionClosedError);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    await session.close();
  });

  it("session close cancels and closes active task executions", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let cancelCalls = 0;
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "session-close",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (record.method === "tasks/get")
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          );
        });
      if (record.method === "tasks/cancel") {
        cancelCalls += 1;
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    await session.close();
    expect(cancelCalls).toBe(1);
    await expect(legacyResult(execution)).rejects.toBeInstanceOf(
      TaskExecutionClosedError,
    );
  });

  it("retries task observations only for retryable DispatchError", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (retryable) => {
        const port = new FakePort({ generation: "v2", capabilities: {} });
        let getCalls = 0;
        port.dispatchHandler = async (request) => {
          await Promise.resolve();
          const record = expectRecord(request);
          if (record.method === "tools/call")
            return {
              kind: "result",
              result: asJson({
                resultType: "task",
                taskId: "retry-get",
                status: "working",
                createdAt: "a",
                lastUpdatedAt: "a",
                ttlMs: null,
              }),
            };
          if (record.method === "tasks/get") {
            getCalls += 1;
            if (getCalls === 1)
              throw new DispatchError("observe failed", retryable);
            return {
              kind: "result",
              result: asJson({
                resultType: "complete",
                taskId: "retry-get",
                status: "completed",
                createdAt: "a",
                lastUpdatedAt: "b",
                ttlMs: null,
                result: { resultType: "complete", content: [] },
              }),
            };
          }
          throw new Error(`unexpected method ${formatJson(record.method)}`);
        };
        const session = withTasks(port, {
          tools: {
            currentTool: () =>
              toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
          },
        });
        const execution = await session.callTool("x");
        if (retryable)
          await expect(legacyResult(execution)).resolves.toEqual({
            resultType: "complete",
            content: [],
          });
        else
          await expect(legacyResult(execution)).rejects.toBeInstanceOf(
            DispatchError,
          );
        expect(getCalls).toBe(retryable ? 2 : 1);
        await session.close();
      }),
      { numRuns: 10 },
    );
  });

  it("retries cancellation only for proven retryable dispatch failures", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (retryable) => {
        const port = new FakePort({ generation: "v2", capabilities: {} });
        let cancelCalls = 0;
        port.dispatchHandler = async (request, options) => {
          const record = expectRecord(request);
          if (record.method === "tools/call")
            return {
              kind: "result",
              result: asJson({
                resultType: "task",
                taskId: "retry-cancel",
                status: "working",
                createdAt: "a",
                lastUpdatedAt: "a",
                ttlMs: null,
              }),
            };
          if (record.method === "tasks/get")
            return new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                "abort",
                () => {
                  reject(asError(options.signal?.reason));
                },
                { once: true },
              );
            });
          if (record.method === "tasks/cancel") {
            cancelCalls += 1;
            if (cancelCalls === 1)
              throw new DispatchError("cancel failed", retryable);
            return { kind: "result", result: { resultType: "complete" } };
          }
          throw new Error(`unexpected method ${formatJson(record.method)}`);
        };
        const session = withTasks(port, {
          tools: {
            currentTool: () =>
              toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
          },
        });
        const execution = await session.callTool("x");
        if (retryable)
          await expect(execution.cancel()).resolves.toBeUndefined();
        else await expect(execution.cancel()).rejects.toThrow("cancel failed");
        expect(cancelCalls).toBe(retryable ? 2 : 1);
        await execution.close();
        await expect(legacyResult(execution)).rejects.toBeInstanceOf(
          TaskExecutionClosedError,
        );
        await session.close();
      }),
    );
  });

  it("conflates nonterminal task updates and always delivers terminal", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async (request) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "conflate",
            status: "working",
            statusMessage: "initial",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
            pollIntervalMs: 1000,
          }),
        };
      if (record.method === "tasks/get") return new Promise(() => {});
      if (record.method === "tasks/cancel")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const iterator = legacyUpdates(execution)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { task: { statusMessage: "initial" } },
    });
    for (const statusMessage of ["one", "one", "two", "three"]) {
      port.notify(
        asJson({
          jsonrpc: "2.0",
          method: "notifications/tasks",
          params: {
            resultType: "complete",
            taskId: "conflate",
            status: "working",
            statusMessage,
            createdAt: "a",
            lastUpdatedAt: statusMessage,
            ttlMs: null,
            pollIntervalMs: 1000,
          },
        }),
      );
    }
    await Promise.resolve();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { task: { statusMessage: "three" } },
    });
    port.notify(
      asJson({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params: {
          resultType: "complete",
          taskId: "conflate",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "z",
          ttlMs: null,
          result: { resultType: "complete", content: [] },
        },
      }),
    );
    port.notify(
      asJson({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params: {
          resultType: "complete",
          taskId: "conflate",
          status: "working",
          statusMessage: "late",
          createdAt: "a",
          lastUpdatedAt: "late",
          ttlMs: null,
          pollIntervalMs: 1000,
        },
      }),
    );
    await expect(iterator.next()).resolves.toMatchObject({
      value: { task: { status: "completed" } },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await session.close();
  });

  it("uses the same first terminal snapshot for updates and result", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async (request) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "first-terminal",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
            pollIntervalMs: 1000,
          }),
        };
      if (record.method === "tasks/get") return new Promise(() => {});
      if (record.method === "tasks/cancel")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const iterator = legacyUpdates(execution)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { task: { status: "working" } },
    });

    port.notify(
      asJson({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params: {
          resultType: "complete",
          taskId: "first-terminal",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttlMs: null,
          result: {
            resultType: "complete",
            content: [{ type: "text", text: "first" }],
          },
        },
      }),
    );
    port.notify(
      asJson({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params: {
          resultType: "complete",
          taskId: "first-terminal",
          status: "failed",
          createdAt: "a",
          lastUpdatedAt: "c",
          ttlMs: null,
          error: { code: -32000, message: "late terminal" },
        },
      }),
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: { task: { status: "completed", lastUpdatedAt: "b" } },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(legacyResult(execution)).resolves.toEqual({
      resultType: "complete",
      content: [{ type: "text", text: "first" }],
    });
    await session.close();
  });

  it("does not retry complete JSON-RPC task errors", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let getCalls = 0;
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "rpc-error",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (record.method === "tasks/get") {
        getCalls += 1;
        return { kind: "error", error: { code: -32000, message: "failed" } };
      }
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    await expect(legacyResult(execution)).rejects.toBeInstanceOf(
      JsonRpcResponseError,
    );
    expect(getCalls).toBe(1);
    await session.close();
  });

  it("routes matching task notifications without cancelling the task", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let cancelCalls = 0;
    let getCalls = 0;
    port.dispatchHandler = async (request) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "notify",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
            pollIntervalMs: 1000,
          }),
        };
      if (record.method === "tasks/get") {
        getCalls += 1;
        return new Promise(() => {});
      }
      if (record.method === "tasks/cancel") {
        cancelCalls += 1;
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const observer = new AbortController();
    const iterator = execution.updates(observer.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "task",
        task: { taskId: "notify", status: "working" },
      },
    });
    const waiting = iterator.next();
    observer.abort(new Error("observer done"));
    await expect(waiting).rejects.toThrow("observer done");
    expect(cancelCalls).toBe(0);
    port.notify(
      asJson({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params: {
          resultType: "complete",
          taskId: "wrong",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttlMs: null,
          result: { resultType: "complete", content: [] },
        },
      }),
    );
    await Promise.resolve();
    port.notify(
      asJson({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params: {
          resultType: "complete",
          taskId: "notify",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttlMs: null,
          result: { resultType: "complete", content: [] },
        },
      }),
    );
    await expect(legacyResult(execution)).resolves.toEqual({
      resultType: "complete",
      content: [],
    });
    expect(cancelCalls).toBe(0);
    expect(getCalls).toBe(0);
    await session.close();
  });

  it("closes promptly when remote cancellation never settles", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "stuck-cancel",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (record.method === "tasks/get")
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          );
        });
      if (record.method === "tasks/cancel") return new Promise(() => {});
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    await expect(execution.close()).resolves.toBeUndefined();
    await expect(legacyResult(execution)).rejects.toBeInstanceOf(
      TaskExecutionClosedError,
    );
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("invalidating a session aborts active task executions", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "invalidate-active",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (record.method === "tasks/get")
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          );
        });
      if (record.method === "tasks/cancel")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    port.invalidate(new Error("session replaced"));
    await expect(legacyResult(execution)).rejects.toThrow("session replaced");
    await session.close();
  });

  it("a terminal notification preempts an in-flight observation", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let observationSignal: AbortSignal | undefined;
    let markGetStarted = (): void => {};
    const getStarted = new Promise<void>((resolve) => {
      markGetStarted = resolve;
    });
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "preempt",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
            pollIntervalMs: 10,
          }),
        };
      if (record.method === "tasks/get") {
        const signal = options?.signal;
        if (signal === undefined)
          throw new Error("observation signal is required");
        observationSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(asError(signal.reason));
            },
            {
              once: true,
            },
          );
          markGetStarted();
        });
      }
      if (record.method === "tasks/cancel")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    await getStarted;
    port.notify(
      asJson({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params: {
          resultType: "complete",
          taskId: "preempt",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttlMs: null,
          result: { resultType: "complete", content: [] },
        },
      }),
    );
    await expect(legacyResult(execution)).resolves.toEqual({
      resultType: "complete",
      content: [],
    });
    expect(observationSignal?.aborted).toBe(true);
    await session.close();
  });

  it("captures a terminal notification emitted during observation startup", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let observationSignal: AbortSignal | undefined;
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call") {
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "synchronous-notification",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
            pollIntervalMs: 10,
          }),
        };
      }
      if (record.method === "tasks/get") {
        const signal = options?.signal;
        if (signal === undefined)
          throw new Error("observation signal is required");
        observationSignal = signal;
        port.notify(
          asJson({
            jsonrpc: "2.0",
            method: "notifications/tasks",
            params: {
              taskId: "synchronous-notification",
              status: "completed",
              createdAt: "a",
              lastUpdatedAt: "b",
              ttlMs: null,
              result: { content: [] },
            },
          }),
        );
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(asError(signal.reason));
            },
            { once: true },
          );
        });
      }
      if (record.method === "tasks/cancel") {
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    await expect(legacyResult(execution)).resolves.toEqual({
      resultType: "complete",
      content: [],
    });
    expect(observationSignal?.aborted).toBe(true);
    await session.close();
  });

  it("caller abort does not poison the shared cancellation attempt", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let cancelCalls = 0;
    let finishCancel: (() => void) | undefined;
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "cancel-waiter",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (record.method === "tasks/get")
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          ),
        );
      if (record.method === "tasks/cancel") {
        cancelCalls += 1;
        await new Promise<void>((resolve) => {
          finishCancel = resolve;
        });
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const waiter = new AbortController();
    const first = execution.cancel(waiter.signal);
    waiter.abort(new Error("waiter stopped"));
    await expect(first).rejects.toThrow("waiter stopped");
    const second = execution.cancel();
    finishCancel?.();
    await expect(second).resolves.toBeUndefined();
    expect(cancelCalls).toBe(1);
    await execution.close();
    await session.close();
  });

  it("settles task result and async snapshot observation concurrently", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let getCalls = 0;
    let cancelCalls = 0;
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const method = expectRecord(request).method;
      if (method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "settle",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (method === "tasks/get") {
        getCalls += 1;
        return {
          kind: "result",
          result: asJson({
            resultType: "complete",
            taskId: "settle",
            status: "completed",
            createdAt: "a",
            lastUpdatedAt: "b",
            ttlMs: null,
            result: { content: [] },
          }),
        };
      }
      if (method === "tasks/cancel") {
        cancelCalls += 1;
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`unexpected method ${formatJson(method)}`);
    };
    const declaration = toolDeclaration({
      name: "x",
      inputSchema: { type: "object" },
    });
    const session = withTasks(port, {
      tools: { currentTool: () => declaration },
    });
    const observed: string[] = [];
    const execution = await session.callTool("x");
    const settlementPromise = execution.settle({
      onEvent: async (event) => {
        await Promise.resolve();
        if (event.type === "task") observed.push(event.task.status);
      },
    });
    expect(execution.settle()).toBe(settlementPromise);
    const settlement = await settlementPromise;
    expect(settlement.outcome).toMatchObject({
      status: "completed",
      result: { resultType: "complete", content: [] },
    });
    expect(settlement.lastTask?.status).toBe("completed");
    expect(observed).toEqual(["working", "completed"]);
    expect(getCalls).toBe(1);
    expect(cancelCalls).toBe(0);
    expect(execution.declaration).toBe(declaration);
    const publicEvents: string[] = [];
    for await (const event of execution.updates()) {
      publicEvents.push(
        event.type === "task" ? event.task.status : event.outcome.status,
      );
    }
    expect(publicEvents).toEqual(["working", "completed", "completed"]);
    await session.close();
  });

  it("preserves an observation failure when it precedes result failure", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const method = expectRecord(request).method;
      if (method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "dual-error",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (method === "tasks/get")
        return {
          kind: "error",
          error: { code: -32000, message: "result failed" },
        };
      throw new Error(`unexpected method ${formatJson(method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const observationError = new Error("observation failed");
    let caught: unknown;
    try {
      await execution.settle({
        close: false,
        onEvent: () => {
          throw observationError;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(observationError);
    await session.close();
  });

  it("stops a nonterminating result driver when snapshot observation fails", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let cancelCalls = 0;
    port.dispatchHandler = async (request, options) => {
      const method = expectRecord(request).method;
      if (method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "observer-failure-hang",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (method === "tasks/get")
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          ),
        );
      if (method === "tasks/cancel") {
        cancelCalls += 1;
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`unexpected method ${formatJson(method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const observationError = new Error("observer stopped");
    await expect(
      execution.settle({
        onEvent: () => {
          throw observationError;
        },
      }),
    ).rejects.toBe(observationError);
    expect(cancelCalls).toBe(0);
    await session.close();
  });
  it("caller-aborted settle does not implicitly cancel the remote task", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let cancelCalls = 0;
    const createdTask = {
      resultType: "task",
      taskId: "abort-settle",
      status: "working",
      createdAt: "a",
      lastUpdatedAt: "a",
      ttlMs: null,
    } as const;
    port.dispatchHandler = async (request, options) => {
      const method = expectRecord(request).method;
      if (method === "tools/call")
        return { kind: "result", result: asJson(createdTask) };
      if (method === "tasks/get")
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(asError(options.signal?.reason));
            },
            { once: true },
          ),
        );
      if (method === "tasks/cancel") {
        cancelCalls += 1;
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`unexpected method ${formatJson(method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclaration({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const caller = new AbortController();
    const settlement = execution.settle({ signal: caller.signal });
    await Promise.resolve();
    caller.abort(new Error("stop waiting"));
    await expect(settlement).rejects.toThrow("stop waiting");
    expect(cancelCalls).toBe(0);
    expect(execution.kind).toBe("task");
    if (execution.kind !== "task") throw new Error("Expected task execution");
    await session.close();
  });
});
import {
  legacyResult,
  legacyUpdates,
} from "../../test-support/client/semantic.js";
