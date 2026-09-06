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
        await resolveAndSubmitInputRequests(
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
        await resolveAndSubmitInputRequests(
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

type InputResolution = {
  readonly inputKey: string;
  readonly response: InputResponseV2;
};

function projectInputRequest(request: InputRequestV2): ApplicationInputRequest {
  if (request.method === "sampling/createMessage")
    return { kind: "sampling", params: request.params };
  if (request.method === "roots/list")
    return {
      kind: "roots",
      ...(request.params === undefined ? {} : { params: request.params }),
    };
  return { kind: "elicitation", params: request.params };
}

function responseSchemaForInputRequest(
  request: InputRequestV2,
): z.ZodType<InputResponseV2> {
  if (request.method === "sampling/createMessage")
    return CreateMessageResultV2Schema;
  if (request.method === "roots/list") return ListRootsResultV2Schema;
  return ElicitResultV2Schema;
}

async function resolveInputRequest<TApplicationContext>(
  task: DetailedTaskV2,
  inputKey: string,
  request: InputRequestV2,
  acquiredInputs: Map<string, string>,
  inputSignal: AbortSignal,
  options: {
    readonly applicationContext: TApplicationContext;
    readonly onInputRequest?: ApplicationInputHandler<TApplicationContext>["handle"];
    readonly reportError: (error: Error) => void;
  },
): Promise<InputResolution | undefined> {
  const signature = deterministicJson(request);
  const acquiredSignature = acquiredInputs.get(inputKey);
  if (acquiredSignature !== undefined) {
    if (acquiredSignature !== signature)
      options.reportError(
        new Error(`V2 task input key ${inputKey} was reused incompatibly`),
      );
    return undefined;
  }
  acquiredInputs.set(inputKey, signature);

  let result: unknown;
  if (options.onInputRequest === undefined) {
    if (request.method !== "elicitation/create") return undefined;
    result = { action: "cancel" };
  } else {
    try {
      result = await options.onInputRequest(projectInputRequest(request), {
        lifetime: "task-v2",
        taskId: task.taskId,
        inputKey,
        applicationContext: options.applicationContext,
        signal: inputSignal,
      });
    } catch (error) {
      if (inputSignal.aborted) return undefined;
      options.reportError(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (request.method !== "elicitation/create") return undefined;
      result = { action: "cancel" };
    }
  }

  try {
    return {
      inputKey,
      response: parseResult(
        responseSchemaForInputRequest(request),
        result as JsonValue,
      ),
    };
  } catch (error) {
    options.reportError(
      error instanceof Error ? error : new Error(String(error)),
    );
    return undefined;
  }
}

async function resolveAndSubmitInputRequests<TApplicationContext>(
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
  for (const [inputKey, request] of Object.entries(task.inputRequests)) {
    const resolution = await resolveInputRequest(
      task,
      inputKey,
      request,
      acquiredInputs,
      inputSignal,
      options,
    );
    if (inputSignal.aborted) return;
    if (resolution !== undefined)
      inputResponses[resolution.inputKey] = resolution.response;
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
