import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { runGate } from "./gate.mjs";
import {
  REQUIRED_FIXTURE_PATHS,
} from "./fixture-spec.mjs";

function fixtureKind(filePath) {
  if (filePath.endsWith(".mp4")) return "video";
  if (filePath.endsWith(".wav")) return "audio";
  if (filePath.endsWith(".png")) return "image";
  return "sidecar";
}

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

function completeManifest() {
  return {
    ffmpegVersion: "ffmpeg version test",
    files: Object.fromEntries(
      REQUIRED_FIXTURE_PATHS.map((filePath) => [
        filePath,
        {
          bytes: 1,
          groundTruth: validGroundTruth(filePath),
          kind: fixtureKind(filePath),
          sha256: "a".repeat(64),
        },
      ]),
    ),
    generatorVersion: "1",
  };
}

test("m0 runs fixtures first, then checks, and prints deferred work", () => {
  const commands = [];
  const output = [];

  const status = runGate("m0", {
    log: (message) => output.push(message),
    readFixtureManifest: completeManifest,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(commands, [
    ["pnpm", "fixtures"],
    ["node", "scripts/video-zero.mjs"],
    ["pnpm", "check:conventions"],
    ["pnpm", "-r", "typecheck"],
    ["pnpm", "exec", "vitest", "run", "--project", "unit", "--project", "golden"],
    [
      "node",
      "--test",
      "scripts/check-conventions.test.mjs",
      "scripts/gate.test.mjs",
      "scripts/make-fixtures.test.mjs",
    ],
  ]);

  const text = output.join("\n");
  assert.match(text, /fixtures/i);
  assert.match(text, /contract.*golden.*e2e.*AC/is);
  assert.match(text, /traceability/i);
  assert.match(text, /dogfood/i);
  assert.match(text, /gate report/i);
});

test("m0 stops at the first failed check", () => {
  const commands = [];

  const status = runGate("m0", {
    error: () => {},
    log: () => {},
    readFixtureManifest: completeManifest,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: commands.length === 2 ? 7 : 0 };
    },
  });

  assert.equal(status, 7);
  assert.deepEqual(commands, [
    ["pnpm", "fixtures"],
    ["node", "scripts/video-zero.mjs"],
  ]);
});

test("m0 uses the Windows pnpm executable without changing command displays", () => {
  const commands = [];
  const output = [];

  const status = runGate("m0", {
    log: (message) => output.push(message),
    platform: "win32",
    readFixtureManifest: completeManifest,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(
    commands.map(([command]) => command),
    ["pnpm.cmd", "node", "pnpm.cmd", "pnpm.cmd", "pnpm.cmd", "node"],
  );
  assert.match(output[0], /^==> pnpm fixtures$/);
});

test("m1 extends the M0 checks with setup, contracts, and the Electron smoke", () => {
  const commands = [];

  const status = runGate("m1", {
    log: () => {},
    readFixtureManifest: completeManifest,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(commands.slice(-4), [
    ["bash", "workers/mlworker/setup.sh"],
    ["uv", "run", "--project", "workers/mlworker", "pytest", "workers/mlworker/tests"],
    ["pnpm", "exec", "vitest", "run", "--project", "contract"],
    ["pnpm", "test:e2e"],
  ]);
});

test("m0 rejects a fixture manifest missing a required entry", () => {
  const errors = [];
  const manifest = completeManifest();
  delete manifest.files["disc-track-720p30-8s.mp4"];

  const status = runGate("m0", {
    error: (message) => errors.push(message),
    log: () => {},
    readFixtureManifest: () => manifest,
    runCommand: () => ({ status: 0 }),
  });

  assert.equal(status, 1);
  assert.match(errors.join("\n"), /disc-track-720p30-8s\.mp4/);
});

test("m0 rejects a fixture manifest missing required ground truth", () => {
  const errors = [];
  const manifest = completeManifest();
  delete manifest.files["bars-1080p30-10s.mp4"].groundTruth;

  const status = runGate("m0", {
    error: (message) => errors.push(message),
    log: () => {},
    readFixtureManifest: () => manifest,
    runCommand: () => ({ status: 0 }),
  });

  assert.equal(status, 1);
  assert.match(errors.join("\n"), /bars-1080p30-10s\.mp4.*groundTruth/);
});

test("m0 rejects semantically invalid fixture kind and ground truth", () => {
  const errors = [];
  const manifest = completeManifest();
  manifest.files["bars-1080p30-10s.mp4"].kind = "sidecar";
  manifest.files["bars-1080p30-10s.mp4"].groundTruth.frameCount = true;

  const status = runGate("m0", {
    error: (message) => errors.push(message),
    log: () => {},
    readFixtureManifest: () => manifest,
    runCommand: () => ({ status: 0 }),
  });

  assert.equal(status, 1);
  assert.match(errors.join("\n"), /kind.*video|frameCount.*300/);
});

test("m0 rejects motion paths with missing coordinates", () => {
  const errors = [];
  const manifest = completeManifest();
  delete manifest.files["greenscreen-720p30-6s.mp4"].groundTruth
    .subjectBoundingBoxPath[0].x;

  const status = runGate("m0", {
    error: (message) => errors.push(message),
    log: () => {},
    readFixtureManifest: () => manifest,
    runCommand: () => ({ status: 0 }),
  });

  assert.equal(status, 1);
  assert.match(errors.join("\n"), /subjectBoundingBoxPath.*x.*y.*width.*height/);
});

for (const milestone of [undefined, "m2", "m3", "m4", "unsupported"]) {
  test(`gate ${milestone ?? "<missing>"} exits one with a clear message`, () => {
    const gatePath = path.join(import.meta.dirname, "gate.mjs");
    const args = milestone === undefined ? [gatePath] : [gatePath, milestone];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}${result.stderr}`,
      new RegExp(`gate ${milestone ?? "<missing>"}: gate not yet defined`),
    );
  });
}
