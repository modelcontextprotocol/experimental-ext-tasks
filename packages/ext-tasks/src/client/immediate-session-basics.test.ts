import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ProtocolDecodeError,
  type JsonValue,
  type RuntimeCodec,
} from "../core/index.js";
import {
  DispatchError,
  JsonRpcResponseError,
  toolDeclarationV1,
  withTasks,
} from "./index.js";
import { FakePort, asJson } from "../../test-support/client/fake-port.js";

describe("immediate and session basics", () => {
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

  it("preserves call metadata and transport headers", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    await session.callTool("x", undefined, {
      metadata: { trace: "request-1" },
      headers: { "x-routing-key": "route-1" },
    });
    expect(port.requests).toEqual([
      {
        method: "tools/call",
        params: {
          name: "x",
          _meta: {
            trace: "request-1",
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { "io.modelcontextprotocol/tasks": {} },
            },
          },
        },
      },
    ]);
    expect(port.dispatchOptions[0]?.context?.headers).toEqual({
      "x-routing-key": "route-1",
    });
    await session.close();
  });

  it("adds requested TTL only to V1 task calls", async () => {
    const port = new FakePort({
      generation: "v1",
      capabilities: { cancel: {}, requests: { tools: { call: {} } } },
    });
    port.response = {
      kind: "result",
      result: {
        task: {
          taskId: "task-ttl",
          status: "working",
          createdAt: "now",
          lastUpdatedAt: "now",
          ttl: 5000,
        },
      },
    };
    const session = withTasks(port, {
      tools: {
        currentTool: () =>
          toolDeclarationV1({
            name: "x",
            inputSchema: { type: "object" },
            execution: { taskSupport: "required" },
          }),
      },
    });
    const execution = await session.callTool("x", undefined, {
      taskTtl: 5000,
      headers: { "x-routing-key": "route-task" },
    });
    expect(port.requests[0]).toEqual({
      method: "tools/call",
      params: { name: "x", task: { ttl: 5000 } },
    });
    port.response = {
      kind: "result",
      result: {
        taskId: "task-ttl",
        status: "cancelled",
        createdAt: "now",
        lastUpdatedAt: "later",
        ttl: 5000,
      },
    };
    await execution.cancel();
    expect(port.requests[1]).toEqual({
      method: "tasks/cancel",
      params: { taskId: "task-ttl" },
    });
    expect(port.dispatchOptions[1]?.context?.headers).toEqual({
      "x-routing-key": "route-task",
    });
    await session.close();
  });

  it("uses an application result codec at the dispatch boundary", async () => {
    const port = new FakePort();
    port.response = { kind: "result", result: { answer: 42 } };
    const resultCodec: RuntimeCodec<string> = {
      parse(value) {
        const answer =
          value !== null &&
          !Array.isArray(value) &&
          typeof value === "object" &&
          "answer" in value
            ? value.answer
            : undefined;
        return typeof answer === "number"
          ? { success: true, value: String(answer) }
          : {
              success: false,
              error: new ProtocolDecodeError("Expected answer"),
            };
      },
    };
    const session = withTasks<string>(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("answer", undefined, {
      resultCodec,
      applicationContext: "ctx",
    });
    expect(execution.applicationContext).toBe("ctx");
    await expect(execution.result()).resolves.toBe("42");

    port.response = { kind: "result", result: { answer: "invalid" } };
    await expect(
      session.callTool("answer", undefined, { resultCodec }),
    ).rejects.toBeInstanceOf(ProtocolDecodeError);
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
          () => {
            reject(new DOMException("invalidated", "AbortError"));
          },
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
});
