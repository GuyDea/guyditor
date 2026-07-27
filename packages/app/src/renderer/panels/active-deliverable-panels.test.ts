import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type {
  Annotation,
  Deliverable,
  GuyditorProject,
  Layer,
  Sequence,
} from "../../../../core/src/index.js";
import {
  validateProject,
} from "../../../../core/src/index.js";
import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import {
  useSelectionStore,
  useWorkspaceStore,
} from "../state/view-state.js";
import * as PreviewPanelModule from "./PreviewPanel.js";
import * as TimelinePanelModule from "./TimelinePanel.js";
import * as TranscriptPanelModule from "./TranscriptPanel.js";
import type { WorkspacePanelProps } from "./types.js";

interface PreviewPanelTestApi {
  previewOutputSize(
    project: GuyditorProject,
    deliverable: Deliverable | undefined,
    framingOutput?: { width: number; height: number },
  ): { width: number; height: number };
}

interface TimelinePanelTestApi {
  synchronizeTimelineScroll(
    viewport: { scrollLeft: number },
    scrollOffsetFrames: number,
    zoomPixelsPerFrame: number,
  ): void;
}

interface TranscriptPanelTestApi {
  transcriptNavigationRequest(
    wordId: string,
    deliverable: Deliverable | undefined,
  ): Record<string, unknown>;
  transcriptRangeOperation(
    kind: "remove" | "createClip",
    wordRange: { fromWord: string; toWord: string },
    deliverable: Deliverable | undefined,
    sequence: Sequence | undefined,
    layer: Layer | undefined,
  ): { op: string; params: Record<string, unknown> } | undefined;
}

const INITIAL_SELECTION = useSelectionStore.getInitialState();
const INITIAL_WORKSPACE = useWorkspaceStore.getInitialState();

function annotation(
  id: string,
  sequenceId: string,
  deliverableId: string,
  body: string,
  aspect: string,
): Annotation {
  return {
    id,
    shape: "note",
    body,
    geometry: null,
    anchor: {
      kind: "timeline",
      sequenceId,
      frame: { frames: 0, fps: "24/1" },
    },
    extent: { frames: 0, fps: "24/1" },
    canvasRef: { sequenceId, deliverableId, aspect },
    state: "open",
    blocking: false,
    author: { kind: "human", id: "creator" },
    createdAt: "2026-07-27T09:00:00Z",
    history: [],
  };
}

function projectWithShort(): GuyditorProject {
  const project = projectFixture();
  project.layers[0]!.pip = {
    style: { mask: { shape: "rounded" } },
    placement: {
      base: { anchor: "bottom_right", width: "24%", margin: "4%" },
    },
    keyframes: [],
  };
  project.sequences.push({
    id: "seq_bbbbbbbbbb",
    name: "short",
    clips: [{
      id: "clp_cccccccccc",
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: 12, fps: "24/1" },
        out: { frames: 24, fps: "24/1" },
      },
    }],
  });
  project.layers.push({
    id: "lyr_bbbbbbbbbb",
    kind: "video",
    name: "short video",
    order: 0,
    enabled: true,
    locked: false,
    sequence: "seq_bbbbbbbbbb",
  });
  project.captions.push({
    ...structuredClone(project.captions[0]!),
    id: "cts_bbbbbbbbbb",
    name: "short captions",
    sourceLayerIds: ["lyr_bbbbbbbbbb"],
  });
  project.deliverables.push({
    id: "dlv_bbbbbbbbbb",
    kind: "short",
    name: "Portrait short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: "seq_bbbbbbbbbb",
    captionsTrackId: "cts_bbbbbbbbbb",
    status: "draft",
  });
  return project;
}

function panelProps(project: GuyditorProject): WorkspacePanelProps {
  return {
    snapshot: {
      revision: project.revision,
      master: project,
      sidecarIndex: project.sidecars,
      projectPath: "/fixture",
    },
    transcripts: [],
    annotations: [
      annotation(
        "ann_aaaaaaaaaa",
        "seq_aaaaaaaaaa",
        "dlv_aaaaaaaaaa",
        "Primary annotation leak",
        "1920:1080",
      ),
      annotation(
        "ann_bbbbbbbbbb",
        "seq_bbbbbbbbbb",
        "dlv_bbbbbbbbbb",
        "Short annotation",
        "1080:1920",
      ),
    ],
    proposals: [],
    skills: [],
    pinnedSkills: [],
    skillDrafts: [],
    restylePlan: null,
    exportReport: null,
    refreshProject: () => Promise.resolve(),
    refreshAnnotations: () => Promise.resolve(),
    refreshProposals: () => Promise.resolve(),
    refreshSkills: () => Promise.resolve(),
    refreshRestylePlan: () => Promise.resolve(),
    refreshExportReport: () => Promise.resolve(),
    setNotice: () => undefined,
  };
}

afterEach(() => {
  INITIAL_SELECTION.selectedDeliverableId = null;
  INITIAL_SELECTION.selectedLayerId = null;
  useSelectionStore.setState(INITIAL_SELECTION);
  useWorkspaceStore.setState(INITIAL_WORKSPACE);
});

describe("active deliverable panels", () => {
  it("renders the same selected short in preview, timeline, and captions", () => {
    const project = projectWithShort();
    expect(validateProject(project).ok).toBe(true);
    useSelectionStore.setState({
      selectedDeliverableId: "dlv_bbbbbbbbbb",
      selectedLayerId: "lyr_aaaaaaaaaa",
    });
    // React's server renderer reads Zustand's initial snapshot.
    INITIAL_SELECTION.selectedDeliverableId = "dlv_bbbbbbbbbb";
    INITIAL_SELECTION.selectedLayerId = "lyr_aaaaaaaaaa";
    useWorkspaceStore.getState().setPhase("cut");
    useWorkspaceStore.getState().resetLayout();
    const props = panelProps(project);

    const preview = renderToStaticMarkup(
      createElement(PreviewPanelModule.PreviewPanel, props),
    );
    const timeline = renderToStaticMarkup(
      createElement(TimelinePanelModule.TimelinePanel, props),
    );
    const transcript = renderToStaticMarkup(
      createElement(TranscriptPanelModule.TranscriptPanel, props),
    );

    expect(preview).toContain('data-aspect="portrait"');
    expect(preview).toContain('data-active-clip="clp_cccccccccc"');
    expect(preview).toContain('type="range" min="0" max="11"');
    expect(preview).toContain('width="1080" height="1920"');
    expect(preview).toContain("Short annotation");
    expect(preview).not.toContain("Primary annotation leak");
    expect(preview).not.toContain('data-testid="pip-preview-canvas"');
    expect(timeline).toContain('data-testid="timeline-clip-clp_cccccccccc"');
    expect(timeline).not.toContain("timeline-clip-clp_aaaaaaaaaa");
    expect(timeline).toContain('data-testid="layer-select-lyr_bbbbbbbbbb"');
    expect(timeline).not.toContain("layer-select-lyr_aaaaaaaaaa");
    expect(transcript).toContain("cts_bbbbbbbbbb");
    expect(transcript).not.toContain("cts_aaaaaaaaaa");
  });

  it("keeps output geometry, scrolling, and transcript requests in the active sequence", () => {
    const project = projectWithShort();
    const deliverable = project.deliverables.find(
      ({ id }) => id === "dlv_bbbbbbbbbb",
    );
    const sequence = project.sequences.find(({ id }) => id === deliverable?.sequenceId);
    const layer = project.layers.find(({ sequence: id }) => id === sequence?.id);
    const previewApi = PreviewPanelModule as unknown as Partial<PreviewPanelTestApi>;
    const timelineApi = TimelinePanelModule as unknown as Partial<TimelinePanelTestApi>;
    const transcriptApi = TranscriptPanelModule as unknown as Partial<TranscriptPanelTestApi>;

    expect(typeof previewApi.previewOutputSize).toBe("function");
    expect(typeof timelineApi.synchronizeTimelineScroll).toBe("function");
    expect(typeof transcriptApi.transcriptNavigationRequest).toBe("function");
    expect(typeof transcriptApi.transcriptRangeOperation).toBe("function");
    if (
      previewApi.previewOutputSize === undefined ||
      timelineApi.synchronizeTimelineScroll === undefined ||
      transcriptApi.transcriptNavigationRequest === undefined ||
      transcriptApi.transcriptRangeOperation === undefined
    ) return;

    expect(previewApi.previewOutputSize(project, deliverable)).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(previewApi.previewOutputSize(project, deliverable, {
      width: 720,
      height: 1280,
    })).toEqual({ width: 720, height: 1280 });
    expect(previewApi.previewOutputSize(project, project.deliverables[0])).toEqual({
      width: 1920,
      height: 1080,
    });

    const viewport = { scrollLeft: 280 };
    timelineApi.synchronizeTimelineScroll(viewport, 0, 4);
    expect(viewport.scrollLeft).toBe(0);

    expect(transcriptApi.transcriptNavigationRequest("w000001", deliverable))
      .toEqual({
        target: { kind: "word", wordId: "w000001" },
        scope: "seq_bbbbbbbbbb",
      });
    const wordRange = { fromWord: "w000001", toWord: "w000002" };
    expect(transcriptApi.transcriptRangeOperation(
      "remove",
      wordRange,
      deliverable,
      sequence,
      layer,
    )).toEqual({
      op: "transcript.range.remove",
      params: {
        sequenceId: "seq_bbbbbbbbbb",
        wordRange,
        paddingMs: 0,
        snapPolicy: "none",
      },
    });
    expect(transcriptApi.transcriptRangeOperation(
      "createClip",
      wordRange,
      deliverable,
      sequence,
      layer,
    )).toEqual({
      op: "transcript.range.createClip",
      params: {
        wordRange,
        targetLayerId: "lyr_bbbbbbbbbb",
        targetIndex: 1,
      },
    });
    expect(transcriptApi.transcriptRangeOperation(
      "remove",
      wordRange,
      undefined,
      sequence,
      layer,
    )).toBeUndefined();
    expect(transcriptApi.transcriptRangeOperation(
      "remove",
      wordRange,
      deliverable,
      undefined,
      layer,
    )).toBeUndefined();
    expect(transcriptApi.transcriptRangeOperation(
      "createClip",
      wordRange,
      deliverable,
      sequence,
      undefined,
    )).toBeUndefined();
  });
});
