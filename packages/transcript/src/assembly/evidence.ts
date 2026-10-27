import { createHash } from "node:crypto";
import type { SampleTime } from "../types.js";
import { formatBytes } from "./context-files.js";
import type {
  AssemblyEvidence, AssemblyTransport, CandidateSegment, ContextFile, ContextFileKind, EvidenceAsset, ScriptBlock,
  SegmentGroup,
} from "./types.js";

/** A context file as the evidence lists it: inline text for sent text files, otherwise a note on how it travels. */
export interface EvidenceContextFile {
  label: string;
  name: string;
  kind: ContextFileKind;
  bytes: number;
  role: "script" | "context";
  sent: boolean;
  text: string | null;
  words: number | null;
  note: string | null;
}

export interface EvidenceInput {
  projectName: string;
  language: string;
  assets: EvidenceAsset[];
  segments: CandidateSegment[];
  groups: SegmentGroup[];
  scriptBlocks: ScriptBlock[];
  contextFiles: EvidenceContextFile[];
  notes: string[];
}

const wordCount = (text: string): number => text.match(/\S+/gu)?.length ?? 0;

/** `textOf` is read only for sent text files. */
export function contextFileNotes(
  files: readonly ContextFile[],
  transport: AssemblyTransport,
  textOf: (file: ContextFile) => string,
): EvidenceContextFile[] {
  return files.map((file) => {
    const { label, name, kind, bytes, role, sent } = file;
    const base = { label, name, kind, bytes, role, sent };
    if (!sent) return { ...base, text: null, words: null, note: `not sent — ${file.unsentReason ?? "unknown reason"}` };
    if (kind === "text") {
      const text = textOf(file);
      return role === "script"
        ? { ...base, text: null, words: wordCount(text), note: "rendered as the script blocks above" }
        : { ...base, text, words: wordCount(text), note: null };
    }
    if (kind === "image") return { ...base, text: null, words: null, note: "attached as an image input" };
    const note = transport === "api"
      ? "attached as a document input"
      : `attached by path for CLI providers: ${label}-${name}`;
    return { ...base, text: null, words: null, note };
  });
}

function contextFileLines(file: EvidenceContextFile): string[] {
  if (file.words !== null) {
    const header = `### ${file.label}  ${file.name}   ${file.kind}   ${file.words.toLocaleString("en-US")} words   role: ${file.role}`;
    return file.text === null ? [header] : [header, file.text.trimEnd()];
  }
  return [`### ${file.label}  ${file.name}   ${file.kind}   ${formatBytes(file.bytes)}   (${file.note ?? ""})`];
}

export const EVIDENCE_TOKEN_LIMIT = 120_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

function minutesSeconds(totalMs: number): string {
  const totalSeconds = Math.floor(totalMs / 1000);
  return `${pad(Math.floor(totalSeconds / 60), 2)}:${pad(totalSeconds % 60, 2)}`;
}

/** `mm:ss.mmm` from the start of the clip. */
export function formatClipTime(time: SampleTime): string {
  const ms = Math.round((time.samples * 1000) / time.rate);
  return `${minutesSeconds(ms)}.${pad(ms % 1000, 3)}`;
}

const durationMs = (segment: CandidateSegment): number =>
  Math.max(0, ((segment.end.samples / segment.end.rate) - (segment.start.samples / segment.start.rate)) * 1000);

function segmentHeader(segment: CandidateSegment): string {
  const fields = [`### ${segment.id}  ${formatClipTime(segment.start)}–${formatClipTime(segment.end)}`];
  fields.push(`words ${segment.fromWord}–${segment.toWord}`);
  if (segment.groupId !== null) fields.push(`group ${segment.groupId}`);
  if (segment.scriptMatch !== null) {
    fields.push(`script ${segment.scriptMatch.block} (${segment.scriptMatch.score.toFixed(2)})`);
  }
  if (segment.confidence !== null) fields.push(`conf ${segment.confidence.toFixed(2)}`);
  if (segment.pauseBeforeMs !== null) fields.push(`pause-before ${(segment.pauseBeforeMs / 1000).toFixed(1)}s`);
  if (segment.lowConfidence) fields.push("LOW-CONF");
  if (segment.aside) fields.push("ASIDE?");
  if (segment.markerPhrases.length > 0) fields.push(`spoken: "${segment.markerPhrases.join(", ")}"`);
  return fields.join("   ");
}

export function renderEvidencePackage(input: EvidenceInput): AssemblyEvidence {
  const speechMs = input.segments.reduce((sum, segment) => sum + durationMs(segment), 0);
  const lines: string[] = [
    "# Evidence", "",
    `project: ${input.projectName}`,
    `language: ${input.language}`,
    `assets: ${input.assets.length}`,
    `speech: ${minutesSeconds(speechMs)}`,
    "",
  ];
  if (input.scriptBlocks.length > 0) {
    lines.push("## Script", "");
    for (const block of input.scriptBlocks) lines.push(`### ${block.id} — ${block.section}`, block.text, "");
  }
  if (input.contextFiles.length > 0) {
    lines.push("## Context files", "");
    for (const file of input.contextFiles) lines.push(...contextFileLines(file), "");
  }
  lines.push("## Footage", "");
  for (const asset of input.assets) {
    lines.push(
      `## A${asset.ordinal}  ${asset.fileName}   captured ${asset.capturedAt} (${asset.captureSource})   dur ${minutesSeconds(asset.durationMs)}   asset ${asset.assetId}`,
    );
    if (asset.orderWarning !== null) lines.push(`order-warning: ${asset.orderWarning}`);
    for (const segment of input.segments.filter(({ assetId }) => assetId === asset.assetId)) {
      lines.push(segmentHeader(segment), segment.text);
    }
    lines.push("");
  }
  lines.push("## Groups", "");
  if (input.groups.length === 0) lines.push("(none)");
  for (const group of input.groups) lines.push(`${group.id}: ${group.memberIds.join(", ")}`);
  lines.push("");
  if (input.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of input.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  const text = `${lines.join("\n").trimEnd()}\n`;
  const tokenEstimate = estimateTokens(text);
  if (tokenEstimate > EVIDENCE_TOKEN_LIMIT) {
    throw new Error(`E_ASSEMBLY_EVIDENCE_TOO_LARGE: ${tokenEstimate} tokens > limit ${EVIDENCE_TOKEN_LIMIT}`);
  }
  return {
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    tokenEstimate,
    assets: input.assets,
    segments: input.segments,
    groups: input.groups,
    scriptBlocks: input.scriptBlocks,
    notes: input.notes,
  };
}
