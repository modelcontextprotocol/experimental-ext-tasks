import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTaskReceiver } from "./index.js";

type Handler = (request: unknown) => Promise<unknown>;
type NotificationInput = { method: string; params: Record<string, unknown> };

class Host {
  readonly _requestHandlers = new Map<string, Handler>();
  readonly notificationInputs: NotificationInput[] = [];
  readonly wireNotifications: Array<NotificationInput & { jsonrpc: "2.0" }> =
    [];
  readonly notification = vi.fn((notification: NotificationInput) => {
    this.notificationInputs.push(notification);
    this.wireNotifications.push({ jsonrpc: "2.0", ...notification });
    return Promise.resolve();
  });

  setRequestHandler(method: string, handler: Handler): void {
    this._requestHandlers.set(method, handler);
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const handler = this._requestHandlers.get(method);
    if (!handler) throw new Error(`Missing handler ${method}`);
    return Promise.resolve().then(() => handler({ method, params }));
  }
}

class ValidatingHost extends Host {
  readonly validatingCalls: string[] = [];

  override setRequestHandler(method: string, handler: Handler): void {
    const validating: Handler = async (request) => {
      this.validatingCalls.push(method);
      const result = await handler(request);
      if (result !== null && typeof result === "object" && "task" in result)
        throw new Error(
          `SDK result validation rejected task result for ${method}`,
        );
      return result;
    };
    this._requestHandlers.set(method, validating);
  }
}

function asClient(host: Host): Client {
  // The fake implements exactly the Client runtime members used by the binding;
  // constructing a real Client would couple these unit tests to a transport.
  return host as unknown as Client;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  vi.useRealTimers();
});

describe("bindTaskReceiver", () => {
  it("validates duration, page, and retention options", () => {
    for (const [option, value] of [
      ["ttlMs", -1],
      ["ttlMs", 1.5],
      ["pollIntervalMs", -1],
      ["pollIntervalMs", 1.5],
      ["pageSize", 0],
      ["pageSize", 1.5],
      ["maxTasks", 0],
      ["maxTasks", 1.5],
    ] as const) {
      const host = new Host();
      expect(() =>
        bindTaskReceiver(asClient(host), {
          methods: {},
          [option]: value,
        }),
      ).toThrow(option);
    }
    expect(() =>
      bindTaskReceiver(asClient(new Host()), {
        methods: {},
        ttlMs: null,
        pollIntervalMs: null,
      }),
    ).not.toThrow();
  });

  it("samples a TTL function separately for each task and expires from each creation", async () => {
    vi.useFakeTimers();
    const host = new Host();
    const ttlMs = vi.fn().mockReturnValueOnce(5).mockReturnValueOnce(10);
    let id = 0;
    bindTaskReceiver(asClient(host), {
      methods: { "sampling/createMessage": true },
      ttlMs,
      sampling: () => new Promise<Record<string, never>>(() => undefined),
      createTaskId: () => `sampled-${String(++id)}`,
    });

    await expect(host.call("sampling/createMessage")).resolves.toMatchObject({
      task: { taskId: "sampled-1", ttl: 5 },
    });
    await expect(host.call("sampling/createMessage")).resolves.toMatchObject({
      task: { taskId: "sampled-2", ttl: 10 },
    });
    expect(ttlMs).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5);
    await expect(
      host.call("tasks/get", { taskId: "sampled-1" }),
    ).rejects.toThrow("expired");
    await expect(
      host.call("tasks/get", { taskId: "sampled-2" }),
    ).resolves.toMatchObject({ ttl: 10 });
    await vi.advanceTimersByTimeAsync(5);
    await expect(
      host.call("tasks/get", { taskId: "sampled-2" }),
    ).rejects.toThrow("expired");
  });

  it("advertises and installs only enabled request methods", () => {
    const host = new Host();
    const binding = bindTaskReceiver(asClient(host), {
      methods: { "sampling/createMessage": true },
      sampling: () => Promise.resolve({ role: "assistant" }),
    });
    expect(binding.capabilities.requests).toEqual({
      sampling: { createMessage: {} },
    });
    expect(host._requestHandlers.has("elicitation/create")).toBe(false);
    for (const method of [
      "tasks/list",
      "tasks/get",
      "tasks/result",
      "tasks/cancel",
    ])
      expect(host._requestHandlers.has(method)).toBe(true);
    binding.close();
  });

  for (const { method, option, ordinaryResult } of [
    {
      method: "sampling/createMessage",
      option: "sampling",
      ordinaryResult: {
        role: "assistant",
        content: { type: "text", text: "ok" },
      },
    },
    {
      method: "elicitation/create",
      option: "elicitation",
      ordinaryResult: { action: "accept", content: { answer: "ok" } },
    },
  ] as const) {
    it(`bypasses SDK result validation only for task-augmented ${method}`, async () => {
      const host = new ValidatingHost();
      const previous = vi.fn(() => Promise.resolve(ordinaryResult));
      host._requestHandlers.set(method, previous);
      const callback = vi.fn(() => Promise.resolve({ completed: true }));
      const binding = bindTaskReceiver(asClient(host), {
        methods: { [method]: true },
        [option]: callback,
        createTaskId: () => `${option}-task`,
      });

      await expect(
        host.call(method, { task: { ttl: null } }),
      ).resolves.toMatchObject({ task: { taskId: `${option}-task` } });
      expect(host.validatingCalls).toEqual([]);

      await expect(host.call(method)).resolves.toEqual(ordinaryResult);
      expect(previous).toHaveBeenCalledOnce();
      expect(host.validatingCalls).toEqual([method]);

      const installed = host._requestHandlers.get(method);
      expect(installed).toBeDefined();
      binding.close();
      expect(host._requestHandlers.get(method)).toBe(previous);
      if (installed)
        await expect(
          installed({ method, params: { task: { ttl: null } } }),
        ).rejects.toThrow("closed");
    });
  }

  it("normalizes params before callback and rejects non-JSON params before allocation", async () => {
    const host = new Host();
    const sampling = vi.fn(() => Promise.resolve({ ok: true }));
    bindTaskReceiver(asClient(host), {
      methods: { "sampling/createMessage": true },
      sampling,
      createTaskId: () => "json-task",
    });
    await host.call("sampling/createMessage", {
      keep: 1,
      omit: undefined,
      nested: { toJSON: () => ({ projected: true }) },
    });
    expect(sampling).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { keep: 1, nested: { projected: true } },
      }),
      expect.any(Object),
    );
    await expect(
      host.call("sampling/createMessage", { invalid: 1n }),
    ).rejects.toThrow("serialized as JSON");
    await expect(host.call("tasks/list")).resolves.toMatchObject({
      tasks: [expect.objectContaining({ taskId: "json-task" })],
    });
  });

  it("creates, completes, emits SDK notification input, and returns payloads", async () => {
    const host = new Host();
    const binding = bindTaskReceiver(asClient(host), {
      methods: { "sampling/createMessage": true },
      ttlMs: 5_000,
      pollIntervalMs: 5,
      sampling: (request) =>
        Promise.resolve({ echo: request.params.prompt ?? null }),
      createTaskId: () => "task-1",
    });
    await expect(
      host.call("sampling/createMessage", { prompt: "hi", task: {} }),
    ).resolves.toMatchObject({
      task: {
        taskId: "task-1",
        status: "input_required",
        ttl: 5_000,
        pollInterval: 5,
      },
    });
    await flush();
    await expect(
      host.call("tasks/result", { taskId: "task-1" }),
    ).resolves.toEqual({ echo: "hi" });
    expect(host.notificationInputs).toHaveLength(1);
    expect(host.notificationInputs[0]?.method).toBe(
      "notifications/tasks/status",
    );
    expect(host.notificationInputs[0]?.params).toMatchObject({
      taskId: "task-1",
      status: "completed",
    });
    expect(host.notificationInputs[0]).not.toHaveProperty("jsonrpc");
    expect(host.wireNotifications[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "notifications/tasks/status",
    });
    binding.close();
  });

  it("does not block transitions on notification and reports notification failures", async () => {
    const host = new Host();
    const notification = deferred<undefined>();
    host.notification.mockImplementationOnce(() => notification.promise);
    const onError = vi.fn();
    bindTaskReceiver(asClient(host), {
      methods: { "sampling/createMessage": true },
      sampling: () => Promise.resolve({ ok: true }),
      createTaskId: () => "notify-task",
      onError,
    });
    await host.call("sampling/createMessage");
    await flush();
    await expect(
      host.call("tasks/result", { taskId: "notify-task" }),
    ).resolves.toEqual({ ok: true });
    notification.reject(new Error("send failed"));
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      method: "sampling/createMessage",
      taskId: "notify-task",
    });
  });

  it("expires from creation, aborts pending callbacks, rejects payloads, and removes tasks", async () => {
    vi.useFakeTimers();
    const host = new Host();
    let signal: AbortSignal | undefined;
    const work = deferred<Record<string, never>>();
    const onError = vi.fn();
    bindTaskReceiver(asClient(host), {
      methods: { "elicitation/create": true },
      ttlMs: 10,
      elicitation: (_request, context) => {
        signal = context.signal;
        return work.promise;
      },
      createTaskId: () => "expiring",
      onError,
    });
    await host.call("elicitation/create");
    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(true);
    await expect(
      host.call("tasks/get", { taskId: "expiring" }),
    ).rejects.toThrow("expired");
    await expect(host.call("tasks/list")).resolves.toEqual({ tasks: [] });
    work.reject(new Error("stopped after expiry"));
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      method: "elicitation/create",
      taskId: "expiring",
      lateAfter: "expiry",
    });
  });

  it("creates elicitation tasks as input_required while callback input is outstanding", async () => {
    const host = new Host();
    const work = deferred<{ action: string }>();
    bindTaskReceiver(asClient(host), {
      methods: { "elicitation/create": true },
      elicitation: () => work.promise,
      createTaskId: () => "elicitation-task",
    });

    await expect(
      host.call("elicitation/create", { message: "Confirm" }),
    ).resolves.toMatchObject({
      task: { taskId: "elicitation-task", status: "input_required" },
    });
    await expect(
      host.call("tasks/get", { taskId: "elicitation-task" }),
    ).resolves.toMatchObject({ status: "input_required" });

    work.resolve({ action: "accept" });
    await flush();
    await expect(
      host.call("tasks/result", { taskId: "elicitation-task" }),
    ).resolves.toEqual({ action: "accept" });
  });

  it("makes accepted cancellation win over late success and reports late failure", async () => {
    const host = new Host();
    const first = deferred<Record<string, boolean>>();
    const second = deferred<Record<string, boolean>>();
    const work = [first, second];
    const onError = vi.fn();
    let workIndex = 0;
    let taskId = 0;
    bindTaskReceiver(asClient(host), {
      methods: { "sampling/createMessage": true },
      sampling: () => work[workIndex++].promise,
      createTaskId: () => `cancel-${String(++taskId)}`,
      onError,
    });
    await host.call("sampling/createMessage");
    await expect(
      host.call("tasks/cancel", { taskId: "cancel-1" }),
    ).resolves.toMatchObject({ status: "cancelled" });
    first.resolve({ ignored: true });
    await flush();
    await expect(
      host.call("tasks/get", { taskId: "cancel-1" }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(host.notificationInputs).toHaveLength(1);

    await host.call("sampling/createMessage");
    await host.call("tasks/cancel", { taskId: "cancel-2" });
    second.reject(new Error("late callback failure"));
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      method: "sampling/createMessage",
      taskId: "cancel-2",
      lateAfter: "cancel",
    });
  });

  it("paginates retained tasks stably and rejects invalid or stale cursors", async () => {
    vi.useFakeTimers();
    const host = new Host();
    let id = 0;
    bindTaskReceiver(asClient(host), {
      methods: { "sampling/createMessage": true },
      sampling: () => Promise.resolve({ ok: true }),
      createTaskId: () => `task-${String(++id)}`,
      pageSize: 2,
      ttlMs: 20,
    });
    await host.call("sampling/createMessage");
    await vi.advanceTimersByTimeAsync(1);
    await host.call("sampling/createMessage");
    await vi.advanceTimersByTimeAsync(1);
    await host.call("sampling/createMessage");
    const first = (await host.call("tasks/list")) as {
      tasks: Array<{ taskId: string }>;
      nextCursor?: string;
    };
    expect(first.tasks.map((task) => task.taskId)).toEqual([
      "task-1",
      "task-2",
    ]);
    expect(first.nextCursor).toBe("task-2");
    await expect(
      host.call("tasks/list", { cursor: first.nextCursor }),
    ).resolves.toMatchObject({ tasks: [{ taskId: "task-3" }] });
    await expect(
      host.call("tasks/list", { cursor: "missing" }),
    ).rejects.toThrow("Invalid or stale");
    await vi.advanceTimersByTimeAsync(18);
    await expect(host.call("tasks/list", { cursor: "task-1" })).rejects.toThrow(
      "Invalid or stale",
    );
  });

  it("rejects new work deterministically at maxTasks and accepts it after expiry", async () => {
    vi.useFakeTimers();
    const host = new Host();
    let id = 0;
    bindTaskReceiver(asClient(host), {
      methods: { "sampling/createMessage": true },
      sampling: () => Promise.resolve({ ok: true }),
      createTaskId: () => `capacity-${String(++id)}`,
      maxTasks: 1,
      ttlMs: 5,
    });
    await host.call("sampling/createMessage");
    await expect(host.call("sampling/createMessage")).rejects.toThrow(
      "capacity of 1",
    );
    await vi.advanceTimersByTimeAsync(5);
    await expect(host.call("sampling/createMessage")).resolves.toMatchObject({
      task: { taskId: "capacity-2" },
    });
  });

  it("guards every installed handler after close and restores only its own handlers", async () => {
    const host = new Host();
    const previous = vi.fn(() => Promise.resolve({ previous: true }));
    host._requestHandlers.set("tasks/get", previous);
    const binding = bindTaskReceiver(asClient(host), { methods: {} });
    const captured = [...host._requestHandlers.values()];
    const replacement = vi.fn(() => Promise.resolve({ replacement: true }));
    host._requestHandlers.set("tasks/list", replacement);
    binding.close();
    expect(host._requestHandlers.get("tasks/get")).toBe(previous);
    expect(host._requestHandlers.get("tasks/list")).toBe(replacement);
    for (const handler of captured)
      await expect(handler({ params: {} })).rejects.toThrow("closed");
  });
});
