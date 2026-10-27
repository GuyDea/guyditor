import type { SampleTime, TranscriptSidecar, TranscriptWord } from "../../types.js";

const WORD_MS = 300;
const GAP_MS = 80;

export interface ScriptedUtterance {
  atMs: number;
  text: string;
  confidence?: number;
}

/** Builds a valid sidecar: one segment per utterance, 300 ms per word, 80 ms word gap. */
export function scriptedTranscript(
  assetId: string,
  utterances: ScriptedUtterance[],
  rate = 48000,
  wordOrdinalStart = 1,
): TranscriptSidecar {
  const at = (ms: number): SampleTime => ({ samples: Math.round((ms * rate) / 1000), rate });
  const words: Record<string, TranscriptWord> = {};
  let ordinal = wordOrdinalStart;
  const segments = utterances.map((utterance, index) => {
    const ids: string[] = [];
    const tokens = utterance.text.split(/\s+/u).filter(Boolean);
    tokens.forEach((text, position) => {
      const id = `w${String(ordinal).padStart(6, "0")}`;
      ordinal += 1;
      const startMs = utterance.atMs + position * (WORD_MS + GAP_MS);
      words[id] = {
        text,
        punctBefore: "",
        punctAfter: "",
        start: at(startMs),
        end: at(startMs + WORD_MS),
        confidence: utterance.confidence ?? 0.95,
        alignment: "ctc",
        state: "active",
        origin: "asr",
      };
      ids.push(id);
    });
    const first = words[ids[0]!]!;
    const last = words[ids.at(-1)!]!;
    return {
      id: `s${String(index + 1).padStart(4, "0")}`,
      speaker: "spk1",
      language: "en",
      start: first.start,
      end: last.end,
      words: ids,
    };
  });
  return {
    schema: "guyditor.transcript/v1",
    assetId,
    audio: { rate, channels: 1, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      engine: { name: "fixture", version: "0", model: "fixture" },
      alignment: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      jobId: "fixture",
    },
    speakers: [{ id: "spk1", label: "Speaker 1" }],
    segments,
    words,
  };
}
