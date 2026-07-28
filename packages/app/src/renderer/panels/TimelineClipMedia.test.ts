import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TimelineClipMedia } from "./TimelineClipMedia.js";

it("isolates clip media layers from timeline-wide overlays", () => {
  const css = readFileSync(
    new URL("../styles.css", import.meta.url),
    "utf8",
  );
  const timelineClipRule = /\.timeline-clip\s*\{[^}]*\}/u.exec(css)?.[0];

  expect(timelineClipRule).toContain("isolation: isolate;");
});

it("renders filmstrip frames and an overlaid waveform together", () => {
  const html = renderToStaticMarkup(createElement(TimelineClipMedia, {
    clipId: "clp_aaaaaaaaaa",
    durationFrames: 184,
    media: {
      frameUrls: ["file:///one.jpg", "file:///two.jpg"],
      hasAudio: true,
      hasVideo: true,
      sourceFrames: [12, 36],
      waveform: [
        { minimum: -64, maximum: 32 },
        { minimum: -20, maximum: 80 },
      ],
    },
  }));

  expect(html.match(/<img/g)).toHaveLength(2);
  expect(html).toContain('data-testid="timeline-filmstrip-clp_aaaaaaaaaa"');
  expect(html).toContain('data-testid="timeline-waveform-clp_aaaaaaaaaa"');
  expect(html).toContain("<path");
  expect(html).toContain("184f");
});

it("renders an audio baseline without filmstrip frames when peaks are absent", () => {
  const html = renderToStaticMarkup(createElement(TimelineClipMedia, {
    clipId: "clp_bbbbbbbbbb",
    durationFrames: 72,
    media: {
      frameUrls: [],
      hasAudio: true,
      hasVideo: false,
      sourceFrames: [],
      waveform: [],
    },
  }));

  expect(html).not.toContain("<img");
  expect(html).toContain('data-state="baseline"');
  expect(html).toContain('data-testid="timeline-waveform-clp_bbbbbbbbbb"');
});

it("omits waveform markup for silent video", () => {
  const html = renderToStaticMarkup(createElement(TimelineClipMedia, {
    clipId: "clp_cccccccccc",
    durationFrames: 48,
    media: {
      frameUrls: ["file:///silent.jpg"],
      hasAudio: false,
      hasVideo: true,
      sourceFrames: [10],
      waveform: [],
    },
  }));
  expect(html).toContain("<img");
  expect(html).not.toContain("timeline-waveform");
});
