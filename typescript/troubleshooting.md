# Troubleshooting

## Session created before connection

Create the Tasks session after the SDK client connects:

```ts
await client.connect(transport);
const session = createTaskSessionFromClient(client, { endpointId });
```

Create a new Tasks session when replacing or reconnecting the SDK client.

## Adapter already active for this Client

One SDK `Client` can have one active Tasks session. Close the current session before creating another:

```ts
await session.close();
const nextSession = createTaskSessionFromClient(client, { endpointId });
```

## V2 requires raw dispatch

Pass the host request coordinator and initialization framing together:

```ts
const session = createTaskSessionFromClient(client, {
  endpointId,
  rawDispatch: hostRequestCoordinator.dispatch,
  v2RequestFraming: { protocolVersion, clientInfo, clientCapabilities },
});
```

See [Adapters and schemas](./adapters-and-schemas.md).

## Failed and cancelled outcomes do not throw

`result()` and `settle()` return terminal outcomes:

```ts
const { outcome } = await execution.settle();

if (outcome.status === "completed") useResult(outcome.result);
if (outcome.status === "failed") reportTaskFailure(outcome.error);
if (outcome.status === "cancelled") reportCancellation();
```

Use `resultFromTaskOutcome(outcome)` for result-or-throw handling.

## Input callback context is missing

Pass application context with the call:

```ts
await session.callTool("review", input, {
  applicationContext: { requestId: "request-42" },
});
```

Read it from `context.applicationContext` in the input callback. See [Input and recovery](./client/input-and-recovery.md).

## Task updates already acquired

`execution.updates()` has one consumer. Fan out events inside the application, or use `onEvent` with `execution.settle()`.

## Recovery fails

Create the session with the same `endpointId` used by the source execution, then resume the stored reference:

```ts
const recovered = await session.resumeTask(await taskStore.load());
```

An unknown task has expired or was removed by the server. `TaskRecoveryOwnershipError` indicates an endpoint, generation, operation, or local ownership mismatch.

Use `execution.handoff((reference) => taskStore.save(reference))` when transferring a live task to durable storage.

## Cancellation and detachment

See [Cancellation and detachment](./client/execution.md#choose-what-happens-when-you-stop-waiting). An `AbortSignal` stops local waiting; `cancel()` requests remote cancellation.

## Task execution unsupported

Check `session.capabilities.execution` and the tool declaration. Use `task.preference: "allow"` to accept an immediate result, or `"require"` to require task-backed execution.

## 2025-11-25 receiver capacity or expiry

Configure `maxTasks` and `ttlMs`:

```ts
const receiver = bindTaskReceiver(client, {
  methods: { "sampling/createMessage": true },
  sampling: handleSampling,
  maxTasks: 100,
  ttlMs: 60_000,
});
```

At capacity, new task creation is rejected. After TTL expiry, the task is no longer retained.

## Request timeout missing from follow-up requests

Set request context on the tool call:

```ts
const execution = await session.callTool("generate_report", input, {
  requestTimeoutMs: 15_000,
  headers: { authorization: `Bearer ${token}` },
});
```

The session applies these options to the initial call and task follow-up requests.
