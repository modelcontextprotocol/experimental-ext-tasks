import { describe, expect, it } from "vitest";

import * as coreV2 from "./index.js";

describe("core/v2 entry point", () => {
  it("can be imported", () => {
    expect(coreV2).toBeTypeOf("object");
  });
});
