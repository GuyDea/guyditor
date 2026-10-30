import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_LLM_RATES } from "../../../agent/src/index.js";
import type { LlmRate, LlmTransport } from "../../../agent/src/index.js";
import type { AssemblyEffort, TighteningMode } from "../../../transcript/src/index.js";

export interface AiSettings {
  provider: "anthropic" | "openai";
  model: string;
  effort: AssemblyEffort;
  tightening: TighteningMode;
  rates: Record<string, LlmRate>;
  transport: { anthropic: LlmTransport; openai: LlmTransport };
  cli: { claudePath: string; codexPath: string };
}

export interface UserSettings {
  schema: 1;
  general: { locale: string; theme: "system" | "light" | "dark"; reopenLastProject: boolean };
  network: { externalCalls: "allow" | "ask" | "block" };
  performance: {
    maxConcurrentJobs: number | "auto";
    jobhostPoolSize: number | "auto";
    preferHardwareEncode: boolean;
    hardwareFinalEncode: boolean;
  };
  mlworker: {
    autoStart: boolean;
    maxProcesses: number;
    defaultTranscriptionModel: "auto" | string;
  };
  logging: { level: "debug" | "info" | "warn" | "error"; retentionDays: number };
  audit: { retentionDays: number };
  budgets: {
    task: { warnUsd: number | null; capUsd: number | null };
    episode: { warnUsd: number | null; capUsd: number | null };
    cumulative: { warnUsd: number | null; capUsd: number | null };
  };
  rights: { requirementLevel: "off" | "warn" | "block" };
  adapters: {
    restyle: {
      kling: {
        enabled: boolean;
        baseUrl?: string;
        apiKeyRef: string;
        model: string;
        costPerSecond: number;
        concurrency: number;
      };
    };
  };
  ai: AiSettings;
  dataBoundaries?: unknown;
}

export interface LoadedSettings {
  settings: UserSettings;
  recoveredPath?: string;
  warning?: string;
}

export const DEFAULT_SETTINGS = Object.freeze({
  schema: 1,
  general: { locale: "en", theme: "system", reopenLastProject: true },
  network: { externalCalls: "ask" },
  performance: {
    maxConcurrentJobs: "auto",
    jobhostPoolSize: "auto",
    preferHardwareEncode: true,
    hardwareFinalEncode: false,
  },
  mlworker: { autoStart: true, maxProcesses: 1, defaultTranscriptionModel: "auto" },
  logging: { level: "info", retentionDays: 30 },
  audit: { retentionDays: 365 },
  budgets: {
    task: { warnUsd: 1, capUsd: 5 },
    episode: { warnUsd: 25, capUsd: null },
    cumulative: { warnUsd: 100, capUsd: null },
  },
  rights: { requirementLevel: "warn" },
  ai: {
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
    tightening: "ask",
    rates: { ...DEFAULT_LLM_RATES },
    transport: { anthropic: "api", openai: "api" },
    cli: { claudePath: "claude", codexPath: "codex" },
  },
  adapters: {
    restyle: {
      kling: {
        enabled: true,
        apiKeyRef: "apiKey",
        model: "kling-video-o1",
        costPerSecond: 0.14,
        concurrency: 2,
      },
    },
  },
} satisfies UserSettings);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDefaults(defaults: unknown, candidate: unknown): unknown {
  if (!isRecord(defaults) || !isRecord(candidate)) {
    return candidate === undefined ? structuredClone(defaults) : candidate;
  }
  const merged: Record<string, unknown> = structuredClone(candidate);
  for (const [key, value] of Object.entries(defaults)) {
    merged[key] = mergeDefaults(value, candidate[key]);
  }
  return merged;
}

function parseSettings(text: string): UserSettings {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || (parsed["schema"] !== undefined && parsed["schema"] !== 1)) {
    throw new TypeError("settings.json must be a schema-1 object.");
  }
  return mergeDefaults(DEFAULT_SETTINGS, parsed) as UserSettings;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function loadSettings(
  userDirectory: string,
  now: () => Date = () => new Date(),
): Promise<LoadedSettings> {
  const settingsPath = join(userDirectory, "settings.json");
  let text: string;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return { settings: structuredClone(DEFAULT_SETTINGS) };
    throw error;
  }

  try {
    return { settings: parseSettings(text) };
  } catch {
    const recoveredPath = `${settingsPath}.bad-${String(now().getTime())}`;
    await rename(settingsPath, recoveredPath);
    return {
      settings: structuredClone(DEFAULT_SETTINGS),
      recoveredPath,
      warning: `Invalid settings were recovered to ${recoveredPath}; defaults are active.`,
    };
  }
}

let tempCounter = 0;
let writeQueue: Promise<void> = Promise.resolve();

/** Replaces one top-level key of settings.json (other keys kept), atomically. Writes are serialized. */
export function replaceSettingsKey(
  userDirectory: string,
  key: string,
  value: unknown,
  now: () => Date = () => new Date(),
): Promise<void> {
  const write = writeQueue.then(() => writeSettingsKey(userDirectory, key, value, now));
  writeQueue = write.catch(() => undefined);
  return write;
}

async function writeSettingsKey(
  userDirectory: string,
  key: string,
  value: unknown,
  now: () => Date,
): Promise<void> {
  const settingsPath = join(userDirectory, "settings.json");
  let current: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed)) {
      current = parsed;
    } else {
      await rename(settingsPath, `${settingsPath}.bad-${String(now().getTime())}`);
    }
  }
  tempCounter += 1;
  const temporary = `${settingsPath}.tmp-${String(process.pid)}-${String(tempCounter)}`;
  await writeFile(temporary, `${JSON.stringify({ ...current, [key]: value }, null, 2)}\n`, "utf8");
  await rename(temporary, settingsPath);
}

/** Reads one top-level key of settings.json; undefined when the file or key is missing or unreadable. */
export async function readSettingsKey(userDirectory: string, key: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(userDirectory, "settings.json"), "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed[key] : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces only the `ai` key of settings.json (unknown keys kept), atomically. */
export async function saveAiSettings(
  userDirectory: string,
  ai: AiSettings,
  now: () => Date = () => new Date(),
): Promise<void> {
  await replaceSettingsKey(userDirectory, "ai", ai, now);
}
