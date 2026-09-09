/** Test-only adapters for legacy assertions whose subject is not semantic outcomes. */

import type { JsonValue } from "../../src/core/index.js";
import { TaskCancelledError } from "../../src/client/index.js";
import type {
  TaskExecutionEvent,
  TaskOutcome,
} from "../../src/client/index.js";

interface OutcomeSource<TResult> {
  result(): Promise<TaskOutcome<TResult>>;
}

interface EventSource<TResult> {
  updates(): AsyncIterable<TaskExecutionEvent<TResult>>;
}

/** Unwraps a semantic outcome for tests focused on unrelated behavior. */
export async function legacyResult<TResult>(
  source: OutcomeSource<TResult>,
): Promise<TResult> {
  const outcome = await source.result();
  if (outcome.status === "completed") return outcome.result;
  if (outcome.status === "failed") {
    if (outcome.error.cause instanceof Error) throw outcome.error.cause;
    throw outcome.error;
  }
  throw new TaskCancelledError();
}

/** Reconstructs generated snapshots for tests focused on legacy race behavior. */
export async function* legacyUpdates<TResult>(
  source: EventSource<TResult>,
): AsyncIterable<{
  readonly generation: "v1" | "v2";
  readonly task: Readonly<Record<string, JsonValue>>;
}> {
  for await (const event of source.updates()) {
    if (event.type !== "task") continue;
    yield {
      generation: "ttl" in event.task.raw ? "v1" : "v2",
      task: event.task.raw,
    };
  }
}
