import { useMemo, useState } from "react";

import type { FrameTime } from "../../../../core/src/index.js";
import type { TranscriptWord } from "../../../../transcript/src/index.js";
import type { JobStatus } from "../../shared/ipc.js";
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

export function TranscriptPanel({
  snapshot,
  transcripts,
  refreshProject,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const allWords = useMemo(() => displayWords(transcripts), [transcripts]);
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
  const estimatedWordsPerRow = 8;
  const first = Math.max(0, Math.floor(scrollTop / 28) * estimatedWordsPerRow - 160);
  const visible = allWords.slice(first, first + 720);
  const selected = allWords.find(({ id }) => id === selectedWordId);

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
        { target: { kind: "word", wordId: id } },
      );
      setPlayhead(position.frame);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function rangeOperation(kind: "remove" | "createClip"): Promise<void> {
    if (wordRange === null || snapshot === null) return;
    const sequence = snapshot.master.sequences.find(({ id }) =>
      snapshot.master.deliverables.find(
        ({ id: deliverableId }) => deliverableId === snapshot.master.settings.primaryDeliverable,
      )?.sequenceId === id) ?? snapshot.master.sequences[0];
    const layer = snapshot.master.layers.find(({ sequence: sequenceId }) => sequenceId === sequence?.id);
    const operation = kind === "remove"
      ? {
          op: "transcript.range.remove",
          params: { wordRange, paddingMs: 0, snapPolicy: "none" },
        }
      : layer === undefined || sequence === undefined
        ? undefined
        : {
            op: "transcript.range.createClip",
            params: {
              wordRange,
              targetLayerId: layer.id,
              targetIndex: sequence.clips.length,
            },
          };
    if (operation === undefined) {
      setNotice("A target sequence layer is required to create a clip.");
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
        <button type="button" data-testid="transcript-range-remove" disabled={wordRange === null} onClick={() => void rangeOperation("remove")}>Remove range</button>
        <button type="button" data-testid="transcript-range-create-clip" disabled={wordRange === null} onClick={() => void rangeOperation("createClip")}>Create clip</button>
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
      <small className="m2-note">Words are windowed with two-screen overscan and selected by delegated events. Caption line-break editing is outside this M1 panel.</small>
    </Panel>
  );
}
