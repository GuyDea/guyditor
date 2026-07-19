import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  });

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
});
