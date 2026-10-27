import type { FrameTime } from "../../../core/src/index.js";
import type { SampleTime } from "../types.js";

export type AssemblyProvider = "anthropic" | "openai" | "stub";
export type AssemblyEffort = "low" | "medium" | "high" | "max";
export type TighteningMode = "ask" | "gentle" | "off";
/** Same values as the agent package's `LlmTransport`; transcript does not import agent. */
export type AssemblyTransport = "api" | "cli";

export interface ScriptBlock { id: string; section: string; text: string; sentences: string[] }

export interface CandidateSegment {
  /** `C<assetOrdinal>.<nn>`, nn two-digit. */
  id: string;
  assetId: string;
  fromWord: string;
  toWord: string;
  start: SampleTime;
  end: SampleTime;
  text: string;
  pauseBeforeMs: number | null;
  confidence: number | null;
  lowConfidence: boolean;
  /** `G<n>`. */
  groupId: string | null;
  scriptMatch: { block: string; score: number } | null;
  aside: boolean;
  markerPhrases: string[];
}

export interface SegmentGroup {
  id: string;
  /** Capture order, latest last. */
  memberIds: string[];
  scriptBlock: string | null;
}

export interface EvidenceAsset {
  assetId: string;
  ordinal: number;
  fileName: string;
  capturedAt: string;
  captureSource: "container" | "file-mtime";
  durationMs: number;
  orderWarning: string | null;
}

export interface AssemblyEvidence {
  text: string;
  sha256: string;
  tokenEstimate: number;
  assets: EvidenceAsset[];
  segments: CandidateSegment[];
  groups: SegmentGroup[];
  scriptBlocks: ScriptBlock[];
  notes: string[];
}

export interface AssemblyQuestion {
  id: string;
  about: { assetId: string; fromWord: string; toWord: string } | null;
  text: string;
  options: string[] | null;
}

export interface AssemblyCut {
  scriptBlock: string | null;
  scriptSentences: [number, number] | null;
  assetId: string;
  fromWord: string;
  toWord: string;
  reason: string;
}

export interface AssemblyFlag {
  cutIndex: number;
  kind: "stitch" | "override" | "low-confidence" | "unmatched" | "other";
  note: string;
}

export type AssemblyPlan = {
  status: "plan";
  summary: string;
  tightening: "gentle" | "off" | null;
  cuts: AssemblyCut[];
  flags: AssemblyFlag[];
};

export type AssemblyReply =
  | { status: "questions"; summary: string; questions: AssemblyQuestion[] }
  | AssemblyPlan;

export interface CompiledCut {
  /** Clip index in the sequence. */
  index: number;
  assetId: string;
  in: FrameTime;
  out: FrameTime;
  timelineStart: FrameTime;
  extent: FrameTime;
  reason: string;
  flags: AssemblyFlag[];
}

export interface AssemblyUsage { inputTokens: number; outputTokens: number; usd: number; estimated: boolean }

export interface AssemblyMessage {
  role: "user" | "assistant" | "validation";
  content: string;
  reply: AssemblyReply | null;
  usage: AssemblyUsage | null;
  at: string;
}

export type AssemblySessionStatus =
  | "created" | "preparing" | "conversing" | "planned" | "proposed" | "accepted" | "abandoned" | "failed";

export interface AssemblySession {
  schema: "guyditor.assembly/v1";
  id: string;
  createdAt: string;
  updatedAt: string;
  status: AssemblySessionStatus;
  settings: {
    provider: AssemblyProvider;
    model: string;
    effort: AssemblyEffort;
    tightening: TighteningMode;
    transport: AssemblyTransport;
  };
  /** `nextFileLabel` numbers the next attached file (`F<n>`); labels are never reused within a session. */
  inputs: { assetIds: string[]; files: ContextFile[]; script: ScriptChoice; nextFileLabel: number };
  auditSessionId: string | null;
  externalAcknowledged: boolean;
  evidence: AssemblyEvidence | null;
  messages: AssemblyMessage[];
  plan: AssemblyPlan | null;
  compiled: CompiledCut[] | null;
  proposalId: string | null;
  tighteningJobId: string | null;
  error: string | null;
}

export type ContextFileKind = "text" | "image" | "pdf" | "other";

export interface ContextFile {
  label: string;
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
  kind: ContextFileKind;
  sent: boolean;
  unsentReason: string | null;
  pages: number | null;
  role: "script" | "context";
}

export type ScriptChoice = { mode: "auto" } | { mode: "label"; label: string } | { mode: "none" };
