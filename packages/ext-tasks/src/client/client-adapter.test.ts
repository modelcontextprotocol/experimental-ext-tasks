import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";
import type { ClientContext } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../core/index.js";
import type { ApplicationInputHandler } from "./index.js";
import {
  createSessionPortFromClient,
  createTaskSessionFromClient,
  toolDeclarationFromMcpTool,
  withTasks,
} from "./index.js";
import type {
  ClientSessionPortOptions,
  CreateTaskSessionFromClientOptions,
} from "./sdk-client-adapter.js";
import { ClientSessionPort } from "./sdk-client-adapter.js";

const client = () => new Client({ name: "test", version: "1" });
const context = {
  mcpReq: {
    id: 1,
    method: "custom/request",
    requestState: () => undefined,
    signal: new AbortController().signal,
    send: vi.fn(),
    notify: vi.fn(),
  },
} satisfies ClientContext;
const v2RequestFraming = {
  protocolVersion: "2026-07-28",
  clientInfo: { name: "test-client", version: "1.2.3" },
  clientCapabilities: {
    sampling: { tools: {} },
    extensions: { "example/other": { enabled: true } },
  },
} as const;

describe("Client adapter", () => {
  it("requires V2 raw dispatch and framing together at the type boundary", () => {
    const withoutRaw: ClientSessionPortOptions = {};
    const withRaw: ClientSessionPortOptions = {
      rawDispatch: vi.fn(),
      v2RequestFraming,
    };
    // @ts-expect-error -- raw dispatch without framing is not a valid adapter configuration.
    const missingFraming: ClientSessionPortOptions = { rawDispatch: vi.fn() };
    // @ts-expect-error -- framing without raw dispatch is not a valid adapter configuration.
    const missingDispatch: ClientSessionPortOptions = { v2RequestFraming };
    // @ts-expect-error -- the owned session factory also requires framing with raw dispatch.
    const ownedMissingFraming: CreateTaskSessionFromClientOptions = {
      endpointId: "owned",
      rawDispatch: vi.fn(),
    };
    // @ts-expect-error -- the owned session factory also requires raw dispatch with framing.
    const ownedMissingDispatch: CreateTaskSessionFromClientOptions = {
      endpointId: "owned",
      v2RequestFraming,
    };

    expect([
      withoutRaw,
      withRaw,
      missingFraming,
      missingDispatch,
      ownedMissingFraming,
      ownedMissingDispatch,
    ]).toHaveLength(6);
  });

  it("dispatches with an explicit schema and signal, preserving full protocol errors", async () => {
    const sdk = client();
    const request = vi.spyOn(sdk, "request");
    const port = createSessionPortFromClient(sdk, "endpoint-sdk");
    const controller = new AbortController();
    request.mockResolvedValueOnce({ ok: true });
    await expect(
      port.dispatch(
        { method: "custom/method", params: { value: 1 } },
        { signal: controller.signal },
      ),
    ).resolves.toEqual({ kind: "result", result: { ok: true } });
    const schema: unknown = request.mock.calls[0]?.[1];
    expect(schema).toBeTypeOf("object");
    expect(schema).toHaveProperty("~standard");
    expect(request.mock.calls[0]?.[2]).toEqual({ signal: controller.signal });
    request.mockRejectedValueOnce(
      new ProtocolError(-32001, "denied", { retry: false }),
    );
    await expect(port.dispatch({ method: "custom/method" })).resolves.toEqual({
      kind: "error",
      error: { code: -32001, message: "denied", data: { retry: false } },
    });
  });

  it("forwards headers and request timeout through SDK request options", async () => {
    const sdk = client();
    const request = vi
      .spyOn(sdk, "request")
      .mockResolvedValueOnce({ ok: true });
    const port = createSessionPortFromClient(sdk, "request-context");
    await port.dispatch(
      { method: "custom/method" },
      {
        context: {
          headers: { "x-trace": "trace-1" },
          requestTimeoutMs: 2_500,
        },
      },
    );
    expect(request.mock.calls[0]?.[2]).toEqual({
      headers: { "x-trace": "trace-1" },
      timeout: 2_500,
    });
  });

  it("allows manual input-required results only for tools/call", async () => {
    const sdk = client();
    const request = vi.spyOn(sdk, "request").mockResolvedValue({ ok: true });
    const port = createSessionPortFromClient(sdk, "manual-input-options");
    const controller = new AbortController();
    const options = {
      signal: controller.signal,
      context: { headers: { "x-trace": "trace-1" } },
    };

    await port.dispatch(
      { method: "tools/call", params: { name: "demo" } },
      options,
    );
    await port.dispatch({ method: "custom/method" }, options);

    expect(request.mock.calls[0]?.[2]).toEqual({
      allowInputRequired: true,
      signal: controller.signal,
      headers: { "x-trace": "trace-1" },
    });
    expect(request.mock.calls[1]?.[2]).toEqual({
      signal: controller.signal,
      headers: { "x-trace": "trace-1" },
    });
    port[Symbol.dispose]();
  });

  it("routes manual input-required results to the session handler and preserves cancellation", async () => {
    const sdk = client();
    const request = vi.spyOn(sdk, "request").mockResolvedValue({
      content: [],
      resultType: "input_required",
      requestState: "manual-state",
      inputRequests: {
        prompt: { method: "elicitation/create", params: { message: "Choose" } },
      },
    });
    const controller = new AbortController();
    const cancellation = new Error("caller cancelled");
    let inputSignal: AbortSignal | undefined;
    let markHandlerStarted: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const onInputRequest: ApplicationInputHandler["handle"] = async (
      input,
      inputContext,
    ) => {
      expect(input).toMatchObject({
        kind: "elicitation",
        params: { message: "Choose" },
      });
      inputSignal = inputContext.signal;
      markHandlerStarted();
      return new Promise<never>((_resolve, reject) => {
        inputContext.signal?.addEventListener(
          "abort",
          () => {
            reject(cancellation);
          },
          { once: true },
        );
      });
    };
    const session = createTaskSessionFromClient(sdk, {
      endpointId: "manual-input-session",
      signal: controller.signal,
      tools: { currentTool: () => undefined },
      onInputRequest,
    });
    const pending = session.callTool("demo");

    await handlerStarted;
    expect(request.mock.calls[0]?.[2]).toMatchObject({
      allowInputRequired: true,
    });
    expect(inputSignal).toBe(request.mock.calls[0]?.[2]?.signal);
    controller.abort(cancellation);
    await expect(pending).rejects.toBe(cancellation);
    expect(inputSignal?.aborted).toBe(true);
    await session.close();
  });

  it("routes V2 task traffic through raw dispatch before SDK validation", async () => {
    const sdk = client();
    vi.spyOn(sdk, "getProtocolEra").mockReturnValue("modern");
    vi.spyOn(sdk, "getServerCapabilities").mockReturnValue({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    const request = vi.spyOn(sdk, "request");
    const rawDispatch = vi.fn().mockResolvedValue({
      kind: "result",
      result: { resultType: "task", taskId: "task-1" },
    });
    const port = createSessionPortFromClient(sdk, "modern", {
      rawDispatch,
      v2RequestFraming,
    });
    const options = { context: { headers: { "x-trace": "trace-2" } } };
    await expect(
      port.dispatch(
        {
          method: "tools/call",
          params: {
            name: "x",
            _meta: {
              trace: "keep-me",
              "io.modelcontextprotocol/protocolVersion": "spoofed",
              "io.modelcontextprotocol/clientInfo": { name: "spoofed" },
              "io.modelcontextprotocol/clientCapabilities": { spoofed: true },
            },
          },
        },
        options,
      ),
    ).resolves.toEqual({
      kind: "result",
      result: { resultType: "task", taskId: "task-1" },
    });
    expect(rawDispatch).toHaveBeenCalledWith(
      {
        method: "tools/call",
        params: {
          name: "x",
          _meta: {
            trace: "keep-me",
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "test-client",
              version: "1.2.3",
            },
            "io.modelcontextprotocol/clientCapabilities": {
              sampling: { tools: {} },
              extensions: {
                "example/other": { enabled: true },
                "io.modelcontextprotocol/tasks": {},
              },
            },
          },
        },
      },
      options,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("copies V2 framing at creation and rejects malformed framing", async () => {
    const sdk = client();
    vi.spyOn(sdk, "getProtocolEra").mockReturnValue("modern");
    vi.spyOn(sdk, "getServerCapabilities").mockReturnValue({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    const mutable = {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "before" },
      clientCapabilities: { nested: { enabled: true } },
    };
    const rawDispatch = vi
      .fn()
      .mockResolvedValue({ kind: "result", result: {} });
    const port = createSessionPortFromClient(sdk, "frozen", {
      rawDispatch,
      v2RequestFraming: mutable,
    });
    mutable.clientInfo.name = "after";
    mutable.clientCapabilities.nested.enabled = false;
    await port.dispatch({ method: "tasks/get", params: { taskId: "x" } });
    expect(rawDispatch.mock.calls[0]?.[0]).toMatchObject({
      params: {
        _meta: {
          "io.modelcontextprotocol/clientInfo": { name: "before" },
          "io.modelcontextprotocol/clientCapabilities": {
            nested: { enabled: true },
          },
        },
      },
    });
    port[Symbol.dispose]();
    const malformed = client();
    vi.spyOn(malformed, "getProtocolEra").mockReturnValue("modern");
    vi.spyOn(malformed, "getServerCapabilities").mockReturnValue({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    expect(() =>
      createSessionPortFromClient(malformed, "malformed", {
        rawDispatch,
        v2RequestFraming: { ...v2RequestFraming, protocolVersion: "" },
      }),
    ).toThrow(/protocolVersion must be non-empty/);
  });

  it("fails V2 port construction before send when no raw coordinator exists", () => {
    const sdk = client();
    vi.spyOn(sdk, "getProtocolEra").mockReturnValue("modern");
    vi.spyOn(sdk, "getServerCapabilities").mockReturnValue({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    const request = vi.spyOn(sdk, "request");
    expect(() => createSessionPortFromClient(sdk, "modern")).toThrow(
      "requires options.rawDispatch and options.v2RequestFraming",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("wraps cancellation and local SDK failures as non-retryable DispatchError", async () => {
    const sdk = client();
    const request = vi.spyOn(sdk, "request");
    const port = createSessionPortFromClient(sdk, "endpoint-sdk");
    for (const failure of [
      new DOMException("cancelled", "AbortError"),
      new SdkError(SdkErrorCode.ConnectionClosed, "closed"),
    ]) {
      request.mockRejectedValueOnce(failure);
      await expect(
        port.dispatch({ method: "custom/method" }),
      ).rejects.toMatchObject({
        name: "DispatchError",
        retryable: false,
        cause: failure,
      });
    }
  });

  it("derives immutable legacy, modern, and absent task capabilities", () => {
    const legacy = client();
    const legacyCapabilities = { tasks: { cancel: {}, list: {} } };
    vi.spyOn(legacy, "getProtocolEra").mockReturnValue("legacy");
    vi.spyOn(legacy, "getServerCapabilities").mockReturnValue(
      legacyCapabilities,
    );
    const legacyPort = createSessionPortFromClient(legacy, "legacy");
    expect(legacyPort.endpointId).toBe("legacy");
    expect(legacyPort.taskCapabilities).toEqual({
      generation: "v1",
      capabilities: { cancel: {}, list: {} },
    });
    legacyCapabilities.tasks.cancel = { changed: true };
    expect(legacyPort.taskCapabilities).toEqual({
      generation: "v1",
      capabilities: { cancel: {}, list: {} },
    });
    const modern = client();
    vi.spyOn(modern, "getProtocolEra").mockReturnValue("modern");
    vi.spyOn(modern, "getServerCapabilities").mockReturnValue({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    expect(() => createSessionPortFromClient(modern, "modern")).toThrow(
      "requires options.rawDispatch",
    );
    const modernPort = createSessionPortFromClient(modern, "modern", {
      rawDispatch: async () => {
        await Promise.resolve();
        return { kind: "result", result: {} };
      },
      v2RequestFraming,
    });
    expect(modernPort.taskCapabilities).toEqual({
      generation: "v2",
      capabilities: {},
    });
    const absent = client();
    vi.spyOn(absent, "getProtocolEra").mockReturnValue("modern");
    vi.spyOn(absent, "getServerCapabilities").mockReturnValue({
      extensions: {},
    });
    expect(
      createSessionPortFromClient(absent, "none").taskCapabilities,
    ).toEqual({ generation: "none" });
    legacyPort[Symbol.dispose]();
    modernPort[Symbol.dispose]();
  });

  it("forwards inbound requests and settles results and full errors", async () => {
    const sdk = client();
    const port = createSessionPortFromClient(sdk, "endpoint-sdk");
    const disposeResult = port.onServerRequest((incoming) =>
      Promise.resolve({
        kind: "result",
        result: { echoed: incoming.request },
      }),
    );
    await expect(
      sdk.fallbackRequestHandler?.(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "elicitation/create",
          params: {},
        },
        context,
      ),
    ).resolves.toEqual({
      echoed: {
        jsonrpc: "2.0",
        id: 1,
        method: "elicitation/create",
        params: {},
      },
    });
    disposeResult();
    const disposeError = port.onServerRequest(() =>
      Promise.resolve({
        kind: "error",
        error: { code: -32002, message: "failed", data: { reason: "x" } },
      }),
    );
    await expect(
      sdk.fallbackRequestHandler?.(
        { jsonrpc: "2.0", id: 2, method: "elicitation/create", params: {} },
        context,
      ),
    ).rejects.toMatchObject({
      code: -32002,
      message: "failed",
      data: { reason: "x" },
    });
    disposeError();
  });

  it("preserves SDK input handlers alongside the Tasks fallback", () => {
    class InspectableClient extends Client {
      requestHandler(method: string): unknown {
        return this._getRequestHandler(method);
      }
    }

    const sdk = new InspectableClient(
      { name: "test", version: "1" },
      {
        capabilities: {
          elicitation: { form: {} },
          sampling: {},
        },
      },
    );
    sdk.setRequestHandler("elicitation/create", () => ({
      action: "accept",
    }));
    sdk.setRequestHandler("sampling/createMessage", () => ({
      model: "test-model",
      role: "assistant",
      content: { type: "text", text: "sampled" },
    }));
    const elicitationHandler = sdk.requestHandler("elicitation/create");
    const samplingHandler = sdk.requestHandler("sampling/createMessage");

    const port = createSessionPortFromClient(sdk, "coexisting-input");

    expect(sdk.requestHandler("elicitation/create")).toBe(elicitationHandler);
    expect(sdk.requestHandler("sampling/createMessage")).toBe(samplingHandler);
    expect(sdk.fallbackRequestHandler).toBeTypeOf("function");

    port[Symbol.dispose]();

    expect(sdk.requestHandler("elicitation/create")).toBe(elicitationHandler);
    expect(sdk.requestHandler("sampling/createMessage")).toBe(samplingHandler);
    expect(sdk.fallbackRequestHandler).toBeUndefined();
  });

  it("chains prior fallbacks, forwards notifications, invalidates on close, and cleans up", async () => {
    const sdk = client();
    const priorRequest = vi.fn(() => Promise.resolve({ prior: true }));
    const priorNotification = vi.fn(() => Promise.resolve());
    const priorClose = vi.fn();
    sdk.fallbackRequestHandler = priorRequest;
    sdk.fallbackNotificationHandler = priorNotification;
    sdk.onclose = priorClose;
    const port = createSessionPortFromClient(sdk, "endpoint-sdk");
    const installedRequest = sdk.fallbackRequestHandler;
    const installedNotification = sdk.fallbackNotificationHandler;
    const installedClose = sdk.onclose;
    const notifications: JsonValue[] = [];
    const invalidations: unknown[] = [];
    const removeNotification = port.onNotification((value) =>
      notifications.push(value),
    );
    const removeInvalidation = port.onInvalidated((reason) =>
      invalidations.push(reason),
    );
    await expect(
      installedRequest({ jsonrpc: "2.0", id: 1, method: "other" }, context),
    ).resolves.toEqual({ prior: true });
    await installedNotification({
      method: "custom/notification",
      params: { value: 1 },
    });
    expect(priorNotification).toHaveBeenCalledOnce();
    expect(notifications).toEqual([
      { method: "custom/notification", params: { value: 1 } },
    ]);
    removeNotification();
    await installedNotification({
      method: "custom/notification",
      params: { value: 2 },
    });
    expect(notifications).toHaveLength(1);
    installedClose();
    expect(priorClose).toHaveBeenCalledOnce();
    expect(port.invalidated).toBe(true);
    expect(invalidations).toHaveLength(1);
    removeInvalidation();
    port[Symbol.dispose]();
    expect(sdk.fallbackRequestHandler).toBe(priorRequest);
    expect(sdk.fallbackNotificationHandler).toBe(priorNotification);
    expect(sdk.onclose).toBe(priorClose);
  });

  it("does not overwrite callbacks installed after adaptation", () => {
    const sdk = client();
    const port = createSessionPortFromClient(sdk, "endpoint-sdk");
    const replacement = vi.fn(() => Promise.resolve({ replacement: true }));
    sdk.fallbackRequestHandler = replacement;
    port[Symbol.dispose]();
    expect(sdk.fallbackRequestHandler).toBe(replacement);
  });

  it("rejects concurrent adapters and permits reuse after disposal", () => {
    const sdk = client();
    const first = createSessionPortFromClient(sdk, "endpoint-sdk");
    expect(() => createSessionPortFromClient(sdk, "endpoint-sdk")).toThrow(
      "already active",
    );
    first[Symbol.dispose]();
    const replacement = createSessionPortFromClient(sdk, "endpoint-sdk");
    replacement[Symbol.dispose]();
  });

  it("accepts Client-compatible objects from another constructor", async () => {
    class ForeignClient {
      fallbackRequestHandler: Client["fallbackRequestHandler"];
      fallbackNotificationHandler: Client["fallbackNotificationHandler"];
      onclose: Client["onclose"];
      readonly request = vi.fn(() => Promise.resolve({ content: [] }));
      getProtocolEra(): ReturnType<Client["getProtocolEra"]> {
        return "legacy";
      }
      getServerCapabilities(): ReturnType<Client["getServerCapabilities"]> {
        return {};
      }
    }
    const foreign = new ForeignClient();
    const port = createSessionPortFromClient(
      foreign as unknown as Client,
      "foreign-client",
    );
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("x");
    await expect(legacyResult(execution)).resolves.toEqual({ content: [] });
    expect(foreign.request).toHaveBeenCalled();
    await session.close();
    port[Symbol.dispose]();
  });

  it("supports explicitly adapted Client sessions and restores callbacks", async () => {
    const sdk = client();
    const request = vi.spyOn(sdk, "request").mockResolvedValue({ content: [] });
    const prior = vi.fn(() => Promise.resolve({ prior: true }));
    sdk.fallbackRequestHandler = prior;
    const port = createSessionPortFromClient(sdk, "raw-client");
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("x");
    await expect(legacyResult(execution)).resolves.toEqual({ content: [] });
    expect(request).toHaveBeenCalledWith(
      { method: "tools/call", params: { name: "x" } },
      expect.any(Object),
      expect.any(Object),
    );
    await expect(
      sdk.fallbackRequestHandler(
        { jsonrpc: "2.0", id: 9, method: "custom/unrelated" },
        context,
      ),
    ).resolves.toEqual({ prior: true });
    expect(prior).toHaveBeenCalledWith(
      { jsonrpc: "2.0", id: 9, method: "custom/unrelated" },
      context,
    );
    await session.close();
    port[Symbol.dispose]();
    expect(sdk.fallbackRequestHandler).toBe(prior);
    expect(sdk.transport).toBeUndefined();
  });

  it("restores Client ownership when an earlier close disposer fails", async () => {
    const sdk = client();
    const prior = vi.fn(() => Promise.resolve({ prior: true }));
    sdk.fallbackRequestHandler = prior;
    const controller = new AbortController();
    const sentinel = new Error("listener cleanup failed");
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation(
      () => {
        throw sentinel;
      },
    );
    const port = createSessionPortFromClient(sdk, "close-failure");
    const errors: Error[] = [];
    const session = withTasks(port, {
      signal: controller.signal,
      tools: { currentTool: () => undefined },
      onError: (error) => errors.push(error),
    });
    const closing = session.close();
    await expect(closing).resolves.toBeUndefined();
    expect(session.close()).toBe(closing);
    expect(errors).toContain(sentinel);
    port[Symbol.dispose]();
    expect(sdk.fallbackRequestHandler).toBe(prior);
    const replacement = createSessionPortFromClient(sdk, "close-failure");
    replacement[Symbol.dispose]();
  });

  it("creates an owned session and restores Client callbacks on close failure", async () => {
    const sdk = client();
    const prior = vi.fn(() => Promise.resolve({ prior: true }));
    sdk.fallbackRequestHandler = prior;
    const controller = new AbortController();
    const sentinel = new Error("listener cleanup failed");
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation(
      () => {
        throw sentinel;
      },
    );
    const errors: Error[] = [];
    const session = createTaskSessionFromClient(sdk, {
      endpointId: "opaque:endpoint/value",
      signal: controller.signal,
      tools: { currentTool: () => undefined },
      onError: (error) => errors.push(error),
    });
    expect(session.endpointId).toBe("opaque:endpoint/value");
    const closing = session.close();
    await expect(closing).resolves.toBeUndefined();
    expect(session.close()).toBe(closing);
    expect(errors).toContain(sentinel);
    expect(sdk.fallbackRequestHandler).toBe(prior);
    const replacement = createSessionPortFromClient(sdk, "replacement");
    replacement[Symbol.dispose]();
  });

  it("forwards rawDispatch through the owned Client session", async () => {
    const sdk = client();
    vi.spyOn(sdk, "getProtocolEra").mockReturnValue("modern");
    vi.spyOn(sdk, "getServerCapabilities").mockReturnValue({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    const request = vi.spyOn(sdk, "request");
    const rawDispatch = vi.fn().mockResolvedValue({
      kind: "result",
      result: { resultType: "complete", content: [] },
    });
    const session = createTaskSessionFromClient(sdk, {
      endpointId: "modern-owned",
      rawDispatch,
      v2RequestFraming,
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("x");
    await expect(legacyResult(execution)).resolves.toEqual({
      resultType: "complete",
      content: [],
    });
    expect(rawDispatch.mock.calls[0]?.[0]).toEqual({
      method: "tools/call",
      params: {
        name: "x",
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "test-client",
            version: "1.2.3",
          },
          "io.modelcontextprotocol/clientCapabilities": {
            sampling: { tools: {} },
            extensions: {
              "example/other": { enabled: true },
              "io.modelcontextprotocol/tasks": {},
            },
          },
        },
      },
    });
    expect(request).not.toHaveBeenCalled();
    await session.close();
  });

  it("converts SDK tools with object schemas and preserved extensions", () => {
    const extendedTool = {
      name: "search",
      inputSchema: {
        type: "object" as const,
        properties: { query: { type: "string" } },
      },
      _meta: { source: "server" },
      execution: {
        taskSupport: "required" as const,
        vendorExecution: { queue: "batch" },
      },
      vendorFlag: { enabled: true },
    };
    expect(toolDeclarationFromMcpTool(extendedTool)).toEqual({
      name: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      metadata: { source: "server" },
      taskSupport: "required",
      executionExtensions: { vendorExecution: { queue: "batch" } },
      extensions: { vendorFlag: { enabled: true } },
    });
    expect(() =>
      toolDeclarationFromMcpTool({ name: "bad", inputSchema: true } as never),
    ).toThrow(/inputSchema must be a JSON object/);
  });

  it("disposes the Client adapter when owned session construction fails", () => {
    const sdk = client();
    const prior = vi.fn(() => Promise.resolve({ prior: true }));
    sdk.fallbackRequestHandler = prior;
    const sentinel = new Error("session construction failed");
    const registration = vi
      .spyOn(ClientSessionPort.prototype, "onServerRequest")
      .mockImplementationOnce(() => {
        throw sentinel;
      });
    expect(() =>
      createTaskSessionFromClient(sdk, {
        endpointId: "construction-failure",
        tools: { currentTool: () => undefined },
      }),
    ).toThrow(sentinel);
    registration.mockRestore();
    expect(sdk.fallbackRequestHandler).toBe(prior);
    const replacement = createSessionPortFromClient(sdk, "replacement");
    replacement[Symbol.dispose]();
  });
});
import { legacyResult } from "../../test-support/client/semantic.js";
