import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProject,
  deriveTimeline,
  JobQueue,
  OperationEngine,
} from "../../core/src/index.js";
import type { ProjectStore } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import {
  RenderService,
  TemplateAuthoringService,
  TemplateRegistry,
} from "./index.js";

const temporaryDirectories: string[] = [];
type FreezePhase = "rendered" | "exact-preflighted" | "published";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixtureProfiles(root: string): Promise<string> {
  const profiles = join(root, "profiles");
  const destination = join(profiles, "youtube-longform", "1.0.0.yaml");
  await mkdir(join(destination, ".."), { recursive: true });
  const source = await readFile(
    resolve("profiles/youtube-longform/1.0.0.yaml"),
    "utf8",
  );
  await writeFile(
    destination,
    source
      .replace(
        "resolution: { width: 3840, height: 2160 }",
        "resolution: { width: 64, height: 36 }",
      )
      .replace(
        "- { width: 3840, height: 2160 }",
        "- { width: 64, height: 36 }",
      ),
    "utf8",
  );
  const shortsDestination = join(profiles, "youtube-shorts", "1.0.0.yaml");
  await mkdir(join(shortsDestination, ".."), { recursive: true });
  const shortsSource = await readFile(
    resolve("profiles/youtube-shorts/1.0.0.yaml"),
    "utf8",
  );
  await writeFile(
    shortsDestination,
    shortsSource.replace(
      "resolution: { width: 1080, height: 1920 }",
      "resolution: { width: 36, height: 64 }",
    ),
    "utf8",
  );
  return profiles;
}

async function entriesOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function expectNoFreezeArtifacts(
  projectRoot: string,
  store: ProjectStore,
): Promise<void> {
  expect(await entriesOrEmpty(join(projectRoot, "media/programmatic"))).toEqual([]);
  expect(await entriesOrEmpty(join(projectRoot, "sidecars/programmatic"))).toEqual([]);
  expect(await entriesOrEmpty(
    join(projectRoot, ".guyditor/cache/render/template-freeze"),
  )).toEqual([]);
  expect(store.currentProject.assets).toHaveLength(0);
  expect(store.currentProject.sidecars).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ schema: "guyditor.programmatic-provenance/v1" }),
  ]));
}

async function acceptFixtureEdit(store: ProjectStore): Promise<void> {
  const layer = store.currentProject.layers[0];
  if (layer === undefined) throw new Error("Freeze fixture has no layer.");
  const result = await new OperationEngine(store.currentProject, {
    committer: store,
  }).execute([{
    op: layer.locked ? "layer.unlock" : "layer.lock",
    params: { layerId: layer.id },
  }], {
    baseRevision: store.currentProject.revision,
    origin: "ui",
    dryRun: false,
    recordUndo: false,
  });
  if (!result.ok) throw result.error;
}

describe("template freeze service", () => {
  it("rejects an authored draft before materializing freeze frames or assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-template-freeze-draft-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "project");
    const profilesRoot = await fixtureProfiles(root);
    const storeResult = await createProject(projectRoot, {
      name: "Draft freeze boundary",
      primaryOutputFormat: "youtube-longform@1.0.0",
    }, { profilesDirectory: profilesRoot });
    if (!storeResult.ok) throw storeResult.error;
    const templatesRoot = join(root, "user-templates");
    const registry = new TemplateRegistry({
      builtinsRoot: join(root, "empty-builtins"),
      userRoot: templatesRoot,
      draftRoot: join(templatesRoot, ".drafts"),
    });
    const ids = ["tas_a2c3d4e5f6", "tpl_b2c3d4e5f6"];
    const authoring = new TemplateAuthoringService({
      registry,
      draftRoot: join(templatesRoot, ".drafts"),
      idFactory: () => ids.shift()!,
      probe: { frames: 2, framesPerSecondFloor: 0.1 },
    });
    const submitted = await authoring.submit({
      name: "Unreviewed freeze fixture",
      description: "Must remain preview-only.",
      manifest: {
        params: { type: "object", additionalProperties: false },
        duration: { mode: "fixed", default: { frames: 12, fps: "24/1" } },
        assets: [],
      },
      source: "export default { render(ctx) { ctx.canvas.fillRect(0, 0, 12, 12); } };\n",
    }, { sessionId: "ses_a2c3d4e5f6", model: "freeze-test" });
    if (!submitted.ok) throw new Error("expected authored draft");
    const { queue } = JobQueue.open(":memory:", { concurrency: 1 });
    const service = new RenderService({
      projectRoot,
      profilesRoot,
      store: storeResult.value,
      jobQueue: queue,
      templateRegistry: registry,
    });
    try {
      await expect(service.templateFreeze({
        revision: storeResult.value.currentProject.revision,
        templateId: submitted.draft.templateId,
        params: {},
        durationFrames: 2,
      })).rejects.toMatchObject({
        code: "E_TEMPLATE_UNREVIEWED",
        acceptedStateChanged: false,
      });
      await expect(stat(join(projectRoot, ".guyditor/cache/render/template-freeze")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(storeResult.value.currentProject.assets).toHaveLength(0);
    } finally {
      queue.close();
    }
  });

  it("freezes and places the first clip in an empty project", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-template-freeze-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "project");
    const profilesRoot = await fixtureProfiles(root);
    const storeResult = await createProject(projectRoot, {
      name: "Empty graphics-first project",
      primaryOutputFormat: "youtube-longform@1.0.0",
    }, { profilesDirectory: profilesRoot });
    if (!storeResult.ok) throw storeResult.error;
    const store = storeResult.value;
    const { queue } = JobQueue.open(":memory:", { concurrency: 1 });
    const registry = new TemplateRegistry({
      builtinsRoot: resolve("templates"),
      userRoot: join(root, "user-templates"),
      projectRoot: join(projectRoot, "templates"),
    });
    const service = new RenderService({
      projectRoot,
      profilesRoot,
      store,
      jobQueue: queue,
      templateRegistry: registry,
    });
    try {
      const deliverableId = store.currentProject.settings.primaryDeliverable;
      const sequenceId = store.currentProject.deliverables.find(
        ({ id }) => id === deliverableId,
      )?.sequenceId;
      if (sequenceId === undefined) throw new Error("Fixture has no sequence.");

      const result = await service.templateFreeze({
        revision: store.currentProject.revision,
        deliverableId,
        templateId: "tpl_k2m3n4p5q6",
        params: {
          accent: "#7C3AED",
          surface: "#111827",
          ink: "#F8FAFC",
        },
        seed: 20260723,
        durationFrames: 3,
        placeAsClip: true,
      });

      expect(result).toMatchObject({
        assetId: expect.stringMatching(/^ast_[a-z2-7]{10}$/u),
        clipId: expect.stringMatching(/^clp_[a-z2-7]{10}$/u),
        sequenceId,
        frames: 3,
        fps: "30/1",
        width: 64,
        height: 36,
        revision: store.currentProject.revision,
      });
      const asset = store.currentProject.assets.find(({ id }) => id === result.assetId);
      expect(asset).toMatchObject({
        kind: "generated",
        rights: { origin: "programmatic" },
        provenance: { sidecar: `programmatic-${result.assetId}` },
      });
      const sidecar = store.currentProject.sidecars.find(
        ({ name }) => name === `programmatic-${result.assetId}`,
      );
      expect(sidecar).toBeDefined();
      if (sidecar === undefined) return;
      const sidecarBytes = await readFile(join(projectRoot, sidecar.path));
      expect(createHash("sha256").update(sidecarBytes).digest("hex")).toBe(sidecar.sha256);
      expect(sidecarBytes.toString("utf8")).toContain(
        '"primitives": "primitives/v1@1"',
      );
      const freezeRoot = join(
        projectRoot,
        ".guyditor/cache/render/template-freeze",
      );
      expect(await entriesOrEmpty(freezeRoot)).toEqual([]);
      const output = await stat(result.outputPath);
      expect(output.size).toBeGreaterThan(0);
      expect(output.mode & 0o222).toBe(0);
      const timeline = deriveTimeline(store.currentProject, sequenceId);
      expect(timeline).toMatchObject({
        ok: true,
        value: {
          duration: "1/10",
          clips: [{
            clipId: result.clipId,
            duration: { frames: 3, fps: "30/1" },
          }],
        },
      });
    } finally {
      queue.close();
    }
  }, 30_000);

  it.each<FreezePhase>(["rendered", "exact-preflighted", "published"])(
    "cleans every temporary and published artifact when the %s phase fails",
    async (failedPhase) => {
      const root = await mkdtemp(join(tmpdir(), `guyditor-template-freeze-${failedPhase}-`));
      temporaryDirectories.push(root);
      const projectRoot = join(root, "project");
      const profilesRoot = await fixtureProfiles(root);
      const storeResult = await createProject(projectRoot, {
        name: `Freeze failure at ${failedPhase}`,
        primaryOutputFormat: "youtube-longform@1.0.0",
      }, { profilesDirectory: profilesRoot });
      if (!storeResult.ok) throw storeResult.error;
      const { queue } = JobQueue.open(":memory:", { concurrency: 1 });
      const service = new RenderService({
        projectRoot,
        profilesRoot,
        store: storeResult.value,
        jobQueue: queue,
        templateRegistry: new TemplateRegistry({
          builtinsRoot: resolve("templates"),
          userRoot: join(root, "user-templates"),
          projectRoot: join(projectRoot, "templates"),
        }),
        onTemplateFreezePhase: async (phase) => {
          if (phase === failedPhase) throw new Error(`Injected ${phase} failure.`);
        },
      });
      try {
        await expect(service.templateFreeze({
          revision: storeResult.value.currentProject.revision,
          templateId: "tpl_k2m3n4p5q6",
          durationFrames: 2,
        })).rejects.toThrow(`Injected ${failedPhase} failure.`);
        await expectNoFreezeArtifacts(projectRoot, storeResult.value);
      } finally {
        queue.close();
      }
    },
    30_000,
  );

  it.each<FreezePhase>(["rendered", "published"])(
    "rejects a revision race at the %s phase without leaking freeze artifacts",
    async (racePhase) => {
      const root = await mkdtemp(join(tmpdir(), `guyditor-template-freeze-race-${racePhase}-`));
      temporaryDirectories.push(root);
      const projectRoot = join(root, "project");
      const profilesRoot = await fixtureProfiles(root);
      const storeResult = await createProject(projectRoot, {
        name: `Freeze race at ${racePhase}`,
        primaryOutputFormat: "youtube-longform@1.0.0",
      }, { profilesDirectory: profilesRoot });
      if (!storeResult.ok) throw storeResult.error;
      const { queue } = JobQueue.open(":memory:", { concurrency: 1 });
      let raced = false;
      const service = new RenderService({
        projectRoot,
        profilesRoot,
        store: storeResult.value,
        jobQueue: queue,
        templateRegistry: new TemplateRegistry({
          builtinsRoot: resolve("templates"),
          userRoot: join(root, "user-templates"),
          projectRoot: join(projectRoot, "templates"),
        }),
        onTemplateFreezePhase: async (phase) => {
          if (phase !== racePhase || raced) return;
          raced = true;
          await acceptFixtureEdit(storeResult.value);
        },
      });
      try {
        await expect(service.templateFreeze({
          revision: storeResult.value.currentProject.revision,
          templateId: "tpl_k2m3n4p5q6",
          durationFrames: 2,
        })).rejects.toMatchObject({
          code: expect.stringMatching(/STALE/u),
        });
        expect(raced).toBe(true);
        await expectNoFreezeArtifacts(projectRoot, storeResult.value);
      } finally {
        queue.close();
      }
    },
    30_000,
  );

  it("preflights and classifies a freeze placed into a short", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-template-freeze-short-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "project");
    const profilesRoot = await fixtureProfiles(root);
    const model = projectFixture();
    model.sequences.push({
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
    model.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "video",
      name: "short",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_bbbbbbbbbb",
    });
    model.deliverables.push({
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
    const storeResult = await createProject(projectRoot, model, {
      profilesDirectory: profilesRoot,
    });
    if (!storeResult.ok) throw storeResult.error;
    const { queue } = JobQueue.open(":memory:", { concurrency: 1 });
    const service = new RenderService({
      projectRoot,
      profilesRoot,
      store: storeResult.value,
      jobQueue: queue,
      templateRegistry: new TemplateRegistry({
        builtinsRoot: resolve("templates"),
        userRoot: join(root, "user-templates"),
        projectRoot: join(projectRoot, "templates"),
      }),
    });
    try {
      await expect(service.templateFreeze({
        revision: storeResult.value.currentProject.revision,
        deliverableId: "dlv_bbbbbbbbbb",
        templateId: "tpl_k2m3n4p5q6",
        durationFrames: 2,
        placeAsClip: true,
        clipIndex: 99,
      })).rejects.toMatchObject({ code: "E_OP_RANGE_OUT_OF_BOUNDS" });
      await expect(stat(join(projectRoot, ".guyditor/cache/render/template-freeze")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const result = await service.templateFreeze({
        revision: storeResult.value.currentProject.revision,
        deliverableId: "dlv_bbbbbbbbbb",
        templateId: "tpl_k2m3n4p5q6",
        params: {
          accent: "#7C3AED",
          surface: "#111827",
          ink: "#F8FAFC",
        },
        durationFrames: 2,
        placeAsClip: true,
      });

      expect(result).toMatchObject({
        sequenceId: "seq_bbbbbbbbbb",
        frames: 2,
        width: 36,
        height: 64,
      });
      expect(await readFile(join(projectRoot, "history/transactions.jsonl"), "utf8"))
        .toContain('"divergence":"graphics"');
    } finally {
      queue.close();
    }
  }, 30_000);
});
