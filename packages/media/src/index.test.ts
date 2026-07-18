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

  it("exports the FR-003 proxy, peaks, and cache-estimation contracts", () => {
    expect(packageModule).toMatchObject({
      PEAK_SAMPLE_RATE: 48_000,
      PEAK_SAMPLES_PER_PEAK: [960, 9_600, 48_000],
      PROXY_PROFILE_VERSION: expect.any(Number),
      PcmPeakAccumulator: expect.any(Function),
      peaksCachePaths: expect.any(Function),
      peaksDecodeCommand: expect.any(Function),
      proxyCachePaths: expect.any(Function),
      proxyCommand: expect.any(Function),
      proxyIsStale: expect.any(Function),
      proxyProfile: expect.any(Function),
    });
  });
});
