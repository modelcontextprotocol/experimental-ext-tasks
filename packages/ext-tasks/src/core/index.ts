import type { TaskV1 } from "./v1/index.js";
import type { DetailedTaskV2, TaskV2 } from "./v2/index.js";

export type TaskId = string & { readonly __taskId: unique symbol };
export type TaskGeneration = "v1" | "v2";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Normalizes an arbitrary JavaScript value through JSON stringify/parse semantics. */
export function toJsonValue(value: unknown): JsonValue {
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("Value cannot be serialized as JSON", { cause: error });
  }
  if (typeof serialized !== "string")
    throw new TypeError("Value cannot be serialized as a top-level JSON value");
  const normalized: unknown = JSON.parse(serialized);
  if (!isJsonValue(normalized))
    throw new TypeError("JSON serialization produced an invalid JSON value");
  return normalized;
}

export type StandardSchemaPathSegment =
  PropertyKey | { readonly key: PropertyKey };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly StandardSchemaPathSegment[];
}

export interface ProtocolDecodeErrorDetails {
  readonly issues?: readonly StandardSchemaIssue[];
}

export class ProtocolDecodeError extends Error {
  readonly details: ProtocolDecodeErrorDetails;

  constructor(
    message: string,
    details: ProtocolDecodeErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProtocolDecodeError";
    this.details = details;
  }
}

export type RuntimeDecodeResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly error: ProtocolDecodeError };

export interface RuntimeCodec<T> {
  parse(value: JsonValue): RuntimeDecodeResult<T>;
}

/** Canonical synchronous Standard Schema V1 surface accepted at the package boundary. */
export interface SynchronousStandardSchema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: T; readonly issues?: undefined }
      | { readonly issues: readonly StandardSchemaIssue[] };
  };
}

/** Adapts a synchronous Standard Schema validator to the package runtime codec. */
export function runtimeCodecFromStandardSchema<T>(
  schema: SynchronousStandardSchema<T>,
): RuntimeCodec<T> {
  return {
    parse(value) {
      try {
        const result = schema["~standard"].validate(value);
        if ("issues" in result && result.issues !== undefined) {
          const issues = Object.freeze(
            result.issues.map((issue) =>
              Object.freeze({
                message: issue.message,
                ...(issue.path === undefined
                  ? {}
                  : { path: Object.freeze([...issue.path]) }),
              }),
            ),
          );
          const message = issues.map((issue) => issue.message).join("; ");
          return {
            success: false,
            error: new ProtocolDecodeError(
              message || "Standard Schema validation failed",
              { issues },
            ),
          };
        }
        if (!("value" in result))
          return {
            success: false,
            error: new ProtocolDecodeError("Standard Schema returned no value"),
          };
        return { success: true, value: result.value };
      } catch (error) {
        return {
          success: false,
          error: new ProtocolDecodeError(
            "Standard Schema validation failed",
            {},
            { cause: error },
          ),
        };
      }
    },
  };
}

export type TaskSnapshot =
  | { readonly generation: "v1"; readonly task: TaskV1 }
  | { readonly generation: "v2"; readonly task: TaskV2 | DetailedTaskV2 };

/** Brands a string as a task identifier without runtime validation or transformation. */
export function taskId(value: string): TaskId {
  return value as TaskId;
}

function isJsonObject(
  candidate: object,
  visit: (value: unknown) => boolean,
): boolean {
  const prototype = Reflect.getPrototypeOf(candidate);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(candidate).every(visit)
  );
}

/**
 * Checks recursively whether a value is JSON-compatible, rejecting non-finite numbers,
 * sparse arrays, non-plain objects, and cyclic references.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  const visiting = new WeakSet();
  const visit = (candidate: unknown): boolean => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    )
      return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate !== "object") return false;
    if (visiting.has(candidate)) return false;
    visiting.add(candidate);
    const valid = Array.isArray(candidate)
      ? candidate.length === Object.keys(candidate).length &&
        candidate.every(visit)
      : isJsonObject(candidate, visit);
    visiting.delete(candidate);
    return valid;
  };
  return visit(value);
}

/** Validates the package's recursive JSON data model without a schema-library dependency. */
export const JsonValueCodec: RuntimeCodec<JsonValue> = {
  parse(value) {
    return isJsonValue(value)
      ? { success: true, value }
      : {
          success: false,
          error: new ProtocolDecodeError("Expected a JSON value"),
        };
  },
};
