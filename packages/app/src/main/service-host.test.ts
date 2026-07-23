import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnnotationService, createProject, JobQueue, OperationEngine } from "../../../core/src/index.js";
import type { JobOverview, Proposal, Result } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { TranscriptEngine } from "../../../transcript/src/index.js";
import { SkillRegistry } from "../../../agent/src/index.js";
import { describe, expect, it } from "vitest";

import type { GdEvent } from "../shared/ipc.js";
import { WindowEventPublisher } from "./events.js";
import { AppServiceHost } from "./service-host.js";

describe("AppServiceHost", () => {
  it("freezes an accepted matte candidate as a read-only generated asset with provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-matte-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-matte-user-"));
    const model = projectFixture();
    const created = await createProject(root, model);
    if (!created.ok) throw created.error;
    const candidatePath = join(root, ".guyditor", "cache", "mattes", "candidate.mkv");
    await mkdir(join(root, ".guyditor", "cache", "mattes"), { recursive: true });
    const candidateBytes = Buffer.from("deterministic frozen matte fixture");
    await writeFile(candidatePath, candidateBytes);
    const candidateSha = createHash("sha256").update(candidateBytes).digest("hex");
    const { queue } = JobQueue.open(join(root, ".guyditor", "jobs.sqlite"));
    queue.registerExecutor("matte", async (job) => ({
      clipId: "clp_aaaaaaaaaa",
      sourceAssetId: "ast_aaaaaaaaaa",
      jobId: job.jobId,
      schema: "guyditor.matte/v1",
      path: candidatePath,
      format: "ffv1-gray-mkv",
      sha256: candidateSha,
      cacheKey: "c".repeat(64),
      source: {
        path: join(root, "media", "a.mov"),
        sha256: model.assets[0]!.sha256,
        frames: { from: 0, to: 23 },
      },
      width: 1920,
      height: 1080,
      frameCount: 24,
      fps: "24/1",
      alpha: { minimum: 0, maximum: 255, nonZeroFrames: 24 },
      engine: { name: "rvm", version: "torchscript-fixture", model: "rvm_mobilenetv3" },
      params: {
        model: "rvm_mobilenetv3",
        downsampleRatio: 0.5,
        stabilization: { enabled: true, alphaMin: 0.35, motionGain: 4, minSpeckleArea: 0.00001 },
      },
    }));
    const queued = queue.enqueue({
      kind: "matte",
      title: "Generate neural matte for clp_aaaaaaaaaa",
      cancellable: true,
      payload: { clipId: "clp_aaaaaaaaaa" },
    });
    const deadline = Date.now() + 2_000;
    while (queue.get(queued.jobId)?.state !== "done") {
      if (Date.now() > deadline) throw new Error("Matte fixture job did not finish.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    queue.close();

    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher(() => undefined),
    });
    await windowHost.openProject(root);
    const execute = windowHost.resolveService("OperationEngine")?.["execute"];
    if (typeof execute !== "function") throw new Error("Operation engine is unavailable.");
    await expect(Reflect.apply(execute, undefined, [{
      operations: [{
        op: "key.matte.generate",
        params: {
          clipId: "clp_aaaaaaaaaa",
          neural: {
            model: "rvm_mobilenetv3",
            downsampleRatio: 0.5,
            stabilization: { enabled: true, alphaMin: 0.35, motionGain: 4, minSpeckleArea: 0.00001 },
          },
        },
      }],
      intent: "direct",
      label: "Generate unavailable matte",
    }])).rejects.toMatchObject({ code: "E_MATTE_CAPABILITY_MISSING" });
    const service = windowHost.resolveService("CompositorModel");
    const candidates = service?.["matteCandidates"];
    const accept = service?.["acceptMatteCandidate"];
    if (typeof candidates !== "function" || typeof accept !== "function") {
      throw new Error("Matte candidate service is unavailable.");
    }
    expect(Reflect.apply(candidates, service, [{ clipId: "clp_aaaaaaaaaa" }]))
      .toMatchObject([{ jobId: queued.jobId, alpha: { maximum: 255 } }]);
    const accepted = await Reflect.apply(accept, service, [{
      clipId: "clp_aaaaaaaaaa",
      jobId: queued.jobId,
    }]) as { assetId: string; path: string };
    const snapshot = windowHost.snapshot().master;
    const asset = snapshot.assets.find(({ id }) => id === accepted.assetId);
    expect(asset).toMatchObject({
      kind: "generated",
      sha256: candidateSha,
      provenance: { sidecar: `provenance-${accepted.assetId}` },
      analyses: { matte: { sourceFrames: { from: 0, to: 23 } } },
    });
    expect(snapshot.sequences[0]!.clips[0]!.effects).toContainEqual(expect.objectContaining({
      kind: "key",
      params: expect.objectContaining({
        mode: "neural",
        neural: expect.objectContaining({ matteAssetId: accepted.assetId }),
      }),
    }));
    expect(await readFile(join(root, accepted.path))).toEqual(candidateBytes);
    expect((await stat(join(root, accepted.path))).mode & 0o222).toBe(0);
    expect(await readFile(join(root, `sidecars/provenance/${accepted.assetId}.provenance.json`), "utf8"))
      .toContain('"sourceAssetId": "ast_aaaaaaaaaa"');
    const historyText = await readFile(join(root, "history/transactions.jsonl"), "utf8");
    expect(historyText).toContain('"op":"sidecar.register"');
    expect(historyText).toContain('"op":"asset.ingest"');
    expect(historyText).toContain('"op":"clip.key.set"');

    await windowHost.close();
    await appHost.close();
  });

  it("exposes storage scan and plan-then-execute cleanup through BackupService", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-storage-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-storage-user-"));
    const created = await createProject(root, projectFixture());
    if (!created.ok) throw created.error;
    const cacheFile = join(root, ".guyditor/cache/analysis/disposable.bin");
    await mkdir(join(root, ".guyditor/cache/analysis"), { recursive: true });
    await writeFile(cacheFile, "disposable");
    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher(() => undefined),
    });
    await windowHost.openProject(root);

    const service = windowHost.resolveService("BackupService");
    const scan = service?.["scan"];
    const planCleanup = service?.["planCleanup"];
    const executeCleanup = service?.["executeCleanup"];
    if (typeof scan !== "function" || typeof planCleanup !== "function" ||
        typeof executeCleanup !== "function") throw new Error("BackupService storage IPC is unavailable.");
    await expect(Reflect.apply(scan, service, [{}])).resolves.toMatchObject({
      categories: { caches: { bytes: 10, reclaimable: true } },
    });
    const plan = await Reflect.apply(planCleanup, service, [{ categories: ["caches"] }]);
    await Reflect.apply(executeCleanup, service, [{ plan }]);
    await expect(access(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });

    await windowHost.close();
    await appHost.close();
  });

  it("routes take comparison through the persistent project job queue", async () => {
    const source = await readFile(new URL("./take-comparison-service.ts", import.meta.url), "utf8");
    expect(source).toContain('registerExecutor("assist.takes.compare"');
    expect(source).toContain('kind: "assist.takes.compare"');
  });

  it("exposes the skill library, project pin, immutable upgrade, and version diff over IPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-skills-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-skills-user-"));
    const model = projectFixture();
    model.skills = [];
    const created = await createProject(root, model);
    if (!created.ok) throw created.error;
    const registry = new SkillRegistry({ globalRoot: join(userDirectory, "skills") });
    const source = await mkdtemp(join(tmpdir(), "guyditor-host-skill-source-"));
    await mkdir(join(source, "examples"));
    const manifest = (version: string, summary: string) => [
      "format: guyditor-skill/v1",
      "id: skl_aaaaaaaaaa",
      "name: exact-pacing",
      `version: ${version}`,
      "title: Exact pacing",
      "categories: [pacing]",
      `summary: ${summary}`,
      "rules:",
      "  - id: rule_pacing",
      "    category: pacing",
      "    strength: prefer",
      "    text: Keep deliberate pauses.",
      "examples:",
      "  approved: []",
      "  rejected: []",
      "body: SKILL.md",
      "",
    ].join("\n");
    await writeFile(join(source, "skill.yaml"), manifest("1.0.0", "Original cadence."), "utf8");
    await writeFile(join(source, "SKILL.md"), "# Exact pacing\n", "utf8");
    await registry.publish(source);
    await writeFile(join(source, "skill.yaml"), manifest("2.0.0", "Refined cadence."), "utf8");
    await registry.publish(source);

    const events: GdEvent[] = [];
    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher((_channel, event) => events.push(event)),
    });
    await windowHost.openProject(root);
    const service = windowHost.resolveService("SkillRegistry");
    const list = service?.["list"];
    const associate = service?.["associate"];
    const pinned = service?.["pinned"];
    const diff = service?.["diff"];
    const upgrade = service?.["upgrade"];
    if (
      typeof list !== "function" || typeof associate !== "function" ||
      typeof pinned !== "function" || typeof diff !== "function" ||
      typeof upgrade !== "function"
    ) throw new Error("SkillRegistry IPC is unavailable.");
    expect(await Reflect.apply(list, service, [{ scope: "global" }])).toHaveLength(2);
    await Reflect.apply(associate, service, [{ skillId: "skl_aaaaaaaaaa", version: "1.0.0" }]);
    expect(await Reflect.apply(pinned, service, [{}])).toMatchObject([
      { manifest: { version: "1.0.0" }, body: "# Exact pacing\n" },
    ]);
    expect(await Reflect.apply(diff, service, [{
      skillId: "skl_aaaaaaaaaa",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    }])).toMatchObject({
      metadata: { summary: { before: "Original cadence.", after: "Refined cadence." } },
    });
    await Reflect.apply(upgrade, service, [{ skillId: "skl_aaaaaaaaaa", version: "2.0.0" }]);
    expect(windowHost.snapshot().master.skills).toMatchObject([{ version: "2.0.0" }]);
    expect(events.filter(({ kind }) => kind === "project.revision")).toHaveLength(2);
    expect(await readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .toContain('"op":"skill.pin.set"');
    await windowHost.close();
    await appHost.close();
  });

  it("exposes a non-secret Kling registry entry and review-gates restyle plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-restyle-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-user-"));
    const model = projectFixture();
    const emptyAnnotations = "format: guyditor.annotations/v1\nannotations: []\n";
    model.sidecars[0]!.inputs = [];
    model.sidecars[0]!.sha256 = createHash("sha256").update(emptyAnnotations).digest("hex");
    const created = await createProject(root, model);
    if (!created.ok) throw created.error;
    await writeFile(join(root, "sidecars/annotations.yaml"), emptyAnnotations, "utf8");
    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher(() => undefined),
    });
    await windowHost.openProject(root);

    const adapterService = windowHost.resolveService("AdapterRegistry");
    const list = adapterService?.["list"];
    if (typeof list !== "function") throw new Error("Adapter registry list is unavailable.");
    const adapters = await Reflect.apply(list, adapterService, []) as Array<{
      descriptor: { canonicalName: string };
      configuration: Record<string, unknown>;
    }>;
    expect(adapters).toMatchObject([{
      descriptor: { canonicalName: ["adp", "kling"].join("_") },
      configuration: { enabled: true, apiKeyRef: "apiKey", model: "kling-video-o1" },
    }]);
    expect(JSON.stringify(adapters)).not.toMatch(/password|secret|bearer/iu);

    const deliverableService = windowHost.resolveService("DeliverableService");
    const createPlan = deliverableService?.["createRestylePlan"];
    if (typeof createPlan !== "function") throw new Error("Restyle planner is unavailable.");
    const planned = await Reflect.apply(createPlan, deliverableService, [{
      deliverableId: "dlv_aaaaaaaaaa",
      coverage: "full",
      prompt: "Ink wash",
      seed: 607,
    }]) as { plan: { chunks: unknown[]; estimatedCost: { amount: number } }; proposal: Proposal };
    expect(planned.plan).toMatchObject({
      chunks: [expect.objectContaining({ sourceRange: { startFrame: 0, endFrame: 48 } })],
      estimatedCost: { amount: 0.28 },
    });
    expect(planned.proposal).toMatchObject({
      status: "ready",
      operations: [{ op: "restyle.plan.create" }],
    });
    expect(windowHost.snapshot().revision).toBe("rev_00001");

    const accept = windowHost.resolveService("OperationEngine")?.["acceptProposal"];
    if (typeof accept !== "function") throw new Error("Proposal acceptance is unavailable.");
    await Reflect.apply(accept, undefined, [{ proposalId: planned.proposal.id }]);
    const readPlan = deliverableService?.["restylePlan"];
    if (typeof readPlan !== "function") throw new Error("Restyle plan reader is unavailable.");
    await expect(Reflect.apply(readPlan, deliverableService, [{
      deliverableId: "dlv_aaaaaaaaaa",
    }])).resolves.toMatchObject({ schema: "guyditor.restyle/v1" });
    expect(windowHost.snapshot().revision).toBe("rev_00002");

    await windowHost.close();
    await appHost.close();
  });

  it("exposes the complete B-roll taxonomy and generation adapter availability", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-generation-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-generation-user-"));
    const created = await createProject(root, projectFixture());
    if (!created.ok) throw created.error;
    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher(() => undefined),
    });
    await windowHost.openProject(root);

    const generation = windowHost.resolveService("GenerationService");
    const taxonomy = generation?.["taxonomy"];
    const adapters = generation?.["adapters"];
    if (typeof taxonomy !== "function" || typeof adapters !== "function") {
      throw new Error("Generation service is unavailable.");
    }
    expect(await Reflect.apply(taxonomy, generation, [])).toHaveLength(7);
    expect(await Reflect.apply(adapters, generation, [])).toMatchObject([
      { descriptor: { canonicalName: ["adp", "comfyui"].join("_"), availability: "declared-unavailable" } },
      { descriptor: { canonicalName: ["adp", "httpgen"].join("_"), availability: "declared-unavailable" } },
      { descriptor: { canonicalName: ["adp", "stubgen"].join("_"), availability: "available" } },
    ]);

    await windowHost.close();
    await appHost.close();
  });

  it("executes clip.trim through a window service and emits the committed revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-project-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-user-"));
    const created = await createProject(root, projectFixture());
    expect(created.ok).toBe(true);
    const events: GdEvent[] = [];
    const publisher = new WindowEventPublisher((_channel, event) => events.push(event));
    const appHost = new AppServiceHost({
      appVersion: "0.0.0-test",
      autoStartMlworker: false,
      settings: {
        auditRetentionDays: 365,
        budgets: {
          task: { warnUsd: 1, capUsd: 5 },
          episode: { warnUsd: 25, capUsd: null },
          cumulative: { warnUsd: 100, capUsd: null },
        },
        maxConcurrentJobs: 1,
      },
      userDirectory,
    });
    const windowHost = appHost.createWindowHost({ publisher });
    await windowHost.openProject(root);

    const operationService = windowHost.resolveService("OperationEngine");
    expect(operationService).toBeDefined();
    const execute = operationService?.["execute"];
    expect(typeof execute).toBe("function");
    const result = await Reflect.apply(execute as (...args: unknown[]) => unknown, operationService, [{
      operations: [{
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: -1, fps: "24/1" },
          snapPolicy: "none",
        },
      }],
      intent: "direct",
      label: "Trim fixture clip by one frame",
    }]) as { revision: string; txnId: string };

    expect(result.revision).toBe("rev_00002");
    expect(result.txnId).toMatch(/^txn_[a-z2-7]{10}$/u);
    expect(events).toContainEqual({
      kind: "project.revision",
      revision: "rev_00002",
      seq: expect.any(Number),
    });
    expect(await readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .toContain('"op":"clip.trim"');

    await windowHost.close();
    await appHost.close();
  });

  it("creates jump-cut concealment as a ready proposal without changing accepted state", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-jumpcut-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-user-"));
    const model = projectFixture();
    model.assets[0]!.probe.height = 2160;
    model.assets[0]!.probe.width = 3840;
    model.assets[0]!.video = {
      codec: "h264",
      width: 3840,
      height: 2160,
      fps: "24/1",
      pixFmt: "yuv420p",
      hasAlpha: false,
      rotation: 0,
    };
    model.sequences[0]!.clips[1]!.source = {
      in: { frames: 48, fps: "24/1" },
      out: { frames: 72, fps: "24/1" },
    };
    const created = await createProject(root, model);
    if (!created.ok) throw created.error;
    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher(() => undefined),
    });
    await windowHost.openProject(root);
    const propose = windowHost.resolveService("OperationEngine")?.["proposeJumpCutConcealment"];
    if (typeof propose !== "function") throw new Error("concealment proposal service is unavailable");

    const planned = await Reflect.apply(propose, undefined, [{
      sequenceId: "seq_aaaaaaaaaa",
      faceTracks: { ast_aaaaaaaaaa: { usable: true, framingStatic: true } },
    }]) as { kind: string; proposal?: Proposal };

    expect(planned.kind).toBe("proposal");
    expect(planned.proposal).toMatchObject({
      status: "ready",
      operations: [{
        op: "clip.punchin.set",
        params: { clipId: "clp_bbbbbbbbbb", level: 1.12, anchor: "face-track" },
      }],
    });
    expect(windowHost.snapshot().revision).toBe("rev_00001");
    expect(windowHost.snapshot().master.sequences[0]!.clips[1]!.punchIn).toBeUndefined();

    await windowHost.close();
    await appHost.close();
  });

  it("routes transcript corrections and annotation creation through semantic operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-domains-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-user-"));
    const model = projectFixture();
    model.assets[0]!.audio = [{
      index: 0,
      codec: "pcm_s16le",
      sampleRate: 48_000,
      channels: 1,
      layout: "mono",
    }];
    model.assets[0]!.probe.audio = { rate: 48_000, channels: 1 };
    const emptyAnnotations = "format: guyditor.annotations/v1\nannotations: []\n";
    model.sidecars[0]!.inputs = [];
    model.sidecars[0]!.sha256 = createHash("sha256").update(emptyAnnotations).digest("hex");
    const created = await createProject(root, model);
    if (!created.ok) throw created.error;
    await writeFile(join(root, "sidecars/annotations.yaml"), emptyAnnotations, "utf8");
    const transcript = new TranscriptEngine({
      appVersion: "0.0.0-test",
      idFactory: (prefix) => prefix === "spk" ? "spk_aaaaaaaaaa" :
        prefix === "seg" ? "seg_aaaaaaaaaa" : `${prefix}_bbbbbbbbbb`,
    });
    const transcriptCreated = await transcript.createFromTranscription(
      created.value,
      "ast_aaaaaaaaaa",
      {
        language: "en",
        languageProbability: 1,
        engine: { name: "fixture", version: "1", model: "tiny" },
        jobId: "job_aaaaaaaaaa",
        segments: [{
          index: 0,
          start: { samples: 0, rate: 48_000 },
          end: { samples: 48_000, rate: 48_000 },
          text: "hello",
          avgLogprob: 0,
          noSpeechProb: 0,
          words: [{
            text: "hello",
            start: { samples: 0, rate: 48_000 },
            end: { samples: 24_000, rate: 48_000 },
            probability: 0.9,
          }],
        }],
      },
    );
    if (!transcriptCreated.ok) throw transcriptCreated.error;
    const events: GdEvent[] = [];
    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher((_channel, event) => events.push(event)),
    });
    await windowHost.openProject(root);
    const execute = windowHost.resolveService("OperationEngine")?.["execute"];
    if (typeof execute !== "function") throw new Error("execute is unavailable");

    await Reflect.apply(execute, undefined, [{
      operations: [{
        op: "transcript.word.correct",
        params: { wordId: "w000001", text: "Hello" },
      }],
      intent: "direct",
      label: "Correct hello",
    }]);
    await Reflect.apply(execute, undefined, [{
      operations: [{
        op: "annotation.create",
        params: {
          annotation: {
            id: "ann_bbbbbbbbbb",
            shape: "pin",
            body: "Check this frame",
            style: { color: "#f2b84b", strokeWidth: 0.004 },
            geometry: { kind: "pin", at: { x: 0.5, y: 0.5 } },
            anchor: {
              kind: "timeline",
              sequenceId: "seq_aaaaaaaaaa",
              frame: { frames: 3, fps: "24/1" },
            },
            extent: { frames: 0, fps: "24/1" },
            canvasRef: { sequenceId: "seq_aaaaaaaaaa", aspect: "16:9" },
            state: "open",
            blocking: false,
            author: { kind: "human", id: "creator" },
            createdAt: "2026-07-19T00:00:00.000Z",
            history: [],
          },
        },
      }],
      intent: "direct",
      label: "Add preview pin",
    }]);

    const sidecar = await readFile(
      join(root, "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json"),
      "utf8",
    );
    expect(sidecar).toContain('"text":"Hello"');
    const annotations = await readFile(join(root, "sidecars/annotations.yaml"), "utf8");
    expect(annotations).toContain("ann_bbbbbbbbbb");
    expect(events.filter(({ kind }) => kind === "project.revision")).toHaveLength(2);

    await windowHost.close();
    await appHost.close();
  });

  it("lists and resolves directly persisted proposals through the project operation engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-proposals-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-user-"));
    const model = projectFixture();
    const emptyAnnotations = "format: guyditor.annotations/v1\nannotations: []\n";
    model.sidecars[0]!.inputs = [];
    model.sidecars[0]!.sha256 = createHash("sha256").update(emptyAnnotations).digest("hex");
    const created = await createProject(root, model);
    if (!created.ok) throw created.error;
    await writeFile(join(root, "sidecars/annotations.yaml"), emptyAnnotations, "utf8");
    const annotations = new AnnotationService({ appVersion: "0.0.0-test" });
    await valueOf(annotations.execute(created.value, [{
      op: "annotation.create",
      params: {
        annotation: {
          id: "ann_bbbbbbbbbb",
          shape: "pin",
          body: "Tighten the annotated ending",
          style: { color: "#f2b84b", strokeWidth: 0.004 },
          geometry: { kind: "pin", at: { x: 0.5, y: 0.5 } },
          anchor: {
            kind: "timeline",
            sequenceId: "seq_aaaaaaaaaa",
            frame: { frames: 3, fps: "24/1" },
          },
          extent: { frames: 0, fps: "24/1" },
          canvasRef: { sequenceId: "seq_aaaaaaaaaa", aspect: "16:9" },
          state: "open",
          blocking: true,
          author: { kind: "human", id: "creator" },
          createdAt: "2026-07-19T00:00:00.000Z",
          history: [],
        },
      },
    }]));
    const engine = new OperationEngine(created.value.currentProject, {
      appVersion: "0.0.0-test",
      committer: created.value,
      proposalStore: created.value,
      idFactory: () => "prp_bbbbbbbbbb",
    });
    const proposal = await valueOf(engine.createProposal({
      operations: [{
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: -1, fps: "24/1" },
          snapPolicy: "none",
        },
      }],
      instruction: { kind: "ui-direct" },
      actor: { kind: "human", id: "fixture" },
      reason: {
        text: "Tighten the ending",
        sources: [{ kind: "annotation", ref: "ann_bbbbbbbbbb" }],
      },
      addresses: ["ann_bbbbbbbbbb"],
    }));
    const events: GdEvent[] = [];
    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher((_channel, event) => events.push(event)),
    });
    await windowHost.openProject(root);

    const projectService = windowHost.resolveService("ProjectStore");
    const list = projectService?.["listProposals"];
    if (typeof list !== "function") throw new Error("listProposals is unavailable");
    expect(await Reflect.apply(list, projectService, [{}])).toEqual([
      expect.objectContaining({ id: proposal.id, status: "ready" }),
    ]);
    const overviewMethod = windowHost.resolveService("JobQueue")?.["overview"];
    if (typeof overviewMethod !== "function") throw new Error("overview is unavailable");
    const overview = await Reflect.apply(overviewMethod, undefined, []) as JobOverview;
    expect(overview.waitingOnCreator).toMatchObject({
      proposals: [{
        proposalId: proposal.id,
        title: "Tighten the ending",
        createdAt: proposal.createdAt,
      }],
      annotations: [{
        annotationId: "ann_bbbbbbbbbb",
        code: "VAL-400",
        message: "Tighten the annotated ending",
        sequenceId: "seq_aaaaaaaaaa",
      }],
    });
    expect(overview.idle).toBe(false);
    const accept = windowHost.resolveService("OperationEngine")?.["acceptProposal"];
    if (typeof accept !== "function") throw new Error("acceptProposal is unavailable");
    const accepted = await Reflect.apply(accept, undefined, [{ proposalId: proposal.id }]) as Proposal;

    expect(accepted.status).toBe("accepted");
    expect(events).toContainEqual(expect.objectContaining({ kind: "proposal.updated" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "project.revision" }));
    expect(await readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .toContain(`\"proposal\":\"${proposal.id}\"`);
    expect(await readFile(join(root, "sidecars/annotations.yaml"), "utf8"))
      .toContain("state: resolved");
    expect(await readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .toContain('"op":"annotation.resolve"');

    await windowHost.close();
    await appHost.close();
  });

  it("drafts, edits, approves, and persists publish metadata and resolved chapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-publish-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-user-"));
    const model = projectFixture();
    model.deliverables[0] = {
      ...model.deliverables[0]!,
      profile: "youtube-longform@1.0.0",
      status: "approved",
      approvedRevision: "rev_00001",
    };
    model.assets[0]!.probe.duration = { frames: 4_320, fps: "24/1" };
    model.sequences[0]!.clips = [{
      ...model.sequences[0]!.clips[0]!,
      source: { in: { frames: 0, fps: "24/1" }, out: { frames: 4_320, fps: "24/1" } },
    }];
    model.beats = [
      { id: "beat_aaaaaaaaaa", name: "Exact intro", anchor: "timeline:seq_aaaaaaaaaa@0", chapter: { title: "Exact intro" } },
      { id: "beat_bbbbbbbbbb", name: "Build the cut", anchor: "timeline:seq_aaaaaaaaaa@1440", chapter: { title: "Build the cut" } },
      { id: "beat_cccccccccc", name: "Package it", anchor: "timeline:seq_aaaaaaaaaa@2880", chapter: { title: "Package it" } },
    ];
    const created = await createProject(root, model);
    if (!created.ok) throw created.error;
    const appHost = testAppHost(userDirectory);
    const windowHost = appHost.createWindowHost({
      publisher: new WindowEventPublisher(() => undefined),
    });
    await windowHost.openProject(root);
    const service = windowHost.resolveService("DeliverableService");
    const draftMetadata = service?.["draftMetadata"];
    const saveMetadata = service?.["saveMetadata"];
    const generateChapters = service?.["generateChapters"];
    const approvePublish = service?.["approvePublish"];
    const publishState = service?.["publishState"];
    if (
      typeof draftMetadata !== "function" || typeof saveMetadata !== "function" ||
      typeof generateChapters !== "function" || typeof approvePublish !== "function" ||
      typeof publishState !== "function"
    ) throw new Error("Publish service surface is unavailable.");

    const drafted = await Reflect.apply(draftMetadata, service, [{ deliverableId: "dlv_aaaaaaaaaa" }]) as {
      title: string; status: string;
    };
    expect(drafted).toMatchObject({ title: "Exact intro", status: "draft" });
    await Reflect.apply(saveMetadata, service, [{
      deliverableId: "dlv_aaaaaaaaaa",
      metadata: { ...drafted, title: "Creator title" },
    }]);
    const chapters = await Reflect.apply(generateChapters, service, [{ deliverableId: "dlv_aaaaaaaaaa" }]) as {
      chapters: Array<{ title: string; startSeconds: number }>;
      errors: unknown[];
    };
    expect(chapters).toMatchObject({
      chapters: [
        { title: "Exact intro", startSeconds: 0 },
        { title: "Build the cut", startSeconds: 60 },
        { title: "Package it", startSeconds: 120 },
      ],
      errors: [],
    });
    await Reflect.apply(approvePublish, service, [{
      deliverableId: "dlv_aaaaaaaaaa",
      targets: ["metadata", "chapters"],
    }]);
    expect(await Reflect.apply(publishState, service, [{ deliverableId: "dlv_aaaaaaaaaa" }]))
      .toMatchObject({
        metadata: { title: "Creator title", status: "approved" },
        chapters: {
          status: "approved",
          chapters: expect.arrayContaining([expect.objectContaining({ startSeconds: 0 })]),
        },
      });
    expect(await readFile(join(root, "publish/dlv_aaaaaaaaaa/metadata.yaml"), "utf8"))
      .toContain("title: Creator title");
    expect(await readFile(join(root, "publish/dlv_aaaaaaaaaa/chapters.txt"), "utf8"))
      .toBe("0:00 Exact intro\n1:00 Build the cut\n2:00 Package it\n");
    expect(windowHost.snapshot().master.deliverables[0]!.publishFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "publish/dlv_aaaaaaaaaa/metadata.yaml" }),
      expect.objectContaining({ path: "publish/dlv_aaaaaaaaaa/chapters.yaml" }),
      expect.objectContaining({ path: "publish/dlv_aaaaaaaaaa/chapters.txt" }),
      expect.objectContaining({ path: "publish/dlv_aaaaaaaaaa/transcript.txt" }),
    ]));

    await windowHost.close();
    await appHost.close();
  });
});

function testAppHost(userDirectory: string): AppServiceHost {
  return new AppServiceHost({
    appVersion: "0.0.0-test",
    autoStartMlworker: false,
    settings: {
      auditRetentionDays: 365,
      budgets: {
        task: { warnUsd: 1, capUsd: 5 },
        episode: { warnUsd: 25, capUsd: null },
        cumulative: { warnUsd: 100, capUsd: null },
      },
      maxConcurrentJobs: 1,
    },
    userDirectory,
  });
}

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
}
