import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnnotationService,
  createProject,
  JobQueue,
  success,
} from "../../core/src/index.js";
import type {
  IdPrefix,
  ProjectStore,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { runStubDirector } from "../test/stub-director/index.js";
import { AuditLog } from "./audit-log.js";
import { AgentGateway } from "./gateway.js";
import { SkillRegistry } from "./skills/index.js";
import type { ResolvedSkill } from "./skills/index.js";

const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

function ids(prefix: IdPrefix): string {
  const values: Partial<Record<IdPrefix, string>> = {
    ann: "ann_bbbbbbbbbb",
    prp: "prp_cccccccccc",
    txn: "txn_dddddddddd",
  };
  return values[prefix] ?? `${prefix}_eeeeeeeeee`;
}

async function annotatedProject(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-gateway-project-"));
  temporaryDirectories.push(root);
  const model = projectFixture();
  model.skills = [];
  model.sidecars[0]!.inputs = [];
  model.sidecars[0]!.sha256 = createHash("sha256")
    .update(EMPTY_ANNOTATIONS)
    .digest("hex");
  const store = await valueOf(createProject(root, model, {
    appVersion: "0.0.0-test",
    idFactory: ids,
    now: () => new Date("2026-07-19T08:00:00.000Z"),
  }));
  await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");
  const annotations = new AnnotationService({
    appVersion: "0.0.0-test",
    idFactory: ids,
    now: () => new Date("2026-07-19T08:01:00.000Z"),
  });
  await valueOf(annotations.execute(store, [{
    op: "annotation.create",
    params: {
      annotation: {
        id: "ann_bbbbbbbbbb",
        shape: "rect",
        body: "Tighten this exact frame",
        style: { color: "#f2b84b", strokeWidth: 0.004 },
        geometry: {
          kind: "rect",
          origin: { x: 0.25, y: 0.25 },
          size: { x: 0.25, y: 0.25 },
        },
        anchor: {
          kind: "timeline",
          sequenceId: "seq_aaaaaaaaaa",
          frame: { frames: 8, fps: "24/1" },
        },
        extent: { frames: 0, fps: "24/1" },
        canvasRef: {
          sequenceId: "seq_aaaaaaaaaa",
          deliverableId: "dlv_aaaaaaaaaa",
          aspect: "16:9",
        },
        state: "open",
        blocking: false,
        author: { kind: "human", id: "creator" },
        createdAt: "2026-07-19T08:01:00.000Z",
        history: [],
      },
    },
  }]));
  return store;
}

describe("AgentGateway", () => {
  it("serves the AC-004 tools over authenticated loopback MCP without mutating accepted state", async () => {
    const store = await annotatedProject();
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-gateway-user-"));
    temporaryDirectories.push(userDirectory);
    const stateDirectory = join(userDirectory, "state");
    const audit = new AuditLog({
      userDir: userDirectory,
      now: (() => {
        let second = 0;
        return () => new Date(`2026-07-19T08:02:${String(second++).padStart(2, "0")}.000Z`);
      })(),
    });
    const { queue: jobs } = JobQueue.open(":memory:");
    const gateway = new AgentGateway({
      auditLog: audit,
      jobQueue: jobs,
      project: store,
      stateDirectory,
      director: {
        profileId: "adp_bbbbbbbbbb",
        modelLabel: "deterministic-stub",
        locality: "local",
      },
      sessionIdFactory: () => "ses_bbbbbbbbbb",
    });
    const started = await gateway.start();

    try {
      expect(started.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
      expect(started.token).toMatch(/^[0-9a-f]{64}$/u);
      const stateFile = JSON.parse(await readFile(started.stateFile, "utf8")) as {
        endpoint: string;
        token: string;
      };
      expect(stateFile).toEqual({ endpoint: started.endpoint, token: started.token });
      expect((await stat(started.stateFile)).mode & 0o777).toBe(0o600);
      await chmod(started.stateFile, 0o600);

      const unauthenticated = await fetch(started.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "unauthenticated", version: "1" },
          },
        }),
      });
      expect(unauthenticated.status).toBe(401);

      const acceptedBefore = store.currentProject.revision;
      const result = await runStubDirector({
        annotationId: "ann_bbbbbbbbbb",
        clipId: "clp_aaaaaaaaaa",
        gatewayStateFile: started.stateFile,
        trimFrames: 2,
      });

      expect(result.tools).toEqual([
        "context_package",
        "progress_overview",
        "proposal_create",
        "proposal_get",
      ]);
      expect(result.progress).toMatchObject({ idle: true, aggregateFraction: 1 });
      expect(result.context.requestedFor.annotationId).toBe("ann_bbbbbbbbbb");
      expect(result.context.position.timelineFrame).toEqual({ frames: 8, fps: "24/1" });
      expect(result.proposal.id).toMatch(/^prp_[a-z2-7]{10}$/u);
      expect(result.proposal.addresses).toEqual(["ann_bbbbbbbbbb"]);
      expect(result.status).toMatchObject({
        id: result.proposal.id,
        status: "ready",
      });
      expect(store.currentProject.revision).toBe(acceptedBefore);
      const persisted = JSON.parse(await readFile(
        join(store.root, "proposals", result.proposal.id, "proposal.json"),
        "utf8",
      )) as { status: string };
      expect(persisted.status).toBe("ready");
    } finally {
      await gateway.close();
      jobs.close();
    }

    const replay = audit.readSession("ses_bbbbbbbbbb");
    expect(replay.warnings).toEqual([]);
    expect(replay.records.filter(({ type }) => type === "tool.call" || type === "tool.result")
      .map((record) => `${record.type}:${"tool" in record ? record.tool : ""}`)).toEqual([
      "tool.call:progress_overview",
      "tool.result:progress_overview",
      "tool.call:context_package",
      "tool.result:context_package",
      "tool.call:proposal_create",
      "tool.result:proposal_create",
      "tool.call:proposal_get",
      "tool.result:proposal_get",
    ]);
  }, 15_000);

  it("validates agent-authored graphic proposals through the shared template provider", async () => {
    const store = await annotatedProject();
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-graphics-gateway-user-"));
    temporaryDirectories.push(userDirectory);
    const audit = new AuditLog({ userDir: userDirectory });
    const { queue: jobs } = JobQueue.open(":memory:");
    const descriptor = {
      schema: "guyditor/template/v1" as const,
      id: "tpl_a2c3d4e5f6",
      name: "Brand lower third",
      kind: "lower_third" as const,
      version: "1.0.0",
      engine: "overlay/v1" as const,
      duration: { mode: "fixed" as const, default: { frames: 90, fps: "24/1" } },
      params: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: { title: { type: "string" } },
      },
      contentHash: "b".repeat(64),
    };
    const gateway = new AgentGateway({
      auditLog: audit,
      jobQueue: jobs,
      project: store,
      stateDirectory: join(userDirectory, "state"),
      sessionIdFactory: () => "ses_bbbbbbbbbb",
      templateProvider: {
        latest: () => success(descriptor),
        get: () => success(descriptor),
      },
    });
    const started = await gateway.start();
    try {
      const result = await runStubDirector({
        annotationId: "ann_bbbbbbbbbb",
        clipId: "clp_aaaaaaaaaa",
        gatewayStateFile: started.stateFile,
        title: "Add an anchored lower third",
        operations: [{
          op: "graphic.add",
          params: {
            templateId: descriptor.id,
            anchor: "timeline:seq_aaaaaaaaaa@8",
            duration: "intrinsic",
            params: { title: "Agent composition" },
            seed: 17,
          },
        }],
      });

      expect(result.proposal.status).toBe("ready");
      expect(result.proposal.operations).toMatchObject([{
        op: "graphic.add",
        params: {
          templateId: descriptor.id,
          anchor: "timeline:seq_aaaaaaaaaa@8",
          seed: 17,
        },
      }]);
      expect(store.currentProject.templates).toBeUndefined();
    } finally {
      await gateway.close();
      jobs.close();
    }
  });

  it("exposes cache-backed short-candidate discovery as an audited gateway tool", async () => {
    const store = await annotatedProject();
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-candidate-gateway-user-"));
    temporaryDirectories.push(userDirectory);
    const audit = new AuditLog({ userDir: userDirectory });
    const { queue: jobs } = JobQueue.open(":memory:");
    const calls: unknown[] = [];
    const records = [{
      candidateId: "candidate-0123456789ab",
      words: { startWordId: "w000001", endWordId: "w000020" },
      beats: ["beat_aaaaaaaaaa"],
      durationSeconds: 18,
      scores: { hook: 0.8, coherence: 0.7, payoff: 0.9, overall: 0.79 },
      evidence: {
        hookLine: "Why this works",
        reasons: ["question in first 2.5 seconds"],
        criteria: ["question", "payoff-beat-final-third"],
      },
    }];
    const gateway = new AgentGateway({
      auditLog: audit,
      jobQueue: jobs,
      project: store,
      stateDirectory: join(userDirectory, "state"),
      sessionIdFactory: () => "ses_bbbbbbbbbb",
      candidateDiscovery: (input) => {
        calls.push(input);
        return Promise.resolve(records);
      },
    });
    const started = await gateway.start();
    try {
      const result = await runStubDirector({
        annotationId: "ann_bbbbbbbbbb",
        clipId: "clp_aaaaaaaaaa",
        gatewayStateFile: started.stateFile,
        candidateDiscovery: {
          profile: "youtube-shorts@1.0.0",
          maxCandidates: 3,
        },
      });

      expect(result.tools).toContain("deliverable_candidates_discover");
      expect(calls).toEqual([{
        profile: "youtube-shorts@1.0.0",
        maxCandidates: 3,
      }]);
      expect(result.candidateResult).toEqual(records);
    } finally {
      await gateway.close();
      jobs.close();
    }
  });

  it("exposes deterministic publish-metadata drafting through the audited gateway", async () => {
    const store = await annotatedProject();
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-metadata-gateway-user-"));
    temporaryDirectories.push(userDirectory);
    const audit = new AuditLog({ userDir: userDirectory });
    const { queue: jobs } = JobQueue.open(":memory:");
    const draft = {
      format: "guyditor-publish/v1",
      deliverableId: "dlv_aaaaaaaaaa",
      profile: "youtube-shorts@1.0.0",
      language: "en",
      title: "Exact editing",
      description: "Deterministic draft",
      tags: ["editing"],
      hashtags: ["#editing"],
      status: "draft",
    };
    const gateway = new AgentGateway({
      auditLog: audit,
      jobQueue: jobs,
      project: store,
      stateDirectory: join(userDirectory, "state"),
      sessionIdFactory: () => "ses_bbbbbbbbbb",
      metadataDraft: (deliverableId) => Promise.resolve({ ...draft, deliverableId }),
    });
    const started = await gateway.start();
    try {
      const result = await runStubDirector({
        annotationId: "ann_bbbbbbbbbb",
        clipId: "clp_aaaaaaaaaa",
        gatewayStateFile: started.stateFile,
        metadataDraft: { deliverableId: "dlv_aaaaaaaaaa" },
      });
      expect(result.tools).toContain("deliverable_metadata_draft");
      expect(result.metadataResult).toEqual(draft);
    } finally {
      await gateway.close();
      jobs.close();
    }
    expect(audit.readSession("ses_bbbbbbbbbb").records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.call", tool: "deliverable_metadata_draft" }),
      expect.objectContaining({ type: "tool.result", tool: "deliverable_metadata_draft", ok: true }),
    ]));
  });

  it("lets the director request and fetch advisory critic findings before translating them into a proposal", async () => {
    const store = await annotatedProject();
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-critic-gateway-user-"));
    temporaryDirectories.push(userDirectory);
    const audit = new AuditLog({ userDir: userDirectory });
    const { queue: jobs } = JobQueue.open(":memory:");
    const critique = {
      critiqueId: "crt_aaaaaaaaaa",
      adapterId: "adp_4444444444",
      model: "stub-critic-v1",
      findings: [{
        id: "cut-density",
        severity: "minor" as const,
        range: { durationSeconds: 10 },
        observation: "Measured cut density is 0.7 cuts/second.",
        suggestion: "Review whether each cut preserves legibility.",
      }],
      rawCostUnits: { seconds: 10 },
    };
    let calls = 0;
    const gateway = new AgentGateway({
      auditLog: audit,
      jobQueue: jobs,
      project: store,
      stateDirectory: join(userDirectory, "state"),
      sessionIdFactory: () => "ses_bbbbbbbbbb",
      criticExecution: {
        request: () => {
          calls += 1;
          return Promise.resolve({ ok: true, value: critique });
        },
        get: (critiqueId) => Promise.resolve(critiqueId === critique.critiqueId ? critique : undefined),
      },
    });
    const started = await gateway.start();
    try {
      const result = await runStubDirector({
        annotationId: "ann_bbbbbbbbbb",
        clipId: "clp_aaaaaaaaaa",
        gatewayStateFile: started.stateFile,
        critic: {
          adapterId: "adp_4444444444",
          request: {
            critiqueId: "crt_aaaaaaaaaa",
            subject: {
              deliverableId: "dlv_aaaaaaaaaa",
              proxyFile: { path: ".guyditor/cache/proxies/ast_aaaaaaaaaa.mp4" },
              range: { durationSeconds: 10 },
            },
            rubric: [{ id: "pacing", source: "inline", text: "Keep the opening legible." }],
            questions: ["Is the promise legible?"],
          },
        },
      });
      expect(result.tools).toEqual(expect.arrayContaining(["critic_request", "critic_result_get"]));
      expect(result.critiqueRequestResult).toEqual(critique);
      expect(result.critiqueFetchedResult).toEqual(critique);
      expect(calls).toBe(1);
      expect(result.proposal.status).toBe("ready");
    } finally {
      await gateway.close();
      jobs.close();
    }
    expect(audit.readSession("ses_bbbbbbbbbb").records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.call", tool: "critic_request" }),
      expect.objectContaining({ type: "tool.call", tool: "critic_result_get" }),
    ]));
  });

  it("returns verified pinned skill content and resolves skill automation rules for a director session", async () => {
    const store = await annotatedProject();
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-skills-gateway-user-"));
    temporaryDirectories.push(userDirectory);
    const audit = new AuditLog({ userDir: userDirectory });
    const { queue: jobs } = JobQueue.open(":memory:");
    const skills: ResolvedSkill[] = [{
      manifest: {
        id: "skl_aaaaaaaaaa",
        name: "quiet-cuts",
        version: "1.0.0",
        title: "Quiet cuts",
        categories: ["framing_cuts"],
        summary: "Keep creator-approved cut behavior explicit.",
        rules: [{
          id: "rule_aaaaaaaaaa",
          category: "framing_cuts",
          strength: "must",
          text: "Allow transcript.word.correct but avoid clip.trim.",
        }],
        examples: { approved: [], rejected: [] },
        contentHash: "a".repeat(64),
      },
      body: "# Quiet cuts\n\nUse only creator-approved corrections.",
      presetReferences: [],
    }];
    const gateway = new AgentGateway({
      auditLog: audit,
      jobQueue: jobs,
      project: store,
      stateDirectory: join(userDirectory, "state"),
      policySnapshot: {
        automation: {
          enabled: true,
          maxRisk: "low",
          allowedOperations: ["clip.trim"],
          maxOpsPerProposal: 2,
          maxAutoAcceptsPerSession: 3,
          notify: "toast",
        },
      },
      sessionIdFactory: () => "ses_bbbbbbbbbb",
      skillRegistry: {
        pinned: () => Promise.resolve(skills),
        resolveAutomationPolicy: (policy) => ({
          ...policy,
          allowedOperations: ["transcript.word.correct"],
        }),
      },
    });
    const started = await gateway.start();
    try {
      const result = await runStubDirector({
        annotationId: "ann_bbbbbbbbbb",
        clipId: "clp_aaaaaaaaaa",
        gatewayStateFile: started.stateFile,
        activeSkills: true,
      });
      expect(result.tools).toContain("active_skills_get");
      expect(result.activeSkillsResult).toEqual(skills);
    } finally {
      await gateway.close();
      jobs.close();
    }
    const start = audit.readSession("ses_bbbbbbbbbb").records.find(
      ({ type }) => type === "session.start",
    );
    expect(start).toMatchObject({
      policySnapshot: {
        automation: { allowedOperations: ["transcript.word.correct"] },
      },
    });
  });

  it("rejects a corrupted skill pin before opening the gateway", async () => {
    const store = await annotatedProject();
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-corrupt-skill-user-"));
    const source = await mkdtemp(join(tmpdir(), "guyditor-corrupt-skill-source-"));
    temporaryDirectories.push(userDirectory);
    temporaryDirectories.push(source);
    await mkdir(join(source, "examples"));
    await writeFile(join(source, "SKILL.md"), "# Verified context\n", "utf8");
    await writeFile(join(source, "skill.yaml"), [
      "format: guyditor-skill/v1",
      "id: skl_aaaaaaaaaa",
      "name: verified-context",
      "version: 1.0.0",
      "title: Verified context",
      "categories: [pacing]",
      "summary: Verify before every director session.",
      "rules: []",
      "examples: { approved: [], rejected: [] }",
      "body: SKILL.md",
      "",
    ].join("\n"), "utf8");
    const registry = new SkillRegistry({ globalRoot: join(userDirectory, "skills") });
    await registry.publish(source);
    await registry.associateProject(store, "skl_aaaaaaaaaa", "1.0.0");
    await writeFile(
      join(store.root, "skills/verified-context/1.0.0/SKILL.md"),
      "# Corrupted context\n",
      "utf8",
    );
    const audit = new AuditLog({ userDir: userDirectory });
    const { queue: jobs } = JobQueue.open(":memory:");
    const gateway = new AgentGateway({
      auditLog: audit,
      jobQueue: jobs,
      project: store,
      stateDirectory: join(userDirectory, "state"),
    });
    await expect(gateway.start()).rejects.toMatchObject({ code: "E_SKILL_HASH" });
    jobs.close();
  });
});
