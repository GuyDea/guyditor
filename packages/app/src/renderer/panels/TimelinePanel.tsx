import { useEffect, useRef, useState } from "react";

import { deriveTimeline } from "../../../../core/src/project/derive.js";
import { convertTimeRounding } from "../../../../core/src/time/index.js";
import { findJumpCutWarnings } from "../../../../core/src/assist/jumpcuts.js";
import type { Clip, Layer } from "../../../../core/src/index.js";
import type { PeaksFile } from "../../../../media/src/index.js";
import { resolveActiveDeliverable } from "../active-deliverable.js";
import { errorMessage, executeDirect } from "../ipc.js";
import { usePreviewStore, useSelectionStore, useTimelineViewStore } from "../state/view-state.js";
import { directEditDivergence } from "./direct-edit-divergence.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

export function synchronizeTimelineScroll(
  viewport: { scrollLeft: number },
  scrollOffsetFrames: number,
  zoomPixelsPerFrame: number,
): void {
  const expected = scrollOffsetFrames * zoomPixelsPerFrame;
  if (Math.abs(viewport.scrollLeft - expected) > 0.5) {
    viewport.scrollLeft = expected;
  }
}

export function jumpCutProposalNotice(result: {
  report: string;
  proposals: Array<{ id: string }>;
}): string {
  if (result.proposals.length === 0) return result.report;
  if (result.proposals.length === 1) {
    return `Prepared review proposal ${result.proposals[0]!.id} for the flagged cut.`;
  }
  const ids = result.proposals.map(({ id }) => id);
  const last = ids.pop()!;
  const list = ids.length === 1
    ? `${ids[0]} and ${last}`
    : `${ids.join(", ")}, and ${last}`;
  return `Prepared ${String(result.proposals.length)} review proposals ${list} for the flagged cut.`;
}

function clipDuration(clip: Clip): number {
  return clip.source.out.frames - clip.source.in.frames;
}

export function TimelinePanel({
  snapshot,
  annotations,
  restylePlan,
  refreshProject,
  refreshProposals,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [trimFrames, setTrimFrames] = useState(1);
  const [trimEdge, setTrimEdge] = useState<"head" | "tail">("tail");
  const [gapFrames, setGapFrames] = useState(0);
  const [peaks, setPeaks] = useState<PeaksFile | null>(null);
  const zoom = useTimelineViewStore((state) => state.zoomPixelsPerFrame);
  const scrollOffset = useTimelineViewStore((state) => state.scrollOffsetFrames);
  const viewportWidth = useTimelineViewStore((state) => state.viewportWidth);
  const setZoom = useTimelineViewStore((state) => state.setZoom);
  const setScrollOffset = useTimelineViewStore((state) => state.setScrollOffset);
  const setViewportWidth = useTimelineViewStore((state) => state.setViewportWidth);
  const selectedDeliverableId = useSelectionStore(
    (state) => state.selectedDeliverableId,
  );
  const selectedClipId = useSelectionStore((state) => state.selectedClipId);
  const selectedLayerId = useSelectionStore((state) => state.selectedLayerId);
  const selectClip = useSelectionStore((state) => state.selectClip);
  const selectLayer = useSelectionStore((state) => state.selectLayer);
  const playhead = usePreviewStore((state) => state.playhead);
  const setPlayhead = usePreviewStore((state) => state.setPlayhead);
  const deliverable = snapshot === null
    ? undefined
    : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
  const sequence = snapshot?.master.sequences.find(
    ({ id }) => id === deliverable?.sequenceId,
  );
  const derivedResult = snapshot === null || sequence === undefined
    ? undefined
    : deriveTimeline(snapshot.master, sequence.id);
  const derived = derivedResult?.ok === true ? derivedResult.value : undefined;
  const selected = sequence?.clips.find(({ id }) => id === selectedClipId);
  const selectedTimed = derived?.clips.find(({ clipId }) => clipId === selectedClipId);
  const fps = snapshot?.master.settings.timeline.fps ?? playhead.fps;
  const totalFrames = derived?.clips.reduce(
    (maximum, clip) => Math.max(maximum, clip.start.frames + clip.duration.frames),
    0,
  ) ?? 0;
  const visibleStart = Math.max(0, scrollOffset - viewportWidth / zoom);
  const visibleEnd = scrollOffset + viewportWidth / zoom * 2;
  const visibleClips = derived?.clips.filter(({ start, duration }) =>
    start.frames + duration.frames >= visibleStart && start.frames <= visibleEnd) ?? [];
  const layers = snapshot?.master.layers.filter(({ sequence: id }) => id === sequence?.id) ?? [];
  const jumpCuts = snapshot === null || sequence === undefined
    ? []
    : findJumpCutWarnings(snapshot.master, sequence.id);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setViewportWidth(entry.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [setViewportWidth]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    synchronizeTimelineScroll(viewport, scrollOffset, zoom);
  }, [scrollOffset, sequence?.id, zoom]);

  useEffect(() => {
    let current = true;
    setPeaks(null);
    if (selected === undefined) return () => { current = false; };
    void window.guyditor.call<PeaksFile | null>("MediaEngine", "readPeaks", {
      assetId: selected.asset,
    }).then((value) => {
      if (current) setPeaks(value);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [selected?.asset]);

  async function commit(
    operations: Array<{ op: string; params: Record<string, unknown> }>,
    label: string,
    success: string,
  ): Promise<void> {
    try {
      await executeDirect(
        operations,
        label,
        snapshot === null
          ? undefined
          : directEditDivergence(snapshot.master, operations),
      );
      await refreshProject();
      setNotice(success);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function split(): Promise<void> {
    if (selected === undefined || selectedTimed === undefined) return;
    const offset = convertTimeRounding(
      { frames: playhead.frames - selectedTimed.start.frames, fps },
      selected.source.in.fps,
    );
    if (!offset.ok) {
      setNotice(offset.error.message);
      return;
    }
    await commit([{
      op: "clip.split",
      params: { clipId: selected.id, at: offset.value.time.frames },
    }], `Split ${selected.id}`, `Split ${selected.id} at frame ${String(playhead.frames)}.`);
  }

  async function joinNext(): Promise<void> {
    if (sequence === undefined || selected === undefined) return;
    const index = sequence.clips.findIndex(({ id }) => id === selected.id);
    const next = sequence.clips[index + 1];
    if (next === undefined) {
      setNotice("Select a clip that has an adjacent following clip.");
      return;
    }
    await commit([{
      op: "clip.join",
      params: { clipIds: [selected.id, next.id] },
    }], `Join ${selected.id} and ${next.id}`, `Joined ${selected.id} and ${next.id}.`);
  }

  async function reorder(clipId: string, targetId: string): Promise<void> {
    if (sequence === undefined || clipId === targetId) return;
    const from = sequence.clips.findIndex(({ id }) => id === clipId);
    const to = sequence.clips.findIndex(({ id }) => id === targetId);
    const clip = sequence.clips[from];
    if (clip === undefined || from < 0 || to < 0) return;
    const targetIndex = from < to ? to - 1 : to;
    await commit([{
      op: "clip.move",
      params: { clipId, toIndex: targetIndex },
    }], `Reorder ${clipId}`, `Moved ${clipId} to position ${String(targetIndex + 1)}.`);
  }

  async function setGap(): Promise<void> {
    if (selected === undefined) return;
    await commit([{
      op: "clip.gap.set",
      params: {
        clipId: selected.id,
        leadingGap: gapFrames <= 0 ? null : { frames: gapFrames, fps },
      },
    }], `Set gap before ${selected.id}`, `Set gap before ${selected.id} to ${String(gapFrames)} frames.`);
  }

  async function layerAction(layer: Layer, action: "enable" | "disable" | "lock" | "unlock"): Promise<void> {
    await commit([{
      op: `layer.${action}`,
      params: { layerId: layer.id },
    }], `${action} ${layer.id}`, `${action}d ${layer.name}.`);
  }

  async function proposeConcealment(beforeClipId: string): Promise<void> {
    if (sequence === undefined) return;
    try {
      const result = await window.guyditor.call<{
        kind: "proposal" | "no-proposal";
        proposals?: Array<{ id: string }>;
        report: string;
      }>("OperationEngine", "proposeJumpCutConcealment", {
        sequenceId: sequence.id,
        beforeClipId,
      });
      await refreshProposals();
      setNotice(jumpCutProposalNotice({
        report: result.report,
        proposals: result.proposals ?? [],
      }));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <Panel
      id="timeline"
      title="Timeline"
      eyebrow="Single sequence / virtualized"
      actions={(
        <label className="zoom-control">
          Zoom
          <input
            type="range"
            min="0.25"
            max="16"
            step="0.25"
            value={zoom}
            data-testid="timeline-zoom"
            onChange={(event) => setZoom(event.target.valueAsNumber)}
          />
        </label>
      )}
    >
      <div className="timeline-toolbar" role="toolbar" aria-label="Timeline operations">
        <input
          type="number"
          min="1"
          value={trimFrames}
          aria-label="Trim frames"
          data-testid="timeline-trim-value"
          onChange={(event) => setTrimFrames(Math.max(1, event.target.valueAsNumber || 1))}
        />
        <button type="button" data-active={trimEdge === "head"} data-testid="timeline-trim-head" onClick={() => setTrimEdge("head")}>Head</button>
        <button type="button" data-active={trimEdge === "tail"} data-testid="timeline-trim-tail" onClick={() => setTrimEdge("tail")}>Tail</button>
        <button
          type="button"
          data-testid="timeline-trim-submit"
          disabled={selected === undefined}
          onClick={() => selected === undefined ? undefined : void commit([{
            op: "clip.trim",
            params: {
              clipId: selected.id,
              edge: trimEdge,
              delta: { frames: trimFrames, fps: selected.source.in.fps },
              snapPolicy: "none",
            },
          }], `Trim ${selected.id}`, `Trimmed ${trimEdge} of ${selected.id}.`)}
        >Trim</button>
        <button type="button" data-testid="timeline-split-submit" disabled={selected === undefined} onClick={() => void split()}>Split</button>
        <button type="button" data-testid="timeline-join-submit" disabled={selected === undefined} onClick={() => void joinNext()}>Join next</button>
        <button
          type="button"
          data-testid="timeline-remove-submit"
          disabled={selected === undefined}
          onClick={() => selected === undefined ? undefined : void commit([{
            op: "clip.remove",
            params: { clipId: selected.id, closeGap: true },
          }], `Remove ${selected.id}`, `Removed ${selected.id}.`)}
        >Remove</button>
        <input
          type="number"
          min="0"
          value={gapFrames}
          aria-label="Gap frames"
          data-testid="timeline-gap-value"
          onChange={(event) => setGapFrames(Math.max(0, event.target.valueAsNumber || 0))}
        />
        <button type="button" data-testid="timeline-gap-submit" disabled={selected === undefined} onClick={() => void setGap()}>Set gap</button>
      </div>
      <div className="timeline-grid">
        <div className="layer-list" data-testid="timeline-layer-list">
          {layers.map((layer) => (
            <div key={layer.id} className="layer-row" data-selected={selectedLayerId === layer.id}>
              <div className="layer-identity">
                <button type="button" data-testid={`layer-select-${layer.id}`} onClick={() => selectLayer(layer.id)}>{layer.name}</button>
                {layer.kind === "music" ? (
                  <span
                    className="ducking-visualization"
                    data-enabled={layer.ducking?.enabled === true}
                    data-testid={`ducking-visualization-${layer.id}`}
                    title={layer.ducking === undefined
                      ? "Ducking is not configured"
                      : `${layer.ducking.mode} ducking ${String(layer.ducking.duckDb)} dB`}
                  >
                    <i />
                    <b>{layer.ducking === undefined ? "DUCK OFF" : `${String(layer.ducking.duckDb)} dB`}</b>
                  </span>
                ) : null}
              </div>
              <button type="button" data-testid={`layer-enable-${layer.id}`} onClick={() => void layerAction(layer, layer.enabled ? "disable" : "enable")}>{layer.enabled ? "On" : "Off"}</button>
              <button type="button" data-testid={`layer-lock-${layer.id}`} onClick={() => void layerAction(layer, layer.locked ? "unlock" : "lock")}>{layer.locked ? "Locked" : "Open"}</button>
            </div>
          ))}
        </div>
        <div
          ref={viewportRef}
          className="timeline-viewport"
          data-testid="timeline-viewport"
          onScroll={(event) => setScrollOffset(event.currentTarget.scrollLeft / zoom)}
        >
          <div className="timeline-content" style={{ width: `${String(Math.max(viewportWidth, totalFrames * zoom + 80))}px` }}>
            <div className="timeline-ruler" aria-hidden="true" style={{ backgroundSize: `${String(Math.max(12, zoom * 24))}px 100%` }} />
            <div className="restyle-timeline-ranges" aria-label="Restyle chunk boundaries">
              {restylePlan?.chunks.map((chunk) => (
                <span
                  key={chunk.id}
                  data-state={chunk.status}
                  data-testid={`restyle-timeline-chunk-${String(chunk.index)}`}
                  title={`Restyle ${String(chunk.index + 1)} · ${String(chunk.sourceRange.startFrame)}–${String(chunk.sourceRange.endFrame)} · ${chunk.semanticAnchors.boundaryKind}`}
                  style={{
                    left: `${String(chunk.sourceRange.startFrame * zoom)}px`,
                    width: `${String(Math.max(2, (chunk.sourceRange.endFrame - chunk.sourceRange.startFrame) * zoom))}px`,
                  }}
                />
              ))}
            </div>
            <div className="restyle-timeline-seams" aria-label="Restyle seam treatments">
              {restylePlan?.seams.map((seam) => (
                <span
                  key={seam.id}
                  data-kind={seam.treatment.kind}
                  data-state={seam.status}
                  data-testid={`restyle-timeline-seam-${seam.id}`}
                  title={`${seam.id} · ${seam.treatment.kind} · ${String(seam.frame)}f`}
                  style={{ left: `${String(seam.frame * zoom)}px` }}
                />
              ))}
            </div>
            <div className="timeline-clips">
              {visibleClips.map((timed) => {
                const clip = sequence?.clips.find(({ id }) => id === timed.clipId);
                if (clip === undefined) return null;
                return (
                  <button
                    key={clip.id}
                    type="button"
                    draggable
                    className="timeline-clip"
                    data-selected={selectedClipId === clip.id}
                    data-testid={`timeline-clip-${clip.id}`}
                    style={{
                      left: `${String(timed.start.frames * zoom)}px`,
                      width: `${String(Math.max(36, timed.duration.frames * zoom))}px`,
                    }}
                    onClick={() => {
                      selectClip(clip.id);
                      setPlayhead({ frames: timed.start.frames, fps });
                      setGapFrames(clip.gapBefore?.frames ?? 0);
                    }}
                    onDragStart={(event) => event.dataTransfer.setData("text/guyditor-clip", clip.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      void reorder(event.dataTransfer.getData("text/guyditor-clip"), clip.id);
                    }}
                  >
                    <span>{clip.id}</span>
                    <small>{clipDuration(clip)}f</small>
                    {selectedClipId === clip.id && peaks !== null ? <Waveform peaks={peaks} /> : null}
                  </button>
                );
              })}
              {jumpCuts.map((warning) => {
                const after = derived?.clips.find(({ clipId }) =>
                  clipId === warning.boundary.afterClip);
                const beforeClipId = warning.boundary.beforeClip;
                if (after === undefined || beforeClipId === undefined) return null;
                return (
                  <button
                    key={`${beforeClipId}:${warning.boundary.afterClip ?? "-"}`}
                    type="button"
                    className="jumpcut-seam"
                    style={{ left: `${String(after.start.frames * zoom)}px` }}
                    title={`${warning.evidence} Propose concealment.`}
                    aria-label={`Jump-cut warning after ${beforeClipId}; propose concealment`}
                    data-testid={`jumpcut-propose-${beforeClipId}`}
                    onClick={() => void proposeConcealment(beforeClipId)}
                  >
                    <span aria-hidden="true">!</span>
                  </button>
                );
              })}
              <div className="timeline-playhead" style={{ left: `${String(playhead.frames * zoom)}px` }} />
              {annotations.map((annotation, index) => (
                <span
                  key={annotation.id}
                  className="annotation-marker"
                  title={annotation.body}
                  style={{ left: `${String((index * 8 + playhead.frames) * zoom)}px` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <small className="m2-note">
        {jumpCuts.length === 0
          ? "No same-source jump cuts are flagged in this sequence."
          : `${String(jumpCuts.length)} jump-cut seam${jumpCuts.length === 1 ? "" : "s"} flagged; select ! to prepare a review proposal.`}
      </small>
    </Panel>
  );
}

function Waveform({ peaks }: { peaks: PeaksFile }): React.JSX.Element {
  const data = peaks.tiers.at(-1)?.data ?? [];
  const bars = data.slice(0, 120).filter((_value, index) => index % 2 === 1);
  return (
    <span className="waveform" aria-hidden="true">
      {bars.map((value, index) => (
        <i key={index} style={{ height: `${String(Math.max(2, Math.abs(value) / 127 * 22))}px` }} />
      ))}
    </span>
  );
}
