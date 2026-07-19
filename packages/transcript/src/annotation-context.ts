import { createHash } from "node:crypto";

import {
  success,
} from "../../core/src/index.js";
import type {
  AnnotationTranscriptSource,
  GuyditorProject,
} from "../../core/src/index.js";
import { createTranscriptWordLookup } from "./anchor-lookup.js";
import { serializeTranscriptSidecar } from "./sidecar.js";
import type { TranscriptSidecar } from "./types.js";

function hash(sidecar: TranscriptSidecar): string {
  return createHash("sha256").update(serializeTranscriptSidecar(sidecar)).digest("hex");
}

function selectedSidecars(
  project: GuyditorProject,
  sidecars: readonly TranscriptSidecar[],
): TranscriptSidecar[] {
  return project.sidecars.flatMap((reference) => {
    if (reference.schema !== "guyditor.transcript/v1") return [];
    const selected = sidecars.find((sidecar) =>
      hash(sidecar) === reference.sha256 &&
      sidecar.assetId === reference.inputs.find(({ asset }) => asset !== undefined)?.asset);
    return selected === undefined ? [] : [selected];
  });
}

export function createAnnotationTranscriptSource(
  sidecars: readonly TranscriptSidecar[],
): AnnotationTranscriptSource {
  const wordLookup = createTranscriptWordLookup(sidecars);
  return {
    resolveWord(project, wordId) {
      return wordLookup.resolveWord(project, wordId);
    },
    listWords(project, assetId) {
      const words = selectedSidecars(project, sidecars)
        .filter((sidecar) => sidecar.assetId === assetId)
        .flatMap((sidecar) => sidecar.segments.flatMap((segment) =>
          segment.words.flatMap((wordId) => {
            const word = sidecar.words[wordId];
            return word?.state !== "active"
              ? []
              : [{
                  id: wordId,
                  text: word.text,
                  assetId,
                  start: word.start,
                  end: word.end,
                }];
          })));
      return success(words);
    },
  };
}
