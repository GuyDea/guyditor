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
      "packages/compositor/src/placement.test.ts",
      "packages/compositor/src/motion.test.ts",
      "packages/compositor/src/avoidance.test.ts",
      "packages/compositor/src/pip-operations.test.ts",
    ],
  }),
  Object.freeze({
    command: "pnpm",
    args: [
      "exec", "vitest", "run", "--project", "golden",
      "packages/render/test/golden/ac003.golden.test.ts",
      "packages/render/test/golden/ac005.golden.test.ts",
      "packages/render/test/golden/ac006.golden.test.ts",
    ],
  }),
  Object.freeze({ command: "pnpm", args: ["--filter", "@guyditor/app", "build"] }),
  Object.freeze({
    command: "pnpm",
    args: [
      "--filter", "@guyditor/app", "exec", "playwright", "test",
      "--config", "playwright.config.ts", "e2e/ac/ac003.spec.ts", "e2e/ac/ac006.spec.ts",
    ],
  }),
]);

export const M3_AC_COMMANDS = Object.freeze([
  Object.freeze({
    command: "pnpm",
    args: [
      "exec", "vitest", "run", "--project", "unit",
      "packages/deliver/src/ac008.integration.test.ts",
      "packages/deliver/src/ac011.integration.test.ts",
      "packages/deliver/src/deliverable-service.test.ts",
      "packages/deliver/src/publish.test.ts",
      "packages/deliver/src/publish-service.test.ts",
      "packages/deliver/src/batch-export.test.ts",
      "packages/deliver/src/profile.test.ts",
      "packages/core/src/deliverables/operations.test.ts",
      "packages/core/src/deliverables/staleness.test.ts",
      "packages/agent/src/gateway.test.ts",
      "packages/transcript/src/range-operations.test.ts",
      "packages/render/src/deliverable-lifecycle.test.ts",
      "packages/render/src/output-set.test.ts",
      "packages/render/src/cover-analysis.test.ts",
      "packages/render/src/thumbnail.test.ts",
      "packages/app/src/renderer/panels/StatusStripPanel.test.ts",
      "packages/app/src/renderer/panels/PublishPanel.test.ts",
    ],
  }),
  Object.freeze({
    command: "pnpm",
    args: [
      "exec", "vitest", "run", "--project", "golden",
      "packages/render/test/golden/ac007.golden.test.ts",
    ],
  }),
  Object.freeze({ command: "pnpm", args: ["--filter", "@guyditor/app", "build"] }),
  Object.freeze({
    command: "pnpm",
    args: [
      "--filter", "@guyditor/app", "exec", "playwright", "test",
      "--config", "playwright.config.ts", "e2e/ac/ac011.spec.ts",
    ],
  }),
]);

export const M4_PARTIAL_AC_COMMANDS = Object.freeze([
  Object.freeze({
    command: "pnpm",
    args: [
      "exec", "vitest", "run", "--project", "unit",
      "packages/agent/src/ac010.integration.test.ts",
      "packages/agent/src/skills/registry.test.ts",
      "packages/agent/src/skills/project-registry.test.ts",
      "packages/agent/src/skills/preference-pack.test.ts",
      "packages/agent/src/gateway.test.ts",
      "packages/core/src/operations/skill-operation.test.ts",
      "packages/app/src/main/service-host.test.ts",
      "packages/app/src/main/surfaces.test.ts",
      "packages/app/src/renderer/panels/SkillsPanel.test.ts",
    ],
  }),
  Object.freeze({ command: "pnpm", args: ["--filter", "@guyditor/app", "build"] }),
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
  if (normalized.length !== 1 || !["m1", "m2", "m3", "m4"].includes(normalized[0])) {
    console.error(`test:ac: expected milestone m1, m2, m3, or m4, received ${normalized.join(" ") || "<missing>"}`);
    return 1;
  }
  const milestone = normalized[0];
  const commands = milestone === "m1"
    ? M1_AC_COMMANDS
    : milestone === "m2" ? M2_AC_COMMANDS
    : milestone === "m3" ? M3_AC_COMMANDS : M4_PARTIAL_AC_COMMANDS;
  for (const { command, args: commandArgs } of commands) {
    const status = run(command, commandArgs);
    if (status !== 0) return status;
  }
  console.log(milestone === "m1"
    ? "test:ac m1: AC-001, AC-002, AC-004, and AC-009 passed"
    : milestone === "m2"
      ? "test:ac m2: AC-003 captions, AC-005 keyed presenter diagnostics, and AC-006 semantic PiP passed"
      : milestone === "m3"
        ? "test:ac m3: AC-007 output sets, AC-008 lifecycle, and AC-011 upload packaging passed"
        : "test:ac m4: AC-010 exact preference reuse and controlled skill evolution passed");
  return 0;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) process.exitCode = main();
