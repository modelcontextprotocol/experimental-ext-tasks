import { describe, expect, it } from "vitest";
import { ProtocolDecodeError, taskId } from "../core/index.js";
import {
  TaskCancellationUnsupportedError,
  TaskCancelledError,
  TaskFailedError,
  TaskInputUpdateUnsupportedError,
  withTasks,
} from "./index.js";
import {
  FakePort,
  asJson,
  expectRecord,
} from "../../test-support/client/fake-port.js";

const v1Task = {
  taskId: "manual-v1",
  status: "completed",
  createdAt: "a",
  lastUpdatedAt: "b",
  ttl: null,
} as const;

const v2CompletedTask = {
  resultType: "complete",
  taskId: "manual-v2",
  status: "completed",
  createdAt: "a",
  lastUpdatedAt: "b",
  ttlMs: null,
  result: { resultType: "complete", content: [] },
} as const;

const tools = { currentTool: () => undefined };

function methods(port: FakePort): unknown[] {
  return port.requests.map((request) => expectRecord(request).method);
}

describe("manual task controller", () => {
  it("uses V1 get, result, and cancel requests and preserves headers", async () => {
    const port = new FakePort({
      generation: "v1",
      capabilities: { requests: { tools: { call: {} } }, cancel: {} },
    });
    port.dispatchHandler = (request) => {
      const method = expectRecord(request).method;
      if (method === "tasks/result")
        return Promise.resolve({ kind: "result", result: { content: [] } });
      return Promise.resolve({ kind: "result", result: asJson(v1Task) });
    };
    const session = withTasks(port, { tools });
    const controller = session.task(taskId("manual-v1"), {
      headers: { authorization: "Bearer test" },
    });

    await expect(controller.snapshot()).resolves.toMatchObject({
      taskId: "manual-v1",
      status: "completed",
      retentionMs: null,
      createdAt: "a",
      lastUpdatedAt: "b",
    });
    await expect(legacyResult(controller)).resolves.toEqual({ content: [] });
    await expect(controller.cancel()).resolves.toBeUndefined();
    expect(methods(port)).toEqual([
      "tasks/get",
      "tasks/result",
      "tasks/cancel",
    ]);
    for (const dispatchOptions of port.dispatchOptions) {
      expect(dispatchOptions?.signal).toBeDefined();
      expect(dispatchOptions?.signal?.aborted).toBe(false);
      expect(dispatchOptions?.context).toEqual({
        headers: { authorization: "Bearer test" },
      });
    }
    await session.close();
  });

  it("uses V2 envelopes for get, decoded result, cancel, and input update", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = (request) => {
      const method = expectRecord(request).method;
      return Promise.resolve(
        method === "tasks/get"
          ? { kind: "result", result: asJson(v2CompletedTask) }
          : { kind: "result", result: { resultType: "complete" } },
      );
    };
    const session = withTasks(port, { tools });
    const controller = session.task(taskId("manual-v2"));

    await expect(controller.snapshot()).resolves.toMatchObject({
      taskId: "manual-v2",
      status: "completed",
      retentionMs: null,
      createdAt: "a",
      lastUpdatedAt: "b",
    });
    await expect(legacyResult(controller)).resolves.toEqual({
      resultType: "complete",
      content: [],
    });
    await expect(controller.cancel()).resolves.toBeUndefined();
    await expect(
      controller.update({ prompt: { action: "cancel" } }),
    ).resolves.toBeUndefined();
    expect(methods(port)).toEqual([
      "tasks/get",
      "tasks/get",
      "tasks/cancel",
      "tasks/update",
    ]);
    for (const request of port.requests) {
      const params = expectRecord(expectRecord(request).params);
      expect(params).toMatchObject({
        taskId: "manual-v2",
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      });
    }
    expect(
      expectRecord(expectRecord(port.requests[3]).params).inputResponses,
    ).toEqual({ prompt: { action: "cancel" } });
    await session.close();
  });

  it("normalizes unknown JSON input responses before dispatch", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.response = { kind: "result", result: { resultType: "complete" } };
    const session = withTasks(port, { tools });
    const controller = session.task(taskId("json-update"));
    await expect(
      controller.updateJson({ prompt: { action: "cancel" } }),
    ).resolves.toBeUndefined();
    expect(
      expectRecord(expectRecord(port.requests[0]).params).inputResponses,
    ).toEqual({ prompt: { action: "cancel" } });
    await expect(
      controller.updateJson({ prompt: { action: "not-valid" } }),
    ).rejects.toBeInstanceOf(ProtocolDecodeError);
    expect(port.requests).toHaveLength(1);
    await session.close();
  });

  it("preserves unknown-task JSON-RPC errors without retrying", async () => {
    const error = {
      code: -32001,
      message: "Unknown task",
      data: { taskId: "missing" },
    };
    for (const generation of ["v1", "v2"] as const) {
      const port = new FakePort(
        generation === "v1"
          ? { generation, capabilities: { requests: { tools: { call: {} } } } }
          : { generation, capabilities: {} },
      );
      port.response = { kind: "error", error };
      const session = withTasks(port, { tools });

      await expect(
        session.task(taskId("missing")).snapshot(),
      ).rejects.toMatchObject({
        name: "JsonRpcResponseError",
        ...error,
      });
      expect(methods(port)).toEqual(["tasks/get"]);
      await session.close();
    }
  });

  it("checks generation and operation usability before decoding JSON updates", async () => {
    const v1Port = new FakePort({
      generation: "v1",
      capabilities: { requests: { tools: { call: {} } } },
    });
    const v1Session = withTasks(v1Port, { tools });
    await expect(
      v1Session.task(taskId("v1-json-update")).updateJson({ invalid: true }),
    ).rejects.toBeInstanceOf(TaskInputUpdateUnsupportedError);
    await v1Session.close();

    const abortedPort = new FakePort({ generation: "v2", capabilities: {} });
    const abortedSession = withTasks(abortedPort, { tools });
    const caller = new AbortController();
    const reason = new Error("caller stopped");
    caller.abort(reason);
    await expect(
      abortedSession
        .task(taskId("aborted-json-update"))
        .updateJson({ invalid: true }, caller.signal),
    ).rejects.toBe(reason);
    expect(abortedPort.requests).toHaveLength(0);
    await abortedSession.close();

    const closedPort = new FakePort({ generation: "v2", capabilities: {} });
    const closedSession = withTasks(closedPort, { tools });
    const controller = closedSession.task(taskId("closed-json-update"));
    await closedSession.close();
    await expect(controller.updateJson({ invalid: true })).rejects.toThrow(
      "closed",
    );
    expect(closedPort.requests).toHaveLength(0);
  });

  it("decodes V1 results with a custom result codec", async () => {
    const port = new FakePort({
      generation: "v1",
      capabilities: { requests: { tools: { call: {} } } },
    });
    port.response = { kind: "result", result: { custom: "v1" } };
    const session = withTasks(port, { tools });

    await expect(
      session.task(taskId("custom-v1")).result({
        resultCodec: {
          parse: (value) => ({
            success: true,
            value: expectRecord(value).custom,
          }),
        },
      }),
    ).resolves.toEqual({ status: "completed", result: "v1" });
    await session.close();
  });

  it("decodes V2 terminal results with a custom result codec", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.response = {
      kind: "result",
      result: asJson({
        ...v2CompletedTask,
        taskId: "custom-v2",
        result: { custom: "v2" },
      }),
    };
    const session = withTasks(port, { tools });

    await expect(
      session.task(taskId("custom-v2")).result({
        resultCodec: {
          parse: (value) => ({
            success: true,
            value: expectRecord(value).custom,
          }),
        },
      }),
    ).resolves.toMatchObject({ status: "completed", result: "v2" });
    await session.close();
  });

  it("propagates custom result codec errors for V1 and V2", async () => {
    for (const generation of ["v1", "v2"] as const) {
      const port =
        generation === "v1"
          ? new FakePort({
              generation,
              capabilities: { requests: { tools: { call: {} } } },
            })
          : new FakePort({ generation, capabilities: {} });
      port.response =
        generation === "v1"
          ? { kind: "result", result: { custom: generation } }
          : {
              kind: "result",
              result: asJson({
                ...v2CompletedTask,
                taskId: `failing-${generation}`,
                result: { custom: generation },
              }),
            };
      const codecError = new ProtocolDecodeError(`${generation} codec failed`);
      const session = withTasks(port, { tools });

      const outcome = await session
        .task(taskId(`failing-${generation}`))
        .result({
          resultCodec: {
            parse: () => ({ success: false, error: codecError }),
          },
        });
      expect(outcome).toMatchObject({
        status: "failed",
        error: {
          name: "TaskFailedError",
          message: `${generation} codec failed`,
        },
      });
      if (outcome.status === "failed")
        expect(outcome.error.cause).toBe(codecError);
      await session.close();
    }
  });

  it("reports unsupported session, V1 update, and V1 cancellation explicitly", async () => {
    const plain = withTasks(new FakePort(), { tools });
    expect(() => plain.task(taskId("none"))).toThrow(
      "Task management is not supported by this session",
    );
    await plain.close();

    const port = new FakePort({
      generation: "v1",
      capabilities: { requests: { tools: { call: {} } } },
    });
    const session = withTasks(port, { tools });
    const controller = session.task(taskId("v1"));
    await expect(controller.update({})).rejects.toBeInstanceOf(
      TaskInputUpdateUnsupportedError,
    );
    await expect(controller.cancel()).rejects.toBeInstanceOf(
      TaskCancellationUnsupportedError,
    );
    expect(port.requests).toHaveLength(0);
    await session.close();
  });

  it("polls through input-required and working V2 states without handling input", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    const statuses = ["input_required", "working", "completed"] as const;
    let getCalls = 0;
    port.dispatchHandler = () => {
      const status = statuses[getCalls++] ?? "completed";
      return Promise.resolve({
        kind: "result",
        result: asJson({
          resultType: "complete",
          taskId: "polling",
          status,
          createdAt: "a",
          lastUpdatedAt: String(getCalls),
          ttlMs: null,
          pollIntervalMs: 0,
          ...(status === "input_required"
            ? { inputRequests: { prompt: { method: "roots/list" } } }
            : {}),
          ...(status === "completed"
            ? { result: { resultType: "complete", content: [] } }
            : {}),
        }),
      });
    };
    const session = withTasks(port, { tools });

    await expect(
      legacyResult(session.task(taskId("polling"))),
    ).resolves.toEqual({
      resultType: "complete",
      content: [],
    });
    expect(methods(port)).toEqual(["tasks/get", "tasks/get", "tasks/get"]);
    await session.close();
  });

  it("surfaces neutral failed and cancelled V2 terminal outcomes", async () => {
    for (const terminal of [
      {
        status: "failed",
        error: { code: -32000, message: "task failed", data: { retry: false } },
      },
      { status: "cancelled" },
    ] as const) {
      const port = new FakePort({ generation: "v2", capabilities: {} });
      port.response = {
        kind: "result",
        result: asJson({
          resultType: "complete",
          taskId: terminal.status,
          status: terminal.status,
          createdAt: "a",
          lastUpdatedAt: "b",
          ttlMs: null,
          ...(terminal.status === "failed" ? { error: terminal.error } : {}),
        }),
      };
      const session = withTasks(port, { tools });
      const outcome = await session.task(taskId(terminal.status)).result();
      if (terminal.status === "failed") {
        expect(outcome).toMatchObject({
          status: "failed",
          error: {
            name: "TaskFailedError",
            message: "task failed",
            code: -32000,
            data: { retry: false },
          },
        });
        if (outcome.status === "failed")
          expect(outcome.error).toBeInstanceOf(TaskFailedError);
      } else {
        expect(outcome.status).toBe("cancelled");
        const legacy = legacyResult(session.task(taskId(terminal.status)));
        await expect(legacy).rejects.toBeInstanceOf(TaskCancelledError);
      }
      await session.close();
    }
  });

  it("propagates caller aborts before and during dispatch", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    const session = withTasks(port, { tools });
    const controller = session.task(taskId("abort"));
    const before = new AbortController();
    before.abort(new Error("before dispatch"));
    await expect(controller.snapshot(before.signal)).rejects.toThrow(
      "before dispatch",
    );
    expect(port.requests).toHaveLength(0);

    const during = new AbortController();
    let dispatchedSignal: AbortSignal | undefined;
    port.dispatchHandler = (_request, options) => {
      dispatchedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            reject(
              options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("dispatch aborted"),
            );
          },
          { once: true },
        );
      });
    };
    const pending = controller.snapshot(during.signal);
    await Promise.resolve();
    expect(dispatchedSignal).toBeDefined();
    expect(dispatchedSignal).not.toBe(during.signal);
    during.abort(new Error("during dispatch"));
    await expect(pending).rejects.toThrow("during dispatch");
    await session.close();
  });

  it("aborts in-flight operations and rejects late responses when the session closes", async () => {
    for (const settleAfterClose of [false, true]) {
      const port = new FakePort({ generation: "v2", capabilities: {} });
      let resolveDispatch: ((value: typeof port.response) => void) | undefined;
      port.dispatchHandler = (_request, options) =>
        new Promise((resolve, reject) => {
          resolveDispatch = resolve;
          if (!settleAfterClose)
            options?.signal?.addEventListener(
              "abort",
              () => {
                reject(
                  options.signal?.reason instanceof Error
                    ? options.signal.reason
                    : new Error("dispatch aborted"),
                );
              },
              { once: true },
            );
        });
      const session = withTasks(port, { tools });
      const pending = session.task(taskId("close")).snapshot();
      await Promise.resolve();
      await session.close();
      resolveDispatch?.({
        kind: "result",
        result: asJson(v2CompletedTask),
      });
      await expect(pending).rejects.toThrow("Task-enabled session is closed");
    }
  });

  it("does not acquire or weaken resumeTask recovery ownership", async () => {
    const port = new FakePort(
      { generation: "v2", capabilities: {} },
      "manual-endpoint",
    );
    port.response = { kind: "result", result: asJson(v2CompletedTask) };
    const session = withTasks(port, { tools });
    const controller = session.task(taskId("manual-v2"));
    expect(controller.capabilities).toMatchObject({
      inventory: "known-handles",
      inputResponses: true,
    });

    const execution = await session.resumeTask({
      endpointId: "manual-endpoint",
      generation: "v2",
      taskId: taskId("manual-v2"),
      originalOperation: "tools/call",
    });
    await expect(legacyResult(execution)).resolves.toEqual({
      resultType: "complete",
      content: [],
    });
    await execution.close();
    await session.close();
  });
});
import { legacyResult } from "../../test-support/client/semantic.js";
