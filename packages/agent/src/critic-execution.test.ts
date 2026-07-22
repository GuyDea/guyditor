import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JobQueue } from "../../core/src/index.js";

import {
  AdapterRegistry,
  AuditLog,
  CostMeter,
  CriticExecutionService,
  StubCriticAdapter,
} from "./index.js";
import type { CritiqueRequest, DataBoundaryPolicy } from "./index.js";

const roots: string[] = [];
const NOW = new Date("2026-07-22T12:00:00.000Z");
const NO_BUDGETS = {
  task: { warnUsd: null, capUsd: null },
  episode: { warnUsd: null, capUsd: null },
  cumulative: { warnUsd: null, capUsd: null },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "guyditor-critic-"));
  roots.push(value);
  return value;
}

function request(): CritiqueRequest {
  return {
    critiqueId: "crt_aaaaaaaaaa",
    subject: {
      deliverableId: "dlv_aaaaaaaaaa",
      proxyFile: { path: ".guyditor/cache/proxies/ast_aaaaaaaaaa.mp4" },
      range: {
        startSeconds: 0,
        durationSeconds: 10,
        cutCount: 7,
        silenceSeconds: 3.5,
        loudnessLufs: [-18, -11, -17, -10],
      },
    },
    rubric: [{ id: "pacing", source: "inline", text: "Keep the opening legible." }],
    questions: ["Does the pacing leave enough time to understand the promise?"],
  };
}

function allowed(adapterId: string): DataBoundaryPolicy {
  return {
    killSwitch: false,
    allowedClasses: ["metadata", "prompt"],
    perAdapter: { [adapterId]: ["metadata", "prompt", "video"] },
  };
}

describe("FR-703 critic adviser path", () => {
  it("returns deterministic rule-derived critique without producing operations", async () => {
    const adapter = new StubCriticAdapter();

    const first = await adapter.critique(request());
    const second = await adapter.critique(request());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      critiqueId: "crt_aaaaaaaaaa",
      adapterId: "adp_4444444444",
      model: "stub-critic-v1",
      findings: [
        expect.objectContaining({
          severity: "major",
          range: request().subject.range,
          observation: expect.stringMatching(/cut density/i),
          suggestion: expect.any(String),
        }),
        expect.objectContaining({ observation: expect.stringMatching(/silence ratio/i) }),
        expect.objectContaining({ observation: expect.stringMatching(/loudness/i) }),
      ],
    });
    expect(Object.keys(first.findings[0]!).sort()).toEqual([
      "id", "observation", "range", "severity", "suggestion",
    ]);
    expect(JSON.stringify(first)).not.toMatch(/"op"|proposal|accepted state/iu);
  });

  it("blocks video at the kill switch, returns E_DATA_BOUNDARY, and audits no transfer", async () => {
    const projectRoot = await root();
    const userDir = await root();
    const audit = new AuditLog({ userDir, now: () => NOW });
    const meter = CostMeter.open({ userDir, auditLog: audit, budgets: NO_BUDGETS, now: () => NOW });
    const registry = new AdapterRegistry();
    const { queue: jobs } = JobQueue.open(":memory:");
    let calls = 0;
    const stub = new StubCriticAdapter({ onCritique: () => { calls += 1; } });
    registry.register(stub);
    const service = new CriticExecutionService({
      projectRoot,
      registry,
      jobs,
      costMeter: meter,
      policy: {
        ...allowed(stub.id),
        killSwitch: true,
      },
      now: () => NOW,
    });

    const result = await service.request({
      adapterId: stub.id,
      request: request(),
      context: {
        sessionId: "ses_aaaaaaaaaa",
        projectId: "prj_aaaaaaaaaa",
        taskId: "job_aaaaaaaaaa",
        initiator: "agent",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_DATA_BOUNDARY",
        acceptedStateChanged: false,
        retry: "none",
        affected: ["adp_4444444444", "video"],
      },
    });
    expect(calls).toBe(0);
    expect(jobs.list({ kind: "critic.review" })).toHaveLength(0);
    expect(audit.readSession("ses_aaaaaaaaaa").records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "external.call",
        adapterId: stub.id,
        purpose: "critic_request:data_boundary_blocked",
        dataClassesSent: [],
        outcome: "error",
      }),
    ]));
    jobs.close();
    meter.close();
  });

  it("cost-meters, audits, and caches an allowed proxy-video critique", async () => {
    const projectRoot = await root();
    const userDir = await root();
    const audit = new AuditLog({ userDir, now: () => NOW });
    const meter = CostMeter.open({ userDir, auditLog: audit, budgets: NO_BUDGETS, now: () => NOW });
    const registry = new AdapterRegistry();
    const { queue: jobs } = JobQueue.open(":memory:");
    const stub = new StubCriticAdapter();
    registry.register(stub);
    expect(registry.resolveCritic(stub.id)).toBe(stub);
    const service = new CriticExecutionService({
      projectRoot,
      registry,
      jobs,
      costMeter: meter,
      policy: allowed(stub.id),
      now: () => NOW,
    });

    const result = await service.request({
      adapterId: stub.id,
      request: request(),
      context: {
        sessionId: "ses_bbbbbbbbbb",
        projectId: "prj_aaaaaaaaaa",
        taskId: "job_bbbbbbbbbb",
        initiator: "agent",
      },
    });

    expect(result).toMatchObject({ ok: true, value: { critiqueId: "crt_aaaaaaaaaa" } });
    expect(jobs.list({ kind: "critic.review" })).toEqual([
      expect.objectContaining({ kind: "critic.review", state: "done", progress: 1 }),
    ]);
    await expect(readFile(
      join(projectRoot, ".guyditor/cache/critiques/crt_aaaaaaaaaa.json"),
      "utf8",
    )).resolves.toContain('"adapterId": "adp_4444444444"');
    expect(audit.readSession("ses_bbbbbbbbbb").records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "external.call",
        dataClassesSent: ["metadata", "prompt", "video"],
        units: { seconds: 10 },
        outcome: "ok",
      }),
      expect.objectContaining({ type: "cost.charge", costUsd: 0 }),
    ]));
    jobs.close();
    meter.close();
  });

  it("has no direct OperationEngine dependency in the critic execution boundary", async () => {
    const source = await readFile(new URL("./critic-execution.ts", import.meta.url), "utf8");
    expect(source).not.toContain("OperationEngine");
  });
});
