import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { expectRecord } from "../core/index.js";
import { withTasks } from "./index.js";
import {
  FakePort,
  asJson,
  formatJson,
  asError,
} from "../../test-support/client/fake-port.js";

describe("V2 input and task behavior", () => {
  it("drives a V2 task to its inline terminal result", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    const tool = { name: "long", inputSchema: { type: "object" } };
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const record = expectRecord(request);
      if (record.method === "tools/call") {
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "v2-task",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      }
      if (record.method === "tasks/get") {
        return {
          kind: "result",
          result: asJson({
            resultType: "complete",
            taskId: "v2-task",
            status: "completed",
            createdAt: "a",
            lastUpdatedAt: "b",
            ttlMs: null,
            result: {
              resultType: "complete",
              content: [{ type: "text", text: "done" }],
            },
          }),
        };
      }
      if (record.method === "tasks/cancel")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, { tools: { currentTool: () => tool } });
    const execution = await session.callTool("long");
    expect(execution.kind).toBe("task");
    expect(execution.handle).toEqual({
      generation: "v2",
      taskId: "v2-task",
      originalOperation: "tools/call",
    });
    expect(port.requests[0]).toMatchObject({
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      },
    });
    await expect(execution.result()).resolves.toEqual({
      resultType: "complete",
      content: [{ type: "text", text: "done" }],
    });
    await session.close();
  });

  it("acquires distinct V2 input keys once and submits one valid subset", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            key: fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/),
            kind: fc.constantFrom("sampling", "roots", "elicitation"),
          }),
          { minLength: 1, maxLength: 8, selector: ({ key }) => key },
        ),
        async (inputs) => {
          const port = new FakePort({ generation: "v2", capabilities: {} });
          const observed: unknown[] = [];
          let getCalls = 0;
          port.dispatchHandler = async (request) => {
            await Promise.resolve();
            const record = expectRecord(request);
            if (record.method === "tools/call")
              return {
                kind: "result",
                result: asJson({
                  resultType: "task",
                  taskId: "input-task",
                  status: "working",
                  createdAt: "a",
                  lastUpdatedAt: "a",
                  ttlMs: null,
                }),
              };
            if (record.method === "tasks/get") {
              getCalls += 1;
              if (getCalls === 1)
                return {
                  kind: "result",
                  result: asJson({
                    resultType: "complete",
                    taskId: "input-task",
                    status: "input_required",
                    createdAt: "a",
                    lastUpdatedAt: "b",
                    ttlMs: null,
                    inputRequests: Object.fromEntries(
                      inputs.map(({ key, kind }) => [
                        key,
                        kind === "sampling"
                          ? {
                              method: "sampling/createMessage",
                              params: { key },
                            }
                          : kind === "roots"
                            ? { method: "roots/list" }
                            : { method: "elicitation/create", params: { key } },
                      ]),
                    ),
                  }),
                };
              return {
                kind: "result",
                result: asJson({
                  resultType: "complete",
                  taskId: "input-task",
                  status: "completed",
                  createdAt: "a",
                  lastUpdatedAt: "c",
                  ttlMs: null,
                  result: { resultType: "complete", content: [] },
                }),
              };
            }
            if (record.method === "tasks/update")
              return { kind: "result", result: { resultType: "complete" } };
            throw new Error(`unexpected method ${formatJson(record.method)}`);
          };
          const session = withTasks<{ marker: string }>(port, {
            tools: {
              currentTool: () => ({
                name: "x",
                inputSchema: { type: "object" },
              }),
            },
            onInputRequest: async (request, context) => {
              await Promise.resolve();
              observed.push({ request, context });
              return (
                request.kind === "sampling"
                  ? { model: "m", role: "assistant", content: { type: "text" } }
                  : request.kind === "roots"
                    ? { roots: [{ uri: "file:///root" }] }
                    : { action: "cancel" }
              ) as never;
            },
          });
          const execution = await session.callTool(
            "x",
            {},
            {
              applicationContext: { marker: "context" },
            },
          );
          await expect(execution.result()).resolves.toEqual({
            resultType: "complete",
            content: [],
          });
          expect(observed).toHaveLength(inputs.length);
          expect(
            observed.map((value) => {
              const entry = expectRecord(asJson(value));
              return expectRecord(entry.context).inputKey;
            }),
          ).toEqual(inputs.map(({ key }) => key));
          const updates = port.requests.filter(
            (request) => expectRecord(request).method === "tasks/update",
          );
          expect(updates).toHaveLength(1);
          expect(updates[0]).toMatchObject({
            params: {
              taskId: "input-task",
              _meta: {
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { "io.modelcontextprotocol/tasks": {} },
                },
              },
            },
          });
          expect(
            Object.keys(
              expectRecord(expectRecord(updates[0]).params)
                .inputResponses as object,
            ),
          ).toEqual(inputs.map(({ key }) => key));
          await session.close();
        },
      ),
      { numRuns: 25 },
    );
  });

  it("reports incompatible repeated V2 keys without reacquiring or updating", async () => {
    const errors: Error[] = [];
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let getCalls = 0;
    let handlerCalls = 0;
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const method = expectRecord(request).method;
      if (method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "repeat",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: null,
          }),
        };
      if (method === "tasks/get") {
        getCalls += 1;
        if (getCalls <= 2)
          return {
            kind: "result",
            result: asJson({
              resultType: "complete",
              taskId: "repeat",
              status: "input_required",
              createdAt: "a",
              lastUpdatedAt: String(getCalls),
              ttlMs: null,
              inputRequests: {
                same:
                  getCalls === 1
                    ? { method: "roots/list" }
                    : { method: "sampling/createMessage", params: {} },
              },
            }),
          };
        return {
          kind: "result",
          result: asJson({
            resultType: "complete",
            taskId: "repeat",
            status: "completed",
            createdAt: "a",
            lastUpdatedAt: "z",
            ttlMs: null,
            result: { resultType: "complete", content: [] },
          }),
        };
      }
      throw new Error(`unexpected method ${formatJson(method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
      onInputRequest: async () => {
        await Promise.resolve();
        handlerCalls += 1;
        throw new Error("declined");
      },
      onError: (error) => errors.push(error),
    });
    const execution = await session.callTool("x");
    await expect(execution.result()).resolves.toMatchObject({
      resultType: "complete",
    });
    expect(handlerCalls).toBe(1);
    expect(
      errors.some((error) => error.message.includes("reused incompatibly")),
    ).toBe(true);
    expect(
      port.requests.filter(
        (request) => expectRecord(request).method === "tasks/update",
      ),
    ).toEqual([]);
    await session.close();
  });

  it("declines keyed V2 elicitation while withholding sampling and roots", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let getCalls = 0;
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const method = expectRecord(request).method;
      if (method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "decline-input",
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
          result: asJson(
            getCalls === 1
              ? {
                  resultType: "complete",
                  taskId: "decline-input",
                  status: "input_required",
                  createdAt: "a",
                  lastUpdatedAt: "b",
                  ttlMs: null,
                  inputRequests: {
                    elicit: { method: "elicitation/create", params: {} },
                    sample: { method: "sampling/createMessage", params: {} },
                    roots: { method: "roots/list" },
                  },
                }
              : {
                  resultType: "complete",
                  taskId: "decline-input",
                  status: "completed",
                  createdAt: "a",
                  lastUpdatedAt: "c",
                  ttlMs: null,
                  result: { resultType: "complete", content: [] },
                },
          ),
        };
      }
      if (method === "tasks/update")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
      onInputRequest: async () => {
        await Promise.resolve();
        throw new Error("declined");
      },
    });
    const execution = await session.callTool("x");
    await expect(execution.result()).resolves.toMatchObject({
      resultType: "complete",
    });
    const updates = port.requests.filter(
      (request) => expectRecord(request).method === "tasks/update",
    );
    expect(updates).toHaveLength(1);
    expect(
      expectRecord(expectRecord(updates[0]).params).inputResponses,
    ).toEqual({
      elicit: { action: "cancel" },
    });
    await session.close();
  });

  it("aborts V2 input handling when a terminal notification arrives", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let getCalls = 0;
    let handlerSignal: AbortSignal | undefined;
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const method = expectRecord(request).method;
      if (method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "terminal-input",
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
            taskId: "terminal-input",
            status: "input_required",
            createdAt: "a",
            lastUpdatedAt: "b",
            ttlMs: null,
            inputRequests: {
              key: { method: "elicitation/create", params: {} },
            },
          }),
        };
      }
      throw new Error(`unexpected method ${formatJson(method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
      onInputRequest: (_request, context) => {
        handlerSignal = context.signal;
        return new Promise<never>((_resolve, reject) =>
          context.signal?.addEventListener(
            "abort",
            () => reject(asError(context.signal?.reason)),
            { once: true },
          ),
        );
      },
    });
    const execution = await session.callTool("x");
    while (handlerSignal === undefined)
      await new Promise((resolve) => setTimeout(resolve, 1));
    port.notify(
      asJson({
        jsonrpc: "2.0",
        method: "notifications/tasks",
        params: {
          resultType: "complete",
          taskId: "terminal-input",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "c",
          ttlMs: null,
          result: { resultType: "complete", content: [] },
        },
      }),
    );
    await expect(execution.result()).resolves.toEqual({
      resultType: "complete",
      content: [],
    });
    expect(handlerSignal.aborted).toBe(true);
    expect(getCalls).toBe(1);
    expect(
      port.requests.some(
        (request) => expectRecord(request).method === "tasks/update",
      ),
    ).toBe(false);
    await session.close();
  });

  it("fetches V2 details when task creation is already terminal", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("completed", "failed", "cancelled"),
        async (status) => {
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
                  taskId: "terminal-at-creation",
                  status,
                  createdAt: "a",
                  lastUpdatedAt: "a",
                  ttlMs: null,
                }),
              };
            if (record.method === "tasks/get") {
              getCalls += 1;
              const terminal = {
                resultType: "complete",
                taskId: "terminal-at-creation",
                status,
                createdAt: "a",
                lastUpdatedAt: "b",
                ttlMs: null,
              };
              return {
                kind: "result",
                result: asJson(
                  status === "completed"
                    ? {
                        ...terminal,
                        result: { resultType: "complete", content: [] },
                      }
                    : status === "failed"
                      ? {
                          ...terminal,
                          error: { code: -32000, message: "task failed" },
                        }
                      : terminal,
                ),
              };
            }
            throw new Error(`unexpected method ${formatJson(record.method)}`);
          };
          const session = withTasks(port, {
            tools: {
              currentTool: () => ({
                name: "x",
                inputSchema: { type: "object" },
              }),
            },
          });
          const execution = await session.callTool("x");
          if (status === "completed")
            await expect(execution.result()).resolves.toEqual({
              resultType: "complete",
              content: [],
            });
          else if (status === "failed")
            await expect(execution.result()).rejects.toMatchObject({
              name: "JsonRpcResponseError",
              code: -32000,
              message: "task failed",
            });
          else await expect(execution.result()).rejects.toThrow(/cancel/i);
          expect(getCalls).toBe(1);
          await session.close();
        },
      ),
      { numRuns: 9 },
    );
  });
});
