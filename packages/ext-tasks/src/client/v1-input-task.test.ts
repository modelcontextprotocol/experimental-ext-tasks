import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type JsonValue } from "../core/index.js";
import {
  type ServerTaskCapabilitiesV1,
  type ToolV1,
} from "../core/v1/index.js";
import {
  InputCorrelationError,
  TaskCancellationUnsupportedError,
  TaskExecutionClosedError,
  withTasks,
  type JsonRpcResponse,
} from "./index.js";
import {
  FakePort,
  asJson,
  formatJson,
  asError,
  expectRecord,
} from "../../test-support/client/fake-port.js";

describe("V1 input and task behavior", () => {
  it("settles default V1 input declines with method-specific protocol values", async () => {
    const port = new FakePort({ generation: "v1", capabilities: {} });
    const errors: Error[] = [];
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
      onError: (error) => errors.push(error),
    });
    await expect(
      port.serve({ method: "elicitation/create", params: {} }),
    ).resolves.toEqual({
      kind: "result",
      result: { action: "cancel" },
    });
    for (const method of ["sampling/createMessage", "roots/list"]) {
      await expect(port.serve({ method, params: {} })).resolves.toEqual({
        kind: "error",
        error: { code: -32603, message: "Internal error" },
      });
    }
    expect(errors).toHaveLength(3);
    expect(
      errors.every((error) => error instanceof InputCorrelationError),
    ).toBe(true);
    expect(
      errors.map((error) => (error as InputCorrelationError).reason),
    ).toEqual(["missing-evidence", "missing-evidence", "missing-evidence"]);
    await session.close();
  });

  it("routes ordinary input requests with the execution context", async () => {
    const cases = [
      {
        method: "elicitation/create",
        result: { action: "accept", content: { value: "ok" } },
      },
      {
        method: "sampling/createMessage",
        result: {
          model: "m",
          role: "assistant",
          content: { type: "text", text: "ok" },
        },
      },
      { method: "roots/list", result: { roots: [{ uri: "file:///tmp" }] } },
    ] as const;
    for (const input of cases) {
      const port = new FakePort({ generation: "v1", capabilities: {} });
      const observed: unknown[] = [];
      port.dispatchHandler = async () => {
        observed.push(
          await port.serve({ method: input.method, params: { prompt: "p" } }),
        );
        return { kind: "result", result: { content: [] } };
      };
      const session = withTasks<{ readonly marker: string }>(port, {
        tools: { currentTool: () => undefined },
        onInputRequest: async (request, context) => {
          await Promise.resolve();
          observed.push({ request, context });
          return input.result as never;
        },
      });
      await session.callTool("x", undefined, {
        applicationContext: { marker: "ctx" },
      });
      expect(observed[0]).toMatchObject({
        request: { params: { prompt: "p" } },
        context: { lifetime: "basic", applicationContext: { marker: "ctx" } },
      });
      expect(
        (observed[0] as { context: { executionId: string } }).context
          .executionId,
      ).toMatch(/^execution-/);
      expect(observed[1]).toEqual({ kind: "result", result: input.result });
      await session.close();
    }
  });

  it("fails closed when the input handler rejects", async () => {
    const port = new FakePort({ generation: "v1", capabilities: {} });
    let settlement: JsonRpcResponse | undefined;
    port.dispatchHandler = async () => {
      settlement = await port.serve({
        method: "elicitation/create",
        params: {},
      });
      return { kind: "result", result: { content: [] } };
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
      onInputRequest: async () => {
        await Promise.resolve();
        throw new Error("declined");
      },
    });
    await session.callTool("x");
    expect(settlement).toEqual({
      kind: "result",
      result: { action: "cancel" },
    });
    await session.close();
  });

  it("reports ambiguous ordinary input correlation before declining", async () => {
    const port = new FakePort({ generation: "v1", capabilities: {} });
    const completions: ((response: JsonRpcResponse) => void)[] = [];
    port.dispatchHandler = () =>
      new Promise((resolve) => completions.push(resolve));
    const errors: Error[] = [];
    let handlerCalls = 0;
    const session = withTasks<string>(port, {
      tools: { currentTool: () => undefined },
      onInputRequest: async () => {
        await Promise.resolve();
        handlerCalls += 1;
        return { action: "accept" } as never;
      },
      onError: (error) => errors.push(error),
    });
    const first = session.callTool("first", undefined, {
      applicationContext: "one",
    });
    const second = session.callTool("second", undefined, {
      applicationContext: "two",
    });
    await Promise.resolve();
    await expect(
      port.serve({ method: "elicitation/create", params: {} }),
    ).resolves.toEqual({
      kind: "result",
      result: { action: "cancel" },
    });
    expect(handlerCalls).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(InputCorrelationError);
    expect(errors[0]).toMatchObject({
      reason: "ambiguous-matches",
      requestKind: "elicitation",
    });
    expect(
      (errors[0] as InputCorrelationError<string>).candidates.map(
        (candidate) => candidate.toolName,
      ),
    ).toEqual(["first", "second"]);
    for (const complete of completions)
      complete({ kind: "result", result: { content: [] } });
    await Promise.all([first, second]);
    await session.close();
  });

  it("correlates V1 task inputs across candidate counts and evidence states", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom("absent", "invalid", "matching", "missing"),
        fc.constantFrom(
          "elicitation/create",
          "sampling/createMessage",
          "roots/list",
        ),
        async (candidateCount, evidenceState, method) => {
          const port = new FakePort({
            generation: "v1",
            capabilities: { requests: { tools: { call: {} } }, cancel: {} },
          });
          port.dispatchHandler = async (request, options) => {
            const record = expectRecord(request);
            const params = expectRecord(record.params);
            if (record.method === "tools/call") {
              if (typeof params.name !== "string")
                throw new Error("tool name required");
              const name = params.name;
              return {
                kind: "result",
                result: asJson({
                  task: {
                    taskId: `task-${name}`,
                    status: "working",
                    createdAt: "a",
                    lastUpdatedAt: "a",
                    ttl: null,
                  },
                }),
              };
            }
            if (record.method === "tasks/get")
              return new Promise((_resolve, reject) =>
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(asError(options.signal?.reason)),
                  { once: true },
                ),
              );
            if (record.method === "tasks/cancel")
              return {
                kind: "result",
                result: asJson({
                  taskId: params.taskId,
                  status: "cancelled",
                  createdAt: "a",
                  lastUpdatedAt: "b",
                  ttl: null,
                }),
              };
            throw new Error(`unexpected method ${formatJson(record.method)}`);
          };
          const errors: Error[] = [];
          const observed: unknown[] = [];
          const session = withTasks<string>(port, {
            tools: {
              currentTool: (name) => ({
                name,
                inputSchema: { type: "object" },
                execution: { taskSupport: "required" },
              }),
            },
            onInputRequest: async (request, context) => {
              await Promise.resolve();
              observed.push({ request, context });
              return (
                request.kind === "elicitation"
                  ? { action: "accept" }
                  : request.kind === "sampling"
                    ? {
                        model: "m",
                        role: "assistant",
                        content: { type: "text", text: "ok" },
                      }
                    : { roots: [] }
              ) as never;
            },
            onError: (error) => errors.push(error),
          });
          const executions = await Promise.all(
            Array.from({ length: candidateCount }, (_, index) =>
              session.callTool(String(index), undefined, {
                applicationContext: `context-${index}`,
              }),
            ),
          );
          const relatedTask: JsonValue =
            evidenceState === "absent"
              ? {}
              : evidenceState === "invalid"
                ? {
                    _meta: {
                      "io.modelcontextprotocol/related-task": { taskId: 1 },
                    },
                  }
                : {
                    _meta: {
                      "io.modelcontextprotocol/related-task": {
                        taskId:
                          evidenceState === "matching" ? "task-0" : "other",
                      },
                    },
                  };
          const settlement = await port.serve({ method, params: relatedTask });
          const succeeds =
            (evidenceState === "absent" && candidateCount === 1) ||
            (evidenceState === "matching" && candidateCount > 0);
          expect(observed).toHaveLength(succeeds ? 1 : 0);
          expect(errors).toHaveLength(succeeds ? 0 : 1);
          if (succeeds) {
            const entry = expectRecord(asJson(observed[0]));
            expect(entry.context).toMatchObject({
              lifetime: "task-v1",
              taskId: "task-0",
              applicationContext: "context-0",
            });
            expect(
              (observed[0] as { context: { signal: AbortSignal } }).context
                .signal,
            ).toBeInstanceOf(AbortSignal);
            expect(settlement.kind).toBe("result");
          } else {
            const expectedReason =
              evidenceState === "invalid"
                ? "invalid-evidence"
                : evidenceState === "absent" && candidateCount === 0
                  ? "missing-evidence"
                  : evidenceState === "missing" || candidateCount === 0
                    ? "zero-matches"
                    : "ambiguous-matches";
            expect(errors[0]).toBeInstanceOf(InputCorrelationError);
            expect(errors[0]).toMatchObject({ reason: expectedReason });
            if (evidenceState === "invalid") {
              const candidates = (errors[0] as InputCorrelationError<string>)
                .candidates;
              expect(candidates).toHaveLength(candidateCount);
              expect(
                candidates.every((candidate) => !("taskId" in candidate)),
              ).toBe(true);
            }
            expect(settlement).toEqual(
              method === "elicitation/create"
                ? { kind: "result", result: { action: "cancel" } }
                : {
                    kind: "error",
                    error: { code: -32603, message: "Internal error" },
                  },
            );
          }
          await Promise.all(executions.map((execution) => execution.close()));
          await session.close();
        },
      ),
      { numRuns: 40 },
    );
  });

  it("conforms exactly to the V1 related-task metadata key", async () => {
    const malformedValues: JsonValue[] = [
      null,
      [],
      "task-0",
      {},
      { taskId: null },
    ];
    for (const relatedTask of malformedValues) {
      const port = new FakePort({ generation: "v1", capabilities: {} });
      const errors: Error[] = [];
      const session = withTasks(port, {
        tools: { currentTool: () => undefined },
        onInputRequest: async () => {
          await Promise.resolve();
          return { action: "accept" } as never;
        },
        onError: (error) => errors.push(error),
      });
      await port.serve({
        method: "elicitation/create",
        params: {
          _meta: { "io.modelcontextprotocol/related-task": relatedTask },
        },
      });
      expect(errors[0]).toMatchObject({ reason: "invalid-evidence" });
      await session.close();
    }
    const port = new FakePort({ generation: "v1", capabilities: {} });
    const errors: Error[] = [];
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
      onInputRequest: async () => {
        await Promise.resolve();
        return { action: "accept" } as never;
      },
      onError: (error) => errors.push(error),
    });
    await port.serve({
      method: "elicitation/create",
      params: {
        _meta: {
          "modelcontextprotocol.io/related-task": { taskId: "wrong-key" },
          unrelated: true,
        },
      },
    });
    expect(errors[0]).toMatchObject({ reason: "missing-evidence" });
    await session.close();
  });

  it("unregisters a closed V1 task candidate and aborts its handler signal", async () => {
    const port = new FakePort({
      generation: "v1",
      capabilities: { requests: { tools: { call: {} } }, cancel: {} },
    });
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            task: {
              taskId: "lifecycle",
              status: "working",
              createdAt: "a",
              lastUpdatedAt: "a",
              ttl: null,
            },
          }),
        };
      if (record.method === "tasks/get")
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => reject(asError(options.signal?.reason)),
            { once: true },
          ),
        );
      return {
        kind: "result",
        result: asJson({
          taskId: "lifecycle",
          status: "cancelled",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttl: null,
        }),
      };
    };
    const errors: Error[] = [];
    let handlerSignal: AbortSignal | undefined;
    const session = withTasks(port, {
      tools: {
        currentTool: () => ({
          name: "x",
          inputSchema: { type: "object" },
          execution: { taskSupport: "required" },
        }),
      },
      onInputRequest: async (_request, context) => {
        await Promise.resolve();
        handlerSignal = context.signal;
        return { action: "accept" } as never;
      },
      onError: (error) => errors.push(error),
    });
    const execution = await session.callTool("x");
    await port.serve({ method: "elicitation/create", params: {} });
    expect(handlerSignal?.aborted).toBe(false);
    await execution.close();
    await expect(execution.result()).rejects.toBeInstanceOf(
      TaskExecutionClosedError,
    );
    expect(handlerSignal?.aborted).toBe(true);
    await port.serve({
      method: "elicitation/create",
      params: {
        _meta: {
          "io.modelcontextprotocol/related-task": { taskId: "lifecycle" },
        },
      },
    });
    expect(errors.at(-1)).toMatchObject({ reason: "zero-matches" });
    await session.close();
  });

  it("applies the exhaustive V1 capability-first task augmentation table", async () => {
    const support = fc.option(
      fc.constantFrom("forbidden", "optional", "required"),
      { nil: undefined },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        support,
        fc.boolean(),
        async (present, taskSupport, preferTask) => {
          const capabilities: ServerTaskCapabilitiesV1 = present
            ? { requests: { tools: { call: {} } } }
            : {};
          const port = new FakePort({ generation: "v1", capabilities });
          let taskSelected = false;
          port.dispatchHandler = async (request) => {
            await Promise.resolve();
            const record = expectRecord(request);
            if (record.method === "tools/call") {
              return taskSelected
                ? {
                    kind: "result",
                    result: asJson({
                      task: {
                        taskId: "property-task",
                        status: "completed",
                        createdAt: "a",
                        lastUpdatedAt: "b",
                        ttl: null,
                      },
                    }),
                  }
                : { kind: "result", result: { content: [] } };
            }
            if (record.method === "tasks/result")
              return { kind: "result", result: { content: [] } };
            throw new Error(`unexpected method ${formatJson(record.method)}`);
          };
          let lookups = 0;
          const tool: ToolV1 = {
            name: "x",
            inputSchema: { type: "object" },
            execution: { taskSupport },
          };
          const session = withTasks(port, {
            tools: {
              currentTool: () => {
                lookups += 1;
                return tool;
              },
            },
          });
          taskSelected =
            present &&
            (taskSupport === "required" ||
              (taskSupport === "optional" && preferTask));
          const execution = await session.callTool("x", undefined, {
            preferTask,
          });
          if (taskSelected) {
            expect(execution.kind).toBe("task");
            expect(port.requests).toEqual([
              { method: "tools/call", params: { name: "x", task: {} } },
              { method: "tasks/result", params: { taskId: "property-task" } },
            ]);
          } else {
            expect(execution.kind).toBe("immediate");
            expect(port.requests).toEqual([
              { method: "tools/call", params: { name: "x" } },
            ]);
          }
          expect(lookups).toBe(1);
          await session.close();
        },
      ),
    );
  });

  it("drives a V1 task to a separately retrieved result", async () => {
    const port = new FakePort({
      generation: "v1",
      capabilities: { requests: { tools: { call: {} } }, cancel: {} },
    });
    const tool: ToolV1 = {
      name: "long",
      inputSchema: { type: "object" },
      execution: { taskSupport: "required" },
    };
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const record = expectRecord(request);
      if (record.method === "tools/call") {
        return {
          kind: "result",
          result: asJson({
            task: {
              taskId: "v1-task",
              status: "working",
              createdAt: "a",
              lastUpdatedAt: "a",
              ttl: null,
            },
          }),
        };
      }
      if (record.method === "tasks/get") {
        return {
          kind: "result",
          result: asJson({
            taskId: "v1-task",
            status: "completed",
            createdAt: "a",
            lastUpdatedAt: "b",
            ttl: null,
          }),
        };
      }
      if (record.method === "tasks/result") {
        return {
          kind: "result",
          result: asJson({ content: [{ type: "text", text: "done" }] }),
        };
      }
      if (record.method === "tasks/cancel") {
        return {
          kind: "result",
          result: asJson({
            taskId: "v1-task",
            status: "cancelled",
            createdAt: "a",
            lastUpdatedAt: "b",
            ttl: null,
          }),
        };
      }
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, { tools: { currentTool: () => tool } });
    const execution = await session.callTool("long");
    expect(execution.kind).toBe("task");
    expect(execution.handle).toEqual({
      generation: "v1",
      taskId: "v1-task",
      originalOperation: "tools/call",
    });
    const snapshots: unknown[] = [];
    for await (const snapshot of execution.updates()) snapshots.push(snapshot);
    expect(snapshots).toEqual([
      {
        generation: "v1",
        task: {
          taskId: "v1-task",
          status: "working",
          createdAt: "a",
          lastUpdatedAt: "a",
          ttl: null,
        },
      },
      {
        generation: "v1",
        task: {
          taskId: "v1-task",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttl: null,
        },
      },
    ]);
    const first = execution.result();
    expect(execution.result()).toBe(first);
    await expect(first).resolves.toEqual({
      content: [{ type: "text", text: "done" }],
    });
    await session.close();
  });

  it("identifies unsupported V1 cancellation without dispatching it", async () => {
    const port = new FakePort({
      generation: "v1",
      capabilities: { requests: { tools: { call: {} } } },
    });
    const tool: ToolV1 = {
      name: "x",
      inputSchema: { type: "object" },
      execution: { taskSupport: "required" },
    };
    port.dispatchHandler = async (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            task: {
              taskId: "no-cancel",
              status: "working",
              createdAt: "a",
              lastUpdatedAt: "a",
              ttl: null,
            },
          }),
        };
      if (record.method === "tasks/get")
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => reject(asError(options.signal?.reason)),
            { once: true },
          ),
        );
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, { tools: { currentTool: () => tool } });
    const execution = await session.callTool("x");
    await expect(execution.cancel()).rejects.toBeInstanceOf(
      TaskCancellationUnsupportedError,
    );
    expect(
      port.requests.some(
        (request) => expectRecord(request).method === "tasks/cancel",
      ),
    ).toBe(false);
    await execution.close();
    await expect(execution.result()).rejects.toBeInstanceOf(
      TaskExecutionClosedError,
    );
    await session.close();
  });
});
