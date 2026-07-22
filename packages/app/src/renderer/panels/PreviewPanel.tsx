import { useCallback, useEffect, useRef, useState } from "react";

import { deriveTimeline } from "../../../../core/src/project/derive.js";
import { convertTimeRounding } from "../../../../core/src/time/index.js";
import type {
  Annotation,
  AnnotationGeometry,
  AnnotationShape,
  Clip,
  FrameTime,
  FramingRect,
  KeySettings,
} from "../../../../core/src/index.js";
import captionFontUrl from "../../../../render/assets/fonts/Inconsolata.otf?url";
import { paintCaptionFrame } from "../../../../render/src/caption-painter.js";
import type { CaptionPaintContext } from "../../../../render/src/caption-painter.js";
import type { CaptionFrameSpec } from "../../../../transcript/src/index.js";
import type { FramingPreviewSpec } from "../../../../render/src/index.js";
import { subjectTrackAvoidRegions } from "../../../../media/src/subject-avoidance.js";
import { ChromaPreviewCanvas } from "../chroma-preview.js";
import { pipPlaceOperation } from "../../../../compositor/src/pip-operation.js";
import { PipPreviewCanvas } from "../pip-preview.js";
import { cropVideoStyle, projectTrackBox } from "../vertical-framing.js";
import {
  createLoudnessMeter,
} from "../loudness-meter.js";
import type {
  LoudnessFrame,
  LoudnessMeterController,
  LoudnessTargetOverlay,
} from "../loudness-meter.js";
import {
  errorMessage,
  executeDirect,
} from "../ipc.js";
import {
  formatTimecode,
  frameCenterSeconds,
  nudgeFrameCenterSeconds,
} from "../preview-controller.js";
import { usePreviewStore, useSelectionStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import { LoudnessMeter } from "./LoudnessMeter.js";
import type { WorkspacePanelProps } from "./types.js";

interface ProxyResolution { path: string; url: string }

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const DRAWING_TOOLS: AnnotationShape[] = ["note", "pin", "rect", "ellipse", "arrow", "range"];
const EMPTY_LOUDNESS_FRAME: LoudnessFrame = {
  momentaryLufs: -Infinity,
  shortTermLufs: -Infinity,
  integratedLufs: null,
  truePeakDbtp: [],
};

function annotationId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return ["ann", [...bytes].map((value) => BASE32[value & 31]).join("")].join("_");
}

function framingOverrideId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `fov_${[...bytes].map((value) => BASE32[value & 31]).join("")}`;
}

function clampCrop(crop: FramingRect): FramingRect {
  const w = Math.max(0.01, Math.min(1, crop.w));
  const h = Math.max(0.01, Math.min(1, crop.h));
  return {
    x: Math.max(0, Math.min(1 - w, crop.x)),
    y: Math.max(0, Math.min(1 - h, crop.y)),
    w,
    h,
  };
}

function fpsNumber(fps: string): number {
  const [numerator = 1, denominator = 1] = fps.split("/").map(Number);
  return numerator / denominator;
}

function activeClip(
  snapshot: NonNullable<WorkspacePanelProps["snapshot"]>,
  frame: number,
): { clip: Clip; timelineStart: number; timelineDuration: number } | undefined {
  const deliverable = snapshot.master.deliverables.find(
    ({ id }) => id === snapshot.master.settings.primaryDeliverable,
  );
  const sequence = snapshot.master.sequences.find(({ id }) => id === deliverable?.sequenceId);
  if (sequence === undefined) return undefined;
  const derived = deriveTimeline(snapshot.master, sequence.id);
  if (!derived.ok) return undefined;
  const timed = derived.value.clips.find(({ start, duration }) =>
    frame >= start.frames && frame < start.frames + duration.frames);
  const clip = sequence.clips.find(({ id }) => id === timed?.clipId);
  return timed === undefined || clip === undefined
    ? undefined
    : { clip, timelineStart: timed.start.frames, timelineDuration: timed.duration.frames };
}

function totalFrames(snapshot: WorkspacePanelProps["snapshot"]): number {
  if (snapshot === null) return 0;
  const deliverable = snapshot.master.deliverables.find(
    ({ id }) => id === snapshot.master.settings.primaryDeliverable,
  );
  if (deliverable === undefined) return 0;
  const derived = deriveTimeline(snapshot.master, deliverable.sequenceId);
  if (!derived.ok) return 0;
  const [durationNumerator = 0, durationDenominator = 1] = derived.value.duration.split("/").map(Number);
  return Math.max(0, Math.round(
    durationNumerator / durationDenominator * fpsNumber(snapshot.master.settings.timeline.fps),
  ));
}

function sourceFrame(
  clip: Clip,
  timelineFrame: number,
  timelineStart: number,
  timelineFps: string,
): number {
  const relative = convertTimeRounding(
    { frames: timelineFrame - timelineStart, fps: timelineFps },
    clip.source.in.fps,
  );
  return clip.source.in.frames + (relative.ok ? relative.value.time.frames : 0);
}

function centerGeometry(shape: AnnotationShape): AnnotationGeometry | null {
  switch (shape) {
    case "note":
    case "range":
      return null;
    case "pin":
      return { kind: "pin", at: { x: 0.5, y: 0.5 } };
    case "rect":
      return { kind: "rect", origin: { x: 0.34, y: 0.34 }, size: { x: 0.32, y: 0.32 } };
    case "ellipse":
      return { kind: "ellipse", center: { x: 0.5, y: 0.5 }, radii: { x: 0.16, y: 0.13 } };
    case "arrow":
      return { kind: "arrow", from: { x: 0.32, y: 0.65 }, to: { x: 0.66, y: 0.35 } };
    case "freehand":
    case "spotlight":
      return null;
  }
}

function wordAtPosition(
  transcripts: WorkspacePanelProps["transcripts"],
  assetId: string | undefined,
  source: number | undefined,
  sourceFps: string | undefined,
): string {
  if (assetId === undefined || source === undefined || sourceFps === undefined) return "No word";
  const seconds = source / fpsNumber(sourceFps);
  const sidecar = transcripts.find((entry) => entry.assetId === assetId);
  if (sidecar === undefined) return "No transcript";
  const located = sidecar.segments.flatMap(({ words }) => words).find((wordId) => {
    const word = sidecar.words[wordId];
    return word !== undefined && word.state === "active" &&
      seconds >= word.start.samples / word.start.rate && seconds < word.end.samples / word.end.rate;
  });
  return located === undefined ? "Between words" : `${located} · ${sidecar.words[located]?.text ?? ""}`;
}

export function PreviewPanel({
  snapshot,
  transcripts,
  annotations,
  refreshAnnotations,
  refreshProject,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const loudnessControllerRef = useRef<LoudnessMeterController | null>(null);
  const loudnessFrameSinkRef = useRef<(frame: LoudnessFrame) => void>(() => undefined);
  const captionCanvasRef = useRef<HTMLCanvasElement>(null);
  const [proxy, setProxy] = useState<ProxyResolution | null>(null);
  const [captionFrame, setCaptionFrame] = useState<CaptionFrameSpec | null>(null);
  const [framingFrame, setFramingFrame] = useState<FramingPreviewSpec | null>(null);
  const [cropDraft, setCropDraft] = useState<FramingRect | null>(null);
  const [graphicsFrame, setGraphicsFrame] = useState<string | null>(null);
  const [captionFontReady, setCaptionFontReady] = useState(false);
  const [tool, setTool] = useState<AnnotationShape>("pin");
  const [body, setBody] = useState("");
  const [context, setContext] = useState<unknown>(null);
  const [chromaAvailable, setChromaAvailable] = useState(true);
  const [pipAnchorFrames, setPipAnchorFrames] = useState<Record<string, number>>({});
  const [loudnessFrame, setLoudnessFrame] = useState<LoudnessFrame>(EMPTY_LOUDNESS_FRAME);
  const [loudnessAvailable, setLoudnessAvailable] = useState(true);
  const playhead = usePreviewStore((state) => state.playhead);
  const playing = usePreviewStore((state) => state.playing);
  const settled = usePreviewStore((state) => state.settled);
  const warning = usePreviewStore((state) => state.warning);
  const setPlayhead = usePreviewStore((state) => state.setPlayhead);
  const setPlaying = usePreviewStore((state) => state.setPlaying);
  const setSettled = usePreviewStore((state) => state.setSettled);
  const setWarning = usePreviewStore((state) => state.setWarning);
  const diagnosticBackground = usePreviewStore((state) => state.diagnosticBackground);
  const previewKeySettings = usePreviewStore((state) => state.previewKeySettings);
  const selectAnnotation = useSelectionStore((state) => state.selectAnnotation);
  const selectWord = useSelectionStore((state) => state.selectWord);
  const selectedLayerId = useSelectionStore((state) => state.selectedLayerId);
  const fps = snapshot?.master.settings.timeline.fps ?? playhead.fps;
  const duration = totalFrames(snapshot);
  const active = snapshot === null ? undefined : activeClip(snapshot, playhead.frames);
  const currentSourceFrame = active === undefined
    ? undefined
    : sourceFrame(active.clip, playhead.frames, active.timelineStart, fps);
  const deliverable = snapshot?.master.deliverables.find(
    ({ id }) => id === snapshot.master.settings.primaryDeliverable,
  );
  const vertical = deliverable?.kind === "short";
  const persistedKeySettings = active?.clip.effects?.find(({ kind }) => kind === "key")
    ?.params as unknown as KeySettings | undefined;
  const keySettings = previewKeySettings ?? persistedKeySettings ?? null;
  const keyPreviewActive = keySettings?.mode === "chroma" && chromaAvailable;
  const selectedPipLayer = snapshot?.master.layers.find((candidate) =>
    candidate.id === selectedLayerId && candidate.pip !== undefined);
  const selectedPip = selectedPipLayer?.pip;
  const sequence = snapshot?.master.sequences.find(({ id }) => id === deliverable?.sequenceId);
  const loudnessTarget: LoudnessTargetOverlay = {
    integratedLufs: sequence?.audio?.targetLufs ?? -14,
    toleranceLu: 1,
    truePeakDbtp: sequence?.audio?.truePeakDb ?? -1,
    profileId: "sequence-master",
  };
  const previewCrop = cropDraft ?? framingFrame?.crop;
  const projectedTrackBoxes = framingFrame === null || previewCrop === undefined
    ? []
    : framingFrame.boxes.map((box) => ({ box, rect: projectTrackBox(box, previewCrop) }))
      .filter(({ rect }) => rect.x + rect.w > 0 && rect.x < 1 && rect.y + rect.h > 0 && rect.y < 1);
  const trackedAvoidRegions = framingFrame === null
    ? []
    : subjectTrackAvoidRegions(
        previewCrop === undefined
          ? framingFrame.boxes
          : projectedTrackBoxes.map(({ box, rect }) => ({ ...box, ...rect })),
        playhead.frames,
      );
  loudnessFrameSinkRef.current = setLoudnessFrame;

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    let cancelled = false;
    void createLoudnessMeter(video, (frame) => loudnessFrameSinkRef.current(frame))
      .then((controller) => {
        if (cancelled) void controller.dispose();
        else loudnessControllerRef.current = controller;
      })
      .catch(() => {
        if (!cancelled) setLoudnessAvailable(false);
      });
    return () => {
      cancelled = true;
      const controller = loudnessControllerRef.current;
      loudnessControllerRef.current = null;
      if (controller !== null) void controller.dispose();
    };
  }, []);

  useEffect(() => {
    let current = true;
    if (snapshot === null || selectedPip === undefined || deliverable === undefined) {
      setPipAnchorFrames({});
      return () => { current = false; };
    }
    void Promise.all(selectedPip.keyframes.map(async ({ at }) => {
      const resolution = await window.guyditor.call<{
        status: "resolved" | "orphaned";
        timeline?: FrameTime;
      }>("OperationEngine", "resolveAnchor", {
        anchor: at,
        scope: deliverable.sequenceId,
      });
      return resolution.status === "resolved" && resolution.timeline !== undefined
        ? [at, resolution.timeline.frames] as const
        : undefined;
    })).then((entries) => {
      if (current) setPipAnchorFrames(Object.fromEntries(entries.filter((entry) => entry !== undefined)));
    });
    return () => { current = false; };
  }, [deliverable, selectedPip, snapshot]);
  const handleChromaReady = useCallback((): void => setChromaAvailable(true), []);
  const handleChromaUnavailable = useCallback((message: string): void => {
    setChromaAvailable(false);
    setWarning(message);
  }, [setWarning]);

  useEffect(() => {
    setChromaAvailable(true);
  }, [keySettings]);

  useEffect(() => {
    const sample = (): void => {
      const video = videoRef.current;
      if (video === null || playing || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        const error = "Pause on a settled presenter frame before sampling the key color.";
        setNotice(error);
        window.dispatchEvent(new CustomEvent("guyditor:key-eyedropper-result", { detail: { error } }));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, video.videoWidth);
      canvas.height = Math.max(1, video.videoHeight);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return;
      context.drawImage(video, 0, 0);
      const pixel = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      const color = `#${[pixel[0], pixel[1], pixel[2]].map((channel) =>
        channel!.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
      window.dispatchEvent(new CustomEvent("guyditor:key-eyedropper-result", { detail: { color } }));
    };
    window.addEventListener("guyditor:key-eyedropper-request", sample);
    return () => window.removeEventListener("guyditor:key-eyedropper-request", sample);
  }, [playing, setNotice]);

  useEffect(() => {
    let current = true;
    const face = new FontFace("Inconsolata Guyditor", `url(${captionFontUrl})`);
    void face.load().then((loaded) => {
      if (!current) return;
      document.fonts.add(loaded);
      setCaptionFontReady(true);
    }).catch(() => {
      if (current) setCaptionFontReady(false);
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    if (snapshot === null || deliverable === undefined) {
      setCaptionFrame(null);
      return () => { current = false; };
    }
    void window.guyditor.call<CaptionFrameSpec>("RenderService", "captionFrame", {
      deliverableId: deliverable.id,
      revision: snapshot.revision,
      frame: playhead.frames,
    }).then((frame) => {
      if (current) setCaptionFrame(frame);
    }).catch((error: unknown) => {
      if (current) {
        setCaptionFrame(null);
        setNotice(errorMessage(error));
      }
    });
    return () => { current = false; };
  }, [deliverable?.id, playhead.frames, setNotice, snapshot?.revision]);

  useEffect(() => {
    let current = true;
    if (snapshot === null || deliverable === undefined || !vertical) {
      setFramingFrame(null);
      return () => { current = false; };
    }
    void window.guyditor.call<FramingPreviewSpec | null>("RenderService", "framingFrame", {
      deliverableId: deliverable.id,
      revision: snapshot.revision,
      frame: playhead.frames,
    }).then((frame) => {
      if (current) setFramingFrame(frame);
    }).catch((error: unknown) => {
      if (current) {
        setFramingFrame(null);
        setNotice(errorMessage(error));
      }
    });
    return () => { current = false; };
  }, [deliverable?.id, playhead.frames, setNotice, snapshot?.revision, vertical]);

  useEffect(() => {
    setCropDraft(framingFrame?.crop === undefined ? null : { ...framingFrame.crop });
  }, [framingFrame?.crop, framingFrame?.decisionId]);

  useEffect(() => {
    let current = true;
    if (snapshot === null || deliverable === undefined) {
      setGraphicsFrame(null);
      return () => { current = false; };
    }
    void window.guyditor.call<{ dataUrl: string }>("RenderService", "graphicsFrame", {
      deliverableId: deliverable.id,
      revision: snapshot.revision,
      frame: playhead.frames,
    }).then(({ dataUrl }) => {
      if (current) setGraphicsFrame(dataUrl);
    }).catch((error: unknown) => {
      if (current) {
        setGraphicsFrame(null);
        setNotice(errorMessage(error));
      }
    });
    return () => { current = false; };
  }, [deliverable?.id, playhead.frames, setNotice, snapshot?.revision]);

  useEffect(() => {
    const canvas = captionCanvasRef.current;
    if (canvas === null || snapshot === null) return;
    const width = framingFrame?.output.width ?? snapshot.master.settings.timeline.width;
    const height = framingFrame?.output.height ?? snapshot.master.settings.timeline.height;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.clearRect(0, 0, width, height);
    if (captionFrame !== null && captionFontReady) {
      paintCaptionFrame(
        context as unknown as CaptionPaintContext,
        captionFrame,
        width,
        height,
      );
    }
  }, [captionFontReady, captionFrame, framingFrame?.output.height, framingFrame?.output.width, snapshot]);

  useEffect(() => {
    let current = true;
    setProxy(null);
    if (active === undefined) return () => { current = false; };
    void window.guyditor.call<ProxyResolution | null>("MediaEngine", "resolveProxy", {
      assetId: active.clip.asset,
    }).then((resolved) => {
      if (current) setProxy(resolved);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [active?.clip.asset]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || proxy === null || active === undefined || currentSourceFrame === undefined) return;
    let attempts = 0;
    let cancelled = false;
    setSettled(false);
    setWarning(null);
    const seek = (target: number): void => {
      video.currentTime = target;
    };
    const verify = (): void => {
      if (cancelled) return;
      if (typeof video.requestVideoFrameCallback !== "function") {
        setSettled(true);
        setWarning("Frame presented; exact rVFC verification is unavailable.");
        return;
      }
      video.requestVideoFrameCallback((_now, metadata) => {
        if (cancelled) return;
        const presented = Math.round(metadata.mediaTime * fpsNumber(active.clip.source.in.fps));
        if (presented === currentSourceFrame) {
          setSettled(true);
          return;
        }
        attempts += 1;
        if (attempts >= 3) {
          setSettled(true);
          setWarning("E_SEEK_UNVERIFIED · regenerate this asset proxy");
          return;
        }
        seek(nudgeFrameCenterSeconds(
          currentSourceFrame,
          active.clip.source.in.fps,
          presented < currentSourceFrame ? "later" : "earlier",
        ));
      });
    };
    video.addEventListener("seeked", verify);
    seek(frameCenterSeconds(currentSourceFrame, active.clip.source.in.fps));
    return () => {
      cancelled = true;
      video.removeEventListener("seeked", verify);
    };
  }, [active?.clip.id, currentSourceFrame, proxy?.url, setSettled, setWarning]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || proxy === null) return;
    if (playing) void video.play().catch(() => setPlaying(false));
    else video.pause();
  }, [playing, proxy, setPlaying]);

  async function createAnnotation(): Promise<void> {
    if (snapshot === null || playing || !settled) return;
    const deliverable = snapshot.master.deliverables.find(
      ({ id }) => id === snapshot.master.settings.primaryDeliverable,
    );
    const sequenceId = deliverable?.sequenceId ?? snapshot.master.sequences[0]?.id;
    if (sequenceId === undefined) return;
    const annotation: Annotation = {
      id: annotationId(),
      shape: tool,
      body: body.trim() || (tool === "note" ? "Review this frame" : `${tool} annotation`),
      ...(tool === "note" || tool === "range"
        ? {}
        : { style: { color: "#f2b84b", strokeWidth: 0.004 } }),
      geometry: centerGeometry(tool),
      anchor: { kind: "timeline", sequenceId, frame: { frames: playhead.frames, fps } },
      extent: { frames: tool === "range" ? Math.max(1, Math.round(fpsNumber(fps))) : 0, fps },
      canvasRef: {
        sequenceId,
        ...(deliverable === undefined ? {} : { deliverableId: deliverable.id }),
        aspect: `${String(snapshot.master.settings.timeline.width)}:${String(snapshot.master.settings.timeline.height)}`,
      },
      state: "open",
      blocking: false,
      author: { kind: "human", id: "creator" },
      createdAt: new Date().toISOString(),
      history: [],
    };
    try {
      await executeDirect([{ op: "annotation.create", params: { annotation } }], `Add ${tool} annotation`);
      setBody("");
      selectAnnotation(annotation.id);
      await refreshAnnotations();
      setNotice(`Added annotation ${annotation.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function saveShotCrop(): Promise<void> {
    if (
      snapshot === null || deliverable === undefined || active === undefined ||
      framingFrame === null || cropDraft === null
    ) return;
    try {
      await executeDirect([{
        op: "deliverable.framing.override",
        params: {
          deliverableId: deliverable.id,
          override: {
            id: framingOverrideId(),
            decisionId: framingFrame.decisionId,
            crop: {
              keyframes: [{
                at: { frames: framingFrame.sourceFrame, fps: active.clip.source.in.fps },
                rect: clampCrop(cropDraft),
              }],
            },
            note: "Manual shot crop from the vertical preview",
          },
        },
      }], `Correct ${framingFrame.decisionId} crop`);
      await refreshProject();
      setNotice(`Saved the manual crop for ${framingFrame.decisionId}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function lifecycle(annotation: Annotation, action: "resolve" | "reject" | "reopen"): Promise<void> {
    try {
      await executeDirect([{
        op: `annotation.${action}`,
        params: { annotationId: annotation.id, reason: `${action} from preview` },
      }], `${action} ${annotation.id}`);
      await refreshAnnotations();
      setNotice(`${action}d annotation ${annotation.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function showContext(annotation: Annotation): Promise<void> {
    try {
      const result = await window.guyditor.call<unknown>("AnnotationService", "contextPackage", {
        annotationId: annotation.id,
      });
      setContext(result);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <Panel
      id="preview"
      title="Preview"
      eyebrow="Proxy / settled frame"
      actions={<span className="quality-badge" data-testid="preview-quality">PROXY</span>}
    >
      <div
        className="preview-surface"
        data-testid="preview-surface"
        data-aspect={vertical ? "portrait" : "landscape"}
        data-framing-mode={framingFrame?.mode ?? "none"}
        data-settled={settled}
        data-diagnostic={diagnosticBackground}
      >
        {keyPreviewActive ? <div className="diagnostic-backdrop" aria-hidden="true" /> : null}
        <video
          ref={videoRef}
          className="preview-video-source"
          data-keyed={keyPreviewActive}
          data-empty={proxy === null}
          data-framed={vertical && previewCrop !== undefined}
          src={proxy?.url}
          style={vertical && previewCrop !== undefined
            ? { position: "absolute", maxWidth: "none", objectFit: "fill", ...cropVideoStyle(previewCrop) }
            : undefined}
          playsInline
          data-testid="preview-video"
          onTimeUpdate={(event) => {
            if (!playing || active === undefined) return;
            const timelineRate = fpsNumber(fps);
            const sourceRate = fpsNumber(active.clip.source.in.fps);
            const relative = Math.round(
              (event.currentTarget.currentTime - active.clip.source.in.frames / sourceRate) * timelineRate,
            );
            setPlayhead({
              frames: Math.max(0, Math.min(duration - 1, active.timelineStart + relative)),
              fps,
            });
          }}
          onEnded={() => setPlayhead({ frames: Math.min(duration - 1, playhead.frames + 1), fps })}
        />
        {proxy === null ? (
          <div className="black-frame"><span>{active === undefined ? "GAP" : "PROXY PENDING"}</span></div>
        ) : null}
        {vertical && framingFrame !== null ? (
          <div className="framing-overlay" data-testid="vertical-framing-overlay">
            <div
              className="framing-safe-area"
              aria-label="Caption title-safe area"
              style={{
                top: `${String(framingFrame.safeArea.top * 100)}%`,
                right: `${String(framingFrame.safeArea.right * 100)}%`,
                bottom: `${String(framingFrame.safeArea.bottom * 100)}%`,
                left: `${String(framingFrame.safeArea.left * 100)}%`,
              }}
            />
            {projectedTrackBoxes.map(({ box, rect }) => (
              <span
                key={box.trackId}
                className="framing-subject-box"
                data-kind={box.kind}
                title={`${box.kind} · ${box.trackId} · ${String(Math.round(box.conf * 100))}%`}
                style={{
                  left: `${String(rect.x * 100)}%`,
                  top: `${String(rect.y * 100)}%`,
                  width: `${String(rect.w * 100)}%`,
                  height: `${String(rect.h * 100)}%`,
                }}
              />
            ))}
            <div className="framing-source-map" aria-label="Source crop and subject track">
              {framingFrame.boxes.map((box) => (
                <span
                  key={box.trackId}
                  className="framing-source-subject"
                  data-kind={box.kind}
                  style={{
                    left: `${String(box.x * 100)}%`,
                    top: `${String(box.y * 100)}%`,
                    width: `${String(box.w * 100)}%`,
                    height: `${String(box.h * 100)}%`,
                  }}
                />
              ))}
              {previewCrop === undefined ? null : (
                <span
                  className="framing-source-crop"
                  data-testid="framing-crop-box"
                  style={{
                    left: `${String(previewCrop.x * 100)}%`,
                    top: `${String(previewCrop.y * 100)}%`,
                    width: `${String(previewCrop.w * 100)}%`,
                    height: `${String(previewCrop.h * 100)}%`,
                  }}
                />
              )}
              <b>{framingFrame.mode === "crop" ? "source gate" : "layer map"}</b>
            </div>
          </div>
        ) : null}
        <ChromaPreviewCanvas
          videoRef={videoRef}
          settings={keySettings}
          onReady={handleChromaReady}
          onUnavailable={handleChromaUnavailable}
        />
        {selectedPipLayer === undefined || selectedPip === undefined || snapshot === null ? null : (
          <PipPreviewCanvas
            videoRef={videoRef}
            pip={selectedPip}
            avoidRegions={[...(snapshot.master.avoidRegions ?? []), ...trackedAvoidRegions]}
            frame={playhead.frames}
            anchorFrames={pipAnchorFrames}
            composition={{
              width: framingFrame?.output.width ?? snapshot.master.settings.timeline.width,
              height: framingFrame?.output.height ?? snapshot.master.settings.timeline.height,
            }}
            onPlace={async (placement) => {
              try {
                await executeDirect(
                  [pipPlaceOperation(selectedPipLayer.id, placement)],
                  `Drag ${selectedPipLayer.name} PiP`,
                );
                await refreshProject();
                setNotice(`Placed ${selectedPipLayer.name} with semantic constraints.`);
              } catch (error: unknown) {
                setNotice(errorMessage(error));
              }
            }}
          />
        )}
        {graphicsFrame === null ? null : (
          <img
            className="graphic-overlay"
            src={graphicsFrame}
            alt=""
            data-testid="preview-graphic-overlay"
          />
        )}
        <canvas
          ref={captionCanvasRef}
          className="caption-overlay"
          data-testid="preview-caption-overlay"
          data-relayout={vertical ? "short" : "canonical"}
          aria-label="Caption overlay"
          onClick={(event) => {
            if (captionFrame === null) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - bounds.left) / bounds.width;
            const y = (event.clientY - bounds.top) / bounds.height;
            const word = captionFrame.cues.flatMap(({ lines }) =>
              lines.flatMap(({ words }) => words)).find(({ box }) =>
                x >= box.x && x <= box.x + box.w &&
                y >= box.y && y <= box.y + box.h);
            if (word !== undefined) selectWord(word.wordId);
          }}
        />
        <svg
          className="annotation-overlay"
          viewBox={vertical ? "0 0 100 177.7778" : "0 0 100 56.25"}
          aria-label="Annotation overlay"
        >
          {annotations.filter(({ state }) => state === "open" || state === "reopened").map((annotation) => (
            <AnnotationMark key={annotation.id} annotation={annotation} />
          ))}
        </svg>
        <div className="settled-badge" data-state={warning === null ? (settled ? "done" : "running") : "warning"}>
          {warning ?? (settled ? "settled" : "seeking")}
        </div>
      </div>
      {vertical ? (
        <section className="framing-controls" data-testid="framing-controls" aria-label="Shot framing controls">
          <header>
            <strong>{framingFrame?.decisionId ?? "Framing pending"}</strong>
            <span data-mode={framingFrame?.mode ?? "pending"}>
              {framingFrame?.mode ?? "pending"}
              {framingFrame === null ? "" : framingFrame.overridden ? " · manual" : " · automatic"}
            </span>
          </header>
          {cropDraft === null ? (
            <p>Separate layers are recomposed against the portrait safe areas.</p>
          ) : (
            <div className="framing-crop-controls">
              {(["x", "y", "w", "h"] as const).map((key) => (
                <label key={key}>
                  {key}
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.001"
                    value={cropDraft[key]}
                    aria-label={`Crop ${key}`}
                    onChange={(event) => setCropDraft(clampCrop({
                      ...cropDraft,
                      [key]: event.target.valueAsNumber || 0,
                    }))}
                  />
                </label>
              ))}
              <button
                type="button"
                data-testid="save-shot-crop"
                disabled={framingFrame === null || active === undefined}
                onClick={() => void saveShotCrop()}
              >
                Save shot crop
              </button>
            </div>
          )}
          {framingFrame?.warnings.map((message) => <small key={message}>{message}</small>)}
        </section>
      ) : null}
      <div className="transport">
        <button
          type="button"
          data-testid="preview-play-toggle"
          onClick={() => {
            if (!playing) void loudnessControllerRef.current?.resume();
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min="0"
          max={Math.max(0, duration - 1)}
          value={Math.min(playhead.frames, Math.max(0, duration - 1))}
          data-testid="preview-scrubber"
          aria-label="Timeline frame"
          onChange={(event) => setPlayhead({ frames: event.target.valueAsNumber, fps })}
        />
        <input
          className="frame-input"
          type="number"
          min="0"
          max={Math.max(0, duration - 1)}
          value={playhead.frames}
          data-testid="preview-frame-input"
          aria-label="Playhead frame"
          onChange={(event) => setPlayhead({
            frames: Math.max(0, Math.min(Math.max(0, duration - 1), event.target.valueAsNumber || 0)),
            fps,
          })}
        />
        <output className="timecode" data-testid="preview-timecode" title={`{ frames: ${String(playhead.frames)}, fps: ${fps} }`}>
          {formatTimecode(playhead.frames, fps)}
        </output>
      </div>
      <LoudnessMeter
        available={loudnessAvailable}
        frame={loudnessFrame}
        target={loudnessTarget}
        onReset={() => {
          loudnessControllerRef.current?.reset();
          setLoudnessFrame(EMPTY_LOUDNESS_FRAME);
        }}
      />
      <div className="word-position" data-testid="preview-word-position">
        {wordAtPosition(transcripts, active?.clip.asset, currentSourceFrame, active?.clip.source.in.fps)}
      </div>
      <div className="annotation-tools" role="toolbar" aria-label="Annotation tools">
        {DRAWING_TOOLS.map((shape) => (
          <button
            key={shape}
            type="button"
            data-active={tool === shape}
            data-testid={`annotation-tool-${shape}`}
            onClick={() => setTool(shape)}
          >
            {shape}
          </button>
        ))}
      </div>
      <div className="annotation-compose">
        <input
          type="text"
          value={body}
          placeholder="Annotation note"
          data-testid="annotation-body"
          aria-label="Annotation note"
          onChange={(event) => setBody(event.target.value)}
        />
        <button
          type="button"
          data-testid="annotation-create-center"
          disabled={playing || !settled || snapshot === null}
          onClick={() => void createAnnotation()}
        >
          Add at center
        </button>
      </div>
      <ol className="annotation-list" data-testid="annotation-list">
        {annotations.map((annotation, index) => (
          <li key={annotation.id} data-testid={`annotation-${annotation.id}`}>
            <button
              type="button"
              className="annotation-jump"
              data-testid={`annotation-seek-${annotation.id}`}
              onClick={() => {
                selectAnnotation(annotation.id);
                void window.guyditor.call<{ frame: FrameTime }>("OperationEngine", "resolveNavigation", {
                  target: { kind: "annotation", annotationId: annotation.id },
                }).then(({ frame }) => setPlayhead(frame)).catch((error: unknown) => setNotice(errorMessage(error)));
              }}
            >
              <strong>{annotation.body || annotation.shape}</strong>
              <span>{annotation.state}</span>
            </button>
            <div className="row-actions">
              {(annotation.state === "open" || annotation.state === "reopened") ? (
                <>
                  <button
                    type="button"
                    data-testid={index === 0 ? "annotation-resolve-first" : `annotation-resolve-${annotation.id}`}
                    onClick={() => void lifecycle(annotation, "resolve")}
                  >Resolve</button>
                  <button type="button" data-testid={`annotation-reject-${annotation.id}`} onClick={() => void lifecycle(annotation, "reject")}>Reject</button>
                </>
              ) : (
                <button type="button" data-testid={`annotation-reopen-${annotation.id}`} onClick={() => void lifecycle(annotation, "reopen")}>Reopen</button>
              )}
              <button type="button" data-testid={`annotation-context-${annotation.id}`} onClick={() => void showContext(annotation)}>Context</button>
            </div>
          </li>
        ))}
        {annotations.length === 0 ? <li className="empty-copy">No annotations.</li> : null}
      </ol>
      {context === null ? null : <pre className="context-json" data-testid="annotation-context-json">{JSON.stringify(context, null, 2)}</pre>}
      <small className="m2-note">Proxy playback uses the normative BT.709 chroma-distance formula in WebGL; HQ diagnostics use the FFmpeg render path.</small>
    </Panel>
  );
}

function AnnotationMark({ annotation }: { annotation: Annotation }): React.JSX.Element | null {
  const geometry = annotation.geometry;
  if (geometry === null) return null;
  if (geometry.kind === "pin") {
    return <circle cx={geometry.at.x * 100} cy={geometry.at.y * 56.25} r="1.4" />;
  }
  if (geometry.kind === "rect") {
    return <rect x={geometry.origin.x * 100} y={geometry.origin.y * 56.25} width={geometry.size.x * 100} height={geometry.size.y * 56.25} />;
  }
  if (geometry.kind === "ellipse") {
    return <ellipse cx={geometry.center.x * 100} cy={geometry.center.y * 56.25} rx={geometry.radii.x * 100} ry={geometry.radii.y * 56.25} />;
  }
  if (geometry.kind === "arrow") {
    return <line x1={geometry.from.x * 100} y1={geometry.from.y * 56.25} x2={geometry.to.x * 100} y2={geometry.to.y * 56.25} />;
  }
  return null;
}
