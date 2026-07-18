import {
  WORD_ID_PATTERN,
} from "../../core/src/index.js";

import type {
  SampleTime,
  TranscriptEngineIdentity,
  TranscriptSegment,
  TranscriptSidecar,
  TranscriptSpeaker,
  TranscriptWord,
} from "./types.js";

const ASSET_ID_PATTERN = /^ast_[a-z2-7]{10}$/u;
const SEGMENT_ID_PATTERN = /^seg_[a-z2-7]{10}$/u;
const SPEAKER_ID_PATTERN = /^spk_[a-z2-7]{10}$/u;
const JOB_ID_PATTERN = /^job_[a-z2-7]{10}$/u;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function invalid(path: string, detail: string): never {
  throw new TypeError(`Invalid guyditor.transcript/v1 sidecar at ${path}: ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : invalid(path, "expected an object");
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) invalid(`${path}/${key}`, "required field is missing");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}/${key}`, "unknown field");
  }
}

function stringValue(value: unknown, path: string): string {
  return typeof value === "string" ? value : invalid(path, "expected a string");
}

function boundedProbability(value: unknown, path: string): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : invalid(path, "expected a finite probability from 0 through 1");
}

function positiveInteger(value: unknown, path: string): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : invalid(path, "expected a positive safe integer");
}

function nonNegativeInteger(value: unknown, path: string): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : invalid(path, "expected a non-negative safe integer");
}

function sampleTime(value: unknown, path: string): SampleTime {
  const source = record(value, path);
  exactKeys(source, ["samples", "rate"], [], path);
  return {
    samples: nonNegativeInteger(source["samples"], `${path}/samples`),
    rate: positiveInteger(source["rate"], `${path}/rate`),
  };
}

function engineIdentity(value: unknown, path: string): TranscriptEngineIdentity {
  const source = record(value, path);
  exactKeys(source, ["name", "version", "model"], [], path);
  return {
    name: stringValue(source["name"], `${path}/name`),
    version: stringValue(source["version"], `${path}/version`),
    model: stringValue(source["model"], `${path}/model`),
  };
}

function speaker(value: unknown, path: string): TranscriptSpeaker {
  const source = record(value, path);
  exactKeys(source, ["id", "label"], [], path);
  const id = stringValue(source["id"], `${path}/id`);
  if (!SPEAKER_ID_PATTERN.test(id)) invalid(`${path}/id`, "malformed speaker ID");
  return { id, label: stringValue(source["label"], `${path}/label`) };
}

function segment(value: unknown, path: string): TranscriptSegment {
  const source = record(value, path);
  exactKeys(source, ["id", "speaker", "language", "start", "end", "words"], [], path);
  const id = stringValue(source["id"], `${path}/id`);
  const speakerId = stringValue(source["speaker"], `${path}/speaker`);
  if (!SEGMENT_ID_PATTERN.test(id)) invalid(`${path}/id`, "malformed segment ID");
  if (!SPEAKER_ID_PATTERN.test(speakerId)) {
    invalid(`${path}/speaker`, "malformed speaker ID");
  }
  const languageValue = source["language"];
  if (languageValue !== null && typeof languageValue !== "string") {
    invalid(`${path}/language`, "expected a string or null");
  }
  if (!Array.isArray(source["words"])) invalid(`${path}/words`, "expected an array");
  const words = source["words"].map((wordId, index) => {
    const idValue = stringValue(wordId, `${path}/words/${String(index)}`);
    if (!WORD_ID_PATTERN.test(idValue)) {
      invalid(`${path}/words/${String(index)}`, "malformed word ID");
    }
    return idValue;
  });
  const start = sampleTime(source["start"], `${path}/start`);
  const end = sampleTime(source["end"], `${path}/end`);
  if (start.rate !== end.rate || start.samples >= end.samples) {
    invalid(path, "segment start/end must share a rate and start before end");
  }
  return { id, speaker: speakerId, language: languageValue, start, end, words };
}

const ALIGNMENTS = new Set(["ctc", "asr", "interpolated", "manual", "imported"]);
const ORIGINS = new Set(["asr", "correction", "script", "pickup", "import"]);

function word(value: unknown, path: string): TranscriptWord {
  const source = record(value, path);
  exactKeys(
    source,
    [
      "text",
      "punctBefore",
      "punctAfter",
      "start",
      "end",
      "confidence",
      "alignment",
      "state",
      "origin",
    ],
    ["replacedBy"],
    path,
  );
  const start = sampleTime(source["start"], `${path}/start`);
  const end = sampleTime(source["end"], `${path}/end`);
  if (start.rate !== end.rate || start.samples >= end.samples) {
    invalid(path, "word start/end must share a rate and start before end");
  }
  const confidenceValue = source["confidence"];
  const confidence = confidenceValue === null
    ? null
    : boundedProbability(confidenceValue, `${path}/confidence`);
  const alignment = stringValue(source["alignment"], `${path}/alignment`);
  if (!ALIGNMENTS.has(alignment)) invalid(`${path}/alignment`, "unknown alignment");
  const state = stringValue(source["state"], `${path}/state`);
  if (state !== "active" && state !== "deleted") invalid(`${path}/state`, "unknown state");
  const origin = stringValue(source["origin"], `${path}/origin`);
  if (!ORIGINS.has(origin)) invalid(`${path}/origin`, "unknown origin");
  let replacedBy: string[] | undefined;
  if (source["replacedBy"] !== undefined) {
    if (state !== "deleted" || !Array.isArray(source["replacedBy"])) {
      invalid(`${path}/replacedBy`, "only deleted words may carry a word-ID array");
    }
    replacedBy = source["replacedBy"].map((wordId, index) => {
      const id = stringValue(wordId, `${path}/replacedBy/${String(index)}`);
      if (!WORD_ID_PATTERN.test(id)) {
        invalid(`${path}/replacedBy/${String(index)}`, "malformed word ID");
      }
      return id;
    });
  }
  return {
    text: stringValue(source["text"], `${path}/text`),
    punctBefore: stringValue(source["punctBefore"], `${path}/punctBefore`),
    punctAfter: stringValue(source["punctAfter"], `${path}/punctAfter`),
    start,
    end,
    confidence,
    alignment: alignment as TranscriptWord["alignment"],
    state,
    origin: origin as TranscriptWord["origin"],
    ...(replacedBy === undefined ? {} : { replacedBy }),
  };
}

function compareTimes(
  left: { start: SampleTime; end: SampleTime },
  right: { start: SampleTime; end: SampleTime },
): number {
  const startDelta = left.start.samples * right.start.rate -
    right.start.samples * left.start.rate;
  if (startDelta !== 0) return startDelta;
  return left.end.samples * right.end.rate - right.end.samples * left.end.rate;
}

export function validateTranscriptSidecar(value: unknown): TranscriptSidecar {
  const source = record(value, "/");
  exactKeys(
    source,
    [
      "schema",
      "assetId",
      "audio",
      "language",
      "languageProbability",
      "provenance",
      "speakers",
      "segments",
      "words",
    ],
    [],
    "/",
  );
  if (source["schema"] !== "guyditor.transcript/v1") {
    invalid("/schema", "expected guyditor.transcript/v1");
  }
  const assetId = stringValue(source["assetId"], "/assetId");
  if (!ASSET_ID_PATTERN.test(assetId)) invalid("/assetId", "malformed asset ID");
  const audioSource = record(source["audio"], "/audio");
  exactKeys(audioSource, ["rate", "channels", "streamIndex"], [], "/audio");
  const audio = {
    rate: positiveInteger(audioSource["rate"], "/audio/rate"),
    channels: positiveInteger(audioSource["channels"], "/audio/channels"),
    streamIndex: nonNegativeInteger(audioSource["streamIndex"], "/audio/streamIndex"),
  };
  const provenanceSource = record(source["provenance"], "/provenance");
  exactKeys(
    provenanceSource,
    ["engine", "alignment", "createdAt", "jobId"],
    [],
    "/provenance",
  );
  const createdAt = stringValue(provenanceSource["createdAt"], "/provenance/createdAt");
  const jobId = stringValue(provenanceSource["jobId"], "/provenance/jobId");
  if (!ISO_UTC_PATTERN.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    invalid("/provenance/createdAt", "expected an ISO-8601 UTC timestamp");
  }
  if (!JOB_ID_PATTERN.test(jobId)) invalid("/provenance/jobId", "malformed job ID");
  if (!Array.isArray(source["speakers"])) invalid("/speakers", "expected an array");
  if (!Array.isArray(source["segments"])) invalid("/segments", "expected an array");
  const speakers = source["speakers"].map((entry, index) =>
    speaker(entry, `/speakers/${String(index)}`));
  const segments = source["segments"].map((entry, index) =>
    segment(entry, `/segments/${String(index)}`));
  const wordsSource = record(source["words"], "/words");
  const words: Record<string, TranscriptWord> = {};
  for (const [wordId, entry] of Object.entries(wordsSource)) {
    if (!WORD_ID_PATTERN.test(wordId)) invalid(`/words/${wordId}`, "malformed word ID key");
    words[wordId] = word(entry, `/words/${wordId}`);
  }

  const speakerIds = new Set(speakers.map(({ id }) => id));
  if (speakerIds.size !== speakers.length) invalid("/speakers", "speaker IDs must be unique");
  const segmentIds = new Set(segments.map(({ id }) => id));
  if (segmentIds.size !== segments.length) invalid("/segments", "segment IDs must be unique");
  const assignedWords = new Set<string>();
  for (const [segmentIndex, entry] of segments.entries()) {
    if (!speakerIds.has(entry.speaker)) {
      invalid(`/segments/${String(segmentIndex)}/speaker`, "speaker does not exist");
    }
    if (entry.start.rate !== audio.rate || entry.end.rate !== audio.rate) {
      invalid(`/segments/${String(segmentIndex)}`, "segment rate differs from native audio rate");
    }
    let previous: TranscriptWord | undefined;
    for (const [wordIndex, wordId] of entry.words.entries()) {
      const entryWord = words[wordId];
      if (entryWord === undefined) {
        invalid(`/segments/${String(segmentIndex)}/words/${String(wordIndex)}`, "word does not exist");
      }
      if (assignedWords.has(wordId)) {
        invalid(`/segments/${String(segmentIndex)}/words/${String(wordIndex)}`, "word is in two segments");
      }
      if (
        entryWord.start.rate !== audio.rate || entryWord.end.rate !== audio.rate ||
        entryWord.start.samples < entry.start.samples || entryWord.end.samples > entry.end.samples
      ) {
        invalid(`/words/${wordId}`, "word timing is outside its segment");
      }
      if (previous !== undefined && compareTimes(previous, entryWord) > 0) {
        invalid(`/segments/${String(segmentIndex)}/words`, "words are not in source-time order");
      }
      assignedWords.add(wordId);
      previous = entryWord;
    }
  }
  if (assignedWords.size !== Object.keys(words).length) {
    invalid("/words", "every word must belong to exactly one segment");
  }

  return {
    schema: "guyditor.transcript/v1",
    assetId,
    audio,
    language: stringValue(source["language"], "/language"),
    languageProbability: boundedProbability(source["languageProbability"], "/languageProbability"),
    provenance: {
      engine: engineIdentity(provenanceSource["engine"], "/provenance/engine"),
      alignment: provenanceSource["alignment"] === null
        ? null
        : engineIdentity(provenanceSource["alignment"], "/provenance/alignment"),
      createdAt,
      jobId,
    },
    speakers,
    segments,
    words,
  };
}

export function parseTranscriptSidecar(text: string): TranscriptSidecar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid guyditor.transcript/v1 JSON: ${detail}.`);
  }
  return validateTranscriptSidecar(parsed);
}

function orderedSampleTime(value: SampleTime): SampleTime {
  return { samples: value.samples, rate: value.rate };
}

function orderedEngine(value: TranscriptEngineIdentity): TranscriptEngineIdentity {
  return { name: value.name, version: value.version, model: value.model };
}

function orderedSegment(value: TranscriptSegment): TranscriptSegment {
  return {
    id: value.id,
    speaker: value.speaker,
    language: value.language,
    start: orderedSampleTime(value.start),
    end: orderedSampleTime(value.end),
    words: [...value.words],
  };
}

function orderedWord(value: TranscriptWord): TranscriptWord {
  return {
    text: value.text,
    punctBefore: value.punctBefore,
    punctAfter: value.punctAfter,
    start: orderedSampleTime(value.start),
    end: orderedSampleTime(value.end),
    confidence: value.confidence,
    alignment: value.alignment,
    state: value.state,
    origin: value.origin,
    ...(value.replacedBy === undefined ? {} : { replacedBy: [...value.replacedBy] }),
  };
}

export function serializeTranscriptSidecar(value: unknown): string {
  const sidecar = validateTranscriptSidecar(value);
  const segments = [...sidecar.segments]
    .sort((left, right) => compareTimes(left, right) || left.id.localeCompare(right.id))
    .map(orderedSegment);
  const wordEntries = Object.entries(sidecar.words)
    .sort(([leftId, left], [rightId, right]) =>
      compareTimes(left, right) || leftId.localeCompare(rightId));
  const lines = [
    "{",
    `  \"schema\": ${JSON.stringify(sidecar.schema)},`,
    `  \"assetId\": ${JSON.stringify(sidecar.assetId)},`,
    `  \"audio\": ${JSON.stringify({
      rate: sidecar.audio.rate,
      channels: sidecar.audio.channels,
      streamIndex: sidecar.audio.streamIndex,
    })},`,
    `  \"language\": ${JSON.stringify(sidecar.language)},`,
    `  \"languageProbability\": ${JSON.stringify(sidecar.languageProbability)},`,
    `  \"provenance\": ${JSON.stringify({
      engine: orderedEngine(sidecar.provenance.engine),
      alignment: sidecar.provenance.alignment === null
        ? null
        : orderedEngine(sidecar.provenance.alignment),
      createdAt: sidecar.provenance.createdAt,
      jobId: sidecar.provenance.jobId,
    })},`,
    `  \"speakers\": ${JSON.stringify(sidecar.speakers.map(({ id, label }) => ({ id, label })))},`,
    "  \"segments\": [",
    ...segments.map((entry, index) =>
      `    ${JSON.stringify(entry)}${index + 1 === segments.length ? "" : ","}`),
    "  ],",
    "  \"words\": {",
    ...wordEntries.map(([wordId, entry], index) =>
      `    ${index === 0 ? "" : ","}${JSON.stringify(wordId)}: ${
        JSON.stringify(orderedWord(entry))
      }`),
    "  }",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}
