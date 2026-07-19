import { useState } from "react";

import type { RestylePlan } from "../../../../core/src/index.js";
import type { RestyleStartResult } from "../../../../agent/src/index.js";
import { errorMessage } from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import type { WorkspacePanelProps } from "./types.js";

type RestylePlanProps = Pick<
  WorkspacePanelProps,
  "snapshot" | "restylePlan" | "refreshProposals" | "refreshRestylePlan" | "setNotice"
>;

function frameSeconds(frame: number, fps: string): string {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) return `${String(frame)}f`;
  return `${(frame * Number(match[2]) / Number(match[1])).toFixed(2)}s`;
}

export function RestylePlanReview({
  snapshot,
  restylePlan,
  refreshProposals,
  refreshRestylePlan,
  setNotice,
}: RestylePlanProps): React.JSX.Element {
  const [prompt, setPrompt] = useState("Cinematic watercolor documentary");
  const [coverageMode, setCoverageMode] = useState<"full" | "range">("full");
  const [startFrame, setStartFrame] = useState(0);
  const [endFrame, setEndFrame] = useState(300);
  const [draft, setDraft] = useState<RestylePlan | null>(null);
  const [confirmation, setConfirmation] = useState<Extract<
    RestyleStartResult,
    { verdict: "warn" }
  > | null>(null);
  const jobs = useJobsStore((state) => state.jobs);
  const plan = restylePlan ?? draft;
  const accepted = restylePlan !== null;
  const deliverableId = snapshot?.master.settings.primaryDeliverable;
  const fps = snapshot?.master.settings.timeline.fps ?? "24/1";

  async function createPlan(): Promise<void> {
    if (deliverableId === undefined || prompt.trim().length === 0) return;
    try {
      const result = await window.guyditor.call<{
        plan: RestylePlan;
        proposal: { id: string };
      }>("DeliverableService", "createRestylePlan", {
        deliverableId,
        coverage: coverageMode === "full"
          ? "full"
          : [{ startFrame, endFrame }],
        prompt: prompt.trim(),
        seed: 607,
        providerSettings: {},
      });
      setDraft(result.plan);
      await refreshProposals();
      setNotice(`Prepared ${String(result.plan.chunks.length)} restyle chunks in ${result.proposal.id}; accept the plan before generation.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function start(confirmToken?: string): Promise<void> {
    if (deliverableId === undefined || !accepted) return;
    try {
      const result = await window.guyditor.call<RestyleStartResult>(
        "DeliverableService",
        "startRestyle",
        { deliverableId, ...(confirmToken === undefined ? {} : { confirmToken }) },
      );
      if (result.verdict === "enqueued") {
        setConfirmation(null);
        setNotice(`Queued ${String(result.jobs.length)} restyle chunks after the $${result.estimate.amount.toFixed(2)} whole-plan preflight.`);
      } else if (result.verdict === "warn") {
        setConfirmation(result);
        setNotice(result.message);
      } else {
        setConfirmation(null);
        setNotice(result.message);
      }
      await refreshRestylePlan();
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <section className="restyle-plan-review" data-testid="restyle-plan-review">
      <header>
        <div>
          <span className="eyebrow">FR-607 / FR-608</span>
          <strong>Segmented AI restyle</strong>
        </div>
        <span className="state-chip" data-state={accepted ? "ready" : "queued"}>
          {accepted ? "accepted plan" : draft === null ? "not planned" : "review plan"}
        </span>
      </header>
      <div className="restyle-create-grid">
        <label>
          Direction
          <input
            value={prompt}
            data-testid="restyle-prompt"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label>
          Coverage
          <select
            value={coverageMode}
            data-testid="restyle-coverage"
            onChange={(event) => setCoverageMode(event.target.value as "full" | "range")}
          >
            <option value="full">Full deliverable</option>
            <option value="range">Frame range</option>
          </select>
        </label>
        {coverageMode === "range" ? (
          <div className="restyle-range-fields">
            <input
              type="number"
              min="0"
              aria-label="Restyle start frame"
              value={startFrame}
              onChange={(event) => setStartFrame(Math.max(0, event.target.valueAsNumber || 0))}
            />
            <input
              type="number"
              min={startFrame + 1}
              aria-label="Restyle end frame"
              value={endFrame}
              onChange={(event) => setEndFrame(Math.max(startFrame + 1, event.target.valueAsNumber || 1))}
            />
          </div>
        ) : null}
        <button
          type="button"
          className="primary-action"
          data-testid="restyle-plan-create"
          disabled={snapshot === null || prompt.trim().length === 0}
          onClick={() => void createPlan()}
        >Prepare proposal</button>
      </div>
      {plan === null ? (
        <p>Plan creation snaps chunks to speech gaps, beats, and low-motion evidence.</p>
      ) : (
        <>
          <div className="restyle-cost-card" data-testid="restyle-plan-cost">
            <span>{String(plan.chunks.length)} chunks · {plan.coverage.mode}</span>
            <strong>${plan.estimatedCost.amount.toFixed(2)}</strong>
            <small>Whole-plan CostMeter preflight runs before the first provider call.</small>
          </div>
          <ol className="restyle-chunks" data-testid="restyle-chunk-list">
            {plan.chunks.map((chunk) => {
              const job = jobs.find(({ title }) =>
                title === `Restyle chunk ${String(chunk.index + 1)}/${String(plan.chunks.length)}`);
              const status = chunk.status === "stale" || chunk.status === "approved"
                ? chunk.status
                : job?.state === "done"
                  ? "review"
                  : job?.state ?? chunk.status;
              return (
                <li key={chunk.id} data-testid={`restyle-chunk-${String(chunk.index)}`}>
                  <span className="restyle-chunk-index">{String(chunk.index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>
                      {frameSeconds(chunk.sourceRange.startFrame, fps)} → {frameSeconds(chunk.sourceRange.endFrame, fps)}
                    </strong>
                    <small>{chunk.semanticAnchors.boundaryKind} · ${chunk.estimatedCostUsd.toFixed(2)}</small>
                  </div>
                  <span className="state-chip" data-state={status}>{status}</span>
                </li>
              );
            })}
          </ol>
          <div className="restyle-run-row">
            <button
              type="button"
              className="primary-action"
              data-testid="restyle-plan-start"
              disabled={!accepted}
              onClick={() => void start()}
            >Run accepted plan</button>
            {confirmation === null ? null : (
              <button
                type="button"
                data-testid="restyle-budget-confirm"
                onClick={() => void start(confirmation.confirmToken)}
              >Confirm ${confirmation.estimate.amount.toFixed(2)}</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
