import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const M1_AC_COMMANDS = Object.freeze([
  Object.freeze({
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "--project",
      "unit",
      "packages/core/src/ac002.integration.test.ts",
    ],
  }),
  Object.freeze({
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "--project",
      "golden",
      "packages/render/test/golden/ac001.golden.test.ts",
      "packages/render/test/golden/ac009.golden.test.ts",
    ],
  }),
  Object.freeze({
    command: "pnpm",
    args: ["--filter", "@guyditor/app", "build"],
  }),
  Object.freeze({
    command: "pnpm",
    args: [
      "--filter",
      "@guyditor/app",
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.config.ts",
      "e2e/ac/ac001.spec.ts",
      "e2e/ac/ac004.spec.ts",
    ],
  }),
]);

export const M2_AC_COMMANDS = Object.freeze([
  Object.freeze({
    command: "pnpm",
    args: [
      "exec", "vitest", "run", "--project", "unit",
      "packages/transcript/src/captions/caption.test.ts",
      "packages/transcript/src/captions/caption.prop.test.ts",
      "packages/transcript/src/captions/operations.test.ts",
    ],
  }),
  Object.freeze({
    command: "pnpm",
    args: [
      "exec", "vitest", "run", "--project", "golden",
      "packages/render/test/golden/ac003.golden.test.ts",
    ],
  }),
  Object.freeze({ command: "pnpm", args: ["--filter", "@guyditor/app", "build"] }),
  Object.freeze({
    command: "pnpm",
    args: [
      "--filter", "@guyditor/app", "exec", "playwright", "test",
      "--config", "playwright.config.ts", "e2e/ac/ac003.spec.ts",
    ],
  }),
]);

function run(command, args) {
  const executable = process.platform === "win32" && command === "pnpm"
    ? `${command}.cmd`
    : command;
  console.log(`==> ${[command, ...args].join(" ")}`);
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  return 0;
}

export function main(args = process.argv.slice(2)) {
  const normalized = args.filter((argument) => argument !== "--");
  if (normalized.length !== 1 || (normalized[0] !== "m1" && normalized[0] !== "m2")) {
    console.error(`test:ac: expected milestone m1 or m2, received ${normalized.join(" ") || "<missing>"}`);
    return 1;
  }
  const milestone = normalized[0];
  const commands = milestone === "m1" ? M1_AC_COMMANDS : M2_AC_COMMANDS;
  for (const { command, args: commandArgs } of commands) {
    const status = run(command, commandArgs);
    if (status !== 0) return status;
  }
  console.log(milestone === "m1"
    ? "test:ac m1: AC-001, AC-002, AC-004, and AC-009 passed"
    : "test:ac m2: AC-003 caption correction, four-output export, and drift checks passed");
  return 0;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) process.exitCode = main();
