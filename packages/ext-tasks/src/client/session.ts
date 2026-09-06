import { Client } from "@modelcontextprotocol/client";
import {
  isJsonValue,
  type JsonValue,
  type TaskId,
  type TaskSnapshot,
} from "../core/index.js";
import type { z } from "zod/v4";
import {
  CreateTaskResultV1Schema,
  GetTaskResultV1Schema,
  TaskStatusNotificationV1Schema,
  shouldCallToolAsTaskV1,
  type CallToolResultV1,
  type TaskV1,
  type ToolV1,
} from "../core/v1/index.js";
import {
  CreateTaskResultV2Schema,
  GetTaskResultV2Schema,
  TaskStatusNotificationV2Schema,
  isCreateTaskResultV2,
  withTaskCapabilityV2,
  type CallToolResultV2,
  type DetailedTaskV2,
} from "../core/v2/index.js";
import {
  InputCorrelationError,
  type SerializedTaskReference,
  type TaskEnabledSession,
  type TaskHandle,
  type ToolDeclarationProvider,
  type ToolExecution,
  type WithTasksOptions,
} from "./api.js";
import {
  ImmediateExecution,
  TaskExecution,
  defaultResultSchema,
  reasonAsError,
} from "./execution.js";
import {
  buildResolvedInputContext,
  defaultServerRequestResponse,
  nextExecutionIdentifier,
  projectApplicationInputRequest,
  readRelatedTaskEvidence,
  resolveInputCandidate,
  throwIfAborted,
  type OrdinaryInputCandidate,
  type V1TaskInputCandidate,
} from "./input-routing.js";
import {
  parseResult,
  dispatchWithRetry,
  linkAbortSignals,
  responseResult,
  withAbort,
  type ConnectedMcpSessionPort,
  type IncomingServerRequest,
  type JsonRpcResponse,
  type SessionTaskCapabilities,
} from "./port.js";
import {
  ClientSessionPort,
  isClientPublicSurface,
  isConnectedMcpSessionPort,
} from "./sdk-client-adapter.js";
import { ManagedToolDeclarations } from "./tool-declarations.js";
import { createTaskExecutionV1 } from "./task-protocol-v1.js";
import { createTaskExecutionV2 } from "./task-protocol-v2.js";

function isSupportedTaskReferenceOperation(reference: {
  readonly originalOperation: unknown;
}): boolean {
  return reference.originalOperation === "tools/call";
}

class PortTaskEnabledSession<
  TApplicationContext,
> implements TaskEnabledSession<TApplicationContext> {
  private closed = false;
  private closeError: Error | undefined;
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

  constructor(
    private readonly port: ConnectedMcpSessionPort,
    private readonly options: WithTasksOptions<TApplicationContext>,
    disposePort?: () => void,
  ) {
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

  async callTool<TResult = CallToolResultV1 | CallToolResultV2>(
    name: string,
    params?: Readonly<Record<string, JsonValue>>,
    options: {
      readonly resultSchema?: z.ZodType<TResult>;
      readonly applicationContext?: TApplicationContext;
      readonly signal?: AbortSignal;
      readonly preferTask?: boolean;
    } = {},
  ): Promise<ToolExecution<TResult, TApplicationContext>> {
    this.assertUsable();
    const callLifecycle = linkAbortSignals(
      this.lifecycleController.signal,
      options.signal,
    );
    const callSignal = callLifecycle.signal;
    let declaration: ReturnType<ToolDeclarationProvider["currentTool"]>;
    try {
      throwIfAborted(callSignal);
      await this.managedDeclarations?.ensureReady(callSignal);
      this.assertUsable();
      declaration = this.declarations.currentTool(name);
    } catch (error) {
      callLifecycle.dispose();
      throw error;
    }
    if (
      this.port.taskCapabilities.generation === "v2" &&
      declaration !== undefined &&
      "execution" in declaration
    ) {
      callLifecycle.dispose();
      throw new Error(
        "V1 tool declaration is incompatible with the V2 session",
      );
    }
    const requestParams: Record<string, JsonValue> = { name };
    if (params !== undefined) requestParams.arguments = params;
    const generation = this.port.taskCapabilities.generation;
    const callAsTaskV1 =
      generation === "v1" &&
      declaration !== undefined &&
      "execution" in declaration &&
      shouldCallToolAsTaskV1(
        this.port.taskCapabilities.capabilities,
        declaration as ToolV1,
        options.preferTask,
      );
    if (callAsTaskV1) requestParams.task = {};
    const executionId = nextExecutionIdentifier();
    if (!callAsTaskV1) {
      this.ordinaryInputCandidates.set(executionId, {
        lifetime: "basic",
        generation: generation === "none" ? "v1" : generation,
        toolName: name,
        executionId,
        applicationContext: options.applicationContext as TApplicationContext,
        signal: callSignal,
      });
    }
    const dispatchPromise = dispatchWithRetry(
      this.port,
      {
        method: "tools/call",
        params:
          generation === "v2"
            ? withTaskCapabilityV2(requestParams)
            : requestParams,
      },
      callSignal,
      "mutate",
    );
    let response: JsonRpcResponse;
    try {
      response = await withAbort(dispatchPromise, callSignal);
    } catch (error) {
      void dispatchPromise.then(
        (lateResponse) => {
          this.cleanupLateTaskCreation(lateResponse, generation, callAsTaskV1);
        },
        () => {},
      );
      throw error;
    } finally {
      this.ordinaryInputCandidates.delete(executionId);
      callLifecycle.dispose();
    }
    try {
      this.assertUsable();
      throwIfAborted(callSignal);
    } catch (error) {
      this.cleanupLateTaskCreation(response, generation, callAsTaskV1);
      throw error;
    }
    const wireResult = responseResult(response);
    const schema =
      options.resultSchema ??
      (defaultResultSchema(generation) as z.ZodType<TResult>);

    if (generation === "v1" && callAsTaskV1) {
      const created = parseResult(CreateTaskResultV1Schema, wireResult);
      const handle: TaskHandle & { readonly generation: "v1" } = {
        generation: "v1",
        taskId: created.task.taskId as TaskId,
        originalOperation: "tools/call",
      };
      const execution = createTaskExecutionV1({
        applicationContext: options.applicationContext as TApplicationContext,
        handle,
        initialTask: created.task,
        resultSchema: schema,
        port: this.port,
        lifecycleSignal: this.lifecycleController.signal,
      });
      return this.trackTaskExecution(execution, {
        lifetime: "task-v1",
        generation: "v1",
        taskId: created.task.taskId as TaskId,
        toolName: name,
        executionId,
        applicationContext: options.applicationContext as TApplicationContext,
        signal: execution.inputSignal(),
      });
    }

    if (generation === "v2" && isCreateTaskResultV2(wireResult)) {
      const created = parseResult(CreateTaskResultV2Schema, wireResult);
      const handle: TaskHandle & { readonly generation: "v2" } = {
        generation: "v2",
        taskId: created.taskId as TaskId,
        originalOperation: "tools/call",
      };
      return this.trackTaskExecution(
        createTaskExecutionV2({
          applicationContext: options.applicationContext as TApplicationContext,
          handle,
          initialTask: created,
          resultSchema: schema,
          port: this.port,
          lifecycleSignal: this.lifecycleController.signal,
          onInputRequest: this.options.onInputRequest,
          reportError: (error) => {
            this.reportBackgroundError(error);
          },
        }),
      );
    }

    const resultPromise = Promise.resolve(parseResult(schema, wireResult));
    return new ImmediateExecution(
      options.applicationContext as TApplicationContext,
      resultPromise,
    );
  }

  async resumeTask<TResult = CallToolResultV1 | CallToolResultV2>(
    reference: SerializedTaskReference,
    options: {
      readonly resultSchema?: z.ZodType<TResult>;
      readonly applicationContext?: TApplicationContext;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ToolExecution<TResult, TApplicationContext>> {
    this.assertUsable();
    const capabilities = this.port.taskCapabilities;
    if (reference.endpointId !== this.port.endpointId)
      throw new Error("Task reference belongs to a different endpoint");
    if (reference.generation !== capabilities.generation)
      throw new Error("Task reference generation does not match this session");
    if (!isSupportedTaskReferenceOperation(reference))
      throw new Error("Task reference operation is not supported");

    const resumeLifecycle = linkAbortSignals(
      this.lifecycleController.signal,
      options.signal,
    );
    const resumeSignal = resumeLifecycle.signal;
    const executionId = nextExecutionIdentifier();
    const schema =
      options.resultSchema ??
      (defaultResultSchema(reference.generation) as z.ZodType<TResult>);
    try {
      throwIfAborted(resumeSignal);
      const response = await dispatchWithRetry(
        this.port,
        {
          method: "tasks/get",
          params:
            reference.generation === "v2"
              ? withTaskCapabilityV2({ taskId: reference.taskId })
              : { taskId: reference.taskId },
        },
        resumeSignal,
        "observe",
      );
      this.assertUsable();
      throwIfAborted(resumeSignal);

      if (reference.generation === "v1") {
        const task = parseResult(
          GetTaskResultV1Schema,
          responseResult(response),
        );
        const execution = createTaskExecutionV1({
          applicationContext: options.applicationContext as TApplicationContext,
          handle: reference,
          initialTask: task,
          resultSchema: schema,
          port: this.port,
          lifecycleSignal: this.lifecycleController.signal,
        });
        return this.trackTaskExecution(execution, {
          lifetime: "task-v1",
          generation: "v1",
          taskId: reference.taskId,
          toolName: "<resumed>",
          executionId,
          applicationContext: options.applicationContext as TApplicationContext,
          signal: execution.inputSignal(),
        });
      }

      const task = parseResult(GetTaskResultV2Schema, responseResult(response));
      return this.trackTaskExecution(
        createTaskExecutionV2({
          applicationContext: options.applicationContext as TApplicationContext,
          handle: reference,
          initialTask: task,
          initialDetailedTask: task,
          resultSchema: schema,
          port: this.port,
          lifecycleSignal: this.lifecycleController.signal,
          onInputRequest: this.options.onInputRequest,
          reportError: (error) => {
            this.reportBackgroundError(error);
          },
        }),
      );
    } finally {
      resumeLifecycle.dispose();
    }
  }

  private cleanupLateTaskCreation(
    response: JsonRpcResponse,
    generation: SessionTaskCapabilities["generation"],
    callAsTaskV1: boolean,
  ): void {
    if (response.kind !== "result") return;
    let taskId: TaskId | undefined;
    let params: JsonValue | undefined;
    if (generation === "v1" && callAsTaskV1) {
      const parsed = CreateTaskResultV1Schema.safeParse(response.result);
      if (parsed.success) {
        taskId = parsed.data.task.taskId as TaskId;
        params = { taskId };
      }
    } else if (generation === "v2" && isCreateTaskResultV2(response.result)) {
      const parsed = CreateTaskResultV2Schema.safeParse(response.result);
      if (parsed.success) {
        taskId = parsed.data.taskId as TaskId;
        params = withTaskCapabilityV2({ taskId });
      }
    }
    if (taskId === undefined || params === undefined) return;
    void dispatchWithRetry(
      this.port,
      { method: "tasks/cancel", params },
      undefined,
      "mutate",
    ).catch(() => {
      // A task returned after call abort is cleaned up on a best-effort basis.
    });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const execution of this.activeTaskExecutions) {
        void execution.close().catch(() => {});
      }
      this.lifecycleController.abort(
        new Error("Task-enabled session is closed"),
      );
      for (const dispose of this.disposeListeners) {
        try {
          dispose();
        } catch (error) {
          this.closeError ??= reasonAsError(error);
        }
      }
    }
    return this.closeError === undefined
      ? Promise.resolve()
      : Promise.reject(this.closeError);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private trackTaskExecution<TResult>(
    execution: TaskExecution<TResult, TApplicationContext>,
    v1InputCandidate?: V1TaskInputCandidate<TApplicationContext>,
  ): TaskExecution<TResult, TApplicationContext> {
    const tracked = execution as TaskExecution<unknown, TApplicationContext>;
    this.activeTaskExecutions.add(tracked);
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
    void execution
      .result()
      .catch(() => {})
      .finally(() => {
        execution.endInputLifetime();
        this.activeTaskExecutions.delete(tracked);
        if (v1InputCandidate !== undefined)
          this.v1TaskInputCandidates.delete(v1InputCandidate.executionId);
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
    const snapshot: TaskSnapshot =
      generation === "v1"
        ? { generation: "v1", task: parsed.data.params as TaskV1 }
        : { generation: "v2", task: parsed.data.params as DetailedTaskV2 };
    for (const execution of this.activeTaskExecutions) {
      execution.onNotification(snapshot);
    }
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
          this.port.taskCapabilities.generation === "none"
            ? "v1"
            : this.port.taskCapabilities.generation,
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

/** Adds task execution support to a connected session port or MCP SDK client. */
export function withTasks<TApplicationContext = void>(
  session: ConnectedMcpSessionPort,
  options?: WithTasksOptions<TApplicationContext>,
): TaskEnabledSession<TApplicationContext>;
export function withTasks<TApplicationContext = void>(
  client: Client,
  options: WithTasksOptions<TApplicationContext> & {
    readonly endpointId: string;
  },
): TaskEnabledSession<TApplicationContext>;
export function withTasks<TApplicationContext = void>(
  session: ConnectedMcpSessionPort | Client,
  options: WithTasksOptions<TApplicationContext> & {
    readonly endpointId?: string;
  } = {},
): TaskEnabledSession<TApplicationContext> {
  if (isConnectedMcpSessionPort(session))
    return new PortTaskEnabledSession(session, options);
  if (!isClientPublicSurface(session))
    throw new TypeError(
      "withTasks requires a ConnectedMcpSessionPort or Client-compatible object",
    );
  const endpointId = options.endpointId;
  if (endpointId === undefined)
    throw new TypeError("withTasks(Client) requires options.endpointId");
  const port = new ClientSessionPort(session, endpointId);
  try {
    return new PortTaskEnabledSession(port, options, () => {
      port[Symbol.dispose]();
    });
  } catch (error) {
    port[Symbol.dispose]();
    throw error;
  }
}
