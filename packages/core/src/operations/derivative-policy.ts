import { placedItemAppliesToSequence } from "../anchors/applicability.js";
import type { GuyditorProject, PlacedItem } from "../project/model.js";

export type DerivativeImpact = "content" | "non-editorial" | "baseline";
export type DerivativeTargetResolver =
  | "none"
  | "scope"
  | "transition-owner"
  | "annotation-conversion"
  | "new-graphic"
  | "template-uses";

export interface DerivativeOperationPolicy {
  impact: DerivativeImpact;
  target: DerivativeTargetResolver;
}

export interface DerivativeTargetOperation {
  op: string;
  params: Readonly<Record<string, unknown>>;
  affected?: readonly string[];
}

const content = (
  target: Exclude<DerivativeTargetResolver, "none"> = "scope",
): DerivativeOperationPolicy => ({ impact: "content", target });
const nonEditorial = (): DerivativeOperationPolicy => ({
  impact: "non-editorial",
  target: "none",
});
const baseline = (): DerivativeOperationPolicy => ({
  impact: "baseline",
  target: "none",
});

/**
 * Closed derivative policy for the semantic operation catalog. Engine startup
 * verifies this table and the executable catalog have exactly the same keys.
 */
export const DERIVATIVE_OPERATION_POLICIES = Object.freeze({
  "asset.ingest": nonEditorial(),
  "asset.remove": nonEditorial(),
  "asset.rights.set": nonEditorial(),
  "asset.markers.attach": nonEditorial(),
  "asset.takes.set": nonEditorial(),
  "project.watchFolders.set": nonEditorial(),
  "skill.pin.set": nonEditorial(),
  "clip.trim": content(),
  "clip.split": content(),
  "clip.join": content(),
  "clip.remove": content(),
  "clip.restore": content(),
  "clip.insert": content(),
  "clip.move": content(),
  "clip.duplicate": content(),
  "clip.gap.set": content(),
  "clip.overlap.set": content(),
  "layer.add": content(),
  "layer.remove": content(),
  "layer.reorder": content(),
  "layer.enable": content(),
  "layer.disable": content(),
  "layer.lock": nonEditorial(),
  "layer.unlock": nonEditorial(),
  "layer.set": content(),
  "layer.transform.set": content(),
  "layer.matte.set": content(),
  "pip.style.set": content(),
  "pip.place": content(),
  "pip.keyframe.add": content(),
  "pip.keyframe.remove": content(),
  "pip.preset.apply": content(),
  "pip.avoid.solve": nonEditorial(),
  "region.mark": nonEditorial(),
  "clip.key.set": content(),
  "clip.key.mask.set": content(),
  "clip.transform.set": content(),
  "clip.punchin.set": content(),
  "clip.source.switch": content(),
  "composition.arrange": content(),
  "key.qc.run": nonEditorial(),
  "key.matte.generate": nonEditorial(),
  "clip.audio.gain.set": content(),
  "clip.audio.fade.set": content(),
  "clip.audio.offset.set": content(),
  "clip.audio.channels.set": content(),
  "clip.audio.chain.set": content(),
  "sequence.audio.master.set": content(),
  "clip.loop.set": content(),
  "clip.anchor.set": content(),
  "layer.ducking.set": content(),
  "layer.ducking.override": content(),
  "clip.color.set": content(),
  "clip.look.apply": content(),
  "transition.set": content(),
  "transition.remove": content("transition-owner"),
  "pickup.splice": content(),
  "transcript.create": baseline(),
  "transcript.word.correct": nonEditorial(),
  "transcript.word.replace": nonEditorial(),
  "transcript.word.insert": nonEditorial(),
  "transcript.word.delete": nonEditorial(),
  "transcript.word.retime": nonEditorial(),
  "transcript.segment.split": nonEditorial(),
  "transcript.segment.merge": nonEditorial(),
  "transcript.speaker.assign": nonEditorial(),
  "transcript.realign": nonEditorial(),
  "transcript.range.remove": content(),
  "transcript.range.retain": content(),
  "transcript.range.createClip": content(),
  "transcript.range.shortCandidate": nonEditorial(),
  "caption.track.add": nonEditorial(),
  "caption.track.remove": content(),
  "caption.track.set": content(),
  "caption.style.set": content(),
  "caption.break.set": content(),
  "caption.break.clear": content(),
  "caption.word.emphasis.set": content(),
  "caption.cue.retime": content(),
  "caption.preset.upgrade": content(),
  "anchor.rebind": content(),
  "annotation.create": nonEditorial(),
  "annotation.update": nonEditorial(),
  "annotation.delete": nonEditorial(),
  "annotation.resolve": nonEditorial(),
  "annotation.reject": nonEditorial(),
  "annotation.reopen": nonEditorial(),
  "annotation.convert": content("annotation-conversion"),
  "graphic.add": content("new-graphic"),
  "graphic.param.set": content(),
  "graphic.anchor.set": content(),
  "graphic.retime": content(),
  "graphic.remove": content(),
  "template.pin": content("template-uses"),
  "template.install": nonEditorial(),
  "template.uninstall": nonEditorial(),
  "template.freeze": content(),
  "restyle.plan.create": baseline(),
  "restyle.segment.approve": content(),
  "generation.accept": content(),
  "seam.treatment.set": baseline(),
  "deliverable.derive": baseline(),
  "deliverable.status.set": baseline(),
  "deliverable.approve": baseline(),
  "deliverable.refresh": baseline(),
  "deliverable.remove": baseline(),
  "deliverable.framing.override": content(),
  "deliverable.metadata.set": baseline(),
  "deliverable.chapters.set": baseline(),
  "deliverable.publish.approve": baseline(),
  "deliverable.thumbnail.select": baseline(),
  "deliverable.publish.files.set": baseline(),
  "sidecar.register": nonEditorial(),
  "take.select": nonEditorial(),
} as const satisfies Readonly<Record<string, DerivativeOperationPolicy>>);

export type CataloguedOperationName = keyof typeof DERIVATIVE_OPERATION_POLICIES;

function nestedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(nestedStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(nestedStrings);
}

function applicableLayerItems(
  project: GuyditorProject,
  sequenceId: string,
): Array<{ layerId: string; itemIds: string[] }> {
  return project.layers.flatMap((layer) => {
    const sequenceOwned = layer.sequence === sequenceId;
    const globalAdjustment = layer.kind === "adjustment";
    const itemIds = (layer.items ?? [])
      .filter((item) => placedItemAppliesToSequence(project, item, sequenceId))
      .map(({ id }) => id);
    if (!sequenceOwned && !globalAdjustment && itemIds.length === 0) return [];
    return [{ layerId: layer.id, itemIds }];
  });
}

function shortScopeIds(project: GuyditorProject, deliverableId: string): Set<string> {
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined || deliverable.kind !== "short") return new Set();
  const sequence = project.sequences.find(({ id }) => id === deliverable.sequenceId);
  const layers = applicableLayerItems(project, deliverable.sequenceId);
  return new Set([
    deliverable.id,
    deliverable.sequenceId,
    ...(sequence?.clips.map(({ id }) => id) ?? []),
    ...layers.map(({ layerId }) => layerId),
    ...layers.flatMap(({ itemIds }) => itemIds),
    ...(deliverable.captionsTrackId === undefined ? [] : [deliverable.captionsTrackId]),
  ]);
}

function targetValues(
  value: unknown,
  names: readonly string[],
): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Readonly<Record<string, unknown>>;
  return names.flatMap((name) =>
    typeof record[name] === "string" ? [record[name]] : []);
}

function transitionOwnerTargets(
  project: GuyditorProject,
  operation: DerivativeTargetOperation,
): string[] {
  const transitionId = operation.params["transitionId"];
  if (typeof transitionId !== "string") return [...(operation.affected ?? [])];
  return [
    ...(operation.affected ?? []),
    ...project.sequences.flatMap(({ clips }) =>
      clips
        .filter(({ transitionAfter }) => transitionAfter?.id === transitionId)
        .map(({ id }) => id)),
  ];
}

function annotationConversionTargets(
  operation: DerivativeTargetOperation,
): string[] {
  return [
    ...(operation.affected ?? []).filter((target) =>
      !target.startsWith("ann_") && !target.startsWith("lyr_")),
    ...targetValues(operation.params, ["sequenceId", "itemId"]),
    ...targetValues(operation.params["revert"], ["itemId"]),
    ...targetValues(operation.params["forward"], ["sequenceId", "itemId"]),
  ];
}

function newGraphicTargets(
  project: GuyditorProject,
  operation: DerivativeTargetOperation,
): string[] {
  const anchor = operation.params["anchor"];
  const duration = operation.params["duration"];
  if (
    typeof anchor !== "string" ||
    (
      duration !== "intrinsic" &&
      (typeof duration !== "object" || duration === null || Array.isArray(duration))
    )
  ) return [];
  const sequenceId = operation.params["sequenceId"];
  const item: PlacedItem = {
    id: typeof operation.params["graphicId"] === "string"
      ? operation.params["graphicId"]
      : "gfx_aaaaaaaaaa",
    ...(typeof sequenceId === "string" ? { sequenceId } : {}),
    template: typeof operation.params["templateId"] === "string"
      ? operation.params["templateId"]
      : "tpl_aaaaaaaaaa",
    at: anchor as PlacedItem["at"],
    duration: structuredClone(duration) as PlacedItem["duration"],
    params: {},
    seed: 0,
  };
  return project.deliverables
    .filter(({ kind }) => kind === "short")
    .filter(({ sequenceId: candidate }) =>
      placedItemAppliesToSequence(project, item, candidate))
    .map(({ id }) => id);
}

function targetStrings(
  project: GuyditorProject,
  operation: DerivativeTargetOperation,
  policy: DerivativeOperationPolicy,
): string[] {
  if (policy.target === "none") return [];
  if (policy.target === "transition-owner") {
    return transitionOwnerTargets(project, operation);
  }
  if (policy.target === "annotation-conversion") {
    return annotationConversionTargets(operation);
  }
  if (policy.target === "new-graphic") return newGraphicTargets(project, operation);
  if (policy.target === "template-uses") {
    const templateId = operation.params["templateId"];
    return [
      ...(operation.affected ?? []),
      ...(typeof templateId !== "string"
        ? []
        : project.layers.flatMap((layer) =>
            (layer.items ?? [])
              .filter(({ template }) => template === templateId)
              .map(({ id }) => id))),
    ];
  }
  return [
    ...(operation.affected ?? []),
    ...nestedStrings(operation.params),
  ];
}

function mentionsScope(targets: readonly string[], scope: ReadonlySet<string>): boolean {
  return targets.some((target) => {
    if (scope.has(target)) return true;
    const anchored = /^(?:clip:(clp_[a-z2-7]{10})|timeline:(seq_[a-z2-7]{10}))@/u
      .exec(target);
    const referencedId = anchored?.[1] ?? anchored?.[2];
    return referencedId !== undefined && scope.has(referencedId);
  });
}

/**
 * Resolves only shorts whose rendered content is targeted by the supplied
 * operations. Passing both the before and after snapshots provides the
 * post-apply backstop for generated and removed entities.
 */
export function touchedDerivativeIds(
  before: GuyditorProject,
  after: GuyditorProject,
  operations: readonly DerivativeTargetOperation[],
): string[] {
  const targetSets = operations.flatMap((operation) => {
    const policy = DERIVATIVE_OPERATION_POLICIES[
      operation.op as CataloguedOperationName
    ];
    if (policy?.impact !== "content") return [];
    return [{
      before: targetStrings(before, operation, policy),
      after: targetStrings(after, operation, policy),
    }];
  });
  if (targetSets.length === 0) return [];
  const deliverableIds = new Set([
    ...before.deliverables.filter(({ kind }) => kind === "short").map(({ id }) => id),
    ...after.deliverables.filter(({ kind }) => kind === "short").map(({ id }) => id),
  ]);
  return [...deliverableIds].filter((deliverableId) => {
    const beforeScope = shortScopeIds(before, deliverableId);
    const afterScope = shortScopeIds(after, deliverableId);
    return targetSets.some((targets) =>
      mentionsScope(targets.before, beforeScope) ||
      mentionsScope(targets.after, afterScope));
  });
}
