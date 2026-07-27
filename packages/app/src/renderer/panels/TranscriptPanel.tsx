import { useMemo, useState } from "react";

import type {
  Deliverable,
  FrameTime,
  Layer,
  Sequence,
} from "../../../../core/src/index.js";
import type { CaptionFrameSpec, TranscriptWord } from "../../../../transcript/src/index.js";
import type { JobStatus } from "../../shared/ipc.js";
import { resolveActiveDeliverable } from "../active-deliverable.js";
import { errorMessage, executeDirect } from "../ipc.js";
import { usePreviewStore, useSelectionStore, useTranscriptViewStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

interface DisplayWord {
  id: string;
  assetId: string;
  speaker: string;
  word: TranscriptWord;
}

function displayWords(transcripts: WorkspacePanelProps["transcripts"]): DisplayWord[] {
  return transcripts.flatMap((sidecar) => sidecar.segments.flatMap((segment) =>
    segment.words.flatMap((id) => {
      const word = sidecar.words[id];
      return word === undefined || word.state !== "active"
        ? []
        : [{ id, assetId: sidecar.assetId, speaker: segment.speaker, word }];
    })));
}

type WordRange = { fromWord: string; toWord: string };

export function transcriptNavigationRequest(
  wordId: string,
  deliverable: Deliverable | undefined,
): Record<string, unknown> {
  return {
    target: { kind: "word", wordId },
    ...(deliverable === undefined ? {} : { scope: deliverable.sequenceId }),
  };
}

export function transcriptRangeOperation(
  kind: "remove" | "createClip",
  wordRange: WordRange,
  deliverable: Deliverable | undefined,
  sequence: Sequence | undefined,
  layer: Layer | undefined,
): { op: string; params: Record<string, unknown> } | undefined {
  if (
    deliverable === undefined ||
    sequence === undefined ||
    sequence.id !== deliverable.sequenceId
  ) return undefined;
  if (kind === "remove") {
    return {
      op: "transcript.range.remove",
      params: {
        sequenceId: deliverable.sequenceId,
        wordRange,
        paddingMs: 0,
        snapPolicy: "none",
      },
    };
  }
  return layer === undefined || layer.sequence !== sequence.id
    ? undefined
    : {
        op: "transcript.range.createClip",
        params: {
          wordRange,
          targetLayerId: layer.id,
          targetIndex: sequence.clips.length,
        },
      };
}

export function TranscriptPanel({
  snapshot,
  transcripts,
  refreshProject,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const allWords = useMemo(() => displayWords(transcripts), [transcripts]);
  const selectedDeliverableId = useSelectionStore(
    (state) => state.selectedDeliverableId,
  );
  const selectedWordId = useSelectionStore((state) => state.selectedWordId);
  const wordRange = useSelectionStore((state) => state.wordRange);
  const selectWord = useSelectionStore((state) => state.selectWord);
  const setWordRange = useSelectionStore((state) => state.setWordRange);
  const setPlayhead = usePreviewStore((state) => state.setPlayhead);
  const scrollTop = useTranscriptViewStore((state) => state.scrollTop);
  const setScrollTop = useTranscriptViewStore((state) => state.setScrollTop);
  const correctionDraft = useTranscriptViewStore((state) => state.correctionDraft);
  const setCorrectionDraft = useTranscriptViewStore((state) => state.setCorrectionDraft);
  const [editing, setEditing] = useState(false);
  const [startNudge, setStartNudge] = useState(0);
  const [endNudge, setEndNudge] = useState(0);
  const estimatedWordsPerRow = 8;
  const first = Math.max(0, Math.floor(scrollTop / 28) * estimatedWordsPerRow - 160);
  const visible = allWords.slice(first, first + 720);
  const selected = allWords.find(({ id }) => id === selectedWordId);
  const deliverable = snapshot === null
    ? undefined
    : resolveActiveDeliverable(snapshot.master, selectedDeliverableId);
  const captionTrack = snapshot?.master.captions.find(
    ({ id }) => id === deliverable?.captionsTrackId,
  );
  const sequence = snapshot?.master.sequences.find(
    ({ id }) => id === deliverable?.sequenceId,
  );
  const layer = snapshot?.master.layers.find(
    ({ sequence: sequenceId }) => sequenceId === sequence?.id,
  );
  const captionPresets = snapshot?.master.presets.filter(({ kind }) => kind === "caption") ?? [];
  const selectedBreak = captionTrack?.breakOverrides.find(
    ({ afterWordId }) => afterWordId === selectedWordId,
  );
  const selectedEmphasis = captionTrack?.emphasisOverrides.find(
    ({ wordId }) => wordId === selectedWordId,
  )?.emphasis ?? false;

  async function applyCaptionOperation(
    operation: { op: string; params: Record<string, unknown> },
    label: string,
  ): Promise<void> {
    try {
      await executeDirect([operation], label);
      await refreshProject();
      setNotice(`${label}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function setStyle(styleOverrides: Record<string, unknown>): Promise<void> {
    if (captionTrack === undefined) return;
    await applyCaptionOperation({
      op: "caption.style.set",
      params: { captionId: captionTrack.id, styleOverrides },
    }, "Updated caption style");
  }

  async function retimeCaption(clear = false): Promise<void> {
    if (snapshot === null || deliverable === undefined || captionTrack === undefined || selectedWordId === null) return;
    try {
      const playhead = usePreviewStore.getState().playhead;
      const frame = await window.guyditor.call<CaptionFrameSpec>("RenderService", "captionFrame", {
        deliverableId: deliverable.id,
        revision: snapshot.revision,
        frame: playhead.frames,
      });
      const cue = frame.cues.find(({ lines }) => lines.some(({ words }) =>
        words.some(({ wordId }) => wordId === selectedWordId)));
      const firstWordId = cue?.firstWordId;
      if (firstWordId === undefined) {
        setNotice(`${selectedWordId} is not in the caption cue at the current frame.`);
        return;
      }
      await applyCaptionOperation({
        op: "caption.cue.retime",
        params: clear
          ? { captionId: captionTrack.id, firstWordId, clear: true }
          : { captionId: captionTrack.id, firstWordId, startMs: startNudge, endMs: endNudge },
      }, clear ? `Cleared timing nudge for ${firstWordId}` : `Nudged cue ${firstWordId}`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function select(id: string, extend: boolean): Promise<void> {
    selectWord(id);
    if (extend && wordRange !== null) setWordRange({ ...wordRange, toWord: id });
    else setWordRange({ fromWord: id, toWord: id });
    const word = allWords.find((entry) => entry.id === id);
    setCorrectionDraft(word === undefined
      ? ""
      : `${word.word.punctBefore}${word.word.text}${word.word.punctAfter}`);
    try {
      const position = await window.guyditor.call<{ frame: FrameTime }>(
        "OperationEngine",
        "resolveNavigation",
        transcriptNavigationRequest(id, deliverable),
      );
      setPlayhead(position.frame);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function rangeOperation(kind: "remove" | "createClip"): Promise<void> {
    if (wordRange === null) return;
    const operation = transcriptRangeOperation(
      kind,
      wordRange,
      deliverable,
      sequence,
      layer,
    );
    if (operation === undefined) {
      setNotice(kind === "createClip"
        ? "An active deliverable sequence layer is required to create a clip."
        : "An active deliverable sequence is required to remove a range.");
      return;
    }
    try {
      await executeDirect([operation], `${kind === "remove" ? "Remove" : "Create clip from"} transcript range`);
      await refreshProject();
      setNotice(kind === "remove" ? "Removed transcript range." : "Created clip from transcript range.");
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function correctWord(): Promise<void> {
    if (selected === undefined || correctionDraft.trim() === "") return;
    try {
      await executeDirect([{
        op: "transcript.word.correct",
        params: { wordId: selected.id, text: correctionDraft.trim() },
      }], `Correct ${selected.id}`);
      await refreshProject();
      setEditing(false);
      setNotice(`Corrected ${selected.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function detectFillers(): Promise<void> {
    try {
      const job = await window.guyditor.call<JobStatus>(
        "TranscriptEngine",
        "enqueueFillerDetection",
        { assetIds: [...new Set(transcripts.map(({ assetId }) => assetId))] },
      );
      setNotice(`Queued ${job.title}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <Panel
      id="transcript"
      title="Transcript"
      eyebrow="Canonical words / virtualized"
      actions={(
        <button type="button" data-testid="transcript-fillers-detect" disabled={transcripts.length === 0} onClick={() => void detectFillers()}>
          Detect fillers
        </button>
      )}
    >
      <div className="transcript-toolbar" role="toolbar" aria-label="Transcript range operations">
        <span data-testid="transcript-selection-readout">
          {wordRange === null ? "No range" : `${wordRange.fromWord} → ${wordRange.toWord}`}
        </span>
        <button
          type="button"
          data-testid="transcript-range-remove"
          disabled={wordRange === null || deliverable === undefined || sequence === undefined}
          onClick={() => void rangeOperation("remove")}
        >Remove range</button>
        <button
          type="button"
          data-testid="transcript-range-create-clip"
          disabled={wordRange === null || deliverable === undefined || sequence === undefined || layer === undefined}
          onClick={() => void rangeOperation("createClip")}
        >Create clip</button>
        <button
          type="button"
          data-testid="transcript-correction-edit"
          disabled={selected === undefined}
          onClick={() => setEditing(!editing)}
        >Correct word</button>
      </div>
      {editing ? (
        <div className="correction-editor">
          <input
            type="text"
            value={correctionDraft}
            data-testid="transcript-correction-input"
            aria-label="Corrected word"
            onChange={(event) => setCorrectionDraft(event.target.value)}
          />
          <button type="button" data-testid="transcript-correction-save" onClick={() => void correctWord()}>Save correction</button>
        </div>
      ) : null}
      <section className="caption-track-panel" data-testid="caption-track-panel" aria-label="Caption track controls">
        <header>
          <strong>Caption track</strong>
          <span>{captionTrack?.id ?? "No caption track"}</span>
        </header>
        {captionTrack === undefined ? (
          <p className="empty-copy">This project has no caption track to configure.</p>
        ) : (
          <>
            <div className="caption-control-grid">
              <label>
                Preset
                <select
                  data-testid="caption-preset-select"
                  value={`${captionTrack.preset.presetId}@${String(captionTrack.preset.version)}`}
                  onChange={(event) => {
                    const preset = captionPresets.find(({ id, version }) =>
                      `${id}@${String(version)}` === event.target.value);
                    if (preset !== undefined) void applyCaptionOperation({
                      op: "caption.preset.upgrade",
                      params: { captionId: captionTrack.id, preset: { presetId: preset.id, version: preset.version } },
                    }, `Selected caption preset ${preset.name}`);
                  }}
                >
                  {captionPresets.map((preset) => (
                    <option key={`${preset.id}@${String(preset.version)}`} value={`${preset.id}@${String(preset.version)}`}>
                      {preset.name} · v{String(preset.version)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Size %
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  data-testid="caption-style-size"
                  defaultValue={captionTrack.styleOverrides.sizePct ?? 5.2}
                  onBlur={(event) => {
                    if (event.target.valueAsNumber !== (captionTrack.styleOverrides.sizePct ?? 5.2)) {
                      void setStyle({ sizePct: event.target.valueAsNumber });
                    }
                  }}
                />
              </label>
              <label>
                Words / line
                <input
                  type="number"
                  min="1"
                  step="1"
                  data-testid="caption-style-words-per-line"
                  defaultValue={captionTrack.styleOverrides.wordsPerLine ?? 4}
                  onBlur={(event) => {
                    if (event.target.valueAsNumber !== (captionTrack.styleOverrides.wordsPerLine ?? 4)) {
                      void setStyle({ wordsPerLine: event.target.valueAsNumber });
                    }
                  }}
                />
              </label>
              <label>
                Max width %
                <input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  data-testid="caption-style-max-width"
                  defaultValue={captionTrack.styleOverrides.maxWidthPct ?? 90}
                  onBlur={(event) => {
                    if (event.target.valueAsNumber !== (captionTrack.styleOverrides.maxWidthPct ?? 90)) {
                      void setStyle({ maxWidthPct: event.target.valueAsNumber });
                    }
                  }}
                />
              </label>
              <label>
                Text RGBA
                <input
                  type="text"
                  pattern="#[0-9A-Fa-f]{8}"
                  data-testid="caption-style-color"
                  defaultValue={captionTrack.styleOverrides.color ?? "#FFFFFFFF"}
                  onBlur={(event) => {
                    const color = event.target.value.toUpperCase();
                    if (color !== (captionTrack.styleOverrides.color ?? "#FFFFFFFF")) {
                      void setStyle({ color });
                    }
                  }}
                />
              </label>
              <label className="caption-checkbox">
                <input
                  type="checkbox"
                  checked={captionTrack.enabled}
                  data-testid="caption-track-enabled"
                  onChange={(event) => void applyCaptionOperation({
                    op: "caption.track.set",
                    params: { captionId: captionTrack.id, enabled: event.target.checked },
                  }, `${event.target.checked ? "Enabled" : "Disabled"} caption track`)}
                />
                Enabled
              </label>
            </div>
            <div className="caption-word-controls">
              <span>{selectedWordId ?? "Select a transcript or rendered caption word"}</span>
              <label>
                Break after
                <select
                  disabled={selectedWordId === null}
                  value={selectedBreak?.kind ?? "none"}
                  data-testid="caption-break-select"
                  onChange={(event) => {
                    if (selectedWordId === null) return;
                    const kind = event.target.value;
                    void applyCaptionOperation({
                      op: kind === "none" ? "caption.break.clear" : "caption.break.set",
                      params: kind === "none"
                        ? { captionId: captionTrack.id, afterWordId: selectedWordId }
                        : { captionId: captionTrack.id, afterWordId: selectedWordId, kind },
                    }, `${kind === "none" ? "Cleared" : `Set ${kind}`} caption break`);
                  }}
                >
                  <option value="none">None</option>
                  <option value="line">Line</option>
                  <option value="cue">Cue</option>
                  <option value="join">Join</option>
                </select>
              </label>
              <label className="caption-checkbox">
                <input
                  key={`${selectedWordId ?? "none"}:${String(selectedEmphasis)}`}
                  type="checkbox"
                  disabled={selectedWordId === null}
                  defaultChecked={selectedEmphasis}
                  data-testid="caption-emphasis-toggle"
                  onChange={(event) => {
                    if (selectedWordId !== null) void applyCaptionOperation({
                      op: "caption.word.emphasis.set",
                      params: { captionId: captionTrack.id, wordId: selectedWordId, emphasis: event.target.checked },
                    }, `${event.target.checked ? "Emphasized" : "Unemphasized"} ${selectedWordId}`);
                  }}
                />
                Emphasis
              </label>
              <label>
                Start ms
                <input type="number" value={startNudge} data-testid="caption-start-nudge" onChange={(event) => setStartNudge(event.target.valueAsNumber || 0)} />
              </label>
              <label>
                End ms
                <input type="number" value={endNudge} data-testid="caption-end-nudge" onChange={(event) => setEndNudge(event.target.valueAsNumber || 0)} />
              </label>
              <button type="button" disabled={selectedWordId === null} data-testid="caption-timing-apply" onClick={() => void retimeCaption()}>Apply nudge</button>
              <button type="button" disabled={selectedWordId === null} data-testid="caption-timing-clear" onClick={() => void retimeCaption(true)}>Clear nudge</button>
            </div>
          </>
        )}
      </section>
      <div
        className="word-stream"
        data-testid="transcript-word-stream"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onClick={(event) => {
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-word-id]")
            : null;
          const id = target?.dataset["wordId"];
          if (id !== undefined) void select(id, event.shiftKey);
        }}
      >
        {first > 0 ? <span className="virtual-spacer">… {String(first)} earlier words …</span> : null}
        {visible.map(({ id, speaker, word }) => (
          <button
            key={id}
            type="button"
            className="transcript-word"
            data-word-id={id}
            data-testid={`transcript-word-${id}`}
            data-selected={wordRange !== null && id >= wordRange.fromWord && id <= wordRange.toWord}
            data-confidence={word.confidence === null ? "unknown" : word.confidence < 0.7 ? "low" : "high"}
            title={`${id} · ${speaker} · ${word.start.samples}/${String(word.start.rate)}s`}
          >
            {word.punctBefore}{word.text}{word.punctAfter}
          </button>
        ))}
        {first + visible.length < allWords.length ? <span className="virtual-spacer">… more words …</span> : null}
        {allWords.length === 0 ? <p className="empty-copy">No canonical transcript sidecar.</p> : null}
      </div>
      <small className="m2-note">Caption edits are semantic operations; every accepted change recompiles the immutable frame model used by preview and export.</small>
    </Panel>
  );
}
