import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  OperationEngine,
  failure,
  formatWordId,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type {
  GuyditorProject,
  IdPrefix,
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
import {
  findWord as findProjectWord,
  resolveWord as resolveProjectWord,
} from "./lookup.js";
import { serializeTranscriptSidecar } from "./sidecar.js";
import type {
  RawTranscriptionSegment,
  RawTranscriptionWord,
  SampleTime,
  TranscribeResult,
  TranscriptSegment,
  TranscriptSidecar,
  TranscriptWord,
  WordLocation,
  WordResolution,
} from "./types.js";

const TRANSCRIPT_SCHEMA = "guyditor.transcript/v1";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
let temporaryOrdinal = 0;

export interface TranscriptEngineOptions {
  idFactory?: (prefix: "seg" | "spk" | "txn") => string;
  now?: () => Date;
  appVersion?: string;
  project?: ProjectStore;
}

export interface TranscriptMutationResult {
  sidecar: TranscriptSidecar;
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

function randomDomainId(prefix: "seg" | "spk" | "txn"): string {
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

export class TranscriptEngine {
  readonly #idFactory: (prefix: "seg" | "spk" | "txn") => string;
  readonly #now: () => Date;
  readonly #appVersion: string;
  readonly #project: ProjectStore | undefined;

  public constructor(options: TranscriptEngineOptions = {}) {
    this.#idFactory = options.idFactory ?? randomDomainId;
    this.#now = options.now ?? (() => new Date());
    this.#appVersion = options.appVersion ?? "0.0.0";
    this.#project = options.project;
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
      const engine = new OperationEngine(project.currentProject, {
        appVersion: this.#appVersion,
        committer: new SidecarCommitter(project, new Map([[reference.path, content]])),
        idFactory: (prefix: IdPrefix) => prefix === "txn"
          ? this.#idFactory("txn")
          : randomDomainId("txn"),
        now: this.#now,
        operationDispatcher: createDispatcher(operation, nextOrdinal, reference),
      });
      const committed = await engine.execute([operation], {
        baseRevision: project.currentProject.revision,
        origin: "system",
        dryRun: false,
      });
      if (!committed.ok) return committed;
      return success({
        sidecar,
        ...(committed.value.transactionId === undefined
          ? {}
          : { transactionId: committed.value.transactionId }),
      });
    } catch (error: unknown) {
      return transcriptFailure(
        "E_TRANSCRIPT_CREATE",
        `Could not create canonical transcript for ${assetId}: ${errorMessage(error)}`,
        [assetId],
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
    const engine = new OperationEngine(project.currentProject, {
      appVersion: this.#appVersion,
      committer: new SidecarCommitter(project, workspace.value.writes),
      idFactory: (prefix: IdPrefix) => prefix === "txn"
        ? this.#idFactory("txn")
        : randomDomainId("txn"),
      now: this.#now,
      operationDispatcher: workspace.value.dispatcher,
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
