/** Generation-specific requester-side V1 task execution. */

import type { RuntimeCodec } from "../core/index.js";
import type { TaskV1 } from "../core/v1/index.js";
import { TaskCancellationUnsupportedError } from "./api.js";
import type { TaskSessionEndpointId, ToolDeclaration } from "./api.js";
import type { InternalTaskHandle } from "./internal.js";
import {
  DEFAULT_TASK_POLL_INTERVAL_MS,
  TaskExecution,
  terminalStatus,
} from "./execution.js";
import { createTaskRpc } from "./port.js";
import type { ConnectedMcpSessionPort, DispatchContext } from "./port.js";

/** Creates an execution controller for an existing V1 task. */
export function createTaskExecutionV1<TResult, TApplicationContext>(options: {
  readonly applicationContext: TApplicationContext;
  readonly handle: InternalTaskHandle & { readonly generation: "v1" };
  readonly declaration?: ToolDeclaration;
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
  const rpc = createTaskRpc("v1", {
    port,
    taskId: handle.taskId,
    context: dispatchContext,
  });
  return new TaskExecution({
    applicationContext,
    declaration: options.declaration,
    handle,
    endpointId: port.endpointId as TaskSessionEndpointId,
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
          async (observationSignal) => ({
            generation: "v1" as const,
            task: await rpc.get(observationSignal),
          }),
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
      return rpc.result(resultCodec, context.signal);
    },
    cancelTask: async (signal) => {
      const capabilities = port.taskCapabilities;
      if (
        capabilities.generation !== "v1" ||
        capabilities.capabilities.cancel === undefined
      )
        throw new TaskCancellationUnsupportedError();
      await rpc.cancel(signal);
    },
    lifecycleSignal: options.lifecycleSignal,
  });
}
