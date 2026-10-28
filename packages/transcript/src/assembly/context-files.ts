import type { ContextFile, ContextFileKind, ScriptChoice } from "./types.js";

/**
 * Provider limits checked 2026-10-27: Anthropic vision 5 MB / 8000 px per image, PDF 32 MB / 100 pages,
 * request 32 MB; OpenAI PDF 32 MB / 100 pages.
 */
export const CONTEXT_FILE_CAPS = {
  textBytes: 204_800,
  imageBytes: 5_242_880,
  imagePx: 8000,
  pdfBytes: 33_554_432,
  pdfPages: 100,
  turnBytes: 20_971_520,
} as const;

const TEXT_MIME: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  srt: "application/x-subrip",
  vtt: "text/vtt",
};

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(TEXT_MIME));
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(IMAGE_MIME));

export interface Classified {
  kind: ContextFileKind;
  mime: string;
  pages: number | null;
  sent: boolean;
  unsentReason: string | null;
}

const OTHER_MIME = "application/octet-stream";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function sniffImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF8"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function countPdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return Math.max(1, text.match(/\/Type\s*\/Page(?![s])/g)?.length ?? 0);
}

export function sniffImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = sniffImageMime(bytes);
  if (mime === "image/png") {
    return bytes.length >= 24 ? { width: v.getUint32(16), height: v.getUint32(20) } : null;
  }
  if (mime === "image/gif") {
    return bytes.length >= 10 ? { width: v.getUint16(6, true), height: v.getUint16(8, true) } : null;
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1] as number;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xc0 || marker === 0xc2) {
        return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + v.getUint16(i + 2);
    }
    return null;
  }
  if (mime === "image/webp" && bytes.length >= 30) {
    if (startsWith(bytes, ascii("VP8 "), 12)) {
      return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    }
    if (startsWith(bytes, ascii("VP8L"), 12)) {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (startsWith(bytes, ascii("VP8X"), 12)) {
      const w = (bytes[24] as number) | ((bytes[25] as number) << 8) | ((bytes[26] as number) << 16);
      const h = (bytes[27] as number) | ((bytes[28] as number) << 8) | ((bytes[29] as number) << 16);
      return { width: w + 1, height: h + 1 };
    }
  }
  return null;
}

function unsent(kind: ContextFileKind, mime: string, pages: number | null, reason: string): Classified {
  return { kind, mime, pages, sent: false, unsentReason: reason };
}

export function classifyContextFile(name: string, bytes: Uint8Array): Classified {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext)) {
    if (!isUtf8(bytes)) return unsent("other", OTHER_MIME, null, "not valid UTF-8");
    const mime = TEXT_MIME[ext] as string;
    if (bytes.length > CONTEXT_FILE_CAPS.textBytes) return unsent("text", mime, null, "over 200 KB");
    return { kind: "text", mime, pages: null, sent: true, unsentReason: null };
  }
  const imageMime = sniffImageMime(bytes);
  if (imageMime !== null) {
    if (bytes.length > CONTEXT_FILE_CAPS.imageBytes) return unsent("image", imageMime, null, "over 5 MB");
    const size = sniffImageSize(bytes);
    if (size !== null && Math.max(size.width, size.height) > CONTEXT_FILE_CAPS.imagePx) {
      return unsent("image", imageMime, null, "over 8000 px");
    }
    return { kind: "image", mime: imageMime, pages: null, sent: true, unsentReason: null };
  }
  if (startsWith(bytes, ascii("%PDF-"))) {
    if (bytes.length > CONTEXT_FILE_CAPS.pdfBytes) return unsent("pdf", "application/pdf", null, "over 32 MB");
    const pages = countPdfPages(bytes);
    if (pages > CONTEXT_FILE_CAPS.pdfPages) return unsent("pdf", "application/pdf", pages, "over 100 pages");
    return { kind: "pdf", mime: "application/pdf", pages, sent: true, unsentReason: null };
  }
  return unsent("other", OTHER_MIME, null, "unsupported type");
}

/**
 * A file larger than every cap is never sent, so it is classified from its extension alone without reading it.
 */
export function classifyOversizedContextFile(name: string): Classified {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext)) return unsent("text", TEXT_MIME[ext] as string, null, "over 200 KB");
  if (IMAGE_EXTENSIONS.has(ext)) return unsent("image", IMAGE_MIME[ext] as string, null, "over 5 MB");
  if (ext === "pdf") return unsent("pdf", "application/pdf", null, "over 32 MB");
  return unsent("other", OTHER_MIME, null, "unsupported type");
}

export function hasQuotedParagraphs(markdown: string): boolean {
  return markdown.split(/\r?\n/u).some((line) => line.trim().startsWith(">"));
}

export function resolveScript(
  files: readonly ContextFile[],
  choice: ScriptChoice,
  textOf: (file: ContextFile) => string,
): ContextFile | null {
  if (choice.mode === "none") return null;
  // A file over its cap is never sent, so it cannot come back as script blocks either.
  const candidates = files.filter((f) => f.kind === "text" && f.sent);
  if (choice.mode === "label") return candidates.find((f) => f.label === choice.label) ?? null;
  return candidates.find((f) => hasQuotedParagraphs(textOf(f))) ?? null;
}

export function contextFilePath(sessionId: string, label: string, name: string): string {
  return `sidecars/context/${sessionId}/${label}-${name}`;
}

export function sentBytesTotal(files: readonly ContextFile[]): number {
  return files.reduce((sum, f) => (f.sent ? sum + f.bytes : sum), 0);
}

export function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  if (bytes < 1_048_576) return `${Math.round(kb)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
