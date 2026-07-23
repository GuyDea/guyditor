import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  Annotation,
  Asset,
  Clip,
  Effect,
  FrameTime,
  GuyditorProject,
  Layer,
  Rational,
} from "../../core/src/index.js";

export interface OtioExportOptions {
  deliverableId: string;
  revision: string;
  mediaPaths: "absolute" | "relative";
  includeBeatsAsMarkers: boolean;
  includeAnnotationsAsMarkers: boolean;
}

export interface OtioLoss {
  construct: string;
  ids: string[];
  disposition: string;
}

export interface OtioExportResult {
  path: string;
  sha256: string;
  losses: OtioLoss[];
}

export interface OtioRationalTime {
  OTIO_SCHEMA: "RationalTime.1";
  value: number;
  rate: number;
}

export interface OtioTimeRange {
  OTIO_SCHEMA: "TimeRange.1";
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
}

export interface OtioEffect {
  OTIO_SCHEMA: "LinearTimeWarp.1" | "FreezeFrame.1";
  name: string;
  effect_name: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
  time_scalar?: number;
}

export interface OtioItem {
  OTIO_SCHEMA: "Clip.2" | "Gap.1" | "Transition.1";
  name: string;
  metadata: Record<string, unknown>;
  source_range?: OtioTimeRange;
  effects?: OtioEffect[];
  media_references?: Record<"DEFAULT_MEDIA", {
    OTIO_SCHEMA: "ExternalReference.1";
    name: string;
    available_range: null;
    available_image_bounds: null;
    metadata: Record<string, unknown>;
    target_url: string;
  }>;
  active_media_reference_key?: "DEFAULT_MEDIA";
  transition_type?: "SMPTE_Dissolve" | "Custom_Transition";
  in_offset?: OtioRationalTime;
  out_offset?: OtioRationalTime;
}

export interface OtioMarker {
  OTIO_SCHEMA: "Marker.2";
  name: string;
  color: "GREEN" | "RED";
  marked_range: OtioTimeRange;
  metadata: Record<string, unknown>;
}

export interface OtioTrack {
  OTIO_SCHEMA: "Track.1";
  name: string;
  metadata: Record<string, unknown>;
  source_range: null;
  effects: never[];
  markers: never[];
  enabled: boolean;
  children: OtioItem[];
  kind: "Video" | "Audio";
}

export interface OtioTimeline {
  OTIO_SCHEMA: "Timeline.1";
  name: string;
  metadata: {
    guyditor: {
      canonical: false;
      format: "guyditor/v1";
      revision: string;
      deliverableId: string;
      losses: OtioLoss[];
      canonicalFragments: Record<string, unknown>;
    };
  };
  global_start_time: OtioRationalTime;
  tracks: {
    OTIO_SCHEMA: "Stack.1";
    name: string;
    metadata: Record<string, unknown>;
    source_range: null;
    effects: never[];
    markers: OtioMarker[];
    enabled: true;
    children: OtioTrack[];
  };
}

export interface OtioExportContext {
  annotations: Annotation[];
  outputPath: string;
  projectRoot: string;
  resolveAnchor(anchor: string): Promise<FrameTime | undefined>;
  resolveAnnotation?(annotation: Annotation): Promise<FrameTime | undefined>;
}

export interface OtioExportPlan {
  path: string;
  losses: OtioLoss[];
  timeline: OtioTimeline;
}

function rationalNumber(value: Rational): number {
  const match = /^(?<numerator>-?\d+)\/(?<denominator>\d+)$/u.exec(value);
  if (match?.groups === undefined) throw new Error(`Invalid rational: ${value}`);
  const denominator = Number(match.groups.denominator);
  if (denominator === 0) throw new Error(`Invalid rational denominator: ${value}`);
  return Number(match.groups.numerator) / denominator;
}

function otioTime(value: number, fps: Rational): OtioRationalTime {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate: rationalNumber(fps) };
}

function timeRange(start: FrameTime, durationFrames: number): OtioTimeRange {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    start_time: otioTime(start.frames, start.fps),
    duration: otioTime(durationFrames, start.fps),
  };
}

function assetPath(asset: Asset, context: OtioExportContext, mode: "absolute" | "relative"): string {
  const absolute = isAbsolute(asset.path) ? asset.path : resolve(context.projectRoot, asset.path);
  if (mode === "absolute") return pathToFileURL(absolute).href;
  const value = relative(dirname(context.outputPath), absolute).split("\\").join("/");
  return value === "" ? basename(absolute) : value;
}

function mappedEffects(effects: Effect[] | undefined): OtioEffect[] {
  const mapped: OtioEffect[] = [];
  for (const effect of effects ?? []) {
    if (effect.kind === "speed" && typeof effect.params.rate === "string") {
      mapped.push({
        OTIO_SCHEMA: "LinearTimeWarp.1",
        name: effect.id,
        effect_name: "LinearTimeWarp",
        enabled: true,
        metadata: { guyditor: { effectId: effect.id, params: effect.params } },
        time_scalar: rationalNumber(effect.params.rate as Rational),
      });
    } else if (effect.kind === "freeze") {
      mapped.push({
        OTIO_SCHEMA: "FreezeFrame.1",
        name: effect.id,
        effect_name: "FreezeFrame",
        enabled: true,
        metadata: { guyditor: { effectId: effect.id, params: effect.params } },
      });
    }
  }
  return mapped;
}

function clipItem(clip: Clip, asset: Asset, context: OtioExportContext, options: OtioExportOptions): OtioItem {
  const effects = mappedEffects(clip.effects);
  return {
    OTIO_SCHEMA: "Clip.2",
    name: clip.id,
    metadata: {
      guyditor: {
        clipId: clip.id,
        sourceFps: clip.source.in.fps,
        canonicalEffects: clip.effects ?? [],
        semanticAnchor: clip.anchor ?? null,
      },
    },
    source_range: timeRange(clip.source.in, clip.source.out.frames - clip.source.in.frames),
    effects,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: asset.id,
        available_range: null,
        available_image_bounds: null,
        metadata: { guyditor: { assetId: asset.id, sha256: asset.sha256 } },
        target_url: assetPath(asset, context, options.mediaPaths),
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
  };
}

function transitionItem(clip: Clip): OtioItem | undefined {
  const transition = clip.transitionAfter;
  if (transition === undefined) return undefined;
  const duration = transition.duration.frames;
  const dissolve = transition.preset === "crossfade" || transition.preset === "audio-crossfade";
  return {
    OTIO_SCHEMA: "Transition.1",
    name: transition.id,
    metadata: {
      guyditor: {
        preset: transition.preset,
        params: transition.params ?? {},
        intent: transition.intent ?? null,
        durationFps: transition.duration.fps,
      },
    },
    transition_type: dissolve ? "SMPTE_Dissolve" : "Custom_Transition",
    in_offset: otioTime(Math.floor(duration / 2), transition.duration.fps),
    out_offset: otioTime(Math.ceil(duration / 2), transition.duration.fps),
  };
}

function trackItems(
  clips: Clip[],
  assets: Map<string, Asset>,
  context: OtioExportContext,
  options: OtioExportOptions,
): OtioItem[] {
  const items: OtioItem[] = [];
  for (const clip of clips) {
    if (clip.gapBefore !== undefined && clip.gapBefore.frames > 0) {
      items.push({
        OTIO_SCHEMA: "Gap.1",
        name: `gap-before-${clip.id}`,
        metadata: { guyditor: { clipId: clip.id, fps: clip.gapBefore.fps } },
        source_range: timeRange({ frames: 0, fps: clip.gapBefore.fps }, clip.gapBefore.frames),
      });
    }
    const asset = assets.get(clip.asset);
    if (asset === undefined) throw new Error(`OTIO export clip ${clip.id} references missing asset ${clip.asset}.`);
    items.push(clipItem(clip, asset, context, options));
    const transition = transitionItem(clip);
    if (transition !== undefined) items.push(transition);
  }
  return items;
}

function isAudioLayer(layer: Layer): boolean {
  return ["audio", "music", "ambience", "sfx"].includes(layer.kind);
}

function collectLosses(project: GuyditorProject, annotations: Annotation[]): OtioLoss[] {
  const clips = project.sequences.flatMap((sequence) => sequence.clips);
  const effects = clips.flatMap((clip) => clip.effects ?? []);
  const nonlinear = effects.filter((effect) => effect.kind === "speed" && typeof effect.params.curve !== "undefined");
  const opaqueEffects = effects.filter((effect) => effect.kind !== "speed" && effect.kind !== "freeze");
  const semanticIds = [
    ...project.beats.map(({ id }) => id),
    ...clips.filter(({ anchor }) => anchor !== undefined).map(({ id }) => id),
    ...annotations.map(({ id }) => id),
  ];
  return [
    {
      construct: "review-annotations",
      ids: annotations.map(({ id }) => id),
      disposition: "Lifecycle and geometry stay canonical-only; optional flat red markers carry note text.",
    },
    {
      construct: "agent-provenance",
      ids: [
        ...project.assets.filter(({ provenance }) => provenance !== undefined).map(({ id }) => id),
        ...project.skills.map(({ id }) => id),
      ],
      disposition: "Provenance, transactions, proposals, skills, and preset versions are opaque metadata only.",
    },
    {
      construct: "responsive-layouts",
      ids: project.layers.filter(({ pip }) => pip !== undefined).map(({ id }) => id),
      disposition: "Only the selected deliverable geometry survives; sibling responsive layouts are dropped.",
    },
    {
      construct: "semantic-anchors",
      ids: semanticIds,
      disposition: "Word, beat, annotation, and clip-relative anchors resolve to absolute frame markers.",
    },
    {
      construct: "effects",
      ids: [...opaqueEffects, ...nonlinear].map(({ id }) => id),
      disposition: "Only linear speed and freeze are native; other effect parameters remain opaque metadata.",
    },
    {
      construct: "captions",
      ids: project.captions.map(({ id }) => id),
      disposition: "Caption styling and word timing stay canonical-only; use burned video or caption sidecars.",
    },
  ];
}

async function collectMarkers(
  project: GuyditorProject,
  deliverableId: string,
  annotations: Annotation[],
  options: OtioExportOptions,
  context: OtioExportContext,
): Promise<OtioMarker[]> {
  const markers: OtioMarker[] = [];
  if (options.includeBeatsAsMarkers) {
    for (const beat of project.beats) {
      const at = await context.resolveAnchor(beat.anchor);
      if (at === undefined) continue;
      markers.push({
        OTIO_SCHEMA: "Marker.2",
        name: beat.name,
        color: "GREEN",
        marked_range: timeRange(at, 0),
        metadata: { guyditor: { beatId: beat.id, semanticAnchor: beat.anchor } },
      });
    }
  }
  if (options.includeAnnotationsAsMarkers) {
    for (const annotation of annotations) {
      if (annotation.canvasRef.deliverableId !== undefined && annotation.canvasRef.deliverableId !== deliverableId) {
        continue;
      }
      const at = await context.resolveAnnotation?.(annotation);
      if (at === undefined) continue;
      markers.push({
        OTIO_SCHEMA: "Marker.2",
        name: annotation.body,
        color: "RED",
        marked_range: timeRange(at, annotation.extent.frames),
        metadata: {
          guyditor: {
            annotationId: annotation.id,
            body: annotation.body,
            state: annotation.state,
            blocking: annotation.blocking,
          },
        },
      });
    }
  }
  return markers;
}

export async function buildOtioExport(
  project: GuyditorProject,
  options: OtioExportOptions,
  context: OtioExportContext,
): Promise<OtioExportPlan> {
  if (extname(context.outputPath).toLowerCase() !== ".otio") {
    throw new Error("OpenTimelineIO exports must use the .otio extension.");
  }
  const deliverable = project.deliverables.find(({ id }) => id === options.deliverableId);
  if (deliverable === undefined) throw new Error(`Unknown deliverable: ${options.deliverableId}`);
  const sequence = project.sequences.find(({ id }) => id === deliverable.sequenceId);
  if (sequence === undefined) throw new Error(`Deliverable ${deliverable.id} references a missing sequence.`);

  const losses = collectLosses(project, context.annotations);
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const layers = project.layers
    .filter((layer) => layer.sequence === sequence.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const tracks: OtioTrack[] = layers.map((layer) => ({
    OTIO_SCHEMA: "Track.1",
    name: layer.name,
    metadata: { guyditor: { layerId: layer.id, kind: layer.kind, order: layer.order } },
    source_range: null,
    effects: [],
    markers: [],
    enabled: layer.enabled,
    children: trackItems(sequence.clips, assets, context, options),
    kind: isAudioLayer(layer) ? "Audio" : "Video",
  }));
  const markers = await collectMarkers(
    project,
    deliverable.id,
    context.annotations,
    options,
    context,
  );

  return {
    path: context.outputPath,
    losses,
    timeline: {
      OTIO_SCHEMA: "Timeline.1",
      name: deliverable.name,
      metadata: {
        guyditor: {
          canonical: false,
          format: "guyditor/v1",
          revision: options.revision,
          deliverableId: deliverable.id,
          losses,
          canonicalFragments: {
            deliverable,
            captions: project.captions,
            annotations: context.annotations.map(({ id, state, blocking, anchor, extent, canvasRef }) => ({
              id,
              state,
              blocking,
              anchor,
              extent,
              canvasRef,
            })),
            layers,
            beats: project.beats,
            presets: project.presets,
            skills: project.skills,
            sidecars: project.sidecars,
          },
        },
      },
      global_start_time: otioTime(0, project.settings.timeline.fps),
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        name: `${deliverable.name} tracks`,
        metadata: {},
        source_range: null,
        effects: [],
        markers,
        enabled: true,
        children: tracks,
      },
    },
  };
}

export async function writeOtioExport(
  project: GuyditorProject,
  options: OtioExportOptions,
  context: OtioExportContext,
): Promise<OtioExportResult> {
  const plan = await buildOtioExport(project, options, context);
  const serialized = `${JSON.stringify(plan.timeline, null, 2)}\n`;
  await mkdir(dirname(plan.path), { recursive: true });
  const temporary = join(dirname(plan.path), `.${basename(plan.path)}.${process.pid}.tmp`);
  await writeFile(temporary, serialized, "utf8");
  await rename(temporary, plan.path);
  return {
    path: plan.path,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    losses: plan.losses,
  };
}
