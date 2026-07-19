import { describe, expect, it } from "vitest";

import * as transcriptPackage from "./index.js";

interface SidecarApi {
  parseTranscriptSidecar(text: string): unknown;
  serializeTranscriptSidecar(value: unknown): string;
}

const example = {
  schema: "guyditor.transcript/v1",
  assetId: "ast_aaaaaaaaaa",
  audio: { rate: 48_000, channels: 2, streamIndex: 1 },
  language: "en",
  languageProbability: 0.997,
  provenance: {
    engine: { name: "faster-whisper", version: "1.0.3", model: "large-v3" },
    alignment: null,
    createdAt: "2026-07-18T12:00:00.000Z",
    jobId: "job_aaaaaaaaaa",
  },
  speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker 1" }],
  segments: [{
    id: "seg_aaaaaaaaaa",
    speaker: "spk_aaaaaaaaaa",
    language: null,
    start: { samples: 0, rate: 48_000 },
    end: { samples: 48_000, rate: 48_000 },
    words: ["w000002", "w000001"],
  }],
  words: {
    w000001: {
      text: "later",
      punctBefore: "",
      punctAfter: ".",
      start: { samples: 24_000, rate: 48_000 },
      end: { samples: 36_000, rate: 48_000 },
      confidence: 0.8,
      alignment: "asr",
      state: "deleted",
      origin: "asr",
      replacedBy: ["w000003"],
    },
    w000002: {
      text: "First",
      punctBefore: "\"",
      punctAfter: "",
      start: { samples: 4_800, rate: 48_000 },
      end: { samples: 12_000, rate: 48_000 },
      confidence: 0.94,
      alignment: "ctc",
      state: "active",
      origin: "asr",
    },
  },
};

describe("canonical transcript sidecar", () => {
  it("serializes exact schema fields with word records sorted by source time", () => {
    const api = transcriptPackage as unknown as Partial<SidecarApi>;
    expect(typeof api.serializeTranscriptSidecar).toBe("function");
    if (api.serializeTranscriptSidecar === undefined) return;

    const serialized = api.serializeTranscriptSidecar(example);
    const lines = serialized.trimEnd().split("\n");
    const firstWordLine = lines.findIndex((line) => line.startsWith('    "w000002"'));
    const laterWordLine = lines.findIndex((line) => line.startsWith('    ,"w000001"'));

    expect(serialized.endsWith("\n")).toBe(true);
    expect(firstWordLine).toBeGreaterThan(-1);
    expect(laterWordLine).toBeGreaterThan(firstWordLine);
    expect(lines[firstWordLine]).toContain('"start":{"samples":4800,"rate":48000}');
    expect(lines[laterWordLine]).toContain('"state":"deleted"');
    expect(lines[laterWordLine]).toContain('"replacedBy":["w000003"]');
    expect(JSON.parse(serialized)).toEqual({
      ...example,
      words: {
        w000002: example.words.w000002,
        w000001: example.words.w000001,
      },
    });
  });

  it("round-trips canonical JSON through strict transcript validation", () => {
    const api = transcriptPackage as unknown as Partial<SidecarApi>;
    expect(typeof api.parseTranscriptSidecar).toBe("function");
    expect(typeof api.serializeTranscriptSidecar).toBe("function");
    if (
      api.parseTranscriptSidecar === undefined ||
      api.serializeTranscriptSidecar === undefined
    ) return;

    const serialized = api.serializeTranscriptSidecar(example);
    expect(api.parseTranscriptSidecar(serialized)).toEqual(JSON.parse(serialized));
  });
});
