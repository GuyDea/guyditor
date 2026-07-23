import { resolve, basename } from "node:path";

import { ProjectStore } from "../../../core/src/index.js";

interface ProjectSnapshot {
  master: ProjectStore["currentProject"];
  projectPath: string;
  revision: string;
  sidecarIndex: ProjectStore["currentProject"]["sidecars"];
}

export async function createProjectDialog(
  choose: (() => Promise<string | undefined>) | undefined,
  open: (path: string) => Promise<ProjectSnapshot>,
  appVersion: string,
  profilesDirectory: string,
): Promise<ProjectSnapshot | null> {
  const selected = await choose?.();
  if (selected === undefined) return null;
  const root = resolve(selected);
  const created = await ProjectStore.createProject(root, { name: basename(root) }, {
    appVersion,
    profilesDirectory,
  });
  if (!created.ok) throw created.error;
  return open(root);
}
