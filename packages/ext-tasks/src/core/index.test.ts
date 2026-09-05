import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ProtocolDecodeError,
  isJsonValue,
  taskId,
  type JsonValue,
} from "./index.js";

const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("value"), { maxKeys: 4 }),
  ),
})).value as fc.Arbitrary<JsonValue>;

describe("core runtime contracts", () => {
  it("recognizes exactly JSON-compatible generated values", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(isJsonValue(value)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.bigInt(), fc.constant(Symbol("x"))),
        (value) => {
          expect(isJsonValue(value)).toBe(false);
        },
      ),
    );
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    expect(isJsonValue(Object.assign(Object.create(null), { ok: true }))).toBe(
      true,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(isJsonValue(sparse)).toBe(false);
  });

  it("brands task identifiers without changing their wire value", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(taskId(value)).toBe(value);
      }),
    );
  });

  it("exposes decode failures as Error values with stable paths", () => {
    const error = new ProtocolDecodeError("expected string", [
      "task",
      "taskId",
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error.path).toEqual(["task", "taskId"]);
    expect(error.message).toContain("task.taskId");
  });
});
