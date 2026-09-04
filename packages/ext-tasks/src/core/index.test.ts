import { describe, expect, it } from "vitest";

import * as core from "./index.js";

describe("core entry point", () => {
  it("can be imported", () => {
    expect(core).toBeTypeOf("object");
  });
});
