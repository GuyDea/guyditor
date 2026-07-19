import { success } from "../errors.js";
import type { GuyditorProject, WatchFolderConfig } from "../project/index.js";
import type { ClipApplication } from "./clip.js";
import type { OperationInput } from "./types.js";

export function applyProjectOperation(
  project: GuyditorProject,
  input: OperationInput,
): ReturnType<typeof success<ClipApplication>> {
  const watchFolders = structuredClone(input.params["watchFolders"] as WatchFolderConfig[]);
  const previous = structuredClone(project.watchFolders ?? []);
  return success({
    model: { ...project, watchFolders },
    inverse: [{ op: input.op, params: { watchFolders: previous } }],
    affected: [project.project.id],
    summary: `Configure ${String(watchFolders.length)} capture watch folders`,
    mutations: [{
      entityId: project.project.id,
      entityType: "project",
      change: "modified",
      fields: [{ field: "watchFolders", before: previous, after: watchFolders }],
    }],
  });
}
