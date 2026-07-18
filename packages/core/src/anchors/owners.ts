import type {
  AnchorLastResolved,
  AnchorResolverDependencies,
  SemanticAnchor,
} from "./types.js";
import type {
  AnchorMetadata,
  Beat,
  Clip,
  GuyditorProject,
  PlacedItem,
} from "../project/model.js";
import { parseAnchor } from "./parser.js";

export type StoredAnchorPath = "/anchor" | "/at" | "/duration/until";

export interface StoredAnchorReference {
  owner: string;
  anchor: SemanticAnchor;
  anchorPath: StoredAnchorPath;
  modelPath: string;
  scope?: string;
  metadata?: AnchorMetadata[StoredAnchorPath];
}

type AnchorOwner = Beat | Clip | PlacedItem;

function reference(
  owner: AnchorOwner,
  anchor: SemanticAnchor,
  anchorPath: StoredAnchorPath,
  modelPath: string,
  scope: string | undefined,
): StoredAnchorReference {
  return {
    owner: owner.id,
    anchor,
    anchorPath,
    modelPath,
    ...(scope === undefined ? {} : { scope }),
    ...(owner.anchorMetadata?.[anchorPath] === undefined
      ? {}
      : { metadata: owner.anchorMetadata[anchorPath] }),
  };
}

export function storedAnchors(project: GuyditorProject): StoredAnchorReference[] {
  const anchors: StoredAnchorReference[] = project.beats.map((beat) =>
    reference(
      beat,
      beat.anchor,
      "/anchor",
      `/beats/${beat.id}/anchor`,
      undefined,
    ));
  for (const sequence of project.sequences) {
    for (const clip of sequence.clips) {
      if (clip.anchor !== undefined) {
        anchors.push(reference(
          clip,
          clip.anchor,
          "/anchor",
          `/sequences/${sequence.id}/clips/${clip.id}/anchor`,
          sequence.id,
        ));
      }
    }
  }
  for (const layer of project.layers) {
    for (const item of layer.items ?? []) {
      anchors.push(reference(
        item,
        item.at,
        "/at",
        `/layers/${layer.id}/items/${item.id}/at`,
        layer.sequence,
      ));
      if (typeof item.duration === "object" && "until" in item.duration) {
        anchors.push(reference(
          item,
          item.duration.until,
          "/duration/until",
          `/layers/${layer.id}/items/${item.id}/duration/until`,
          layer.sequence,
        ));
      }
    }
  }
  return anchors;
}

export function findStoredAnchor(
  project: GuyditorProject,
  ownerId: string,
  anchorPath: StoredAnchorPath,
): StoredAnchorReference | undefined {
  return storedAnchors(project).find(({ owner, anchorPath: path }) =>
    owner === ownerId && path === anchorPath);
}

function findOwner(project: GuyditorProject, ownerId: string): AnchorOwner | undefined {
  return project.beats.find(({ id }) => id === ownerId) ??
    project.sequences.flatMap(({ clips }) => clips).find(({ id }) => id === ownerId) ??
    project.layers.flatMap(({ items }) => items ?? []).find(({ id }) => id === ownerId);
}

function setMetadata(
  owner: AnchorOwner,
  anchorPath: StoredAnchorPath,
  lastResolved: AnchorLastResolved | undefined,
): void {
  if (lastResolved === undefined) {
    if (owner.anchorMetadata === undefined) return;
    delete owner.anchorMetadata[anchorPath];
    if (Object.keys(owner.anchorMetadata).length === 0) delete owner.anchorMetadata;
    return;
  }
  owner.anchorMetadata = {
    ...owner.anchorMetadata,
    [anchorPath]: { lastResolved: structuredClone(lastResolved) },
  };
}

export function updateStoredAnchor(
  project: GuyditorProject,
  ownerId: string,
  anchorPath: StoredAnchorPath,
  anchor: SemanticAnchor,
  lastResolved: AnchorLastResolved | undefined,
): GuyditorProject | undefined {
  const updated = structuredClone(project);
  const owner = findOwner(updated, ownerId);
  if (owner === undefined) return undefined;
  if (anchorPath === "/anchor") {
    if (!("anchor" in owner)) return undefined;
    owner.anchor = anchor;
  } else if (anchorPath === "/at") {
    if (!("at" in owner)) return undefined;
    owner.at = anchor;
  } else {
    if (!("duration" in owner) || typeof owner.duration !== "object" || !("until" in owner.duration)) {
      return undefined;
    }
    owner.duration.until = anchor;
  }
  setMetadata(owner, anchorPath, lastResolved);
  return updated;
}

export function writeLastResolved(
  project: GuyditorProject,
  ownerId: string,
  anchorPath: StoredAnchorPath,
  lastResolved: AnchorLastResolved,
): GuyditorProject | undefined {
  const current = findStoredAnchor(project, ownerId, anchorPath);
  return current === undefined
    ? undefined
    : updateStoredAnchor(project, ownerId, anchorPath, current.anchor, lastResolved);
}

export async function neighboringWordContext(
  project: GuyditorProject,
  reference: StoredAnchorReference,
  dependencies: AnchorResolverDependencies,
): Promise<AnchorLastResolved["context"] | undefined> {
  const parsed = parseAnchor(reference.anchor);
  if (!parsed.ok || parsed.value.kind !== "word" || dependencies.wordLookup === undefined) {
    return undefined;
  }
  const word = await dependencies.wordLookup.resolveWord(project, parsed.value.wordId);
  const context = word.ok ? word.value?.context : undefined;
  return context === undefined
    ? undefined
    : {
        wordsBefore: context.wordsBefore.slice(-5),
        wordsAfter: context.wordsAfter.slice(0, 5),
      };
}
