export interface LoudnessTarget {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
}

export interface LoudnormMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

export interface Ebur128Measurement {
  integratedLufs: number;
  loudnessRangeLu: number;
  truePeakDbtp: number;
}

function loudnormOutput(stderr: string): Record<string, unknown> {
  const matches = [...stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/gu)];
  const json = matches.at(-1)?.[0];
  if (json === undefined) {
    throw new Error("FFmpeg loudnorm output did not contain a measurement object.");
  }
  const parsed: unknown = JSON.parse(json);
  if (!isUnknownRecord(parsed)) {
    throw new Error("FFmpeg loudnorm measurement was not an object.");
  }
  return parsed;
}

export function loudnormOutputIsSilent(stderr: string): boolean {
  const measurement = loudnormOutput(stderr);
  const negativeInfinity = (value: unknown): boolean =>
    typeof value === "string" && /^-inf(?:inity)?$/iu.test(value.trim());
  return negativeInfinity(measurement["input_i"]) &&
    negativeInfinity(measurement["input_tp"]);
}

export function loudnormMeasureCommand(
  inputPath: string,
  target: LoudnessTarget,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-i",
    inputPath,
    "-af",
    loudnormTarget(target, true),
    "-f",
    "null",
    "-",
  ];
}

export function parseLoudnormMeasurement(stderr: string): LoudnormMeasurement {
  const parsed = loudnormOutput(stderr);
  return {
    inputI: numericField(parsed, "input_i"),
    inputTp: numericField(parsed, "input_tp"),
    inputLra: numericField(parsed, "input_lra"),
    inputThresh: numericField(parsed, "input_thresh"),
    targetOffset: numericField(parsed, "target_offset"),
  };
}

export function loudnormNormalizeCommand(
  inputPath: string,
  outputPath: string,
  target: LoudnessTarget,
  measurement: LoudnormMeasurement,
  appendLimiter: boolean,
  sampleRate: number,
): string[] {
  const loudnorm = [
    loudnormTarget(target, false),
    `measured_I=${measurement.inputI}`,
    `measured_TP=${measurement.inputTp}`,
    `measured_LRA=${measurement.inputLra}`,
    `measured_thresh=${measurement.inputThresh}`,
    `offset=${measurement.targetOffset}`,
    "linear=true",
    "print_format=json",
  ].join(":");
  const limiter = appendLimiter
    ? `,alimiter=limit=${roundSix(10 ** (target.truePeakDbtp / 20))}:level=false`
    : "";
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-af",
    `${loudnorm}${limiter}`,
    "-map",
    "0:a:0",
    "-vn",
    "-c:a",
    "pcm_f32le",
    "-ar",
    String(sampleRate),
    outputPath,
  ];
}

export function ebur128MeasureCommand(inputPath: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-i",
    inputPath,
    "-filter_complex",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  ];
}

export function parseEbur128Summary(stderr: string): Ebur128Measurement {
  return {
    integratedLufs: sectionNumber(stderr, "Integrated loudness", "I"),
    loudnessRangeLu: sectionNumber(stderr, "Loudness range", "LRA"),
    truePeakDbtp: sectionNumber(stderr, "True peak", "Peak"),
  };
}

function loudnormTarget(target: LoudnessTarget, printFormat: boolean): string {
  const fields = [
    `loudnorm=I=${target.integratedLufs}`,
    `TP=${target.truePeakDbtp}`,
    `LRA=${target.loudnessRangeLu}`,
  ];
  if (printFormat) {
    fields.push("print_format=json");
  }
  return fields.join(":");
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`FFmpeg loudness field ${key} was not finite.`);
  }
  return number;
}

function sectionNumber(stderr: string, section: string, field: string): number {
  const pattern = new RegExp(
    `${escapeRegExp(section)}:[\\s\\S]*?\\b${escapeRegExp(field)}:\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))`,
    "gu",
  );
  const matches = [...stderr.matchAll(pattern)];
  const value = Number(matches.at(-1)?.[1]);
  if (!Number.isFinite(value)) {
    throw new Error(`FFmpeg ebur128 output did not contain ${field}.`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function roundSix(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
