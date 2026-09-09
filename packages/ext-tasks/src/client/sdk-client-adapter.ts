import { Client, ProtocolError } from "@modelcontextprotocol/client";
import type { StandardSchemaV1, Tool } from "@modelcontextprotocol/client";
import { isJsonValue, toJsonValue } from "../core/index.js";
import type { JsonValue } from "../core/index.js";
import { toolDeclaration } from "./api.js";
import type { TaskEnabledSession, WithTasksOptions } from "./api.js";
import { withOwnedTasks } from "./session.js";
import type { DispatchOptions, SessionTaskCapabilities } from "./port.js";
import { DispatchError } from "./port.js";
import type {
  ConnectedMcpSessionPort,
  IncomingServerRequest,
  JsonRpcResponse,
} from "./port.js";

const jsonValueSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "@modelcontextprotocol/ext-tasks",
    validate(value) {
      return isJsonValue(value)
        ? { value }
        : { issues: [{ message: "Expected a JSON value" }] };
    },
  },
};

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return (
    isJsonValue(value) &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object"
  );
}

function allowsInputRequired(request: JsonValue): boolean {
  return isJsonRecord(request) && request.method === "tools/call";
}

function clientTaskCapabilities(
  client: ClientPublicSurface,
): SessionTaskCapabilities {
  const capabilities = client.getServerCapabilities();
  if (client.getProtocolEra() === "modern") {
    const extension =
      capabilities?.extensions?.["io.modelcontextprotocol/tasks"];
    if (
      typeof extension === "object" &&
      !Array.isArray(extension) &&
      Object.keys(extension).length === 0
    )
      return { generation: "v2", capabilities: {} };
    return { generation: "none" };
  }
  const tasks = capabilities?.tasks;
  return tasks === undefined
    ? { generation: "none" }
    : { generation: "v1", capabilities: structuredClone(tasks) };
}

function asClientRequest(request: JsonValue): {
  readonly method: string;
  readonly params?: Readonly<Record<string, JsonValue>>;
} {
  if (!isJsonRecord(request))
    throw new DispatchError("MCP request must be a JSON object");
  const method = request.method;
  if (typeof method !== "string")
    throw new DispatchError("MCP request method must be a string");
  const params = request.params;
  if (!Object.hasOwn(request, "params")) return { method };
  if (!isJsonRecord(params))
    throw new DispatchError("MCP request params must be a JSON object");
  return { method, params };
}

function isTaskInputMethod(method: string): boolean {
  return (
    method === "elicitation/create" ||
    method === "sampling/createMessage" ||
    method === "roots/list"
  );
}

/** Host-owned request coordinator used when SDK wire codecs reject V2 task traffic. */
export type RawClientDispatch = (
  request: JsonValue,
  options?: DispatchOptions,
) => Promise<JsonRpcResponse>;

/** Exact V2 request metadata framing unavailable from the SDK Client public API. */
export interface V2RequestFraming {
  readonly protocolVersion: string;
  readonly clientInfo: Readonly<Record<string, JsonValue>>;
  readonly clientCapabilities: Readonly<Record<string, JsonValue>>;
}

/** Options for adapting an SDK Client. */
export interface ClientSessionPortOptions {
  readonly rawDispatch?: RawClientDispatch;
  /** Required with rawDispatch for V2; copied and deeply frozen at creation. */
  readonly v2RequestFraming?: V2RequestFraming;
}

/** Options for creating an owned task-enabled session from an MCP SDK Client. */
export interface CreateTaskSessionFromClientOptions<TApplicationContext = void>
  extends WithTasksOptions<TApplicationContext>, ClientSessionPortOptions {
  /** Opaque stable identity used to scope serialized task references. */
  readonly endpointId: string;
}

function requiresRawDispatch(
  capabilities: SessionTaskCapabilities,
  request: JsonValue,
): boolean {
  if (capabilities.generation !== "v2") return false;
  const method = asClientRequest(request).method;
  return method === "tools/call" || method.startsWith("tasks/");
}

const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreezeJson(nested);
    Object.freeze(value);
  }
  return value;
}

function normalizeV2RequestFraming(
  framing: V2RequestFraming,
): V2RequestFraming {
  if (framing.protocolVersion.trim().length === 0)
    throw new TypeError("v2RequestFraming.protocolVersion must be non-empty");
  const clientInfo = toJsonValue(framing.clientInfo);
  const clientCapabilities = toJsonValue(framing.clientCapabilities);
  if (!isJsonRecord(clientInfo))
    throw new TypeError("v2RequestFraming.clientInfo must be a JSON object");
  if (!isJsonRecord(clientCapabilities))
    throw new TypeError(
      "v2RequestFraming.clientCapabilities must be a JSON object",
    );
  return Object.freeze({
    protocolVersion: framing.protocolVersion,
    clientInfo: deepFreezeJson(structuredClone(clientInfo)),
    clientCapabilities: deepFreezeJson(structuredClone(clientCapabilities)),
  });
}

/**
 * Frames V2 task metadata. Package-reserved framing keys overwrite caller collisions.
 */
function frameV2TaskRequest(
  request: JsonValue,
  framing: V2RequestFraming,
): JsonValue {
  if (!isJsonRecord(request))
    throw new DispatchError("MCP request must be a JSON object");
  const envelope = asClientRequest(request);
  const params = envelope.params ?? {};
  const callerMeta = isJsonRecord(params._meta) ? params._meta : {};
  const clientCapabilities = framing.clientCapabilities;
  const extensions = isJsonRecord(clientCapabilities.extensions)
    ? clientCapabilities.extensions
    : {};
  return {
    ...request,
    params: {
      ...params,
      _meta: {
        ...callerMeta,
        [PROTOCOL_VERSION_META]: framing.protocolVersion,
        [CLIENT_INFO_META]: framing.clientInfo,
        [CLIENT_CAPABILITIES_META]: {
          ...clientCapabilities,
          extensions: { ...extensions, [TASKS_EXTENSION_ID]: {} },
        },
      },
    },
  };
}

/** Converts an MCP SDK Tool into the package's neutral declaration. */
export function toolDeclarationFromMcpTool(
  tool: Tool,
): import("./api.js").ToolDeclaration {
  const normalized = toJsonValue(tool);
  if (!isJsonRecord(normalized))
    throw new TypeError("MCP tool must serialize to a JSON object");
  const inputSchema = normalized.inputSchema;
  if (!isJsonRecord(inputSchema))
    throw new TypeError("MCP tool inputSchema must be a JSON object");
  const known = new Set([
    "name",
    "title",
    "description",
    "inputSchema",
    "outputSchema",
    "annotations",
    "icons",
    "_meta",
    "execution",
  ]);
  const execution = isJsonRecord(normalized.execution)
    ? normalized.execution
    : undefined;
  const taskSupport = execution?.taskSupport;
  const executionExtensions =
    execution === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(execution).filter(([key]) => key !== "taskSupport"),
        );
  return toolDeclaration({
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema,
    ...(isJsonRecord(normalized.outputSchema)
      ? { outputSchema: normalized.outputSchema }
      : {}),
    ...(isJsonRecord(normalized.annotations)
      ? { annotations: normalized.annotations }
      : {}),
    ...(Array.isArray(normalized.icons) && normalized.icons.every(isJsonRecord)
      ? { icons: normalized.icons }
      : {}),
    ...(isJsonRecord(normalized._meta) ? { metadata: normalized._meta } : {}),
    ...(taskSupport === "forbidden" ||
    taskSupport === "optional" ||
    taskSupport === "required"
      ? { taskSupport }
      : {}),
    ...(executionExtensions === undefined ? {} : { executionExtensions }),
    extensions: Object.fromEntries(
      Object.entries(normalized).filter(([key]) => !known.has(key)),
    ),
  });
}

type ClientPublicSurface = Pick<
  Client,
  | "request"
  | "getProtocolEra"
  | "getServerCapabilities"
  | "fallbackRequestHandler"
  | "fallbackNotificationHandler"
  | "onclose"
>;

const adaptedClients = new WeakSet();

export class ClientSessionPort implements ConnectedMcpSessionPort {
  readonly taskCapabilities: SessionTaskCapabilities;
  private readonly serverRequestListeners = new Set<
    (incoming: IncomingServerRequest) => Promise<JsonRpcResponse>
  >();
  private readonly notificationListeners = new Set<
    (notification: JsonValue) => void
  >();
  private readonly invalidationListeners = new Set<(reason: unknown) => void>();
  private readonly previousFallbackRequestHandler: ClientPublicSurface["fallbackRequestHandler"];
  private readonly previousFallbackNotificationHandler: ClientPublicSurface["fallbackNotificationHandler"];
  private readonly previousOnclose: ClientPublicSurface["onclose"];
  private readonly v2RequestFraming: V2RequestFraming | undefined;
  private disposed = false;
  private isInvalidated = false;

  private readonly fallbackRequestHandler: NonNullable<
    ClientPublicSurface["fallbackRequestHandler"]
  > = async (request, context) => {
    if (!isTaskInputMethod(request.method)) {
      if (this.previousFallbackRequestHandler !== undefined)
        return this.previousFallbackRequestHandler(request, context);
      throw new ProtocolError(-32601, `Method not found: ${request.method}`);
    }
    const listener = this.serverRequestListeners.values().next().value;
    if (listener === undefined) {
      if (this.previousFallbackRequestHandler !== undefined)
        return this.previousFallbackRequestHandler(request, context);
      throw new ProtocolError(-32601, `Method not found: ${request.method}`);
    }
    if (!isJsonValue(request))
      throw new ProtocolError(-32600, "Inbound request is not JSON");
    const response = await listener({ request, requestContext: context });
    if (response.kind === "error")
      throw new ProtocolError(
        response.error.code,
        response.error.message,
        response.error.data,
      );
    if (!isJsonRecord(response.result))
      throw new ProtocolError(
        -32603,
        "Inbound handler returned a non-object result",
      );
    return response.result;
  };

  private readonly fallbackNotificationHandler: NonNullable<
    ClientPublicSurface["fallbackNotificationHandler"]
  > = async (notification) => {
    await this.previousFallbackNotificationHandler?.(notification);
    if (!isJsonValue(notification)) return;
    for (const listener of [...this.notificationListeners])
      listener(notification);
  };

  private readonly onclose = (): void => {
    try {
      this.previousOnclose?.();
    } finally {
      this.invalidate(new Error("MCP client connection closed"));
    }
  };

  constructor(
    private readonly client: ClientPublicSurface,
    readonly endpointId: string,
    private readonly rawDispatch?: RawClientDispatch,
    v2RequestFraming?: V2RequestFraming,
  ) {
    if (adaptedClients.has(client))
      throw new TypeError(
        "An ext-tasks adapter is already active for this Client",
      );
    this.v2RequestFraming =
      v2RequestFraming === undefined
        ? undefined
        : normalizeV2RequestFraming(v2RequestFraming);
    this.taskCapabilities = clientTaskCapabilities(client);
    if (
      this.taskCapabilities.generation === "v2" &&
      (rawDispatch === undefined || this.v2RequestFraming === undefined)
    )
      throw new TypeError(
        "A V2 task session requires options.rawDispatch and options.v2RequestFraming to coordinate task wire shapes",
      );
    this.previousFallbackRequestHandler = client.fallbackRequestHandler;
    this.previousFallbackNotificationHandler =
      client.fallbackNotificationHandler;
    this.previousOnclose = client.onclose;
    adaptedClients.add(client);
    client.fallbackRequestHandler = this.fallbackRequestHandler;
    client.fallbackNotificationHandler = this.fallbackNotificationHandler;
    client.onclose = this.onclose;
  }

  get invalidated(): boolean {
    return this.isInvalidated;
  }

  async dispatch(
    request: JsonValue,
    options: DispatchOptions = {},
  ): Promise<JsonRpcResponse> {
    try {
      if (requiresRawDispatch(this.taskCapabilities, request)) {
        if (
          this.rawDispatch === undefined ||
          this.v2RequestFraming === undefined
        )
          throw new DispatchError(
            "SDK Client cannot dispatch V2 task wire shapes without rawDispatch and v2RequestFraming",
          );
        return await this.rawDispatch(
          frameV2TaskRequest(request, this.v2RequestFraming),
          options,
        );
      }
      const result = await this.client.request(
        asClientRequest(request),
        jsonValueSchema,
        {
          ...(allowsInputRequired(request) ? { allowInputRequired: true } : {}),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.context?.headers === undefined
            ? {}
            : { headers: options.context.headers }),
          ...(options.context?.requestTimeoutMs === undefined
            ? {}
            : { timeout: options.context.requestTimeoutMs }),
        },
      );
      return { kind: "result", result };
    } catch (error) {
      if (error instanceof ProtocolError) {
        const data = error.data;
        return {
          kind: "error",
          error: {
            code: error.code,
            message: error.message,
            ...(data === undefined || !isJsonValue(data) ? {} : { data }),
          },
        };
      }
      if (error instanceof DispatchError) throw error;
      throw new DispatchError("MCP client request failed", false, {
        cause: error,
      });
    }
  }

  onServerRequest(
    handler: (incoming: IncomingServerRequest) => Promise<JsonRpcResponse>,
  ): () => void {
    this.serverRequestListeners.add(handler);
    return () => this.serverRequestListeners.delete(handler);
  }

  onNotification(listener: (notification: JsonValue) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onInvalidated(listener: (reason: unknown) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.client.fallbackRequestHandler === this.fallbackRequestHandler)
      this.client.fallbackRequestHandler = this.previousFallbackRequestHandler;
    if (
      this.client.fallbackNotificationHandler ===
      this.fallbackNotificationHandler
    )
      this.client.fallbackNotificationHandler =
        this.previousFallbackNotificationHandler;
    if (this.client.onclose === this.onclose)
      this.client.onclose = this.previousOnclose;
    adaptedClients.delete(this.client);
    this.serverRequestListeners.clear();
    this.notificationListeners.clear();
    this.invalidationListeners.clear();
  }

  private invalidate(reason: unknown): void {
    if (this.isInvalidated) return;
    this.isInvalidated = true;
    for (const listener of [...this.invalidationListeners]) listener(reason);
  }
}

/** Creates a disposable connected session port backed by an MCP SDK client. */
export function createSessionPortFromClient(
  client: Client,
  endpointId: string,
  options: ClientSessionPortOptions = {},
): ConnectedMcpSessionPort & Disposable {
  return new ClientSessionPort(
    client,
    endpointId,
    options.rawDispatch,
    options.v2RequestFraming,
  );
}

/** Creates a task-enabled session that owns and disposes its Client adapter. */
export function createTaskSessionFromClient<TApplicationContext = void>(
  client: Client,
  options: CreateTaskSessionFromClientOptions<TApplicationContext>,
): TaskEnabledSession<TApplicationContext> {
  const { endpointId, rawDispatch, v2RequestFraming, ...sessionOptions } =
    options;
  const port = createSessionPortFromClient(client, endpointId, {
    rawDispatch,
    v2RequestFraming,
  });
  try {
    return withOwnedTasks(port, sessionOptions, () => {
      port[Symbol.dispose]();
    });
  } catch (error) {
    port[Symbol.dispose]();
    throw error;
  }
}
