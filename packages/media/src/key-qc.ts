import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ChromaKeyParams,
  JobQueue,
  JobRecord,
  JsonValue,
  KeySettings,
} from "../../core/src/index.js";

import { runFfmpeg } from "./run.js";

export interface RgbaFrame {
  data: Uint8Array;
  height: number;
  width: number;
}

export interface KeyQcMetrics {
  frame: number;
  haloScore: number;
  spillScore: number;
  holeCount: number;
  holeArea: number;
  edgeChatter: number;
  detailLoss: number;
}

export type KeyQcWarningCode =
  | "halo"
  | "spill"
  | "holes"
  | "edge_chatter"
  | "detail_loss";

export interface KeyQcWarning {
  code: KeyQcWarningCode;
  frames: number[];
  peak: number;
  message: string;
}

export interface KeyQcReport {
  schema: "guyditor.keyqc/v1";
  clipId: string;
  assetId: string;
  keyParamsHash: string;
  sampledFrames: number[];
  metrics: KeyQcMetrics[];
  warnings: KeyQcWarning[];
}

export interface AnalyzeKeyQcFrameInput {
  frame: number;
  source: RgbaFrame;
  keyed: RgbaFrame;
  previousSource?: RgbaFrame;
  previousKeyed?: RgbaFrame;
  keyColor: string;
  similarity: number;
  blendW: number;
}

export interface BuildKeyQcReportInput {
  clipId: string;
  assetId: string;
  keySettings: KeySettings;
  metrics: readonly KeyQcMetrics[];
}

export interface RunKeyQcInput {
  projectRoot: string;
  sourcePath: string;
  clipId: string;
  assetId: string;
  width: number;
  height: number;
  frameCount: number;
  fps: string;
  keySettings: KeySettings;
  sourceFrameOffset?: number;
  mattePath?: string;
  matteFrameOffset?: number;
  shotBoundaries?: readonly number[];
}

export type KeyQcJobPayload = RunKeyQcInput;

const THRESHOLDS: Readonly<Record<KeyQcWarningCode, number>> = Object.freeze({
  halo: 0.25,
  spill: 0.05,
  holes: 0,
  edge_chatter: 0.04,
  detail_loss: 0.6,
});

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertMatchingFrames(...frames: RgbaFrame[]): void {
  const [{ width, height }] = frames;
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height || frame.data.length !== width * height * 4) {
      throw new TypeError("Key QC RGBA frames must have matching dimensions and four bytes per pixel.");
    }
  }
}

function parseColor(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  if (match === null) throw new TypeError(`Invalid key color ${value}.`);
  return [Number.parseInt(match[1]!, 16) / 255, Number.parseInt(match[2]!, 16) / 255,
    Number.parseInt(match[3]!, 16) / 255];
}

function chroma(red: number, green: number, blue: number): readonly [number, number] {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return [0.5 + (blue - luma) / 1.8556, 0.5 + (red - luma) / 1.5748];
}

function chromaDistance(
  red: number,
  green: number,
  blue: number,
  key: readonly [number, number, number],
): number {
  const [cb, cr] = chroma(red, green, blue);
  const [keyCb, keyCr] = chroma(...key);
  return Math.hypot(cb - keyCb, cr - keyCr) / Math.SQRT2;
}

function hueAndSaturation(red: number, green: number, blue: number): readonly [number, number] {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (delta === 0) return [0, 0];
  const sector = maximum === red
    ? ((green - blue) / delta) % 6
    : maximum === green
      ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  return [((sector * 60) + 360) % 360, maximum === 0 ? 0 : delta / maximum];
}

function hueDistance(left: number, right: number): number {
  const direct = Math.abs(left - right);
  return Math.min(direct, 360 - direct);
}

function alphaAt(frame: RgbaFrame, pixel: number): number {
  return frame.data[pixel * 4 + 3]! / 255;
}

function lumaAt(frame: RgbaFrame, pixel: number): number {
  const offset = pixel * 4;
  return (0.2126 * frame.data[offset]! + 0.7152 * frame.data[offset + 1]! +
    0.0722 * frame.data[offset + 2]!) / 255;
}

function dilatedEdgeBand(frame: RgbaFrame): Uint8Array {
  const original = new Uint8Array(frame.width * frame.height);
  for (let pixel = 0; pixel < original.length; pixel += 1) {
    const alpha = alphaAt(frame, pixel);
    if (alpha > 0.05 && alpha < 0.95) original[pixel] = 1;
  }
  const dilated = new Uint8Array(original);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      let marked = false;
      for (let dy = -2; dy <= 2 && !marked; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < frame.width && ny >= 0 && ny < frame.height &&
              original[ny * frame.width + nx] === 1) {
            marked = true;
            break;
          }
        }
      }
      if (marked) dilated[y * frame.width + x] = 1;
    }
  }
  return dilated;
}

function largestForeground(frame: RgbaFrame): Uint8Array {
  const seen = new Uint8Array(frame.width * frame.height);
  let largest: number[] = [];
  for (let start = 0; start < seen.length; start += 1) {
    if (seen[start] === 1 || alphaAt(frame, start) < 0.5) continue;
    const component: number[] = [];
    const queue = [start];
    seen[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const pixel = queue[cursor]!;
      component.push(pixel);
      const x = pixel % frame.width;
      const y = Math.floor(pixel / frame.width);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const next = ny * frame.width + nx;
        if (nx >= 0 && nx < frame.width && ny >= 0 && ny < frame.height &&
            seen[next] === 0 && alphaAt(frame, next) >= 0.5) {
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  const result = new Uint8Array(seen.length);
  for (const pixel of largest) result[pixel] = 1;
  return result;
}

function holeMetrics(frame: RgbaFrame): { count: number; area: number } {
  const foreground = largestForeground(frame);
  const seen = new Uint8Array(foreground.length);
  let count = 0;
  let area = 0;
  const minimumArea = frame.width * frame.height * 1e-4;
  for (let start = 0; start < seen.length; start += 1) {
    if (seen[start] === 1 || alphaAt(frame, start) >= 0.5) continue;
    const queue = [start];
    seen[start] = 1;
    let touchesBoundary = false;
    let touchesLargest = false;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const pixel = queue[cursor]!;
      const x = pixel % frame.width;
      const y = Math.floor(pixel / frame.width);
      if (x === 0 || y === 0 || x === frame.width - 1 || y === frame.height - 1) touchesBoundary = true;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= frame.width || ny < 0 || ny >= frame.height) continue;
        const next = ny * frame.width + nx;
        if (foreground[next] === 1) touchesLargest = true;
        if (seen[next] === 0 && alphaAt(frame, next) < 0.5) {
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    if (!touchesBoundary && touchesLargest && queue.length >= minimumArea) {
      count += 1;
      area += queue.length;
    }
  }
  return { count, area: area / (frame.width * frame.height) };
}

function laplacianEnergy(frame: RgbaFrame, pixel: number, alpha: boolean): number {
  const x = pixel % frame.width;
  const y = Math.floor(pixel / frame.width);
  const sample = (sx: number, sy: number): number => {
    const index = Math.min(frame.height - 1, Math.max(0, sy)) * frame.width +
      Math.min(frame.width - 1, Math.max(0, sx));
    return alpha ? alphaAt(frame, index) : lumaAt(frame, index);
  };
  const center = sample(x, y);
  return Math.abs(8 * center - sample(x - 1, y - 1) - sample(x, y - 1) -
    sample(x + 1, y - 1) - sample(x - 1, y) - sample(x + 1, y) -
    sample(x - 1, y + 1) - sample(x, y + 1) - sample(x + 1, y + 1));
}

function localMotion(current: RgbaFrame, previous: RgbaFrame, pixel: number): number {
  const x = pixel % current.width;
  const y = Math.floor(pixel / current.width);
  let total = 0;
  let count = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= current.width || ny < 0 || ny >= current.height) continue;
      const index = ny * current.width + nx;
      total += Math.abs(lumaAt(current, index) - lumaAt(previous, index));
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

export function analyzeKeyQcFrame(input: AnalyzeKeyQcFrameInput): KeyQcMetrics {
  const frames = [input.source, input.keyed];
  if (input.previousSource !== undefined) frames.push(input.previousSource);
  if (input.previousKeyed !== undefined) frames.push(input.previousKeyed);
  assertMatchingFrames(...frames);
  const edge = dilatedEdgeBand(input.keyed);
  const key = parseColor(input.keyColor);
  const [keyHue] = hueAndSaturation(...key);
  let edgePixels = 0;
  let halo = 0;
  let opaque = 0;
  let spill = 0;
  let chatter = 0;
  let chatterPixels = 0;
  let alphaEnergy = 0;
  let lumaEnergy = 0;
  const dref = input.similarity + input.blendW;
  for (let pixel = 0; pixel < edge.length; pixel += 1) {
    const offset = pixel * 4;
    const red = input.source.data[offset]! / 255;
    const green = input.source.data[offset + 1]! / 255;
    const blue = input.source.data[offset + 2]! / 255;
    if (edge[pixel] === 1) {
      edgePixels += 1;
      const distance = chromaDistance(red, green, blue, key);
      halo += Math.max(0, 1 - distance / Math.max(Number.EPSILON, dref));
      alphaEnergy += laplacianEnergy(input.keyed, pixel, true);
      lumaEnergy += laplacianEnergy(input.source, pixel, false);
      if (input.previousKeyed !== undefined &&
          (input.previousSource === undefined || localMotion(input.source, input.previousSource, pixel) < 0.05)) {
        chatter += Math.abs(alphaAt(input.keyed, pixel) - alphaAt(input.previousKeyed, pixel));
        chatterPixels += 1;
      }
    }
    if (alphaAt(input.keyed, pixel) > 0.95) {
      opaque += 1;
      const [hue, saturation] = hueAndSaturation(red, green, blue);
      if (saturation > 0.25 && hueDistance(hue, keyHue) <= 20) spill += 1;
    }
  }
  const holes = holeMetrics(input.keyed);
  return {
    frame: input.frame,
    haloScore: edgePixels === 0 ? 0 : halo / edgePixels,
    spillScore: opaque === 0 ? 0 : spill / opaque,
    holeCount: holes.count,
    holeArea: holes.area,
    edgeChatter: chatterPixels === 0 ? 0 : chatter / chatterPixels,
    detailLoss: lumaEnergy === 0 ? 0 : clamp(1 - alphaEnergy / lumaEnergy),
  };
}

export function keyQcSampleFrames(
  frameCount: number,
  shotBoundaries: readonly number[] = [],
): number[] {
  const frames = new Set<number>();
  for (let frame = 0; frame < frameCount; frame += 12) frames.add(frame);
  for (const boundary of shotBoundaries) {
    for (let offset = 0; offset < 5 && boundary + offset < frameCount; offset += 1) {
      if (boundary + offset >= 0) frames.add(boundary + offset);
    }
  }
  return [...frames].sort((left, right) => left - right);
}

function warning(
  code: KeyQcWarningCode,
  metrics: readonly KeyQcMetrics[],
  value: (metric: KeyQcMetrics) => number,
  message: string,
): KeyQcWarning | undefined {
  const affected = metrics.filter((metric) => value(metric) > THRESHOLDS[code]);
  if (affected.length === 0) return undefined;
  return {
    code,
    frames: affected.map(({ frame }) => frame),
    peak: Math.max(...affected.map(value)),
    message,
  };
}

export function buildKeyQcReport(input: BuildKeyQcReportInput): KeyQcReport {
  const metrics = [...input.metrics].sort((left, right) => left.frame - right.frame);
  const warnings = [
    warning("halo", metrics, ({ haloScore }) => haloScore, "Key-colored edge contamination exceeds 0.25."),
    warning("spill", metrics, ({ spillScore }) => spillScore, "Opaque foreground retains excessive key-color spill."),
    warning("holes", metrics, ({ holeCount }) => holeCount, "The foreground matte contains enclosed transparent holes."),
    warning("edge_chatter", metrics, ({ edgeChatter }) => edgeChatter, "Static matte edges change excessively between frames."),
    warning("detail_loss", metrics, ({ detailLoss }) => detailLoss, "Fine foreground detail is missing from the matte."),
  ].filter((entry): entry is KeyQcWarning => entry !== undefined);
  return {
    schema: "guyditor.keyqc/v1",
    clipId: input.clipId,
    assetId: input.assetId,
    keyParamsHash: createHash("sha256").update(JSON.stringify(input.keySettings)).digest("hex"),
    sampledFrames: metrics.map(({ frame }) => frame),
    metrics,
    warnings,
  };
}

export function applyChromaKeyAlpha(source: RgbaFrame, chromaParams: ChromaKeyParams): RgbaFrame {
  const data = new Uint8Array(source.data);
  const key = parseColor(chromaParams.keyColor);
  const similarity = 0.01 + 0.39 * chromaParams.tolerance;
  const blendW = 0.4 * chromaParams.softness;
  for (let pixel = 0; pixel < source.width * source.height; pixel += 1) {
    const offset = pixel * 4;
    const distance = chromaDistance(
      source.data[offset]! / 255,
      source.data[offset + 1]! / 255,
      source.data[offset + 2]! / 255,
      key,
    );
    const alpha = distance < similarity
      ? 0
      : blendW === 0 || distance >= similarity + blendW
        ? 1
        : (distance - similarity) / blendW;
    data[offset + 3] = Math.round(255 * clamp(alpha));
  }
  return { data, height: source.height, width: source.width };
}

export function applyFrozenMatteAlpha(source: RgbaFrame, matte: RgbaFrame): RgbaFrame {
  assertMatchingFrames(source, matte);
  const data = new Uint8Array(source.data);
  for (let pixel = 0; pixel < source.width * source.height; pixel += 1) {
    data[pixel * 4 + 3] = matte.data[pixel * 4]!;
  }
  return { data, height: source.height, width: source.width };
}

function fpsDecimal(fps: string): number {
  const match = /^(\d+)\/(\d+)$/u.exec(fps);
  if (match === null || Number(match[2]) === 0) throw new TypeError(`Invalid frame rate ${fps}.`);
  return Number(match[1]) / Number(match[2]);
}

export async function extractRgbaFrame(
  path: string,
  frame: number,
  width: number,
  height: number,
  fps: string,
  signal?: AbortSignal,
): Promise<RgbaFrame> {
  const chunks: Buffer[] = [];
  await runFfmpeg([
    "-hide_banner", "-nostdin", "-ss", (frame / fpsDecimal(fps)).toFixed(9), "-i", path,
    "-frames:v", "1", "-vf", `scale=${String(width)}:${String(height)}:flags=neighbor`,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], {
    collectStdout: false,
    onStdoutChunk: (chunk) => { chunks.push(chunk); },
    ...(signal === undefined ? {} : { signal }),
  });
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== width * height * 4) {
    throw new Error(`Expected ${String(width * height * 4)} RGBA bytes for frame ${String(frame)}, got ${String(bytes.length)}.`);
  }
  return { data: new Uint8Array(bytes), height, width };
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

export async function runKeyQc(
  input: RunKeyQcInput,
  options: { signal?: AbortSignal; reportProgress?: (progress: number) => void } = {},
): Promise<KeyQcReport> {
  const chromaParams = input.keySettings.chroma;
  const neural = input.keySettings.mode === "neural";
  if (input.keySettings.mode !== "chroma" && !neural) {
    throw new TypeError("Key QC requires chroma or accepted neural key settings.");
  }
  if ((!neural && chromaParams === undefined) || (neural && input.mattePath === undefined)) {
    throw new TypeError("Key QC is missing chroma parameters or the accepted frozen matte path.");
  }
  const frames = keyQcSampleFrames(input.frameCount, input.shotBoundaries);
  const metrics: KeyQcMetrics[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frameNumber = frames[index]!;
    const sourceFrame = frameNumber + (input.sourceFrameOffset ?? 0);
    const source = await extractRgbaFrame(
      input.sourcePath, sourceFrame, input.width, input.height, input.fps, options.signal,
    );
    const previousSource = frameNumber === 0 ? undefined : await extractRgbaFrame(
      input.sourcePath, sourceFrame - 1, input.width, input.height, input.fps, options.signal,
    );
    const matte = neural ? await extractRgbaFrame(
      input.mattePath!, frameNumber + (input.matteFrameOffset ?? 0),
      input.width, input.height, input.fps, options.signal,
    ) : undefined;
    const previousMatte = neural && frameNumber > 0 ? await extractRgbaFrame(
      input.mattePath!, frameNumber - 1 + (input.matteFrameOffset ?? 0),
      input.width, input.height, input.fps, options.signal,
    ) : undefined;
    const keyed = neural
      ? applyFrozenMatteAlpha(source, matte!)
      : applyChromaKeyAlpha(source, chromaParams!);
    metrics.push(analyzeKeyQcFrame({
      frame: frameNumber,
      source,
      keyed,
      ...(previousSource === undefined ? {} : {
        previousSource,
        previousKeyed: neural
          ? applyFrozenMatteAlpha(previousSource, previousMatte!)
          : applyChromaKeyAlpha(previousSource, chromaParams!),
      }),
      keyColor: chromaParams?.keyColor ?? "#00B140",
      similarity: 0.01 + 0.39 * (chromaParams?.tolerance ?? 0.35),
      blendW: 0.4 * (chromaParams?.softness ?? 0.12),
    }));
    options.reportProgress?.((index + 1) / frames.length);
  }
  const report = buildKeyQcReport({ ...input, metrics });
  await atomicWrite(
    join(input.projectRoot, "sidecars", "analysis", `${input.clipId}.keyqc.json`),
    `${JSON.stringify(report)}\n`,
  );
  return report;
}

function keyQcPayload(value: JsonValue): KeyQcJobPayload {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Invalid key.qc.run job payload.");
  }
  return value as unknown as KeyQcJobPayload;
}

function jsonResult(value: KeyQcReport): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function registerKeyQcExecutor(queue: JobQueue): void {
  queue.registerExecutor("keyqc.analyze", async (job, { reportProgress, signal }) =>
    jsonResult(await runKeyQc(keyQcPayload(job.payload), { reportProgress, signal })));
}

export function enqueueKeyQc(queue: JobQueue, input: RunKeyQcInput): JobRecord {
  return queue.enqueue({
    kind: "keyqc.analyze",
    title: `Analyze key quality for ${input.clipId}`,
    cancellable: true,
    payload: JSON.parse(JSON.stringify(input)) as JsonValue,
  });
}
