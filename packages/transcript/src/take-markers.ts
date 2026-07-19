import type {
  MarkerRecord,
  MarkerType,
  TakeMarkerSidecar,
  TakeQuality,
  TakeRecord,
} from "../../core/src/index.js";
import type { TranscriptSidecar, TranscriptWord } from "./types.js";

type TakeMarkerIdFactory = (prefix: "mrk" | "tak") => string;

export interface TakeMarkerImportOptions {
  assetId: string;
  fps: string;
  assetEndFrame: number;
  idFactory: TakeMarkerIdFactory;
  captureStart?: string;
}

export interface SpokenMarkerOptions {
  fps: string;
  idFactory: TakeMarkerIdFactory;
  phrases?: readonly string[];
}

interface IntakeMarker {
  at: number | string;
  type: Exclude<MarkerType, "spoken">;
  take?: number;
  note?: string;
  quality?: Exclude<TakeQuality, "unrated">;
}

interface NormalizedMarker {
  record: MarkerRecord;
  take?: number;
  quality?: Exclude<TakeQuality, "unrated">;
}

function invalid(detail: string): never {
  throw new TypeError(`Invalid guyditor.take-markers-intake/v1 input: ${detail}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : invalid(`${path} must be an object`);
}

function fpsParts(fps: string): { numerator: number; denominator: number } {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(fps);
  if (match === null) return invalid(`fps ${fps} must be a positive rational`);
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

function roundRatioEarlier(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || numerator < 0 || !Number.isFinite(denominator) || denominator <= 0) {
    return invalid("time must be finite and non-negative");
  }
  const floor = Math.floor(numerator / denominator);
  const remainder = numerator - floor * denominator;
  return remainder * 2 > denominator ? floor + 1 : floor;
}

function secondsToFrame(seconds: number, fps: string): number {
  const parts = fpsParts(fps);
  return roundRatioEarlier(seconds * parts.numerator, parts.denominator);
}

function sampleToFrame(word: TranscriptWord, fps: string): number {
  const parts = fpsParts(fps);
  return roundRatioEarlier(
    word.start.samples * parts.numerator,
    word.start.rate * parts.denominator,
  );
}

const MARKER_TYPES = new Set<MarkerType>([
  "take-start", "take-end", "good", "bad", "mistake", "note", "chapter",
]);
const QUALITIES = new Set<TakeQuality>(["good", "bad", "flubbed"]);

function intakeMarker(value: unknown, index: number): IntakeMarker {
  const source = record(value, `/markers/${String(index)}`);
  const at = source["at"];
  if (typeof at !== "number" && typeof at !== "string") {
    invalid(`/markers/${String(index)}/at must be seconds or an ISO timestamp`);
  }
  const type = source["type"];
  if (typeof type !== "string" || !MARKER_TYPES.has(type as MarkerType)) {
    invalid(`/markers/${String(index)}/type is unknown`);
  }
  const take = source["take"];
  if (take !== undefined && (!Number.isSafeInteger(take) || Number(take) < 1)) {
    invalid(`/markers/${String(index)}/take must be a positive integer`);
  }
  const note = source["note"];
  if (note !== undefined && typeof note !== "string") invalid(`/markers/${String(index)}/note must be text`);
  const quality = source["quality"];
  if (quality !== undefined && (typeof quality !== "string" || !QUALITIES.has(quality as TakeQuality))) {
    invalid(`/markers/${String(index)}/quality is unknown`);
  }
  return {
    at,
    type: type as IntakeMarker["type"],
    ...(take === undefined ? {} : { take: Number(take) }),
    ...(note === undefined ? {} : { note }),
    ...(quality === undefined ? {} : { quality: quality as Exclude<TakeQuality, "unrated"> }),
  };
}

function markerFrame(
  marker: IntakeMarker,
  clock: "recording" | "utc",
  options: TakeMarkerImportOptions,
): number {
  if (clock === "recording") {
    return typeof marker.at === "number"
      ? secondsToFrame(marker.at, options.fps)
      : invalid("recording-clock marker at must be float seconds");
  }
  if (typeof marker.at !== "string") invalid("UTC marker at must be an ISO timestamp");
  if (options.captureStart === undefined) invalid("UTC intake requires the asset capture start");
  const at = Date.parse(marker.at);
  const start = Date.parse(options.captureStart);
  if (!Number.isFinite(at) || !Number.isFinite(start) || at < start) {
    invalid("UTC marker timestamp must be valid and not precede capture start");
  }
  return secondsToFrame((at - start) / 1000, options.fps);
}

function normalizedMarkers(
  markers: readonly IntakeMarker[],
  clock: "recording" | "utc",
  source: "json" | "notes",
  options: TakeMarkerImportOptions,
): NormalizedMarker[] {
  return markers.map((marker): NormalizedMarker => {
    const frame = markerFrame(marker, clock, options);
    if (frame > options.assetEndFrame) invalid(`marker at frame ${String(frame)} exceeds the asset duration`);
    return {
      record: {
        id: options.idFactory("mrk"),
        assetId: options.assetId,
        at: { frame, fps: options.fps },
        type: marker.type,
        ...(marker.note === undefined ? {} : { note: marker.note }),
        source,
      },
      ...(marker.take === undefined ? {} : { take: marker.take }),
      ...(marker.quality === undefined ? {} : { quality: marker.quality }),
    };
  }).sort((left, right) => {
    const leftFrame = "frame" in left.record.at ? left.record.at.frame : left.record.at.start;
    const rightFrame = "frame" in right.record.at ? right.record.at.frame : right.record.at.start;
    return leftFrame - rightFrame;
  });
}

function frameOf(marker: NormalizedMarker): number {
  return "frame" in marker.record.at ? marker.record.at.frame : marker.record.at.start;
}

function takeQuality(markers: readonly NormalizedMarker[]): TakeQuality {
  let quality: TakeQuality = "unrated";
  for (const marker of markers) {
    if (marker.quality !== undefined) quality = marker.quality;
    else if (marker.record.type === "good") quality = "good";
    else if (marker.record.type === "bad") quality = "bad";
    else if (marker.record.type === "mistake") quality = "flubbed";
  }
  return quality;
}

function assembleTakes(
  markers: readonly NormalizedMarker[],
  options: TakeMarkerImportOptions,
): TakeRecord[] {
  const starts = markers.filter(({ record }) => record.type === "take-start");
  return starts.map((start, ordinal) => {
    const index = start.take ?? ordinal + 1;
    const startFrame = frameOf(start);
    const nextStart = starts[ordinal + 1];
    const explicitEnd = markers.find((candidate) =>
      candidate.record.type === "take-end" && frameOf(candidate) >= startFrame &&
      (candidate.take === undefined || candidate.take === index));
    const end = explicitEnd === undefined
      ? nextStart === undefined ? options.assetEndFrame : frameOf(nextStart)
      : frameOf(explicitEnd);
    const included = markers.filter((candidate) => {
      const frame = frameOf(candidate);
      return frame >= startFrame && frame <= end;
    });
    return {
      id: options.idFactory("tak"),
      assetId: options.assetId,
      index,
      range: { start: startFrame, end, fps: options.fps },
      quality: takeQuality(included),
      notes: included.flatMap(({ record }) => record.note === undefined ? [] : [record.note]),
      sourceMarkerIds: included.map(({ record }) => record.id),
    };
  });
}

function sidecarFrom(
  markers: readonly IntakeMarker[],
  clock: "recording" | "utc",
  source: "json" | "notes",
  options: TakeMarkerImportOptions,
): TakeMarkerSidecar {
  const normalized = normalizedMarkers(markers, clock, source, options);
  return {
    format: "guyditor.take-markers/v1",
    assetId: options.assetId,
    markers: normalized.map(({ record }) => record),
    takes: assembleTakes(normalized, options),
  };
}

export function importJsonTakeMarkers(
  text: string,
  options: TakeMarkerImportOptions,
): TakeMarkerSidecar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalid("expected valid JSON");
  }
  const source = record(parsed, "/");
  if (source["format"] !== "guyditor.take-markers-intake/v1") invalid("format is not supported");
  if (source["clock"] !== "recording" && source["clock"] !== "utc") invalid("clock is unknown");
  if (!Array.isArray(source["markers"])) invalid("markers must be an array");
  return sidecarFrom(
    source["markers"].map(intakeMarker),
    source["clock"],
    "json",
    options,
  );
}

function timestampSeconds(value: string): number {
  const match = /^([0-9]+):([0-5][0-9]):([0-5][0-9](?:\.[0-9]+)?)$/u.exec(value);
  if (match === null) return invalid(`notes timestamp ${value} is malformed`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function importTakeNotes(
  text: string,
  options: TakeMarkerImportOptions,
): TakeMarkerSidecar {
  const markers: IntakeMarker[] = text.split(/\r?\n/u).flatMap((line, index) => {
    if (line.trim() === "") return [];
    const match = /^(\S+)\s+(TAKE\s+[0-9]+|GOOD|BAD|FLUB|NOTE|MARK)(?:\s+(.*))?$/u.exec(line.trim());
    if (match === null) invalid(`notes line ${String(index + 1)} is malformed`);
    const flag = match[2]!;
    const note = match[3]?.trim();
    const takeMatch = /^TAKE\s+([0-9]+)$/u.exec(flag);
    let type: IntakeMarker["type"];
    let quality: IntakeMarker["quality"];
    if (takeMatch !== null) type = "take-start";
    else if (flag === "GOOD") type = "good";
    else if (flag === "BAD") type = "bad";
    else if (flag === "FLUB") {
      type = "mistake";
      quality = "flubbed";
    } else type = "note";
    return [{
      at: timestampSeconds(match[1]!),
      type,
      ...(takeMatch === null ? {} : { take: Number(takeMatch[1]) }),
      ...(note === undefined || note === "" ? {} : { note }),
      ...(quality === undefined ? {} : { quality }),
    }];
  });
  return sidecarFrom(markers, "recording", "notes", options);
}

function orderedWords(sidecar: TranscriptSidecar): Array<{ id: string; word: TranscriptWord }> {
  return sidecar.segments.flatMap(({ words }) => words.flatMap((id) => {
    const word = sidecar.words[id];
    return word === undefined || word.state !== "active" ? [] : [{ id, word }];
  }));
}

const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
]);

function defaultPhraseLength(tokens: readonly string[], index: number): number {
  if (tokens[index] === "marker" || tokens[index] === "again") return 1;
  if (tokens[index] === "cut" && tokens[index + 1] === "that") return 2;
  if (
    tokens[index] === "take" && tokens[index + 1] !== undefined &&
    (/^[0-9]+$/u.test(tokens[index + 1]!) || NUMBER_WORDS.has(tokens[index + 1]!))
  ) return 2;
  if (
    tokens[index] === "that" && tokens[index + 1] === "was" &&
    (tokens[index + 2] === "good" || tokens[index + 2] === "bad")
  ) return 3;
  return 0;
}

export function detectSpokenTakeMarkers(
  sidecar: TranscriptSidecar,
  options: SpokenMarkerOptions,
): MarkerRecord[] {
  const words = orderedWords(sidecar);
  const tokens = words.map(({ word }) => word.text.toLocaleLowerCase("en").replace(/[^a-z0-9]+/gu, ""));
  const configured = options.phrases?.map((phrase) =>
    phrase.toLocaleLowerCase("en").trim().split(/\s+/u)) ?? [];
  const markers: MarkerRecord[] = [];
  for (let index = 0; index < tokens.length;) {
    const configuredLength = configured.find((phrase) =>
      phrase.every((token, offset) => tokens[index + offset] === token))?.length ?? 0;
    const length = Math.max(configuredLength, defaultPhraseLength(tokens, index));
    if (length === 0) {
      index += 1;
      continue;
    }
    const first = words[index]!;
    markers.push({
      id: options.idFactory("mrk"),
      assetId: sidecar.assetId,
      at: { frame: sampleToFrame(first.word, options.fps), fps: options.fps },
      type: "spoken",
      note: tokens.slice(index, index + length).join(" "),
      anchor: `word:${first.id}`,
      detected: true,
      source: "spoken",
    });
    index += length;
  }
  return markers;
}
