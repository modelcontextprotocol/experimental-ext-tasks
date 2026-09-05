import type { RuntimeCodec, TaskSnapshot } from "../core/index.js";
import {
  CallToolResultV1Codec,
  type CallToolResultV1,
  type TaskV1,
} from "../core/v1/index.js";
import {
  CallToolResultV2Codec,
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

/** Selects the default tool-result codec for the negotiated task generation. */
export function defaultResultCodec(
  generation: SessionTaskCapabilities["generation"],
): RuntimeCodec<CallToolResultV1 | CallToolResultV2> {
  return generation === "v2" ? CallToolResultV2Codec : CallToolResultV1Codec;
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

export type TaskDriver<TResult> = (
  accept: (snapshot: TaskSnapshot) => void,
  waitForTurn: (
    afterSequence: number,
    delayMs: number | undefined,
  ) => Promise<TaskTurn>,
  observe: (
    afterSequence: number,
    observation: (signal: AbortSignal) => Promise<TaskSnapshot>,
  ) => Promise<TaskTurn>,
  signal: AbortSignal,
  cancelledError: Error,
  closedError: Error,
  isClosed: () => boolean,
  inputSignal: AbortSignal,
) => Promise<TResult>;

export class TaskExecution<
  TResult,
  TApplicationContext,
> implements ToolExecutionCommon<TResult, TApplicationContext> {
  readonly kind = "task" as const;
  private readonly controller = new AbortController();
  private readonly inputController = new AbortController();
  private readonly cancellationController = new AbortController();
  private readonly resultPromise: Promise<TResult>;
  private readonly cancelledError = new Error("Task was cancelled");
  private readonly closedError = new TaskExecutionClosedError();
  private readonly notificationWaiters = new Set<() => void>();
  private readonly updateWaiters = new Set<() => void>();
  private initialSnapshot: TaskSnapshot | undefined;
  private pendingSnapshot: TaskSnapshot | undefined;
  private terminalSnapshot: TaskSnapshot | undefined;
  private terminalSnapshotBytes: string | undefined;
  private lastAcceptedBytes: string;
  private notificationSequence = 0;
  private latestNotification: TaskSnapshot | undefined;
  private updatesAcquired = false;
  private cancelPromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    readonly applicationContext: TApplicationContext,
    readonly handle: TaskHandle,
    private readonly endpointId: string,
    initialSnapshot: TaskSnapshot,
    driver: TaskDriver<TResult>,
    private readonly cancelTask: (signal?: AbortSignal) => Promise<void>,
    lifecycleSignal?: AbortSignal,
  ) {
    this.initialSnapshot = initialSnapshot;
    if (terminalStatus(initialSnapshot.task.status))
      this.inputController.abort();
    this.lastAcceptedBytes = deterministicJson(initialSnapshot);
    if (lifecycleSignal !== undefined) {
      const abort = (): void => this.controller.abort(lifecycleSignal.reason);
      if (lifecycleSignal.aborted) abort();
      else lifecycleSignal.addEventListener("abort", abort, { once: true });
    }
    this.resultPromise = driver(
      (snapshot) => this.accept(snapshot),
      (afterSequence, delayMs) => this.waitForTurn(afterSequence, delayMs),
      (afterSequence, observation) =>
        this.observeOrNotification(afterSequence, observation),
      this.controller.signal,
      this.cancelledError,
      this.closedError,
      () => this.closed,
      this.inputController.signal,
    );
  }

  serializeReference(): SerializedTaskReference {
    return { endpointId: this.endpointId, ...this.handle };
  }

  onNotification(snapshot: TaskSnapshot): void {
    if (this.closed || snapshot.generation !== this.handle.generation) return;
    if (snapshot.task.taskId !== this.handle.taskId) return;
    const bytes = deterministicJson(snapshot);
    if (terminalStatus(snapshot.task.status)) {
      this.inputController.abort();
      if (this.terminalSnapshotBytes === undefined) {
        this.terminalSnapshot = snapshot;
        this.terminalSnapshotBytes = bytes;
      }
    } else if (this.terminalSnapshotBytes !== undefined) {
      return;
    }
    this.latestNotification = snapshot;
    this.notificationSequence += 1;
    for (const wake of this.notificationWaiters) wake();
    this.notificationWaiters.clear();
    for (const wake of this.updateWaiters) wake();
    this.updateWaiters.clear();
  }

  updates(signal?: AbortSignal): AsyncIterable<TaskSnapshot> {
    if (this.updatesAcquired) throw new TaskUpdatesAlreadyAcquiredError();
    this.updatesAcquired = true;
    return this.iterateUpdates(signal);
  }

  private async *iterateUpdates(
    signal?: AbortSignal,
  ): AsyncIterable<TaskSnapshot> {
    while (true) {
      throwIfAborted(signal);
      if (this.initialSnapshot !== undefined) {
        const snapshot = this.initialSnapshot;
        this.initialSnapshot = undefined;
        yield snapshot;
        continue;
      }
      if (this.pendingSnapshot !== undefined) {
        const snapshot = this.pendingSnapshot;
        this.pendingSnapshot = undefined;
        yield snapshot;
        continue;
      }
      if (this.terminalSnapshot !== undefined) {
        const snapshot = this.terminalSnapshot;
        this.terminalSnapshot = undefined;
        yield snapshot;
        continue;
      }
      const settled = await this.waitForUpdateOrResult(signal);
      if (
        !settled &&
        this.initialSnapshot === undefined &&
        this.pendingSnapshot === undefined &&
        this.terminalSnapshot === undefined
      )
        return;
    }
  }

  private accept(snapshot: TaskSnapshot): void {
    if (this.closed) return;
    const bytes = deterministicJson(snapshot);
    if (bytes === this.lastAcceptedBytes) return;
    this.lastAcceptedBytes = bytes;
    if (terminalStatus(snapshot.task.status)) {
      this.inputController.abort();
      if (bytes !== this.terminalSnapshotBytes) {
        this.terminalSnapshot ??= snapshot;
        this.terminalSnapshotBytes ??= bytes;
      }
    } else if (this.terminalSnapshotBytes === undefined) {
      this.pendingSnapshot = snapshot;
    }
    for (const wake of this.updateWaiters) wake();
    this.updateWaiters.clear();
  }

  private async waitForUpdateOrResult(signal?: AbortSignal): Promise<boolean> {
    if (
      this.pendingSnapshot !== undefined ||
      this.terminalSnapshot !== undefined
    )
      return true;
    let wake: (() => void) | undefined;
    const updated = new Promise<true>((resolve) => {
      wake = () => resolve(true);
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

  private currentTurn(afterSequence: number): TaskTurn {
    if (
      this.notificationSequence > afterSequence &&
      this.latestNotification !== undefined
    ) {
      return {
        sequence: this.notificationSequence,
        snapshot: this.latestNotification,
      };
    }
    return undefined;
  }

  private async waitForTurn(
    afterSequence: number,
    delayMs: number | undefined,
  ): Promise<TaskTurn> {
    const current = this.currentTurn(afterSequence);
    if (current !== undefined) return current;
    if (delayMs === undefined) {
      await Promise.resolve();
      throwIfAborted(this.controller.signal);
      return this.currentTurn(afterSequence);
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        clearTimeout(timeout);
        this.notificationWaiters.delete(onNotification);
        this.controller.signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(reasonAsError(error));
      };
      const onNotification = (): void => finish();
      const onAbort = (): void => finish(this.controller.signal.reason);
      const timeout = setTimeout(onNotification, Math.max(0, delayMs));
      this.notificationWaiters.add(onNotification);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return this.currentTurn(afterSequence);
  }

  private async observeOrNotification(
    afterSequence: number,
    observation: (signal: AbortSignal) => Promise<TaskSnapshot>,
  ): Promise<TaskTurn> {
    const current = this.currentTurn(afterSequence);
    if (current !== undefined) return current;
    const observationLifecycle = linkAbortSignals(this.controller.signal);
    const observationPromise = observation(observationLifecycle.signal);
    void observationPromise.catch(() => {});
    let wake: (() => void) | undefined;
    const notified = new Promise<TaskTurn>((resolve) => {
      wake = () => resolve(this.currentTurn(afterSequence));
      this.notificationWaiters.add(wake);
    });
    try {
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
      if (wake !== undefined) this.notificationWaiters.delete(wake);
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
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded ?? `[${typeof value}]`;
  }
  if (Array.isArray(value))
    return `[${value.map(deterministicJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${deterministicJson(record[key])}`)
    .join(",")}}`;
}

/** Returns whether a V1 task status is terminal. */
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
