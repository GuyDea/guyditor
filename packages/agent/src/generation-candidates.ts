import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  GenerationProvenance,
  GenerationReviewAnnotation,
  RightsMetadata,
} from "../../core/src/index.js";
import type { GenerationRequest } from "./adapters/types.js";

export interface GenerationCandidate {
  candidateId: string;
  jobId: string;
  index: number;
  status: "review" | "proposed" | "rejected";
  filePath: string;
  previewPath: string;
  mime: string;
  width: number;
  height: number;
  durationSeconds?: number;
  seed?: number;
  request: GenerationRequest;
  provenance: Omit<GenerationProvenance, "assetId" | "reviewAnnotationId">;
  review: GenerationReviewAnnotation;
  rawResponseRef: string;
  proposalId?: string;
}

export interface GenerationCandidateStoreOptions {
  projectRoot: string;
}

function serializable(candidate: GenerationCandidate): string {
  return `${JSON.stringify(candidate, null, 2)}\n`;
}

function isCandidate(value: unknown): value is GenerationCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["candidateId"] === "string" &&
    typeof record["jobId"] === "string" &&
    typeof record["index"] === "number" &&
    (record["status"] === "review" || record["status"] === "proposed" ||
      record["status"] === "rejected") &&
    typeof record["filePath"] === "string" &&
    typeof record["request"] === "object" && record["request"] !== null &&
    typeof record["provenance"] === "object" && record["provenance"] !== null &&
    typeof record["review"] === "object" && record["review"] !== null;
}

export class GenerationCandidateStore {
  readonly #projectRoot: string;
  readonly #candidates = new Map<string, GenerationCandidate>();

  public constructor(options: GenerationCandidateStoreOptions) {
    this.#projectRoot = options.projectRoot;
    const root = join(this.#projectRoot, ".guyditor/cache/generations");
    try {
      for (const job of readdirSync(root, { withFileTypes: true })) {
        if (!job.isDirectory()) continue;
        for (const name of readdirSync(join(root, job.name))) {
          if (!/^candidate-\d+\.json$/u.test(name)) continue;
          try {
            const parsed = JSON.parse(readFileSync(join(root, job.name, name), "utf8")) as unknown;
            if (isCandidate(parsed)) this.#candidates.set(parsed.candidateId, structuredClone(parsed));
          } catch {
            // Candidate cache is disposable; a malformed entry is ignored and never accepted.
          }
        }
      }
    } catch {
      // The cache directory is created lazily on the first generated candidate.
    }
  }

  public get(candidateId: string): GenerationCandidate | undefined {
    const candidate = this.#candidates.get(candidateId);
    return candidate === undefined ? undefined : structuredClone(candidate);
  }

  public list(): GenerationCandidate[] {
    return [...this.#candidates.values()]
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
      .map((candidate) => structuredClone(candidate));
  }

  public async save(candidate: GenerationCandidate): Promise<void> {
    this.#candidates.set(candidate.candidateId, structuredClone(candidate));
    const directory = join(this.#projectRoot, ".guyditor/cache/generations", candidate.jobId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `candidate-${String(candidate.index)}.json`),
      serializable(candidate),
      "utf8",
    );
    await writeFile(
      join(directory, `candidate-${String(candidate.index)}.provenance.json`),
      `${JSON.stringify(candidate.provenance, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(directory, `candidate-${String(candidate.index)}.review.json`),
      `${JSON.stringify(candidate.review, null, 2)}\n`,
      "utf8",
    );
  }
}

export function normalizedGenerationRights(
  provider: string,
  rights: Partial<RightsMetadata> | undefined,
): RightsMetadata {
  return {
    origin: rights?.origin ?? "generated",
    ...(rights?.licenseName === undefined ? {} : { licenseName: rights.licenseName }),
    ...(rights?.licenseUrl === undefined ? {} : { licenseUrl: rights.licenseUrl }),
    licensor: rights?.licensor ?? provider,
    ...(rights?.purchaseRef === undefined ? {} : { purchaseRef: rights.purchaseRef }),
    restrictions: [...(rights?.restrictions ?? [])],
    ...(rights?.attributionText === undefined ? {} : { attributionText: rights.attributionText }),
    ...(rights?.providerTermsUrl === undefined
      ? {}
      : { providerTermsUrl: rights.providerTermsUrl }),
    confirmedBy: rights?.confirmedBy ?? "provider",
    ...(rights?.confirmedAt === undefined ? {} : { confirmedAt: rights.confirmedAt }),
  };
}
