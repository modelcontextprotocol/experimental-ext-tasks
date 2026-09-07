import {
  ProtocolDecodeError,
  type JsonValue,
  type RuntimeCodec,
} from "../core/index.js";
import type { ServerTaskCapabilitiesV1 } from "../core/v1/index.js";
import type { ErrorV2, TasksExtensionCapabilityV2 } from "../core/v2/index.js";
import { JsonRpcResponseError } from "./api.js";
import { throwIfAborted } from "./input-routing.js";

export type SessionTaskCapabilities =
  | { readonly generation: "none" }
  | {
      readonly generation: "v1";
      readonly capabilities: ServerTaskCapabilitiesV1;
    }
  | {
      readonly generation: "v2";
      readonly capabilities: TasksExtensionCapabilityV2;
    };

export type JsonRpcResponse =
  | { readonly kind: "result"; readonly result: JsonValue }
  | { readonly kind: "error"; readonly error: ErrorV2 };

export interface IncomingServerRequest {
  readonly request: JsonValue;
  readonly requestContext: unknown;
}

/** Per-dispatch transport context preserved by task follow-up requests. */
export interface DispatchContext {
  /** Additional transport headers. HTTP transports send these on this request. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Options for one port dispatch. */
export interface DispatchOptions {
  readonly signal?: AbortSignal;
  /** Host-owned context that must remain attached to task lifecycle requests. */
  readonly context?: DispatchContext;
}

export interface ConnectedMcpSessionPort {
  readonly endpointId: string;
  readonly taskCapabilities: SessionTaskCapabilities;
  dispatch(
    request: JsonValue,
    options?: DispatchOptions,
  ): Promise<JsonRpcResponse>;
  onServerRequest(
    handler: (incoming: IncomingServerRequest) => Promise<JsonRpcResponse>,
  ): () => void;
  onNotification(listener: (notification: JsonValue) => void): () => void;
  onInvalidated(listener: (reason: unknown) => void): () => void;
  readonly invalidated: boolean;
}

export class DispatchError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "DispatchError";
    this.retryable = retryable;
  }
}
/** Races a promise against an optional abort signal and releases its listener. */
export async function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** Links abort signals into one disposable lifecycle. */
export function linkAbortSignals(
  ...signals: readonly (AbortSignal | undefined)[]
): {
  readonly signal: AbortSignal;
  readonly abort: (reason?: unknown) => void;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: (() => void)[] = [];
  for (const signal of signals) {
    if (signal === undefined) continue;
    const abort = (): void => {
      controller.abort(signal.reason);
    };
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeners.push(() => {
      signal.removeEventListener("abort", abort);
    });
  }
  return {
    signal: controller.signal,
    abort: (reason) => {
      controller.abort(reason);
    },
    dispose: () => {
      for (const remove of listeners) remove();
    },
  };
}

/** Dispatches a request with the retry policy for its observation or mutation intent. */
export async function dispatchWithRetry(
  port: ConnectedMcpSessionPort,
  request: JsonValue,
  dispatchOptions: DispatchOptions | AbortSignal | undefined,
  retry: "observe" | "mutate",
): Promise<JsonRpcResponse> {
  const options =
    dispatchOptions instanceof AbortSignal
      ? { signal: dispatchOptions }
      : dispatchOptions;
  const signal = options?.signal;
  try {
    return await port.dispatch(request, options);
  } catch (error) {
    throwIfAborted(signal);
    if (
      !(error instanceof DispatchError) ||
      (retry === "mutate" && !error.retryable)
    ) {
      throw error;
    }
    return port.dispatch(request, options);
  }
}

interface InternalSchema<T> {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: unknown };
}

/** Validates and parses a JSON-RPC result with a public codec or internal schema. */
export function parseResult<T>(
  codec: RuntimeCodec<T> | InternalSchema<T>,
  value: JsonValue,
): T {
  if ("safeParse" in codec) {
    const decoded = codec.safeParse(value);
    if (decoded.success) return decoded.data;
    throw new ProtocolDecodeError("Protocol value failed schema validation", {
      cause: decoded.error,
    });
  }
  const decoded = codec.parse(value);
  if (decoded.success) return decoded.value;
  throw decoded.error;
}

/** Unwraps a JSON-RPC result or throws the response error. */
export function responseResult(response: JsonRpcResponse): JsonValue {
  if (response.kind === "error") throw new JsonRpcResponseError(response.error);
  return response.result;
}
