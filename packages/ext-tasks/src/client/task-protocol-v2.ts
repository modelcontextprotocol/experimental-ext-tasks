/** Generation-specific requester-side V2 task execution. */

import type { JsonValue, RuntimeCodec } from "../core/index.js";
import type { z } from "zod/v4";
import {
  CreateMessageResultV2Schema,
  ElicitResultV2Schema,
  ListRootsResultV2Schema,
  type DetailedTaskV2,
  type InputRequestV2,
  type InputResponseV2,
  type TaskV2,
} from "../core/v2/index.js";
import { JsonRpcResponseError } from "./api.js";
import type {
  ApplicationInputHandler,
  ApplicationInputRequest,
  TaskSessionEndpointId,
  ToolDeclaration,
} from "./api.js";
import type { InternalTaskHandle } from "./internal.js";
import {
  TaskExecution,
  deterministicJson,
  taskPollInterval,
  terminalStatus,
} from "./execution.js";
import type { TaskDriverContext } from "./execution.js";
import { createTaskRpc, parseResult } from "./port.js";
import type {
  ConnectedMcpSessionPort,
  DispatchContext,
  TaskRpcV2,
} from "./port.js";

interface TaskExecutionV2Options<TResult, TApplicationContext> {
  readonly applicationContext: TApplicationContext;
  readonly handle: InternalTaskHandle & { readonly generation: "v2" };
  readonly declaration?: ToolDeclaration;
  readonly initialTask: TaskV2;
  readonly initialDetailedTask?: DetailedTaskV2;
  readonly resultCodec: RuntimeCodec<TResult>;
  readonly port: ConnectedMcpSessionPort;
  readonly dispatchContext?: DispatchContext;
  readonly lifecycleSignal: AbortSignal;
  readonly onInputRequest?: ApplicationInputHandler<TApplicationContext>["handle"];
  readonly reportError: (error: Error) => void;
}

interface V2TaskRpcContext {
  readonly rpc: TaskRpcV2;
  readonly handle: InternalTaskHandle & { readonly generation: "v2" };
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

/** Reserves input keys during handling and commits them only after update succeeds. */
class InputRequestLedger {
  private readonly fingerprints = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly state: "reserved" | "committed";
    }
  >();

  acquire(inputKey: string, request: InputRequestV2): InputAcquisition {
    const fingerprint = deterministicJson(request);
    const acquired = this.fingerprints.get(inputKey);
    if (acquired === undefined) {
      this.fingerprints.set(inputKey, { fingerprint, state: "reserved" });
      return { kind: "new" };
    }
    return acquired.fingerprint === fingerprint
      ? { kind: "duplicate" }
      : { kind: "incompatible" };
  }

  commit(inputKey: string): void {
    const acquired = this.fingerprints.get(inputKey);
    if (acquired !== undefined)
      this.fingerprints.set(inputKey, { ...acquired, state: "committed" });
  }

  release(inputKey: string): void {
    if (this.fingerprints.get(inputKey)?.state === "reserved")
      this.fingerprints.delete(inputKey);
  }
}

/** Creates an execution controller for an existing V2 task. */
export function createTaskExecutionV2<TResult, TApplicationContext>(
  options: TaskExecutionV2Options<TResult, TApplicationContext>,
): TaskExecution<TResult, TApplicationContext> {
  const rpcContext: V2TaskRpcContext = {
    rpc: createTaskRpc("v2", {
      port: options.port,
      taskId: options.handle.taskId,
      context: options.dispatchContext,
    }),
    handle: options.handle,
  };
  return new TaskExecution({
    applicationContext: options.applicationContext,
    declaration: options.declaration,
    handle: options.handle,
    endpointId: options.port.endpointId as TaskSessionEndpointId,
    initialSnapshot: { generation: "v2", task: options.initialTask },
    driver: (driverContext) =>
      driveTaskExecutionV2({ options, rpcContext, driverContext }),
    cancelTask: (signal) => rpcContext.rpc.cancel(signal),
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
    const delayMs = taskPollInterval(
      latestDetailedTask?.pollIntervalMs,
      options.initialTask.pollIntervalMs,
    );
    const observed = await driverContext.nextObservation(
      lastNotificationSequence,
      delayMs,
      async (signal) => ({
        generation: "v2",
        task: await rpcContext.rpc.get(signal),
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
    latestDetailedTask = await rpcContext.rpc.get(driverContext.signal);
  return resolveTerminalTaskResult({
    task: latestDetailedTask,
    resultCodec: options.resultCodec,
    cancelledError: driverContext.errors.cancelled,
  });
}

/** Resolves a terminal V2 task with the same result and error semantics everywhere. */
export function resolveTerminalTaskResult<TResult>(args: {
  readonly task: DetailedTaskV2;
  readonly resultCodec: RuntimeCodec<TResult>;
  readonly cancelledError: Error;
}): TResult {
  const { task, resultCodec, cancelledError } = args;
  switch (task.status) {
    case "cancelled":
      throw cancelledError;
    case "failed":
      throw new JsonRpcResponseError(task.error);
    case "completed":
      return parseResult(resultCodec, task.result);
    default:
      throw new Error(`Unsupported terminal task status: ${task.status}`);
  }
}

type InputResolution = {
  readonly inputKey: string;
  readonly response: InputResponseV2;
};

/** Projects a V2 wire input request to the generation-neutral application shape. */
export function projectInputRequest(
  request: InputRequestV2,
): ApplicationInputRequest {
  if (request.method === "sampling/createMessage")
    return { kind: "sampling", params: request.params };
  if (request.method === "roots/list")
    return {
      kind: "roots",
      ...(request.params === undefined ? {} : { params: request.params }),
    };
  return { kind: "elicitation", params: request.params };
}

/** Selects the response validator for a V2 input request. */
export function responseSchemaForInputRequest(
  request: InputRequestV2,
): z.ZodType<InputResponseV2> {
  if (request.method === "sampling/createMessage")
    return CreateMessageResultV2Schema;
  if (request.method === "roots/list") return ListRootsResultV2Schema;
  return ElicitResultV2Schema;
}

type InputHandlerOutcome =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "skipped" };

async function invokeInputHandler<TApplicationContext>(args: {
  readonly inputKey: string;
  readonly request: InputRequestV2;
  readonly inputContext: V2InputContext<TApplicationContext>;
}): Promise<InputHandlerOutcome> {
  const { inputKey, request, inputContext } = args;
  if (inputContext.onInputRequest === undefined)
    return request.method === "elicitation/create"
      ? { kind: "result", value: { action: "cancel" } }
      : { kind: "skipped" };
  try {
    return {
      kind: "result",
      value: await inputContext.onInputRequest(projectInputRequest(request), {
        scope: "task",
        delivery: "task-update",
        taskId: inputContext.handle.taskId,
        inputId: inputKey,
        applicationContext: inputContext.applicationContext,
        signal: inputContext.inputSignal,
      }),
    };
  } catch (error) {
    if (inputContext.inputSignal.aborted) return { kind: "skipped" };
    inputContext.reportError(
      error instanceof Error ? error : new Error(String(error)),
    );
    return request.method === "elicitation/create"
      ? { kind: "result", value: { action: "cancel" } }
      : { kind: "skipped" };
  }
}

async function resolveInputRequest<TApplicationContext>(args: {
  readonly inputKey: string;
  readonly request: InputRequestV2;
  readonly inputContext: V2InputContext<TApplicationContext>;
}): Promise<InputResolution | undefined> {
  const { inputKey, request, inputContext } = args;
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

  const outcome = await invokeInputHandler({
    inputKey,
    request,
    inputContext,
  });
  if (outcome.kind === "skipped") {
    inputContext.acquiredRequestLedger.release(inputKey);
    return undefined;
  }

  try {
    return {
      inputKey,
      response: parseResult(
        responseSchemaForInputRequest(request),
        outcome.value as JsonValue,
      ),
    };
  } catch (error) {
    inputContext.reportError(
      error instanceof Error ? error : new Error(String(error)),
    );
    inputContext.acquiredRequestLedger.release(inputKey);
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
  try {
    await inputContext.rpc.update(inputResponses, inputContext.signal);
    for (const inputKey of Object.keys(inputResponses))
      inputContext.acquiredRequestLedger.commit(inputKey);
  } catch (error) {
    for (const inputKey of Object.keys(inputResponses))
      inputContext.acquiredRequestLedger.release(inputKey);
    throw error;
  }
}
