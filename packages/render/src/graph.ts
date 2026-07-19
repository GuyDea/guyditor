import { createHash } from "node:crypto";

import {
  convertTime,
  deriveTimeline,
  makeGuyditorError,
} from "../../core/src/index.js";
import type {
  Asset,
  Clip,
  Effect,
  FrameTime,
  GuyditorProject,
  KeySettings,
  Layer,
  PlacedItem,
  Transform2D,
} from "../../core/src/index.js";

import type {
  AudioChainNodeParams,
  CompositeNodeParams,
  EncodeNodeParams,
  KeyNodeParams,
  OverlayNodeParams,
  RenderGraph,
  RenderNode,
  RenderNodeKind,
  SourceNodeParams,
  ToolchainManifest,
  TransformNodeParams,
  TrimNodeParams,
} from "./ir.js";
import type { RenderProfile } from "./profile.js";

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
  options: CompileRenderGraphOptions,
): KeyNodeParams | undefined {
  if (settings.mode === "off") return undefined;
  if (settings.mode === "neural") {
    unsupported(`neural matte on ${clipId}`, "Part 6 §6.5 (deferred)", [clipId]);
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
    masks: settings.masks.map((mask) => {
      const supplied = options.maskAssets?.[mask.id];
      const hash = createHash("sha256").update(JSON.stringify(mask)).digest("hex");
      return {
        id: mask.id,
        role: mask.role,
        path: supplied?.path ?? `.guyditor/cache/masks/${hash}.png`,
        sha256: supplied?.sha256 ?? hash,
        animated: supplied?.animated ?? mask.frames !== undefined,
      };
    }),
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

function visualLayers(project: GuyditorProject): Layer[] {
  return project.layers
    .filter(({ enabled, kind }) => enabled && (
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
  for (const layer of visualLayers(project)) {
    if (layer.kind === "adjustment") {
      unsupported(`adjustment-layer color math on ${layer.id}`, "Part 6", [layer.id]);
    }
    if (layer.pip !== undefined) unsupported(`PiP on ${layer.id}`, "Part 6 §6.8", [layer.id]);
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
      if (clip.loop !== undefined) unsupported(`loop on ${clip.id}`, "Part 5", [clip.id]);
      if (clip.punchIn !== undefined) unsupported(`punch-in transform on ${clip.id}`, "Part 6", [clip.id]);
      for (const effect of clip.effects ?? []) {
        if (effect.kind === "freeze") unsupported(`freeze effect ${effect.id}`, "Part 6", [effect.id]);
        if (effect.kind !== "speed" && effect.kind !== "key" && effect.kind !== "transform") {
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
  const mainTimeline = deriveTimeline(project, sequence.id);
  if (!mainTimeline.ok) throw mainTimeline.error;
  const compositionDurationFrames = framesForSeconds(
    mainTimeline.value.duration,
    project.settings.timeline.fps,
  );
  const nodes: RenderNode[] = [];
  const nextId = idFactory(`${revision}:${deliverableId}:${variant}:${quality}`);
  const canvas = {
    w: project.settings.timeline.width,
    h: project.settings.timeline.height,
    background: "0x00000000",
  };
  const visualLayerCount = visualLayers(project).filter(({ kind }) =>
    kind === "video" || kind === "image").length;

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
      const key = keyParams(keyEffect.params as unknown as KeySettings, owner.id, options);
      if (key !== undefined) root = pushNode(nodes, nextId, "key", [root.id], key);
    }
    const transform = owner.effects?.find(({ kind }) => kind === "transform");
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
    return { nodeId: trim.id, durationFrames: outputFrames(duration, project.settings.timeline.fps) };
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
      const durationFrames = outputFrames(derived.duration, project.settings.timeline.fps);
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
                project.settings.timeline.fps,
              ),
            }),
      });
    }
    const durationFrames = framesForSeconds(timeline.value.duration, project.settings.timeline.fps);
    const root = pushNode(nodes, nextId, "composite", inputs.map(({ nodeId }) => nodeId), {
      canvas,
      mode: "timeline.sequential",
      durationFrames,
      inputSettings: inputs.map(({ durationFrames: duration, transitionFromPreviousFrames }) => ({
        durationFrames: duration,
        ...(transitionFromPreviousFrames === undefined ? {} : { transitionFromPreviousFrames }),
      })),
    } satisfies CompositeNodeParams);
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
        project.settings.timeline.fps,
        compositionDurationFrames,
      );
      let source: { in: FrameTime; out: FrameTime };
      if (item.source !== undefined && "in" in item.source) {
        source = item.source;
      } else if (asset.kind === "image" || asset.image !== undefined) {
        source = {
          in: { frames: 0, fps: project.settings.timeline.fps },
          out: { frames: durationFrames, fps: project.settings.timeline.fps },
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
        atOutputFrame: itemStart(item, sequence.id, project.settings.timeline.fps),
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
    return compiled;
  }

  const ordered = visualLayers(project);
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
    layerInputs.push({ ...compiled, layer });
  }

  const topComposite = pushNode(nodes, nextId, "composite", layerInputs.map(({ root }) => root.id), {
    canvas: {
      w: project.settings.timeline.width,
      h: project.settings.timeline.height,
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

  let visualRoot = topComposite;
  for (const overlay of options.graphicOverlays ?? []) {
    visualRoot = pushNode(nodes, nextId, "overlay", [visualRoot.id], structuredClone(overlay));
  }
  if (variant === "burnin") {
    for (const overlay of options.overlays ?? []) {
      visualRoot = pushNode(nodes, nextId, "overlay", [visualRoot.id], structuredClone(overlay));
    }
  }

  const audioInputs: string[] = [];
  const audioSettings: NonNullable<AudioChainNodeParams["inputSettings"]> = [];
  function addAudioSlot(asset: Asset | undefined, duration: FrameTime, clip?: Clip): void {
    const hasAudio = asset !== undefined && ((asset.audio?.length ?? 0) > 0 || asset.probe.audio !== undefined);
    const rate = hasAudio
      ? actualAudioRate(asset, project.settings.audio.sampleRate)
      : project.settings.audio.sampleRate;
    const source = pushNode(nodes, nextId, "source", [], {
      assetId: hasAudio ? asset.id : VIRTUAL_SILENCE_ASSET,
      assetSha256: hasAudio ? asset.sha256 : "0".repeat(64),
      stream: "audio",
      path: hasAudio ? asset.path : "",
      useProxy: false,
    } satisfies SourceNodeParams);
    const durationSamples = samplesForFrames(duration, rate);
    const trimParams: TrimNodeParams = hasAudio && clip !== undefined
      ? {
          in: { samples: samplesForFrames(clip.source.in, rate), rate },
          out: { samples: samplesForFrames(clip.source.out, rate), rate },
        }
      : {
          in: { samples: 0, rate },
          out: { samples: durationSamples, rate },
        };
    if (clip !== undefined) {
      const speed = speedOf(clip);
      if (speed !== undefined) trimParams.speed = speed;
    }
    const trim = pushNode(nodes, nextId, "trim", [source.id], trimParams);
    audioInputs.push(trim.id);
    audioSettings.push({ durationSamples });
  }

  const mainByClip = new Map(mainTimeline.value.clips.map((entry) => [entry.clipId, entry] as const));
  for (const [index, clip] of sequence.clips.entries()) {
    if (clip.gapBefore !== undefined) addAudioSlot(undefined, clip.gapBefore);
    const asset = project.assets.find(({ id }) => id === clip.asset);
    if (asset === undefined) {
      throw makeGuyditorError(
        "E_RENDER_UNFROZEN_GENERATION",
        `Clip ${clip.id} references absent asset ${clip.asset}.`,
        { affected: [clip.id, clip.asset] },
      );
    }
    const derived = mainByClip.get(clip.id);
    if (derived === undefined) graphInvalid(`No derived timeline entry exists for ${clip.id}.`, [clip.id]);
    addAudioSlot(asset, derived.duration, clip);
    const transition = sequence.clips[index - 1]?.transitionAfter;
    if (transition !== undefined) {
      audioSettings.at(-1)!.transitionFromPreviousSamples = samplesForFrames(
        transition.duration,
        audioSettings.at(-1)!.durationSamples === 0
          ? project.settings.audio.sampleRate
          : project.settings.audio.sampleRate,
      );
    }
  }
  const audiochain = pushNode(nodes, nextId, "audiochain", audioInputs, {
    stages: [],
    inputSettings: audioSettings,
  } satisfies AudioChainNodeParams);

  pushNode(nodes, nextId, "encode", [visualRoot.id, audiochain.id], {
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
    outputFps: project.settings.timeline.fps,
    outputSize: { w: project.settings.timeline.width, h: project.settings.timeline.height },
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
