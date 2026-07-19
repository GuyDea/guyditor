import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GuyditorProject, PresetPin } from "../../../core/src/index.js";
import { parseCaptionPreset } from "./preset.js";
import type { CaptionPreset } from "./types.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function loadPinnedCaptionPreset(
  projectRoot: string,
  pin: PresetPin,
): Promise<CaptionPreset> {
  if (pin.kind !== "caption") throw new TypeError(`Preset ${pin.id} is not a caption preset.`);
  const content = await readFile(join(projectRoot, pin.path), "utf8");
  const actual = sha256(content);
  if (actual !== pin.sha256) {
    throw new TypeError(`Caption preset ${pin.path} does not match its pinned SHA-256.`);
  }
  const preset = parseCaptionPreset(content);
  if (preset.presetId !== pin.id || preset.version !== pin.version) {
    throw new TypeError(`Caption preset ${pin.path} does not match ${pin.id}@${String(pin.version)}.`);
  }
  return preset;
}

export interface PinCaptionPresetOptions<Project extends Pick<GuyditorProject, "presets">> {
  globalRoot: string;
  projectRoot: string;
  project: Project;
  presetId: string;
  version: number;
}

export async function pinCaptionPresetVersion<
  Project extends Pick<GuyditorProject, "presets">,
>(options: PinCaptionPresetOptions<Project>): Promise<{
  project: Project;
  pin: PresetPin;
  preset: CaptionPreset;
}> {
  const existing = options.project.presets.find(({ id, version }) =>
    id === options.presetId && version === options.version);
  if (existing !== undefined) {
    const preset = await loadPinnedCaptionPreset(options.projectRoot, existing);
    return { project: options.project, pin: existing, preset };
  }
  const filename = `${options.presetId}@${String(options.version)}.yaml`;
  const globalPath = join(options.globalRoot, "captions", filename);
  const content = await readFile(globalPath, "utf8");
  const preset = parseCaptionPreset(content);
  if (preset.presetId !== options.presetId || preset.version !== options.version) {
    throw new TypeError(`Global caption preset ${globalPath} has mismatched identity.`);
  }
  const pin: PresetPin = {
    id: preset.presetId,
    name: preset.name,
    kind: "caption",
    version: preset.version,
    path: `presets/${filename}`,
    sha256: sha256(content),
  };
  const destination = join(options.projectRoot, pin.path);
  await mkdir(join(options.projectRoot, "presets"), { recursive: true });
  try {
    await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
    const existingContent = await readFile(destination, "utf8");
    if (sha256(existingContent) !== pin.sha256) {
      throw new TypeError(`Immutable caption preset destination ${destination} already differs.`);
    }
  }
  return {
    project: {
      ...options.project,
      presets: [...options.project.presets, pin].sort((left, right) => left.id.localeCompare(right.id)),
    },
    pin,
    preset,
  };
}
