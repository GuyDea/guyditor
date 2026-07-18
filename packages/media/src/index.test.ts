import { describe, expect, it } from "vitest";

import * as packageModule from "./index.js";

describe("@guyditor/media", () => {
  it("loads the @guyditor/media package entry point", () => {
    expect(packageModule).toBeDefined();
  });

  it("exports the FFmpeg plumbing API", () => {
    expect(packageModule).toMatchObject({
      probeMedia: expect.any(Function),
      resolveFfmpeg: expect.any(Function),
      resolveFfprobe: expect.any(Function),
      runFfmpeg: expect.any(Function),
      runFfprobe: expect.any(Function),
    });
  });
});
