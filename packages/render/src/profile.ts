import { join } from "node:path";

import { loadPlatformProfile } from "../../deliver/src/index.js";

export interface RenderProfile {
  id: string;
  version: string;
  video: { codec: string; crf: number; pixelFormat: string };
  audio: { codec: string; bitrate: string };
  container: "mp4" | "mov" | "webm";
}

export interface LoadedRenderProfile {
  path: string;
  profile: RenderProfile;
  sha256: string;
}

function ffmpegVideoCodec(codec: string): string {
  if (codec === "h264") return "libx264";
  if (codec === "h265" || codec === "hevc") return "libx265";
  return codec;
}

/**
 * Render's encode adapter consumes the canonical Part 11 profile loader owned by
 * @guyditor/deliver and narrows it to the FFmpeg settings used by the graph.
 */
export async function loadRenderProfile(
  pin: string,
  profilesRoot: string | URL = join(process.cwd(), "profiles"),
  overrides?: Record<string, unknown>,
): Promise<LoadedRenderProfile> {
  const loaded = await loadPlatformProfile(pin, {
    builtinsRoot: profilesRoot,
    ...(overrides === undefined ? {} : { overrides }),
  });
  return {
    path: loaded.path,
    sha256: loaded.sha256,
    profile: {
      id: loaded.profile.id,
      version: loaded.profile.version,
      video: {
        codec: ffmpegVideoCodec(loaded.profile.video.codec),
        crf: loaded.profile.video.rateControl.crf,
        pixelFormat: loaded.profile.video.pixelFormat,
      },
      audio: {
        codec: loaded.profile.audio.codec,
        bitrate: `${String(loaded.profile.audio.bitrateKbps)}k`,
      },
      container: loaded.profile.video.container,
    },
  };
}
