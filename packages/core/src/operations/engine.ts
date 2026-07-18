import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import trimSchema from "./schemas/clip.trim.json" with { type: "json" };
import splitSchema from "./schemas/clip.split.json" with { type: "json" };
import joinSchema from "./schemas/clip.join.json" with { type: "json" };
import assetIngestSchema from "./schemas/asset.ingest.json" with { type: "json" };
import assetRemoveSchema from "./schemas/asset.remove.json" with { type: "json" };
import transcriptCreateSchema from "./schemas/transcript.create.json" with { type: "json" };
import transcriptWordCorrectSchema from "./schemas/transcript.word.correct.json" with { type: "json" };
import transcriptWordReplaceSchema from "./schemas/transcript.word.replace.json" with { type: "json" };
import transcriptWordInsertSchema from "./schemas/transcript.word.insert.json" with { type: "json" };
import transcriptWordDeleteSchema from "./schemas/transcript.word.delete.json" with { type: "json" };
import transcriptWordRetimeSchema from "./schemas/transcript.word.retime.json" with { type: "json" };
import transcriptSegmentSplitSchema from "./schemas/transcript.segment.split.json" with { type: "json" };
import transcriptSegmentMergeSchema from "./schemas/transcript.segment.merge.json" with { type: "json" };
import transcriptSpeakerAssignSchema from "./schemas/transcript.speaker.assign.json" with { type: "json" };
import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import {
  formatRevision,
  makeId,
  parseRevision,
  validateProject,
} from "../project/index.js";
import type {
  GuyditorProject,
  IdPrefix,
} from "../project/index.js";
import type { TransactionRecord } from "../store/types.js";
import { applyClipOperation } from "./clip.js";
import type { ClipApplication } from "./clip.js";
import { applyAssetOperation } from "./asset.js";
import { buildSemanticDiff } from "./diff.js";
import type {
  AppliedOperation,
  OperationBatchResult,
  OperationContext,
  OperationInput,
  RiskClass,
} from "./types.js";

export type IdFactory = (prefix: IdPrefix) => string;

export interface OperationCommitter {
  commit(
    model: GuyditorProject,
    transaction: TransactionRecord,
  ): Promise<Result<GuyditorProject>>;
}

export interface DispatchedOperationApplication {
  model: GuyditorProject;
  inverse: OperationInput[];
  affected: string[];
  summary: string;
}

export type OperationDispatcher = (
  project: GuyditorProject,
  input: OperationInput,
) => Result<DispatchedOperationApplication> |
  Promise<Result<DispatchedOperationApplication>>;

export interface OperationEngineOptions {
  idFactory?: IdFactory;
  committer?: OperationCommitter;
  appVersion?: string;
  now?: () => Date;
  operationDispatcher?: OperationDispatcher;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
interface CatalogEntry {
  captionImpact: AppliedOperation["captionImpact"];
  riskClass: RiskClass;
  summaryTemplate: string;
  validate: ValidateFunction<Record<string, unknown>>;
}

function catalogEntry(
  schema: object,
  riskClass: RiskClass,
  captionImpact: AppliedOperation["captionImpact"],
  summaryTemplate: string,
): CatalogEntry {
  return {
    validate: ajv.compile<Record<string, unknown>>(schema),
    riskClass,
    captionImpact,
    summaryTemplate,
  };
}

const catalog = new Map<string, CatalogEntry>([
  ["asset.ingest", catalogEntry(assetIngestSchema, "normal", "none", "Ingest {n} assets")],
  ["asset.remove", catalogEntry(assetRemoveSchema, "normal", "none", "Remove {n} assets")],
  ["clip.trim", catalogEntry(trimSchema, "normal", "none", "Trim {clip}")],
  ["clip.split", catalogEntry(splitSchema, "normal", "none", "Split {clip}")],
  ["clip.join", catalogEntry(joinSchema, "normal", "none", "Join {clips}")],
  ["transcript.create", catalogEntry(
    transcriptCreateSchema,
    "low",
    "shift",
    "Register canonical transcript for {asset}",
  )],
  ["transcript.word.correct", catalogEntry(
    transcriptWordCorrectSchema,
    "low",
    "shift",
    "Correct {word}",
  )],
  ["transcript.word.replace", catalogEntry(
    transcriptWordReplaceSchema,
    "low",
    "shift",
    "Replace {wordRange}",
  )],
  ["transcript.word.insert", catalogEntry(
    transcriptWordInsertSchema,
    "low",
    "shift",
    "Insert words in {segment}",
  )],
  ["transcript.word.delete", catalogEntry(
    transcriptWordDeleteSchema,
    "low",
    "shift",
    "Delete {wordRange}",
  )],
  ["transcript.word.retime", catalogEntry(
    transcriptWordRetimeSchema,
    "low",
    "realign",
    "Retime {word}",
  )],
  ["transcript.segment.split", catalogEntry(
    transcriptSegmentSplitSchema,
    "low",
    "shift",
    "Split {segment}",
  )],
  ["transcript.segment.merge", catalogEntry(
    transcriptSegmentMergeSchema,
    "low",
    "shift",
    "Merge {segments}",
  )],
  ["transcript.speaker.assign", catalogEntry(
    transcriptSpeakerAssignSchema,
    "low",
    "shift",
    "Assign {speaker}",
  )],
]);

const RISK_RANK: Record<RiskClass, number> = {
  low: 0,
  normal: 1,
  consequential: 2,
};

function maximumRisk(classes: readonly RiskClass[]): RiskClass {
  return classes.reduce<RiskClass>(
    (maximum, current) => RISK_RANK[current] > RISK_RANK[maximum] ? current : maximum,
    "low",
  );
}

function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath === "" ? "/" : error.instancePath;
  return `${path} ${error.message ?? error.keyword}`;
}

function operationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function actorFor(context: OperationContext): TransactionRecord["actor"] {
  if (context.origin === "ui") return { kind: "human", id: "ui" };
  if (context.origin === "agent") {
    return { kind: "agent", id: context.sessionId ?? "agent" };
  }
  return { kind: "tool", id: "system" };
}

function instructionFor(context: OperationContext): TransactionRecord["instruction"] {
  return context.origin === "ui"
    ? { kind: "ui-direct" }
    : { kind: "skill-policy" };
}

export class OperationEngine {
  readonly #idFactory: IdFactory;
  readonly #committer: OperationCommitter | undefined;
  readonly #appVersion: string;
  readonly #now: () => Date;
  readonly #operationDispatcher: OperationDispatcher | undefined;
  #project: GuyditorProject;

  public constructor(project: GuyditorProject, options: OperationEngineOptions = {}) {
    this.#project = project;
    this.#idFactory = options.idFactory ?? ((prefix) => makeId(prefix));
    this.#committer = options.committer;
    this.#appVersion = options.appVersion ?? "0.0.0";
    this.#now = options.now ?? (() => new Date());
    this.#operationDispatcher = options.operationDispatcher;
  }

  public get currentProject(): GuyditorProject {
    return this.#project;
  }

  public async execute(
    batch: OperationInput[],
    context: OperationContext,
  ): Promise<Result<OperationBatchResult>> {
    const base = this.#project;
    if (context.baseRevision !== base.revision) {
      return operationFailure(
        "E_OP_STALE_BASE",
        `Operation base ${context.baseRevision} does not match accepted revision ${base.revision}.`,
      );
    }
    if (context.origin === "agent" && !context.dryRun && context.proposalId === undefined) {
      return operationFailure(
        "E_OP_AGENT_DIRECT",
        "Agent operations must be committed through a proposal or automation policy.",
      );
    }

    let working = base;
    const applied: AppliedOperation[] = [];
    const applications: ClipApplication[] = [];
    for (const requested of batch) {
      const definition = catalog.get(requested.op);
      if (definition === undefined) {
        return operationFailure("E_OP_UNKNOWN", `Unknown operation ${requested.op}.`);
      }
      const params = structuredClone(requested.params);
      if (
        requested.op === "clip.split" &&
        typeof params["at"] === "string" &&
        params["at"].startsWith("word:")
      ) {
        return operationFailure(
          "E_OP_SCHEMA",
          "clip.split word anchors are deferred until transcripts are available; use clip-relative integer frames in M0.",
        );
      }
      if (!definition.validate(params)) {
        const detail = definition.validate.errors?.map(formatSchemaError).join("; ") ??
          "unknown schema error";
        return operationFailure(
          "E_OP_SCHEMA",
          `${requested.op} parameters failed schema validation: ${detail}`,
        );
      }

      const normalized = { op: requested.op, params };
      let application: Result<ClipApplication>;
      if (requested.op.startsWith("asset.")) {
        application = applyAssetOperation(working, normalized);
      } else if (requested.op.startsWith("clip.")) {
        application = applyClipOperation(working, normalized, this.#idFactory);
      } else if (this.#operationDispatcher === undefined) {
        application = operationFailure(
          "E_OP_DISPATCH_UNAVAILABLE",
          `Operation ${requested.op} has no domain dispatcher.`,
          [requested.op],
        );
      } else {
        const dispatched = await this.#operationDispatcher(working, normalized);
        application = dispatched.ok
          ? success({ ...dispatched.value, mutations: [] })
          : dispatched;
      }
      if (!application.ok) return application;
      working = application.value.model;
      applications.push(application.value);
      applied.push({
        op: requested.op,
        params,
        summary: application.value.summary,
        inverse: application.value.inverse,
        captionImpact: definition.captionImpact,
        // TODO(Part 5 §5.7): run audio-continuity guards at moved cut boundaries.
        warnings: [],
        affected: application.value.affected,
      });
    }

    const valid = validateProject(working);
    if (!valid.ok) return valid;
    const diff = buildSemanticDiff(base, working, applications, applied);
    const result: OperationBatchResult = {
      base: base.revision,
      applied,
      riskClass: maximumRisk(applied.map(({ op }) => catalog.get(op)!.riskClass)),
      diff,
    };
    if (context.dryRun) return success(result);

    const resultRevision = formatRevision(parseRevision(base.revision) + 1);
    const committedCandidate = { ...working, revision: resultRevision };
    const transactionId = this.#idFactory("txn");
    const actor = actorFor(context);
    const transaction: TransactionRecord = {
      id: transactionId,
      baseRevision: base.revision,
      resultRevision,
      operations: applied.map((operation) => ({
        op: operation.op,
        params: operation.params,
        summary: operation.summary,
        // TODO(Part 5 §5.13): TransactionRecord's v1 envelope has one inverse
        // slot; persist multi-step inverses when the undo-record format lands.
        ...(operation.inverse.length === 1
          ? { inverse: operation.inverse[0] }
          : {}),
      })),
      instruction: instructionFor(context),
      actor,
      versions: {
        app: this.#appVersion,
        schema: "guyditor/v1",
        skills: base.skills.map(({ id, version }) => ({ id, version })),
        presets: base.presets.map(({ id, version }) => ({ id, version })),
        tools: [],
      },
      acceptance: {
        status: "accepted",
        by: actor.id,
        at: this.#now().toISOString(),
        ...(context.proposalId === undefined
          ? {}
          : { proposal: context.proposalId }),
      },
      orphanedAnchors: [],
      addresses: [],
    };
    const committed = this.#committer === undefined
      ? success(committedCandidate)
      : await this.#committer.commit(committedCandidate, transaction);
    if (!committed.ok) return committed;
    this.#project = committed.value;
    return success({ ...result, transactionId });
  }
}
