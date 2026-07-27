import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import { AnchorResolverRegistry } from "../anchors/index.js";
import {
  OperationEngine,
} from "../operations/engine.js";
import type {
  IdFactory,
  OperationCommitter,
} from "../operations/engine.js";
import type {
  OperationBatchResult,
  OperationContext,
  OperationInput,
} from "../operations/types.js";
import { makeId } from "../project/ids.js";
import type {
  GuyditorProject,
  SidecarRef,
} from "../project/index.js";
import type {
  ProjectStore,
  TransactionRecord,
} from "../store/index.js";
import {
  annotationPatchAffectsRenderedItem,
  annotationSummary,
  createAnnotationDispatcher,
  refreshAnnotationIndex,
  stateChange,
  transactionActor,
} from "./operations.js";
import type { AnnotationWorkspace } from "./operations.js";
import {
  parseAnnotationSidecar,
  serializeAnnotationSidecar,
} from "./sidecar.js";
import {
  createAnnotationAnchorResolver,
  resolveAnnotationRecord,
} from "./resolver.js";
import type { AnnotationAnchorResolverDependencies } from "./resolver.js";
import type {
  Annotation,
  AnnotationState,
} from "./types.js";

const ANNOTATION_SCHEMA = "guyditor.annotations/v1";
const ANNOTATION_PATH = "sidecars/annotations.yaml";
let temporaryOrdinal = 0;

export interface AnnotationServiceOptions {
  appVersion?: string;
  anchorResolvers?: AnchorResolverRegistry | AnnotationAnchorResolverDependencies;
  idFactory?: IdFactory;
  now?: () => Date;
}

interface LoadedWorkspace {
  reference: SidecarRef;
  text: string;
  workspace: AnnotationWorkspace;
}

interface AnnotationDerivativeState {
  converted: boolean;
  itemId: string | undefined;
  sequenceId: string;
}

function annotationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaryOrdinal += 1;
  const temporary = `${path}.tmp-${String(process.pid)}-${String(temporaryOrdinal)}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function loadWorkspace(project: ProjectStore): Promise<Result<LoadedWorkspace>> {
  const name = project.currentProject.annotations.sidecar;
  const reference = project.currentProject.sidecars.find((candidate) => candidate.name === name);
  if (reference === undefined) {
    return annotationFailure(
      "E_ANN_SIDECAR",
      `Annotation sidecar registry entry ${name} does not exist.`,
      [name],
    );
  }
  if (reference.schema !== ANNOTATION_SCHEMA || reference.path !== ANNOTATION_PATH) {
    return annotationFailure(
      "E_ANN_SIDECAR",
      `Annotation sidecar must use ${ANNOTATION_PATH} with schema ${ANNOTATION_SCHEMA}.`,
      [reference.name],
    );
  }
  try {
    const text = await readFile(join(project.root, reference.path), "utf8");
    const actualHash = createHash("sha256").update(text).digest("hex");
    if (actualHash !== reference.sha256) {
      return annotationFailure(
        "E_SIDECAR_MODIFIED",
        `Annotation sidecar ${reference.path} does not match its registered SHA-256.`,
        [reference.name],
      );
    }
    const original = parseAnnotationSidecar(text);
    const expectedSummary = annotationSummary(original);
    if (JSON.stringify(expectedSummary) !== JSON.stringify(project.currentProject.annotations.summary)) {
      return annotationFailure(
        "E_ANN_SUMMARY",
        "The annotation master summary does not match the annotations sidecar.",
        [reference.name],
      );
    }
    return success({
      reference,
      text,
      workspace: {
        original: structuredClone(original),
        current: structuredClone(original),
        pendingConversions: [],
        pendingFiles: [],
      },
    });
  } catch (error: unknown) {
    return annotationFailure(
      "E_ANN_LOAD",
      `Could not load annotations: ${errorMessage(error)}`,
      [reference.name],
    );
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

class AnnotationCommitter implements OperationCommitter {
  readonly #project: ProjectStore;
  readonly #workspace: AnnotationWorkspace;
  readonly #originalText: string;
  readonly #resolverDependencies: AnnotationAnchorResolverDependencies;

  public constructor(
    project: ProjectStore,
    workspace: AnnotationWorkspace,
    originalText: string,
    resolverDependencies: AnnotationAnchorResolverDependencies,
  ) {
    this.#project = project;
    this.#workspace = workspace;
    this.#originalText = originalText;
    this.#resolverDependencies = resolverDependencies;
  }

  async #reconcileOrphans(
    model: GuyditorProject,
    transaction: TransactionRecord,
  ): Promise<Result<true>> {
    for (const annotation of this.#workspace.current.annotations) {
      if (annotation.state !== "open" && annotation.state !== "reopened") continue;
      const currentResolution = await resolveAnnotationRecord(
        model,
        annotation,
        annotation.canvasRef.sequenceId,
        this.#resolverDependencies,
      );
      if (!currentResolution.ok) return currentResolution;
      if (currentResolution.value.status === "resolved") {
        delete annotation.orphan;
        continue;
      }
      if (annotation.orphan !== undefined) continue;
      const original = this.#workspace.original.annotations.find(({ id }) =>
        id === annotation.id);
      if (original === undefined) continue;
      const previousResolution = await resolveAnnotationRecord(
        this.#project.currentProject,
        original,
        original.canvasRef.sequenceId,
        this.#resolverDependencies,
      );
      if (!previousResolution.ok) return previousResolution;
      if (
        previousResolution.value.status !== "resolved" ||
        previousResolution.value.timeline === undefined
      ) continue;
      annotation.orphan = {
        detectedAtRevision: model.revision,
        lastResolved: {
          sequenceId: original.canvasRef.sequenceId,
          timelineFrame: previousResolution.value.timeline,
        },
      };
      if (!transaction.orphanedAnchors.some(({ owner }) => owner === annotation.id)) {
        transaction.orphanedAnchors.push({
          owner: annotation.id,
          anchor: `ann:${annotation.id}`,
        });
      }
    }
    return success(true);
  }

  public async commit(
    model: GuyditorProject,
    transaction: TransactionRecord,
  ): Promise<Result<GuyditorProject>> {
    const conversionIds = transaction.operations.flatMap((operation) =>
      operation.op === "annotation.convert" &&
        typeof operation.params["annotationId"] === "string" &&
        operation.params["revert"] === undefined
        ? [operation.params["annotationId"]]
        : []);
    transaction.addresses = unique([...transaction.addresses, ...conversionIds]);

    const actor = transactionActor(transaction);
    for (const conversion of this.#workspace.pendingConversions) {
      const annotation = this.#workspace.current.annotations.find(
        ({ id }) => id === conversion.annotationId,
      );
      if (annotation !== undefined) {
        annotation.convertedTo = { itemId: conversion.itemId, txnId: transaction.id };
      }
    }

    for (const annotationId of transaction.addresses) {
      const annotation = this.#workspace.current.annotations.find(({ id }) => id === annotationId);
      if (annotation === undefined) {
        return annotationFailure(
          "E_ANN_NOT_FOUND",
          `Addressed annotation ${annotationId} does not exist.`,
          [annotationId],
        );
      }
      if (annotation.state === "open" || annotation.state === "reopened") {
        stateChange(
          annotation,
          "addressed",
          "resolved",
          actor,
          transaction.acceptance.at,
        );
      } else if (annotation.state !== "resolved") {
        return annotationFailure(
          "E_ANN_INVALID_TRANSITION",
          `Addressed annotation ${annotationId} cannot resolve from ${annotation.state}.`,
          [annotationId],
        );
      }
      annotation.resolvedBy = {
        txnId: transaction.id,
        revision: transaction.resultRevision,
      };
      if (!transaction.operations.some((operation) =>
        operation.op === "annotation.resolve" &&
        operation.params["annotationId"] === annotationId)) {
        transaction.operations.push({
          op: "annotation.resolve",
          params: { annotationId, txnId: transaction.id },
          summary: `Resolved annotation ${annotationId} via ${transaction.id}`,
          inverse: {
            op: "annotation.reopen",
            params: { annotationId, reason: `Undo ${transaction.id}` },
          },
        });
      }
    }

    for (const annotation of this.#workspace.current.annotations) {
      for (const entry of annotation.history) {
        if (entry.txnId === undefined) entry.txnId = transaction.id;
      }
      const transitionedToResolved = annotation.history.some((entry) =>
        entry.txnId === transaction.id && entry.to === "resolved");
      if (transitionedToResolved) {
        annotation.resolvedBy = {
          txnId: transaction.id,
          revision: transaction.resultRevision,
        };
      }
    }

    const reconciled = await this.#reconcileOrphans(model, transaction);
    if (!reconciled.ok) return reconciled;

    const refreshed = refreshAnnotationIndex(model, this.#workspace.current);
    if (!refreshed.ok) return refreshed;
    const content = serializeAnnotationSidecar(this.#workspace.current);
    const path = join(this.#project.root, ANNOTATION_PATH);
    const createdPaths: string[] = [];
    try {
      for (const file of this.#workspace.pendingFiles) {
        const absolute = join(this.#project.root, file.path);
        await mkdir(dirname(absolute), { recursive: true });
        try {
          await open(absolute, "wx").then(async (handle) => {
            await handle.close();
            await unlink(absolute);
          });
        } catch (error: unknown) {
          await Promise.all(createdPaths.map((created) => unlink(created).catch(() => undefined)));
          return annotationFailure(
            "E_ANN_GENERATED_COLLISION",
            `Generated annotation file ${file.path} already exists: ${errorMessage(error)}`,
            [file.path],
          );
        }
        await atomicWrite(absolute, file.content);
        createdPaths.push(absolute);
      }
      await atomicWrite(path, content);
      const committed = await this.#project.commit(refreshed.value, transaction);
      if (committed.ok) return committed;
      await atomicWrite(path, this.#originalText);
      await Promise.all(createdPaths.map((created) => unlink(created).catch(() => undefined)));
      return committed;
    } catch (error: unknown) {
      await atomicWrite(path, this.#originalText).catch(() => undefined);
      await Promise.all(createdPaths.map((created) => unlink(created).catch(() => undefined)));
      return annotationFailure(
        "E_ANN_COMMIT",
        `Annotation sidecar transaction failed: ${errorMessage(error)}`,
        [ANNOTATION_PATH],
      );
    }
  }

  public readAcceptedRevision(): Promise<Result<string>> {
    return this.#project.readAcceptedRevision();
  }

  public readTransaction(id: string): Promise<Result<TransactionRecord>> {
    return this.#project.readTransaction(id);
  }

  public restore(targetRevision: string): Promise<Result<GuyditorProject>> {
    return this.#project.restore(targetRevision);
  }
}

function operationActor(
  context: Omit<OperationContext, "baseRevision">,
): { kind: "human" | "agent"; id: string } {
  if (context.actor?.kind === "agent") {
    return { kind: "agent", id: context.actor.id };
  }
  if (context.actor?.kind === "human") {
    return { kind: "human", id: context.actor.id };
  }
  return context.origin === "agent"
    ? { kind: "agent", id: context.sessionId ?? "agent" }
    : { kind: "human", id: context.actor?.id ?? "ui" };
}

export class AnnotationService {
  readonly #appVersion: string;
  readonly #idFactory: IdFactory;
  readonly #now: () => Date;
  readonly #resolverDependencies: AnnotationAnchorResolverDependencies;

  public constructor(options: AnnotationServiceOptions = {}) {
    this.#appVersion = options.appVersion ?? "0.0.0";
    this.#idFactory = options.idFactory ?? makeId;
    this.#now = options.now ?? (() => new Date());
    this.#resolverDependencies = options.anchorResolvers instanceof AnchorResolverRegistry
      ? options.anchorResolvers.dependencies()
      : options.anchorResolvers ?? {};
  }

  public async execute(
    project: ProjectStore,
    operations: OperationInput[],
    context: Omit<OperationContext, "baseRevision"> = {
      origin: "ui",
      dryRun: false,
    },
  ): Promise<Result<OperationBatchResult>> {
    const loaded = await loadWorkspace(project);
    if (!loaded.ok) return loaded;
    const annotationStates = new Map<string, AnnotationDerivativeState>(
      loaded.value.workspace.current.annotations.map((candidate) => [
        candidate.id,
        {
          converted: candidate.convertedTo !== undefined,
          itemId: candidate.convertedTo?.itemId,
          sequenceId: candidate.canvasRef.sequenceId,
        },
      ]),
    );
    const renderedTargets = (state: AnnotationDerivativeState | undefined): string[] =>
      state?.converted === true ? [state.itemId ?? state.sequenceId] : [];
    const engine = new OperationEngine(project.currentProject, {
      appVersion: this.#appVersion,
      committer: new AnnotationCommitter(
        project,
        loaded.value.workspace,
        loaded.value.text,
        this.#resolverDependencies,
      ),
      idFactory: this.#idFactory,
      now: this.#now,
      operationDispatcher: createAnnotationDispatcher(loaded.value.workspace, {
        actor: operationActor(context),
        idFactory: this.#idFactory,
        now: this.#now,
      }),
      derivativeTargetResolver: (_model, input) => {
        if (input.op === "annotation.create") {
          const candidate = input.params["annotation"] as Partial<Annotation> | undefined;
          if (
            typeof candidate?.id === "string" &&
            typeof candidate.canvasRef?.sequenceId === "string"
          ) {
            const state: AnnotationDerivativeState = {
              converted: candidate.convertedTo !== undefined,
              itemId: candidate.convertedTo?.itemId,
              sequenceId: candidate.canvasRef.sequenceId,
            };
            annotationStates.set(candidate.id, state);
            return renderedTargets(state);
          }
          return [];
        }
        const annotationId = input.params["annotationId"];
        if (typeof annotationId !== "string") return [];
        if (input.op === "annotation.update") {
          const patch = input.params["patch"] as Readonly<Record<string, unknown>>;
          const state = annotationStates.get(annotationId);
          const targets = annotationPatchAffectsRenderedItem(patch)
            ? renderedTargets(state)
            : [];
          const canvasRef = patch["canvasRef"] as
            | Readonly<{ sequenceId?: unknown }>
            | undefined;
          if (state !== undefined && typeof canvasRef?.sequenceId === "string") {
            state.sequenceId = canvasRef.sequenceId;
          }
          return targets;
        }
        if (input.op === "annotation.delete") {
          const targets = renderedTargets(annotationStates.get(annotationId));
          annotationStates.delete(annotationId);
          return targets;
        }
        if (input.op !== "annotation.convert") return [];
        const state = annotationStates.get(annotationId);
        const revert = input.params["revert"] as
          | Readonly<{ itemId?: unknown }>
          | undefined;
        if (typeof revert?.itemId === "string") {
          if (state !== undefined) {
            state.converted = false;
            state.itemId = undefined;
          }
          return [revert.itemId];
        }
        if (state === undefined) return [];
        const itemId = input.params["itemId"];
        state.converted = true;
        state.itemId = typeof itemId === "string" ? itemId : undefined;
        return [state.sequenceId];
      },
      anchorResolvers: {
        ...this.#resolverDependencies,
        annotationResolver: createAnnotationAnchorResolver([
          loaded.value.workspace.original,
          loaded.value.workspace.current,
        ], this.#resolverDependencies),
      },
    });
    return engine.execute(operations, {
      ...context,
      baseRevision: project.currentProject.revision,
    });
  }

  public async commitAccepted(
    project: ProjectStore,
    model: GuyditorProject,
    transaction: TransactionRecord,
  ): Promise<Result<GuyditorProject>> {
    const loaded = await loadWorkspace(project);
    if (!loaded.ok) return loaded;
    return new AnnotationCommitter(
      project,
      loaded.value.workspace,
      loaded.value.text,
      this.#resolverDependencies,
    ).commit(model, transaction);
  }

  public registerAnchorResolver(
    registry: AnchorResolverRegistry,
    project: ProjectStore,
  ): void {
    registry.registerAnnotationResolver({
      async resolveAnnotation(model, annotationId, sequenceId) {
        const loaded = await loadWorkspace(project);
        if (!loaded.ok) return loaded;
        const resolver = createAnnotationAnchorResolver(
          [loaded.value.workspace.current],
          registry.dependencies(),
        );
        return resolver.resolveAnnotation(model, annotationId, sequenceId);
      },
    });
  }

  public async list(project: ProjectStore): Promise<Result<Annotation[]>> {
    const loaded = await loadWorkspace(project);
    return loaded.ok
      ? success(structuredClone(loaded.value.workspace.current.annotations))
      : loaded;
  }

  public async get(
    project: ProjectStore,
    annotationId: string,
  ): Promise<Result<Annotation | undefined>> {
    const loaded = await loadWorkspace(project);
    if (!loaded.ok) return loaded;
    const annotation = loaded.value.workspace.current.annotations.find(({ id }) =>
      id === annotationId);
    return success(annotation === undefined ? undefined : structuredClone(annotation));
  }

  public async getState(
    project: ProjectStore,
    annotationId: string,
    pending: ReadonlyArray<{ status: string; addresses: string[] }> = [],
  ): Promise<Result<AnnotationState | undefined>> {
    const annotation = await this.get(project, annotationId);
    if (!annotation.ok) return annotation;
    if (annotation.value === undefined) return success(undefined);
    return success(
      (annotation.value.state === "open" || annotation.value.state === "reopened") &&
        pending.some(({ status, addresses }) =>
          status === "ready" && addresses.includes(annotationId))
        ? "addressed"
        : annotation.value.state,
    );
  }
}
