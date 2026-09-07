# `@modelcontextprotocol/ext-tasks`

Requester-side lifecycle support and versioned protocol schemas for MCP Tasks.

This package has no root entry point. Import the role or protocol generation needed by the application:

```ts
import {
  createSessionPortFromClient,
  withTasks,
} from "@modelcontextprotocol/ext-tasks/client";
```

## Session setup and endpoint identity

`withTasks` accepts only a connected `ConnectedMcpSessionPort`. Every port has an explicit, stable `endpointId`; serialized task references use it to fail closed when resumed against another endpoint.

For an MCP SDK Client, create and own the port separately:

```ts
const port = createSessionPortFromClient(client, endpointId);
const session = withTasks(port, { onError });

try {
  const execution = await session.callTool("generate_report", {
    format: "pdf",
  });
  const result = await execution.result();
} finally {
  await session.close(); // releases ext-tasks resources; never closes the borrowed port
  port[Symbol.dispose](); // restores SDK Client callbacks; never closes the Client transport
}
```

The adapter support matrix is explicit:

| Connected session   | `createSessionPortFromClient` requirement | Dispatch path                                              |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| V1 Tasks            | `client`, `endpointId`                    | SDK `Client.request`                                       |
| No Tasks capability | `client`, `endpointId`                    | SDK `Client.request`                                       |
| V2 Tasks            | `client`, `endpointId`, `{ rawDispatch }` | Host request coordinator for V2 `tools/call` and `tasks/*` |

SDK Client 2.x has no public raw request coordinator that can safely share request IDs, authentication recovery, cancellation, and inbound-response ownership. Therefore V2 without `rawDispatch` throws while constructing the port, before a session or call exists. `rawDispatch` must be supplied explicitly; no property is discovered on the Client object.

```ts
const port = createSessionPortFromClient(client, endpointId, {
  rawDispatch: hostRequestCoordinator.dispatch,
});
```

Do not implement `rawDispatch` with a standalone `client.transport.send`: that bypasses the SDK coordinator and competes for responses.

## Tool declaration providers

A host-supplied provider returns an explicitly tagged generated declaration. Generation is never inferred from optional tool properties.

```ts
import {
  toolDeclarationV1,
  toolDeclarationV2,
  withTasks,
} from "@modelcontextprotocol/ext-tasks/client";

const session = withTasks(port, {
  tools: {
    currentTool(name) {
      const rawTool = pool.currentRawTool(name);
      if (rawTool === undefined) return undefined;
      return pool.generation === "v1"
        ? toolDeclarationV1(rawTool)
        : toolDeclarationV2(rawTool);
    },
  },
});
```

Hosts that own tool discovery can retain each raw generated declaration and tag it without projecting or reparsing it. When no provider is supplied, the package performs generation-specific `tools/list` parsing itself. Duplicate names reject the refresh deterministically; no first/last winner is selected.

## Runtime codecs

The public projection API is schema-library neutral. `RuntimeCodec<T>` receives an already-decoded `JsonValue` and returns a success value or `ProtocolDecodeError`. Zod remains an implementation convenience of the versioned generated schema subpaths, not a public client API requirement.

```ts
import {
  ProtocolDecodeError,
  type RuntimeCodec,
} from "@modelcontextprotocol/ext-tasks/core";

const reportCodec: RuntimeCodec<{ reportUrl: string }> = {
  parse(value) {
    if (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      "reportUrl" in value &&
      typeof value.reportUrl === "string"
    ) {
      return { success: true, value: { reportUrl: value.reportUrl } };
    }
    return {
      success: false,
      error: new ProtocolDecodeError("Expected reportUrl"),
    };
  },
};

const execution = await session.callTool("generate_report", undefined, {
  resultCodec: reportCodec,
});
```

`@modelcontextprotocol/ext-tasks/core` has no runtime imports or dependencies. Generated Zod schemas remain available from `/core/v1` and `/core/v2`:

```ts
import { TaskV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";

const task = TaskV2Schema.parse(taskPayload);
```

## Embedding hosts

Calls can preserve host-owned request metadata and transport routing while adding Tasks protocol fields:

```ts
await session.callTool("generate_report", undefined, {
  metadata: { traceId },
  headers: { "x-routing-key": routingKey },
  taskTtl: 60_000, // V1 task requests only
});
```

`session.close()` and execution `close()` are idempotent and resolving. Teardown failures with a session owner are reported through `onError`. Closing a settled execution does not cancel it; closing an incomplete task starts one best-effort cooperative cancellation attempt without allowing a nonresponsive server to block teardown.

## Initial-release API migration

- Replace `withTasks(client, { endpointId, ...options })` with `const port = createSessionPortFromClient(client, endpointId, adapterOptions); const session = withTasks(port, options)`.
- For a V2 Client adapter, pass `{ rawDispatch }` explicitly when constructing the port. There is no Client property probe and no per-call fallback.
- Replace `resultSchema` with a library-neutral `resultCodec: RuntimeCodec<TResult>`.
- Replace provider returns of raw `ToolV1 | ToolV2` with `toolDeclarationV1(rawTool)` or `toolDeclarationV2(rawTool)`.
- Remove generic arguments and `applicationContext` reads from `InputCorrelationError`; candidates contain only generation, tool name, and execution ID.
- Dispose a Client-backed port separately from closing the task-enabled session.

The public package subpaths are:

- `@modelcontextprotocol/ext-tasks/core`
- `@modelcontextprotocol/ext-tasks/core/v1`
- `@modelcontextprotocol/ext-tasks/core/v2`
- `@modelcontextprotocol/ext-tasks/client`

Source is emitted as ESM JavaScript, TypeScript declarations, and source maps in `dist/`.
