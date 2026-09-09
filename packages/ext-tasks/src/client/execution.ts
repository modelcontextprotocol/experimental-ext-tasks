import { ProtocolDecodeError } from "../core/index.js";
import type { RuntimeCodec } from "../core/index.js";
import { CallToolResultV1Schema } from "../core/v1/index.js";
import type { CallToolResultV1, TaskV1 } from "../core/v1/index.js";
import { CallToolResultV2Schema } from "../core/v2/index.js";
import type { CallToolResultV2 } from "../core/v2/index.js";
import {
  JsonRpcResponseError,
  TaskCancelledError,
  TaskExecutionClosedError,
  TaskFailedError,
  TaskUpdatesAlreadyAcquiredError,
} from "./api.js";
import type {
  SerializedTaskReference,
  TaskExecutionEvent,
  TaskHandle,
  TaskOutcome,
  TaskSessionEndpointId,
  TaskView,
  ToolDeclaration,
  ToolExecutionCommon,
  ToolExecutionSettleOptions,
  ToolExecutionSettlement,
} from "./api.js";
import { completedOutcome, projectTask, publicTaskHandle } from "./internal.js";
import type { InternalTaskHandle, InternalTaskSnapshot } from "./internal.js";
import type { SessionTaskCapabilities } from "./port.js";
import { linkAbortSignals, withAbort } from "./port.js";
import { throwIfAborted } from "./input-routing.js";

function codecFromSchema<T>(schema: {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: unknown };
}): RuntimeCodec<T> {
  return {
    parse(value) {
      const decoded = schema.safeParse(value);
      return decoded.success
        ? { success: true, value: decoded.data }
        : {
            success: false,
            error: new ProtocolDecodeError(
              "Protocol value failed schema validation",
              {},
              { cause: decoded.error },
            ),
          };
    },
  };
}

/** Selects the default tool-result codec for the negotiated task generation. */
export function defaultResultCodec(
  generation: SessionTaskCapabilities["generation"],
): RuntimeCodec<CallToolResultV1 | CallToolResultV2> {
  return generation === "v2"
    ? codecFromSchema(CallToolResultV2Schema)
    : codecFromSchema(CallToolResultV1Schema);
}

/** Normalizes an invalidation or abort reason to an Error instance. */
export function reasonAsError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(
    typeof reason === "string" ? reason : "MCP session was invalidated",
    { cause: reason },
  );
}

export const DEFAULT_TASK_POLL_INTERVAL_MS = 10;

/** Applies the minimum polling cadence to server-suggested task intervals. */
export function taskPollInterval(
  ...suggestedIntervals: readonly (number | undefined)[]
): number {
  return Math.max(
    DEFAULT_TASK_POLL_INTERVAL_MS,
    ...suggestedIntervals.filter(
      (interval): interval is number => interval !== undefined,
    ),
  );
}

/** Waits for the next task poll while remaining abortable. */
export async function waitForTaskPoll(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await withAbort(
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, Math.max(0, delayMs));
      }),
      signal,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type TaskTurn =
  | { readonly sequence: number; readonly snapshot: InternalTaskSnapshot }
  | undefined;

function wakeAll(waiters: Set<() => void>): void {
  for (const wake of waiters) wake();
  waiters.clear();
}

export interface TaskDriverContext {
  readonly accept: (snapshot: InternalTaskSnapshot) => InternalTaskSnapshot;
  readonly nextObservation: (
    afterSequence: number,
    delayMs: number | undefined,
    observation: (signal: AbortSignal) => Promise<InternalTaskSnapshot>,
  ) => Promise<TaskTurn>;
  readonly signal: AbortSignal;
  readonly inputSignal: AbortSignal;
  readonly errors: { readonly cancelled: Error; readonly closed: Error };
  readonly isClosed: () => boolean;
}

export type TaskDriver<TResult> = (
  context: TaskDriverContext,
) => Promise<TResult>;

interface TaskExecutionOptions<TResult, TApplicationContext> {
  readonly applicationContext: TApplicationContext;
  readonly handle: InternalTaskHandle;
  readonly declaration?: ToolDeclaration;
  readonly endpointId: TaskSessionEndpointId;
  readonly initialSnapshot: InternalTaskSnapshot;
  readonly driver: TaskDriver<TResult>;
  readonly cancelTask: (signal?: AbortSignal) => Promise<void>;
  readonly lifecycleSignal?: AbortSignal;
}

export class TaskExecution<
  TResult,
  TApplicationContext,
> implements ToolExecutionCommon<TResult, TApplicationContext> {
  readonly kind = "task" as const;
  readonly applicationContext: TApplicationContext;
  readonly declaration: ToolDeclaration | undefined;
  readonly handle: TaskHandle;
  private readonly internalHandle: InternalTaskHandle;
  private readonly endpointId: TaskSessionEndpointId;
  private readonly cancelTask: (signal?: AbortSignal) => Promise<void>;
  private readonly controller = new AbortController();
  private readonly inputController = new AbortController();
  private readonly cancellationController = new AbortController();
  private readonly resultPromise: Promise<TResult>;
  private readonly outcomePromise: Promise<TaskOutcome<TResult>>;
  private readonly cancelledError = new TaskCancelledError();
  private readonly closedError = new TaskExecutionClosedError();
  private readonly turnWaiters = new Set<() => void>();
  private readonly updateWaiters = new Set<() => void>();
  private readonly observationWaiters = new Set<() => void>();
  private readonly observedSnapshots: InternalTaskSnapshot[] = [];
  private initialSnapshot: InternalTaskSnapshot | undefined;
  private pendingSnapshot: InternalTaskSnapshot | undefined;
  private terminalSnapshot: InternalTaskSnapshot | undefined;
  private authoritativeTerminalSnapshot: InternalTaskSnapshot | undefined;
  private lastAcceptedBytes: string;
  private notificationSequence = 0;
  private latestNotifiedSnapshot: InternalTaskSnapshot | undefined;
  private updatesAcquired = false;
  private cancelPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private settlementPromise:
    Promise<ToolExecutionSettlement<TResult>> | undefined;
  private settled = false;
  private closed = false;

  constructor(options: TaskExecutionOptions<TResult, TApplicationContext>) {
    this.applicationContext = options.applicationContext;
    this.declaration = options.declaration;
    this.internalHandle = options.handle;
    this.handle = publicTaskHandle(options.handle);
    this.endpointId = options.endpointId;
    this.cancelTask = options.cancelTask;
    this.initialSnapshot = options.initialSnapshot;
    this.observedSnapshots.push(options.initialSnapshot);
    const initialBytes = deterministicJson(options.initialSnapshot);
    this.lastAcceptedBytes = initialBytes;
    if (terminalStatus(options.initialSnapshot.task.status)) {
      this.authoritativeTerminalSnapshot = options.initialSnapshot;
      this.inputController.abort();
    }
    const { lifecycleSignal } = options;
    if (lifecycleSignal !== undefined) {
      const abort = (): void => {
        this.controller.abort(lifecycleSignal.reason);
      };
      if (lifecycleSignal.aborted) abort();
      else lifecycleSignal.addEventListener("abort", abort, { once: true });
    }
    this.resultPromise = options.driver({
      accept: (snapshot) => this.acceptSnapshot(snapshot),
      nextObservation: (afterSequence, delayMs, observation) =>
        this.nextObservation(afterSequence, delayMs, observation),
      signal: this.controller.signal,
      inputSignal: this.inputController.signal,
      errors: {
        cancelled: this.cancelledError,
        closed: this.closedError,
      },
      isClosed: () => this.closed,
    });
    this.outcomePromise = this.resultPromise.then(
      (result) => ({
        status: "completed" as const,
        result,
        ...(this.authoritativeTerminalSnapshot === undefined
          ? {}
          : { task: projectTask(this.authoritativeTerminalSnapshot) }),
      }),
      (error: unknown) =>
        error === this.cancelledError
          ? {
              status: "cancelled" as const,
              ...(this.authoritativeTerminalSnapshot === undefined
                ? {}
                : { task: projectTask(this.authoritativeTerminalSnapshot) }),
            }
          : {
              status: "failed" as const,
              error:
                error instanceof TaskFailedError
                  ? error
                  : error instanceof JsonRpcResponseError
                    ? new TaskFailedError(
                        error.message,
                        { code: error.code, data: error.data },
                        { cause: error },
                      )
                    : new TaskFailedError(
                        error instanceof Error ? error.message : String(error),
                        {},
                        error instanceof Error ? { cause: error } : undefined,
                      ),
              ...(this.authoritativeTerminalSnapshot === undefined
                ? {}
                : { task: projectTask(this.authoritativeTerminalSnapshot) }),
            },
    );
    void this.outcomePromise.catch(() => {
      // The public outcome is cached even when callers detach without awaiting it.
    });
    void this.resultPromise.then(
      () => {
        this.settled = true;
      },
      () => {
        this.settled = true;
      },
    );
  }

  serializeReference(): SerializedTaskReference {
    return { endpointId: this.endpointId, ...this.internalHandle };
  }

  async handoff(
    persist: (reference: SerializedTaskReference) => void | Promise<void>,
  ): Promise<void> {
    await persist(this.serializeReference());
    await this.detach();
  }

  onNotification(snapshot: InternalTaskSnapshot): void {
    if (this.closed || snapshot.generation !== this.internalHandle.generation)
      return;
    if (snapshot.task.taskId !== this.internalHandle.taskId) return;
    this.transitionSnapshot(snapshot, "notification");
  }

  updates(signal?: AbortSignal): AsyncIterable<TaskExecutionEvent<TResult>> {
    if (this.updatesAcquired) throw new TaskUpdatesAlreadyAcquiredError();
    this.updatesAcquired = true;
    return this.iterateEvents(signal);
  }

  private async *iterateEvents(
    signal?: AbortSignal,
  ): AsyncIterable<TaskExecutionEvent<TResult>> {
    for (;;) {
      throwIfAborted(signal);
      const snapshot = this.takeQueuedUpdate();
      if (snapshot !== undefined) {
        yield { type: "task", task: projectTask(snapshot) };
        continue;
      }
      const settled = await this.waitForUpdateOrResult(signal);
      if (!settled) {
        yield { type: "outcome", outcome: await this.result() };
        return;
      }
    }
  }

  private takeQueuedUpdate(): InternalTaskSnapshot | undefined {
    if (this.initialSnapshot !== undefined) {
      const snapshot = this.initialSnapshot;
      this.initialSnapshot = undefined;
      return snapshot;
    }
    if (this.pendingSnapshot !== undefined) {
      const snapshot = this.pendingSnapshot;
      this.pendingSnapshot = undefined;
      return snapshot;
    }
    const snapshot = this.terminalSnapshot;
    this.terminalSnapshot = undefined;
    return snapshot;
  }

  private acceptSnapshot(snapshot: InternalTaskSnapshot): InternalTaskSnapshot {
    if (this.closed) return snapshot;
    return this.transitionSnapshot(snapshot, "accepted");
  }

  private transitionSnapshot(
    snapshot: InternalTaskSnapshot,
    source: "accepted" | "notification",
  ): InternalTaskSnapshot {
    // The first terminal snapshot is authoritative across polling, notifications,
    // result driving, and the update stream. Nothing may advance after it.
    if (this.authoritativeTerminalSnapshot !== undefined)
      return this.authoritativeTerminalSnapshot;
    const bytes = deterministicJson(snapshot);
    if (source === "accepted" && bytes === this.lastAcceptedBytes)
      return snapshot;

    let queuedUpdate = false;
    if (terminalStatus(snapshot.task.status)) {
      this.terminalSnapshot = snapshot;
      queuedUpdate = true;
      this.authoritativeTerminalSnapshot = snapshot;
      this.inputController.abort();
    } else if (source === "accepted") {
      this.pendingSnapshot = snapshot;
      queuedUpdate = true;
    }

    if (source === "accepted") {
      this.lastAcceptedBytes = bytes;
    } else {
      this.latestNotifiedSnapshot = snapshot;
      this.notificationSequence += 1;
      wakeAll(this.turnWaiters);
    }
    if (queuedUpdate) {
      this.observedSnapshots.push(snapshot);
      wakeAll(this.observationWaiters);
    }
    if (queuedUpdate) wakeAll(this.updateWaiters);
    return snapshot;
  }

  private async *observeEvents(
    signal?: AbortSignal,
  ): AsyncIterable<TaskExecutionEvent<TResult>> {
    let index = 0;
    for (;;) {
      throwIfAborted(signal);
      while (index < this.observedSnapshots.length) {
        const snapshot = this.observedSnapshots[index];
        index += 1;
        yield { type: "task", task: projectTask(snapshot) };
      }
      const settled = await this.waitForObservationOrResult(index, signal);
      if (!settled) {
        yield { type: "outcome", outcome: await this.result() };
        return;
      }
    }
  }

  private async waitForObservationOrResult(
    index: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (index < this.observedSnapshots.length) return true;
    let wake: (() => void) | undefined;
    const observed = new Promise<true>((resolve) => {
      wake = () => {
        resolve(true);
      };
      this.observationWaiters.add(wake);
    });
    try {
      return await withAbort(
        Promise.race([
          observed,
          this.resultPromise.then(
            () => false,
            () => false,
          ),
        ]),
        signal,
      );
    } finally {
      if (wake !== undefined) this.observationWaiters.delete(wake);
    }
  }

  private async waitForUpdateOrResult(signal?: AbortSignal): Promise<boolean> {
    if (
      this.pendingSnapshot !== undefined ||
      this.terminalSnapshot !== undefined
    )
      return true;
    let wake: (() => void) | undefined;
    const updated = new Promise<true>((resolve) => {
      wake = () => {
        resolve(true);
      };
      this.updateWaiters.add(wake);
    });
    try {
      return await withAbort(
        Promise.race([
          updated,
          this.resultPromise.then(
            () => false,
            () => false,
          ),
        ]),
        signal,
      );
    } finally {
      if (wake !== undefined) this.updateWaiters.delete(wake);
    }
  }

  private notifiedSnapshotAfter(afterSequence: number): TaskTurn {
    if (
      this.notificationSequence > afterSequence &&
      this.latestNotifiedSnapshot !== undefined
    ) {
      return {
        sequence: this.notificationSequence,
        snapshot: this.latestNotifiedSnapshot,
      };
    }
    return undefined;
  }

  private async waitForTurn(
    afterSequence: number,
    delayMs: number | undefined,
  ): Promise<TaskTurn> {
    const current = this.notifiedSnapshotAfter(afterSequence);
    if (current !== undefined) return current;
    if (delayMs === undefined) {
      await Promise.resolve();
      throwIfAborted(this.controller.signal);
      return this.notifiedSnapshotAfter(afterSequence);
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        clearTimeout(timeout);
        this.turnWaiters.delete(onTurn);
        this.controller.signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(reasonAsError(error));
      };
      const onTurn = (): void => {
        finish();
      };
      const onAbort = (): void => {
        finish(this.controller.signal.reason);
      };
      const timeout = setTimeout(onTurn, Math.max(0, delayMs));
      this.turnWaiters.add(onTurn);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return this.notifiedSnapshotAfter(afterSequence);
  }

  private async nextObservation(
    afterSequence: number,
    delayMs: number | undefined,
    observation: (signal: AbortSignal) => Promise<InternalTaskSnapshot>,
  ): Promise<TaskTurn> {
    const turn = await this.waitForTurn(afterSequence, delayMs);
    if (turn !== undefined) return turn;

    let wake: (() => void) | undefined;
    const notified = new Promise<TaskTurn>((resolve) => {
      wake = () => {
        resolve(this.notifiedSnapshotAfter(afterSequence));
      };
      this.turnWaiters.add(wake);
    });
    // Register before checking again so a notification cannot land between the
    // clean check and observer registration.
    const current = this.notifiedSnapshotAfter(afterSequence);
    if (current !== undefined) {
      if (wake !== undefined) this.turnWaiters.delete(wake);
      return current;
    }

    const observationLifecycle = linkAbortSignals(this.controller.signal);
    try {
      const observationPromise = observation(observationLifecycle.signal);
      void observationPromise.catch(() => {});
      return await withAbort(
        Promise.race([
          observationPromise.then((snapshot) => ({
            sequence: afterSequence,
            snapshot,
          })),
          notified,
        ]),
        this.controller.signal,
      );
    } finally {
      if (!observationLifecycle.signal.aborted) observationLifecycle.abort();
      observationLifecycle.dispose();
      if (wake !== undefined) this.turnWaiters.delete(wake);
    }
  }

  result(): Promise<TaskOutcome<TResult>> {
    return this.outcomePromise;
  }

  settle(
    options: ToolExecutionSettleOptions<TResult> = {},
  ): Promise<ToolExecutionSettlement<TResult>> {
    this.settlementPromise ??= settleExecution(
      this,
      this.observeEvents(options.signal),
      options,
    );
    return this.settlementPromise;
  }

  inputSignal(): AbortSignal {
    return this.inputController.signal;
  }

  endInputLifetime(): void {
    this.inputController.abort();
  }

  cancel(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.cancelPromise ??= this.cancelTask(this.cancellationController.signal);
    return signal === undefined
      ? this.cancelPromise
      : withAbort(this.cancelPromise, signal);
  }

  detach(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.controller.abort(this.closedError);
    this.inputController.abort(this.closedError);
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const shouldCancel = !this.settled;
    this.closePromise = this.detach();
    if (shouldCancel)
      void this.cancel().catch(() => {
        // Cooperative cancellation is best effort during close.
      });
    return this.closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** Produces stable JSON-like text by sorting object keys recursively. */
export function deterministicJson(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return `[${typeof value}]`;
  if (Array.isArray(value))
    return `[${value.map(deterministicJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${deterministicJson(record[key])}`)
    .join(",")}}`;
}

/** Returns whether a task status is terminal. */
export function terminalStatus(status: TaskV1["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

async function settleExecution<TResult>(
  execution: ToolExecutionCommon<TResult, unknown>,
  events: AsyncIterable<TaskExecutionEvent<TResult>>,
  options: ToolExecutionSettleOptions<TResult>,
): Promise<ToolExecutionSettlement<TResult>> {
  let lastTask: TaskView | undefined;
  const observation = (async () => {
    for await (const event of events) {
      if (event.type === "task") lastTask = event.task;
      await options.onEvent?.(event);
    }
  })();
  const outcome = withAbort(execution.result(), options.signal);
  const first = await Promise.race([
    outcome.then(
      (value) => ({ branch: "outcome" as const, value }),
      (error: unknown) => ({ branch: "outcome-error" as const, error }),
    ),
    observation.then(
      () => ({ branch: "observation" as const }),
      (error: unknown) => ({ branch: "observation-error" as const, error }),
    ),
  ]);
  if (first.branch === "observation-error") {
    await execution.detach();
    throw first.error;
  }
  if (first.branch === "outcome-error") {
    await execution.detach();
    await observation.catch(() => {});
    throw first.error;
  }
  const outcomeValue = first.branch === "outcome" ? first.value : await outcome;
  await observation;
  if (options.close !== false) {
    try {
      await execution.close();
    } catch {
      // Settlement cleanup is best effort and never masks execution outcomes.
    }
  }
  return { outcome: outcomeValue, lastTask };
}

export class ImmediateExecution<
  TResult,
  TApplicationContext,
> implements ToolExecutionCommon<TResult, TApplicationContext> {
  readonly kind = "immediate" as const;
  readonly handle = undefined;
  readonly declaration: ToolDeclaration | undefined;
  private readonly outcomePromise: Promise<TaskOutcome<TResult>>;
  private settlementPromise:
    Promise<ToolExecutionSettlement<TResult>> | undefined;

  constructor(
    readonly applicationContext: TApplicationContext,
    private readonly resultPromise: Promise<TResult>,
    declaration?: ToolDeclaration,
  ) {
    this.declaration = declaration;
    this.outcomePromise = completedOutcome(this.resultPromise);
  }

  updates(signal?: AbortSignal): AsyncIterable<TaskExecutionEvent<TResult>> {
    throwIfAborted(signal);
    const outcome = this.result();
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "outcome" as const, outcome: await outcome };
      },
    };
  }

  result(): Promise<TaskOutcome<TResult>> {
    return this.outcomePromise;
  }

  settle(
    options: ToolExecutionSettleOptions<TResult> = {},
  ): Promise<ToolExecutionSettlement<TResult>> {
    this.settlementPromise ??= settleExecution(
      this,
      this.updates(options.signal),
      options,
    );
    return this.settlementPromise;
  }

  cancel(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return Promise.resolve();
  }

  detach(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
