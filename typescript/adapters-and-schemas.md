# Integrate adapters and schemas

Use these APIs for V2 raw dispatch, custom transports, tool declarations, runtime codecs, and versioned wire schemas.

## Supply the V2 request path

For Tasks V2, pass the host's raw request coordinator and the values used during SDK client initialization:

```ts
const session = createTaskSessionFromClient(client, {
  endpointId,
  rawDispatch: hostRequestCoordinator.dispatch,
  v2RequestFraming: {
    protocolVersion,
    clientInfo,
    clientCapabilities,
  },
});
```

`rawDispatch` must use the host coordinator that owns request IDs and response matching.

The adapter adds the framing values to V2 task requests.

## Use a custom connected port

When the host already has a transport abstraction, adapt it to `ConnectedMcpSessionPort` and pass it to `withTasks()`:

```ts
import {
  withTasks,
  type ConnectedMcpSessionPort,
} from "@modelcontextprotocol/ext-tasks/client";

const port: ConnectedMcpSessionPort = {
  endpointId,
  taskCapabilities: { generation: "v1", capabilities: {} },
  dispatch: (request, options) => transport.dispatch(request, options),
  onServerRequest: (handler) => transport.onRequest(handler),
  onNotification: (listener) => transport.onNotification(listener),
  onInvalidated: (listener) => transport.onClose(listener),
  get invalidated() {
    return transport.closed;
  },
};

const session = withTasks(port);
```

`withTasks()` borrows the port. Close the session before disposing the port. For SDK clients, `createSessionPortFromClient()` exposes the lower-level adapter used by `createTaskSessionFromClient()`.

## Provide tool declarations

Supply a declaration when the host owns tool metadata or overrides task support:

```ts
import { toolDeclaration } from "@modelcontextprotocol/ext-tasks/client";

const generateReport = toolDeclaration({
  name: "generate_report",
  description: "Generate a report",
  inputSchema: {
    type: "object",
    properties: { format: { enum: ["pdf", "html"] } },
  },
  taskSupport: "required",
});

const session = withTasks(port, {
  tools: {
    currentTool(name) {
      return name === generateReport.name ? generateReport : undefined;
    },
  },
});
```

The session projects the generation-neutral declaration to the negotiated wire shape. An execution-scoped declaration overrides the session provider.

Convert SDK `Tool` values with `toolDeclarationFromMcpTool(mcpTool)`.

## Decode custom results

Adapt a synchronous Standard Schema V1 validator when a tool returns an application-specific shape:

```ts
import { runtimeCodecFromStandardSchema } from "@modelcontextprotocol/ext-tasks/core";

const reportCodec = runtimeCodecFromStandardSchema<{ reportUrl: string }>(
  reportSchema,
);

const execution = await session.callTool("generate_report", undefined, {
  resultCodec: reportCodec,
});
const { outcome } = await execution.settle();
```

The adapter accepts synchronous Standard Schema V1 validators. Validation issues become `ProtocolDecodeError` details; a thrown validator is retained as the error cause.

## Normalize host data as JSON

Use `toJsonValue()` when arbitrary JavaScript crosses into APIs typed as `JsonValue`:

```ts
import { toJsonValue } from "@modelcontextprotocol/ext-tasks/core";

const metadata = toJsonValue({
  traceId,
  optional: undefined,
  createdAt: new Date(),
});
```

Normalization follows a `JSON.stringify()`/`JSON.parse()` round trip. Unsupported values throw.

## Package entry points

Use the narrowest package entry point:

| Import                                     | Use it for                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `@modelcontextprotocol/ext-tasks/client`   | Sessions, execution, ports, SDK adapters, and neutral tool declarations.           |
| `@modelcontextprotocol/ext-tasks/receiver` | 2025-11-25 Tasks receiver binding and callback options.                            |
| `@modelcontextprotocol/ext-tasks/core`     | Generation-neutral JSON, identifiers, runtime codecs, and decode errors.           |
| `@modelcontextprotocol/ext-tasks/core/v1`  | 2025-11-25 Tasks schemas and wire types.                                           |
| `@modelcontextprotocol/ext-tasks/core/v2`  | V2 schemas and types for code intentionally reading or writing the V2 wire format. |

## Next steps

See [Troubleshooting](./troubleshooting.md) for adapter and framing failures, or use the [Tasks specification](/specification/2026-07-28/tasks) for normative wire behavior.
