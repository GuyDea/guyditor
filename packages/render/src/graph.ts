import { createHash } from "node:crypto";
import {
  compilePipTimeline,
  solvePlacement,
} from "../../compositor/src/index.js";
import type { FramingSidecar } from "../../deliver/src/index.js";

import {
  convertTime,
  deriveTimeline,
  makeGuyditorError,
} from "../../core/src/index.js";
import type {
  Asset,
  AudioChain,
  Clip,
  ColorCorrection,
  Effect,
  FrameTime,
  GuyditorProject,
  KeySettings,
  Layer,
  PlacedItem,
  Sequence,
  Transform2D,
} from "../../core/src/index.js";

import type {
  AudioStage,
  AudioChainNodeParams,
  ColorNodeParams,
  CompositeNodeParams,
  EncodeNodeParams,
  KeyNodeParams,
  OverlayNodeParams,
  PipNodeParams,
  RenderGraph,
  RenderNode,
  RenderNodeKind,
  SourceNodeParams,
  ToolchainManifest,
  TimelineInsertNodeParams,
  TransformNodeParams,
  TrimNodeParams,
} from "./ir.js";
import type { RenderProfile } from "./profile.js";
import {
  compileDuckingEnvelope,
} from "./ducking.js";
import {
  insertedDurationFrames,
  restyleTimelineInsertions,
  sourceFrameToOutputFrame,
} from "./timeline-insertions.js";
import type {
  ResolvedDuckingOverride,
  SpeechInterval,
} from "./ducking.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const VIRTUAL_GAP_ASSET = "__guyditor_gap__";
export const VIRTUAL_SILENCE_ASSET = "__guyditor_silence__";

export type DiagnosticBackground = "none" | "black" | "white" | "saturated" | "checkerboard";

export interface CompileRenderGraphOptions {
  project: GuyditorProject;
  revision: string;
  deliverableId: string;
  variant: "burnin" | "clean" | "preview";
  quality: "proxy" | "high";
  profile: RenderProfile;
  profileSha256: string;
  toolchain: ToolchainManifest;
  /** Caption overlays retained under the M1 field name for graph compatibility. */
  overlays?: readonly OverlayNodeParams[];
  /** Deliberate graphics are part of every output variant, including clean. */
  graphicOverlays?: readonly OverlayNodeParams[];
  maskAssets?: Readonly<Record<string, { path: string; sha256: string; animated?: boolean }>>;
  diagnosticBackground?: DiagnosticBackground;
  diagnosticSaturatedColor?: string;
  inspectedLayerId?: string;
  /** Compile-time semantic-anchor resolutions; solved coordinates remain derived IR only. */
  anchorFrames?: Readonly<Record<string, number>>;
  pipAssets?: Readonly<Record<string, NonNullable<PipNodeParams["rasterAssets"]>>>;
  /** Timeline-mapped VAD/peak speech intervals at the project sample rate. */
  speechIntervals?: readonly SpeechInterval[];
  /** Exact resolved samples for persisted semantic manual-ducking anchors. */
  duckingOverrideSamples?: Readonly<Record<string, number>>;
  /** Smoothed normalized face centers derived from tracking sidecars for punch-in crops. */
  faceTrackAnchors?: Readonly<Record<string, { x: number; y: number }>>;
  /** Verified per-deliverable framing decisions loaded from guyditor.framing/v1. */
  framing?: FramingSidecar;
}

interface VisualInput {
  nodeId: string;
  durationFrames: number;
  transitionFromPreviousFrames?: number;
  atOutputFrame?: number;
}

function unsupported(feature: string, part: string, affected: readonly string[] = []): never {
  throw makeGuyditorError(
    "E_RENDER_UNSUPPORTED",
    `${feature} is unsupported by the M2 renderer; ${part} owns this feature.`,
    { affected },
  );
}

function graphInvalid(message: string, affected: readonly string[] = []): never {
  throw makeGuyditorError("E_RENDER_GRAPH_INVALID", message, { affected });
}

function base32Digest(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 10) {
      bits -= 5;
      output += BASE32[(buffer >>> bits) & 31];
    }
    if (output.length === 10) return output;
  }
  return output.padEnd(10, "a");
}

function idFactory(graphSeed: string): () => string {
  let ordinal = 0;
  return () => {
    ordinal += 1;
    return `rn_${base32Digest(`${graphSeed}:${String(ordinal)}`)}`;
  };
}

function rationalParts(value: string): { numerator: bigint; denominator: bigint } {
  const match = /^(-?\d+)\/(\d+)$/u.exec(value);
  if (match === null || match[2] === "0") graphInvalid(`Invalid exact rational ${value}.`);
  return { numerator: BigInt(match[1]!), denominator: BigInt(match[2]!) };
}

function safeNumber(value: bigint, feature: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    unsupported(`${feature} outside exact integer bounds`, "Part 2");
  }
  return Number(value);
}

function samplesForFrames(time: FrameTime, sampleRate: number): number {
  const fps = rationalParts(time.fps);
  const numerator = BigInt(time.frames) * fps.denominator * BigInt(sampleRate);
  if (numerator % fps.numerator !== 0n) {
    unsupported(
      `frame duration ${String(time.frames)}@${time.fps} at ${String(sampleRate)} Hz`,
      "Part 2",
    );
  }
  return safeNumber(numerator / fps.numerator, "sample time");
}

function resampleExactOffset(samples: number, rate: number, outputRate: number): number {
  const numerator = BigInt(samples) * BigInt(outputRate);
  const denominator = BigInt(rate);
  if (numerator % denominator !== 0n) {
    unsupported(
      `sample offset ${String(samples)}@${String(rate)} Hz at ${String(outputRate)} Hz`,
      "Part 2",
    );
  }
  const value = numerator / denominator;
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    unsupported("sample offset outside exact integer bounds", "Part 2");
  }
  return Number(value);
}

function outputFrames(time: FrameTime, fps: string): number {
  const converted = convertTime(time, fps);
  if (!converted.ok) {
    unsupported(`incommensurate frame time ${String(time.frames)}@${time.fps}`, "Part 2");
  }
  return converted.value.frames;
}

function framesForSeconds(value: string, fps: string): number {
  const seconds = rationalParts(value);
  const rate = rationalParts(fps);
  const numerator = seconds.numerator * rate.numerator;
  const denominator = seconds.denominator * rate.denominator;
  if (numerator % denominator !== 0n) {
    unsupported(`duration ${value} at ${fps}`, "Part 2");
  }
  return safeNumber(numerator / denominator, "output duration");
}

function speedOf(clip: Clip | PlacedItem): { num: number; den: number } | undefined {
  const speedEffects = (clip.effects ?? []).filter((effect) => effect.kind === "speed");
  if (speedEffects.length === 0) return undefined;
  if (speedEffects.length > 1) unsupported(`multiple speed effects on ${clip.id}`, "Part 6", [clip.id]);
  const value = speedEffects[0]!.params["rate"];
  if (typeof value !== "string") unsupported(`non-rational speed effect on ${clip.id}`, "Part 6", [clip.id]);
  const parts = rationalParts(value);
  if (parts.numerator <= 0n) unsupported(`non-positive speed effect on ${clip.id}`, "Part 6", [clip.id]);
  return {
    num: safeNumber(parts.numerator, "speed numerator"),
    den: safeNumber(parts.denominator, "speed denominator"),
  };
}

function pushNode(
  nodes: RenderNode[],
  nextId: () => string,
  kind: RenderNodeKind,
  inputs: string[],
  params: RenderNode["params"],
): RenderNode {
  const node: RenderNode = { id: nextId(), kind, inputs, params };
  nodes.push(node);
  return node;
}

function actualAudioRate(asset: Asset, fallback: number): number {
  return asset.audio?.[0]?.sampleRate ?? asset.probe.audio?.rate ?? fallback;
}

function correctionFromEffect(effect: Effect): ColorCorrection {
  const correction = effect.params as unknown as ColorCorrection;
  return structuredClone(correction);
}

function audioChainStages(chain: AudioChain | undefined): AudioStage[] {
  if (chain === undefined) return [];
  const stages: AudioStage[] = [];
  for (const node of chain.nodes) {
    if (!node.enabled) continue;
    switch (node.type) {
      case "channelSelect":
        stages.push({
          stage: "channelmap",
          params: {
            mapping: Array.isArray(node.mapping) ? node.mapping.join(",") : node.mapping,
          },
        });
        break;
      case "noiseReduction":
        stages.push({ stage: "denoise", params: { strengthDb: node.strengthDb } });
        break;
      case "gain":
        stages.push({ stage: "gain", params: { gainDb: node.gainDb } });
        break;
      case "eq":
        stages.push(...node.bands.map((band) => ({
          stage: "eq" as const,
          params: { frequencyHz: band.freqHz, gainDb: band.gainDb, q: band.q },
        })));
        break;
      case "compression":
        stages.push({
          stage: "compress",
          params: {
            thresholdDb: node.thresholdDb,
            ratio: node.ratio,
            attackMs: node.attackMs,
            releaseMs: node.releaseMs,
            makeupDb: node.makeupDb,
          },
        });
        break;
      case "limiting":
        stages.push({ stage: "limit", params: { ceilingDb: node.ceilingDb } });
        break;
    }
  }
  return stages;
}

function dominantChannel(color: string): "green" | "blue" | undefined {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  if (green > red && green > blue) return "green";
  if (blue > red && blue > green) return "blue";
  return undefined;
}

function keyParams(
  settings: KeySettings,
  clipId: string,
  project: GuyditorProject,
  options: CompileRenderGraphOptions,
): KeyNodeParams | undefined {
  if (settings.mode === "off") return undefined;
  const masks = settings.masks.map((mask) => {
    const supplied = options.maskAssets?.[mask.id];
    const hash = createHash("sha256").update(JSON.stringify(mask)).digest("hex");
    return {
      id: mask.id,
      role: mask.role,
      path: supplied?.path ?? `.guyditor/cache/masks/${hash}.png`,
      sha256: supplied?.sha256 ?? hash,
      animated: supplied?.animated ?? mask.frames !== undefined,
    };
  });
  if (settings.mode === "neural") {
    const neural = settings.neural;
    if (neural?.matteAssetId === undefined) {
      graphInvalid(`Neural key on ${clipId} has no accepted frozen matte asset.`, [clipId]);
    }
    const matte = project.assets.find(({ id }) => id === neural.matteAssetId);
    if (matte === undefined || matte.kind !== "generated" || matte.provenance === undefined) {
      graphInvalid(`Neural key on ${clipId} references a non-frozen matte asset.`, [clipId, neural.matteAssetId]);
    }
    const chroma = settings.chroma;
    const channel = chroma?.spill.mode === "despill" ? dominantChannel(chroma.keyColor) : undefined;
    return {
      method: "neuralMatte",
      matteAssetId: matte.id,
      masks,
      ...(chroma === undefined ? {} : {
        keyColor: chroma.keyColor,
        spill: { ...structuredClone(chroma.spill), ...(channel === undefined ? {} : { channel }) },
      }),
      ...(settings.postColor === undefined ? {} : { postColor: structuredClone(settings.postColor) }),
    };
  }
  const chroma = settings.chroma;
  if (chroma === undefined) graphInvalid(`Chroma key on ${clipId} has no parameters.`, [clipId]);
  const channel = chroma.spill.mode === "despill" ? dominantChannel(chroma.keyColor) : undefined;
  if (chroma.spill.mode === "despill" && channel === undefined) {
    throw makeGuyditorError(
      "E_KEY_UNSUPPORTED_COLOR",
      `Key color ${chroma.keyColor} has no dominant green or blue channel.`,
      { affected: [clipId], suggestion: "Use spill mode 'average'." },
    );
  }
  return {
    method: "chroma",
    keyColor: chroma.keyColor,
    tolerance: chroma.tolerance,
    edgeSoftness: chroma.softness,
    preBlur: chroma.preBlur,
    edge: structuredClone(chroma.edge),
    spill: { ...structuredClone(chroma.spill), ...(channel === undefined ? {} : { channel }) },
    masks,
    ...(settings.postColor === undefined ? {} : { postColor: structuredClone(settings.postColor) }),
  };
}

function transformEffectParams(effect: Effect): TransformNodeParams {
  const crop = effect.params["crop"] as { l: number; t: number; r: number; b: number } | undefined;
  const scale = effect.params["scale"] as number | undefined;
  const position = effect.params["position"] as { x: number; y: number } | undefined;
  const rotationDeg = effect.params["rotationDeg"] as number | undefined;
  const opacity = effect.params["opacity"] as number | undefined;
  return {
    keyframes: [{
      atOutputFrame: 0,
      ...(crop === undefined
        ? {}
        : { crop: [crop.l, crop.t, 1 - crop.l - crop.r, 1 - crop.t - crop.b] }),
      ...(scale === undefined ? {} : { scale }),
      ...(position === undefined ? {} : { pos: [position.x, position.y] }),
      anchor: [0.5, 0.5],
      ...(rotationDeg === undefined ? {} : { rotateDeg: rotationDeg }),
      ...(opacity === undefined ? {} : { opacity }),
    }],
    interpolation: "linear",
  };
}

function punchInTransformParams(
  clip: Clip,
  options: CompileRenderGraphOptions,
): TransformNodeParams {
  const punchIn = clip.punchIn;
  if (punchIn === undefined) graphInvalid(`Clip ${clip.id} has no punch-in.`, [clip.id]);
  const center = punchIn.anchor === "face-track"
    ? options.faceTrackAnchors?.[clip.id]
    : punchIn.anchor;
  if (center === undefined) {
    graphInvalid(`Punch-in ${clip.id} requires a resolved face-track anchor.`, [clip.id]);
  }
  const cropSize = 1 / punchIn.level;
  const round = (value: number): number => Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
  const x = round(Math.min(1 - cropSize, Math.max(0, center.x - cropSize / 2)));
  const y = round(Math.min(1 - cropSize, Math.max(0, center.y - cropSize / 2)));
  return {
    keyframes: [{
      atOutputFrame: 0,
      crop: [x, y, round(cropSize), round(cropSize)],
      scale: punchIn.level,
      pos: [0.5, 0.5],
      anchor: [0.5, 0.5],
    }],
    interpolation: "linear",
  };
}

function layerTransformParams(transform: Transform2D): TransformNodeParams {
  return {
    keyframes: [{
      atOutputFrame: 0,
      ...(transform.crop === undefined
        ? {}
        : { crop: [transform.crop.x, transform.crop.y, transform.crop.w, transform.crop.h] }),
      scale: [transform.scale.x, transform.scale.y],
      pos: [transform.position.x, transform.position.y],
      anchor: [transform.anchor.x, transform.anchor.y],
      rotateDeg: transform.rotationDeg,
    }],
    interpolation: "linear",
  };
}

function fixedItemDuration(
  item: PlacedItem,
  asset: Asset,
  outputFps: string,
  compositionDurationFrames: number,
): number {
  if (item.duration === "intrinsic") {
    const duration = asset.probe.duration;
    return duration !== undefined && "frames" in duration
      ? outputFrames(duration, outputFps)
      : compositionDurationFrames;
  }
  if ("until" in item.duration) {
    unsupported(`semantic until duration on ${item.id}`, "Part 0 anchor resolver", [item.id]);
  }
  return outputFrames(item.duration, outputFps);
}

function itemStart(item: PlacedItem, sequenceId: string, outputFps: string): number {
  const scoped = new RegExp(`^timeline:${sequenceId}@([0-9]+)$`, "u").exec(item.at);
  if (scoped !== null) return Number(scoped[1]);
  const absolute = /^timeline:([0-9]+)@([0-9]+\/[1-9][0-9]*)$/u.exec(item.at);
  if (absolute !== null) {
    return outputFrames({ frames: Number(absolute[1]), fps: absolute[2]! }, outputFps);
  }
  unsupported(`unresolved item anchor ${item.at}`, "Part 0 anchor resolver", [item.id]);
}

function restyleSourceRange(
  item: PlacedItem,
): { startFrame: number; endFrame: number } | undefined {
  const value = item.params?.["restyle"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const sourceRange = (value as Record<string, unknown>)["sourceRange"];
  if (typeof sourceRange !== "object" || sourceRange === null || Array.isArray(sourceRange)) {
    graphInvalid(`Restyle item ${item.id} has no source range.`, [item.id]);
  }
  const range = sourceRange as Record<string, unknown>;
  const startFrame = range["startFrame"];
  const endFrame = range["endFrame"];
  if (
    typeof startFrame !== "number" || !Number.isSafeInteger(startFrame) || startFrame < 0 ||
    typeof endFrame !== "number" || !Number.isSafeInteger(endFrame) || endFrame <= startFrame
  ) {
    graphInvalid(`Restyle item ${item.id} has an invalid source range.`, [item.id]);
  }
  return { startFrame, endFrame };
}

function visualLayers(project: GuyditorProject, sequenceId?: string): Layer[] {
  return project.layers
    .filter(({ enabled, kind, sequence }) =>
      enabled && (sequenceId === undefined || sequence === undefined || sequence === sequenceId) && (
      kind === "video" || kind === "image" || kind === "matte" ||
      kind === "text" || kind === "animation" || kind === "caption" ||
      kind === "adjustment"
    ))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function assertSupportedSubset(
  project: GuyditorProject,
  deliverableId: string,
  quality: "proxy" | "high",
) {
  if (quality === "proxy") unsupported("proxy quality", "Part 3", [deliverableId]);
  const deliverable = project.deliverables.find((item) => item.id === deliverableId);
  if (deliverable === undefined) {
    throw makeGuyditorError(
      "E_RENDER_DELIVERABLE_NOT_FOUND",
      `Deliverable ${deliverableId} does not exist.`,
      { affected: [deliverableId] },
    );
  }
  if (deliverable.profileOverrides !== undefined) {
    unsupported(`profile overrides on ${deliverableId}`, "Part 11", [deliverableId]);
  }
  const sequence = project.sequences.find((item) => item.id === deliverable.sequenceId);
  if (sequence === undefined) {
    throw makeGuyditorError(
      "E_RENDER_SEQUENCE_NOT_FOUND",
      `Sequence ${deliverable.sequenceId} for ${deliverableId} does not exist.`,
      { affected: [deliverableId, deliverable.sequenceId] },
    );
  }
  for (const layer of visualLayers(project, deliverable.sequenceId)) {
    if (layer.kind === "text" || layer.kind === "animation") {
      const templatesOnly = layer.items?.every((item) => item.template !== undefined) ?? true;
      if (!templatesOnly) unsupported(`overlay items layer ${layer.id}`, "Part 7", [layer.id]);
    }
    if (layer.kind === "caption") continue;
    if (layer.sequence !== undefined && !project.sequences.some(({ id }) => id === layer.sequence)) {
      graphInvalid(`Layer ${layer.id} references missing sequence ${layer.sequence}.`, [layer.id]);
    }
  }
  for (const candidate of project.sequences) {
    for (const clip of candidate.clips) {
      if (clip.overlapPrevious !== undefined) unsupported(`overlap before ${clip.id}`, "Part 5", [clip.id]);
      for (const effect of clip.effects ?? []) {
        if (effect.kind === "freeze") unsupported(`freeze effect ${effect.id}`, "Part 6", [effect.id]);
        if (
          effect.kind !== "speed" && effect.kind !== "key" && effect.kind !== "transform" &&
          effect.kind !== "color" && effect.kind !== "look"
        ) {
          unsupported(`${effect.kind} effect ${effect.id}`, "Part 6", [effect.id]);
        }
      }
    }
  }
  return { deliverable, sequence };
}

function diagnosticColor(options: CompileRenderGraphOptions): string {
  switch (options.diagnosticBackground ?? "none") {
    case "white": return "white";
    case "saturated": return options.diagnosticSaturatedColor ?? "0xFF00FF";
    case "checkerboard": return "checkerboard";
    case "black":
    case "none":
      return "black";
  }
}

export function compileRenderGraph(options: CompileRenderGraphOptions): RenderGraph {
  const { project, revision, deliverableId, variant, quality, profile, profileSha256, toolchain } = options;
  if (revision !== project.revision) {
    graphInvalid(`Loaded revision ${project.revision} does not match requested ${revision}.`, [revision]);
  }
  const { deliverable, sequence } = assertSupportedSubset(project, deliverableId, quality);
  if (deliverable.profile !== `${profile.id}@${profile.version}`) {
    unsupported(`profile pin ${deliverable.profile}`, "Part 11", [deliverable.id]);
  }
  const profileFps = deliverable.kind === "short" ? profile.video.fps : undefined;
  const profileResolution = deliverable.kind === "short" ? profile.video.resolution : undefined;
  const outputFps = profileFps ?? project.settings.timeline.fps;
  const outputSize = profileResolution === undefined
    ? { w: project.settings.timeline.width, h: project.settings.timeline.height }
    : { w: profileResolution.width, h: profileResolution.height };
  if (options.framing !== undefined && (
    options.framing.deliverableId !== deliverable.id ||
    options.framing.profile !== deliverable.profile
  )) {
    graphInvalid("The framing sidecar does not match this deliverable and profile.", [
      deliverable.id,
    ]);
  }
  const mainTimeline = deriveTimeline(project, sequence.id);
  if (!mainTimeline.ok) throw mainTimeline.error;
  const sourceCompositionDurationFrames = framesForSeconds(
    mainTimeline.value.duration,
    outputFps,
  );
  const timelineInsertions = restyleTimelineInsertions(project, sequence.id);
  for (const insertion of timelineInsertions) {
    if (insertion.sourceFrame <= 0 || insertion.sourceFrame >= sourceCompositionDurationFrames) {
      graphInvalid(
        `Restyle seam ${insertion.seamId} must fall inside the source composition.`,
        [insertion.seamId],
      );
    }
  }
  const compositionDurationFrames = sourceCompositionDurationFrames +
    insertedDurationFrames(timelineInsertions);
  const nodes: RenderNode[] = [];
  const nextId = idFactory(`${revision}:${deliverableId}:${variant}:${quality}`);
  const canvas = {
    ...outputSize,
    background: "0x00000000",
  };
  const visualLayerCount = visualLayers(project, deliverable.sequenceId).filter(({ kind }) =>
    kind === "video" || kind === "image").length;
  const derivedClips = new Map(mainTimeline.value.clips.map((entry) => [entry.clipId, entry] as const));

  function effectiveFramingDecision(decision: FramingSidecar["decisions"][number]): {
    mode: "crop" | "recompose";
    crop: typeof decision.crop;
    layout: string | undefined;
  } {
    const override = deliverable.framingOverrides?.find(({ decisionId }) =>
      decisionId === decision.decisionId);
    return {
      mode: override?.crop !== undefined
        ? "crop"
        : override?.layout !== undefined ? "recompose" : decision.mode,
      crop: override?.crop ?? decision.crop,
      layout: override?.layout ?? decision.layout,
    };
  }

  function sourceTimeToOutputFrame(clipId: string, at: FrameTime): number {
    const clip = sequence.clips.find(({ id }) => id === clipId);
    const derived = derivedClips.get(clipId);
    if (clip === undefined || derived === undefined) {
      graphInvalid(`Framing decision references unavailable clip ${clipId}.`, [clipId]);
    }
    const sourceIn = outputFrames(clip.source.in, outputFps);
    const sourceOut = outputFrames(clip.source.out, outputFps);
    const sourceAt = outputFrames(at, outputFps);
    if (sourceAt < sourceIn || sourceAt > sourceOut) {
      graphInvalid(`Framing keyframe leaves clip ${clipId}'s source range.`, [clipId]);
    }
    const sourceSpan = sourceOut - sourceIn;
    const derivedStart = outputFrames(derived.start, outputFps);
    const derivedDuration = outputFrames(derived.duration, outputFps);
    const timelineFrame = derivedStart + (sourceSpan === 0
      ? 0
      : Math.round((sourceAt - sourceIn) * derivedDuration / sourceSpan));
    return sourceFrameToOutputFrame(timelineFrame, timelineInsertions);
  }

  function layerSourceSize(layer: Layer): { width: number; height: number } {
    const layerSequence = project.sequences.find(({ id }) => id === layer.sequence);
    const assetId = layerSequence?.clips[0]?.asset ?? layer.items?.find(({ asset }) => asset !== undefined)?.asset;
    const asset = project.assets.find(({ id }) => id === assetId);
    return {
      width: asset?.video?.width ?? asset?.probe.width ?? project.settings.timeline.width,
      height: asset?.video?.height ?? asset?.probe.height ?? project.settings.timeline.height,
    };
  }

  function decisionSourceSize(
    decision: FramingSidecar["decisions"][number],
    layer: Layer,
  ): { width: number; height: number } {
    const clip = sequence.clips.find(({ id }) => id === decision.shot.clipId);
    const asset = project.assets.find(({ id }) => id === clip?.asset);
    return asset === undefined
      ? layerSourceSize(layer)
      : {
          width: asset.video?.width ?? asset.probe.width ?? project.settings.timeline.width,
          height: asset.video?.height ?? asset.probe.height ?? project.settings.timeline.height,
        };
  }

  function sourceCropOnContainedCanvas(
    rect: NonNullable<FramingSidecar["decisions"][number]["crop"]>["keyframes"][number]["rect"],
    source: { width: number; height: number },
  ): { crop: [number, number, number, number]; scale: number } {
    const contain = Math.min(outputSize.w / source.width, outputSize.h / source.height);
    const containedWidth = source.width * contain;
    const containedHeight = source.height * contain;
    const offsetX = (outputSize.w - containedWidth) / 2;
    const offsetY = (outputSize.h - containedHeight) / 2;
    const crop: [number, number, number, number] = [
      (offsetX + rect.x * containedWidth) / outputSize.w,
      (offsetY + rect.y * containedHeight) / outputSize.h,
      rect.w * containedWidth / outputSize.w,
      rect.h * containedHeight / outputSize.h,
    ];
    return { crop, scale: Math.min(1 / crop[2], 1 / crop[3]) };
  }

  function normalizedRecomposeKeyframe(
    layer: Layer,
    layerIndex: number,
  ): Pick<TransformNodeParams["keyframes"][number], "scale" | "pos" | "anchor"> {
    if (layer.pip !== undefined) {
      // The PiP transform below performs the responsive constraint solve; this
      // framing transform remains an auditable per-layer boundary.
      return { scale: 1, pos: [0.5, 0.5], anchor: [0.5, 0.5] };
    }
    const source = layerSourceSize(layer);
    if (layerIndex === 0) {
      const cover = Math.max(outputSize.w / source.width, outputSize.h / source.height);
      return { scale: cover, pos: [0.5, 0.5], anchor: [0.5, 0.5] };
    }
    const rect = solvePlacement({
      anchor: layerIndex % 2 === 0 ? "top" : "bottom",
      width: "84%",
      margin: "6%",
      aspect: `${String(source.width)}:${String(source.height)}`,
    }, outputSize.w, outputSize.h, source.width / source.height);
    const fit = Math.min(
      rect.w * outputSize.w / source.width,
      rect.h * outputSize.h / source.height,
    );
    return {
      scale: fit,
      pos: [rect.x + rect.w / 2, rect.y + rect.h / 2],
      anchor: [0.5, 0.5],
    };
  }

  function framingTransformParams(layer: Layer, layerIndex: number): TransformNodeParams | undefined {
    const decisions = options.framing?.decisions ?? [];
    const effective = decisions.map((decision) => ({
      decision,
      ...effectiveFramingDecision(decision),
    }));
    const crops = effective.filter(({ mode, crop }) => mode === "crop" && crop !== undefined);
    if (crops.length > 0) {
      const byFrame = new Map<number, TransformNodeParams["keyframes"][number]>();
      for (const { decision, crop } of crops) {
        for (const keyframe of crop!.keyframes) {
          const atOutputFrame = sourceTimeToOutputFrame(decision.shot.clipId, keyframe.at);
          const lowered = sourceCropOnContainedCanvas(
            keyframe.rect,
            decisionSourceSize(decision, layer),
          );
          byFrame.set(atOutputFrame, {
            atOutputFrame,
            crop: lowered.crop,
            scale: lowered.scale,
            pos: [0.5, 0.5],
            anchor: [0.5, 0.5],
          });
        }
      }
      const keyframes = [...byFrame.values()].sort((left, right) => left.atOutputFrame - right.atOutputFrame);
      if (keyframes.length > 0 && keyframes[0]!.atOutputFrame !== 0) {
        keyframes.unshift({ ...keyframes[0]!, atOutputFrame: 0 });
      }
      return {
        layerId: layer.id,
        framingDecisionId: crops[0]!.decision.decisionId,
        keyframes,
        interpolation: "linear",
      };
    }
    const recompositions = effective.filter(({ mode }) => mode === "recompose");
    if (recompositions.length === 0) return undefined;
    const geometry = normalizedRecomposeKeyframe(layer, layerIndex);
    const byFrame = new Map<number, TransformNodeParams["keyframes"][number]>();
    for (const { decision } of recompositions) {
      const frame = sourceTimeToOutputFrame(decision.shot.clipId, decision.shot.source.start);
      byFrame.set(frame, { atOutputFrame: frame, ...geometry });
    }
    const keyframes = [...byFrame.values()].sort((left, right) => left.atOutputFrame - right.atOutputFrame);
    if (keyframes[0]!.atOutputFrame !== 0) keyframes.unshift({ ...keyframes[0]!, atOutputFrame: 0 });
    return {
      layerId: layer.id,
      framingDecisionId: recompositions[0]!.decision.decisionId,
      keyframes,
      interpolation: "linear",
    };
  }

  function addVisualSource(
    owner: Clip | PlacedItem,
    asset: Asset,
    source: { in: FrameTime; out: FrameTime },
    durationFrames: number,
  ): string {
    const audioOnly = asset.kind === "audio";
    const keyEffect = owner.effects?.find(({ kind }) => kind === "key");
    const sourceNode = pushNode(nodes, nextId, "source", [], {
      assetId: audioOnly ? VIRTUAL_GAP_ASSET : asset.id,
      assetSha256: audioOnly ? "0".repeat(64) : asset.sha256,
      stream: "video",
      path: audioOnly ? "" : asset.path,
      useProxy: false,
      ...(asset.kind === "image" || asset.image !== undefined ? { still: true } : {}),
      ...(visualLayerCount > 1 || keyEffect !== undefined ||
          asset.video?.hasAlpha === true || asset.image?.hasAlpha === true
        ? { preserveAlpha: true }
        : {}),
    } satisfies SourceNodeParams);
    const trimParams: TrimNodeParams = { in: source.in, out: source.out };
    const speed = speedOf(owner);
    if (speed !== undefined) trimParams.speed = speed;
    const trim = pushNode(nodes, nextId, "trim", [sourceNode.id], trimParams);
    let root = trim;
    if (keyEffect !== undefined) {
      const key = keyParams(keyEffect.params as unknown as KeySettings, owner.id, project, options);
      if (key !== undefined) {
        const inputs = [root.id];
        if (key.method === "neuralMatte") {
          const matte = project.assets.find(({ id }) => id === key.matteAssetId);
          if (matte === undefined || matte.probe.duration === undefined || !("frames" in matte.probe.duration)) {
            graphInvalid(`Frozen matte for ${owner.id} has no frame duration.`, [owner.id, String(key.matteAssetId)]);
          }
          const matteAnalysis = matte.analyses?.["matte"] as {
            sourceFrames?: { from?: unknown; to?: unknown };
          } | undefined;
          const generatedFrom = matteAnalysis?.sourceFrames?.from;
          const generatedTo = matteAnalysis?.sourceFrames?.to;
          if (typeof generatedFrom !== "number" || typeof generatedTo !== "number") {
            graphInvalid(`Frozen matte for ${owner.id} has no source-frame mapping.`, [owner.id, matte.id]);
          }
          const matteIn = source.in.frames - generatedFrom;
          const matteOut = source.out.frames - generatedFrom;
          if (matteIn < 0 || matteOut > generatedTo - generatedFrom + 1 || matteOut <= matteIn) {
            graphInvalid(`Frozen matte for ${owner.id} does not cover the current source range.`, [owner.id, matte.id]);
          }
          const matteSource = pushNode(nodes, nextId, "source", [], {
            assetId: matte.id,
            assetSha256: matte.sha256,
            stream: "video",
            path: matte.path,
            useProxy: false,
          } satisfies SourceNodeParams);
          const matteTrim: TrimNodeParams = {
            in: { frames: matteIn, fps: matte.probe.duration.fps },
            out: { frames: matteOut, fps: matte.probe.duration.fps },
          };
          if (speed !== undefined) matteTrim.speed = speed;
          inputs.push(pushNode(nodes, nextId, "trim", [matteSource.id], matteTrim).id);
        }
        root = pushNode(nodes, nextId, "key", inputs, key);
      }
    }
    for (const effect of owner.effects?.filter(({ kind }) => kind === "color" || kind === "look") ?? []) {
      root = pushNode(nodes, nextId, "color", [root.id], {
        correction: correctionFromEffect(effect),
        source: effect.kind === "look" ? "look" : "clip",
      } satisfies ColorNodeParams);
    }
    const transform = owner.effects?.find(({ kind }) => kind === "transform");
    if ("punchIn" in owner && owner.punchIn !== undefined) {
      root = pushNode(nodes, nextId, "transform", [root.id], punchInTransformParams(owner, options));
    }
    if (transform !== undefined) {
      root = pushNode(nodes, nextId, "transform", [root.id], transformEffectParams(transform));
    }
    void durationFrames;
    return root.id;
  }

  function addVirtualVideo(duration: FrameTime): VisualInput {
    const source = pushNode(nodes, nextId, "source", [], {
      assetId: VIRTUAL_GAP_ASSET,
      assetSha256: "0".repeat(64),
      stream: "video",
      path: "",
      useProxy: false,
    } satisfies SourceNodeParams);
    const trim = pushNode(nodes, nextId, "trim", [source.id], {
      in: { frames: 0, fps: duration.fps },
      out: duration,
    } satisfies TrimNodeParams);
    return { nodeId: trim.id, durationFrames: outputFrames(duration, outputFps) };
  }

  function compileSequenceLayer(layer: Layer): { root: RenderNode; durationFrames: number } {
    const layerSequence = project.sequences.find(({ id }) => id === layer.sequence);
    if (layerSequence === undefined) graphInvalid(`Layer ${layer.id} sequence is missing.`, [layer.id]);
    const timeline = deriveTimeline(project, layerSequence.id);
    if (!timeline.ok) throw timeline.error;
    const byClip = new Map(timeline.value.clips.map((entry) => [entry.clipId, entry] as const));
    const inputs: VisualInput[] = [];
    for (const [index, clip] of layerSequence.clips.entries()) {
      if (clip.gapBefore !== undefined) inputs.push(addVirtualVideo(clip.gapBefore));
      const asset = project.assets.find(({ id }) => id === clip.asset);
      if (asset === undefined) {
        throw makeGuyditorError(
          "E_RENDER_UNFROZEN_GENERATION",
          `Clip ${clip.id} references absent asset ${clip.asset}.`,
          { affected: [clip.id, clip.asset] },
        );
      }
      const derived = byClip.get(clip.id);
      if (derived === undefined) graphInvalid(`No derived timeline entry exists for ${clip.id}.`, [clip.id]);
      const durationFrames = outputFrames(derived.duration, outputFps);
      const previous = layerSequence.clips[index - 1];
      const transition = previous?.transitionAfter;
      inputs.push({
        nodeId: addVisualSource(clip, asset, clip.source, durationFrames),
        durationFrames,
        ...(transition === undefined
          ? {}
          : {
              transitionFromPreviousFrames: outputFrames(
                transition.duration,
                outputFps,
              ),
            }),
      });
    }
    const durationFrames = framesForSeconds(timeline.value.duration, outputFps);
    let root = pushNode(nodes, nextId, "composite", inputs.map(({ nodeId }) => nodeId), {
      canvas,
      mode: "timeline.sequential",
      durationFrames,
      inputSettings: inputs.map(({ durationFrames: duration, transitionFromPreviousFrames }) => ({
        durationFrames: duration,
        ...(transitionFromPreviousFrames === undefined ? {} : { transitionFromPreviousFrames }),
      })),
    } satisfies CompositeNodeParams);
    if (timelineInsertions.length > 0) {
      const applicable = timelineInsertions.filter(({ sourceFrame }) => sourceFrame < durationFrames);
      if (applicable.length === 0) return { root, durationFrames };
      const outputDuration = durationFrames + insertedDurationFrames(applicable);
      root = pushNode(nodes, nextId, "timeline-insert", [root.id], {
        stream: "video",
        sourceDuration: durationFrames,
        outputDuration,
        insertions: applicable.map(({ sourceFrame, durationFrames: duration }) => ({
          at: sourceFrame,
          duration,
        })),
      } satisfies TimelineInsertNodeParams);
      return { root, durationFrames: outputDuration };
    }
    return { root, durationFrames };
  }

  function compileItemsLayer(layer: Layer): { root: RenderNode; durationFrames: number } {
    const inputs: VisualInput[] = [];
    for (const item of layer.items ?? []) {
      if (item.template !== undefined) continue;
      if (item.asset === undefined) graphInvalid(`Placed item ${item.id} has no asset.`, [item.id]);
      const asset = project.assets.find(({ id }) => id === item.asset);
      if (asset === undefined) {
        throw makeGuyditorError(
          "E_RENDER_UNFROZEN_GENERATION",
          `Placed item ${item.id} references absent asset ${item.asset}.`,
          { affected: [item.id, item.asset] },
        );
      }
      const durationFrames = fixedItemDuration(
        item,
        asset,
        outputFps,
        sourceCompositionDurationFrames,
      );
      const sourceStartFrame = itemStart(item, sequence.id, outputFps);
      const restyleRange = restyleSourceRange(item);
      if (restyleRange !== undefined) {
        if (
          asset.kind !== "generated" || asset.provenance === undefined ||
          sourceStartFrame !== restyleRange.startFrame ||
          durationFrames !== restyleRange.endFrame - restyleRange.startFrame
        ) {
          graphInvalid(
            `Restyle item ${item.id} must use a frozen generated asset over its exact source range.`,
            [item.id, asset.id],
          );
        }
      }
      let source: { in: FrameTime; out: FrameTime };
      if (item.source !== undefined && "in" in item.source) {
        source = item.source;
      } else if (asset.kind === "image" || asset.image !== undefined) {
        source = {
          in: { frames: 0, fps: outputFps },
          out: { frames: durationFrames, fps: outputFps },
        };
      } else if (asset.probe.duration !== undefined && "frames" in asset.probe.duration) {
        source = {
          in: { frames: 0, fps: asset.probe.duration.fps },
          out: asset.probe.duration,
        };
      } else {
        graphInvalid(`Placed item ${item.id} needs a frame source range.`, [item.id]);
      }
      inputs.push({
        nodeId: addVisualSource(item, asset, source, durationFrames),
        durationFrames,
        atOutputFrame: sourceFrameToOutputFrame(sourceStartFrame, timelineInsertions),
      });
    }
    const root = pushNode(nodes, nextId, "composite", inputs.map(({ nodeId }) => nodeId), {
      canvas,
      mode: "timeline.anchored",
      durationFrames: compositionDurationFrames,
      inputSettings: inputs.map(({ durationFrames, atOutputFrame }) => ({
        durationFrames,
        atOutputFrame: atOutputFrame ?? 0,
      })),
    } satisfies CompositeNodeParams);
    return { root, durationFrames: compositionDurationFrames };
  }

  function compileLayer(layer: Layer): { root: RenderNode; durationFrames: number } {
    let compiled = layer.sequence === undefined
      ? compileItemsLayer(layer)
      : compileSequenceLayer(layer);
    if (layer.transform !== undefined) {
      compiled = {
        ...compiled,
        root: pushNode(nodes, nextId, "transform", [compiled.root.id], layerTransformParams(layer.transform)),
      };
    }
    if (layer.pip !== undefined) {
      const timeline = compilePipTimeline({
        pip: layer.pip,
        compWidth: outputSize.w,
        compHeight: outputSize.h,
        targetAspect: profile.video.aspect ?? `${String(outputSize.w)}:${String(outputSize.h)}`,
        anchorFrames: options.anchorFrames ?? {},
      });
      const transformed = pushNode(nodes, nextId, "transform", [compiled.root.id], {
        keyframes: timeline.samples.map(({ atOutputFrame, rect, opacity }) => ({
          atOutputFrame,
          scale: [rect.w, rect.h],
          pos: [rect.x + rect.w / 2, rect.y + rect.h / 2],
          anchor: [0.5, 0.5],
          opacity,
        })),
        interpolation: "linear",
      } satisfies TransformNodeParams);
      const styled = pushNode(nodes, nextId, "pip", [transformed.id], {
        style: structuredClone(layer.pip.style),
        styleKeyframes: timeline.samples.flatMap(({ atOutputFrame, style }) =>
          style === undefined ? [] : [{ atOutputFrame, style: structuredClone(style) }]),
        ...(options.pipAssets?.[layer.id] === undefined
          ? {}
          : { rasterAssets: structuredClone(options.pipAssets[layer.id]) }),
      } satisfies PipNodeParams);
      compiled = {
        ...compiled,
        root: styled,
      };
    }
    if (layer.kind === "video" || layer.kind === "image") {
      const layerIndex = visualLayers(project, deliverable.sequenceId)
        .filter(({ kind }) => kind === "video" || kind === "image")
        .findIndex(({ id }) => id === layer.id);
      const framing = framingTransformParams(layer, layerIndex);
      if (framing !== undefined) {
        compiled = {
          ...compiled,
          root: pushNode(nodes, nextId, "transform", [compiled.root.id], framing),
        };
      }
    }
    return compiled;
  }

  const ordered = visualLayers(project, deliverable.sequenceId);
  const matteRoots = new Map<string, { root: RenderNode; durationFrames: number }>();
  for (const layer of ordered.filter(({ kind }) => kind === "matte")) {
    matteRoots.set(layer.id, compileLayer(layer));
  }

  let layersToRender = ordered.filter(({ kind }) =>
    kind === "video" || kind === "image");
  const diagnostic = options.diagnosticBackground ?? "none";
  if (diagnostic !== "none" && options.inspectedLayerId !== undefined) {
    const inspected = project.layers.find(({ id }) => id === options.inspectedLayerId);
    if (inspected === undefined) graphInvalid(`Inspected layer ${options.inspectedLayerId} is missing.`);
    layersToRender = layersToRender.filter(({ order }) => order >= inspected.order);
  }
  const layerInputs: Array<{
    root: RenderNode;
    durationFrames: number;
    layer: Layer;
  }> = [];
  for (const layer of layersToRender) {
    let compiled = compileLayer(layer);
    if (layer.matte !== undefined) {
      const matte = matteRoots.get(layer.matte.layerId);
      if (matte === undefined) graphInvalid(`Matte layer ${layer.matte.layerId} was not compiled.`, [layer.id]);
      compiled = {
        ...compiled,
        root: pushNode(nodes, nextId, "key", [compiled.root.id, matte.root.id], {
          method: "alphaMatte",
          matteSource: layer.matte.source,
          invertMatte: layer.matte.invert ?? false,
        } satisfies KeyNodeParams),
      };
    }
    if (layer.look !== undefined) {
      compiled = {
        ...compiled,
        root: pushNode(nodes, nextId, "color", [compiled.root.id], {
          correction: structuredClone(layer.look),
          source: "layer-look",
        } satisfies ColorNodeParams),
      };
    }
    layerInputs.push({ ...compiled, layer });
  }
  const adjustmentLayers = ordered.filter(({ kind }) => kind === "adjustment");
  let visualRoot: RenderNode;
  if (adjustmentLayers.length === 0) {
    visualRoot = pushNode(nodes, nextId, "composite", layerInputs.map(({ root }) => root.id), {
      canvas: {
        ...outputSize,
        background: diagnosticColor(options),
      },
      mode: "stack",
      durationFrames: compositionDurationFrames,
      inputSettings: layerInputs.map(({ durationFrames, layer }) => ({
        durationFrames,
        layerId: layer.id,
        blend: layer.blend ?? "normal",
        opacity: layer.opacity ?? 1,
      })),
    } satisfies CompositeNodeParams);
  } else {
    const compiledByLayer = new Map(layerInputs.map((entry) => [entry.layer.id, entry] as const));
    let current: RenderNode | undefined;
    for (const layer of ordered.filter(({ kind }) =>
      kind === "video" || kind === "image" || kind === "adjustment")) {
      if (layer.kind === "adjustment") {
        if (current === undefined) {
          current = pushNode(nodes, nextId, "composite", [], {
            canvas: {
              ...outputSize,
              background: diagnosticColor(options),
            },
            mode: "stack",
            durationFrames: compositionDurationFrames,
            inputSettings: [],
          } satisfies CompositeNodeParams);
        }
        current = pushNode(nodes, nextId, "color", [current.id], {
          correction: structuredClone(layer.adjustment!),
          source: "adjustment",
        } satisfies ColorNodeParams);
        continue;
      }
      const compiled = compiledByLayer.get(layer.id);
      if (compiled === undefined) continue;
      current = pushNode(
        nodes,
        nextId,
        "composite",
        current === undefined ? [compiled.root.id] : [current.id, compiled.root.id],
        {
          canvas: {
            ...outputSize,
            background: diagnosticColor(options),
          },
          mode: "stack",
          durationFrames: compositionDurationFrames,
          inputSettings: [
            ...(current === undefined ? [] : [{ durationFrames: compositionDurationFrames }]),
            {
              durationFrames: compiled.durationFrames,
              layerId: layer.id,
              blend: layer.blend ?? "normal",
              opacity: layer.opacity ?? 1,
            },
          ],
        } satisfies CompositeNodeParams,
      );
    }
    if (current === undefined) graphInvalid("The visual stack has no renderable base.");
    visualRoot = current;
  }
  for (const overlay of options.graphicOverlays ?? []) {
    visualRoot = pushNode(nodes, nextId, "overlay", [visualRoot.id], structuredClone(overlay));
  }
  if (variant === "burnin") {
    for (const overlay of options.overlays ?? []) {
      visualRoot = pushNode(nodes, nextId, "overlay", [visualRoot.id], structuredClone(overlay));
    }
  }

  const outputSampleRate = project.settings.audio.sampleRate;
  const sourceCompositionDurationSamples = samplesForFrames(
    { frames: sourceCompositionDurationFrames, fps: outputFps },
    outputSampleRate,
  );
  const compositionDurationSamples = samplesForFrames(
    { frames: compositionDurationFrames, fps: outputFps },
    outputSampleRate,
  );

  function clipAudioStages(clip: Clip, durationSamples: number): AudioStage[] {
    const stages: AudioStage[] = [];
    if (clip.audio?.mute === true) stages.push({ stage: "gain", params: { gainDb: -120 } });
    if (clip.audio?.gainDb !== undefined) {
      stages.push({ stage: "gain", params: { gainDb: clip.audio.gainDb } });
    }
    if (clip.audio?.fadeIn !== undefined) {
      stages.push({
        stage: "fade",
        params: {
          direction: "in",
          startSample: 0,
          durationSamples: samplesForFrames(clip.audio.fadeIn, outputSampleRate),
          curve: clip.audio.fadeInCurve ?? "linear",
        },
      });
    }
    if (clip.audio?.fadeOut !== undefined) {
      const fadeSamples = samplesForFrames(clip.audio.fadeOut, outputSampleRate);
      stages.push({
        stage: "fade",
        params: {
          direction: "out",
          startSample: Math.max(0, durationSamples - fadeSamples),
          durationSamples: fadeSamples,
          curve: clip.audio.fadeOutCurve ?? "linear",
        },
      });
    }
    if (clip.audio?.channels !== undefined) {
      stages.push({
        stage: "channelmap",
        params: {
          mapping: Array.isArray(clip.audio.channels)
            ? clip.audio.channels.join(",")
            : clip.audio.channels,
        },
      });
    }
    stages.push(...audioChainStages(clip.audio?.chain));
    return stages;
  }

  function clipAnchorFrame(clip: Clip, sequenceId: string): number {
    if (clip.anchor === undefined) return 0;
    const supplied = options.anchorFrames?.[clip.anchor];
    if (supplied !== undefined) return supplied;
    const scoped = new RegExp(`^timeline:${sequenceId}@([0-9]+)$`, "u").exec(clip.anchor);
    if (scoped !== null) return Number(scoped[1]);
    const absolute = /^timeline:([0-9]+)@([0-9]+\/[1-9][0-9]*)$/u.exec(clip.anchor);
    if (absolute !== null) {
      return outputFrames({ frames: Number(absolute[1]), fps: absolute[2]! }, outputFps);
    }
    unsupported(`unresolved audio anchor ${clip.anchor}`, "Part 0 anchor resolver", [clip.id]);
  }

  function compileAudioSequence(
    target: Sequence,
    mode: "sequential" | "anchored",
    layer?: Layer,
  ): RenderNode {
    const audioInputs: string[] = [];
    const audioSettings: NonNullable<AudioChainNodeParams["inputSettings"]> = [];
    const timeline = deriveTimeline(project, target.id);
    if (!timeline.ok) throw timeline.error;
    const byClip = new Map(timeline.value.clips.map((entry) => [entry.clipId, entry] as const));

    function addAudioSlot(asset: Asset | undefined, duration: FrameTime, clip?: Clip): void {
    const hasAudio = asset !== undefined && ((asset.audio?.length ?? 0) > 0 || asset.probe.audio !== undefined);
    const sourceRate = hasAudio ? actualAudioRate(asset, outputSampleRate) : outputSampleRate;
    const source = pushNode(nodes, nextId, "source", [], {
      assetId: hasAudio ? asset.id : VIRTUAL_SILENCE_ASSET,
      assetSha256: hasAudio ? asset.sha256 : "0".repeat(64),
      stream: "audio",
      path: hasAudio ? asset.path : "",
      useProxy: false,
    } satisfies SourceNodeParams);
    const durationSamples = samplesForFrames(duration, outputSampleRate);
    const trimParams: TrimNodeParams = hasAudio && clip !== undefined
      ? {
          in: { samples: samplesForFrames(clip.source.in, sourceRate), rate: sourceRate },
          out: { samples: samplesForFrames(clip.source.out, sourceRate), rate: sourceRate },
        }
      : {
          in: { samples: 0, rate: outputSampleRate },
          out: { samples: durationSamples, rate: outputSampleRate },
        };
    if (clip !== undefined) {
      const speed = speedOf(clip);
      if (speed !== undefined) trimParams.speed = speed;
    }
    const trim = pushNode(nodes, nextId, "trim", [source.id], trimParams);
    audioInputs.push(trim.id);
    const startFrame = clip === undefined || mode === "sequential"
      ? 0
      : clipAnchorFrame(clip, target.id);
    const atOutputSample = samplesForFrames(
      { frames: startFrame, fps: outputFps },
      outputSampleRate,
    );
    audioSettings.push({
      durationSamples,
      stages: clip === undefined ? [] : clipAudioStages(clip, durationSamples),
      ...(mode === "anchored" ? { atOutputSample } : {}),
      ...(clip?.audio?.offset === undefined
        ? {}
        : {
            offsetSamples: resampleExactOffset(
              clip.audio.offset.samples,
              clip.audio.offset.rate,
              outputSampleRate,
            ),
          }),
      ...(clip?.loop?.enabled !== true
        ? {}
        : {
            loop: true,
            loopCrossfadeSamples: clip.loop.crossfade === undefined
              ? 0
              : samplesForFrames(clip.loop.crossfade, outputSampleRate),
            loopDurationSamples: Math.max(0, sourceCompositionDurationSamples - atOutputSample),
          }),
    });
    }

    for (const [index, clip] of target.clips.entries()) {
      if (mode === "sequential" && clip.gapBefore !== undefined) {
        addAudioSlot(undefined, clip.gapBefore);
      }
      const asset = project.assets.find(({ id }) => id === clip.asset);
      if (asset === undefined) {
        throw makeGuyditorError(
          "E_RENDER_UNFROZEN_GENERATION",
          `Clip ${clip.id} references absent asset ${clip.asset}.`,
          { affected: [clip.id, clip.asset] },
        );
      }
      const derived = byClip.get(clip.id);
      if (derived === undefined) graphInvalid(`No derived timeline entry exists for ${clip.id}.`, [clip.id]);
      addAudioSlot(asset, derived.duration, clip);
      const transition = target.clips[index - 1]?.transitionAfter;
      if (transition !== undefined && mode === "sequential") {
        audioSettings.at(-1)!.transitionFromPreviousSamples = samplesForFrames(
          transition.duration,
          outputSampleRate,
        );
      }
    }

    const stages = audioChainStages(layer?.audio?.chain);
    if (layer?.ducking?.enabled === true) {
      const overrides: ResolvedDuckingOverride[] = layer.ducking.overrides.map((point) => {
        const suppliedSample = options.duckingOverrideSamples?.[point.at];
        const suppliedFrame = options.anchorFrames?.[point.at];
        if (suppliedSample === undefined && suppliedFrame === undefined) {
          unsupported(`unresolved ducking override ${point.at}`, "Part 0 anchor resolver", [layer.id]);
        }
        return {
          at: {
            samples: suppliedSample ?? samplesForFrames(
              { frames: suppliedFrame!, fps: outputFps },
              outputSampleRate,
            ),
            rate: outputSampleRate,
          },
          gainDb: point.gainDb,
        };
      });
      const envelope = compileDuckingEnvelope({
        config: layer.ducking,
        speech: options.speechIntervals ?? [],
        overrides,
        duration: { samples: sourceCompositionDurationSamples, rate: outputSampleRate },
      });
      stages.push({
        stage: "duck",
        params: {
          sampleRate: outputSampleRate,
          envelope: envelope.map(({ at, gainDb }) => `${String(at.samples)}:${String(gainDb)}`).join(","),
        },
      });
    }
    return pushNode(nodes, nextId, "audiochain", audioInputs, {
      mode,
      durationSamples: sourceCompositionDurationSamples,
      stages,
      inputSettings: audioSettings,
    } satisfies AudioChainNodeParams);
  }

  const mainAudio = compileAudioSequence(sequence, "sequential");
  const roleAudio = project.layers
    .filter(({ enabled, kind, sequence: sequenceId }) =>
      enabled && (kind === "audio" || kind === "music" || kind === "ambience" || kind === "sfx") &&
      sequenceId !== undefined)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((layer) => {
      const layerSequence = project.sequences.find(({ id }) => id === layer.sequence);
      if (layerSequence === undefined) graphInvalid(`Audio layer ${layer.id} sequence is missing.`, [layer.id]);
      return compileAudioSequence(layerSequence, "anchored", layer);
    });
  const masterTarget = sequence.audio ?? { targetLufs: -14, truePeakDb: -1 };
  const masterAudio = pushNode(nodes, nextId, "audiochain", [mainAudio.id, ...roleAudio.map(({ id }) => id)], {
    mode: "mix",
    durationSamples: sourceCompositionDurationSamples,
    inputSettings: [mainAudio, ...roleAudio].map(() => ({
      durationSamples: sourceCompositionDurationSamples,
      stages: [],
    })),
    stages: [{
      stage: "loudnorm",
      params: {
        integratedLufs: masterTarget.targetLufs,
        truePeakDbtp: masterTarget.truePeakDb,
        loudnessRangeLu: 11,
        twoPass: true,
      },
    }],
  } satisfies AudioChainNodeParams);

  const encodedAudio = timelineInsertions.length === 0
    ? masterAudio
    : pushNode(nodes, nextId, "timeline-insert", [masterAudio.id], {
        stream: "audio",
        sourceDuration: samplesForFrames(
          { frames: sourceCompositionDurationFrames, fps: outputFps },
          outputSampleRate,
        ),
        outputDuration: compositionDurationSamples,
        insertions: timelineInsertions.map(({ sourceFrame, durationFrames }) => ({
          at: samplesForFrames(
            { frames: sourceFrame, fps: outputFps },
            outputSampleRate,
          ),
          duration: samplesForFrames(
            { frames: durationFrames, fps: outputFps },
            outputSampleRate,
          ),
        })),
      } satisfies TimelineInsertNodeParams);

  pushNode(nodes, nextId, "encode", [visualRoot.id, encodedAudio.id], {
    profileId: profile.id,
    profileVersion: profile.version,
    profileSha256,
    vcodec: profile.video.codec,
    vcodecParams: { crf: profile.video.crf },
    acodec: profile.audio.codec,
    abitrate: profile.audio.bitrate,
    pixFmt: profile.video.pixelFormat,
    container: profile.container,
  } satisfies EncodeNodeParams);

  const graph: RenderGraph = {
    graphVersion: "guyditor-rg/1",
    revision,
    deliverableId,
    variant,
    outputFps,
    outputSize,
    nodes,
    toolchain,
  };
  validateRenderGraph(graph);
  return graph;
}

export function validateRenderGraph(graph: RenderGraph): void {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!/^rn_[a-z2-7]{10}$/u.test(node.id)) graphInvalid(`Render node id ${node.id} is invalid.`, [node.id]);
    if (ids.has(node.id)) graphInvalid(`Render node id ${node.id} is duplicated.`, [node.id]);
    ids.add(node.id);
  }
  const encodeNodes = graph.nodes.filter((node) => node.kind === "encode");
  if (encodeNodes.length !== 1) graphInvalid("A render graph must contain exactly one encode root.");
  const referenced = new Set(graph.nodes.flatMap((node) => node.inputs));
  const roots = graph.nodes.filter((node) => !referenced.has(node.id));
  if (roots.length !== 1 || roots[0]!.id !== encodeNodes[0]!.id) {
    graphInvalid("The single encode node must be the render graph root.", roots.map((node) => node.id));
  }
  for (const node of graph.nodes) {
    for (const input of node.inputs) {
      if (!ids.has(input)) graphInvalid(`Render node ${node.id} references missing input ${input}.`, [node.id, input]);
    }
    if (
      node.kind === "composite" &&
      (node.params as CompositeNodeParams).inputSettings !== undefined &&
      (node.params as CompositeNodeParams).inputSettings!.length !== node.inputs.length
    ) {
      graphInvalid(`Composite ${node.id} input settings do not match its inputs.`, [node.id]);
    }
    if (node.kind === "timeline-insert") {
      const insertion = node.params as TimelineInsertNodeParams;
      if (
        node.inputs.length !== 1 ||
        !Number.isSafeInteger(insertion.sourceDuration) || insertion.sourceDuration < 1 ||
        !Number.isSafeInteger(insertion.outputDuration) || insertion.outputDuration <= insertion.sourceDuration ||
        insertion.insertions.length < 1
      ) {
        graphInvalid(`Timeline insertion ${node.id} has invalid duration metadata.`, [node.id]);
      }
      let previous = 0;
      let total = 0;
      for (const entry of insertion.insertions) {
        if (
          !Number.isSafeInteger(entry.at) || entry.at <= previous || entry.at >= insertion.sourceDuration ||
          !Number.isSafeInteger(entry.duration) || entry.duration < 1
        ) {
          graphInvalid(`Timeline insertion ${node.id} has an invalid insertion point.`, [node.id]);
        }
        previous = entry.at;
        total += entry.duration;
      }
      if (insertion.outputDuration !== insertion.sourceDuration + total) {
        graphInvalid(`Timeline insertion ${node.id} output duration is inconsistent.`, [node.id]);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  function visit(id: string): void {
    if (visiting.has(id)) graphInvalid(`Render graph cycle includes ${id}.`, [id]);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const input of byId.get(id)?.inputs ?? []) visit(input);
    visiting.delete(id);
    visited.add(id);
  }
  for (const node of graph.nodes) visit(node.id);
  const indexById = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  for (const [index, node] of graph.nodes.entries()) {
    for (const input of node.inputs) {
      if ((indexById.get(input) ?? index) >= index) {
        graphInvalid(`Render graph nodes are not topologically ordered at ${node.id}.`, [node.id, input]);
      }
    }
  }
}
