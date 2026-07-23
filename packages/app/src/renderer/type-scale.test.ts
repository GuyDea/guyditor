import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, it } from "vitest";

const RENDERER_ROOT = import.meta.dirname;
const FONT_FLOOR_PX = 10;
const STYLESHEET_EXTENSIONS = new Set([".css", ".less", ".sass", ".scss"]);
const COMPONENT_EXTENSIONS = new Set([".jsx", ".tsx"]);

interface FontOffender {
  declaration: string;
  file: string;
  line: number;
  reason: string;
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function stylesheetOffenders(path: string): FontOffender[] {
  const source = readFileSync(path, "utf8");
  const offenders: FontOffender[] = [];
  const declarationPattern = /(?:^|[;{])\s*(--fs-[\w-]+|font(?:-size)?)\s*:\s*([^;}]+)/gmu;

  for (const declaration of source.matchAll(declarationPattern)) {
    const value = declaration[2] ?? "";
    const property = declaration[1] ?? "";
    const fontSizeValue = property === "font" ? value.split("/", 1)[0] ?? "" : value;
    let belowFloor = false;
    for (const sizeMatch of fontSizeValue.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)px\b/gmu)) {
      const size = Number(sizeMatch[1]);
      if (size < FONT_FLOOR_PX) {
        belowFloor = true;
        offenders.push({
          declaration: `${declaration[1]}: ${value.trim()}`,
          file: relative(RENDERER_ROOT, path),
          line: lineAt(source, declaration.index),
          reason: `${String(size)}px`,
        });
      }
    }
    if (!belowFloor &&
      !property.startsWith("--fs-") &&
      !/(?:^|\s)var\(--fs-/mu.test(value)) {
      offenders.push({
        declaration: `${property}: ${value.trim()}`,
        file: relative(RENDERER_ROOT, path),
        line: lineAt(source, declaration.index),
        reason: "bypasses the type scale",
      });
    }
  }
  return offenders;
}

function inlineStyleOffenders(path: string): FontOffender[] {
  const source = readFileSync(path, "utf8");
  const offenders: FontOffender[] = [];
  const fontSizePattern =
    /\bfontSize\s*:\s*(?:["'])?(\d+(?:\.\d+)?)(?:px)?\b/gmu;
  const fontShorthandPattern = /\bfont\s*:\s*["'`]([^"'`]+)["'`]/gmu;

  for (const declaration of source.matchAll(fontSizePattern)) {
    const size = Number(declaration[1]);
    if (size < FONT_FLOOR_PX) {
      offenders.push({
        declaration: declaration[0],
        file: relative(RENDERER_ROOT, path),
        line: lineAt(source, declaration.index),
        reason: `${String(size)}px`,
      });
    }
  }
  for (const declaration of source.matchAll(fontShorthandPattern)) {
    const sizeMatch = declaration[1]?.match(/(?<![\w-])(\d+(?:\.\d+)?)px\b/mu);
    const size = Number(sizeMatch?.[1]);
    if (sizeMatch !== null && size < FONT_FLOOR_PX) {
      offenders.push({
        declaration: declaration[0],
        file: relative(RENDERER_ROOT, path),
        line: lineAt(source, declaration.index),
        reason: `${String(size)}px`,
      });
    }
  }
  return offenders;
}

function failWithOffenders(offenders: FontOffender[]): void {
  if (offenders.length === 0) return;
  const details = offenders
    .map(({ declaration, file, line, reason }) =>
      `- ${file}:${String(line)} (${reason}): ${declaration}`)
    .join("\n");
  throw new Error(
    `Renderer fonts must use the type scale and stay at or above ` +
      `${String(FONT_FLOOR_PX)}px.\n${details}`,
  );
}

describe("renderer type scale", () => {
  it("enforces the 10px font floor across stylesheets and component inline styles", () => {
    const rendererFiles = filesBelow(RENDERER_ROOT);
    const offenders = [
      ...rendererFiles
        .filter((path) => STYLESHEET_EXTENSIONS.has(extname(path)))
        .flatMap(stylesheetOffenders),
      ...rendererFiles
        .filter((path) => COMPONENT_EXTENSIONS.has(extname(path)))
        .flatMap(inlineStyleOffenders),
    ];

    failWithOffenders(offenders);
  });
});
