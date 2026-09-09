# `@modelcontextprotocol/ext-tasks`

Requester- and receiver-side lifecycle support plus versioned protocol schemas for MCP Tasks.

This package has no root entry point. Import the role or protocol generation needed by the application:

```ts
import { createTaskSessionFromClient } from "@modelcontextprotocol/ext-tasks/client";
import { bindTaskReceiver } from "@modelcontextprotocol/ext-tasks/receiver";
```

## Receiver binding

`bindTaskReceiver(client, options)` adds Tasks V1 lifecycle handling to an SDK `Client`. The binding owns task identifiers, timestamps, bounded retention, result promises, status transitions and notifications, `tasks/list|get|result|cancel`, cancellation signals, and cleanup. Consumers provide only enabled request methods and asynchronous sampling/elicitation callbacks. The SDK Client is the supported host because the package can then honestly preserve and restore displaced handlers; the private `_requestHandlers` compatibility shim remains encapsulated inside the package.

```ts
const receiver = bindTaskReceiver(client, {
  methods: {
    "sampling/createMessage": true,
    "elicitation/create": true,
  },
  ttlMs: 60_000,
  pollIntervalMs: 1_000,
  pageSize: 100,
  maxTasks: 1_000,
  sampling: async (request, { signal }) =>
    runSampling(request.params, { signal }),
  elicitation: async (request, { signal }) =>
    runElicitation(request.params, { signal }),
  onError(error, context) {
    reportReceiverError(error, context);
  },
});

// Merge this under the host's advertised Tasks capability.
const taskCapabilities = receiver.capabilities;

try {
  await serve();
} finally {
  receiver.close();
}
```

Only methods set to `true` are installed and advertised; each enabled method requires its matching callback. Receiver-created task-augmented `sampling/createMessage` and `elicitation/create` tasks start as `input_required` because their callbacks represent outstanding client or user input; they transition to `completed` or `failed` when the callback settles. `ttlMs` is the total task lifetime measured from creation, not from settlement. Set it to a non-negative integer or `null`, or to a function returning one of those values; a function is sampled once separately for each task, and that sample is both reported on the task and used for its creation-relative expiry. A finite TTL is armed immediately; expiry aborts pending callback work, rejects the retained payload promise, and removes the task. `null` disables time expiry. `pollIntervalMs` accepts only a non-negative integer or `null`; `null` polling omits the wire hint. `pageSize` (default 100) and `maxTasks` (default 1,000) are positive integers. `tasks/list` uses stable insertion-order task-ID cursors and rejects unknown or expired cursors. At capacity, new task creation is rejected deterministically rather than evicting retained work.

Cancellation wins once `tasks/cancel` accepts it: the task is marked cancelled before its callback is aborted, late success is discarded, and a late callback failure is reported through `onError` with `lateAfter: "cancel"`. Expiry and close similarly report late callback failures with their disposition, so callback outcomes are always observed. Cancelled records remain retained only until their original creation-based TTL.

Status notifications are fire-and-forget and never delay lifecycle transitions. The binding passes the SDK notification input `{ method, params }` without `jsonrpc`; the Client owns the JSON-RPC envelope. Send failures are caught and reported through `onError` with the originating transition method. `close()` is idempotent, aborts pending callbacks, drops retained records, and restores handlers displaced when the binding was installed without overwriting handlers installed later. Every installed handler rejects after close, including a handler reference captured before restoration.

### Receiver migration

| Consumer-owned receiver concern                                    | Package replacement                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| Task ID, timestamps, TTL map, payload promises                     | `bindTaskReceiver` internal lifecycle                     |
| Sampling/createMessage task wrapper                                | `methods["sampling/createMessage"]` + `sampling` callback |
| Elicitation/create task wrapper                                    | `methods["elicitation/create"]` + `elicitation` callback  |
| Status notification emission                                       | Automatic `notifications/tasks/status` transitions        |
| `tasks/list`, `tasks/get`, `tasks/result`, `tasks/cancel` handlers | Installed automatically                                   |
| Cancellation controller lookup                                     | Callback `AbortSignal`                                    |
| Task-augmented create result                                       | Automatic `{ task: TaskV1 }` result                       |
| Direct `_requestHandlers` access and restoration                   | Internal compatibility shim + `close()`                   |

## Session setup and endpoint identity

`createTaskSessionFromClient(client, options)` is the primary MCP SDK Client entry point. `options.endpointId` is an opaque, stable identity used only to scope serialized task references; the package never interprets it. The returned `TaskEnabledSession` owns its Client adapter, so `close()` restores the Client callbacks even when session cleanup reports another failure. Construction failures dispose the partially installed adapter before they are rethrown. The factory never closes the Client transport.

When the host does not already have a stable opaque identity, `createTaskSessionEndpointId(namespace, descriptor)` derives one from host-supplied connection semantics. It normalizes the descriptor as JSON, recursively sorts object keys, and returns a branded, versioned SHA-256 identity. Include only stable endpoint properties; the package deliberately does not inspect a transport or choose descriptor fields.

```ts
const session = createTaskSessionFromClient(client, {
  endpointId,
  onError,
  onInputRequest,
  // Required only when the connected session negotiates V2 Tasks:
  rawDispatch: hostRequestCoordinator.dispatch,
  v2RequestFraming: {
    protocolVersion,
    clientInfo,
    clientCapabilities,
  },
});

try {
  const execution = await session.callTool("generate_report", {
    format: "pdf",
  });
  const outcome = await execution.result();
} finally {
  await session.close();
}
```

For custom transports or advanced ownership, `withTasks(port, options)` still accepts any connected `ConnectedMcpSessionPort` and borrows it. `createSessionPortFromClient(client, endpointId, { rawDispatch, v2RequestFraming })` remains available as the low-level Client adapter; callers composing those APIs separately must dispose the port after closing the session.

The adapter support matrix is explicit:

| Connected session   | Client adapter requirement                                                                 | Dispatch path                                              |
| ------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| V1 Tasks            | `client`, opaque `endpointId`                                                              | SDK `Client.request`                                       |
| No Tasks capability | `client`, opaque `endpointId`                                                              | SDK `Client.request`                                       |
| V2 Tasks            | `client`, opaque `endpointId`, `rawDispatch`, and `v2RequestFraming` when V2 is negotiated | Host request coordinator for V2 `tools/call` and `tasks/*` |

SDK Client 2.x has no public raw request coordinator or public getters for its constructor-time client identity and capabilities. Therefore V2 without `rawDispatch` and `v2RequestFraming` throws while constructing the port, before a session or call exists. The adapter validates, copies, and deeply freezes framing at creation. It frames every raw V2 task request with the protocol version, client information, and client capabilities, forces the Tasks extension, and preserves unrelated caller `_meta`; the three package-reserved framing keys overwrite caller collisions. Consumers pass unframed task requests. Non-task requests continue through `Client.request` unchanged.

```ts
const port = createSessionPortFromClient(client, endpointId, {
  rawDispatch: hostRequestCoordinator.dispatch,
  v2RequestFraming: { protocolVersion, clientInfo, clientCapabilities },
});
```

Do not implement `rawDispatch` with a standalone `client.transport.send`: that bypasses the SDK coordinator and competes for responses.

## Package boundary adapters

Use `toJsonValue(value)` from `@modelcontextprotocol/ext-tasks/core` when arbitrary JavaScript data crosses into the package JSON model. Its semantics are explicitly `JSON.stringify(value)` followed by `JSON.parse(...)`: object `undefined` properties are omitted, array holes and `undefined` become `null`, `toJSON` is honored, and prototypes are removed. A top-level value that JSON cannot represent, serialization failure, or invalid normalized result throws `TypeError`.

`runtimeCodecFromStandardSchema<T>(schema)` adapts a canonical synchronous Standard Schema V1 validator to `RuntimeCodec<T>`; validation failures retain copied readonly issues, including paths, in `ProtocolDecodeError.details.issues`, while thrown validators are retained as the error `cause`. `toolDeclarationFromMcpTool(tool)` from the client subpath converts an SDK `Tool`, requires an object-shaped `inputSchema`, maps `_meta` to neutral metadata, maps task support, preserves unknown top-level fields in `extensions`, and preserves unknown nested `execution` fields in `executionExtensions`.

These adapters remove consumer-owned stringify/parse helpers, Standard Schema result translation, and MCP Tool projection code.

## Tool declarations

> `ToolDeclaration` is structural and generation-neutral. The session projects it to the negotiated wire protocol internally; applications never choose a V1/V2 declaration factory.

```ts
import {
  toolDeclaration,
  withTasks,
} from "@modelcontextprotocol/ext-tasks/client";

const declaration = toolDeclaration({
  name: "generate_report",
  description: "Generate a report",
  inputSchema: { type: "object" },
  taskSupport: "required",
});

const session = withTasks(port, {
  tools: {
    currentTool(name) {
      return name === declaration.name ? declaration : undefined;
    },
  },
});
```

When no provider is supplied, the package parses `tools/list` using the negotiated protocol and projects every tool to the same neutral shape. Duplicate names reject deterministically. An execution-scoped `declaration` in `callTool` or `resumeTask` options wins over provider lookup and remains available as `execution.declaration`.

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

## Semantic outcomes and events

`execution.result()` resolves exactly one cached `TaskOutcome<TResult>`: `{ status: "completed", result, task? }`, `{ status: "failed", error, task? }`, or `{ status: "cancelled", task? }`. Protocol errors and cancellation are values in this semantic union rather than generation-specific result/rejection shapes. `resultFromTaskOutcome(outcome)` is the convenience boundary for code that prefers the traditional result-or-throw shape: it returns the completed result and throws `TaskFailedError` or `TaskCancelledError` otherwise.

`execution.updates()` is single-acquire and yields normalized `{ type: "task", task: TaskView }` events followed by exactly one `{ type: "outcome", outcome }` event. `taskViewFromExecutionEvent(event)` returns the event's direct task or its outcome task when present. `TaskView` contains `taskId`, semantic `status`, optional `statusMessage` and timestamps, `retentionMs`, `suggestedPollIntervalMs`, plus `raw` and `extensions` for application UI use. The readonly `ttl` and `pollInterval` fields are compatibility aliases populated from those normalized primary names. It has no generation discriminator.

`execution.settle({ onEvent, signal, close })` concurrently drains that stream and resolves `{ outcome, lastTask }`. It awaits synchronous or asynchronous `onEvent` callbacks. Observer failure or caller abort locally detaches immediately: polling stops and managed ownership is released without sending `tasks/cancel`. Settlement best-effort closes after natural completion by default; pass `close: false` to retain the execution. `detach()` is always local-only, while `close()` may request best-effort cooperative cancellation for an incomplete task.

## Embedding hosts

Calls preserve host metadata and transport routing while accepting neutral task options:

```ts
await session.callTool("generate_report", undefined, {
  metadata: { traceId },
  headers: { "x-routing-key": routingKey },
  task: { preference: "prefer", retentionMs: 60_000 },
});
```

`preference` is `"allow" | "prefer" | "require" | "forbid"`. Requested retention is mapped only where the negotiated protocol supports it. Use `withRelatedTaskMetadata(existingMetadata, task)` to install `io.modelcontextprotocol/related-task` without mutating or dropping unknown metadata. Task-scoped peer requests and task-update inputs consistently expose related-task evidence through semantic input contexts.

For modern ordinary `tools/call` results with `resultType: "input_required"`, `callTool` completes request-scoped continuation before deciding whether the eventual result is immediate or task-backed. It preserves the original call parameters, per-round opaque `requestState`, validated `inputResponses`, application context, headers, and effective cancellation signal for up to 10 continuation rounds. This is distinct from a task snapshot whose `status` is `"input_required"`, which continues through `tasks/update` during task execution.

## Capabilities, input contexts, and manual tasks

`session.capabilities` and `controller.capabilities` expose semantic `TaskCapabilities`:

```ts
interface TaskCapabilities {
  inventory: "server-list" | "known-handles" | "unsupported";
  execution: boolean;
  cancellation: boolean;
  inputResponses: boolean;
  requestedRetention: boolean;
}
```

Input handlers receive `{ scope: "request" | "task", delivery: "peer-request" | "request-retry" | "task-update", inputId?, taskId?, applicationContext, signal? }`. `request-retry` identifies an ordinary result continuation; `task-update` identifies task-status input. No protocol lifetime names are exposed. `createApplicationInputHandler({ elicitation, sampling, roots })` provides exhaustive, result-preserving routing to kind-specific callbacks. Before a task-scoped callback runs, the package installs standard related-task metadata while preserving existing metadata; request-scoped inputs are unchanged.

Use `session.task(taskId)` for non-owning manual operations. `snapshot()` returns `TaskView`; `result()` returns `TaskOutcome<TResult>`; `cancel()` is semantic; `update()` and `updateJson()` are available when `capabilities.inputResponses` is true.

```ts
import { taskId } from "@modelcontextprotocol/ext-tasks/core";

const controller = session.task(taskId(currentSessionTaskId), {
  headers: { "x-routing-key": routingKey },
});
const view = await controller.snapshot();
const outcome = await controller.result();

const resumed = await session.resumeTask(persistedReference);
```

`execution.handle` is opaque and contains only `taskId` plus `operation`. Serialized references may retain endpoint and version information for persistence, but applications should store and pass them back without inspection. `resumeTask` is the owning cross-session recovery API.

Observation and mutation dispatches retry once only when a `DispatchError` is explicitly marked `retryable`. `session.close()` and execution `close()` are idempotent and resolving.

## Generation-neutral migration

- Replace `toolDeclarationV1(rawTool)` / `toolDeclarationV2(rawTool)` with `toolDeclaration(neutralDeclaration)`.
- Replace `preferTask` and `taskTtl` with `task: { preference, retentionMs }`.
- Replace raw/rejecting execution results with `TaskOutcome`: inspect `outcome.status` and then `result` or `error`.
- Replace generation-tagged snapshots with `TaskView`, and snapshot callbacks with `onEvent`.
- Replace `taskGeneration` and controller `generation` reads with semantic `capabilities`.
- Replace `lifetime`, `inputKey`, and generation-bearing input context reads with `scope`, `delivery`, and `inputId`.
- Keep generated wire schemas and advanced generated types imported explicitly from `/core/v1` or `/core/v2`.
- Replace manual `createSessionPortFromClient` + `withTasks` composition with `createTaskSessionFromClient(client, { endpointId, ...options })` when the session should own adapter disposal; keep the low-level APIs only for custom ownership.

The public package subpaths are:

- `@modelcontextprotocol/ext-tasks/core`
- `@modelcontextprotocol/ext-tasks/core/v1`
- `@modelcontextprotocol/ext-tasks/core/v2`
- `@modelcontextprotocol/ext-tasks/client`

Source is emitted as ESM JavaScript, TypeScript declarations, and source maps in `dist/`.
