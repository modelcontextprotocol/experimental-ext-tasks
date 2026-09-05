/** Generation-specific requester-side V1 task execution. */

import type { RuntimeCodec } from "../core/index.js";
import {
  CancelTaskResultV1Codec,
  GetTaskResultV1Codec,
  TaskResultV1Codec,
  type TaskV1,
} from "../core/v1/index.js";
import { TaskCancellationUnsupportedError, type TaskHandle } from "./api.js";
import {
  DEFAULT_TASK_POLL_INTERVAL_MS,
  TaskExecution,
  terminalStatus,
} from "./execution.js";
import {
  decodeResult,
  dispatchWithRetry,
  responseResult,
  type ConnectedMcpSessionPort,
} from "./port.js";

/** Creates an execution controller for an existing V1 task. */
export function createTaskExecutionV1<TResult, TApplicationContext>(options: {
  readonly applicationContext: TApplicationContext;
  readonly handle: TaskHandle & { readonly generation: "v1" };
  readonly initialTask: TaskV1;
  readonly resultCodec: RuntimeCodec<TResult>;
  readonly port: ConnectedMcpSessionPort;
  readonly lifecycleSignal: AbortSignal;
}): TaskExecution<TResult, TApplicationContext> {
  const { applicationContext, handle, initialTask, resultCodec, port } =
    options;
  return new TaskExecution(
    applicationContext,
    handle,
    port.endpointId,
    { generation: "v1", task: initialTask },
    async (
      accept,
      waitForTurn,
      observe,
      signal,
      cancelledError,
      closedError,
      isClosed,
    ) => {
      let current = initialTask;
      let notificationSequence = 0;
      while (!terminalStatus(current.status)) {
        const turn = await waitForTurn(
          notificationSequence,
          Math.max(
            DEFAULT_TASK_POLL_INTERVAL_MS,
            current.pollInterval ?? DEFAULT_TASK_POLL_INTERVAL_MS,
          ),
        );
        const observed =
          turn ??
          (await observe(notificationSequence, (observationSignal) =>
            dispatchWithRetry(
              port,
              { method: "tasks/get", params: { taskId: handle.taskId } },
              observationSignal,
              "observe",
            ).then((response) => ({
              generation: "v1" as const,
              task: decodeResult(
                GetTaskResultV1Codec,
                responseResult(response),
              ),
            })),
          ));
        if (observed?.snapshot.generation !== "v1") continue;
        notificationSequence = observed.sequence;
        current = observed.snapshot.task;
        if (!isClosed()) accept({ generation: "v1", task: current });
      }
      if (isClosed()) throw closedError;
      if (current.status === "cancelled") throw cancelledError;
      if (current.status === "failed")
        throw new Error(current.statusMessage ?? "Task failed");
      const taskResult = responseResult(
        await dispatchWithRetry(
          port,
          { method: "tasks/result", params: { taskId: handle.taskId } },
          signal,
          "observe",
        ),
      );
      decodeResult(TaskResultV1Codec, taskResult);
      return decodeResult(resultCodec, taskResult);
    },
    async (signal) => {
      const capabilities = port.taskCapabilities;
      if (
        capabilities.generation !== "v1" ||
        capabilities.capabilities.cancel === undefined
      )
        throw new TaskCancellationUnsupportedError();
      decodeResult(
        CancelTaskResultV1Codec,
        responseResult(
          await dispatchWithRetry(
            port,
            {
              method: "tasks/cancel",
              params: { taskId: handle.taskId },
            },
            signal,
            "mutate",
          ),
        ),
      );
    },
    options.lifecycleSignal,
  );
}
