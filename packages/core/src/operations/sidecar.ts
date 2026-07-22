import { success } from "../errors.js";
import type { GuyditorProject, SidecarRef } from "../project/index.js";
import type { ClipApplication } from "./clip.js";
import type { OperationInput } from "./types.js";

function analysisIdentity(sidecar: SidecarRef | undefined): { assetId: string; kind: string } | undefined {
  if (sidecar?.schema !== "guyditor.analysis/v1") return undefined;
  const match = /^sidecars\/analysis\/(ast_[a-z2-7]{10})\.(.+)\.json$/u.exec(sidecar.path);
  return match === null ? undefined : { assetId: match[1]!, kind: match[2]! };
}

export function applySidecarOperation(
  project: GuyditorProject,
  input: OperationInput,
): ReturnType<typeof success<ClipApplication>> {
  const name = input.params["name"] as string;
  const sidecar = input.params["sidecar"] as SidecarRef | null;
  const previous = project.sidecars.find((candidate) => candidate.name === name);
  const sidecars = project.sidecars.filter((candidate) => candidate.name !== name);
  if (sidecar !== null) sidecars.push(structuredClone(sidecar));
  const previousAnalysis = analysisIdentity(previous);
  const nextAnalysis = analysisIdentity(sidecar ?? undefined);
  const assets = project.assets.map((asset) => {
    if (asset.id !== previousAnalysis?.assetId && asset.id !== nextAnalysis?.assetId) return asset;
    const analyses = { ...(asset.analyses ?? {}) };
    if (asset.id === previousAnalysis?.assetId) delete analyses[previousAnalysis.kind];
    if (asset.id === nextAnalysis?.assetId && sidecar !== null) {
      analyses[nextAnalysis.kind] = {
        sidecar: sidecar.name,
        path: sidecar.path,
        sha256: sidecar.sha256,
      };
    }
    return { ...asset, analyses };
  });
  return success({
    model: { ...project, assets, sidecars },
    inverse: [{
      op: "sidecar.register",
      params: { name, sidecar: previous === undefined ? null : structuredClone(previous) },
    }],
    affected: [name],
    summary: sidecar === null ? `Unregister sidecar ${name}` : `Register sidecar ${name}`,
    mutations: [{
      entityId: name,
      entityType: "sidecar",
      change: previous === undefined ? (sidecar === null ? "removed" : "added") :
        sidecar === null ? "removed" : "modified",
      fields: [{ field: "sidecar", before: previous ?? null, after: sidecar }],
    }],
  });
}
