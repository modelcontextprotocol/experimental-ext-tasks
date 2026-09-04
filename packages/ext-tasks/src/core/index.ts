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

export interface RuntimeCodec<T> {
  parse(value: JsonValue):
    | { readonly success: true; readonly value: T }
    | { readonly success: false; readonly error: ProtocolDecodeError };
}

export type TaskSnapshot =
  | { readonly generation: "v1"; readonly task: TaskV1 }
  | { readonly generation: "v2"; readonly task: TaskV2 | DetailedTaskV2 };

export function taskId(value: string): TaskId {
  return value as TaskId;
}

export function isJsonValue(value: unknown): value is JsonValue {
  const visiting = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate !== "object") return false;
    if (visiting.has(candidate)) return false;
    visiting.add(candidate);
    let valid: boolean;
    if (Array.isArray(candidate)) {
      valid = candidate.length === Object.keys(candidate).length && candidate.every(visit);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      valid = (prototype === Object.prototype || prototype === null) && Object.values(candidate).every(visit);
    }
    visiting.delete(candidate);
    return valid;
  };
  return visit(value);
}

export function createRuntimeCodec<T>(
  decode: (value: JsonValue, path: DecodePath) => T,
 ): RuntimeCodec<T> {
  return {
    parse(value) {
      try {
        return { success: true, value: decode(value, []) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof ProtocolDecodeError
            ? error
            : new ProtocolDecodeError("invalid protocol value"),
        };
      }
    },
  };
}

export function expectRecord(value: JsonValue, path: DecodePath = []): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ProtocolDecodeError("expected object", path);
  }
  return value as Record<string, JsonValue>;
}

export function expectString(value: JsonValue | undefined, path: DecodePath): string {
  if (typeof value !== "string") throw new ProtocolDecodeError("expected string", path);
  return value;
}

export function expectNumber(value: JsonValue | undefined, path: DecodePath): number {
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
