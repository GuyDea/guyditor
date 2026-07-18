import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/compositor", () => {
  it("loads the @guyditor/compositor package entry point", () => {
    expect(packageModule).toBeDefined();
  });
});
