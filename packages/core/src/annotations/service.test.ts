import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Full project + sidecar + journal setup per test is disk-heavy; the vitest
// 5 s default flakes under parallel full-suite load.
vi.setConfig({ testTimeout: 30_000 });

import * as corePackage from "../index.js";
import type {
  Annotation,
  AnnotationState,
  GuyditorProject,
  IdFactory,
  IdPrefix,
  OperationBatchResult,
  OperationContext,
  OperationInput,
  ProjectStore,
  Result,
} from "../index.js";
import { projectFixture } from "../project/test-fixtures.js";

const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";
const NOW = new Date("2026-07-18T12:00:00Z");
const roots: string[] = [];

interface AnnotationServiceInstance {
  execute(
    project: ProjectStore,
    operations: OperationInput[],
    context?: Omit<OperationContext, "baseRevision">,
  ): Promise<Result<OperationBatchResult>>;
  get(project: ProjectStore, annotationId: string): Promise<Result<Annotation | undefined>>;
  getState(
    project: ProjectStore,
    annotationId: string,
    pending?: ReadonlyArray<{ status: string; addresses: string[] }>,
  ): Promise<Result<AnnotationState | undefined>>;
  commitAccepted(
    project: ProjectStore,
    model: GuyditorProject,
    transaction: import("../index.js").TransactionRecord,
  ): Promise<Result<GuyditorProject>>;
}

interface AnnotationServiceConstructor {
  new(options?: { idFactory?: IdFactory; now?: () => Date }): AnnotationServiceInstance;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

function ids(): IdFactory {
  const ordinals = new Map<IdPrefix, number>();
  return (prefix) => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    const character = String.fromCharCode("a".charCodeAt(0) + ordinal);
    return `${prefix}_${character.repeat(10)}`;
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(`${settled.error.code}: ${settled.error.message}`);
  expect(settled.ok).toBe(true);
  return settled.value;
}

async function fixtureStore(idFactory: IdFactory): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-annotations-"));
  roots.push(root);
  const project = projectFixture();
  project.sidecars[0]!.inputs = [];
  project.sidecars[0]!.sha256 = createHash("sha256").update(EMPTY_ANNOTATIONS).digest("hex");
  const created = await corePackage.createProject(root, project, {
    idFactory,
    now: () => NOW,
  });
  const store = await valueOf(Promise.resolve(created));
  await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");
  return store;
}

function annotation(
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id: "ann_aaaaaaaaaa",
    shape: "arrow",
    body: "Move this upward",
    style: { color: "#ff3355", strokeWidth: 0.004 },
    geometry: {
      kind: "arrow",
      from: { x: 0.6123004, y: 0.3813998 },
      to: { x: 0.7021, y: 0.2449 },
    },
    anchor: {
      kind: "clip",
      clipId: "clp_aaaaaaaaaa",
      assetId: "ast_aaaaaaaaaa",
      sourceFrame: { frames: 12, fps: "24/1" },
    },
    extent: { frames: 0, fps: "24/1" },
    canvasRef: { sequenceId: "seq_aaaaaaaaaa", aspect: "16:9" },
    state: "open",
    blocking: true,
    author: { kind: "human", id: "creator" },
    createdAt: NOW.toISOString(),
    history: [],
    ...overrides,
  };
}

function serviceApi(): AnnotationServiceConstructor | undefined {
  const candidate = (corePackage as unknown as { AnnotationService?: AnnotationServiceConstructor })
    .AnnotationService;
  expect(typeof candidate).toBe("function");
  return candidate;
}

describe("AnnotationService", () => {
  it("keeps sidecar bytes, registry hash, summary, and transaction history consistent", async () => {
    const Service = serviceApi();
    if (Service === undefined) return;
    const idFactory = ids();
    const store = await fixtureStore(idFactory);
    const service = new Service({ idFactory, now: () => NOW });

    const created = await valueOf(service.execute(store, [{
      op: "annotation.create",
      params: { annotation: annotation() },
    }]));
    expect(created.applied[0]).toMatchObject({
      op: "annotation.create",
      summary: "Added arrow annotation ann_aaaaaaaaaa at clip clp_aaaaaaaaaa",
    });
    expect(store.currentProject.annotations.summary).toEqual({
      open: 1,
      resolved: 0,
      rejected: 0,
      reopened: 0,
    });

    const sidecarText = await readFile(join(store.root, "sidecars/annotations.yaml"), "utf8");
    const reference = store.currentProject.sidecars.find(({ name }) => name === "annotations")!;
    expect(reference.sha256).toBe(createHash("sha256").update(sidecarText).digest("hex"));
    expect(sidecarText).toContain("x: 0.612300");
    expect((await valueOf(service.get(store, "ann_aaaaaaaaaa")))?.geometry)
      .toMatchObject({ from: { x: 0.6123, y: 0.3814 } });

    await valueOf(service.execute(store, [{
      op: "annotation.resolve",
      params: { annotationId: "ann_aaaaaaaaaa", reason: "Fixed manually" },
    }]));
    expect(store.currentProject.annotations.summary).toEqual({
      open: 0,
      resolved: 1,
      rejected: 0,
      reopened: 0,
    });
    const resolved = await valueOf(service.get(store, "ann_aaaaaaaaaa"));
    expect(resolved).toMatchObject({
      state: "resolved",
      resolvedBy: { txnId: "txn_cccccccccc", revision: "rev_00003" },
      history: [{
        from: "open",
        to: "resolved",
        actor: { kind: "human", id: "ui" },
        txnId: "txn_cccccccccc",
        reason: "Fixed manually",
      }],
    });
  });

  it("enforces the persisted transition matrix and derives addressed from ready proposals", async () => {
    const Service = serviceApi();
    if (Service === undefined) return;
    const idFactory = ids();
    const store = await fixtureStore(idFactory);
    const service = new Service({ idFactory, now: () => NOW });
    await valueOf(service.execute(store, [{
      op: "annotation.create",
      params: { annotation: annotation() },
    }]));

    expect(await valueOf(service.getState(store, "ann_aaaaaaaaaa", [{
      status: "ready",
      addresses: ["ann_aaaaaaaaaa"],
    }]))).toBe("addressed");
    expect(await valueOf(service.getState(store, "ann_aaaaaaaaaa", [{
      status: "rejected",
      addresses: ["ann_aaaaaaaaaa"],
    }]))).toBe("open");

    await valueOf(service.execute(store, [{
      op: "annotation.resolve",
      params: { annotationId: "ann_aaaaaaaaaa", reason: "Done" },
    }]));
    const illegal = await service.execute(store, [{
      op: "annotation.reject",
      params: { annotationId: "ann_aaaaaaaaaa", reason: "No" },
    }]);
    expect(illegal).toMatchObject({
      ok: false,
      error: { code: "E_ANN_INVALID_TRANSITION", affected: ["ann_aaaaaaaaaa"] },
    });

    await valueOf(service.execute(store, [{
      op: "annotation.reopen",
      params: { annotationId: "ann_aaaaaaaaaa", reason: "Regression" },
    }]));
    await valueOf(service.execute(store, [{
      op: "annotation.reject",
      params: { annotationId: "ann_aaaaaaaaaa", reason: "Won't fix" },
    }]));
    expect(await valueOf(service.getState(store, "ann_aaaaaaaaaa"))).toBe("rejected");
  });

  it("accepts exactly the six legal persisted lifecycle transitions", async () => {
    const Service = serviceApi();
    if (Service === undefined) return;
    const states = ["open", "resolved", "rejected", "reopened"] as const;
    const targets = ["resolved", "rejected", "reopened"] as const;
    const operationFor = {
      resolved: "annotation.resolve",
      rejected: "annotation.reject",
      reopened: "annotation.reopen",
    } as const;
    const legal = new Set([
      "open:resolved",
      "open:rejected",
      "resolved:reopened",
      "rejected:reopened",
      "reopened:resolved",
      "reopened:rejected",
    ]);

    for (const from of states) {
      for (const to of targets) {
        const idFactory = ids();
        const store = await fixtureStore(idFactory);
        const service = new Service({ idFactory, now: () => NOW });
        await valueOf(service.execute(store, [{
          op: "annotation.create",
          params: { annotation: annotation({ state: from }) },
        }]));
        const transitioned = await service.execute(store, [{
          op: operationFor[to],
          params: { annotationId: "ann_aaaaaaaaaa", reason: `${from} to ${to}` },
        }]);
        const edge = `${from}:${to}`;
        if (legal.has(edge)) {
          expect(transitioned, edge).toMatchObject({ ok: true });
          expect(await valueOf(service.getState(store, "ann_aaaaaaaaaa")), edge).toBe(to);
        } else {
          expect(transitioned, edge).toMatchObject({
            ok: false,
            error: { code: "E_ANN_INVALID_TRANSITION" },
          });
          expect(await valueOf(service.getState(store, "ann_aaaaaaaaaa")), edge).toBe(from);
        }
      }
    }
  });

  it("atomically resolves accepted addresses and records annotation.resolve in that transaction", async () => {
    const Service = serviceApi();
    if (Service === undefined) return;
    const idFactory = ids();
    const store = await fixtureStore(idFactory);
    const service = new Service({ idFactory, now: () => NOW });
    await valueOf(service.execute(store, [{
      op: "annotation.create",
      params: { annotation: annotation() },
    }]));

    const accepted = await valueOf(service.execute(store, [], {
      origin: "system",
      actor: { kind: "human", id: "reviewer" },
      dryRun: false,
      addresses: ["ann_aaaaaaaaaa"],
    }));
    const journal = (await readFile(join(store.root, "history/transactions.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as {
        id: string;
        addresses: string[];
        operations: Array<{ op: string; params: Record<string, unknown> }>;
      });
    const transaction = journal.at(-1)!;

    expect(accepted.transactionId).toBe(transaction.id);
    expect(transaction.addresses).toEqual(["ann_aaaaaaaaaa"]);
    expect(transaction.operations.at(-1)).toMatchObject({
      op: "annotation.resolve",
      params: { annotationId: "ann_aaaaaaaaaa", txnId: transaction.id },
    });
    expect(await valueOf(service.getState(store, "ann_aaaaaaaaaa"))).toBe("resolved");
  });

  it("stamps an open annotation orphan and transaction bookkeeping when its clip is removed in a real commit", async () => {
    const Service = serviceApi();
    if (Service === undefined) return;
    const idFactory = ids();
    const store = await fixtureStore(idFactory);
    const service = new Service({ idFactory, now: () => NOW });
    await valueOf(service.execute(store, [{
      op: "annotation.create",
      params: { annotation: annotation() },
    }]));

    const removed = structuredClone(store.currentProject);
    removed.revision = "rev_00003";
    removed.sequences[0]!.clips.splice(0, 1);
    await valueOf(service.commitAccepted(store, removed, {
      id: "txn_cccccccccc",
      baseRevision: "rev_00002",
      resultRevision: "rev_00003",
      operations: [{
        op: "clip.remove",
        params: { clipId: "clp_aaaaaaaaaa", closeGap: true },
        summary: "Remove clp_aaaaaaaaaa",
      }],
      instruction: { kind: "ui-direct" },
      actor: { kind: "human", id: "ui" },
      versions: {
        app: "0.0.0",
        schema: "guyditor/v1",
        skills: [{ id: "skl_aaaaaaaaaa", version: "1.0.0" }],
        presets: [{ id: "pre_aaaaaaaaaa", version: 1 }],
        tools: [],
      },
      acceptance: { status: "accepted", by: "ui", at: NOW.toISOString() },
      orphanedAnchors: [],
      addresses: [],
    }));

    expect(await valueOf(service.get(store, "ann_aaaaaaaaaa"))).toMatchObject({
      state: "open",
      orphan: {
        detectedAtRevision: "rev_00003",
        lastResolved: {
          sequenceId: "seq_aaaaaaaaaa",
          timelineFrame: { frames: 12, fps: "24/1" },
        },
      },
    });
    const transaction = JSON.parse(
      (await readFile(join(store.root, "history/transactions.jsonl"), "utf8"))
        .trim().split("\n").at(-1)!,
    ) as { orphanedAnchors: unknown };
    expect(transaction.orphanedAnchors).toEqual([{
      owner: "ann_aaaaaaaaaa",
      anchor: "ann:ann_aaaaaaaaaa",
    }]);
  });

  it("converts only through annotation.convert, creates a renderable item, and addresses its source", async () => {
    const Service = serviceApi();
    if (Service === undefined) return;
    const idFactory = ids();
    const store = await fixtureStore(idFactory);
    const withTemplate: GuyditorProject = store.currentProject;
    withTemplate.templates = {
      tpl_aaaaaaaaaa: { version: "1.0.0", contentHash: "b".repeat(64) },
    };
    withTemplate.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "graphics",
      order: 10,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    });
    const service = new Service({ idFactory, now: () => NOW });
    await valueOf(service.execute(store, [{
      op: "annotation.create",
      params: { annotation: annotation() },
    }]));
    expect(store.currentProject.layers[0]!.items ?? []).toEqual([]);

    const converted = await valueOf(service.execute(store, [{
      op: "annotation.convert",
      params: {
        annotationId: "ann_aaaaaaaaaa",
        layerId: "lyr_bbbbbbbbbb",
        templateId: "tpl_aaaaaaaaaa",
        styleOverrides: { label: "review-fix" },
      },
    }]));

    expect(converted.riskClass).toBe("normal");
    expect(store.currentProject.layers[1]!.items?.[0]).toMatchObject({
      id: "gfx_aaaaaaaaaa",
      template: "tpl_aaaaaaaaaa",
      at: "ann:ann_aaaaaaaaaa",
      duration: { frames: 48, fps: "24/1" },
      source: { annotationId: "ann_aaaaaaaaaa" },
      params: {
        shape: "arrow",
        styleOverrides: { label: "review-fix" },
      },
    });
    expect(await valueOf(service.get(store, "ann_aaaaaaaaaa"))).toMatchObject({
      state: "resolved",
      convertedTo: {
        itemId: "gfx_aaaaaaaaaa",
        txnId: converted.transactionId,
      },
    });
    const transactionLine = (await readFile(join(store.root, "history/transactions.jsonl"), "utf8"))
      .trim().split("\n").at(-1)!;
    expect(JSON.parse(transactionLine)).toMatchObject({ addresses: ["ann_aaaaaaaaaa"] });
  });

  it("freezes a freehand annotation as a generated SVG asset on an image layer", async () => {
    const Service = serviceApi();
    if (Service === undefined) return;
    const idFactory = ids();
    const store = await fixtureStore(idFactory);
    const service = new Service({ idFactory, now: () => NOW });
    await valueOf(service.execute(store, [{
      op: "annotation.create",
      params: {
        annotation: annotation({
          shape: "freehand",
          body: "Trace this path",
          geometry: {
            kind: "freehand",
            points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }],
            closed: false,
          },
        }),
      },
    }]));

    const converted = await valueOf(service.execute(store, [{
      op: "annotation.convert",
      params: {
        annotationId: "ann_aaaaaaaaaa",
        createdLayerId: "lyr_bbbbbbbbbb",
        assetId: "ast_bbbbbbbbbb",
      },
    }]));

    expect(converted.applied[0]?.inverse).toMatchObject([{
      op: "annotation.convert",
      params: {
        annotationId: "ann_aaaaaaaaaa",
        revert: { createdLayer: true },
      },
    }]);
    expect(store.currentProject.layers.at(-1)).toMatchObject({
      id: "lyr_bbbbbbbbbb",
      kind: "image",
      items: [{
        id: "gfx_aaaaaaaaaa",
        asset: "ast_bbbbbbbbbb",
        at: "ann:ann_aaaaaaaaaa",
        source: { annotationId: "ann_aaaaaaaaaa" },
      }],
    });
    expect(store.currentProject.assets.at(-1)).toMatchObject({
      id: "ast_bbbbbbbbbb",
      kind: "generated",
      path: "media/generated/ast_bbbbbbbbbb.svg",
      provenance: { sidecar: "provenance-ast_bbbbbbbbbb" },
    });
    const svg = await readFile(
      join(store.root, "media/generated/ast_bbbbbbbbbb.svg"),
      "utf8",
    );
    expect(svg).toContain('<polyline points="100000,200000 300000,400000"');
    expect(await readFile(
      join(store.root, "sidecars/provenance/ast_bbbbbbbbbb.provenance.json"),
      "utf8",
    )).toContain('"reviewAnnotationId": "ann_aaaaaaaaaa"');
  });
});
