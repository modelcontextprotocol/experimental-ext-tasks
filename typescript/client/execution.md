# Observe and control execution

`session.callTool()` returns a `ToolExecution` for immediate and task-backed results. Choose the runtime policy after the server responds.

## Settle and observe progress

```ts
import { resultFromTaskOutcome } from "@modelcontextprotocol/ext-tasks/client";

const execution = await session.callTool("render-report", {
  accountId: "acct-42",
});

const { outcome, lastTask } = await execution.settle({
  onEvent(event) {
    if (event.type === "task") {
      console.log(event.task.status, event.task.statusMessage);
    }
  },
});

const report = resultFromTaskOutcome(outcome);
```

An immediate result may produce no task event. A task-backed call reports task snapshots as it progresses. `lastTask` contains the most recent snapshot.

Task-backed executions also expose the task handle and handoff API:

```ts
if (execution.kind === "task") {
  console.log(execution.handle.taskId);
  await execution.handoff((reference) => taskStore.save(reference));
}
```

## Read the terminal outcome

```ts
const outcome = await execution.result();

switch (outcome.status) {
  case "completed":
    console.log(outcome.result);
    break;
  case "failed":
    console.error(outcome.error.message);
    break;
  case "cancelled":
    console.log("The work was cancelled");
    break;
}
```

Switch on `outcome.status` when failed and cancelled states are application data. Use `resultFromTaskOutcome(outcome)` for result-or-throw handling.

## Choose what happens when you stop waiting

| Method     | Effect                                                        |
| ---------- | ------------------------------------------------------------- |
| `cancel()` | Requests remote cancellation and releases local ownership.    |
| `detach()` | Releases local ownership while the remote task keeps running. |
| `close()`  | Releases ownership and best-effort cancels unfinished work.   |

Aborting a settlement or observation signal stops local waiting. Use `cancel()` to request remote cancellation.

## Observe the update stream yourself

A UI may need its own async stream instead of an `onEvent` callback:

```ts
for await (const event of execution.updates()) {
  if (event.type === "task") renderProgress(event.task);
  if (event.type === "outcome") renderOutcome(event.outcome);
}
```

`updates()` has one consumer. A second acquisition throws `TaskUpdatesAlreadyAcquiredError`. Use `settle({ onEvent })` when a separate stream is unnecessary.

## Set request context

```ts
const execution = await session.callTool(
  "render-report",
  { accountId: "acct-42" },
  {
    headers: { "x-trace-id": "trace-9" },
    requestTimeoutMs: 15_000,
    signal: AbortSignal.timeout(60_000),
  },
);
```

`headers` and `requestTimeoutMs` apply to the initial call and every task follow-up request. The timeout is per request. `signal` bounds the caller's local lifecycle across the operation.

For a task ID obtained elsewhere, pass the same request context when creating `session.task(taskId, options)`. Manual controllers and cross-session handoff are covered in [Application input and recovery](./input-and-recovery.md).

## Next steps

Continue with [application input and recovery](./input-and-recovery.md) when a tool can pause for input or outlive this connection. See [Troubleshooting](../troubleshooting.md) for ownership and cancellation failures.
