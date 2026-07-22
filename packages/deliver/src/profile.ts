import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { parse } from "yaml";

import { makeGuyditorError } from "../../core/src/index.js";

import profileSchema from "./schemas/guyditor-profile-v1.schema.json" with { type: "json" };

export interface ProfileResolution { width: number; height: number }
export interface ProfileInsets { top: number; bottom: number; left: number; right: number }
export interface ProfileRect { x: number; y: number; w: number; h: number }

export interface PlatformProfile {
  format: "guyditor-profile/v1";
  id: string;
  version: string;
  displayName: string;
  kind: "short" | "longform";
  video: {
    aspect: string;
    resolution: ProfileResolution;
    resolutionsAllowed?: ProfileResolution[];
    fps: { allowed: string[]; default: string };
    container: "mp4" | "mov" | "webm";
    codec: string;
    codecProfile: string;
    pixelFormat: string;
    colorSpace: string;
    rateControl: { mode: "crf"; crf: number; maxBitrateKbps: number };
  };
  duration: {
    minSeconds: number;
    maxSeconds: number | null;
    recommendedMaxSeconds: number | null;
  };
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
    bitrateKbps: number;
    loudness: {
      integratedLufs: number;
      toleranceLu: number;
      truePeakDbtp: number;
      lraMaxLu: number;
    };
  };
  safeAreas: {
    title: ProfileInsets;
    action: ProfileInsets;
    platformUi: Array<{ name: string; rect: ProfileRect }>;
  };
  captionDefaults: {
    maxLines: number;
    maxCharsPerLine: number;
    placement: { anchor: "left" | "center" | "right"; verticalCenter: number };
    perWordHighlight: boolean;
  };
  metadata: {
    title: { maxChars: number } | null;
    description: { maxChars: number };
    tags: { maxCount: number; totalMaxChars: number } | null;
    hashtags: {
      maxCount: number;
      recommendedMaxCount?: number;
      countedIn: "description" | "caption";
    } | null;
  };
  cover: {
    resolution: ProfileResolution;
    formats: Array<"jpg" | "png">;
    maxBytes: number;
  };
  chapters: {
    minCount: number;
    minChapterSeconds: number;
    firstMustBeZero: boolean;
  } | null;
}

export interface LoadedPlatformProfile {
  path: string;
  profile: PlatformProfile;
  sha256: string;
}

export interface PlatformProfileRoots {
  projectRoot?: string | URL;
  userRoot?: string | URL;
  builtinsRoot?: string | URL;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateProfile = ajv.compile<PlatformProfile>(profileSchema);
const PIN_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function rootPath(root: string | URL): string {
  return root instanceof URL ? fileURLToPath(root) : root;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function profileErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return errors?.map((error) => {
    const path = error.instancePath === "" ? "/" : error.instancePath;
    return `${path} ${error.message ?? error.keyword}`;
  }).join("; ") ?? "unknown schema error";
}

function assertProfile(value: unknown, expected?: { id: string; version: string }): PlatformProfile {
  if (!validateProfile(value)) {
    throw makeGuyditorError(
      "E_PROFILE_INVALID",
      `Platform profile failed guyditor-profile/v1 validation: ${profileErrors(validateProfile.errors)}.`,
    );
  }
  if (expected !== undefined && (value.id !== expected.id || value.version !== expected.version)) {
    throw makeGuyditorError(
      "E_PROFILE_INVALID",
      `Platform profile content ${value.id}@${value.version} does not match requested pin ${expected.id}@${expected.version}.`,
      { affected: [`${expected.id}@${expected.version}`] },
    );
  }
  if (!value.video.fps.allowed.includes(value.video.fps.default)) {
    throw makeGuyditorError(
      "E_PROFILE_INVALID",
      `Platform profile ${value.id}@${value.version} default fps is not in its allowed list.`,
      { affected: [`${value.id}@${value.version}`] },
    );
  }
  if (
    value.duration.maxSeconds !== null &&
    value.duration.minSeconds > value.duration.maxSeconds
  ) {
    throw makeGuyditorError(
      "E_PROFILE_INVALID",
      `Platform profile ${value.id}@${value.version} duration bounds are inverted.`,
      { affected: [`${value.id}@${value.version}`] },
    );
  }
  return structuredClone(value);
}

function parsePin(pin: string): { id: string; version: string } {
  const match = PIN_PATTERN.exec(pin);
  if (match === null) {
    throw makeGuyditorError(
      "E_PROFILE_INVALID",
      `Platform profile pin ${pin} must use <profileId>@<semver>.`,
      { affected: [pin] },
    );
  }
  return { id: match[1]!, version: `${match[2]!}.${match[3]!}.${match[4]!}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return structuredClone(patch);
  const merged: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : structuredClone(value);
  }
  return merged;
}

export function resolveProfileOverrides(
  profile: PlatformProfile,
  overrides: Record<string, unknown>,
): PlatformProfile {
  return assertProfile(deepMerge(profile, overrides));
}

export async function loadPlatformProfile(
  pin: string,
  roots: PlatformProfileRoots & { overrides?: Record<string, unknown> } = {},
): Promise<LoadedPlatformProfile> {
  const requested = parsePin(pin);
  const candidates = [
    roots.projectRoot ?? join(process.cwd(), "profiles"),
    roots.userRoot ?? join(homedir(), ".guyditor", "profiles"),
    roots.builtinsRoot ?? join(process.cwd(), "profiles"),
  ].map((root) => join(rootPath(root), requested.id, `${requested.version}.yaml`));
  const uniqueCandidates = [...new Set(candidates)];
  for (const path of uniqueCandidates) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error: unknown) {
      if (isMissing(error)) continue;
      throw error;
    }
    const parsed = parse(bytes.toString("utf8")) as unknown;
    const profile = assertProfile(parsed, requested);
    return {
      path,
      profile: roots.overrides === undefined
        ? profile
        : resolveProfileOverrides(profile, roots.overrides),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  throw makeGuyditorError(
    "E_PROFILE_NOT_FOUND",
    `Platform profile ${pin} was not found in project, user, or built-in profiles.`,
    { affected: [pin], retry: "none" },
  );
}
