import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { KeyQcReport } from "./key-qc.js";
import type { ProbedAssetMedia } from "./probe.js";

export type CaptureGuidanceWarningCode =
  | "uneven_backdrop"
  | "underexposed_subject"
  | "motion_blur"
  | "compression_artifacts"
  | "subject_too_close"
  | "key_color_wardrobe";

export interface CaptureGuidanceWarning {
  code: CaptureGuidanceWarningCode;
  severity: "info" | "warning";
  evidence: { frames: number[]; metric: number; threshold: number };
  remediation: string;
}

export interface CaptureGuidanceMetrics {
  backdropLumaStd?: number;
  backdropHueStdDeg?: number;
  foregroundMedianLuma?: number;
  motionEdgeGradientRatio?: number;
  blockBoundaryRatio?: number;
  bitsPerPixelFrame?: number;
  keyWardrobeFraction?: number;
}

export interface CaptureGuidanceReport {
  schema: "guyditor.capture/v1";
  assetId: string;
  keyIntended: boolean;
  warnings: CaptureGuidanceWarning[];
}

export interface BuildCaptureGuidanceInput {
  assetId: string;
  keyIntendedFraction: number;
  probe: ProbedAssetMedia;
  qcReport?: KeyQcReport;
  metrics?: CaptureGuidanceMetrics;
}

function warning(
  code: CaptureGuidanceWarningCode,
  frames: readonly number[],
  metric: number,
  threshold: number,
  remediation: string,
  severity: CaptureGuidanceWarning["severity"] = "warning",
): CaptureGuidanceWarning {
  return {
    code,
    severity,
    evidence: { frames: [...frames], metric, threshold },
    remediation,
  };
}

function rationalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  if (match === null || Number(match[2]) === 0) return undefined;
  return Number(match[1]) / Number(match[2]);
}

function probeBitsPerPixelFrame(probe: ProbedAssetMedia): number | undefined {
  const video = probe.video;
  const fps = rationalNumber(video?.fps ?? probe.probe.fps);
  if (video?.bitrate === undefined || fps === undefined || fps <= 0 ||
      video.width <= 0 || video.height <= 0) return undefined;
  return video.bitrate / (video.width * video.height * fps);
}

export function buildCaptureGuidanceReport(input: BuildCaptureGuidanceInput): CaptureGuidanceReport {
  const keyIntended = input.keyIntendedFraction >= 0.3;
  const report: CaptureGuidanceReport = {
    schema: "guyditor.capture/v1",
    assetId: input.assetId,
    keyIntended,
    warnings: [],
  };
  if (!keyIntended) return report;
  const probeBppf = input.metrics?.bitsPerPixelFrame ?? probeBitsPerPixelFrame(input.probe);
  const metrics: CaptureGuidanceMetrics = {
    ...input.metrics,
    ...(probeBppf === undefined ? {} : { bitsPerPixelFrame: probeBppf }),
  };
  const frames = input.qcReport?.sampledFrames ?? [];
  if ((metrics.backdropLumaStd ?? 0) > 0.08 || (metrics.backdropHueStdDeg ?? 0) > 6) {
    const useHue = (metrics.backdropHueStdDeg ?? 0) / 6 > (metrics.backdropLumaStd ?? 0) / 0.08;
    report.warnings.push(warning(
      "uneven_backdrop",
      frames,
      useHue ? metrics.backdropHueStdDeg! : metrics.backdropLumaStd!,
      useHue ? 6 : 0.08,
      "Light the screen more evenly and remove visible folds or hot spots.",
    ));
  }
  if ((metrics.foregroundMedianLuma ?? 1) < 0.25) {
    report.warnings.push(warning(
      "underexposed_subject", frames, metrics.foregroundMedianLuma!, 0.25,
      "Increase subject exposure without brightening the key screen.",
    ));
  }
  if ((metrics.motionEdgeGradientRatio ?? 1) < 0.5) {
    report.warnings.push(warning(
      "motion_blur", frames, metrics.motionEdgeGradientRatio!, 0.5,
      "Use a faster shutter speed or reduce subject movement.",
    ));
  }
  if ((metrics.blockBoundaryRatio ?? 0) > 1.3 || (metrics.bitsPerPixelFrame ?? 1) < 0.04) {
    const blockBased = (metrics.blockBoundaryRatio ?? 0) > 1.3;
    report.warnings.push(warning(
      "compression_artifacts",
      frames,
      blockBased ? metrics.blockBoundaryRatio! : metrics.bitsPerPixelFrame!,
      blockBased ? 1.3 : 0.04,
      "Record at a higher bitrate or with a less destructive codec.",
    ));
  }
  const spillMetrics = input.qcReport?.metrics.filter(({ spillScore }) => spillScore > 0.08) ?? [];
  if (spillMetrics.length > 0) {
    report.warnings.push(warning(
      "subject_too_close",
      spillMetrics.map(({ frame }) => frame),
      Math.max(...spillMetrics.map(({ spillScore }) => spillScore)),
      0.08,
      "Move approximately 0.5 m further from the screen and add separation light.",
    ));
  }
  if ((metrics.keyWardrobeFraction ?? 0) > 0.02) {
    report.warnings.push(warning(
      "key_color_wardrobe", frames, metrics.keyWardrobeFraction!, 0.02,
      "Replace wardrobe or props that are close to the selected key color.",
    ));
  }
  return report;
}

export async function writeCaptureGuidanceReport(
  projectRoot: string,
  report: CaptureGuidanceReport,
): Promise<string> {
  const path = join(projectRoot, "sidecars", "analysis", `${report.assetId}.capture.json`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report)}\n`, "utf8");
  await rename(temporary, path);
  return path;
}
