import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type {
  Asset,
  GuyditorProject,
  SidecarRef,
} from "../project/index.js";
import type { ClipApplication } from "./clip.js";
import type { OperationInput } from "./types.js";

function assetFailure(code: `E_${Uppercase<string>}`, message: string, affected: string[]) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function assetReferences(project: GuyditorProject, assetId: string): string[] {
  return [
    ...project.sequences.flatMap((sequence) =>
      sequence.clips.filter((clip) => clip.asset === assetId).map((clip) => clip.id),
    ),
    ...project.layers.flatMap((layer) =>
      (layer.items ?? []).filter((item) => item.asset === assetId).map((item) => item.id),
    ),
  ];
}

function applyIngest(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const incoming = input.params["assets"] as Asset[];
  const byId = new Map(project.assets.map((asset) => [asset.id, asset] as const));
  const hashToId = new Map(project.assets.map((asset) => [asset.sha256, asset.id] as const));
  const previous: Asset[] = [];
  const added: string[] = [];
  for (const asset of incoming) {
    const existing = byId.get(asset.id);
    if (existing !== undefined && existing.sha256 !== asset.sha256) {
      if (hashToId.get(existing.sha256) === asset.id) hashToId.delete(existing.sha256);
    }
    const shaConflictId = hashToId.get(asset.sha256);
    if (shaConflictId !== undefined && shaConflictId !== asset.id) {
      return assetFailure(
        "E_OP_ASSET_CONFLICT",
        `Asset hash ${asset.sha256} is already registered as ${shaConflictId}.`,
        [shaConflictId, asset.id],
      );
    }
    if (existing === undefined) added.push(asset.id);
    else previous.push(existing);
    byId.set(asset.id, structuredClone(asset));
    hashToId.set(asset.sha256, asset.id);
  }
  const affected = incoming.map(({ id }) => id);
  const inverseParams: Record<string, unknown> = { assetIds: added };
  if (previous.length > 0) inverseParams["restoreAssets"] = previous;
  return success({
    model: { ...project, assets: [...byId.values()] },
    inverse: [{ op: "asset.remove", params: inverseParams }],
    affected,
    summary: `Ingest ${String(incoming.length)} assets`,
    mutations: incoming.map((asset) => {
      const before = project.assets.find(({ id }) => id === asset.id);
      return {
        entityId: asset.id,
        entityType: "asset" as const,
        change: before === undefined ? "added" as const : "modified" as const,
        fields: [{
          field: "$entity",
          ...(before === undefined ? {} : { before }),
          after: asset,
        }],
      };
    }),
  });
}

function applyRemove(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const assetIds = input.params["assetIds"] as string[];
  const restoreAssets = (input.params["restoreAssets"] as Asset[] | undefined) ?? [];
  const removed: Asset[] = [];
  for (const assetId of assetIds) {
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (asset === undefined) {
      return assetFailure("E_OP_NOT_FOUND", `Asset ${assetId} does not exist.`, [assetId]);
    }
    const references = assetReferences(project, assetId);
    if (references.length > 0) {
      return assetFailure(
        "E_OP_ASSET_IN_USE",
        `Asset ${assetId} is referenced by timeline clips or items.`,
        [assetId, ...references],
      );
    }
    removed.push(asset);
  }

  const removeIds = new Set(assetIds);
  const assets = project.assets.filter(({ id }) => !removeIds.has(id));
  const restoredById = new Map(assets.map((asset) => [asset.id, asset] as const));
  for (const asset of restoreAssets) restoredById.set(asset.id, structuredClone(asset));
  const affected = [...assetIds, ...restoreAssets.map(({ id }) => id)];
  return success({
    model: { ...project, assets: [...restoredById.values()] },
    inverse: removed.length === 0
      ? []
      : [{ op: "asset.ingest", params: { assets: removed } }],
    affected,
    summary: `Remove ${String(assetIds.length)} assets`,
    mutations: [
      ...removed.map((asset) => ({
        entityId: asset.id,
        entityType: "asset" as const,
        change: "removed" as const,
        fields: [{ field: "$entity", before: asset }],
      })),
      ...restoreAssets.map((asset) => ({
        entityId: asset.id,
        entityType: "asset" as const,
        change: "modified" as const,
        fields: [{ field: "$entity", after: asset }],
      })),
    ],
  });
}

interface TakeSidecarParam {
  path: string;
  sha256: string;
}

function takeSidecar(project: GuyditorProject, assetId: string): SidecarRef | undefined {
  return project.sidecars.find(({ schema, inputs }) =>
    schema === "guyditor.take-markers/v1" && inputs.some(({ asset }) => asset === assetId));
}

function applyTakeMetadata(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  const assetId = input.params["assetId"] as string;
  const index = project.assets.findIndex(({ id }) => id === assetId);
  const asset = project.assets[index];
  if (asset === undefined) {
    return assetFailure("E_OP_NOT_FOUND", `Asset ${assetId} does not exist.`, [assetId]);
  }
  const markerOperation = input.op === "asset.markers.attach";
  const ids = input.params[markerOperation ? "markerIds" : "takeIds"] as string[];
  const sidecar = input.params["sidecar"] as TakeSidecarParam | null;
  const priorIds = markerOperation ? asset.markers ?? [] : asset.takes ?? [];
  const priorSidecar = takeSidecar(project, assetId);
  const replacement: Asset = { ...asset };
  if (markerOperation) replacement.markers = [...ids];
  else replacement.takes = [...ids];
  const assets = project.assets.slice();
  assets[index] = replacement;
  const sidecars = project.sidecars.filter((candidate) => candidate !== priorSidecar);
  if (sidecar !== null) {
    sidecars.push({
      name: `takes-${assetId}`,
      path: sidecar.path,
      schema: "guyditor.take-markers/v1",
      sha256: sidecar.sha256,
      inputs: [{ asset: assetId, sha256: asset.sha256 }],
    });
  }
  return success({
    model: { ...project, assets, sidecars },
    inverse: [{
      op: input.op,
      params: {
        assetId,
        [markerOperation ? "markerIds" : "takeIds"]: [...priorIds],
        sidecar: priorSidecar === undefined
          ? null
          : { path: priorSidecar.path, sha256: priorSidecar.sha256 },
      },
    }],
    affected: [assetId, ...ids],
    summary: markerOperation
      ? `Attach ${String(ids.length)} markers to ${assetId}`
      : `Set ${String(ids.length)} takes for ${assetId}`,
    mutations: [{
      entityId: assetId,
      entityType: "asset",
      change: "modified",
      fields: [{
        field: markerOperation ? "markers" : "takes",
        before: [...priorIds],
        after: [...ids],
      }],
    }],
  });
}

export function applyAssetOperation(
  project: GuyditorProject,
  input: OperationInput,
): Result<ClipApplication> {
  if (input.op === "asset.ingest") return applyIngest(project, input);
  if (input.op === "asset.remove") return applyRemove(project, input);
  return applyTakeMetadata(project, input);
}
