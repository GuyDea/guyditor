import {
  applyClipOperation,
  convertTimeRounding,
  failure,
  makeGuyditorError,
} from "../../../core/src/index.js";
import type {
  GuyditorProject,
  OperationInput,
  Result,
} from "../../../core/src/index.js";

import type {
  FillerCandidate,
  FillerProposalPolicy,
  FillerProposalResult,
} from "./types.js";

function proposalFailure(message: string, affected: readonly string[] = []) {
  return failure(makeGuyditorError("E_FILLER_PROPOSAL", message, { affected }));
}

function sampleFrame(
  value: { samples: number; rate: number },
  fps: string,
): Result<number> {
  const converted = convertTimeRounding(
    { frames: value.samples, fps: `${String(value.rate)}/1` },
    fps,
  );
  return converted.ok ? { ok: true, value: converted.value.time.frames } : converted;
}

function primarySequence(project: GuyditorProject) {
  const deliverable = project.deliverables.find(({ id }) =>
    id === project.settings.primaryDeliverable);
  return project.sequences.find(({ id }) => id === deliverable?.sequenceId);
}

function compilePause(
  working: GuyditorProject,
  candidate: FillerCandidate,
  policy: FillerProposalPolicy,
): Result<{ model: GuyditorProject; operations: OperationInput[] }> {
  const sequence = primarySequence(working);
  if (sequence === undefined) {
    return proposalFailure("The primary sequence is unavailable.");
  }
  const operations: OperationInput[] = [];
  let model = working;
  const apply = (operation: OperationInput): Result<true> => {
    const result = applyClipOperation(model, operation, (prefix) => {
      if (prefix !== "clp" && prefix !== "fx") {
        throw new TypeError(`Unexpected ${prefix} allocation while compiling pause removal.`);
      }
      return policy.idFactory(prefix);
    });
    if (!result.ok) return result;
    model = result.value.model;
    operations.push(operation);
    return { ok: true, value: true };
  };
  for (const original of sequence.clips.filter(({ asset }) =>
    asset === candidate.sourceRange.assetId)) {
    const start = sampleFrame(candidate.sourceRange.start, original.source.in.fps);
    if (!start.ok) return start;
    const end = sampleFrame(candidate.sourceRange.end, original.source.in.fps);
    if (!end.ok) return end;
    const intervalStart = Math.max(original.source.in.frames, start.value);
    const intervalEnd = Math.min(original.source.out.frames, end.value);
    if (intervalStart >= intervalEnd) continue;
    const evidence = candidate.rule;
    if (intervalStart === original.source.in.frames && intervalEnd === original.source.out.frames) {
      const removed = apply({
        op: "clip.remove",
        params: { clipId: original.id, evidence },
      });
      if (!removed.ok) return removed;
      continue;
    }
    if (intervalStart === original.source.in.frames) {
      const trimmed = apply({
        op: "clip.trim",
        params: {
          clipId: original.id,
          edge: "head",
          delta: { frames: intervalEnd - intervalStart, fps: original.source.in.fps },
          snapPolicy: "none",
          evidence,
        },
      });
      if (!trimmed.ok) return trimmed;
      continue;
    }
    if (intervalEnd === original.source.out.frames) {
      const trimmed = apply({
        op: "clip.trim",
        params: {
          clipId: original.id,
          edge: "tail",
          delta: { frames: intervalEnd - intervalStart, fps: original.source.in.fps },
          snapPolicy: "none",
          evidence,
        },
      });
      if (!trimmed.ok) return trimmed;
      continue;
    }
    const middleId = policy.idFactory("clp");
    const firstSplit = apply({
      op: "clip.split",
      params: {
        clipId: original.id,
        at: intervalStart - original.source.in.frames,
        newClipId: middleId,
        evidence,
      },
    });
    if (!firstSplit.ok) return firstSplit;
    const middle = model.sequences.flatMap(({ clips }) => clips)
      .find(({ id }) => id === middleId);
    if (middle === undefined) return proposalFailure("Compiled pause middle clip is missing.", [middleId]);
    const afterId = policy.idFactory("clp");
    const secondSplit = apply({
      op: "clip.split",
      params: {
        clipId: middle.id,
        at: intervalEnd - middle.source.in.frames,
        newClipId: afterId,
        evidence,
      },
    });
    if (!secondSplit.ok) return secondSplit;
    const removed = apply({
      op: "clip.remove",
      params: { clipId: middleId, evidence },
    });
    if (!removed.ok) return removed;
  }
  return operations.length === 0
    ? proposalFailure("The pause candidate has no editable instance.", [candidate.id])
    : { ok: true, value: { model, operations } };
}

export function compileFillerProposal(
  candidates: readonly FillerCandidate[],
  policy: FillerProposalPolicy,
): FillerProposalResult {
  const selectedIds = policy.selectedCandidateIds === undefined
    ? new Set(candidates.filter(({ defaultSelected }) => defaultSelected).map(({ id }) => id))
    : new Set(policy.selectedCandidateIds);
  const selected = candidates.filter(({ id }) => selectedIds.has(id));
  if (selected.length === 0) {
    return Promise.resolve(proposalFailure("At least one filler candidate must be selected."));
  }
  let working = policy.engine.currentProject;
  const operations: OperationInput[] = [];
  for (const candidate of selected) {
    if (candidate.wordRange !== undefined) {
      operations.push({
        op: "transcript.range.remove",
        params: {
          wordRange: candidate.wordRange,
          paddingMs: policy.cutPaddingMs ?? 120,
          snapPolicy: "none",
          evidence: candidate.rule,
        },
      });
      continue;
    }
    const compiled = compilePause(working, candidate, policy);
    if (!compiled.ok) return Promise.resolve(compiled);
    working = compiled.value.model;
    operations.push(...compiled.value.operations);
  }
  return policy.engine.createProposal({
    operations,
    instruction: { kind: "skill-policy", text: "Review pause and filler assistance" },
    actor: { kind: "tool", id: "assist.fillers.detect" },
    reason: {
      text: "Review the selected pause and filler candidates before changing the timeline.",
      sources: selected.map(({ rule }) => ({ kind: "skill-rule" as const, ref: rule })),
    },
    addresses: [],
    warnings: selected.flatMap(({ warnings }) => warnings),
  });
}
