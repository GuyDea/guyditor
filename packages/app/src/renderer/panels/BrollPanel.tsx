import { useCallback, useEffect, useMemo, useState } from "react";

import {
  BROLL_SOURCE_TAXONOMY,
} from "../../../../core/src/generation/taxonomy.js";
import { rightsCompliance } from "../../../../core/src/generation/rights.js";
import type {
  BrollSourceClassId,
  RightsCompliance,
  RightsMetadata,
  RightsPolicy,
} from "../../../../core/src/index.js";
import type {
  AdapterDescriptor,
  CostEstimate,
  GenerationCandidate,
  GenerationRequest,
  GenerationStartResult,
} from "../../../../agent/src/index.js";
import { resolveActiveDeliverable } from "../active-deliverable.js";
import { sectionHelpKey } from "../help/help-texts.js";
import { errorMessage } from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import {
  usePreviewStore,
  useSelectionStore,
  useWorkspaceStore,
} from "../state/view-state.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

type ReviewState = "pending" | "pass" | "fail" | "not_applicable";

interface AdapterEntry {
  descriptor: AdapterDescriptor;
  configuration?: Record<string, unknown>;
}

interface CandidateView extends GenerationCandidate {
  previewUrl: string;
  rightsCompliance: RightsCompliance;
}

interface EstimateView {
  availability: { available: boolean; reason?: string };
  estimate: CostEstimate | null;
}

interface IngestResult {
  job: { title: string };
  rightsCompliance: RightsCompliance;
}

const REVIEW_FIELD_LABELS = [
  "Factual relevance",
  "Research accuracy",
  "Brand fit",
  "Visual artifacts",
  "Text artifacts",
  "Unintended implications",
  "Rights confirmed",
] as const;

const FALLBACK_ADAPTERS: AdapterEntry[] = [
  {
    descriptor: {
      adapterId: "adp_stubgenaaa",
      canonicalName: ["adp", "stubgen"].join("_"),
      adapterVersion: "1.0.0",
      displayName: "Deterministic offline generator",
      provider: "Guyditor deterministic stub",
      local: true,
      availability: "available",
      capabilities: ["generate"],
      modes: ["video"],
      models: [{
        id: "ffmpeg-synth-v1",
        mode: "video",
        maxWidth: 3840,
        maxHeight: 2160,
        maxDurationSec: 30,
        supportsSeed: true,
      }],
      requestSchema: { type: "object", additionalProperties: false },
      dataClassesSent: [],
      maxConcurrent: 2,
    },
  },
  {
    descriptor: {
      adapterId: "adp_httpgenaaa",
      canonicalName: ["adp", "httpgen"].join("_"),
      adapterVersion: "1.0.0",
      displayName: "Generic HTTP generator",
      provider: "openai-compatible",
      local: false,
      availability: "declared-unavailable",
      unavailableReason: "No enabled HTTP generation provider is configured.",
      capabilities: ["generate"],
      modes: ["image", "video"],
      models: [],
      requestSchema: {},
      dataClassesSent: ["prompt", "metadata"],
      maxConcurrent: 2,
    },
  },
  {
    descriptor: {
      adapterId: "adp_comfyuiaaa",
      canonicalName: ["adp", "comfyui"].join("_"),
      adapterVersion: "0.1.0",
      displayName: "ComfyUI local generator",
      provider: "comfyui",
      local: true,
      availability: "declared-unavailable",
      unavailableReason: "No enabled ComfyUI workflow is configured.",
      capabilities: ["generate"],
      modes: [],
      models: [],
      requestSchema: {},
      dataClassesSent: [],
      maxConcurrent: 1,
    },
  },
];

const FILE_SOURCES: readonly BrollSourceClassId[] = [
  "local-footage",
  "licensed-asset",
  "still-image",
  "screen-capture",
];

function available(entry: AdapterEntry): boolean {
  return entry.descriptor.availability !== "declared-unavailable";
}

function fpsValue(fps: string): number {
  const [numerator = "24", denominator = "1"] = fps.split("/");
  return Number(numerator) / Number(denominator);
}

function rightsLabel(compliance: RightsCompliance): string {
  if (compliance.compliant) return "Rights ready";
  return compliance.severity === "error" ? "Rights blocked" : "Rights missing";
}

function sourceCode(sourceClass: BrollSourceClassId): string {
  return ({
    "local-footage": "LOC",
    "licensed-asset": "LIC",
    "still-image": "STL",
    "screen-capture": "SCR",
    "programmatic-animation": "TPL",
    "external-generation": "GEN",
    "local-generation": "LCL",
  })[sourceClass];
}

export function BrollPanel({
  snapshot,
  refreshProject,
  refreshProposals,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const [sourceClass, setSourceClass] = useState<BrollSourceClassId>("local-footage");
  const [sourcePath, setSourcePath] = useState("");
  const [licenseName, setLicenseName] = useState("");
  const [licensor, setLicensor] = useState("");
  const [purchaseRef, setPurchaseRef] = useState("");
  const [adapters, setAdapters] = useState<AdapterEntry[]>(FALLBACK_ADAPTERS);
  const [adapterId, setAdapterId] = useState("adp_stubgenaaa");
  const [model, setModel] = useState("ffmpeg-synth-v1");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);
  const [durationSeconds, setDurationSeconds] = useState(3);
  const [seed, setSeed] = useState(607);
  const [count, setCount] = useState(1);
  const [estimate, setEstimate] = useState<EstimateView | null>(null);
  const [confirmToken, setConfirmToken] = useState<string | undefined>();
  // A cost confirmation is bound to the task it was issued for, and the task ID
  // is the request ID. Minting a fresh one on the confirm click made the
  // confirmation unredeemable, so the warned request ID is held alongside it.
  const [pendingRequestId, setPendingRequestId] = useState<string | undefined>();
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [reviewDraft, setReviewDraft] = useState<Record<string, {
    state: ReviewState;
    note: string;
  }>>({});
  const [rightsPolicy, setRightsPolicy] = useState<RightsPolicy>({ requirementLevel: "warn" });
  const jobs = useJobsStore((state) => state.jobs);
  const playhead = usePreviewStore((state) => state.playhead);
  const selectedDeliverableId = useSelectionStore(
    (state) => state.selectedDeliverableId,
  );
  const focusPanel = useWorkspaceStore((state) => state.focusPanel);
  const deliverable = snapshot === null
    ? undefined
    : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
  const selectedAdapter = adapters.find(({ descriptor }) => descriptor.adapterId === adapterId) ??
    FALLBACK_ADAPTERS[0]!;
  const selectedModel = selectedAdapter.descriptor.models.find(({ id }) => id === model) ??
    selectedAdapter.descriptor.models[0];
  const mode = selectedModel?.mode ?? "video";
  const fps = snapshot?.master.settings.timeline.fps ?? playhead.fps;
  const durationFrames = Math.max(1, Math.round(durationSeconds * fpsValue(fps)));
  const selectedCandidate = candidates.find(({ candidateId }) =>
    candidateId === selectedCandidateId) ?? candidates[0];
  const generationJobSignature = jobs.filter(({ kind }) => kind === "broll.generate")
    .map(({ jobId, state }) => `${jobId}:${state}`).join("|");

  const generationRequest = useCallback((requestId: string): GenerationRequest => ({
    requestId,
    mode,
    model,
    prompt: prompt.trim(),
    ...(negativePrompt.trim() === "" ? {} : { negativePrompt: negativePrompt.trim() }),
    width,
    height,
    ...(mode === "video" ? { durationFrames, fps } : {}),
    seed,
    count,
    providerSettings: {},
  }), [count, durationFrames, fps, height, mode, model, negativePrompt, prompt, seed, width]);

  const refreshQueue = useCallback(async (): Promise<void> => {
    if (snapshot === null) {
      setCandidates([]);
      return;
    }
    try {
      const queue = await window.guyditor.call<CandidateView[]>(
        "GenerationService",
        "reviewQueue",
        {},
      );
      setCandidates(queue);
      setSelectedCandidateId((current) =>
        queue.some(({ candidateId }) => candidateId === current)
          ? current
          : queue[0]?.candidateId ?? null);
    } catch {
      setCandidates([]);
    }
  }, [snapshot]);

  useEffect(() => {
    let current = true;
    if (snapshot === null) return () => { current = false; };
    void Promise.all([
      window.guyditor.call<AdapterEntry[]>("GenerationService", "adapters", {}),
      window.guyditor.call<RightsPolicy>("GenerationService", "rightsPolicy", {}),
    ]).then(([nextAdapters, nextPolicy]) => {
      if (!current) return;
      setAdapters(nextAdapters);
      setRightsPolicy(nextPolicy);
      const preferred = nextAdapters.find((entry) => available(entry));
      if (preferred !== undefined) {
        setAdapterId((active) => nextAdapters.some(({ descriptor }) =>
          descriptor.adapterId === active && descriptor.availability !== "declared-unavailable")
          ? active
          : preferred.descriptor.adapterId);
      }
    }).catch(() => undefined);
    return () => { current = false; };
  }, [snapshot?.projectPath]);

  useEffect(() => {
    const next = selectedAdapter.descriptor.models.find(({ id }) => id === model) ??
      selectedAdapter.descriptor.models[0];
    if (next !== undefined && next.id !== model) setModel(next.id);
  }, [model, selectedAdapter]);

  useEffect(() => {
    void refreshQueue();
  }, [generationJobSignature, refreshQueue, snapshot?.revision]);

  useEffect(() => {
    if (snapshot === null || prompt.trim() === "" || selectedModel === undefined) {
      setEstimate(null);
      return undefined;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      void window.guyditor.call<EstimateView>("GenerationService", "estimate", {
        adapterId,
        request: generationRequest("estimate-only"),
      }).then((next) => current ? setEstimate(next) : undefined)
        .catch(() => current ? setEstimate(null) : undefined);
    }, 160);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [adapterId, generationRequest, prompt, selectedModel, snapshot]);

  useEffect(() => {
    if (selectedCandidate === undefined) {
      setReviewDraft({});
      return;
    }
    setReviewDraft(Object.fromEntries(selectedCandidate.review.checklist.items.map((item) => [
      item.id,
      { state: item.state, note: item.note ?? "" },
    ])));
  }, [selectedCandidate?.candidateId, selectedCandidate?.review.state]);

  async function ingestSource(): Promise<void> {
    if (!FILE_SOURCES.includes(sourceClass) || sourcePath.trim() === "") return;
    const rights: Partial<RightsMetadata> = sourceClass === "licensed-asset"
      ? {
          origin: "licensed",
          ...(licenseName.trim() === "" ? {} : { licenseName: licenseName.trim() }),
          ...(licensor.trim() === "" ? {} : { licensor: licensor.trim() }),
          ...(purchaseRef.trim() === "" ? {} : { purchaseRef: purchaseRef.trim() }),
          restrictions: [],
          confirmedBy: "creator",
        }
      : { origin: "captured", restrictions: [], confirmedBy: "creator" };
    try {
      const result = await window.guyditor.call<IngestResult>(
        "GenerationService",
        "ingestSource",
        {
          sourceClass,
          path: sourcePath.trim(),
          ...(sourceClass === "still-image" ? { origin: rights.origin } : {}),
          rights,
        },
      );
      setSourcePath("");
      setNotice(result.rightsCompliance.compliant
        ? `Queued ${result.job.title}. Rights metadata is complete.`
        : `Queued ${result.job.title}. Missing rights: ${result.rightsCompliance.missingFields.join(", ")}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function activateSource(next: BrollSourceClassId): void {
    setSourceClass(next);
    if (next === "programmatic-animation") {
      focusPanel("graphics");
      setNotice("Programmatic animation is rendered through the pinned Graphics template path.");
    } else if (next === "external-generation") {
      setNotice("Choose an available generation adapter and run preflight below.");
    } else if (next === "local-generation") {
      setNotice("Local model generation is a declared-unavailable capability until configured.");
    }
  }

  async function startGeneration(): Promise<void> {
    if (prompt.trim() === "") return;
    const requestId = pendingRequestId ?? `generation-${window.crypto.randomUUID()}`;
    try {
      const result = await window.guyditor.call<GenerationStartResult>(
        "GenerationService",
        "request",
        {
          adapterId,
          request: generationRequest(requestId),
          ...(confirmToken === undefined ? {} : { confirmToken }),
        },
      );
      if (result.verdict === "warn") {
        setConfirmToken(result.confirmToken);
        setPendingRequestId(requestId);
        setNotice(`${result.message} Confirm the generation request to continue.`);
      } else if (result.verdict === "enqueued") {
        setConfirmToken(undefined);
        setPendingRequestId(undefined);
        setNotice(`Queued ${result.job.title}; outputs will enter creator review.`);
      } else if (result.verdict === "blocked") {
        setConfirmToken(undefined);
        setPendingRequestId(undefined);
        setNotice(result.message);
      } else {
        setNotice(`${result.error.message}${result.error.suggestion === undefined ? "" : ` ${result.error.suggestion}`}`);
      }
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function saveJudgments(): Promise<boolean> {
    if (selectedCandidate === undefined) return false;
    const judgments = selectedCandidate.review.checklist.items.map((item) => ({
      item,
      draft: reviewDraft[item.id] ?? { state: "pending" as const, note: "" },
    }));
    if (judgments.some(({ draft }) => draft.state === "pending" || draft.note.trim() === "")) {
      setNotice("Record a creator judgment and note for every required review field.");
      return false;
    }
    try {
      await Promise.all(judgments.map(({ item, draft }) => window.guyditor.call(
        "GenerationService",
        "recordCreatorJudgment",
        {
          candidateId: selectedCandidate.candidateId,
          itemId: item.id,
          state: draft.state,
          note: draft.note.trim(),
        },
      )));
      await refreshQueue();
      return true;
    } catch (error: unknown) {
      setNotice(errorMessage(error));
      return false;
    }
  }

  async function resolveReview(): Promise<void> {
    if (selectedCandidate === undefined || !await saveJudgments()) return;
    try {
      await window.guyditor.call("GenerationService", "resolveReview", {
        candidateId: selectedCandidate.candidateId,
      });
      await refreshQueue();
      setNotice("Creator review resolved. The candidate can now be accepted and frozen.");
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function acceptCandidate(): Promise<void> {
    if (selectedCandidate === undefined || snapshot === null) return;
    if (deliverable === undefined) {
      setNotice("Open an active deliverable before placing generated B-roll.");
      return;
    }
    const placedFrames = selectedCandidate.request.durationFrames ?? durationFrames;
    try {
      await window.guyditor.call("GenerationService", "acceptCandidate", {
        candidateId: selectedCandidate.candidateId,
        sequenceId: deliverable.sequenceId,
        atFrame: playhead.frames,
        durationFrames: placedFrames,
      });
      await Promise.all([refreshProject(), refreshProposals(), refreshQueue()]);
      setNotice("Candidate accepted, copied read-only into media/generated, and placed on the timeline.");
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function rejectCandidate(): Promise<void> {
    if (selectedCandidate === undefined) return;
    try {
      await window.guyditor.call("GenerationService", "rejectCandidate", {
        candidateId: selectedCandidate.candidateId,
      });
      await refreshQueue();
      setNotice("Candidate rejected; accepted project state was unchanged.");
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function regenerateCandidate(): Promise<void> {
    if (selectedCandidate === undefined) return;
    try {
      const result = await window.guyditor.call<GenerationStartResult>(
        "GenerationService",
        "regenerate",
        { candidateId: selectedCandidate.candidateId },
      );
      setNotice(result.verdict === "enqueued"
        ? "Regeneration queued. Acceptance will create a new asset ID."
        : result.verdict === "warn" || result.verdict === "blocked"
          ? result.message
          : result.error.message);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  const rightsAssets = useMemo(() => (snapshot?.master.assets ?? []).map((asset) => ({
    asset,
    compliance: rightsCompliance(asset.rights, rightsPolicy),
  })).filter(({ asset, compliance }) => asset.rights !== undefined || !compliance.compliant),
  [rightsPolicy, snapshot]);

  return (
    <Panel id="broll" title="B-roll" eyebrow="Sources · generation · review">
      <div className="broll-workbench">
        <section className="broll-source-browser" aria-label="B-roll source taxonomy">
          <header><h3 data-help={sectionHelpKey("broll", "Source classes")}>Source classes</h3><span>7 paths</span></header>
          <div className="broll-source-rail">
            {BROLL_SOURCE_TAXONOMY.map((source) => (
              <button
                type="button"
                key={source.id}
                data-active={sourceClass === source.id}
                data-availability={source.availability}
                onClick={() => activateSource(source.id)}
                title={`${source.entryPath} · ${source.origin}`}
              >
                <b>{sourceCode(source.id)}</b>
                <span>{source.label}</span>
                <small>{source.availability === "available" ? source.rightsDefault : "unavailable"}</small>
              </button>
            ))}
          </div>
          {FILE_SOURCES.includes(sourceClass) ? (
            <div className="broll-ingest-card">
              <label>Source path<input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="/path/to/source.mp4" /></label>
              {sourceClass === "licensed-asset" ? (
                <div className="broll-rights-fields">
                  <label>License<input value={licenseName} onChange={(event) => setLicenseName(event.target.value)} /></label>
                  <label>Licensor<input value={licensor} onChange={(event) => setLicensor(event.target.value)} /></label>
                  <label>Purchase ref<input value={purchaseRef} onChange={(event) => setPurchaseRef(event.target.value)} /></label>
                </div>
              ) : null}
              <button type="button" className="primary-action" disabled={snapshot === null || sourcePath.trim() === ""} onClick={() => void ingestSource()}>Capture rights + ingest</button>
            </div>
          ) : null}
        </section>

        <form className="broll-generation-form" data-testid="generation-request" onSubmit={(event) => { event.preventDefault(); void startGeneration(); }}>
          <header><h3 data-help={sectionHelpKey("broll", "Generation request")}>Generation request</h3><span>text-free</span></header>
          <label className="broll-prompt">Visual prompt<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Slow orbit around a cobalt glass sculpture…" /></label>
          <label>Negative prompt<input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="logos, lettering, watermarks" /></label>
          <div className="broll-form-grid">
            <label>Adapter<select value={adapterId} onChange={(event) => setAdapterId(event.target.value)}>{adapters.map((entry) => <option key={entry.descriptor.adapterId} value={entry.descriptor.adapterId}>{entry.descriptor.displayName}{available(entry) ? "" : " · unavailable"}</option>)}</select></label>
            <label>Model<select value={model} onChange={(event) => setModel(event.target.value)} disabled={selectedAdapter.descriptor.models.length === 0}>{selectedAdapter.descriptor.models.length === 0 ? <option value="">No model</option> : selectedAdapter.descriptor.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}</select></label>
            <label>Width<input type="number" min="16" max="4096" value={width} onChange={(event) => setWidth(event.target.valueAsNumber)} /></label>
            <label>Height<input type="number" min="16" max="4096" value={height} onChange={(event) => setHeight(event.target.valueAsNumber)} /></label>
            <label>Seconds<input type="number" min="1" max="60" value={durationSeconds} disabled={mode === "image"} onChange={(event) => setDurationSeconds(event.target.valueAsNumber)} /></label>
            <label>Seed<input type="number" min="0" max="4294967295" value={seed} onChange={(event) => setSeed(event.target.valueAsNumber)} /></label>
            <label>Count<input type="number" min="1" max="4" value={count} onChange={(event) => setCount(event.target.valueAsNumber)} /></label>
          </div>
          <div className="broll-cost" data-testid="generation-cost-estimate" data-state={estimate?.availability.available === false ? "missing" : "ready"}>
            <span>{estimate?.availability.available === false ? "Adapter unavailable" : "Preflight estimate"}</span>
            <strong>{estimate?.estimate === undefined || estimate.estimate === null ? "$—" : `$${estimate.estimate.amount.toFixed(3)} ${estimate.estimate.currency}`}</strong>
            <small>{estimate?.availability.reason ?? "CostMeter checks task, episode, and lifetime thresholds before submission."}</small>
          </div>
          <button type="submit" className="primary-action" disabled={snapshot === null || prompt.trim() === "" || selectedModel === undefined || !available(selectedAdapter)}>{confirmToken === undefined ? "Run preflight + generate" : "Confirm cost + generate"}</button>
          <small className="broll-text-guard">Visual text is refused here. Render titles, captions, and labels through pinned templates.</small>
        </form>

        <section className="broll-review" data-testid="generation-review-queue">
          <header><h3 data-help={sectionHelpKey("broll", "Candidate review")}>Candidate review</h3><span>{String(candidates.length)} waiting</span></header>
          <p className="broll-verification-note">Visual plausibility is not factual verification.</p>
          <ul className="broll-review-key" aria-label="Required review fields">{REVIEW_FIELD_LABELS.map((label) => <li key={label}>{label}</li>)}</ul>
          {candidates.length === 0 ? <p className="empty-copy">Generated candidates stay in disposable cache until creator review and acceptance.</p> : (
            <>
              <div className="broll-candidate-tabs">{candidates.map((candidate) => <button type="button" key={candidate.candidateId} data-active={candidate.candidateId === selectedCandidate?.candidateId} onClick={() => setSelectedCandidateId(candidate.candidateId)}>#{String(candidate.index + 1)} · {candidate.request.model}</button>)}</div>
              {selectedCandidate === undefined ? null : (
                <article className="broll-candidate-card">
                  {selectedCandidate.mime.startsWith("video/") ? <video src={selectedCandidate.previewUrl} muted controls preload="metadata" /> : <img src={selectedCandidate.previewUrl} alt="Generated B-roll candidate preview" />}
                  <div className="broll-candidate-meta">
                    <strong>{selectedCandidate.request.prompt}</strong>
                    <span>{selectedCandidate.provenance.generation.adapterId}@{selectedCandidate.provenance.generation.adapterVersion}</span>
                    <span className="rights-badge" data-state={selectedCandidate.rightsCompliance.compliant ? "ready" : "missing"}>{rightsLabel(selectedCandidate.rightsCompliance)}</span>
                    {selectedCandidate.review.brandVisualSkill === undefined ? <small>No brand_visual skill pinned</small> : <small>brand_visual · {selectedCandidate.review.brandVisualSkill.version}</small>}
                  </div>
                  <div className="broll-checklist">
                    {selectedCandidate.review.checklist.items.map((item) => {
                      const draft = reviewDraft[item.id] ?? { state: item.state, note: item.note ?? "" };
                      return (
                        <div key={item.id} className="broll-check-row">
                          <label>{item.label}<select value={draft.state} onChange={(event) => setReviewDraft((current) => ({ ...current, [item.id]: { ...draft, state: event.target.value as ReviewState } }))}><option value="pending">Pending</option><option value="pass">Pass</option><option value="fail">Fail</option><option value="not_applicable">N/A</option></select></label>
                          <input aria-label={`${item.label} review note`} value={draft.note} placeholder="Creator note required" onChange={(event) => setReviewDraft((current) => ({ ...current, [item.id]: { ...draft, note: event.target.value } }))} />
                          {item.agentObservation === undefined ? null : <small>Agent observation: {item.agentObservation}</small>}
                        </div>
                      );
                    })}
                  </div>
                  <div className="broll-review-actions">
                    <button type="button" onClick={() => void rejectCandidate()}>Reject</button>
                    <button type="button" onClick={() => void regenerateCandidate()}>Regenerate new</button>
                    {selectedCandidate.review.state === "resolved" ? <button type="button" className="primary-action" onClick={() => void acceptCandidate()}>Accept + freeze</button> : <button type="button" className="primary-action" onClick={() => void resolveReview()}>Resolve review</button>}
                  </div>
                </article>
              )}
            </>
          )}
        </section>

        <section className="broll-rights-shelf">
          <header><h3 data-help={sectionHelpKey("broll", "Rights indicators")}>Rights indicators</h3><span>{rightsPolicy.requirementLevel}</span></header>
          <div className="broll-rights-legend"><span className="rights-badge" data-state="ready">Rights ready</span><span className="rights-badge" data-state="missing">Rights missing</span></div>
          {rightsAssets.map(({ asset, compliance }) => <div key={asset.id}><strong>{asset.id}</strong><span>{asset.rights?.origin ?? "unknown"}</span><span className="rights-badge" data-state={compliance.compliant ? "ready" : "missing"}>{rightsLabel(compliance)}</span></div>)}
        </section>
      </div>
    </Panel>
  );
}
