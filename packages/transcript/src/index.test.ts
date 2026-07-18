import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/transcript", () => {
  it("loads the @guyditor/transcript package entry point", () => {
    expect(packageModule).toBeDefined();
  });
});
