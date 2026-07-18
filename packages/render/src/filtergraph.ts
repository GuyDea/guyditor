import { fileURLToPath } from "node:url";

import { makeGuyditorError } from "../../core/src/index.js";

import {
  VIRTUAL_GAP_ASSET,
  VIRTUAL_SILENCE_ASSET,
  validateRenderGraph,
} from "./graph.js";
import type {
  AudioChainNodeParams,
  CompositeNodeParams,
  EncodeNodeParams,
  RenderGraph,
  RenderNode,
  SourceNodeParams,
  TrimNodeParams,
} from "./ir.js";

interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

export interface CompiledFiltergraph {
  args: string[];
  expectedDurationFrames: number;
  expectedDurationSeconds: string;
  filterComplex: string;
}

function unsupported(feature: string, affected: readonly string[] = []): never {
  throw makeGuyditorError(
    "E_RENDER_UNSUPPORTED",
    `${feature} is unsupported by the M0 renderer; Part 12 owns this feature.`,
    { affected },
  );
}

function graphInvalid(message: string, affected: readonly string[] = []): never {
  throw makeGuyditorError("E_RENDER_GRAPH_INVALID", message, { affected });
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function fraction(numerator: bigint, denominator: bigint): Fraction {
  if (denominator === 0n) graphInvalid("A filtergraph rational denominator is zero.");
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return {
    numerator: (numerator * sign) / divisor,
    denominator: (denominator * sign) / divisor,
  };
}

function add(left: Fraction, right: Fraction): Fraction {
  return fraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left: Fraction, right: Fraction): Fraction {
  return fraction(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiply(left: Fraction, right: Fraction): Fraction {
  return fraction(left.numerator * right.numerator, left.denominator * right.denominator);
}

function rational(value: string): Fraction {
  const match = /^(-?\d+)\/(\d+)$/u.exec(value);
  if (match === null) graphInvalid(`Invalid render rational ${value}.`);
  return fraction(BigInt(match[1]!), BigInt(match[2]!));
}

function seconds(value: TrimNodeParams["in"]): Fraction {
  if ("frames" in value) {
    const fps = rational(value.fps);
    return fraction(BigInt(value.frames) * fps.denominator, fps.numerator);
  }
  return fraction(BigInt(value.samples), BigInt(value.rate));
}

function expression(value: Fraction): string {
  return value.denominator === 1n
    ? value.numerator.toString()
    : `${value.numerator.toString()}/${value.denominator.toString()}`;
}

function decimal(value: Fraction, digits = 12): string {
  if (value.numerator < 0n) graphInvalid("FFmpeg command times must not be negative.");
  const whole = value.numerator / value.denominator;
  let remainder = value.numerator % value.denominator;
  if (remainder === 0n) return whole.toString();
  let decimals = "";
  for (let index = 0; index < digits && remainder !== 0n; index += 1) {
    remainder *= 10n;
    decimals += (remainder / value.denominator).toString();
    remainder %= value.denominator;
  }
  return `${whole.toString()}.${decimals}`;
}

function safeNumber(value: bigint, feature: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    unsupported(`${feature} outside exact integer bounds`);
  }
  return Number(value);
}

function isVirtual(source: SourceNodeParams): boolean {
  return source.assetId === VIRTUAL_GAP_ASSET || source.assetId === VIRTUAL_SILENCE_ASSET;
}

function localPath(path: string, role: "input" | "output"): string {
  if (/^[A-Za-z]:[\\/]/u.test(path)) return path;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(path)?.[1]?.toLowerCase();
  if (scheme === undefined) return path;
  if (scheme === "file") return fileURLToPath(path);
  unsupported(`non-file ${role} ${path}`, [path]);
}

function params<T>(node: RenderNode, kind: RenderNode["kind"]): T {
  if (node.kind !== kind) graphInvalid(`Expected ${kind} node, received ${node.kind}.`, [node.id]);
  return node.params as T;
}

function outputDuration(trim: TrimNodeParams): Fraction {
  const duration = subtract(seconds(trim.out), seconds(trim.in));
  if (duration.numerator <= 0n) graphInvalid("A trim duration must be positive.");
  return trim.speed === undefined
    ? duration
    : multiply(duration, fraction(BigInt(trim.speed.den), BigInt(trim.speed.num)));
}

function atempoFilters(speed: NonNullable<TrimNodeParams["speed"]>): string[] {
  let numerator = BigInt(speed.num);
  let denominator = BigInt(speed.den);
  const filters: string[] = [];
  while (numerator > denominator * 2n) {
    filters.push("atempo=2");
    denominator *= 2n;
  }
  while (denominator > numerator * 2n) {
    filters.push("atempo=0.5");
    numerator *= 2n;
  }
  filters.push(`atempo=${decimal(fraction(numerator, denominator))}`);
  return filters;
}

export function compileFiltergraph(graph: RenderGraph, outputPath?: string): CompiledFiltergraph {
  validateRenderGraph(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const composite = graph.nodes.find((node) => node.kind === "composite");
  const audiochain = graph.nodes.find((node) => node.kind === "audiochain");
  const encode = graph.nodes.find((node) => node.kind === "encode");
  if (composite === undefined || audiochain === undefined || encode === undefined) {
    graphInvalid("The M0 graph requires composite, audiochain, and encode nodes.");
  }
  const encodeParams = params<EncodeNodeParams>(encode, "encode");
  const output = localPath(
    outputPath ?? `${graph.deliverableId}-${graph.variant}.${encodeParams.container}`,
    "output",
  );
  const canvas = params<CompositeNodeParams>(composite, "composite").canvas;
  const stages = params<AudioChainNodeParams>(audiochain, "audiochain").stages;
  if (stages.length > 0) unsupported("audiochain stages", [audiochain.id]);
  if (composite.inputs.length === 0 || composite.inputs.length !== audiochain.inputs.length) {
    graphInvalid("Video and audio sequence slot counts must match.");
  }

  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  const filters: string[] = [];
  const inputIndexBySource = new Map<string, number>();
  let inputCount = 0;

  function sourceAndTrim(trimId: string): { source: SourceNodeParams; trim: TrimNodeParams } {
    const trimNode = byId.get(trimId);
    if (trimNode === undefined) graphInvalid(`Missing trim node ${trimId}.`, [trimId]);
    const trim = params<TrimNodeParams>(trimNode, "trim");
    if (trimNode.inputs.length !== 1) graphInvalid(`Trim ${trimId} requires one source input.`, [trimId]);
    const sourceNode = byId.get(trimNode.inputs[0]!);
    if (sourceNode === undefined) graphInvalid(`Trim ${trimId} source is missing.`, [trimId]);
    const source = params<SourceNodeParams>(sourceNode, "source");
    if (!isVirtual(source) && !inputIndexBySource.has(sourceNode.id)) {
      const end = seconds(trim.out);
      args.push(
        "-ss",
        "0",
        "-to",
        decimal(end),
        "-i",
        localPath(source.path, "input"),
      );
      inputIndexBySource.set(sourceNode.id, inputCount);
      inputCount += 1;
    }
    return { source, trim };
  }

  let totalDuration = fraction(0n, 1n);
  const videoLabels: string[] = [];
  for (const [slot, trimId] of composite.inputs.entries()) {
    const { source, trim } = sourceAndTrim(trimId);
    const duration = outputDuration(trim);
    totalDuration = add(totalDuration, duration);
    const outputLabel = `v${String(slot)}`;
    if (isVirtual(source)) {
      filters.push(
        `color=c=${canvas.background}:s=${String(canvas.w)}x${String(canvas.h)}` +
        `:r=${graph.outputFps}:d=${decimal(duration)},setpts=PTS-STARTPTS[${outputLabel}]`,
      );
    } else {
      const sourceNode = byId.get(byId.get(trimId)!.inputs[0]!)!;
      const inputIndex = inputIndexBySource.get(sourceNode.id);
      if (inputIndex === undefined) graphInvalid(`No FFmpeg input exists for ${sourceNode.id}.`);
      if (!("frames" in trim.in) || !("frames" in trim.out)) {
        graphInvalid(`Video trim ${trimId} must use frame time.`, [trimId]);
      }
      const speed = trim.speed === undefined
        ? "PTS-STARTPTS"
        : `(PTS-STARTPTS)*${String(trim.speed.den)}/${String(trim.speed.num)}`;
      filters.push(
        `[${String(inputIndex)}:v]trim=start_frame=${String(trim.in.frames)}:end_frame=${String(trim.out.frames)},` +
        `setpts=${speed},fps=${graph.outputFps},` +
        `scale=${String(canvas.w)}:${String(canvas.h)}:force_original_aspect_ratio=decrease:flags=bicubic,` +
        `pad=${String(canvas.w)}:${String(canvas.h)}:(ow-iw)/2:(oh-ih)/2:color=${canvas.background},` +
        `setsar=1[${outputLabel}]`,
      );
    }
    videoLabels.push(`[${outputLabel}]`);
  }

  const audioLabels: string[] = [];
  let outputSampleRate: number | undefined;
  for (const [slot, trimId] of audiochain.inputs.entries()) {
    const { source, trim } = sourceAndTrim(trimId);
    if (!("samples" in trim.in) || !("samples" in trim.out)) {
      graphInvalid(`Audio trim ${trimId} must use sample time.`, [trimId]);
    }
    outputSampleRate ??= trim.in.rate;
    const outputLabel = `a${String(slot)}`;
    if (isVirtual(source)) {
      filters.push(
        `anullsrc=r=${String(trim.in.rate)}:cl=stereo,` +
        `atrim=start_sample=0:end_sample=${String(trim.out.samples - trim.in.samples)},` +
        `asetpts=PTS-STARTPTS[${outputLabel}]`,
      );
    } else {
      const sourceNode = byId.get(byId.get(trimId)!.inputs[0]!)!;
      const inputIndex = inputIndexBySource.get(sourceNode.id);
      if (inputIndex === undefined) graphInvalid(`No FFmpeg input exists for ${sourceNode.id}.`);
      const speedFilters = trim.speed === undefined ? [] : atempoFilters(trim.speed);
      filters.push(
        `[${String(inputIndex)}:a]atrim=start_sample=${String(trim.in.samples)}:end_sample=${String(trim.out.samples)},` +
        `asetpts=PTS-STARTPTS${speedFilters.length === 0 ? "" : `,${speedFilters.join(",")}`},` +
        `aresample=${String(trim.in.rate)},aformat=sample_fmts=fltp:channel_layouts=stereo[${outputLabel}]`,
      );
    }
    audioLabels.push(`[${outputLabel}]`);
  }

  filters.push(`${videoLabels.join("")}concat=n=${String(videoLabels.length)}:v=1:a=0[vout]`);
  filters.push(`${audioLabels.join("")}concat=n=${String(audioLabels.length)}:v=0:a=1[aout]`);
  const filterComplex = filters.join(";");
  const outputFps = rational(graph.outputFps);
  const frameFraction = multiply(totalDuration, outputFps);
  if (frameFraction.numerator % frameFraction.denominator !== 0n) {
    graphInvalid("The graph duration is not an integer output frame.");
  }
  const expectedDurationFrames = safeNumber(
    frameFraction.numerator / frameFraction.denominator,
    "output frame count",
  );
  const codecArgs = Object.entries(encodeParams.vcodecParams)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => [`-${key}`, String(value)]);
  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    encodeParams.vcodec,
    ...codecArgs,
    "-pix_fmt",
    encodeParams.pixFmt,
    "-c:a",
    encodeParams.acodec,
    "-b:a",
    encodeParams.abitrate,
    "-ar",
    String(outputSampleRate ?? 48_000),
    "-ac",
    "2",
    "-r",
    graph.outputFps,
    "-frames:v",
    String(expectedDurationFrames),
    "-t",
    decimal(totalDuration),
    "-threads",
    String(graph.toolchain.encoderThreads),
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    "-loglevel",
    "error",
    output,
  );
  return {
    args,
    expectedDurationFrames,
    expectedDurationSeconds: expression(totalDuration),
    filterComplex,
  };
}
