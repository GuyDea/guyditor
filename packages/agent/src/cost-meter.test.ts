import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditLog,
  CostMeter,
  DEFAULT_BUDGETS,
} from "./index.js";
import type {
  BudgetConfig,
  CostContext,
  CostEstimate,
  ExternalCallActual,
} from "./index.js";

const directories: string[] = [];
const NOW = new Date("2026-07-19T14:00:00.000Z");

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function userDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guyditor-cost-"));
  directories.push(directory);
  return directory;
}

function context(
  sessionId: string,
  projectId: string,
  taskId: string,
): CostContext {
  return { sessionId, projectId, taskId, initiator: "agent" };
}

function estimate(amount: number, adapterId = "adp_aaaaaaaaaa"): CostEstimate {
  return {
    adapterId,
    currency: "USD",
    amount,
    units: { inputTokens: 1_000, outputTokens: 100 },
    confidence: "pricebook",
  };
}

function actual(
  callContext: CostContext,
  estimated: CostEstimate,
  actualUsd: number,
): ExternalCallActual {
  return {
    context: callContext,
    estimate: estimated,
    provider: "provider-test",
    purpose: "critic_request",
    dataClassesSent: ["metadata", "prompt", "transcript"],
    payloadSummary: { transcriptWords: 250, promptChars: 90 },
    units: { inputTokens: 1_000, outputTokens: 100 },
    actualUsd,
    outcome: "ok",
    durationMs: 200,
  };
}

const NO_BUDGETS: BudgetConfig = {
  task: { warnUsd: null, capUsd: null },
  episode: { warnUsd: null, capUsd: null },
  cumulative: { warnUsd: null, capUsd: null },
};

describe("CostMeter", () => {
  it("persists estimated and actual totals across task, episode, and lifetime", () => {
    const userDir = userDirectory();
    const audit = new AuditLog({ userDir, now: () => NOW });
    let meter = CostMeter.open({ userDir, auditLog: audit, budgets: NO_BUDGETS, now: () => NOW });
    const taskA = context("ses_aaaaaaaaaa", "prj_aaaaaaaaaa", "task-a");
    const taskB = context("ses_bbbbbbbbbb", "prj_aaaaaaaaaa", "task-b");
    const taskC = context("ses_cccccccccc", "prj_bbbbbbbbbb", "task-c");

    const first = meter.record(actual(taskA, estimate(1), 0.8));
    meter.record(actual(taskB, estimate(2), 2.2));
    meter.record(actual(taskC, estimate(4), 3.5));

    expect(first.externalCall).toMatchObject({
      type: "external.call",
      costUsd: { estimated: 1, actual: 0.8 },
      units: { inputTokens: 1_000, outputTokens: 100 },
    });
    expect(first.charge).toMatchObject({
      type: "cost.charge",
      externalCallSeq: first.externalCall.seq,
      totals: { taskUsd: 0.8, episodeUsd: 0.8, cumulativeUsd: 0.8 },
    });
    expect(meter.statusForTask(taskA.projectId, taskA.taskId)).toMatchObject({
      taskUsd: 0.8,
      episodeUsd: 3,
      cumulativeUsd: 6.5,
      estimated: { taskUsd: 1, episodeUsd: 3, cumulativeUsd: 7 },
      levels: {
        task: { estimatedUsd: 1, actualUsd: 0.8 },
        episode: { estimatedUsd: 3, actualUsd: 3 },
        lifetime: { estimatedUsd: 7, actualUsd: 6.5 },
      },
    });
    expect(meter.databasePath).toBe(join(userDir, "state", "costmeter.sqlite"));
    expect(existsSync(meter.databasePath)).toBe(true);
    meter.close();

    meter = CostMeter.open({ userDir, auditLog: audit, budgets: NO_BUDGETS, now: () => NOW });
    expect(meter.statusForTask(taskB.projectId, taskB.taskId)).toMatchObject({
      taskUsd: 2.2,
      episodeUsd: 3,
      cumulativeUsd: 6.5,
      estimated: { taskUsd: 2, episodeUsd: 3, cumulativeUsd: 7 },
    });
    const replay = audit.readSession(taskA.sessionId);
    expect(replay.records.map(({ type }) => type)).toEqual(["external.call", "cost.charge"]);
    meter.close();
  });

  it("uses strict thresholds, cap precedence, and all three budget levels", () => {
    expect(DEFAULT_BUDGETS).toEqual({
      task: { warnUsd: 1, capUsd: 5 },
      episode: { warnUsd: 25, capUsd: null },
      cumulative: { warnUsd: 100, capUsd: null },
    });
    const cases: Array<{
      name: string;
      budgets: BudgetConfig;
      amount: number;
      expected: object;
      event?: { level: string; kind: string };
    }> = [
      {
        name: "at warning threshold proceeds",
        budgets: { ...NO_BUDGETS, task: { warnUsd: 1, capUsd: 2 } },
        amount: 1,
        expected: { verdict: "proceed" },
      },
      {
        name: "above task warning warns",
        budgets: { ...NO_BUDGETS, task: { warnUsd: 1, capUsd: 2 } },
        amount: 1.01,
        expected: { verdict: "warn", level: "task", confirmToken: "confirm-test" },
        event: { level: "task", kind: "warn" },
      },
      {
        name: "above task cap blocks",
        budgets: { ...NO_BUDGETS, task: { warnUsd: 1, capUsd: 2 } },
        amount: 2.01,
        expected: { verdict: "blocked", level: "task" },
        event: { level: "task", kind: "cap_block" },
      },
      {
        name: "episode cap outranks task warning",
        budgets: {
          ...NO_BUDGETS,
          task: { warnUsd: 0.5, capUsd: null },
          episode: { warnUsd: null, capUsd: 1 },
        },
        amount: 1.01,
        expected: { verdict: "blocked", level: "episode" },
        event: { level: "episode", kind: "cap_block" },
      },
      {
        name: "cumulative warning is surfaced",
        budgets: { ...NO_BUDGETS, cumulative: { warnUsd: 0.5, capUsd: null } },
        amount: 0.51,
        expected: { verdict: "warn", level: "cumulative", confirmToken: "confirm-test" },
        event: { level: "cumulative", kind: "warn" },
      },
    ];

    for (const entry of cases) {
      const userDir = userDirectory();
      const audit = new AuditLog({ userDir, now: () => NOW });
      const meter = CostMeter.open({
        userDir,
        auditLog: audit,
        budgets: entry.budgets,
        now: () => NOW,
        confirmTokenFactory: () => "confirm-test",
      });
      const callContext = context("ses_aaaaaaaaaa", "prj_aaaaaaaaaa", "task-a");

      expect(meter.preflight(estimate(entry.amount), callContext), entry.name)
        .toMatchObject(entry.expected);
      const budgetEvents = audit.readSession(callContext.sessionId).records
        .filter(({ type }) => type === "budget.event");
      if (entry.event === undefined) expect(budgetEvents, entry.name).toEqual([]);
      else expect(budgetEvents, entry.name).toEqual([expect.objectContaining(entry.event)]);
      meter.close();
    }
  });

  it("rejects non-USD estimates before comparing USD budgets", () => {
    const userDir = userDirectory();
    const meter = CostMeter.open({
      userDir,
      auditLog: new AuditLog({ userDir }),
      budgets: NO_BUDGETS,
    });

    expect(() => meter.preflight(
      { ...estimate(1), currency: "EUR" },
      context("ses_aaaaaaaaaa", "prj_aaaaaaaaaa", "task-a"),
    )).toThrow(/USD/u);
    expect(() => meter.preflight(
      { ...estimate(1), units: null as unknown as object },
      context("ses_aaaaaaaaaa", "prj_aaaaaaaaaa", "task-a"),
    )).toThrow(/units/u);
    meter.close();
  });
});
