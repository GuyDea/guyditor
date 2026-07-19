import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  CAPTION_FONT_PATH,
  ensureCaptionFont,
} from "../../../scripts/setup-caption-font.mjs";

const stagedPath = resolve(import.meta.dirname, "../dist/assets/fonts/Inconsolata.otf");

await ensureCaptionFont();
await mkdir(dirname(stagedPath), { recursive: true });
await copyFile(CAPTION_FONT_PATH, stagedPath);

console.log("caption font: staged app runtime asset dist/assets/fonts/Inconsolata.otf");
