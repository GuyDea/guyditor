import {
  DERIVATIVE_OPERATION_POLICIES,
  touchedDerivativeIds,
} from "../../../../core/src/operations/derivative-policy.js";
import type {
  CataloguedOperationName,
  DerivativeTargetOperation,
  DivergenceClass,
  GuyditorProject,
  Layer,
} from "../../../../core/src/index.js";

const AUDIO_LAYER_KINDS = new Set<Layer["kind"]>([
  "audio",
  "music",
  "ambience",
  "sfx",
]);

const FIXED_CLASSES: Partial<
  Readonly<Record<CataloguedOperationName, DivergenceClass>>
> = {
  "clip.trim": "cuts",
  "clip.split": "cuts",
  "clip.join": "cuts",
  "clip.remove": "cuts",
  "clip.move": "order",
  "clip.gap.set": "pacing",
  "transcript.range.remove": "cuts",
  "transcript.range.createClip": "cuts",
  "caption.track.set": "captions",
  "caption.style.set": "captions",
  "caption.break.set": "captions",
  "caption.break.clear": "captions",
  "caption.word.emphasis.set": "captions",
  "caption.cue.retime": "captions",
  "caption.preset.upgrade": "captions",
  "layer.ducking.set": "audio",
  "layer.ducking.override": "audio",
  "pip.place": "framing",
  "composition.arrange": "framing",
  "deliverable.framing.override": "framing",
  "pip.style.set": "graphics",
  "pip.preset.apply": "graphics",
  "clip.key.set": "graphics",
};

function targetLayer(
  project: GuyditorProject,
  operation: DerivativeTargetOperation,
): Layer {
  const layerId = operation.params["layerId"];
  const layer = typeof layerId === "string"
    ? project.layers.find(({ id }) => id === layerId)
    : undefined;
  if (layer === undefined) {
    throw new Error(`Cannot classify ${operation.op} without a live layer target.`);
  }
  return layer;
}

function operationClass(
  project: GuyditorProject,
  operation: DerivativeTargetOperation,
): DivergenceClass | undefined {
  const name = operation.op as CataloguedOperationName;
  const policy = DERIVATIVE_OPERATION_POLICIES[name];
  if (policy === undefined) {
    throw new Error(`Unknown direct edit operation: ${operation.op}.`);
  }
  if (policy.impact !== "content") return undefined;
  if (name === "layer.enable" || name === "layer.disable") {
    return AUDIO_LAYER_KINDS.has(targetLayer(project, operation).kind)
      ? "audio"
      : "graphics";
  }
  const divergence = FIXED_CLASSES[name];
  if (divergence === undefined) {
    throw new Error(`Direct edit operation ${operation.op} has no divergence class.`);
  }
  return divergence;
}

/**
 * Classifies a renderer-authored direct edit only when its actual semantic
 * targets contribute pixels or audio to at least one short deliverable.
 */
export function directEditDivergence(
  project: GuyditorProject,
  operations: readonly DerivativeTargetOperation[],
): DivergenceClass | undefined {
  const classes = new Set<DivergenceClass>();
  for (const operation of operations) {
    const divergence = operationClass(project, operation);
    if (
      divergence !== undefined &&
      touchedDerivativeIds(project, project, [operation]).length > 0
    ) {
      classes.add(divergence);
    }
  }
  if (classes.size === 0) return undefined;
  if (classes.size > 1) {
    throw new Error(
      `Direct edit batch mixes divergence classes: ${[...classes].sort().join(", ")}.`,
    );
  }
  return [...classes][0];
}
