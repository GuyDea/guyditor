import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/core", () => {
  it("loads the @guyditor/core package entry point", () => {
    expect(packageModule).toBeDefined();
  });
});
