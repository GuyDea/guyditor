import type {
  ContinuityWarning,
  GuyditorProject,
  OperationInput,
  SampleTime as CoreSampleTime,
} from "../../core/src/index.js";
import type {
  TranscriptSidecar,
  TranscriptWord,
  TranscriptWordRange,
} from "./types.js";

export const PICKUP_ALIGNMENT_CONFIDENCE_THRESHOLD = 0.7;

export interface PickupSpliceInput {
  project: GuyditorProject;
  transcript: TranscriptSidecar;
  pickupTranscript: TranscriptSidecar;
  wordRange: TranscriptWordRange;
  pickupAssetId: string;
  pickupRange: { in: CoreSampleTime; out: CoreSampleTime };
  alignmentConfidence: number;
  roomTonePaddingMs?: number;
  trigger?: { markerId?: string; annotationId?: string };
  evaluateContinuity: (
    operation: OperationInput,
    updatedTranscript: TranscriptSidecar,
  ) => readonly ContinuityWarning[] | Promise<readonly ContinuityWarning[]>;
}

export type PickupSplicePlan =
  | {
      kind: "needs-review";
      code: "E_PICKUP_ALIGNMENT_LOW_CONFIDENCE";
      confidence: number;
      threshold: number;
      proposalCreated: false;
      message: string;
    }
  | {
      kind: "proposal";
      operation: OperationInput;
      updatedTranscript: TranscriptSidecar;
      captionUpdates: Array<{
        captionId: string;
        wordIds: string[];
        impact: "realign";
      }>;
      warnings: ContinuityWarning[];
      mechanics: {
        crossfadeAtZeroCrossings: true;
        roomTonePaddingMs: number;
        roomToneFill: true;
        clippedPhonemeCheck: true;
      };
      provenance: {
        pickupAssetId: string;
        repairedWordIds: string[];
        trigger?: PickupSpliceInput["trigger"];
      };
      reviewRequired: true;
      directApply: false;
    };

function orderedActiveWords(sidecar: TranscriptSidecar): Array<{
  id: string;
  word: TranscriptWord;
}> {
  return sidecar.segments.flatMap(({ words }) => words.flatMap((id) => {
    const word = sidecar.words[id];
    return word === undefined || word.state !== "active" ? [] : [{ id, word }];
  }));
}

function selectedRange(
  sidecar: TranscriptSidecar,
  range: TranscriptWordRange,
): Array<{ id: string; word: TranscriptWord }> {
  const ordered = orderedActiveWords(sidecar);
  const from = ordered.findIndex(({ id }) => id === range.fromWord);
  const to = ordered.findIndex(({ id }) => id === range.toWord);
  if (from === -1 || to < from) {
    throw new TypeError(`Pickup word range ${range.fromWord}..${range.toWord} is not contiguous.`);
  }
  return ordered.slice(from, to + 1);
}

function compareSample(left: CoreSampleTime, right: CoreSampleTime): number {
  const delta = BigInt(left.samples) * BigInt(right.rate) -
    BigInt(right.samples) * BigInt(left.rate);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function pickupWords(input: PickupSpliceInput): Array<{ id: string; word: TranscriptWord }> {
  return orderedActiveWords(input.pickupTranscript).filter(({ word }) =>
    compareSample(word.end, input.pickupRange.in) > 0 &&
    compareSample(word.start, input.pickupRange.out) < 0);
}

export async function planPickupSplice(
  input: PickupSpliceInput,
): Promise<PickupSplicePlan> {
  if (
    !Number.isFinite(input.alignmentConfidence) ||
    input.alignmentConfidence < PICKUP_ALIGNMENT_CONFIDENCE_THRESHOLD
  ) {
    return {
      kind: "needs-review",
      code: "E_PICKUP_ALIGNMENT_LOW_CONFIDENCE",
      confidence: input.alignmentConfidence,
      threshold: PICKUP_ALIGNMENT_CONFIDENCE_THRESHOLD,
      proposalCreated: false,
      message: "Pickup force-alignment confidence is too low to prepare a splice; review or realign the recording.",
    };
  }
  if (input.pickupTranscript.assetId !== input.pickupAssetId) {
    throw new TypeError("Pickup transcript does not belong to the requested pickup asset.");
  }
  const selected = selectedRange(input.transcript, input.wordRange);
  const replacements = pickupWords(input);
  if (replacements.length !== selected.length) {
    throw new TypeError(
      `Pickup alignment produced ${String(replacements.length)} words for ${String(selected.length)} repaired words.`,
    );
  }
  const updatedTranscript = structuredClone(input.transcript);
  const repairedWordIds = selected.map(({ id }) => id);
  for (const [index, target] of selected.entries()) {
    const pickup = replacements[index]!.word;
    updatedTranscript.words[target.id] = {
      ...structuredClone(target.word),
      text: pickup.text,
      punctBefore: pickup.punctBefore,
      punctAfter: pickup.punctAfter,
      start: structuredClone(pickup.start),
      end: structuredClone(pickup.end),
      confidence: pickup.confidence === null
        ? input.alignmentConfidence
        : pickup.confidence * input.alignmentConfidence,
      alignment: "ctc",
      origin: "pickup",
    };
  }
  const roomTonePaddingMs = input.roomTonePaddingMs ?? 120;
  const operation: OperationInput = {
    op: "pickup.splice",
    params: {
      wordRange: structuredClone(input.wordRange),
      pickupAssetId: input.pickupAssetId,
      pickupRange: structuredClone(input.pickupRange),
      roomTonePaddingMs,
      repairedWordIds,
      wordUpdates: repairedWordIds.map((wordId) => ({
        wordId,
        word: structuredClone(updatedTranscript.words[wordId]!),
      })),
      alignmentConfidence: input.alignmentConfidence,
      ...(input.trigger === undefined ? {} : { trigger: structuredClone(input.trigger) }),
    },
  };
  const warnings = [...await input.evaluateContinuity(operation, updatedTranscript)];
  return {
    kind: "proposal",
    operation,
    updatedTranscript,
    captionUpdates: input.project.captions
      .filter(({ enabled }) => enabled)
      .map(({ id }) => ({
        captionId: id,
        wordIds: [...repairedWordIds],
        impact: "realign" as const,
      })),
    warnings,
    mechanics: {
      crossfadeAtZeroCrossings: true,
      roomTonePaddingMs,
      roomToneFill: true,
      clippedPhonemeCheck: true,
    },
    provenance: {
      pickupAssetId: input.pickupAssetId,
      repairedWordIds,
      ...(input.trigger === undefined ? {} : { trigger: structuredClone(input.trigger) }),
    },
    reviewRequired: true,
    directApply: false,
  };
}
