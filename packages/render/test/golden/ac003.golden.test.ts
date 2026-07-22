import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue, openProject } from "../../../core/src/index.js";
import type { JobRecord, Result } from "../../../core/src/index.js";
import {
  compileCaptionTrack,
  loadPinnedCaptionPreset,
  parseSubtitleCues,
  parseTranscriptSidecar,
  resolveCaptionStyle,
  serializeSubtitles,
  TranscriptEngine,
} from "../../../transcript/src/index.js";
import type { TranscriptSidecar } from "../../../transcript/src/index.js";
import {
  CAPTION_CANVAS_VERSION,
  CAPTION_FONT_SHA256,
  CAPTION_OVERLAY_RENDERER_VERSION,
  createCaptionTextMeasurer,
  exportOutputPath,
  RenderService,
  subtitleOutputPaths,
} from "../../src/index.js";
import { dhashFrame, hammingDistance } from "./dhash.js";

interface Ac003Manifest {
  id: string;
  project: string;
  deliverable: string;
  frames: Array<{
    wordId: string;
    correctedText: string;
    frame: number;
    dhash: string;
    maxDistance: number;
    overlaySha256: string;
  }>;
  toolVersions: { overlayRenderer: string; canvas: string; fontSha256: string };
}

interface OverlayManifest {
  atOutputFrame: number;
  durationFrames: number;
  frameHashes: string[];
}

const FIXTURE_ROOT = resolve(".fixtures/projects/ac003");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const current = queue.get(jobId);
  if (current?.state === "done" || current?.state === "failed" || current?.state === "cancelled") {
    return current;
  }
  return new Promise<JobRecord>((resolveJob, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for AC-003 render ${jobId}.`));
    }, 180_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId !== jobId ||
          (job.state !== "done" && job.state !== "failed" && job.state !== "cancelled")) return;
      clearTimeout(timeout);
      unsubscribe();
      resolveJob(job);
    });
  });
}

function halfEvenMilliseconds(value: { num: number; den: number }): number {
  const numerator = BigInt(value.num) * 1_000n;
  const denominator = BigInt(value.den);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  return Number(twice < denominator || (twice === denominator && quotient % 2n === 0n)
    ? quotient
    : quotient + 1n);
}

describe.skipIf(!existsSync(FIXTURE_ROOT))("AC-003 corrected word-highlight captions", () => {
  it("renders corrected text goldens, exports all four outputs, and has zero cue drift", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("./ac003.golden.json", import.meta.url),
      "utf8",
    )) as Ac003Manifest;
    expect(manifest.toolVersions).toEqual({
      overlayRenderer: CAPTION_OVERLAY_RENDERER_VERSION,
      canvas: CAPTION_CANVAS_VERSION,
      fontSha256: CAPTION_FONT_SHA256,
    });
    const root = await mkdtemp(join(tmpdir(), "guyditor-ac003-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, manifest.project);
    await cp(FIXTURE_ROOT, projectRoot, { recursive: true });
    const store = await valueOf(openProject(projectRoot, { appVersion: "0.0.0-ac003" }));
    const originalOrdinal = store.currentProject.transcript.nextWordOrdinal;
    const transcript = new TranscriptEngine({
      appVersion: "0.0.0-ac003",
      idFactory: (prefix) => `${prefix}_bbbbbbbbbb`,
    });
    const correctionOperations = manifest.frames.map(({ correctedText, wordId }) => ({
      op: "transcript.word.correct",
      params: { wordId, text: correctedText },
    }));
    await valueOf(transcript.execute(store, [
      ...correctionOperations,
      {
        op: "transcript.segment.split",
        params: { segmentId: "seg_fixturezzz", beforeWordId: "w000030" },
      },
    ]));
    expect(store.currentProject.transcript.nextWordOrdinal).toBe(originalOrdinal);

    const transcriptReference = store.currentProject.sidecars.find(
      ({ schema }) => schema === "guyditor.transcript/v1",
    );
    expect(transcriptReference).toBeDefined();
    if (transcriptReference === undefined) return;
    const canonicalSidecar = parseTranscriptSidecar(await readFile(
      join(projectRoot, transcriptReference.path),
      "utf8",
    ));
    for (const { correctedText, wordId } of manifest.frames) {
      expect(canonicalSidecar.words[wordId]).toMatchObject({
        text: correctedText,
        origin: "correction",
        state: "active",
      });
    }
    expect(canonicalSidecar.segments).toHaveLength(2);

    const { queue } = JobQueue.open(join(projectRoot, ".guyditor/jobs-ac003.sqlite"), {
      concurrency: 1,
    });
    try {
      const render = new RenderService({
        projectRoot,
        store,
        jobQueue: queue,
        profilesRoot: resolve("profiles"),
      });
      for (const expected of manifest.frames) {
        const frame = await render.captionFrame({
          revision: store.currentProject.revision,
          deliverableId: manifest.deliverable,
          frame: expected.frame,
        });
        const renderedWord = frame.cues.flatMap(({ lines }) =>
          lines.flatMap(({ words }) => words)).find(({ wordId }) => wordId === expected.wordId);
        expect(renderedWord).toMatchObject({
          displayText: expected.correctedText,
          state: "current",
        });
      }
      const outputDir = join(root, "exports");
      const enqueued = await render.renderExport({
        revision: store.currentProject.revision,
        deliverableId: manifest.deliverable,
        variants: ["burnin", "clean"],
        outputDir,
        skipValidationWarnings: true,
      });
      expect(enqueued.jobIds).toHaveLength(2);
      for (const jobId of enqueued.jobIds) {
        expect(await terminal(queue, jobId)).toMatchObject({ state: "done" });
      }
      const subtitles = subtitleOutputPaths(outputDir, manifest.deliverable);
      const outputs = [
        exportOutputPath(outputDir, manifest.deliverable, "burnin", "mp4"),
        exportOutputPath(outputDir, manifest.deliverable, "clean", "mp4"),
        subtitles.srt,
        subtitles.vtt,
      ];
      expect(outputs.map(existsSync)).toEqual([true, true, true, true]);

      const overlayRoot = join(projectRoot, ".guyditor/cache/render/overlays");
      const overlayKeys = await readdir(overlayRoot);
      expect(overlayKeys).toHaveLength(1);
      const overlayManifest = JSON.parse(await readFile(
        join(overlayRoot, overlayKeys[0]!, "manifest.json"),
        "utf8",
      )) as OverlayManifest;
      const comparisons = manifest.frames.map((frame) => {
        const index = frame.frame - overlayManifest.atOutputFrame;
        const overlayPath = join(
          overlayRoot,
          overlayKeys[0]!,
          `${String(index).padStart(8, "0")}.png`,
        );
        const overlaySha256 = createHash("sha256").update(
          existsSync(overlayPath) ? readFileSync(overlayPath) : Buffer.alloc(0),
        ).digest("hex");
        const dhash = dhashFrame(outputs[0]!, frame.frame);
        return {
          ...frame,
          dhash,
          distance: hammingDistance(dhash, frame.dhash),
          overlaySha256,
          manifestSha256: overlayManifest.frameHashes[index],
        };
      });
      expect(comparisons.map(({ distance, maxDistance }) => distance <= maxDistance)).toEqual([true, true, true]);
      expect(comparisons.map(({ overlaySha256, manifestSha256 }) => overlaySha256 === manifestSha256)).toEqual([true, true, true]);
      expect(comparisons.map(({ overlaySha256 }) => overlaySha256)).toEqual(
        manifest.frames.map(({ overlaySha256 }) => overlaySha256),
      );

      const track = store.currentProject.captions[0]!;
      const pin = store.currentProject.presets.find(({ id, version }) =>
        id === track.preset.presetId && version === track.preset.version)!;
      const preset = await loadPinnedCaptionPreset(projectRoot, pin);
      const allWordIds = canonicalSidecar.segments.flatMap(({ words }) => words)
        .filter((wordId) => canonicalSidecar.words[wordId]?.state === "active");
      const driftTrack = {
        ...track,
        breakOverrides: allWordIds.slice(0, -1).map((afterWordId) => ({
          afterWordId,
          kind: "cue" as const,
        })),
      };
      const timeline = {
        sequenceId: "seq_aaaaaaaaaa",
        instances: allWordIds.map((wordId) => ({
          wordId,
          clipId: "clp_aaaaaaaaaa",
          layerId: "lyr_aaaaaaaaaa",
          start: {
            num: canonicalSidecar.words[wordId]!.start.samples,
            den: canonicalSidecar.words[wordId]!.start.rate,
          },
          end: {
            num: canonicalSidecar.words[wordId]!.end.samples,
            den: canonicalSidecar.words[wordId]!.end.rate,
          },
          truncated: false,
        })),
        diagnostics: { clippedWords: [], ambiguousRanges: [], orphanedAnchors: [] },
      };
      const fullModel = compileCaptionTrack({
        track: driftTrack,
        timeline,
        sidecars: [canonicalSidecar] satisfies TranscriptSidecar[],
        style: resolveCaptionStyle(preset.style, track.styleOverrides),
        safeArea: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
        output: { width: 1920, height: 1080, fps: "30/1" },
        measureText: createCaptionTextMeasurer(),
      });
      const parsedSrt = parseSubtitleCues(serializeSubtitles(fullModel, {
        format: "srt", vttWordTimestamps: false, vttPositioning: false, includeSpeakerLabels: false,
      }), "srt");
      const parsedVtt = parseSubtitleCues(serializeSubtitles(fullModel, {
        format: "vtt", vttWordTimestamps: true, vttPositioning: true, includeSpeakerLabels: false,
      }), "vtt");
      const checked = allWordIds.filter((_, index) => (index + 1) % 50 === 0);
      for (const wordId of checked) {
        const index = allWordIds.indexOf(wordId);
        const expectedStart = halfEvenMilliseconds(timeline.instances[index]!.start);
        const expectedEnd = halfEvenMilliseconds(timeline.instances[index]!.end);
        expect(parsedSrt[index]).toMatchObject({ startMs: expectedStart, endMs: expectedEnd });
        expect(parsedVtt[index]).toMatchObject({ startMs: expectedStart, endMs: expectedEnd });
      }
      const firstError = parsedSrt[0]!.startMs - halfEvenMilliseconds(timeline.instances[0]!.start);
      const lastIndex = parsedSrt.length - 1;
      const lastError = parsedSrt[lastIndex]!.endMs - halfEvenMilliseconds(timeline.instances[lastIndex]!.end);
      expect({ checked: checked.length, firstError, lastError }).toEqual({
        checked: 56,
        firstError: 0,
        lastError: 0,
      });
    } finally {
      queue.close();
    }
  }, 240_000);
});
