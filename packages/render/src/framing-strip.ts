import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { FramingDecision } from "../../deliver/src/index.js";
import { runFfmpeg } from "../../media/src/index.js";

import { framingPreviewSpec } from "./framing-preview.js";

const PANEL_WIDTH = 240;
const PANEL_HEIGHT = 135;
const LABEL_HEIGHT = 24;

export interface FramingPreviewStripInput {
  decision: FramingDecision;
  sourcePath: string;
  outputPath: string;
  signal?: AbortSignal;
}

export interface FramingPreviewStripPanel {
  frame: number;
  png: Buffer;
  crop?: { x: number; y: number; w: number; h: number };
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function framingPreviewStripSvg(
  decisionId: string,
  panels: readonly FramingPreviewStripPanel[],
): string {
  if (panels.length !== 3) throw new RangeError("A framing preview strip requires three panels.");
  const width = PANEL_WIDTH * panels.length;
  const rectangles = panels.flatMap((panel, index) => panel.crop === undefined ? [] : [{
    x: index * PANEL_WIDTH + panel.crop.x * PANEL_WIDTH,
    y: panel.crop.y * PANEL_HEIGHT,
    w: panel.crop.w * PANEL_WIDTH,
    h: panel.crop.h * PANEL_HEIGHT,
  }]);
  const path = rectangles.map(({ x, y, w, h }) =>
    `${String(x + w / 2)},${String(y + h / 2)}`).join(" ");
  const images = panels.map((panel, index) =>
    `<image x="${String(index * PANEL_WIDTH)}" y="0" width="${String(PANEL_WIDTH)}" ` +
    `height="${String(PANEL_HEIGHT)}" href="data:image/png;base64,${panel.png.toString("base64")}"/>`)
    .join("");
  const boxes = rectangles.map(({ x, y, w, h }) =>
    `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" ` +
    "fill=\"none\" stroke=\"#e3ff57\" stroke-width=\"2\"/>").join("");
  const labels = panels.map((panel, index) =>
    `<text x="${String(index * PANEL_WIDTH + 8)}" y="${String(PANEL_HEIGHT + 17)}">` +
    `frame ${xmlText(String(panel.frame))}</text>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w${String(3)}.org/2000/svg" width="${String(width)}" ` +
    `height="${String(PANEL_HEIGHT + LABEL_HEIGHT)}" viewBox="0 0 ${String(width)} ` +
    `${String(PANEL_HEIGHT + LABEL_HEIGHT)}">` +
    `<rect width="100%" height="100%" fill="#0b0d12"/>${images}${boxes}` +
    `${path.length === 0 ? "" : `<polyline points="${path}" fill="none" stroke="#ff5ca8" stroke-width="2"/>`}` +
    `<g fill="#d9dfeb" font-family="sans-serif" font-size="11">${labels}</g>` +
    `<title>${xmlText(decisionId)} framing preview</title></svg>\n`;
}

async function framePng(
  sourcePath: string,
  frame: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", sourcePath,
    "-vf", `select=eq(n\\,${String(frame)}),scale=${String(PANEL_WIDTH)}:${String(PANEL_HEIGHT)}:flags=bicubic`,
    "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1",
  ], {
    collectStdout: false,
    onStdoutChunk: (chunk) => chunks.push(Buffer.from(chunk)),
    ...(signal === undefined ? {} : { signal }),
  });
  const png = Buffer.concat(chunks);
  if (png.length === 0) throw new Error(`Could not render framing proxy frame ${String(frame)}.`);
  return png;
}

export async function renderFramingPreviewStrip(input: FramingPreviewStripInput): Promise<void> {
  const { start, end } = input.decision.shot.source;
  const frames = [
    start.frames,
    Math.floor((start.frames + end.frames) / 2),
    Math.max(start.frames, end.frames - 1),
  ];
  const panels = await Promise.all(frames.map(async (frame): Promise<FramingPreviewStripPanel> => {
    const preview = framingPreviewSpec({
      decision: input.decision,
      sourceFrame: frame,
      boxes: [],
      output: { width: PANEL_WIDTH, height: PANEL_HEIGHT },
      safeArea: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return {
      frame,
      png: await framePng(input.sourcePath, frame, input.signal),
      ...(preview.crop === undefined ? {} : { crop: preview.crop }),
    };
  }));
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, framingPreviewStripSvg(input.decision.decisionId, panels), "utf8");
}
