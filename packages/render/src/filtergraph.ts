import { fileURLToPath } from "node:url";

import { makeGuyditorError } from "../../core/src/index.js";

import {
  VIRTUAL_GAP_ASSET,
  VIRTUAL_SILENCE_ASSET,
  validateRenderGraph,
} from "./graph.js";
import type {
  AudioChainNodeParams,
  AudioStage,
  ColorNodeParams,
  CompositeNodeParams,
  EncodeNodeParams,
  KeyNodeParams,
  OverlayNodeParams,
  PipNodeParams,
  RenderGraph,
  RenderNode,
  SourceNodeParams,
  TimelineInsertNodeParams,
  TransformNodeParams,
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
    `${feature} is unsupported by the M2 renderer; Part 12 owns this feature.`,
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

function secondsForFrames(frames: number, fps: string): Fraction {
  const rate = rational(fps);
  return fraction(BigInt(frames) * rate.denominator, rate.numerator);
}

function expression(value: Fraction): string {
  return value.denominator === 1n
    ? value.numerator.toString()
    : `${value.numerator.toString()}/${value.denominator.toString()}`;
}

function decimal(value: Fraction, digits = 12): string {
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const whole = numerator / value.denominator;
  let remainder = numerator % value.denominator;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  let decimals = "";
  for (let index = 0; index < digits && remainder !== 0n; index += 1) {
    remainder *= 10n;
    decimals += (remainder / value.denominator).toString();
    remainder %= value.denominator;
  }
  return `${negative ? "-" : ""}${whole.toString()}.${decimals}`;
}

function numberText(value: number): string {
  return String(Math.round(value * 1_000_000) / 1_000_000);
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

function nodeLabel(node: RenderNode): string {
  return `n${node.id.slice(3)}`;
}

function inputLabel(label: string): string {
  return `[${label}]`;
}

export function compileFiltergraph(graph: RenderGraph, outputPath?: string): CompiledFiltergraph {
  validateRenderGraph(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const encode = graph.nodes.find((node) => node.kind === "encode");
  const audiochain = graph.nodes.find((node) => node.kind === "audiochain");
  const stackComposite = graph.nodes.find((node) =>
    node.kind === "composite" && (node.params as CompositeNodeParams).mode === "stack");
  if (encode === undefined) graphInvalid("The graph requires an encode node.");
  if (audiochain === undefined) graphInvalid("The graph requires an audiochain node.");
  if (stackComposite === undefined) graphInvalid("The graph requires a stack composite node.");
  const encodeParams = params<EncodeNodeParams>(encode, "encode");
  const encodeVideoInput = encode.inputs[0];
  const encodeAudioInput = encode.inputs[1];
  const output = localPath(
    outputPath ?? `${graph.deliverableId}-${graph.variant}.${encodeParams.container}`,
    "output",
  );
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  const filters: string[] = [];
  const inputIndexBySource = new Map<string, number>();
  const keyMaskInput = new Map<string, number>();
  const overlayInput = new Map<string, number>();
  const pipAssetInput = new Map<string, { mask: number; underlay: number; chrome: number }>();
  let inputCount = 0;

  for (const sourceNode of graph.nodes.filter(({ kind }) => kind === "source")) {
    const source = params<SourceNodeParams>(sourceNode, "source");
    if (isVirtual(source)) continue;
    const trimNode = graph.nodes.find((node) => node.kind === "trim" && node.inputs[0] === sourceNode.id);
    if (trimNode === undefined) graphInvalid(`Source ${sourceNode.id} has no trim consumer.`, [sourceNode.id]);
    const trim = params<TrimNodeParams>(trimNode, "trim");
    if (source.still === true) {
      args.push("-loop", "1", "-framerate", graph.outputFps, "-i", localPath(source.path, "input"));
    } else {
      args.push(
        "-ss",
        "0",
        "-to",
        decimal(seconds(trim.out)),
        "-i",
        localPath(source.path, "input"),
      );
    }
    inputIndexBySource.set(sourceNode.id, inputCount);
    inputCount += 1;
  }

  for (const keyNode of graph.nodes.filter(({ kind }) => kind === "key")) {
    const key = params<KeyNodeParams>(keyNode, "key");
    for (const mask of key.masks ?? []) {
      const mapKey = `${keyNode.id}:${mask.id}`;
      if (mask.animated) {
        args.push("-i", localPath(mask.path, "input"));
      } else {
        args.push("-loop", "1", "-framerate", graph.outputFps, "-i", localPath(mask.path, "input"));
      }
      keyMaskInput.set(mapKey, inputCount);
      inputCount += 1;
    }
  }

  for (const overlayNode of graph.nodes.filter(({ kind }) => kind === "overlay")) {
    const overlay = params<OverlayNodeParams>(overlayNode, "overlay");
    args.push(
      "-framerate",
      graph.outputFps,
      "-start_number",
      "0",
      "-i",
      localPath(overlay.overlayAssetPath, "input"),
    );
    overlayInput.set(overlayNode.id, inputCount);
    inputCount += 1;
  }

  for (const pipNode of graph.nodes.filter(({ kind }) => kind === "pip")) {
    const pip = params<PipNodeParams>(pipNode, "pip");
    if (pip.rasterAssets === undefined) continue;
    const indexes = { mask: inputCount, underlay: inputCount + 1, chrome: inputCount + 2 };
    for (const path of [
      pip.rasterAssets.maskPath,
      pip.rasterAssets.underlayPath,
      pip.rasterAssets.chromePath,
    ]) {
      args.push("-framerate", graph.outputFps, "-start_number", "0", "-i", localPath(path, "input"));
      inputCount += 1;
    }
    pipAssetInput.set(pipNode.id, indexes);
  }

  const labels = new Map<string, string>();
  let outputSampleRate: number | undefined;

  function compiledNodeLabel(node: RenderNode): string {
    if (encodeVideoInput === node.id) return "vout";
    if (encodeAudioInput === node.id) return "aout";
    return nodeLabel(node);
  }

  function durationForNode(nodeId: string): Fraction {
    const node = byId.get(nodeId);
    if (node === undefined) graphInvalid(`Render node ${nodeId} is missing.`, [nodeId]);
    if (node.kind === "trim") return outputDuration(params<TrimNodeParams>(node, "trim"));
    if (node.kind === "composite") {
      const composite = params<CompositeNodeParams>(node, "composite");
      return secondsForFrames(composite.durationFrames ?? 1, graph.outputFps);
    }
    if (node.kind === "timeline-insert") {
      const insertion = params<TimelineInsertNodeParams>(node, "timeline-insert");
      return insertion.stream === "video"
        ? secondsForFrames(insertion.outputDuration, graph.outputFps)
        : fraction(BigInt(insertion.outputDuration), BigInt(outputSampleRate ?? 48_000));
    }
    if (node.inputs.length === 0) graphInvalid(`Node ${node.id} has no duration-bearing input.`, [node.id]);
    return durationForNode(node.inputs[0]!);
  }

  function compiledInput(node: RenderNode, index = 0): string {
    const inputId = node.inputs[index];
    if (inputId === undefined) graphInvalid(`${node.kind} node ${node.id} is missing input ${String(index)}.`, [node.id]);
    const label = labels.get(inputId);
    if (label === undefined) graphInvalid(`Input ${inputId} for ${node.id} is not compiled.`, [node.id, inputId]);
    return label;
  }

  function compileTrim(node: RenderNode): void {
    const trim = params<TrimNodeParams>(node, "trim");
    const sourceNode = byId.get(node.inputs[0]!);
    if (sourceNode === undefined) graphInvalid(`Trim ${node.id} source is missing.`, [node.id]);
    const source = params<SourceNodeParams>(sourceNode, "source");
    const label = compiledNodeLabel(node);
    if (source.stream === "video") {
      const duration = outputDuration(trim);
      if (isVirtual(source)) {
        filters.push(
          `color=c=0x00000000:s=${String(graph.outputSize.w)}x${String(graph.outputSize.h)}` +
          `:r=${graph.outputFps}:d=${decimal(duration)},format=yuva444p,setpts=PTS-STARTPTS[${label}]`,
        );
      } else {
        const inputIndex = inputIndexBySource.get(sourceNode.id);
        if (inputIndex === undefined) graphInvalid(`No FFmpeg input exists for ${sourceNode.id}.`);
        if (!("frames" in trim.in) || !("frames" in trim.out)) {
          graphInvalid(`Video trim ${node.id} must use frame time.`, [node.id]);
        }
        const speed = trim.speed === undefined
          ? "PTS-STARTPTS"
          : `(PTS-STARTPTS)*${String(trim.speed.den)}/${String(trim.speed.num)}`;
        filters.push(
          `[${String(inputIndex)}:v]trim=start_frame=${String(trim.in.frames)}:` +
          `end_frame=${String(trim.out.frames)},setpts=${speed},fps=${graph.outputFps},` +
          `scale=${String(graph.outputSize.w)}:${String(graph.outputSize.h)}:` +
          "force_original_aspect_ratio=decrease:flags=bicubic," +
          `${source.preserveAlpha === true ? "format=yuva444p," : ""}` +
          `pad=${String(graph.outputSize.w)}:${String(graph.outputSize.h)}:` +
          `(ow-iw)/2:(oh-ih)/2:color=${source.preserveAlpha === true ? "0x00000000" : "black"},` +
          "setsar=1" +
          `[${label}]`,
        );
      }
    } else {
      if (!("samples" in trim.in) || !("samples" in trim.out)) {
        graphInvalid(`Audio trim ${node.id} must use sample time.`, [node.id]);
      }
      outputSampleRate ??= trim.in.rate;
      if (isVirtual(source)) {
        filters.push(
          `anullsrc=r=${String(trim.in.rate)}:cl=stereo,` +
          `atrim=start_sample=0:end_sample=${String(trim.out.samples - trim.in.samples)},` +
          `asetpts=PTS-STARTPTS[${label}]`,
        );
      } else {
        const inputIndex = inputIndexBySource.get(sourceNode.id);
        if (inputIndex === undefined) graphInvalid(`No FFmpeg input exists for ${sourceNode.id}.`);
        const speedFilters = trim.speed === undefined ? [] : atempoFilters(trim.speed);
        filters.push(
          `[${String(inputIndex)}:a]atrim=start_sample=${String(trim.in.samples)}:` +
          `end_sample=${String(trim.out.samples)},asetpts=PTS-STARTPTS` +
          `${speedFilters.length === 0 ? "" : `,${speedFilters.join(",")}`},` +
          `aresample=${String(trim.in.rate)},aformat=sample_fmts=fltp:` +
          `channel_layouts=stereo[${label}]`,
        );
      }
    }
    labels.set(node.id, label);
  }

  function compileTransform(node: RenderNode): void {
    const transform = params<TransformNodeParams>(node, "transform");
    const keyframes = [...transform.keyframes].sort((a, b) => a.atOutputFrame - b.atOutputFrame);
    if (keyframes.length === 0 || keyframes[0]!.atOutputFrame !== 0) {
      graphInvalid(`Transform ${node.id} must begin at output frame 0.`, [node.id]);
    }
    for (let index = 1; index < keyframes.length; index += 1) {
      if (keyframes[index]!.atOutputFrame === keyframes[index - 1]!.atOutputFrame) {
        graphInvalid(`Transform ${node.id} has duplicate output frames.`, [node.id]);
      }
    }
    const keyframe = keyframes[0]!;
    const animated = keyframes.length > 1;
    function curve(accessor: (frame: typeof keyframe) => number | undefined, fallback: number): string {
      let held = fallback;
      const points = keyframes.map((frame) => {
        held = accessor(frame) ?? held;
        return { frame: frame.atOutputFrame, value: held };
      });
      if (points.length === 1) return numberText(points[0]!.value);
      let expression = numberText(points.at(-1)!.value);
      for (let index = points.length - 2; index >= 0; index -= 1) {
        const from = points[index]!;
        const to = points[index + 1]!;
        const slope = `(${numberText(to.value)}-${numberText(from.value)})*` +
          `(n-${String(from.frame)})/${String(to.frame - from.frame)}`;
        expression = `if(lt(n,${String(to.frame)}),${numberText(from.value)}+${slope},${expression})`;
      }
      return expression;
    }
    const input = compiledInput(node);
    const label = compiledNodeLabel(node);
    const body = `${label}body`;
    const stages: string[] = [];
    if (keyframes.some(({ crop }) => crop !== undefined)) {
      const x = curve((frame) => frame.crop?.[0], 0);
      const y = curve((frame) => frame.crop?.[1], 0);
      const width = curve((frame) => frame.crop?.[2], 1);
      const height = curve((frame) => frame.crop?.[3], 1);
      stages.push(
        `crop=w='iw*${width}':h='ih*${height}':x='iw*${x}':y='ih*${y}'`,
      );
    }
    if (keyframes.some(({ scale }) => scale !== undefined)) {
      const scaleX = curve((frame) => Array.isArray(frame.scale) ? frame.scale[0] : frame.scale, 1);
      const scaleY = curve((frame) => Array.isArray(frame.scale) ? frame.scale[1] : frame.scale, 1);
      stages.push(
        `scale=w='iw*${scaleX}':h='ih*${scaleY}':flags=bicubic${animated ? ":eval=frame" : ""}`,
      );
    }
    if (keyframes.some(({ rotateDeg }) => rotateDeg !== undefined && rotateDeg !== 0)) {
      stages.push(
        `rotate='${curve((frame) => frame.rotateDeg, 0)}*PI/180':` +
        "ow=rotw(iw):oh=roth(ih):c=none",
      );
    }
    stages.push("format=yuva444p");
    if (keyframes.some(({ opacity }) => opacity !== undefined && opacity !== 1)) {
      const opacity = curve((frame) => frame.opacity, 1);
      stages.push(animated
        ? `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${opacity}'`
        : `colorchannelmixer=aa=${opacity}`);
    }
    filters.push(`${inputLabel(input)}${stages.join(",")}[${body}]`);
    const duration = durationForNode(node.inputs[0]!);
    const positionX = curve((frame) => frame.pos?.[0], 0.5);
    const positionY = curve((frame) => frame.pos?.[1], 0.5);
    const anchorX = curve((frame) => frame.anchor?.[0], 0.5);
    const anchorY = curve((frame) => frame.anchor?.[1], 0.5);
    const base = `${label}base`;
    filters.push(
      `color=c=0x00000000:s=${String(graph.outputSize.w)}x${String(graph.outputSize.h)}` +
      `:r=${graph.outputFps}:d=${decimal(duration)},format=yuva444p[${base}]`,
    );
    const x = `${positionX}*main_w-${anchorX}*overlay_w`;
    const y = `${positionY}*main_h-${anchorY}*overlay_h`;
    if (transform.framingDecisionId === undefined) {
      filters.push(
        `[${base}][${body}]overlay=x='${x}':y='${y}':eof_action=pass:shortest=0[${label}]`,
      );
    } else {
      const visual = `${label}visual`;
      const alphaSource = `${label}alphasource`;
      const alpha = `${label}alpha`;
      const placedVisual = `${label}placedvisual`;
      const alphaBase = `${label}alphabase`;
      const placedAlpha = `${label}placedalpha`;
      filters.push(`[${body}]split[${visual}][${alphaSource}]`);
      filters.push(`[${alphaSource}]alphaextract[${alpha}]`);
      filters.push(
        `[${base}][${visual}]overlay=x='${x}':y='${y}':` +
        `eof_action=pass:shortest=0:format=auto[${placedVisual}]`,
      );
      filters.push(
        `color=c=black:s=${String(graph.outputSize.w)}x${String(graph.outputSize.h)}` +
        `:r=${graph.outputFps}:d=${decimal(duration)},format=gray[${alphaBase}]`,
      );
      filters.push(
        `[${alphaBase}][${alpha}]overlay=x='${x}':y='${y}':` +
        `eof_action=pass:shortest=0:format=auto,format=gray[${placedAlpha}]`,
      );
      filters.push(`[${placedVisual}][${placedAlpha}]alphamerge[${label}]`);
    }
    labels.set(node.id, label);
  }

  function compileColor(node: RenderNode): void {
    const color = params<ColorNodeParams>(node, "color");
    const input = compiledInput(node);
    const label = compiledNodeLabel(node);
    const correction = color.correction;
    const brightness = Math.max(-1, Math.min(1, (2 ** correction.exposure - 1) / 2));
    const stages = [
      `eq=contrast=${numberText(correction.contrast)}:` +
      `brightness=${numberText(brightness)}:saturation=${numberText(correction.saturation)}`,
    ];
    if (correction.tint !== undefined && correction.tint !== 0) {
      stages.push(
        `colorbalance=rm=${numberText(correction.tint / 2)}:` +
        `gm=${numberText(-correction.tint)}:bm=${numberText(correction.tint / 2)}`,
      );
    }
    if (correction.temperatureK !== undefined) {
      stages.push(`colortemperature=temperature=${numberText(correction.temperatureK)}`);
    }
    filters.push(`${inputLabel(input)}${stages.join(",")}[${label}]`);
    labels.set(node.id, label);
  }

  function ffmpegColor(value: string): string {
    return value.startsWith("#") ? `0x${value.slice(1)}` : value;
  }

  function compilePip(node: RenderNode): void {
    const pip = params<PipNodeParams>(node, "pip");
    const input = compiledInput(node);
    const label = compiledNodeLabel(node);
    const raster = pipAssetInput.get(node.id);
    if (raster !== undefined) {
      const visual = `${label}visual`;
      const alpha = `${label}alpha`;
      const mask = `${label}mask`;
      const maskedAlpha = `${label}maskedalpha`;
      const masked = `${label}masked`;
      const underlay = `${label}underlay`;
      const chrome = `${label}chrome`;
      const assembled = `${label}assembled`;
      filters.push(`${inputLabel(input)}format=rgba,split[${visual}][${alpha}source]`);
      filters.push(`[${alpha}source]alphaextract[${alpha}]`);
      filters.push(`[${String(raster.mask)}:v]format=gray[${mask}]`);
      filters.push(`[${alpha}][${mask}]blend=all_mode=multiply[${maskedAlpha}]`);
      filters.push(`[${visual}][${maskedAlpha}]alphamerge[${masked}]`);
      filters.push(`[${String(raster.underlay)}:v]format=rgba[${underlay}]`);
      filters.push(`[${String(raster.chrome)}:v]format=rgba[${chrome}]`);
      filters.push(`[${underlay}][${masked}]overlay=format=auto:eof_action=pass[${assembled}]`);
      filters.push(`[${assembled}][${chrome}]overlay=format=auto:eof_action=pass[${label}]`);
      labels.set(node.id, label);
      return;
    }
    const masked = `${label}masked`;
    const stages = ["format=yuva444p"];
    const { mask } = pip.style;
    let pipInput = inputLabel(input);
    if (pip.style.background?.color !== undefined) {
      const foreground = `${label}backgroundfg`;
      const background = `${label}background`;
      const combined = `${label}backgroundcombined`;
      filters.push(`${pipInput}format=yuva444p[${foreground}]`);
      filters.push(
        `color=c=${ffmpegColor(pip.style.background.color)}:` +
        `s=${String(graph.outputSize.w)}x${String(graph.outputSize.h)}:` +
        `r=${graph.outputFps}:d=${decimal(durationForNode(node.inputs[0]!))}[${background}]`,
      );
      filters.push(`[${background}][${foreground}]overlay=format=auto[${combined}]`);
      pipInput = `[${combined}]`;
    }
    if ((pip.style.background?.padPx ?? 0) > 0) {
      const pad = pip.style.background?.padPx ?? 0;
      stages.push(
        `pad=w=iw+${numberText(pad * 2)}:h=ih+${numberText(pad * 2)}:` +
        `x=${numberText(pad)}:y=${numberText(pad)}:color=0x00000000`,
      );
    }
    if (mask.shape === "circle") {
      stages.push(
        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':" +
        "a='alpha(X,Y)*lte(hypot(X-W/2,Y-H/2),min(W,H)/2)'",
      );
    } else if (mask.shape === "ellipse") {
      stages.push(
        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':" +
        "a='alpha(X,Y)*lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1)'",
      );
    } else if (mask.shape === "rounded") {
      const radius = numberText(mask.cornerRadius ?? 0.08);
      stages.push(
        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*" +
        `if(lte(abs(X-W/2),W/2-min(W,H)*${radius}),1,` +
        `if(lte(abs(Y-H/2),H/2-min(W,H)*${radius}),1,` +
        `lte(hypot(abs(X-W/2)-(W/2-min(W,H)*${radius}),` +
        `abs(Y-H/2)-(H/2-min(W,H)*${radius})),min(W,H)*${radius})))'`,
      );
    }
    if ((mask.featherPx ?? 0) > 0) {
      stages.push(`gblur=sigma=${numberText(mask.featherPx ?? 0)}:steps=1`);
    }
    if (pip.style.background?.blurSigma !== undefined) {
      stages.unshift(`gblur=sigma=${numberText(pip.style.background.blurSigma)}:steps=1`);
    }
    if (pip.style.border !== undefined && pip.style.border.widthPx > 0) {
      stages.push(
        `drawbox=x=0:y=0:w=iw:h=ih:color=${ffmpegColor(pip.style.border.color)}` +
        `@${numberText(pip.style.border.opacity)}:t=${numberText(pip.style.border.widthPx)}`,
      );
    }
    if (pip.style.deviceFrame !== undefined) {
      stages.push("drawbox=x=0:y=0:w=iw:h=ih:color=0x20242A@1:t=12");
    }
    filters.push(`${pipInput}${stages.join(",")}[${masked}]`);
    if (pip.style.shadow === undefined || pip.style.shadow.opacity <= 0) {
      filters.push(`[${masked}]null[${label}]`);
    } else {
      const shadow = pip.style.shadow;
      const foreground = `${label}fg`;
      const shadowLayer = `${label}shadow`;
      filters.push(`[${masked}]split[${foreground}][${shadowLayer}source]`);
      filters.push(
        `[${shadowLayer}source]gblur=sigma=${numberText(shadow.blurPx)}:steps=2,` +
        `colorchannelmixer=rr=0:gg=0:bb=0:aa=${numberText(shadow.opacity)}[${shadowLayer}]`,
      );
      filters.push(
        `[${shadowLayer}][${foreground}]overlay=x=${numberText(-shadow.dx)}:` +
        `y=${numberText(-shadow.dy)}:format=auto[${label}]`,
      );
    }
    labels.set(node.id, label);
  }

  function compileAlphaMatte(node: RenderNode, key: KeyNodeParams): void {
    const visual = compiledInput(node);
    const matte = compiledInput(node, 1);
    const label = compiledNodeLabel(node);
    const alpha = `${label}alpha`;
    const alphaFilter = key.matteSource === "alpha" ? "alphaextract" : "format=gray";
    filters.push(
      `${inputLabel(matte)}${alphaFilter}${key.invertMatte === true ? ",negate" : ""}[${alpha}]`,
    );
    filters.push(`${inputLabel(visual)}format=yuva444p[${label}visual]`);
    filters.push(`[${label}visual][${alpha}]alphamerge[${label}]`);
    labels.set(node.id, label);
  }

  function compileChromaKey(node: RenderNode, key: KeyNodeParams): void {
    const input = compiledInput(node);
    const label = compiledNodeLabel(node);
    const sharp = `${label}sharp`;
    const branch = `${label}kb`;
    let alpha = `${label}a0`;
    const tolerance = key.tolerance ?? 0;
    const softness = key.edgeSoftness ?? 0;
    const similarity = 0.01 + 0.39 * tolerance;
    const blend = 0.4 * softness;
    filters.push(`${inputLabel(input)}split=2[${sharp}][${branch}]`);
    const keyStages = ["format=yuva444p"];
    if ((key.preBlur ?? 0) > 0) {
      keyStages.push(`gblur=sigma=${numberText(key.preBlur!)}:planes=0x6`);
    }
    keyStages.push(
      `chromakey=color=0x${(key.keyColor ?? "#00FF00").slice(1).toUpperCase()}:` +
      `similarity=${numberText(similarity)}:blend=${numberText(blend)}`,
      "alphaextract",
    );
    filters.push(`[${branch}]${keyStages.join(",")}[${alpha}]`);
    const refinement: string[] = [];
    for (let index = 0; index < (key.edge?.erodePx ?? 0); index += 1) refinement.push("erosion");
    if ((key.edge?.featherPx ?? 0) > 0) {
      refinement.push(`gblur=sigma=${numberText(0.5 * key.edge!.featherPx)}`);
    }
    if (refinement.length > 0) {
      const refined = `${label}a1`;
      filters.push(`[${alpha}]${refinement.join(",")}[${refined}]`);
      alpha = refined;
    }
    for (const [index, mask] of (key.masks ?? []).entries()) {
      const inputIndex = keyMaskInput.get(`${node.id}:${mask.id}`);
      if (inputIndex === undefined) graphInvalid(`Mask input ${mask.id} is missing.`, [node.id, mask.id]);
      const maskLabel = `${label}m${String(index)}`;
      const nextAlpha = `${label}am${String(index)}`;
      filters.push(`[${String(inputIndex)}:v]format=gray[${maskLabel}]`);
      filters.push(
        `[${alpha}][${maskLabel}]blend=all_mode=${mask.role === "garbage" ? "multiply" : "lighten"}` +
        `[${nextAlpha}]`,
      );
      alpha = nextAlpha;
    }
    filters.push(`[${sharp}]format=yuva444p[${label}s0]`);
    let current = `${label}f0`;
    filters.push(`[${label}s0][${alpha}]alphamerge[${current}]`);
    const spill = key.spill;
    if (spill !== undefined && spill.mode === "despill") {
      const next = `${label}f1`;
      filters.push(
        `[${current}]despill=type=${spill.channel ?? "green"}:mix=${numberText(spill.strength)}:` +
        `expand=${numberText(0.5 * spill.strength)}[${next}]`,
      );
      current = next;
    } else if (spill !== undefined && spill.mode === "average") {
      const next = `${label}f1`;
      const strength = numberText(spill.strength);
      const channel = dominantGeqChannel(key.keyColor ?? "#00FF00");
      filters.push(`[${current}]${averageGeq(channel, strength)}[${next}]`);
      current = next;
    }
    if (key.postColor !== undefined) {
      const next = `${label}color`;
      const brightness = Math.max(-1, Math.min(1, 2 ** key.postColor.exposure - 1));
      const stages = [
        `eq=contrast=${numberText(key.postColor.contrast)}:` +
        `brightness=${numberText(brightness)}:saturation=${numberText(key.postColor.saturation)}`,
      ];
      if (key.postColor.temperatureK !== undefined) {
        stages.push(`colortemperature=temperature=${numberText(key.postColor.temperatureK)}`);
      }
      filters.push(`[${current}]${stages.join(",")}[${next}]`);
      current = next;
    }
    if (current !== label) filters.push(`[${current}]null[${label}]`);
    labels.set(node.id, label);
  }

  function compileKey(node: RenderNode): void {
    const key = params<KeyNodeParams>(node, "key");
    if (key.method === "alphaMatte") compileAlphaMatte(node, key);
    else if (key.method === "chroma") compileChromaKey(node, key);
    else unsupported(`neural matte node ${node.id}`, [node.id]);
  }

  function compileSequential(node: RenderNode, composite: CompositeNodeParams): void {
    const settings: NonNullable<CompositeNodeParams["inputSettings"]> =
      composite.inputSettings ?? node.inputs.map(() => ({ durationFrames: 1 }));
    const inputLabels = node.inputs.map((_, index) => compiledInput(node, index));
    const label = compiledNodeLabel(node);
    if (inputLabels.length === 0) {
      filters.push(
        `color=c=0x00000000:s=${String(composite.canvas.w)}x${String(composite.canvas.h)}` +
        `:r=${graph.outputFps}:d=${decimal(secondsForFrames(composite.durationFrames ?? 1, graph.outputFps))},` +
        `format=yuva444p[${label}]`,
      );
    } else if (settings.every(({ transitionFromPreviousFrames }) =>
      (transitionFromPreviousFrames ?? 0) === 0)) {
      filters.push(
        `${inputLabels.map(inputLabel).join("")}concat=n=${String(inputLabels.length)}:v=1:a=0[${label}]`,
      );
    } else {
      let current = inputLabels[0]!;
      let elapsedFrames = settings[0]!.durationFrames;
      for (let index = 1; index < inputLabels.length; index += 1) {
        const transitionFrames = settings[index]!.transitionFromPreviousFrames ?? 0;
        const next = index === inputLabels.length - 1 ? label : `${label}x${String(index)}`;
        if (transitionFrames > 0) {
          const offsetFrames = elapsedFrames - transitionFrames;
          filters.push(
            `${inputLabel(current)}${inputLabel(inputLabels[index]!)}xfade=transition=fade:` +
            `duration=${decimal(secondsForFrames(transitionFrames, graph.outputFps))}:` +
            `offset=${decimal(secondsForFrames(offsetFrames, graph.outputFps))}[${next}]`,
          );
          elapsedFrames += settings[index]!.durationFrames - transitionFrames;
        } else {
          filters.push(`${inputLabel(current)}${inputLabel(inputLabels[index]!)}concat=n=2:v=1:a=0[${next}]`);
          elapsedFrames += settings[index]!.durationFrames;
        }
        current = next;
      }
    }
    labels.set(node.id, label);
  }

  function compileAnchored(node: RenderNode, composite: CompositeNodeParams): void {
    const durationFrames = composite.durationFrames ?? 1;
    const duration = secondsForFrames(durationFrames, graph.outputFps);
    const label = compiledNodeLabel(node);
    if (node.inputs.length === 1) {
      const setting = composite.inputSettings?.[0];
      const start = setting?.atOutputFrame ?? 0;
      const itemDuration = setting?.durationFrames ?? 1;
      if (start < 0 || itemDuration < 1 || start >= durationFrames) {
        graphInvalid(`Anchored composite ${node.id} has an invalid exact frame span.`, [node.id]);
      }
      const stop = Math.max(0, durationFrames - start - itemDuration);
      filters.push(
        `${inputLabel(compiledInput(node))}setpts=PTS-STARTPTS,` +
        `tpad=start=${String(start)}:stop=${String(stop)}:color=black@0,` +
        `trim=start_frame=0:end_frame=${String(durationFrames)},setpts=PTS-STARTPTS[${label}]`,
      );
      labels.set(node.id, label);
      return;
    }
    let current = `${label}base`;
    filters.push(
      `color=c=0x00000000:s=${String(composite.canvas.w)}x${String(composite.canvas.h)}` +
      `:r=${graph.outputFps}:d=${decimal(duration)},format=yuva444p[${current}]`,
    );
    for (const [index] of node.inputs.entries()) {
      const setting = composite.inputSettings?.[index];
      const start = setting?.atOutputFrame ?? 0;
      const end = start + (setting?.durationFrames ?? 1) - 1;
      const shifted = `${label}i${String(index)}`;
      const next = index === node.inputs.length - 1 ? label : `${label}o${String(index)}`;
      filters.push(
        `${inputLabel(compiledInput(node, index))}setpts=PTS-STARTPTS+` +
        `${decimal(secondsForFrames(start, graph.outputFps))}/TB[${shifted}]`,
      );
      filters.push(
        `[${current}][${shifted}]overlay=enable='between(n,${String(start)},${String(end)})':` +
        `eof_action=pass:shortest=0:format=auto[${next}]`,
      );
      current = next;
    }
    if (node.inputs.length === 0) filters.push(`[${current}]null[${label}]`);
    labels.set(node.id, label);
  }

  function checkerboardSource(composite: CompositeNodeParams, label: string): void {
    const duration = decimal(secondsForFrames(composite.durationFrames ?? 1, graph.outputFps));
    filters.push(
      `nullsrc=s=${String(composite.canvas.w)}x${String(composite.canvas.h)}:` +
      `r=${graph.outputFps}:d=${duration},format=rgba,` +
      "geq=r='if(eq(mod(floor(X/32)+floor(Y/32),2),0),102,153)':" +
      "g='if(eq(mod(floor(X/32)+floor(Y/32),2),0),102,153)':" +
      "b='if(eq(mod(floor(X/32)+floor(Y/32),2),0),102,153)':a=255" +
      `[${label}]`,
    );
  }

  function compileStack(node: RenderNode, composite: CompositeNodeParams): void {
    const label = compiledNodeLabel(node);
    let current = `${label}base`;
    if (composite.canvas.background === "checkerboard") checkerboardSource(composite, current);
    else {
      filters.push(
        `color=c=${composite.canvas.background}:s=${String(composite.canvas.w)}x${String(composite.canvas.h)}` +
        `:r=${graph.outputFps}:d=${decimal(secondsForFrames(composite.durationFrames ?? 1, graph.outputFps))},` +
        `format=yuva444p[${current}]`,
      );
    }
    for (const [index] of node.inputs.entries()) {
      const setting = composite.inputSettings?.[index];
      const blend = setting?.blend ?? "normal";
      const opacity = setting?.opacity ?? 1;
      let layer = compiledInput(node, index);
      if (blend === "normal" && opacity !== 1) {
        const opacityLabel = `${label}op${String(index)}`;
        filters.push(`${inputLabel(layer)}format=yuva444p,colorchannelmixer=aa=${numberText(opacity)}[${opacityLabel}]`);
        layer = opacityLabel;
      }
      const next = index === node.inputs.length - 1 ? label : `${label}o${String(index)}`;
      if (blend === "normal") {
        filters.push(
          `[${current}]${inputLabel(layer)}overlay=eof_action=pass:shortest=0[${next}]`,
        );
      } else {
        filters.push(
          `[${current}]${inputLabel(layer)}blend=all_mode=${blend}:all_opacity=${numberText(opacity)}[${next}]`,
        );
      }
      current = next;
    }
    if (node.inputs.length === 0) filters.push(`[${current}]null[${label}]`);
    labels.set(node.id, label);
  }

  function compileComposite(node: RenderNode): void {
    const composite = params<CompositeNodeParams>(node, "composite");
    if (composite.mode === "timeline.anchored") compileAnchored(node, composite);
    else if (composite.mode === "stack") compileStack(node, composite);
    else compileSequential(node, composite);
  }

  function compileOverlay(node: RenderNode): void {
    const overlay = params<OverlayNodeParams>(node, "overlay");
    const inputIndex = overlayInput.get(node.id);
    if (inputIndex === undefined) graphInvalid(`Overlay input for ${node.id} is missing.`, [node.id]);
    const label = compiledNodeLabel(node);
    const overlayLabel = `${label}asset`;
    const offset = secondsForFrames(overlay.atOutputFrame, graph.outputFps);
    filters.push(`[${String(inputIndex)}:v]format=rgba,setpts=PTS-STARTPTS+${decimal(offset)}/TB[${overlayLabel}]`);
    filters.push(
      `${inputLabel(compiledInput(node))}[${overlayLabel}]overlay=enable='between(n,` +
      `${String(overlay.atOutputFrame)},${String(overlay.atOutputFrame + overlay.durationFrames - 1)})':` +
      `eof_action=pass:shortest=0[${label}]`,
    );
    labels.set(node.id, label);
  }

  function compileTimelineInsert(node: RenderNode): void {
    const insertion = params<TimelineInsertNodeParams>(node, "timeline-insert");
    const input = compiledInput(node);
    const label = compiledNodeLabel(node);
    const segmentLabels = insertion.insertions.map((_, index) => `${label}s${String(index)}`);
    segmentLabels.push(`${label}s${String(insertion.insertions.length)}`);
    const split = insertion.stream === "video" ? "split" : "asplit";
    filters.push(
      `${inputLabel(input)}${split}=${String(segmentLabels.length)}` +
      segmentLabels.map(inputLabel).join(""),
    );
    const outputs: string[] = [];
    let start = 0;
    for (const [index, entry] of insertion.insertions.entries()) {
      const segment = `${label}t${String(index)}`;
      const gap = `${label}g${String(index)}`;
      if (insertion.stream === "video") {
        filters.push(
          `[${segmentLabels[index]}]trim=start_frame=${String(start)}:end_frame=${String(entry.at)},` +
          `setpts=PTS-STARTPTS[${segment}]`,
        );
        filters.push(
          `color=c=0x00000000:s=${String(graph.outputSize.w)}x${String(graph.outputSize.h)}` +
          `:r=${graph.outputFps}:d=${decimal(secondsForFrames(entry.duration, graph.outputFps))},` +
          `format=yuva444p[${gap}]`,
        );
      } else {
        filters.push(
          `[${segmentLabels[index]}]atrim=start_sample=${String(start)}:end_sample=${String(entry.at)},` +
          `asetpts=PTS-STARTPTS[${segment}]`,
        );
        filters.push(
          `anullsrc=r=${String(outputSampleRate ?? 48_000)}:cl=stereo,` +
          `atrim=start_sample=0:end_sample=${String(entry.duration)},` +
          `asetpts=PTS-STARTPTS[${gap}]`,
        );
      }
      outputs.push(segment, gap);
      start = entry.at;
    }
    const tail = `${label}t${String(insertion.insertions.length)}`;
    if (insertion.stream === "video") {
      filters.push(
        `[${segmentLabels.at(-1)!}]trim=start_frame=${String(start)}:` +
        `end_frame=${String(insertion.sourceDuration)},setpts=PTS-STARTPTS[${tail}]`,
      );
    } else {
      filters.push(
        `[${segmentLabels.at(-1)!}]atrim=start_sample=${String(start)}:` +
        `end_sample=${String(insertion.sourceDuration)},asetpts=PTS-STARTPTS[${tail}]`,
      );
    }
    outputs.push(tail);
    filters.push(
      `${outputs.map(inputLabel).join("")}concat=n=${String(outputs.length)}:` +
      `${insertion.stream === "video" ? "v=1:a=0" : "v=0:a=1"}[${label}]`,
    );
    labels.set(node.id, label);
  }

  function audioStageFilters(stages: readonly AudioStage[]): string[] {
    return stages.flatMap((stage) => {
      const value = stage.params;
      switch (stage.stage) {
        case "gain":
          return `volume=${numberText(value["gainDb"] as number)}dB`;
        case "fade":
          return `afade=t=${value["direction"] === "out" ? "out" : "in"}:` +
            `ss=${String(value["startSample"] as number)}:` +
            `ns=${String(value["durationSamples"] as number)}:` +
            `curve=${String(value["curve"] === "linear" ? "tri" : value["curve"] ?? "tri")}`;
        case "channelmap": {
          const mapping = String(value["mapping"]);
          if (mapping === "left") {
            return "channelmap=map=FL-FL|FL-FR:channel_layout=stereo";
          }
          if (mapping === "right") {
            return "channelmap=map=FR-FL|FR-FR:channel_layout=stereo";
          }
          if (mapping === "mix") return "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1";
          const channels = mapping.split(",").map((channel) => Number(channel));
          return `channelmap=map=${channels.map((channel, index) =>
            `${String(channel)}-${String(index)}`).join("|")}:channel_layout=stereo`;
        }
        case "denoise":
          return "arnndn=m='guyditor-rnnoise.rnnn':" +
            `mix=${numberText(Math.min(1, (value["strengthDb"] as number) / 30))}`;
        case "eq":
          return `equalizer=f=${numberText(value["frequencyHz"] as number)}:` +
            `t=q:w=${numberText(value["q"] as number)}:` +
            `g=${numberText(value["gainDb"] as number)}`;
        case "compress":
          return `acompressor=threshold=${numberText(value["thresholdDb"] as number)}dB:` +
            `ratio=${numberText(value["ratio"] as number)}:` +
            `attack=${numberText(value["attackMs"] as number)}:` +
            `release=${numberText(value["releaseMs"] as number)}:` +
            `makeup=${numberText(value["makeupDb"] as number)}dB`;
        case "limit":
          return `alimiter=limit=${numberText(10 ** ((value["ceilingDb"] as number) / 20))}:level=false`;
        case "duck":
          return duckVolumeFilter(String(value["envelope"]), value["sampleRate"] as number);
        case "loudnorm":
          // The master loudness marker is intentionally lowered by RenderService
          // after this post-chain mix has been rendered and measured in pass one.
          return [];
      }
    });
  }

  function duckVolumeFilter(serialized: string, rate: number): string {
    const points = serialized.length === 0
      ? []
      : serialized.split(",").map((entry) => {
          const [sample, gain] = entry.split(":");
          return { sample: Number(sample), gain: Number(gain) };
        });
    if (points.length === 0) return "volume=0dB";
    let expressionText = numberText(points.at(-1)!.gain);
    for (let index = points.length - 2; index >= 0; index -= 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const fromSeconds = decimal(fraction(BigInt(from.sample), BigInt(rate)));
      const durationSeconds = decimal(fraction(BigInt(to.sample - from.sample), BigInt(rate)));
      const segment = to.sample === from.sample
        ? numberText(to.gain)
        : `${numberText(from.gain)}+((${numberText(to.gain)})-(${numberText(from.gain)}))*` +
          `(t-${fromSeconds})/${durationSeconds}`;
      expressionText = `if(lt(t,${decimal(fraction(BigInt(to.sample), BigInt(rate)))}),` +
        `${segment},${expressionText})`;
    }
    return `volume='pow(10,(${expressionText})/20)':eval=frame`;
  }

  function compileAudiochain(node: RenderNode): void {
    const audio = params<AudioChainNodeParams>(node, "audiochain");
    const rawInputs = node.inputs.map((_, index) => compiledInput(node, index));
    const label = compiledNodeLabel(node);
    if (rawInputs.length === 0) graphInvalid("An audiochain needs at least one input.", [node.id]);
    const settings = audio.inputSettings;
    const inputs = rawInputs.map((raw, index) => {
      const setting = settings?.[index];
      if (setting === undefined) graphInvalid(`Audio input ${String(index)} has no settings.`, [node.id]);
      let current = raw;
      const inputStages: string[] = [];
      if ((setting.offsetSamples ?? 0) > 0) {
        inputStages.push(
          `adelay=delays=${String(setting.offsetSamples)}S:all=1`,
          `atrim=end_sample=${String(setting.durationSamples)}`,
        );
      } else if ((setting.offsetSamples ?? 0) < 0) {
        inputStages.push(
          `atrim=start_sample=${String(-setting.offsetSamples!)}`,
          "asetpts=PTS-STARTPTS",
          "apad",
          `atrim=end_sample=${String(setting.durationSamples)}`,
        );
      }
      inputStages.push(...audioStageFilters(setting.stages));
      if (inputStages.length > 0) {
        const processed = `${label}i${String(index)}`;
        filters.push(`${inputLabel(current)}${inputStages.join(",")}[${processed}]`);
        current = processed;
      }
      if (setting.loop === true) {
        const loopDuration = setting.loopDurationSamples ?? setting.durationSamples;
        const crossfade = setting.loopCrossfadeSamples ?? 0;
        if (crossfade > 0 && crossfade < setting.durationSamples) {
          const bodyInput = `${label}lb${String(index)}`;
          const tailInput = `${label}lt${String(index)}`;
          const headInput = `${label}lh${String(index)}`;
          const body = `${label}lbo${String(index)}`;
          const tail = `${label}lto${String(index)}`;
          const head = `${label}lho${String(index)}`;
          const seam = `${label}ls${String(index)}`;
          const cycle = `${label}lc${String(index)}`;
          const looped = `${label}lo${String(index)}`;
          filters.push(`${inputLabel(current)}asplit=3[${bodyInput}][${tailInput}][${headInput}]`);
          filters.push(`[${bodyInput}]atrim=end_sample=${String(setting.durationSamples - crossfade)},asetpts=PTS-STARTPTS[${body}]`);
          filters.push(`[${tailInput}]atrim=start_sample=${String(setting.durationSamples - crossfade)},asetpts=PTS-STARTPTS[${tail}]`);
          filters.push(`[${headInput}]atrim=end_sample=${String(crossfade)},asetpts=PTS-STARTPTS[${head}]`);
          filters.push(`[${tail}][${head}]acrossfade=d=${decimal(fraction(BigInt(crossfade), BigInt(outputSampleRate ?? 48_000)))}:c1=tri:c2=tri[${seam}]`);
          filters.push(`[${body}][${seam}]concat=n=2:v=0:a=1[${cycle}]`);
          filters.push(`[${cycle}]aloop=loop=-1:size=${String(setting.durationSamples)},atrim=end_sample=${String(loopDuration)}[${looped}]`);
          current = looped;
        } else {
          const looped = `${label}lo${String(index)}`;
          filters.push(`${inputLabel(current)}aloop=loop=-1:size=${String(setting.durationSamples)},atrim=end_sample=${String(loopDuration)}[${looped}]`);
          current = looped;
        }
      }
      if ((audio.mode === "anchored" || audio.mode === "mix") && (setting.atOutputSample ?? 0) > 0) {
        const delayed = `${label}d${String(index)}`;
        filters.push(
          `${inputLabel(current)}adelay=delays=${String(setting.atOutputSample)}S:all=1[${delayed}]`,
        );
        current = delayed;
      }
      return current;
    });
    let mixed: string;
    if (audio.mode === "mix" || audio.mode === "anchored") {
      mixed = audio.stages.length === 0 ? label : `${label}mix`;
      filters.push(
        `${inputs.map(inputLabel).join("")}amix=inputs=${String(inputs.length)}:` +
        `duration=longest:normalize=0,atrim=end_sample=${String(audio.durationSamples ?? 1)}[${mixed}]`,
      );
    } else if (settings === undefined || settings.every(({ transitionFromPreviousSamples }) =>
      (transitionFromPreviousSamples ?? 0) === 0)) {
      mixed = audio.stages.length === 0 ? label : `${label}mix`;
      filters.push(`${inputs.map(inputLabel).join("")}concat=n=${String(inputs.length)}:v=0:a=1[${mixed}]`);
    } else {
      let current = inputs[0]!;
      for (let index = 1; index < inputs.length; index += 1) {
        const transitionSamples = settings[index]?.transitionFromPreviousSamples ?? 0;
        const finalMix = audio.stages.length === 0 ? label : `${label}mix`;
        const next = index === inputs.length - 1 ? finalMix : `${label}x${String(index)}`;
        if (transitionSamples > 0) {
          filters.push(
            `${inputLabel(current)}${inputLabel(inputs[index]!)}acrossfade=` +
            `d=${decimal(fraction(BigInt(transitionSamples), BigInt(outputSampleRate ?? 48_000)))}:` +
            `c1=tri:c2=tri[${next}]`,
          );
        } else {
          filters.push(`${inputLabel(current)}${inputLabel(inputs[index]!)}concat=n=2:v=0:a=1[${next}]`);
        }
        current = next;
      }
      mixed = current;
    }
    const postStages = audioStageFilters(audio.stages);
    if (postStages.length > 0) {
      filters.push(`${inputLabel(mixed)}${postStages.join(",")}[${label}]`);
      labels.set(node.id, label);
    } else {
      labels.set(node.id, mixed);
    }
  }

  for (const node of graph.nodes) {
    switch (node.kind) {
      case "source": break;
      case "trim": compileTrim(node); break;
      case "transform": compileTransform(node); break;
      case "color": compileColor(node); break;
      case "pip": compilePip(node); break;
      case "key": compileKey(node); break;
      case "composite": compileComposite(node); break;
      case "timeline-insert": compileTimelineInsert(node); break;
      case "overlay": compileOverlay(node); break;
      case "audiochain": compileAudiochain(node); break;
      case "encode": break;
    }
  }

  const visualLabel = labels.get(encode.inputs[0]!);
  const audioLabel = labels.get(encode.inputs[1]!);
  if (visualLabel === undefined || audioLabel === undefined) {
    graphInvalid("Encode inputs were not compiled.", encode.inputs);
  }
  const stack = params<CompositeNodeParams>(stackComposite, "composite");
  const expectedDurationFrames = stack.durationFrames ?? 1;
  const totalDuration = secondsForFrames(expectedDurationFrames, graph.outputFps);
  const codecArgs = Object.entries(encodeParams.vcodecParams)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => [`-${key}`, String(value)]);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    inputLabel(visualLabel),
    "-map",
    inputLabel(audioLabel),
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
    filterComplex: filters.join(";"),
  };
}

function dominantGeqChannel(color: string): "r" | "g" | "b" {
  const values = {
    r: Number.parseInt(color.slice(1, 3), 16),
    g: Number.parseInt(color.slice(3, 5), 16),
    b: Number.parseInt(color.slice(5, 7), 16),
  };
  return Object.entries(values).sort((left, right) => right[1] - left[1])[0]![0] as "r" | "g" | "b";
}

function averageGeq(channel: "r" | "g" | "b", strength: string): string {
  const others = channel === "r" ? ["g", "b"] : channel === "g" ? ["r", "b"] : ["r", "g"];
  const preserved = ["r", "g", "b"].filter((candidate) => candidate !== channel);
  return `geq=${preserved.map((candidate) => `${candidate}='${candidate}(X,Y)'`).join(":")}:` +
    `a='alpha(X,Y)':${channel}='min(${channel}(X,Y),` +
    `(${others[0]}(X,Y)+${others[1]}(X,Y))/2+(1-${strength})*max(0,` +
    `${channel}(X,Y)-(${others[0]}(X,Y)+${others[1]}(X,Y))/2))'`;
}
