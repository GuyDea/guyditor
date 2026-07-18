import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveFfmpeg } from "./binaries.js";

const originalOverride = process.env.GUYDITOR_FFMPEG;
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.GUYDITOR_FFMPEG;
  } else {
    process.env.GUYDITOR_FFMPEG = originalOverride;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

describe("resolveFfmpeg", () => {
  it("prefers and reports a working environment override", () => {
    const baseline = resolveFfmpeg();
    process.env.GUYDITOR_FFMPEG = baseline.path;

    expect(resolveFfmpeg()).toEqual({
      path: baseline.path,
      source: "environment",
      version: baseline.version,
    });
  });

  it("throws the missing-binary envelope when no candidate works", () => {
    process.env.GUYDITOR_FFMPEG = path.join(
      tmpdir(),
      "guyditor-does-not-exist",
    );
    process.env.PATH = "";

    expect(() => resolveFfmpeg()).toThrow(
      expect.objectContaining({
        acceptedStateChanged: false,
        code: "E_FFMPEG_MISSING",
        retry: "none",
      }),
    );
  });
});
