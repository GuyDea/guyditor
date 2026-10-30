import { describe, expect, it } from "vitest";

import { readableJobTitle } from "./jobs.js";

const assets = [
  { id: "ast_za6x3vytdc", path: "/home/me/vlogs/261027_AI-trickery/IMG_0084.MOV" },
  { id: "ast_44ju7e3cp5", path: "C:\\clips\\IMG_0082.MOV" },
  { id: "ast_aaaaaaaaaa", path: "media/pickups/take-2.wav" },
];

describe("readableJobTitle", () => {
  it("names the clip instead of its asset id", () => {
    expect(readableJobTitle("Transcribe ast_za6x3vytdc", assets)).toBe("Transcribe IMG_0084.MOV");
    expect(readableJobTitle("Generate proxy for ast_44ju7e3cp5", assets))
      .toBe("Generate proxy for IMG_0082.MOV");
    expect(readableJobTitle("Align transcript for ast_aaaaaaaaaa", assets))
      .toBe("Align transcript for take-2.wav");
  });

  it("keeps ids it cannot resolve and titles without ids", () => {
    expect(readableJobTitle("Transcribe ast_bbbbbbbbbb", assets)).toBe("Transcribe ast_bbbbbbbbbb");
    expect(readableJobTitle("Ingest 9 assets", assets)).toBe("Ingest 9 assets");
    expect(readableJobTitle("Transcribe ast_za6x3vytdc", [])).toBe("Transcribe ast_za6x3vytdc");
  });
});
