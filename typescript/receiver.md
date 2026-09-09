# Receive 2025-11-25 Tasks requests

`bindTaskReceiver()` adds 2025-11-25 Tasks lifecycle handling for incoming sampling and elicitation requests.

## Bind the receiver

```ts
import { bindTaskReceiver } from "@modelcontextprotocol/ext-tasks/receiver";

const receiver = bindTaskReceiver(client, {
  methods: { "sampling/createMessage": true },
  sampling: async (request, { signal }) => {
    return runSampling(request.params, { signal });
  },
});

// Include this value under the client's advertised Tasks capability.
const tasks = receiver.capabilities;

try {
  await runClient(client, { capabilities: { tasks } });
} finally {
  receiver.close();
}
```

The binding owns the task lifecycle. Your callback owns the application work and receives the task ID and an `AbortSignal`.

Add `receiver.capabilities` to the host's advertised Tasks capability. The exact SDK hook depends on how the host initializes its client.

The supported task-backed request methods are `sampling/createMessage` and `elicitation/create`.

## Add the methods your application supports

Enable the request methods and provide their callbacks:

```ts
const receiver = bindTaskReceiver(client, {
  methods: {
    "sampling/createMessage": true,
    "elicitation/create": true,
  },
  sampling: async (request, context) =>
    runSampling(request.params, { signal: context.signal }),
  elicitation: async (request, context) =>
    askUser(request.params, { signal: context.signal }),
});

console.log(receiver.capabilities);
// {
//   list: {},
//   cancel: {},
//   requests: {
//     sampling: { createMessage: {} },
//     elicitation: { create: {} },
//   },
// }
```

Each enabled method requires its callback. `receiver.capabilities` reflects the enabled methods plus task listing and cancellation.

## What happens after a request arrives

Sampling and elicitation tasks start in `input_required`. When the callback settles:

- a returned result moves the task to `completed` and becomes available through `tasks/result`;
- a thrown error moves the task to `failed` and rejects `tasks/result`;
- each transition emits `notifications/tasks/status` without delaying the transition.

## Set production limits

Configure retention, polling hints, pagination, and capacity as needed:

```ts
const receiver = bindTaskReceiver(client, {
  methods: { "elicitation/create": true },
  elicitation: async (request, { signal }) =>
    askUser(request.params, { signal }),
  ttlMs: () => 60_000,
  pollIntervalMs: 1_000,
  pageSize: 50,
  maxTasks: 500,
});
```

| Option           | Behavior                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ttlMs`          | Total lifetime from task creation. Use a non-negative integer, `null`, or a function returning either. The function is sampled once per task. The default is `null` (no time expiry). |
| `pollIntervalMs` | Non-negative polling hint. `null` or omission leaves the hint off the task.                                                                                                           |
| `pageSize`       | Maximum records in one `tasks/list` page. Must be a positive integer; defaults to `100`.                                                                                              |
| `maxTasks`       | Maximum retained records, including pending work. Must be a positive integer; defaults to `1,000`.                                                                                    |
| `createTaskId`   | Optional ID factory. Otherwise the binding uses `crypto.randomUUID()`.                                                                                                                |

A finite `ttlMs` expires from task creation. Reaching `maxTasks` rejects new task creation.

## Handle cancellation and background errors

`tasks/cancel` marks the task cancelled and aborts the callback signal.

Report failures that happen outside the request/response path with `onError`:

```ts
const receiver = bindTaskReceiver(client, {
  methods: { "sampling/createMessage": true },
  sampling: async (request, { signal }) =>
    runSampling(request.params, { signal }),
  onError(error, context) {
    logger.error({ error, ...context }, "task receiver background error");
  },
});
```

`context` identifies the method and task, and marks callback failures that arrive after cancellation, expiry, or close.

## Clean up

Close the binding when the client role ends:

```ts
try {
  await serve();
} finally {
  receiver.close();
}
```

`close()` aborts pending callbacks and releases retained task state.

## Next steps

See [Troubleshooting](./troubleshooting.md) for capacity, expiry, and cancellation failures. If you need a custom client adapter or wire-level schemas, continue to [Adapters and schemas](./adapters-and-schemas.md).
