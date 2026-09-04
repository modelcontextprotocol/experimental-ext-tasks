import { describe, expect, it } from "vitest";

import * as coreV1 from "./index.js";

describe("core/v1 entry point", () => {
  it("can be imported", () => {
    expect(coreV1).toBeTypeOf("object");
  });
});
