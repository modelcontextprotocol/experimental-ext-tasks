import {
  Client,
  ProtocolError,
  type StandardSchemaV1,
} from "@modelcontextprotocol/client";
import { isJsonValue, type JsonValue } from "../core/index.js";
import type { SessionTaskCapabilities } from "./port.js";
import {
  DispatchError,
  type ConnectedMcpSessionPort,
  type IncomingServerRequest,
  type JsonRpcResponse,
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

function clientTaskCapabilities(
  client: ClientPublicSurface,
): SessionTaskCapabilities {
  const capabilities = client.getServerCapabilities();
  if (client.getProtocolEra() === "modern") {
    const extension =
      capabilities?.extensions?.["io.modelcontextprotocol/tasks"];
    if (
      extension !== null &&
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
  if (params === undefined) return { method };
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

type ClientPublicSurface = Pick<
  Client,
  | "request"
  | "getProtocolEra"
  | "getServerCapabilities"
  | "fallbackRequestHandler"
  | "fallbackNotificationHandler"
  | "onclose"
>;

const adaptedClients = new WeakSet<object>();

export function isConnectedMcpSessionPort(
  value: unknown,
): value is ConnectedMcpSessionPort {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ConnectedMcpSessionPort>;
  return (
    typeof candidate.endpointId === "string" &&
    candidate.taskCapabilities !== undefined &&
    typeof candidate.dispatch === "function" &&
    typeof candidate.onServerRequest === "function" &&
    typeof candidate.onNotification === "function" &&
    typeof candidate.onInvalidated === "function" &&
    typeof candidate.invalidated === "boolean"
  );
}

export function isClientPublicSurface(
  value: unknown,
): value is ClientPublicSurface {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ClientPublicSurface>;
  return (
    typeof candidate.request === "function" &&
    typeof candidate.getProtocolEra === "function" &&
    typeof candidate.getServerCapabilities === "function"
  );
}

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
  ) {
    if (adaptedClients.has(client))
      throw new TypeError(
        "An ext-tasks adapter is already active for this Client",
      );
    this.previousFallbackRequestHandler = client.fallbackRequestHandler;
    this.previousFallbackNotificationHandler =
      client.fallbackNotificationHandler;
    this.previousOnclose = client.onclose;
    this.taskCapabilities = clientTaskCapabilities(client);
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
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<JsonRpcResponse> {
    try {
      const result = await this.client.request(
        asClientRequest(request),
        jsonValueSchema,
        options.signal === undefined ? {} : { signal: options.signal },
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

export function createSessionPortFromClient(
  client: Client,
  endpointId: string,
): ConnectedMcpSessionPort & Disposable {
  return new ClientSessionPort(client, endpointId);
}
