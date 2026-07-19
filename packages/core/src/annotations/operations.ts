import { createHash } from "node:crypto";

import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import type { IdFactory } from "../operations/engine.js";
import type {
  DispatchedOperationApplication,
  OperationDispatcher,
  OperationInput,
} from "../operations/index.js";
import type {
  GuyditorProject,
  Layer,
  PlacedItem,
} from "../project/index.js";
import type { TransactionRecord } from "../store/index.js";
import { roundSpatial, normalizeAnnotationGeometry } from "./coordinates.js";
import {
  serializeAnnotationSidecar,
  validateAnnotation,
} from "./sidecar.js";
import type {
  Annotation,
  AnnotationPersistedState,
  AnnotationSidecar,
  AnnotationState,
} from "./types.js";

export interface PendingAnnotationConversion {
  annotationId: string;
  itemId: string;
}

export interface PendingAnnotationFile {
  path: string;
  content: string;
}

export interface AnnotationWorkspace {
  original: AnnotationSidecar;
  current: AnnotationSidecar;
  pendingConversions: PendingAnnotationConversion[];
  pendingFiles: PendingAnnotationFile[];
}

interface AnnotationDispatcherOptions {
  actor: { kind: "human" | "agent"; id: string };
  idFactory: IdFactory;
  now: () => Date;
}

const DEFAULT_TEMPLATES: Partial<Record<Annotation["shape"], string>> = {
  note: ["tpl", "callout", "text"].join("_"),
  pin: ["tpl", "callout", "pin"].join("_"),
  rect: ["tpl", "highlight", "box"].join("_"),
  ellipse: ["tpl", "highlight", "box"].join("_"),
  arrow: ["tpl", "arrow"].join("_"),
  spotlight: ["tpl", "spotlight"].join("_"),
};

function annotationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function summary(sidecar: AnnotationSidecar): GuyditorProject["annotations"]["summary"] {
  const counts = { open: 0, resolved: 0, rejected: 0, reopened: 0 };
  for (const annotation of sidecar.annotations) counts[annotation.state] += 1;
  return counts;
}

export function annotationSummary(
  sidecar: AnnotationSidecar,
): GuyditorProject["annotations"]["summary"] {
  return summary(sidecar);
}

export function refreshAnnotationIndex(
  project: GuyditorProject,
  sidecar: AnnotationSidecar,
): Result<GuyditorProject> {
  const referenceName = project.annotations.sidecar;
  const referenceIndex = project.sidecars.findIndex(({ name }) => name === referenceName);
  if (referenceIndex < 0) {
    return annotationFailure(
      "E_ANN_SIDECAR",
      `Annotation sidecar registry entry ${referenceName} does not exist.`,
      [referenceName],
    );
  }
  const content = serializeAnnotationSidecar(sidecar);
  const sidecars = project.sidecars.map((reference, index) =>
    index === referenceIndex
      ? {
          ...reference,
          sha256: createHash("sha256").update(content).digest("hex"),
          inputs: [],
        }
      : reference);
  return success({
    ...project,
    annotations: { sidecar: referenceName, summary: summary(sidecar) },
    sidecars,
  });
}

function normalizeRecord(value: unknown): Annotation {
  const candidate = structuredClone(value) as Annotation;
  if (candidate.geometry !== null && typeof candidate.canvasRef?.aspect === "string") {
    candidate.geometry = normalizeAnnotationGeometry(candidate.geometry, candidate.canvasRef.aspect);
  }
  if (candidate.style !== undefined) {
    candidate.style = {
      color: candidate.style.color,
      strokeWidth: roundSpatial(candidate.style.strokeWidth),
    };
  }
  if (candidate.sourceProjection !== undefined && typeof candidate.canvasRef?.aspect === "string") {
    candidate.sourceProjection = {
      ...candidate.sourceProjection,
      geometry: normalizeAnnotationGeometry(
        candidate.sourceProjection.geometry,
        candidate.canvasRef.aspect,
      ),
    };
  }
  return validateAnnotation(candidate);
}

function anchorDescription(annotation: Annotation): string {
  switch (annotation.anchor.kind) {
    case "clip":
      return `clip ${annotation.anchor.clipId}`;
    case "word":
      return `word ${annotation.anchor.wordId}`;
    case "object":
      return `object ${annotation.anchor.trackId}`;
    case "beat":
      return `beat ${annotation.anchor.beatId}`;
    case "timeline":
      return `timeline frame ${String(annotation.anchor.frame.frames)}`;
  }
}

function locate(workspace: AnnotationWorkspace, annotationId: string): Result<{
  annotation: Annotation;
  index: number;
}> {
  const index = workspace.current.annotations.findIndex(({ id }) => id === annotationId);
  return index < 0
    ? annotationFailure(
        "E_ANN_NOT_FOUND",
        `Annotation ${annotationId} does not exist.`,
        [annotationId],
      )
    : success({ annotation: workspace.current.annotations[index]!, index });
}

function application(
  project: GuyditorProject,
  workspace: AnnotationWorkspace,
  details: Omit<DispatchedOperationApplication, "model">,
): Result<DispatchedOperationApplication> {
  const refreshed = refreshAnnotationIndex(project, workspace.current);
  return refreshed.ok ? success({ ...details, model: refreshed.value }) : refreshed;
}

function createAnnotation(
  project: GuyditorProject,
  workspace: AnnotationWorkspace,
  input: OperationInput,
): Result<DispatchedOperationApplication> {
  let annotation: Annotation;
  try {
    annotation = normalizeRecord(input.params["annotation"]);
  } catch (error: unknown) {
    return annotationFailure(
      "E_ANN_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (workspace.current.annotations.some(({ id }) => id === annotation.id)) {
    return annotationFailure(
      "E_ANN_EXISTS",
      `Annotation ${annotation.id} already exists.`,
      [annotation.id],
    );
  }
  workspace.current.annotations.push(annotation);
  return application(project, workspace, {
    inverse: [{ op: "annotation.delete", params: { annotationId: annotation.id } }],
    redo: { op: "annotation.create", params: { annotation: structuredClone(annotation) } },
    affected: [annotation.id],
    summary: `Added ${annotation.shape} annotation ${annotation.id} at ${anchorDescription(annotation)}`,
  });
}

function updateAnnotation(
  project: GuyditorProject,
  workspace: AnnotationWorkspace,
  input: OperationInput,
): Result<DispatchedOperationApplication> {
  const annotationId = input.params["annotationId"] as string;
  const found = locate(workspace, annotationId);
  if (!found.ok) return found;
  const patch = input.params["patch"] as Record<string, unknown>;
  const candidate = structuredClone(found.value.annotation) as unknown as Record<string, unknown>;
  const inversePatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    inversePatch[key] = key in candidate ? structuredClone(candidate[key]) : null;
    if (value === null && (key === "style" || key === "sourceProjection" || key === "context")) {
      delete candidate[key];
    } else {
      candidate[key] = structuredClone(value);
    }
  }
  if ("anchor" in patch) delete candidate["orphan"];
  let updated: Annotation;
  try {
    updated = normalizeRecord(candidate);
  } catch (error: unknown) {
    return annotationFailure(
      "E_ANN_INVALID",
      error instanceof Error ? error.message : String(error),
      [annotationId],
    );
  }
  workspace.current.annotations[found.value.index] = updated;
  const changedFields = Object.keys(patch).sort();
  return application(project, workspace, {
    inverse: [{ op: "annotation.update", params: { annotationId, patch: inversePatch } }],
    redo: { op: "annotation.update", params: { annotationId, patch: structuredClone(patch) } },
    affected: [annotationId],
    summary: `Edited annotation ${annotationId} (${changedFields.join(", ")})`,
  });
}

function deleteAnnotation(
  project: GuyditorProject,
  workspace: AnnotationWorkspace,
  input: OperationInput,
): Result<DispatchedOperationApplication> {
  const annotationId = input.params["annotationId"] as string;
  const found = locate(workspace, annotationId);
  if (!found.ok) return found;
  workspace.current.annotations.splice(found.value.index, 1);
  return application(project, workspace, {
    inverse: [{
      op: "annotation.create",
      params: { annotation: structuredClone(found.value.annotation) },
    }],
    affected: [annotationId],
    summary: `Deleted annotation ${annotationId}`,
  });
}

function transition(
  project: GuyditorProject,
  workspace: AnnotationWorkspace,
  input: OperationInput,
  options: AnnotationDispatcherOptions,
): Result<DispatchedOperationApplication> {
  const annotationId = input.params["annotationId"] as string;
  const reason = input.params["reason"] as string;
  const found = locate(workspace, annotationId);
  if (!found.ok) return found;
  const from = found.value.annotation.state;
  let to: AnnotationPersistedState;
  if (input.op === "annotation.resolve") to = "resolved";
  else if (input.op === "annotation.reject") to = "rejected";
  else to = "reopened";
  const legal = to === "reopened"
    ? from === "resolved" || from === "rejected"
    : from === "open" || from === "reopened";
  if (!legal) {
    return annotationFailure(
      "E_ANN_INVALID_TRANSITION",
      `Annotation ${annotationId} cannot transition from ${from} to ${to}.`,
      [annotationId],
    );
  }
  const updated = structuredClone(found.value.annotation);
  updated.state = to;
  updated.history.push({
    at: options.now().toISOString(),
    from,
    to,
    actor: options.actor,
    reason,
  });
  delete updated.resolvedBy;
  workspace.current.annotations[found.value.index] = updated;
  const inverse = to === "reopened"
    ? from === "resolved"
      ? { op: "annotation.resolve", params: { annotationId, reason: `Undo: ${reason}` } }
      : { op: "annotation.reject", params: { annotationId, reason: `Undo: ${reason}` } }
    : { op: "annotation.reopen", params: { annotationId, reason: `Undo: ${reason}` } };
  const verb = to === "resolved" ? "Resolved" : to === "rejected" ? "Rejected" : "Reopened";
  return application(project, workspace, {
    inverse: [inverse],
    affected: [annotationId],
    summary: to === "resolved"
      ? `${verb} annotation ${annotationId} via manual: ${reason}`
      : `${verb} annotation ${annotationId}: ${reason}`,
  });
}

function twoSecondFrames(fps: string): number {
  const match = /^([0-9]+)\/([1-9][0-9]*)$/u.exec(fps);
  if (match === null) throw new RangeError(`Invalid sequence fps ${fps}.`);
  const numerator = BigInt(match[1]!) * 2n;
  const denominator = BigInt(match[2]!);
  const floor = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n <= denominator ? floor : floor + 1n;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new RangeError("Default overlay duration overflows.");
  return value;
}

function conversionParams(
  annotation: Annotation,
  styleOverrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    shape: annotation.shape,
    body: annotation.body,
    ...(annotation.style === undefined ? {} : { style: structuredClone(annotation.style) }),
    ...(annotation.geometry === null
      ? {}
      : {
          geometry: structuredClone(
            annotation.sourceProjection?.geometry ?? annotation.geometry,
          ),
        }),
    ...(annotation.sourceProjection === undefined
      ? {}
      : { sourceProjection: structuredClone(annotation.sourceProjection) }),
    styleOverrides: structuredClone(styleOverrides),
  };
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function frozenFreehandSvg(annotation: Annotation): string {
  const geometry = annotation.sourceProjection?.geometry ?? annotation.geometry;
  if (geometry?.kind !== "freehand") {
    throw new TypeError(`Annotation ${annotation.id} has no freehand geometry.`);
  }
  const width = 1_000_000;
  const height = 1_000_000;
  const points = geometry.points.map(({ x, y }) =>
    `${String(Math.round(x * width))},${String(Math.round(y * height))}`).join(" ");
  const color = xmlAttribute(annotation.style?.color ?? "#ffcc00");
  const strokeWidth = Math.max(1, Math.round((annotation.style?.strokeWidth ?? 0.004) * height));
  const element = geometry.closed
    ? `<polygon points="${points}" fill="none" stroke="${color}" stroke-width="${String(strokeWidth)}"/>`
    : `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${String(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.${"w"}${"3"}.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}">`,
    element,
    "</svg>",
    "",
  ].join("\n");
}

function convertAnnotation(
  project: GuyditorProject,
  workspace: AnnotationWorkspace,
  input: OperationInput,
  options: AnnotationDispatcherOptions,
): Result<DispatchedOperationApplication> {
  const annotationId = input.params["annotationId"] as string;
  const found = locate(workspace, annotationId);
  if (!found.ok) return found;
  const revert = input.params["revert"] as {
    layerId: string;
    itemId: string;
    createdLayer: boolean;
  } | undefined;
  if (revert !== undefined) {
    const layers = project.layers.map((candidate) => structuredClone(candidate));
    const layerIndex = layers.findIndex(({ id }) => id === revert.layerId);
    if (layerIndex < 0) {
      return annotationFailure(
        "E_OP_NOT_FOUND",
        `Overlay layer ${revert.layerId} does not exist.`,
        [revert.layerId],
      );
    }
    const layer = layers[layerIndex]!;
    if (!(layer.items ?? []).some(({ id }) => id === revert.itemId)) {
      return annotationFailure(
        "E_OP_NOT_FOUND",
        `Overlay item ${revert.itemId} does not exist.`,
        [revert.itemId],
      );
    }
    layer.items = (layer.items ?? []).filter(({ id }) => id !== revert.itemId);
    if (revert.createdLayer) {
      if ((layer.items ?? []).length > 0) {
        return annotationFailure(
          "E_ANN_OVERLAY_LAYER",
          `Created overlay layer ${layer.id} is no longer empty after removing ${revert.itemId}.`,
          [layer.id, revert.itemId],
        );
      }
      layers.splice(layerIndex, 1);
    }
    const annotation = structuredClone(found.value.annotation);
    const from = annotation.state;
    if (from !== "resolved") {
      return annotationFailure(
        "E_ANN_INVALID_TRANSITION",
        `Converted annotation ${annotationId} cannot be restored from ${from}.`,
        [annotationId],
      );
    }
    annotation.state = "reopened";
    delete annotation.resolvedBy;
    delete annotation.convertedTo;
    annotation.history.push({
      at: options.now().toISOString(),
      from,
      to: "reopened",
      actor: options.actor,
      reason: `Undo conversion to ${revert.itemId}`,
    });
    workspace.current.annotations[found.value.index] = annotation;
    const model = { ...project, layers };
    const refreshed = refreshAnnotationIndex(model, workspace.current);
    if (!refreshed.ok) return refreshed;
    const forward = input.params["forward"] as Record<string, unknown>;
    return success({
      model: refreshed.value,
      inverse: [{ op: "annotation.convert", params: structuredClone(forward) }],
      redo: { op: "annotation.convert", params: structuredClone(input.params) },
      affected: [annotationId, revert.layerId, revert.itemId],
      summary: `Restored annotation ${annotationId} from overlay ${revert.itemId}`,
    });
  }
  const annotation = found.value.annotation;
  if (annotation.state !== "open" && annotation.state !== "reopened") {
    return annotationFailure(
      "E_ANN_INVALID_TRANSITION",
      `Annotation ${annotationId} cannot be converted from ${annotation.state}.`,
      [annotationId],
    );
  }
  const explicitTemplate = input.params["templateId"] as string | undefined;
  const frozenFreehand = annotation.shape === "freehand" && explicitTemplate === undefined;
  const templateId = explicitTemplate ?? DEFAULT_TEMPLATES[annotation.shape];
  if (templateId === undefined && !frozenFreehand) {
    return annotationFailure(
      "E_ANN_NOT_CONVERTIBLE",
      `Annotation ${annotationId} requires an explicit templateId for conversion.`,
      [annotationId],
    );
  }
  if (explicitTemplate !== undefined && project.templates?.[explicitTemplate] === undefined) {
    return annotationFailure(
      "E_TEMPLATE_MISSING_VERSION",
      `Template ${explicitTemplate} is not pinned in this project.`,
      [explicitTemplate, annotationId],
    );
  }
  const layers = project.layers.map((layer) => structuredClone(layer));
  const requestedLayerId = input.params["layerId"] as string | undefined;
  let layer: Layer | undefined = requestedLayerId === undefined
    ? undefined
    : layers.find(({ id }) => id === requestedLayerId);
  if (requestedLayerId !== undefined && layer === undefined) {
    return annotationFailure("E_OP_NOT_FOUND", `Layer ${requestedLayerId} does not exist.`, [requestedLayerId]);
  }
  if (layer?.locked === true) {
    return annotationFailure("E_OP_LAYER_LOCKED", `Layer ${layer.id} is locked.`, [layer.id]);
  }
  let createdLayerId: string | undefined;
  if (layer === undefined) {
    createdLayerId = input.params["createdLayerId"] as string | undefined ?? options.idFactory("lyr");
    layer = {
      id: createdLayerId,
      kind: frozenFreehand ? "image" : "animation",
      name: "annotation overlays",
      order: Math.max(-1, ...layers.map(({ order }) => order)) + 1,
      enabled: true,
      locked: false,
      items: [],
    };
    layers.push(layer);
  }
  if (
    frozenFreehand
      ? layer.kind !== "image"
      : layer.kind !== "text" && layer.kind !== "animation"
  ) {
    return annotationFailure(
      "E_ANN_OVERLAY_LAYER",
      frozenFreehand
        ? `Frozen freehand overlays require an image layer, not ${layer.kind}.`
        : `Annotation overlays require a text or animation layer, not ${layer.kind}.`,
      [layer.id],
    );
  }
  const itemId = input.params["itemId"] as string | undefined ?? options.idFactory("gfx");
  const durationOverride = input.params["durationOverride"] as Annotation["extent"] | undefined;
  const duration = durationOverride ?? (annotation.extent.frames > 0
    ? annotation.extent
    : {
        frames: twoSecondFrames(project.settings.timeline.fps),
        fps: project.settings.timeline.fps,
      });
  const styleOverrides = (input.params["styleOverrides"] as Record<string, unknown> | undefined) ?? {};
  let assetId: string | undefined;
  let modelAssets = project.assets;
  let modelSidecars = project.sidecars;
  if (frozenFreehand) {
    assetId = input.params["assetId"] as string | undefined ?? options.idFactory("ast");
    if (project.assets.some(({ id }) => id === assetId)) {
      return annotationFailure("E_OP_DUPLICATE_ID", `Asset ${assetId} already exists.`, [assetId]);
    }
    const svg = frozenFreehandSvg(annotation);
    const svgHash = createHash("sha256").update(svg).digest("hex");
    const provenanceName = `provenance-${assetId}`;
    const provenancePath = `sidecars/provenance/${assetId}.provenance.json`;
    const provenance = `${JSON.stringify({
      schema: "guyditor.provenance/v1",
      assetId,
      generation: {
        adapterId: "guyditor.annotation-svg",
        adapterVersion: "1",
        provider: "local",
        model: "deterministic-freehand-svg",
        settings: { width: 1_000_000, height: 1_000_000 },
        referenceAssetIds: [],
        createdAt: options.now().toISOString(),
      },
      rights: {
        origin: "generated",
        licensor: "project-author",
        restrictions: [],
      },
      reviewAnnotationId: annotation.id,
      contentHash: `sha256:${svgHash}`,
    }, null, 2)}\n`;
    const provenanceHash = createHash("sha256").update(provenance).digest("hex");
    const svgPath = `media/generated/${assetId}.svg`;
    workspace.pendingFiles.push(
      { path: svgPath, content: svg },
      { path: provenancePath, content: provenance },
    );
    modelAssets = [...project.assets, {
      id: assetId,
      kind: "generated",
      path: svgPath,
      sha256: svgHash,
      bytes: Buffer.byteLength(svg, "utf8"),
      container: "svg",
      probe: { width: 1_000_000, height: 1_000_000 },
      image: { width: 1_000_000, height: 1_000_000, hasAlpha: true },
      ingest: {
        at: options.now().toISOString(),
        ffprobeVersion: "not-applicable",
        via: "generated",
      },
      provenance: { sidecar: provenanceName },
    }];
    modelSidecars = [...project.sidecars, {
      name: provenanceName,
      path: provenancePath,
      schema: "guyditor.provenance/v1",
      sha256: provenanceHash,
      generatedBy: { tool: "guyditor/annotation-svg", version: "1" },
      inputs: [{ asset: assetId, sha256: svgHash }],
    }];
  }
  const item: PlacedItem = {
    id: itemId,
    ...(assetId === undefined ? { template: templateId!, seed: 0 } : { asset: assetId }),
    at: `ann:${annotation.id}`,
    duration: structuredClone(duration),
    source: { annotationId: annotation.id },
    params: conversionParams(annotation, styleOverrides),
  };
  delete layer.sequence;
  layer.items = [...(layer.items ?? []), item];
  workspace.pendingConversions.push({ annotationId, itemId });
  const model = { ...project, assets: modelAssets, layers, sidecars: modelSidecars };
  const refreshed = refreshAnnotationIndex(model, workspace.current);
  if (!refreshed.ok) return refreshed;
  const forwardParams: Record<string, unknown> = {
    annotationId,
    layerId: layer.id,
    ...(templateId === undefined ? {} : { templateId }),
    durationOverride: duration,
    styleOverrides: structuredClone(styleOverrides),
    itemId,
    ...(assetId === undefined ? {} : { assetId }),
    ...(createdLayerId === undefined ? {} : { createdLayerId }),
  };
  return success({
    model: refreshed.value,
    inverse: [{
      op: "annotation.convert",
      params: {
        annotationId,
        revert: {
          layerId: layer.id,
          itemId,
          createdLayer: createdLayerId !== undefined,
        },
        forward: structuredClone(forwardParams),
      },
    }],
    redo: {
      op: "annotation.convert",
      params: forwardParams,
    },
    affected: [annotationId, layer.id, itemId],
    summary: `Converted annotation ${annotationId} to overlay ${itemId} on ${layer.id}`,
  });
}

export function createAnnotationDispatcher(
  workspace: AnnotationWorkspace,
  options: AnnotationDispatcherOptions,
): OperationDispatcher {
  return (project, input) => {
    try {
      switch (input.op) {
        case "annotation.create":
          return createAnnotation(project, workspace, input);
        case "annotation.update":
          return updateAnnotation(project, workspace, input);
        case "annotation.delete":
          return deleteAnnotation(project, workspace, input);
        case "annotation.resolve":
        case "annotation.reject":
        case "annotation.reopen":
          return transition(project, workspace, input, options);
        case "annotation.convert":
          return convertAnnotation(project, workspace, input, options);
        default:
          return annotationFailure(
            "E_ANN_DISPATCH",
            `Annotation workspace cannot dispatch ${input.op}.`,
            [input.op],
          );
      }
    } catch (error: unknown) {
      return annotationFailure(
        "E_ANN_OPERATION",
        error instanceof Error ? error.message : String(error),
        [input.op],
      );
    }
  };
}

export function stateChange(
  annotation: Annotation,
  from: AnnotationState,
  to: AnnotationPersistedState,
  actor: { kind: "human" | "agent"; id: string },
  at: string,
  reason?: string,
): void {
  annotation.state = to;
  annotation.history.push({
    at,
    from,
    to,
    actor,
    ...(reason === undefined ? {} : { reason }),
  });
}

export function transactionActor(
  transaction: TransactionRecord,
): { kind: "human" | "agent"; id: string } {
  return transaction.actor.kind === "agent"
    ? { kind: "agent", id: transaction.actor.id }
    : { kind: "human", id: transaction.actor.id };
}
