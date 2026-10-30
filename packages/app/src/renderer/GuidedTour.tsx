import { useEffect, useLayoutEffect, useState } from "react";
import type { CSSProperties } from "react";

import type { DockPanelId, WorkflowPhase } from "./state/layout-state.js";
import { useWorkspaceStore } from "./state/view-state.js";
import { revealPanel } from "./workspace-navigation.js";

interface TourStop {
  id: string;
  selector: string;
  title: string;
  copy: string;
  phase?: WorkflowPhase;
  panel?: DockPanelId;
}

export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: "phase-tabs",
    selector: "[data-testid='workflow-phase-tabs']",
    title: "Work left to right",
    copy: "These five phase tabs each remember their own layout. Split, close, or add panels from any panel header; your layouts follow you into every project.",
  },
  {
    id: "master-tool-rail",
    selector: "[data-testid='master-tool-rail']",
    title: "Keep every tool within reach",
    copy: "The master rail is the complete panel map. Activate a tool to jump to it, or to add it next to the panel you last used if this tab does not show it yet.",
  },
  {
    id: "global-progress",
    selector: "[data-testid='global-progress']",
    title: "See what the project is waiting on",
    copy: "Project activity aggregates every background job. Its waiting-on view separates running work, queued chains, your decisions, and external provider calls.",
  },
  {
    id: "ingest-media",
    selector: "[data-testid='media-panel']",
    phase: "ingest",
    panel: "media",
    title: "Bring material in",
    copy: "Drop footage here or choose a path. Sources are hashed and referenced; Guyditor never modifies the originals.",
  },
  {
    id: "ingest-status",
    selector: "[data-testid='status-panel']",
    phase: "ingest",
    panel: "status",
    title: "Follow the ingest chain",
    copy: "Hashing, probing, proxies, waveforms, and transcription stay visible as real jobs with retryable states.",
  },
  {
    id: "ingest-storage",
    selector: "[data-testid='storage-panel']",
    phase: "ingest",
    panel: "storage",
    title: "Know what is disposable",
    copy: "Storage separates source media from regenerable caches, so cleanup never reaches project state or originals.",
  },
  {
    id: "cut-preview",
    selector: "[data-testid='preview-panel']",
    phase: "cut",
    panel: "preview",
    title: "See the exact frame",
    copy: "The preview follows the same semantic selection and timing used by the timeline and transcript.",
  },
  {
    id: "cut-transcript",
    selector: "[data-testid='transcript-panel']",
    phase: "cut",
    panel: "transcript",
    title: "Shape the story in words",
    copy: "Select transcript ranges to remove, retain, clip, or mark. Word IDs stay stable so downstream edits keep their anchors.",
  },
  {
    id: "cut-agent",
    selector: "[data-testid='agent-panel']",
    phase: "cut",
    panel: "agent",
    title: "Review assisted cuts",
    copy: "Filler, pause, pickup, and continuity assistance compile into proposals. You review the edit before anything consequential applies.",
  },
  {
    id: "cut-timeline",
    selector: "[data-testid='timeline-panel']",
    phase: "cut",
    panel: "timeline",
    title: "Edit with full history",
    copy: "Trim, split, join, move, and layer changes are semantic operations—undoable and journaled.",
  },
  {
    id: "polish-preview",
    selector: "[data-testid='preview-panel']",
    phase: "polish",
    panel: "preview",
    title: "Polish against the final picture",
    copy: "Caption, keying, composition, and meter feedback all meet on the preview frame.",
  },
  {
    id: "polish-transcript",
    selector: "[data-testid='transcript-panel']",
    phase: "polish",
    panel: "transcript",
    title: "Keep timing anchored to words",
    copy: "Captions and graphic moments inherit stable transcript anchors, even after corrections.",
  },
  {
    id: "polish-inspector",
    selector: "[data-testid='inspector-panel']",
    phase: "polish",
    panel: "inspector",
    title: "Tune the current selection",
    copy: "The Inspector exposes schema-driven controls for the selected clip, layer, or project object.",
  },
  {
    id: "polish-agent",
    selector: "[data-testid='agent-panel']",
    phase: "polish",
    panel: "agent",
    title: "Keep generated work reviewable",
    copy: "Restyles, authored templates, and polish suggestions remain proposals with reasons, risk, and evidence.",
  },
  {
    id: "polish-graphics",
    selector: "[data-testid='graphics-panel']",
    phase: "polish",
    panel: "graphics",
    title: "Build reusable graphics",
    copy: "Place versioned templates, brand assets, and word-anchored motion without baking away editability.",
  },
  {
    id: "review-media",
    selector: "[data-testid='media-panel']",
    phase: "review",
    panel: "media",
    title: "Compare takes without losing options",
    copy: "Alternate takes remain available while delivery evidence helps you make the call.",
  },
  {
    id: "review-preview",
    selector: "[data-testid='preview-panel']",
    phase: "review",
    panel: "preview",
    title: "Annotate the evidence",
    copy: "Draw or pin feedback on a paused frame; anchors survive edits and travel with the context.",
  },
  {
    id: "review-agent",
    selector: "[data-testid='agent-panel']",
    phase: "review",
    panel: "agent",
    title: "Accept, reject, or revise",
    copy: "Every agent change lands here as a semantic diff. Rejection leaves the project byte-identical.",
  },
  {
    id: "publish-status",
    selector: "[data-testid='status-panel']",
    phase: "publish",
    panel: "status",
    title: "Watch deliverables become ready",
    copy: "Validation, export work, failures, and stale outputs stay visible before files leave the project.",
  },
  {
    id: "publish-publish",
    selector: "[data-testid='publish-panel']",
    phase: "publish",
    panel: "publish",
    title: "Package the release",
    copy: "Export video, subtitles, chapters, metadata, covers, and a hash-backed report from one deliverable surface.",
  },
] as const;

interface GuidedTourProps {
  onFinish: () => void;
  onStopChange: (stopId: string | null) => void;
}

interface TourRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

function measuredRect(element: Element): TourRect {
  const rect = element.getBoundingClientRect();
  return {
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
}

export function GuidedTour({
  onFinish,
  onStopChange,
}: GuidedTourProps): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<TourRect | null>(null);
  const stop = TOUR_STOPS[index]!;

  useEffect(() => {
    onStopChange(stop.id);
    if (stop.phase !== undefined) useWorkspaceStore.getState().setPhase(stop.phase);
    if (stop.panel !== undefined) {
      requestAnimationFrame(() => revealPanel(stop.panel!));
    }
    return () => onStopChange(null);
  }, [onStopChange, stop]);

  useLayoutEffect(() => {
    let frame = 0;
    let attempts = 0;
    let observer: ResizeObserver | undefined;
    const update = (): void => {
      const target = document.querySelector(stop.selector);
      if (target === null) {
        attempts += 1;
        if (attempts < 12) frame = requestAnimationFrame(update);
        return;
      }
      setRect(measuredRect(target));
      observer = new ResizeObserver(() => setRect(measuredRect(target)));
      observer.observe(target);
    };
    frame = requestAnimationFrame(update);
    const reposition = (): void => {
      const target = document.querySelector(stop.selector);
      if (target !== null) setRect(measuredRect(target));
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [stop]);

  const finish = (): void => {
    onStopChange(null);
    onFinish();
  };
  const advance = (): void => {
    if (index === TOUR_STOPS.length - 1) finish();
    else setIndex((current) => current + 1);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (!["Escape", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") finish();
      else if (event.key === "ArrowLeft") setIndex((current) => Math.max(0, current - 1));
      else advance();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });

  const cardWidth = 340;
  const cardTop = rect === null
    ? 110
    : rect.top + rect.height + 12 + 210 < window.innerHeight
      ? rect.top + rect.height + 12
      : Math.max(12, rect.top - 222);
  const cardLeft = rect === null
    ? 24
    : Math.max(12, Math.min(rect.left, window.innerWidth - cardWidth - 12));
  const targetStyle = rect === null ? undefined : {
    height: `${String(rect.height + 8)}px`,
    left: `${String(rect.left - 4)}px`,
    top: `${String(rect.top - 4)}px`,
    width: `${String(rect.width + 8)}px`,
  } satisfies CSSProperties;
  const cardStyle = {
    left: `${String(cardLeft)}px`,
    top: `${String(cardTop)}px`,
    width: `${String(cardWidth)}px`,
  } satisfies CSSProperties;

  return (
    <div className="tour-layer" aria-live="polite">
      {targetStyle === undefined ? null : (
        <div className="tour-target" style={targetStyle} aria-hidden="true" />
      )}
      <aside
        className="tour-stop"
        data-testid="tour-stop"
        data-tour-stop={stop.id}
        style={cardStyle}
        aria-label={`Guided tour: ${stop.title}`}
      >
        <div className="tour-rail" aria-hidden="true">
          <span style={{ width: `${String((index + 1) / TOUR_STOPS.length * 100)}%` }} />
        </div>
        <header>
          <span>Tour · {String(index + 1).padStart(2, "0")}/{String(TOUR_STOPS.length)}</span>
          <button type="button" aria-label="Skip tour" onClick={finish}>×</button>
        </header>
        <h2>{stop.title}</h2>
        <p>{stop.copy}</p>
        <footer>
          <button
            type="button"
            disabled={index === 0}
            onClick={() => setIndex((current) => Math.max(0, current - 1))}
          >Back</button>
          <button type="button" className="primary-action" onClick={advance}>
            {index === TOUR_STOPS.length - 1 ? "Finish" : "Next"}
          </button>
        </footer>
        <small>Esc skips · ← → or Enter advances</small>
      </aside>
    </div>
  );
}
