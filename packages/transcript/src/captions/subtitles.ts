import { formatWordId } from "../../../core/src/index.js";
import type { TranscriptWord } from "../types.js";
import { halfEvenMilliseconds } from "./rational.js";
import type {
  CaptionCue,
  CaptionRenderModel,
  ImportedSubtitle,
  ImportSubtitleOptions,
  SubtitleExportOptions,
} from "./types.js";

interface ParsedSubtitleCue {
  startMs: number;
  endMs: number;
  lines: string[];
  wordStartsMs: number[];
}

function time(ms: number, separator: "," | "."): string {
  const clamped = Math.max(0, ms);
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor(clamped % 3_600_000 / 60_000);
  const seconds = Math.floor(clamped % 60_000 / 1_000);
  const milliseconds = clamped % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}${separator}${String(milliseconds).padStart(3, "0")}`;
}

function cueLines(cue: CaptionCue, speaker: boolean): string[] {
  return cue.lines.map((line, index) => {
    const text = line.words.map(({ displayText }) => displayText).join(" ");
    return speaker && index === 0 ? `${cue.speakerLabel.toLocaleUpperCase("und")}: ${text}` : text;
  });
}

function vttLine(style: CaptionRenderModel["styleResolved"]): string {
  const line = style.placement.anchor === "top"
    ? style.placement.offsetYPct
    : style.placement.anchor === "middle"
      ? 50 + style.placement.offsetYPct
      : 100 + style.placement.offsetYPct;
  const position = style.placement.align === "left" ? 0 : style.placement.align === "right" ? 100 : 50;
  return ` line:${String(Math.max(0, Math.min(100, line)))}% position:${String(position)}% align:${style.placement.align}`;
}

function vttCueLines(cue: CaptionCue, options: SubtitleExportOptions): string[] {
  if (!options.vttWordTimestamps) return cueLines(cue, options.includeSpeakerLabels);
  return cue.lines.map((line, lineIndex) => line.words.map((word, wordIndex) => {
    const prefix = options.includeSpeakerLabels && lineIndex === 0 && wordIndex === 0
      ? `${cue.speakerLabel.toLocaleUpperCase("und")}: `
      : wordIndex === 0 ? "" : " ";
    return `${prefix}<${time(halfEvenMilliseconds(word.highlightStart), ".")}>${word.displayText}`;
  }).join(""));
}

export function serializeSubtitles(
  model: CaptionRenderModel,
  options: SubtitleExportOptions,
): string {
  let previousEnd = 0;
  const blocks = model.cues.map((cue, index) => {
    const naturalStart = Math.max(0, halfEvenMilliseconds(cue.start));
    const start = Math.max(previousEnd, naturalStart);
    const end = Math.max(start, halfEvenMilliseconds(cue.end));
    previousEnd = end;
    if (options.format === "srt") {
      return `${String(index + 1)}\n${time(start, ",")} --> ${time(end, ",")}\n` +
        cueLines(cue, options.includeSpeakerLabels).join("\n");
    }
    const settings = options.vttPositioning ? vttLine(model.styleResolved) : "";
    return `${time(start, ".")} --> ${time(end, ".")}${settings}\n` +
      vttCueLines(cue, options).join("\n");
  });
  return options.format === "vtt"
    ? `WEBVTT\n\n${blocks.join("\n\n")}\n`
    : `${blocks.join("\n\n")}\n`;
}

function parseTimestamp(value: string): number {
  const match = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/u.exec(value);
  if (match === null) throw new TypeError(`Invalid subtitle timestamp ${value}.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) throw new TypeError(`Invalid subtitle timestamp ${value}.`);
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

function visibleText(value: string): string {
  return value.replace(/<\d{2,}:\d{2}:\d{2}[,.]\d{3}>/gu, "").replace(/<[^>]+>/gu, "");
}

export function parseSubtitleCues(content: string, format: "srt" | "vtt"): ParsedSubtitleCue[] {
  let normalized = content.replace(/\r\n?/gu, "\n").trim();
  if (format === "vtt") {
    if (!normalized.startsWith("WEBVTT")) throw new TypeError("VTT input must begin with WEBVTT.");
    normalized = normalized.slice("WEBVTT".length).trim();
  }
  if (normalized === "") return [];
  return normalized.split(/\n{2,}/u).flatMap((block) => {
    const lines = block.split("\n");
    if (format === "srt" && /^\d+$/u.test(lines[0] ?? "")) lines.shift();
    if (format === "vtt" && !lines[0]?.includes(" --> ") && lines.length > 1) lines.shift();
    const timing = lines.shift();
    if (timing === undefined) return [];
    const match = /^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$/u.exec(timing);
    if (match === null) throw new TypeError(`Invalid subtitle cue timing ${timing}.`);
    const startMs = parseTimestamp(match[1]!);
    const endMs = parseTimestamp(match[2]!);
    if (endMs <= startMs) throw new TypeError("Subtitle cue end must be after its start.");
    const raw = lines.join(" ");
    const wordStartsMs = [...raw.matchAll(/<(\d{2,}:\d{2}:\d{2}[,.]\d{3})>/gu)]
      .map((entry) => parseTimestamp(entry[1]!));
    return [{
      startMs,
      endMs,
      lines: lines.map(visibleText),
      wordStartsMs,
    }];
  });
}

function samples(milliseconds: number, rate: number): number {
  const numerator = BigInt(milliseconds) * BigInt(rate);
  const quotient = numerator / 1_000n;
  const remainder = numerator % 1_000n;
  const rounded = remainder * 2n <= 1_000n ? quotient : quotient + 1n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Imported subtitle timing is too large.");
  return Number(rounded);
}

function tokenParts(raw: string): { text: string; punctBefore: string; punctAfter: string } {
  const punctBefore = raw.match(/^\p{P}*/u)?.[0] ?? "";
  const withoutBefore = raw.slice(punctBefore.length);
  const punctAfter = withoutBefore.match(/\p{P}*$/u)?.[0] ?? "";
  const text = withoutBefore.slice(0, withoutBefore.length - punctAfter.length);
  return { text: text || raw, punctBefore: text === "" ? "" : punctBefore, punctAfter: text === "" ? "" : punctAfter };
}

function base32Ordinal(value: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let remaining = value;
  let result = "";
  for (let index = 0; index < 10; index += 1) {
    result = `${alphabet[remaining % 32]}${result}`;
    remaining = Math.floor(remaining / 32);
  }
  return result;
}

export function importSubtitleText(
  content: string,
  options: ImportSubtitleOptions,
): ImportedSubtitle {
  if (!Number.isSafeInteger(options.firstWordOrdinal) || options.firstWordOrdinal < 0) {
    throw new RangeError("firstWordOrdinal must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(options.sampleRate) || options.sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive safe integer.");
  }
  const cues = parseSubtitleCues(content, options.format);
  const words: Record<string, TranscriptWord> = {};
  let ordinal = options.firstWordOrdinal;
  const segments = cues.map((cue, cueIndex) => {
    const tokens = cue.lines.join(" ").trim().split(/\s+/u).filter(Boolean);
    const counts = tokens.map((token) => Math.max(1, [...tokenParts(token).text].length));
    const total = counts.reduce((sum, count) => sum + count, 0);
    let characters = 0;
    const wordIds = tokens.map((token, tokenIndex) => {
      const wordId = formatWordId(ordinal);
      ordinal += 1;
      const interpolatedStart = cue.startMs + Math.floor((cue.endMs - cue.startMs) * characters / total);
      characters += counts[tokenIndex]!;
      const interpolatedEnd = tokenIndex === tokens.length - 1
        ? cue.endMs
        : cue.startMs + Math.floor((cue.endMs - cue.startMs) * characters / total);
      const startMs = cue.wordStartsMs[tokenIndex] ?? interpolatedStart;
      const endMs = cue.wordStartsMs[tokenIndex + 1] ?? interpolatedEnd;
      words[wordId] = {
        ...tokenParts(token),
        start: { samples: samples(startMs, options.sampleRate), rate: options.sampleRate },
        end: { samples: samples(Math.max(startMs + 1, endMs), options.sampleRate), rate: options.sampleRate },
        confidence: null,
        alignment: "imported",
        state: "active",
        origin: "import",
      };
      return wordId;
    });
    return {
      id: `seg_${base32Ordinal(cueIndex + 1)}`,
      speaker: "spk_aaaaaaaaaa",
      language: null,
      start: { samples: samples(cue.startMs, options.sampleRate), rate: options.sampleRate },
      end: { samples: samples(cue.endMs, options.sampleRate), rate: options.sampleRate },
      words: wordIds,
    };
  });
  return {
    provisional: true,
    nextWordOrdinal: ordinal,
    sidecar: {
      schema: "guyditor.transcript/v1",
      assetId: options.assetId,
      provisional: true,
      audio: { rate: options.sampleRate, channels: 1, streamIndex: 0 },
      language: "und",
      languageProbability: 0,
      provenance: {
        engine: { name: `${options.format}-import`, version: "1", model: "subtitle" },
        alignment: null,
        createdAt: options.now,
        jobId: options.jobId,
      },
      speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker 1" }],
      segments,
      words,
    },
  };
}
