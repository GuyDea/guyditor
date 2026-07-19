import { useEffect, useRef, useState } from "react";

import { deriveTimeline } from "../../../../core/src/project/derive.js";
import { convertTimeRounding } from "../../../../core/src/time/index.js";
import type { Clip, Layer } from "../../../../core/src/index.js";
import type { PeaksFile } from "../../../../media/src/index.js";
import { errorMessage, executeDirect } from "../ipc.js";
import { usePreviewStore, useSelectionStore, useTimelineViewStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

function sequenceFor(snapshot: NonNullable<WorkspacePanelProps["snapshot"]>) {
  const deliverable = snapshot.master.deliverables.find(
    ({ id }) => id === snapshot.master.settings.primaryDeliverable,
  );
  return snapshot.master.sequences.find(({ id }) => id === deliverable?.sequenceId) ??
    snapshot.master.sequences[0];
}

function clipDuration(clip: Clip): number {
  return clip.source.out.frames - clip.source.in.frames;
}

export function TimelinePanel({
  snapshot,
  annotations,
  refreshProject,
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
  const selectedClipId = useSelectionStore((state) => state.selectedClipId);
  const selectedLayerId = useSelectionStore((state) => state.selectedLayerId);
  const selectClip = useSelectionStore((state) => state.selectClip);
  const selectLayer = useSelectionStore((state) => state.selectLayer);
  const playhead = usePreviewStore((state) => state.playhead);
  const setPlayhead = usePreviewStore((state) => state.setPlayhead);
  const sequence = snapshot === null ? undefined : sequenceFor(snapshot);
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
      await executeDirect(operations, label);
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
    await commit([
      { op: "clip.remove", params: { clipId } },
      {
        op: "clip.restore",
        params: { sequenceId: sequence.id, targetIndex, clips: [structuredClone(clip)] },
      },
    ], `Reorder ${clipId}`, `Moved ${clipId} to position ${String(targetIndex + 1)}.`);
  }

  async function setGap(): Promise<void> {
    if (sequence === undefined || selected === undefined) return;
    const index = sequence.clips.findIndex(({ id }) => id === selected.id);
    const replacement = structuredClone(selected);
    if (gapFrames <= 0) delete replacement.gapBefore;
    else replacement.gapBefore = { frames: gapFrames, fps };
    await commit([
      { op: "clip.remove", params: { clipId: selected.id } },
      {
        op: "clip.restore",
        params: { sequenceId: sequence.id, targetIndex: index, clips: [replacement] },
      },
    ], `Set gap before ${selected.id}`, `Set gap before ${selected.id} to ${String(gapFrames)} frames.`);
  }

  async function layerAction(layer: Layer, action: "enable" | "disable" | "lock" | "unlock"): Promise<void> {
    await commit([{
      op: `layer.${action}`,
      params: { layerId: layer.id },
    }], `${action} ${layer.id}`, `${action}d ${layer.name}.`);
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
            params: { clipId: selected.id },
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
              <button type="button" data-testid={`layer-select-${layer.id}`} onClick={() => selectLayer(layer.id)}>{layer.name}</button>
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
      <small className="m2-note">Waveform tiers load on selection. M1 virtualizes the horizontal clip window; multi-layer placed-item editing and catalogued layer mutations depend on the remaining Part 5 operation entries.</small>
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
