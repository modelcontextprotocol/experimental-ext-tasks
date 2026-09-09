import { describe, expect, it, vi } from "vitest";
import { taskId } from "../core/index.js";
import { withTasks } from "./index.js";
import { FakePort, asJson } from "../../test-support/client/fake-port.js";

const task = (id: string, status = "working") => ({
  taskId: id,
  status,
  createdAt: "2026-01-01T00:00:00Z",
  lastUpdatedAt: "2026-01-01T00:00:00Z",
  ttl: 1_000,
});

describe("task session facade", () => {
  it("owns immediate call registration and settlement", async () => {
    const port = new FakePort();
    port.response = { kind: "result", result: { content: [] } };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });

    await expect(session.callToolAndSettle("echo")).resolves.toEqual({
      outcome: { status: "completed", result: { content: [] } },
      lastTask: undefined,
      handle: undefined,
    });
    await session.close();
  });

  it("lists V1 server inventory", async () => {
    const port = new FakePort({
      generation: "v1",
      capabilities: { list: {}, requests: { tools: { call: {} } } },
    });
    port.response = {
      kind: "result",
      result: { tasks: [task("listed")], nextCursor: "next" },
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });

    const page = await session.listTasks("start");
    expect(port.requests).toEqual([
      { method: "tasks/list", params: { cursor: "start" } },
    ]);
    expect(page.nextCursor).toBe("next");
    expect(page.tasks[0]?.taskId).toBe("listed");
    await session.close();
  });

  it("settles an owned V2 task", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let reads = 0;
    port.dispatchHandler = (request) => {
      const method = (request as { method?: string }).method;
      if (method === "tools/call")
        return Promise.resolve({
          kind: "result",
          result: {
            resultType: "task",
            taskId: "owned",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: 1_000,
          },
        });
      reads += 1;
      return Promise.resolve({
        kind: "result",
        result: {
          resultType: "complete",
          taskId: "owned",
          status: "completed",
          createdAt: "a",
          lastUpdatedAt: "b",
          ttlMs: 1_000,
          result: { content: [] },
        },
      });
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });

    const settled = await session.callToolAndSettle("echo");
    expect(settled.handle).toEqual({
      taskId: "owned",
      operation: "tools/call",
    });
    expect(settled.outcome.status).toBe("completed");
    expect(reads).toBeGreaterThan(0);
    await session.close();
  });

  it("routes cancellation to a live execution and aborts owned input", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = async (request) => {
      const method = (request as { method?: string }).method;
      if (method === "tools/call")
        return {
          kind: "result",
          result: asJson({
            resultType: "task",
            taskId: "live",
            status: "working",
            createdAt: "a",
            lastUpdatedAt: "a",
            ttlMs: 1_000,
          }),
        };
      if (method === "tasks/cancel")
        return { kind: "result", result: asJson({}) };
      return new Promise(() => {});
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const execution = await session.callTool("echo");
    const inputSignal = (
      execution as unknown as { inputSignal(): AbortSignal }
    ).inputSignal();

    await session.cancelTask(taskId("live"));
    expect(inputSignal.aborted).toBe(true);
    expect(
      port.requests.filter(
        (request) => (request as { method?: string }).method === "tasks/cancel",
      ),
    ).toHaveLength(1);
    await session.close();
  });

  it("reports detached task cancellation failure", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.dispatchHandler = () => {
      throw new Error("cancel failed");
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    await expect(session.cancelTask(taskId("failed-cancel"))).rejects.toThrow(
      "cancel failed",
    );
    await session.close();
  });

  it("uses a detached controller and tolerates concurrent close/cancel", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let releaseCancellation: () => void = () => {};
    const releasePromise = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const cancelSeen = vi.fn();
    port.dispatchHandler = async (request) => {
      if ((request as { method?: string }).method === "tasks/cancel") {
        cancelSeen();
        await releasePromise;
        return { kind: "result", result: {} };
      }
      return { kind: "result", result: {} };
    };
    const session = withTasks(port, {
      tools: { currentTool: () => undefined },
    });
    const cancellation = session.cancelTask(taskId("detached"));
    await vi.waitFor(() => {
      expect(cancelSeen).toHaveBeenCalledOnce();
    });
    const closing = session.close();
    releaseCancellation();
    await expect(Promise.all([cancellation, closing])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
