/** Generation-specific requester-side V2 task execution. */

import type { JsonValue } from "../core/index.js";
import type { z } from "zod/v4";
import {
  CancelTaskResultV2Schema,
  CreateMessageResultV2Schema,
  ElicitResultV2Schema,
  GetTaskResultV2Schema,
  ListRootsResultV2Schema,
  UpdateTaskResultV2Schema,
  withTaskCapabilityV2,
  type DetailedTaskV2,
  type InputRequestV2,
  type InputResponseV2,
  type TaskV2,
} from "../core/v2/index.js";
import {
  JsonRpcResponseError,
  type ApplicationInputHandler,
  type ApplicationInputRequest,
  type TaskHandle,
} from "./api.js";
import {
  DEFAULT_TASK_POLL_INTERVAL_MS,
  TaskExecution,
  deterministicJson,
  terminalStatus,
} from "./execution.js";
import {
  parseResult,
  dispatchWithRetry,
  responseResult,
  type ConnectedMcpSessionPort,
} from "./port.js";

/** Creates an execution controller for an existing V2 task. */
export function createTaskExecutionV2<TResult, TApplicationContext>(options: {
  readonly applicationContext: TApplicationContext;
  readonly handle: TaskHandle & { readonly generation: "v2" };
  readonly initialTask: TaskV2;
  readonly initialDetailedTask?: DetailedTaskV2;
  readonly resultSchema: z.ZodType<TResult>;
  readonly port: ConnectedMcpSessionPort;
  readonly lifecycleSignal: AbortSignal;
  readonly onInputRequest?: ApplicationInputHandler<TApplicationContext>["handle"];
  readonly reportError: (error: Error) => void;
}): TaskExecution<TResult, TApplicationContext> {
  const {
    applicationContext,
    handle,
    initialTask,
    initialDetailedTask,
    resultSchema,
    port,
  } = options;
  return new TaskExecution(
    applicationContext,
    handle,
    port.endpointId,
    { generation: "v2", task: initialTask },
    async (
      accept,
      waitForTurn,
      observe,
      signal,
      cancelledError,
      closedError,
      isClosed,
      inputSignal,
    ) => {
      let status = initialTask.status;
      let current = initialDetailedTask;
      let notificationSequence = 0;
      const acquiredInputs = new Map<string, string>();
      if (current !== undefined)
        await acquireInputs(
          current,
          acquiredInputs,
          inputSignal,
          signal,
          options,
        );
      while (!terminalStatus(status)) {
        const delayMs = Math.max(
          DEFAULT_TASK_POLL_INTERVAL_MS,
          current?.pollIntervalMs ??
            initialTask.pollIntervalMs ??
            DEFAULT_TASK_POLL_INTERVAL_MS,
        );
        const turn = await waitForTurn(notificationSequence, delayMs);
        const observed =
          turn ??
          (await observe(notificationSequence, (observationSignal) =>
            dispatchWithRetry(
              port,
              {
                method: "tasks/get",
                params: withTaskCapabilityV2({ taskId: handle.taskId }),
              },
              observationSignal,
              "observe",
            ).then((response) => ({
              generation: "v2" as const,
              task: parseResult(
                GetTaskResultV2Schema,
                responseResult(response),
              ),
            })),
          ));
        if (observed?.snapshot.generation !== "v2") continue;
        notificationSequence = observed.sequence;
        current = observed.snapshot.task as DetailedTaskV2;
        status = current.status;
        if (!isClosed()) accept({ generation: "v2", task: current });
        await acquireInputs(
          current,
          acquiredInputs,
          inputSignal,
          signal,
          options,
        );
      }
      if (isClosed()) throw closedError;
      if (current === undefined) {
        current = parseResult(
          GetTaskResultV2Schema,
          responseResult(
            await dispatchWithRetry(
              port,
              {
                method: "tasks/get",
                params: withTaskCapabilityV2({ taskId: handle.taskId }),
              },
              signal,
              "observe",
            ),
          ),
        );
        if (!isClosed()) accept({ generation: "v2", task: current });
      }
      if (current.status === "cancelled") throw cancelledError;
      if (current.status === "failed")
        throw new JsonRpcResponseError(current.error);
      if (current.status !== "completed")
        throw new Error(`Unsupported terminal task status: ${current.status}`);
      return parseResult(resultSchema, current.result);
    },
    async (signal) => {
      parseResult(
        CancelTaskResultV2Schema,
        responseResult(
          await dispatchWithRetry(
            port,
            {
              method: "tasks/cancel",
              params: withTaskCapabilityV2({ taskId: handle.taskId }),
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

async function acquireInputs<TApplicationContext>(
  task: DetailedTaskV2,
  acquiredInputs: Map<string, string>,
  inputSignal: AbortSignal,
  signal: AbortSignal,
  options: {
    readonly applicationContext: TApplicationContext;
    readonly onInputRequest?: ApplicationInputHandler<TApplicationContext>["handle"];
    readonly reportError: (error: Error) => void;
    readonly port: ConnectedMcpSessionPort;
  },
): Promise<void> {
  if (task.status !== "input_required") return;
  const inputResponses: Record<string, InputResponseV2> = {};
  for (const [inputKey, inputRequest] of Object.entries(task.inputRequests)) {
    const signature = deterministicJson(inputRequest);
    const acquiredSignature = acquiredInputs.get(inputKey);
    if (acquiredSignature !== undefined) {
      if (acquiredSignature !== signature)
        options.reportError(
          new Error(`V2 task input key ${inputKey} was reused incompatibly`),
        );
      continue;
    }
    acquiredInputs.set(inputKey, signature);
    const request: InputRequestV2 = inputRequest;
    const projected: ApplicationInputRequest =
      request.method === "sampling/createMessage"
        ? { kind: "sampling", params: request.params }
        : request.method === "roots/list"
          ? {
              kind: "roots",
              ...(request.params === undefined
                ? {}
                : { params: request.params }),
            }
          : { kind: "elicitation", params: request.params };
    let result: unknown;
    if (options.onInputRequest === undefined) {
      if (request.method !== "elicitation/create") continue;
      result = { action: "cancel" };
    } else {
      try {
        result = await options.onInputRequest(projected, {
          lifetime: "task-v2",
          taskId: task.taskId,
          inputKey,
          applicationContext: options.applicationContext,
          signal: inputSignal,
        });
      } catch {
        if (inputSignal.aborted) return;
        if (request.method !== "elicitation/create") continue;
        result = { action: "cancel" };
      }
    }
    try {
      const responseSchema =
        request.method === "sampling/createMessage"
          ? CreateMessageResultV2Schema
          : request.method === "roots/list"
            ? ListRootsResultV2Schema
            : ElicitResultV2Schema;
      inputResponses[inputKey] = parseResult(
        responseSchema as z.ZodType<InputResponseV2>,
        result as JsonValue,
      );
    } catch (error) {
      options.reportError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  if (inputSignal.aborted || Object.keys(inputResponses).length === 0) return;
  parseResult(
    UpdateTaskResultV2Schema,
    responseResult(
      await dispatchWithRetry(
        options.port,
        {
          method: "tasks/update",
          params: withTaskCapabilityV2({ taskId: task.taskId, inputResponses }),
        },
        signal,
        "mutate",
      ),
    ),
  );
}
