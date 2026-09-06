import * as z from "zod/v4";
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

export type TaskSnapshot =
  | { readonly generation: "v1"; readonly task: TaskV1 }
  | { readonly generation: "v2"; readonly task: TaskV2 | DetailedTaskV2 };

/** Brands a string as a task identifier without runtime validation or transformation. */
export function taskId(value: string): TaskId {
  return value as TaskId;
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
    let valid: boolean;
    if (Array.isArray(candidate)) {
      valid =
        candidate.length === Object.keys(candidate).length &&
        candidate.every(visit);
    } else {
      const prototype = Reflect.getPrototypeOf(candidate);
      valid =
        (prototype === Object.prototype || prototype === null) &&
        Object.values(candidate).every(visit);
    }
    visiting.delete(candidate);
    return valid;
  };
  return visit(value);
}

/** Validates the package's recursive JSON data model. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  isJsonValue,
  "Expected a JSON value",
);
