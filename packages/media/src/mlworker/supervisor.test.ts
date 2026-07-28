import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MlworkerSupervisor } from "./supervisor.js";
import type { MlworkerStateEvent } from "./types.js";

const temporaryDirectories: string[] = [];
const supervisors: MlworkerSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(async (supervisor) => supervisor.stop()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

async function fakeWorker(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "guyditor-mlworker-test-"));
  temporaryDirectories.push(directory);
  const script = path.join(directory, "worker.mjs");
  await writeFile(script, source);
  return script;
}

function supervisorFor(
  script: string,
  options: {
    onStateChange?: (event: MlworkerStateEvent) => void;
    timing?: {
      backoffMs?: readonly number[];
      cancelTimeoutMs?: number;
      failureWindowMs?: number;
      handshakeTimeoutMs?: number;
      livenessTimeoutMs?: number;
      pingIntervalMs?: number;
    };
  } = {},
): MlworkerSupervisor {
  const supervisor = new MlworkerSupervisor({
    command: process.execPath,
    args: [script],
    env: { GUYDITOR_TEST_VALUE: "visible" },
    ...options,
  });
  supervisors.push(supervisor);
  return supervisor;
}

const WORKING_WORKER = String.raw`
import readline from "node:readline";
const hello = {
  jsonrpc: "2.0",
  method: "mlworker.hello",
  params: {
    protocol: 1,
    workerVersion: "test",
    python: "3.11.9",
    device: { type: "cpu" },
    capabilities: [{ task: "transcribe", engine: "fake", engineVersion: "1" }],
    testEnv: [process.env.PYTHONNOUSERSITE, process.env.GUYDITOR_TEST_VALUE],
  },
};
process.stdout.write(JSON.stringify(hello) + "\n");
const timers = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "ping") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { pong: true } }) + "\n");
  } else if (message.method === "transcribe") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", method: "$/progress",
      params: { taskId: message.params.taskId, progress: 0.5, stage: "decode" },
    }) + "\n");
    const timer = setTimeout(() => {
      timers.delete(message.params.taskId);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { segments: [] } }) + "\n");
    }, 40);
    timers.set(message.params.taskId, { id: message.id, timer });
  } else if (message.method === "$/cancel") {
    const active = timers.get(message.params.taskId);
    if (active) {
      clearTimeout(active.timer);
      timers.delete(message.params.taskId);
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: active.id,
        error: { code: -32800, message: "cancelled" },
      }) + "\n");
    }
  }
});
`;

// Reports how many tasks the worker sees in flight at once, so a test can prove
// the "one task in flight per worker process" invariant (spec §1.2) holds.
const OVERLAP_REPORTING_WORKER = String.raw`
import readline from "node:readline";
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  method: "mlworker.hello",
  params: {
    protocol: 1,
    workerVersion: "test",
    python: "3.11.9",
    device: { type: "cpu" },
    capabilities: [
      { task: "transcribe", engine: "fake", engineVersion: "1" },
      { task: "vad", engine: "fake", engineVersion: "1" },
    ],
  },
}) + "\n");
let inFlight = 0;
let peak = 0;
let served = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "ping") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { pong: true } }) + "\n");
    return;
  }
  if (message.method !== "transcribe" && message.method !== "vad") return;
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  const dispatchOrder = ++served;
  setTimeout(() => {
    inFlight -= 1;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { taskId: message.params.taskId, peakInFlight: peak, dispatchOrder },
    }) + "\n");
  }, 60);
});
`;

describe("MlworkerSupervisor", () => {
  it("queues a concurrent task instead of rejecting it, keeping one task in flight", async () => {
    const script = await fakeWorker(OVERLAP_REPORTING_WORKER);
    const supervisor = supervisorFor(script);

    const [first, second] = await Promise.all([
      supervisor.runTask("transcribe", { taskId: "job_concurrent" }),
      supervisor.runTask("vad", { taskId: "job_secondtask" }),
    ]);

    expect(first).toMatchObject({ ok: true, value: { peakInFlight: 1 } });
    expect(second).toMatchObject({ ok: true, value: { peakInFlight: 1 } });
  });

  it("serializes a burst of concurrent tasks in submission order", async () => {
    const script = await fakeWorker(OVERLAP_REPORTING_WORKER);
    const supervisor = supervisorFor(script);

    const taskIds = [
      "job_burstaaaaa",
      "job_burstbbbbb",
      "job_burstccccc",
      "job_burstddddd",
    ];
    const results = await Promise.all(
      taskIds.map(async (taskId) => supervisor.runTask("transcribe", { taskId })),
    );

    for (const result of results) {
      expect(result).toMatchObject({ ok: true, value: { peakInFlight: 1 } });
    }
    // Assert the order the *worker* saw, not the order Promise.all returns:
    // results[i] always corresponds to taskIds[i] because responses are routed
    // by JSON-RPC id, so comparing task IDs would pass under any wake order.
    expect(results.map((result) =>
      result.ok ? (result.value as { dispatchOrder: number }).dispatchOrder : 0))
      .toEqual([1, 2, 3, 4]);
  });

  it("fails a queued task when the worker is stopped and does not respawn", async () => {
    const script = await fakeWorker(OVERLAP_REPORTING_WORKER);
    const states: MlworkerStateEvent[] = [];
    const supervisor = supervisorFor(script, {
      onStateChange: (event) => states.push(event),
    });

    const running = supervisor.runTask("transcribe", { taskId: "job_stopheldaa" });
    while (supervisor.state !== "ready") {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
    }
    const queued = supervisor.runTask("vad", { taskId: "job_stopqueued" });
    await supervisor.stop();

    expect(await running).toMatchObject({
      ok: false,
      error: { code: "E_MLWORKER_DOWN" },
    });
    expect(await queued).toMatchObject({
      ok: false,
      error: { code: "E_MLWORKER_DOWN" },
    });
    // A drained waiter must not have restarted the worker behind the stop.
    expect(states.at(-1)?.state).toBe("stopped");
    expect(supervisor.state).toBe("stopped");
  });

  it("cancels a task that is aborted while queued behind another task", async () => {
    const script = await fakeWorker(OVERLAP_REPORTING_WORKER);
    const supervisor = supervisorFor(script);
    const controller = new AbortController();

    const running = supervisor.runTask("transcribe", { taskId: "job_holdslotaa" });
    const queued = supervisor.runTask(
      "vad",
      { taskId: "job_queuedwait" },
      { signal: controller.signal },
    );
    controller.abort();

    expect(await queued).toMatchObject({
      ok: false,
      error: { code: "E_MLWORKER_CANCELLED" },
    });
    expect(await running).toMatchObject({ ok: true });
  });

  it("handshakes, reports state, forwards progress, and resets failures on success", async () => {
    const script = await fakeWorker(WORKING_WORKER);
    const states: MlworkerStateEvent[] = [];
    const supervisor = supervisorFor(script, {
      onStateChange: (event) => states.push(event),
    });

    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    expect(started.value).toMatchObject({
      protocol: 1,
      capabilities: [{ task: "transcribe" }],
      testEnv: ["1", "visible"],
    });

    const progress: number[] = [];
    const result = await supervisor.runTask(
      "transcribe",
      { taskId: "job_testtask22" },
      { onProgress: (update) => progress.push(update.progress) },
    );
    expect(result).toEqual({ ok: true, value: { segments: [] } });
    expect(progress).toEqual([0.5]);
    expect(supervisor.failureCount).toBe(0);
    expect(states.map(({ state }) => state)).toEqual(["starting", "ready"]);
  });

  it("maps cancellation acknowledgement and accepts the next task", async () => {
    const script = await fakeWorker(WORKING_WORKER);
    const supervisor = supervisorFor(script);
    const controller = new AbortController();

    const running = supervisor.runTask(
      "transcribe",
      { taskId: "job_canceltest" },
      {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      },
    );
    const cancelled = await running;
    expect(cancelled).toMatchObject({
      ok: false,
      error: { code: "E_MLWORKER_CANCELLED", retry: "safe" },
    });

    const next = await supervisor.runTask(
      "transcribe",
      { taskId: "job_aftercan22" },
    );
    expect(next.ok).toBe(true);
  });

  it("honors a signal aborted while the worker is handshaking", async () => {
    const script = await fakeWorker(
      `setTimeout(() => process.stdout.write(JSON.stringify({\n` +
      `  jsonrpc: "2.0", method: "mlworker.hello", params: {\n` +
      `    protocol: 1, workerVersion: "test", python: "3.11.9",\n` +
      `    device: { type: "cpu" }, capabilities: [],\n` +
      `  },\n` +
      `}) + "\\n"), 50); setInterval(() => {}, 1000);\n`,
    );
    const supervisor = supervisorFor(script);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await supervisor.runTask(
      "vad",
      { taskId: "job_duringst22", audioPath: "/tmp/audio.wav" },
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_MLWORKER_CANCELLED" },
    });
  });

  it("supports a user-forced restart and returns to ready", async () => {
    const script = await fakeWorker(WORKING_WORKER);
    const states: MlworkerStateEvent[] = [];
    const supervisor = supervisorFor(script, {
      onStateChange: (event) => states.push(event),
    });
    expect((await supervisor.start()).ok).toBe(true);

    const restarted = await supervisor.restart();

    expect(restarted.ok).toBe(true);
    expect(supervisor.state).toBe("ready");
    expect(supervisor.failureCount).toBe(0);
    expect(states.map(({ state }) => state)).toEqual([
      "starting",
      "ready",
      "stopped",
      "starting",
      "ready",
    ]);
  });

  it("marks the worker unavailable after three consecutive handshake failures", async () => {
    const script = await fakeWorker("setInterval(() => {}, 1000);\n");
    const states: MlworkerStateEvent[] = [];
    const supervisor = supervisorFor(script, {
      onStateChange: (event) => states.push(event),
      timing: {
        backoffMs: [5, 10, 25],
        handshakeTimeoutMs: 15,
        livenessTimeoutMs: 100,
        pingIntervalMs: 20,
      },
    });

    const started = await supervisor.start();
    expect(started).toMatchObject({
      ok: false,
      error: {
        code: "E_MLWORKER_DOWN",
        acceptedStateChanged: false,
        retry: "safe",
      },
    });
    if (started.ok) throw new Error("worker unexpectedly started");
    expect(started.error.suggestion).toMatch(/Settings.*safe mode.*reinstall/i);
    expect(supervisor.failureCount).toBe(3);
    expect(states.at(-1)?.state).toBe("unavailable");

    const rejected = await supervisor.runTask("vad", {
      taskId: "job_unavail222",
      audioPath: "/tmp/missing.wav",
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "E_MLWORKER_DOWN" },
    });
  });

  it("does not accumulate process failures beyond the ten-minute window", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "guyditor-failure-window-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "counter.txt");
    const script = await fakeWorker(String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(counterPath)};
let count = 0;
try { count = Number(readFileSync(counterPath, "utf8")); } catch {}
count += 1;
writeFileSync(counterPath, String(count));
if (count >= 3) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", method: "mlworker.hello", params: {
      protocol: 1, workerVersion: "test", python: "3.11.9",
      device: { type: "cpu" }, capabilities: [],
    },
  }) + "\n");
}
setInterval(() => {}, 1000);
`);
    const supervisor = supervisorFor(script, {
      timing: {
        backoffMs: [75, 75, 75],
        failureWindowMs: 50,
        handshakeTimeoutMs: 200,
        livenessTimeoutMs: 1_000,
        pingIntervalMs: 100,
      },
    });

    expect((await supervisor.start()).ok).toBe(true);
    expect(supervisor.failureCount).toBe(1);
    expect(supervisor.state).toBe("ready");
  });
});
