import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationEngine,
  createProject,
  openProject,
} from "../../core/src/index.js";
import type {
  IdPrefix,
  Proposal,
  ProposalReason,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { AuditLog } from "./index.js";

const directories: string[] = [];
const NOW = new Date("2026-07-19T15:00:00.000Z");
const SESSION_ID = "ses_aaaaaaaaaa";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(label: string): string {
  const path = mkdtempSync(join(tmpdir(), label));
  directories.push(path);
  return path;
}

function ids(): (prefix: IdPrefix) => string {
  const ordinals = new Map<IdPrefix, number>();
  return (prefix) => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    return `${prefix}_${String.fromCharCode(97 + ordinal).repeat(10)}`;
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function reason(): ProposalReason {
  return {
    text: "Tighten the ending without changing the story.",
    sources: [{ kind: "instruction", ref: "tighten the ending" }],
  };
}

async function setup(): Promise<{
  audit: AuditLog;
  engine: OperationEngine;
}> {
  const root = directory("guyditor-audited-project-");
  const userDir = directory("guyditor-audited-user-");
  const idFactory = ids();
  const store = await valueOf(createProject(root, projectFixture(), {
    idFactory,
    now: () => NOW,
  }));
  const audit = new AuditLog({ userDir, now: () => NOW });
  return {
    audit,
    engine: new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      auditSink: audit,
      idFactory,
      now: () => NOW,
    }),
  };
}

async function createProposal(engine: OperationEngine): Promise<Proposal> {
  return valueOf(engine.createProposal({
    operations: [{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
        snapPolicy: "none",
      },
    }],
    instruction: { kind: "user-text", text: "tighten the ending" },
    actor: { kind: "agent", id: SESSION_ID, model: "director-test" },
    sessionId: SESSION_ID,
    reason: reason(),
    addresses: [],
  }));
}

describe("OperationEngine AuditSink integration", () => {
  it("writes linked create, commit, and accepted proposal records", async () => {
    const { audit, engine } = await setup();
    const proposal = await createProposal(engine);

    await valueOf(engine.acceptProposal(proposal.id, "creator"));

    const replay = audit.readSession(SESSION_ID);
    expect(replay.warnings).toEqual([]);
    expect(replay.records).toEqual([
      expect.objectContaining({
        type: "proposal.created",
        proposalId: proposal.id,
        opCount: 1,
        riskClass: "normal",
      }),
      expect.objectContaining({
        type: "tool.result",
        tool: "operation.commit",
        callId: "txn_bbbbbbbbbb",
        ok: true,
        paramsDigest: expect.objectContaining({ proposalId: proposal.id }),
      }),
      expect.objectContaining({
        type: "proposal.outcome",
        proposalId: proposal.id,
        outcome: "accepted",
        transactionId: "txn_bbbbbbbbbb",
        revision: "rev_00002",
      }),
    ]);
  });

  it("writes linked create and rejected proposal records without a commit", async () => {
    const { audit, engine } = await setup();
    const proposal = await createProposal(engine);

    await valueOf(engine.rejectProposal(proposal.id, "creator"));

    const records = audit.readSession(SESSION_ID).records;
    expect(records.map(({ type }) => type)).toEqual([
      "proposal.created",
      "proposal.outcome",
    ]);
    expect(records[0]).toMatchObject({ proposalId: proposal.id });
    expect(records[1]).toMatchObject({ proposalId: proposal.id, outcome: "rejected" });
  });

  it("rebuilds and commits project state when audit history is corrupt or unavailable", async () => {
    const root = directory("guyditor-r007-project-");
    const userDir = directory("guyditor-r007-user-");
    const idFactory = ids();
    const store = await valueOf(createProject(root, projectFixture(), { idFactory, now: () => NOW }));
    const audit = new AuditLog({ userDir, now: () => NOW });
    audit.append({
      type: "instruction",
      sessionId: SESSION_ID,
      projectId: store.currentProject.project.id,
      source: "creator",
      text: "This history is operational only.",
    });
    appendFileSync(join(userDir, "audit", `${SESSION_ID}.jsonl`), "{corrupt}\n", "utf8");
    const reopenedBefore = await valueOf(openProject(root));
    const engine = new OperationEngine(reopenedBefore.currentProject, {
      committer: reopenedBefore,
      idFactory,
      auditSink: {
        record() {
          throw new Error("audit storage unavailable");
        },
      },
    });

    await valueOf(engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
        snapPolicy: "none",
      },
    }], {
      baseRevision: "rev_00001",
      origin: "system",
      sessionId: SESSION_ID,
      dryRun: false,
    }));
    const reopenedAfter = await valueOf(openProject(root));

    expect(reopenedAfter.currentProject.revision).toBe("rev_00002");
    expect(reopenedAfter.currentProject.sequences[0]!.clips[0]!.source.out.frames).toBe(23);
  });
});
