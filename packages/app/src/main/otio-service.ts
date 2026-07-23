import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AnchorResolverRegistry,
  resolveAnchor,
} from "../../../core/src/index.js";
import type {
  AnnotationService,
  ProjectStore,
  Result,
} from "../../../core/src/index.js";
import {
  createTranscriptWordLookup,
  parseTranscriptSidecar,
} from "../../../transcript/src/index.js";
import {
  buildOtioExport,
  writeOtioExport,
} from "../../../deliver/src/index.js";
import type {
  OtioExportOptions,
  OtioExportResult,
} from "../../../deliver/src/index.js";

export interface OtioServiceOptions {
  store: ProjectStore;
  annotations: AnnotationService;
}

function resultValue<Value>(result: Result<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

export class OtioService {
  readonly #store: ProjectStore;
  readonly #annotations: AnnotationService;

  public constructor(options: OtioServiceOptions) {
    this.#store = options.store;
    this.#annotations = options.annotations;
  }

  public async preview(params: OtioExportOptions): Promise<{
    path: string;
    losses: OtioExportResult["losses"];
  }> {
    const context = await this.#context(params);
    const plan = await buildOtioExport(context.project, context.params, context.dependencies);
    return { path: plan.path, losses: plan.losses };
  }

  public async export(params: OtioExportOptions): Promise<OtioExportResult> {
    const context = await this.#context(params);
    return writeOtioExport(context.project, context.params, context.dependencies);
  }

  async #context(params: OtioExportOptions) {
    const project = this.#store.currentProject;
    const deliverable = project.deliverables.find(({ id }) => id === params.deliverableId);
    if (deliverable === undefined) throw new Error(`Deliverable ${params.deliverableId} does not exist.`);
    const outputPath = join(
      this.#store.root,
      "exports",
      "interchange",
      `${deliverable.name.replaceAll(/[^A-Za-z0-9._-]+/gu, "-")}-${project.revision}.otio`,
    );
    const annotations = resultValue(await this.#annotations.list(this.#store));
    const transcripts = await Promise.all(project.sidecars
      .filter(({ schema }) => schema === "guyditor.transcript/v1")
      .map(async ({ path }) => parseTranscriptSidecar(
        await readFile(join(this.#store.root, path), "utf8"),
      )));
    const resolvers = new AnchorResolverRegistry();
    resolvers.registerWordLookup(createTranscriptWordLookup(transcripts));
    this.#annotations.registerAnchorResolver(resolvers, this.#store);
    const resolveSemanticAnchor = async (anchor: string) => {
      const resolution = resultValue(await resolveAnchor(
        project,
        anchor,
        deliverable.sequenceId,
        resolvers.dependencies(),
      ));
      return resolution.status === "resolved" ? resolution.timeline : undefined;
    };
    return {
      project,
      params: { ...params, revision: project.revision },
      dependencies: {
        annotations,
        outputPath,
        projectRoot: this.#store.root,
        resolveAnchor: resolveSemanticAnchor,
        resolveAnnotation: (annotation: (typeof annotations)[number]) =>
          resolveSemanticAnchor(`ann:${annotation.id}`),
      },
    };
  }
}
