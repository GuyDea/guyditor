import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { deriveTimeline } from "../../core/src/index.js";
import type {
  GuyditorProject,
  RestyleFrameRange,
} from "../../core/src/index.js";

import { runFfmpeg } from "./run.js";

const FIXED_CREATION_TIME = "2000-01-01T00:00:00.000Z";

function fpsValue(fps: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) throw new TypeError(`Invalid frame rate ${fps}.`);
  return Number(match[1]) / Number(match[2]);
}

function fixedVideoOutput(outputPath: string): string[] {
  return [
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-threads", "1",
    "-g", "30",
    "-keyint_min", "30",
    "-sc_threshold", "0",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-map_metadata", "-1",
    "-metadata", `creation_time=${FIXED_CREATION_TIME}`,
    "-movflags", "+faststart",
    outputPath,
  ];
}

export interface ApplyDeterministicRestyleFilterInput {
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  fps: string;
  durationSeconds: number;
  signal?: AbortSignal;
}

export async function applyDeterministicRestyleFilter(
  input: ApplyDeterministicRestyleFilterInput,
): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", input.inputPath,
    "-t", input.durationSeconds.toFixed(6),
    "-vf",
    [
      `fps=${input.fps}`,
      `scale=${String(input.width)}:${String(input.height)}:force_original_aspect_ratio=decrease`,
      `pad=${String(input.width)}:${String(input.height)}:(ow-iw)/2:(oh-ih)/2:black`,
      "setsar=1",
      "curves=r='0/0 0.45/0.72 1/1':g='0/0 0.5/0.35 1/1':b='0/0 0.5/0.8 1/1'",
      "hue=h=35:s=1.25",
    ].join(","),
    ...fixedVideoOutput(input.outputPath),
  ], input.signal === undefined ? {} : { signal: input.signal });
}

export interface MaterializeRestyleSegmentInput {
  project: GuyditorProject;
  sequenceId: string;
  range: RestyleFrameRange;
  outputPath: string;
  projectRoot?: string;
  signal?: AbortSignal;
}

export interface MaterializedRestyleSegment {
  outputPath: string;
  durationSeconds: number;
  sourceAssetIds: string[];
}

export async function materializeRestyleSegment(
  input: MaterializeRestyleSegmentInput,
): Promise<MaterializedRestyleSegment> {
  const timeline = deriveTimeline(input.project, input.sequenceId);
  if (!timeline.ok) throw new Error(timeline.error.message);
  const sequence = input.project.sequences.find(({ id }) => id === input.sequenceId);
  if (sequence === undefined) throw new Error(`Sequence ${input.sequenceId} does not exist.`);
  const clips = new Map(sequence.clips.map((clip) => [clip.id, clip] as const));
  const timelineFps = fpsValue(input.project.settings.timeline.fps);
  const intersections = timeline.value.clips.flatMap((derived) => {
    const startFrame = Math.max(input.range.startFrame, derived.start.frames);
    const endFrame = Math.min(
      input.range.endFrame,
      derived.start.frames + derived.duration.frames,
    );
    if (endFrame <= startFrame) return [];
    const clip = clips.get(derived.clipId)!;
    if ((clip.effects ?? []).some(({ kind }) => kind === "speed" || kind === "freeze")) {
      throw new Error(`Restyle materialization does not yet support timed effect ${clip.id}.`);
    }
    const asset = input.project.assets.find(({ id }) => id === clip.asset);
    if (asset === undefined || asset.video === undefined) {
      throw new Error(`Restyle source clip ${clip.id} requires a video asset.`);
    }
    const sourceFps = fpsValue(clip.source.in.fps);
    return [{
      assetId: asset.id,
      path: isAbsolute(asset.path)
        ? asset.path
        : resolve(input.projectRoot ?? process.cwd(), asset.path),
      sourceStartSeconds: clip.source.in.frames / sourceFps +
        (startFrame - derived.start.frames) / timelineFps,
      durationFrames: endFrame - startFrame,
    }];
  });
  const coveredFrames = intersections.reduce((sum, item) => sum + item.durationFrames, 0);
  const requestedFrames = input.range.endFrame - input.range.startFrame;
  if (requestedFrames <= 0 || coveredFrames !== requestedFrames) {
    throw new Error("Restyle source range must be fully covered by video clips.");
  }
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  for (const intersection of intersections) {
    args.push(
      "-ss", intersection.sourceStartSeconds.toFixed(6),
      "-t", (intersection.durationFrames / timelineFps).toFixed(6),
      "-i", intersection.path,
    );
  }
  const width = input.project.settings.timeline.width;
  const height = input.project.settings.timeline.height;
  const filters = intersections.map((_intersection, index) =>
    `[${String(index)}:v:0]fps=${input.project.settings.timeline.fps},` +
    `scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,` +
    `pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2:black,` +
    `setsar=1,setpts=PTS-STARTPTS[v${String(index)}]`);
  const inputs = intersections.map((_intersection, index) => `[v${String(index)}]`).join("");
  filters.push(`${inputs}concat=n=${String(intersections.length)}:v=1:a=0[outv]`);
  await mkdir(dirname(input.outputPath), { recursive: true });
  await runFfmpeg([
    ...args,
    "-filter_complex", filters.join(";"),
    "-map", "[outv]",
    "-frames:v", String(requestedFrames),
    ...fixedVideoOutput(input.outputPath),
  ], input.signal === undefined ? {} : { signal: input.signal });
  return {
    outputPath: input.outputPath,
    durationSeconds: requestedFrames / timelineFps,
    sourceAssetIds: intersections.map(({ assetId }) => assetId),
  };
}
