import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/media", () => {
  it("loads the @guyditor/media package entry point", () => {
    expect(packageModule).toBeDefined();
  });
});
