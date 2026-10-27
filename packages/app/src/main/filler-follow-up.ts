import {
  AnchorResolverRegistry,
  makeId,
  OperationEngine,
} from "../../../core/src/index.js";
import type { AuditSink, JobRecord, Result } from "../../../core/src/index.js";
import {
  compileFillerProposal,
  createTranscriptWordLookup,
  parseFillerDetectionResult,
} from "../../../transcript/src/index.js";
import { loadTranscriptWorkspace } from "../../../transcript/src/operations.js";
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

export async function createFillerProposal(
  deps: FillerFollowUpDeps,
  project: ProjectServices,
  job: JobRecord,
): Promise<void> {
  const detected = parseFillerDetectionResult(job.payload);
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
  deps.publish({ kind: "proposal.updated", proposalId: proposal.id });
}
