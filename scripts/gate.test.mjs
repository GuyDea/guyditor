import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { runGate } from "./gate.mjs";

test("m0 runs the implementable checks sequentially and prints deferred work", () => {
  const commands = [];
  const output = [];

  const status = runGate("m0", {
    log: (message) => output.push(message),
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(commands, [
    ["pnpm", "check:conventions"],
    ["pnpm", "-r", "typecheck"],
    ["pnpm", "exec", "vitest", "run"],
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
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: commands.length === 2 ? 7 : 0 };
    },
  });

  assert.equal(status, 7);
  assert.deepEqual(commands, [
    ["pnpm", "check:conventions"],
    ["pnpm", "-r", "typecheck"],
  ]);
});

test("m0 uses the Windows pnpm executable without changing command displays", () => {
  const commands = [];
  const output = [];

  const status = runGate("m0", {
    log: (message) => output.push(message),
    platform: "win32",
    runCommand: (command, args) => {
      commands.push([command, ...args]);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(
    commands.map(([command]) => command),
    ["pnpm.cmd", "pnpm.cmd", "pnpm.cmd"],
  );
  assert.match(output[0], /^==> pnpm check:conventions$/);
});

for (const milestone of [undefined, "m1", "m2", "m3", "m4", "unsupported"]) {
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
