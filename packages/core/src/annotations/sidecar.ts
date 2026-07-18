import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Scalar, ScalarTag } from "yaml";

import { ID_PATTERNS, REVISION_ID_PATTERN, WORD_ID_PATTERN } from "../project/ids.js";
import { validateFrameTime } from "../time/validation.js";
import { roundSpatial } from "./coordinates.js";
import type {
  Annotation,
  AnnotationAnchor,
  AnnotationGeometry,
  AnnotationPersistedState,
  AnnotationShape,
  AnnotationSidecar,
  AnnotationState,
  NormPoint,
} from "./types.js";

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/u;
const ASPECT_PATTERN = /^[1-9][0-9]*:[1-9][0-9]*$/u;
const STATE_VALUES = new Set<AnnotationPersistedState>([
  "open", "resolved", "rejected", "reopened",
]);
const EFFECTIVE_STATE_VALUES = new Set<AnnotationState>([
  ...STATE_VALUES, "addressed",
]);
const SHAPE_VALUES = new Set<AnnotationShape>([
  "note", "pin", "rect", "ellipse", "arrow", "freehand", "spotlight", "range",
]);

function invalid(path: string, detail: string): never {
  throw new TypeError(`Invalid guyditor.annotations/v1 sidecar at ${path}: ${detail}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : invalid(path, "expected an object");
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) invalid(`${path}/${key}`, "required field is missing");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}/${key}`, "unknown field");
  }
}

function stringValue(value: unknown, path: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value.trim() === "")) {
    invalid(path, nonempty ? "expected a nonempty string" : "expected a string");
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : invalid(path, "expected a boolean");
}

function finiteNumber(value: unknown, path: string): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : invalid(path, "expected a finite number");
}

function spatialNumber(value: unknown, path: string, nonnegative = false): number {
  const number = finiteNumber(value, path);
  if (number < (nonnegative ? 0 : -0.25) || number > 1.25) {
    invalid(path, `expected a normalized coordinate from ${nonnegative ? "0" : "-0.25"} through 1.25`);
  }
  if (roundSpatial(number) !== number) invalid(path, "expected at most six decimal places");
  return number;
}

function point(value: unknown, path: string, nonnegative = false): NormPoint {
  const source = record(value, path);
  exactKeys(source, ["x", "y"], [], path);
  return {
    x: spatialNumber(source["x"], `${path}/x`, nonnegative),
    y: spatialNumber(source["y"], `${path}/y`, nonnegative),
  };
}

function sourceTime(value: unknown, path: string) {
  const checked = validateFrameTime(value);
  if (!checked.ok || checked.value.frames < 0) {
    invalid(path, "expected a non-negative SourceTime with a valid rational fps");
  }
  return checked.value;
}

function geometry(value: unknown, path: string): AnnotationGeometry {
  const source = record(value, path);
  const kind = stringValue(source["kind"], `${path}/kind`);
  switch (kind) {
    case "pin":
      exactKeys(source, ["kind", "at"], [], path);
      return { kind, at: point(source["at"], `${path}/at`) };
    case "rect":
      exactKeys(source, ["kind", "origin", "size"], ["rotationDeg"], path);
      return {
        kind,
        origin: point(source["origin"], `${path}/origin`),
        size: point(source["size"], `${path}/size`, true),
        ...(source["rotationDeg"] === undefined
          ? {}
          : { rotationDeg: finiteNumber(source["rotationDeg"], `${path}/rotationDeg`) }),
      };
    case "ellipse":
      exactKeys(source, ["kind", "center", "radii"], ["rotationDeg"], path);
      return {
        kind,
        center: point(source["center"], `${path}/center`),
        radii: point(source["radii"], `${path}/radii`, true),
        ...(source["rotationDeg"] === undefined
          ? {}
          : { rotationDeg: finiteNumber(source["rotationDeg"], `${path}/rotationDeg`) }),
      };
    case "arrow":
      exactKeys(source, ["kind", "from", "to"], [], path);
      return {
        kind,
        from: point(source["from"], `${path}/from`),
        to: point(source["to"], `${path}/to`),
      };
    case "freehand": {
      exactKeys(source, ["kind", "points", "closed"], [], path);
      if (!Array.isArray(source["points"])) invalid(`${path}/points`, "expected an array");
      if (source["points"].length < 2 || source["points"].length > 512) {
        invalid(`${path}/points`, "expected 2 through 512 simplified points");
      }
      return {
        kind,
        points: source["points"].map((entry, index) =>
          point(entry, `${path}/points/${String(index)}`)),
        closed: booleanValue(source["closed"], `${path}/closed`),
      };
    }
    case "spotlight": {
      exactKeys(source, ["kind", "region", "dimOpacity"], [], path);
      const region = record(source["region"], `${path}/region`);
      const opacity = finiteNumber(source["dimOpacity"], `${path}/dimOpacity`);
      if (opacity < 0 || opacity > 1) invalid(`${path}/dimOpacity`, "expected 0 through 1");
      if ("rect" in region) {
        exactKeys(region, ["rect"], [], `${path}/region`);
        const rect = record(region["rect"], `${path}/region/rect`);
        exactKeys(rect, ["origin", "size"], [], `${path}/region/rect`);
        return {
          kind,
          region: {
            rect: {
              origin: point(rect["origin"], `${path}/region/rect/origin`),
              size: point(rect["size"], `${path}/region/rect/size`, true),
            },
          },
          dimOpacity: opacity,
        };
      }
      exactKeys(region, ["ellipse"], [], `${path}/region`);
      const ellipse = record(region["ellipse"], `${path}/region/ellipse`);
      exactKeys(ellipse, ["center", "radii"], [], `${path}/region/ellipse`);
      return {
        kind,
        region: {
          ellipse: {
            center: point(ellipse["center"], `${path}/region/ellipse/center`),
            radii: point(ellipse["radii"], `${path}/region/ellipse/radii`, true),
          },
        },
        dimOpacity: opacity,
      };
    }
    default:
      return invalid(`${path}/kind`, "unknown annotation geometry kind");
  }
}

function id(value: unknown, kind: "ann" | "ast" | "clp" | "seq" | "dlv" | "beat" | "txn", path: string): string {
  const candidate = stringValue(value, path);
  return ID_PATTERNS[kind].test(candidate)
    ? candidate
    : invalid(path, `malformed ${kind} ID`);
}

function annotationAnchor(value: unknown, path: string): AnnotationAnchor {
  const source = record(value, path);
  const kind = stringValue(source["kind"], `${path}/kind`);
  switch (kind) {
    case "clip":
      exactKeys(source, ["kind", "clipId", "assetId", "sourceFrame"], [], path);
      return {
        kind,
        clipId: id(source["clipId"], "clp", `${path}/clipId`),
        assetId: id(source["assetId"], "ast", `${path}/assetId`),
        sourceFrame: sourceTime(source["sourceFrame"], `${path}/sourceFrame`),
      };
    case "word": {
      exactKeys(source, ["kind", "wordId"], ["offset"], path);
      const wordId = stringValue(source["wordId"], `${path}/wordId`);
      if (!WORD_ID_PATTERN.test(wordId)) invalid(`${path}/wordId`, "malformed word ID");
      return {
        kind,
        wordId,
        ...(source["offset"] === undefined
          ? {}
          : { offset: sourceTime(source["offset"], `${path}/offset`) }),
      };
    }
    case "object":
      exactKeys(source, ["kind", "trackId", "assetId", "sourceFrame"], [], path);
      return {
        kind,
        trackId: stringValue(source["trackId"], `${path}/trackId`, true),
        assetId: id(source["assetId"], "ast", `${path}/assetId`),
        sourceFrame: sourceTime(source["sourceFrame"], `${path}/sourceFrame`),
      };
    case "beat":
      exactKeys(source, ["kind", "beatId"], ["offset"], path);
      return {
        kind,
        beatId: id(source["beatId"], "beat", `${path}/beatId`),
        ...(source["offset"] === undefined
          ? {}
          : { offset: sourceTime(source["offset"], `${path}/offset`) }),
      };
    case "timeline":
      exactKeys(source, ["kind", "sequenceId", "frame"], [], path);
      return {
        kind,
        sequenceId: id(source["sequenceId"], "seq", `${path}/sequenceId`),
        frame: sourceTime(source["frame"], `${path}/frame`),
      };
    default:
      return invalid(`${path}/kind`, "unknown annotation anchor kind");
  }
}

function actor(value: unknown, path: string): { kind: "human" | "agent"; id: string } {
  const source = record(value, path);
  exactKeys(source, ["kind", "id"], [], path);
  if (source["kind"] !== "human" && source["kind"] !== "agent") {
    invalid(`${path}/kind`, "expected human or agent");
  }
  return { kind: source["kind"], id: stringValue(source["id"], `${path}/id`, true) };
}

export function validateAnnotation(value: unknown, path = "/annotation"): Annotation {
  const source = record(value, path);
  exactKeys(source, [
    "id", "shape", "body", "geometry", "anchor", "extent", "canvasRef", "state",
    "blocking", "author", "createdAt", "history",
  ], [
    "style", "sourceProjection", "context", "resolvedBy", "orphan", "convertedTo",
  ], path);
  const annotationId = id(source["id"], "ann", `${path}/id`);
  const shape = stringValue(source["shape"], `${path}/shape`);
  if (!SHAPE_VALUES.has(shape as AnnotationShape)) invalid(`${path}/shape`, "unknown annotation shape");
  const typedShape = shape as AnnotationShape;
  const body = stringValue(source["body"], `${path}/body`);
  const parsedGeometry = source["geometry"] === null
    ? null
    : geometry(source["geometry"], `${path}/geometry`);
  if (typedShape === "note" || typedShape === "range") {
    if (parsedGeometry !== null || source["style"] !== undefined) {
      invalid(path, `${typedShape} requires null geometry and no style`);
    }
  } else if (parsedGeometry?.kind !== typedShape) {
    invalid(`${path}/geometry`, `${typedShape} requires matching geometry`);
  }
  if (typedShape === "note" && body.trim() === "") {
    invalid(`${path}/body`, "note requires a nonempty body");
  }
  let parsedStyle: Annotation["style"];
  if (source["style"] !== undefined) {
    const style = record(source["style"], `${path}/style`);
    exactKeys(style, ["color", "strokeWidth"], [], `${path}/style`);
    const color = stringValue(style["color"], `${path}/style/color`);
    if (!COLOR_PATTERN.test(color)) invalid(`${path}/style/color`, "expected lowercase #rrggbb");
    const strokeWidth = spatialNumber(style["strokeWidth"], `${path}/style/strokeWidth`, true);
    if (strokeWidth <= 0) invalid(`${path}/style/strokeWidth`, "expected a positive height-normalized width");
    parsedStyle = { color, strokeWidth };
  } else if (typedShape !== "note" && typedShape !== "range") {
    invalid(`${path}/style`, `${typedShape} requires a style`);
  }
  const extent = sourceTime(source["extent"], `${path}/extent`);
  if (typedShape === "range" && extent.frames <= 0) {
    invalid(`${path}/extent/frames`, "range requires a positive extent");
  }
  const canvasSource = record(source["canvasRef"], `${path}/canvasRef`);
  exactKeys(canvasSource, ["sequenceId", "aspect"], ["deliverableId"], `${path}/canvasRef`);
  const aspect = stringValue(canvasSource["aspect"], `${path}/canvasRef/aspect`);
  if (!ASPECT_PATTERN.test(aspect)) invalid(`${path}/canvasRef/aspect`, "expected W:H");
  const state = stringValue(source["state"], `${path}/state`);
  if (!STATE_VALUES.has(state as AnnotationPersistedState)) invalid(`${path}/state`, "unknown persisted state");
  const createdAt = stringValue(source["createdAt"], `${path}/createdAt`);
  if (!ISO_UTC_PATTERN.test(createdAt)) invalid(`${path}/createdAt`, "expected ISO 8601 UTC");
  if (!Array.isArray(source["history"])) invalid(`${path}/history`, "expected an array");
  const history = source["history"].map((entry, index) => {
    const historyPath = `${path}/history/${String(index)}`;
    const historySource = record(entry, historyPath);
    exactKeys(historySource, ["at", "from", "to", "actor"], ["txnId", "reason"], historyPath);
    const at = stringValue(historySource["at"], `${historyPath}/at`);
    if (!ISO_UTC_PATTERN.test(at)) invalid(`${historyPath}/at`, "expected ISO 8601 UTC");
    const from = stringValue(historySource["from"], `${historyPath}/from`);
    const to = stringValue(historySource["to"], `${historyPath}/to`);
    if (!EFFECTIVE_STATE_VALUES.has(from as AnnotationState) ||
      !EFFECTIVE_STATE_VALUES.has(to as AnnotationState)) {
      invalid(historyPath, "history states are invalid");
    }
    return {
      at,
      from: from as AnnotationState,
      to: to as AnnotationState,
      actor: actor(historySource["actor"], `${historyPath}/actor`),
      ...(historySource["txnId"] === undefined
        ? {}
        : { txnId: id(historySource["txnId"], "txn", `${historyPath}/txnId`) }),
      ...(historySource["reason"] === undefined
        ? {}
        : { reason: stringValue(historySource["reason"], `${historyPath}/reason`, true) }),
    };
  });

  const annotation: Annotation = {
    id: annotationId,
    shape: typedShape,
    body,
    ...(parsedStyle === undefined ? {} : { style: parsedStyle }),
    geometry: parsedGeometry,
    anchor: annotationAnchor(source["anchor"], `${path}/anchor`),
    extent,
    canvasRef: {
      sequenceId: id(canvasSource["sequenceId"], "seq", `${path}/canvasRef/sequenceId`),
      ...(canvasSource["deliverableId"] === undefined
        ? {}
        : { deliverableId: id(canvasSource["deliverableId"], "dlv", `${path}/canvasRef/deliverableId`) }),
      aspect,
    },
    state: state as AnnotationPersistedState,
    blocking: booleanValue(source["blocking"], `${path}/blocking`),
    author: actor(source["author"], `${path}/author`),
    createdAt,
    history,
  };
  if (source["sourceProjection"] !== undefined) {
    if (typedShape === "note" || typedShape === "range") {
      invalid(`${path}/sourceProjection`, `${typedShape} cannot have source-projected geometry`);
    }
    const projection = record(source["sourceProjection"], `${path}/sourceProjection`);
    exactKeys(projection, ["assetId", "clipId", "geometry"], [], `${path}/sourceProjection`);
    const projectedGeometry = geometry(projection["geometry"], `${path}/sourceProjection/geometry`);
    if (projectedGeometry.kind !== typedShape) {
      invalid(`${path}/sourceProjection/geometry`, `${typedShape} requires matching geometry`);
    }
    annotation.sourceProjection = {
      assetId: id(projection["assetId"], "ast", `${path}/sourceProjection/assetId`),
      clipId: id(projection["clipId"], "clp", `${path}/sourceProjection/clipId`),
      geometry: projectedGeometry,
    };
  }
  if (source["context"] !== undefined) {
    const context = record(source["context"], `${path}/context`);
    exactKeys(context, [], ["nearestWordId", "beatId"], `${path}/context`);
    const nearestWordValue = context["nearestWordId"];
    const nearestWordId = nearestWordValue === undefined
      ? undefined
      : stringValue(nearestWordValue, `${path}/context/nearestWordId`);
    if (nearestWordId !== undefined && !WORD_ID_PATTERN.test(nearestWordId)) {
      invalid(`${path}/context/nearestWordId`, "malformed word ID");
    }
    annotation.context = {
      ...(nearestWordId === undefined ? {} : { nearestWordId }),
      ...(context["beatId"] === undefined
        ? {}
        : { beatId: id(context["beatId"], "beat", `${path}/context/beatId`) }),
    };
  }
  if (source["resolvedBy"] !== undefined) {
    const resolvedBy = record(source["resolvedBy"], `${path}/resolvedBy`);
    exactKeys(resolvedBy, ["txnId", "revision"], [], `${path}/resolvedBy`);
    const revision = stringValue(resolvedBy["revision"], `${path}/resolvedBy/revision`);
    if (!REVISION_ID_PATTERN.test(revision)) invalid(`${path}/resolvedBy/revision`, "malformed revision");
    annotation.resolvedBy = {
      txnId: id(resolvedBy["txnId"], "txn", `${path}/resolvedBy/txnId`),
      revision,
    };
  }
  if (source["orphan"] !== undefined) {
    const orphan = record(source["orphan"], `${path}/orphan`);
    exactKeys(orphan, ["detectedAtRevision", "lastResolved"], [], `${path}/orphan`);
    const revision = stringValue(orphan["detectedAtRevision"], `${path}/orphan/detectedAtRevision`);
    if (!REVISION_ID_PATTERN.test(revision)) invalid(`${path}/orphan/detectedAtRevision`, "malformed revision");
    const last = record(orphan["lastResolved"], `${path}/orphan/lastResolved`);
    exactKeys(last, ["sequenceId", "timelineFrame"], [], `${path}/orphan/lastResolved`);
    annotation.orphan = {
      detectedAtRevision: revision,
      lastResolved: {
        sequenceId: id(last["sequenceId"], "seq", `${path}/orphan/lastResolved/sequenceId`),
        timelineFrame: sourceTime(last["timelineFrame"], `${path}/orphan/lastResolved/timelineFrame`),
      },
    };
  }
  if (source["convertedTo"] !== undefined) {
    const converted = record(source["convertedTo"], `${path}/convertedTo`);
    exactKeys(converted, ["itemId", "txnId"], [], `${path}/convertedTo`);
    const itemId = stringValue(converted["itemId"], `${path}/convertedTo/itemId`);
    if (!ID_PATTERNS.gfx.test(itemId) && !ID_PATTERNS.clp.test(itemId)) {
      invalid(`${path}/convertedTo/itemId`, "malformed overlay item ID");
    }
    annotation.convertedTo = {
      itemId,
      txnId: id(converted["txnId"], "txn", `${path}/convertedTo/txnId`),
    };
  }
  return annotation;
}

export function validateAnnotationSidecar(value: unknown): AnnotationSidecar {
  const source = record(value, "/");
  exactKeys(source, ["format", "annotations"], [], "/");
  if (source["format"] !== "guyditor.annotations/v1") {
    invalid("/format", "expected guyditor.annotations/v1");
  }
  if (!Array.isArray(source["annotations"])) invalid("/annotations", "expected an array");
  const annotations = source["annotations"].map((entry, index) =>
    validateAnnotation(entry, `/annotations/${String(index)}`));
  const ids = new Set<string>();
  for (const annotation of annotations) {
    if (ids.has(annotation.id)) invalid("/annotations", `duplicate annotation ID ${annotation.id}`);
    ids.add(annotation.id);
  }
  return { format: "guyditor.annotations/v1", annotations };
}

export function parseAnnotationSidecar(text: string): AnnotationSidecar {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { schema: "core" }) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid guyditor.annotations/v1 YAML: ${detail}.`);
  }
  return validateAnnotationSidecar(parsed);
}

class FixedDecimal {
  public constructor(public readonly value: number) {}
}

const fixedDecimalTag: ScalarTag = {
  tag: "tag:yaml.org,2002:float",
  default: true,
  identify: (value) => value instanceof FixedDecimal,
  resolve: (value) => Number(value),
  stringify: (item: Scalar) => (item.value as FixedDecimal).value.toFixed(6),
};

function fixedPoint(value: NormPoint): { x: FixedDecimal; y: FixedDecimal } {
  return { x: new FixedDecimal(value.x), y: new FixedDecimal(value.y) };
}

function orderedGeometry(value: AnnotationGeometry): unknown {
  switch (value.kind) {
    case "pin":
      return { kind: value.kind, at: fixedPoint(value.at) };
    case "rect":
      return {
        kind: value.kind,
        origin: fixedPoint(value.origin),
        size: fixedPoint(value.size),
        ...(value.rotationDeg === undefined ? {} : { rotationDeg: value.rotationDeg }),
      };
    case "ellipse":
      return {
        kind: value.kind,
        center: fixedPoint(value.center),
        radii: fixedPoint(value.radii),
        ...(value.rotationDeg === undefined ? {} : { rotationDeg: value.rotationDeg }),
      };
    case "arrow":
      return { kind: value.kind, from: fixedPoint(value.from), to: fixedPoint(value.to) };
    case "freehand":
      return { kind: value.kind, points: value.points.map(fixedPoint), closed: value.closed };
    case "spotlight":
      return {
        kind: value.kind,
        region: "rect" in value.region
          ? {
              rect: {
                origin: fixedPoint(value.region.rect.origin),
                size: fixedPoint(value.region.rect.size),
              },
            }
          : {
              ellipse: {
                center: fixedPoint(value.region.ellipse.center),
                radii: fixedPoint(value.region.ellipse.radii),
              },
            },
        dimOpacity: new FixedDecimal(value.dimOpacity),
      };
  }
}

function orderedAnnotation(value: Annotation): unknown {
  return {
    id: value.id,
    shape: value.shape,
    body: value.body,
    ...(value.style === undefined
      ? {}
      : {
          style: {
            color: value.style.color,
            strokeWidth: new FixedDecimal(value.style.strokeWidth),
          },
        }),
    geometry: value.geometry === null ? null : orderedGeometry(value.geometry),
    anchor: value.anchor,
    extent: value.extent,
    canvasRef: value.canvasRef,
    ...(value.sourceProjection === undefined
      ? {}
      : {
          sourceProjection: {
            assetId: value.sourceProjection.assetId,
            clipId: value.sourceProjection.clipId,
            geometry: orderedGeometry(value.sourceProjection.geometry),
          },
        }),
    state: value.state,
    blocking: value.blocking,
    author: value.author,
    createdAt: value.createdAt,
    history: value.history,
    ...(value.context === undefined ? {} : { context: value.context }),
    ...(value.resolvedBy === undefined ? {} : { resolvedBy: value.resolvedBy }),
    ...(value.orphan === undefined ? {} : { orphan: value.orphan }),
    ...(value.convertedTo === undefined ? {} : { convertedTo: value.convertedTo }),
  };
}

export function serializeAnnotationSidecar(value: unknown): string {
  const sidecar = validateAnnotationSidecar(value);
  return stringifyYaml({
    format: sidecar.format,
    annotations: sidecar.annotations.map(orderedAnnotation),
  }, {
    aliasDuplicateObjects: false,
    customTags: (tags) => [fixedDecimalTag, ...tags],
    indent: 2,
    lineWidth: 0,
    schema: "core",
  });
}
