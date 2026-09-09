import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  JsonValueCodec,
  ProtocolDecodeError,
  isJsonValue,
  runtimeCodecFromStandardSchema,
  taskId,
  toJsonValue,
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
        expect(JsonValueCodec.parse(value)).toEqual({ success: true, value });
      }),
    );
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.bigInt(), fc.constant(Symbol("x"))),
        (value) => {
          expect(isJsonValue(value)).toBe(false);
          const decoded = JsonValueCodec.parse(value as never);
          expect(decoded.success).toBe(false);
          if (!decoded.success)
            expect(decoded.error).toBeInstanceOf(ProtocolDecodeError);
        },
      ),
    );
  });

  it("rejects exotic, cyclic, sparse, and non-finite values", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class Exotic {
      readonly marker = "non-plain";
    }
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
      const decoded = JsonValueCodec.parse(value as never);
      expect(decoded.success).toBe(false);
      if (!decoded.success)
        expect(decoded.error).toBeInstanceOf(ProtocolDecodeError);
    }
  });

  it("accepts plain objects with null prototypes", () => {
    const value = Object.assign(Object.create(null) as object, { ok: true });
    expect(JsonValueCodec.parse(value as JsonValue)).toEqual({
      success: true,
      value,
    });
  });
  it("normalizes values with JSON stringify/parse semantics", () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = undefined;
    class Value {
      constructor(readonly kept: string) {}
    }
    const normalized = toJsonValue({
      omitted: undefined,
      custom: { toJSON: () => ({ answer: 42 }) },
      sparse,
      instance: new Value("yes"),
    });
    expect(normalized).toEqual({
      custom: { answer: 42 },
      sparse: [null, null],
      instance: { kept: "yes" },
    });
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(() => toJsonValue(undefined)).toThrow(/top-level JSON value/);
    expect(() => toJsonValue({ value: 1n })).toThrow(/serialized as JSON/);
  });

  it("adapts canonical synchronous Standard Schema results with structured issues", () => {
    const success = runtimeCodecFromStandardSchema<number>({
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ value: 7 }),
      },
    });
    expect(success.parse(null)).toEqual({ success: true, value: 7 });
    const sourceIssues = [
      { message: "not a number", path: ["answer", 0] },
      { message: "out of range", path: [{ key: "limit" }] },
    ] as const;
    const issues = runtimeCodecFromStandardSchema<number>({
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: sourceIssues }),
      },
    });
    const issueResult = issues.parse(null);
    expect(issueResult.success).toBe(false);
    if (!issueResult.success) {
      expect(issueResult.error.message).toBe("not a number; out of range");
      expect(issueResult.error.details.issues).toEqual(sourceIssues);
      expect(issueResult.error.details.issues).not.toBe(sourceIssues);
      expect(Object.isFrozen(issueResult.error.details.issues)).toBe(true);
      expect(Object.isFrozen(issueResult.error.details.issues?.[0]?.path)).toBe(
        true,
      );
    }
    const thrownError = new Error("boom");
    const thrown = runtimeCodecFromStandardSchema<number>({
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => {
          throw thrownError;
        },
      },
    });
    const thrownResult = thrown.parse(null);
    expect(thrownResult.success).toBe(false);
    if (!thrownResult.success) {
      expect(thrownResult.error).toBeInstanceOf(ProtocolDecodeError);
      expect(thrownResult.error.details).toEqual({});
      expect(thrownResult.error.cause).toBe(thrownError);
    }
  });

  it("brands task identifiers without changing their wire value", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(taskId(value)).toBe(value);
      }),
    );
  });
});
