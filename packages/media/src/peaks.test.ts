import { existsSync } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobQueue,
  ProjectStore,
} from "../../core/src/index.js";
import type {
  Asset,
  JobRecord,
  Result,
} from "../../core/src/index.js";
import { MediaEngine } from "./ingest.js";
import type { IngestJobResult } from "./ingest.js";
import {
  PEAK_SAMPLE_RATE,
  PEAK_SAMPLES_PER_PEAK,
  PcmPeakAccumulator,
  peaksCachePaths,
} from "./peaks.js";
import type { PeaksFile } from "./peaks.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, ".fixtures");
const FIXTURES_AVAILABLE = existsSync(path.join(FIXTURE_ROOT, "manifest.json"));
const temporaryDirectories: string[] = [];
const queues: JobQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

function pcm(samples: readonly number[]): Buffer {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes;
}

async function sandbox(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "guyditor-peaks-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function waitForJob(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const job = queue.get(jobId);
    if (job?.state === "done" || job?.state === "failed") return job;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${jobId}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("PcmPeakAccumulator", () => {
  it("reduces chunked little-endian PCM into interleaved signed-int8 min/max tiers", () => {
    const accumulator = new PcmPeakAccumulator();
    const samples = [
      -32_768,
      32_767,
      ...Array.from({ length: 958 }, () => 0),
      -16_384,
    ];
    const bytes = pcm(samples);

    accumulator.write(bytes.subarray(0, 1));
    accumulator.write(bytes.subarray(1, 1_917));
    accumulator.write(bytes.subarray(1_917));
    const tiers = accumulator.finish();

    expect(tiers.map(({ samplesPerPeak }) => samplesPerPeak))
      .toEqual(PEAK_SAMPLES_PER_PEAK);
    expect(tiers[0]?.data).toEqual([-127, 127, -64, -64]);
    expect(tiers[1]?.data).toEqual([-127, 127]);
    expect(tiers[2]?.data).toEqual([-127, 127]);
    for (const tier of tiers) {
      expect(tier.data.every((value) =>
        Number.isInteger(value) && value >= -127 && value <= 127)).toBe(true);
    }
  });

  it("rejects a trailing partial signed-16 sample", () => {
    const accumulator = new PcmPeakAccumulator();
    accumulator.write(Buffer.of(1));

    expect(() => accumulator.finish()).toThrow("partial s16le sample");
  });
});

describe.skipIf(!FIXTURES_AVAILABLE)("peaks.generate fixture executor", () => {
  it("streams the speech WAV into fixed tiers and near-zero silence buckets", async () => {
    const root = await sandbox();
    const store = await valueOf(ProjectStore.createProject(
      path.join(root, "project"),
      { name: "Peaks test" },
      { profilesDirectory: path.join(REPOSITORY_ROOT, "profiles") },
    ));
    const { queue } = JobQueue.open(path.join(store.root, ".guyditor/jobs.sqlite"));
    queues.push(queue);
    const engine = new MediaEngine({
      followUpJobs: ["peaks.generate"],
      jobQueue: queue,
    });

    const ingest = await waitForJob(queue, engine.ingest(store, {
      sources: [{ path: path.join(FIXTURE_ROOT, "speech-48k-20s.wav") }],
    }).jobId);
    expect(ingest.state).toBe("done");
    const ingestResult = ingest.payload as unknown as IngestJobResult;
    const peaksJobId = ingestResult.followUpJobIds[0];
    if (peaksJobId === undefined) throw new Error("Peaks job was not queued.");
    expect((await waitForJob(queue, peaksJobId)).state).toBe("done");
    const assetId = ingestResult.assets[0]?.assetId;
    const asset = store.currentProject.assets.find(({ id }) => id === assetId);
    if (asset === undefined) throw new Error("Audio asset was not registered.");

    const paths = peaksCachePaths(store.root, asset);
    expect(paths.file).toBe(path.join(
      store.root,
      `.guyditor/cache/peaks/${asset.id}.${asset.sha256.slice(0, 8)}.peaks.json`,
    ));
    const parsed = JSON.parse(await readFile(paths.file, "utf8")) as PeaksFile;
    expect(parsed).toMatchObject({
      assetId: asset.id,
      format: "guyditor.peaks/v1",
      sampleRate: PEAK_SAMPLE_RATE,
      sourceHash: asset.sha256,
    });
    expect(parsed.tiers.map(({ samplesPerPeak }) => samplesPerPeak))
      .toEqual(PEAK_SAMPLES_PER_PEAK);
    const duration = asset.probe.duration;
    if (duration === undefined || !("samples" in duration)) {
      throw new Error("Fixture duration is not sample-based.");
    }
    const decodedSamples = duration.samples * PEAK_SAMPLE_RATE / duration.rate;
    parsed.tiers.forEach((tier) => {
      const peaks = tier.data.length / 2;
      expect(Math.abs(peaks - decodedSamples / tier.samplesPerPeak))
        .toBeLessThanOrEqual(1);
      expect(tier.data.every((value) =>
        Number.isInteger(value) && value >= -127 && value <= 127)).toBe(true);
    });

    const manifest = JSON.parse(await readFile(
      path.join(FIXTURE_ROOT, "manifest.json"),
      "utf8",
    )) as {
      files: Record<string, {
        groundTruth?: { silenceMap?: Array<{ end: string; start: string }> };
      }>;
    };
    const silenceMap = manifest.files["speech-48k-20s.wav"]?.groundTruth?.silenceMap;
    if (silenceMap === undefined) throw new Error("Fixture silence map is missing.");
    const fine = parsed.tiers[0];
    if (fine === undefined) throw new Error("Fine peak tier is missing.");
    const rational = (value: string): number => {
      const [numerator, denominator] = value.split("/").map(Number);
      if (numerator === undefined || denominator === undefined) {
        throw new Error(`Invalid rational ${value}.`);
      }
      return numerator / denominator;
    };
    for (const region of silenceMap) {
      const firstFullBucket = Math.ceil(
        rational(region.start) * PEAK_SAMPLE_RATE / fine.samplesPerPeak,
      ) + 1;
      const lastFullBucket = Math.floor(
        rational(region.end) * PEAK_SAMPLE_RATE / fine.samplesPerPeak,
      ) - 1;
      for (let bucket = firstFullBucket; bucket <= lastFullBucket; bucket += 1) {
        expect(Math.abs(fine.data[bucket * 2] ?? 127)).toBeLessThanOrEqual(1);
        expect(Math.abs(fine.data[bucket * 2 + 1] ?? 127)).toBeLessThanOrEqual(1);
      }
    }
    await expect(access(paths.part)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("peaks cache paths", () => {
  it("uses the source hash prefix", () => {
    const asset: Asset = {
      id: "ast_aaaaaaaaaa",
      kind: "audio",
      path: "speech.wav",
      probe: {},
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };

    expect(peaksCachePaths("/project", asset)).toEqual({
      file: path.join(
        "/project/.guyditor/cache/peaks",
        "ast_aaaaaaaaaa.01234567.peaks.json",
      ),
      part: path.join(
        "/project/.guyditor/cache/peaks",
        "ast_aaaaaaaaaa.01234567.peaks.json.part",
      ),
    });
  });
});
