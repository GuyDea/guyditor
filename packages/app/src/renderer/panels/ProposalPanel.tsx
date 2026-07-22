import { useState } from "react";

import type { Proposal, SemanticDiffEntry } from "../../../../core/src/index.js";
import { errorMessage } from "../ipc.js";
import { useAgentPanelStore } from "../state/view-state.js";
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
  refreshProject,
  refreshAnnotations,
  refreshProposals,
  restylePlan,
  refreshRestylePlan,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const expandedProposalId = useAgentPanelStore((state) => state.expandedProposalId);
  const setExpandedProposal = useAgentPanelStore((state) => state.setExpandedProposal);
  const [revisionInstruction, setRevisionInstruction] = useState("");

  async function act(
    proposal: Proposal,
    action: "acceptProposal" | "rejectProposal" | "supersedeProposal",
  ): Promise<void> {
    try {
      await window.guyditor.call("OperationEngine", action, {
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
      setRevisionInstruction("");
    } catch (error: unknown) {
      setNotice(errorMessage(error));
      await refreshProposals();
    }
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
          const stale = proposal.staleBase === true || proposal.baseRevision !== snapshot?.revision;
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
                  <div className="proposal-controls">
                    <button
                      type="button"
                      className="primary-action"
                      data-testid={`proposal-accept-${proposal.id}`}
                      disabled={stale && !rebasableRestyle}
                      onClick={() => void act(proposal, "acceptProposal")}
                    >{stale && rebasableRestyle ? "Rebase + accept" : "Accept"}</button>
                    <button type="button" data-testid={`proposal-reject-${proposal.id}`} onClick={() => void act(proposal, "rejectProposal")}>Reject</button>
                    <button type="button" data-testid={`proposal-preview-${proposal.id}`} disabled title="Comparison rendering is M2">Compare summary</button>
                  </div>
                  <div className="revision-box">
                    <input
                      type="text"
                      value={revisionInstruction}
                      placeholder="Revision instruction"
                      data-testid={`proposal-revise-input-${proposal.id}`}
                      aria-label="Revision instruction"
                      onChange={(event) => setRevisionInstruction(event.target.value)}
                    />
                    <button type="button" data-testid={`proposal-supersede-${proposal.id}`} onClick={() => void act(proposal, "supersedeProposal")}>Supersede</button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
        {proposals.length === 0 ? <li className="empty-copy">No open proposals.</li> : null}
      </ol>
      <small className="m2-note">The M1 proposal panel renders semantic comparison summaries. Generated comparison frames and director conversation are M2/later surfaces.</small>
    </Panel>
  );
}
