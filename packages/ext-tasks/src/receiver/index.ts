/** SDK Client binding for MCP Tasks V1 receiver requests. */
import type { Client } from "@modelcontextprotocol/client";
import { toJsonValue, type JsonValue } from "../core/index.js";
import type {
  CreateTaskResultV1,
  TaskStatusV1,
  TaskV1,
} from "../core/v1/index.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_TASKS = 1_000;

function createDefaultTaskId(): string {
  if (typeof globalThis.crypto.randomUUID !== "function") {
    throw new Error(
      "Task receiver requires crypto.randomUUID or options.createTaskId",
    );
  }
  return globalThis.crypto.randomUUID();
}

export type TaskReceiverMethod =
  "sampling/createMessage" | "elicitation/create";
export type TaskReceiverProtocolMethod =
  | TaskReceiverMethod
  | "tasks/list"
  | "tasks/get"
  | "tasks/result"
  | "tasks/cancel"
  | "notifications/tasks/status";

export interface TaskReceiverRequest {
  readonly method: TaskReceiverMethod;
  readonly params: Readonly<Record<string, JsonValue>>;
}

export interface TaskReceiverCallbackContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
}

export type TaskReceiverCallback<
  TResult extends Record<string, JsonValue> = Record<string, JsonValue>,
> = (
  request: TaskReceiverRequest,
  context: TaskReceiverCallbackContext,
) => Promise<TResult>;

export interface TaskReceiverErrorContext {
  readonly method: TaskReceiverProtocolMethod;
  readonly taskId?: string;
  readonly lateAfter?: "cancel" | "expiry" | "close";
}

export interface TaskReceiverOptions {
  readonly methods: Partial<Record<TaskReceiverMethod, boolean>>;
  /**
   * Total task lifetime, measured from creation. A function is sampled once for
   * each created task; `null` disables time expiry for that task.
   */
  readonly ttlMs?: number | null | (() => number | null);
  readonly pollIntervalMs?: number | null;
  /** Maximum tasks returned in one `tasks/list` page. Defaults to 100. */
  readonly pageSize?: number;
  /** Maximum retained tasks, including pending tasks. Defaults to 1,000. */
  readonly maxTasks?: number;
  readonly sampling?: TaskReceiverCallback;
  readonly elicitation?: TaskReceiverCallback;
  readonly onError?: (
    error: unknown,
    context: TaskReceiverErrorContext,
  ) => void;
  readonly createTaskId?: () => string;
}

export interface TaskReceiverCapabilities {
  readonly list: Record<string, never>;
  readonly cancel: Record<string, never>;
  readonly requests: {
    readonly sampling?: { readonly createMessage: Record<string, never> };
    readonly elicitation?: { readonly create: Record<string, never> };
  };
}

export interface TaskReceiverBinding {
  readonly capabilities: TaskReceiverCapabilities;
  close(): void;
}

type Handler = (request: unknown, context?: unknown) => Promise<unknown>;
type FinalDisposition = "expiry" | "close";
type TaskDisposition = "cancel" | FinalDisposition;

interface TaskRecord {
  task: TaskV1;
  readonly method: TaskReceiverMethod;
  readonly result: Promise<Record<string, JsonValue>>;
  readonly resolve: (value: Record<string, JsonValue>) => void;
  readonly reject: (error: unknown) => void;
  readonly controller: AbortController;
  readonly expiresAt: number | null;
  expiryTimer?: ReturnType<typeof setTimeout>;
  disposition?: TaskDisposition;
}

interface ClientInternals {
  readonly _requestHandlers: Map<string, Handler>;
}

function clientInternals(client: Client): ClientInternals {
  const candidate = client as unknown as Partial<ClientInternals>;
  if (!(candidate._requestHandlers instanceof Map))
    throw new TypeError(
      "Task receiver binding requires an SDK Client with request-handler restoration support",
    );
  return candidate as ClientInternals;
}

function nonNegativeInteger(
  name: string,
  value: number | null,
  allowNull: boolean,
): void {
  if (value === null) {
    if (allowNull) return;
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(
      `${name} must be a non-negative integer${allowNull ? " or null" : ""}`,
    );
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer`);
}

function paramsOf(request: unknown): Record<string, JsonValue> {
  if (request === null || typeof request !== "object" || !("params" in request))
    return {};
  const params = toJsonValue(request.params);
  if (params === null || Array.isArray(params) || typeof params !== "object")
    throw new TypeError("Request params must normalize to a JSON object");
  return params as Record<string, JsonValue>;
}

function hasTaskAugmentation(request: unknown): boolean {
  if (request === null || typeof request !== "object" || !("params" in request))
    return false;
  const { params } = request;
  return (
    params !== null &&
    typeof params === "object" &&
    "task" in params &&
    params.task !== null &&
    params.task !== undefined
  );
}

function taskIdOf(request: unknown): string {
  const taskId = paramsOf(request).taskId;
  if (typeof taskId !== "string")
    throw new Error("A string taskId is required");
  return taskId;
}

function clearExpiry(record: TaskRecord): void {
  if (record.expiryTimer !== undefined) clearTimeout(record.expiryTimer);
  record.expiryTimer = undefined;
}

function detachTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

/**
 * Binds task-augmented receiver requests to an SDK Client and owns their task
 * lifecycle. The Client creates JSON-RPC envelopes for emitted notifications.
 */
export function bindTaskReceiver(
  client: Client,
  options: TaskReceiverOptions,
): TaskReceiverBinding {
  const internals = clientInternals(client);
  const now = Date.now;
  const makeId = options.createTaskId ?? createDefaultTaskId;
  const ttlMs = options.ttlMs ?? null;
  const pollIntervalMs = options.pollIntervalMs;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  if (typeof ttlMs !== "function") nonNegativeInteger("ttlMs", ttlMs, true);
  if (pollIntervalMs !== undefined)
    nonNegativeInteger("pollIntervalMs", pollIntervalMs, true);
  positiveInteger("pageSize", pageSize);
  positiveInteger("maxTasks", maxTasks);

  const callbacks = new Map<TaskReceiverMethod, TaskReceiverCallback>();
  if (options.methods["sampling/createMessage"] && options.sampling)
    callbacks.set("sampling/createMessage", options.sampling);
  if (options.methods["elicitation/create"] && options.elicitation)
    callbacks.set("elicitation/create", options.elicitation);
  for (const method of Object.keys(options.methods) as TaskReceiverMethod[]) {
    if (options.methods[method] && !callbacks.has(method))
      throw new Error(`Enabled receiver method ${method} requires a callback`);
  }

  const tasks = new Map<string, TaskRecord>();
  const installed = new Map<string, Handler>();
  const previous = new Map<string, Handler | undefined>();
  let closed = false;

  const report = (error: unknown, context: TaskReceiverErrorContext): void => {
    options.onError?.(error, context);
  };
  const snapshot = (record: TaskRecord): TaskV1 => ({ ...record.task });
  const notify = (
    record: TaskRecord,
    origin: TaskReceiverProtocolMethod,
  ): void => {
    const notification = {
      method: "notifications/tasks/status",
      params: snapshot(record),
    };
    void client.notification(notification).catch((error: unknown) => {
      report(error, { method: origin, taskId: record.task.taskId });
    });
  };
  const transition = (
    record: TaskRecord,
    status: TaskStatusV1,
    origin: TaskReceiverProtocolMethod,
    statusMessage?: string,
  ): void => {
    record.task = {
      ...record.task,
      status,
      lastUpdatedAt: new Date(now()).toISOString(),
      ...(statusMessage === undefined ? {} : { statusMessage }),
    };
    notify(record, origin);
  };
  const remove = (record: TaskRecord, disposition: FinalDisposition): void => {
    const firstDisposition = record.disposition === undefined;
    if (firstDisposition) {
      record.disposition = disposition;
      record.controller.abort();
      record.reject(
        new Error(
          `Task ${disposition === "expiry" ? "expired" : "receiver binding closed"}`,
        ),
      );
    }
    clearExpiry(record);
    tasks.delete(record.task.taskId);
  };
  const expire = (): void => {
    const timestamp = now();
    for (const record of tasks.values())
      if (record.expiresAt !== null && timestamp >= record.expiresAt)
        remove(record, "expiry");
  };
  const armExpiry = (record: TaskRecord): void => {
    if (record.expiresAt === null) return;
    const timer = setTimeout(
      () => {
        remove(record, "expiry");
      },
      Math.max(0, record.expiresAt - now()),
    );
    record.expiryTimer = timer;
    detachTimer(timer);
  };
  const get = (id: string): TaskRecord => {
    expire();
    const record = tasks.get(id);
    if (!record) throw new Error(`Unknown or expired task: ${id}`);
    return record;
  };
  const install = (
    method: string,
    handler: Handler,
    bypassTaskResultValidation = false,
  ): void => {
    const prior = internals._requestHandlers.get(method);
    previous.set(method, prior);
    const guarded: Handler = (request, context) => {
      if (closed)
        return Promise.reject(new Error("Task receiver binding is closed"));
      if (bypassTaskResultValidation && !hasTaskAugmentation(request) && prior)
        return prior(request, context);
      return handler(request, context);
    };
    // The SDK excludes legacy task methods from its public method union, but its
    // runtime custom-method path still accepts these handlers.
    (
      client.setRequestHandler as unknown as (
        method: string,
        handler: Handler,
      ) => void
    )(method, guarded);
    const validating = internals._requestHandlers.get(method);
    if (!validating)
      throw new Error(
        `SDK Client did not install request handler for ${method}`,
      );
    const installedHandler: Handler = bypassTaskResultValidation
      ? (request, context) =>
          hasTaskAugmentation(request)
            ? guarded(request, context)
            : validating(request, context)
      : validating;
    if (installedHandler !== validating)
      internals._requestHandlers.set(method, installedHandler);
    installed.set(method, installedHandler);
  };

  for (const [method, callback] of callbacks)
    install(
      method,
      (raw) => {
        expire();
        const params = paramsOf(raw);
        if (tasks.size >= maxTasks)
          throw new Error(
            `Task receiver capacity of ${String(maxTasks)} retained tasks reached`,
          );
        const id = makeId();
        if (tasks.has(id)) throw new Error(`Duplicate task identifier: ${id}`);
        const createdTimestamp = now();
        const createdAt = new Date(createdTimestamp).toISOString();
        const taskTtlMs = typeof ttlMs === "function" ? ttlMs() : ttlMs;
        nonNegativeInteger("ttlMs", taskTtlMs, true);
        let resolve!: (value: Record<string, JsonValue>) => void;
        let reject!: (error: unknown) => void;
        const result = new Promise<Record<string, JsonValue>>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        result.catch(() => undefined);
        const record: TaskRecord = {
          task: {
            taskId: id,
            status: "input_required",
            createdAt,
            lastUpdatedAt: createdAt,
            ttl: taskTtlMs,
            ...(pollIntervalMs === undefined || pollIntervalMs === null
              ? {}
              : { pollInterval: pollIntervalMs }),
          },
          method,
          result,
          resolve,
          reject,
          controller: new AbortController(),
          expiresAt: taskTtlMs === null ? null : createdTimestamp + taskTtlMs,
        };
        tasks.set(id, record);
        armExpiry(record);

        let callbackPromise: Promise<Record<string, JsonValue>>;
        try {
          callbackPromise = callback(
            { method, params },
            { taskId: id, signal: record.controller.signal },
          );
        } catch (error) {
          callbackPromise = Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        void callbackPromise.then(
          (value) => {
            if (record.disposition !== undefined) return;
            record.resolve(value);
            transition(record, "completed", record.method);
          },
          (error: unknown) => {
            if (record.disposition !== undefined) {
              report(error, {
                method: record.method,
                taskId: id,
                lateAfter: record.disposition,
              });
              return;
            }
            record.reject(error);
            transition(
              record,
              "failed",
              record.method,
              error instanceof Error ? error.message : String(error),
            );
            report(error, { method: record.method, taskId: id });
          },
        );
        return Promise.resolve({
          task: snapshot(record),
        } satisfies CreateTaskResultV1);
      },
      true,
    );

  install("tasks/list", (request) => {
    expire();
    const params = paramsOf(request);
    const cursor = Object.hasOwn(params, "cursor") ? params.cursor : undefined;
    if (cursor !== undefined && typeof cursor !== "string")
      throw new Error("tasks/list cursor must be a string");
    const records = [...tasks.values()];
    let start = 0;
    if (cursor !== undefined) {
      const cursorIndex = records.findIndex(
        (record) => record.task.taskId === cursor,
      );
      if (cursorIndex < 0)
        throw new Error("Invalid or stale tasks/list cursor");
      start = cursorIndex + 1;
    }
    const page = records.slice(start, start + pageSize);
    const hasMore = start + page.length < records.length;
    const last = page.at(-1);
    return Promise.resolve({
      tasks: page.map(snapshot),
      ...(hasMore && last !== undefined
        ? { nextCursor: last.task.taskId }
        : {}),
    });
  });
  install("tasks/get", (request) =>
    Promise.resolve(snapshot(get(taskIdOf(request)))),
  );
  install("tasks/result", async (request) => {
    const record = get(taskIdOf(request));
    if (
      record.task.status === "working" ||
      record.task.status === "input_required"
    )
      throw new Error("Task is not terminal");
    if (record.task.status === "cancelled")
      throw new Error("Task was cancelled");
    return record.result;
  });
  install("tasks/cancel", (request) => {
    const record = get(taskIdOf(request));
    if (
      record.task.status === "working" ||
      record.task.status === "input_required"
    ) {
      // Mark cancellation before aborting so re-entrant or immediately-settled
      // callbacks cannot overwrite an accepted cancellation.
      record.disposition = "cancel";
      transition(record, "cancelled", "tasks/cancel");
      record.controller.abort();
      record.reject(new Error("Task was cancelled"));
    }
    return Promise.resolve(snapshot(record));
  });

  const requests: TaskReceiverCapabilities["requests"] = {
    ...(callbacks.has("sampling/createMessage")
      ? { sampling: { createMessage: {} } }
      : {}),
    ...(callbacks.has("elicitation/create")
      ? { elicitation: { create: {} } }
      : {}),
  };
  return {
    capabilities: { list: {}, cancel: {}, requests },
    close() {
      if (closed) return;
      closed = true;
      for (const record of tasks.values()) remove(record, "close");
      tasks.clear();
      for (const [method, ours] of installed) {
        if (internals._requestHandlers.get(method) !== ours) continue;
        const prior = previous.get(method);
        if (prior) internals._requestHandlers.set(method, prior);
        else internals._requestHandlers.delete(method);
      }
    },
  };
}
