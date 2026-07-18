import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { makeGuyditorError } from "../../core/src/index.js";

export interface RenderProfile {
  id: string;
  version: string;
  video: { codec: string; crf: number; pixelFormat: string };
  audio: { codec: string; bitrate: string };
  container: "mp4" | "mov" | "webm";
}

export interface LoadedRenderProfile {
  path: string;
  profile: RenderProfile;
  sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidProfile(message: string): never {
  throw makeGuyditorError(
    "E_RENDER_UNSUPPORTED",
    `Render profile ${message}; Part 11 owns the complete profile schema.`,
  );
}

function parseProfile(value: unknown, expectedId: string, expectedVersion: string): RenderProfile {
  if (!isRecord(value)) invalidProfile("must be a mapping");
  const video = value["video"];
  const audio = value["audio"];
  if (!isRecord(video) || !isRecord(audio)) {
    invalidProfile("requires video and audio mappings");
  }
  const id = value["id"];
  const version = value["version"];
  const codec = video["codec"];
  const crf = video["crf"];
  const pixelFormat = video["pixelFormat"];
  const audioCodec = audio["codec"];
  const bitrate = audio["bitrate"];
  const container = value["container"];
  if (
    id !== expectedId || version !== expectedVersion ||
    typeof codec !== "string" || !Number.isSafeInteger(crf) ||
    typeof pixelFormat !== "string" || typeof audioCodec !== "string" ||
    typeof bitrate !== "string" ||
    (container !== "mp4" && container !== "mov" && container !== "webm")
  ) {
    invalidProfile(`${expectedId}@${expectedVersion} has invalid M0 encode settings`);
  }
  return {
    id,
    version,
    video: { codec, crf: crf as number, pixelFormat },
    audio: { codec: audioCodec, bitrate },
    container,
  };
}

function profilePin(pin: string): { id: string; version: string } {
  const match = /^([a-z0-9-]+)@(\d+\.\d+\.\d+)$/u.exec(pin);
  if (match === null) invalidProfile(`pin ${pin} is not <id>@<semver>`);
  return { id: match[1]!, version: match[2]! };
}

export async function loadRenderProfile(
  pin: string,
  profilesRoot: string | URL = join(process.cwd(), "profiles"),
): Promise<LoadedRenderProfile> {
  const { id, version } = profilePin(pin);
  const root = profilesRoot instanceof URL ? fileURLToPath(profilesRoot) : profilesRoot;
  const path = join(root, id, `${version}.yaml`);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    invalidProfile(
      `${pin} could not be loaded from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    path,
    profile: parseProfile(parse(bytes.toString("utf8")) as unknown, id, version),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
