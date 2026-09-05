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

export function isJsonArray(
  value: JsonValue | undefined,
): value is readonly JsonValue[] {
  return Array.isArray(value);
}
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

export function expectRecord(
  value: JsonValue,
  path: DecodePath = [],
): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ProtocolDecodeError("expected object", path);
  }
  return value as Record<string, JsonValue>;
}

export function expectString(
  value: JsonValue | undefined,
  path: DecodePath,
): string {
  if (typeof value !== "string")
    throw new ProtocolDecodeError("expected string", path);
  return value;
}

export function expectNumber(
  value: JsonValue | undefined,
  path: DecodePath,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolDecodeError("expected finite number", path);
  }
  return value;
}

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
