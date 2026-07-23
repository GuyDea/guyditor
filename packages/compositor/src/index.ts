import {
  deriveTimeline,
  failure,
  makeGuyditorError,
  makeId,
  success,
} from "../../core/src/index.js";
import type {
  DispatchedOperationApplication,
  GuyditorProject,
  IdPrefix,
  Layer,
  OperationDispatcher,
  OperationContext,
  OperationInput,
  NeuralMatteParams,
  PipConfig,
  PipKeyframe,
  PipStyle,
  PlacementConstraints,
  PresetPin,
  AvoidRegion,
  PlacedItem,
  Result,
} from "../../core/src/index.js";
import { formatPlacementConstraints, solvePlacement } from "./placement.js";
import { motionPreset, motionPresetPin } from "./motion.js";

export * from "./placement.js";
export * from "./motion.js";
export * from "./avoidance.js";
export * from "./pip-operation.js";

export interface PresenterArrangement {
  id: string;
  version: number;
  name:
    | "presenter_over_background"
    | "presenter_over_screen"
    | "presenter_front_of_animation"
    | "presenter_sandwich"
    | "presenter_side_by_side";
  roles: Array<{
    role: "presenter" | "background" | "screen" | "animation" | "foreground" | "content";
    kind: Layer["kind"];
    defaultKey?: boolean;
  }>;
}

export const PRESENTER_ARRANGEMENTS: readonly PresenterArrangement[] = Object.freeze([
  {
    id: "pre_aaaaaaaaaa",
    version: 1,
    name: "presenter_over_background",
    roles: [
      { role: "background", kind: "image" },
      { role: "presenter", kind: "video", defaultKey: true },
    ],
  },
  {
    id: "pre_bbbbbbbbbb",
    version: 1,
    name: "presenter_over_screen",
    roles: [
      { role: "screen", kind: "video" },
      { role: "presenter", kind: "video", defaultKey: true },
    ],
  },
  {
    id: "pre_cccccccccc",
    version: 1,
    name: "presenter_front_of_animation",
    roles: [
      { role: "animation", kind: "animation" },
      { role: "presenter", kind: "video", defaultKey: true },
    ],
  },
  {
    id: "pre_dddddddddd",
    version: 1,
    name: "presenter_sandwich",
    roles: [
      { role: "background", kind: "image" },
      { role: "presenter", kind: "video", defaultKey: true },
      { role: "foreground", kind: "image" },
    ],
  },
  {
    id: "pre_eeeeeeeeee",
    version: 1,
    name: "presenter_side_by_side",
    roles: [
      { role: "background", kind: "image" },
      { role: "content", kind: "image" },
      { role: "presenter", kind: "video", defaultKey: true },
    ],
  },
]);

export interface ArrangeCompositionParams {
  sequenceId: string;
  arrangementRef: string;
  assignments: Record<string, string>;
  at?: string;
  restoreLayers?: Layer[];
}

export interface CompositorModelOptions {
  idFactory?: (prefix: IdPrefix) => string;
  onKeyQcRun?: (request: { project: GuyditorProject; clipId: string; shotBoundaries: number[] }) => void;
  onMatteGenerate?: (request: {
    project: GuyditorProject;
    clipId: string;
    neural: NeuralMatteParams;
    shotBoundaries: number[];
  }) => void;
}

interface PipOperationParams {
  layerId: string;
  placement?: PlacementConstraints;
  style?: PipStyle;
  keyframe?: PipKeyframe;
  keyframeId?: string;
  at?: string;
  presetId?: string;
  version?: number;
  durationFrames?: number;
  params?: PipKeyframe["transition"] extends { params?: infer P } ? P : never;
  restorePip?: PipConfig | null;
  restorePresets?: PresetPin[];
}

interface RegionMarkParams {
  region: AvoidRegion;
  restoreRegions?: AvoidRegion[];
}

const DEFAULT_PLACEMENT: PlacementConstraints = {
  anchor: "bottom_right",
  width: "24%",
  margin: "4%",
};

function initialPip(placement = DEFAULT_PLACEMENT): PipConfig {
  return {
    style: { mask: { shape: "none" } },
    placement: { base: structuredClone(placement) },
    keyframes: [],
  };
}

function findPipLayer(project: GuyditorProject, layerId: string): Result<Layer> {
  const layer = project.layers.find(({ id }) => id === layerId);
  if (layer === undefined) {
    return compositorFailure("E_OP_NOT_FOUND", `Layer ${layerId} does not exist.`, [layerId]);
  }
  if (layer.locked) {
    return compositorFailure("E_OP_LAYER_LOCKED", `Layer ${layerId} is locked.`, [layerId]);
  }
  if (layer.kind !== "video" && layer.kind !== "image" && layer.kind !== "animation") {
    return compositorFailure("E_OP_SCHEMA", `Layer ${layerId} cannot contain a PiP.`, [layerId]);
  }
  return success(layer);
}

function replaceLayer(project: GuyditorProject, replacement: Layer): GuyditorProject {
  return {
    ...project,
    layers: project.layers.map((layer) => layer.id === replacement.id ? replacement : layer),
  };
}

function compositorFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
): Result<never> {
  return failure(makeGuyditorError(code, message, { affected }));
}

function durationFrames(project: GuyditorProject, sequenceId: string): number {
  const timeline = deriveTimeline(project, sequenceId);
  if (!timeline.ok) return 1;
  const [durationNumerator = "0", durationDenominator = "1"] = timeline.value.duration.split("/");
  const [fpsNumerator = "1", fpsDenominator = "1"] = project.settings.timeline.fps.split("/");
  const numerator = BigInt(durationNumerator) * BigInt(fpsNumerator);
  const denominator = BigInt(durationDenominator) * BigInt(fpsDenominator);
  return Math.max(1, Number(numerator / denominator));
}

function assetItem(
  project: GuyditorProject,
  sequenceId: string,
  assetId: string,
  idFactory: (prefix: IdPrefix) => string,
): Result<PlacedItem> {
  const asset = project.assets.find(({ id }) => id === assetId);
  if (asset === undefined) {
    return compositorFailure("E_OP_NOT_FOUND", `Asset ${assetId} does not exist.`, [assetId]);
  }
  const item: PlacedItem = {
    id: idFactory("clp"),
    asset: assetId,
    at: `timeline:${sequenceId}@0`,
    duration: {
      frames: durationFrames(project, sequenceId),
      fps: project.settings.timeline.fps,
    },
  };
  if (asset.kind !== "image" && asset.probe.duration !== undefined && "frames" in asset.probe.duration) {
    item.source = {
      in: { frames: 0, fps: asset.probe.duration.fps },
      out: structuredClone(asset.probe.duration),
    };
  }
  return success(item);
}

export class CompositorModel {
  readonly #idFactory: (prefix: IdPrefix) => string;
  readonly #onKeyQcRun: CompositorModelOptions["onKeyQcRun"];
  readonly #onMatteGenerate: CompositorModelOptions["onMatteGenerate"];

  public constructor(options: CompositorModelOptions = {}) {
    this.#idFactory = options.idFactory ?? makeId;
    this.#onKeyQcRun = options.onKeyQcRun;
    this.#onMatteGenerate = options.onMatteGenerate;
  }

  public arrangements(): PresenterArrangement[] {
    return structuredClone([...PRESENTER_ARRANGEMENTS]);
  }

  public readonly dispatchOperation: OperationDispatcher = (
    project: GuyditorProject,
    input: OperationInput,
    context: OperationContext,
  ) => this.#dispatch(project, input, context);

  #dispatchPip(
    project: GuyditorProject,
    input: OperationInput,
  ): Result<DispatchedOperationApplication> {
    if (input.op === "region.mark") {
      const params = input.params as unknown as RegionMarkParams;
      if (params.restoreRegions !== undefined) {
        return success({
          model: { ...project, avoidRegions: structuredClone(params.restoreRegions) },
          inverse: [{
            op: input.op,
            params: { ...input.params, restoreRegions: structuredClone(project.avoidRegions ?? []) },
          }],
          affected: [...new Set([
            ...(project.avoidRegions ?? []).map(({ id }) => id),
            ...params.restoreRegions.map(({ id }) => id),
          ])],
          summary: "Restore marked avoid regions",
        });
      }
      const region = structuredClone(params.region);
      region.id ??= this.#idFactory("avr");
      if (region.source !== "marked") {
        return compositorFailure("E_OP_SCHEMA", "region.mark only accepts marked regions.", [region.id]);
      }
      if (region.rect.x + region.rect.w > 1 || region.rect.y + region.rect.h > 1) {
        return compositorFailure("E_OP_SCHEMA", "Marked region must fit inside the normalized canvas.", [region.id]);
      }
      if (region.frames !== undefined && region.frames.from > region.frames.to) {
        return compositorFailure("E_OP_SCHEMA", "Marked region frame range is reversed.", [region.id]);
      }
      return success({
        model: { ...project, avoidRegions: [...(project.avoidRegions ?? []), region] },
        inverse: [{
          op: input.op,
          params: { ...input.params, restoreRegions: structuredClone(project.avoidRegions ?? []) },
        }],
        redo: { op: input.op, params: { ...input.params, region } },
        affected: [region.id],
        summary: `Mark hard avoid region ${region.id}`,
      });
    }

    const params = input.params as unknown as PipOperationParams;
    const found = findPipLayer(project, params.layerId);
    if (!found.ok) return found;
    const layer = structuredClone(found.value);
    if (Object.hasOwn(input.params, "restorePip")) {
      if (params.restorePip === null) delete layer.pip;
      else if (params.restorePip !== undefined) layer.pip = structuredClone(params.restorePip);
      return success({
        model: {
          ...replaceLayer(project, layer),
          ...(params.restorePresets === undefined
            ? {}
            : { presets: structuredClone(params.restorePresets) }),
        },
        inverse: [{
          op: input.op,
          params: {
            ...input.params,
            restorePip: found.value.pip === undefined ? null : structuredClone(found.value.pip),
            restorePresets: structuredClone(project.presets),
          },
        }],
        affected: [layer.id],
        summary: `Restore PiP on ${layer.id}`,
      });
    }
    const beforePip = layer.pip === undefined ? null : structuredClone(layer.pip);
    const inverse = [{
      op: input.op,
      params: {
        ...input.params,
        restorePip: beforePip,
        restorePresets: structuredClone(project.presets),
      },
    }];

    if (input.op === "pip.avoid.solve") {
      return success({
        model: project,
        inverse: [],
        affected: [layer.id],
        summary: `Prepared reviewable collision-avoidance proposal for ${layer.id}`,
      });
    }
    if (input.op === "pip.place") {
      if (params.placement === undefined) {
        return compositorFailure("E_OP_SCHEMA", "pip.place requires placement constraints.", [layer.id]);
      }
      solvePlacement(params.placement, 1920, 1080);
      layer.pip = layer.pip ?? initialPip(params.placement);
      layer.pip.placement.base = structuredClone(params.placement);
      return success({
        model: replaceLayer(project, layer), inverse, affected: [layer.id],
        summary: `Place layer ${formatPlacementConstraints(params.placement)
          .replace(/^anchor: /u, "")
          .replace(/, ([a-z_]+): /gu, ", $1 ")}`,
      });
    }
    if (input.op === "pip.style.set") {
      if (params.style === undefined || params.style.mask === undefined) {
        return compositorFailure("E_OP_SCHEMA", "pip.style.set requires a complete style and mask.", [layer.id]);
      }
      layer.pip = layer.pip ?? initialPip();
      layer.pip.style = structuredClone(params.style);
      return success({
        model: replaceLayer(project, layer), inverse, affected: [layer.id],
        summary: `Style PiP on ${layer.id} as ${params.style.mask.shape}`,
      });
    }
    if (input.op === "pip.keyframe.add") {
      if (params.keyframe === undefined) {
        return compositorFailure("E_OP_SCHEMA", "pip.keyframe.add requires a keyframe.", [layer.id]);
      }
      const keyframe = structuredClone(params.keyframe);
      keyframe.id ??= this.#idFactory("kfr");
      solvePlacement(keyframe.placement, 1920, 1080);
      layer.pip = layer.pip ?? initialPip();
      if (layer.pip.keyframes.some(({ id }) => id === keyframe.id)) {
        return compositorFailure("E_OP_DUPLICATE_ID", `PiP keyframe ${keyframe.id} already exists.`, [keyframe.id]);
      }
      layer.pip.keyframes.push(keyframe);
      return success({
        model: replaceLayer(project, layer), inverse,
        redo: { op: input.op, params: { ...input.params, keyframe } },
        affected: [layer.id, keyframe.id],
        summary: `Add PiP keyframe at ${keyframe.at}`,
      });
    }
    if (input.op === "pip.keyframe.remove") {
      layer.pip = layer.pip ?? initialPip();
      const index = layer.pip.keyframes.findIndex(({ id }) => id === params.keyframeId);
      if (index === -1) {
        return compositorFailure("E_OP_NOT_FOUND", `PiP keyframe ${String(params.keyframeId)} does not exist.`, [String(params.keyframeId)]);
      }
      layer.pip.keyframes.splice(index, 1);
      return success({
        model: replaceLayer(project, layer), inverse, affected: [layer.id, String(params.keyframeId)],
        summary: `Remove PiP keyframe ${String(params.keyframeId)}`,
      });
    }
    if (input.op === "pip.preset.apply") {
      if (
        params.placement === undefined || params.at === undefined || params.presetId === undefined ||
        params.version === undefined || params.durationFrames === undefined
      ) {
        return compositorFailure("E_OP_SCHEMA", "pip.preset.apply parameters are incomplete.", [layer.id]);
      }
      let preset;
      try {
        preset = motionPreset(params.presetId, params.version);
      } catch {
        return compositorFailure(
          "E_PIP_PRESET_NOT_FOUND",
          `PiP motion preset ${params.presetId}@${String(params.version)} is not installed.`,
          [params.presetId],
        );
      }
      solvePlacement(params.placement, 1920, 1080);
      const keyframe: PipKeyframe = {
        id: params.keyframeId ?? this.#idFactory("kfr"),
        at: params.at,
        placement: structuredClone(params.placement),
        transition: {
          preset: preset.id,
          durationFrames: params.durationFrames,
          ...(params.params === undefined ? {} : { params: structuredClone(params.params) }),
        },
      };
      layer.pip = layer.pip ?? initialPip();
      if (layer.pip.keyframes.some(({ id }) => id === keyframe.id)) {
        return compositorFailure("E_OP_DUPLICATE_ID", `PiP keyframe ${keyframe.id} already exists.`, [keyframe.id]);
      }
      layer.pip.keyframes.push(keyframe);
      const presets = project.presets.some(({ id, version }) =>
        id === preset.id && version === preset.version)
        ? project.presets
        : [...project.presets, motionPresetPin(preset.id, preset.version)];
      return success({
        model: { ...replaceLayer(project, layer), presets }, inverse,
        redo: { op: input.op, params: { ...input.params, keyframeId: keyframe.id } },
        affected: [layer.id, keyframe.id, preset.id],
        summary: `Apply ${preset.label}@${String(preset.version)} at ${params.at}`,
      });
    }
    return compositorFailure("E_OP_UNKNOWN", `CompositorModel cannot dispatch ${input.op}.`, [input.op]);
  }

  #dispatch(
    project: GuyditorProject,
    input: OperationInput,
    context: OperationContext,
  ): Result<DispatchedOperationApplication> {
    if (input.op.startsWith("pip.") || input.op === "region.mark") {
      return this.#dispatchPip(project, input);
    }
    if (input.op === "key.qc.run") {
      const clipId = input.params["clipId"] as string;
      const exists = project.sequences.some(({ clips }) => clips.some(({ id }) => id === clipId));
      if (!exists) return compositorFailure("E_OP_NOT_FOUND", `Clip ${clipId} does not exist.`, [clipId]);
      if (!context.dryRun) {
        this.#onKeyQcRun?.({
          project: structuredClone(project),
          clipId,
          shotBoundaries: structuredClone((input.params["shotBoundaries"] as number[] | undefined) ?? []),
        });
      }
      return success({
        model: project,
        inverse: [],
        affected: [clipId],
        summary: `Queued key quality analysis for ${clipId}`,
      });
    }
    if (input.op === "key.matte.generate") {
      const clipId = input.params["clipId"] as string;
      const exists = project.sequences.some(({ clips }) => clips.some(({ id }) => id === clipId));
      if (!exists) return compositorFailure("E_OP_NOT_FOUND", `Clip ${clipId} does not exist.`, [clipId]);
      if (!context.dryRun) {
        this.#onMatteGenerate?.({
          project: structuredClone(project),
          clipId,
          neural: structuredClone(input.params["neural"] as unknown as NeuralMatteParams),
          shotBoundaries: structuredClone((input.params["shotBoundaries"] as number[] | undefined) ?? []),
        });
      }
      return success({
        model: project,
        inverse: [],
        affected: [clipId],
        summary: `Queued neural matte generation for ${clipId}`,
      });
    }
    if (input.op !== "composition.arrange") {
      return compositorFailure(
        "E_OP_UNKNOWN",
        `CompositorModel cannot dispatch ${input.op}.`,
        [input.op],
      );
    }
    const params = input.params as unknown as ArrangeCompositionParams;
    if (params.restoreLayers !== undefined) {
      const current = structuredClone(project.layers);
      return success({
        model: { ...project, layers: structuredClone(params.restoreLayers) },
        inverse: [{
          op: "composition.arrange",
          params: { ...input.params, restoreLayers: current },
        }],
        affected: [...new Set([...current, ...params.restoreLayers].map(({ id }) => id))],
        summary: `Restore layers before ${params.arrangementRef}`,
      });
    }
    if (!project.sequences.some(({ id }) => id === params.sequenceId)) {
      return compositorFailure(
        "E_OP_NOT_FOUND",
        `Sequence ${params.sequenceId} does not exist.`,
        [params.sequenceId],
      );
    }
    const arrangement = PRESENTER_ARRANGEMENTS.find(({ id, name }) =>
      params.arrangementRef === id || params.arrangementRef === name);
    if (arrangement === undefined) {
      return compositorFailure(
        "E_OP_NOT_FOUND",
        `Presenter arrangement ${params.arrangementRef} does not exist.`,
        [params.arrangementRef],
      );
    }
    const expectedRoles = new Set<string>(arrangement.roles.map(({ role }) => role));
    const suppliedRoles = Object.keys(params.assignments);
    if (
      suppliedRoles.length !== expectedRoles.size ||
      suppliedRoles.some((role) => !expectedRoles.has(role))
    ) {
      return compositorFailure(
        "E_OP_SCHEMA",
        `${arrangement.name} requires assignments for ${[...expectedRoles].join(", ")}.`,
        suppliedRoles,
      );
    }

    const nextById = new Map(project.layers.map((layer) => [layer.id, structuredClone(layer)]));
    const roleLayers: Layer[] = [];
    for (const [index, role] of arrangement.roles.entries()) {
      const assignment = params.assignments[role.role]!;
      let layer: Layer;
      if (/^lyr_[a-z2-7]{10}$/u.test(assignment)) {
        const existing = nextById.get(assignment);
        if (existing === undefined) {
          return compositorFailure("E_OP_NOT_FOUND", `Layer ${assignment} does not exist.`, [assignment]);
        }
        if (existing.locked) {
          return compositorFailure("E_OP_LAYER_LOCKED", `Layer ${assignment} is locked.`, [assignment]);
        }
        layer = existing;
      } else {
        const item = assetItem(project, params.sequenceId, assignment, this.#idFactory);
        if (!item.ok) return item;
        layer = {
          id: this.#idFactory("lyr"),
          kind: role.kind,
          name: role.role,
          order: index * 10,
          enabled: true,
          locked: false,
          items: [item.value],
        };
      }
      layer.order = index * 10;
      nextById.set(layer.id, layer);
      roleLayers.push(layer);
    }
    const roleIds = new Set(roleLayers.map(({ id }) => id));
    const unassigned = [...nextById.values()].filter(({ id }) => !roleIds.has(id));
    const layers = [...roleLayers, ...unassigned];
    const summaryAssignments = arrangement.roles
      .map(({ role }) => `${role}=${params.assignments[role]}`)
      .join(", ");
    return success({
      model: { ...project, layers },
      inverse: [{
        op: "composition.arrange",
        params: { ...input.params, restoreLayers: structuredClone(project.layers) },
      }],
      affected: roleLayers.map(({ id }) => id),
      summary: `Arranged ${arrangement.name}: ${summaryAssignments}`,
    });
  }
}
