import { describe, expect, it, vi } from "vitest";
import { type ToolV1 } from "../core/v1/index.js";
import { DispatchError, withTasks, type JsonRpcResponse } from "./index.js";
import {
  FakePort,
  asJson,
  formatJson,
  expectRecord,
} from "../../test-support/client/fake-port.js";

describe("declarations and capabilities", () => {
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
          () => {
            reject(new DOMException("discovery aborted", "AbortError"));
          },
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
          () => {
            reject(new DOMException("closed", "AbortError"));
          },
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
});
