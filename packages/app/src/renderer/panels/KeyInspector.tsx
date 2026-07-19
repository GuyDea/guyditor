import { useEffect, useMemo, useState } from "react";

import type { KeySettings } from "../../../../core/src/index.js";
import type { PresenterArrangement } from "../../../../compositor/src/index.js";
import type {
  CaptureGuidanceReport,
  KeyQcReport,
} from "../../../../media/src/index.js";
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
  const selectedClipId = useSelectionStore((state) => state.selectedClipId);
  const jobs = useJobsStore((state) => state.jobs);
  const diagnosticBackground = usePreviewStore((state) => state.diagnosticBackground);
  const setDiagnosticBackground = usePreviewStore((state) => state.setDiagnosticBackground);
  const setPreviewKeySettings = usePreviewStore((state) => state.setPreviewKeySettings);
  const clip = snapshot?.master.sequences.flatMap(({ clips }) => clips)
    .find(({ id }) => id === selectedClipId);
  const asset = snapshot?.master.assets.find(({ id }) => id === clip?.asset);
  const [settings, setSettings] = useState<KeySettings | null>(null);
  const [report, setReport] = useState<KeyQcReport | null>(null);
  const [guidance, setGuidance] = useState<CaptureGuidanceReport | null>(null);
  const [arrangements, setArrangements] = useState<PresenterArrangement[]>([]);
  const [arrangementId, setArrangementId] = useState("presenter_sandwich");
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const qcJobSignature = useMemo(() => jobs.filter(({ kind, title }) =>
    kind === "keyqc.analyze" && (selectedClipId === null || title.includes(selectedClipId)))
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
    const arrangement = arrangements.find(({ id, name }) =>
      arrangementId === id || arrangementId === name);
    if (arrangement === undefined || snapshot === null) return;
    const next: Record<string, string> = {};
    for (const role of arrangement.roles) {
      const matchingLayer = snapshot.master.layers.find(({ kind }) => kind === role.kind);
      const matchingAsset = snapshot.master.assets.find(({ kind }) =>
        role.kind === "video" ? kind === "video" : role.kind === "image" ? kind === "image" : false);
      const assignment = role.role === "presenter" && clip !== undefined
        ? snapshot.master.layers.find(({ sequence }) => sequence === snapshot.master.sequences.find(
            ({ clips }) => clips.some(({ id }) => id === clip.id),
          )?.id)?.id ?? matchingLayer?.id ?? matchingAsset?.id
        : matchingLayer?.id ?? matchingAsset?.id;
      if (assignment !== undefined) next[role.role] = assignment;
    }
    setAssignments(next);
  }, [arrangementId, arrangements, clip, snapshot]);

  if (clip === undefined || snapshot === null) return null;
  const selectedClip = clip;
  const projectSnapshot = snapshot;
  const chroma = settings?.mode === "chroma" ? settings.chroma : undefined;

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

  async function renderDiagnostic(): Promise<void> {
    if (diagnosticBackground === "none") return;
    const deliverable = projectSnapshot.master.deliverables.find(
      ({ id }) => id === projectSnapshot.master.settings.primaryDeliverable,
    );
    const layer = projectSnapshot.master.layers.find(({ sequence }) =>
      sequence !== undefined && projectSnapshot.master.sequences.find(({ id }) => id === sequence)
        ?.clips.some(({ id }) => id === selectedClip.id));
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
    const deliverable = projectSnapshot.master.deliverables.find(
      ({ id }) => id === projectSnapshot.master.settings.primaryDeliverable,
    );
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
      {chroma === undefined ? (
        <button type="button" data-testid="key-enable" onClick={() => {
          const next = structuredClone(DEFAULT_KEY);
          setSettings(next);
          void commit(next, `Enable chroma key on ${clip.id}`);
        }}>Enable chroma key</button>
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
      <div className="key-qc-actions"><button type="button" data-testid="key-qc-run" disabled={chroma === undefined} onClick={() => void runQc()}>Run key QC</button></div>
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
          {snapshot.master.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name} · {layer.kind}</option>)}
          {snapshot.master.assets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.path} · {candidate.kind}</option>)}
        </select></label>)}
        <button type="button" data-testid="arrangement-apply" disabled={selectedArrangement?.roles.some(({ role }) => assignments[role] === undefined) ?? true} onClick={() => void applyArrangement()}>Apply arrangement</button>
      </div>
    </section>
  );
}
