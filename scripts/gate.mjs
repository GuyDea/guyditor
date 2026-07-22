import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateFixtureManifest } from "./fixture-spec.mjs";

export const M0_COMMANDS = Object.freeze([
  Object.freeze({ args: ["fixtures"], command: "pnpm" }),
  Object.freeze({ args: ["scripts/video-zero.mjs"], command: "node" }),
  Object.freeze({ args: ["check:conventions"], command: "pnpm" }),
  Object.freeze({ args: ["-r", "typecheck"], command: "pnpm" }),
  Object.freeze({
    args: ["exec", "vitest", "run", "--project", "unit", "--project", "golden"],
    command: "pnpm",
  }),
  Object.freeze({
    args: [
      "--test",
      "scripts/check-conventions.test.mjs",
      "scripts/gate.test.mjs",
      "scripts/make-fixtures.test.mjs",
    ],
    command: "node",
  }),
]);

export const M1_COMMANDS = Object.freeze([
  Object.freeze({ args: ["fixtures"], command: "pnpm" }),
  Object.freeze({ args: ["check:conventions"], command: "pnpm" }),
  Object.freeze({ args: ["test"], command: "pnpm" }),
  Object.freeze({ args: ["test:contract"], command: "pnpm" }),
  Object.freeze({ args: ["test:golden"], command: "pnpm" }),
  Object.freeze({ args: ["test:e2e"], command: "pnpm" }),
  Object.freeze({ args: ["test:ac", "--", "m1"], command: "pnpm" }),
]);

export const M2_PARTIAL_COMMANDS = Object.freeze([
  Object.freeze({ args: ["fixtures"], command: "pnpm" }),
  Object.freeze({ args: ["check:conventions"], command: "pnpm" }),
  Object.freeze({ args: ["-r", "typecheck"], command: "pnpm" }),
  Object.freeze({ args: ["-r", "lint"], command: "pnpm" }),
  Object.freeze({ args: ["exec", "vitest", "run", "--project", "unit"], command: "pnpm" }),
  Object.freeze({ args: ["test:golden"], command: "pnpm" }),
  Object.freeze({ args: ["test:ac", "--", "m2"], command: "pnpm" }),
]);

export const M3_PARTIAL_COMMANDS = Object.freeze([
  Object.freeze({ args: ["fixtures"], command: "pnpm" }),
  Object.freeze({ args: ["check:conventions"], command: "pnpm" }),
  Object.freeze({ args: ["-r", "typecheck"], command: "pnpm" }),
  Object.freeze({ args: ["-r", "lint"], command: "pnpm" }),
  Object.freeze({ args: ["test:ac", "--", "m3"], command: "pnpm" }),
]);

const DEFERRED_M0_STEPS = Object.freeze([
  "remaining milestone contract, golden, e2e, and AC coverage beyond the implemented M0/M1 suites",
  "milestone traceability-status enforcement",
  "dogfood evidence",
  "gate report emission",
]);

function identifiers(prefix, from, through, width) {
  return Array.from({ length: through - from + 1 }, (_, index) =>
    `${prefix}-${String(from + index).padStart(width, "0")}`
  );
}

export const M1_SHIP_IDS = Object.freeze([
  ...identifiers("FR", 1, 8, 3),
  ...identifiers("FR", 100, 108, 3),
  "FR-200",
  "FR-201",
  "FR-203",
  "FR-204",
  ...identifiers("FR", 300, 305, 3),
  ...identifiers("FR", 400, 406, 3),
  "FR-900",
  "FR-901",
  "FR-904",
  "FR-905",
  ...identifiers("FR", 1000, 1005, 4),
  "NFR-006",
  "NFR-007",
  "NFR-106",
]);

export const M1_AC_IDS = Object.freeze(["AC-001", "AC-002", "AC-004", "AC-009"]);

export const M2_PARTIAL_IDS = Object.freeze([
  "FR-009",
  "FR-010",
  "FR-011",
  "FR-205",
  "FR-206",
  "FR-207",
  "FR-208",
  "FR-1101",
  "FR-306",
  "FR-311",
  "FR-500",
  "FR-501",
  "FR-502",
  "FR-504",
  "FR-505",
  "FR-506",
  "FR-507",
  "FR-508",
  "FR-509",
  "FR-510",
  "AC-003",
  "AC-005",
  "AC-006",
]);

const M2_PARTIAL_STATUS_IDS = new Set(["FR-1101", "FR-505"]);

export const M3_PARTIAL_IDS = Object.freeze([
  "FR-510",
  "FR-511",
  "FR-800",
  "FR-801",
  "FR-802",
  "FR-803",
  "FR-804",
  "FR-805",
  "FR-807",
  "AC-008",
]);

// The M1 table explicitly permits scoped rows ("core" and "foundation"), and the
// coordinator ruling permits evidence-backed partial rows. The three required M1
// acceptance suites themselves must be implemented; AC-009 is intentionally a partial
// automated harness until its M4 real-episode/cross-machine obligation.
export const M1_FULL_IMPLEMENTATION_IDS = Object.freeze([
  "AC-001",
  "AC-002",
  "AC-004",
]);

function spawnCommand(command, args) {
  return spawnSync(command, args, { stdio: "inherit" });
}

function commandText(command, args) {
  return [command, ...args].join(" ");
}

function readGeneratedFixtureManifest() {
  return JSON.parse(
    readFileSync(path.resolve(".fixtures", "manifest.json"), "utf8"),
  );
}

function readTraceability() {
  return readFileSync(path.resolve("docs", "traceability.md"), "utf8");
}

function readDogfood(milestone) {
  return readFileSync(
    path.resolve("docs", "dogfood", `${milestone.toUpperCase()}-episode.md`),
    "utf8",
  );
}

function traceabilityRows(markdown) {
  const rows = new Map();
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*((?:FR|NFR|AC)-\d+)\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/u.exec(line);
    if (match !== null) {
      rows.set(match[1], { status: match[2].trim(), evidence: match[3].trim() });
    }
  }
  return rows;
}

export function validateM1Traceability(markdown) {
  const rows = traceabilityRows(markdown);
  const full = new Set(M1_FULL_IMPLEMENTATION_IDS);
  const errors = [];
  for (const id of [...M1_SHIP_IDS, ...M1_AC_IDS]) {
    const row = rows.get(id);
    if (row === undefined) {
      errors.push(`${id}: traceability row is missing`);
      continue;
    }
    if (row.status !== "implemented" && row.status !== "partial") {
      errors.push(`${id}: status must be implemented or partial (received ${row.status})`);
    } else if (full.has(id) && row.status !== "implemented") {
      errors.push(`${id}: the M1 acceptance suite must be implemented`);
    }
    if (row.evidence.length === 0) errors.push(`${id}: test evidence is required`);
  }
  return errors;
}

export function validateM2PartialTraceability(markdown) {
  const rows = traceabilityRows(markdown);
  const errors = [];
  for (const id of M2_PARTIAL_IDS) {
    const row = rows.get(id);
    if (row === undefined) {
      errors.push(`${id}: traceability row is missing`);
      continue;
    }
    const expected = M2_PARTIAL_STATUS_IDS.has(id) ? "partial" : "implemented";
    if (row.status !== expected) {
      errors.push(`${id}: M2 partial gate requires status ${expected} (received ${row.status})`);
    }
    if (row.evidence.length === 0) errors.push(`${id}: test evidence is required`);
  }
  return errors;
}

export function validateM3PartialTraceability(markdown) {
  const rows = traceabilityRows(markdown);
  const errors = [];
  for (const id of M3_PARTIAL_IDS) {
    const row = rows.get(id);
    if (row === undefined) {
      errors.push(`${id}: traceability row is missing`);
      continue;
    }
    const expected = id === "FR-800" ? "partial" : "implemented";
    if (row.status !== expected) {
      errors.push(`${id}: M3 partial gate requires status ${expected} (received ${row.status})`);
    }
    if (row.evidence.length === 0) errors.push(`${id}: test evidence is required`);
  }
  return errors;
}

export function validateDogfoodReport(markdown) {
  const required = [
    [/episode title/iu, "episode title"],
    [/\bdate\b/iu, "date"],
    [/source-footage inventory/iu, "source-footage inventory"],
    [/shipped features used/iu, "shipped features used"],
    [/manual workarounds/iu, "manual workarounds"],
    [/export report/iu, "export report links"],
    [/§23 metrics snapshot/iu, "§23 metrics snapshot"],
  ];
  return required.flatMap(([pattern, label]) => pattern.test(markdown) ? [] : [label]);
}

function emitGateReport({ date, dogfoodSkipped, milestone, traceabilityCount }) {
  const directory = path.resolve("docs", "gates");
  mkdirSync(directory, { recursive: true });
  const outputPath = path.join(directory, `${milestone}-${date}.md`);
  const dogfood = dogfoodSkipped
    ? "skipped by coordinator (`--skip-dogfood`); TODO before creator sign-off"
    : "complete";
  const commandRows = (milestone === "m3"
    ? M3_PARTIAL_COMMANDS
    : milestone === "m2" ? M2_PARTIAL_COMMANDS
    : milestone === "m1" ? M1_COMMANDS : M0_COMMANDS)
    .map(({ command, args }) => `| \`${commandText(command, args)}\` | pass |`)
    .join("\n");
  writeFileSync(outputPath, [
    `# ${milestone.toUpperCase()} gate report — ${date}`,
    "",
    "## §14.8 gate algorithm results",
    "",
    "| Check | Result |",
    "|---|---|",
    commandRows,
    `| Fixture manifest | pass |`,
    `| Traceability | pass — ${String(traceabilityCount)} ${milestone.toUpperCase()} requirement/AC rows checked |`,
    `| Dogfood | ${dogfood} |`,
    "",
  ].join("\n"), "utf8");
  return outputPath;
}

export function runGate(
  milestone,
  {
    currentDate = () => new Date().toISOString().slice(0, 10),
    error = console.error,
    log = console.log,
    platform = process.platform,
    readDogfoodReport = readDogfood,
    readFixtureManifest = readGeneratedFixtureManifest,
    readTraceabilityReport = readTraceability,
    runCommand = spawnCommand,
    skipDogfood = false,
    writeGateReport = emitGateReport,
  } = {},
) {
  if (milestone !== "m0" && milestone !== "m1" && milestone !== "m2" && milestone !== "m3") {
    error(`gate ${milestone ?? "<missing>"}: gate not yet defined`);
    return 1;
  }

  const commands = milestone === "m0"
    ? M0_COMMANDS
    : milestone === "m1" ? M1_COMMANDS
    : milestone === "m2" ? M2_PARTIAL_COMMANDS : M3_PARTIAL_COMMANDS;
  for (const { command, args } of commands) {
    const display = commandText(command, args);
    const executable = platform === "win32" && command === "pnpm" ? `${command}.cmd` : command;
    log(`==> ${display}`);

    let result;
    try {
      result = runCommand(executable, args);
    } catch (spawnError) {
      error(`gate ${milestone}: could not run ${display}: ${spawnError.message}`);
      return 1;
    }
    if (result?.error) {
      error(`gate ${milestone}: could not run ${display}: ${result.error.message}`);
      return 1;
    }
    if (result?.status !== 0) {
      const detail = result?.signal
        ? `terminated by signal ${result.signal}`
        : `exited with status ${result?.status ?? "unknown"}`;
      error(`gate ${milestone}: ${display} ${detail}`);
      return typeof result?.status === "number" && result.status !== 0 ? result.status : 1;
    }
  }

  let manifest;
  try {
    manifest = readFixtureManifest();
  } catch (manifestError) {
    error(`gate ${milestone}: could not read .fixtures/manifest.json: ${manifestError.message}`);
    return 1;
  }
  const manifestErrors = validateFixtureManifest(manifest);
  if (manifestErrors.length > 0) {
    error(`gate ${milestone}: invalid fixture manifest: ${manifestErrors.join("; ")}`);
    return 1;
  }
  log(`gate ${milestone}: fixture manifest contains every required entry`);

  if (milestone === "m0") {
    log("gate m0: implementable scaffold checks passed");
    log("Deferred §14.8 scaffold-era steps:");
    for (const step of DEFERRED_M0_STEPS) log(`- ${step}`);
    return 0;
  }

  let traceability;
  try {
    traceability = readTraceabilityReport();
  } catch (traceabilityError) {
    error(`gate m1: could not read docs/traceability.md: ${traceabilityError.message}`);
    return 1;
  }
  const traceabilityErrors = milestone === "m1"
    ? validateM1Traceability(traceability)
    : milestone === "m2"
      ? validateM2PartialTraceability(traceability)
      : validateM3PartialTraceability(traceability);
  if (traceabilityErrors.length > 0) {
    error(`gate ${milestone}: traceability failed: ${traceabilityErrors.join("; ")}`);
    return 1;
  }
  const traceabilityCount = milestone === "m1"
    ? M1_SHIP_IDS.length + M1_AC_IDS.length
    : milestone === "m2" ? M2_PARTIAL_IDS.length : M3_PARTIAL_IDS.length;
  log(`gate ${milestone}: traceability passed for ${String(traceabilityCount)} rows`);

  if (milestone === "m2") {
    log("gate m2: partial milestone scope passed (captions, keyframed transforms, compositing/keying, PiP, AC-003, AC-005, AC-006)");
    return 0;
  }

  if (milestone === "m3") {
    if (skipDogfood) {
      log("!!! M3 agent candidate judgment dogfood was skipped; run the real director-model coherence review before sign-off !!!");
    } else {
      let dogfood;
      try {
        dogfood = readDogfoodReport("m3");
      } catch (dogfoodError) {
        error(`gate m3: missing docs/dogfood/M3-episode.md: ${dogfoodError.message}`);
        return 1;
      }
      if (!/candidate/iu.test(dogfood) || !/coheren/iu.test(dogfood)) {
        error("gate m3: dogfood must record the real-model candidate coherence judgment");
        return 1;
      }
      log("gate m3: real-model candidate coherence dogfood is recorded");
    }
    log("gate m3: partial deliverable lifecycle/profile/derivation/staleness scope passed");
    return 0;
  }

  if (skipDogfood) {
    log("!!! TODO: M1 DOGFOOD WAS SKIPPED — RUN THE REAL CREATOR EPISODE BEFORE SIGN-OFF !!!");
  } else {
    let dogfood;
    try {
      dogfood = readDogfoodReport("m1");
    } catch (dogfoodError) {
      error(`gate m1: missing docs/dogfood/M1-episode.md: ${dogfoodError.message}`);
      return 1;
    }
    const missing = validateDogfoodReport(dogfood);
    if (missing.length > 0) {
      error(`gate m1: dogfood report is incomplete; missing ${missing.join(", ")}`);
      return 1;
    }
    log("gate m1: dogfood report is complete");
  }

  let reportPath;
  try {
    reportPath = writeGateReport({
      date: currentDate(),
      dogfoodSkipped: skipDogfood,
      milestone,
      traceabilityCount,
    });
  } catch (reportError) {
    error(`gate m1: could not emit gate report: ${reportError.message}`);
    return 1;
  }
  log(`gate m1: wrote ${path.relative(process.cwd(), reportPath)}`);
  log("gate m1: all automated milestone checks passed");
  return 0;
}

export function parseGateArguments(args) {
  const normalized = args.filter((argument) => argument !== "--");
  const milestone = normalized[0];
  const options = normalized.slice(1);
  const unknown = options.filter((argument) => argument !== "--skip-dogfood");
  if (unknown.length > 0) throw new Error(`Unknown gate option(s): ${unknown.join(", ")}`);
  return { milestone, skipDogfood: options.includes("--skip-dogfood") };
}

export function main(args = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseGateArguments(args);
  } catch (argumentError) {
    console.error(`gate: ${argumentError.message}`);
    return 1;
  }
  return runGate(parsed.milestone, { skipDogfood: parsed.skipDogfood });
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) process.exitCode = main();
