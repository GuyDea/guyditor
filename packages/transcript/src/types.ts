export interface SampleTime {
  samples: number;
  rate: number;
}

export interface TranscriptEngineIdentity {
  name: string;
  version: string;
  model: string;
}

export interface TranscriptSpeaker {
  id: string;
  label: string;
}

export interface TranscriptSegment {
  id: string;
  speaker: string;
  language: string | null;
  start: SampleTime;
  end: SampleTime;
  words: string[];
}

export type TranscriptAlignment =
  | "ctc"
  | "asr"
  | "interpolated"
  | "manual"
  | "imported";

export type TranscriptWordOrigin =
  | "asr"
  | "correction"
  | "script"
  | "pickup"
  | "import";

export interface TranscriptWord {
  text: string;
  punctBefore: string;
  punctAfter: string;
  start: SampleTime;
  end: SampleTime;
  confidence: number | null;
  alignment: TranscriptAlignment;
  state: "active" | "deleted";
  origin: TranscriptWordOrigin;
  replacedBy?: string[];
}

export interface TranscriptSidecar {
  schema: "guyditor.transcript/v1";
  assetId: string;
  audio: { rate: number; channels: number; streamIndex: number };
  language: string;
  languageProbability: number;
  provenance: {
    engine: TranscriptEngineIdentity;
    alignment: TranscriptEngineIdentity | null;
    createdAt: string;
    jobId: string;
  };
  speakers: TranscriptSpeaker[];
  segments: TranscriptSegment[];
  words: Record<string, TranscriptWord>;
}

export interface RawTranscriptionWord {
  text: string;
  start: SampleTime | number;
  end: SampleTime | number;
  probability: number;
}

export interface RawTranscriptionSegment {
  index: number;
  start: SampleTime | number;
  end: SampleTime | number;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  words: RawTranscriptionWord[];
}

export interface TranscribeResult {
  language: string;
  languageProbability: number;
  segments: RawTranscriptionSegment[];
  engine: TranscriptEngineIdentity;
  jobId: string;
}

export interface AlignedToken {
  segmentIndex: number;
  tokenIndex: number;
  start: SampleTime;
  end: SampleTime;
  score: number;
  aligned: boolean;
}

export interface AlignResult {
  tokens: AlignedToken[];
  engine: TranscriptEngineIdentity;
}

export interface TranscriptWordRange {
  fromWord: string;
  toWord: string;
}

export interface TranscriptRealignRequest {
  assetId: string;
  wordRange?: TranscriptWordRange;
}

export interface WordLocation {
  assetId: string;
  segmentId: string;
  sidecarName: string;
  wordId: string;
  word: TranscriptWord;
}

export interface WordResolution extends WordLocation {
  requestedWordId: string;
  approximate: boolean;
}
