import source from "../../../../../docs/HELP.md?raw";

import { parseHelp } from "./help-texts.js";
import type { HelpEntry } from "./help-texts.js";

export const HELP_SOURCE = source;

export interface HelpEntries {
  entries: ReadonlyMap<string, HelpEntry>;
  /** Set when docs/HELP.md is malformed; `entries` is then empty. */
  error?: string;
}

let cached: HelpEntries | undefined;

/**
 * The parsed help entries, parsed once on first use. A malformed docs/HELP.md reports its
 * message in `error` instead of throwing, so it can never blank the renderer at import.
 */
export function helpEntries(): HelpEntries {
  if (cached !== undefined) return cached;
  try {
    cached = { entries: parseHelp(HELP_SOURCE) };
  } catch (error) {
    cached = {
      entries: new Map<string, HelpEntry>(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return cached;
}
