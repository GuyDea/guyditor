import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/app", () => {
  it("loads the @guyditor/app package entry point", () => {
    expect(packageModule).toBeDefined();
  });
});
