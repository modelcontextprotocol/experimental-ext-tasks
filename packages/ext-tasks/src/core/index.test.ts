import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  ProtocolDecodeError,
  createRuntimeCodec,
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

  it("rejects non-JSON inputs before invoking the decoder", () => {
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
    const decode = vi.fn(() => "decoded");
    const codec = createRuntimeCodec(decode);

    for (const value of nonJsonValues) {
      const result = codec.parse(value);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(ProtocolDecodeError);
        expect(result.error.path).toEqual([]);
      }
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it("invokes the decoder for JSON values and starts it at the root path", () => {
    const decode = vi.fn(
      (value: JsonValue, path: readonly (string | number)[]) => ({
        value,
        path,
      }),
    );
    const codec = createRuntimeCodec(decode);
    const input = { nested: [null, true, 1, "value"] };
    const result = codec.parse(input);

    expect(result).toEqual({
      success: true,
      value: { value: input, path: [] },
    });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith(input, []);
  });

  it("returns decoder ProtocolDecodeError instances unchanged with their paths", () => {
    const error = new ProtocolDecodeError("expected string", [
      "params",
      "name",
    ]);
    const codec = createRuntimeCodec(() => {
      throw error;
    });

    const result = codec.parse({});
    expect(result).toEqual({ success: false, error });
    if (!result.success) {
      expect(result.error).toBe(error);
      expect(result.error.path).toEqual(["params", "name"]);
    }
  });

  it("rethrows unexpected decoder errors unchanged", () => {
    const error = new Error("programmer failure");
    const codec = createRuntimeCodec(() => {
      throw error;
    });

    expect(() => codec.parse({})).toThrow(error);
    try {
      codec.parse({});
    } catch (caught) {
      expect(caught).toBe(error);
    }
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
