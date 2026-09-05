import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  JsonValueSchema,
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
  it("recognizes and parses exactly JSON-compatible generated values", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(isJsonValue(value)).toBe(true);
        expect(JsonValueSchema.parse(value)).toEqual(value);
      }),
    );
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.bigInt(), fc.constant(Symbol("x"))),
        (value) => {
          expect(isJsonValue(value)).toBe(false);
          expect(JsonValueSchema.safeParse(value).success).toBe(false);
        },
      ),
    );
  });

  it("rejects exotic, cyclic, sparse, and non-finite values", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class Exotic {}
    const nonJsonValues: readonly unknown[] = [
      undefined,
      1n,
      Symbol("x"),
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date(),
      new Map(),
      sparse,
      cyclic,
      new Exotic(),
      Object.create({ inherited: true }) as object,
      /not-json/,
    ];

    for (const value of nonJsonValues) {
      expect(JsonValueSchema.safeParse(value).success).toBe(false);
      expect(() => JsonValueSchema.parse(value)).toThrow();
    }
  });

  it("accepts plain objects with null prototypes", () => {
    const value = Object.assign(Object.create(null) as object, { ok: true });
    expect(JsonValueSchema.parse(value)).toEqual(value);
  });
  it("brands task identifiers without changing their wire value", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(taskId(value)).toBe(value);
      }),
    );
  });
});
