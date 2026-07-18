import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/agent", () => {
  it("loads the @guyditor/agent package entry point", () => {
    expect(packageModule).toBeDefined();
  });
});
