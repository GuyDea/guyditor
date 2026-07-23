import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  makeGuyditorError,
  programmaticAnimationSidecar,
  serializeProgrammaticAnimationProvenance,
} from "../../core/src/index.js";
import type {
  Asset,
  ProgrammaticAnimationProvenance,
  SidecarRef,
} from "../../core/src/index.js";
import { probeMedia } from "./probe.js";

export interface MaterializeProgrammaticAnimationArtifactInput {
  projectRoot: string;
  outputPath: string;
  assetId: string;
  template: ProgrammaticAnimationProvenance["template"];
  params: Record<string, unknown>;
  seed: number;
  renderer: ProgrammaticAnimationProvenance["renderer"];
  expected: ProgrammaticAnimationProvenance["output"];
  ingestedAt: string;
}

export interface ProgrammaticAnimationArtifact {
  asset: Asset;
  provenance: ProgrammaticAnimationProvenance;
  sidecar: SidecarRef;
  serialized: string;
}

function invalid(message: string, affected: readonly string[]) {
  return makeGuyditorError(
    "E_PROGRAMMATIC_ARTIFACT_INVALID",
    message,
    { affected },
  );
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function projectPath(projectRoot: string, outputPath: string): string {
  const root = resolve(projectRoot);
  const absolute = resolve(outputPath);
  const child = relative(root, absolute);
  if (
    child === "" || child === ".." || child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw invalid(
      `Programmatic output ${outputPath} must be inside the project.`,
      [outputPath],
    );
  }
  return child.split(sep).join("/");
}

function exactOutput(
  actual: {
    frames: number;
    fps: string;
    width: number;
    height: number;
  },
  expected: ProgrammaticAnimationProvenance["output"],
): boolean {
  return actual.frames === expected.frames &&
    actual.fps === expected.fps &&
    actual.width === expected.width &&
    actual.height === expected.height;
}

export async function materializeProgrammaticAnimationArtifact(
  input: MaterializeProgrammaticAnimationArtifactInput,
): Promise<ProgrammaticAnimationArtifact> {
  const [metadata, file, contentHash] = await Promise.all([
    probeMedia(input.outputPath),
    stat(input.outputPath),
    sha256(input.outputPath),
  ]);
  const duration = metadata.probe.duration;
  const fps = metadata.probe.fps ?? metadata.video?.fps ??
    (duration !== undefined && "frames" in duration ? duration.fps : undefined);
  const actual = duration !== undefined && "frames" in duration && fps !== undefined &&
      metadata.probe.width !== undefined && metadata.probe.height !== undefined
    ? {
        frames: duration.frames,
        fps,
        width: metadata.probe.width,
        height: metadata.probe.height,
      }
    : undefined;
  if (
    actual === undefined || !exactOutput(actual, input.expected) ||
    metadata.video === undefined
  ) {
    throw invalid(
      `Encoded programmatic asset does not match ${String(input.expected.frames)} frames at ` +
      `${input.expected.fps}, ${String(input.expected.width)}×${String(input.expected.height)}.`,
      [input.assetId, input.outputPath],
    );
  }
  const rights = {
    origin: "programmatic" as const,
    restrictions: [],
    confirmedBy: "creator" as const,
  };
  const provenance: ProgrammaticAnimationProvenance = {
    schema: "guyditor.programmatic-provenance/v1",
    assetId: input.assetId,
    template: structuredClone(input.template),
    params: structuredClone(input.params),
    seed: input.seed,
    renderer: structuredClone(input.renderer),
    output: structuredClone(input.expected),
    rights,
    contentHash: `sha256:${contentHash}`,
  };
  const sidecar = programmaticAnimationSidecar(provenance);
  const asset: Asset = {
    id: input.assetId,
    kind: "generated",
    path: projectPath(input.projectRoot, input.outputPath),
    sha256: contentHash,
    bytes: file.size,
    ...(metadata.container === undefined ? {} : { container: metadata.container }),
    probe: structuredClone(metadata.probe),
    video: structuredClone(metadata.video),
    ...(metadata.audio === undefined ? {} : { audio: structuredClone(metadata.audio) }),
    ...(metadata.image === undefined ? {} : { image: structuredClone(metadata.image) }),
    integrity: "ok",
    ingest: {
      at: input.ingestedAt,
      ffprobeVersion: metadata.ffprobeVersion,
      via: "generated",
    },
    provenance: { sidecar: sidecar.name },
    rights,
  };
  return {
    asset,
    provenance,
    sidecar,
    serialized: serializeProgrammaticAnimationProvenance(provenance),
  };
}
