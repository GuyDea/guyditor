import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/render", () => {
  it("loads the @guyditor/render package entry point", () => {
    expect(packageModule).toBeDefined();
  });
});
