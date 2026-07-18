import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationEngine,
  createProject,
  failure,
  makeGuyditorError,
  openProject,
  parseProjectYaml,
} from "../index.js";
import type {
  AutomationPolicy,
  IdPrefix,
  OperationDispatcher,
  Proposal,
  ProposalReason,
  ProposalStore,
  Result,
  TransactionRecord,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const directories: string[] = [];
const NOW = new Date("2026-07-18T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "guyditor-proposal-"));
  directories.push(path);
  return path;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

function ids(): (prefix: IdPrefix) => string {
  const ordinals = new Map<IdPrefix, number>();
  return (prefix) => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    const character = String.fromCharCode("a".charCodeAt(0) + ordinal);
    return `${prefix}_${character.repeat(10)}`;
  };
}

function reason(text = "Tighten the ending without changing the story."): ProposalReason {
  return {
    text,
    sources: [{ kind: "instruction", ref: "tighten the ending" }],
  };
}

function trim(delta = 1) {
  return {
    op: "clip.trim",
    params: {
      clipId: "clp_aaaaaaaaaa",
      edge: "tail",
      delta: { frames: delta, fps: "24/1" },
      snapPolicy: "none",
    },
  };
}

function applySingleFileUnifiedDiff(base: string, patch: string): string {
  const lines = patch.split("\n");
  const header = lines.findIndex((line) => line.startsWith("@@ "));
  if (header === -1) throw new Error("missing unified diff hunk");
  const output: string[] = [];
  let cursor = 0;
  const baseLines = base.endsWith("\n") ? base.slice(0, -1).split("\n") : base.split("\n");
  for (const line of lines.slice(header + 1)) {
    if (line === "") continue;
    const marker = line[0];
    const content = line.slice(1);
    if (marker === " ") {
      expect(baseLines[cursor]).toBe(content);
      output.push(content);
      cursor += 1;
    } else if (marker === "-") {
      expect(baseLines[cursor]).toBe(content);
      cursor += 1;
    } else if (marker === "+") {
      output.push(content);
    } else {
      throw new Error(`invalid unified diff line ${line}`);
    }
  }
  expect(cursor).toBe(baseLines.length);
  return `${output.join("\n")}\n`;
}

async function projectEngine(
  policy?: AutomationPolicy,
): Promise<{ root: string; engine: OperationEngine }> {
  const root = await directory();
  const idFactory = ids();
  const store = await valueOf(createProject(root, projectFixture(), {
    idFactory,
    now: () => NOW,
  }));
  return {
    root,
    engine: new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      idFactory,
      now: () => NOW,
      ...(policy === undefined ? {} : { automationPolicy: policy }),
    }),
  };
}

async function createReady(engine: OperationEngine): Promise<Proposal> {
  return valueOf(engine.createProposal({
    operations: [trim()],
    instruction: { kind: "user-text", text: "tighten the ending" },
    actor: { kind: "agent", id: "ses_aaaaaaaaaa", model: "test-agent" },
    sessionId: "ses_aaaaaaaaaa",
    reason: reason(),
    addresses: [],
  }));
}

describe("proposal lifecycle", () => {
  it("creates a ready proposal layout and accepts it through a linked journal transaction", async () => {
    const { root, engine } = await projectEngine();
    const acceptedBefore = await readFile(join(root, "episode.guyditor.yaml"), "utf8");

    const proposal = await createReady(engine);

    expect(proposal).toMatchObject({
      id: "prp_aaaaaaaaaa",
      baseRevision: "rev_00001",
      status: "ready",
      riskClass: "normal",
      reason: reason(),
      applied: [{ op: "clip.trim" }],
      diff: { base: "rev_00001", entries: [{ op: "clip.trim" }] },
      warnings: [],
      orphanedAnchors: [],
    });
    const proposalRoot = join(root, "proposals", proposal.id);
    expect((await readdir(proposalRoot)).sort()).toEqual([
      "diff.patch",
      "master.proposed.yaml",
      "previews",
      "proposal.json",
    ]);
    await expect(readdir(join(proposalRoot, "previews"))).resolves.toEqual([]);
    await expect(readFile(join(root, "episode.guyditor.yaml"), "utf8"))
      .resolves.toBe(acceptedBefore);

    const proposed = await readFile(join(proposalRoot, "master.proposed.yaml"), "utf8");
    const patch = await readFile(join(proposalRoot, "diff.patch"), "utf8");
    expect(applySingleFileUnifiedDiff(acceptedBefore, patch)).toBe(proposed);

    const accepted = await valueOf(engine.acceptProposal(proposal.id, "creator"));
    expect(accepted).toMatchObject({
      status: "accepted",
      resultTransaction: "txn_bbbbbbbbbb",
      resolvedBy: "creator",
    });
    await expect(readdir(join(root, "proposals"))).resolves.toEqual([]);
    await expect(readdir(join(root, "history/proposals"))).resolves.toEqual([proposal.id]);
    const journal = (await readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as TransactionRecord);
    expect(journal.at(-1)).toMatchObject({
      id: "txn_bbbbbbbbbb",
      acceptance: { status: "accepted", by: "creator", proposal: proposal.id },
      actor: proposal.actor,
      instruction: proposal.instruction,
      reason: proposal.reason.text,
    });
    await expect(engine.undo()).resolves.toMatchObject({
      ok: false,
      error: { code: "E_OP_UNDO_EMPTY", acceptedStateChanged: false },
    });
    await valueOf(engine.revertTransaction(accepted.resultTransaction!));
    expect(engine.currentProject.sequences[0]!.clips[0]!.source.out.frames).toBe(24);
    expect(engine.currentProject.revision).toBe("rev_00003");
  });

  it("reports a post-commit finalization failure and reconciles the proposal on open", async () => {
    const root = await directory();
    const idFactory = ids();
    const store = await valueOf(createProject(root, projectFixture(), {
      idFactory,
      now: () => NOW,
    }));
    const savedStatuses: Proposal["status"][] = [];
    const failingArchive: ProposalStore = {
      get head() {
        return store.head;
      },
      readAcceptedRevision: () => store.readAcceptedRevision(),
      saveProposal: (proposal, project) => {
        savedStatuses.push(proposal.status);
        return store.saveProposal(proposal, project);
      },
      readProposal: (id) => store.readProposal(id),
      updateProposal: (proposal) => store.updateProposal(proposal),
      archiveProposal: async (id) => failure(makeGuyditorError(
        "E_PROJECT_PROPOSAL",
        "simulated archive failure",
        { affected: [id] },
      )),
    };
    const engine = new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: failingArchive,
      idFactory,
      now: () => NOW,
    });
    const proposal = await createReady(engine);
    expect(savedStatuses).toEqual(["draft", "ready"]);

    const accepted = await engine.acceptProposal(proposal.id, "creator");

    expect(accepted).toMatchObject({
      ok: false,
      error: { code: "E_PROPOSAL_FINALIZE", acceptedStateChanged: true },
    });
    expect(store.head).toBe("rev_00002");
    const reopened = await openProject(root);
    expect(reopened.ok).toBe(true);
    await expect(readdir(join(root, "proposals"))).resolves.toEqual([]);
    await expect(readdir(join(root, "history/proposals")))
      .resolves.toEqual([proposal.id]);
  });

  it("rejects without changing any accepted bytes", async () => {
    const { root, engine } = await projectEngine();
    const proposal = await createReady(engine);
    const before = await readFile(join(root, "episode.guyditor.yaml"));
    const beforeHash = createHash("sha256").update(before).digest("hex");

    const rejected = await valueOf(engine.rejectProposal(proposal.id, "creator"));

    expect(rejected).toMatchObject({ status: "rejected", resolvedBy: "creator" });
    const after = await readFile(join(root, "episode.guyditor.yaml"));
    expect(createHash("sha256").update(after).digest("hex")).toBe(beforeHash);
    expect(after.equals(before)).toBe(true);
    await expect(engine.undo()).resolves.toMatchObject({
      ok: false,
      error: { code: "E_OP_UNDO_EMPTY", acceptedStateChanged: false },
    });
  });

  it("withdraws to history without touching accepted state", async () => {
    const { root, engine } = await projectEngine();
    const proposal = await createReady(engine);
    const before = await readFile(join(root, "episode.guyditor.yaml"), "utf8");

    const withdrawn = await valueOf(engine.withdrawProposal(
      proposal.id,
      proposal.actor.id,
    ));

    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      resolvedBy: proposal.actor.id,
    });
    await expect(readFile(join(root, "episode.guyditor.yaml"), "utf8"))
      .resolves.toBe(before);
    await expect(readdir(join(root, "history/proposals")))
      .resolves.toEqual([proposal.id]);
  });

  it("stamps staleBase and refuses to reapply after an interleaved commit", async () => {
    const { root, engine } = await projectEngine();
    const proposal = await createReady(engine);
    await valueOf(engine.execute([trim(2)], {
      baseRevision: "rev_00001",
      origin: "ui",
      dryRun: false,
    }));

    const result = await engine.acceptProposal(proposal.id, "creator");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_PROPOSAL_STALE", acceptedStateChanged: false },
    });
    const stored = JSON.parse(await readFile(
      join(root, "proposals", proposal.id, "proposal.json"),
      "utf8",
    )) as Proposal;
    expect(stored).toMatchObject({ status: "ready", staleBase: true });
    expect(engine.currentProject.revision).toBe("rev_00002");
  });

  it("translates a HEAD race at commit into a stamped stale proposal", async () => {
    const root = await directory();
    const idFactory = ids();
    const store = await valueOf(createProject(root, projectFixture(), { idFactory }));
    let raceOnRead = false;
    let maskHeadOnce = false;
    const racingStore: ProposalStore = {
      get head() {
        if (maskHeadOnce) {
          maskHeadOnce = false;
          return "rev_00001";
        }
        return store.head;
      },
      async readAcceptedRevision() {
        const revision = await store.readAcceptedRevision();
        if (raceOnRead) {
          raceOnRead = false;
          const interleaved = new OperationEngine(store.currentProject, {
            committer: store,
            idFactory,
          });
          await valueOf(interleaved.execute([{
            op: "clip.trim",
            params: {
              clipId: "clp_bbbbbbbbbb",
              edge: "tail",
              delta: { frames: 1, fps: "24/1" },
            },
          }], {
            baseRevision: "rev_00001",
            origin: "ui",
            dryRun: false,
          }));
          maskHeadOnce = true;
        }
        return revision;
      },
      saveProposal: (proposal, project) => store.saveProposal(proposal, project),
      readProposal: (id) => store.readProposal(id),
      updateProposal: (proposal) => store.updateProposal(proposal),
      archiveProposal: (id) => store.archiveProposal(id),
    };
    const engine = new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: racingStore,
      idFactory,
    });
    const proposal = await createReady(engine);
    raceOnRead = true;

    const accepted = await engine.acceptProposal(proposal.id, "creator");

    expect(accepted).toMatchObject({
      ok: false,
      error: { code: "E_PROPOSAL_STALE", acceptedStateChanged: false },
    });
    expect(await store.readProposal(proposal.id)).toMatchObject({
      ok: true,
      value: { status: "ready", staleBase: true },
    });
    expect(store.head).toBe("rev_00002");
  });

  it("keeps concurrent proposal dry-run masters paired with their operations", async () => {
    const { root, engine } = await projectEngine();

    const [first, second] = await Promise.all([
      valueOf(engine.createProposal({
        operations: [trim(1)],
        instruction: { kind: "user-text", text: "trim one frame" },
        actor: { kind: "agent", id: "ses_aaaaaaaaaa" },
        sessionId: "ses_aaaaaaaaaa",
        reason: reason("Trim one frame."),
        addresses: [],
      })),
      valueOf(engine.createProposal({
        operations: [trim(2)],
        instruction: { kind: "user-text", text: "trim two frames" },
        actor: { kind: "agent", id: "ses_bbbbbbbbbb" },
        sessionId: "ses_bbbbbbbbbb",
        reason: reason("Trim two frames."),
        addresses: [],
      })),
    ]);

    for (const [proposal, expectedOut] of [[first, 23], [second, 22]] as const) {
      const proposed = parseProjectYaml(await readFile(
        join(root, "proposals", proposal.id, "master.proposed.yaml"),
        "utf8",
      ));
      expect(proposed.ok).toBe(true);
      if (proposed.ok) {
        expect(proposed.value.sequences[0]!.clips[0]!.source.out.frames).toBe(expectedOut);
      }
    }
  });

  it("creates a replacement and archives the superseded proposal as a chain", async () => {
    const { root, engine } = await projectEngine();
    const original = await createReady(engine);

    const replacement = await valueOf(engine.supersedeProposal(original.id, {
      operations: [trim(2)],
      instruction: { kind: "user-text", text: "make the trim stronger" },
      actor: original.actor,
      ...(original.sessionId === undefined ? {} : { sessionId: original.sessionId }),
      reason: reason("Apply the creator's stronger trim request."),
      addresses: [],
    }));

    expect(replacement).toMatchObject({ id: "prp_bbbbbbbbbb", status: "ready" });
    const archived = JSON.parse(await readFile(
      join(root, "history/proposals", original.id, "proposal.json"),
      "utf8",
    )) as Proposal;
    expect(archived).toMatchObject({
      status: "superseded",
      supersededBy: replacement.id,
      resolvedBy: original.actor.id,
    });
  });

  it("auto-accepts only low-risk proposals allowed by the injected policy", async () => {
    const policy: AutomationPolicy = {
      enabled: true,
      maxRisk: "low",
      allowedOperations: ["transcript.word.correct"],
      maxOpsPerProposal: 2,
      maxAutoAcceptsPerSession: 1,
      notify: "toast",
    };
    const root = await directory();
    const idFactory = ids();
    const store = await valueOf(createProject(root, projectFixture(), { idFactory }));
    const dispatcher: OperationDispatcher = (project, input) => ({
      ok: true,
      value: {
        model: { ...project, transcript: { nextWordOrdinal: 2 } },
        inverse: [{
          op: "transcript.word.correct",
          params: { wordId: "w000001", text: "before" },
        }],
        affected: ["w000001"],
        summary: `Correct ${String(input.params["wordId"])}`,
      },
    });
    const engine = new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      operationDispatcher: dispatcher,
      automationPolicy: policy,
      idFactory,
    });

    const low = await valueOf(engine.createProposal({
      operations: [{
        op: "transcript.word.correct",
        params: { wordId: "w000001", text: "after" },
      }],
      instruction: { kind: "user-text", text: "correct the word" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa" },
      sessionId: "ses_aaaaaaaaaa",
      reason: reason("Correct the transcript typo."),
      addresses: [],
    }));
    expect(low).toMatchObject({
      status: "accepted",
      riskClass: "low",
      resolvedBy: "auto",
    });
    const journal = (await readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as TransactionRecord);
    expect(journal.at(-1)?.acceptance).toMatchObject({
      status: "auto-accepted-low-risk",
      by: "automation-policy",
      proposal: low.id,
    });

    const normal = await valueOf(engine.createProposal({
      operations: [trim()],
      instruction: { kind: "user-text", text: "trim" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa" },
      sessionId: "ses_aaaaaaaaaa",
      reason: reason(),
      addresses: [],
    }));
    expect(normal).toMatchObject({ status: "ready", riskClass: "normal" });
    expect(engine.currentProject.revision).toBe("rev_00002");

    const human = await valueOf(engine.createProposal({
      operations: [{
        op: "transcript.word.correct",
        params: { wordId: "w000001", text: "creator edit" },
      }],
      instruction: { kind: "ui-direct" },
      actor: { kind: "human", id: "creator" },
      reason: reason("Apply the creator's transcript correction."),
      addresses: [],
    }));
    expect(human).toMatchObject({ status: "ready", riskClass: "low" });
    expect(engine.currentProject.revision).toBe("rev_00002");
  });

  it("defaults to review even for a low-risk proposal", async () => {
    const root = await directory();
    const idFactory = ids();
    const store = await valueOf(createProject(root, projectFixture(), { idFactory }));
    const engine = new OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      idFactory,
      operationDispatcher(project) {
        return {
          ok: true,
          value: {
            model: { ...project, transcript: { nextWordOrdinal: 2 } },
            inverse: [],
            affected: ["w000001"],
            summary: "Correct w000001",
          },
        };
      },
    });

    const proposal = await valueOf(engine.createProposal({
      operations: [{
        op: "transcript.word.correct",
        params: { wordId: "w000001", text: "after" },
      }],
      instruction: { kind: "user-text", text: "correct the word" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa" },
      sessionId: "ses_aaaaaaaaaa",
      reason: reason("Correct the transcript typo."),
      addresses: [],
    }));

    expect(proposal).toMatchObject({ status: "ready", riskClass: "low" });
    expect(engine.currentProject.revision).toBe("rev_00001");
  });

  it("requires a reason for meaningful agent proposals", async () => {
    const { engine } = await projectEngine();

    const result = await engine.createProposal({
      operations: [trim()],
      instruction: { kind: "user-text", text: "trim" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa" },
      reason: { text: "", sources: [] },
      addresses: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_REASON_REQUIRED", acceptedStateChanged: false },
    });
  });

  it("validates active proposal records and artifacts when opening a project", async () => {
    const { root, engine } = await projectEngine();
    const proposal = await createReady(engine);
    await writeFile(
      join(root, "proposals", proposal.id, "proposal.json"),
      "{\"status\":\"ready\"}\n",
      "utf8",
    );

    const reopened = await openProject(root);

    expect(reopened).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_PROPOSAL", acceptedStateChanged: false },
    });
  });
});
