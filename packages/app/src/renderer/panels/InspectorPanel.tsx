import { useMemo, useState } from "react";

import type { TransactionRecord } from "../../../../core/src/index.js";
import { errorMessage } from "../ipc.js";
import { useSelectionStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import { KeyInspector } from "./KeyInspector.js";
import { PipInspector } from "./PipInspector.js";
import type { WorkspacePanelProps } from "./types.js";
import { AudioInspector } from "./AudioInspector.js";

function actorLabel(transaction: TransactionRecord): string {
  return `${transaction.actor.kind}:${transaction.actor.id}`;
}

export function InspectorPanel({
  snapshot,
  annotations,
  transcripts,
  refreshProject,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const selectedClipId = useSelectionStore((state) => state.selectedClipId);
  const selectedLayerId = useSelectionStore((state) => state.selectedLayerId);
  const selectedWordId = useSelectionStore((state) => state.selectedWordId);
  const selectedAnnotationId = useSelectionStore((state) => state.selectedAnnotationId);
  const [history, setHistory] = useState<TransactionRecord[] | null>(null);
  const [entityFilter, setEntityFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [revisionFilter, setRevisionFilter] = useState("");
  const clip = snapshot?.master.sequences.flatMap(({ clips }) => clips)
    .find(({ id }) => id === selectedClipId);
  const layer = snapshot?.master.layers.find(({ id }) => id === selectedLayerId);
  const annotation = annotations.find(({ id }) => id === selectedAnnotationId);
  const word = transcripts.flatMap((sidecar) => Object.entries(sidecar.words))
    .find(([id]) => id === selectedWordId);
  const value = annotation ?? clip ?? layer ?? (word === undefined
    ? null
    : { id: word[0], ...word[1] });
  const selectedId = value !== null && "id" in value && typeof value.id === "string"
    ? value.id
    : null;
  const filteredHistory = useMemo(() => (history ?? []).filter((transaction) => {
    const serialized = JSON.stringify(transaction);
    return (entityFilter.length === 0 || serialized.includes(entityFilter)) &&
      (actorFilter.length === 0 || actorLabel(transaction).includes(actorFilter)) &&
      (revisionFilter.length === 0 || transaction.resultRevision.includes(revisionFilter));
  }), [actorFilter, entityFilter, history, revisionFilter]);

  async function copyText(valueToCopy: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(valueToCopy);
      setNotice(`Copied ${label}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function projectAction(method: "revealProject" | "openMaster"): Promise<void> {
    try {
      const { path } = await window.guyditor.call<{ path: string }>("ProjectStore", method, {});
      setNotice(method === "openMaster"
        ? `Opened ${path}. External edits require a reviewable reload; they are never auto-merged.`
        : `Revealed ${path}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function openHistory(): Promise<void> {
    try {
      setHistory(await window.guyditor.call<TransactionRecord[]>("ProjectStore", "listHistory", {}));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <Panel id="inspector" title="Inspector" eyebrow="Current selection">
      <div className="inspector-actions">
        <button type="button" data-testid="project-reveal" disabled={snapshot === null} onClick={() => void projectAction("revealProject")}>Reveal project</button>
        <button type="button" data-testid="project-open-master" disabled={snapshot === null} onClick={() => void projectAction("openMaster")}>Open master</button>
        <button type="button" data-testid="project-copy-path" disabled={snapshot === null} onClick={() => snapshot === null ? undefined : void copyText(snapshot.projectPath, "project path")}>Copy path</button>
        <button type="button" data-testid="history-open" disabled={snapshot === null} onClick={() => void openHistory()}>History</button>
      </div>
      <AudioInspector
        layer={layer}
        timelineFps={snapshot?.master.settings.timeline.fps ?? "24/1"}
        refreshProject={refreshProject}
        setNotice={setNotice}
      />
      <KeyInspector snapshot={snapshot} refreshProject={refreshProject} setNotice={setNotice} />
      <PipInspector snapshot={snapshot} refreshProject={refreshProject} setNotice={setNotice} />
      {value === null ? (
        <p className="empty-copy">Select a clip, layer, word, or annotation.</p>
      ) : (
        <>
          <button type="button" data-testid="inspector-copy-id" disabled={selectedId === null} onClick={() => selectedId === null ? undefined : void copyText(selectedId, "entity ID")}>Copy selected ID</button>
          <pre className="inspector-json" data-testid="inspector-selection">{JSON.stringify(value, null, 2)}</pre>
        </>
      )}
      <small className="m2-note">M1 exposes inspectable selection truth. Schema-generated property editors follow when their remaining operation catalog entries land.</small>
      {history !== null ? (
        <section className="history-dialog" role="dialog" aria-modal="true" aria-label="Semantic history" data-testid="history-viewer">
          <header>
            <div>
              <span className="panel-eyebrow">Append-only journal</span>
              <h3>Semantic history</h3>
            </div>
            <button type="button" data-testid="history-close" onClick={() => setHistory(null)}>Close</button>
          </header>
          <div className="history-filters">
            <label>Entity ID<input data-testid="history-filter-entity" value={entityFilter} onChange={(event) => setEntityFilter(event.currentTarget.value)} /></label>
            <label>Actor<input data-testid="history-filter-actor" value={actorFilter} onChange={(event) => setActorFilter(event.currentTarget.value)} /></label>
            <label>Revision<input data-testid="history-filter-revision" value={revisionFilter} onChange={(event) => setRevisionFilter(event.currentTarget.value)} /></label>
          </div>
          <div className="history-rows" data-testid="history-list">
            {filteredHistory.map((transaction) => (
              <article key={transaction.id} data-testid={`history-${transaction.id}`}>
                <strong>{transaction.resultRevision} · {actorLabel(transaction)}</strong>
                <span>{transaction.id}</span>
                {transaction.operations.map((operation, index) => (
                  <p key={`${transaction.id}-${String(index)}`}>{operation.summary ?? operation.op}</p>
                ))}
                <small>{JSON.stringify({ instruction: transaction.instruction, versions: transaction.versions })}</small>
              </article>
            ))}
          </div>
          <footer>
            <button type="button" data-testid="history-compare" disabled title="Revision comparison rendering is M2.">Compare revisions · M2</button>
            <button type="button" data-testid="history-restore" disabled title="The current core operation catalog has no revision restore operation.">Restore revision · catalog pending</button>
          </footer>
        </section>
      ) : null}
    </Panel>
  );
}
