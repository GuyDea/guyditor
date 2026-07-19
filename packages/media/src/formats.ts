import path from "node:path";

import type { Asset } from "../../core/src/project/model.js";
import type { ProbedAssetMedia } from "./probe.js";

export type FormatSupportTier = 1 | 2 | 3;

export const FORMAT_SUPPORT_TIERS = {
  containers: {
    tier1: ["mp4", "mov", "matroska", "webm", "wav", "mp3", "m4a", "flac"],
    tier2: ["mxf", "avi", "mpegts", "mts", "m2ts"],
  },
  videoCodecs: {
    tier1: ["h264", "hevc", "prores", "vp9"],
    tier2: ["av1", "dnxhd", "mjpeg"],
  },
  audioCodecs: {
    tier1: ["aac", "pcm", "opus", "mp3", "flac"],
    tier2: ["vorbis", "alac"],
  },
  images: {
    tier1: ["png", "jpg", "jpeg", "webp"],
    tier2: ["tif", "tiff", "heic", "bmp"],
  },
  animations: {
    tier1: ["gif", "webp", "prores", "vp9"],
    tier2: ["image-sequence"],
  },
  subtitles: {
    tier1: ["srt", "vtt"],
    tier2: [],
  },
} as const;

type ClassifiedKind = Exclude<Asset["kind"], "generated" | "other">;

function listedTier(
  value: string,
  list: { tier1: readonly string[]; tier2: readonly string[] },
): FormatSupportTier {
  if (list.tier1.includes(value)) return 1;
  if (list.tier2.includes(value)) return 2;
  return 3;
}

function codecTier(
  value: string,
  list: { tier1: readonly string[]; tier2: readonly string[] },
): FormatSupportTier {
  const normalized = value.toLowerCase();
  if (list.tier1.some((codec) =>
    codec === "pcm" ? normalized.startsWith("pcm_") : normalized === codec)) return 1;
  if (list.tier2.includes(normalized)) return 2;
  return 3;
}

function containerTier(container: string | undefined): FormatSupportTier {
  if (container === undefined) return 3;
  let best: FormatSupportTier = 3;
  for (const name of container.toLowerCase().split(",")) {
    const tier = listedTier(name, FORMAT_SUPPORT_TIERS.containers);
    if (tier < best) best = tier;
  }
  return best;
}

function maximumTier(tiers: readonly FormatSupportTier[]): FormatSupportTier {
  return tiers.reduce<FormatSupportTier>(
    (highest, tier) => tier > highest ? tier : highest,
    1,
  );
}

export function formatSupportTier(
  sourcePath: string,
  kind: ClassifiedKind,
  probed: ProbedAssetMedia,
): FormatSupportTier {
  const extension = path.extname(sourcePath).slice(1).toLowerCase();
  if (kind === "image") return listedTier(extension, FORMAT_SUPPORT_TIERS.images);
  if (kind === "subtitle") {
    return listedTier(extension, FORMAT_SUPPORT_TIERS.subtitles);
  }
  if (kind === "animation") {
    if (extension === "gif" || extension === "webp") return 1;
    const codec = probed.video?.codec;
    return codec === undefined
      ? 3
      : listedTier(codec, FORMAT_SUPPORT_TIERS.animations);
  }

  const tiers: FormatSupportTier[] = [containerTier(probed.container)];
  if (kind === "video") {
    tiers.push(probed.video === undefined
      ? 3
      : codecTier(probed.video.codec, FORMAT_SUPPORT_TIERS.videoCodecs));
  }
  for (const stream of probed.audio ?? []) {
    tiers.push(codecTier(stream.codec, FORMAT_SUPPORT_TIERS.audioCodecs));
  }
  return maximumTier(tiers);
}
