import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  makeId,
  parseTakeComparison,
  parseTakeMarkerSidecar,
  serializeTakeComparison,
  takeComparisonSidecarRef,
} from "../../../core/src/index.js";
import type {
  IdPrefix,
  JobQueue,
  JobRecord,
  JsonValue,
  OperationEngine,
  ProjectStore,
  Proposal,
  Result,
  TakeComparison,
  TakeRecord,
} from "../../../core/src/index.js";
import { deriveTakeMetrics, loadPeaks } from "../../../media/src/index.js";
import type { PeaksFile, TakeMetricSignals } from "../../../media/src/index.js";
import {
  extractTakeTranscript,
  groupTakeTranscripts,
  parseTranscriptSidecar,
} from "../../../transcript/src/index.js";
import type { TranscriptSidecar } from "../../../transcript/src/index.js";
import {
  buildTakeComparison,
  takePreferenceRubric,
} from "../../../agent/src/index.js";
import type { SkillRegistry } from "../../../agent/src/index.js";

export interface TakeComparisonServiceOptions {
  project: ProjectStore;
  jobs: JobQueue;
  skillRegistry: Pick<SkillRegistry, "pinned">;
  operationEngine: () => Pick<OperationEngine, "execute" | "createProposal">;
  idFactory?: (prefix: IdPrefix) => string;
  now?: () => Date;
  onRevision?: (revision: string) => void;
  onProposal?: (proposalId: string) => void;
}

function resultValue<Value>(result: Result<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function terminal(job: JobRecord): boolean {
  return job.state === "done" || job.state === "failed" || job.state === "cancelled";
}

function waitForTerminal(jobs: JobQueue, jobId: string): Promise<JobRecord> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const finish = (job: JobRecord): void => {
      unsubscribe();
      resolve(job);
    };
    unsubscribe = jobs.onChange(({ job }) => {
      if (job.jobId === jobId && terminal(job)) finish(job);
    });
    const current = jobs.get(jobId);
    if (current !== undefined && terminal(current)) finish(current);
  });
}

function jobTakeIds(payload: JsonValue): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("Take comparison job payload must be an object.");
  }
  const takeIds = payload["takeIds"];
  if (!Array.isArray(takeIds) || !takeIds.every((value) => typeof value === "string")) {
    throw new TypeError("Take comparison job payload requires takeIds.");
  }
  return takeIds;
}

function jobComparisonIds(payload: JsonValue): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const comparisonIds = payload["comparisonIds"];
  return Array.isArray(comparisonIds)
    ? comparisonIds.filter((value): value is string => typeof value === "string")
    : [];
}

function numericFps(value: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(value);
  if (match === null) throw new TypeError(`Invalid take fps ${value}.`);
  return Number(match[1]) / Number(match[2]);
}

function takePeakData(take: TakeRecord, peaks: PeaksFile): { levels: number[]; peaks: number[] } {
  const tier = [...peaks.tiers].sort((left, right) =>
    right.samplesPerPeak - left.samplesPerPeak)[0];
  if (tier === undefined) throw new TypeError(`Take ${take.id} has no loudness analysis tier.`);
  const secondsPerPair = tier.samplesPerPeak / peaks.sampleRate;
  const fps = numericFps(take.range.fps);
  const first = Math.floor(take.range.start / fps / secondsPerPair);
  const last = Math.max(first + 1, Math.ceil(take.range.end / fps / secondsPerPair));
  const levels: number[] = [];
  const raw: number[] = [];
  for (let pair = first; pair < last; pair += 1) {
    const low = tier.data[pair * 2];
    const high = tier.data[pair * 2 + 1];
    if (low === undefined || high === undefined) continue;
    const magnitude = Math.max(1, Math.abs(low), Math.abs(high));
    levels.push(Number((20 * Math.log10(magnitude / 127)).toFixed(4)));
    raw.push(Math.abs(low), Math.abs(high));
  }
  if (levels.length === 0) throw new TypeError(`Take ${take.id} has no loudness samples in range.`);
  return { levels, peaks: raw };
}

function takeMetricSignals(
  take: TakeRecord,
  transcript: TranscriptSidecar,
  peaks: PeaksFile,
): TakeMetricSignals {
  const fps = numericFps(take.range.fps);
  const startSeconds = take.range.start / fps;
  const endSeconds = take.range.end / fps;
  const words = transcript.segments.flatMap(({ words: ids }) => ids)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .flatMap((id) => {
      const word = transcript.words[id];
      if (word === undefined || word.state !== "active") return [];
      const midpoint = (word.start.samples / word.start.rate + word.end.samples / word.end.rate) / 2;
      return midpoint >= startSeconds && midpoint < endSeconds ? [word] : [];
    })
    .sort((left, right) => left.start.samples / left.start.rate -
      right.start.samples / right.start.rate);
  if (words.length === 0) throw new TypeError(`Take ${take.id} has no aligned transcript words.`);
  const tokens = words.map(({ text }) =>
    text.toLocaleLowerCase("en").replace(/[^\p{Letter}']/gu, ""));
  const fillers = new Set(["um", "uh", "erm", "ah", "like"]);
  const silenceSeconds = words.slice(1).reduce((sum, word, index) => {
    const prior = words[index]!;
    return sum + Math.max(0,
      word.start.samples / word.start.rate - prior.end.samples / prior.end.rate);
  }, 0);
  const peakData = takePeakData(take, peaks);
  const sortedLevels = [...peakData.levels].sort((left, right) => left - right);
  const noiseFloorDb = sortedLevels[Math.floor((sortedLevels.length - 1) * 0.25)]!;
  return {
    durationSeconds: endSeconds - startSeconds,
    wordCount: words.length,
    fillerCount: tokens.filter((token) => fillers.has(token)).length,
    silenceSeconds,
    loudnessLufs: peakData.levels,
    restartCount: tokens.slice(1)
      .filter((token, index) => token !== "" && token === tokens[index]).length,
    technical: {
      audioClippingPct: Number((peakData.peaks.filter((value) => value >= 126).length /
        Math.max(1, peakData.peaks.length) * 100).toFixed(4)),
      noiseFloorDb,
    },
  };
}

async function transcripts(project: ProjectStore): Promise<TranscriptSidecar[]> {
  return Promise.all(project.currentProject.sidecars
    .filter(({ schema }) => schema === "guyditor.transcript/v1")
    .map(async ({ path }) => parseTranscriptSidecar(
      await readFile(join(project.root, path), "utf8"),
    )));
}

export class TakeComparisonService {
  readonly #project: ProjectStore;
  readonly #jobs: JobQueue;
  readonly #skills: Pick<SkillRegistry, "pinned">;
  readonly #engine: TakeComparisonServiceOptions["operationEngine"];
  readonly #idFactory: (prefix: IdPrefix) => string;
  readonly #now: () => Date;
  readonly #onRevision: ((revision: string) => void) | undefined;
  readonly #onProposal: ((proposalId: string) => void) | undefined;

  public constructor(options: TakeComparisonServiceOptions) {
    this.#project = options.project;
    this.#jobs = options.jobs;
    this.#skills = options.skillRegistry;
    this.#engine = options.operationEngine;
    this.#idFactory = options.idFactory ?? makeId;
    this.#now = options.now ?? (() => new Date());
    this.#onRevision = options.onRevision;
    this.#onProposal = options.onProposal;
    this.#jobs.registerExecutor("assist.takes.compare", async (job, context) => {
      const comparisons = await this.#compare(jobTakeIds(job.payload), context.signal,
        context.reportProgress);
      return { comparisonIds: comparisons.map(({ id }) => id) };
    });
  }

  public async list(): Promise<TakeComparison[]> {
    return Promise.all(this.#project.currentProject.sidecars
      .filter(({ schema }) => schema === "guyditor.take-comparison/v1")
      .map(async ({ path }) => parseTakeComparison(
        await readFile(join(this.#project.root, path), "utf8"),
      )));
  }

  public async compare(takeIds: string[]): Promise<TakeComparison[]> {
    if (new Set(takeIds).size < 2) {
      throw new TypeError("Take comparison requires at least two distinct takes.");
    }
    const job = this.#jobs.enqueue({
      kind: "assist.takes.compare",
      title: `Compare ${String(takeIds.length)} takes`,
      cancellable: true,
      payload: { takeIds: [...takeIds] },
    });
    const finished = await waitForTerminal(this.#jobs, job.jobId);
    if (finished.state === "failed") {
      throw new Error(finished.error?.message ?? `Take comparison job ${job.jobId} failed.`);
    }
    if (finished.state === "cancelled") {
      throw new Error(`Take comparison job ${job.jobId} was cancelled.`);
    }
    const comparisonIds = new Set(jobComparisonIds(finished.payload));
    return (await this.list()).filter(({ id }) => comparisonIds.has(id));
  }

  async #compare(
    takeIds: string[],
    signal: AbortSignal,
    reportProgress: (progress: number, etaSeconds?: number) => void,
  ): Promise<TakeComparison[]> {
    const requested = new Set(takeIds);
    if (requested.size < 2) throw new TypeError("Take comparison requires at least two distinct takes.");
    if (signal.aborted) throw new Error("Take comparison was cancelled.");
    reportProgress(0.05);
    const sidecars = await Promise.all(this.#project.currentProject.sidecars
      .filter(({ schema }) => schema === "guyditor.take-markers/v1")
      .map(async ({ path }) => parseTakeMarkerSidecar(
        await readFile(join(this.#project.root, path), "utf8"),
      )));
    const takes = sidecars.flatMap(({ takes: values }) => values)
      .filter(({ id }) => requested.has(id));
    if (takes.length !== requested.size) throw new TypeError("One or more requested takes are unavailable.");
    const transcriptSidecars = await transcripts(this.#project);
    const extracted = takes.map((take) => {
      const transcript = transcriptSidecars.find(({ assetId }) => assetId === take.assetId);
      if (transcript === undefined) throw new TypeError(`Take ${take.id} has no transcript analysis.`);
      return extractTakeTranscript(take, transcript);
    });
    const groups = groupTakeTranscripts(extracted).filter(({ candidates }) => candidates.length >= 2);
    if (groups.length === 0) {
      throw new TypeError("The requested takes do not contain a transcript-similar group.");
    }
    reportProgress(0.2);
    const rubric = takePreferenceRubric(await this.#skills.pinned(this.#project));
    const comparisons: TakeComparison[] = [];
    for (const [groupIndex, group] of groups.entries()) {
      if (signal.aborted) throw new Error("Take comparison was cancelled.");
      const candidates = await Promise.all(group.candidates.map(async (candidate) => {
        const take = takes.find(({ id }) => id === candidate.takeId)!;
        const transcript = transcriptSidecars.find(({ assetId }) => assetId === take.assetId)!;
        const asset = this.#project.currentProject.assets.find(({ id }) => id === take.assetId);
        if (asset === undefined) throw new TypeError(`Take asset ${take.assetId} is unavailable.`);
        const peaks = await loadPeaks(this.#project.root, asset);
        if (peaks === undefined) {
          throw new TypeError(`Take ${take.id} requires completed loudness/peaks analysis.`);
        }
        return {
          take,
          transcript: candidate,
          ...deriveTakeMetrics(takeMetricSignals(take, transcript, peaks)),
        };
      }));
      const lead = group.candidates.find(({ takeId }) => takeId === group.leadTakeId);
      const comparison = buildTakeComparison({
        comparisonId: this.#idFactory("tkc"),
        createdAt: this.#now().toISOString(),
        slot: {
          scriptSection: lead?.transcriptText ?? "Transcript-similar takes",
          ...(lead?.wordRange === undefined ? {} : {
            wordRange: { fromWord: lead.wordRange.from, toWord: lead.wordRange.to },
          }),
        },
        candidates,
        rubric,
      });
      await this.#persist(comparison);
      comparisons.push(comparison);
      reportProgress(0.2 + (groupIndex + 1) / groups.length * 0.8);
    }
    this.#onRevision?.(this.#project.currentProject.revision);
    return comparisons;
  }

  public async proposeSelection(comparisonId: string, takeId: string): Promise<Proposal> {
    const previousComparison = (await this.list()).find(({ id }) => id === comparisonId);
    if (previousComparison === undefined) throw new TypeError(`Comparison ${comparisonId} is unavailable.`);
    if (!previousComparison.candidates.some(({ takeId: candidateId }) => candidateId === takeId)) {
      throw new TypeError(`Take ${takeId} is not retained in comparison ${comparisonId}.`);
    }
    const comparison = { ...previousComparison, selectedTakeId: takeId };
    const recommendation = previousComparison.recommendation;
    const detail = recommendation?.takeId === takeId
      ? recommendation.reasons.map(({ detail: reason }) => reason).join(" ")
      : "The creator selected this retained alternative after reviewing the same disclosed metrics.";
    const proposal = resultValue<Proposal>(await this.#engine().createProposal({
      operations: [{ op: "take.select", params: { comparison, previousComparison } }],
      instruction: { kind: "ui-direct", text: `Select ${takeId} from ${comparisonId}` },
      actor: { kind: "tool", id: "assist.takes.compare" },
      reason: {
        text: detail.slice(0, 280),
        sources: [{ kind: "media-evidence", ref: comparisonId }],
      },
      addresses: [],
    }));
    this.#onProposal?.(proposal.id);
    return proposal;
  }

  async #persist(comparison: TakeComparison): Promise<void> {
    const reference = takeComparisonSidecarRef(comparison, Object.fromEntries(
      this.#project.currentProject.assets.map(({ id, sha256 }) => [id, sha256]),
    ));
    await mkdir(join(this.#project.root, "sidecars/takes"), { recursive: true });
    await writeFile(
      join(this.#project.root, reference.path),
      serializeTakeComparison(comparison),
      "utf8",
    );
    resultValue(await this.#engine().execute([{
      op: "sidecar.register",
      params: { name: reference.name, sidecar: reference },
    }], {
      baseRevision: this.#project.currentProject.revision,
      origin: "system",
      dryRun: false,
      recordUndo: false,
      instruction: { kind: "ui-direct", text: "Register take comparison evidence" },
    }));
  }
}
