import {
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type { GuyditorProject } from "../project/model.js";
import type { ValidationIssue } from "../operations/types.js";
import { resolveAnchor } from "./resolver.js";
import {
  neighboringWordContext,
  storedAnchors,
  writeLastResolved,
} from "./owners.js";
import type { StoredAnchorReference } from "./owners.js";
import type {
  AnchorLastResolved,
  AnchorResolution,
  AnchorResolverDependencies,
} from "./types.js";

export interface OrphanedAnchorRecord {
  owner: string;
  anchor: string;
  anchorPath: StoredAnchorReference["anchorPath"];
  reason: NonNullable<AnchorResolution["reason"]>;
  lastResolved?: AnchorLastResolved;
}

export interface AnchorValidationReport {
  issues: ValidationIssue[];
  orphanedAnchors: OrphanedAnchorRecord[];
}

export interface AnchorTransitionResult {
  project: GuyditorProject;
  orphanedAnchors: OrphanedAnchorRecord[];
}

function keyOf(reference: StoredAnchorReference): string {
  return `${reference.owner}\u0000${reference.anchorPath}`;
}

export async function computeAnchorTransitions(
  before: GuyditorProject,
  after: GuyditorProject,
  dependencies: AnchorResolverDependencies = {},
): Promise<Result<AnchorTransitionResult>> {
  const beforeByOwnerPath = new Map(
    storedAnchors(before).map((reference) => [keyOf(reference), reference] as const),
  );
  let project = after;
  const orphanedAnchors: OrphanedAnchorRecord[] = [];

  for (const afterReference of storedAnchors(after)) {
    const beforeReference = beforeByOwnerPath.get(keyOf(afterReference));
    if (beforeReference === undefined) continue;
    const beforeResolution = await resolveAnchor(
      before,
      beforeReference.anchor,
      beforeReference.scope,
      dependencies,
    );
    if (!beforeResolution.ok) return beforeResolution;
    const afterResolution = await resolveAnchor(
      after,
      afterReference.anchor,
      afterReference.scope,
      dependencies,
    );
    if (!afterResolution.ok) return afterResolution;
    if (
      beforeResolution.value.status !== "resolved" ||
      beforeResolution.value.timeline === undefined ||
      afterResolution.value.status !== "orphaned" ||
      afterResolution.value.reason === undefined
    ) {
      continue;
    }

    const preservedInverseMetadata =
      beforeReference.anchor !== afterReference.anchor
        ? afterReference.metadata?.lastResolved
        : undefined;
    const context = await neighboringWordContext(before, beforeReference, dependencies);
    const lastResolved: AnchorLastResolved = preservedInverseMetadata ?? {
      timeline: beforeResolution.value.timeline,
      revision: before.revision,
      ...(context === undefined ? {} : { context }),
    };
    const updated = writeLastResolved(
      project,
      afterReference.owner,
      afterReference.anchorPath,
      lastResolved,
    );
    if (updated !== undefined) project = updated;
    orphanedAnchors.push({
      owner: afterReference.owner,
      anchor: afterReference.anchor,
      anchorPath: afterReference.anchorPath,
      reason: afterResolution.value.reason,
      lastResolved,
    });
  }
  return success({ project, orphanedAnchors });
}

export async function validateProjectAnchors(
  project: GuyditorProject,
  scope: string | undefined = undefined,
  dependencies: AnchorResolverDependencies = {},
): Promise<Result<AnchorValidationReport>> {
  const orphanedAnchors: OrphanedAnchorRecord[] = [];
  const issues: ValidationIssue[] = [];
  for (const reference of storedAnchors(project)) {
    const resolution = await resolveAnchor(
      project,
      reference.anchor,
      reference.scope ?? scope,
      dependencies,
    );
    if (!resolution.ok) return resolution;
    if (resolution.value.status !== "orphaned" || resolution.value.reason === undefined) {
      continue;
    }
    const orphan: OrphanedAnchorRecord = {
      owner: reference.owner,
      anchor: reference.anchor,
      anchorPath: reference.anchorPath,
      reason: resolution.value.reason,
      ...(reference.metadata?.lastResolved === undefined
        ? {}
        : { lastResolved: reference.metadata.lastResolved }),
    };
    orphanedAnchors.push(orphan);
    issues.push({
      code: "W_ANCHOR_ORPHANED",
      severity: "warning",
      message: `Anchor ${reference.anchor} is orphaned (${resolution.value.reason}).`,
      path: reference.modelPath,
      affected: [reference.owner],
    });
  }
  return success({ issues, orphanedAnchors });
}
