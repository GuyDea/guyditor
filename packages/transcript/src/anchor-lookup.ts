import { createHash } from "node:crypto";

import type {
  AnchorResolverRegistry,
  GuyditorProject,
  ProjectStore,
  Result,
  WordLookup,
  WordLookupResolution,
} from "../../core/src/index.js";

import {
  resolveWord as resolveProjectWord,
  resolveWordFromSidecars,
} from "./lookup.js";
import { serializeTranscriptSidecar } from "./sidecar.js";
import type {
  TranscriptSidecar,
  WordResolution,
} from "./types.js";

function adapted(
  resolution: Result<WordResolution | undefined>,
): Result<WordLookupResolution | undefined> {
  if (!resolution.ok) return { ok: false, error: resolution.error };
  return resolution.value === undefined
    ? { ok: true, value: undefined }
    : {
        ok: true,
        value: {
          wordId: resolution.value.wordId,
          assetId: resolution.value.assetId,
          start: resolution.value.word.start,
          end: resolution.value.word.end,
          approximate: resolution.value.approximate,
          context: resolution.value.context,
        },
      };
}

function sidecarHash(sidecar: TranscriptSidecar): string {
  return createHash("sha256")
    .update(serializeTranscriptSidecar(sidecar))
    .digest("hex");
}

/**
 * A project-aware lookup over immutable/live sidecar versions. The project
 * sidecar registry hash selects the correct snapshot for before/after engine
 * resolution passes.
 */
export function createTranscriptWordLookup(
  sidecars: readonly TranscriptSidecar[],
): WordLookup {
  return {
    resolveWord(project: GuyditorProject, wordId: string) {
      const variants = sidecars.map((sidecar) => ({
        sidecar,
        sha256: sidecarHash(sidecar),
      }));
      const selected = project.sidecars.flatMap((reference) => {
        if (reference.schema !== "guyditor.transcript/v1") return [];
        const assetId = reference.inputs.find(({ asset }) => asset !== undefined)?.asset;
        const match = variants.find(({ sidecar, sha256 }) =>
          sha256 === reference.sha256 &&
          (assetId === undefined || sidecar.assetId === assetId));
        return match === undefined
          ? []
          : [{ name: reference.name, sidecar: match.sidecar }];
      });
      return adapted(resolveWordFromSidecars(selected, wordId));
    },
  };
}

/** Register the accepted on-disk transcript lookup for navigation/queries. */
export function registerTranscriptWordLookup(
  registry: AnchorResolverRegistry,
  store: ProjectStore,
): void {
  registry.registerWordLookup({
    async resolveWord(_project, wordId) {
      return adapted(await resolveProjectWord(store, wordId));
    },
  });
}
