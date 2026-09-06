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
  type TaskDriverContext,
} from "./execution.js";
import {
  parseResult,
  dispatchWithRetry,
  responseResult,
  type ConnectedMcpSessionPort,
} from "./port.js";

interface TaskExecutionV2Options<TResult, TApplicationContext> {
  readonly applicationContext: TApplicationContext;
  readonly handle: TaskHandle & { readonly generation: "v2" };
  readonly initialTask: TaskV2;
  readonly initialDetailedTask?: DetailedTaskV2;
  readonly resultSchema: z.ZodType<TResult>;
  readonly port: ConnectedMcpSessionPort;
  readonly lifecycleSignal: AbortSignal;
  readonly onInputRequest?: ApplicationInputHandler<TApplicationContext>["handle"];
  readonly reportError: (error: Error) => void;
}

interface V2TaskRpcContext {
  readonly port: ConnectedMcpSessionPort;
  readonly handle: TaskHandle & { readonly generation: "v2" };
}

interface V2InputContext<TApplicationContext> extends V2TaskRpcContext {
  readonly applicationContext: TApplicationContext;
  readonly onInputRequest?: ApplicationInputHandler<TApplicationContext>["handle"];
  readonly reportError: (error: Error) => void;
  readonly acquiredRequestLedger: InputRequestLedger;
  readonly inputSignal: AbortSignal;
  readonly signal: AbortSignal;
}

type InputAcquisition =
  | { readonly kind: "new" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "incompatible" };

/**
 * Tracks each input key and request fingerprint. The first acquisition wins,
 * including when handling fails or is aborted; later identical requests are
 * duplicates, and different requests are incompatible.
 */
class InputRequestLedger {
  private readonly fingerprints = new Map<string, string>();

  acquire(inputKey: string, request: InputRequestV2): InputAcquisition {
    const fingerprint = deterministicJson(request);
    const acquiredFingerprint = this.fingerprints.get(inputKey);
    if (acquiredFingerprint === undefined) {
      this.fingerprints.set(inputKey, fingerprint);
      return { kind: "new" };
    }
    return acquiredFingerprint === fingerprint
      ? { kind: "duplicate" }
      : { kind: "incompatible" };
  }
}

/** Creates an execution controller for an existing V2 task. */
export function createTaskExecutionV2<TResult, TApplicationContext>(
  options: TaskExecutionV2Options<TResult, TApplicationContext>,
): TaskExecution<TResult, TApplicationContext> {
  const rpcContext: V2TaskRpcContext = {
    port: options.port,
    handle: options.handle,
  };
  return new TaskExecution({
    applicationContext: options.applicationContext,
    handle: options.handle,
    endpointId: options.port.endpointId,
    initialSnapshot: { generation: "v2", task: options.initialTask },
    driver: (driverContext) =>
      driveTaskExecutionV2({ options, rpcContext, driverContext }),
    cancelTask: (signal) => cancelTask({ rpcContext, signal }),
    lifecycleSignal: options.lifecycleSignal,
  });
}

async function driveTaskExecutionV2<TResult, TApplicationContext>(args: {
  readonly options: TaskExecutionV2Options<TResult, TApplicationContext>;
  readonly rpcContext: V2TaskRpcContext;
  readonly driverContext: TaskDriverContext;
}): Promise<TResult> {
  const { options, rpcContext, driverContext } = args;
  let knownStatus = options.initialTask.status;
  let latestDetailedTask = options.initialDetailedTask;
  let lastNotificationSequence = 0;
  const acquiredRequestLedger = new InputRequestLedger();
  const inputContext: V2InputContext<TApplicationContext> = {
    ...rpcContext,
    applicationContext: options.applicationContext,
    onInputRequest: options.onInputRequest,
    reportError: options.reportError,
    acquiredRequestLedger,
    inputSignal: driverContext.inputSignal,
    signal: driverContext.signal,
  };

  if (latestDetailedTask !== undefined)
    await resolveAndSubmitInputRequests({
      task: latestDetailedTask,
      inputContext,
    });

  while (!terminalStatus(knownStatus)) {
    const delayMs = Math.max(
      DEFAULT_TASK_POLL_INTERVAL_MS,
      latestDetailedTask?.pollIntervalMs ??
        options.initialTask.pollIntervalMs ??
        DEFAULT_TASK_POLL_INTERVAL_MS,
    );
    const observed = await driverContext.nextObservation(
      lastNotificationSequence,
      delayMs,
      async (signal) => ({
        generation: "v2",
        task: await fetchDetailedTask({ rpcContext, signal }),
      }),
    );
    if (observed === undefined) continue;
    if (observed.snapshot.generation !== "v2")
      throw new Error("V2 task driver received a non-V2 snapshot");

    lastNotificationSequence = observed.sequence;
    const accepted = driverContext.isClosed()
      ? observed.snapshot
      : driverContext.accept(observed.snapshot);
    if (accepted.generation !== "v2")
      throw new Error("V2 task driver accepted a non-V2 snapshot");
    knownStatus = accepted.task.status;
    latestDetailedTask = accepted.task as DetailedTaskV2;
    await resolveAndSubmitInputRequests({
      task: latestDetailedTask,
      inputContext,
    });
  }

  if (driverContext.isClosed()) throw driverContext.errors.closed;
  if (latestDetailedTask === undefined)
    latestDetailedTask = await fetchDetailedTask({
      rpcContext,
      signal: driverContext.signal,
    });
  return resolveTerminalTaskResult({
    task: latestDetailedTask,
    resultSchema: options.resultSchema,
    cancelledError: driverContext.errors.cancelled,
  });
}

async function fetchDetailedTask(args: {
  readonly rpcContext: V2TaskRpcContext;
  readonly signal: AbortSignal;
}): Promise<DetailedTaskV2> {
  const { rpcContext, signal } = args;
  return parseResult(
    GetTaskResultV2Schema,
    responseResult(
      await dispatchWithRetry(
        rpcContext.port,
        {
          method: "tasks/get",
          params: withTaskCapabilityV2({ taskId: rpcContext.handle.taskId }),
        },
        signal,
        "observe",
      ),
    ),
  );
}

function resolveTerminalTaskResult<TResult>(args: {
  readonly task: DetailedTaskV2;
  readonly resultSchema: z.ZodType<TResult>;
  readonly cancelledError: Error;
}): TResult {
  const { task, resultSchema, cancelledError } = args;
  switch (task.status) {
    case "cancelled":
      throw cancelledError;
    case "failed":
      throw new JsonRpcResponseError(task.error);
    case "completed":
      return parseResult(resultSchema, task.result);
    default:
      throw new Error(`Unsupported terminal task status: ${task.status}`);
  }
}

async function cancelTask(args: {
  readonly rpcContext: V2TaskRpcContext;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { rpcContext, signal } = args;
  parseResult(
    CancelTaskResultV2Schema,
    responseResult(
      await dispatchWithRetry(
        rpcContext.port,
        {
          method: "tasks/cancel",
          params: withTaskCapabilityV2({ taskId: rpcContext.handle.taskId }),
        },
        signal,
        "mutate",
      ),
    ),
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

async function resolveInputRequest<TApplicationContext>(args: {
  readonly task: DetailedTaskV2;
  readonly inputKey: string;
  readonly request: InputRequestV2;
  readonly inputContext: V2InputContext<TApplicationContext>;
}): Promise<InputResolution | undefined> {
  const { task, inputKey, request, inputContext } = args;
  const acquisition = inputContext.acquiredRequestLedger.acquire(
    inputKey,
    request,
  );
  if (acquisition.kind !== "new") {
    if (acquisition.kind === "incompatible")
      inputContext.reportError(
        new Error(`V2 task input key ${inputKey} was reused incompatibly`),
      );
    return undefined;
  }

  let result: unknown;
  if (inputContext.onInputRequest === undefined) {
    if (request.method !== "elicitation/create") return undefined;
    result = { action: "cancel" };
  } else {
    try {
      result = await inputContext.onInputRequest(projectInputRequest(request), {
        lifetime: "task-v2",
        taskId: task.taskId,
        inputKey,
        applicationContext: inputContext.applicationContext,
        signal: inputContext.inputSignal,
      });
    } catch (error) {
      if (inputContext.inputSignal.aborted) return undefined;
      inputContext.reportError(
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
    inputContext.reportError(
      error instanceof Error ? error : new Error(String(error)),
    );
    return undefined;
  }
}

async function resolveAndSubmitInputRequests<TApplicationContext>(args: {
  readonly task: DetailedTaskV2;
  readonly inputContext: V2InputContext<TApplicationContext>;
}): Promise<void> {
  const { task, inputContext } = args;
  if (task.status !== "input_required") return;
  const inputResponses: Record<string, InputResponseV2> = {};
  for (const [inputKey, request] of Object.entries(task.inputRequests)) {
    const resolution = await resolveInputRequest({
      task,
      inputKey,
      request,
      inputContext,
    });
    if (inputContext.inputSignal.aborted) return;
    if (resolution !== undefined)
      inputResponses[resolution.inputKey] = resolution.response;
  }
  if (
    inputContext.inputSignal.aborted ||
    Object.keys(inputResponses).length === 0
  )
    return;
  parseResult(
    UpdateTaskResultV2Schema,
    responseResult(
      await dispatchWithRetry(
        inputContext.port,
        {
          method: "tasks/update",
          params: withTaskCapabilityV2({ taskId: task.taskId, inputResponses }),
        },
        inputContext.signal,
        "mutate",
      ),
    ),
  );
}
