import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  failure,
  makeGuyditorError,
  success,
} from "../../core/src/index.js";
import type { ProjectStore, Result } from "../../core/src/index.js";

import { parseTranscriptSidecar } from "./sidecar.js";
import type {
  TranscriptSidecar,
  WordLocation,
  WordResolution,
} from "./types.js";

interface IndexedTranscript {
  locations: Map<string, WordLocation>;
  sidecars: Map<string, TranscriptSidecar>;
}

function lookupFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function indexTranscripts(project: ProjectStore): Promise<Result<IndexedTranscript>> {
  const locations = new Map<string, WordLocation>();
  const sidecars = new Map<string, TranscriptSidecar>();
  try {
    for (const reference of project.currentProject.sidecars) {
      if (reference.schema !== "guyditor.transcript/v1") continue;
      const content = await readFile(join(project.root, reference.path), "utf8");
      if (contentHash(content) !== reference.sha256) {
        return lookupFailure(
          "E_SIDECAR_MODIFIED",
          `Transcript sidecar ${reference.path} does not match its registered SHA-256.`,
          [reference.name],
        );
      }
      const sidecar = parseTranscriptSidecar(content);
      sidecars.set(reference.name, sidecar);
      for (const segment of sidecar.segments) {
        for (const wordId of segment.words) {
          if (locations.has(wordId)) {
            return lookupFailure(
              "E_TRANSCRIPT_WORD_ID_CONFLICT",
              `Project-global word ID ${wordId} occurs in more than one transcript.`,
              [wordId],
            );
          }
          locations.set(wordId, {
            assetId: sidecar.assetId,
            segmentId: segment.id,
            sidecarName: reference.name,
            wordId,
            word: sidecar.words[wordId]!,
          });
        }
      }
    }
    return success({ locations, sidecars });
  } catch (error: unknown) {
    return lookupFailure(
      "E_TRANSCRIPT_LOAD",
      `Could not index canonical transcript sidecars: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function findWord(
  project: ProjectStore,
  wordId: string,
): Promise<Result<WordLocation | undefined>> {
  const indexed = await indexTranscripts(project);
  return indexed.ok ? success(indexed.value.locations.get(wordId)) : indexed;
}

function firstActiveDescendant(
  wordId: string,
  locations: ReadonlyMap<string, WordLocation>,
  visited: Set<string>,
): WordLocation | undefined {
  if (visited.has(wordId)) return undefined;
  visited.add(wordId);
  const location = locations.get(wordId);
  if (location === undefined) return undefined;
  if (location.word.state === "active") return location;
  for (const replacementId of location.word.replacedBy ?? []) {
    const active = firstActiveDescendant(replacementId, locations, visited);
    if (active !== undefined) return active;
  }
  return undefined;
}

function midpointDistance(left: WordLocation, right: WordLocation): bigint {
  const leftSum = BigInt(left.word.start.samples + left.word.end.samples);
  const rightSum = BigInt(right.word.start.samples + right.word.end.samples);
  const difference = leftSum * BigInt(right.word.start.rate) -
    rightSum * BigInt(left.word.start.rate);
  return difference < 0n ? -difference : difference;
}

function isWithinTwoSeconds(left: WordLocation, right: WordLocation): boolean {
  return midpointDistance(left, right) <=
    4n * BigInt(left.word.start.rate) * BigInt(right.word.start.rate);
}

function sourceOrder(left: WordLocation, right: WordLocation): number {
  const difference = BigInt(left.word.start.samples) * BigInt(right.word.start.rate) -
    BigInt(right.word.start.samples) * BigInt(left.word.start.rate);
  return difference < 0n ? -1 : difference > 0n ? 1 : left.wordId.localeCompare(right.wordId);
}

export async function resolveWord(
  project: ProjectStore,
  wordId: string,
): Promise<Result<WordResolution | undefined>> {
  const indexed = await indexTranscripts(project);
  if (!indexed.ok) return indexed;
  const requested = indexed.value.locations.get(wordId);
  if (requested === undefined) return success(undefined);
  if (requested.word.state === "active") {
    return success({ ...requested, requestedWordId: wordId, approximate: false });
  }
  const descendant = firstActiveDescendant(wordId, indexed.value.locations, new Set());
  if (descendant !== undefined) {
    return success({ ...descendant, requestedWordId: wordId, approximate: false });
  }

  const sidecar = indexed.value.sidecars.get(requested.sidecarName);
  const segment = sidecar?.segments.find(({ id }) => id === requested.segmentId);
  const nearest = segment?.words
    .flatMap((candidateId) => {
      const candidate = indexed.value.locations.get(candidateId);
      return candidate?.word.state === "active" && isWithinTwoSeconds(requested, candidate)
        ? [candidate]
        : [];
    })
    .sort((left, right) => {
      const leftDistance = midpointDistance(requested, left);
      const rightDistance = midpointDistance(requested, right);
      return leftDistance < rightDistance
        ? -1
        : leftDistance > rightDistance
          ? 1
          : sourceOrder(left, right);
    })[0];
  return nearest === undefined
    ? success(undefined)
    : success({ ...nearest, requestedWordId: wordId, approximate: true });
}
