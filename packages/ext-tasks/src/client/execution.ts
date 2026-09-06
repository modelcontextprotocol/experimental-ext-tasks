import type { TaskSnapshot } from "../core/index.js";
import type { z } from "zod/v4";
import {
  CallToolResultV1Schema,
  type CallToolResultV1,
  type TaskV1,
} from "../core/v1/index.js";
import {
  CallToolResultV2Schema,
  type CallToolResultV2,
} from "../core/v2/index.js";
import {
  TaskExecutionClosedError,
  TaskUpdatesAlreadyAcquiredError,
  type SerializedTaskReference,
  type TaskHandle,
  type ToolExecutionCommon,
} from "./api.js";
import type { SessionTaskCapabilities } from "./port.js";
import { linkAbortSignals, withAbort } from "./port.js";
import { throwIfAborted } from "./input-routing.js";

/** Selects the default tool-result schema for the negotiated task generation. */
export function defaultResultSchema(
  generation: SessionTaskCapabilities["generation"],
): z.ZodType<CallToolResultV1 | CallToolResultV2> {
  return generation === "v2" ? CallToolResultV2Schema : CallToolResultV1Schema;
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

type TaskTurn =
  { readonly sequence: number; readonly snapshot: TaskSnapshot } | undefined;

function wakeAll(waiters: Set<() => void>): void {
  for (const wake of waiters) wake();
  waiters.clear();
}

export interface TaskDriverContext {
  readonly accept: (snapshot: TaskSnapshot) => TaskSnapshot;
  readonly nextObservation: (
    afterSequence: number,
    delayMs: number | undefined,
    observation: (signal: AbortSignal) => Promise<TaskSnapshot>,
  ) => Promise<TaskTurn>;
  readonly signal: AbortSignal;
  readonly inputSignal: AbortSignal;
  readonly errors: {
    readonly cancelled: Error;
    readonly closed: Error;
  };
  readonly isClosed: () => boolean;
}

export type TaskDriver<TResult> = (
  context: TaskDriverContext,
) => Promise<TResult>;

interface TaskExecutionOptions<TResult, TApplicationContext> {
  readonly applicationContext: TApplicationContext;
  readonly handle: TaskHandle;
  readonly endpointId: string;
  readonly initialSnapshot: TaskSnapshot;
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
  readonly handle: TaskHandle;
  private readonly endpointId: string;
  private readonly cancelTask: (signal?: AbortSignal) => Promise<void>;
  private readonly controller = new AbortController();
  private readonly inputController = new AbortController();
  private readonly cancellationController = new AbortController();
  private readonly resultPromise: Promise<TResult>;
  private readonly cancelledError = new Error("Task was cancelled");
  private readonly closedError = new TaskExecutionClosedError();
  private readonly turnWaiters = new Set<() => void>();
  private readonly updateWaiters = new Set<() => void>();
  private initialSnapshot: TaskSnapshot | undefined;
  private pendingSnapshot: TaskSnapshot | undefined;
  private terminalSnapshot: TaskSnapshot | undefined;
  private authoritativeTerminalSnapshot: TaskSnapshot | undefined;
  private lastAcceptedBytes: string;
  private notificationSequence = 0;
  private latestNotifiedSnapshot: TaskSnapshot | undefined;
  private updatesAcquired = false;
  private cancelPromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: TaskExecutionOptions<TResult, TApplicationContext>) {
    this.applicationContext = options.applicationContext;
    this.handle = options.handle;
    this.endpointId = options.endpointId;
    this.cancelTask = options.cancelTask;
    this.initialSnapshot = options.initialSnapshot;
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
  }

  serializeReference(): SerializedTaskReference {
    return { endpointId: this.endpointId, ...this.handle };
  }

  onNotification(snapshot: TaskSnapshot): void {
    if (this.closed || snapshot.generation !== this.handle.generation) return;
    if (snapshot.task.taskId !== this.handle.taskId) return;
    this.transitionSnapshot(snapshot, "notification");
  }

  updates(signal?: AbortSignal): AsyncIterable<TaskSnapshot> {
    if (this.updatesAcquired) throw new TaskUpdatesAlreadyAcquiredError();
    this.updatesAcquired = true;
    return this.iterateUpdates(signal);
  }

  private async *iterateUpdates(
    signal?: AbortSignal,
  ): AsyncIterable<TaskSnapshot> {
    for (;;) {
      throwIfAborted(signal);
      const snapshot = this.takeQueuedUpdate();
      if (snapshot !== undefined) {
        yield snapshot;
        continue;
      }
      const settled = await this.waitForUpdateOrResult(signal);
      if (!settled) return;
    }
  }

  private takeQueuedUpdate(): TaskSnapshot | undefined {
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

  private acceptSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
    if (this.closed) return snapshot;
    return this.transitionSnapshot(snapshot, "accepted");
  }

  private transitionSnapshot(
    snapshot: TaskSnapshot,
    source: "accepted" | "notification",
  ): TaskSnapshot {
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
    if (queuedUpdate) wakeAll(this.updateWaiters);
    return snapshot;
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
    observation: (signal: AbortSignal) => Promise<TaskSnapshot>,
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

  result(): Promise<TResult> {
    return this.resultPromise;
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

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.controller.abort(this.closedError);
      this.inputController.abort(this.closedError);
      void this.cancel().catch(() => {
        // Cooperative cancellation is best effort during close.
      });
    }
    return Promise.resolve();
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

export class ImmediateExecution<
  TResult,
  TApplicationContext,
> implements ToolExecutionCommon<TResult, TApplicationContext> {
  readonly kind = "immediate" as const;
  readonly handle = undefined;

  constructor(
    readonly applicationContext: TApplicationContext,
    private readonly resultPromise: Promise<TResult>,
  ) {}

  updates(signal?: AbortSignal): AsyncIterable<TaskSnapshot> {
    throwIfAborted(signal);
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve({ done: true as const, value: undefined }),
        };
      },
    };
  }

  result(): Promise<TResult> {
    return this.resultPromise;
  }

  cancel(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
