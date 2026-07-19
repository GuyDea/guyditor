import { createHash } from "node:crypto";

import {
  convertTime,
  deriveTimeline,
  makeGuyditorError,
} from "../../core/src/index.js";
import type {
  Asset,
  Clip,
  FrameTime,
  GuyditorProject,
} from "../../core/src/index.js";

import type {
  AudioChainNodeParams,
  CompositeNodeParams,
  EncodeNodeParams,
  OverlayNodeParams,
  RenderGraph,
  RenderNode,
  RenderNodeKind,
  SourceNodeParams,
  ToolchainManifest,
  TrimNodeParams,
} from "./ir.js";
import type { RenderProfile } from "./profile.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const VIRTUAL_GAP_ASSET = "__guyditor_gap__";
export const VIRTUAL_SILENCE_ASSET = "__guyditor_silence__";

export interface CompileRenderGraphOptions {
  project: GuyditorProject;
  revision: string;
  deliverableId: string;
  variant: "burnin" | "clean" | "preview";
  quality: "proxy" | "high";
  profile: RenderProfile;
  profileSha256: string;
  toolchain: ToolchainManifest;
  overlays?: readonly OverlayNodeParams[];
}

function unsupported(feature: string, part: string, affected: readonly string[] = []): never {
  throw makeGuyditorError(
    "E_RENDER_UNSUPPORTED",
    `${feature} is unsupported by the M0 renderer; ${part} owns this feature.`,
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
  if (match === null || match[2] === "0") {
    graphInvalid(`Invalid exact rational ${value}.`);
  }
  return { numerator: BigInt(match[1]!), denominator: BigInt(match[2]!) };
}

function safeNumber(value: bigint, feature: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    unsupported(`${feature} outside exact M0 integer bounds`, "Part 2");
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

function speedOf(clip: Clip): { num: number; den: number } | undefined {
  const speedEffects = (clip.effects ?? []).filter((effect) => effect.kind === "speed");
  if (speedEffects.length === 0) return undefined;
  if (speedEffects.length > 1) {
    unsupported(`multiple speed effects on ${clip.id}`, "Part 6", [clip.id]);
  }
  const value = speedEffects[0]!.params["rate"];
  if (typeof value !== "string") {
    unsupported(`non-rational speed effect on ${clip.id}`, "Part 6", [clip.id]);
  }
  const parts = rationalParts(value);
  if (parts.numerator <= 0n) {
    unsupported(`non-positive speed effect on ${clip.id}`, "Part 6", [clip.id]);
  }
  return {
    num: safeNumber(parts.numerator, "speed numerator"),
    den: safeNumber(parts.denominator, "speed denominator"),
  };
}

function assertSupportedSubset(project: GuyditorProject, deliverableId: string, quality: "proxy" | "high") {
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
  const sequenceLayers = project.layers.filter((layer) =>
    layer.enabled && layer.sequence === sequence.id
  );
  const videoLayers = sequenceLayers.filter((layer) => layer.kind === "video");
  if (videoLayers.length !== 1) {
    unsupported(
      videoLayers.length > 1 ? "multiple video layers" : "a sequence without one video layer",
      "Part 6",
      videoLayers.map((layer) => layer.id),
    );
  }
  for (const layer of project.layers.filter((item) => item.enabled)) {
    if (layer.items !== undefined) {
      const overlayLayer = layer.kind === "text" || layer.kind === "image" || layer.kind === "animation";
      unsupported(
        overlayLayer ? `overlay items layer ${layer.id}` : `items layers (${layer.id})`,
        overlayLayer ? "Part 7" : "Part 6",
        [layer.id],
      );
    }
    if (layer.kind !== "video" && layer.kind !== "caption") {
      unsupported(`${layer.kind} layer ${layer.id}`, "Part 6", [layer.id]);
    }
    if (layer.transform !== undefined || layer.opacity !== undefined || layer.blend !== undefined ||
        layer.matte !== undefined || layer.pip !== undefined || layer.adjustment !== undefined ||
        layer.ducking !== undefined) {
      unsupported(`transforms/compositing on ${layer.id}`, "Part 6", [layer.id]);
    }
  }
  for (const clip of sequence.clips) {
    if (clip.transitionAfter !== undefined) unsupported(`transition ${clip.transitionAfter.id}`, "Part 5", [clip.transitionAfter.id]);
    if (clip.overlapPrevious !== undefined) unsupported(`overlap before ${clip.id}`, "Part 5", [clip.id]);
    if (clip.loop !== undefined) unsupported(`loop on ${clip.id}`, "Part 5", [clip.id]);
    if (clip.punchIn !== undefined) unsupported(`transform on ${clip.id}`, "Part 6", [clip.id]);
    if (clip.audio !== undefined && Object.keys(clip.audio).length > 0) {
      unsupported(`per-clip audio processing on ${clip.id}`, "Part 5", [clip.id]);
    }
    for (const effect of clip.effects ?? []) {
      if (effect.kind === "freeze") unsupported(`freeze effect ${effect.id}`, "Part 6", [effect.id]);
      if (effect.kind !== "speed") unsupported(`${effect.kind} effect ${effect.id}`, "Part 6", [effect.id]);
    }
  }
  return { deliverable, sequence };
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

export function compileRenderGraph(options: CompileRenderGraphOptions): RenderGraph {
  const { project, revision, deliverableId, variant, quality, profile, profileSha256, toolchain } = options;
  if (revision !== project.revision) {
    graphInvalid(`Loaded revision ${project.revision} does not match requested ${revision}.`, [revision]);
  }
  const { deliverable, sequence } = assertSupportedSubset(project, deliverableId, quality);
  if (deliverable.profile !== `${profile.id}@${profile.version}`) {
    unsupported(`profile pin ${deliverable.profile}`, "Part 11", [deliverable.id]);
  }
  const timeline = deriveTimeline(project, sequence.id);
  if (!timeline.ok) throw timeline.error;
  const timelineByClip = new Map(timeline.value.clips.map((clip) => [clip.clipId, clip] as const));
  const nodes: RenderNode[] = [];
  const nextId = idFactory(`${revision}:${deliverableId}:${variant}:${quality}`);
  const videoInputs: string[] = [];
  const audioInputs: string[] = [];

  function addVirtualSlot(
    assetId: string,
    duration: FrameTime,
  ): void {
    const videoSource = pushNode(nodes, nextId, "source", [], {
      assetId,
      assetSha256: "0".repeat(64),
      stream: "video",
      path: "",
      useProxy: false,
    } satisfies SourceNodeParams);
    const videoTrim = pushNode(nodes, nextId, "trim", [videoSource.id], {
      in: { frames: 0, fps: duration.fps },
      out: duration,
    } satisfies TrimNodeParams);
    const audioSource = pushNode(nodes, nextId, "source", [], {
      assetId,
      assetSha256: "0".repeat(64),
      stream: "audio",
      path: "",
      useProxy: false,
    } satisfies SourceNodeParams);
    const samples = samplesForFrames(duration, project.settings.audio.sampleRate);
    const audioTrim = pushNode(nodes, nextId, "trim", [audioSource.id], {
      in: { samples: 0, rate: project.settings.audio.sampleRate },
      out: { samples, rate: project.settings.audio.sampleRate },
    } satisfies TrimNodeParams);
    videoInputs.push(videoTrim.id);
    audioInputs.push(audioTrim.id);
  }

  for (const clip of sequence.clips) {
    if (clip.gapBefore !== undefined) {
      const converted = convertTime(clip.gapBefore, project.settings.timeline.fps);
      if (!converted.ok) unsupported(`incommensurate gap before ${clip.id}`, "Part 2", [clip.id]);
      addVirtualSlot(VIRTUAL_GAP_ASSET, converted.value);
    }
    const asset = project.assets.find((item) => item.id === clip.asset);
    if (asset === undefined) {
      throw makeGuyditorError(
        "E_RENDER_UNFROZEN_GENERATION",
        `Clip ${clip.id} references absent asset ${clip.asset}.`,
        { affected: [clip.id, clip.asset] },
      );
    }
    const speed = speedOf(clip);
    const audioOnly = asset.kind === "audio";
    const videoSource = pushNode(nodes, nextId, "source", [], {
      assetId: audioOnly ? VIRTUAL_GAP_ASSET : asset.id,
      assetSha256: audioOnly ? "0".repeat(64) : asset.sha256,
      stream: "video",
      path: audioOnly ? "" : asset.path,
      useProxy: false,
    } satisfies SourceNodeParams);
    const videoTrimParams: TrimNodeParams = { in: clip.source.in, out: clip.source.out };
    if (speed !== undefined) videoTrimParams.speed = speed;
    const videoTrim = pushNode(nodes, nextId, "trim", [videoSource.id], videoTrimParams);
    videoInputs.push(videoTrim.id);

    if ((asset.audio?.length ?? 0) > 0 || asset.probe.audio !== undefined) {
      const rate = actualAudioRate(asset, project.settings.audio.sampleRate);
      const audioSource = pushNode(nodes, nextId, "source", [], {
        assetId: asset.id,
        assetSha256: asset.sha256,
        stream: "audio",
        path: asset.path,
        useProxy: false,
      } satisfies SourceNodeParams);
      const audioTrimParams: TrimNodeParams = {
        in: { samples: samplesForFrames(clip.source.in, rate), rate },
        out: { samples: samplesForFrames(clip.source.out, rate), rate },
      };
      if (speed !== undefined) audioTrimParams.speed = speed;
      const audioTrim = pushNode(nodes, nextId, "trim", [audioSource.id], audioTrimParams);
      audioInputs.push(audioTrim.id);
    } else {
      const derived = timelineByClip.get(clip.id);
      if (derived === undefined) graphInvalid(`No derived timeline entry exists for ${clip.id}.`, [clip.id]);
      const audioSource = pushNode(nodes, nextId, "source", [], {
        assetId: VIRTUAL_SILENCE_ASSET,
        assetSha256: "0".repeat(64),
        stream: "audio",
        path: "",
        useProxy: false,
      } satisfies SourceNodeParams);
      const samples = samplesForFrames(derived.duration, project.settings.audio.sampleRate);
      const audioTrim = pushNode(nodes, nextId, "trim", [audioSource.id], {
        in: { samples: 0, rate: project.settings.audio.sampleRate },
        out: { samples, rate: project.settings.audio.sampleRate },
      } satisfies TrimNodeParams);
      audioInputs.push(audioTrim.id);
    }
  }

  const composite = pushNode(nodes, nextId, "composite", videoInputs, {
    canvas: {
      w: project.settings.timeline.width,
      h: project.settings.timeline.height,
      background: "black",
    },
  } satisfies CompositeNodeParams);
  let visualRoot = composite;
  if (variant === "burnin") {
    for (const overlay of options.overlays ?? []) {
      visualRoot = pushNode(nodes, nextId, "overlay", [visualRoot.id], structuredClone(overlay));
    }
  }
  const audiochain = pushNode(nodes, nextId, "audiochain", audioInputs, {
    stages: [],
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
