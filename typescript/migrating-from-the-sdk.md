# Migrate an MCP SDK client

This guide starts with an MCP TypeScript SDK client that calls tools and handles elicitation and sampling. Each step keeps that behavior while adding Tasks.

## Before: use the base SDK

The base client advertises input capabilities, installs request handlers, connects, and calls tools directly:

```ts
import { Client } from "@modelcontextprotocol/client";

const client = new Client(
  { name: "reporting-client", version: "1.0.0" },
  {
    capabilities: {
      elicitation: { form: {} },
      sampling: {},
    },
  },
);

client.setRequestHandler("elicitation/create", async (request) => {
  return promptUser(request.params);
});

client.setRequestHandler("sampling/createMessage", async (request) => {
  return runModel(request.params);
});

await client.connect(transport);

const result = await client.callTool({
  name: "generate_report",
  arguments: { quarter: "Q2" },
});
```

On a 2025-11-25 connection, these handlers answer server-to-client requests. On a 2026-07-28 connection, the SDK also uses them for multi-round-trip requests (MRTR): it fulfills `input_required` results and retries the original call.

## 1. Install the extension

```sh
npm install @modelcontextprotocol/ext-tasks
```

Add the client imports:

```ts
import {
  createApplicationInputHandler,
  createTaskSessionFromClient,
  resultFromTaskOutcome,
  type ApplicationCreateMessageResult,
  type ApplicationElicitResult,
} from "@modelcontextprotocol/ext-tasks/client";
import type { JsonValue } from "@modelcontextprotocol/ext-tasks/core";
```

Keep using the SDK `Client` and transport. The extension wraps the connected client; it does not replace connection setup or capability negotiation.

## 2. Share the application input functions

Move each existing handler body into a named application function, then keep the SDK handlers as thin wrappers. The Tasks session will call the same functions:

```ts
async function handleElicitation(
  params: Readonly<Record<string, JsonValue>>,
): Promise<ApplicationElicitResult> {
  return promptUser(params);
}

async function handleSampling(
  params: Readonly<Record<string, JsonValue>>,
): Promise<ApplicationCreateMessageResult> {
  return runModel(params);
}

client.setRequestHandler("elicitation/create", async (request) => {
  return handleElicitation(request.params);
});

client.setRequestHandler("sampling/createMessage", async (request) => {
  return handleSampling(request.params);
});
```

The SDK handlers continue to cover ordinary peer requests and SDK MRTR.

## 3. Add the Tasks input handler

Create one generation-agnostic handler for input delivered through a Tasks execution:

```ts
const taskInputHandler = createApplicationInputHandler({
  elicitation: async (request) => {
    return handleElicitation(request.params);
  },
  sampling: async (request) => {
    return handleSampling(request.params);
  },
  roots: async () => ({ roots: [] }),
});
```

This handler covers Tasks-extension MRTR and input attached to a durable task.

## 4. Create a Tasks session after connecting

Keep the existing connection, then create one session for it. This is the complete setup for 2025-11-25 Tasks:

```ts
await client.connect(transport);

const session = createTaskSessionFromClient(client, {
  endpointId: "production-reports",
  onInputRequest: taskInputHandler,
});
```

`endpointId` identifies the MCP endpoint when a task is resumed on a later connection. Recreate the session whenever the underlying SDK client connection is replaced.

A 2026-07-28 Tasks session requires both `rawDispatch` and `v2RequestFraming`; omitting either makes session creation fail. Replace the factory call above with:

```ts
const session = createTaskSessionFromClient(client, {
  endpointId: "production-reports",
  onInputRequest: taskInputHandler,
  rawDispatch: hostRequestCoordinator.dispatch,
  v2RequestFraming: {
    protocolVersion,
    clientInfo,
    clientCapabilities,
  },
});
```

Both values come from the host request coordinator and must be supplied together. See [Supply the V2 request path](./adapters-and-schemas.md#supply-the-v2-request-path).

## 5. Replace tool calls

Replace `client.callTool()` with `session.callTool()`, then settle the returned execution:

```ts
const execution = await session.callTool("generate_report", {
  quarter: "Q2",
});

const { outcome } = await execution.settle();
const result = resultFromTaskOutcome(outcome);
```

The call now handles immediate and task-backed results through the same path. You can inspect `execution.kind`, observe progress, cancel, or hand off a task before settlement.

Close the Tasks session before closing or replacing the SDK client:

```ts
await session.close();
await client.close();
```

## How input paths coexist

The base SDK continues to use `setRequestHandler()` for its 2026-07-28 MRTR flow. Calls made through the Tasks session use `onInputRequest` for extension MRTR and durable-task input:

| Input path                                                  | Handler                            |
| ----------------------------------------------------------- | ---------------------------------- |
| 2025-11-25 server-to-client elicitation or sampling request | SDK `setRequestHandler()` callback |
| Base SDK 2026-07-28 `input_required` auto-fulfilment        | SDK `setRequestHandler()` callback |
| Tasks extension MRTR `input_required`                       | `onInputRequest` callback          |
| Input attached to a durable Tasks execution                 | `onInputRequest` callback          |

Both registrations call the same application functions, so user prompts and model execution stay consistent.

### 2025-11-25 peer-request semantics

Keep the SDK handlers for 2025-11-25 peer requests. The SDK dispatches them by method name before the Tasks adapter's fallback, so an ordinary request and a task-associated request use the same handler.

The handler can inspect related-task metadata in `request.params._meta`, but it does not receive ext-tasks' `ResolvedInputExchangeContext` or the call's `applicationContext`. Keep the shared application functions as the source of truth for both registrations.

## Complete migrated 2025-11-25 shape

```ts
const client = new Client(
  { name: "reporting-client", version: "1.0.0" },
  {
    capabilities: {
      elicitation: { form: {} },
      sampling: {},
    },
  },
);

client.setRequestHandler("elicitation/create", async (request) =>
  handleElicitation(request.params),
);
client.setRequestHandler("sampling/createMessage", async (request) =>
  handleSampling(request.params),
);

await client.connect(transport);

const session = createTaskSessionFromClient(client, {
  endpointId: "production-reports",
  onInputRequest: taskInputHandler,
});

try {
  const execution = await session.callTool("generate_report", {
    quarter: "Q2",
  });
  const { outcome } = await execution.settle();
  const result = resultFromTaskOutcome(outcome);
} finally {
  await session.close();
  await client.close();
}
```

For 2026-07-28 Tasks, use the paired V2 factory options shown in Step 4.

## Next steps

See [Execution](./client/execution.md) for progress, cancellation, and handoff. See [Input and recovery](./client/input-and-recovery.md) for callback context, task resumption, and manual task controllers.
