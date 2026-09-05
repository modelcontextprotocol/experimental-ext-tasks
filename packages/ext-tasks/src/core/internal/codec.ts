/** Internal runtime codec implementation helpers. */
import { isJsonValue, type JsonValue, type RuntimeCodec } from "../index.js";

export type DecodePath = readonly (string | number)[];

export class ProtocolDecodeError extends Error {
  readonly path: DecodePath;

  constructor(message: string, path: DecodePath = []) {
    const location = path.length === 0 ? "$" : path.join(".");
    super(`${location}: ${message}`);
    this.name = "ProtocolDecodeError";
    this.path = path;
  }
}

/** Returns whether a JSON value is an array. */
export function isJsonArray(
  value: JsonValue | undefined,
): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Creates a runtime codec from a path-aware decoder. */
export function createRuntimeCodec<T>(
  decode: (value: JsonValue, path: DecodePath) => T,
): RuntimeCodec<T> {
  return {
    parse(value) {
      if (!isJsonValue(value)) {
        return {
          success: false,
          error: new ProtocolDecodeError("expected JSON value"),
        };
      }
      try {
        return { success: true, value: decode(value, []) };
      } catch (error) {
        if (error instanceof ProtocolDecodeError) {
          return { success: false, error };
        }
        throw error;
      }
    },
  };
}

/** Requires a JSON object at the supplied decode path. */
export function expectRecord(
  value: JsonValue,
  path: DecodePath = [],
): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ProtocolDecodeError("expected object", path);
  }
  return value as Record<string, JsonValue>;
}

/** Requires a string at the supplied decode path. */
export function expectString(
  value: JsonValue | undefined,
  path: DecodePath,
): string {
  if (typeof value !== "string")
    throw new ProtocolDecodeError("expected string", path);
  return value;
}

/** Requires a finite number at the supplied decode path. */
export function expectNumber(
  value: JsonValue | undefined,
  path: DecodePath,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolDecodeError("expected finite number", path);
  }
  return value;
}

/** Requires one of the allowed string values at the supplied decode path. */
export function expectEnum<T extends string>(
  value: JsonValue | undefined,
  values: readonly T[],
  path: DecodePath,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ProtocolDecodeError(`expected one of ${values.join(", ")}`, path);
  }
  return value as T;
}

/** Appends a property or index to a decode path. */
export function childPath(path: DecodePath, key: string | number): DecodePath {
  return [...path, key];
}

/** Returns whether a decoded object defines an own property. */
export function hasOwn(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Requires an integer at the supplied decode path. */
export function expectInteger(
  value: JsonValue | undefined,
  path: DecodePath,
): number {
  const number = expectNumber(value, path);
  if (!Number.isInteger(number)) {
    throw new ProtocolDecodeError("expected integer", path);
  }
  return number;
}

/** Requires a specific literal value at the supplied decode path. */
export function expectLiteral(
  value: JsonValue | undefined,
  expected: string | number | boolean | null,
  path: DecodePath,
): void {
  if (value !== expected) {
    throw new ProtocolDecodeError(`expected ${String(expected)}`, path);
  }
}

/** Decodes an optional JSON object at the supplied path. */
export function expectOptionalRecord(
  value: JsonValue | undefined,
  path: DecodePath,
): Record<string, JsonValue> | undefined {
  return value === undefined ? undefined : expectRecord(value, path);
}

/** Decodes an optional boolean at the supplied path. */
export function expectOptionalBoolean(
  value: JsonValue | undefined,
  path: DecodePath,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProtocolDecodeError("expected boolean", path);
  }
  return value;
}
