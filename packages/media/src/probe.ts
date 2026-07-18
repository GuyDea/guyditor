import type { Asset } from "../../core/src/project/model.js";

import { FfmpegError } from "./errors.js";
import { runFfprobe } from "./run.js";

export type Rational = NonNullable<Asset["probe"]["fps"]>;
export type FrameTime = Extract<
  NonNullable<Asset["probe"]["duration"]>,
  { frames: number }
>;
export type SampleTime = Extract<
  NonNullable<Asset["probe"]["duration"]>,
  { samples: number }
>;
export type AssetProbeShape = Asset["probe"];
export type AssetVideoShape = NonNullable<Asset["video"]>;
export type AssetAudioShape = NonNullable<Asset["audio"]>[number];

export interface ProbeFieldSources {
  audio?: { probe: string; streams: Array<Record<string, string>> };
  capturedAt?: string;
  container?: string;
  duration?: string;
  fps?: string;
  height?: string;
  image?: string;
  video?: Record<string, string>;
  width?: string;
}

export interface ProbedAssetMedia {
  audio?: AssetAudioShape[];
  container?: string;
  ffprobeVersion: string;
  image?: { width: number; height: number; hasAlpha: boolean };
  probe: AssetProbeShape;
  sources: ProbeFieldSources;
  video?: AssetVideoShape;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface Fraction {
  denominator: bigint;
  numerator: bigint;
}

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function integerField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function normalizedFraction(
  numerator: bigint,
  denominator: bigint,
): Fraction | undefined {
  if (denominator === 0n) return undefined;
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: (numerator * sign) / divisor,
    denominator: (denominator * sign) / divisor,
  };
}

function parseFraction(value: unknown): Fraction | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(-?\d+)\/(\d+)$/u.exec(value);
  if (match === null) return undefined;
  return normalizedFraction(BigInt(match[1]!), BigInt(match[2]!));
}

function parseDecimal(value: unknown): Fraction | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null) return undefined;
  const fractionDigits = match[2] ?? "";
  const denominator = 10n ** BigInt(fractionDigits.length);
  return normalizedFraction(
    BigInt(`${match[1]}${fractionDigits}`),
    denominator,
  );
}

function rationalString(fraction: Fraction): Rational {
  return `${fraction.numerator}/${fraction.denominator}`;
}

/** Core rule 2.2-3: nearest frame/sample, with exact ties toward earlier. */
function roundNearestTowardEarlier(fraction: Fraction): number | undefined {
  let floor = fraction.numerator / fraction.denominator;
  let remainder = fraction.numerator % fraction.denominator;
  if (remainder < 0n) {
    floor -= 1n;
    remainder += fraction.denominator;
  }
  const rounded =
    remainder * 2n <= fraction.denominator ? floor : floor + 1n;
  return rounded >= 0n && rounded <= MAX_SAFE_INTEGER
    ? Number(rounded)
    : undefined;
}

function durationAtRate(
  duration: Fraction,
  rate: Fraction,
): number | undefined {
  const product = normalizedFraction(
    duration.numerator * rate.numerator,
    duration.denominator * rate.denominator,
  );
  return product === undefined ? undefined : roundNearestTowardEarlier(product);
}

function streamsFrom(root: JsonRecord): JsonRecord[] {
  const streams = root.streams;
  return Array.isArray(streams) ? streams.filter(isRecord) : [];
}

function formatFrom(root: JsonRecord): JsonRecord {
  return isRecord(root.format) ? root.format : {};
}

function streamRate(
  stream: JsonRecord,
  streamIndex: number,
): { fps: Rational; source: string } | undefined {
  for (const field of ["avg_frame_rate", "r_frame_rate"] as const) {
    const fraction = parseFraction(stream[field]);
    if (fraction !== undefined && fraction.numerator > 0n) {
      return {
        fps: rationalString(fraction),
        source: `streams[${streamIndex}].${field}`,
      };
    }
  }
  return undefined;
}

function alphaPixelFormat(pixelFormat: string): boolean {
  return /^(?:abgr|argb|bgra|gbrap|rgba|ya|yuva)/u.test(pixelFormat);
}

function rotationOf(stream: JsonRecord): 0 | 90 | 180 | 270 {
  const tags = isRecord(stream.tags) ? stream.tags : {};
  let value = integerField(tags, "rotate");
  if (value === undefined && Array.isArray(stream.side_data_list)) {
    for (const sideData of stream.side_data_list.filter(isRecord)) {
      value = integerField(sideData, "rotation");
      if (value !== undefined) break;
    }
  }
  const normalized = ((value ?? 0) % 360 + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270
    ? normalized
    : 0;
}

function videoDuration(
  stream: JsonRecord,
  streamIndex: number,
  format: JsonRecord,
  fps: Rational,
): { duration: FrameTime; source: string } | undefined {
  const frames = integerField(stream, "nb_frames");
  if (frames !== undefined && frames >= 0) {
    return {
      duration: { frames, fps },
      source: `streams[${streamIndex}].nb_frames`,
    };
  }
  const rate = parseFraction(fps);
  if (rate === undefined) return undefined;
  for (const [value, source] of [
    [stream.duration, `streams[${streamIndex}].duration`],
    [format.duration, "format.duration"],
  ] as const) {
    const decimal = parseDecimal(value);
    if (decimal === undefined) continue;
    const roundedFrames = durationAtRate(decimal, rate);
    if (roundedFrames !== undefined) {
      return {
        duration: { frames: roundedFrames, fps },
        source: `${source} × ${fps}, rounded nearest with ties toward earlier`,
      };
    }
  }
  return undefined;
}

function audioDuration(
  stream: JsonRecord,
  streamIndex: number,
  format: JsonRecord,
  sampleRate: number,
): { duration: SampleTime; source: string } | undefined {
  const durationTimestamp = integerField(stream, "duration_ts");
  const timeBase = parseFraction(stream.time_base);
  if (durationTimestamp !== undefined && timeBase !== undefined) {
    const duration = normalizedFraction(
      BigInt(durationTimestamp) * timeBase.numerator,
      timeBase.denominator,
    );
    const samples =
      duration === undefined
        ? undefined
        : durationAtRate(duration, {
            numerator: BigInt(sampleRate),
            denominator: 1n,
          });
    if (samples !== undefined) {
      return {
        duration: { rate: sampleRate, samples },
        source: `streams[${streamIndex}].duration_ts × streams[${streamIndex}].time_base × sample_rate`,
      };
    }
  }
  for (const [value, source] of [
    [stream.duration, `streams[${streamIndex}].duration`],
    [format.duration, "format.duration"],
  ] as const) {
    const decimal = parseDecimal(value);
    if (decimal === undefined) continue;
    const samples = durationAtRate(decimal, {
      numerator: BigInt(sampleRate),
      denominator: 1n,
    });
    if (samples !== undefined) {
      return {
        duration: { rate: sampleRate, samples },
        source: `${source} × sample_rate, rounded nearest with ties toward earlier`,
      };
    }
  }
  return undefined;
}

function parseProbeJson(stdout: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Converted to the same command-failure envelope below.
  }
  throw new FfmpegError(
    "E_FFMPEG_FAILED",
    "ffprobe returned invalid JSON.",
    "safe",
    { exitCode: 0, stderrLines: [] },
  );
}

export async function probeMedia(mediaPath: string): Promise<ProbedAssetMedia> {
  const run = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    mediaPath,
  ]);
  const root = parseProbeJson(run.stdout);
  const streams = streamsFrom(root);
  const format = formatFrom(root);
  const videoStreamIndex = streams.findIndex(
    (stream) => stringField(stream, "codec_type") === "video",
  );
  const videoStream = streams[videoStreamIndex];
  const audioStreams = streams
    .map((stream, index) => ({ index, stream }))
    .filter(({ stream }) => stringField(stream, "codec_type") === "audio");
  const probe: AssetProbeShape = {};
  const sources: ProbeFieldSources = {};
  const result: ProbedAssetMedia = {
    ffprobeVersion: run.binary.version,
    probe,
    sources,
  };

  const container = stringField(format, "format_name");
  if (container !== undefined) {
    result.container = container;
    sources.container = "format.format_name";
  }

  const isImage =
    container
      ?.split(",")
      .some((name) => name === "image2" || name.endsWith("_pipe")) ?? false;
  if (videoStream !== undefined) {
    const width = integerField(videoStream, "width");
    const height = integerField(videoStream, "height");
    const pixelFormat = stringField(videoStream, "pix_fmt") ?? "unknown";
    const rate = streamRate(videoStream, videoStreamIndex);
    if (width !== undefined) {
      probe.width = width;
      sources.width = `streams[${videoStreamIndex}].width`;
    }
    if (height !== undefined) {
      probe.height = height;
      sources.height = `streams[${videoStreamIndex}].height`;
    }
    if (rate !== undefined) {
      probe.fps = rate.fps;
      sources.fps = rate.source;
    }

    if (isImage && width !== undefined && height !== undefined) {
      result.image = {
        hasAlpha: alphaPixelFormat(pixelFormat),
        height,
        width,
      };
      sources.image = `streams[${videoStreamIndex}].{width,height,pix_fmt}`;
    } else if (
      width !== undefined &&
      height !== undefined &&
      rate !== undefined
    ) {
      const codec = stringField(videoStream, "codec_name") ?? "unknown";
      const video: AssetVideoShape = {
        codec,
        fps: rate.fps,
        hasAlpha: alphaPixelFormat(pixelFormat),
        height,
        pixFmt: pixelFormat,
        rotation: rotationOf(videoStream),
        width,
      };
      const colorSpace = stringField(videoStream, "color_space");
      const bitrate = integerField(videoStream, "bit_rate");
      if (colorSpace !== undefined) video.colorSpace = colorSpace;
      if (bitrate !== undefined && bitrate >= 0) video.bitrate = bitrate;
      result.video = video;
      const videoSources: Record<string, string> = {
        codec: `streams[${videoStreamIndex}].codec_name`,
        fps: rate.source,
        hasAlpha: `streams[${videoStreamIndex}].pix_fmt (derived)`,
        height: `streams[${videoStreamIndex}].height`,
        pixFmt: `streams[${videoStreamIndex}].pix_fmt`,
        rotation: `streams[${videoStreamIndex}].tags.rotate or side_data_list.rotation`,
        width: `streams[${videoStreamIndex}].width`,
      };
      if (colorSpace !== undefined) {
        videoSources.colorSpace = `streams[${videoStreamIndex}].color_space`;
      }
      if (bitrate !== undefined && bitrate >= 0) {
        videoSources.bitrate = `streams[${videoStreamIndex}].bit_rate`;
      }
      sources.video = videoSources;
      const duration = videoDuration(
        videoStream,
        videoStreamIndex,
        format,
        rate.fps,
      );
      if (duration !== undefined) {
        probe.duration = duration.duration;
        sources.duration = duration.source;
      }
    }
  }

  if (audioStreams.length > 0) {
    const mappedAudio: AssetAudioShape[] = [];
    const mappedAudioSources: Array<Record<string, string>> = [];
    let firstMappedStreamIndex: number | undefined;
    for (const { index, stream } of audioStreams) {
      const sampleRate = integerField(stream, "sample_rate");
      const channels = integerField(stream, "channels");
      if (sampleRate === undefined || channels === undefined) continue;
      const audio: AssetAudioShape = {
        channels,
        codec: stringField(stream, "codec_name") ?? "unknown",
        index: integerField(stream, "index") ?? index,
        layout: stringField(stream, "channel_layout") ?? "unknown",
        sampleRate,
      };
      const bitrate = integerField(stream, "bit_rate");
      if (bitrate !== undefined && bitrate >= 0) audio.bitrate = bitrate;
      mappedAudio.push(audio);
      firstMappedStreamIndex ??= index;
      const audioSources: Record<string, string> = {
        channels: `streams[${index}].channels`,
        codec: `streams[${index}].codec_name`,
        index: `streams[${index}].index`,
        layout: `streams[${index}].channel_layout`,
        sampleRate: `streams[${index}].sample_rate`,
      };
      if (bitrate !== undefined && bitrate >= 0) {
        audioSources.bitrate = `streams[${index}].bit_rate`;
      }
      mappedAudioSources.push(audioSources);
    }
    if (mappedAudio.length > 0) {
      result.audio = mappedAudio;
      const first = mappedAudio[0]!;
      const firstSource = audioStreams.find(
        ({ index }) => index === firstMappedStreamIndex,
      )!;
      probe.audio = { channels: first.channels, rate: first.sampleRate };
      sources.audio = {
        probe: `streams[${firstSource.index}].{sample_rate,channels}`,
        streams: mappedAudioSources,
      };
      if (probe.duration === undefined) {
        const duration = audioDuration(
          firstSource.stream,
          firstSource.index,
          format,
          first.sampleRate,
        );
        if (duration !== undefined) {
          probe.duration = duration.duration;
          sources.duration = duration.source;
        }
      }
    }
  }

  const formatTags = isRecord(format.tags) ? format.tags : {};
  const capturedAt =
    stringField(formatTags, "creation_time") ??
    stringField(formatTags, "com.apple.quicktime.creationdate");
  if (capturedAt !== undefined) {
    probe.capturedAt = capturedAt;
    sources.capturedAt = stringField(formatTags, "creation_time")
      ? "format.tags.creation_time"
      : "format.tags.com.apple.quicktime.creationdate";
  }

  return result;
}
