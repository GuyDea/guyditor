import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProject,
  JobQueue,
  OperationEngine,
} from "../../../core/src/index.js";
import type { JobRecord } from "../../../core/src/index.js";
import {
  exportOutputPath,
  loadTemplateRuntime,
  RenderService,
  renderTemplatePng,
  TemplateAuthoringService,
  TemplateRegistry,
} from "../../src/index.js";
import { dhashFrame } from "./dhash.js";

interface AuthoredGolden {
  publishedContentHash: string;
  probeFrameSha256: string;
  exportDhash: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function terminal(queue: JobQueue, jobId: string): Promise<JobRecord> {
  const current = queue.get(jobId);
  if (current?.state === "done" || current?.state === "failed") return current;
  return new Promise<JobRecord>((resolveJob, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for authored-template export ${jobId}.`));
    }, 120_000);
    const unsubscribe = queue.onChange(({ job }) => {
      if (job.jobId !== jobId || (job.state !== "done" && job.state !== "failed")) return;
      clearTimeout(timeout);
      unsubscribe();
      resolveJob(job);
    });
  });
}

async function tinyProfiles(root: string): Promise<string> {
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
  return profiles;
}

describe("FR-612 authored-template end-to-end golden", () => {
  it("submits, validates, publishes, places, freezes, and exports a novel stat badge", async () => {
    const expected = JSON.parse(await readFile(
      new URL("./authored-template.golden.json", import.meta.url),
      "utf8",
    )) as AuthoredGolden;
    const root = await mkdtemp(join(tmpdir(), "guyditor-authored-golden-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "project");
    const profilesRoot = await tinyProfiles(root);
    const created = await createProject(projectRoot, {
      name: "Authored graphics proof",
      primaryOutputFormat: "youtube-longform@1.0.0",
    }, { profilesDirectory: profilesRoot });
    if (!created.ok) throw created.error;
    const store = created.value;
    const templatesRoot = join(root, "templates");
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
      now: () => new Date("2026-07-23T12:00:00.000Z"),
      probe: { frames: 4, framesPerSecondFloor: 0.1 },
    });
    const submitted = await authoring.submit({
      name: "Signal stat badge",
      description: "A seeded meter badge authored entirely from primitives.",
      manifest: {
        params: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["value", "accent"],
          properties: {
            value: { type: "number", minimum: 0, maximum: 100, default: 72 },
            accent: {
              type: "string",
              pattern: "^#[0-9A-Fa-f]{6}$",
              default: "#4DD6A4",
            },
          },
        },
        duration: { mode: "fixed", default: { frames: 12, fps: "30/1" } },
        assets: [],
      },
      source: `import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";
export default {
  render(ctx, params) {
    const progress = motion.easing.sample("ease-out", ctx.progress);
    ctx.canvas.fillStyle = "#101820";
    ctx.canvas.fillRect(0, 0, ctx.width, ctx.height);
    motion.shapes.roundedRect(ctx.canvas, {
      x: ctx.width * 0.12,
      y: ctx.height * 0.22,
      width: ctx.width * 0.76,
      height: ctx.height * 0.56,
      radius: ctx.height * 0.12,
      fill: "#172630",
      stroke: params.accent,
      strokeWidth: 2
    });
    motion.shapes.roundedRect(ctx.canvas, {
      x: ctx.width * 0.2,
      y: ctx.height * 0.46,
      width: Math.max(1, ctx.width * 0.6 * (params.value / 100) * progress),
      height: ctx.height * 0.12,
      radius: ctx.height * 0.05,
      fill: params.accent
    });
    ctx.canvas.fillStyle = params.accent;
    ctx.canvas.fillRect(ctx.rng.int(5, 10), 4, 2, 2);
  }
};`,
    }, { sessionId: "ses_a2c3d4e5f6", model: "golden-director" });
    if (!submitted.ok) {
      throw new Error(`Authored stat badge failed validation: ${JSON.stringify(submitted.checks)}`);
    }
    expect(submitted.checks.every(({ ok }) => ok)).toBe(true);
    const published = await authoring.review({
      submissionId: submitted.draft.submissionId,
      decision: "approve",
    });
    const descriptor = published.published;
    if (descriptor === undefined) throw new Error("approval did not publish a template");
    expect(descriptor.contentHash).toBe(expected.publishedContentHash);

    const pkg = await registry.package(
      descriptor.id,
      descriptor.version,
      descriptor.contentHash,
    );
    if (!pkg.ok) throw pkg.error;
    const runtime = await loadTemplateRuntime(pkg.value);
    if (!runtime.ok) throw runtime.error;
    const probe = renderTemplatePng(runtime.value, {
      params: { value: 72, accent: "#4DD6A4" },
      seed: 0x4755_5944,
      frame: 6,
      totalFrames: 12,
      fps: "30/1",
      width: 64,
      height: 36,
      safeArea: { top: 2, right: 3, bottom: 2, left: 3 },
      brand: { palette: {} },
    });
    if (!probe.ok) throw probe.error;
    expect(digest(probe.value)).toBe(expected.probeFrameSha256);

    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-authored-golden",
      committer: store,
      templateProvider: registry,
    });
    const placed = await engine.execute([{
      op: "graphic.add",
      params: {
        templateId: descriptor.id,
        anchor: `timeline:${store.currentProject.deliverables[0]!.sequenceId}@0`,
        duration: { frames: 12, fps: "30/1" },
        params: { value: 72, accent: "#4DD6A4" },
        seed: 0x4755_5944,
      },
    }], {
      baseRevision: store.currentProject.revision,
      origin: "ui",
      dryRun: false,
    });
    if (!placed.ok) throw placed.error;
    expect(store.currentProject.templates?.[descriptor.id]).toEqual({
      version: descriptor.version,
      contentHash: descriptor.contentHash,
    });

    const { queue } = JobQueue.open(join(projectRoot, ".guyditor/jobs.sqlite"), {
      concurrency: 1,
    });
    try {
      const render = new RenderService({
        projectRoot,
        store,
        jobQueue: queue,
        profilesRoot,
        templateRegistry: registry,
      });
      const frozen = await render.templateFreeze({
        revision: store.currentProject.revision,
        templateId: descriptor.id,
        params: { value: 72, accent: "#4DD6A4" },
        seed: 0x4755_5944,
        durationFrames: 12,
        placeAsClip: true,
      });
      const provenance = JSON.parse(
        await readFile(frozen.provenancePath, "utf8"),
      ) as { template: { contentHash: string } };
      expect(provenance.template.contentHash).toBe(descriptor.contentHash);
      expect(frozen.clipId).toMatch(/^clp_[a-z2-7]{10}$/u);

      const outputDirectory = join(root, "exports");
      const exportJob = await render.renderExport({
        revision: store.currentProject.revision,
        deliverableId: store.currentProject.settings.primaryDeliverable,
        variants: ["clean"],
        outputDir: outputDirectory,
      });
      for (const jobId of exportJob.jobIds) {
        const completed = await terminal(queue, jobId);
        expect(completed, completed.error?.message).toMatchObject({ state: "done" });
      }
      const output = exportOutputPath(
        outputDirectory,
        store.currentProject.settings.primaryDeliverable,
        "clean",
        "mp4",
      );
      expect(dhashFrame(output, 6)).toBe(expected.exportDhash);
    } finally {
      queue.close();
    }
  }, 120_000);
});
