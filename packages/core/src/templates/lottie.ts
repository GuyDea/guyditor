import { posix } from "node:path";

export const LOTTIE_FEATURE_PROFILE_SCHEMA =
  "guyditor/lottie-feature-profile/v1" as const;
export const LOTTIE_RENDERER_VERSION = "guyditor-lottie-subset/v1" as const;

export type LottieSupportedFeature =
  | "bezier-path"
  | "ellipse"
  | "fill"
  | "group"
  | "image-layer"
  | "keyframes"
  | "mask"
  | "precomposition"
  | "rectangle"
  | "registered-raster"
  | "shape-layer"
  | "stroke"
  | "transform"
  | "trim-path";

export interface LottieFeatureProfile {
  schema: typeof LOTTIE_FEATURE_PROFILE_SCHEMA;
  renderer: typeof LOTTIE_RENDERER_VERSION;
  lottieVersion: string;
  width: number;
  height: number;
  frameRate: number;
  inPoint: number;
  outPoint: number;
  features: LottieSupportedFeature[];
  colorSlots: string[];
}

export interface LottieUnsupportedFeature {
  feature: string;
  layerPath: string;
}

export type LottieAnalysis =
  | { ok: true; profile: LottieFeatureProfile }
  | { ok: false; unsupported: LottieUnsupportedFeature[] };

export interface AnalyzeLottieOptions {
  documentPath?: string;
  registeredRasterPaths?: readonly string[];
}

type JsonRecord = Record<string, unknown>;

interface AnalysisState {
  assets: Map<string, JsonRecord>;
  colorSlots: Set<string>;
  features: Set<LottieSupportedFeature>;
  issues: Map<string, LottieUnsupportedFeature>;
  options: Required<AnalyzeLottieOptions>;
  visitedPrecomps: Set<string>;
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = record(item);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function layerPath(prefix: string, layer: JsonRecord, index: number): string {
  const name = nonEmptyString(layer["nm"]);
  return `${prefix}[${String(index)}]${name === undefined ? "" : ` ${JSON.stringify(name)}`}`;
}

function addIssue(state: AnalysisState, feature: string, path: string): void {
  state.issues.set(`${path}\u0000${feature}`, { feature, layerPath: path });
}

function hasExpression(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExpression);
  const object = record(value);
  if (object === undefined) return false;
  if (
    (typeof object["x"] === "string" && object["x"].trim().length > 0) ||
    (typeof object["exp"] === "string" && object["exp"].trim().length > 0)
  ) return true;
  return Object.values(object).some(hasExpression);
}

function hasObjectKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => hasObjectKey(item, keys));
  const object = record(value);
  if (object === undefined) return false;
  if (Object.keys(object).some((key) => keys.has(key))) return true;
  return Object.values(object).some((child) => hasObjectKey(child, keys));
}

function hasRovingKeyframe(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRovingKeyframe);
  const object = record(value);
  if (object === undefined) return false;
  if (typeof object["t"] === "number" && object["r"] === 1) return true;
  return Object.values(object).some(hasRovingKeyframe);
}

function hasThreeComponentValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (
      value.length >= 3 &&
      value.slice(0, 3).every((item) => typeof item === "number")
    ) return true;
    return value.some(hasThreeComponentValue);
  }
  const object = record(value);
  return object !== undefined && Object.values(object).some(hasThreeComponentValue);
}

function staticScalar(value: unknown): number | undefined {
  const property = record(value);
  if (property === undefined || property["a"] === 1) return undefined;
  const raw = property["k"];
  return typeof raw === "number"
    ? raw
    : Array.isArray(raw) && typeof raw[0] === "number"
      ? raw[0]
      : undefined;
}

function unwrappedPath(value: unknown): JsonRecord | undefined {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return record(candidate);
}

function pathSignature(value: unknown): string | undefined {
  const path = unwrappedPath(value);
  const incoming = path?.["i"];
  const outgoing = path?.["o"];
  const vertices = path?.["v"];
  if (
    !Array.isArray(incoming) ||
    !Array.isArray(outgoing) ||
    !Array.isArray(vertices) ||
    vertices.length === 0 ||
    incoming.length !== vertices.length ||
    outgoing.length !== vertices.length
  ) return undefined;
  return `${String(vertices.length)}:${path?.["c"] === true ? "closed" : "open"}`;
}

function inspectPathProperty(
  state: AnalysisState,
  value: unknown,
  path: string,
): void {
  const property = record(value);
  if (property === undefined || !("k" in property)) {
    addIssue(state, "invalid Bezier path", path);
    return;
  }
  const values = property["a"] === 1
    ? records(property["k"]).flatMap((keyframe) =>
        [keyframe["s"], keyframe["e"]].filter((item) => item !== undefined))
    : [property["k"]];
  const signatures = values.map(pathSignature);
  if (signatures.length === 0 || signatures.some((signature) => signature === undefined)) {
    addIssue(state, "invalid Bezier path", path);
    return;
  }
  if (new Set(signatures).size > 1) {
    addIssue(state, "changing path topology", path);
  }
}

function inspectAnimatedProperty(
  state: AnalysisState,
  value: unknown,
): void {
  const property = record(value);
  if (property?.["a"] === 1) state.features.add("keyframes");
}

function inspectTransform(
  state: AnalysisState,
  transform: unknown,
  path: string,
): void {
  const value = record(transform);
  if (value === undefined) return;
  state.features.add("transform");
  for (const name of ["a", "p", "s", "r", "rz", "o"] as const) {
    inspectAnimatedProperty(state, value[name]);
  }
  const position = record(value["p"]);
  if (position?.["s"] === true || position?.["s"] === 1) {
    addIssue(state, "separated position dimensions", path);
  }
  if (
    hasThreeComponentValue(value["a"]) ||
    hasThreeComponentValue(value["p"]) ||
    hasThreeComponentValue(value["s"])
  ) {
    addIssue(state, "3D transform", path);
  }
  if (value["sk"] !== undefined || value["sa"] !== undefined) {
    addIssue(state, "skew transform", path);
  }
}

function shapeFeature(type: string): LottieSupportedFeature | undefined {
  if (type === "gr") return "group";
  if (type === "sh") return "bezier-path";
  if (type === "rc") return "rectangle";
  if (type === "el") return "ellipse";
  if (type === "fl") return "fill";
  if (type === "st") return "stroke";
  if (type === "tm") return "trim-path";
  if (type === "tr") return "transform";
  return undefined;
}

const UNSUPPORTED_SHAPES: Readonly<Record<string, string>> = Object.freeze({
  sr: "star or polygon shape",
  gf: "gradient fill",
  gs: "gradient stroke",
  mm: "merge paths",
  rp: "repeater",
  rd: "rounded corners modifier",
  pb: "pucker and bloat",
  zz: "zig zag",
  tw: "twist",
  op: "offset paths",
});

function inspectShapes(
  state: AnalysisState,
  shapes: unknown,
  path: string,
): void {
  for (const shape of records(shapes)) {
    const type = nonEmptyString(shape["ty"]);
    if (type === undefined) {
      addIssue(state, "shape without type", path);
      continue;
    }
    const supported = shapeFeature(type);
    if (supported === undefined) {
      addIssue(state, UNSUPPORTED_SHAPES[type] ?? `shape type ${type}`, path);
      continue;
    }
    state.features.add(supported);
    if (type === "gr") {
      const groupItems = records(shape["it"]);
      if (
        groupItems.some(({ ty }) => ty === "tm") &&
        groupItems.some(({ ty }) => ty === "fl")
      ) {
        addIssue(state, "trim path with fill", path);
      }
      inspectShapes(state, shape["it"], path);
      continue;
    }
    if (type === "tr") {
      inspectTransform(state, shape, path);
      continue;
    }
    if (type === "fl" || type === "st") {
      const name = nonEmptyString(shape["nm"]);
      if (name !== undefined) state.colorSlots.add(name);
    }
    if (type === "st" && Array.isArray(shape["d"]) && shape["d"].length > 0) {
      addIssue(state, "dashed stroke", path);
    }
    if (
      (type === "rc" || type === "el" || type === "sh") &&
      shape["d"] !== undefined && shape["d"] !== 1
    ) {
      addIssue(state, "reversed shape direction", path);
    }
    if (type === "tm" && shape["m"] !== undefined && shape["m"] !== 1) {
      addIssue(state, "individual trim paths", path);
    }
    if (type === "sh") inspectPathProperty(state, shape["ks"], path);
    for (const property of ["p", "s", "r", "c", "o", "w", "ks", "pt"] as const) {
      inspectAnimatedProperty(state, shape[property]);
    }
  }
}

function normalizedRasterPath(
  documentPath: string,
  asset: JsonRecord,
): string | undefined {
  const filename = nonEmptyString(asset["p"]);
  if (filename === undefined) return undefined;
  const directory = nonEmptyString(asset["u"]) ?? "";
  if (
    asset["e"] === 1 ||
    /^(?:data:|https?:|\/\/)/iu.test(filename) ||
    /^(?:data:|https?:|\/\/)/iu.test(directory)
  ) return undefined;
  const root = posix.dirname(documentPath);
  const path = posix.normalize(posix.join(root === "." ? "" : root, directory, filename));
  return path === ".." || path.startsWith("../") || posix.isAbsolute(path)
    ? undefined
    : path;
}

function networkRaster(asset: JsonRecord): boolean {
  return [asset["p"], asset["u"]].some((value) =>
    typeof value === "string" && /^(?:https?:|\/\/)/iu.test(value));
}

function inspectMasks(
  state: AnalysisState,
  layer: JsonRecord,
  path: string,
): void {
  const masks = records(layer["masksProperties"]);
  if (masks.length === 0) return;
  state.features.add("mask");
  for (const mask of masks) {
    if (mask["mode"] !== "a" && mask["mode"] !== "i") {
      addIssue(state, `mask mode ${String(mask["mode"] ?? "unknown")}`, path);
    }
    if (mask["inv"] === true || mask["inv"] === 1) {
      addIssue(state, "inverted mask", path);
    }
    if (mask["f"] !== undefined) addIssue(state, "mask feather", path);
    if (mask["x"] !== undefined) addIssue(state, "mask expansion", path);
    if (staticScalar(mask["o"]) !== 100) addIssue(state, "mask opacity", path);
    inspectAnimatedProperty(state, mask["pt"]);
    inspectAnimatedProperty(state, mask["o"]);
  }
}

function layerTypeName(type: unknown): string {
  if (type === 1) return "solid layer";
  if (type === 3) return "null layer";
  if (type === 5) return "text layer";
  if (type === 6) return "audio layer";
  if (type === 13) return "camera layer";
  return `layer type ${String(type)}`;
}

function inspectLayer(
  state: AnalysisState,
  layer: JsonRecord,
  path: string,
): void {
  if (hasExpression(layer)) addIssue(state, "expression", path);
  if (hasObjectKey(layer, new Set(["to", "ti"]))) {
    addIssue(state, "spatial keyframe tangents", path);
  }
  if (hasRovingKeyframe(layer) || hasObjectKey(layer, new Set(["roving"]))) {
    addIssue(state, "roving keyframe", path);
  }
  if (layer["ddd"] === 1) addIssue(state, "3D layer", path);
  if (layer["parent"] !== undefined) addIssue(state, "parented layer", path);
  if (layer["tt"] !== undefined || layer["td"] !== undefined) {
    addIssue(state, "track matte", path);
  }
  if (Array.isArray(layer["ef"]) && layer["ef"].length > 0) {
    addIssue(state, "layer effect", path);
  }
  if (Array.isArray(layer["sy"]) && layer["sy"].length > 0) {
    addIssue(state, "layer style", path);
  }
  if (layer["bm"] !== undefined && layer["bm"] !== 0) {
    addIssue(state, "blend mode", path);
  }
  if (layer["tm"] !== undefined) addIssue(state, "time remap", path);
  if (layer["ct"] === 1) addIssue(state, "collapsed transformations", path);
  if (layer["sr"] !== undefined && layer["sr"] !== 1) {
    addIssue(state, "time stretch", path);
  }
  inspectTransform(state, layer["ks"], path);
  inspectMasks(state, layer, path);

  const type = layer["ty"];
  if (type === 4) {
    state.features.add("shape-layer");
    inspectShapes(state, layer["shapes"], path);
    return;
  }
  if (type === 0) {
    state.features.add("precomposition");
    const refId = nonEmptyString(layer["refId"]);
    const asset = refId === undefined ? undefined : state.assets.get(refId);
    if (asset === undefined || !Array.isArray(asset["layers"])) {
      addIssue(state, "missing precomposition", path);
      return;
    }
    if (state.visitedPrecomps.has(refId!)) {
      addIssue(state, "recursive precomposition", path);
      return;
    }
    state.visitedPrecomps.add(refId!);
    inspectLayers(state, asset["layers"], `assets[${JSON.stringify(refId)}].layers`);
    state.visitedPrecomps.delete(refId!);
    return;
  }
  if (type === 2) {
    state.features.add("image-layer");
    const refId = nonEmptyString(layer["refId"]);
    const asset = refId === undefined ? undefined : state.assets.get(refId);
    const rasterPath = asset === undefined
      ? undefined
      : normalizedRasterPath(state.options.documentPath, asset);
    if (asset !== undefined && networkRaster(asset)) {
      addIssue(state, "network asset", path);
    } else if (asset?.["e"] === 1) {
      addIssue(state, "embedded raster", path);
    } else if (
      rasterPath === undefined ||
      !state.options.registeredRasterPaths.includes(rasterPath)
    ) {
      addIssue(state, "unregistered raster", path);
    } else {
      state.features.add("registered-raster");
    }
    return;
  }
  addIssue(state, layerTypeName(type), path);
}

function inspectLayers(
  state: AnalysisState,
  value: unknown,
  prefix: string,
): void {
  for (const [index, layer] of records(value).entries()) {
    inspectLayer(state, layer, layerPath(prefix, layer, index));
  }
}

function rootProfile(document: JsonRecord): Omit<
  LottieFeatureProfile,
  "schema" | "renderer" | "features" | "colorSlots"
> | undefined {
  const lottieVersion = nonEmptyString(document["v"]);
  const width = finiteNumber(document["w"]);
  const height = finiteNumber(document["h"]);
  const frameRate = finiteNumber(document["fr"]);
  const inPoint = finiteNumber(document["ip"]);
  const outPoint = finiteNumber(document["op"]);
  if (
    lottieVersion === undefined ||
    width === undefined || width <= 0 ||
    height === undefined || height <= 0 ||
    frameRate === undefined || frameRate <= 0 ||
    inPoint === undefined ||
    outPoint === undefined || outPoint <= inPoint ||
    !Array.isArray(document["layers"])
  ) return undefined;
  return { lottieVersion, width, height, frameRate, inPoint, outPoint };
}

export function analyzeLottieDocument(
  value: unknown,
  options: AnalyzeLottieOptions = {},
): LottieAnalysis {
  const document = record(value);
  const profile = document === undefined ? undefined : rootProfile(document);
  if (document === undefined || profile === undefined) {
    return {
      ok: false,
      unsupported: [{ feature: "invalid Lottie document", layerPath: "$" }],
    };
  }
  const assets = new Map(records(document["assets"]).flatMap((asset) => {
    const id = nonEmptyString(asset["id"]);
    return id === undefined ? [] : [[id, asset] as const];
  }));
  const state: AnalysisState = {
    assets,
    colorSlots: new Set(),
    features: new Set(),
    issues: new Map(),
    options: {
      documentPath: options.documentPath ?? "animation.json",
      registeredRasterPaths: [...(options.registeredRasterPaths ?? [])]
        .map((path) => posix.normalize(path))
        .sort(),
    },
    visitedPrecomps: new Set(),
  };
  if (document["chars"] !== undefined) addIssue(state, "embedded glyphs", "$");
  if (document["fonts"] !== undefined) addIssue(state, "font table", "$");
  inspectLayers(state, document["layers"], "layers");
  const unsupported = [...state.issues.values()].sort((left, right) =>
    left.layerPath.localeCompare(right.layerPath) ||
    left.feature.localeCompare(right.feature));
  if (unsupported.length > 0) return { ok: false, unsupported };
  return {
    ok: true,
    profile: {
      schema: LOTTIE_FEATURE_PROFILE_SCHEMA,
      renderer: LOTTIE_RENDERER_VERSION,
      ...profile,
      features: [...state.features].sort(),
      colorSlots: [...state.colorSlots].sort(),
    },
  };
}
