import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  failure,
  formatWordId,
  makeGuyditorError,
  success,
  convertTimeRounding,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  IdPrefix,
  Layer,
  OperationDispatcher,
  OperationInput,
  ProjectStore,
  Result,
  SidecarRef,
} from "../../core/src/index.js";

import {
  parseTranscriptSidecar,
  serializeTranscriptSidecar,
} from "./sidecar.js";
import type {
  SampleTime,
  TranscriptAlignment,
  TranscriptEngineIdentity,
  TranscriptSegment,
  TranscriptSidecar,
  TranscriptWord,
} from "./types.js";
import { applyTranscriptRangeOperation } from "./range-operations.js";
import { applyCaptionOperation } from "./captions/operations.js";

const TRANSCRIPT_SCHEMA = "guyditor.transcript/v1";

interface TranscriptDocument {
  reference: SidecarRef;
  sidecar: TranscriptSidecar;
}

export interface TranscriptWorkspace {
  dispatcher: OperationDispatcher;
  sidecars: TranscriptSidecar[];
  writes: Map<string, string>;
}

interface LocatedWord {
  document: TranscriptDocument;
  segment: TranscriptSegment;
  segmentIndex: number;
  word: TranscriptWord;
  wordId: string;
  wordIndex: number;
}

interface LocatedSegment {
  document: TranscriptDocument;
  segment: TranscriptSegment;
  segmentIndex: number;
}

type TranscriptIdFactory = (
  prefix: IdPrefix | "seg" | "spk",
) => string;

function operationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareTime(left: SampleTime, right: SampleTime): number {
  const difference = BigInt(left.samples) * BigInt(right.rate) -
    BigInt(right.samples) * BigInt(left.rate);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function compareWords(
  leftId: string,
  left: TranscriptWord,
  rightId: string,
  right: TranscriptWord,
): number {
  return compareTime(left.start, right.start) ||
    compareTime(left.end, right.end) ||
    leftId.localeCompare(rightId);
}

function sortSegmentWords(sidecar: TranscriptSidecar, segment: TranscriptSegment): void {
  segment.words.sort((leftId, rightId) =>
    compareWords(leftId, sidecar.words[leftId]!, rightId, sidecar.words[rightId]!));
}

function displayToken(word: TranscriptWord): string {
  return `${word.punctBefore}${word.text}${word.punctAfter}`;
}

function tokenParts(raw: string): {
  text: string;
  punctBefore: string;
  punctAfter: string;
} {
  const token = raw.trim();
  const punctBefore = token.match(/^\p{P}*/u)?.[0] ?? "";
  const withoutBefore = token.slice(punctBefore.length);
  const punctAfter = withoutBefore.match(/\p{P}*$/u)?.[0] ?? "";
  const text = withoutBefore.slice(0, withoutBefore.length - punctAfter.length);
  if (text === "") throw new TypeError(`Transcript token ${JSON.stringify(raw)} has no spoken text.`);
  return { text, punctBefore, punctAfter };
}

function characterCount(value: string): number {
  return [...value].length;
}

function partition(
  start: SampleTime,
  end: SampleTime,
  tokens: readonly string[],
): Array<{ start: SampleTime; end: SampleTime }> {
  if (start.rate !== end.rate || start.samples >= end.samples) {
    throw new RangeError("Interpolation requires a positive same-rate time span.");
  }
  const counts = tokens.map((token) => characterCount(tokenParts(token).text));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const duration = BigInt(end.samples - start.samples);
  let consumed = 0;
  return counts.map((count, index) => {
    const from = BigInt(start.samples) + duration * BigInt(consumed) / BigInt(total);
    consumed += count;
    const to = index + 1 === counts.length
      ? BigInt(end.samples)
      : BigInt(start.samples) + duration * BigInt(consumed) / BigInt(total);
    if (from >= to) throw new RangeError("Interpolation span is too short for the replacement tokens.");
    return {
      start: { samples: Number(from), rate: start.rate },
      end: { samples: Number(to), rate: end.rate },
    };
  });
}

function averageConfidence(words: readonly TranscriptWord[]): number | null {
  const values = words.flatMap(({ confidence }) => confidence === null ? [] : [confidence]);
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function findWord(
  documents: readonly TranscriptDocument[],
  wordId: string,
): LocatedWord | undefined {
  let located: LocatedWord | undefined;
  for (const document of documents) {
    const word = document.sidecar.words[wordId];
    if (word === undefined) continue;
    for (const [segmentIndex, segment] of document.sidecar.segments.entries()) {
      const wordIndex = segment.words.indexOf(wordId);
      if (wordIndex === -1) continue;
      if (located !== undefined) {
        throw new TypeError(`Project-global word ID ${wordId} occurs in more than one transcript.`);
      }
      located = { document, segment, segmentIndex, word, wordId, wordIndex };
    }
  }
  return located;
}

function findSegment(
  documents: readonly TranscriptDocument[],
  segmentId: string,
): LocatedSegment | undefined {
  for (const document of documents) {
    const segmentIndex = document.sidecar.segments.findIndex(({ id }) => id === segmentId);
    if (segmentIndex !== -1) {
      return {
        document,
        segment: document.sidecar.segments[segmentIndex]!,
        segmentIndex,
      };
    }
  }
  return undefined;
}

function updateReference(
  project: GuyditorProject,
  document: TranscriptDocument,
  writes: Map<string, string>,
): GuyditorProject {
  const content = serializeTranscriptSidecar(document.sidecar);
  const reference = { ...document.reference, sha256: hash(content) };
  document.reference = reference;
  writes.set(reference.path, content);
  return {
    ...project,
    sidecars: project.sidecars.map((candidate) =>
      candidate.name === reference.name ? reference : candidate),
  };
}

function allocateWordIds(
  project: GuyditorProject,
  count: number,
): Result<{ ids: string[]; project: GuyditorProject }> {
  const first = project.transcript.nextWordOrdinal;
  const next = first + count;
  if (first < 0 || next > 999_999) {
    return operationFailure(
      "E_TRANSCRIPT_WORD_ID_EXHAUSTED",
      "The six-digit project-global word ordinal space is exhausted.",
    );
  }
  return success({
    ids: Array.from({ length: count }, (_, index) => formatWordId(first + index)),
    project: { ...project, transcript: { nextWordOrdinal: next } },
  });
}

function correction(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
) {
  const wordId = input.params["wordId"] as string;
  const located = findWord(documents, wordId);
  if (located === undefined) {
    return operationFailure("E_TRANSCRIPT_WORD_NOT_FOUND", `Word ${wordId} does not exist.`, [wordId]);
  }
  if (located.word.state !== "active") {
    return operationFailure("E_TRANSCRIPT_WORD_DELETED", `Word ${wordId} is deleted.`, [wordId]);
  }
  const previous = {
    text: located.word.text,
    punctBefore: located.word.punctBefore,
    punctAfter: located.word.punctAfter,
  };
  const text = input.params["text"] as string | undefined;
  if (text !== undefined && (/\p{P}/u.test(text) || text.trim() !== text)) {
    return operationFailure(
      "E_TRANSCRIPT_TOKEN_INVALID",
      "transcript.word.correct text must be a bare spoken token; punctuation has separate fields.",
      [wordId],
    );
  }
  located.document.sidecar.words[wordId] = {
    ...located.word,
    ...(text === undefined ? {} : { text }),
    ...(input.params["punctBefore"] === undefined
      ? {}
      : { punctBefore: input.params["punctBefore"] as string }),
    ...(input.params["punctAfter"] === undefined
      ? {}
      : { punctAfter: input.params["punctAfter"] as string }),
    origin: "correction",
  };
  return success({
    model: updateReference(project, located.document, writes),
    inverse: [{ op: input.op, params: { wordId, ...previous } }],
    affected: [wordId],
    summary: `Correct word ${wordId}`,
  });
}

function replacement(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
) {
  const wordIds = input.params["wordIds"] as string[];
  const tokens = input.params["tokens"] as string[];
  const locations = wordIds.map((wordId) => findWord(documents, wordId));
  if (locations.some((located) => located === undefined)) {
    const missing = wordIds.filter((_, index) => locations[index] === undefined);
    return operationFailure(
      "E_TRANSCRIPT_WORD_NOT_FOUND",
      `Replacement words do not exist: ${missing.join(", ")}.`,
      missing,
    );
  }
  const selected = locations as LocatedWord[];
  const document = selected[0]!.document;
  const segment = selected[0]!.segment;
  if (selected.some((located) => located.document !== document || located.segment !== segment)) {
    return operationFailure(
      "E_TRANSCRIPT_WORD_RANGE",
      "Replacement words must be in one segment.",
      wordIds,
    );
  }
  const allActive = selected.every(({ word }) => word.state === "active");
  const allRestorableTombstones = selected.every(({ word }) =>
    word.state === "deleted" && word.replacedBy === undefined);
  if (!allActive && !allRestorableTombstones) {
    return operationFailure(
      "E_TRANSCRIPT_WORD_DELETED",
      "Replacement words must be active or unreplaced tombstones from an inverse.",
      wordIds,
    );
  }
  const comparableOrder = allActive
    ? segment.words.filter((wordId) => document.sidecar.words[wordId]?.state === "active")
    : segment.words;
  const indexes = selected
    .map(({ wordId }) => comparableOrder.indexOf(wordId))
    .sort((left, right) => left - right);
  if (indexes.some((index, position) => position > 0 && index !== indexes[position - 1]! + 1)) {
    return operationFailure(
      "E_TRANSCRIPT_WORD_RANGE",
      "Replacement words must be contiguous in segment order.",
      wordIds,
    );
  }
  const temporallySorted = [...selected].sort((left, right) =>
    compareWords(left.wordId, left.word, right.wordId, right.word));
  const start = temporallySorted[0]!.word.start;
  const end = temporallySorted.at(-1)!.word.end;
  let spans: Array<{ start: SampleTime; end: SampleTime }>;
  try {
    spans = partition(start, end, tokens);
  } catch (error: unknown) {
    return operationFailure(
      "E_TRANSCRIPT_INTERPOLATION",
      error instanceof Error ? error.message : String(error),
      wordIds,
    );
  }
  const allocated = allocateWordIds(project, tokens.length);
  if (!allocated.ok) return allocated;
  const confidence = averageConfidence(selected.map(({ word }) => word));
  for (const [index, newWordId] of allocated.value.ids.entries()) {
    document.sidecar.words[newWordId] = {
      ...tokenParts(tokens[index]!),
      ...spans[index]!,
      confidence,
      alignment: "interpolated",
      state: "active",
      origin: "correction",
    };
    segment.words.push(newWordId);
  }
  for (const located of selected) {
    document.sidecar.words[located.wordId] = {
      ...located.word,
      state: "deleted",
      replacedBy: [...allocated.value.ids],
    };
  }
  sortSegmentWords(document.sidecar, segment);
  const model = updateReference(allocated.value.project, document, writes);
  return success({
    model,
    inverse: [{
      op: input.op,
      params: {
        wordIds: allocated.value.ids,
        tokens: temporallySorted.map(({ word }) => displayToken(word)),
      },
    }],
    affected: [...wordIds, ...allocated.value.ids],
    summary: `Replace ${String(wordIds.length)} words with ${String(tokens.length)} tokens`,
  });
}

function insertion(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
) {
  const segmentId = input.params["segmentId"] as string;
  const afterWordId = input.params["afterWordId"] as string | null;
  const tokens = input.params["tokens"] as string[];
  const located = findSegment(documents, segmentId);
  if (located === undefined) {
    return operationFailure(
      "E_TRANSCRIPT_SEGMENT_NOT_FOUND",
      `Segment ${segmentId} does not exist.`,
      [segmentId],
    );
  }
  const active = located.segment.words.filter((wordId) =>
    located.document.sidecar.words[wordId]?.state === "active");
  let left = located.segment.start;
  let right: SampleTime | undefined;
  if (afterWordId === null) {
    const first = active[0];
    right = first === undefined
      ? located.segment.end
      : located.document.sidecar.words[first]!.start;
  } else {
    const afterIndex = active.indexOf(afterWordId);
    if (afterIndex === -1) {
      return operationFailure(
        "E_TRANSCRIPT_WORD_RANGE",
        `afterWordId ${afterWordId} is not active in segment ${segmentId}.`,
        [segmentId, afterWordId],
      );
    }
    left = located.document.sidecar.words[afterWordId]!.end;
    const next = active[afterIndex + 1];
    right = next === undefined
      ? located.segment.end
      : located.document.sidecar.words[next]!.start;
  }
  let spans: Array<{ start: SampleTime; end: SampleTime }>;
  try {
    spans = partition(left, right, tokens);
  } catch (error: unknown) {
    return operationFailure(
      "E_TRANSCRIPT_INSERT_GAP",
      `Words cannot be inserted without a positive neighbor gap: ${
        error instanceof Error ? error.message : String(error)
      }`,
      [segmentId],
    );
  }
  const allocated = allocateWordIds(project, tokens.length);
  if (!allocated.ok) return allocated;
  for (const [index, wordId] of allocated.value.ids.entries()) {
    located.document.sidecar.words[wordId] = {
      ...tokenParts(tokens[index]!),
      ...spans[index]!,
      confidence: null,
      alignment: "interpolated",
      state: "active",
      origin: "correction",
    };
    located.segment.words.push(wordId);
  }
  sortSegmentWords(located.document.sidecar, located.segment);
  return success({
    model: updateReference(allocated.value.project, located.document, writes),
    inverse: [{
      op: "transcript.word.delete",
      params: { wordIds: allocated.value.ids },
    }],
    affected: [segmentId, ...allocated.value.ids],
    summary: `Insert ${String(tokens.length)} words in segment ${segmentId}`,
  });
}

function deletion(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
) {
  const wordIds = input.params["wordIds"] as string[];
  const locations = wordIds.map((wordId) => findWord(documents, wordId));
  if (locations.some((located) => located === undefined)) {
    return operationFailure("E_TRANSCRIPT_WORD_NOT_FOUND", "A deleted word does not exist.", wordIds);
  }
  const selected = locations as LocatedWord[];
  if (selected.some(({ word }) => word.state !== "active")) {
    return operationFailure("E_TRANSCRIPT_WORD_DELETED", "A selected word is already deleted.", wordIds);
  }
  const byDocument = new Set(selected.map(({ document }) => document));
  let model = project;
  for (const document of byDocument) {
    const inDocument = selected.filter((located) => located.document === document);
    for (const located of inDocument) {
      document.sidecar.words[located.wordId] = { ...located.word, state: "deleted" };
    }
    model = updateReference(model, document, writes);
  }
  return success({
    model,
    inverse: selected.map(({ wordId, word }) => ({
      op: "transcript.word.replace",
      params: { wordIds: [wordId], tokens: [displayToken(word)] },
    })),
    affected: wordIds,
    summary: `Delete ${String(wordIds.length)} transcript words`,
  });
}

function retime(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
) {
  const wordId = input.params["wordId"] as string;
  const located = findWord(documents, wordId);
  if (located === undefined) {
    return operationFailure("E_TRANSCRIPT_WORD_NOT_FOUND", `Word ${wordId} does not exist.`, [wordId]);
  }
  if (located.word.state !== "active") {
    return operationFailure("E_TRANSCRIPT_WORD_DELETED", `Word ${wordId} is deleted.`, [wordId]);
  }
  const start = (input.params["start"] as SampleTime | undefined) ?? located.word.start;
  const end = (input.params["end"] as SampleTime | undefined) ?? located.word.end;
  if (
    start.rate !== located.document.sidecar.audio.rate ||
    end.rate !== located.document.sidecar.audio.rate ||
    start.samples >= end.samples ||
    start.samples < located.segment.start.samples ||
    end.samples > located.segment.end.samples
  ) {
    return operationFailure(
      "E_TRANSCRIPT_RETIME_RANGE",
      "Word retiming must be a positive native-rate interval inside its segment.",
      [wordId],
    );
  }
  const active = located.segment.words.filter((candidate) =>
    located.document.sidecar.words[candidate]?.state === "active");
  const activeIndex = active.indexOf(wordId);
  const previous = active[activeIndex - 1];
  const next = active[activeIndex + 1];
  if (
    (previous !== undefined &&
      located.document.sidecar.words[previous]!.end.samples > start.samples) ||
    (next !== undefined && end.samples > located.document.sidecar.words[next]!.start.samples)
  ) {
    return operationFailure(
      "E_TRANSCRIPT_RETIME_ORDER",
      "Word retiming may not reorder or overlap active neighbors.",
      [wordId, ...(previous === undefined ? [] : [previous]), ...(next === undefined ? [] : [next])],
    );
  }
  const prior = { start: located.word.start, end: located.word.end };
  located.document.sidecar.words[wordId] = {
    ...located.word,
    start,
    end,
    alignment: "manual",
  };
  sortSegmentWords(located.document.sidecar, located.segment);
  return success({
    model: updateReference(project, located.document, writes),
    inverse: [{ op: input.op, params: { wordId, ...prior } }],
    affected: [wordId],
    summary: `Retime word ${wordId}`,
  });
}

interface PickupRestore {
  words: Array<{ wordId: string; word: TranscriptWord }>;
  layers: Layer[];
}

function sampleFrame(
  time: SampleTime,
  fps: string,
): Result<number> {
  const converted = convertTimeRounding(
    { frames: time.samples, fps: `${String(time.rate)}/1` },
    fps,
  );
  return converted.ok ? success(converted.value.time.frames) : converted;
}

function pickupSplice(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
  idFactory: TranscriptIdFactory,
) {
  const repairedWordIds = input.params["repairedWordIds"] as string[];
  const located = repairedWordIds.map((wordId) => findWord(documents, wordId));
  if (located.some((word) => word === undefined)) {
    return operationFailure(
      "E_TRANSCRIPT_WORD_NOT_FOUND",
      "A pickup repair word does not exist.",
      repairedWordIds,
    );
  }
  const selected = located as LocatedWord[];
  const document = selected[0]!.document;
  if (selected.some((word) => word.document !== document)) {
    return operationFailure(
      "E_TRANSCRIPT_WORD_RANGE",
      "Pickup repair words must belong to one canonical transcript.",
      repairedWordIds,
    );
  }
  const restore = input.params["restore"] as PickupRestore | undefined;
  if (restore !== undefined) {
    for (const { wordId, word } of restore.words) {
      document.sidecar.words[wordId] = structuredClone(word);
    }
    return success({
      model: updateReference(
        { ...project, layers: structuredClone(restore.layers) },
        document,
        writes,
      ),
      inverse: [],
      affected: repairedWordIds,
      summary: `Restore ${String(repairedWordIds.length)} words before pickup splice`,
    });
  }
  const pickupAssetId = input.params["pickupAssetId"] as string;
  const pickupAsset = project.assets.find(({ id }) => id === pickupAssetId);
  if (pickupAsset === undefined) {
    return operationFailure(
      "E_OP_NOT_FOUND",
      `Pickup asset ${pickupAssetId} does not exist.`,
      [pickupAssetId],
    );
  }
  if (pickupAsset.kind !== "audio" && pickupAsset.kind !== "video") {
    return operationFailure(
      "E_PICKUP_MEDIA_KIND",
      `Pickup asset ${pickupAssetId} has no playable audio source.`,
      [pickupAssetId],
    );
  }
  const updates = input.params["wordUpdates"] as Array<{ wordId: string; word: TranscriptWord }>;
  if (
    updates.length !== repairedWordIds.length ||
    updates.some(({ wordId }, index) => wordId !== repairedWordIds[index])
  ) {
    return operationFailure(
      "E_PICKUP_WORD_MISMATCH",
      "Pickup word updates must exactly match the repaired word range.",
      repairedWordIds,
    );
  }
  const priorWords = selected.map(({ wordId, word }) => ({
    wordId,
    word: structuredClone(word),
  }));
  for (const { wordId, word } of updates) {
    if (word.origin !== "pickup" || word.state !== "active") {
      return operationFailure(
        "E_PICKUP_WORD_MISMATCH",
        `Pickup update ${wordId} must be an active pickup-origin word.`,
        [wordId],
      );
    }
    document.sidecar.words[wordId] = structuredClone(word);
  }
  const pickupRange = input.params["pickupRange"] as { in: SampleTime; out: SampleTime };
  const fps = project.settings.timeline.fps;
  const sourceIn = sampleFrame(pickupRange.in, fps);
  if (!sourceIn.ok) return sourceIn;
  const sourceOut = sampleFrame(pickupRange.out, fps);
  if (!sourceOut.ok) return sourceOut;
  if (sourceIn.value >= sourceOut.value) {
    return operationFailure(
      "E_PICKUP_RANGE",
      "Pickup range must have positive exact duration.",
      [pickupAssetId],
    );
  }
  const existingLayer = project.layers.find(({ kind, name }) => kind === "audio" && name === "Pickups");
  const layerId = existingLayer?.id ?? idFactory("lyr");
  const itemId = idFactory("clp");
  const item = {
    id: itemId,
    asset: pickupAssetId,
    at: `word:${repairedWordIds[0]!}` as const,
    duration: { frames: sourceOut.value - sourceIn.value, fps },
    source: {
      in: { frames: sourceIn.value, fps },
      out: { frames: sourceOut.value, fps },
    },
    params: {
      pickup: {
        repairedWordIds: [...repairedWordIds],
        roomTonePaddingMs: input.params["roomTonePaddingMs"],
        ...(input.params["trigger"] === undefined
          ? {}
          : { trigger: structuredClone(input.params["trigger"]) }),
      },
    },
  };
  const layers = existingLayer === undefined
    ? [...project.layers, {
        id: layerId,
        kind: "audio" as const,
        name: "Pickups",
        order: project.layers.filter(({ kind }) => kind === "audio").length,
        enabled: true,
        locked: false,
        items: [item],
      }]
    : project.layers.map((layer) => layer.id === layerId
      ? { ...layer, items: [...(layer.items ?? []), item] }
      : layer);
  return success({
    model: updateReference({ ...project, layers }, document, writes),
    inverse: [{
      op: input.op,
      params: {
        ...structuredClone(input.params),
        restore: { words: priorWords, layers: structuredClone(project.layers) },
      },
    }],
    affected: [pickupAssetId, itemId, layerId, ...repairedWordIds],
    summary: `Replace ${repairedWordIds[0]}..${repairedWordIds.at(-1)} with pickup ${pickupAssetId}`,
  });
}

function segmentSplit(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
  idFactory: TranscriptIdFactory,
) {
  const segmentId = input.params["segmentId"] as string;
  const beforeWordId = input.params["beforeWordId"] as string;
  const located = findSegment(documents, segmentId);
  if (located === undefined) {
    return operationFailure("E_TRANSCRIPT_SEGMENT_NOT_FOUND", `Segment ${segmentId} does not exist.`, [segmentId]);
  }
  const boundary = located.segment.words.indexOf(beforeWordId);
  if (boundary <= 0) {
    return operationFailure(
      "E_TRANSCRIPT_SEGMENT_SPLIT",
      `Segment ${segmentId} must retain at least one word before ${beforeWordId}.`,
      [segmentId, beforeWordId],
    );
  }
  const headWords = located.segment.words.slice(0, boundary);
  const tailWords = located.segment.words.slice(boundary);
  const newSegmentId = idFactory("seg");
  if (findSegment(documents, newSegmentId) !== undefined) {
    return operationFailure("E_TRANSCRIPT_ID_CONFLICT", `Segment ID ${newSegmentId} already exists.`, [newSegmentId]);
  }
  const headEnd = headWords
    .map((wordId) => located.document.sidecar.words[wordId]!.end)
    .reduce((latest, candidate) => compareTime(latest, candidate) < 0 ? candidate : latest);
  const tailStart = tailWords
    .map((wordId) => located.document.sidecar.words[wordId]!.start)
    .reduce((earliest, candidate) => compareTime(candidate, earliest) < 0 ? candidate : earliest);
  const head: TranscriptSegment = {
    ...located.segment,
    end: headEnd,
    words: headWords,
  };
  const tail: TranscriptSegment = {
    ...located.segment,
    id: newSegmentId,
    start: tailStart,
    words: tailWords,
  };
  located.document.sidecar.segments.splice(located.segmentIndex, 1, head, tail);
  return success({
    model: updateReference(project, located.document, writes),
    inverse: [{
      op: "transcript.segment.merge",
      params: { segmentIds: [segmentId, newSegmentId] },
    }],
    affected: [segmentId, newSegmentId],
    summary: `Split segment ${segmentId} before ${beforeWordId}`,
  });
}

function segmentMerge(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
) {
  const segmentIds = input.params["segmentIds"] as string[];
  const locations = segmentIds.map((segmentId) => findSegment(documents, segmentId));
  if (locations.some((located) => located === undefined)) {
    return operationFailure("E_TRANSCRIPT_SEGMENT_NOT_FOUND", "A merged segment does not exist.", segmentIds);
  }
  const selected = locations as LocatedSegment[];
  const document = selected[0]!.document;
  if (selected.some((located) => located.document !== document)) {
    return operationFailure("E_TRANSCRIPT_SEGMENT_MERGE", "Merged segments must share a sidecar.", segmentIds);
  }
  if (selected.some((located, index) =>
    index > 0 && located.segmentIndex !== selected[index - 1]!.segmentIndex + 1)) {
    return operationFailure("E_TRANSCRIPT_SEGMENT_MERGE", "Merged segments must be adjacent and ordered.", segmentIds);
  }
  const boundaries = selected.slice(1).map(({ segment }) => segment.words[0]!);
  const first = selected[0]!.segment;
  const last = selected.at(-1)!.segment;
  const merged: TranscriptSegment = {
    ...first,
    end: last.end,
    words: selected.flatMap(({ segment }) => segment.words),
  };
  sortSegmentWords(document.sidecar, merged);
  document.sidecar.segments.splice(
    selected[0]!.segmentIndex,
    selected.length,
    merged,
  );
  return success({
    model: updateReference(project, document, writes),
    inverse: boundaries.map((beforeWordId) => ({
      op: "transcript.segment.split",
      params: { segmentId: first.id, beforeWordId },
    })),
    affected: segmentIds,
    summary: `Merge ${String(segmentIds.length)} transcript segments`,
  });
}

function ensureSpeaker(sidecar: TranscriptSidecar, speakerId: string): void {
  if (!sidecar.speakers.some(({ id }) => id === speakerId)) {
    sidecar.speakers.push({ id: speakerId, label: speakerId });
  }
}

function segmentBounds(
  sidecar: TranscriptSidecar,
  original: TranscriptSegment,
  words: readonly string[],
  firstPiece: boolean,
  lastPiece: boolean,
): Pick<TranscriptSegment, "start" | "end"> {
  return {
    start: firstPiece
      ? original.start
      : words
          .map((wordId) => sidecar.words[wordId]!.start)
          .reduce((earliest, candidate) =>
            compareTime(candidate, earliest) < 0 ? candidate : earliest),
    end: lastPiece
      ? original.end
      : words
          .map((wordId) => sidecar.words[wordId]!.end)
          .reduce((latest, candidate) =>
            compareTime(latest, candidate) < 0 ? candidate : latest),
  };
}

function assignWordRange(
  document: TranscriptDocument,
  fromWord: string,
  toWord: string,
  speakerId: string,
  idFactory: TranscriptIdFactory,
): Result<Array<{ segmentId: string; previousSpeaker: string }>> {
  const ordered = document.sidecar.segments.flatMap(({ words }) => words);
  const from = ordered.indexOf(fromWord);
  const to = ordered.indexOf(toWord);
  if (from === -1 || to < from) {
    return operationFailure(
      "E_TRANSCRIPT_WORD_RANGE",
      `Speaker word range ${fromWord}..${toWord} is invalid.`,
      [fromWord, toWord],
    );
  }
  const selected = new Set(ordered.slice(from, to + 1));
  const replacements: TranscriptSegment[] = [];
  const changed: Array<{ segmentId: string; previousSpeaker: string }> = [];
  for (const original of document.sidecar.segments) {
    const runs: Array<{ selected: boolean; words: string[] }> = [];
    for (const wordId of original.words) {
      const isSelected = selected.has(wordId);
      const current = runs.at(-1);
      if (current?.selected === isSelected) current.words.push(wordId);
      else runs.push({ selected: isSelected, words: [wordId] });
    }
    for (const [runIndex, run] of runs.entries()) {
      const id = runIndex === 0 ? original.id : idFactory("seg");
      const assignedSpeaker = run.selected ? speakerId : original.speaker;
      replacements.push({
        ...original,
        id,
        speaker: assignedSpeaker,
        ...segmentBounds(
          document.sidecar,
          original,
          run.words,
          runIndex === 0,
          runIndex + 1 === runs.length,
        ),
        words: run.words,
      });
      if (run.selected && assignedSpeaker !== original.speaker) {
        changed.push({ segmentId: id, previousSpeaker: original.speaker });
      }
    }
  }
  document.sidecar.segments = replacements;
  return success(changed);
}

function speakerAssign(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
  idFactory: TranscriptIdFactory,
) {
  const speakerId = input.params["speakerId"] as string;
  const segmentIds = input.params["segmentIds"] as string[] | undefined;
  const wordRange = input.params["wordRange"] as {
    fromWord: string;
    toWord: string;
  } | undefined;
  const inverseBySpeaker = new Map<string, string[]>();
  const touched = new Set<TranscriptDocument>();
  if (segmentIds !== undefined) {
    for (const segmentId of segmentIds) {
      const located = findSegment(documents, segmentId);
      if (located === undefined) {
        return operationFailure("E_TRANSCRIPT_SEGMENT_NOT_FOUND", `Segment ${segmentId} does not exist.`, [segmentId]);
      }
      ensureSpeaker(located.document.sidecar, speakerId);
      const prior = inverseBySpeaker.get(located.segment.speaker) ?? [];
      prior.push(segmentId);
      inverseBySpeaker.set(located.segment.speaker, prior);
      located.segment.speaker = speakerId;
      touched.add(located.document);
    }
  }
  if (wordRange !== undefined) {
    const from = findWord(documents, wordRange.fromWord);
    const to = findWord(documents, wordRange.toWord);
    if (from === undefined || to === undefined || from.document !== to.document) {
      return operationFailure(
        "E_TRANSCRIPT_WORD_RANGE",
        "Speaker word range endpoints must exist in one sidecar.",
        [wordRange.fromWord, wordRange.toWord],
      );
    }
    ensureSpeaker(from.document.sidecar, speakerId);
    const assigned = assignWordRange(
      from.document,
      wordRange.fromWord,
      wordRange.toWord,
      speakerId,
      idFactory,
    );
    if (!assigned.ok) return assigned;
    for (const change of assigned.value) {
      const prior = inverseBySpeaker.get(change.previousSpeaker) ?? [];
      prior.push(change.segmentId);
      inverseBySpeaker.set(change.previousSpeaker, prior);
    }
    touched.add(from.document);
  }
  let model = project;
  for (const document of touched) model = updateReference(model, document, writes);
  return success({
    model,
    inverse: [...inverseBySpeaker].map(([previousSpeaker, priorSegmentIds]) => ({
      op: input.op,
      params: { speakerId: previousSpeaker, segmentIds: priorSegmentIds },
    })),
    affected: [speakerId, ...(segmentIds ?? []),
      ...(wordRange === undefined ? [] : [wordRange.fromWord, wordRange.toWord])],
    summary: `Assign speaker ${speakerId}`,
  });
}

interface RealignUpdate {
  wordId: string;
  start: SampleTime;
  end: SampleTime;
  confidence: number | null;
  alignment: TranscriptAlignment;
}

function realign(
  documents: readonly TranscriptDocument[],
  project: GuyditorProject,
  input: OperationInput,
  writes: Map<string, string>,
) {
  const assetId = input.params["assetId"] as string;
  const document = documents.find(({ sidecar }) => sidecar.assetId === assetId);
  if (document === undefined) {
    return operationFailure(
      "E_TRANSCRIPT_ASSET_NOT_FOUND",
      `Asset ${assetId} has no canonical transcript.`,
      [assetId],
    );
  }
  const updates = input.params["updates"] as RealignUpdate[];
  const wordIds = updates.map(({ wordId }) => wordId);
  if (new Set(wordIds).size !== wordIds.length) {
    return operationFailure(
      "E_TRANSCRIPT_REALIGN_DUPLICATE",
      "A realignment transaction may update each word at most once.",
      wordIds,
    );
  }
  const previous: RealignUpdate[] = [];
  const candidates = new Map<string, TranscriptWord>();
  for (const update of updates) {
    const located = findWord([document], update.wordId);
    if (located === undefined || located.word.state !== "active") {
      return operationFailure(
        "E_TRANSCRIPT_WORD_NOT_FOUND",
        `Realigned word ${update.wordId} is not active in asset ${assetId}.`,
        [assetId, update.wordId],
      );
    }
    previous.push({
      wordId: update.wordId,
      start: located.word.start,
      end: located.word.end,
      confidence: located.word.confidence,
      alignment: located.word.alignment,
    });
    candidates.set(update.wordId, {
      ...located.word,
      start: update.start,
      end: update.end,
      confidence: update.confidence,
      alignment: update.alignment,
    });
  }
  for (const segment of document.sidecar.segments) {
    let previousEnd: SampleTime | undefined;
    for (const wordId of segment.words) {
      const original = document.sidecar.words[wordId];
      if (original?.state !== "active") continue;
      const word = candidates.get(wordId) ?? original;
      if (
        word.start.rate !== document.sidecar.audio.rate ||
        word.end.rate !== document.sidecar.audio.rate ||
        compareTime(word.start, word.end) >= 0 ||
        compareTime(word.start, segment.start) < 0 ||
        compareTime(word.end, segment.end) > 0 ||
        (previousEnd !== undefined && compareTime(previousEnd, word.start) > 0)
      ) {
        return operationFailure(
          "E_TRANSCRIPT_REALIGN_RANGE",
          `Realignment would make ${wordId} invalid or overlap its active neighbor.`,
          [assetId, wordId],
        );
      }
      previousEnd = word.end;
    }
  }
  for (const [wordId, word] of candidates) document.sidecar.words[wordId] = word;
  const previousAlignment = document.sidecar.provenance.alignment;
  const previousProvisional = document.sidecar.provisional;
  document.sidecar.provenance = {
    ...document.sidecar.provenance,
    alignment: input.params["alignment"] as TranscriptEngineIdentity | null,
  };
  const provisional = input.params["provisional"] as boolean | null | undefined;
  if (provisional === true || provisional === false) document.sidecar.provisional = provisional;
  else delete document.sidecar.provisional;
  const wordRange = input.params["wordRange"] as {
    fromWord: string;
    toWord: string;
  } | undefined;
  return success({
    model: updateReference(project, document, writes),
    inverse: [{
      op: input.op,
      params: {
        assetId,
        ...(wordRange === undefined ? {} : { wordRange }),
        updates: previous,
        alignment: previousAlignment,
        provisional: previousProvisional ?? null,
        jobId: input.params["jobId"],
      },
    }],
    affected: [assetId, ...wordIds],
    summary: `Realign ${String(updates.length)} transcript words for ${assetId}`,
  });
}

function dispatcher(
  documents: readonly TranscriptDocument[],
  writes: Map<string, string>,
  idFactory: TranscriptIdFactory,
): OperationDispatcher {
  return (project, input) => {
    try {
      const rangeOperation = applyTranscriptRangeOperation(
        project,
        input,
        documents.map(({ sidecar }) => sidecar),
        idFactory,
      );
      if (rangeOperation !== undefined) return rangeOperation;
      const captionOperation = applyCaptionOperation(project, input, idFactory);
      if (captionOperation !== undefined) return captionOperation;
      switch (input.op) {
        case "transcript.word.correct":
          return correction(documents, project, input, writes);
        case "transcript.word.replace":
          return replacement(documents, project, input, writes);
        case "transcript.word.insert":
          return insertion(documents, project, input, writes);
        case "transcript.word.delete":
          return deletion(documents, project, input, writes);
        case "transcript.word.retime":
          return retime(documents, project, input, writes);
        case "transcript.segment.split":
          return segmentSplit(documents, project, input, writes, idFactory);
        case "transcript.segment.merge":
          return segmentMerge(documents, project, input, writes);
        case "transcript.speaker.assign":
          return speakerAssign(documents, project, input, writes, idFactory);
        case "transcript.realign":
          return realign(documents, project, input, writes);
        case "pickup.splice":
          return pickupSplice(documents, project, input, writes, idFactory);
        default:
          return operationFailure(
            "E_TRANSCRIPT_DISPATCH",
            `Transcript workspace cannot dispatch ${input.op}.`,
            [input.op],
          );
      }
    } catch (error: unknown) {
      return operationFailure(
        "E_TRANSCRIPT_OPERATION",
        error instanceof Error ? error.message : String(error),
        [input.op],
      );
    }
  };
}

export function createTranscriptWorkspace(
  sidecars: TranscriptSidecar[],
  references: SidecarRef[],
  idFactory: TranscriptIdFactory,
): TranscriptWorkspace {
  if (sidecars.length !== references.length) {
    throw new RangeError("Transcript sidecars and references must have matching lengths.");
  }
  const documents = sidecars.map((sidecar, index) => ({
    sidecar,
    reference: references[index]!,
  }));
  const writes = new Map<string, string>();
  return {
    dispatcher: dispatcher(documents, writes, idFactory),
    sidecars,
    writes,
  };
}

export async function loadTranscriptWorkspace(
  project: ProjectStore,
  idFactory: TranscriptIdFactory,
): Promise<Result<TranscriptWorkspace>> {
  const documents: TranscriptDocument[] = [];
  try {
    for (const reference of project.currentProject.sidecars) {
      if (reference.schema !== TRANSCRIPT_SCHEMA) continue;
      const content = await readFile(join(project.root, reference.path), "utf8");
      if (hash(content) !== reference.sha256) {
        return operationFailure(
          "E_SIDECAR_MODIFIED",
          `Transcript sidecar ${reference.path} does not match its registered SHA-256.`,
          [reference.name],
        );
      }
      documents.push({ reference, sidecar: parseTranscriptSidecar(content) });
    }
    const allWordIds = documents.flatMap(({ sidecar }) => Object.keys(sidecar.words));
    if (new Set(allWordIds).size !== allWordIds.length) {
      return operationFailure(
        "E_TRANSCRIPT_WORD_ID_CONFLICT",
        "Canonical transcript sidecars contain duplicate project-global word IDs.",
        allWordIds,
      );
    }
    const writes = new Map<string, string>();
    return success({
      dispatcher: dispatcher(documents, writes, idFactory),
      sidecars: documents.map(({ sidecar }) => sidecar),
      writes,
    });
  } catch (error: unknown) {
    return operationFailure(
      "E_TRANSCRIPT_LOAD",
      `Could not load canonical transcript sidecars: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
