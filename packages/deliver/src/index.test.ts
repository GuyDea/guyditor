import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/deliver", () => {
  it("loads the @guyditor/deliver package entry point", () => {
    expect(packageModule).toBeDefined();
  });
});
