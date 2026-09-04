import { describe, expect, it } from "vitest";

import * as client from "./index.js";

describe("client entry point", () => {
  it("can be imported", () => {
    expect(client).toBeTypeOf("object");
  });
});
