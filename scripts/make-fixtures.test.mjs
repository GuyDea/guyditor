import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  isFixtureManifestFresh,
  makeTranscriptFixture,
  parseFixtureArguments,
} from "./make-fixtures.mjs";
import {
  FIXTURE_GENERATOR_VERSION,
  EXPECTED_FIXTURE_KINDS,
  REQUIRED_FIXTURE_PATHS,
} from "./fixture-spec.mjs";

const temporaryDirectories = [];

function validGroundTruth(filePath) {
  const values = {
    "bars-1080p30-10s.mp4": { fps: "30/1", frameCount: 300 },
    "speech-48k-20s.wav": {
      silenceMap: [
        { end: "19/5", start: "3/1" },
        { end: "51/5", start: "9/1" },
        { end: "16/1", start: "31/2" },
      ],
    },
    "greenscreen-720p30-6s.mp4": {
      keyColor: "0x00B140",
      subjectBoundingBoxPath: Array.from({ length: 180 }, (_, frame) => ({
        frame,
        height: 210,
        width: 120,
        x: 0,
        y: 0,
      })),
    },
    "screencast-1080p30-15s.mp4": { cutFrame: 225 },
    "avsync-video.mp4": { flashFrame: 60, offsetMilliseconds: 500 },
    "avsync-audio.wav": {
      offsetMilliseconds: 500,
      shiftedBeepStart: "5/2",
    },
    "stills/diagram-1080.png": { height: 1080, width: 1920 },
    "stills/logo-256.png": { height: 256, width: 256 },
    "disc-track-720p30-8s.mp4": {
      centerPath: Array.from({ length: 240 }, (_, frame) => ({
        frame,
        x: 0,
        y: 0,
      })),
      radius: 48,
    },
    "transcripts/short-exact.json": {
      duration: { rate: 48_000, samples: 576_000 },
      wordCount: 24,
    },
    "transcripts/drift-2800w-20m.json": {
      duration: { rate: 48_000, samples: 57_600_000 },
      wordCount: 2_800,
    },
  };
  return values[filePath];
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test("makeTranscriptFixture creates deterministic exact 20-minute timing", () => {
  const options = {
    assetId: "ast_fixturezzz",
    durationSamples: 57_600_000,
    seed: 0x47_55_59,
    wordCount: 2_800,
  };

  const first = makeTranscriptFixture(options);
  const second = makeTranscriptFixture(options);

  assert.deepEqual(first, second);
  assert.match(first.assetId, /^ast_[a-z2-7]{10}$/u);
  assert.match(first.provenance.jobId, /^job_[a-z2-7]{10}$/u);
  assert.match(first.segments[0].id, /^seg_[a-z2-7]{10}$/u);
  assert.match(first.speakers[0].id, /^spk_[a-z2-7]{10}$/u);
  assert.equal(Object.keys(first.words).length, 2_800);
  assert.equal(first.segments[0].words.length, 2_800);
  assert.deepEqual(first.segments[0].start, { rate: 48_000, samples: 0 });
  assert.deepEqual(first.segments[0].end, {
    rate: 48_000,
    samples: 57_600_000,
  });
  assert.equal(first.segments[0].words[0], "w000001");
  assert.equal(first.segments[0].words.at(-1), "w002800");
});

test("isFixtureManifestFresh accepts only current manifests with every file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "guyditor-fresh-"));
  temporaryDirectories.push(directory);
  const files = {};
  for (const fixturePath of REQUIRED_FIXTURE_PATHS) {
    const absolutePath = path.join(directory, fixturePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "x");
    files[fixturePath] = {
      bytes: 1,
      groundTruth: validGroundTruth(fixturePath),
      kind: EXPECTED_FIXTURE_KINDS[fixturePath],
      sha256: createHash("sha256").update("x").digest("hex"),
    };
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({
      ffmpegVersion: "ffmpeg version fixture",
      files,
      generatorVersion: FIXTURE_GENERATOR_VERSION,
    })}\n`,
  );

  assert.equal(await isFixtureManifestFresh(directory), true);
  await writeFile(path.join(directory, REQUIRED_FIXTURE_PATHS[0]), "y");
  assert.equal(await isFixtureManifestFresh(directory), false);
  await rm(path.join(directory, REQUIRED_FIXTURE_PATHS[0]));
  assert.equal(await isFixtureManifestFresh(directory), false);
});

test("parseFixtureArguments accepts pnpm's separator before --force", () => {
  assert.deepEqual(parseFixtureArguments(["--", "--force"]), { force: true });
});
