import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateFixtureManifest } from "./fixture-spec.mjs";

export const M0_COMMANDS = Object.freeze([
  Object.freeze({ args: ["fixtures"], command: "pnpm" }),
  Object.freeze({ args: ["scripts/video-zero.mjs"], command: "node" }),
  Object.freeze({ args: ["check:conventions"], command: "pnpm" }),
  Object.freeze({ args: ["-r", "typecheck"], command: "pnpm" }),
  Object.freeze({ args: ["exec", "vitest", "run"], command: "pnpm" }),
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

const DEFERRED_M0_STEPS = Object.freeze([
  "dedicated contract, golden, e2e, and AC suites (root Vitest currently selects empty specialized projects)",
  "milestone traceability-status enforcement",
  "dogfood evidence",
  "gate report emission",
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

export function runGate(
  milestone,
  {
    error = console.error,
    log = console.log,
    platform = process.platform,
    readFixtureManifest = readGeneratedFixtureManifest,
    runCommand = spawnCommand,
  } = {},
) {
  if (milestone !== "m0") {
    error(`gate ${milestone ?? "<missing>"}: gate not yet defined`);
    return 1;
  }

  for (const { command, args } of M0_COMMANDS) {
    const display = commandText(command, args);
    const executable =
      platform === "win32" && command === "pnpm" ? `${command}.cmd` : command;
    log(`==> ${display}`);

    let result;
    try {
      result = runCommand(executable, args);
    } catch (spawnError) {
      error(`gate m0: could not run ${display}: ${spawnError.message}`);
      return 1;
    }

    if (result?.error) {
      error(`gate m0: could not run ${display}: ${result.error.message}`);
      return 1;
    }
    if (result?.status !== 0) {
      const detail = result?.signal
        ? `terminated by signal ${result.signal}`
        : `exited with status ${result?.status ?? "unknown"}`;
      error(`gate m0: ${display} ${detail}`);
      return typeof result?.status === "number" && result.status !== 0
        ? result.status
        : 1;
    }
  }

  let manifest;
  try {
    manifest = readFixtureManifest();
  } catch (manifestError) {
    error(
      `gate m0: could not read .fixtures/manifest.json: ${manifestError.message}`,
    );
    return 1;
  }
  const manifestErrors = validateFixtureManifest(manifest);
  if (manifestErrors.length > 0) {
    error(`gate m0: invalid fixture manifest: ${manifestErrors.join("; ")}`);
    return 1;
  }

  log("gate m0: fixture manifest contains every required entry");
  log("gate m0: implementable scaffold checks passed");
  log("Deferred §14.8 scaffold-era steps:");
  for (const step of DEFERRED_M0_STEPS) {
    log(`- ${step}`);
  }
  return 0;
}

export function main(args = process.argv.slice(2)) {
  return runGate(args[0]);
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) {
  process.exitCode = main();
}
