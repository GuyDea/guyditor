import { describe, expect, it } from "vitest";

import { OperationEngine } from "../index.js";
import type {
  GuyditorProject,
  IdPrefix,
  OperationDispatcher,
  Result,
  TransactionRecord,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

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
    const character = String.fromCharCode("c".charCodeAt(0) + ordinal);
    return `${prefix}_${character.repeat(10)}`;
  };
}

function recordingEngine(
  project: GuyditorProject,
  dispatcher?: OperationDispatcher,
): { engine: OperationEngine; transactions: TransactionRecord[] } {
  const transactions: TransactionRecord[] = [];
  const engine = new OperationEngine(project, {
    idFactory: ids(),
    ...(dispatcher === undefined ? {} : { operationDispatcher: dispatcher }),
    committer: {
      async commit(model, transaction) {
        transactions.push(transaction);
        return { ok: true, value: model };
      },
      async readTransaction(id) {
        const transaction = transactions.find((candidate) => candidate.id === id);
        return transaction === undefined
          ? {
              ok: false as const,
              error: {
                code: "E_PROJECT_TRANSACTION" as const,
                message: `Transaction ${id} was not found.`,
                acceptedStateChanged: false as const,
                retry: "none" as const,
                affected: [id],
              },
            }
          : { ok: true as const, value: transaction };
      },
    },
  });
  return { engine, transactions };
}

function ui(engine: OperationEngine, operations: Array<{
  op: string;
  params: Record<string, unknown>;
}>) {
  return engine.execute(operations, {
    baseRevision: engine.currentProject.revision,
    origin: "ui",
    dryRun: false,
  });
}

describe("session undo and redo", () => {
  it("refuses a public agent commit even when a proposal ID is supplied", async () => {
    const { engine } = recordingEngine(projectFixture());

    const result = await engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    }], {
      baseRevision: "rev_00001",
      origin: "agent",
      proposalId: "prp_aaaaaaaaaa",
      dryRun: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_AGENT_DIRECT", acceptedStateChanged: false },
    });
    expect(engine.currentProject.revision).toBe("rev_00001");
  });

  it("round-trips trim as forward transactions with undoOf and redoOf", async () => {
    const original = projectFixture();
    const { engine, transactions } = recordingEngine(original);
    await valueOf(ui(engine, [{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 4, fps: "24/1" },
        snapPolicy: "none",
      },
    }]));
    const edited = structuredClone(engine.currentProject);

    await valueOf(engine.undo());
    expect(engine.currentProject.sequences[0]!.clips[0]!.source.out.frames).toBe(24);
    expect(transactions.at(-1)).toMatchObject({ undoOf: "txn_cccccccccc" });

    await valueOf(engine.redo());
    expect(engine.currentProject.sequences[0]!.clips[0]!.source.out.frames).toBe(20);
    expect(engine.currentProject.sequences).toEqual(edited.sequences);
    expect(transactions.at(-1)).toMatchObject({ redoOf: "txn_cccccccccc" });
    expect(transactions.map(({ resultRevision }) => resultRevision)).toEqual([
      "rev_00002",
      "rev_00003",
      "rev_00004",
    ]);
  });

  it("preserves generated stable IDs while undoing and redoing split and join", async () => {
    const splitSetup = recordingEngine(projectFixture());
    await valueOf(ui(splitSetup.engine, [{
      op: "clip.split",
      params: { clipId: "clp_aaaaaaaaaa", at: 12 },
    }]));
    const splitIds = splitSetup.engine.currentProject.sequences[0]!.clips.map(({ id }) => id);
    await valueOf(splitSetup.engine.undo());
    await valueOf(splitSetup.engine.redo());
    expect(splitSetup.engine.currentProject.sequences[0]!.clips.map(({ id }) => id))
      .toEqual(splitIds);

    const joinSetup = recordingEngine(projectFixture());
    await valueOf(ui(joinSetup.engine, [{
      op: "clip.join",
      params: { clipIds: ["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"] },
    }]));
    await valueOf(joinSetup.engine.undo());
    expect(joinSetup.engine.currentProject.sequences[0]!.clips.map(({ id }) => id)).toEqual([
      "clp_aaaaaaaaaa",
      "clp_bbbbbbbbbb",
    ]);
    await valueOf(joinSetup.engine.redo());
    expect(joinSetup.engine.currentProject.sequences[0]!.clips.map(({ id }) => id))
      .toEqual(["clp_aaaaaaaaaa"]);
  });

  it("round-trips transcript operations through their domain dispatcher", async () => {
    const dispatcher: OperationDispatcher = (project, input) => {
      const text = input.params["text"];
      if (typeof text !== "string") throw new TypeError("text is required");
      const after = text === "after";
      return {
        ok: true,
        value: {
          model: {
            ...project,
            transcript: { nextWordOrdinal: after ? 2 : 1 },
          },
          inverse: [{
            op: "transcript.word.correct",
            params: { wordId: "w000001", text: after ? "before" : "after" },
          }],
          affected: ["w000001"],
          summary: `Correct w000001 to ${text}`,
        },
      };
    };
    const { engine } = recordingEngine(projectFixture(), dispatcher);

    await valueOf(ui(engine, [{
      op: "transcript.word.correct",
      params: { wordId: "w000001", text: "after" },
    }]));
    expect(engine.currentProject.transcript.nextWordOrdinal).toBe(2);
    await valueOf(engine.undo());
    expect(engine.currentProject.transcript.nextWordOrdinal).toBe(1);
    await valueOf(engine.redo());
    expect(engine.currentProject.transcript.nextWordOrdinal).toBe(2);
  });

  it("invalidates UI undo when a non-UI transaction has advanced HEAD", async () => {
    const { engine } = recordingEngine(projectFixture());
    await valueOf(ui(engine, [{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    }]));
    await valueOf(engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_bbbbbbbbbb",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    }], {
      baseRevision: "rev_00002",
      origin: "system",
      dryRun: false,
    }));

    const result = await engine.undo();

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_OP_UNDO_STALE", acceptedStateChanged: false },
    });
    expect(engine.currentProject.revision).toBe("rev_00003");
  });

  it("reverts a historical transaction without treating it as undo", async () => {
    const { engine, transactions } = recordingEngine(projectFixture());
    const proposal = await valueOf(engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 3, fps: "24/1" },
      },
    }], {
      baseRevision: "rev_00001",
      origin: "system",
      dryRun: false,
    }));
    await valueOf(ui(engine, [{
      op: "clip.trim",
      params: {
        clipId: "clp_bbbbbbbbbb",
        edge: "tail",
        delta: { frames: 2, fps: "24/1" },
      },
    }]));

    await valueOf(engine.revertTransaction(proposal.transactionId!));

    expect(engine.currentProject.sequences[0]!.clips.map(({ source }) => source.out.frames))
      .toEqual([24, 46]);
    expect(transactions.at(-1)).toMatchObject({
      operations: [{ op: "clip.trim" }],
      instruction: { kind: "ui-direct" },
    });
    const undo = await engine.undo();
    expect(undo).toMatchObject({
      ok: false,
      error: { code: "E_OP_UNDO_STALE", acceptedStateChanged: false },
    });
  });

  it("maps an inverse that no longer applies to a revert conflict", async () => {
    const { engine } = recordingEngine(projectFixture());
    const original = await valueOf(ui(engine, [{
      op: "clip.trim",
      params: {
        clipId: "clp_bbbbbbbbbb",
        edge: "tail",
        delta: { frames: 2, fps: "24/1" },
      },
    }]));
    await valueOf(ui(engine, [{
      op: "clip.join",
      params: { clipIds: ["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"] },
    }]));

    const result = await engine.revertTransaction(original.transactionId!);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_OP_REVERT_CONFLICT",
        acceptedStateChanged: false,
      },
    });
    if (!result.ok) expect(result.error.message).toContain("restore");
  });
});
