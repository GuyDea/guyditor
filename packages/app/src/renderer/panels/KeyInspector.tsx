import { useEffect, useMemo, useState } from "react";

import type { KeySettings } from "../../../../core/src/index.js";
import type { PresenterArrangement } from "../../../../compositor/src/index.js";
import type {
  CaptureGuidanceReport,
  KeyQcReport,
} from "../../../../media/src/index.js";
import { resolveActiveDeliverable } from "../active-deliverable.js";
import { errorMessage, executeDirect } from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import {
  usePreviewStore,
  useSelectionStore,
} from "../state/view-state.js";
import type { WorkspacePanelProps } from "./types.js";

const DEFAULT_KEY: KeySettings = {
  schema: "guyditor/key@1",
  mode: "chroma",
  chroma: {
    keyColor: "#00B140",
    tolerance: 0.35,
    softness: 0.12,
    preBlur: 1.5,
    edge: { erodePx: 1, featherPx: 2 },
    spill: { mode: "despill", strength: 0.6 },
  },
  masks: [],
};

const DEFAULT_NEURAL_KEY: KeySettings = {
  schema: "guyditor/key@1",
  mode: "neural",
  neural: {
    model: "rvm_mobilenetv3",
    downsampleRatio: 0.5,
    stabilization: {
      enabled: true,
      alphaMin: 0.35,
      motionGain: 4,
      minSpeckleArea: 0.00001,
    },
  },
  chroma: structuredClone(DEFAULT_KEY.chroma!),
  masks: [],
};

interface MatteCandidate {
  jobId: string;
  clipId: string;
  path: string;
  sha256: string;
  frameCount: number;
  alpha: { minimum: number; maximum: number; nonZeroFrames: number };
  engine: { model: "rvm_mobilenetv3" | "rvm_resnet50"; version: string };
}

function persistedKey(clip: NonNullable<WorkspacePanelProps["snapshot"]>["master"]["sequences"][number]["clips"][number]): KeySettings | null {
  const effect = clip.effects?.find(({ kind }) => kind === "key");
  return effect === undefined ? null : effect.params as unknown as KeySettings;
}

function metricText(value: number): string {
  return value.toFixed(3);
}

export function KeyInspector({
  snapshot,
  refreshProject,
  setNotice,
}: Pick<WorkspacePanelProps, "snapshot" | "refreshProject" | "setNotice">): React.JSX.Element | null {
  const selectedDeliverableId = useSelectionStore(
    (state) => state.selectedDeliverableId,
  );
  const selectedClipId = useSelectionStore((state) => state.selectedClipId);
  const jobs = useJobsStore((state) => state.jobs);
  const diagnosticBackground = usePreviewStore((state) => state.diagnosticBackground);
  const setDiagnosticBackground = usePreviewStore((state) => state.setDiagnosticBackground);
  const setPreviewKeySettings = usePreviewStore((state) => state.setPreviewKeySettings);
  const deliverable = snapshot === null
    ? undefined
    : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
  const sequence = snapshot?.master.sequences.find(
    ({ id }) => id === deliverable?.sequenceId,
  );
  const clip = sequence?.clips.find(({ id }) => id === selectedClipId);
  const activeLayers = useMemo(() => snapshot?.master.layers.filter(
    ({ sequence: owner }) =>
      owner === undefined || owner === deliverable?.sequenceId,
  ) ?? [], [deliverable?.sequenceId, snapshot?.master.layers]);
  const asset = snapshot?.master.assets.find(({ id }) => id === clip?.asset);
  const [settings, setSettings] = useState<KeySettings | null>(null);
  const [report, setReport] = useState<KeyQcReport | null>(null);
  const [guidance, setGuidance] = useState<CaptureGuidanceReport | null>(null);
  const [arrangements, setArrangements] = useState<PresenterArrangement[]>([]);
  const [arrangementId, setArrangementId] = useState("presenter_sandwich");
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [matteCandidates, setMatteCandidates] = useState<MatteCandidate[]>([]);
  const qcJobSignature = useMemo(() => jobs.filter(({ kind, title }) =>
    kind === "keyqc.analyze" && (selectedClipId === null || title.includes(selectedClipId)))
    .map(({ jobId, state }) => `${jobId}:${state}`).join("|"), [jobs, selectedClipId]);
  const matteJobSignature = useMemo(() => jobs.filter(({ kind, title }) =>
    kind === "matte" && (selectedClipId === null || title.includes(selectedClipId)))
    .map(({ jobId, state }) => `${jobId}:${state}`).join("|"), [jobs, selectedClipId]);

  useEffect(() => {
    setSettings(clip === undefined ? null : persistedKey(clip));
  }, [clip]);

  useEffect(() => {
    setPreviewKeySettings(settings);
    return () => setPreviewKeySettings(null);
  }, [setPreviewKeySettings, settings]);

  useEffect(() => {
    void window.guyditor.call<PresenterArrangement[]>("CompositorModel", "arrangements", {})
      .then(setArrangements).catch(() => setArrangements([]));
  }, [snapshot?.revision]);

  useEffect(() => {
    if (clip === undefined || asset === undefined) {
      setReport(null);
      setGuidance(null);
      return;
    }
    void Promise.all([
      window.guyditor.call<KeyQcReport | null>("CompositorModel", "keyQcReport", { clipId: clip.id }),
      window.guyditor.call<CaptureGuidanceReport | null>("CompositorModel", "captureGuidance", { assetId: asset.id }),
    ]).then(([nextReport, nextGuidance]) => {
      setReport(nextReport);
      setGuidance(nextGuidance);
    }).catch(() => {
      setReport(null);
      setGuidance(null);
    });
  }, [asset?.id, clip?.id, qcJobSignature]);

  useEffect(() => {
    if (clip === undefined) {
      setMatteCandidates([]);
      return;
    }
    void window.guyditor.call<MatteCandidate[]>("CompositorModel", "matteCandidates", { clipId: clip.id })
      .then(setMatteCandidates).catch(() => setMatteCandidates([]));
  }, [clip?.id, matteJobSignature]);

  useEffect(() => {
    setAssignments({});
  }, [deliverable?.id]);

  useEffect(() => {
    const arrangement = arrangements.find(({ id, name }) =>
      arrangementId === id || arrangementId === name);
    if (arrangement === undefined || snapshot === null) return;
    const next: Record<string, string> = {};
    for (const role of arrangement.roles) {
      const matchingLayer = activeLayers.find(({ kind, sequence: owner }) =>
        kind === role.kind && owner === deliverable?.sequenceId) ??
        activeLayers.find(({ kind }) => kind === role.kind);
      const matchingAsset = snapshot.master.assets.find(({ kind }) =>
        role.kind === "video" ? kind === "video" : role.kind === "image" ? kind === "image" : false);
      const assignment = role.role === "presenter" && clip !== undefined
        ? activeLayers.find(({ sequence: owner }) =>
            owner === deliverable?.sequenceId)?.id ??
          matchingLayer?.id ??
          matchingAsset?.id
        : matchingLayer?.id ?? matchingAsset?.id;
      if (assignment !== undefined) next[role.role] = assignment;
    }
    setAssignments(next);
  }, [activeLayers, arrangementId, arrangements, clip, deliverable?.sequenceId, snapshot]);

  if (clip === undefined || snapshot === null) return null;
  const selectedClip = clip;
  const projectSnapshot = snapshot;
  const chroma = settings?.mode === "chroma" ? settings.chroma : undefined;
  const neural = settings?.mode === "neural" ? settings.neural : undefined;

  async function commit(next: KeySettings | null, label: string): Promise<void> {
    if (clip === undefined) return;
    try {
      await executeDirect([{ op: "clip.key.set", params: { clipId: clip.id, settings: next } }], label);
      await refreshProject();
      setNotice(label);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function updateChroma(update: (current: NonNullable<KeySettings["chroma"]>) => NonNullable<KeySettings["chroma"]>): void {
    setSettings((current) => current?.chroma === undefined
      ? current
      : { ...current, chroma: update(current.chroma) });
  }

  function commitCurrent(label: string): void {
    void commit(settings, label);
  }

  function eyedropper(): void {
    const receive = (event: Event): void => {
      const { color, error } = (event as CustomEvent<{ color?: string; error?: string }>).detail;
      if (error !== undefined) {
        setNotice(error);
        return;
      }
      if (color === undefined) return;
      if (settings?.chroma === undefined) return;
      const next = { ...settings, chroma: { ...settings.chroma, keyColor: color } };
      setSettings(next);
      void commit(next, `Sample key color ${color}`);
    };
    window.addEventListener("guyditor:key-eyedropper-result", receive, { once: true });
    window.dispatchEvent(new Event("guyditor:key-eyedropper-request"));
  }

  async function runQc(): Promise<void> {
    try {
      await executeDirect([{ op: "key.qc.run", params: { clipId: selectedClip.id } }], `Run key QC for ${selectedClip.id}`);
      await refreshProject();
      setNotice(`Queued key quality analysis for ${selectedClip.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function generateMatte(): Promise<void> {
    if (neural === undefined) return;
    const candidateParams = structuredClone(neural);
    delete candidateParams.matteAssetId;
    try {
      await executeDirect([{
        op: "key.matte.generate",
        params: { clipId: selectedClip.id, neural: candidateParams },
      }], `Generate neural matte for ${selectedClip.id}`);
      setNotice(`Queued neural matte generation for ${selectedClip.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function acceptMatte(candidate: MatteCandidate): Promise<void> {
    try {
      await window.guyditor.call("CompositorModel", "acceptMatteCandidate", {
        clipId: selectedClip.id,
        jobId: candidate.jobId,
      });
      await refreshProject();
      setNotice(`Accepted and froze neural matte ${candidate.jobId}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function renderDiagnostic(): Promise<void> {
    if (diagnosticBackground === "none") return;
    const layer = activeLayers.find(
      ({ sequence: owner }) => owner === deliverable?.sequenceId,
    ) ?? activeLayers.find(({ sequence: owner }) => owner === undefined);
    if (deliverable === undefined || layer === undefined) return;
    try {
      await window.guyditor.call("RenderService", "renderDiagnostic", {
        revision: projectSnapshot.revision,
        deliverableId: deliverable.id,
        inspectedLayerId: layer.id,
        diagnosticBackground,
        outputDir: `${projectSnapshot.projectPath}/exports/diagnostics`,
      });
      setNotice(`Queued ${diagnosticBackground} HQ diagnostic render.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function applyArrangement(): Promise<void> {
    if (deliverable === undefined) return;
    try {
      await executeDirect([{
        op: "composition.arrange",
        params: { sequenceId: deliverable.sequenceId, arrangementRef: arrangementId, assignments },
      }], `Apply ${arrangementId}`);
      await refreshProject();
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  const selectedArrangement = arrangements.find(({ id, name }) =>
    arrangementId === id || arrangementId === name);
  return (
    <section className="key-inspector" data-testid="key-inspector">
      <header><span className="panel-eyebrow">FR-502 · presenter key</span><strong>{clip.id}</strong></header>
      <label>Key method<select data-testid="key-method" value={settings?.mode ?? "off"} onChange={(event) => {
        if (event.currentTarget.value === "off") {
          setSettings(null);
          void commit(null, `Disable key on ${clip.id}`);
        } else if (event.currentTarget.value === "chroma") {
          const next = structuredClone(DEFAULT_KEY);
          setSettings(next);
          void commit(next, `Enable chroma key on ${clip.id}`);
        } else {
          setSettings(structuredClone(DEFAULT_NEURAL_KEY));
          setNotice("Neural matte selected for audition. Generate and accept a frozen matte to commit it.");
        }
      }}><option value="off">Off</option><option value="chroma">Chroma key</option><option value="neural">Neural matte (RVM)</option></select></label>
      {chroma === undefined ? (
        neural === undefined ? <div className="publish-actions"><button type="button" data-testid="key-enable" onClick={() => {
            const next = structuredClone(DEFAULT_KEY);
            setSettings(next);
            void commit(next, `Enable chroma key on ${clip.id}`);
          }}>Enable chroma key</button><button type="button" data-testid="matte-enable" onClick={() => {
            setSettings(structuredClone(DEFAULT_NEURAL_KEY));
            setNotice("Neural matte selected for audition. Generate and accept a frozen matte to commit it.");
          }}>Use neural matte</button></div> : <div className="neural-matte-controls" data-testid="neural-matte-controls">
          <label>RVM model<select value={neural.model} onChange={(event) => setSettings((current) => current?.neural === undefined ? current : {
            ...current,
            neural: { ...current.neural, model: event.currentTarget.value === "rvm_resnet50" ? "rvm_resnet50" : "rvm_mobilenetv3" },
          })}><option value="rvm_mobilenetv3">MobileNetV3 · faster</option><option value="rvm_resnet50">ResNet50 · higher detail</option></select></label>
          <label>Inference scale <output>{metricText(neural.downsampleRatio)}</output><input type="range" min="0.1" max="1" step="0.05" value={neural.downsampleRatio} onChange={(event) => setSettings((current) => current?.neural === undefined ? current : {
            ...current,
            neural: { ...current.neural, downsampleRatio: event.currentTarget.valueAsNumber },
          })} /></label>
          <label><input type="checkbox" checked={neural.stabilization.enabled} onChange={(event) => setSettings((current) => current?.neural === undefined ? current : {
            ...current,
            neural: { ...current.neural, stabilization: { ...current.neural.stabilization, enabled: event.currentTarget.checked } },
          })} />Temporal stabilization</label>
          {neural.matteAssetId === undefined ? <button type="button" data-testid="matte-generate" onClick={() => void generateMatte()}>Generate matte candidate</button> : <p className="state-chip" data-state="accepted">Frozen matte · {neural.matteAssetId}</p>}
          {matteCandidates.map((candidate) => <div key={candidate.jobId} className="key-qc-report" data-testid="matte-candidate"><strong>{candidate.engine.model}</strong><p>{candidate.frameCount} frames · alpha {candidate.alpha.minimum}–{candidate.alpha.maximum} · {candidate.engine.version}</p><button type="button" data-testid="matte-accept" onClick={() => void acceptMatte(candidate)}>Accept + freeze matte</button></div>)}
          <button type="button" data-testid="key-disable" onClick={() => {
            setSettings(null);
            void commit(null, `Disable neural matte on ${clip.id}`);
          }}>Remove key</button>
        </div>
      ) : (
        <>
          <div className="key-color-row">
            <label>Key color<input data-testid="key-color" type="color" value={chroma.keyColor} onChange={(event) => {
              const next = { ...settings!, chroma: { ...chroma, keyColor: event.currentTarget.value.toUpperCase() } };
              setSettings(next);
              void commit(next, "Set key color");
            }} /></label>
            <button type="button" data-testid="key-eyedropper" onClick={eyedropper}>Sample paused frame</button>
          </div>
          <label>Tolerance <output>{metricText(chroma.tolerance)}</output><input data-testid="key-tolerance" type="range" min="0" max="1" step="0.01" value={chroma.tolerance} onChange={(event) => updateChroma((current) => ({ ...current, tolerance: event.currentTarget.valueAsNumber }))} onPointerUp={() => commitCurrent("Set key tolerance")} /></label>
          <label>Edge softness <output>{metricText(chroma.softness)}</output><input data-testid="key-softness" type="range" min="0" max="1" step="0.01" value={chroma.softness} onChange={(event) => updateChroma((current) => ({ ...current, softness: event.currentTarget.valueAsNumber }))} onPointerUp={() => commitCurrent("Set key softness")} /></label>
          <label>Edge feather <output>{metricText(chroma.edge.featherPx)} px</output><input data-testid="key-edge" type="range" min="0" max="12" step="0.25" value={chroma.edge.featherPx} onChange={(event) => updateChroma((current) => ({ ...current, edge: { ...current.edge, featherPx: event.currentTarget.valueAsNumber } }))} onPointerUp={() => commitCurrent("Set key edge feather")} /></label>
          <label>Spill suppression <output>{metricText(chroma.spill.strength)}</output><input data-testid="key-spill" type="range" min="0" max="1" step="0.01" value={chroma.spill.strength} onChange={(event) => updateChroma((current) => ({ ...current, spill: { ...current.spill, strength: event.currentTarget.valueAsNumber } }))} onPointerUp={() => commitCurrent("Set spill suppression")} /></label>
          <button type="button" data-testid="key-disable" onClick={() => {
            setSettings(null);
            void commit(null, `Disable chroma key on ${clip.id}`);
          }}>Remove key</button>
        </>
      )}
      <div className="diagnostic-controls">
        <label>Diagnostic background<select data-testid="key-diagnostic" value={diagnosticBackground} onChange={(event) => setDiagnosticBackground(event.currentTarget.value as typeof diagnosticBackground)}>
          <option value="none">Composite</option><option value="black">Black</option><option value="white">White</option><option value="saturated">Saturated magenta</option><option value="checkerboard">Checkerboard</option>
        </select></label>
        <button type="button" data-testid="key-diagnostic-hq" disabled={diagnosticBackground === "none"} onClick={() => void renderDiagnostic()}>Render HQ diagnostic</button>
      </div>
      <div className="key-qc-actions"><button type="button" data-testid="key-qc-run" disabled={chroma === undefined && neural?.matteAssetId === undefined} onClick={() => void runQc()}>Run key QC</button></div>
      {report === null ? <p className="empty-copy">No QC report for this key.</p> : (
        <div className="key-qc-report" data-testid="key-qc-report">
          <strong>{report.warnings.length === 0 ? "QC clear" : `${String(report.warnings.length)} QC warnings`}</strong>
          {report.warnings.map((item) => <p key={item.code}><span>{item.code}</span> peak {metricText(item.peak)} · frames {item.frames.join(", ")}</p>)}
        </div>
      )}
      {guidance === null || guidance.warnings.length === 0 ? null : (
        <div className="capture-guidance" data-testid="capture-guidance">
          <strong>Capture guidance</strong>
          {guidance.warnings.map((item) => <p key={item.code}><span>{item.code}</span> · {item.remediation}</p>)}
        </div>
      )}
      <div className="arrangement-controls" data-testid="arrangement-picker">
        <label>Presenter arrangement<select value={arrangementId} onChange={(event) => setArrangementId(event.currentTarget.value)}>
          {arrangements.map((arrangement) => <option key={arrangement.id} value={arrangement.name}>{arrangement.name.replaceAll("_", " ")}</option>)}
        </select></label>
        {selectedArrangement?.roles.map((role) => <label key={role.role}>{role.role}<select value={assignments[role.role] ?? ""} onChange={(event) => setAssignments((current) => ({ ...current, [role.role]: event.currentTarget.value }))}>
          <option value="">Choose…</option>
          {activeLayers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name} · {layer.kind}</option>)}
          {snapshot.master.assets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.path} · {candidate.kind}</option>)}
        </select></label>)}
        <button type="button" data-testid="arrangement-apply" disabled={selectedArrangement?.roles.some(({ role }) => assignments[role] === undefined) ?? true} onClick={() => void applyArrangement()}>Apply arrangement</button>
      </div>
    </section>
  );
}
