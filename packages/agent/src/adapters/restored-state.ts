import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CredentialStore } from "./credentials.js";

export interface RestoredAdapterCredentialState {
  adapterId: string;
  credentialKeys: string[];
  state: "ready" | "needs-credentials";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function references(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    /(?:ref|reference)$/iu.test(key) && typeof child === "string"
      ? [child]
      : references(child));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function restoredAdapterCredentialStates(
  userDirectory: string,
  credentials: CredentialStore,
): Promise<RestoredAdapterCredentialState[]> {
  let adapterIds: string[];
  try {
    adapterIds = await readdir(join(userDirectory, "adapters"));
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
  const states: RestoredAdapterCredentialState[] = [];
  for (const directoryId of adapterIds.sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(userDirectory, "adapters", directoryId, "manifest.json"), "utf8")) as unknown;
    } catch (error: unknown) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!isRecord(parsed)) continue;
    const adapterId = typeof parsed["adapterId"] === "string" ? parsed["adapterId"] : directoryId;
    const credentialKeys = [...new Set(references(parsed))].sort();
    const values = await Promise.all(credentialKeys.map((key) => credentials.get(adapterId, key)));
    states.push({
      adapterId,
      credentialKeys,
      state: values.every((value) => value !== undefined) ? "ready" : "needs-credentials",
    });
  }
  return states;
}
