import {
  AnchorResolverRegistry,
  makeId,
  OperationEngine,
} from "../../../core/src/index.js";
import type { Annotation, AuditSink, JobRecord, OperationInput, Result } from "../../../core/src/index.js";
import {
  compileFillerProposal,
  createTranscriptWordLookup,
  parseFillerDetectionResult,
} from "../../../transcript/src/index.js";
import { loadTranscriptWorkspace } from "../../../transcript/src/operations.js";
import type { FillerCandidate, FillerScope } from "../../../transcript/src/index.js";
import type { GdEventWithoutSeq } from "../shared/ipc.js";
import type { ProjectServices } from "./project-services.js";

export interface FillerFollowUpDeps {
  readonly appVersion: string;
  readonly auditSink: AuditSink;
  readonly publish: (event: GdEventWithoutSeq) => void;
}

function resultValue<Value>(result: Result<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Keeps a candidate only when it lies inside a range the assembly kept; compares in seconds. */
export function withinKeptRanges(candidate: FillerCandidate, scope: FillerScope | undefined): boolean {
  if (scope === undefined) return true;
  const { assetId, start, end } = candidate.sourceRange;
  return scope.keptRanges.some((kept) =>
    kept.assetId === assetId
    && start.samples / start.rate >= kept.start.samples / kept.start.rate
    && end.samples / end.rate <= kept.end.samples / kept.end.rate);
}

async function addReviewMarkers(
  project: ProjectServices,
  candidates: readonly FillerCandidate[],
): Promise<void> {
  const model = project.store.currentProject;
  const deliverable = model.deliverables.find(({ id }) => id === model.settings.primaryDeliverable);
  if (deliverable === undefined) return;
  const now = new Date().toISOString();
  const operations: OperationInput[] = candidates.flatMap((candidate) => {
    if (candidate.reviewRequired !== true || candidate.wordRange === undefined) return [];
    const annotation: Annotation = {
      id: makeId("ann"),
      // A "range" annotation needs a positive extent; a word marker has none, so it is a note.
      shape: "note",
      body: `review: ${candidate.evidence}`,
      geometry: null,
      anchor: { kind: "word", wordId: candidate.wordRange.fromWord },
      extent: { frames: 0, fps: model.settings.timeline.fps },
      canvasRef: { sequenceId: deliverable.sequenceId, deliverableId: deliverable.id, aspect: "16:9" },
      state: "open",
      blocking: false,
      author: { kind: "agent", id: "assist.fillers.detect" },
      createdAt: now,
      history: [],
    };
    return [{ op: "annotation.create", params: { annotation } }];
  });
  if (operations.length === 0) return;
  resultValue(await project.annotations.execute(project.store, operations, { origin: "system", dryRun: false }));
}

export async function createFillerProposal(
  deps: FillerFollowUpDeps,
  project: ProjectServices,
  job: JobRecord,
): Promise<void> {
  const parsed = parseFillerDetectionResult(job.payload);
  const candidates = parsed.candidates.filter((candidate) => withinKeptRanges(candidate, parsed.scope));
  const detected = { ...parsed, candidates };
  if (detected.candidates.length === 0) return;
  const workspace = resultValue(await loadTranscriptWorkspace(project.store, (prefix) => {
    if (prefix === "seg" || prefix === "spk") {
      return `${prefix}_${makeId("txn").slice(4)}`;
    }
    return makeId(prefix);
  }));
  const resolvers = new AnchorResolverRegistry();
  resolvers.registerWordLookup(createTranscriptWordLookup(workspace.sidecars));
  const engine = new OperationEngine(project.store.currentProject, {
    appVersion: deps.appVersion,
    committer: project.store,
    proposalStore: project.store,
    operationDispatcher: workspace.dispatcher,
    templateProvider: project.templates,
    anchorResolvers: resolvers,
    auditSink: deps.auditSink,
  });
  const proposal = resultValue(await compileFillerProposal(detected.candidates, {
    engine,
    selectedCandidateIds: detected.candidates.map(({ id }) => id),
    idFactory: makeId,
  }));
  await addReviewMarkers(project, detected.candidates);
  deps.publish({ kind: "proposal.updated", proposalId: proposal.id });
}
