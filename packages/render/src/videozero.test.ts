import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  createProject,
  deriveTimeline,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  Result,
  TransactionRecord,
} from "../../core/src/index.js";
import { probeMedia } from "../../media/src/index.js";

import {
  RenderService,
  exportOutputPath,
  exportReportPath,
} from "./index.js";
import type { ExportReport } from "./index.js";

const FIXTURE_ROOT = resolve(".fixtures");
const MANIFEST_PATH = join(FIXTURE_ROOT, "manifest.json");
const fixtureManifestMissing = !existsSync(MANIFEST_PATH);
const temporaryDirectories: string[] = [];
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function transaction(): TransactionRecord {
  return {
    id: "txn_aaaaaaaaaa",
    baseRevision: "rev_00001",
    resultRevision: "rev_00002",
    operations: [{
      op: "project.video-zero",
      params: {},
      summary: "Commit the hand-written video-zero master",
    }],
    instruction: { kind: "user-text", text: "Render video zero" },
    actor: { kind: "human", id: "video-zero" },
    versions: {
      app: "0.0.0",
      schema: "guyditor/v1",
      skills: [],
      presets: [],
      tools: [],
    },
    acceptance: {
      status: "accepted",
      by: "video-zero",
      at: "2026-07-18T12:00:00.000Z",
    },
    orphanedAnchors: [],
    addresses: [],
  };
}

interface FixtureManifestEntry {
  bytes: number;
  sha256: string;
}

interface FixtureManifest {
  files: Record<string, FixtureManifestEntry>;
}

function videoZeroProject(manifest: FixtureManifest, annotationSha256: string): GuyditorProject {
  const bars = manifest.files["bars-1080p30-10s.mp4"]!;
  const screencast = manifest.files["screencast-1080p30-15s.mp4"]!;
  return {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: {
      id: "prj_aaaaaaaaaa",
      name: "Video Zero",
      created: "2026-07-18T12:00:00.000Z",
    },
    settings: {
      timeline: { fps: "30/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 1 },
    assets: [
      {
        id: "ast_aaaaaaaaaa",
        kind: "video",
        path: join(FIXTURE_ROOT, "bars-1080p30-10s.mp4"),
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
      },
      {
        id: "ast_bbbbbbbbbb",
        kind: "video",
        path: join(FIXTURE_ROOT, "screencast-1080p30-15s.mp4"),
        sha256: screencast.sha256,
        bytes: screencast.bytes,
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        probe: {
          duration: { frames: 450, fps: "30/1" },
          width: 1920,
          height: 1080,
          fps: "30/1",
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
      },
    ],
    beats: [],
    sequences: [{
      id: "seq_aaaaaaaaaa",
      name: "video zero",
      clips: [
        {
          id: "clp_aaaaaaaaaa",
          asset: "ast_aaaaaaaaaa",
          source: {
            in: { frames: 0, fps: "30/1" },
            out: { frames: 120, fps: "30/1" },
          },
        },
        {
          id: "clp_bbbbbbbbbb",
          asset: "ast_bbbbbbbbbb",
          source: {
            in: { frames: 225, fps: "30/1" },
            out: { frames: 345, fps: "30/1" },
          },
        },
        {
          id: "clp_cccccccccc",
          asset: "ast_aaaaaaaaaa",
          source: {
            in: { frames: 150, fps: "30/1" },
            out: { frames: 240, fps: "30/1" },
          },
          gapBefore: { frames: 30, fps: "30/1" },
        },
      ],
    }],
    layers: [{
      id: "lyr_aaaaaaaaaa",
      kind: "video",
      name: "video zero",
      order: 0,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    }],
    captions: [],
    annotations: {
      sidecar: "annotations",
      summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 },
    },
    deliverables: [{
      id: "dlv_aaaaaaaaaa",
      kind: "longform",
      name: "video-zero",
      profile: "youtube-longform@1.0.0",
      sequenceId: "seq_aaaaaaaaaa",
      status: "approved",
      approvedRevision: "rev_00002",
    }],
    presets: [],
    skills: [],
    sidecars: [{
      name: "annotations",
      path: "sidecars/annotations.json",
      schema: "guyditor.annotations/v1",
      sha256: annotationSha256,
      inputs: [],
    }],
  };
}

function exactFrames(duration: string, fps: string): number {
  const durationMatch = /^(\d+)\/(\d+)$/u.exec(duration)!;
  const fpsMatch = /^(\d+)\/(\d+)$/u.exec(fps)!;
  const numerator = BigInt(durationMatch[1]!) * BigInt(fpsMatch[1]!);
  const denominator = BigInt(durationMatch[2]!) * BigInt(fpsMatch[2]!);
  expect(numerator % denominator).toBe(0n);
  return Number(numerator / denominator);
}

async function awaitDone(queue: JobQueue, jobId: string): Promise<void> {
  const current = queue.get(jobId);
  if (current?.state === "done") return;
  await new Promise<void>((resolveDone, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${jobId}.`));
    }, 120_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId !== jobId || (job.state !== "done" && job.state !== "failed")) return;
      clearTimeout(timeout);
      unsubscribe();
      if (job.state === "failed") {
        reject(new Error(`${job.error?.code ?? "E_UNKNOWN"}: ${job.error?.message ?? "render failed"}`));
      } else {
        resolveDone();
      }
    });
  });
}

describe.skipIf(fixtureManifestMissing)(
  "video zero (skipped when .fixtures/manifest.json is missing; run pnpm fixtures)",
  () => {
    it("renders the hand-written accepted revision through RenderService and a real JobQueue", async () => {
      const root = await mkdtemp(join(tmpdir(), "guyditor-video-zero-"));
      temporaryDirectories.push(root);
      const annotationBytes = "{}\n";
      const annotationSha256 = createHash("sha256").update(annotationBytes).digest("hex");
      await mkdir(join(root, "sidecars"), { recursive: true });
      await writeFile(join(root, "sidecars/annotations.json"), annotationBytes, "utf8");
      const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as FixtureManifest;
      const initial = videoZeroProject(manifest, annotationSha256);
      const store = await valueOf(createProject(root, initial));
      const accepted = structuredClone(initial);
      accepted.revision = "rev_00002";
      await valueOf(store.commit(accepted, transaction()));

      const queue = JobQueue.open(join(root, ".guyditor/jobs.sqlite"), { concurrency: 1 }).queue;
      queues.push(queue);
      const service = new RenderService({ projectRoot: root, store, jobQueue: queue });
      const validation = await service.validateExport("dlv_aaaaaaaaaa", "rev_00002");
      expect(validation.outcome).toBe("pass");
      expect(validation.checks.every((check) => check.status === "pass")).toBe(true);
      const outputDir = join(root, "exports");
      const observedProgress: number[] = [];
      const unsubscribeProgress = queue.onChange((event) => {
        if (event.kind === "job.progress") observedProgress.push(event.job.progress);
      });
      const { jobId } = await service.renderExport({
        revision: "rev_00002",
        deliverableId: "dlv_aaaaaaaaaa",
        variants: ["clean"],
        outputDir,
      });
      await awaitDone(queue, jobId);
      unsubscribeProgress();

      const output = exportOutputPath(outputDir, "dlv_aaaaaaaaaa", "clean", "mp4");
      expect(existsSync(output)).toBe(true);
      const probe = await probeMedia(output);
      expect(probe.video).toMatchObject({
        codec: "h264",
        pixFmt: "yuv420p",
        width: 1920,
        height: 1080,
        fps: "30/1",
      });
      expect(probe.audio?.[0]?.codec).toBe("aac");
      expect(observedProgress.some((progress) => progress > 0 && progress < 1)).toBe(true);
      const timeline = deriveTimeline(accepted, "seq_aaaaaaaaaa");
      expect(timeline.ok).toBe(true);
      if (!timeline.ok) throw new Error(timeline.error.message);
      const expectedFrames = exactFrames(timeline.value.duration, accepted.settings.timeline.fps);
      expect(expectedFrames).toBeGreaterThanOrEqual(10 * 30);
      expect(probe.probe.duration).toEqual({ frames: expectedFrames, fps: "30/1" });

      const reportPath = exportReportPath(output);
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as ExportReport;
      expect(report).toMatchObject({
        revision: "rev_00002",
        deliverableId: "dlv_aaaaaaaaaa",
        output: { path: output, durationFrames: expectedFrames, fps: "30/1" },
      });
      expect(report.validation.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "VAL-500", status: "pass" }),
        expect.objectContaining({ id: "VAL-501", status: "pass" }),
      ]));
      expect(report.output.sha256).toBe(await sha256(output));
    }, 120_000);
  },
);
