import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCanvas } from "@napi-rs/canvas";

import {
  CAPTION_FONT_PATH,
  ensureCaptionFont,
} from "./setup-caption-font.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_ROOT = path.join(REPOSITORY_ROOT, "templates");
const RUNTIME_ROOT = path.join(REPOSITORY_ROOT, ".guyditor", "template-preview-runtime");

async function templateDirectories() {
  return (await readdir(TEMPLATES_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(TEMPLATES_ROOT, entry.name))
    .sort();
}

function compileRuntime() {
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPOSITORY_ROOT, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      path.join(REPOSITORY_ROOT, "packages", "render", "tsconfig.json"),
      "--noEmit",
      "false",
      "--outDir",
      RUNTIME_ROOT,
      "--rootDir",
      path.join(REPOSITORY_ROOT, "packages"),
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false, windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not compile the template preview runtime: ${
        result.error?.message ?? `${result.stdout}${result.stderr}`.trim()
      }`,
    );
  }
}

async function preparePackageFiles(templateRoot) {
  const fontDirectory = path.join(templateRoot, "fonts");
  await mkdir(fontDirectory, { recursive: true });
  await copyFile(CAPTION_FONT_PATH, path.join(fontDirectory, "Inconsolata.otf"));
  const previewPath = path.join(templateRoot, "preview.png");
  const blank = createCanvas(640, 360);
  await writeFile(previewPath, blank.toBuffer("image/png"));
}

async function renderPreviews() {
  await ensureCaptionFont();
  const directories = await templateDirectories();
  await Promise.all(directories.map(preparePackageFiles));
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  compileRuntime();
  const runtime = await import(pathToFileURL(
    path.join(RUNTIME_ROOT, "render", "src", "index.js"),
  ).href);

  for (const templateRoot of directories) {
    const validated = await runtime.validateTemplatePackage(templateRoot);
    if (!validated.ok) throw new Error(validated.error.message);
    const loaded = await runtime.loadTemplateRuntime(validated.value);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const totalFrames = validated.value.manifest.duration.default?.frames ?? 120;
    const frame = Math.max(0, Math.min(totalFrames - 1, Math.round(totalFrames * 0.38)));
    const png = runtime.renderTemplatePng(loaded.value, {
      params: validated.value.manifest.preview.params,
      seed: 0x4755_5944,
      frame,
      totalFrames,
      fps: "30/1",
      width: 640,
      height: 360,
      safeArea: { top: 22, right: 32, bottom: 22, left: 32 },
      brand: { palette: {} },
    });
    if (!png.ok) throw new Error(png.error.message);
    await writeFile(path.join(templateRoot, "preview.png"), png.value);
    const finalValidation = await runtime.validateTemplatePackage(templateRoot);
    if (!finalValidation.ok) throw new Error(finalValidation.error.message);
    console.log(
      `${validated.value.manifest.name}: ${finalValidation.value.contentHash}`,
    );
  }
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
}

renderPreviews().catch(async (error) => {
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  console.error(`template previews: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
