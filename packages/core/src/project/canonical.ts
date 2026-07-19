import { parse as parseYaml } from "yaml";

import {
  failure,
  makeGuyditorError,
} from "../errors.js";
import type { Result } from "../errors.js";
import type { GuyditorProject } from "./model.js";
import { validateProject } from "./validate.js";

type PathPart = string | number;
type KeyOrder = readonly string[];

const ROOT_ORDER = [
  "format",
  "revision",
  "project",
  "settings",
  "transcript",
  "assets",
  "beats",
  "sequences",
  "layers",
  "captions",
  "annotations",
  "deliverables",
  "templates",
  "avoidRegions",
  "watchFolders",
  "presets",
  "skills",
  "sidecars",
] as const;

const ORDERS = {
  project: ["id", "name", "created"],
  settings: ["timeline", "audio", "primaryDeliverable", "automation"],
  timeline: ["fps", "width", "height"],
  settingsAudio: ["sampleRate", "channels"],
  transcript: ["nextWordOrdinal"],
  asset: [
    "id", "kind", "path", "knownPaths", "sha256", "bytes", "container",
    "probe", "video", "audio", "image", "captureTime", "timecode",
    "session", "takes", "markers", "analyses", "sync", "integrity",
    "ingest", "provenance", "rights",
  ],
  probe: ["duration", "width", "height", "fps", "audio", "capturedAt"],
  probeAudio: ["rate", "channels"],
  video: [
    "codec", "width", "height", "fps", "pixFmt", "hasAlpha", "rotation",
    "colorSpace", "bitrate",
  ],
  audioStream: ["index", "codec", "sampleRate", "channels", "layout", "bitrate"],
  image: ["width", "height", "hasAlpha"],
  captureTime: ["value", "source"],
  timecode: ["start", "fps"],
  ingest: ["at", "ffprobeVersion", "via"],
  provenance: ["sidecar"],
  rights: ["source", "license", "restrictions"],
  beat: ["id", "name", "anchor", "anchorMetadata", "chapter"],
  chapter: ["title"],
  sequence: ["id", "name", "clips", "audio"],
  sequenceAudio: ["targetLufs", "truePeakDb"],
  clip: [
    "id", "asset", "source", "gapBefore", "overlapPrevious",
    "transitionAfter", "effects", "audio", "loop", "anchor", "anchorMetadata", "punchIn",
  ],
  frameRange: ["in", "out"],
  frameTime: ["frames", "fps"],
  sampleTime: ["samples", "rate"],
  transition: ["id", "preset", "duration", "params", "intent"],
  effect: ["id", "kind", "params"],
  clipAudio: ["gainDb", "fadeIn", "fadeInCurve", "fadeOut", "fadeOutCurve", "mute", "offset", "channels", "chain"],
  layerAudio: ["chain"],
  audioChain: ["nodes"],
  audioChainNode: [
    "type", "enabled", "mapping", "strengthDb", "gainDb", "bands",
    "thresholdDb", "ratio", "attackMs", "releaseMs", "makeupDb", "ceilingDb",
  ],
  eqBand: ["freqHz", "gainDb", "q"],
  loop: ["enabled", "crossfade"],
  punchIn: ["level", "anchor"],
  point: ["x", "y"],
  transform: ["anchor", "position", "scale", "rotationDeg", "crop"],
  crop: ["x", "y", "w", "h"],
  colorCorrection: ["exposure", "contrast", "temperatureK", "tint", "saturation"],
  keySettings: ["schema", "mode", "chroma", "neural", "masks", "postColor"],
  chroma: ["keyColor", "tolerance", "softness", "preBlur", "edge", "spill"],
  keyEdge: ["erodePx", "featherPx"],
  keySpill: ["mode", "strength"],
  keyMask: ["id", "role", "shape", "points", "featherPx", "frames"],
  shapeMask: ["shape", "cornerRadius", "featherPx"],
  pipStyle: ["mask", "border", "shadow", "background", "deviceFrame"],
  pipBorder: ["widthPx", "color", "opacity"],
  pipShadow: ["dx", "dy", "blurPx", "color", "opacity"],
  pipBackground: ["color", "blurSigma", "padPx"],
  deviceFrame: ["templateId", "params"],
  pip: ["style", "placement", "keyframes", "avoid"],
  responsivePlacement: ["base", "overrides"],
  placement: [
    "anchor", "width", "height", "margin", "margin_x", "margin_y",
    "offset_x", "offset_y", "aspect", "fit",
  ],
  pipKeyframe: ["id", "at", "placement", "style", "transition"],
  pipTransition: ["preset", "durationFrames", "params"],
  avoidConfig: [
    "enabled", "sources", "softOverlapMax", "holdFrames", "fallbackAnchors",
    "moveTransition",
  ],
  moveTransition: ["preset", "durationFrames"],
  avoidRegion: ["id", "source", "hardness", "rect", "frames", "fromAnnotation"],
  normalizedRect: ["x", "y", "w", "h"],
  layer: [
    "id", "kind", "name", "order", "enabled", "locked", "opacity", "blend",
    "transform", "matte", "pip", "adjustment", "audio", "ducking", "look", "sequence", "items",
  ],
  ducking: ["enabled", "mode", "duckDb", "attackMs", "releaseMs", "holdMs", "minGapMs", "overrides"],
  duckingPoint: ["at", "gainDb"],
  look: ["presetId", "presetVersion", "exposure", "contrast", "temperatureK", "tint", "saturation"],
  matte: ["layerId", "source", "invert"],
  placedItem: [
    "id", "asset", "template", "at", "duration", "anchorMetadata", "source", "effects",
    "params", "seed", "layout",
  ],
  anchorMetadataEntry: ["lastResolved"],
  anchorLastResolved: ["timeline", "revision", "context"],
  anchorWordContext: ["wordsBefore", "wordsAfter"],
  until: ["until"],
  caption: [
    "id", "name", "sourceLayerIds", "preset", "styleOverrides",
    "breakOverrides", "emphasisOverrides", "timingOffsets", "enabled",
  ],
  captionPreset: ["presetId", "version"],
  emphasis: ["wordId", "emphasis"],
  timingOffset: ["firstWordId", "startMs", "endMs"],
  annotations: ["sidecar", "summary"],
  annotationSummary: ["open", "resolved", "rejected", "reopened"],
  deliverable: [
    "id", "kind", "name", "profile", "profileOverrides", "sequenceId",
    "captionsTrackId", "status", "approvedRevision", "dependencies",
    "divergences", "staleReasons", "publishFiles",
  ],
  divergence: ["class", "transactionIds"],
  publishFile: ["path", "sha256"],
  templatePin: ["version", "contentHash"],
  presetPin: ["id", "name", "kind", "version", "path", "sha256"],
  skillPin: ["id", "name", "version", "path", "contentHash"],
  sidecar: ["name", "path", "schema", "sha256", "generatedBy", "inputs"],
  generatedBy: ["tool", "version", "job"],
  sidecarInput: ["asset", "sidecar", "sha256"],
} as const satisfies Record<string, KeyOrder>;

const REGISTRY_SORT_KEYS = new Map<string, string>([
  ["assets", "id"],
  ["beats", "id"],
  ["captions", "id"],
  ["deliverables", "id"],
  ["presets", "id"],
  ["skills", "id"],
  ["sidecars", "name"],
  ["avoidRegions", "id"],
]);

const ISO_8601_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastString(path: readonly PathPart[]): string | undefined {
  const last = path.at(-1);
  return typeof last === "string" ? last : undefined;
}

function includesPath(path: readonly PathPart[], part: string): boolean {
  return path.some((candidate) => candidate === part);
}

function orderFor(
  value: Record<string, unknown>,
  path: readonly PathPart[],
): KeyOrder | undefined {
  if (path.length === 0) return ROOT_ORDER;
  if ("frames" in value && "fps" in value) return ORDERS.frameTime;
  if ("samples" in value && "rate" in value) return ORDERS.sampleTime;
  if ("in" in value && "out" in value) return ORDERS.frameRange;

  const key = lastString(path);
  if (path.length === 1) {
    if (key === "project") return ORDERS.project;
    if (key === "settings") return ORDERS.settings;
    if (key === "transcript") return ORDERS.transcript;
    if (key === "annotations") return ORDERS.annotations;
  }
  if (key === "timeline" && includesPath(path, "settings")) return ORDERS.timeline;
  if (key === "audio" && includesPath(path, "settings")) return ORDERS.settingsAudio;
  if (key === "probe") return ORDERS.probe;
  if (key === "audio" && includesPath(path, "probe")) return ORDERS.probeAudio;
  if (key === "video" && includesPath(path, "assets")) return ORDERS.video;
  if (typeof path.at(-1) === "number" && path.at(-2) === "audio" && includesPath(path, "assets")) {
    return ORDERS.audioStream;
  }
  if (key === "image" && includesPath(path, "assets")) return ORDERS.image;
  if (key === "captureTime") return ORDERS.captureTime;
  if (key === "timecode") return ORDERS.timecode;
  if (key === "ingest") return ORDERS.ingest;
  if (key === "provenance") return ORDERS.provenance;
  if (key === "rights") return ORDERS.rights;
  if (key === "chapter") return ORDERS.chapter;
  if (key === "audio" && includesPath(path, "clips")) return ORDERS.clipAudio;
  if (key === "audio" && includesPath(path, "layers")) return ORDERS.layerAudio;
  if (key === "audio" && includesPath(path, "sequences")) return ORDERS.sequenceAudio;
  if (key === "chain") return ORDERS.audioChain;
  if (typeof value.type === "string" && [
    "channelSelect", "noiseReduction", "gain", "eq", "compression", "limiting",
  ].includes(value.type)) return ORDERS.audioChainNode;
  if ("freqHz" in value && "gainDb" in value && "q" in value) return ORDERS.eqBand;
  if (key === "transitionAfter") return ORDERS.transition;
  if (key === "loop") return ORDERS.loop;
  if (key === "punchIn") return ORDERS.punchIn;
  if (key === "transform") return ORDERS.transform;
  if (key === "crop" && "w" in value && "h" in value) return ORDERS.crop;
  if (key === "adjustment" || key === "postColor") return ORDERS.colorCorrection;
  if (key === "ducking") return ORDERS.ducking;
  if (typeof path.at(-1) === "number" && path.at(-2) === "overrides" && includesPath(path, "ducking")) {
    return ORDERS.duckingPoint;
  }
  if (key === "look") return ORDERS.look;
  if (key === "params" && value.schema === "guyditor/key@1") return ORDERS.keySettings;
  if (key === "chroma") return ORDERS.chroma;
  if (key === "edge" && "erodePx" in value) return ORDERS.keyEdge;
  if (key === "spill") return ORDERS.keySpill;
  if (key === "anchor" && "x" in value && "y" in value) return ORDERS.point;
  if (key === "matte") return ORDERS.matte;
  if (key === "duration" && "until" in value) return ORDERS.until;
  if (key === "anchorMetadata") return undefined;
  if (key === "lastResolved") return ORDERS.anchorLastResolved;
  if (key === "context" && "wordsBefore" in value) return ORDERS.anchorWordContext;
  if ("lastResolved" in value && Object.keys(value).length === 1) {
    return ORDERS.anchorMetadataEntry;
  }
  if (key === "preset" && "presetId" in value) return ORDERS.captionPreset;
  if (key === "pip") return ORDERS.pip;
  if (key === "style" && includesPath(path, "pip")) return ORDERS.pipStyle;
  if (key === "mask" && includesPath(path, "pip")) return ORDERS.shapeMask;
  if (key === "border" && includesPath(path, "pip")) return ORDERS.pipBorder;
  if (key === "shadow" && includesPath(path, "pip")) return ORDERS.pipShadow;
  if (key === "background" && includesPath(path, "pip")) return ORDERS.pipBackground;
  if (key === "deviceFrame") return ORDERS.deviceFrame;
  if (key === "placement" && "base" in value) return ORDERS.responsivePlacement;
  if (key === "base" && includesPath(path, "placement")) return ORDERS.placement;
  if (key === "placement" && includesPath(path, "keyframes")) return ORDERS.placement;
  if (key === "transition" && includesPath(path, "keyframes")) return ORDERS.pipTransition;
  if (key === "avoid" && includesPath(path, "pip")) return ORDERS.avoidConfig;
  if (key === "moveTransition") return ORDERS.moveTransition;
  if (key === "rect" && includesPath(path, "avoidRegions")) return ORDERS.normalizedRect;
  if (key === "summary" && includesPath(path, "annotations")) return ORDERS.annotationSummary;
  if (key === "generatedBy") return ORDERS.generatedBy;
  if (typeof path.at(-1) === "number" && path.at(-2) === "inputs" && includesPath(path, "sidecars")) {
    return ORDERS.sidecarInput;
  }
  if (typeof path.at(-1) === "string" && path.at(-2) === "templates") return ORDERS.templatePin;

  const id = typeof value.id === "string" ? value.id : "";
  const prefix = id.slice(0, id.indexOf("_"));
  if (prefix === "msk") return ORDERS.keyMask;
  if (prefix === "kfr") return ORDERS.pipKeyframe;
  if (prefix === "avr") return ORDERS.avoidRegion;
  if (prefix === "ast") return ORDERS.asset;
  if (prefix === "beat") return ORDERS.beat;
  if (prefix === "seq") return ORDERS.sequence;
  if (prefix === "trn") return ORDERS.transition;
  if (prefix === "fx") return ORDERS.effect;
  if (prefix === "lyr") return ORDERS.layer;
  if (prefix === "cts") return ORDERS.caption;
  if (prefix === "dlv") return ORDERS.deliverable;
  if (prefix === "pre") return ORDERS.presetPin;
  if (prefix === "skl") return ORDERS.skillPin;
  if (
    (prefix === "clp" || prefix === "gfx") &&
    "at" in value
  ) {
    return ORDERS.placedItem;
  }
  if (prefix === "clp") return ORDERS.clip;
  if ("wordId" in value && "emphasis" in value) return ORDERS.emphasis;
  if ("firstWordId" in value) return ORDERS.timingOffset;
  if ("class" in value && "transactionIds" in value) return ORDERS.divergence;
  if ("path" in value && "sha256" in value && Object.keys(value).length === 2) {
    return ORDERS.publishFile;
  }
  if ("schema" in value && "inputs" in value && !("id" in value)) return ORDERS.sidecar;
  return undefined;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedEntries(
  value: Record<string, unknown>,
  path: readonly PathPart[],
): [string, unknown][] {
  const present = Object.keys(value).filter((key) => value[key] !== undefined);
  const order = orderFor(value, path);
  if (order === undefined) {
    return present.sort(compareStrings).map((key) => [key, value[key]]);
  }

  const indexByKey = new Map(order.map((key, index) => [key, index] as const));
  return present
    .sort((left, right) => {
      const leftIndex = indexByKey.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = indexByKey.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || compareStrings(left, right);
    })
    .map((key) => [key, value[key]]);
}

function normalizedString(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

function quoteString(value: string): string {
  return JSON.stringify(normalizedString(value));
}

function emitString(value: string): string {
  const normalized = normalizedString(value);
  if (ISO_8601_TIMESTAMP.test(normalized)) return quoteString(normalized);
  if (normalized === "" || normalized.includes("\n")) return quoteString(normalized);

  try {
    const roundTripped = parseYaml(normalized, { schema: "core" }) as unknown;
    if (typeof roundTripped === "string" && roundTripped === normalized) {
      return normalized;
    }
  } catch {
    // Fall through to the unambiguous double-quoted form.
  }
  return quoteString(normalized);
}

function emitScalar(value: unknown): string {
  if (typeof value === "string") return emitString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical YAML cannot represent a non-finite number.");
    }
    return String(value);
  }
  if (value === null) {
    throw new TypeError("Canonical YAML cannot represent null model fields.");
  }
  throw new TypeError(`Canonical YAML cannot represent ${typeof value} values.`);
}

function hasNestedListOrMultiline(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (typeof value === "string") return normalizedString(value).includes("\n");
  if (!isRecord(value)) return false;
  return Object.values(value).some(
    (child) => child !== undefined && hasNestedListOrMultiline(child),
  );
}

function flowObject(
  value: Record<string, unknown>,
  path: readonly PathPart[],
): string | undefined {
  if (hasNestedListOrMultiline(value)) return undefined;
  const fields: string[] = [];
  for (const [key, child] of orderedEntries(value, path)) {
    const childPath = [...path, key];
    const emittedKey = emitString(key);
    if (isRecord(child)) {
      const nested = flowObject(child, childPath);
      if (nested === undefined) return undefined;
      fields.push(`${emittedKey}: ${nested}`);
    } else {
      fields.push(`${emittedKey}: ${emitScalar(child)}`);
    }
  }
  if (fields.length === 0) return "{}";
  const emitted = `{ ${fields.join(", ")} }`;
  return emitted.length <= 120 ? emitted : undefined;
}

function sortedArray(value: readonly unknown[], path: readonly PathPart[]): readonly unknown[] {
  if (path.length !== 1) return value;
  const key = lastString(path);
  const sortKey = key === undefined ? undefined : REGISTRY_SORT_KEYS.get(key);
  if (sortKey === undefined) return value;
  return [...value].sort((left, right) => {
    const leftValue = isRecord(left) ? left[sortKey] : undefined;
    const rightValue = isRecord(right) ? right[sortKey] : undefined;
    return typeof leftValue === "string" && typeof rightValue === "string"
      ? compareStrings(leftValue, rightValue)
      : 0;
  });
}

function multilineBlock(value: string, indent: number): string {
  const normalized = normalizedString(value);
  let indicator = "|-";
  if (normalized.endsWith("\n\n")) indicator = "|+";
  else if (normalized.endsWith("\n")) indicator = "|";

  const content = indicator === "|-" ? normalized : normalized.slice(0, -1);
  const padding = " ".repeat(indent);
  return `${indicator}\n${content.split("\n").map((line) => `${padding}${line}`).join("\n")}`;
}

function emitArray(
  value: readonly unknown[],
  indent: number,
  path: readonly PathPart[],
): string {
  if (value.length === 0) return `${" ".repeat(indent)}[]`;
  const padding = " ".repeat(indent);
  return sortedArray(value, path)
    .map((child, index) => {
      const childPath = [...path, index];
      if (isRecord(child)) {
        const flow = flowObject(child, childPath);
        return flow === undefined
          ? `${padding}-\n${emitObject(child, indent + 2, childPath)}`
          : `${padding}- ${flow}`;
      }
      if (Array.isArray(child)) {
        return child.length === 0
          ? `${padding}- []`
          : `${padding}-\n${emitArray(child, indent + 2, childPath)}`;
      }
      if (typeof child === "string" && normalizedString(child).includes("\n")) {
        return `${padding}- ${multilineBlock(child, indent + 2)}`;
      }
      return `${padding}- ${emitScalar(child)}`;
    })
    .join("\n");
}

function emitObject(
  value: Record<string, unknown>,
  indent: number,
  path: readonly PathPart[],
): string {
  const padding = " ".repeat(indent);
  return orderedEntries(value, path)
    .map(([key, child]) => {
      const childPath = [...path, key];
      const emittedKey = emitString(key);
      if (isRecord(child)) {
        const flow = flowObject(child, childPath);
        if (flow !== undefined) return `${padding}${emittedKey}: ${flow}`;
        return `${padding}${emittedKey}:\n${emitObject(child, indent + 2, childPath)}`;
      }
      if (Array.isArray(child)) {
        return child.length === 0
          ? `${padding}${emittedKey}: []`
          : `${padding}${emittedKey}:\n${emitArray(child, indent + 2, childPath)}`;
      }
      if (typeof child === "string" && normalizedString(child).includes("\n")) {
        return `${padding}${emittedKey}: ${multilineBlock(child, indent + 2)}`;
      }
      return `${padding}${emittedKey}: ${emitScalar(child)}`;
    })
    .join("\n");
}

export function canonicalizeYaml(project: GuyditorProject): string {
  const emitted = emitObject(project as unknown as Record<string, unknown>, 0, []);
  return `${emitted.normalize("NFC").replace(/\n*$/u, "")}\n`;
}

export function parseProjectYaml(text: string): Result<GuyditorProject> {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, {
      maxAliasCount: 0,
      prettyErrors: false,
      schema: "core",
      strict: true,
    }) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      makeGuyditorError(
        "E_SCHEMA_INVALID",
        `Project YAML parsing failed: ${detail}`,
      ),
    );
  }

  return validateProject(parsed);
}
