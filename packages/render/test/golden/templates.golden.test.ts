import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnchorResolverRegistry,
  createProject,
  JobQueue,
  OperationEngine,
  success,
} from "../../../core/src/index.js";
import type { JobRecord } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import {
  createTranscriptWordLookup,
  parseTranscriptSidecar,
  serializeTranscriptSidecar,
} from "../../../transcript/src/index.js";
import {
  compileRenderGraph,
  loadTemplateRuntime,
  renderGraphicFrame,
  renderGraphicOverlaySequence,
  renderTemplatePng,
  resolveTemplateDuration,
  exportOutputPath,
  RenderService,
  TemplateRegistry,
} from "../../src/index.js";
import { dhashFrame } from "./dhash.js";
import type {
  RenderProfile,
  TemplateCatalogEntry,
  ToolchainManifest,
} from "../../src/index.js";

interface GoldenManifest {
  builtins: Record<string, { contentHash: string; frameSha256: string }>;
  anchored: {
    previewFrameSha256: string;
    overlaySha256: string;
    frameHashes: string[];
  };
  finalVideo: { graphicFrame: number; dhash: string };
}

interface OverlayManifest {
  frameHashes: string[];
}

const HASH = "a".repeat(64);
const PROFILE: RenderProfile = {
  id: "youtube",
  version: "1.0.0",
  video: { codec: "libx264", crf: 18, pixelFormat: "yuv420p" },
  audio: { codec: "aac", bitrate: "192k" },
  container: "mp4",
};
const TOOLCHAIN: ToolchainManifest = {
  ffmpeg: { version: "golden", buildSha256: HASH },
  ffprobe: { version: "golden", buildSha256: HASH },
  renderPackage: "0.0.0",
  overlayRenderer: { version: "graphic-overlay/v1", canvasVersion: "1.0.2", fontHashes: {} },
  encoderThreads: 1,
  os: "linux",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const current = queue.get(jobId);
  if (current?.state === "done" || current?.state === "failed") return current;
  return new Promise<JobRecord>((resolveJob, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for graphic golden ${jobId}.`));
    }, 120_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId !== jobId || (job.state !== "done" && job.state !== "failed")) return;
      clearTimeout(timeout);
      unsubscribe();
      resolveJob(job);
    });
  });
}

async function duration(entry: TemplateCatalogEntry, registry: TemplateRegistry): Promise<number> {
  if (entry.duration.default !== undefined) return entry.duration.default.frames;
  const pkg = await registry.package(entry.id, entry.version, entry.contentHash);
  if (!pkg.ok) throw pkg.error;
  const runtime = await loadTemplateRuntime(pkg.value);
  if (!runtime.ok) throw runtime.error;
  const resolved = resolveTemplateDuration(runtime.value, entry.previewParams, {
    width: 640,
    height: 360,
    fps: "30/1",
  });
  if (resolved.ok && resolved.value.mode === "anchor_span") return 120;
  if (!resolved.ok || resolved.value.mode !== "fixed") {
    throw new Error(`Golden template ${entry.id} did not resolve a fixed preview duration.`);
  }
  return resolved.value.frames;
}

describe("FR-600/601/602 template graphics goldens", () => {
  it("pins every built-in painter and proves the anchored overlay is shared by clean and burnin", async () => {
    const expected = JSON.parse(await readFile(
      new URL("./templates.golden.json", import.meta.url),
      "utf8",
    )) as GoldenManifest;
    const userRoot = await mkdtemp(join(tmpdir(), "guyditor-template-golden-user-"));
    temporaryDirectories.push(userRoot);
    const registry = new TemplateRegistry({
      builtinsRoot: resolve("templates"),
      userRoot,
    });
    const catalog = await registry.list();
    if (!catalog.ok) throw catalog.error;
    const builtins: GoldenManifest["builtins"] = {};
    for (const entry of catalog.value) {
      const pkg = await registry.package(entry.id, entry.version, entry.contentHash);
      if (!pkg.ok) throw pkg.error;
      const runtime = await loadTemplateRuntime(pkg.value);
      if (!runtime.ok) throw runtime.error;
      const totalFrames = await duration(entry, registry);
      const frame = Math.min(totalFrames - 1, Math.round(totalFrames * 0.38));
      const png = renderTemplatePng(runtime.value, {
        params: entry.previewParams,
        seed: 0x4755_5944,
        frame,
        totalFrames,
        fps: "30/1",
        width: 640,
        height: 360,
        safeArea: { top: 22, right: 32, bottom: 22, left: 32 },
        brand: { palette: {} },
      });
      if (!png.ok) throw png.error;
      builtins[entry.builtinName ?? entry.id] = {
        contentHash: entry.contentHash,
        frameSha256: digest(png.value),
      };
    }

    const project = projectFixture();
    const lowerThird = catalog.value.find(({ builtinName }) => builtinName === "lower-third")!;
    project.templates = {
      [lowerThird.id]: { version: lowerThird.version, contentHash: lowerThird.contentHash },
    };
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "Graphics",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
      items: [{
        id: "gfx_bbbbbbbbbb",
        template: lowerThird.id,
        at: "word:w000001",
        duration: { frames: 12, fps: "24/1" },
        params: {
          title: "Anchored lower third",
          subtitle: "Rendered once, everywhere",
          accent: "#77E7C4",
          position: "left",
        },
        seed: 42,
      }],
    });
    const common = {
      project,
      sequenceId: "seq_aaaaaaaaaa",
      registry,
      anchorDependencies: {
        wordLookup: {
          resolveWord: () => success({
            wordId: "w000001",
            assetId: "ast_aaaaaaaaaa",
            start: { frames: 4, fps: "24/1" },
            end: { frames: 5, fps: "24/1" },
            approximate: false,
          }),
        },
      },
      width: 640,
      height: 360,
      fps: "24/1",
      brand: { palette: {} },
    } as const;
    const cacheRoot = await mkdtemp(join(tmpdir(), "guyditor-template-golden-overlay-"));
    temporaryDirectories.push(cacheRoot);
    const preview = await renderGraphicFrame({ ...common, frame: 8 });
    const plan = await renderGraphicOverlaySequence({ ...common, cacheRoot });
    if (plan === undefined) throw new Error("Anchored golden did not create an overlay plan.");
    const overlayManifest = JSON.parse(await readFile(
      join(cacheRoot, plan.overlayKey, "manifest.json"),
      "utf8",
    )) as OverlayManifest;
    expect(digest(await readFile(join(cacheRoot, plan.overlayKey, "00000004.png"))))
      .toBe(digest(preview));
    const graphicOverlay = [{
      overlayAssetPath: plan.pathPattern,
      overlaySha256: plan.overlaySha256,
      atOutputFrame: plan.atOutputFrame,
      durationFrames: plan.durationFrames,
    }];
    for (const variant of ["clean", "burnin"] as const) {
      const graph = compileRenderGraph({
        project,
        revision: project.revision,
        deliverableId: "dlv_aaaaaaaaaa",
        variant,
        quality: "high",
        profile: PROFILE,
        profileSha256: HASH,
        toolchain: TOOLCHAIN,
        graphicOverlays: graphicOverlay,
      });
      expect(graph.nodes.filter(({ kind }) => kind === "overlay")).toHaveLength(1);
      expect(graph.nodes.find(({ kind }) => kind === "overlay")?.params).toEqual(graphicOverlay[0]);
    }

    expect({
      builtins,
      anchored: {
        previewFrameSha256: digest(preview),
        overlaySha256: plan.overlaySha256,
        frameHashes: overlayManifest.frameHashes,
      },
    }).toEqual({ builtins: expected.builtins, anchored: expected.anchored });
  }, 30_000);

  it.skipIf(!existsSync(resolve(".fixtures/manifest.json")))(
    "journals a word-anchored lower third and burns identical pixels into clean and burnin exports",
    async () => {
      const expected = JSON.parse(await readFile(
        new URL("./templates.golden.json", import.meta.url),
        "utf8",
      )) as GoldenManifest;
      const root = await mkdtemp(join(tmpdir(), "guyditor-template-final-golden-"));
      temporaryDirectories.push(root);
      const annotationText = "{}\n";
      const sidecar = parseTranscriptSidecar(await readFile(
        resolve(".fixtures/transcripts/short-exact.json"),
        "utf8",
      ));
      const transcriptText = serializeTranscriptSidecar(sidecar);
      const annotationHash = digest(Buffer.from(annotationText));
      const transcriptHash = digest(Buffer.from(transcriptText));
      const fixtureManifest = JSON.parse(await readFile(
        resolve(".fixtures/manifest.json"),
        "utf8",
      )) as { files: Record<string, { sha256: string; bytes: number }> };
      const bars = fixtureManifest.files["bars-1080p30-10s.mp4"]!;
      const initial = projectFixture();
      initial.settings.timeline = { fps: "30/1", width: 1920, height: 1080 };
      initial.assets = [{
        id: "ast_shortexact",
        kind: "video",
        path: resolve(".fixtures/bars-1080p30-10s.mp4"),
        sha256: bars.sha256,
        bytes: bars.bytes,
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        probe: {
          duration: { frames: 300, fps: "30/1" },
          width: 1920,
          height: 1080,
          fps: "30/1",
          audio: { rate: 48_000, channels: 1 },
        },
        video: {
          codec: "h264",
          width: 1920,
          height: 1080,
          fps: "30/1",
          pixFmt: "yuv420p",
          hasAlpha: false,
          rotation: 0,
        },
        audio: [{
          index: 1,
          codec: "aac",
          sampleRate: 48_000,
          channels: 1,
          layout: "mono",
        }],
      }];
      initial.sequences[0]!.clips = [{
        id: "clp_aaaaaaaaaa",
        asset: "ast_shortexact",
        source: {
          in: { frames: 0, fps: "30/1" },
          out: { frames: 60, fps: "30/1" },
        },
      }];
      initial.layers = [initial.layers[0]!];
      initial.layers[0]!.sequence = "seq_aaaaaaaaaa";
      initial.captions = [];
      delete initial.deliverables[0]!.captionsTrackId;
      initial.deliverables[0]!.profile = "youtube-longform@1.0.0";
      initial.presets = [];
      initial.sidecars = [
        {
          name: "annotations",
          path: "sidecars/annotations.json",
          schema: "guyditor.annotations/v1",
          sha256: annotationHash,
          inputs: [],
        },
        {
          name: "transcript-main",
          path: "sidecars/transcript.json",
          schema: "guyditor.transcript/v1",
          sha256: transcriptHash,
          inputs: [{ asset: "ast_shortexact", sha256: bars.sha256 }],
        },
      ];
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(root, "sidecars"), { recursive: true });
      await writeFile(join(root, "sidecars/annotations.json"), annotationText, "utf8");
      await writeFile(join(root, "sidecars/transcript.json"), transcriptText, "utf8");
      const created = await createProject(root, initial, { appVersion: "0.0.0-graphics-golden" });
      if (!created.ok) throw created.error;
      const userRoot = await mkdtemp(join(tmpdir(), "guyditor-template-final-user-"));
      temporaryDirectories.push(userRoot);
      const registry = new TemplateRegistry({ builtinsRoot: resolve("templates"), userRoot });
      const resolvers = new AnchorResolverRegistry();
      resolvers.registerWordLookup(createTranscriptWordLookup([sidecar]));
      const engine = new OperationEngine(created.value.currentProject, {
        appVersion: "0.0.0-graphics-golden",
        committer: created.value,
        templateProvider: registry,
        anchorResolvers: resolvers,
      });
      const applied = await engine.execute([{
        op: "graphic.add",
        params: {
          templateId: "tpl_a2c3d4e5f6",
          anchor: "word:w000001",
          duration: { frames: 30, fps: "30/1" },
          params: {
            title: "Anchored lower third",
            subtitle: "Clean is still deliberate",
            accent: "#77E7C4",
            position: "left",
          },
          seed: 42,
        },
      }], {
        baseRevision: created.value.currentProject.revision,
        origin: "ui",
        dryRun: false,
      });
      if (!applied.ok) throw applied.error;
      const journal = await readFile(join(root, "history/transactions.jsonl"), "utf8");
      expect(journal.trimEnd().split("\n").at(-1)).toContain("graphic.add");

      const { queue } = JobQueue.open(join(root, ".guyditor/jobs-graphics-golden.sqlite"), {
        concurrency: 1,
      });
      try {
        const service = new RenderService({
          projectRoot: root,
          store: created.value,
          jobQueue: queue,
          profilesRoot: resolve("profiles"),
          templateRegistry: registry,
        });
        const preview = await service.graphicsFrame({
          revision: created.value.currentProject.revision,
          deliverableId: "dlv_aaaaaaaaaa",
          frame: expected.finalVideo.graphicFrame,
        });
        expect(preview.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
        const outputDir = join(root, "exports");
        const enqueued = await service.renderExport({
          revision: created.value.currentProject.revision,
          deliverableId: "dlv_aaaaaaaaaa",
          variants: ["burnin", "clean"],
          outputDir,
        });
        for (const jobId of enqueued.jobIds) {
          expect(await terminal(queue, jobId)).toMatchObject({ state: "done" });
        }
        const burnin = exportOutputPath(outputDir, "dlv_aaaaaaaaaa", "burnin", "mp4");
        const clean = exportOutputPath(outputDir, "dlv_aaaaaaaaaa", "clean", "mp4");
        const burninHash = dhashFrame(burnin, expected.finalVideo.graphicFrame);
        const cleanHash = dhashFrame(clean, expected.finalVideo.graphicFrame);
        expect(burninHash).toBe(cleanHash);
        expect(burninHash).toBe(expected.finalVideo.dhash);
        expect(dhashFrame(clean, 2)).not.toBe(cleanHash);
      } finally {
        queue.close();
      }
    },
    120_000,
  );
});
