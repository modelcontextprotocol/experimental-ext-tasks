import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type ClientContext,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { type JsonValue } from "../core/index.js";
import { createSessionPortFromClient, withTasks } from "./index.js";

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

describe("Client adapter", () => {
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
    expect(
      createSessionPortFromClient(modern, "modern").taskCapabilities,
    ).toEqual({ generation: "v2", capabilities: {} });
    const absent = client();
    vi.spyOn(absent, "getProtocolEra").mockReturnValue("modern");
    vi.spyOn(absent, "getServerCapabilities").mockReturnValue({
      extensions: {},
    });
    expect(
      createSessionPortFromClient(absent, "none").taskCapabilities,
    ).toEqual({ generation: "none" });
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
    const session = withTasks(foreign as unknown as Client, {
      endpointId: "foreign-client",
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("x");
    await expect(execution.result()).resolves.toEqual({ content: [] });
    expect(foreign.request).toHaveBeenCalled();
    await session.close();
  });

  it("supports Client sessions through withTasks and restores callbacks", async () => {
    const sdk = client();
    const request = vi.spyOn(sdk, "request").mockResolvedValue({ content: [] });
    const prior = vi.fn(() => Promise.resolve({ prior: true }));
    sdk.fallbackRequestHandler = prior;
    const session = withTasks(sdk, {
      endpointId: "raw-client",
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("x");
    await expect(execution.result()).resolves.toEqual({ content: [] });
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
    const session = withTasks(sdk, {
      endpointId: "close-failure",
      signal: controller.signal,
      tools: { currentTool: () => undefined },
    });
    await expect(session.close()).rejects.toBe(sentinel);
    await expect(session.close()).rejects.toBe(sentinel);
    expect(sdk.fallbackRequestHandler).toBe(prior);
    const replacement = createSessionPortFromClient(sdk, "close-failure");
    replacement[Symbol.dispose]();
  });
});
