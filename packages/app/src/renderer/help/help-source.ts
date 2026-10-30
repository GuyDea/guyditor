import source from "../../../../../docs/HELP.md?raw";

import { parseHelp } from "./help-texts.js";
import type { HelpEntry } from "./help-texts.js";

export const HELP_SOURCE = source;

export const HELP_ENTRIES: ReadonlyMap<string, HelpEntry> = parseHelp(HELP_SOURCE);
