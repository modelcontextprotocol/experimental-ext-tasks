# Add Tasks to an MCP client

Start with a connected `Client` from `@modelcontextprotocol/client`. Create one task-enabled session for that connection:

```ts
import {
  createTaskSessionFromClient,
  resultFromTaskOutcome,
} from "@modelcontextprotocol/ext-tasks/client";

const session = createTaskSessionFromClient(client, {
  endpointId: serverId,
});
```

`endpointId` is a stable identifier for the MCP server. It is used when task references are resumed on a later connection.

Call tools through the session:

```ts
try {
  const execution = await session.callTool("generate_report", {
    quarter: "Q2",
  });
  const { outcome } = await execution.settle();

  const result = resultFromTaskOutcome(outcome);
} finally {
  await session.close();
}
```

`callTool()` returns a `ToolExecution` for immediate and task-backed results. `settle()` waits for its terminal outcome.

## Next steps

- [Migrate an existing MCP SDK client](./migrating-from-the-sdk.md) for a piece-by-piece conversion that preserves ordinary elicitation, sampling, and MRTR handling.
- [Observe and control execution](./client/execution.md) for progress events, cancellation, timeouts, and handoff.
- [Handle application input and recover tasks](./client/input-and-recovery.md) for elicitation, sampling, roots, and reconnection.
- [Receive 2025-11-25 Tasks requests](./receiver.md) to handle task-backed sampling and elicitation.
- [Integrate adapters and schemas](./adapters-and-schemas.md) for V2 raw dispatch, custom transports, and wire types.
