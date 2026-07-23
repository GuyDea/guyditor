import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ebur128MeasureCommand,
  loudnormMeasureCommand,
  loudnormNormalizeCommand,
  loudnormOutputIsSilent,
  parseEbur128Summary,
  parseLoudnormMeasurement,
  runFfmpeg,
} from "../../media/src/index.js";
import type {
  Ebur128Measurement,
  LoudnessTarget,
  LoudnormMeasurement,
} from "../../media/src/index.js";

export interface LoudnessRunResult {
  stderrLines: readonly string[];
}

export type LoudnessRunner = (
  args: readonly string[],
) => Promise<LoudnessRunResult>;

export interface NormalizeMasterLoudnessInput {
  inputPath: string;
  outputPath: string;
  measurementPath: string;
  target: LoudnessTarget;
  sampleRate: number;
  run?: LoudnessRunner;
}

export interface NormalizeMasterLoudnessResult {
  measurement: LoudnormMeasurement | null;
  limiterApplied: boolean;
  silent: boolean;
}

export async function normalizeMasterLoudness(
  input: NormalizeMasterLoudnessInput,
): Promise<NormalizeMasterLoudnessResult> {
  const run = input.run ?? defaultRunner;
  const passOne = await run(loudnormMeasureCommand(input.inputPath, input.target));
  const passOneOutput = passOne.stderrLines.join("\n");
  await mkdir(dirname(input.measurementPath), { recursive: true });
  if (loudnormOutputIsSilent(passOneOutput)) {
    await writeFile(input.measurementPath, `${JSON.stringify({ silent: true }, undefined, 2)}\n`, "utf8");
    return { limiterApplied: false, measurement: null, silent: true };
  }
  const measurement = parseLoudnormMeasurement(passOneOutput);
  await writeFile(
    input.measurementPath,
    `${JSON.stringify(measurement, undefined, 2)}\n`,
    "utf8",
  );

  const linearGainDb = input.target.integratedLufs - measurement.inputI + measurement.targetOffset;
  const limiterApplied = measurement.inputTp + linearGainDb > input.target.truePeakDbtp;
  await mkdir(dirname(input.outputPath), { recursive: true });
  await run(loudnormNormalizeCommand(
    input.inputPath,
    input.outputPath,
    input.target,
    measurement,
    limiterApplied,
    input.sampleRate,
  ));
  return { limiterApplied, measurement, silent: false };
}

export async function measureDeliveredLoudness(
  inputPath: string,
  run: LoudnessRunner = defaultRunner,
): Promise<Ebur128Measurement> {
  const result = await run(ebur128MeasureCommand(inputPath));
  return parseEbur128Summary(result.stderrLines.join("\n"));
}

async function defaultRunner(args: readonly string[]): Promise<LoudnessRunResult> {
  return runFfmpeg(args);
}
