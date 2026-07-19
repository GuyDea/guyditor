import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import {
  AnchorResolverRegistry,
  OperationEngine,
  failure,
  formatWordId,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type {
  Asset,
  GuyditorProject,
  IdPrefix,
  JobQueue,
  JobRecord,
  JsonValue,
  OperationCommitter,
  OperationDispatcher,
  OperationInput,
  OperationBatchResult,
  OperationContext,
  ProjectStore,
  Result,
  SidecarRef,
  TransactionRecord,
} from "../../core/src/index.js";

import { loadTranscriptWorkspace } from "./operations.js";
import { createTranscriptContinuityGuard } from "./continuity.js";
import type { ContinuityPeaks } from "./continuity.js";
import {
  findWord as findProjectWord,
  resolveWord as resolveProjectWord,
} from "./lookup.js";
import { createTranscriptWordLookup } from "./anchor-lookup.js";
import { serializeTranscriptSidecar } from "./sidecar.js";
import type {
  AlignResult,
  AlignedToken,
  RawTranscriptionSegment,
  RawTranscriptionWord,
  SampleTime,
  TranscribeResult,
  TranscriptSegment,
  TranscriptRealignRequest,
  TranscriptSidecar,
  TranscriptWord,
  WordLocation,
  WordResolution,
} from "./types.js";
import { importSubtitleText } from "./captions/subtitles.js";
import type { ImportedSubtitle } from "./captions/types.js";

const TRANSCRIPT_SCHEMA = "guyditor.transcript/v1";
export const ALIGNMENT_CONFIDENCE_THRESHOLD = 0.35;
const ANALYSIS_RATE = 16_000;
const DEFAULT_ALIGNMENT_MODEL = "wav2vec2-base-960h";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
let temporaryOrdinal = 0;

export interface TranscriptEngineOptions {
  idFactory?: (prefix: IdPrefix | "seg" | "spk") => string;
  now?: () => Date;
  appVersion?: string;
  project?: ProjectStore;
  alignmentJobs?: TranscriptAlignmentJobs;
  loadPeaks?: (
    assetId: string,
  ) => ContinuityPeaks | undefined | Promise<ContinuityPeaks | undefined>;
}

export interface TranscriptAlignmentJobs {
  queue: JobQueue;
  hasAlignCapability: () => boolean;
  audioPath: (assetId: string) => string;
  model?: string;
}

export interface TranscriptMutationResult {
  sidecar: TranscriptSidecar;
  transactionId?: string;
  alignmentJobId?: string;
}

export interface SubtitleImportResult extends ImportedSubtitle {
  assetId: string;
  transactionId?: string;
}

function transcriptFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaryOrdinal += 1;
  const temporary = `${path}.tmp-${String(process.pid)}-${String(temporaryOrdinal)}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

class SidecarCommitter implements OperationCommitter {
  readonly #store: ProjectStore;
  readonly #writes: ReadonlyMap<string, string>;

  public constructor(store: ProjectStore, writes: ReadonlyMap<string, string>) {
    this.#store = store;
    this.#writes = writes;
  }

  public async commit(
    model: GuyditorProject,
    transaction: TransactionRecord,
  ): Promise<Result<GuyditorProject>> {
    const previous = new Map<string, string | undefined>();
    try {
      for (const [relativePath, content] of this.#writes) {
        const path = join(this.#store.root, relativePath);
        previous.set(relativePath, await readOptional(path));
        await atomicWrite(path, content);
      }
      const committed = await this.#store.commit(model, transaction);
      if (committed.ok) return committed;
      await this.#restore(previous);
      return committed;
    } catch (error: unknown) {
      await this.#restore(previous).catch(() => undefined);
      return transcriptFailure(
        "E_TRANSCRIPT_COMMIT",
        `Transcript sidecar transaction failed: ${errorMessage(error)}`,
        [...this.#writes.keys()],
      );
    }
  }

  async #restore(previous: ReadonlyMap<string, string | undefined>): Promise<void> {
    for (const [relativePath, content] of previous) {
      const path = join(this.#store.root, relativePath);
      if (content === undefined) await unlink(path).catch(() => undefined);
      else await atomicWrite(path, content);
    }
  }
}

function randomDomainId(prefix: IdPrefix | "seg" | "spk"): string {
  const bytes = randomBytes(10);
  let suffix = "";
  for (const byte of bytes) suffix += BASE32_ALPHABET[byte & 31];
  return `${prefix}_${suffix}`;
}

function sidecarPath(assetId: string): string {
  return `sidecars/transcripts/${assetId}.transcript.json`;
}

function sidecarName(assetId: string): string {
  return `transcript-${assetId}`;
}

function compareSampleTime(left: SampleTime, right: SampleTime): number {
  const difference = BigInt(left.samples) * BigInt(right.rate) -
    BigInt(right.samples) * BigInt(left.rate);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function roundedRatio(numerator: bigint, denominator: bigint): number {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n > denominator ? quotient + 1n : quotient;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new RangeError("Converted sample time is out of range.");
  return value;
}

function nativeTime(value: SampleTime | number, nativeRate: number): SampleTime {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("Worker second timestamps must be finite and non-negative.");
    }
    const scaled = value * nativeRate;
    const earlier = Math.floor(scaled);
    const samples = scaled - earlier > 0.5 ? earlier + 1 : earlier;
    if (!Number.isSafeInteger(samples)) throw new RangeError("Worker timestamp is out of range.");
    return { samples, rate: nativeRate };
  }
  if (
    !Number.isSafeInteger(value.samples) || value.samples < 0 ||
    !Number.isSafeInteger(value.rate) || value.rate <= 0
  ) {
    throw new RangeError("Worker sample timestamps must contain safe non-negative samples and a positive rate.");
  }
  return {
    samples: roundedRatio(
      BigInt(value.samples) * BigInt(nativeRate),
      BigInt(value.rate),
    ),
    rate: nativeRate,
  };
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
  if (text === "") throw new TypeError(`Transcription token ${JSON.stringify(raw)} has no spoken text.`);
  return { text, punctBefore, punctAfter };
}

interface PreparedWord {
  raw: RawTranscriptionWord;
  start: SampleTime;
  end: SampleTime;
}

interface PreparedSegment {
  raw: RawTranscriptionSegment;
  start: SampleTime;
  end: SampleTime;
  words: PreparedWord[];
}

function prepareSegments(
  segments: readonly RawTranscriptionSegment[],
  nativeRate: number,
): PreparedSegment[] {
  return segments.map((raw) => {
    const words = raw.words.map((word) => ({
      raw: word,
      start: nativeTime(word.start, nativeRate),
      end: nativeTime(word.end, nativeRate),
    })).sort((left, right) =>
      compareSampleTime(left.start, right.start) || compareSampleTime(left.end, right.end));
    for (const entry of words) {
      if (compareSampleTime(entry.start, entry.end) >= 0) {
        throw new RangeError("Transcription word start must precede its end.");
      }
      if (
        !Number.isFinite(entry.raw.probability) ||
        entry.raw.probability < 0 || entry.raw.probability > 1
      ) {
        throw new RangeError("Transcription word probability must be from 0 through 1.");
      }
    }
    const rawStart = nativeTime(raw.start, nativeRate);
    const rawEnd = nativeTime(raw.end, nativeRate);
    const firstWord = words[0];
    const lastWord = words.at(-1);
    const start = firstWord !== undefined && compareSampleTime(firstWord.start, rawStart) < 0
      ? firstWord.start
      : rawStart;
    const end = lastWord !== undefined && compareSampleTime(lastWord.end, rawEnd) > 0
      ? lastWord.end
      : rawEnd;
    if (compareSampleTime(start, end) >= 0) {
      throw new RangeError("Transcription segment start must precede its end.");
    }
    return { raw, start, end, words };
  }).sort((left, right) =>
    compareSampleTime(left.start, right.start) ||
    compareSampleTime(left.end, right.end) ||
    left.raw.index - right.raw.index);
}

function registryEntry(
  assetId: string,
  assetHash: string,
  contentHash: string,
  result: TranscribeResult,
): SidecarRef {
  return {
    name: sidecarName(assetId),
    path: sidecarPath(assetId),
    schema: TRANSCRIPT_SCHEMA,
    sha256: contentHash,
    generatedBy: {
      tool: `mlworker/${result.engine.name}`,
      version: result.engine.version,
      job: result.jobId,
    },
    inputs: [{ asset: assetId, sha256: assetHash }],
  };
}

function createDispatcher(
  expected: OperationInput,
  nextOrdinal: number,
  reference: SidecarRef,
): OperationDispatcher {
  return (project, input) => {
    if (input.op !== expected.op || input.params["assetId"] !== expected.params["assetId"]) {
      return transcriptFailure(
        "E_TRANSCRIPT_DISPATCH",
        `Unexpected operation ${input.op} during transcript creation.`,
      );
    }
    const existing = project.sidecars.find(({ name, schema, inputs }) =>
      name === reference.name ||
      (schema === TRANSCRIPT_SCHEMA && inputs.some(({ asset }) =>
        asset === input.params["assetId"])));
    if (existing !== undefined) {
      return transcriptFailure(
        "E_TRANSCRIPT_EXISTS",
        `Asset ${String(input.params["assetId"])} already has a canonical transcript; re-transcription requires a proposal.`,
        [String(input.params["assetId"])],
      );
    }
    return success({
      model: {
        ...project,
        transcript: { nextWordOrdinal: nextOrdinal },
        sidecars: [...project.sidecars, reference],
      },
      inverse: [],
      affected: [String(input.params["assetId"])],
      summary: `Register canonical transcript for ${String(input.params["assetId"])}`,
    });
  };
}

function alignmentSegmentsFromTranscription(
  result: TranscribeResult,
): JsonValue[] {
  return result.segments.map((segment) => ({
    index: segment.index,
    start: { ...nativeTime(segment.start, ANALYSIS_RATE) },
    end: { ...nativeTime(segment.end, ANALYSIS_RATE) },
    tokens: segment.words.map(({ text }) => tokenParts(text).text),
  }));
}

function alignmentPayload(
  jobs: TranscriptAlignmentJobs,
  assetId: string,
  language: string,
  segments: JsonValue[],
): JsonValue {
  return {
    audioPath: jobs.audioPath(assetId),
    language,
    model: jobs.model ?? DEFAULT_ALIGNMENT_MODEL,
    segments,
  };
}

function terminalJob(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const terminal = (job: JobRecord | undefined): job is JobRecord =>
    job !== undefined &&
    (job.state === "done" || job.state === "failed" || job.state === "cancelled");
  const current = queue.get(jobId);
  if (terminal(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const stop = queue.onChange(({ job }) => {
      if (job.jobId !== jobId || !terminal(job)) return;
      stop();
      resolve(job);
    });
    const afterSubscribe = queue.get(jobId);
    if (terminal(afterSubscribe)) {
      stop();
      resolve(afterSubscribe);
    }
  });
}

function jsonObject(value: JsonValue, path: string): { [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value;
}

function finiteNumber(value: JsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number.`);
  }
  return value;
}

function integer(value: JsonValue | undefined, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${path} must be a safe integer.`);
  return parsed;
}

function sampleTime(value: JsonValue | undefined, path: string): SampleTime {
  if (value === undefined) throw new TypeError(`${path} is required.`);
  const source = jsonObject(value, path);
  const samples = integer(source["samples"], `${path}.samples`);
  const rate = integer(source["rate"], `${path}.rate`);
  if (samples < 0 || rate <= 0) throw new RangeError(`${path} is not a valid sample time.`);
  return { samples, rate };
}

function engineIdentity(value: JsonValue | undefined, path: string) {
  if (value === undefined) throw new TypeError(`${path} is required.`);
  const source = jsonObject(value, path);
  const name = source["name"];
  const version = source["version"];
  const model = source["model"];
  if (
    typeof name !== "string" || name.length === 0 ||
    typeof version !== "string" || version.length === 0 ||
    typeof model !== "string" || model.length === 0
  ) {
    throw new TypeError(`${path} must contain non-empty name, version, and model strings.`);
  }
  return { name, version, model };
}

function parseAlignResult(value: JsonValue): AlignResult {
  const source = jsonObject(value, "align result");
  const rawTokens = source["tokens"];
  if (!Array.isArray(rawTokens)) throw new TypeError("align result.tokens must be an array.");
  const tokens: AlignedToken[] = rawTokens.map((value, index) => {
    const token = jsonObject(value, `align result.tokens[${String(index)}]`);
    const score = finiteNumber(token["score"], `align result.tokens[${String(index)}].score`);
    if (score < 0 || score > 1 || typeof token["aligned"] !== "boolean") {
      throw new RangeError(`align result.tokens[${String(index)}] has invalid confidence fields.`);
    }
    return {
      segmentIndex: integer(
        token["segmentIndex"],
        `align result.tokens[${String(index)}].segmentIndex`,
      ),
      tokenIndex: integer(
        token["tokenIndex"],
        `align result.tokens[${String(index)}].tokenIndex`,
      ),
      start: sampleTime(token["start"], `align result.tokens[${String(index)}].start`),
      end: sampleTime(token["end"], `align result.tokens[${String(index)}].end`),
      score,
      aligned: token["aligned"],
    };
  });
  return { tokens, engine: engineIdentity(source["engine"], "align result.engine") };
}

interface ScopedAlignmentSegment {
  request: JsonValue;
  wordIds: string[];
  start: SampleTime;
  end: SampleTime;
}

function scopedAlignmentSegments(
  sidecar: TranscriptSidecar,
  request: TranscriptRealignRequest,
): ScopedAlignmentSegment[] {
  const orderedActive = sidecar.segments.flatMap((segment, segmentIndex) =>
    segment.words.flatMap((wordId) => {
      const word = sidecar.words[wordId];
      return word?.state === "active" ? [{ wordId, word, segmentIndex }] : [];
    }));
  let selected = orderedActive;
  if (request.wordRange !== undefined) {
    const from = orderedActive.findIndex(({ wordId }) => wordId === request.wordRange?.fromWord);
    const to = orderedActive.findIndex(({ wordId }) => wordId === request.wordRange?.toWord);
    if (from === -1 || to < from) {
      throw new RangeError(
        `Realignment word range ${request.wordRange.fromWord}..${request.wordRange.toWord} is invalid.`,
      );
    }
    selected = orderedActive.slice(from, to + 1);
  }
  if (selected.length === 0) throw new RangeError(`Asset ${request.assetId} has no active words to align.`);
  const bySegment = new Map<number, typeof selected>();
  for (const entry of selected) {
    const group = bySegment.get(entry.segmentIndex) ?? [];
    group.push(entry);
    bySegment.set(entry.segmentIndex, group);
  }
  return [...bySegment].map(([segmentIndex, entries]) => {
    const first = entries[0]!.word.start;
    const last = entries.at(-1)!.word.end;
    const start = nativeTime(first, ANALYSIS_RATE);
    const end = nativeTime(last, ANALYSIS_RATE);
    return {
      request: {
        index: segmentIndex,
        start: { ...start },
        end: { ...end },
        tokens: entries.map(({ word }) => word.text),
      },
      wordIds: entries.map(({ wordId }) => wordId),
      start,
      end,
    };
  });
}

export class TranscriptEngine {
  readonly #idFactory: (prefix: IdPrefix | "seg" | "spk") => string;
  readonly #now: () => Date;
  readonly #appVersion: string;
  readonly #project: ProjectStore | undefined;
  readonly #alignmentJobs: TranscriptAlignmentJobs | undefined;
  readonly #loadPeaks: TranscriptEngineOptions["loadPeaks"];

  public constructor(options: TranscriptEngineOptions = {}) {
    this.#idFactory = options.idFactory ?? randomDomainId;
    this.#now = options.now ?? (() => new Date());
    this.#appVersion = options.appVersion ?? "0.0.0";
    this.#project = options.project;
    this.#alignmentJobs = options.alignmentJobs;
    this.#loadPeaks = options.loadPeaks;
  }

  #enqueueInsufficientAlignment(
    assetId: string,
    result: TranscribeResult,
  ): string | undefined {
    const jobs = this.#alignmentJobs;
    if (
      jobs === undefined ||
      !jobs.hasAlignCapability() ||
      !result.segments.some(({ words }) =>
        words.some(({ probability }) => probability < ALIGNMENT_CONFIDENCE_THRESHOLD))
    ) {
      return undefined;
    }
    return jobs.queue.enqueue({
      kind: "align",
      title: `Align transcript for ${assetId}`,
      cancellable: true,
      payload: alignmentPayload(
        jobs,
        assetId,
        result.language,
        alignmentSegmentsFromTranscription(result),
      ),
    }).jobId;
  }

  public async createFromTranscription(
    project: ProjectStore,
    assetId: string,
    transcribeResult: TranscribeResult,
  ): Promise<Result<TranscriptMutationResult>> {
    try {
      const asset = project.currentProject.assets.find(({ id }) => id === assetId);
      if (asset === undefined) {
        return transcriptFailure("E_TRANSCRIPT_ASSET_NOT_FOUND", `Asset ${assetId} does not exist.`, [assetId]);
      }
      const audio = asset.audio?.[0];
      if (audio === undefined) {
        return transcriptFailure(
          "E_TRANSCRIPT_AUDIO_NOT_FOUND",
          `Asset ${assetId} has no selected native audio stream.`,
          [assetId],
        );
      }
      if (project.currentProject.sidecars.some(({ schema, inputs }) =>
        schema === TRANSCRIPT_SCHEMA && inputs.some((input) => input.asset === assetId))) {
        return transcriptFailure(
          "E_TRANSCRIPT_EXISTS",
          `Asset ${assetId} already has a canonical transcript; re-transcription requires a proposal.`,
          [assetId],
        );
      }

      const prepared = prepareSegments(transcribeResult.segments, audio.sampleRate);
      const wordCount = prepared.reduce((count, segment) => count + segment.words.length, 0);
      const firstOrdinal = project.currentProject.transcript.nextWordOrdinal;
      const nextOrdinal = firstOrdinal + wordCount;
      if (firstOrdinal < 0 || nextOrdinal > 999_999) {
        return transcriptFailure(
          "E_TRANSCRIPT_WORD_ID_EXHAUSTED",
          "The six-digit project-global word ordinal space is exhausted.",
          [assetId],
        );
      }

      const speakerId = this.#idFactory("spk");
      let ordinal = firstOrdinal;
      const words: Record<string, TranscriptWord> = {};
      const segments: TranscriptSegment[] = prepared.map((entry) => {
        const wordIds = entry.words.map((preparedWord) => {
          const wordId = formatWordId(ordinal);
          ordinal += 1;
          const parts = tokenParts(preparedWord.raw.text);
          words[wordId] = {
            ...parts,
            start: preparedWord.start,
            end: preparedWord.end,
            confidence: preparedWord.raw.probability,
            alignment: "asr",
            state: "active",
            origin: "asr",
          };
          return wordId;
        });
        return {
          id: this.#idFactory("seg"),
          speaker: speakerId,
          language: null,
          start: entry.start,
          end: entry.end,
          words: wordIds,
        };
      });
      const sidecar: TranscriptSidecar = {
        schema: TRANSCRIPT_SCHEMA,
        assetId,
        audio: {
          rate: audio.sampleRate,
          channels: audio.channels,
          streamIndex: audio.index,
        },
        language: transcribeResult.language,
        languageProbability: transcribeResult.languageProbability,
        provenance: {
          engine: transcribeResult.engine,
          alignment: null,
          createdAt: this.#now().toISOString(),
          jobId: transcribeResult.jobId,
        },
        speakers: [{ id: speakerId, label: "Speaker 1" }],
        segments,
        words,
      };
      const content = serializeTranscriptSidecar(sidecar);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const reference = registryEntry(assetId, asset.sha256, sha256, transcribeResult);
      const operation: OperationInput = {
        op: "transcript.create",
        params: {
          assetId,
          sidecar: { path: reference.path, sha256 },
          engine: transcribeResult.engine,
          alignment: null,
          jobId: transcribeResult.jobId,
        },
      };
      const anchorResolvers = new AnchorResolverRegistry();
      anchorResolvers.registerWordLookup(createTranscriptWordLookup([sidecar]));
      const engine = new OperationEngine(project.currentProject, {
        appVersion: this.#appVersion,
        committer: new SidecarCommitter(project, new Map([[reference.path, content]])),
        idFactory: (prefix: IdPrefix) => this.#idFactory(prefix),
        now: this.#now,
        operationDispatcher: createDispatcher(operation, nextOrdinal, reference),
        anchorResolvers,
      });
      const committed = await engine.execute([operation], {
        baseRevision: project.currentProject.revision,
        origin: "system",
        dryRun: false,
      });
      if (!committed.ok) return committed;
      const alignmentJobId = this.#enqueueInsufficientAlignment(assetId, transcribeResult);
      return success({
        sidecar,
        ...(committed.value.transactionId === undefined
          ? {}
          : { transactionId: committed.value.transactionId }),
        ...(alignmentJobId === undefined ? {} : { alignmentJobId }),
      });
    } catch (error: unknown) {
      return transcriptFailure(
        "E_TRANSCRIPT_CREATE",
        `Could not create canonical transcript for ${assetId}: ${errorMessage(error)}`,
        [assetId],
      );
    }
  }

  public async importSubtitles(path: string): Promise<Result<SubtitleImportResult>> {
    const project = this.#project;
    if (project === undefined) {
      return transcriptFailure(
        "E_TRANSCRIPT_PROJECT_NOT_ATTACHED",
        "TranscriptEngine.importSubtitles(path) requires a project in TranscriptEngineOptions.",
        [path],
      );
    }
    const extension = extname(path).toLowerCase();
    const format = extension === ".srt" ? "srt" : extension === ".vtt" ? "vtt" : undefined;
    if (format === undefined) {
      return transcriptFailure(
        "E_SUBTITLE_FORMAT",
        `Subtitle import supports .srt and .vtt files, not ${extension || "an extensionless path"}.`,
        [path],
      );
    }
    try {
      const bytes = await readFile(path);
      const assetId = this.#idFactory("ast");
      const jobId = this.#idFactory("job");
      const assetSha256 = createHash("sha256").update(bytes).digest("hex");
      const now = this.#now().toISOString();
      const imported = importSubtitleText(bytes.toString("utf8"), {
        format,
        assetId,
        firstWordOrdinal: project.currentProject.transcript.nextWordOrdinal,
        sampleRate: project.currentProject.settings.audio.sampleRate,
        now,
        jobId,
      });
      const content = serializeTranscriptSidecar(imported.sidecar);
      const contentHash = createHash("sha256").update(content).digest("hex");
      const reference: SidecarRef = {
        name: sidecarName(assetId),
        path: sidecarPath(assetId),
        schema: TRANSCRIPT_SCHEMA,
        sha256: contentHash,
        generatedBy: { tool: `${format}-import`, version: "1", job: jobId },
        inputs: [{ asset: assetId, sha256: assetSha256 }],
      };
      const asset: Asset = {
        id: assetId,
        kind: "subtitle",
        path: resolve(path),
        sha256: assetSha256,
        bytes: bytes.byteLength,
        container: format,
        probe: {},
        analyses: {},
        integrity: "ok",
        ingest: { at: now, ffprobeVersion: "subtitle-parser/1", via: "manual" },
      };
      const createOperation: OperationInput = {
        op: "transcript.create",
        params: {
          assetId,
          sidecar: { path: reference.path, sha256: contentHash },
          engine: imported.sidecar.provenance.engine,
          alignment: null,
          jobId,
        },
      };
      const anchorResolvers = new AnchorResolverRegistry();
      anchorResolvers.registerWordLookup(createTranscriptWordLookup([imported.sidecar]));
      const engine = new OperationEngine(project.currentProject, {
        appVersion: this.#appVersion,
        committer: new SidecarCommitter(project, new Map([[reference.path, content]])),
        idFactory: (prefix: IdPrefix) => this.#idFactory(prefix),
        now: this.#now,
        operationDispatcher: createDispatcher(
          createOperation,
          imported.nextWordOrdinal,
          reference,
        ),
        anchorResolvers,
      });
      const committed = await engine.execute([
        { op: "asset.ingest", params: { assets: [asset] } },
        createOperation,
      ], {
        baseRevision: project.currentProject.revision,
        origin: "ui",
        dryRun: false,
      });
      if (!committed.ok) return committed;
      return success({
        ...imported,
        assetId,
        ...(committed.value.transactionId === undefined
          ? {}
          : { transactionId: committed.value.transactionId }),
      });
    } catch (error: unknown) {
      return transcriptFailure(
        "E_SUBTITLE_IMPORT",
        `Could not import subtitles from ${path}: ${errorMessage(error)}`,
        [path],
      );
    }
  }

  public async realign(
    project: ProjectStore,
    request: TranscriptRealignRequest,
  ): Promise<Result<OperationBatchResult>> {
    const jobs = this.#alignmentJobs;
    if (jobs === undefined || !jobs.hasAlignCapability()) {
      return transcriptFailure(
        "E_ALIGN_CAPABILITY_UNAVAILABLE",
        "Forced alignment is unavailable in the configured mlworker.",
        [request.assetId],
      );
    }
    try {
      const workspace = await loadTranscriptWorkspace(
        project,
        (prefix) => this.#idFactory(prefix),
      );
      if (!workspace.ok) return workspace;
      const sidecar = workspace.value.sidecars.find(({ assetId }) => assetId === request.assetId);
      if (sidecar === undefined) {
        return transcriptFailure(
          "E_TRANSCRIPT_ASSET_NOT_FOUND",
          `Asset ${request.assetId} has no canonical transcript.`,
          [request.assetId],
        );
      }
      const scoped = scopedAlignmentSegments(sidecar, request);
      const job = jobs.queue.enqueue({
        kind: "align",
        title: `Realign transcript for ${request.assetId}`,
        cancellable: true,
        payload: alignmentPayload(
          jobs,
          request.assetId,
          sidecar.language,
          scoped.map(({ request }) => request),
        ),
      });
      const completed = await terminalJob(jobs.queue, job.jobId);
      if (completed.state === "failed" && completed.error !== undefined) {
        return failure(completed.error);
      }
      if (completed.state !== "done") {
        return transcriptFailure(
          "E_ALIGN_JOB_CANCELLED",
          `Alignment job ${job.jobId} was cancelled before producing timings.`,
          [request.assetId, job.jobId],
        );
      }
      const aligned = parseAlignResult(completed.payload);
      const expectedCount = scoped.reduce((count, segment) => count + segment.wordIds.length, 0);
      if (aligned.tokens.length !== expectedCount) {
        throw new RangeError(
          `Alignment returned ${String(aligned.tokens.length)} tokens for ${String(expectedCount)} words.`,
        );
      }
      const resultByPosition = new Map<string, AlignedToken>();
      for (const token of aligned.tokens) {
        const key = `${String(token.segmentIndex)}:${String(token.tokenIndex)}`;
        if (resultByPosition.has(key)) throw new RangeError(`Alignment returned duplicate token ${key}.`);
        resultByPosition.set(key, token);
      }
      const updates: Array<{
        wordId: string;
        start: SampleTime;
        end: SampleTime;
        confidence: number | null;
        alignment: "ctc" | "interpolated";
      }> = [];
      for (const segment of scoped) {
        const requestSource = jsonObject(segment.request, "alignment request segment");
        const segmentIndex = integer(requestSource["index"], "alignment request segment.index");
        let previousEnd = segment.start;
        for (const [tokenIndex, wordId] of segment.wordIds.entries()) {
          const token = resultByPosition.get(`${String(segmentIndex)}:${String(tokenIndex)}`);
          if (token === undefined) {
            throw new RangeError(`Alignment omitted segment ${String(segmentIndex)} token ${String(tokenIndex)}.`);
          }
          if (
            token.start.rate !== ANALYSIS_RATE ||
            token.end.rate !== ANALYSIS_RATE ||
            compareSampleTime(token.start, token.end) >= 0 ||
            compareSampleTime(token.start, previousEnd) < 0 ||
            compareSampleTime(token.start, segment.start) < 0 ||
            compareSampleTime(token.end, segment.end) > 0
          ) {
            throw new RangeError(`Alignment returned invalid timing for ${wordId}.`);
          }
          previousEnd = token.end;
          if (token.aligned && token.score < ALIGNMENT_CONFIDENCE_THRESHOLD) continue;
          const word = sidecar.words[wordId]!;
          updates.push({
            wordId,
            start: nativeTime(token.start, sidecar.audio.rate),
            end: nativeTime(token.end, sidecar.audio.rate),
            confidence: token.aligned
              ? word.confidence === null ? token.score : word.confidence * token.score
              : word.confidence,
            alignment: token.aligned ? "ctc" : "interpolated",
          });
        }
      }
      return this.execute(
        project,
        [{
          op: "transcript.realign",
          params: {
            assetId: request.assetId,
            ...(request.wordRange === undefined ? {} : { wordRange: request.wordRange }),
            updates,
            alignment: aligned.engine,
            jobId: job.jobId,
          },
        }],
      );
    } catch (error: unknown) {
      return transcriptFailure(
        "E_TRANSCRIPT_REALIGN",
        `Could not realign transcript for ${request.assetId}: ${errorMessage(error)}`,
        [request.assetId],
      );
    }
  }

  public async execute(
    project: ProjectStore,
    operations: OperationInput[],
    context: Omit<OperationContext, "baseRevision"> = {
      origin: "ui",
      dryRun: false,
    },
  ): Promise<Result<OperationBatchResult>> {
    const workspace = await loadTranscriptWorkspace(
      project,
      (prefix) => this.#idFactory(prefix),
    );
    if (!workspace.ok) return workspace;
    const anchorResolvers = new AnchorResolverRegistry();
    anchorResolvers.registerWordLookup(createTranscriptWordLookup([
      ...workspace.value.sidecars.map((sidecar) => structuredClone(sidecar)),
      ...workspace.value.sidecars,
    ]));
    const engine = new OperationEngine(project.currentProject, {
      appVersion: this.#appVersion,
      committer: new SidecarCommitter(project, workspace.value.writes),
      idFactory: (prefix: IdPrefix) => this.#idFactory(prefix),
      now: this.#now,
      operationDispatcher: workspace.value.dispatcher,
      anchorResolvers,
      continuityGuard: createTranscriptContinuityGuard({
        sidecars: workspace.value.sidecars,
        ...(this.#loadPeaks === undefined ? {} : { loadPeaks: this.#loadPeaks }),
      }),
    });
    return engine.execute(operations, {
      ...context,
      baseRevision: project.currentProject.revision,
    });
  }

  public findWord(wordId: string): Promise<Result<WordLocation | undefined>> {
    return this.#project === undefined
      ? Promise.resolve(transcriptFailure(
          "E_TRANSCRIPT_PROJECT_NOT_ATTACHED",
          "TranscriptEngine.findWord(wordId) requires a project in TranscriptEngineOptions.",
          [wordId],
        ))
      : findProjectWord(this.#project, wordId);
  }

  public resolveWord(wordId: string): Promise<Result<WordResolution | undefined>> {
    return this.#project === undefined
      ? Promise.resolve(transcriptFailure(
          "E_TRANSCRIPT_PROJECT_NOT_ATTACHED",
          "TranscriptEngine.resolveWord(wordId) requires a project in TranscriptEngineOptions.",
          [wordId],
        ))
      : resolveProjectWord(this.#project, wordId);
  }
}
