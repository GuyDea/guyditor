import { DEFAULT_FILLER_RULE_SET } from "./detect.js";
import type { FillerRuleSet } from "./types.js";

/** Post-assembly tightening: shorten long pauses, flag fillers for review, never auto-remove words. */
export const GENTLE_FILLER_RULE_SET: FillerRuleSet = {
  version: 1,
  pauses: { minRemovableMs: 1200, keepAtSentenceBoundaryMs: 1500, retainMs: 500 },
  fillers: { remove: [], review: ["um", "uh", "erm", "ehm"], keep: [] },
  repeats: { enabled: true, minWords: 3 },
  falseStarts: { enabled: true },
  limits: structuredClone(DEFAULT_FILLER_RULE_SET.limits),
  padding: { cutPaddingMs: 120 },
};
