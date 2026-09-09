# `@modelcontextprotocol/ext-tasks`

Call tools through generation-agnostic Tasks requester APIs. The package also provides 2025-11-25 Tasks receiver support for sampling and elicitation requests.

## Install

```sh
npm install @modelcontextprotocol/ext-tasks
```

Use the client entry point when your application calls tools:

```ts
import {
  createTaskSessionFromClient,
  resultFromTaskOutcome,
} from "@modelcontextprotocol/ext-tasks/client";
```

## Call a tool

Create a session from a connected MCP SDK `Client`. The same call handles immediate results and durable task-backed execution.

```ts
const session = createTaskSessionFromClient(client, {
  endpointId: "production-reports",
});

try {
  const execution = await session.callTool("generate_report", {
    format: "pdf",
  });
  const { outcome } = await execution.settle();
  const result = resultFromTaskOutcome(outcome);
} finally {
  await session.close();
}
```

## Receive 2025-11-25 Tasks requests

Use the receiver entry point to handle 2025-11-25 task-backed sampling and elicitation requests.

```ts
import { bindTaskReceiver } from "@modelcontextprotocol/ext-tasks/receiver";

const receiver = bindTaskReceiver(client, {
  methods: { "sampling/createMessage": true },
  sampling: async (request, { signal }) =>
    runSampling(request.params, { signal }),
});

try {
  await serve();
} finally {
  receiver.close();
}
```

The binding owns task state, retention, cancellation, lifecycle handlers, and status notifications. Merge `receiver.capabilities` into the host's advertised Tasks capability.

## Documentation

Start with the [TypeScript package guide](https://modelcontextprotocol.github.io/ext-tasks/typescript/) and [getting-started walkthrough](https://modelcontextprotocol.github.io/ext-tasks/typescript/getting-started.html). Then choose the task you need:

- [Migrate an existing MCP SDK client](https://modelcontextprotocol.github.io/ext-tasks/typescript/migrating-from-the-sdk.html)
- [Execute and control tools](https://modelcontextprotocol.github.io/ext-tasks/typescript/client/execution.html)
- [Handle application input and recover tasks](https://modelcontextprotocol.github.io/ext-tasks/typescript/client/input-and-recovery.html)
- [Bind a 2025-11-25 Tasks receiver](https://modelcontextprotocol.github.io/ext-tasks/typescript/receiver.html)
- [Integrate custom adapters or schemas](https://modelcontextprotocol.github.io/ext-tasks/typescript/adapters-and-schemas.html)
- [Troubleshoot setup and lifecycle failures](https://modelcontextprotocol.github.io/ext-tasks/typescript/troubleshooting.html)

For normative wire behavior, use the [MCP Tasks specification](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html).

## Public entry points

- `@modelcontextprotocol/ext-tasks/client` — requester sessions, execution, input routing, recovery, and SDK adapters
- `@modelcontextprotocol/ext-tasks/receiver` — 2025-11-25 Tasks receiver binding
- `@modelcontextprotocol/ext-tasks/core` — generation-neutral JSON, codecs, errors, and identifiers
- `@modelcontextprotocol/ext-tasks/core/v1` — generated 2025-11-25 Tasks schemas and wire types
- `@modelcontextprotocol/ext-tasks/core/v2` — generated Tasks V2 schemas and wire types

Source is emitted as ESM JavaScript, TypeScript declarations, and source maps in `dist`.
