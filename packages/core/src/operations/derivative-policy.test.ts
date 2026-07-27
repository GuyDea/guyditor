import { describe, expect, it } from "vitest";

import {
  DERIVATIVE_OPERATION_POLICIES,
  OperationEngine,
  cataloguedOperationNames,
  success,
  touchedDerivativeIds,
} from "../index.js";
import type {
  GuyditorProject,
  OperationDispatcher,
  ProposalStore,
  TransactionRecord,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

function projectWithShort(): GuyditorProject {
  const project = projectFixture();
  project.sequences.push({
    id: "seq_bbbbbbbbbb",
    name: "short",
    clips: [{
      id: "clp_cccccccccc",
      asset: "ast_aaaaaaaaaa",
      source: {
        in: { frames: 0, fps: "24/1" },
        out: { frames: 12, fps: "24/1" },
      },
    }],
  });
  project.layers.push({
    id: "lyr_bbbbbbbbbb",
    kind: "video",
    name: "short",
    order: 1,
    enabled: true,
    locked: false,
    sequence: "seq_bbbbbbbbbb",
  });
  project.deliverables.push({
    id: "dlv_bbbbbbbbbb",
    kind: "short",
    name: "Short",
    profile: "youtube-shorts@1.0.0",
    sequenceId: "seq_bbbbbbbbbb",
    status: "draft",
    dependencies: [{
      derivativeClipId: "clp_cccccccccc",
      source: {
        assetId: "ast_aaaaaaaaaa",
        range: {
          start: { frames: 0, fps: "24/1" },
          end: { frames: 12, fps: "24/1" },
        },
        longformClipId: "clp_aaaaaaaaaa",
      },
    }],
  });
  return project;
}

function passThroughDispatcher(onDispatch?: () => void): OperationDispatcher {
  return (project, input) => {
    onDispatch?.();
    return success({
      model: project,
      inverse: [],
      affected: [
        typeof input.params["clipId"] === "string"
          ? input.params["clipId"]
          : "seq_bbbbbbbbbb",
      ],
      summary: `Run ${input.op}`,
    });
  };
}

describe("derivative operation policy", () => {
  it("covers the complete operation catalog with explicit impact metadata", () => {
    expect(Object.keys(DERIVATIVE_OPERATION_POLICIES).sort())
      .toEqual(cataloguedOperationNames().sort());

    for (const operation of [
      "annotation.create",
      "annotation.update",
      "annotation.delete",
      "annotation.resolve",
      "annotation.reject",
      "annotation.reopen",
      "layer.lock",
      "layer.unlock",
      "region.mark",
      "pip.avoid.solve",
      "key.qc.run",
      "key.matte.generate",
    ]) {
      expect(DERIVATIVE_OPERATION_POLICIES[
        operation as keyof typeof DERIVATIVE_OPERATION_POLICIES
      ]).toMatchObject({ impact: "non-editorial", target: "none" });
    }

    for (const operation of [
      "restyle.plan.create",
      "seam.treatment.set",
      "deliverable.derive",
      "deliverable.status.set",
      "deliverable.approve",
      "deliverable.refresh",
      "deliverable.remove",
      "deliverable.metadata.set",
      "deliverable.chapters.set",
      "deliverable.publish.approve",
      "deliverable.thumbnail.select",
      "deliverable.publish.files.set",
    ]) {
      expect(DERIVATIVE_OPERATION_POLICIES[
        operation as keyof typeof DERIVATIVE_OPERATION_POLICIES
      ]).toMatchObject({ impact: "baseline", target: "none" });
    }

    expect(DERIVATIVE_OPERATION_POLICIES["annotation.convert"]).toMatchObject({
      impact: "content",
      target: "placed-item",
    });
    expect(DERIVATIVE_OPERATION_POLICIES["deliverable.framing.override"].impact)
      .toBe("content");
  });

  it.each([
    ["layer lock", {
      op: "layer.lock",
      params: { layerId: "lyr_bbbbbbbbbb" },
    }],
    ["annotation create", {
      op: "annotation.create",
      params: {
        annotation: {
          id: "ann_aaaaaaaaaa",
          canvasRef: { sequenceId: "seq_bbbbbbbbbb" },
        },
      },
    }],
    ["PiP avoid solve", {
      op: "pip.avoid.solve",
      params: { layerId: "lyr_bbbbbbbbbb" },
    }],
    ["avoid-region mark", {
      op: "region.mark",
      params: {
        region: {
          id: "avr_aaaaaaaaaa",
          source: "marked",
          hardness: "soft",
          rect: { x: 0, y: 0, w: 0.25, h: 0.25 },
        },
      },
    }],
    ["key QC", {
      op: "key.qc.run",
      params: { clipId: "clp_cccccccccc" },
    }],
    ["matte generation", {
      op: "key.matte.generate",
      params: {
        clipId: "clp_cccccccccc",
        neural: {
          model: "rvm_mobilenetv3",
          downsampleRatio: 0.5,
          stabilization: {
            enabled: true,
            alphaMin: 0.1,
            motionGain: 1,
            minSpeckleArea: 0.01,
          },
        },
      },
    }],
  ])("does not classify short %s as an editorial divergence", async (_name, operation) => {
    const project = projectWithShort();
    const engine = new OperationEngine(project, {
      operationDispatcher: passThroughDispatcher(),
    });

    const result = await engine.execute([operation], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });

    expect(result).toMatchObject({ ok: true });
    expect(engine.currentProject.deliverables[1]?.divergences).toBeUndefined();
  });

  it("rejects an unknown divergence before invoking an analysis callback", async () => {
    let callbacks = 0;
    const project = projectWithShort();
    const engine = new OperationEngine(project, {
      operationDispatcher: passThroughDispatcher(() => {
        callbacks += 1;
      }),
    });

    const result = await engine.execute([{
      op: "key.qc.run",
      params: { clipId: "clp_cccccccccc" },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
      divergence: "unknown" as never,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_DIVERGENCE_CLASS" },
    });
    expect(callbacks).toBe(0);
  });

  it("preflights the whole batch before an analysis callback sees an unclassified short edit", async () => {
    let callbacks = 0;
    const project = projectWithShort();
    const engine = new OperationEngine(project, {
      operationDispatcher: passThroughDispatcher(() => {
        callbacks += 1;
      }),
    });

    const result = await engine.execute([{
      op: "key.qc.run",
      params: { clipId: "clp_cccccccccc" },
    }, {
      op: "clip.trim",
      params: {
        clipId: "clp_cccccccccc",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_DIVERGENCE_REQUIRED",
        affected: ["dlv_bbbbbbbbbb"],
      },
    });
    expect(callbacks).toBe(0);
  });

  it("does not persist a proposal draft when short content lacks a divergence", async () => {
    const savedStatuses: string[] = [];
    const project = projectWithShort();
    const proposalStore: ProposalStore = {
      head: project.revision,
      async readAcceptedRevision() {
        return success(project.revision);
      },
      async saveProposal(proposal) {
        savedStatuses.push(proposal.status);
        return success(proposal);
      },
      async readProposal() {
        throw new Error("readProposal should not be called");
      },
      async updateProposal() {
        throw new Error("updateProposal should not be called");
      },
      async archiveProposal() {
        throw new Error("archiveProposal should not be called");
      },
    };
    const engine = new OperationEngine(project, { proposalStore });

    const result = await engine.createProposal({
      operations: [{
        op: "clip.trim",
        params: {
          clipId: "clp_cccccccccc",
          edge: "tail",
          delta: { frames: 1, fps: "24/1" },
        },
      }],
      instruction: { kind: "user-text", text: "Tighten the short." },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa" },
      reason: {
        text: "Tighten the short by one frame.",
        sources: [{ kind: "instruction", ref: "Tighten the short." }],
      },
      addresses: [],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_DIVERGENCE_REQUIRED" },
    });
    expect(savedStatuses).toEqual([]);
  });

  it("dispatches a valid analysis-only batch exactly once without a divergence", async () => {
    let callbacks = 0;
    const project = projectWithShort();
    const engine = new OperationEngine(project, {
      operationDispatcher: passThroughDispatcher(() => {
        callbacks += 1;
      }),
    });

    const result = await engine.execute([{
      op: "key.qc.run",
      params: { clipId: "clp_cccccccccc" },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });

    expect(result).toMatchObject({ ok: true });
    expect(callbacks).toBe(1);
  });

  it("accepts and journals audio divergence for a short audio edit", async () => {
    const transactions: Array<{ divergence?: string }> = [];
    const project = projectWithShort();
    const engine = new OperationEngine(project, {
      committer: {
        async commit(model, transaction) {
          transactions.push(transaction);
          return success(model);
        },
      },
    });

    const result = await engine.execute([{
      op: "clip.audio.gain.set",
      params: {
        clipId: "clp_cccccccccc",
        gainDb: -3,
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
      divergence: "audio",
    });

    expect(result).toMatchObject({ ok: true });
    expect(transactions[0]?.divergence).toBe("audio");
    expect(engine.currentProject.deliverables[1]?.divergences).toEqual([{
      class: "audio",
      transactionIds: [expect.stringMatching(/^txn_/u)],
    }]);
  });

  it("does not infer a short target from an ID merely mentioned in user text", async () => {
    const project = projectWithShort();
    const engine = new OperationEngine(project);

    const result = await engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
        evidence: "Compared against clp_cccccccccc before trimming.",
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
    });

    expect(result).toMatchObject({ ok: true });
    expect(engine.currentProject.deliverables[1]?.divergences).toBeUndefined();
  });

  it("does not classify a long-form annotation overlay from its shared layer", () => {
    const before = projectWithShort();
    before.layers.push({
      id: "lyr_cccccccccc",
      kind: "animation",
      name: "Shared overlays",
      order: 2,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_bbbbbbbbbb",
        sequenceId: "seq_bbbbbbbbbb",
        template: "tpl_a2c3d4e5f6",
        at: "word:w000001",
        duration: { frames: 12, fps: "24/1" },
        params: {},
        seed: 1,
      }],
    });
    const after = structuredClone(before);
    after.layers.at(-1)!.items!.push({
      id: "gfx_cccccccccc",
      sequenceId: "seq_aaaaaaaaaa",
      template: "tpl_a2c3d4e5f6",
      at: "ann:ann_aaaaaaaaaa",
      duration: { frames: 12, fps: "24/1" },
      params: {},
      seed: 2,
    });

    expect(touchedDerivativeIds(before, after, [{
      op: "annotation.convert",
      params: {
        annotationId: "ann_aaaaaaaaaa",
        layerId: "lyr_cccccccccc",
        itemId: "gfx_cccccccccc",
      },
      affected: [
        "ann_aaaaaaaaaa",
        "lyr_cccccccccc",
        "gfx_cccccccccc",
      ],
    }])).toEqual([]);
  });

  it("preserves the captured divergence while reverting a historical short edit", async () => {
    const transactions: TransactionRecord[] = [];
    const project = projectWithShort();
    const engine = new OperationEngine(project, {
      committer: {
        async commit(model, transaction) {
          transactions.push(structuredClone(transaction));
          return success(model);
        },
        async readTransaction(id) {
          const transaction = transactions.find((candidate) => candidate.id === id);
          if (transaction === undefined) throw new Error(`Missing transaction ${id}`);
          return success(structuredClone(transaction));
        },
      },
    });
    const edited = await engine.execute([{
      op: "clip.trim",
      params: {
        clipId: "clp_cccccccccc",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
      },
    }], {
      baseRevision: project.revision,
      origin: "ui",
      dryRun: false,
      divergence: "cuts",
      recordUndo: false,
    });
    expect(edited).toMatchObject({ ok: true });
    if (!edited.ok) throw new Error(edited.error.message);

    const reverted = await engine.revertTransaction(edited.value.transactionId!);

    expect(reverted).toMatchObject({ ok: true });
    expect(transactions.map(({ divergence }) => divergence)).toEqual(["cuts", "cuts"]);
    expect(engine.currentProject.sequences[1]?.clips[0]?.source.out.frames).toBe(12);
  });
});
