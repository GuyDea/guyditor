import { createHash } from "node:crypto";

import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type {
  Asset,
  Clip,
  GuyditorProject,
  SidecarRef,
} from "../project/index.js";
import type {
  ClipApplication,
  EntityMutation,
} from "../operations/clip.js";
import type { OperationInput } from "../operations/types.js";
import type {
  ProgrammaticAnimationProvenance,
  TemplateProvider,
} from "./types.js";

interface FreezePlacement {
  sequenceId: string;
  layerId: string;
  clipId: string;
  index: number;
}

function freezeFailure<Value = ClipApplication>(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[],
): Result<Value> {
  return failure(makeGuyditorError(code, message, { affected }));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sorted(child)]));
}

export function serializeProgrammaticAnimationProvenance(
  provenance: ProgrammaticAnimationProvenance,
): string {
  return `${JSON.stringify(sorted(provenance), null, 2)}\n`;
}

export function programmaticAnimationSidecar(
  provenance: ProgrammaticAnimationProvenance,
): SidecarRef {
  const serialized = serializeProgrammaticAnimationProvenance(provenance);
  return {
    name: `programmatic-${provenance.assetId}`,
    path: `sidecars/programmatic/${provenance.assetId}.json`,
    schema: provenance.schema,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    generatedBy: {
      tool: provenance.template.id,
      version: provenance.template.version,
    },
    inputs: [],
  };
}

function hashesAreValid(provenance: ProgrammaticAnimationProvenance): boolean {
  const hash = /^[0-9a-f]{64}$/u;
  return hash.test(provenance.template.contentHash) &&
    /^sha256:[0-9a-f]{64}$/u.test(provenance.renderer.toolchainHash) &&
    /^sha256:[0-9a-f]{64}$/u.test(provenance.contentHash) &&
    Object.values(provenance.renderer.fontHashes).every((value) => hash.test(value));
}

function provenanceMatches(
  asset: Asset,
  provenance: ProgrammaticAnimationProvenance,
  sidecar: SidecarRef,
): boolean {
  const expectedSidecar = programmaticAnimationSidecar(provenance);
  const duration = asset.probe.duration;
  return provenance.schema === "guyditor.programmatic-provenance/v1" &&
    provenance.assetId === asset.id &&
    provenance.contentHash === `sha256:${asset.sha256}` &&
    asset.kind === "generated" &&
    asset.provenance?.sidecar === sidecar.name &&
    asset.rights?.origin === "programmatic" &&
    JSON.stringify(asset.rights) === JSON.stringify(provenance.rights) &&
    duration !== undefined && "frames" in duration &&
    duration.frames === provenance.output.frames &&
    (asset.probe.fps ?? asset.video?.fps ?? duration.fps) === provenance.output.fps &&
    asset.probe.width === provenance.output.width &&
    asset.probe.height === provenance.output.height &&
    Number.isSafeInteger(provenance.seed) &&
    provenance.seed >= 0 && provenance.seed <= 0xffff_ffff &&
    Number.isSafeInteger(provenance.output.frames) && provenance.output.frames > 0 &&
    Number.isSafeInteger(provenance.output.width) && provenance.output.width > 0 &&
    Number.isSafeInteger(provenance.output.height) && provenance.output.height > 0 &&
    hashesAreValid(provenance) &&
    JSON.stringify(sidecar) === JSON.stringify(expectedSidecar);
}

function placementResult(
  project: GuyditorProject,
  asset: Asset,
  placement: FreezePlacement,
  provenance: ProgrammaticAnimationProvenance,
): Result<{ project: GuyditorProject; clip: Clip }> {
  const sequenceIndex = project.sequences.findIndex(({ id }) => id === placement.sequenceId);
  const sequence = project.sequences[sequenceIndex];
  const layer = project.layers.find(({ id }) => id === placement.layerId);
  if (sequence === undefined) {
    return freezeFailure(
      "E_OP_NOT_FOUND",
      `Template freeze sequence ${placement.sequenceId} does not exist.`,
      [placement.sequenceId],
    );
  }
  if (
    layer === undefined || layer.kind !== "video" ||
    layer.sequence !== placement.sequenceId
  ) {
    return freezeFailure(
      "E_OP_LAYER_TARGET",
      `Template freeze layer ${placement.layerId} must be the sequence-bound video layer.`,
      [placement.layerId, placement.sequenceId],
    );
  }
  if (layer.locked) {
    return freezeFailure(
      "E_OP_LAYER_LOCKED",
      `Template freeze layer ${placement.layerId} is locked.`,
      [placement.layerId],
    );
  }
  if (placement.index < 0 || placement.index > sequence.clips.length) {
    return freezeFailure(
      "E_OP_RANGE_OUT_OF_BOUNDS",
      `Template freeze index ${String(placement.index)} is outside ${placement.sequenceId}.`,
      [placement.sequenceId],
    );
  }
  if (project.sequences.some(({ clips }) => clips.some(({ id }) => id === placement.clipId))) {
    return freezeFailure(
      "E_OP_ID_CONFLICT",
      `Template freeze clip ${placement.clipId} already exists.`,
      [placement.clipId],
    );
  }
  const clip: Clip = {
    id: placement.clipId,
    asset: asset.id,
    origin: "local",
    source: {
      in: { frames: 0, fps: provenance.output.fps },
      out: { frames: provenance.output.frames, fps: provenance.output.fps },
    },
  };
  const clips = sequence.clips.slice();
  clips.splice(placement.index, 0, clip);
  const sequences = project.sequences.slice();
  sequences[sequenceIndex] = { ...sequence, clips };
  return success({ project: { ...project, sequences }, clip });
}

export async function applyTemplateFreezeOperation(
  project: GuyditorProject,
  input: OperationInput,
  provider: TemplateProvider,
): Promise<Result<ClipApplication>> {
  if (input.op !== "template.freeze") {
    return freezeFailure("E_OP_UNKNOWN", `Unknown freeze operation ${input.op}.`, [input.op]);
  }
  const asset = structuredClone(input.params["asset"] as Asset);
  const provenance = structuredClone(
    input.params["provenance"] as ProgrammaticAnimationProvenance,
  );
  const sidecar = structuredClone(input.params["sidecar"] as SidecarRef);
  const placement = input.params["placement"] as FreezePlacement | undefined;
  if (
    project.assets.some(({ id }) => id === asset.id) ||
    project.assets.some(({ sha256 }) => sha256 === asset.sha256) ||
    project.sidecars.some(({ name }) => name === sidecar.name)
  ) {
    return freezeFailure(
      "E_OP_ID_CONFLICT",
      `Template freeze asset or sidecar ${asset.id} already exists.`,
      [asset.id, sidecar.name],
    );
  }
  if (!provenanceMatches(asset, provenance, sidecar)) {
    return freezeFailure(
      "E_TEMPLATE_FREEZE_PROVENANCE_INVALID",
      `Template freeze provenance does not match asset ${asset.id}.`,
      [asset.id, provenance.template.id],
    );
  }
  const descriptor = await provider.get(
    provenance.template.id,
    provenance.template.version,
  );
  if (
    !descriptor.ok ||
    descriptor.value.contentHash !== provenance.template.contentHash
  ) {
    return descriptor.ok
      ? freezeFailure(
          "E_TEMPLATE_FREEZE_PROVENANCE_INVALID",
          `Template ${provenance.template.id}@${provenance.template.version} content changed before freeze commit.`,
          [provenance.template.id],
        )
      : descriptor;
  }
  let model: GuyditorProject = {
    ...project,
    assets: [...project.assets, asset],
    sidecars: [...project.sidecars, sidecar],
  };
  let clip: Clip | undefined;
  if (placement !== undefined) {
    const placed = placementResult(model, asset, placement, provenance);
    if (!placed.ok) return placed;
    model = placed.value.project;
    clip = placed.value.clip;
  }
  const mutations: EntityMutation[] = [
    {
      entityId: asset.id,
      entityType: "asset",
      change: "added",
      fields: [{ field: "$entity", after: asset }],
    },
    {
      entityId: sidecar.name,
      entityType: "sidecar",
      change: "added",
      fields: [{ field: "$entity", after: sidecar }],
    },
    ...(clip === undefined
      ? []
      : [{
          entityId: clip.id,
          entityType: "clip" as const,
          change: "added" as const,
          fields: [{ field: "$entity", after: clip }],
        }]),
  ];
  return success({
    model,
    inverse: [
      ...(clip === undefined
        ? []
        : [{ op: "clip.remove", params: { clipId: clip.id, closeGap: true } }]),
      { op: "sidecar.register", params: { name: sidecar.name, sidecar: null } },
      { op: "asset.remove", params: { assetIds: [asset.id] } },
    ],
    affected: mutations.map(({ entityId }) => entityId),
    summary: clip === undefined
      ? `Freeze ${provenance.template.id} to ${asset.id}`
      : `Freeze ${provenance.template.id} to first-class clip ${clip.id}`,
    mutations,
  });
}
