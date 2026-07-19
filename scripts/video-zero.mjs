import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CAPTION_FONT_PATH,
  ensureCaptionFont,
} from "./setup-caption-font.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, ".fixtures");
const DEMO_ROOT = path.join(REPOSITORY_ROOT, ".guyditor-demo");
const PROJECT_ROOT = path.join(DEMO_ROOT, "project");
const OUTPUT_ROOT = path.join(DEMO_ROOT, "exports");
const RUNTIME_ROOT = path.join(DEMO_ROOT, ".runtime");

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function requireFixtureManifest() {
  const manifestPath = path.join(FIXTURE_ROOT, "manifest.json");
  try {
    await access(manifestPath);
  } catch {
    throw new Error(".fixtures/manifest.json is missing; run pnpm fixtures first.");
  }
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function buildRuntime() {
  const compilerPath = path.join(
    REPOSITORY_ROOT,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      "-p",
      path.join(REPOSITORY_ROOT, "packages", "render", "tsconfig.json"),
      "--noEmit",
      "false",
      "--outDir",
      RUNTIME_ROOT,
      "--rootDir",
      path.join(REPOSITORY_ROOT, "packages"),
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not build the video-zero runtime: ${
        result.error?.message ?? `${result.stdout}${result.stderr}`.trim()
      }`,
    );
  }
  const runtimeModules = path.join(RUNTIME_ROOT, "node_modules");
  const runtimeFont = path.join(RUNTIME_ROOT, "render/assets/fonts/Inconsolata.otf");
  await ensureCaptionFont();
  await mkdir(path.dirname(runtimeFont), { recursive: true });
  await copyFile(CAPTION_FONT_PATH, runtimeFont);
  await mkdir(runtimeModules, { recursive: true });
  await Promise.all([
    symlink(
      path.join(REPOSITORY_ROOT, "packages/core/node_modules/ajv"),
      path.join(runtimeModules, "ajv"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    symlink(
      path.join(REPOSITORY_ROOT, "node_modules/yaml"),
      path.join(runtimeModules, "yaml"),
      process.platform === "win32" ? "junction" : "dir",
    ),
  ]);
  const [core, media, render] = await Promise.all([
    import(pathToFileURL(path.join(RUNTIME_ROOT, "core/src/index.js")).href),
    import(pathToFileURL(path.join(RUNTIME_ROOT, "media/src/index.js")).href),
    import(pathToFileURL(path.join(RUNTIME_ROOT, "render/src/index.js")).href),
  ]);
  return { core, media, render };
}

function projectModel(manifest, annotationsSha256) {
  const bars = manifest.files["bars-1080p30-10s.mp4"];
  const screencast = manifest.files["screencast-1080p30-15s.mp4"];
  if (!bars || !screencast) {
    throw new Error("The fixture manifest does not contain video-zero media.");
  }
  return {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: {
      id: "prj_aaaaaaaaaa",
      name: "Video Zero Demo",
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
        path: path.join(FIXTURE_ROOT, "bars-1080p30-10s.mp4"),
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
        path: path.join(FIXTURE_ROOT, "screencast-1080p30-15s.mp4"),
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
      sha256: annotationsSha256,
      inputs: [],
    }],
  };
}

function commitRecord() {
  return {
    id: "txn_aaaaaaaaaa",
    baseRevision: "rev_00001",
    resultRevision: "rev_00002",
    operations: [{
      op: "project.video-zero",
      params: {},
      summary: "Commit the hand-written video-zero demo master",
    }],
    instruction: { kind: "user-text", text: "Render video zero" },
    actor: { kind: "human", id: "video-zero-demo" },
    versions: {
      app: "0.0.0",
      schema: "guyditor/v1",
      skills: [],
      presets: [],
      tools: [],
    },
    acceptance: {
      status: "accepted",
      by: "video-zero-demo",
      at: "2026-07-18T12:00:00.000Z",
    },
    orphanedAnchors: [],
    addresses: [],
  };
}

function resultValue(result, label) {
  if (!result.ok) throw new Error(`${label}: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function exactFrames(duration, fps) {
  const durationMatch = /^(\d+)\/(\d+)$/u.exec(duration);
  const fpsMatch = /^(\d+)\/(\d+)$/u.exec(fps);
  if (!durationMatch || !fpsMatch) throw new Error("Invalid exact timeline duration.");
  const numerator = BigInt(durationMatch[1]) * BigInt(fpsMatch[1]);
  const denominator = BigInt(durationMatch[2]) * BigInt(fpsMatch[2]);
  if (numerator % denominator !== 0n) throw new Error("Timeline duration is not an output frame.");
  return Number(numerator / denominator);
}

async function awaitDone(queue, jobId) {
  const current = queue.get(jobId);
  if (current?.state === "done") return;
  await new Promise((resolveDone, reject) => {
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

export async function runVideoZero({ log = console.log } = {}) {
  const manifest = await requireFixtureManifest();
  await rm(DEMO_ROOT, { recursive: true, force: true });
  await mkdir(path.join(PROJECT_ROOT, "sidecars"), { recursive: true });
  const annotations = "{}\n";
  const annotationsSha256 = createHash("sha256").update(annotations).digest("hex");
  await writeFile(path.join(PROJECT_ROOT, "sidecars/annotations.json"), annotations, "utf8");
  const { core, media, render } = await buildRuntime();
  let queue;
  try {
    const initial = projectModel(manifest, annotationsSha256);
    const store = resultValue(await core.createProject(PROJECT_ROOT, initial), "create project");
    const accepted = structuredClone(initial);
    accepted.revision = "rev_00002";
    resultValue(await store.commit(accepted, commitRecord()), "commit video zero");
    queue = core.JobQueue.open(path.join(PROJECT_ROOT, ".guyditor/jobs.sqlite"), {
      concurrency: 1,
    }).queue;
    const service = new render.RenderService({
      projectRoot: PROJECT_ROOT,
      profilesRoot: path.join(REPOSITORY_ROOT, "profiles"),
      store,
      jobQueue: queue,
    });
    const { jobId } = await service.renderExport({
      revision: "rev_00002",
      deliverableId: "dlv_aaaaaaaaaa",
      variants: ["clean"],
      outputDir: OUTPUT_ROOT,
    });
    await awaitDone(queue, jobId);
    const outputPath = render.exportOutputPath(
      OUTPUT_ROOT,
      "dlv_aaaaaaaaaa",
      "clean",
      "mp4",
    );
    const probe = await media.probeMedia(outputPath);
    if (!probe.video || !probe.probe.duration || !("frames" in probe.probe.duration)) {
      throw new Error("video-zero output does not contain a probed video stream.");
    }
    const timeline = resultValue(core.deriveTimeline(accepted, "seq_aaaaaaaaaa"), "derive timeline");
    const durationFrames = exactFrames(timeline.duration, accepted.settings.timeline.fps);
    assertEqual(probe.video.codec, "h264", "video codec");
    assertEqual(probe.video.pixFmt, "yuv420p", "pixel format");
    assertEqual(probe.video.width, 1920, "width");
    assertEqual(probe.video.height, 1080, "height");
    assertEqual(probe.video.fps, "30/1", "frame rate");
    assertEqual(probe.audio?.[0]?.codec, "aac", "audio codec");
    assertEqual(probe.probe.duration.frames, durationFrames, "exact duration frames");
    if (durationFrames < 300) throw new Error("video-zero duration is shorter than the M0 10 s criterion.");
    const reportPath = render.exportReportPath(outputPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assertEqual(report.output.sha256, await sha256(outputPath), "report output SHA-256");
    assertEqual(report.output.durationFrames, durationFrames, "report duration frames");
    const summary = {
      revision: report.revision,
      profile: `${report.profile.id}@${report.profile.version}`,
      durationFrames: report.output.durationFrames,
      fps: report.output.fps,
      sha256: report.output.sha256,
    };
    log(`video-zero output: ${outputPath}`);
    log(`video-zero report: ${JSON.stringify(summary)}`);
    return { outputPath, reportPath, summary };
  } finally {
    queue?.close();
    await rm(RUNTIME_ROOT, { recursive: true, force: true });
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) {
  runVideoZero().catch((error) => {
    console.error(`video-zero: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
