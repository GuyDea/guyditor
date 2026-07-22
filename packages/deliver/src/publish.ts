import type { PlatformProfile } from "./profile.js";

export interface PublishMetadata {
  format: "guyditor-publish/v1";
  deliverableId: string;
  profile: string;
  language: string;
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  cta?: string;
  status: "draft" | "approved" | "stale";
  draftedBy?: { agent: string; model: string; skillVersions: Record<string, string> };
  approvedRevision?: string;
}

export interface MetadataFieldError {
  code: "E_METADATA_LIMIT_EXCEEDED";
  field: "title" | "description" | "tags.count" | "tags.totalChars" | "hashtags";
  actual: number;
  max: number;
  affected: string[];
  retry: "none";
  suggestion: string;
}

export interface Chapter {
  beatId: string;
  title: string;
  startSeconds: number;
}

export interface ChapterList {
  format: "guyditor-chapters/v1";
  deliverableId: string;
  derivedAtRevision: string;
  status: "draft" | "approved" | "stale";
  chapters: Chapter[];
  textSha256?: string;
  approvedRevision?: string;
  warnings?: string[];
  stale?: {
    transactionId: string;
    revision: string;
    detectedAt: string;
    warning: string;
  };
}

export interface ChapterGenerationError {
  code: "E_CHAPTER_COUNT";
  actual: number;
  minimum: number;
  message: string;
}

export interface ChapterGenerationResult {
  list: ChapterList;
  text: string;
  warnings: string[];
  errors: ChapterGenerationError[];
}

export interface PublishTranscriptWord {
  id: string;
  assetId: string;
  text: string;
  punctAfter: string;
  startSamples: number;
  endSamples: number;
  rate: number;
  state: "active" | "deleted";
  speaker?: string;
}

function codePoints(value: string): number {
  return [...value].length;
}

function normalizedHashtag(value: string): string {
  return value.startsWith("#") ? value : `#${value}`;
}

function hashtagValues(metadata: PublishMetadata, profile: Pick<PlatformProfile, "metadata">): string[] {
  const declared = metadata.hashtags.map(normalizedHashtag);
  if (profile.metadata.hashtags?.countedIn !== "description") return declared;
  const inDescription = metadata.description.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set([...declared, ...inDescription].map((tag) => tag.toLocaleLowerCase("en-US")))];
}

function limitError(
  metadata: PublishMetadata,
  field: MetadataFieldError["field"],
  actual: number,
  max: number,
): MetadataFieldError {
  return {
    code: "E_METADATA_LIMIT_EXCEEDED",
    field,
    actual,
    max,
    affected: [metadata.deliverableId],
    retry: "none",
    suggestion: `${field}: ${String(actual)}/${String(max)}`,
  };
}

export function validateMetadata(
  metadata: PublishMetadata,
  profile: Pick<PlatformProfile, "metadata">,
): MetadataFieldError[] {
  const errors: MetadataFieldError[] = [];
  const titleMax = profile.metadata.title?.maxChars;
  const titleLength = codePoints(metadata.title);
  if (titleMax !== undefined && titleLength > titleMax) {
    errors.push(limitError(metadata, "title", titleLength, titleMax));
  }
  const descriptionLength = codePoints(metadata.description);
  if (descriptionLength > profile.metadata.description.maxChars) {
    errors.push(limitError(metadata, "description", descriptionLength, profile.metadata.description.maxChars));
  }
  const tagRules = profile.metadata.tags;
  if (tagRules !== null) {
    if (metadata.tags.length > tagRules.maxCount) {
      errors.push(limitError(metadata, "tags.count", metadata.tags.length, tagRules.maxCount));
    }
    const totalChars = metadata.tags.reduce((total, tag) => total + codePoints(tag), 0);
    if (totalChars > tagRules.totalMaxChars) {
      errors.push(limitError(metadata, "tags.totalChars", totalChars, tagRules.totalMaxChars));
    }
  }
  const hashtagRules = profile.metadata.hashtags;
  if (hashtagRules !== null) {
    const total = hashtagValues(metadata, profile).length;
    if (total > hashtagRules.maxCount) {
      errors.push(limitError(metadata, "hashtags", total, hashtagRules.maxCount));
    }
  }
  return errors;
}

function sentence(value: string): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) return "";
  const match = /^.*?[.!?](?:\s|$)/u.exec(trimmed);
  return (match?.[0] ?? trimmed).trim();
}

export interface DraftPublishMetadataInput {
  deliverableId: string;
  profile: string;
  language: string;
  transcript: string;
  beats: readonly string[];
  brandVoice?: { id: string; version: string };
}

function titleFrom(input: DraftPublishMetadataInput): string {
  const beat = input.beats.find((value) => value.trim().length > 0)?.trim();
  if (beat !== undefined) return beat;
  const words = sentence(input.transcript).split(/\s+/u).slice(0, 10).join(" ");
  return words.length === 0 ? "Untitled deliverable" : words;
}

const TAG_STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "for", "from", "into", "that",
  "the", "this", "with", "your",
]);

function tagsFrom(input: DraftPublishMetadataInput): string[] {
  const counts = new Map<string, number>();
  for (const token of `${input.beats.join(" ")} ${input.transcript}`
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length < 3 || TAG_STOP_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left.localeCompare(right))
    .slice(0, 8)
    .map(([tag]) => tag);
}

export function draftPublishMetadata(input: DraftPublishMetadataInput): PublishMetadata {
  const tags = tagsFrom(input);
  return {
    format: "guyditor-publish/v1",
    deliverableId: input.deliverableId,
    profile: input.profile,
    language: input.language,
    title: titleFrom(input),
    description: sentence(input.transcript),
    tags,
    hashtags: tags.slice(0, 3).map((tag) => `#${tag.replace(/[^\p{L}\p{N}_]/gu, "")}`),
    cta: "Watch, share, and follow for the next edit.",
    status: "draft",
    draftedBy: {
      agent: "guyditor-template",
      model: "deterministic-local-v1",
      skillVersions: input.brandVoice === undefined
        ? {}
        : { [input.brandVoice.id]: input.brandVoice.version },
    },
  };
}

function timestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remaining = seconds % 60;
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes)}:${String(remaining).padStart(2, "0")}`;
}

export function chaptersTextBlock(chapters: readonly Chapter[]): string {
  return chapters.map((chapter) => `${timestamp(chapter.startSeconds)} ${chapter.title}`).join("\n") +
    (chapters.length === 0 ? "" : "\n");
}

export interface GenerateChapterListInput {
  deliverableId: string;
  revision: string;
  beats: readonly Chapter[];
  rules: NonNullable<PlatformProfile["chapters"]>;
}

export function generateChapterList(input: GenerateChapterListInput): ChapterGenerationResult {
  const sorted = input.beats
    .map((beat) => ({ ...beat, startSeconds: Math.max(0, Math.floor(beat.startSeconds)) }))
    .sort((left, right) => left.startSeconds - right.startSeconds || left.beatId.localeCompare(right.beatId));
  if (input.rules.firstMustBeZero && sorted[0]?.startSeconds !== 0) {
    sorted.unshift({ beatId: "beat_2222222222", title: "Intro", startSeconds: 0 });
  }
  const chapters: Chapter[] = [];
  const warnings: string[] = [];
  for (const chapter of sorted) {
    const previous = chapters.at(-1);
    if (previous !== undefined && chapter.startSeconds - previous.startSeconds < input.rules.minChapterSeconds) {
      warnings.push(
        `Merged chapter ‘${chapter.title}’ into ‘${previous.title}’ because it was shorter than ${String(input.rules.minChapterSeconds)} seconds.`,
      );
      continue;
    }
    chapters.push(chapter);
  }
  const list: ChapterList = {
    format: "guyditor-chapters/v1",
    deliverableId: input.deliverableId,
    derivedAtRevision: input.revision,
    status: "draft",
    chapters,
  };
  const errors: ChapterGenerationError[] = chapters.length < input.rules.minCount
    ? [{
        code: "E_CHAPTER_COUNT",
        actual: chapters.length,
        minimum: input.rules.minCount,
        message: `${String(chapters.length)} chapters generated; profile requires at least ${String(input.rules.minCount)}.`,
      }]
    : [];
  return { list, text: chaptersTextBlock(chapters), warnings, errors };
}

export function metadataTextBlock(metadata: PublishMetadata): string {
  const hashtags = metadata.hashtags.map(normalizedHashtag).join(" ");
  const cta = metadata.cta === undefined || metadata.cta.length === 0 ? "" : `${metadata.cta}\n\n`;
  return `${metadata.title}\n\n${metadata.description}\n\n${cta}` +
    `Tags: ${metadata.tags.join(", ")}\nHashtags: ${hashtags}\n`;
}

function ordinal(wordId: string): number {
  const match = /^w(\d{6})$/u.exec(wordId);
  if (match === null) throw new TypeError(`Invalid word ID ${wordId}.`);
  return Number(match[1]);
}

export function extractTranscriptText(input: {
  clips: readonly { assetId: string; startWordId: string; endWordId: string }[];
  beatWordIds: readonly string[];
  words: readonly PublishTranscriptWord[];
}): string {
  const beatStarts = new Set(input.beatWordIds);
  const ordered = input.clips.flatMap((clip) => {
    const start = ordinal(clip.startWordId);
    const end = ordinal(clip.endWordId);
    return input.words.filter((word) =>
      word.state === "active" && word.assetId === clip.assetId &&
      ordinal(word.id) >= start && ordinal(word.id) <= end)
      .sort((left, right) => ordinal(left.id) - ordinal(right.id));
  });
  const multiSpeaker = new Set(ordered.flatMap(({ speaker }) => speaker === undefined ? [] : [speaker])).size > 1;
  const paragraphs: PublishTranscriptWord[][] = [];
  for (const word of ordered) {
    const current = paragraphs.at(-1);
    const previous = current?.at(-1);
    const pauseSeconds = previous === undefined || previous.rate !== word.rate
      ? 0
      : (word.startSamples - previous.endSamples) / word.rate;
    if (
      current === undefined || beatStarts.has(word.id) || pauseSeconds > 1.5 ||
      multiSpeaker && previous?.speaker !== word.speaker
    ) paragraphs.push([word]);
    else current.push(word);
  }
  const text = paragraphs.map((paragraph) => {
    const first = paragraph[0]!;
    const speaker = multiSpeaker && first.speaker !== undefined ? `${first.speaker}: ` : "";
    return `${speaker}${paragraph.map((word) => `${word.text}${word.punctAfter}`).join(" ")}`;
  }).join("\n\n");
  return text.length === 0 ? "" : `${text}\n`;
}

export function selectCoverFrames(input: {
  fps: number;
  durationFrames: number;
  hookFrame: number;
  beatFrames: readonly number[];
  scoredFrames: readonly { frame: number; faceArea: number; sharpness: number }[];
  limit?: number;
}): number[] {
  if (!Number.isFinite(input.fps) || input.fps <= 0) throw new RangeError("Cover fps must be positive.");
  const limit = input.limit ?? 6;
  const ranked = input.scoredFrames.slice().sort((left, right) =>
    right.faceArea * right.sharpness - left.faceArea * left.sharpness || left.frame - right.frame);
  const candidates = [input.hookFrame, ...input.beatFrames, ...ranked.map(({ frame }) => frame)];
  const selected: number[] = [];
  for (const frame of candidates) {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= input.durationFrames) continue;
    if (selected.some((candidate) => Math.abs(candidate - frame) < input.fps)) continue;
    selected.push(frame);
    if (selected.length === limit) break;
  }
  return selected;
}
