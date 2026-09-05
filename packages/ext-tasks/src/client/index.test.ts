import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeCodec,
  expectRecord,
  type JsonValue,
} from "../core/index.js";
import type { ServerTaskCapabilitiesV1, ToolV1 } from "../core/v1/index.js";

import {
  DispatchError,
  InputCorrelationError,
  JsonRpcResponseError,
  TaskCancellationUnsupportedError,
  TaskExecutionClosedError,
  TaskUpdatesAlreadyAcquiredError,
  withTasks,
  type ConnectedMcpSessionPort,
  type IncomingServerRequest,
  type JsonRpcResponse,
  type SessionTaskCapabilities,
} from "./index.js";

const asJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

const formatJson = (value: unknown): string =>
  JSON.stringify(value) ?? "undefined";

const asError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error(formatJson(reason));

class FakePort implements ConnectedMcpSessionPort {
  readonly requests: JsonValue[] = [];
  readonly taskCapabilities: SessionTaskCapabilities;
  invalidated = false;
  response: JsonRpcResponse = { kind: "result", result: { content: [] } };
  dispatchHandler?: (
    request: JsonValue,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<JsonRpcResponse>;
  private requestHandler?: (
    incoming: IncomingServerRequest,
  ) => Promise<JsonRpcResponse>;
  private notificationListener?: (notification: JsonValue) => void;
  private invalidationListener?: (reason: unknown) => void;
  listenerDisposals = 0;

  constructor(
    taskCapabilities: SessionTaskCapabilities = { generation: "none" },
  ) {
    this.taskCapabilities = taskCapabilities;
  }

  async dispatch(
    request: JsonValue,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JsonRpcResponse> {
    this.requests.push(request);
    return this.dispatchHandler === undefined
      ? this.response
      : this.dispatchHandler(request, options);
  }

  onServerRequest(
    handler: (incoming: IncomingServerRequest) => Promise<JsonRpcResponse>,
  ): () => void {
    this.requestHandler = handler;
    return () => {
      this.requestHandler = undefined;
      this.listenerDisposals += 1;
    };
  }

  onNotification(listener: (notification: JsonValue) => void): () => void {
    this.notificationListener = listener;
    return () => {
      this.notificationListener = undefined;
      this.listenerDisposals += 1;
    };
  }

  onInvalidated(listener: (reason: unknown) => void): () => void {
    this.invalidationListener = listener;
    return () => {
      this.invalidationListener = undefined;
      this.listenerDisposals += 1;
    };
  }

  invalidate(reason: unknown): void {
    this.invalidated = true;
    this.invalidationListener?.(reason);
  }

  async serve(request: JsonValue): Promise<JsonRpcResponse> {
    if (this.requestHandler === undefined)
      throw new Error("request handler is not installed");
    return this.requestHandler({ request, requestContext: {} });
  }

  notify(notification: JsonValue): void {
    this.notificationListener?.(notification);
  }
}

describe("client tool executions", () => {
  it("dispatches a non-task call and caches the decoded result", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.dictionary(fc.string(), fc.jsonValue()),
        async (name, args) => {
          const port = new FakePort();
          const result = { content: [{ type: "text", text: name }] };
          port.response = { kind: "result", result: asJson(result) };
          const session = withTasks(port, {
            tools: { currentTool: () => undefined },
          });
          const normalizedArgs = asJson(args) as Readonly<
            Record<string, JsonValue>
          >;
          const execution = await session.callTool(name, normalizedArgs);
          expect(execution.kind).toBe("immediate");
          expect(port.requests).toEqual([
            {
              method: "tools/call",
              params: { name, arguments: normalizedArgs },
            },
          ]);
          const first = execution.result();
          const second = execution.result();
          expect(first).toBe(second);
          await expect(first).resolves.toEqual(result);
          const updates: unknown[] = [];
          for await (const update of execution.updates()) updates.push(update);
          expect(updates).toEqual([]);
          await execution.cancel();
          expect(port.requests).toHaveLength(1);
          await session.close();
        },
      ),
    );
  });

  it("uses an application result codec at the dispatch boundary", async () => {
    const port = new FakePort();
    port.response = { kind: "result", result: { answer: 42 } };
    const codec = createRuntimeCodec((value) => {
      const record = expectRecord(value);
      if (typeof record.answer !== "number") throw new Error("answer required");
      return record.answer;
    });
    const session = withTasks<string>(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("answer", undefined, {
      resultCodec: codec,
      applicationContext: "ctx",
    });
    expect(execution.applicationContext).toBe("ctx");
    await expect(execution.result()).resolves.toBe(42);
    await session.close();
  });

  it("preserves complete JSON-RPC errors and dispatch failures", async () => {
    const port = new FakePort();
    port.response = {
      kind: "error",
      error: { code: -32001, message: "denied", data: { retry: false } },
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    await expect(session.callTool("denied")).rejects.toMatchObject({
      name: "JsonRpcResponseError",
      code: -32001,
      message: "denied",
      data: { retry: false },
    });
    const error = new DispatchError("offline", true);
    expect(error.retryable).toBe(true);
    expect(new JsonRpcResponseError({ code: 1, message: "x" })).toBeInstanceOf(
      Error,
    );
    await session.close();
  });

  it("closes executions and sessions idempotently without closing the borrowed port", async () => {
    const port = new FakePort();
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("x");
    await execution.close();
    await execution.close();
    await session.close();
    await session.close();
    expect(port.listenerDisposals).toBe(3);
    expect(port.invalidated).toBe(false);
  });

  it("rejects new and pending work after session invalidation", async () => {
    const port = new FakePort();
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    port.invalidate(new Error("replaced"));
    await expect(session.callTool("x")).rejects.toThrow("replaced");
    await session.close();
  });

  it("aborts pending discovery when the port is invalidated", async () => {
    const port = new FakePort();
    port.dispatchHandler = (_request, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("invalidated", "AbortError")),
          { once: true },
        );
      });
    const session = withTasks(port);
    const pending = session.callTool("x");
    port.invalidate(new Error("connection replaced"));
    await expect(pending).rejects.toThrow(/connection replaced|invalidated/);
    expect(port.requests).toHaveLength(1);
    await session.close();
  });

  it("settles default V1 input declines with method-specific protocol values", async () => {
    const port = new FakePort({ generation: "v1", capabilities: {} });
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
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

  it("settles configured input-handler rejection fail-closed", async () => {
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
  it("honors already-aborted call and session signals before dispatch", async () => {
    const callPort = new FakePort();
    const callSession = withTasks(callPort, {
      tools: { currentTool: () => undefined },
    });
    const callController = new AbortController();
    callController.abort(new Error("call aborted"));
    await expect(
      callSession.callTool("x", undefined, { signal: callController.signal }),
    ).rejects.toThrow("call aborted");
    expect(callPort.requests).toEqual([]);
    await callSession.close();

    const sessionPort = new FakePort();
    const sessionController = new AbortController();
    const session = withTasks(sessionPort, {
      tools: { currentTool: () => undefined },
      signal: sessionController.signal,
    });
    sessionController.abort(new Error("session aborted"));
    await expect(session.callTool("x")).rejects.toThrow("session aborted");
    expect(sessionPort.requests).toEqual([]);
    await session.close();
  });

  it("cleans up call listeners when declaration lookup fails", async () => {
    const port = new FakePort();
    const callController = new AbortController();
    const addListener = vi.spyOn(callController.signal, "addEventListener");
    const removeListener = vi.spyOn(
      callController.signal,
      "removeEventListener",
    );
    const session = withTasks(port, {
      tools: {
        currentTool: () => {
          throw new Error("declaration lookup failed");
        },
      },
    });
    await expect(
      session.callTool("x", undefined, { signal: callController.signal }),
    ).rejects.toThrow("declaration lookup failed");
    expect(port.requests).toEqual([]);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
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

  it("does not treat an application task field as task creation", async () => {
    const port = new FakePort({ generation: "v1", capabilities: {} });
    port.response = {
      kind: "result",
      result: { content: [], task: "application-data" },
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("x");
    await expect(execution.result()).resolves.toEqual({
      content: [],
      task: "application-data",
    });
    await session.close();
  });

  it("manages initial tool declarations only when no provider is supplied", async () => {
    const managed = new FakePort({ generation: "v1", capabilities: {} });
    managed.dispatchHandler = async (request) => {
      await Promise.resolve();
      const record = expectRecord(request);
      if (record.method === "tools/list") {
        return {
          kind: "result",
          result: asJson({
            tools: [{ name: "listed", inputSchema: { type: "object" } }],
          }),
        };
      }
      return { kind: "result", result: asJson({ content: [] }) };
    };
    const managedSession = withTasks(managed);
    await managedSession.callTool("listed");
    expect(managed.requests).toEqual([
      { method: "tools/list", params: {} },
      { method: "tools/call", params: { name: "listed" } },
    ]);
    await managedSession.close();

    const supplied = new FakePort();
    const suppliedSession = withTasks(supplied, {
      tools: { currentTool: () => undefined },
    });
    await suppliedSession.callTool("x");
    expect(supplied.requests).toEqual([
      { method: "tools/call", params: { name: "x" } },
    ]);
    await suppliedSession.close();
  });

  it("retries initial discovery and follows tool-list cursors", async () => {
    const port = new FakePort({ generation: "v1", capabilities: {} });
    let attempts = 0;
    port.dispatchHandler = async (request) => {
      await Promise.resolve();
      const record = expectRecord(request);
      if (record.method !== "tools/list")
        return { kind: "result", result: asJson({ content: [] }) };
      attempts += 1;
      if (attempts === 1) throw new DispatchError("temporary", true);
      const params = expectRecord(record.params);
      if (params.cursor === undefined) {
        return {
          kind: "result",
          result: asJson({
            tools: [{ name: "first", inputSchema: { type: "object" } }],
            nextCursor: "next",
          }),
        };
      }
      return {
        kind: "result",
        result: asJson({
          tools: [{ name: "second", inputSchema: { type: "object" } }],
        }),
      };
    };
    const session = withTasks(port);
    await session.callTool("second");
    expect(port.requests.slice(0, 3)).toEqual([
      { method: "tools/list", params: {} },
      { method: "tools/list", params: {} },
      { method: "tools/list", params: { cursor: "next" } },
    ]);
    await session.close();
  });
  it("ignores stale tool-list refreshes", async () => {
    const port = new FakePort({
      generation: "v1",
      capabilities: { requests: { tools: { call: {} } } },
    });
    const pending: ((response: JsonRpcResponse) => void)[] = [];
    let abortedRefreshes = 0;
    let listCount = 0;
    port.dispatchHandler = (request, options) => {
      const record = expectRecord(request);
      if (record.method === "tools/call") {
        const params = expectRecord(record.params);
        return Promise.resolve(
          params.task === undefined
            ? { kind: "result", result: { content: [] } }
            : {
                kind: "result",
                result: asJson({
                  task: {
                    taskId: "newest",
                    status: "completed",
                    createdAt: "a",
                    lastUpdatedAt: "b",
                    ttl: null,
                  },
                }),
              },
        );
      }
      if (record.method === "tasks/result")
        return Promise.resolve({ kind: "result", result: { content: [] } });
      if (record.method !== "tools/list")
        throw new Error(`unexpected method ${formatJson(record.method)}`);
      listCount += 1;
      if (listCount === 1) {
        return Promise.resolve({
          kind: "result",
          result: asJson({
            tools: [{ name: "x", inputSchema: { type: "object" } }],
          }),
        });
      }
      return new Promise((resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            abortedRefreshes += 1;
            reject(new DOMException("superseded", "AbortError"));
          },
          { once: true },
        );
        pending.push(resolve);
      });
    };
    const session = withTasks(port);
    await session.callTool("x");
    port.requests.length = 0;
    port.notify({ method: "notifications/tools/list_changed" });
    port.notify({ method: "notifications/tools/list_changed" });
    expect(abortedRefreshes).toBe(1);
    pending[1]?.({
      kind: "result",
      result: asJson({
        tools: [
          {
            name: "x",
            inputSchema: { type: "object" },
            execution: { taskSupport: "required" },
          },
        ],
      }),
    });
    await Promise.resolve();
    const execution = await session.callTool("x");
    expect(execution.kind).toBe("task");
    expect(port.requests.slice(-2)).toEqual([
      { method: "tools/call", params: { name: "x", task: {} } },
      { method: "tasks/result", params: { taskId: "newest" } },
    ]);
    await session.close();
  });

  it("reports duplicate tools and aborts managed discovery on close", async () => {
    const errors: Error[] = [];
    const duplicatePort = new FakePort({ generation: "v1", capabilities: {} });
    duplicatePort.dispatchHandler = async (request) => {
      await Promise.resolve();
      const record = expectRecord(request);
      if (record.method === "tools/list") {
        return {
          kind: "result",
          result: asJson({
            tools: [
              { name: "duplicate", inputSchema: { type: "object" } },
              {
                name: "duplicate",
                inputSchema: { type: "object" },
                title: "newer",
              },
            ],
          }),
        };
      }
      return { kind: "result", result: asJson({ content: [] }) };
    };
    const duplicateSession = withTasks(duplicatePort, {
      onError: (error) => errors.push(error),
    });
    await duplicateSession.callTool("duplicate");
    expect(errors.map((error) => error.message)).toContain(
      "Duplicate tool declaration: duplicate",
    );
    await duplicateSession.close();

    const callAbortPort = new FakePort();
    callAbortPort.dispatchHandler = (_request, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("discovery aborted", "AbortError")),
          { once: true },
        );
      });
    const callAbortSession = withTasks(callAbortPort);
    const callController = new AbortController();
    const call = callAbortSession.callTool("x", undefined, {
      signal: callController.signal,
    });
    callController.abort(new Error("waiter aborted"));
    await expect(call).rejects.toThrow("waiter aborted");
    expect(callAbortPort.requests).toHaveLength(1);
    await callAbortSession.close();

    const closePort = new FakePort();
    let refreshSignal: AbortSignal | undefined;
    closePort.dispatchHandler = (_request, options) =>
      new Promise((_resolve, reject) => {
        refreshSignal = options?.signal;
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("closed", "AbortError")),
          { once: true },
        );
      });
    const closeSession = withTasks(closePort);
    const closeCallController = new AbortController();
    const addListener = vi.spyOn(
      closeCallController.signal,
      "addEventListener",
    );
    const removeListener = vi.spyOn(
      closeCallController.signal,
      "removeEventListener",
    );
    const pendingCall = closeSession.callTool("x", undefined, {
      signal: closeCallController.signal,
    });
    await closeSession.close();
    await expect(pendingCall).rejects.toThrow(/closed|aborted/i);
    expect(refreshSignal?.aborted).toBe(true);
    expect(closePort.requests).toHaveLength(1);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });
  it("rejects generation-mismatched declarations without leaking call listeners", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    const v1Tool: ToolV1 = {
      name: "x",
      inputSchema: { type: "object" },
      execution: { taskSupport: "required" },
    };
    const callController = new AbortController();
    const addListener = vi.spyOn(callController.signal, "addEventListener");
    const removeListener = vi.spyOn(
      callController.signal,
      "removeEventListener",
    );
    const session = withTasks(port, { tools: { currentTool: () => v1Tool } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        session.callTool("x", undefined, { signal: callController.signal }),
      ).rejects.toThrow(
        "V1 tool declaration is incompatible with the V2 session",
      );
    }
    expect(port.requests).toEqual([]);
    expect(addListener).toHaveBeenCalledTimes(3);
    expect(removeListener).toHaveBeenCalledTimes(3);
    await session.close();
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
            () => reject(asError(options.signal?.reason)),
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
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
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
    await expect(execution.result()).rejects.toBeInstanceOf(
      TaskExecutionClosedError,
    );
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
            () => reject(asError(options.signal?.reason)),
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
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    await session.close();
    expect(cancelCalls).toBe(1);
    await expect(execution.result()).rejects.toBeInstanceOf(
      TaskExecutionClosedError,
    );
  });

  it("retries task observations once after any DispatchError", async () => {
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
            currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
          },
        });
        const execution = await session.callTool("x");
        await expect(execution.result()).resolves.toEqual({
          resultType: "complete",
          content: [],
        });
        expect(getCalls).toBe(2);
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
                () => reject(asError(options.signal?.reason)),
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
            currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
          },
        });
        const execution = await session.callTool("x");
        if (retryable)
          await expect(execution.cancel()).resolves.toBeUndefined();
        else await expect(execution.cancel()).rejects.toThrow("cancel failed");
        expect(cancelCalls).toBe(retryable ? 2 : 1);
        await execution.close();
        await expect(execution.result()).rejects.toBeInstanceOf(
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
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const iterator = execution.updates()[Symbol.asyncIterator]();
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
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    await expect(execution.result()).rejects.toBeInstanceOf(
      JsonRpcResponseError,
    );
    expect(getCalls).toBe(1);
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
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    const observer = new AbortController();
    const iterator = execution.updates(observer.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        generation: "v2",
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
    await expect(execution.result()).resolves.toEqual({
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
            () => reject(asError(options.signal?.reason)),
            { once: true },
          );
        });
      if (record.method === "tasks/cancel") return new Promise(() => {});
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    await expect(execution.close()).resolves.toBeUndefined();
    await expect(execution.result()).rejects.toBeInstanceOf(
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
            () => reject(asError(options.signal?.reason)),
            { once: true },
          );
        });
      if (record.method === "tasks/cancel")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    port.invalidate(new Error("session replaced"));
    await expect(execution.result()).rejects.toThrow("session replaced");
    await session.close();
  });

  it("a terminal notification preempts an in-flight observation", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let getStarted = false;
    let observationSignal: AbortSignal | undefined;
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
        getStarted = true;
        const signal = options?.signal;
        if (signal === undefined)
          throw new Error("observation signal is required");
        observationSignal = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(asError(signal.reason)),
            {
              once: true,
            },
          ),
        );
      }
      if (record.method === "tasks/cancel")
        return { kind: "result", result: { resultType: "complete" } };
      throw new Error(`unexpected method ${formatJson(record.method)}`);
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
      },
    });
    const execution = await session.callTool("x");
    while (!getStarted) await new Promise((resolve) => setTimeout(resolve, 1));
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
    await expect(execution.result()).resolves.toEqual({
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
            () => reject(asError(options.signal?.reason)),
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
        currentTool: () => ({ name: "x", inputSchema: { type: "object" } }),
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
