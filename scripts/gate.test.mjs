import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import {
  M1_AC_IDS,
  M1_SHIP_IDS,
  M2_PARTIAL_COMMANDS,
  M2_PARTIAL_IDS,
  M3_COMMANDS,
  M3_IDS,
  M4_COMMANDS,
  M4_IDS,
  runGate,
  validateDogfoodReport,
  validateM1Traceability,
  validateM2PartialTraceability,
  validateM3Traceability,
  validateM4Traceability,
} from "./gate.mjs";
import {
  REQUIRED_FIXTURE_PATHS,
  REQUIRED_PROJECT_TEMPLATES,
  REQUIRED_PROJECT_TEMPLATE_PATHS,
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
    "generated/frozen-overlay.png": {
      frozen: true,
      height: 360,
      width: 640,
    },
    "generated/ac005-foreground.png": {
      foreground: true,
      height: 1080,
      width: 1920,
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
    projects: Object.fromEntries(REQUIRED_PROJECT_TEMPLATES.map((name) => [
      name,
      {
        files: Object.fromEntries(REQUIRED_PROJECT_TEMPLATE_PATHS.map((filePath) => [
          filePath,
          { bytes: 1, sha256: "b".repeat(64) },
        ])),
        groundTruth: {
          annotationCount: name === "annotated" ? 1 : 0,
          ...(name === "annotated" ? { exactFrame: { frames: 90, fps: "30/1" } } : {}),
          primaryDeliverableId: "dlv_aaaaaaaaaa",
          revision: "rev_00001",
          schemaValid: true,
          sequenceId: "seq_aaaaaaaaaa",
          transcriptAssetId: "ast_bbbbbbbbbb",
        },
      },
    ])),
  };
}

function completeTraceability() {
  const implemented = new Set(["AC-001", "AC-002", "AC-004"]);
  return [...M1_SHIP_IDS, ...M1_AC_IDS].map((id) =>
    `| ${id} | Part | ${implemented.has(id) ? "implemented" : "partial"} | \`test/${id}.test.ts\` | evidence |`
  ).join("\n");
}

function completeDogfood() {
  return `# M1 dogfood
Episode title: Creator episode
Date: 2026-07-19
## Source-footage inventory
camera.mp4
## Shipped features used
ingest, review, export
## Manual workarounds needed
none
## Export report links
exports/report.json
## §23 metrics snapshot
recorded
`;
}

function completeM2Traceability() {
  const partial = new Set(["FR-1101", "FR-505"]);
  return M2_PARTIAL_IDS.map((id) =>
    `| ${id} | Part | ${partial.has(id) ? "partial" : "implemented"} | \`test/${id}.test.ts\` | evidence |`
  ).join("\n");
}

function completeM3Traceability() {
  return M3_IDS.map((id) =>
    `| ${id} | Part | implemented | \`test/${id}.test.ts\` | evidence |`
  ).join("\n");
}

function completeM4Traceability() {
  return M4_IDS.map((id) =>
    `| ${id} | Part | implemented | \`test/${id}.test.ts\` | evidence |`
  ).join("\n");
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

test("m1 runs the complete §14.8 command algorithm and milestone AC suite", () => {
  const commands = [];
  const reports = [];

  const status = runGate("m1", {
    log: () => {},
    readDogfoodReport: completeDogfood,
    readFixtureManifest: completeManifest,
    readTraceabilityReport: completeTraceability,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
    writeGateReport: (input) => {
      reports.push(input);
      return "/repo/docs/gates/m1-test.md";
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(commands, [
    ["pnpm", "fixtures"],
    ["pnpm", "check:conventions"],
    ["pnpm", "test"],
    ["pnpm", "test:contract"],
    ["pnpm", "test:golden"],
    ["pnpm", "test:e2e"],
    ["pnpm", "test:ac", "--", "m1"],
  ]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].traceabilityCount, M1_SHIP_IDS.length + M1_AC_IDS.length);
});

test("m1 skip-dogfood is explicit, loud, and still emits the automated gate report", () => {
  const output = [];
  let emitted = false;
  const status = runGate("m1", {
    log: (message) => output.push(message),
    readFixtureManifest: completeManifest,
    readTraceabilityReport: completeTraceability,
    runCommand: () => ({ status: 0 }),
    skipDogfood: true,
    writeGateReport: () => {
      emitted = true;
      return "/repo/docs/gates/m1-test.md";
    },
  });
  assert.equal(status, 0);
  assert.equal(emitted, true);
  assert.match(output.join("\n"), /TODO.*DOGFOOD.*SKIPPED/iu);
});

test("m2 runs the declared partial gate and enforces its scoped traceability", () => {
  for (const id of ["FR-009", "FR-010", "FR-011", "FR-311"]) {
    assert.equal(M2_PARTIAL_IDS.includes(id), true, `${id} must be enforced by the M2 gate`);
  }
  const commands = [];
  const output = [];
  const status = runGate("m2", {
    log: (message) => output.push(message),
    readFixtureManifest: completeManifest,
    readTraceabilityReport: completeM2Traceability,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(commands, M2_PARTIAL_COMMANDS.map(({ command, args }) => [command, ...args]));
  assert.match(output.join("\n"), /partial milestone scope passed/iu);
  assert.deepEqual(validateM2PartialTraceability(completeM2Traceability()), []);
});

test("m3 runs the complete §14.8 gate and requires all FR-800..813 and AC rows", () => {
  const commands = [];
  const output = [];
  const reports = [];
  const status = runGate("m3", {
    log: (message) => output.push(message),
    readFixtureManifest: completeManifest,
    readTraceabilityReport: completeM3Traceability,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
    skipDogfood: true,
    writeGateReport: (input) => {
      reports.push(input);
      return "/repo/docs/gates/m3-test.md";
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(commands, M3_COMMANDS.map(({ command, args }) => [command, ...args]));
  assert.deepEqual(validateM3Traceability(completeM3Traceability()), []);
  assert.equal(reports[0].traceabilityCount, M3_IDS.length);
  assert.match(output.join("\n"), /agent candidate judgment.*dogfood.*skipped/iu);
  assert.match(output.join("\n"), /full FR-800\.\.813/iu);
});

test("m4 gate runs the full row, earlier milestone suites, and loud manual sign-off list", () => {
  assert.equal(
    M4_COMMANDS.some(({ command, args }) =>
      command === "pnpm" &&
      args.join(" ").includes("packages/render/src/template-authoring.test.ts")),
    true,
    "M4 must run the focused FR-612 unit suite",
  );
  assert.equal(
    M4_COMMANDS.some(({ command, args }) =>
      command === "pnpm" &&
      args.join(" ").includes("authored-template.golden.test.ts")),
    true,
    "M4 must run the authored-template export golden",
  );
  const commands = [];
  const output = [];
  const status = runGate("m4", {
    log: (message) => output.push(message),
    readFixtureManifest: completeManifest,
    readTraceabilityReport: completeM4Traceability,
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
    skipDogfood: true,
    writeGateReport: () => "/repo/docs/gates/m4-test.md",
  });
  assert.equal(status, 0);
  assert.deepEqual(commands, M4_COMMANDS.map(({ command, args }) => [command, ...args]));
  assert.deepEqual(validateM4Traceability(completeM4Traceability()), []);
  for (const id of [
    "FR-610", "FR-611", "FR-612",
    "FR-304", "FR-503", "FR-603", "FR-604", "FR-605", "FR-606",
    "FR-700", "FR-701", "FR-702", "FR-703", "FR-704", "FR-705",
    "NFR-102", "NFR-107", "NFR-108", "NFR-109", "FR-1102",
    "AC-009", "AC-010", "AC-012",
  ]) assert.equal(M4_IDS.includes(id), true, `${id} must be enforced by M4`);
  assert.match(output.join("\n"), /real-episode reuse test/iu);
  assert.match(output.join("\n"), /cross-machine restore/iu);
  assert.match(output.join("\n"), /real critic\/director judgments/iu);
  assert.match(output.join("\n"), /full M4 milestone scope passed/iu);
});

test("m1 rejects absent, incomplete, or un-evidenced checklist rows", () => {
  const missing = validateM1Traceability(completeTraceability().replace(
    /^\| FR-001 .*$/mu,
    "| FR-001 | Part | todo | | missing |",
  ));
  assert.match(missing.join("\n"), /FR-001.*status.*implemented or partial/iu);
  assert.match(missing.join("\n"), /FR-001.*evidence/iu);

  const partialAc = validateM1Traceability(completeTraceability().replace(
    "| AC-004 | Part | implemented |",
    "| AC-004 | Part | partial |",
  ));
  assert.match(partialAc.join("\n"), /AC-004.*must be implemented/iu);
});

test("m1 dogfood validation enforces every §14.8 field", () => {
  assert.deepEqual(validateDogfoodReport(completeDogfood()), []);
  assert.match(validateDogfoodReport("# incomplete").join("\n"), /episode title/iu);
  assert.match(validateDogfoodReport("# incomplete").join("\n"), /§23 metrics/iu);
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

for (const milestone of [undefined, "m5", "unsupported"]) {
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
