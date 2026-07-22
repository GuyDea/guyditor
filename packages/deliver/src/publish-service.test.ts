import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GuyditorProject } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  PublishService,
  type PublishMetadata,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "guyditor-publish-"));
  roots.push(path);
  return path;
}

function metadata(deliverableId: string, profile: string): PublishMetadata {
  return {
    format: "guyditor-publish/v1",
    deliverableId,
    profile,
    language: "en",
    title: "Exact editing",
    description: "A deterministic editing workflow from source to upload kit.",
    tags: ["editing", "workflow"],
    hashtags: ["#editing"],
    status: "approved",
    approvedRevision: "rev_00001",
  };
}

async function fixtureFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixturePng(path: string, width: number, height: number): Promise<void> {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function shortProject(projectRoot: string): Promise<GuyditorProject> {
  const project = projectFixture();
  project.deliverables[0] = {
    ...project.deliverables[0]!,
    kind: "short",
    profile: "youtube-shorts@1.0.0",
    status: "approved",
    approvedRevision: "rev_00001",
    publish: { metadata: metadata("dlv_aaaaaaaaaa", "youtube-shorts@1.0.0") },
  };
  const output = join(projectRoot, "exports", "dlv_aaaaaaaaaa");
  await Promise.all([
    fixtureFile(join(output, "video.burned.mp4"), "burned"),
    fixtureFile(join(output, "video.clean.mp4"), "clean"),
    fixtureFile(join(output, "subtitles.srt"), "1\n00:00:00,000 --> 00:00:01,000\nExact\n"),
    fixtureFile(join(output, "subtitles.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nExact\n"),
    fixtureFile(join(output, "covers", "cover-01.jpg"), "cover"),
    fixtureFile(join(output, "export-report.json"), `${JSON.stringify({
      reportVersion: "guyditor-export-report/1",
      revision: "rev_00001",
      deliverableId: "dlv_aaaaaaaaaa",
      outputSet: {
        artifacts: [
          { path: "video.burned.mp4", sha256: hash("burned") },
          { path: "video.clean.mp4", sha256: hash("clean") },
          { path: "subtitles.srt", sha256: hash("1\n00:00:00,000 --> 00:00:01,000\nExact\n") },
          { path: "subtitles.vtt", sha256: hash("WEBVTT\n\n00:00.000 --> 00:01.000\nExact\n") },
          { path: "covers/cover-01.jpg", sha256: hash("cover") },
        ],
      },
    })}\n`),
  ]);
  return project;
}

describe("PublishService", () => {
  it("writes creator-editable metadata and plain text atomically with stable hashes", async () => {
    const projectRoot = await root();
    const project = await shortProject(projectRoot);
    const service = new PublishService({
      projectRoot,
      project: () => project,
      profilesRoot: new URL("../../../profiles/", import.meta.url),
    });
    const stored = await service.writeMetadata(project.deliverables[0]!.publish!.metadata!);
    const transcript = await service.writeText("dlv_aaaaaaaaaa", "transcript", "Corrected words only.\n");
    const metadataText = await service.writeTextExports("dlv_aaaaaaaaaa", ["metadata"]);

    expect(stored.path).toBe("publish/dlv_aaaaaaaaaa/metadata.yaml");
    expect(stored.sha256).toBe(createHash("sha256").update(await readFile(
      join(projectRoot, stored.path),
    )).digest("hex"));
    expect(transcript.path).toBe("publish/dlv_aaaaaaaaaa/transcript.txt");
    expect(metadataText).toEqual([expect.objectContaining({ path: "publish/dlv_aaaaaaaaaa/metadata.txt" })]);
    expect(await readFile(join(projectRoot, metadataText[0]!.path), "utf8"))
      .toContain("Hashtags: #editing");
  });

  it("builds a complete hashed short-form upload kit", async () => {
    const projectRoot = await root();
    const project = await shortProject(projectRoot);
    const service = new PublishService({
      projectRoot,
      project: () => project,
      profilesRoot: new URL("../../../profiles/", import.meta.url),
    });
    await service.writeMetadata(project.deliverables[0]!.publish!.metadata!);
    await service.writeText("dlv_aaaaaaaaaa", "transcript", "Corrected words only.\n");
    const built = await service.buildKit("dlv_aaaaaaaaaa");

    expect(built.path).toBe("exports/kits/dlv_aaaaaaaaaa/youtube-shorts@1.0.0");
    expect(built.manifest).toMatchObject({
      format: "guyditor-kit/v1",
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "youtube-shorts@1.0.0",
      revision: "rev_00001",
      validation: { passed: true },
    });
    expect(built.manifest.files.map(({ role }) => role)).toEqual(expect.arrayContaining([
      "video-burned", "video-clean", "cover", "subtitles-srt", "subtitles-vtt",
      "metadata", "transcript", "export-report",
    ]));
    for (const file of built.manifest.files) {
      const bytes = await readFile(join(projectRoot, built.path, file.path));
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect((await stat(join(projectRoot, built.path, "kit-manifest.json"))).isFile()).toBe(true);
  });

  it("fails over-limit metadata before creating a kit directory", async () => {
    const projectRoot = await root();
    const project = await shortProject(projectRoot);
    project.deliverables[0]!.publish!.metadata!.title = "x".repeat(101);
    const service = new PublishService({
      projectRoot,
      project: () => project,
      profilesRoot: new URL("../../../profiles/", import.meta.url),
    });
    await service.writeMetadata(project.deliverables[0]!.publish!.metadata!, { skipValidation: true });
    await service.writeText("dlv_aaaaaaaaaa", "transcript", "Corrected words only.\n");

    await expect(service.buildKit("dlv_aaaaaaaaaa")).rejects.toMatchObject({
      code: "E_KIT_VALIDATION_FAILED",
      affected: ["dlv_aaaaaaaaaa"],
      retry: "safe",
      suggestion: "title: 101/100",
    });
    await expect(stat(join(
      projectRoot,
      "exports/kits/dlv_aaaaaaaaaa/youtube-shorts@1.0.0",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects cached exports whose report is not for the current accepted revision", async () => {
    const projectRoot = await root();
    const project = await shortProject(projectRoot);
    const service = new PublishService({
      projectRoot,
      project: () => project,
      profilesRoot: new URL("../../../profiles/", import.meta.url),
    });
    await service.writeMetadata(project.deliverables[0]!.publish!.metadata!);
    await service.writeText("dlv_aaaaaaaaaa", "transcript", "Corrected words only.\n");
    await fixtureFile(join(projectRoot, "exports/dlv_aaaaaaaaaa/export-report.json"),
      "{\"reportVersion\":\"guyditor-export-report/1\",\"revision\":\"rev_00000\",\"deliverableId\":\"dlv_aaaaaaaaaa\"}\n");

    await expect(service.buildKit("dlv_aaaaaaaaaa")).rejects.toMatchObject({
      code: "E_KIT_VALIDATION_FAILED",
      suggestion: "Export report revision rev_00000 does not match rev_00001.",
    });
  });

  it("rejects cached output bytes that do not match the consolidated report hashes", async () => {
    const projectRoot = await root();
    const project = await shortProject(projectRoot);
    const service = new PublishService({
      projectRoot,
      project: () => project,
      profilesRoot: new URL("../../../profiles/", import.meta.url),
    });
    await service.writeMetadata(project.deliverables[0]!.publish!.metadata!);
    await service.writeText("dlv_aaaaaaaaaa", "transcript", "Corrected words only.\n");
    await fixtureFile(join(projectRoot, "exports/dlv_aaaaaaaaaa/video.clean.mp4"), "changed");

    await expect(service.buildKit("dlv_aaaaaaaaaa")).rejects.toMatchObject({
      code: "E_KIT_VALIDATION_FAILED",
      suggestion: "video.clean.mp4 does not match the export report SHA-256.",
    });
  });

  it("builds a long-form kit only with profile-sized thumbnails and valid approved chapters", async () => {
    const projectRoot = await root();
    const project = await shortProject(projectRoot);
    const deliverable = project.deliverables[0]!;
    deliverable.kind = "longform";
    deliverable.profile = "youtube-longform@1.0.0";
    deliverable.publish = {
      metadata: metadata(deliverable.id, deliverable.profile),
      selectedThumbnail: "keyed-template",
      chapters: {
        format: "guyditor-chapters/v1",
        deliverableId: deliverable.id,
        derivedAtRevision: "rev_00001",
        status: "approved",
        approvedRevision: "rev_00001",
        textSha256: createHash("sha256").update("0:00 Intro\n1:00 Build\n2:00 Ship\n").digest("hex"),
        chapters: [
          { beatId: "beat_aaaaaaaaaa", title: "Intro", startSeconds: 0 },
          { beatId: "beat_bbbbbbbbbb", title: "Build", startSeconds: 60 },
          { beatId: "beat_cccccccccc", title: "Ship", startSeconds: 120 },
        ],
      },
    };
    const service = new PublishService({
      projectRoot,
      project: () => project,
      profilesRoot: new URL("../../../profiles/", import.meta.url),
    });
    await service.writeMetadata(deliverable.publish.metadata!);
    await service.writeChapters(deliverable.publish.chapters!);
    await service.writeText(deliverable.id, "transcript", "Corrected words only.\n");
    const thumbnailPath = join(projectRoot, `publish/${deliverable.id}/thumbnails/keyed-template.png`);
    await fixturePng(thumbnailPath, 1280, 720);

    await expect(service.buildKit(deliverable.id)).resolves.toMatchObject({
      manifest: { files: expect.arrayContaining([
        expect.objectContaining({ role: "thumbnail", path: "thumbnail.png" }),
        expect.objectContaining({ role: "chapters", path: "chapters.txt" }),
      ]) },
    });

    await fixturePng(thumbnailPath, 1080, 1080);
    await expect(service.buildKit(deliverable.id)).rejects.toMatchObject({
      code: "E_KIT_VALIDATION_FAILED",
      suggestion: "Thumbnail must be 1280×720; received 1080×1080.",
    });
  });
});
