import type { CaptionStyle, CaptionTrack } from "../../../core/src/index.js";
import type {
  TranscriptSegment,
  TranscriptSidecar,
  TranscriptWord,
} from "../types.js";
import {
  add,
  ceilFrames,
  compare,
  floorFrames,
  maximum,
  milliseconds,
  minimum,
  rational,
  subtract,
} from "./rational.js";
import type {
  CaptionCue,
  CaptionCueLine,
  CaptionCueWord,
  CaptionFrameSpec,
  CaptionRenderModel,
  CompileCaptionTrackOptions,
  NormRect,
  RationalSec,
  WordInstance,
} from "./types.js";

interface WordMetadata {
  word: TranscriptWord;
  segment: TranscriptSegment;
  speakerLabel: string;
  segmentFinal: boolean;
}

interface MeasuredWord {
  instance: WordInstance;
  metadata: WordMetadata;
  displayText: string;
  width: number;
  overflow: boolean;
}

interface RawCue {
  words: MeasuredWord[];
  lines: MeasuredWord[][];
}

const ZERO = rational(0, 1);

function metadataByWord(sidecars: readonly TranscriptSidecar[]): Map<string, WordMetadata> {
  const result = new Map<string, WordMetadata>();
  for (const sidecar of sidecars) {
    const speakers = new Map(sidecar.speakers.map(({ id, label }) => [id, label] as const));
    for (const segment of sidecar.segments) {
      const active = segment.words.filter((wordId) => sidecar.words[wordId]?.state === "active");
      for (const [index, wordId] of active.entries()) {
        const word = sidecar.words[wordId];
        if (word === undefined) continue;
        if (result.has(wordId)) throw new TypeError(`Caption word ${wordId} exists in multiple sidecars.`);
        result.set(wordId, {
          word,
          segment,
          speakerLabel: speakers.get(segment.speaker) ?? segment.speaker,
          segmentFinal: index === active.length - 1,
        });
      }
    }
  }
  return result;
}

function transformWord(text: string, transform: CaptionStyle["transform"]): string {
  switch (transform) {
    case "none": return text;
    case "upper": return text.toLocaleUpperCase("und");
    case "lower": return text.toLocaleLowerCase("und");
    case "title": return text.replace(/\p{L}[\p{L}\p{M}]*/gu, (word) =>
      `${word.slice(0, 1).toLocaleUpperCase("und")}${word.slice(1).toLocaleLowerCase("und")}`);
  }
}

function defaultMeasure(text: string, fontPx: number, style: CaptionStyle): number {
  const glyphUnits = [...text].reduce((sum, character) =>
    sum + (/\s/u.test(character) ? 0.34 : /[ilI1.,'`]/u.test(character) ? 0.32 : /[MW@#]/u.test(character) ? 0.86 : 0.58), 0);
  const spacing = Math.max(0, [...text].length - 1) * style.letterSpacingPct / 100;
  return (glyphUnits + spacing) * fontPx;
}

function breakMap(track: CaptionTrack): Map<string, "line" | "cue" | "join"> {
  return new Map(track.breakOverrides.map(({ afterWordId, kind }) => [afterWordId, kind]));
}

function measuredWords(options: CompileCaptionTrackOptions): MeasuredWord[] {
  const metadata = metadataByWord(options.sidecars);
  const fontPx = options.style.sizePct / 100 * options.output.height;
  const measure = options.measureText ?? defaultMeasure;
  const availableWidth = options.safeArea.w * options.output.width * options.style.maxWidthPct / 100;
  return options.timeline.instances.flatMap((instance) => {
    const details = metadata.get(instance.wordId);
    if (details === undefined) return [];
    const displayText = transformWord(
      `${details.word.punctBefore}${details.word.text}${details.word.punctAfter}`,
      options.style.transform,
    );
    const width = measure(displayText, fontPx, options.style);
    return [{ instance, metadata: details, displayText, width, overflow: width > availableWidth }];
  });
}

function lineWidth(
  words: readonly MeasuredWord[],
  spaceWidth: number,
): number {
  return words.reduce((sum, word, index) => sum + word.width + (index === 0 ? 0 : spaceWidth), 0);
}

function layout(
  words: readonly MeasuredWord[],
  options: CompileCaptionTrackOptions,
): MeasuredWord[][] {
  if (words.length === 0) return [];
  const fontPx = options.style.sizePct / 100 * options.output.height;
  const measure = options.measureText ?? defaultMeasure;
  const availableWidth = options.safeArea.w * options.output.width * options.style.maxWidthPct / 100;
  const spaceWidth = measure(" ", fontPx, options.style);
  const lines: MeasuredWord[][] = [];
  let current: MeasuredWord[] = [];
  for (const word of words) {
    const candidate = [...current, word];
    if (
      current.length > 0 &&
      (current.length >= options.style.wordsPerLine || lineWidth(candidate, spaceWidth) > availableWidth)
    ) {
      lines.push(current);
      current = [word];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);

  for (let index = lines.length - 1; index > 0; index -= 1) {
    const last = lines[index]!;
    const previous = lines[index - 1]!;
    if (last.length === 1 && previous.length >= 3) {
      const moved = previous.at(-1)!;
      const candidate = [moved, ...last];
      if (lineWidth(candidate, spaceWidth) <= availableWidth) {
        previous.pop();
        lines[index] = candidate;
      }
    }
  }

  const existingBreaks = new Set(lines.slice(0, -1).map((line) => line.at(-1)!.instance.wordId));
  for (const override of options.track.breakOverrides) {
    if (override.kind === "line") existingBreaks.add(override.afterWordId);
  }
  const forced: MeasuredWord[][] = [];
  current = [];
  for (const word of words) {
    current.push(word);
    if (existingBreaks.has(word.instance.wordId)) {
      forced.push(current);
      current = [];
    }
  }
  if (current.length > 0) forced.push(current);
  return forced;
}

function gapExceeds(left: MeasuredWord, right: MeasuredWord, millisecondsLimit: number): boolean {
  return compare(subtract(right.instance.start, left.instance.end), milliseconds(millisecondsLimit)) > 0;
}

function sentenceFinal(word: MeasuredWord): boolean {
  return word.metadata.segmentFinal && /[.!?](?:["'”’)]*)$/u.test(word.metadata.word.punctAfter);
}

function segmentCues(words: readonly MeasuredWord[], options: CompileCaptionTrackOptions): RawCue[] {
  const overrides = breakMap(options.track);
  const cues: RawCue[] = [];
  let current: MeasuredWord[] = [];
  for (const word of words) {
    const previous = current.at(-1);
    let startCue = previous === undefined;
    if (previous !== undefined) {
      const boundary = overrides.get(previous.instance.wordId);
      const joined = boundary === "join";
      startCue = boundary === "cue" ||
        previous.metadata.segment.speaker !== word.metadata.segment.speaker ||
        (!joined && sentenceFinal(previous)) ||
        (!joined && gapExceeds(previous, word, options.style.cueGapMs)) ||
        compare(
          subtract(word.instance.end, current[0]!.instance.start),
          milliseconds(options.style.maxCueDurationMs),
        ) > 0 ||
        layout([...current, word], options).length > options.style.maxLines;
    }
    if (startCue && current.length > 0) {
      cues.push({ words: current, lines: layout(current, options) });
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) cues.push({ words: current, lines: layout(current, options) });
  return cues;
}

function cueTimes(raw: readonly RawCue[], options: CompileCaptionTrackOptions): Array<{
  start: RationalSec;
  end: RationalSec;
}> {
  const offsets = new Map(options.track.timingOffsets.map((offset) => [offset.firstWordId, offset]));
  const nominal = raw.map(({ words }) => ({
    start: maximum(
      words[0]!.instance.clipStart ?? ZERO,
      subtract(words[0]!.instance.start, milliseconds(options.style.highlight.leadInMs)),
    ),
    end: add(words.at(-1)!.instance.end, milliseconds(options.style.highlight.holdMs)),
  }));
  const result: Array<{ start: RationalSec; end: RationalSec }> = [];
  for (const [index, cue] of raw.entries()) {
    const offset = offsets.get(cue.words[0]!.instance.wordId);
    let start = add(nominal[index]!.start, milliseconds(offset?.startMs ?? 0));
    let end = add(nominal[index]!.end, milliseconds(offset?.endMs ?? 0));
    start = maximum(start, result.at(-1)?.end ?? ZERO);
    const nextStart = nominal[index + 1]?.start;
    if (nextStart !== undefined) end = minimum(end, maximum(start, nextStart));
    if (compare(end, start) < 0) end = start;
    result.push({ start, end });
  }
  return result;
}

function horizontalStart(
  width: number,
  safeArea: NormRect,
  align: CaptionStyle["placement"]["align"],
): number {
  if (align === "left") return safeArea.x;
  if (align === "right") return safeArea.x + safeArea.w - width;
  return safeArea.x + (safeArea.w - width) / 2;
}

function verticalStart(
  height: number,
  safeArea: NormRect,
  style: CaptionStyle,
): number {
  const offset = style.placement.offsetYPct / 100 * safeArea.h;
  if (style.placement.anchor === "top") return safeArea.y + offset;
  if (style.placement.anchor === "middle") return safeArea.y + (safeArea.h - height) / 2 + offset;
  return safeArea.y + safeArea.h - height + offset;
}

function geometry(
  lines: readonly MeasuredWord[][],
  options: CompileCaptionTrackOptions,
): { box: NormRect; lines: Array<{ box: NormRect; words: Array<{ box: NormRect }> }> } {
  const fontPx = options.style.sizePct / 100 * options.output.height;
  const measure = options.measureText ?? defaultMeasure;
  const space = measure(" ", fontPx, options.style) / options.output.width;
  const lineHeight = fontPx * options.style.lineSpacing / options.output.height;
  const widths = lines.map((line) =>
    line.reduce((sum, word, index) => sum + word.width / options.output.width + (index === 0 ? 0 : space), 0));
  const boxWidth = Math.max(0, ...widths);
  const boxHeight = lineHeight * lines.length;
  const boxX = horizontalStart(boxWidth, options.safeArea, options.style.placement.align);
  const boxY = verticalStart(boxHeight, options.safeArea, options.style);
  return {
    box: { x: boxX, y: boxY, w: boxWidth, h: boxHeight },
    lines: lines.map((line, lineIndex) => {
      const lineWidth = widths[lineIndex]!;
      const lineX = horizontalStart(lineWidth, options.safeArea, options.style.placement.align);
      let cursor = lineX;
      return {
        box: { x: lineX, y: boxY + lineIndex * lineHeight, w: lineWidth, h: lineHeight },
        words: line.map((word, wordIndex) => {
          const width = word.width / options.output.width;
          if (wordIndex > 0) cursor += space;
          const box = { x: cursor, y: boxY + lineIndex * lineHeight, w: width, h: lineHeight };
          cursor += width;
          return { box };
        }),
      };
    }),
  };
}

function cueWords(
  raw: RawCue,
  timing: { start: RationalSec; end: RationalSec },
  options: CompileCaptionTrackOptions,
): CaptionCue {
  const boxes = geometry(raw.lines, options);
  const positions = new Map<string, NormRect>();
  for (const [lineIndex, line] of raw.lines.entries()) {
    for (const [wordIndex, word] of line.entries()) {
      positions.set(word.instance.wordId, boxes.lines[lineIndex]!.words[wordIndex]!.box);
    }
  }
  const emphasized = new Set(options.track.emphasisOverrides
    .filter(({ emphasis }) => emphasis)
    .map(({ wordId }) => wordId));
  const highlighted = raw.words.map((word, index) => {
    const next = raw.words[index + 1];
    let end: RationalSec;
    if (next !== undefined) {
      const gap = maximum(ZERO, subtract(next.instance.start, word.instance.end));
      end = compare(gap, milliseconds(options.style.highlight.maxGapMs)) <= 0
        ? next.instance.start
        : add(word.instance.end, minimum(gap, milliseconds(options.style.highlight.holdMs)));
    } else {
      end = minimum(timing.end, add(word.instance.end, milliseconds(options.style.highlight.holdMs)));
    }
    return { word, start: word.instance.start, end: minimum(end, timing.end) };
  });
  const cueWordById = new Map<string, CaptionCueWord>();
  for (const [index, entry] of highlighted.entries()) {
    const nextStartFrame = highlighted[index + 1] === undefined
      ? undefined
      : floorFrames(highlighted[index + 1]!.start, options.output.fps);
    const naturalEnd = floorFrames(entry.end, options.output.fps);
    cueWordById.set(entry.word.instance.wordId, {
      wordId: entry.word.instance.wordId,
      displayText: entry.word.displayText,
      start: entry.word.instance.start,
      end: entry.word.instance.end,
      highlightStart: entry.start,
      highlightEnd: entry.end,
      startFrame: floorFrames(entry.start, options.output.fps),
      endFrame: nextStartFrame === undefined ? naturalEnd : Math.min(naturalEnd, nextStartFrame),
      emphasized: emphasized.has(entry.word.instance.wordId),
      box: positions.get(entry.word.instance.wordId)!,
    });
  }
  const lines: CaptionCueLine[] = raw.lines.map((line, index) => ({
    box: boxes.lines[index]!.box,
    words: line.map(({ instance }) => cueWordById.get(instance.wordId)!),
  }));
  const first = raw.words[0]!;
  return {
    firstWordId: first.instance.wordId,
    clipId: first.instance.clipId,
    speakerId: first.metadata.segment.speaker,
    speakerLabel: first.metadata.speakerLabel,
    start: timing.start,
    end: timing.end,
    startFrame: floorFrames(timing.start, options.output.fps),
    endFrame: ceilFrames(timing.end, options.output.fps),
    box: boxes.box,
    lines,
    overflow: raw.words.filter(({ overflow }) => overflow).map(({ instance }) => instance.wordId),
  };
}

function wordState(word: CaptionCueWord, frame: number): "past" | "current" | "future" {
  if (frame >= word.startFrame && frame < word.endFrame) return "current";
  return frame >= word.endFrame ? "past" : "future";
}

function frameCue(cue: CaptionCue, frame: number, style: CaptionStyle): CaptionFrameSpec["cues"][number] {
  return {
    firstWordId: cue.firstWordId,
    box: cue.box,
    lines: cue.lines.map((line) => {
      const states = line.words.map((word) => wordState(word, frame));
      const lineCurrent = style.highlight.mode === "per-line" && states.includes("current");
      return {
        box: line.box,
        words: line.words.map((word, index) => ({
          wordId: word.wordId,
          displayText: word.displayText,
          state: style.highlight.mode === "none" ? "future" : lineCurrent ? "current" : states[index]!,
          emphasized: word.emphasized,
          box: word.box,
        })),
      };
    }),
  };
}

function cueAtFrame(cues: readonly CaptionCue[], frame: number): CaptionCue | undefined {
  let low = 0;
  let high = cues.length - 1;
  let candidate: CaptionCue | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle]!;
    if (cue.startFrame <= frame) {
      candidate = cue;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate !== undefined && frame < candidate.endFrame ? candidate : undefined;
}

export function compileCaptionTrack(options: CompileCaptionTrackOptions): CaptionRenderModel {
  if (!options.track.enabled) {
    return {
      trackId: options.track.id,
      outputs: options.output,
      cues: [],
      diagnostics: options.timeline.diagnostics,
      styleResolved: options.style,
      captionsAtFrame: () => ({ cues: [], styleResolved: options.style }),
    };
  }
  const words = measuredWords(options);
  const raw = segmentCues(words, options);
  const times = cueTimes(raw, options);
  const cues = raw.map((cue, index) => cueWords(cue, times[index]!, options));
  return {
    trackId: options.track.id,
    outputs: options.output,
    cues,
    diagnostics: options.timeline.diagnostics,
    styleResolved: options.style,
    captionsAtFrame(frame: number): CaptionFrameSpec {
      if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Caption frame must be a non-negative safe integer.");
      const cue = cueAtFrame(cues, frame);
      return {
        cues: cue === undefined ? [] : [frameCue(cue, frame, options.style)],
        styleResolved: options.style,
      };
    },
  };
}
