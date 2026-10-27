import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  convertTimeRounding,
  parseAnnotationSidecar,
} from "../../../core/src/index.js";
import type {
  Annotation,
  JobQueue,
  JobRecord,
  JsonValue,
  ProjectStore,
} from "../../../core/src/index.js";

import { loadTranscriptWorkspace } from "../operations.js";
import { assessSourceRangeContinuity } from "../continuity.js";
import type { ContinuityPeaks } from "../continuity.js";
import type { SampleTime, TranscriptSidecar } from "../types.js";
import { DEFAULT_FILLER_RULE_SET, detectFillerCandidates } from "./detect.js";
import type {
  EnqueueFillerDetectionInput,
  FillerCandidate,
  FillerDetectionResult,
  FillerReviewWindow,
  FillerRuleSet,
  ProtectedSourceRange,
  VadActivity,
} from "./types.js";

export interface FillerDetectionExecutorOptions {
  project: ProjectStore;
  audioPath: (assetId: string) => string;
  loadPeaks?: (
    assetId: string,
  ) => ContinuityPeaks | undefined | Promise<ContinuityPeaks | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function terminalJob(
  queue: JobQueue,
  jobId: string,
  signal: AbortSignal,
): Promise<JobRecord> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const finish = (job: JobRecord): void => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
      resolve(job);
    };
    const abort = (): void => {
      queue.cancel(jobId);
      unsubscribe();
      reject(new Error(`Cancelled while waiting for job ${jobId}.`));
    };
    unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId === jobId && ["done", "failed", "cancelled"].includes(job.state)) finish(job);
    });
    signal.addEventListener("abort", abort, { once: true });
    const current = queue.get(jobId);
    if (current !== undefined && ["done", "failed", "cancelled"].includes(current.state)) {
      finish(current);
    }
  });
}

function nativeSample(seconds: number, rate: number): SampleTime {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new TypeError("VAD timestamps must be finite non-negative seconds.");
  }
  const samples = Math.floor(seconds * rate + 0.5);
  if (!Number.isSafeInteger(samples)) throw new RangeError("VAD timestamp is outside the safe sample range.");
  return { samples, rate };
}

function vadActivities(payload: JsonValue, sidecar: TranscriptSidecar): VadActivity[] {
  if (!isRecord(payload)) throw new TypeError("VAD result must be an object.");
  const intervals = (kind: "speech" | "silence", rmsDb: number): VadActivity[] => {
    const entries = payload[kind];
    if (!Array.isArray(entries)) throw new TypeError(`VAD result.${kind} must be an array.`);
    return entries.map((entry) => {
      if (!isRecord(entry) || typeof entry["start"] !== "number" || typeof entry["end"] !== "number") {
        throw new TypeError(`VAD result.${kind} entries require numeric start/end.`);
      }
      return {
        start: nativeSample(entry["start"], sidecar.audio.rate),
        end: nativeSample(entry["end"], sidecar.audio.rate),
        kind,
        rmsDb,
      };
    });
  };
  return [...intervals("speech", -20), ...intervals("silence", -100)]
    .sort((left, right) => left.start.samples - right.start.samples);
}

function sampleAtRate(
  value: { frames: number; fps: string },
  rate: number,
): SampleTime | undefined {
  const converted = convertTimeRounding(value, `${String(rate)}/1`);
  return converted.ok
    ? { samples: converted.value.time.frames, rate }
    : undefined;
}

function annotationRange(
  annotation: Annotation,
  sidecar: TranscriptSidecar,
): ProtectedSourceRange | undefined {
  if (annotation.state !== "open" && annotation.state !== "reopened") return undefined;
  let start: SampleTime | undefined;
  let assetId: string | undefined;
  if (annotation.anchor.kind === "word") {
    const word = sidecar.words[annotation.anchor.wordId];
    if (word?.state === "active") {
      start = word.start;
      assetId = sidecar.assetId;
    }
  } else if (
    annotation.anchor.kind === "clip" || annotation.anchor.kind === "object"
  ) {
    if (annotation.anchor.assetId !== sidecar.assetId) return undefined;
    start = sampleAtRate(annotation.anchor.sourceFrame, sidecar.audio.rate);
    assetId = annotation.anchor.assetId;
  }
  if (start === undefined || assetId === undefined) return undefined;
  const extent = sampleAtRate(annotation.extent, sidecar.audio.rate);
  if (extent === undefined) return undefined;
  return {
    assetId,
    start,
    end: { samples: start.samples + extent.samples, rate: start.rate },
    reason: `open annotation ${annotation.id}`,
  };
}

async function annotationProtections(
  project: ProjectStore,
  sidecar: TranscriptSidecar,
): Promise<ProtectedSourceRange[]> {
  const reference = project.currentProject.sidecars.find(
    ({ name }) => name === project.currentProject.annotations.sidecar,
  );
  if (reference === undefined) return [];
  try {
    const content = await readFile(join(project.root, reference.path), "utf8");
    if (createHash("sha256").update(content).digest("hex") !== reference.sha256) {
      throw new Error(`Annotation sidecar ${reference.path} does not match its registered hash.`);
    }
    return parseAnnotationSidecar(content).annotations.flatMap((annotation) =>
      annotationRange(annotation, sidecar) ?? []);
  } catch (error: unknown) {
    if (isRecord(error) && error["code"] === "ENOENT") return [];
    throw error;
  }
}

function lockedProtections(
  project: ProjectStore,
  sidecar: TranscriptSidecar,
): ProtectedSourceRange[] {
  const lockedSequences = new Set(project.currentProject.layers
    .filter(({ locked, sequence }) => locked && sequence !== undefined)
    .map(({ sequence }) => sequence!));
  return project.currentProject.sequences
    .filter(({ id }) => lockedSequences.has(id))
    .flatMap(({ clips }) => clips)
    .filter(({ asset }) => asset === sidecar.assetId)
    .flatMap((clip) => {
      const start = sampleAtRate(clip.source.in, sidecar.audio.rate);
      const end = sampleAtRate(clip.source.out, sidecar.audio.rate);
      return start === undefined || end === undefined
        ? []
        : [{
            assetId: sidecar.assetId,
            start,
            end,
            reason: `locked layer clip ${clip.id}`,
          }];
    });
}

function beatProtections(
  project: ProjectStore,
  sidecar: TranscriptSidecar,
  protectedNames: readonly string[],
): ProtectedSourceRange[] {
  const names = new Set(protectedNames.map((name) => name.toLocaleLowerCase()));
  return project.currentProject.beats.flatMap((beat) => {
    if (!names.has(beat.name.toLocaleLowerCase())) return [];
    const match = /^word:(w[0-9]{6})(?::(?:start|end))?(?:[+-][0-9]+f)?$/u.exec(beat.anchor);
    const word = match?.[1] === undefined ? undefined : sidecar.words[match[1]];
    if (word?.state !== "active") return [];
    return [{
      assetId: sidecar.assetId,
      start: { samples: Math.max(0, word.start.samples - 1), rate: word.start.rate },
      end: { samples: word.end.samples + 1, rate: word.end.rate },
      reason: `protected beat ${beat.id}`,
    }];
  });
}

async function protections(
  project: ProjectStore,
  sidecar: TranscriptSidecar,
  rules: FillerRuleSet,
): Promise<ProtectedSourceRange[]> {
  return [
    ...lockedProtections(project, sidecar),
    ...beatProtections(project, sidecar, rules.limits.protectBeats),
    ...(rules.limits.protectAnnotatedRanges
      ? await annotationProtections(project, sidecar)
      : []),
  ];
}

function parseRules(value: unknown): FillerRuleSet {
  if (value === undefined) return structuredClone(DEFAULT_FILLER_RULE_SET);
  if (!isRecord(value) || value["version"] !== 1) {
    throw new TypeError("assist.fillers.detect fillerRules must use version 1.");
  }
  return structuredClone(value) as unknown as FillerRuleSet;
}

function resultJson(result: FillerDetectionResult): JsonValue {
  return {
    candidates: result.candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      ...(candidate.wordRange === undefined ? {} : { wordRange: { ...candidate.wordRange } }),
      sourceRange: {
        assetId: candidate.sourceRange.assetId,
        start: { ...candidate.sourceRange.start },
        end: { ...candidate.sourceRange.end },
      },
      rule: candidate.rule,
      evidence: candidate.evidence,
      warnings: candidate.warnings.map((warning) => ({
        code: warning.code,
        severity: warning.severity,
        boundary: { ...warning.boundary },
        evidence: warning.evidence,
        ...(warning.suggestion === undefined ? {} : { suggestion: warning.suggestion }),
        ...(warning.autoFix === undefined ? {} : {
          autoFix: { op: warning.autoFix.op, params: warning.autoFix.params as JsonValue },
        }),
      })),
      defaultSelected: candidate.defaultSelected,
      ...(candidate.reviewRequired === undefined
        ? {}
        : { reviewRequired: candidate.reviewRequired }),
    })),
    reviewWindows: result.reviewWindows.map((window) => ({
      assetId: window.assetId,
      start: { ...window.start },
      end: { ...window.end },
      reviewRequired: true,
      candidateIds: [...window.candidateIds],
    })),
  };
}

function rulesJson(rules: FillerRuleSet): JsonValue {
  return {
    version: rules.version,
    pauses: { ...rules.pauses },
    fillers: {
      remove: [...rules.fillers.remove],
      review: [...rules.fillers.review],
      keep: [...rules.fillers.keep],
    },
    repeats: { ...rules.repeats },
    falseStarts: { ...rules.falseStarts },
    limits: {
      ...rules.limits,
      protectBeats: [...rules.limits.protectBeats],
    },
    padding: { ...rules.padding },
  };
}

export function registerFillerDetectionExecutor(
  queue: JobQueue,
  options: FillerDetectionExecutorOptions,
): void {
  queue.registerExecutor("assist.fillers.detect", async (job, { reportProgress, signal }) => {
    if (!isRecord(job.payload)) throw new TypeError("assist.fillers.detect payload must be an object.");
    const requestedAssets = job.payload["assetIds"];
    if (requestedAssets !== undefined &&
        (!Array.isArray(requestedAssets) || requestedAssets.some((id) => typeof id !== "string"))) {
      throw new TypeError("assist.fillers.detect assetIds must be a string array.");
    }
    const rules = parseRules(job.payload["fillerRules"]);
    const workspace = await loadTranscriptWorkspace(options.project, (prefix) => {
      if (prefix === "seg") return "seg_aaaaaaaaaa";
      if (prefix === "spk") return "spk_aaaaaaaaaa";
      if (prefix === "clp") return "clp_aaaaaaaaaa";
      if (prefix === "fx") return "fx_aaaaaaaaaa";
      if (prefix === "dlv") return "dlv_aaaaaaaaaa";
      return "txn_aaaaaaaaaa";
    });
    if (!workspace.ok) throw workspace.error;
    const selected = workspace.value.sidecars.filter(({ assetId }) =>
      requestedAssets === undefined || requestedAssets.includes(assetId));
    const combined: FillerDetectionResult = { candidates: [], reviewWindows: [] };
    for (const [index, sidecar] of selected.entries()) {
      const vad = queue.enqueue({
        kind: "vad",
        title: `Detect voice activity for ${sidecar.assetId}`,
        cancellable: true,
        payload: { audioPath: options.audioPath(sidecar.assetId) },
      });
      const completed = await terminalJob(queue, vad.jobId, signal);
      if (completed.state === "failed" && completed.error !== undefined) throw completed.error;
      if (completed.state !== "done") throw new Error(`VAD job ${vad.jobId} did not complete.`);
      const result = await detectFillerCandidates({
        sidecar,
        vad: vadActivities(completed.payload, sidecar),
        rules,
        protectedRanges: await protections(options.project, sidecar, rules),
        continuityWarnings: (sourceRange) => assessSourceRangeContinuity(
          options.project.currentProject,
          sourceRange,
          {
            sidecars: workspace.value.sidecars,
            ...(options.loadPeaks === undefined ? {} : { loadPeaks: options.loadPeaks }),
          },
        ),
      });
      combined.candidates.push(...result.candidates);
      combined.reviewWindows.push(...result.reviewWindows);
      reportProgress((index + 1) / Math.max(1, selected.length));
    }
    return resultJson(combined);
  });
}

export function enqueueFillerDetection(
  queue: JobQueue,
  input: EnqueueFillerDetectionInput = {},
): JobRecord {
  return queue.enqueue({
    kind: "assist.fillers.detect",
    title: "Detect pauses and filler candidates",
    cancellable: true,
    payload: {
      ...(input.assetIds === undefined ? {} : { assetIds: [...input.assetIds] }),
      ...(input.fillerRules === undefined
        ? {}
        : { fillerRules: rulesJson(input.fillerRules) }),
    },
  });
}

function sampleTime(value: unknown): SampleTime {
  if (!isRecord(value) || !Number.isSafeInteger(value["samples"]) || !Number.isSafeInteger(value["rate"])) {
    throw new TypeError("Filler candidate sample time is invalid.");
  }
  return { samples: Number(value["samples"]), rate: Number(value["rate"]) };
}

function parsedCandidate(value: unknown): FillerCandidate {
  if (!isRecord(value) ||
      typeof value["id"] !== "string" ||
      !["pause", "filler", "repeat", "false-start"].includes(String(value["kind"])) ||
      !isRecord(value["sourceRange"]) ||
      typeof value["sourceRange"]["assetId"] !== "string" ||
      typeof value["rule"] !== "string" || typeof value["evidence"] !== "string" ||
      typeof value["defaultSelected"] !== "boolean" || !Array.isArray(value["warnings"])) {
    throw new TypeError("assist.fillers.detect returned an invalid candidate.");
  }
  const wordRangeValue = value["wordRange"];
  const wordRange = isRecord(wordRangeValue) &&
    typeof wordRangeValue["fromWord"] === "string" &&
    typeof wordRangeValue["toWord"] === "string"
    ? { fromWord: wordRangeValue["fromWord"], toWord: wordRangeValue["toWord"] }
    : undefined;
  return {
    id: value["id"],
    kind: value["kind"] as FillerCandidate["kind"],
    ...(wordRange === undefined ? {} : { wordRange }),
    sourceRange: {
      assetId: value["sourceRange"]["assetId"],
      start: sampleTime(value["sourceRange"]["start"]),
      end: sampleTime(value["sourceRange"]["end"]),
    },
    rule: value["rule"],
    evidence: value["evidence"],
    warnings: value["warnings"] as unknown as FillerCandidate["warnings"],
    defaultSelected: value["defaultSelected"],
    ...(value["reviewRequired"] === true ? { reviewRequired: true } : {}),
  };
}

function parsedWindow(value: unknown): FillerReviewWindow {
  if (!isRecord(value) || typeof value["assetId"] !== "string" ||
      value["reviewRequired"] !== true || !Array.isArray(value["candidateIds"]) ||
      value["candidateIds"].some((id) => typeof id !== "string")) {
    throw new TypeError("assist.fillers.detect returned an invalid review window.");
  }
  return {
    assetId: value["assetId"],
    start: sampleTime(value["start"]),
    end: sampleTime(value["end"]),
    reviewRequired: true,
    candidateIds: value["candidateIds"] as string[],
  };
}

export function parseFillerDetectionResult(value: JsonValue): FillerDetectionResult {
  if (!isRecord(value) || !Array.isArray(value["candidates"]) || !Array.isArray(value["reviewWindows"])) {
    throw new TypeError("assist.fillers.detect result is invalid.");
  }
  return {
    candidates: value["candidates"].map(parsedCandidate),
    reviewWindows: value["reviewWindows"].map(parsedWindow),
  };
}
