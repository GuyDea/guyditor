import { describe, expect, it } from "vitest";
import {
  classifyContextFile,
  classifyOversizedContextFile,
  contextFilePath,
  formatBytes,
  resolveScript,
  sentBytesTotal,
  sniffImageSize,
} from "./context-files.js";
import type { ContextFile } from "./types.js";

const enc = (s: string): number[] => [...new TextEncoder().encode(s)];

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...enc("IHDR")]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, APP0 (len 16), SOF0
  const b = new Uint8Array(2 + 18 + 19);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...enc("JFIF")]);
  const sof = 20;
  b.set([0xff, 0xc0, 0, 17, 8], sof);
  const v = new DataView(b.buffer);
  v.setUint16(sof + 5, height);
  v.setUint16(sof + 7, width);
  return b;
}

function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set(enc("GIF89a"));
  const v = new DataView(b.buffer);
  v.setUint16(6, width, true);
  v.setUint16(8, height, true);
  return b;
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([...enc("RIFF"), 32, 0, 0, 0, ...enc("WEBP"), ...enc(chunk)]);
  const v = new DataView(b.buffer);
  if (chunk === "VP8 ") {
    b.set([0x9d, 0x01, 0x2a], 23);
    v.setUint16(26, width, true);
    v.setUint16(28, height, true);
  } else if (chunk === "VP8L") {
    b[20] = 0x2f;
    v.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    b[24] = (width - 1) & 0xff;
    b[25] = ((width - 1) >> 8) & 0xff;
    b[26] = ((width - 1) >> 16) & 0xff;
    b[27] = (height - 1) & 0xff;
    b[28] = ((height - 1) >> 8) & 0xff;
    b[29] = ((height - 1) >> 16) & 0xff;
  }
  return b;
}

function pdf(pages: number): Uint8Array {
  let s = "%PDF-1.4\n1 0 obj << /Type /Pages /Count " + pages + " >> endobj\n";
  for (let i = 0; i < pages; i++) s += `${i + 2} 0 obj << /Type /Page >> endobj\n`;
  return new TextEncoder().encode(s);
}

function file(label: string, name: string, kind: ContextFile["kind"]): ContextFile {
  return {
    label,
    name,
    path: `p/${label}`,
    sha256: "x",
    bytes: 10,
    mime: "x",
    kind,
    sent: true,
    unsentReason: null,
    pages: null,
    role: "context",
  };
}

describe("classifyContextFile", () => {
  it("classifies by extension, magic bytes and UTF-8", () => {
    expect(classifyContextFile("outline.md", new TextEncoder().encode("# hi"))).toEqual({
      kind: "text",
      mime: "text/markdown",
      sent: true,
      unsentReason: null,
      pages: null,
    });
    const p = classifyContextFile("s.png", png(10, 10));
    expect(p).toMatchObject({ kind: "image", mime: "image/png", sent: true });
    const d = classifyContextFile("d.pdf", pdf(3));
    expect(d).toMatchObject({ kind: "pdf", mime: "application/pdf", pages: 3, sent: true });
    const x = classifyContextFile("b.xlsx", new Uint8Array([1, 2, 3]));
    expect(x).toMatchObject({ kind: "other", sent: false, unsentReason: "unsupported type" });
  });

  it("a text extension that is not UTF-8 is other, not garbage", () => {
    const c = classifyContextFile("notes.txt", new Uint8Array([0xe9, 0x20, 0x61]));
    expect(c.kind).toBe("other");
    expect(c.unsentReason).toBe("not valid UTF-8");
    expect(c.sent).toBe(false);
  });

  it("trusts magic bytes over the extension", () => {
    expect(classifyContextFile("x.png", jpeg(5, 5))).toMatchObject({ kind: "image", mime: "image/jpeg" });
    expect(classifyContextFile("y.png", new Uint8Array([1, 2, 3, 4])).kind).toBe("other");
  });

  it("caps mark files as not sent with the reason", () => {
    const big = new Uint8Array(204_801).fill(0x61);
    expect(classifyContextFile("big.txt", big)).toMatchObject({ kind: "text", sent: false, unsentReason: "over 200 KB" });
    expect(classifyContextFile("w.png", png(8001, 10))).toMatchObject({
      kind: "image",
      sent: false,
      unsentReason: "over 8000 px",
    });
    expect(classifyContextFile("many.pdf", pdf(101))).toMatchObject({
      kind: "pdf",
      pages: 101,
      sent: false,
      unsentReason: "over 100 pages",
    });
  });
});

describe("classifyOversizedContextFile", () => {
  it("classifies by extension alone with each kind's byte cap as the reason", () => {
    expect(classifyOversizedContextFile("notes.MD")).toEqual({
      kind: "text", mime: "text/markdown", pages: null, sent: false, unsentReason: "over 200 KB",
    });
    expect(classifyOversizedContextFile("still.jpg")).toMatchObject({ kind: "image", mime: "image/jpeg", unsentReason: "over 5 MB" });
    expect(classifyOversizedContextFile("deck.pdf")).toMatchObject({ kind: "pdf", mime: "application/pdf", unsentReason: "over 32 MB" });
    expect(classifyOversizedContextFile("IMG_0001.mov")).toEqual({
      kind: "other", mime: "application/octet-stream", pages: null, sent: false, unsentReason: "unsupported type",
    });
  });
});

describe("sniffImageSize", () => {
  it("reads image dimensions from PNG, JPEG, GIF and WebP headers", () => {
    expect(sniffImageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(sniffImageSize(jpeg(300, 200))).toEqual({ width: 300, height: 200 });
    expect(sniffImageSize(gif(120, 90))).toEqual({ width: 120, height: 90 });
    expect(sniffImageSize(webp("VP8 ", 321, 123))).toEqual({ width: 321, height: 123 });
    expect(sniffImageSize(webp("VP8L", 400, 300))).toEqual({ width: 400, height: 300 });
    expect(sniffImageSize(webp("VP8X", 1000, 2000))).toEqual({ width: 1000, height: 2000 });
    expect(sniffImageSize(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]))).toBeNull();
  });
});

describe("resolveScript", () => {
  it("picks the first quoted markdown in auto and honours label and none", () => {
    const F1 = file("F1", "notes.txt", "text");
    const F2 = file("F2", "script.md", "text");
    const F3 = file("F3", "outline.md", "text");
    const F4 = file("F4", "pic.png", "image");
    const texts: Record<string, string> = { F1: "plain words", F2: "# H\n> quoted", F3: "  > also quoted" };
    const textOf = (f: ContextFile): string => texts[f.label] ?? "";
    const all = [F1, F2, F3, F4];
    expect(resolveScript(all, { mode: "auto" }, textOf)).toBe(F2);
    expect(resolveScript(all, { mode: "label", label: "F3" }, textOf)).toBe(F3);
    expect(resolveScript(all, { mode: "label", label: "F4" }, textOf)).toBeNull();
    expect(resolveScript(all, { mode: "none" }, textOf)).toBeNull();
  });

  it("never picks a file that is not sent", () => {
    const big = { ...file("F1", "big.md", "text"), sent: false, unsentReason: "over 200 KB" };
    const F2 = file("F2", "script.md", "text");
    const textOf = (): string => "> quoted";
    expect(resolveScript([big, F2], { mode: "label", label: "F1" }, textOf)).toBeNull();
    expect(resolveScript([big, F2], { mode: "auto" }, textOf)).toBe(F2);
  });
});

describe("paths, totals and sizes", () => {
  it("formats paths, sums sent bytes and humanises sizes", () => {
    expect(contextFilePath("asb_aaaaaaaaaa", "F2", "a b.png")).toBe("sidecars/context/asb_aaaaaaaaaa/F2-a b.png");
    const a = { ...file("F1", "a", "text"), bytes: 100 };
    const b = { ...file("F2", "b", "text"), bytes: 50, sent: false };
    expect(sentBytesTotal([a, b])).toBe(100);
    expect(formatBytes(1229)).toBe("1.2 KB");
    expect(formatBytes(40_960)).toBe("40 KB");
    expect(formatBytes(1_153_434)).toBe("1.1 MB");
  });
});
