import { isJsonValue } from "../core/index.js";
import type { JsonValue, RuntimeCodec, TaskId } from "../core/index.js";
import {
  CreateTaskResultV1Schema,
  ListTasksResultV1Schema,
  TaskStatusNotificationV1Schema,
  shouldCallToolAsTaskV1,
} from "../core/v1/index.js";
import type { CallToolResultV1, TaskV1 } from "../core/v1/index.js";
import {
  CreateTaskResultV2Schema,
  DetailedTaskV2Schema,
  InputRequiredCallToolResultV2Schema,
  TaskStatusNotificationV2Schema,
  isCreateTaskResultV2,
  withTaskCapabilityV2,
} from "../core/v2/index.js";
import type {
  CallToolResultV2,
  DetailedTaskV2,
  InputRequestV2,
  InputResponsesV2,
} from "../core/v2/index.js";
import {
  InputCorrelationError,
  TaskRecoveryOwnershipError,
  TaskRetentionUnsupportedError,
} from "./api.js";
import type { TaskController, TaskControllerOptions } from "./api.js";
import type { TaskRecoveryOptions, TaskSessionEndpointId } from "./api.js";
import type {
  CallToolAndSettleOptions,
  CallToolAndSettleResult,
  SerializedTaskReference,
  TaskEnabledSession,
  TaskListPage,
  ToolCallOptions,
  ToolDeclarationProvider,
  ToolExecution,
  WithTasksOptions,
} from "./api.js";
import {
  ImmediateExecution,
  TaskExecution,
  defaultResultCodec,
  reasonAsError,
} from "./execution.js";
import {
  projectTask,
  projectToolForGeneration,
  semanticCapabilities,
} from "./internal.js";
import type { InternalTaskHandle, InternalTaskSnapshot } from "./internal.js";
import {
  buildResolvedInputContext,
  defaultServerRequestResponse,
  nextExecutionIdentifier,
  projectApplicationInputRequest,
  readRelatedTaskEvidence,
  resolveInputCandidate,
  throwIfAborted,
} from "./input-routing.js";
import type {
  OrdinaryInputCandidate,
  V1TaskInputCandidate,
} from "./input-routing.js";
import {
  createTaskRpc,
  parseResult,
  dispatchWithRetry,
  linkAbortSignals,
  responseResult,
  withAbort,
} from "./port.js";
import type {
  ConnectedMcpSessionPort,
  IncomingServerRequest,
  JsonRpcResponse,
  SessionTaskCapabilities,
} from "./port.js";
import { createTaskController } from "./task-controller.js";
import { ManagedToolDeclarations } from "./tool-declarations.js";
import { createTaskExecutionV1 } from "./task-protocol-v1.js";
import {
  createTaskExecutionV2,
  projectInputRequest,
  responseSchemaForInputRequest,
} from "./task-protocol-v2.js";

type TaskIdentityOwner = {
  readonly originalOperation: string;
  readonly token: symbol;
};

const MAX_REQUEST_INPUT_ROUNDS = 10;

function taskIdentityKey(reference: {
  readonly generation: "v1" | "v2";
  readonly taskId: TaskId;
}): string {
  return `${reference.generation}:${reference.taskId}`;
}

function isSupportedTaskReferenceOperation(reference: {
  readonly originalOperation: unknown;
}): boolean {
  return reference.originalOperation === "tools/call";
}

function selectResultCodec<TResult>(
  generation: SessionTaskCapabilities["generation"],
  codec: RuntimeCodec<TResult> | undefined,
): RuntimeCodec<TResult> {
  if (codec !== undefined) return codec;
  const fallback = defaultResultCodec(generation);
  return {
    parse(value) {
      const decoded = fallback.parse(value);
      if (!decoded.success) return decoded;
      // TResult defaults to the generated result union; callers choosing another TResult must provide resultCodec.
      return { success: true, value: decoded.value as TResult };
    },
  };
}

class PortTaskEnabledSession<
  TApplicationContext,
> implements TaskEnabledSession<TApplicationContext> {
  readonly endpointId: TaskSessionEndpointId;
  readonly capabilities;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly lifecycleController = new AbortController();
  private invalidationError: Error | undefined;
  private readonly disposeListeners: readonly (() => void)[];
  private readonly declarations: ToolDeclarationProvider;
  private readonly managedDeclarations: ManagedToolDeclarations | undefined;
  private readonly ordinaryInputCandidates = new Map<
    string,
    OrdinaryInputCandidate<TApplicationContext>
  >();
  private readonly v1TaskInputCandidates = new Map<
    string,
    V1TaskInputCandidate<TApplicationContext>
  >();
  private readonly activeTaskExecutions = new Set<
    TaskExecution<unknown, TApplicationContext>
  >();
  private readonly taskIdentityOwners = new Map<string, TaskIdentityOwner>();
  private readonly activeTaskExecutionsById = new Map<
    TaskId,
    TaskExecution<unknown, TApplicationContext>
  >();

  constructor(
    private readonly port: ConnectedMcpSessionPort,
    private readonly options: WithTasksOptions<TApplicationContext>,
    disposePort?: () => void,
  ) {
    this.endpointId = port.endpointId as TaskSessionEndpointId;
    this.capabilities = semanticCapabilities(port.taskCapabilities);
    const reportError = (error: Error): void => {
      try {
        this.options.onError?.(error);
      } catch (sinkError) {
        console.error(sinkError);
      }
    };
    if (options.tools === undefined) {
      this.managedDeclarations = new ManagedToolDeclarations(port, reportError);
      this.declarations = this.managedDeclarations;
    } else {
      this.managedDeclarations = undefined;
      this.declarations = options.tools;
    }
    const onSessionAbort = (): void => {
      const error =
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new DOMException("The session was aborted", "AbortError");
      this.invalidationError ??= error;
      this.lifecycleController.abort(error);
      this.managedDeclarations?.close();
    };
    options.signal?.addEventListener("abort", onSessionAbort, { once: true });
    this.disposeListeners = [
      port.onServerRequest(async (incoming) =>
        this.handleServerRequest(incoming),
      ),
      port.onNotification((notification) => {
        this.handleNotification(notification);
      }),
      port.onInvalidated((reason) => {
        const error = reasonAsError(reason);
        this.invalidationError ??= error;
        this.lifecycleController.abort(error);
        this.managedDeclarations?.close();
      }),
      () => options.signal?.removeEventListener("abort", onSessionAbort),
      () => this.managedDeclarations?.close(),
      ...(disposePort === undefined ? [] : [disposePort]),
    ];
    if (options.signal?.aborted === true) onSessionAbort();
    if (port.invalidated) {
      const error = new Error("MCP session was invalidated");
      this.invalidationError = error;
      this.lifecycleController.abort(error);
      this.managedDeclarations?.close();
    }
  }

  task(taskId: TaskId, options: TaskControllerOptions = {}): TaskController {
    this.assertUsable();
    return createTaskController(
      this.port,
      taskId,
      options,
      this.lifecycleController.signal,
      () => {
        this.assertUsable();
      },
    );
  }

  async listTasks(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<TaskListPage> {
    this.assertUsable();
    if (this.capabilities.inventory !== "server-list")
      throw new Error("Server task inventory is not supported by this session");
    const response = await dispatchWithRetry(
      this.port,
      {
        method: "tasks/list",
        ...(cursor === undefined ? {} : { params: { cursor } }),
      },
      { signal },
    );
    const result = parseResult(
      ListTasksResultV1Schema,
      responseResult(response),
    );
    const tasks = result.tasks.map((task) =>
      projectTask({ generation: "v1", task }),
    );
    return {
      tasks,
      ...(result.nextCursor === undefined
        ? {}
        : { nextCursor: result.nextCursor }),
    };
  }

  async cancelTask(taskId: TaskId, signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    const execution = this.activeTaskExecutionsById.get(taskId);
    if (execution !== undefined) {
      execution.endInputLifetime();
      await execution.cancel(signal);
      return;
    }
    const operationLifecycle = new AbortController();
    await createTaskController(
      this.port,
      taskId,
      {},
      operationLifecycle.signal,
      () => {},
    ).cancel(signal);
  }

  async callToolAndSettle<TResult = CallToolResultV1 | CallToolResultV2>(
    name: string,
    params?: Readonly<Record<string, JsonValue>>,
    options: CallToolAndSettleOptions<TResult, TApplicationContext> = {},
  ): Promise<CallToolAndSettleResult<TResult>> {
    const { onEvent, close, ...callOptions } = options;
    const execution = await this.callTool(name, params, callOptions);
    const settlement = await execution.settle({
      signal: options.signal,
      close,
      onEvent,
    });
    return { ...settlement, handle: execution.handle };
  }

  async callTool<TResult = CallToolResultV1 | CallToolResultV2>(
    name: string,
    params?: Readonly<Record<string, JsonValue>>,
    options: ToolCallOptions<TResult, TApplicationContext> = {},
  ): Promise<ToolExecution<TResult, TApplicationContext>> {
    this.assertUsable();
    const callLifecycle = linkAbortSignals(
      this.lifecycleController.signal,
      options.signal,
    );
    const callSignal = callLifecycle.signal;
    let declaration = options.declaration;
    try {
      throwIfAborted(callSignal);
      await this.managedDeclarations?.ensureReady(callSignal);
      this.assertUsable();
      declaration ??= this.declarations.currentTool(name);
    } catch (error) {
      callLifecycle.dispose();
      throw error;
    }
    const requestParams: Record<string, JsonValue> = { name };
    if (params !== undefined) requestParams.arguments = params;
    if (options.metadata !== undefined) requestParams._meta = options.metadata;
    const generation = this.port.taskCapabilities.generation;
    const preference = options.task?.preference ?? "allow";
    if (
      options.task?.retentionMs !== undefined &&
      options.task.retention === "require-capability" &&
      !this.capabilities.requestedRetention
    ) {
      callLifecycle.dispose();
      throw new TaskRetentionUnsupportedError();
    }
    const callAsTaskV1 =
      generation === "v1" &&
      declaration !== undefined &&
      shouldCallToolAsTaskV1(
        this.port.taskCapabilities.capabilities,
        projectToolForGeneration(declaration, "v1"),
        preference === "prefer" || preference === "require",
      ) &&
      preference !== "forbid";
    if (preference === "require" && generation !== "v2" && !callAsTaskV1) {
      callLifecycle.dispose();
      throw new Error("Task execution was required but is unavailable");
    }
    if (callAsTaskV1)
      requestParams.task =
        options.task?.retentionMs === undefined
          ? {}
          : { ttl: options.task.retentionMs };
    const dispatchContext =
      options.headers === undefined ? undefined : { headers: options.headers };
    const executionId = nextExecutionIdentifier();
    this.ordinaryInputCandidates.set(executionId, {
      lifetime: "basic",
      generation: generation === "none" ? "v1" : generation,
      toolName: name,
      executionId,
      applicationContext: options.applicationContext as TApplicationContext,
      signal: callSignal,
    });
    let continuedRequestParams: Record<string, JsonValue> = requestParams;
    let response: JsonRpcResponse | undefined;
    try {
      let inputRound = 0;
      let previousRequestStateOnly: string | undefined;
      for (;;) {
        const dispatchPromise = dispatchWithRetry(
          this.port,
          {
            method: "tools/call",
            params:
              generation === "v2"
                ? withTaskCapabilityV2(continuedRequestParams)
                : continuedRequestParams,
          },
          { signal: callSignal, context: dispatchContext },
        );
        try {
          response = await withAbort(dispatchPromise, callSignal);
        } catch (error) {
          void dispatchPromise.then(
            (lateResponse) => {
              this.cleanupLateTaskCreation(
                lateResponse,
                generation,
                callAsTaskV1,
              );
            },
            () => {},
          );
          throw error;
        }
        this.assertUsable();
        throwIfAborted(callSignal);
        const roundResult = responseResult(response);
        if (!this.isRequestInputRequired(roundResult)) break;
        if (inputRound >= MAX_REQUEST_INPUT_ROUNDS)
          throw new Error(
            `Tool call exceeded ${String(MAX_REQUEST_INPUT_ROUNDS)} input-required rounds`,
          );
        const inputRequired = parseResult(
          InputRequiredCallToolResultV2Schema,
          roundResult,
        );
        const hasInputRequests = inputRequired.inputRequests !== undefined;
        if (
          !hasInputRequests &&
          inputRequired.requestState === previousRequestStateOnly
        )
          throw new Error(
            "Tool call returned repeated non-advancing requestState-only input_required",
          );
        previousRequestStateOnly = hasInputRequests
          ? undefined
          : inputRequired.requestState;
        const inputResponses = await this.resolveRequestInputResponses(
          inputRequired.inputRequests ?? {},
          executionId,
          options.applicationContext as TApplicationContext,
          callSignal,
        );
        continuedRequestParams = {
          ...requestParams,
          ...(Object.keys(inputResponses).length === 0
            ? {}
            : { inputResponses }),
          ...(inputRequired.requestState === undefined
            ? {}
            : { requestState: inputRequired.requestState }),
        };
        inputRound += 1;
      }
    } catch (error) {
      if (response !== undefined)
        this.cleanupLateTaskCreation(response, generation, callAsTaskV1);
      throw error;
    } finally {
      this.ordinaryInputCandidates.delete(executionId);
      callLifecycle.dispose();
    }
    const wireResult = responseResult(response);
    const codec = selectResultCodec(generation, options.resultCodec);

    if (generation === "v1" && callAsTaskV1) {
      const created = parseResult(CreateTaskResultV1Schema, wireResult);
      const handle: InternalTaskHandle & { readonly generation: "v1" } = {
        generation: "v1",
        taskId: created.task.taskId as TaskId,
        originalOperation: "tools/call",
      };
      const releaseTaskIdentity = this.acquireTaskIdentity(handle);
      const execution = createTaskExecutionV1({
        applicationContext: options.applicationContext as TApplicationContext,
        handle,
        declaration,
        initialTask: created.task,
        resultCodec: codec,
        port: this.port,
        dispatchContext,
        lifecycleSignal: this.lifecycleController.signal,
      });
      return this.trackTaskExecution(
        execution,
        {
          lifetime: "task-v1",
          generation: "v1",
          taskId: created.task.taskId as TaskId,
          toolName: name,
          executionId,
          applicationContext: options.applicationContext as TApplicationContext,
          signal: execution.inputSignal(),
        },
        releaseTaskIdentity,
      );
    }

    if (generation === "v2" && isCreateTaskResultV2(wireResult)) {
      const created = parseResult(CreateTaskResultV2Schema, wireResult);
      const handle: InternalTaskHandle & { readonly generation: "v2" } = {
        generation: "v2",
        taskId: created.taskId as TaskId,
        originalOperation: "tools/call",
      };
      const releaseTaskIdentity = this.acquireTaskIdentity(handle);
      return this.trackTaskExecution(
        createTaskExecutionV2({
          applicationContext: options.applicationContext as TApplicationContext,
          declaration,
          handle,
          initialTask: created,
          resultCodec: codec,
          port: this.port,
          dispatchContext,
          lifecycleSignal: this.lifecycleController.signal,
          onInputRequest: this.options.onInputRequest,
          reportError: (error) => {
            this.reportBackgroundError(error);
          },
        }),
        undefined,
        releaseTaskIdentity,
      );
    }

    const resultPromise = Promise.resolve(parseResult(codec, wireResult));
    return new ImmediateExecution(
      options.applicationContext as TApplicationContext,
      resultPromise,
      declaration,
    );
  }

  async resumeTask<TResult = CallToolResultV1 | CallToolResultV2>(
    reference: SerializedTaskReference,
    options: TaskRecoveryOptions<TResult, TApplicationContext> = {},
    initialSnapshot?: InternalTaskSnapshot,
  ): Promise<ToolExecution<TResult, TApplicationContext>> {
    this.assertUsable();
    const capabilities = this.port.taskCapabilities;
    if (reference.endpointId !== this.port.endpointId)
      throw new Error("Task reference belongs to a different endpoint");
    if (reference.generation !== capabilities.generation)
      throw new Error("Task reference generation does not match this session");
    const activeTaskIdentity = this.taskIdentityOwners.get(
      taskIdentityKey(reference),
    );
    if (activeTaskIdentity !== undefined) {
      throw new TaskRecoveryOwnershipError(
        reference.taskId,
        reference.originalOperation,
        activeTaskIdentity.originalOperation,
      );
    }
    if (!isSupportedTaskReferenceOperation(reference))
      throw new Error("Task reference operation is not supported");
    const releaseTaskIdentity = this.acquireTaskIdentity(reference);
    let taskIdentityTransferred = false;

    const resumeLifecycle = linkAbortSignals(
      this.lifecycleController.signal,
      options.signal,
    );
    const resumeSignal = resumeLifecycle.signal;
    const executionId = nextExecutionIdentifier();
    const codec = selectResultCodec(reference.generation, options.resultCodec);
    try {
      throwIfAborted(resumeSignal);
      this.assertUsable();
      throwIfAborted(resumeSignal);

      if (reference.generation === "v1") {
        const task =
          initialSnapshot?.generation === "v1"
            ? initialSnapshot.task
            : await createTaskRpc(reference.generation, {
                port: this.port,
                taskId: reference.taskId,
              }).get(resumeSignal);
        this.assertUsable();
        throwIfAborted(resumeSignal);
        const execution = createTaskExecutionV1({
          applicationContext: options.applicationContext as TApplicationContext,
          declaration: options.declaration,
          handle: reference,
          initialTask: task,
          resultCodec: codec,
          port: this.port,
          lifecycleSignal: this.lifecycleController.signal,
        });
        const tracked = this.trackTaskExecution(
          execution,
          {
            lifetime: "task-v1",
            generation: "v1",
            taskId: reference.taskId,
            toolName: "<resumed>",
            executionId,
            applicationContext:
              options.applicationContext as TApplicationContext,
            signal: execution.inputSignal(),
          },
          releaseTaskIdentity,
        );
        taskIdentityTransferred = true;
        return tracked;
      }

      const seededTask =
        initialSnapshot?.generation === "v2" ? initialSnapshot.task : undefined;
      const seededDetailed =
        seededTask === undefined
          ? undefined
          : DetailedTaskV2Schema.safeParse(seededTask);
      const seededDetailedTask =
        seededDetailed?.success === true ? seededDetailed.data : undefined;
      const detailedTask =
        seededTask === undefined
          ? await createTaskRpc(reference.generation, {
              port: this.port,
              taskId: reference.taskId,
            }).get(resumeSignal)
          : seededDetailedTask;
      const task = seededTask ?? detailedTask;
      if (task === undefined)
        throw new Error("Task recovery produced no initial task");
      this.assertUsable();
      throwIfAborted(resumeSignal);
      const execution = createTaskExecutionV2({
        applicationContext: options.applicationContext as TApplicationContext,
        declaration: options.declaration,
        handle: reference,
        initialTask: task,
        initialDetailedTask: detailedTask,
        resultCodec: codec,
        port: this.port,
        lifecycleSignal: this.lifecycleController.signal,
        onInputRequest: this.options.onInputRequest,
        reportError: (error) => {
          this.reportBackgroundError(error);
        },
      });
      const tracked = this.trackTaskExecution(
        execution,
        undefined,
        releaseTaskIdentity,
      );
      taskIdentityTransferred = true;
      return tracked;
    } finally {
      if (!taskIdentityTransferred) releaseTaskIdentity();
      resumeLifecycle.dispose();
    }
  }

  private lateTaskCancellationParams(
    result: JsonValue,
    generation: SessionTaskCapabilities["generation"],
    callAsTaskV1: boolean,
  ): JsonValue | undefined {
    if (generation === "v1" && callAsTaskV1) {
      const parsed = CreateTaskResultV1Schema.safeParse(result);
      if (!parsed.success) return undefined;
      return { taskId: parsed.data.task.taskId as TaskId };
    }
    if (generation !== "v2" || !isCreateTaskResultV2(result)) return undefined;
    const parsed = CreateTaskResultV2Schema.safeParse(result);
    if (!parsed.success) return undefined;
    return withTaskCapabilityV2({ taskId: parsed.data.taskId as TaskId });
  }

  private cleanupLateTaskCreation(
    response: JsonRpcResponse,
    generation: SessionTaskCapabilities["generation"],
    callAsTaskV1: boolean,
  ): void {
    if (response.kind !== "result") return;
    const params = this.lateTaskCancellationParams(
      response.result,
      generation,
      callAsTaskV1,
    );
    if (params === undefined) return;
    void dispatchWithRetry(
      this.port,
      { method: "tasks/cancel", params },
      undefined,
    ).catch(() => {
      // A task returned after call abort is cleaned up on a best-effort basis.
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const childClosures = [...this.activeTaskExecutions].map(
        async (execution) => {
          try {
            await execution.close();
          } catch (error) {
            this.reportBackgroundError(reasonAsError(error));
          }
        },
      );
      this.lifecycleController.abort(
        new Error("Task-enabled session is closed"),
      );
      for (const dispose of this.disposeListeners) {
        try {
          dispose();
        } catch (error) {
          this.reportBackgroundError(reasonAsError(error));
        }
      }
      await Promise.all(childClosures);
    })();
    return this.closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private acquireTaskIdentity(
    reference: SerializedTaskReference | InternalTaskHandle,
  ): () => void {
    const key = taskIdentityKey(reference);
    const active = this.taskIdentityOwners.get(key);
    if (active !== undefined) {
      throw new TaskRecoveryOwnershipError(
        reference.taskId,
        reference.originalOperation,
        active.originalOperation,
      );
    }
    const owner: TaskIdentityOwner = {
      originalOperation: reference.originalOperation,
      token: Symbol(key),
    };
    this.taskIdentityOwners.set(key, owner);
    return () => {
      if (this.taskIdentityOwners.get(key)?.token === owner.token) {
        this.taskIdentityOwners.delete(key);
      }
    };
  }

  private trackTaskExecution<TResult>(
    execution: TaskExecution<TResult, TApplicationContext>,
    v1InputCandidate?: V1TaskInputCandidate<TApplicationContext>,
    releaseTaskIdentity?: () => void,
  ): TaskExecution<TResult, TApplicationContext> {
    const tracked = execution as TaskExecution<unknown, TApplicationContext>;
    this.activeTaskExecutions.add(tracked);
    this.activeTaskExecutionsById.set(execution.handle.taskId, tracked);
    if (
      v1InputCandidate !== undefined &&
      v1InputCandidate.signal?.aborted !== true
    ) {
      this.v1TaskInputCandidates.set(
        v1InputCandidate.executionId,
        v1InputCandidate,
      );
      v1InputCandidate.signal?.addEventListener(
        "abort",
        () => {
          this.v1TaskInputCandidates.delete(v1InputCandidate.executionId);
        },
        { once: true },
      );
    }
    void execution.result().finally(() => {
      execution.endInputLifetime();
      this.activeTaskExecutions.delete(tracked);
      if (
        this.activeTaskExecutionsById.get(execution.handle.taskId) === tracked
      )
        this.activeTaskExecutionsById.delete(execution.handle.taskId);
      if (v1InputCandidate !== undefined)
        this.v1TaskInputCandidates.delete(v1InputCandidate.executionId);
      releaseTaskIdentity?.();
    });
    return execution;
  }

  private handleNotification(notification: JsonValue): void {
    this.managedDeclarations?.onNotification(notification);
    if (
      notification === null ||
      Array.isArray(notification) ||
      typeof notification !== "object"
    )
      return;
    const method = (notification as Readonly<Record<string, JsonValue>>).method;
    const generation = this.port.taskCapabilities.generation;
    const parsed =
      generation === "v1" && method === "notifications/tasks/status"
        ? TaskStatusNotificationV1Schema.safeParse(notification)
        : generation === "v2" && method === "notifications/tasks"
          ? TaskStatusNotificationV2Schema.safeParse(notification)
          : undefined;
    if (parsed === undefined) return;
    if (!parsed.success) {
      this.reportBackgroundError(parsed.error);
      return;
    }
    const snapshot: InternalTaskSnapshot =
      generation === "v1"
        ? { generation: "v1", task: parsed.data.params as TaskV1 }
        : { generation: "v2", task: parsed.data.params as DetailedTaskV2 };
    for (const execution of this.activeTaskExecutions) {
      execution.onNotification(snapshot);
    }
  }

  private isRequestInputRequired(value: JsonValue): value is Readonly<
    Record<string, JsonValue>
  > & {
    readonly resultType: "input_required";
  } {
    return (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      (value as Readonly<Record<string, JsonValue>>).resultType ===
        "input_required"
    );
  }

  private async resolveRequestInputResponses(
    inputRequests: Readonly<Record<string, InputRequestV2>>,
    executionId: string,
    applicationContext: TApplicationContext,
    signal: AbortSignal,
  ): Promise<InputResponsesV2> {
    if (Object.keys(inputRequests).length === 0) return {};
    if (this.options.onInputRequest === undefined)
      throw new Error(
        "Tool call requires input, but no onInputRequest handler is configured",
      );
    const inputResponses: Record<string, InputResponsesV2[string]> = {};
    for (const [inputId, inputRequest] of Object.entries(inputRequests)) {
      throwIfAborted(signal);
      const result = await this.options.onInputRequest(
        projectInputRequest(inputRequest),
        {
          scope: "request",
          delivery: "request-retry",
          inputId,
          applicationContext,
          signal,
        },
      );
      throwIfAborted(signal);
      inputResponses[inputId] = parseResult(
        responseSchemaForInputRequest(inputRequest),
        result as JsonValue,
      );
    }
    if (this.ordinaryInputCandidates.get(executionId) === undefined)
      throw new Error("Tool call input lifetime ended before retry");
    return inputResponses;
  }

  private async handleServerRequest(
    incoming: IncomingServerRequest,
  ): Promise<JsonRpcResponse> {
    const request = projectApplicationInputRequest(incoming);
    if (request === undefined) return defaultServerRequestResponse(incoming);

    const resolution = resolveInputCandidate(
      readRelatedTaskEvidence(request),
      [...this.ordinaryInputCandidates.values()],
      [...this.v1TaskInputCandidates.values()],
    );
    if (resolution.kind === "failed") {
      this.reportBackgroundError(
        new InputCorrelationError(
          request.kind,
          resolution.candidates,
          resolution.reason,
        ),
      );
      return defaultServerRequestResponse(incoming);
    }
    if (this.options.onInputRequest === undefined)
      return defaultServerRequestResponse(incoming);

    try {
      const context = buildResolvedInputContext(resolution.candidate);
      const result = await this.options.onInputRequest(request, context);
      if (!isJsonValue(result))
        throw new Error("Input handler returned a non-JSON value");
      return { kind: "result", result };
    } catch {
      return defaultServerRequestResponse(incoming);
    }
  }

  private reportBackgroundError(error: Error): void {
    try {
      if (this.options.onError === undefined) console.error(error);
      else this.options.onError(error);
    } catch (sinkError) {
      console.error(sinkError);
    }
  }

  private assertUsable(): void {
    if (this.invalidationError !== undefined) throw this.invalidationError;
    if (this.closed) throw new Error("Task-enabled session is closed");
  }
}

/** Adds task execution support to a connected MCP session port. */
export function withTasks<TApplicationContext = void>(
  session: ConnectedMcpSessionPort,
  options: WithTasksOptions<TApplicationContext> = {},
): TaskEnabledSession<TApplicationContext> {
  return new PortTaskEnabledSession(session, options);
}

/** @internal Creates a task session that owns disposal of its connected port. */
export function withOwnedTasks<TApplicationContext = void>(
  session: ConnectedMcpSessionPort,
  options: WithTasksOptions<TApplicationContext>,
  disposePort: () => void,
): TaskEnabledSession<TApplicationContext> {
  return new PortTaskEnabledSession(session, options, disposePort);
}
