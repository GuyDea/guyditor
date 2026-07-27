import { useEffect, useState } from "react";

import type {
  RestylePlan,
  RestyleSeam,
  RestyleSeamTreatment,
} from "../../../../core/src/index.js";
import type { RestyleStartResult } from "../../../../agent/src/index.js";
import type { TemplateCatalogEntry } from "../../../../render/src/index.js";
import { resolveActiveDeliverable } from "../active-deliverable.js";
import { errorMessage } from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import { useSelectionStore } from "../state/view-state.js";
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

function oneSecondFrames(fps: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  return match === null ? 24 : Math.max(1, Math.round(Number(match[1]) / Number(match[2])));
}

function defaultInterstitialParams(
  catalog: readonly TemplateCatalogEntry[],
  projectName: string,
  deliverableName: string,
): Record<string, unknown> {
  const entry = catalog.find(({ id }) => id === "tpl_d2e3f4g5h6") ?? catalog[0];
  return {
    ...(entry === undefined ? {} : structuredClone(entry.previewParams)),
    title: deliverableName,
    body: projectName,
  };
}

function SeamEditor({
  seam,
  catalog,
  accepted,
  deliverableId,
  fps,
  projectName,
  deliverableName,
  refreshProposals,
  setNotice,
}: {
  seam: RestyleSeam;
  catalog: readonly TemplateCatalogEntry[];
  accepted: boolean;
  deliverableId: string | undefined;
  fps: string;
  projectName: string;
  deliverableName: string;
  refreshProposals: () => Promise<void>;
  setNotice: (notice: string) => void;
}): React.JSX.Element {
  const initial = seam.treatment;
  const [kind, setKind] = useState<RestyleSeamTreatment["kind"]>(initial.kind);
  const [templateId, setTemplateId] = useState(
    initial.kind === "interstitial" ? initial.templateId : "tpl_d2e3f4g5h6",
  );
  const [durationFrames, setDurationFrames] = useState(
    initial.kind === "interstitial" ? initial.durationFrames : oneSecondFrames(fps),
  );
  const [params, setParams] = useState<Record<string, unknown>>(
    initial.kind === "interstitial"
      ? structuredClone(initial.params)
      : defaultInterstitialParams(catalog, projectName, deliverableName),
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    if (kind !== "interstitial" || templateId.length === 0) {
      setPreviewUrl(null);
      return () => { current = false; };
    }
    const timer = window.setTimeout(() => {
      void window.guyditor.call<{ dataUrl: string }>("RenderService", "templateFrame", {
        templateId,
        params,
        seed: 609,
      }).then(({ dataUrl }) => {
        if (current) setPreviewUrl(dataUrl);
      }).catch(() => {
        if (current) setPreviewUrl(null);
      });
    }, 80);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [kind, params, templateId]);

  function chooseTemplate(nextId: string): void {
    setTemplateId(nextId);
    const entry = catalog.find(({ id }) => id === nextId);
    if (entry !== undefined) setParams(structuredClone(entry.previewParams));
  }

  async function propose(): Promise<void> {
    if (deliverableId === undefined || !accepted) return;
    const treatment: RestyleSeamTreatment = kind === "interstitial"
      ? { kind, templateId, params, durationFrames, resumeExact: true }
      : { kind };
    try {
      const result = await window.guyditor.call<{ proposal: { id: string } }>(
        "DeliverableService",
        "setRestyleSeamTreatment",
        { deliverableId, seamId: seam.id, treatment },
      );
      await refreshProposals();
      setNotice(`Prepared ${kind} override for ${seam.id} in ${result.proposal.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <li className="restyle-seam-editor" data-testid={`restyle-seam-${seam.id}`}>
      <header>
        <span className="restyle-seam-glyph" data-kind={kind} aria-hidden="true" />
        <strong>{String(seam.frame)}f · {seam.boundary}</strong>
        <span className="state-chip" data-state={seam.status}>{seam.status}</span>
      </header>
      <div className="restyle-seam-controls">
        <label>Treatment
          <select
            value={kind}
            data-testid={`restyle-seam-kind-${seam.id}`}
            onChange={(event) => setKind(event.currentTarget.value as RestyleSeamTreatment["kind"])}
          >
            <option value="interstitial">Infographic</option>
            <option value="punch-in">Punch-in</option>
            <option value="none">None</option>
          </select>
        </label>
        {kind !== "interstitial" ? null : (
          <>
            <label>Template
              <select
                value={templateId}
                data-testid={`restyle-seam-template-${seam.id}`}
                onChange={(event) => chooseTemplate(event.currentTarget.value)}
              >
                {catalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </select>
            </label>
            <label>Duration (frames)
              <input
                type="number"
                min={Math.ceil(oneSecondFrames(fps) / 2)}
                max={oneSecondFrames(fps) * 2}
                value={durationFrames}
                data-testid={`restyle-seam-duration-${seam.id}`}
                onChange={(event) => setDurationFrames(Math.max(1, event.currentTarget.valueAsNumber || 1))}
              />
            </label>
          </>
        )}
      </div>
      {kind !== "interstitial" ? null : (
        <div className="restyle-seam-interstitial">
          {previewUrl === null ? null : (
            <img
              src={previewUrl}
              alt="Interstitial template preview"
              data-testid={`restyle-seam-preview-${seam.id}`}
            />
          )}
          <div>
            {Object.entries(params).map(([name, value]) => (
              typeof value === "string" || typeof value === "number" ? (
                <label key={name}>{name}
                  <input
                    value={String(value)}
                    data-testid={`restyle-seam-param-${seam.id}-${name}`}
                    onChange={(event) => setParams((current) => ({
                      ...current,
                      [name]: typeof value === "number"
                        ? Number(event.currentTarget.value)
                        : event.currentTarget.value,
                    }))}
                  />
                </label>
              ) : null
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        disabled={!accepted || (kind === "interstitial" && templateId.length === 0)}
        data-testid={`restyle-seam-propose-${seam.id}`}
        onClick={() => void propose()}
      >Propose seam change</button>
    </li>
  );
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
  const [catalog, setCatalog] = useState<TemplateCatalogEntry[]>([]);
  const [confirmation, setConfirmation] = useState<Extract<
    RestyleStartResult,
    { verdict: "warn" }
  > | null>(null);
  const jobs = useJobsStore((state) => state.jobs);
  const selectedDeliverableId = useSelectionStore(
    (state) => state.selectedDeliverableId,
  );
  const plan = restylePlan ?? draft;
  const accepted = restylePlan !== null;
  const deliverable = snapshot === null
    ? undefined
    : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
  const deliverableId = deliverable?.id;
  const fps = snapshot?.master.settings.timeline.fps ?? "24/1";
  const projectName = snapshot?.master.project.name ?? "Episode";
  const deliverableName = deliverable?.name ?? "Episode";
  const planExtent = plan?.chunks.reduce(
    (maximum, chunk) => Math.max(maximum, chunk.sourceRange.endFrame),
    1,
  ) ?? 1;

  useEffect(() => {
    setDraft(null);
    setConfirmation(null);
    setCoverageMode("full");
    setStartFrame(0);
    setEndFrame(300);
  }, [deliverableId]);

  useEffect(() => {
    let current = true;
    void window.guyditor.call<TemplateCatalogEntry[]>("RenderService", "templateCatalog", {})
      .then((entries) => { if (current) setCatalog(entries); })
      .catch(() => { if (current) setCatalog([]); });
    return () => { current = false; };
  }, [snapshot?.projectPath]);

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
          <section className="restyle-seams" data-testid="restyle-seam-list">
            <header>
              <strong>Seam concealment</strong>
              <small>{String(plan.seams.length)} boundaries · proposal-gated</small>
            </header>
            <div className="restyle-seam-track" aria-label="Restyle seam markers">
              {plan.seams.map((seam) => (
                <i
                  key={seam.id}
                  data-kind={seam.treatment.kind}
                  data-state={seam.status}
                  title={`${seam.id} · ${seam.treatment.kind} · ${String(seam.frame)}f`}
                  style={{
                    left: `${String(seam.frame / planExtent * 100)}%`,
                  }}
                />
              ))}
            </div>
            <ol>
              {plan.seams.map((seam) => (
                <SeamEditor
                  key={`${seam.id}:${seam.status}:${seam.treatment.kind}:${String(catalog.length)}`}
                  seam={seam}
                  catalog={catalog}
                  accepted={accepted}
                  deliverableId={deliverableId}
                  fps={fps}
                  projectName={projectName}
                  deliverableName={deliverableName}
                  refreshProposals={refreshProposals}
                  setNotice={setNotice}
                />
              ))}
            </ol>
          </section>
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
