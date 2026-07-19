import { useEffect, useMemo, useState } from "react";

import {
  MOTION_PRESETS,
} from "../../../../compositor/src/motion.js";
import { pipPlaceOperation } from "../../../../compositor/src/pip-operation.js";
import type {
  AnchorName,
  AvoidRegion,
  PipStyle,
  PlacementConstraints,
} from "../../../../core/src/index.js";
import { errorMessage, executeDirect } from "../ipc.js";
import { usePreviewStore, useSelectionStore } from "../state/view-state.js";
import type { WorkspacePanelProps } from "./types.js";

const ANCHORS: readonly AnchorName[] = [
  "top_left", "top", "top_right", "left", "center", "right",
  "bottom_left", "bottom", "bottom_right",
];
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function semanticId(prefix: "kfr" | "avr"): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((value) => BASE32[value & 31]).join("")}`;
}

export function PipInspector({
  snapshot,
  refreshProject,
  setNotice,
}: Pick<WorkspacePanelProps, "snapshot" | "refreshProject" | "setNotice">): React.JSX.Element | null {
  const selectedLayerId = useSelectionStore((state) => state.selectedLayerId);
  const selectedWordId = useSelectionStore((state) => state.selectedWordId);
  const playhead = usePreviewStore((state) => state.playhead);
  const layer = snapshot?.master.layers.find(({ id }) => id === selectedLayerId);
  const visual = layer?.kind === "video" || layer?.kind === "image" || layer?.kind === "animation";
  const placement = layer?.pip?.placement.base;
  const [anchor, setAnchor] = useState<AnchorName>(placement?.anchor ?? "bottom_right");
  const [width, setWidth] = useState(placement?.width ?? "24%");
  const [margin, setMargin] = useState(placement?.margin ?? "4%");
  const [shape, setShape] = useState<PipStyle["mask"]["shape"]>(layer?.pip?.style.mask.shape ?? "rounded");
  const [presetId, setPresetId] = useState("pre_pipsmoothm");
  const [durationFrames, setDurationFrames] = useState(18);
  const sequenceId = snapshot?.master.deliverables.find(({ id }) =>
    id === snapshot.master.settings.primaryDeliverable)?.sequenceId;
  const reviewAnchor = selectedWordId === null
    ? (sequenceId === undefined ? "" : `timeline:${sequenceId}@${String(playhead.frames)}`)
    : `word:${selectedWordId}`;
  const nextPlacement = useMemo((): PlacementConstraints => ({
    anchor,
    width,
    margin,
    ...(placement?.aspect === undefined ? {} : { aspect: placement.aspect }),
  }), [anchor, margin, placement?.aspect, width]);

  useEffect(() => {
    if (placement === undefined) return;
    setAnchor(placement.anchor);
    setWidth(placement.width ?? "24%");
    setMargin(placement.margin ?? "4%");
    setShape(layer?.pip?.style.mask.shape ?? "rounded");
  }, [layer?.id, layer?.pip?.style.mask.shape, placement]);

  if (layer === undefined || !visual) return null;

  async function run(operations: Parameters<typeof executeDirect>[0], label: string): Promise<void> {
    try {
      await executeDirect(operations, label);
      await refreshProject();
      setNotice(label);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function style(): PipStyle {
    return {
      ...(layer?.pip?.style ?? {}),
      mask: {
        ...(layer?.pip?.style.mask ?? {}),
        shape,
        ...(shape === "rounded" ? { cornerRadius: 0.08 } : {}),
      },
    };
  }

  async function place(): Promise<void> {
    await run([pipPlaceOperation(layer!.id, nextPlacement)],
      `Place ${layer!.name} ${anchor}, width ${width}, margin ${margin}`);
  }

  async function applyStyle(): Promise<void> {
    await run([{
      op: "pip.style.set",
      params: { layerId: layer!.id, style: style() },
    }], `Set ${layer!.name} PiP shape to ${shape}`);
  }

  async function addKeyframe(): Promise<void> {
    if (reviewAnchor.length === 0) return;
    await run([{
      op: "pip.preset.apply",
      params: {
        layerId: layer!.id,
        keyframeId: semanticId("kfr"),
        at: reviewAnchor,
        placement: nextPlacement,
        presetId,
        version: 1,
        durationFrames,
      },
    }], `Add ${presetId}@1 at ${reviewAnchor}`);
  }

  async function markRegion(): Promise<void> {
    const region: AvoidRegion = {
      id: semanticId("avr"),
      source: "marked",
      hardness: "hard",
      rect: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 },
      frames: { from: playhead.frames, to: playhead.frames + 60 },
    };
    await run([{ op: "region.mark", params: { region } }], "Mark preview avoid region");
  }

  return (
    <section className="pip-inspector" data-testid="pip-inspector">
      <header><strong>Picture in picture</strong><span>{layer.pip === undefined ? "not placed" : `${layer.pip.keyframes.length} keyframes`}</span></header>
      <div className="pip-grid">
        <label>Anchor<select data-testid="pip-anchor" value={anchor} onChange={(event) => setAnchor(event.currentTarget.value as AnchorName)}>
          {ANCHORS.map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label>Width<input data-testid="pip-width" value={width} onChange={(event) => setWidth(event.currentTarget.value)} /></label>
        <label>Margin<input data-testid="pip-margin" value={margin} onChange={(event) => setMargin(event.currentTarget.value)} /></label>
        <button type="button" data-testid="pip-place" onClick={() => void place()}>Place / update</button>
      </div>
      <div className="pip-grid">
        <label>Shape<select data-testid="pip-shape" value={shape} onChange={(event) => setShape(event.currentTarget.value as PipStyle["mask"]["shape"])}>
          {(["none", "rect", "rounded", "circle", "ellipse"] as const).map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <button type="button" data-testid="pip-style-apply" onClick={() => void applyStyle()}>Apply chrome</button>
      </div>
      <div className="pip-motion">
        <label>Motion<select data-testid="pip-preset" value={presetId} onChange={(event) => {
          setPresetId(event.currentTarget.value);
          window.dispatchEvent(new CustomEvent("guyditor:pip-preset-preview", { detail: event.currentTarget.value }));
        }}>
          {MOTION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} · v{preset.version}</option>)}
        </select></label>
        <label>Frames<input type="number" min="1" value={durationFrames} onChange={(event) => setDurationFrames(Math.max(1, event.currentTarget.valueAsNumber || 1))} /></label>
        <output data-testid="pip-review-anchor">{reviewAnchor || "Select a review anchor"}</output>
        <button type="button" data-testid="pip-keyframe-add" disabled={layer.pip === undefined || reviewAnchor.length === 0} onClick={() => void addKeyframe()}>Transition to state at anchor</button>
      </div>
      <div className="pip-avoid-actions">
        <button type="button" data-testid="pip-region-mark" onClick={() => void markRegion()}>Mark avoid region</button>
        <button type="button" data-testid="pip-avoid-solve" disabled={layer.pip?.avoid?.enabled !== true} onClick={() => void run([{
          op: "pip.avoid.solve", params: { layerId: layer.id },
        }], "Prepare collision-avoidance proposal")}>Preview avoidance</button>
        <small>Caption, marked-region, and safe-area avoidance ship in M2. Subject/diagram tracking hooks remain M3.</small>
      </div>
    </section>
  );
}
