/** Generation-specific requester-side V1 task execution. */

import type { RuntimeCodec } from "../core/index.js";
import {
  CancelTaskResultV1Schema,
  GetTaskResultV1Schema,
  TaskResultV1Schema,
} from "../core/v1/index.js";
import type { TaskV1 } from "../core/v1/index.js";
import { TaskCancellationUnsupportedError } from "./api.js";
import type { TaskHandle } from "./api.js";
import {
  DEFAULT_TASK_POLL_INTERVAL_MS,
  TaskExecution,
  terminalStatus,
} from "./execution.js";
import { parseResult, dispatchWithRetry, responseResult } from "./port.js";
import type { ConnectedMcpSessionPort, DispatchContext } from "./port.js";

/** Creates an execution controller for an existing V1 task. */
export function createTaskExecutionV1<TResult, TApplicationContext>(options: {
  readonly applicationContext: TApplicationContext;
  readonly handle: TaskHandle & { readonly generation: "v1" };
  readonly initialTask: TaskV1;
  readonly resultCodec: RuntimeCodec<TResult>;
  readonly port: ConnectedMcpSessionPort;
  readonly dispatchContext?: DispatchContext;
  readonly lifecycleSignal: AbortSignal;
}): TaskExecution<TResult, TApplicationContext> {
  const {
    applicationContext,
    dispatchContext,
    handle,
    initialTask,
    resultCodec,
    port,
  } = options;
  return new TaskExecution({
    applicationContext,
    handle,
    endpointId: port.endpointId,
    initialSnapshot: { generation: "v1", task: initialTask },
    driver: async (context) => {
      let current = initialTask;
      let notificationSequence = 0;
      while (!terminalStatus(current.status)) {
        const observed = await context.nextObservation(
          notificationSequence,
          Math.max(
            DEFAULT_TASK_POLL_INTERVAL_MS,
            current.pollInterval ?? DEFAULT_TASK_POLL_INTERVAL_MS,
          ),
          (observationSignal) =>
            dispatchWithRetry(
              port,
              { method: "tasks/get", params: { taskId: handle.taskId } },
              { signal: observationSignal, context: dispatchContext },
              "observe",
            ).then((response) => ({
              generation: "v1" as const,
              task: parseResult(
                GetTaskResultV1Schema,
                responseResult(response),
              ),
            })),
        );
        if (observed === undefined) continue;
        if (observed.snapshot.generation !== "v1")
          throw new Error("V1 task driver received a non-V1 snapshot");
        notificationSequence = observed.sequence;
        current = observed.snapshot.task;
        if (!context.isClosed()) {
          const accepted = context.accept({ generation: "v1", task: current });
          if (accepted.generation !== "v1")
            throw new Error("V1 task driver accepted a non-V1 snapshot");
          current = accepted.task;
        }
      }
      if (context.isClosed()) throw context.errors.closed;
      if (current.status === "cancelled") throw context.errors.cancelled;
      if (current.status === "failed")
        throw new Error(current.statusMessage ?? "Task failed");
      const taskResult = responseResult(
        await dispatchWithRetry(
          port,
          { method: "tasks/result", params: { taskId: handle.taskId } },
          { signal: context.signal, context: dispatchContext },
          "observe",
        ),
      );
      parseResult(TaskResultV1Schema, taskResult);
      return parseResult(resultCodec, taskResult);
    },
    cancelTask: async (signal) => {
      const capabilities = port.taskCapabilities;
      if (
        capabilities.generation !== "v1" ||
        capabilities.capabilities.cancel === undefined
      )
        throw new TaskCancellationUnsupportedError();
      parseResult(
        CancelTaskResultV1Schema,
        responseResult(
          await dispatchWithRetry(
            port,
            {
              method: "tasks/cancel",
              params: { taskId: handle.taskId },
            },
            { signal, context: dispatchContext },
            "mutate",
          ),
        ),
      );
    },
    lifecycleSignal: options.lifecycleSignal,
  });
}
