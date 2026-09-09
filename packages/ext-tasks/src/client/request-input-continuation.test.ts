import { describe, expect, it } from "vitest";
import type { ApplicationInputHandler, JsonRpcResponse } from "./index.js";
import { withTasks } from "./index.js";
import { FakePort, expectRecord } from "../../test-support/client/fake-port.js";

const tools = {
  currentTool: () => undefined,
};

describe("request-scoped input-required continuation", () => {
  it("preserves call params, request state, context, headers, and signal", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    const abort = new AbortController();
    let round = 0;
    port.dispatchHandler = async (): Promise<JsonRpcResponse> => {
      await Promise.resolve();
      round += 1;
      if (round === 1)
        return {
          kind: "result",
          result: {
            resultType: "input_required",
            requestState: "opaque-1",
            inputRequests: {
              choice: {
                method: "elicitation/create",
                params: { message: "pick" },
              },
            },
          },
        };
      if (round === 2)
        return {
          kind: "result",
          result: {
            resultType: "input_required",
            requestState: "opaque-2",
            inputRequests: { roots: { method: "roots/list" } },
          },
        };
      return {
        kind: "result",
        result: { resultType: "complete", content: [] },
      };
    };
    const inputIds: (string | undefined)[] = [];
    const inputSignals: (AbortSignal | undefined)[] = [];
    const onInputRequest: ApplicationInputHandler<{
      trace: string;
    }>["handle"] = async (request, context) => {
      await Promise.resolve();
      inputIds.push(context.inputId);
      expect(context).toMatchObject({
        scope: "request",
        delivery: "request-retry",
        applicationContext: { trace: "app" },
      });
      inputSignals.push(context.signal);
      return (
        request.kind === "elicitation"
          ? { action: "accept" as const }
          : { roots: [{ uri: "file:///root" }] }
      ) as never;
    };
    const session = withTasks<{ trace: string }>(port, {
      tools,
      onInputRequest,
    });
    const execution = await session.callTool(
      "demo",
      { original: true },
      {
        metadata: { source: "test" },
        applicationContext: { trace: "app" },
        headers: { authorization: "secret" },
        signal: abort.signal,
      },
    );
    expect(execution.kind).toBe("immediate");
    await expect(execution.result()).resolves.toEqual({
      status: "completed",
      result: { resultType: "complete", content: [] },
    });
    expect(inputIds).toEqual(["choice", "roots"]);
    expect(port.requests).toHaveLength(3);
    const firstParams = expectRecord(expectRecord(port.requests[0]).params);
    const secondParams = expectRecord(expectRecord(port.requests[1]).params);
    const thirdParams = expectRecord(expectRecord(port.requests[2]).params);
    expect(firstParams).toMatchObject({
      name: "demo",
      arguments: { original: true },
      _meta: { source: "test" },
    });
    expect(secondParams).toMatchObject({
      ...firstParams,
      requestState: "opaque-1",
      inputResponses: { choice: { action: "accept" } },
    });
    expect(thirdParams).toMatchObject({
      ...firstParams,
      requestState: "opaque-2",
      inputResponses: { roots: { roots: [{ uri: "file:///root" }] } },
    });
    expect(port.dispatchOptions).toHaveLength(3);
    const effectiveSignal = port.dispatchOptions[0]?.signal;
    expect(effectiveSignal).toBeDefined();
    expect(inputSignals).toEqual([effectiveSignal, effectiveSignal]);
    for (const dispatchOptions of port.dispatchOptions) {
      expect(dispatchOptions?.signal).toBe(effectiveSignal);
      expect(dispatchOptions?.context?.headers).toEqual({
        authorization: "secret",
      });
    }
    await session.close();
  });

  it("continues before classifying a task result", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let round = 0;
    port.dispatchHandler = async (): Promise<JsonRpcResponse> => {
      await Promise.resolve();
      round += 1;
      return round === 1
        ? {
            kind: "result",
            result: { resultType: "input_required", requestState: "state" },
          }
        : {
            kind: "result",
            result: {
              resultType: "task",
              taskId: "continued-task",
              status: "working",
              createdAt: "a",
              lastUpdatedAt: "a",
              ttlMs: null,
            },
          };
    };
    const session = withTasks(port, { tools });
    const execution = await session.callTool("demo");
    expect(execution.kind).toBe("task");
    expect(execution.handle).toMatchObject({ taskId: "continued-task" });
    expect(expectRecord(expectRecord(port.requests[1]).params)).toMatchObject({
      name: "demo",
      requestState: "state",
    });
    await session.close();
  });

  it("fails without a handler when input requests are present", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.response = {
      kind: "result",
      result: {
        resultType: "input_required",
        inputRequests: {
          prompt: { method: "elicitation/create", params: {} },
        },
      },
    };
    const session = withTasks(port, { tools });
    await expect(session.callTool("demo")).rejects.toThrow(
      "no onInputRequest handler",
    );
    await session.close();
  });

  it("fails immediately on repeated non-advancing requestState-only input", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    port.response = {
      kind: "result",
      result: { resultType: "input_required", requestState: "stalled" },
    };
    const session = withTasks(port, { tools });
    await expect(session.callTool("demo")).rejects.toThrow(
      "repeated non-advancing requestState-only input_required",
    );
    expect(port.requests).toHaveLength(2);
    await session.close();
  });

  it("limits advancing input continuation to ten rounds", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let round = 0;
    port.dispatchHandler = async (): Promise<JsonRpcResponse> => {
      await Promise.resolve();
      round += 1;
      return {
        kind: "result",
        result: {
          resultType: "input_required",
          requestState: `state-${String(round)}`,
          inputRequests: { roots: { method: "roots/list" } },
        },
      };
    };
    const onInputRequest: ApplicationInputHandler["handle"] = async (
      request,
    ) => {
      await Promise.resolve();
      expect(request.kind).toBe("roots");
      return { roots: [] } as never;
    };
    const session = withTasks(port, { tools, onInputRequest });
    await expect(session.callTool("demo")).rejects.toThrow(
      "exceeded 10 input-required rounds",
    );
    expect(port.requests).toHaveLength(11);
    await session.close();
  });

  it("does not retain requestState when a later round omits it", async () => {
    const port = new FakePort({ generation: "v2", capabilities: {} });
    let round = 0;
    port.dispatchHandler = async (): Promise<JsonRpcResponse> => {
      await Promise.resolve();
      round += 1;
      if (round === 1)
        return {
          kind: "result",
          result: {
            resultType: "input_required",
            requestState: "per-round",
            inputRequests: { roots: { method: "roots/list" } },
          },
        };
      if (round === 2)
        return {
          kind: "result",
          result: {
            resultType: "input_required",
            inputRequests: { roots: { method: "roots/list" } },
          },
        };
      return {
        kind: "result",
        result: { resultType: "complete", content: [] },
      };
    };
    const onInputRequest: ApplicationInputHandler["handle"] = async (
      request,
    ) => {
      await Promise.resolve();
      expect(request.kind).toBe("roots");
      return { roots: [] } as never;
    };
    const session = withTasks(port, { tools, onInputRequest });
    const execution = await session.callTool("demo");
    await expect(execution.result()).resolves.toMatchObject({
      status: "completed",
    });
    const secondParams = expectRecord(expectRecord(port.requests[1]).params);
    const thirdParams = expectRecord(expectRecord(port.requests[2]).params);
    expect(secondParams.requestState).toBe("per-round");
    expect(thirdParams).not.toHaveProperty("requestState");
    await session.close();
  });
});
