import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MlworkerSupervisor } from "./supervisor.js";
import type {
  MlworkerTranscribeResult,
  MlworkerVadResult,
  SampleTime,
} from "./types.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..");
const WORKER_ROOT = path.join(REPOSITORY_ROOT, "workers/mlworker");
const PYTHON = path.join(WORKER_ROOT, ".venv/bin/python");
const FIXTURE = path.join(REPOSITORY_ROOT, ".fixtures/speech-48k-20s.wav");
const MANIFEST = path.join(REPOSITORY_ROOT, ".fixtures/manifest.json");
const AVAILABLE = existsSync(PYTHON) && existsSync(FIXTURE) && existsSync(MANIFEST);
const suiteName = AVAILABLE
  ? "mlworker real-process contract"
  : "mlworker real-process contract (skipped: run workers/mlworker/setup.sh and pnpm fixtures)";
const supervisors: MlworkerSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(async (supervisor) => supervisor.stop()));
});

function realSupervisor(disable?: string): MlworkerSupervisor {
  const supervisor = new MlworkerSupervisor({
    env: {
      GUYDITOR_ML_MODEL_DIR: path.join(REPOSITORY_ROOT, ".guyditor/ml-models"),
      ...(disable === undefined ? {} : { GUYDITOR_ML_DISABLE: disable }),
    },
  });
  supervisors.push(supervisor);
  return supervisor;
}

function seconds(value: string): number {
  const [numerator, denominator] = value.split("/").map(Number);
  if (numerator === undefined || denominator === undefined) {
    throw new Error(`invalid rational ${value}`);
  }
  return numerator / denominator;
}

function sampleSeconds(value: SampleTime): number {
  return value.samples / value.rate;
}

describe.skipIf(!AVAILABLE)(suiteName, () => {
  it("handshakes with honest capabilities and supports disable-env omission", async () => {
    const startedAt = performance.now();
    const enabled = realSupervisor();
    const hello = await enabled.start();
    expect(hello.ok).toBe(true);
    if (!hello.ok) throw new Error(hello.error.message);
    expect(hello.value).toMatchObject({
      protocol: 1,
      device: { type: "cpu" },
    });
    expect(hello.value.capabilities.map(({ task }) => task)).toEqual([
      "transcribe",
      "vad",
    ]);

    const disabled = realSupervisor("transcribe");
    const degraded = await disabled.start();
    expect(degraded.ok).toBe(true);
    if (!degraded.ok) throw new Error(degraded.error.message);
    expect(degraded.value.capabilities.map(({ task }) => task)).toEqual(["vad"]);
    console.info(`mlworker contract handshake ${(performance.now() - startedAt).toFixed(0)} ms`);
  });

  it("detects manifest silence boundaries within 150 ms", async () => {
    const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
      files: Record<string, {
        groundTruth?: { silenceMap?: Array<{ start: string; end: string }> };
      }>;
    };
    const expected = manifest.files["speech-48k-20s.wav"]?.groundTruth?.silenceMap;
    if (expected === undefined) throw new Error("fixture silence map is missing");
    const supervisor = realSupervisor();
    const startedAt = performance.now();
    const response = await supervisor.runTask("vad", {
      taskId: "job_vadcase222",
      audioPath: FIXTURE,
    });
    const elapsed = performance.now() - startedAt;
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const result = response.value as unknown as MlworkerVadResult;
    expect(result.silence).toHaveLength(expected.length);
    const errors: number[] = [];
    expected.forEach((interval, index) => {
      const actual = result.silence[index];
      if (actual === undefined) throw new Error(`missing silence interval ${index}`);
      const startError = Math.abs(actual.start - seconds(interval.start));
      const endError = Math.abs(actual.end - seconds(interval.end));
      errors.push(startError, endError);
      expect(startError).toBeLessThanOrEqual(0.15);
      expect(endError).toBeLessThanOrEqual(0.15);
    });
    console.info(
      `mlworker contract vad ${elapsed.toFixed(0)} ms; max boundary error ${(Math.max(...errors) * 1000).toFixed(1)} ms`,
    );
  }, 60_000);

  it("returns monotonic schema-valid tiny-model transcription", async () => {
    const supervisor = realSupervisor();
    const startedAt = performance.now();
    const response = await supervisor.runTask("transcribe", {
      taskId: "job_asrcase222",
      audioPath: FIXTURE,
      model: "tiny",
      language: "auto",
      wordTimestamps: true,
    });
    const elapsed = performance.now() - startedAt;
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const result = response.value as unknown as MlworkerTranscribeResult;
    expect(result.language).toEqual(expect.any(String));
    expect(result.languageProbability).toEqual(expect.any(Number));
    expect(result.engine).toMatchObject({ name: "faster-whisper", model: "tiny" });
    let previousSegmentEnd = 0;
    for (const segment of result.segments) {
      const start = sampleSeconds(segment.start);
      const end = sampleSeconds(segment.end);
      expect(start).toBeGreaterThanOrEqual(previousSegmentEnd);
      expect(end).toBeGreaterThanOrEqual(start);
      expect(end).toBeLessThanOrEqual(20);
      previousSegmentEnd = end;
      let previousWordEnd = start;
      for (const word of segment.words) {
        const wordStart = sampleSeconds(word.start);
        const wordEnd = sampleSeconds(word.end);
        expect(wordStart).toBeGreaterThanOrEqual(previousWordEnd);
        expect(wordEnd).toBeGreaterThanOrEqual(wordStart);
        expect(wordEnd).toBeLessThanOrEqual(end);
        expect(word.probability).toEqual(expect.any(Number));
        previousWordEnd = wordEnd;
      }
    }
    console.info(`mlworker contract transcribe ${elapsed.toFixed(0)} ms`);
  }, 600_000);

  it("acknowledges cancel within two seconds and accepts the next task", async () => {
    const supervisor = realSupervisor();
    const ready = await supervisor.start();
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error(ready.error.message);
    const controller = new AbortController();
    const cancelAt = { value: 0 };
    const timer = setTimeout(() => {
      cancelAt.value = performance.now();
      controller.abort();
    }, 50);
    const response = await supervisor.runTask(
      "transcribe",
      {
        taskId: "job_cancelcase",
        audioPath: FIXTURE,
        model: "tiny",
        language: "auto",
        wordTimestamps: true,
      },
      { signal: controller.signal },
    );
    clearTimeout(timer);
    const acknowledgedMs = performance.now() - cancelAt.value;
    expect(response).toMatchObject({
      ok: false,
      error: { code: "E_MLWORKER_CANCELLED" },
    });
    expect(acknowledgedMs).toBeLessThanOrEqual(2_000);

    const next = await supervisor.runTask("vad", {
      taskId: "job_nextcase22",
      audioPath: FIXTURE,
    });
    expect(next.ok).toBe(true);
    console.info(`mlworker contract cancel acknowledgement ${acknowledgedMs.toFixed(0)} ms`);
  }, 600_000);
});
