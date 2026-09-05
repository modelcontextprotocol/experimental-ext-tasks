import { type JsonValue } from "../../src/core/index.js";
import {
  type ConnectedMcpSessionPort,
  type IncomingServerRequest,
  type JsonRpcResponse,
  type SessionTaskCapabilities,
} from "../../src/client/index.js";

export const asJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

export const formatJson = (value: unknown): string =>
  JSON.stringify(value) ?? "undefined";

export const asError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error(formatJson(reason));

export class FakePort implements ConnectedMcpSessionPort {
  readonly endpointId: string;
  readonly requests: JsonValue[] = [];
  readonly taskCapabilities: SessionTaskCapabilities;
  invalidated = false;
  response: JsonRpcResponse = { kind: "result", result: { content: [] } };
  dispatchHandler?: (
    request: JsonValue,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<JsonRpcResponse>;
  private requestHandler?: (
    incoming: IncomingServerRequest,
  ) => Promise<JsonRpcResponse>;
  private notificationListener?: (notification: JsonValue) => void;
  private invalidationListener?: (reason: unknown) => void;
  listenerDisposals = 0;

  constructor(
    taskCapabilities: SessionTaskCapabilities = { generation: "none" },
    endpointId = "fake-endpoint",
  ) {
    this.taskCapabilities = taskCapabilities;
    this.endpointId = endpointId;
  }

  async dispatch(
    request: JsonValue,
    options?: { readonly signal?: AbortSignal },
  ): Promise<JsonRpcResponse> {
    this.requests.push(request);
    return this.dispatchHandler === undefined
      ? this.response
      : this.dispatchHandler(request, options);
  }

  onServerRequest(
    handler: (incoming: IncomingServerRequest) => Promise<JsonRpcResponse>,
  ): () => void {
    this.requestHandler = handler;
    return () => {
      this.requestHandler = undefined;
      this.listenerDisposals += 1;
    };
  }

  onNotification(listener: (notification: JsonValue) => void): () => void {
    this.notificationListener = listener;
    return () => {
      this.notificationListener = undefined;
      this.listenerDisposals += 1;
    };
  }

  onInvalidated(listener: (reason: unknown) => void): () => void {
    this.invalidationListener = listener;
    return () => {
      this.invalidationListener = undefined;
      this.listenerDisposals += 1;
    };
  }

  invalidate(reason: unknown): void {
    this.invalidated = true;
    this.invalidationListener?.(reason);
  }

  async serve(request: JsonValue): Promise<JsonRpcResponse> {
    if (this.requestHandler === undefined)
      throw new Error("request handler is not installed");
    return this.requestHandler({ request, requestContext: {} });
  }

  notify(notification: JsonValue): void {
    this.notificationListener?.(notification);
  }
}
