import { describe, expect, it } from "vitest";

import * as server from "./index.js";

describe("server entry point", () => {
  it("can be imported", () => {
    expect(server).toBeTypeOf("object");
  });
});
