import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProject,
  OperationEngine,
  parseTakeMarkerSidecar,
} from "../../../core/src/index.js";
import type {
  OperationEngine as OperationEngineType,
  ProjectStore,
  Result,
  TakeMarkerSidecar,
} from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { describe, expect, it, vi } from "vitest";

import { CaptureProjectMetadata } from "./capture-project-metadata.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

function resultValue<Value>(result: Result<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function coreEngine(store: ProjectStore): OperationEngine {
  return new OperationEngine(store.currentProject, {
    appVersion: "0.0.0-test",
    committer: store,
    proposalStore: store,
  });
}

function gatedEngine(
  store: ProjectStore,
  entered: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
): () => OperationEngineType {
  let calls = 0;
  return () => {
    const engine = coreEngine(store);
    const execute = engine.execute.bind(engine);
    vi.spyOn(engine, "execute").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return execute(...args);
    });
    return engine;
  };
}

async function expectRegisteredSidecar(
  store: ProjectStore,
  assetId: string,
): Promise<TakeMarkerSidecar> {
  const path = `sidecars/takes/${assetId}.takes.json`;
  const content = await readFile(join(store.root, path), "utf8");
  const reference = store.currentProject.sidecars.find((sidecar) =>
    sidecar.schema === "guyditor.take-markers/v1" && sidecar.path === path);
  expect(reference?.sha256).toBe(
    createHash("sha256").update(content).digest("hex"),
  );
  return parseTakeMarkerSidecar(content);
}

describe("CaptureProjectMetadata", () => {
  it("serializes a same-asset take and marker into one registered sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-capture-metadata-same-"));
    try {
      const store = resultValue(await createProject(root, projectFixture(), {
        appVersion: "0.0.0-test",
      }));
      const entered = deferred();
      const release = deferred();
      const metadata = new CaptureProjectMetadata({
        store,
        engine: gatedEngine(store, entered, release),
        publishRevision: () => undefined,
      });
      const marker: TakeMarkerSidecar["markers"][number] = {
        id: "mrk_aaaaaaaaaa",
        assetId: "ast_aaaaaaaaaa",
        at: { frame: 12, fps: "24/1" },
        type: "spoken",
        note: "take three",
        detected: true,
        source: "spoken",
      };

      const seeding = metadata.seedTake("ast_aaaaaaaaaa", {
        id: "tak_aaaaaaaaaa",
        index: 3,
      });
      await entered.promise;
      const marking = metadata.addMarkers("ast_aaaaaaaaaa", [marker]);
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      release.resolve();
      const settled = await Promise.allSettled([seeding, marking]);
      expect(settled).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);

      const sidecar = await expectRegisteredSidecar(store, "ast_aaaaaaaaaa");
      expect(sidecar.takes.map(({ id }) => id)).toEqual(["tak_aaaaaaaaaa"]);
      expect(sidecar.markers.map(({ id }) => id)).toEqual(["mrk_aaaaaaaaaa"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes metadata commits across different assets sharing one revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-capture-metadata-store-"));
    try {
      const model = projectFixture();
      model.assets.push({
        ...structuredClone(model.assets[0]!),
        id: "ast_bbbbbbbbbb",
        path: "media/b.mov",
        sha256: "b".repeat(64),
      });
      const store = resultValue(await createProject(root, model, {
        appVersion: "0.0.0-test",
      }));
      const entered = deferred();
      const release = deferred();
      const metadata = new CaptureProjectMetadata({
        store,
        engine: gatedEngine(store, entered, release),
        publishRevision: () => undefined,
      });

      const first = metadata.seedTake("ast_aaaaaaaaaa", {
        id: "tak_aaaaaaaaaa",
        index: 1,
      });
      await entered.promise;
      const second = metadata.seedTake("ast_bbbbbbbbbb", {
        id: "tak_bbbbbbbbbb",
        index: 2,
      });
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      release.resolve();
      const settled = await Promise.allSettled([first, second]);
      expect(settled).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);

      await expect(expectRegisteredSidecar(store, "ast_aaaaaaaaaa"))
        .resolves.toMatchObject({
          assetId: "ast_aaaaaaaaaa",
          takes: [{ id: "tak_aaaaaaaaaa" }],
        });
      await expect(expectRegisteredSidecar(store, "ast_bbbbbbbbbb"))
        .resolves.toMatchObject({
          assetId: "ast_bbbbbbbbbb",
          takes: [{ id: "tak_bbbbbbbbbb" }],
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges amended marker imports without duplicating prior markers or takes", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-capture-metadata-import-"));
    try {
      const model = projectFixture();
      model.assets[0]!.session = "ses_aaaaaaaaaa";
      const store = resultValue(await createProject(root, model, {
        appVersion: "0.0.0-test",
      }));
      const metadata = new CaptureProjectMetadata({
        store,
        engine: () => coreEngine(store),
        publishRevision: () => undefined,
      });
      const markerPath = join(root, "markers.json");
      const intake = (extra: boolean) => JSON.stringify({
        format: "guyditor.take-markers-intake/v1",
        session: "capture",
        clock: "recording",
        markers: [
          { at: 0.0625, type: "take-start", take: 3 },
          { at: 1.5, type: "mistake", note: "first correction" },
          { at: 2, type: "take-end", take: 3, quality: "good" },
          ...(extra
            ? [{ at: 2.5, type: "note", note: "amended note" }]
            : []),
        ],
      });
      await writeFile(markerPath, intake(false), "utf8");
      await metadata.importMarkerFile(markerPath, "ses_aaaaaaaaaa");
      await writeFile(markerPath, intake(true), "utf8");
      await metadata.importMarkerFile(markerPath, "ses_aaaaaaaaaa");

      const sidecar = await expectRegisteredSidecar(store, "ast_aaaaaaaaaa");
      expect(sidecar.markers).toHaveLength(4);
      expect(sidecar.markers.map(({ note }) => note).filter(Boolean)).toEqual([
        "first correction",
        "amended note",
      ]);
      expect(sidecar.takes).toHaveLength(1);
      expect(sidecar.takes[0]).toMatchObject({
        index: 3,
        notes: ["first correction"],
      });
      expect(new Set(sidecar.takes[0]!.sourceMarkerIds).size).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores registered bytes when a semantic metadata commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-capture-metadata-rollback-"));
    try {
      const store = resultValue(await createProject(root, projectFixture(), {
        appVersion: "0.0.0-test",
      }));
      const metadata = new CaptureProjectMetadata({
        store,
        engine: () => coreEngine(store),
        publishRevision: () => undefined,
      });
      await metadata.seedTake("ast_aaaaaaaaaa", {
        id: "tak_aaaaaaaaaa",
        index: 1,
      });
      const path = join(
        root,
        "sidecars/takes/ast_aaaaaaaaaa.takes.json",
      );
      const before = await readFile(path);
      const failing = new CaptureProjectMetadata({
        store,
        engine: () => {
          const engine = coreEngine(store);
          vi.spyOn(engine, "execute")
            .mockRejectedValue(new Error("semantic commit fixture"));
          return engine;
        },
        publishRevision: () => undefined,
      });

      await expect(failing.addMarkers("ast_aaaaaaaaaa", [{
        id: "mrk_aaaaaaaaaa",
        assetId: "ast_aaaaaaaaaa",
        at: { frame: 10, fps: "24/1" },
        type: "note",
        note: "must roll back",
        source: "notes",
      }])).rejects.toThrow("semantic commit fixture");

      expect(await readFile(path)).toEqual(before);
      await expect(expectRegisteredSidecar(store, "ast_aaaaaaaaaa"))
        .resolves.toMatchObject({
          markers: [],
          takes: [{ id: "tak_aaaaaaaaaa" }],
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
