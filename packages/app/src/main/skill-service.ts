import type {
  CaptureSkillExampleInput,
  SkillRegistry,
  SkillScope,
  UpdateSkillDraftInput,
} from "../../../agent/src/index.js";
import type { ProjectStore } from "../../../core/src/index.js";

import type { IpcService } from "./rpc.js";

export interface SkillRegistryServiceOptions {
  appVersion: string;
  project?: ProjectStore;
  registry: SkillRegistry;
  requireProject: () => ProjectStore;
  publishRevision: (revision: string) => void;
}

export function skillRegistryService(options: SkillRegistryServiceOptions): IpcService {
  return {
    list: ({ scope }: { scope: SkillScope }) => options.registry.list(scope, options.project),
    versions: ({ skillId }: { skillId: string }) => options.registry.versions(skillId),
    get: ({ skillId, version }: { skillId: string; version?: string }) =>
      options.registry.get(skillId, version),
    publish: ({ directory }: { directory: string }) => options.registry.publish(directory),
    verify: ({ skillId, version }: { skillId: string; version: string }) =>
      options.registry.verify(skillId, version),
    drafts: ({ skillId }: { skillId?: string }) => options.registry.drafts(skillId),
    createDraft: ({ skillId, baseVersion, version }: {
      skillId: string;
      baseVersion: string;
      version: string;
    }) => options.registry.createDraft({
      base: { skillId, version: baseVersion },
      version,
    }),
    updateDraft: (params: UpdateSkillDraftInput) => options.registry.updateDraft(params),
    deleteDraft: async ({ skillId, version }: { skillId: string; version: string }) => {
      await options.registry.deleteDraft(skillId, version);
      return { deleted: true };
    },
    publishDraft: ({ skillId, version }: { skillId: string; version: string }) =>
      options.registry.publishDraft(skillId, version),
    diff: ({ skillId, fromVersion, toVersion }: {
      skillId: string;
      fromVersion: string;
      toVersion: string;
    }) => options.registry.diff(skillId, fromVersion, toVersion),
    pinned: () => options.project === undefined ? [] : options.registry.pinned(options.project),
    associate: async ({ skillId, version }: { skillId: string; version: string }) => {
      const result = await options.registry.associateProject(
        options.requireProject(),
        skillId,
        version,
        { appVersion: options.appVersion },
      );
      options.publishRevision(result.revision);
      return result;
    },
    upgrade: async ({ skillId, version }: { skillId: string; version: string }) => {
      const result = await options.registry.upgradeProject(
        options.requireProject(),
        skillId,
        version,
        { appVersion: options.appVersion },
      );
      options.publishRevision(result.revision);
      return result;
    },
    captureExample: (params: Omit<CaptureSkillExampleInput, "project">) =>
      options.registry.captureExample({ ...params, project: options.requireProject() }),
  };
}
