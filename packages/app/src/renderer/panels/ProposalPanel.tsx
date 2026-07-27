import { useEffect, useRef, useState } from "react";

import type {
  EvidenceRef,
  Proposal,
  SemanticDiffEntry,
} from "../../../../core/src/index.js";
import { activateDeliverable } from "../active-deliverable.js";
import { errorMessage, setActiveDeliverable } from "../ipc.js";
import {
  beginContextRequest,
  createContextRequestGate,
  invalidateContextRequests,
  isContextRequestCurrent,
  isContextRequestLatest,
} from "../state/async-context.js";
import {
  useAgentPanelStore,
  usePreviewStore,
  useSelectionStore,
} from "../state/view-state.js";
import { useProjectMirror } from "../state/project-mirror.js";
import { projectDeliverableContextKey } from "../state/project-context.js";
import { Panel } from "./Panel.js";
import { RestylePlanReview } from "./RestylePlan.js";
import type { WorkspacePanelProps } from "./types.js";

function grouped(entries: SemanticDiffEntry[]): Array<[string, SemanticDiffEntry[]]> {
  const groups = new Map<string, SemanticDiffEntry[]>();
  for (const entry of entries) {
    const values = groups.get(entry.entityType) ?? [];
    values.push(entry);
    groups.set(entry.entityType, values);
  }
  return [...groups];
}

export function ProposalPanel({
  snapshot,
  proposals,
  pinnedSkills,
  refreshProject,
  refreshAnnotations,
  refreshProposals,
  refreshSkills,
  restylePlan,
  refreshRestylePlan,
  onProposalResolved,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const expandedProposalId = useAgentPanelStore((state) => state.expandedProposalId);
  const setExpandedProposal = useAgentPanelStore((state) => state.setExpandedProposal);
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [captureSkillId, setCaptureSkillId] = useState("");
  const [exampleDescription, setExampleDescription] = useState("");
  const [resolvedExamples, setResolvedExamples] = useState<Proposal[]>([]);
  const setPlayhead = usePreviewStore((state) => state.setPlayhead);
  const selectWord = useSelectionStore((state) => state.selectWord);
  const setWordRange = useSelectionStore((state) => state.setWordRange);
  const selectAnnotation = useSelectionStore((state) => state.selectAnnotation);
  const evidenceGate = useRef(createContextRequestGate());

  useEffect(() => () => {
    invalidateContextRequests(evidenceGate.current);
  }, []);

  async function jumpToEvidence(evidence: EvidenceRef): Promise<void> {
    const requestSnapshot = useProjectMirror.getState().snapshot;
    const selectedBefore = useSelectionStore.getState().selectedDeliverableId;
    const targetDeliverableId = evidence.deliverableId ?? selectedBefore;
    const request = beginContextRequest(
      evidenceGate.current,
      projectDeliverableContextKey(requestSnapshot, targetDeliverableId),
    );
    if (evidence.deliverableId !== undefined) {
      if (requestSnapshot === null) {
        if (isContextRequestLatest(evidenceGate.current, request)) {
          setNotice(
            `Evidence target is unavailable: open a project containing ${evidence.deliverableId}.`,
          );
        }
        return;
      }
      try {
        await activateDeliverable(
          requestSnapshot.master,
          evidence.deliverableId,
          setNotice,
          (deliverableId) => setActiveDeliverable(
            requestSnapshot.projectPath,
            deliverableId,
          ),
        );
      } catch (error: unknown) {
        if (isContextRequestCurrent(
          evidenceGate.current,
          request,
          projectDeliverableContextKey(
            useProjectMirror.getState().snapshot,
            targetDeliverableId,
          ),
        )) {
          setNotice(`Evidence target is unavailable: ${errorMessage(error)}`);
        }
        return;
      }
      const currentSnapshot = useProjectMirror.getState().snapshot;
      const currentDeliverableId =
        useSelectionStore.getState().selectedDeliverableId;
      if (!isContextRequestCurrent(
        evidenceGate.current,
        request,
        projectDeliverableContextKey(
          currentSnapshot,
          currentDeliverableId,
        ),
      ) || currentDeliverableId !== targetDeliverableId) return;
    } else if (!isContextRequestLatest(evidenceGate.current, request)) {
      return;
    }
    if (evidence.sourceRange !== undefined) setPlayhead(evidence.sourceRange.start);
    if (evidence.wordRange !== undefined) {
      selectWord(evidence.wordRange.from);
      setWordRange({
        fromWord: evidence.wordRange.from,
        toWord: evidence.wordRange.to,
      });
    }
    if (evidence.annotationId !== undefined) selectAnnotation(evidence.annotationId);
  }

  function evidenceLabel(evidence: EvidenceRef): string {
    if (evidence.wordRange !== undefined) {
      return `${evidence.wordRange.from}–${evidence.wordRange.to}`;
    }
    if (evidence.sourceRange !== undefined) {
      return `${evidence.assetId ?? "source"} @ ${String(evidence.sourceRange.start.frames)}f`;
    }
    return evidence.annotationId ?? evidence.deliverableId ?? evidence.assetId ?? "evidence";
  }

  async function act(
    proposal: Proposal,
    action: "acceptProposal" | "rejectProposal" | "supersedeProposal",
  ): Promise<void> {
    try {
      const resolved = await window.guyditor.call<Proposal>("OperationEngine", action, {
        proposalId: proposal.id,
        ...(action === "supersedeProposal"
          ? { instruction: revisionInstruction.trim() || "Revise this proposal with the latest feedback" }
          : {}),
      });
      await Promise.all([
        refreshProject(),
        refreshAnnotations(),
        refreshProposals(),
        refreshRestylePlan(),
      ]);
      setNotice(`${action === "acceptProposal" ? "Accepted" : action === "rejectProposal" ? "Rejected" : "Superseded"} ${proposal.id}.`);
      if (resolved.status === "accepted" || resolved.status === "rejected") {
        onProposalResolved?.(resolved.status);
        setResolvedExamples((current) => [
          resolved,
          ...current.filter(({ id }) => id !== resolved.id),
        ]);
      }
      setRevisionInstruction("");
    } catch (error: unknown) {
      setNotice(errorMessage(error));
      await refreshProposals();
    }
  }

  async function saveExample(proposal: Proposal): Promise<void> {
    const skillId = captureSkillId || pinnedSkills[0]?.manifest.id;
    if (skillId === undefined) {
      setNotice("Pin an editorial skill before saving a preference example.");
      return;
    }
    if (proposal.status !== "accepted" && proposal.status !== "rejected") return;
    try {
      const draft = await window.guyditor.call<{ manifest: { version: string } }>(
        "SkillRegistry",
        "captureExample",
        {
          proposalId: proposal.id,
          skillId,
          decision: proposal.status === "accepted" ? "approved" : "rejected",
          description: exampleDescription.trim() || proposal.reason.text,
        },
      );
      await refreshSkills();
      setExampleDescription("");
      setNotice(`Saved ${proposal.status === "accepted" ? "approved" : "rejected"} example to inactive draft v${draft.manifest.version}. Publish and upgrade explicitly to activate it.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function exampleCapture(proposal: Proposal): React.JSX.Element | null {
    if (proposal.status !== "accepted" && proposal.status !== "rejected") return null;
    return (
      <div className="preference-capture" data-testid={`proposal-example-${proposal.id}`}>
        <strong>Save as {proposal.status === "accepted" ? "approved" : "rejected"} example</strong>
        <select
          aria-label="Editorial skill"
          value={captureSkillId || pinnedSkills[0]?.manifest.id || ""}
          disabled={pinnedSkills.length === 0}
          onChange={(event) => setCaptureSkillId(event.target.value)}
        >
          {pinnedSkills.map(({ manifest }) => (
            <option key={manifest.id} value={manifest.id}>{manifest.title} · v{manifest.version}</option>
          ))}
        </select>
        <input
          type="text"
          aria-label="Example description"
          placeholder="Why this edit matches—or misses—the preference"
          value={exampleDescription}
          onChange={(event) => setExampleDescription(event.target.value)}
        />
        <button
          type="button"
          className="primary-action"
          disabled={pinnedSkills.length === 0}
          data-testid={`proposal-save-example-${proposal.id}`}
          onClick={() => void saveExample(proposal)}
        >Save to new draft version</button>
      </div>
    );
  }

  return (
    <Panel
      id="agent"
      title="Proposals"
      eyebrow="Semantic review"
      actions={<button type="button" data-testid="proposal-refresh" onClick={() => void refreshProposals()}>Refresh</button>}
    >
      <RestylePlanReview
        snapshot={snapshot}
        restylePlan={restylePlan}
        refreshProposals={refreshProposals}
        refreshRestylePlan={refreshRestylePlan}
        setNotice={setNotice}
      />
      <ol className="proposal-list" data-testid="proposal-list">
        {proposals.map((proposal) => {
          const stale = proposal.status === "ready" &&
            (proposal.staleBase === true || proposal.baseRevision !== snapshot?.revision);
          const rebasableRestyle = proposal.operations.length > 0 &&
            proposal.operations.every(({ op }) =>
              op === "restyle.segment.approve" || op === "clip.split" || op === "clip.punchin.set");
          const expanded = expandedProposalId === proposal.id || proposals.length === 1;
          return (
            <li key={proposal.id} data-testid={`proposal-${proposal.id}`}>
              <button
                type="button"
                className="proposal-heading"
                data-testid={`proposal-expand-${proposal.id}`}
                aria-expanded={expanded}
                onClick={() => setExpandedProposal(expanded ? null : proposal.id)}
              >
                <span>
                  <strong>{proposal.id}</strong>
                  <small>{proposal.actor.id} · {proposal.riskClass} risk</small>
                </span>
                <span className="state-chip" data-state={stale ? "failed" : "ready"}>
                  {stale ? "stale" : proposal.status}
                </span>
              </button>
              {expanded ? (
                <div className="proposal-detail">
                  <p>{proposal.reason.text}</p>
                  <div className="chip-row">
                    {proposal.addresses.map((id) => <span key={id} className="entity-chip">{id}</span>)}
                  </div>
                  {proposal.assessment === undefined ? null : (
                    <section
                      className="assessment-review"
                      data-testid={`proposal-assessment-${proposal.id}`}
                    >
                      <header>
                        <span className="state-chip" data-state="ready">Recommendation</span>
                        <strong>{proposal.assessment.question}</strong>
                      </header>
                      <dl className="assessment-criteria">
                        {proposal.assessment.criteria.map((criterion) => (
                          <div key={criterion.id}>
                            <dt>{criterion.id}</dt>
                            <dd>
                              {criterion.text}
                              <small>{criterion.source === "skill_rule"
                                ? `${criterion.skillId} · ${criterion.ruleId}`
                                : "inline disclosed criterion"}</small>
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {proposal.assessment.subjects.map((subject, subjectIndex) => (
                        <article key={`${proposal.assessmentId}-${String(subjectIndex)}`}>
                          <button
                            type="button"
                            className="evidence-jump"
                            onClick={() => void jumpToEvidence(subject.ref)}
                          >Jump to {evidenceLabel(subject.ref)}</button>
                          <h4>Observed</h4>
                          {subject.observations.map((observation) => (
                            <div className="assessment-observation" key={observation.id}>
                              <p>{observation.text}</p>
                              <div className="chip-row">
                                {observation.evidence.map((evidence, evidenceIndex) => (
                                  <button
                                    type="button"
                                    className="entity-chip evidence-jump"
                                    key={`${observation.id}-${String(evidenceIndex)}`}
                                    onClick={() => void jumpToEvidence(evidence)}
                                  >{evidenceLabel(evidence)}</button>
                                ))}
                              </div>
                            </div>
                          ))}
                          <h4>Inferred</h4>
                          {subject.inferences.map((inference, inferenceIndex) => (
                            <p className="assessment-inference" key={`${inference.text}-${String(inferenceIndex)}`}>
                              {inference.text}
                              <small>{inference.confidence} confidence · based on {inference.basedOn.join(", ")}</small>
                            </p>
                          ))}
                          {subject.scores === undefined ? null : (
                            <div className="score-ledger">
                              {subject.scores.map((score) => (
                                <span key={score.criterionId}>{score.criterionId} {String(score.value)}/5</span>
                              ))}
                            </div>
                          )}
                        </article>
                      ))}
                      {proposal.assessment.comparison === undefined ? null : (
                        <p><strong>Ranking:</strong> {proposal.assessment.comparison.rankedRefs.join(" → ")} · {proposal.assessment.comparison.rationale}</p>
                      )}
                      <small className="assessment-limitations">Limitations: {proposal.assessment.limitations}</small>
                    </section>
                  )}
                  <div className="semantic-diff" data-testid={`proposal-diff-${proposal.id}`}>
                    {proposal.diff === undefined ? (
                      <ul>{proposal.operations.map((operation, index) => <li key={`${operation.op}-${String(index)}`}>{operation.summary}</li>)}</ul>
                    ) : (
                      grouped(proposal.diff.entries).map(([entityType, entries]) => (
                        <section key={entityType}>
                          <h3>{entityType}</h3>
                          <ul>
                            {entries.map((entry, index) => (
                              <li key={`${entry.entityId}-${String(index)}`}>
                                <span data-change={entry.change}>{entry.change}</span>
                                <strong>{entry.entityId}</strong>
                                <p>{entry.summary}</p>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))
                    )}
                    {proposal.diff?.orphanedAnchors.map((orphan) => (
                      <p key={`${orphan.owner}-${orphan.anchorPath}`} className="orphan-warning">
                        Orphan warning: {orphan.owner} · {orphan.reason}
                      </p>
                    ))}
                    {proposal.diff === undefined ? null : (
                      <dl className="diff-stats">
                        <div><dt>Clips −</dt><dd>{proposal.diff.stats.clipsRemoved}</dd></div>
                        <div><dt>Clips +</dt><dd>{proposal.diff.stats.clipsAdded}</dd></div>
                        <div><dt>Modified</dt><dd>{proposal.diff.stats.clipsModified}</dd></div>
                      </dl>
                    )}
                  </div>
                  {proposal.status === "ready" ? <div className="proposal-controls">
                    <button
                      type="button"
                      className="primary-action"
                      data-testid={`proposal-accept-${proposal.id}`}
                      disabled={stale && !rebasableRestyle}
                      onClick={() => void act(proposal, "acceptProposal")}
                    >{stale && rebasableRestyle ? "Rebase + accept" : "Accept"}</button>
                    <button type="button" data-testid={`proposal-reject-${proposal.id}`} onClick={() => void act(proposal, "rejectProposal")}>Reject</button>
                    <button type="button" data-testid={`proposal-preview-${proposal.id}`} disabled title="Comparison rendering is M2">Compare summary</button>
                  </div> : null}
                  {proposal.status === "ready" ? <div className="revision-box">
                    <input
                      type="text"
                      value={revisionInstruction}
                      placeholder="Revision instruction"
                      data-testid={`proposal-revise-input-${proposal.id}`}
                      aria-label="Revision instruction"
                      onChange={(event) => setRevisionInstruction(event.target.value)}
                    />
                    <button type="button" data-testid={`proposal-supersede-${proposal.id}`} onClick={() => void act(proposal, "supersedeProposal")}>Supersede</button>
                  </div> : null}
                  {exampleCapture(proposal)}
                </div>
              ) : null}
            </li>
          );
        })}
        {proposals.length === 0 ? <li className="empty-copy">No open proposals.</li> : null}
      </ol>
      {resolvedExamples.length === 0 ? null : (
        <section className="resolved-example-tray" data-testid="resolved-example-tray">
          <header><strong>Preference examples</strong><span>Resolved this session</span></header>
          {resolvedExamples.map((proposal) => (
            <article key={proposal.id}>
              <p>{proposal.reason.text}</p>
              {exampleCapture(proposal)}
            </article>
          ))}
        </section>
      )}
      <small className="m2-note">The M1 proposal panel renders semantic comparison summaries. Generated comparison frames and director conversation are M2/later surfaces.</small>
    </Panel>
  );
}
