# Handle application input and recover tasks

A long-running tool may pause to ask your application for something: user approval, a model response, or a list of roots. Add one input handler to the session, and the package routes each request back to the execution that caused it.

## Answer input requests

```ts
import {
  createApplicationInputHandler,
  createTaskSessionFromClient,
  type ResolvedInputExchangeContext,
} from "@modelcontextprotocol/ext-tasks/client";

type AppContext = { traceId: string };

const onInputRequest = createApplicationInputHandler<AppContext>({
  elicitation: async (_request, _context) => {
    return { action: "accept", content: { approved: true } };
  },
  sampling: async (request, context) => {
    return runModel(request.params, { signal: context.signal });
  },
  roots: async (_request, context) => {
    return { roots: await findRoots(context.applicationContext.traceId) };
  },
});

const session = createTaskSessionFromClient<AppContext>(client, {
  endpointId,
  onInputRequest,
  onError(error) {
    logger.error(error, "task input failed");
  },
});
```

`createApplicationInputHandler()` keeps the request and response types paired for each input kind. The callback context carries the application state and abort signal for the execution that owns the request.

Pass that application state when you start the call:

```ts
const execution = await session.callTool(
  "prepare-release",
  { version: "2.4.0" },
  { applicationContext: { traceId: "trace-9" } },
);
```

## Distinguish request input from task input

Every callback context tells you where the input belongs:

```ts
function auditInput(context: ResolvedInputExchangeContext<AppContext>): void {
  if (context.scope === "request") {
    console.log("Input continues the active request", context.inputId);
  } else {
    console.log("Input belongs to task", context.taskId, context.inputId);
  }
}
```

Request-scoped input continues the active tool call. Task-scoped input belongs to durable work that has already been created. `delivery` tells you whether the package will answer a peer request, retry the original request, or send a task update.

Use `context.signal` for prompts, model calls, and root discovery. Cancellation, detachment, closure, or session invalidation aborts input work owned by that execution.

If routing is ambiguous or a handler fails, the package returns a conservative protocol response and reports the failure through the session's `onError` callback.

## Let a task outlive this connection

When another process or a later session will continue the work, give the endpoint a stable identity:

```ts
import { createTaskSessionEndpointId } from "@modelcontextprotocol/ext-tasks/client";

const endpointId = await createTaskSessionEndpointId("workspace-mcp", {
  transport: "streamable-http",
  url: serverUrl,
  tenantId,
});
```

Build the descriptor from the connection properties that identify the MCP server, such as its URL and tenant.

Create the session with that identity, then hand off task-backed executions to durable storage:

```ts
const session = createTaskSessionFromClient(client, { endpointId });
const execution = await session.callTool("prepare-release", {
  version: "2.4.0",
});

if (execution.kind === "task") {
  await execution.handoff((reference) => taskStore.save(reference));
}
```

`handoff()` saves the reference before detaching. If persistence fails, the execution remains active and `handoff()` can be retried.

## Resume after reconnecting

Create a session for the same endpoint and pass the stored reference to `resumeTask()`:

```ts
const reference = await taskStore.load();

const recovered = await session.resumeTask(reference, {
  applicationContext: { traceId: "recovered-trace" },
});

const { outcome } = await recovered.settle({
  onEvent(event) {
    if (event.type === "task") console.log(event.task.status);
  },
});
```

The recovered execution exposes the same progress, input, and settlement APIs as a fresh call.

If the result uses a custom runtime codec, pass the same codec to `resumeTask()` that you used for the original call. See [Adapters and schemas](../adapters-and-schemas.md).

## Work with a known task ID

Use a manual controller when the application already has a task ID:

```ts
const task = session.task(taskId, {
  headers: { "x-trace-id": "trace-9" },
  requestTimeoutMs: 15_000,
});

const snapshot = await task.snapshot();
const outcome = await task.result({ resultCodec: reportResultCodec });

if (task.capabilities.cancellation) {
  await task.cancel();
}
```

## Next steps

Return to [execution control](./execution.md), or see [Troubleshooting](../troubleshooting.md) for correlation, expiry, and recovery failures.
