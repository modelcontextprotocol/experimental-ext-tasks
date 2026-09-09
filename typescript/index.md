# TypeScript API

`@modelcontextprotocol/ext-tasks` adds generation-agnostic Tasks requester support and 2025-11-25 Tasks receiver support to applications using the MCP TypeScript SDK v2.

## Install

```sh
npm install @modelcontextprotocol/ext-tasks
```

## Packages

| Import                                     | Purpose                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `@modelcontextprotocol/ext-tasks/client`   | Tool execution, progress, input handling, cancellation, recovery |
| `@modelcontextprotocol/ext-tasks/receiver` | 2025-11-25 Tasks sampling and elicitation receiver               |
| `@modelcontextprotocol/ext-tasks/core`     | Generation-neutral codecs, identifiers, and errors               |
| `@modelcontextprotocol/ext-tasks/core/v1`  | 2025-11-25 Tasks wire schemas and types                          |
| `@modelcontextprotocol/ext-tasks/core/v2`  | Tasks V2 wire schemas and types                                  |

## Requester

Given a connected SDK `Client`:

```ts
const session = createTaskSessionFromClient(client, { endpointId: serverId });

const execution = await session.callTool("generate_report", {
  format: "pdf",
});
const { outcome } = await execution.settle();

const result = resultFromTaskOutcome(outcome);
```

See [Add Tasks to an MCP client](./getting-started.md), [migrate an existing SDK client](./migrating-from-the-sdk.md), [Execution](./client/execution.md), and [Input and recovery](./client/input-and-recovery.md).

## 2025-11-25 receiver

```ts
const receiver = bindTaskReceiver(client, {
  methods: { "sampling/createMessage": true },
  sampling: async (request, { signal }) =>
    runSampling(request.params, { signal }),
});
```

Advertise `receiver.capabilities` during client initialization. See [2025-11-25 receiver](./receiver.md).

## Advanced integration

See [Adapters and schemas](./adapters-and-schemas.md) for V2 raw dispatch, custom transports, tool declarations, runtime codecs, and versioned schemas. See [Troubleshooting](./troubleshooting.md) for setup and lifecycle errors.

For wire behavior, use the [MCP Tasks specification](/specification/2026-07-28/tasks).
