import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

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
