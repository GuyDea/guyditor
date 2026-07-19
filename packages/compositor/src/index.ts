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
  PlacedItem,
  Result,
} from "../../core/src/index.js";

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

  public constructor(options: CompositorModelOptions = {}) {
    this.#idFactory = options.idFactory ?? makeId;
    this.#onKeyQcRun = options.onKeyQcRun;
  }

  public arrangements(): PresenterArrangement[] {
    return structuredClone([...PRESENTER_ARRANGEMENTS]);
  }

  public readonly dispatchOperation: OperationDispatcher = (
    project: GuyditorProject,
    input: OperationInput,
    context: OperationContext,
  ) => this.#dispatch(project, input, context);

  #dispatch(
    project: GuyditorProject,
    input: OperationInput,
    context: OperationContext,
  ): Result<DispatchedOperationApplication> {
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
