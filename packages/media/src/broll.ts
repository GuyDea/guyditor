import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  BrollSourceClassId,
  RightsMetadata,
} from "../../core/src/index.js";

import type { IngestRequest } from "./ingest.js";
import { runFfmpeg } from "./run.js";

type FileSourceClass = "local-footage" | "licensed-asset" | "still-image" | "screen-capture";

export type BrollSourcePathRequest =
  | {
      sourceClass: FileSourceClass;
      path: string;
      origin?: "captured" | "licensed";
      rights?: Partial<RightsMetadata>;
    }
  | {
      sourceClass: "programmatic-animation";
      templateId: string;
      version: string;
      params: Record<string, unknown>;
      seed: number;
      exportedPath?: string;
      provenanceSidecar?: string;
    }
  | { sourceClass: "external-generation" }
  | { sourceClass: "local-generation" };

export type ResolvedBrollSourcePath =
  | {
      kind: "ingest";
      request: IngestRequest;
      rightsMissing: string[];
      programmaticProvenance?: {
        templateId: string;
        version: string;
        paramsHash: string;
        seed: number;
      };
    }
  | {
      kind: "template";
      graphic: {
        templateId: string;
        version: string;
        params: Record<string, unknown>;
        seed: number;
      };
    }
  | {
      kind: "generate";
      local: boolean;
      availability: "available" | "declared-unavailable";
      reason?: string;
    };

function creatorRights(origin: "captured" | "programmatic"): RightsMetadata {
  return { origin, restrictions: [], confirmedBy: "creator" };
}

function sourceRights(
  sourceClass: FileSourceClass,
  selectedOrigin: "captured" | "licensed" | undefined,
  supplied: Partial<RightsMetadata> | undefined,
): RightsMetadata {
  const origin = sourceClass === "licensed-asset"
    ? "licensed"
    : sourceClass === "still-image"
      ? selectedOrigin ?? "unknown"
      : "captured";
  return {
    origin,
    restrictions: [...(supplied?.restrictions ?? [])],
    ...(origin === "captured" ? { confirmedBy: supplied?.confirmedBy ?? "creator" } : {}),
    ...(supplied?.licenseName === undefined ? {} : { licenseName: supplied.licenseName }),
    ...(supplied?.licenseUrl === undefined ? {} : { licenseUrl: supplied.licenseUrl }),
    ...(supplied?.licensor === undefined ? {} : { licensor: supplied.licensor }),
    ...(supplied?.purchaseRef === undefined ? {} : { purchaseRef: supplied.purchaseRef }),
    ...(supplied?.attributionText === undefined
      ? {}
      : { attributionText: supplied.attributionText }),
    ...(supplied?.providerTermsUrl === undefined
      ? {}
      : { providerTermsUrl: supplied.providerTermsUrl }),
    ...(origin === "captured" || supplied?.confirmedBy === undefined
      ? {}
      : { confirmedBy: supplied.confirmedBy }),
    ...(supplied?.confirmedAt === undefined ? {} : { confirmedAt: supplied.confirmedAt }),
  };
}

function missingRights(rights: RightsMetadata): string[] {
  if (rights.origin === "licensed" || rights.origin === "stock") {
    return [
      ...(rights.licenseName === undefined ? ["licenseName"] : []),
      ...(rights.licensor === undefined ? ["licensor"] : []),
    ];
  }
  return rights.origin === "unknown" ? ["origin"] : [];
}

function paramsHash(params: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(params).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
}

export function resolveBrollSourcePath(
  input: BrollSourcePathRequest,
): ResolvedBrollSourcePath {
  if (input.sourceClass === "external-generation") {
    return { kind: "generate", local: false, availability: "available" };
  }
  if (input.sourceClass === "local-generation") {
    return {
      kind: "generate",
      local: true,
      availability: "declared-unavailable",
      reason: "No local generation adapter is configured.",
    };
  }
  if (input.sourceClass === "programmatic-animation") {
    const graphic = {
      templateId: input.templateId,
      version: input.version,
      params: structuredClone(input.params),
      seed: input.seed,
    };
    if (input.exportedPath === undefined) return { kind: "template", graphic };
    if (input.provenanceSidecar === undefined) {
      throw new TypeError("A frozen programmatic export requires a provenance sidecar.");
    }
    return {
      kind: "ingest",
      request: {
        via: "generated",
        sources: [{
          path: input.exportedPath,
          generated: true,
          provenance: { sidecar: input.provenanceSidecar },
          rights: creatorRights("programmatic"),
        }],
      },
      rightsMissing: [],
      programmaticProvenance: {
        templateId: input.templateId,
        version: input.version,
        paramsHash: paramsHash(input.params),
        seed: input.seed,
      },
    };
  }
  const rights = sourceRights(input.sourceClass, input.origin, input.rights);
  return {
    kind: "ingest",
    request: {
      sources: [{ path: input.path, rights }],
      ...(input.sourceClass === "screen-capture" ? { via: "watch" } : { via: "manual" }),
    },
    rightsMissing: missingRights(rights),
  };
}

export interface PromptSynthesisParameters {
  seed: number;
  background: string;
  accent: string;
  offsetX: number;
  offsetY: number;
  speedX: number;
  speedY: number;
  renderedText: false;
}

export function derivePromptSynthesis(
  prompt: string,
  requestedSeed?: number,
): PromptSynthesisParameters {
  const promptDigest = createHash("sha256").update(prompt).digest();
  const seed = requestedSeed ?? promptDigest.readUInt32BE(0);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("Generation seed must be a uint32.");
  }
  const digest = createHash("sha256").update(`${prompt}\0${String(seed)}`).digest();
  const color = (offset: number): string =>
    [...digest.subarray(offset, offset + 3)].map((value) =>
      value.toString(16).padStart(2, "0")).join("");
  return {
    seed,
    background: color(0),
    accent: color(3),
    offsetX: digest[6]!,
    offsetY: digest[7]!,
    speedX: 24 + digest[8]! % 72,
    speedY: 18 + digest[9]! % 54,
    renderedText: false,
  };
}

function fpsNumber(value: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(value);
  if (match === null) throw new TypeError(`Invalid frame rate ${value}.`);
  return Number(match[1]) / Number(match[2]);
}

export interface SynthesizePromptClipInput {
  outputPath: string;
  prompt: string;
  seed?: number;
  width: number;
  height: number;
  durationFrames: number;
  fps: string;
  signal?: AbortSignal;
}

export interface SynthesizedPromptClip {
  outputPath: string;
  mime: "video/mp4";
  width: number;
  height: number;
  durationSeconds: number;
  seed: number;
  parameters: PromptSynthesisParameters;
}

export async function synthesizePromptClip(
  input: SynthesizePromptClipInput,
): Promise<SynthesizedPromptClip> {
  if (
    !Number.isSafeInteger(input.width) || input.width < 16 ||
    !Number.isSafeInteger(input.height) || input.height < 16 ||
    !Number.isSafeInteger(input.durationFrames) || input.durationFrames < 1
  ) throw new RangeError("Synthesis dimensions and duration must be positive integers.");
  const fps = fpsNumber(input.fps);
  const durationSeconds = input.durationFrames / fps;
  const parameters = derivePromptSynthesis(input.prompt, input.seed);
  const boxWidth = Math.max(8, Math.floor(input.width / 4));
  const boxHeight = Math.max(8, Math.floor(input.height / 4));
  await mkdir(dirname(input.outputPath), { recursive: true });
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi",
    "-i", `color=c=0x${parameters.background}:s=${String(input.width)}x${String(input.height)}:r=${input.fps}:d=${durationSeconds.toFixed(6)}`,
    "-vf", [
      `drawbox=x=abs(sin(t*${String(parameters.speedX / 100)}+${String(parameters.offsetX / 100)}))*(iw-${String(boxWidth)})`,
      `y=abs(cos(t*${String(parameters.speedY / 100)}+${String(parameters.offsetY / 100)}))*(ih-${String(boxHeight)})`,
      `w=${String(boxWidth)}`,
      `h=${String(boxHeight)}`,
      `color=0x${parameters.accent}@0.88`,
      "t=fill",
    ].join(":"),
    "-frames:v", String(input.durationFrames),
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-threads", "1", "-g", "30", "-keyint_min", "30",
    "-sc_threshold", "0", "-fflags", "+bitexact", "-flags:v", "+bitexact",
    "-map_metadata", "-1", "-metadata", "creation_time=2000-01-01T00:00:00.000Z",
    "-movflags", "+faststart", input.outputPath,
  ], input.signal === undefined ? {} : { signal: input.signal });
  return {
    outputPath: input.outputPath,
    mime: "video/mp4",
    width: input.width,
    height: input.height,
    durationSeconds,
    seed: parameters.seed,
    parameters,
  };
}

export function isBrollSourceClass(value: string): value is BrollSourceClassId {
  return [
    "local-footage",
    "licensed-asset",
    "still-image",
    "screen-capture",
    "programmatic-animation",
    "external-generation",
    "local-generation",
  ].includes(value);
}
