import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CAPTION_FONT = Object.freeze({
  family: "Inconsolata Guyditor",
  filename: "Inconsolata.otf",
  bytes: 58_464,
  sha256: "1561e616c414a1b82d6e6dfbd18e5726fd65028913ade191e5fa38b6ec375a1a",
  source: "https://levien.com/type/myfonts/Inconsolata.otf",
});

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CAPTION_FONT_PATH = path.join(
  REPOSITORY_ROOT,
  "packages/render/assets/fonts",
  CAPTION_FONT.filename,
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function validFont(pathname) {
  try {
    const bytes = await readFile(pathname);
    return bytes.byteLength === CAPTION_FONT.bytes && digest(bytes) === CAPTION_FONT.sha256;
  } catch {
    return false;
  }
}

export async function ensureCaptionFont({ fetchImpl = globalThis.fetch, outputPath = CAPTION_FONT_PATH } = {}) {
  if (await validFont(outputPath)) return outputPath;
  if (typeof fetchImpl !== "function") throw new Error("Caption font setup requires fetch.");
  const response = await fetchImpl(CAPTION_FONT.source);
  if (!response.ok) throw new Error(`Caption font download failed with HTTP ${String(response.status)}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = digest(bytes);
  if (bytes.byteLength !== CAPTION_FONT.bytes || hash !== CAPTION_FONT.sha256) {
    throw new Error(
      `Caption font integrity failed: expected ${CAPTION_FONT.sha256}/${String(CAPTION_FONT.bytes)}, ` +
      `received ${hash}/${String(bytes.byteLength)}.`,
    );
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.partial-${String(process.pid)}`;
  await rm(temporary, { force: true });
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, outputPath);
  await access(outputPath);
  return outputPath;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) {
  ensureCaptionFont().then((fontPath) => {
    console.log(`caption font: verified ${path.relative(REPOSITORY_ROOT, fontPath)} (${CAPTION_FONT.sha256})`);
  }).catch((error) => {
    console.error(`caption font setup: ${error.message}`);
    process.exitCode = 1;
  });
}
