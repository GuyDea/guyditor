import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProject, OperationEngine } from "../../core/src/index.js";
import type { GuyditorProject, Result } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { PublishService } from "./publish-service.js";
import type { ChapterList, PublishMetadata } from "./publish.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

async function fixtureFile(path: string, value: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function metadata(deliverableId: string, profile: string): PublishMetadata {
  return {
    format: "guyditor-publish/v1",
    deliverableId,
    profile,
    language: "en",
    title: "Exact publishing workflow",
    description: "A corrected, paste-ready description.",
    tags: ["editing", "workflow"],
    hashtags: ["#editing"],
    status: "approved",
    approvedRevision: "rev_00001",
  };
}

function ac011Project(chapterText: string): GuyditorProject {
  const model = projectFixture();
  model.sequences[0]!.clips = [{
    ...model.sequences[0]!.clips[0]!,
    source: { in: { frames: 0, fps: "24/1" }, out: { frames: 240, fps: "24/1" } },
  }];
  model.sequences.push({
    id: "seq_bbbbbbbbbb",
    name: "fixture short",
    clips: [{
      ...model.sequences[0]!.clips[0]!,
      id: "clp_cccccccccc",
    }],
  });
  model.layers.push({
    id: "lyr_bbbbbbbbbb",
    kind: "video",
    name: "fixture short",
    order: 1,
    enabled: true,
    locked: false,
    sequence: "seq_bbbbbbbbbb",
  });
  const chapters: ChapterList & { textSha256: string; approvedRevision: string } = {
    format: "guyditor-chapters/v1",
    deliverableId: "dlv_aaaaaaaaaa",
    derivedAtRevision: "rev_00001",
    status: "approved",
    approvedRevision: "rev_00001",
    textSha256: createHash("sha256").update(chapterText).digest("hex"),
    chapters: [
      { beatId: "beat_aaaaaaaaaa", title: "Intro", startSeconds: 0 },
      { beatId: "beat_bbbbbbbbbb", title: "Build", startSeconds: 60 },
      { beatId: "beat_cccccccccc", title: "Ship", startSeconds: 120 },
    ],
  };
  model.deliverables = [{
    ...model.deliverables[0]!,
    profile: "youtube-longform@1.0.0",
    status: "approved",
    approvedRevision: "rev_00001",
    publish: {
      metadata: metadata("dlv_aaaaaaaaaa", "youtube-longform@1.0.0"),
      chapters,
      selectedThumbnail: "keyed-template",
    },
  }, {
    id: "dlv_bbbbbbbbbb",
    kind: "short",
    name: "fixture short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: "seq_bbbbbbbbbb",
    status: "approved",
    approvedRevision: "rev_00001",
    publish: { metadata: metadata("dlv_bbbbbbbbbb", "youtube-shorts@1.0.0") },
  }];
  return model;
}

describe("AC-011 — package an upload kit", () => {
  it("packages long/short outputs, blocks over-limit metadata, and preserves stale chapter text", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-ac011-"));
    roots.push(root);
    const chapterText = "0:00 Intro\n1:00 Build\n2:00 Ship\n";
    const store = await valueOf(createProject(root, ac011Project(chapterText)));
    const publish = new PublishService({
      projectRoot: root,
      project: () => store.currentProject,
      profilesRoot: new URL("../../../profiles/", import.meta.url),
    });
    for (const deliverable of store.currentProject.deliverables) {
      const output = join(root, "exports", deliverable.id);
      await Promise.all([
        fixtureFile(join(output, "video.burned.mp4"), "burned"),
        fixtureFile(join(output, "video.clean.mp4"), "clean"),
        fixtureFile(join(output, "subtitles.srt"), "1\n00:00:00,000 --> 00:00:01,000\nExact\n"),
        fixtureFile(join(output, "subtitles.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nExact\n"),
        fixtureFile(join(output, "export-report.json"), `${JSON.stringify({
          reportVersion: "guyditor-export-report/1",
          revision: "rev_00001",
          deliverableId: deliverable.id,
          outputSet: {
            artifacts: [
              { path: "video.burned.mp4", sha256: hash("burned") },
              { path: "video.clean.mp4", sha256: hash("clean") },
              { path: "subtitles.srt", sha256: hash("1\n00:00:00,000 --> 00:00:01,000\nExact\n") },
              { path: "subtitles.vtt", sha256: hash("WEBVTT\n\n00:00.000 --> 00:01.000\nExact\n") },
              ...(deliverable.kind === "short"
                ? [{ path: "covers/cover-01.jpg", sha256: hash("cover") }]
                : []),
            ],
          },
        })}\n`),
        publish.writeMetadata(deliverable.publish!.metadata!),
        publish.writeText(deliverable.id, "transcript", "Corrected transcript.\n"),
      ]);
    }
    await publish.writeChapters(store.currentProject.deliverables[0]!.publish!.chapters!);
    await fixtureFile(join(root, "publish/dlv_aaaaaaaaaa/thumbnails/keyed-template.png"), png(1280, 720));
    await fixtureFile(join(root, "exports/dlv_bbbbbbbbbb/covers/cover-01.jpg"), "cover");

    const longKit = await publish.buildKit("dlv_aaaaaaaaaa");
    const shortKit = await publish.buildKit("dlv_bbbbbbbbbb");
    expect(longKit.manifest.files.map(({ role }) => role)).toEqual(expect.arrayContaining([
      "video-burned", "video-clean", "thumbnail", "subtitles-srt", "subtitles-vtt",
      "chapters", "metadata", "transcript", "export-report",
    ]));
    expect(shortKit.manifest.files.map(({ role }) => role)).toEqual(expect.arrayContaining([
      "video-burned", "video-clean", "cover", "subtitles-srt", "subtitles-vtt",
      "metadata", "transcript", "export-report",
    ]));

    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-ac011",
      committer: store,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    const overLimit = {
      ...store.currentProject.deliverables[1]!.publish!.metadata!,
      title: "x".repeat(101),
    };
    await valueOf(engine.execute([{
      op: "deliverable.metadata.set",
      params: { deliverableId: "dlv_bbbbbbbbbb", metadata: overLimit },
    }], { baseRevision: store.currentProject.revision, origin: "ui", dryRun: false }));
    await publish.writeMetadata(overLimit, { skipValidation: true });
    await expect(publish.buildKit("dlv_bbbbbbbbbb")).rejects.toMatchObject({
      code: "E_KIT_VALIDATION_FAILED",
      affected: ["dlv_bbbbbbbbbb"],
      suggestion: "title: 101/100",
    });

    const before = await readFile(join(root, "publish/dlv_aaaaaaaaaa/chapters.txt"), "utf8");
    await valueOf(engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "head",
        delta: { frames: 30, fps: "24/1" },
        snapPolicy: "none",
      },
    }], { baseRevision: store.currentProject.revision, origin: "ui", dryRun: false }));
    const stale = store.currentProject.deliverables[0]!.publish!.chapters!;
    expect(stale).toMatchObject({
      status: "stale",
      textSha256: createHash("sha256").update(chapterText).digest("hex"),
      stale: { warning: expect.stringContaining("30 frames") },
    });
    expect(await readFile(join(root, "publish/dlv_aaaaaaaaaa/chapters.txt"), "utf8"))
      .toBe(before);
  });
});
