import type { Asset } from "../../core/src/index.js";

export type ProxyTier = "edit";

export type ProxyProfileKind =
  | "opaque-video"
  | "alpha-video"
  | "audio"
  | "opaque-image"
  | "alpha-image";

export interface ProxyProfile {
  extension: "mp4" | "webm" | "m4a" | "jpg" | "png";
  kind: ProxyProfileKind;
  estimatedBitrateKbps?: number;
  tier: ProxyTier;
}

const VIDEO_SCALE =
  "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
const IMAGE_SCALE =
  "scale=w='min(2048,iw)':h='min(2048,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

function roundedFps(fps: string): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) {
    throw new TypeError(`Invalid asset frame rate ${fps}.`);
  }
  return Math.max(1, Math.round(Number(match[1]) / Number(match[2])));
}

export function proxyProfile(
  asset: Asset,
  tier: ProxyTier,
): ProxyProfile | undefined {
  if (asset.video !== undefined) {
    return asset.video.hasAlpha
      ? { extension: "webm", kind: "alpha-video", estimatedBitrateKbps: 2_500, tier }
      : { extension: "mp4", kind: "opaque-video", estimatedBitrateKbps: 2_500, tier };
  }
  if (asset.image !== undefined) {
    if (Math.max(asset.image.width, asset.image.height) <= 2_048) return undefined;
    return asset.image.hasAlpha
      ? { extension: "png", kind: "alpha-image", tier }
      : { extension: "jpg", kind: "opaque-image", tier };
  }
  if ((asset.audio?.length ?? 0) > 0) {
    return { extension: "m4a", kind: "audio", estimatedBitrateKbps: 128, tier };
  }
  return undefined;
}

function commandPrefix(asset: Asset): string[] {
  return ["-y", "-nostdin", "-i", asset.path];
}

function opaqueVideoCommand(asset: Asset, target: string): string[] {
  if (asset.video === undefined) throw new TypeError("Video proxy requires video metadata.");
  return [
    ...commandPrefix(asset),
    "-map", "0:v:0",
    "-map", "0:a?",
    "-vf", VIDEO_SCALE,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-g", String(roundedFps(asset.video.fps)),
    "-sc_threshold", "0",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    "-f", "mp4",
    target,
  ];
}

function alphaVideoCommand(asset: Asset, target: string): string[] {
  return [
    ...commandPrefix(asset),
    "-map", "0:v:0",
    "-map", "0:a?",
    "-vf", VIDEO_SCALE,
    "-c:v", "libvpx-vp9",
    "-crf", "32",
    "-b:v", "0",
    "-pix_fmt", "yuva420p",
    "-row-mt", "1",
    "-c:a", "libopus",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-f", "webm",
    target,
  ];
}

function audioCommand(asset: Asset, target: string): string[] {
  return [
    ...commandPrefix(asset),
    "-map", "0:a:0",
    "-vn",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    "-f", "mp4",
    target,
  ];
}

function imageCommand(asset: Asset, target: string, alpha: boolean): string[] {
  return [
    ...commandPrefix(asset),
    "-map", "0:v:0",
    "-frames:v", "1",
    "-vf", IMAGE_SCALE,
    ...(alpha ? ["-c:v", "png"] : ["-c:v", "mjpeg", "-q:v", "2"]),
    "-an",
    "-f", "image2",
    target,
  ];
}

/** Compile the sole FR-003 proxy tier. Small images intentionally return no command. */
export function proxyCommand(
  asset: Asset,
  tier: ProxyTier,
  target: string,
): string[] | undefined {
  const profile = proxyProfile(asset, tier);
  if (profile === undefined) return undefined;
  if (profile.kind === "opaque-video") return opaqueVideoCommand(asset, target);
  if (profile.kind === "alpha-video") return alphaVideoCommand(asset, target);
  if (profile.kind === "audio") return audioCommand(asset, target);
  return imageCommand(asset, target, profile.kind === "alpha-image");
}

export function peaksDecodeCommand(asset: Asset, target = "pipe:1"): string[] {
  return [
    "-nostdin",
    "-i", asset.path,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "48000",
    "-c:a", "pcm_s16le",
    "-f", "s16le",
    target,
  ];
}
