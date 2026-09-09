import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { taskId } from "../core/index.js";
import {
  ProtocolDecodeError,
  type JsonValue,
  type RuntimeCodec,
} from "../core/index.js";
import {
  createApplicationInputHandler,
  createTaskSessionEndpointId,
  DispatchError,
  JsonRpcResponseError,
  resultFromTaskOutcome,
  taskViewFromExecutionEvent,
  TaskCancelledError,
  TaskFailedError,
  toolDeclaration,
  withRelatedTaskMetadata,
  withTasks,
} from "./index.js";
import {
  legacyResult,
  legacyUpdates,
} from "../../test-support/client/semantic.js";
import { FakePort, asJson } from "../../test-support/client/fake-port.js";
import { projectTask } from "./internal.js";

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
          await expect(first).resolves.toEqual({
            status: "completed",
            result,
          });
          const updates: unknown[] = [];
          for await (const update of legacyUpdates(execution))
            updates.push(update);
          expect(updates).toEqual([]);
          await execution.cancel();
          expect(port.requests).toHaveLength(1);
          await session.close();
        },
      ),
    );
  });

  it("settles immediate results and exposes immutable related-task metadata", async () => {
    const port = new FakePort();
    port.response = { kind: "result", result: { content: [] } };
    const declaration = toolDeclaration({
      name: "x",
      inputSchema: { type: "object" },
    });
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("x", undefined, { declaration });
    await expect(execution.settle()).resolves.toEqual({
      outcome: { status: "completed", result: { content: [] } },
      lastTask: undefined,
    });
    expect(execution.declaration).toBe(declaration);
    const original = { trace: "one", unknown: { nested: true } } as const;
    const metadata = withRelatedTaskMetadata(original, {
      taskId: taskId("related"),
    });
    expect(metadata).toEqual({
      ...original,
      "io.modelcontextprotocol/related-task": { taskId: "related" },
    });
    expect(original).toEqual({ trace: "one", unknown: { nested: true } });
    expect(session.endpointId).toBe(port.endpointId);
    expect(session.capabilities.inventory).toBe("unsupported");
    await session.close();
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
          toolDeclaration({
            name: "x",
            inputSchema: { type: "object" },
            execution: { taskSupport: "required" },
          }),
      },
    });
    const execution = await session.callTool("x", undefined, {
      task: { retentionMs: 5000 },
      headers: { "x-routing-key": "route-task" },
      requestTimeoutMs: 3_000,
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
    const expectedContext = {
      headers: { "x-routing-key": "route-task" },
      requestTimeoutMs: 3_000,
    };
    expect(port.dispatchOptions[0]?.context).toEqual(expectedContext);
    expect(port.dispatchOptions[1]?.context).toEqual(expectedContext);
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
    await expect(legacyResult(execution)).resolves.toBe("42");

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
    await expect(legacyResult(execution)).resolves.toEqual({
      content: [],
      task: "application-data",
    });
    await session.close();
  });

  it("creates canonical endpoint identities from host descriptors", async () => {
    const left = await createTaskSessionEndpointId("transport", {
      z: 1,
      a: { d: 4, c: 3 },
    });
    const right = await createTaskSessionEndpointId("transport", {
      a: { c: 3, d: 4 },
      z: 1,
    });
    expect(left).toBe(
      "transport:v1:sha256:9609398a798ffd5d25bf2ad53bb05d312094237c7c818dd99951e600396fcc64",
    );
    expect(right).toBe(left);
    await expect(createTaskSessionEndpointId("", {})).rejects.toThrow(
      "namespace",
    );
  });

  it("orders canonical endpoint keys by their serialized spelling", async () => {
    const serializedQuote = JSON.stringify('"');
    const canonical = `{${serializedQuote}:1,"a":2}`;
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    const expected = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    await expect(
      createTaskSessionEndpointId("escaped", { a: 2, '"': 1 }),
    ).resolves.toBe(`escaped:v1:sha256:${expected}`);
  });

  it("projects task aliases and unwraps semantic outcomes", () => {
    const v1 = projectTask({
      generation: "v1",
      task: {
        taskId: "v1",
        status: "working",
        createdAt: "now",
        lastUpdatedAt: "now",
        ttl: 42,
        pollInterval: 7,
      },
    });
    const v2 = projectTask({
      generation: "v2",
      task: {
        taskId: "v2",
        status: "working",
        createdAt: "now",
        lastUpdatedAt: "now",
        ttlMs: null,
        pollIntervalMs: 9,
      },
    });
    expect(v1).toMatchObject({
      retentionMs: 42,
      ttl: 42,
      suggestedPollIntervalMs: 7,
      pollInterval: 7,
    });
    expect(v2).toMatchObject({
      retentionMs: null,
      ttl: null,
      suggestedPollIntervalMs: 9,
      pollInterval: 9,
    });
    expect(taskViewFromExecutionEvent({ type: "task", task: v1 })).toBe(v1);
    expect(
      taskViewFromExecutionEvent({
        type: "outcome",
        outcome: { status: "completed", result: 3, task: v2 },
      }),
    ).toBe(v2);
    expect(resultFromTaskOutcome({ status: "completed", result: 3 })).toBe(3);
    const failure = new TaskFailedError("failed", {
      code: 7,
      data: { why: true },
    });
    expect(() =>
      resultFromTaskOutcome({ status: "failed", error: failure }),
    ).toThrow(failure);
    expect(() => resultFromTaskOutcome({ status: "cancelled" })).toThrow(
      TaskCancelledError,
    );
  });

  it("routes typed application callbacks and adds task metadata", async () => {
    const seen: unknown[] = [];
    const handler = createApplicationInputHandler<{ trace: string }>({
      elicitation: (request, context) => {
        seen.push({ request, context });
        return { action: "accept", content: { ok: true } };
      },
      sampling: () => ({
        model: "test",
        role: "assistant",
        content: { type: "text", text: "sampled" },
      }),
      roots: () => ({ roots: [{ uri: "file:///tmp" }] }),
    });
    const result = await handler(
      {
        kind: "elicitation",
        params: { _meta: { trace: "kept" }, message: "continue?" },
      },
      {
        scope: "task",
        delivery: "task-update",
        taskId: taskId("task-input"),
        applicationContext: { trace: "ctx" },
      },
    );
    expect(result).toEqual({ action: "accept", content: { ok: true } });
    expect(seen).toEqual([
      {
        request: {
          kind: "elicitation",
          params: {
            message: "continue?",
            _meta: {
              trace: "kept",
              "io.modelcontextprotocol/related-task": { taskId: "task-input" },
            },
          },
        },
        context: {
          scope: "task",
          delivery: "task-update",
          taskId: "task-input",
          applicationContext: { trace: "ctx" },
        },
      },
    ]);
    await expect(
      handler(
        { kind: "roots" },
        {
          scope: "request",
          delivery: "peer-request",
          inputId: "roots-1",
          applicationContext: { trace: "ctx" },
        },
      ),
    ).resolves.toEqual({ roots: [{ uri: "file:///tmp" }] });
  });
});
