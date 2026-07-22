import { describe, expect, it } from "vitest";

import type { PlatformProfile } from "./profile.js";
import {
  draftPublishMetadata,
  extractTranscriptText,
  generateChapterList,
  metadataTextBlock,
  selectCoverFrames,
  validateMetadata,
} from "./publish.js";

function profile(): PlatformProfile {
  return {
    format: "guyditor-profile/v1",
    id: "test-platform",
    version: "1.0.0",
    displayName: "Test platform",
    kind: "longform",
    video: {
      aspect: "16:9",
      resolution: { width: 1280, height: 720 },
      fps: { allowed: ["30/1"], default: "30/1" },
      container: "mp4",
      codec: "h264",
      codecProfile: "high",
      pixelFormat: "yuv420p",
      colorSpace: "bt709",
      rateControl: { mode: "crf", crf: 18, maxBitrateKbps: 8_000 },
    },
    duration: { minSeconds: 1, maxSeconds: null, recommendedMaxSeconds: null },
    audio: {
      codec: "aac",
      sampleRate: 48_000,
      channels: 2,
      bitrateKbps: 192,
      loudness: { integratedLufs: -14, toleranceLu: 1, truePeakDbtp: -1, lraMaxLu: 11 },
    },
    safeAreas: {
      title: { top: 0, right: 0, bottom: 0, left: 0 },
      action: { top: 0, right: 0, bottom: 0, left: 0 },
      platformUi: [],
    },
    captionDefaults: {
      maxLines: 2,
      maxCharsPerLine: 32,
      placement: { anchor: "center", verticalCenter: 0.8 },
      perWordHighlight: true,
    },
    metadata: {
      title: { maxChars: 5 },
      description: { maxChars: 18 },
      tags: { maxCount: 2, totalMaxChars: 8 },
      hashtags: { maxCount: 2, countedIn: "description" },
    },
    cover: {
      resolution: { width: 1280, height: 720 },
      formats: ["jpg", "png"],
      maxBytes: 2_097_152,
    },
    chapters: { minCount: 3, minChapterSeconds: 10, firstMustBeZero: true },
  };
}

describe("publish metadata", () => {
  it("counts Unicode code points and hashtags in the description against profile limits", () => {
    const errors = validateMetadata({
      format: "guyditor-publish/v1",
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "test-platform@1.0.0",
      language: "en",
      title: "👍👍👍👍👍👍",
      description: "Watch this #one #two #three",
      tags: ["four", "fives"],
      hashtags: ["#one"],
      status: "draft",
    }, profile());

    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "title", actual: 6, max: 5 }),
      expect.objectContaining({ field: "description", max: 18 }),
      expect.objectContaining({ field: "tags.totalChars", actual: 9, max: 8 }),
      expect.objectContaining({ field: "hashtags", actual: 3, max: 2 }),
    ]));
    expect(errors.every(({ code }) => code === "E_METADATA_LIMIT_EXCEEDED")).toBe(true);
  });

  it("drafts reproducible creator-editable metadata from transcript and beats", () => {
    const input = {
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "youtube-longform@1.0.0",
      language: "en",
      transcript: "A precise hook explains exact editing and a reliable payoff.",
      beats: ["Exact editing", "Reliable delivery"],
      brandVoice: { id: "skl_aaaaaaaaaa", version: "3" },
    } as const;
    const first = draftPublishMetadata(input);
    const second = draftPublishMetadata(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      format: "guyditor-publish/v1",
      deliverableId: input.deliverableId,
      status: "draft",
      draftedBy: {
        agent: "guyditor-template",
        model: "deterministic-local-v1",
        skillVersions: { skl_aaaaaaaaaa: "3" },
      },
    });
    expect(first.title).toContain("Exact editing");
    expect(first.description).toContain("precise hook");
    expect(first.cta).toBeTruthy();
  });

  it("serializes an approved metadata paste block", () => {
    expect(metadataTextBlock({
      format: "guyditor-publish/v1",
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "youtube-longform@1.0.0",
      language: "en",
      title: "Exact cuts",
      description: "Ship the finished story.",
      tags: ["editing", "workflow"],
      hashtags: ["#editing", "workflow"],
      cta: "Subscribe for the next cut.",
      status: "approved",
    })).toBe("Exact cuts\n\nShip the finished story.\n\nSubscribe for the next cut.\n\nTags: editing, workflow\nHashtags: #editing #workflow\n");
  });
});

describe("chapter and transcript derivation", () => {
  it("forces zero, merges too-short chapters, and emits paste-ready exact seconds", () => {
    const generated = generateChapterList({
      deliverableId: "dlv_aaaaaaaaaa",
      revision: "rev_00007",
      beats: [
        { beatId: "beat_aaaaaaaaaa", title: "Setup", startSeconds: 12 },
        { beatId: "beat_bbbbbbbbbb", title: "Tiny aside", startSeconds: 18 },
        { beatId: "beat_cccccccccc", title: "Payoff", startSeconds: 42 },
      ],
      rules: { minCount: 3, minChapterSeconds: 10, firstMustBeZero: true },
    });

    expect(generated.list).toMatchObject({
      format: "guyditor-chapters/v1",
      derivedAtRevision: "rev_00007",
      status: "draft",
      chapters: [
        { title: "Intro", startSeconds: 0 },
        { beatId: "beat_aaaaaaaaaa", title: "Setup", startSeconds: 12 },
        { beatId: "beat_cccccccccc", title: "Payoff", startSeconds: 42 },
      ],
    });
    expect(generated.text).toBe("0:00 Intro\n0:12 Setup\n0:42 Payoff\n");
    expect(generated.warnings).toContain("Merged chapter ‘Tiny aside’ into ‘Setup’ because it was shorter than 10 seconds.");
    expect(generated.errors).toEqual([]);
  });

  it("reports the platform minimum chapter count", () => {
    const generated = generateChapterList({
      deliverableId: "dlv_aaaaaaaaaa",
      revision: "rev_00001",
      beats: [{ beatId: "beat_aaaaaaaaaa", title: "Only", startSeconds: 0 }],
      rules: { minCount: 3, minChapterSeconds: 10, firstMustBeZero: true },
    });
    expect(generated.errors).toEqual([expect.objectContaining({ code: "E_CHAPTER_COUNT", actual: 1, minimum: 3 })]);
  });

  it("walks clip ranges in timeline order and inserts beat and pause paragraphs", () => {
    const text = extractTranscriptText({
      clips: [
        { assetId: "ast_aaaaaaaaaa", startWordId: "w000001", endWordId: "w000003" },
        { assetId: "ast_aaaaaaaaaa", startWordId: "w000005", endWordId: "w000006" },
      ],
      beatWordIds: ["w000005"],
      words: [
        { id: "w000001", assetId: "ast_aaaaaaaaaa", text: "First", punctAfter: "", startSamples: 0, endSamples: 10_000, rate: 48_000, state: "active", speaker: "A" },
        { id: "w000002", assetId: "ast_aaaaaaaaaa", text: "precise", punctAfter: "", startSamples: 12_000, endSamples: 20_000, rate: 48_000, state: "active", speaker: "A" },
        { id: "w000003", assetId: "ast_aaaaaaaaaa", text: "cut", punctAfter: ".", startSamples: 100_000, endSamples: 110_000, rate: 48_000, state: "active", speaker: "A" },
        { id: "w000005", assetId: "ast_aaaaaaaaaa", text: "Then", punctAfter: "", startSamples: 120_000, endSamples: 130_000, rate: 48_000, state: "active", speaker: "B" },
        { id: "w000006", assetId: "ast_aaaaaaaaaa", text: "payoff", punctAfter: "!", startSamples: 132_000, endSamples: 140_000, rate: 48_000, state: "active", speaker: "B" },
      ],
    });
    expect(text).toBe("A: First precise\n\nA: cut.\n\nB: Then payoff!\n");
  });
});

describe("cover candidates", () => {
  it("prioritizes hook and beats, ranks analysis frames, and enforces one-second spacing", () => {
    expect(selectCoverFrames({
      fps: 30,
      durationFrames: 300,
      hookFrame: 15,
      beatFrames: [48, 90],
      scoredFrames: [
        { frame: 16, faceArea: 1, sharpness: 100 },
        { frame: 130, faceArea: 0.8, sharpness: 100 },
        { frame: 170, faceArea: 0.5, sharpness: 100 },
        { frame: 210, faceArea: 0.9, sharpness: 100 },
        { frame: 250, faceArea: 0.7, sharpness: 100 },
      ],
      limit: 6,
    })).toEqual([15, 48, 90, 210, 130, 250]);
  });
});
