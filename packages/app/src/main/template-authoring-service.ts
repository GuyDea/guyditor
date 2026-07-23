import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { ProjectStore } from "../../../core/src/index.js";
import type { AuditLog } from "../../../agent/src/index.js";
import {
  TemplateAuthoringService,
  TemplateRegistry,
} from "../../../render/src/index.js";

function builtinsRoot(): string {
  const candidates = [
    resolve("templates"),
    resolve("../..", "templates"),
    resolve(import.meta.dirname, "../../../../templates"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function createProjectTemplateServices(options: {
  userDirectory: string;
  store: ProjectStore;
  auditLog: AuditLog;
}): {
  templates: TemplateRegistry;
  templateAuthoring: TemplateAuthoringService;
} {
  const templatesRoot = join(options.userDirectory, "templates");
  const templates = new TemplateRegistry({
    builtinsRoot: builtinsRoot(),
    userRoot: templatesRoot,
    projectRoot: join(options.store.root, "templates"),
    compiledRoot: join(templatesRoot, ".compiled"),
    draftRoot: join(templatesRoot, ".drafts"),
  });
  const templateAuthoring = new TemplateAuthoringService({
    registry: templates,
    draftRoot: join(templatesRoot, ".drafts"),
    resolveAsset: async (declaration) => {
      const asset = options.store.currentProject.assets.find(
        ({ sha256 }) => sha256 === declaration.sha256,
      );
      if (asset === undefined) {
        throw new Error(
          `Declared template asset ${declaration.name} (${declaration.sha256}) is not registered in the project.`,
        );
      }
      return readFile(
        isAbsolute(asset.path) ? asset.path : join(options.store.root, asset.path),
      );
    },
    onAudit: (event) => {
      options.auditLog.append({
        type: event.type === "submitted"
          ? "template.author.submitted"
          : "template.author.reviewed",
        sessionId: event.status.provenance.sessionId,
        projectId: options.store.currentProject.project.id,
        submissionId: event.status.submissionId,
        templateId: event.status.templateId,
        model: event.status.provenance.model,
        status: event.status.status,
        ...(event.decision === undefined ? {} : { decision: event.decision }),
        ...(event.status.reason === undefined ? {} : { reason: event.status.reason }),
        ...(event.status.published === undefined
          ? {}
          : { contentHash: event.status.published.contentHash }),
      });
    },
  });
  return { templates, templateAuthoring };
}

export function templateAuthoringIpc(service: TemplateAuthoringService) {
  return {
    status: ({ submissionId }: { submissionId?: string }) =>
      submissionId === undefined ? service.status() : service.status(submissionId),
    review: (params: Parameters<TemplateAuthoringService["review"]>[0]) =>
      service.review(params),
  };
}
