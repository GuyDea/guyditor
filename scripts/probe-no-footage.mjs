import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILES_ROOT = path.join(REPOSITORY_ROOT, "profiles");
const TEMPLATES_ROOT = path.join(REPOSITORY_ROOT, "templates");
const INFOGRAPHIC_TEMPLATE_ID = "tpl_d2e3f4g5h6";
const LOWER_THIRD_TEMPLATE_ID = "tpl_a2c3d4e5f6";
const CLIP_FRAMES = 150;
const NO_BUDGETS = {
  task: { warnUsd: null, capUsd: null },
  episode: { warnUsd: null, capUsd: null },
  cumulative: { warnUsd: null, capUsd: null },
};

function resultValue(result, label) {
  if (!result.ok) {
    throw new Error(`${label}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function errorText(error) {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function runTypeScriptBuild(project, runtimeRoot) {
  const compiler = path.join(REPOSITORY_ROOT, "node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [
    compiler,
    "-p",
    path.join(REPOSITORY_ROOT, project),
    "--noEmit",
    "false",
    "--outDir",
    runtimeRoot,
    "--rootDir",
    path.join(REPOSITORY_ROOT, "packages"),
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not build ${project}: ${
        result.error?.message ?? `${result.stdout}${result.stderr}`.trim()
      }`,
    );
  }
}

async function buildRuntime() {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "guyditor-no-footage-runtime-"));
  runTypeScriptBuild("packages/agent/tsconfig.json", runtimeRoot);
  runTypeScriptBuild("packages/render/tsconfig.json", runtimeRoot);
  await symlink(
    path.join(REPOSITORY_ROOT, "node_modules"),
    path.join(runtimeRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const runtimeFont = path.join(runtimeRoot, "render/assets/fonts/Inconsolata.otf");
  await mkdir(path.dirname(runtimeFont), { recursive: true });
  await copyFile(
    path.join(REPOSITORY_ROOT, "packages/render/assets/fonts/Inconsolata.otf"),
    runtimeFont,
  );
  const [core, media, render, agent] = await Promise.all([
    import(pathToFileURL(path.join(runtimeRoot, "core/src/index.js")).href),
    import(pathToFileURL(path.join(runtimeRoot, "media/src/index.js")).href),
    import(pathToFileURL(path.join(runtimeRoot, "render/src/index.js")).href),
    import(pathToFileURL(path.join(runtimeRoot, "agent/src/index.js")).href),
  ]);
  return { agent, core, media, render, runtimeRoot };
}

async function awaitJob(queue, jobId, label) {
  const terminal = (job) => job?.state === "done" || job?.state === "failed";
  let job = queue.get(jobId);
  if (!terminal(job)) {
    job = await new Promise((resolveJob, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`${label}: timed out waiting for ${jobId}`));
      }, 600_000);
      const unsubscribe = queue.onChange(({ job: changed }) => {
        if (changed.jobId !== jobId || !terminal(changed)) return;
        clearTimeout(timeout);
        unsubscribe();
        resolveJob(changed);
      });
    });
  }
  if (job?.state !== "done") {
    throw new Error(
      `${label}: ${job?.error?.code ?? "E_JOB_UNKNOWN"}: ${
        job?.error?.message ?? `job ${jobId} did not complete`
      }`,
    );
  }
  return job;
}

function operationEngine(core, store, registry) {
  return new core.OperationEngine(store.currentProject, {
    committer: store,
    proposalStore: store,
    templateProvider: registry,
  });
}

async function execute(engine, operations, label) {
  return resultValue(await engine.execute(operations, {
    baseRevision: engine.currentProject.revision,
    origin: "ui",
    dryRun: false,
  }), label);
}

function exactFrameDuration(asset, fallbackFps) {
  const duration = asset.probe.duration;
  if (duration === undefined || !("frames" in duration)) {
    throw new Error(`Asset ${asset.id} has no exact probed frame duration.`);
  }
  return {
    frames: duration.frames,
    fps: asset.probe.fps ?? asset.video?.fps ?? duration.fps ?? fallbackFps,
  };
}

export async function runNoFootageProbe({ log = console.log } = {}) {
  const sandboxRoot = await mkdtemp(path.join(tmpdir(), "guyditor-no-footage-"));
  const projectRoot = path.join(sandboxRoot, "project");
  const outputRoot = path.join(sandboxRoot, "exports");
  const userRoot = path.join(sandboxRoot, "user");
  const runtime = await buildRuntime();
  const { agent, core, media, render } = runtime;
  let queue;
  let meter;
  try {
    log(`probe root: ${sandboxRoot}`);
    const store = resultValue(await core.createProject(projectRoot, {
      name: "No Footage Project",
      primaryOutputFormat: "youtube-longform@1.0.0",
    }, {
      profilesDirectory: PROFILES_ROOT,
    }), "createProject");
    const deliverableId = store.currentProject.settings.primaryDeliverable;
    const sequenceId = store.currentProject.deliverables.find(
      ({ id }) => id === deliverableId,
    )?.sequenceId;
    const sequenceLayerId = store.currentProject.layers.find(
      ({ kind, sequence }) => kind === "video" && sequence === sequenceId,
    )?.id;
    if (sequenceId === undefined || sequenceLayerId === undefined) {
      throw new Error("The empty project did not create its primary sequence and video layer.");
    }
    const emptyTimeline = resultValue(
      core.deriveTimeline(store.currentProject, sequenceId),
      "derive empty timeline",
    );
    log(`empty project: assets=0 clips=0 duration=${emptyTimeline.duration}`);

    queue = core.JobQueue.open(
      path.join(projectRoot, ".guyditor/jobs.sqlite"),
      { concurrency: 1 },
    ).queue;
    const registry = new render.TemplateRegistry({
      builtinsRoot: TEMPLATES_ROOT,
      projectRoot: path.join(projectRoot, "templates"),
      userRoot: path.join(userRoot, "templates"),
    });
    const renderService = new render.RenderService({
      projectRoot,
      profilesRoot: PROFILES_ROOT,
      store,
      jobQueue: queue,
      templateRegistry: registry,
    });

    // This is deliberately the first content mutation. The deterministic
    // template renderer must create the asset and establish sequence duration.
    const frozen = await renderService.templateFreeze({
      revision: store.currentProject.revision,
      deliverableId,
      templateId: INFOGRAPHIC_TEMPLATE_ID,
      params: {
        title: "No Camera Needed",
        body: "A complete edit can begin with generated visuals and deterministic motion graphics.",
        accent: "#77E7C4",
        logoSlot: "none",
      },
      seed: 20260723,
      durationFrames: CLIP_FRAMES,
      placeAsClip: true,
    });
    const programmaticAsset = store.currentProject.assets.find(
      ({ id }) => id === frozen.assetId,
    );
    if (
      programmaticAsset === undefined ||
      programmaticAsset.kind !== "generated" ||
      programmaticAsset.rights?.origin !== "programmatic" ||
      frozen.clipId === undefined
    ) {
      throw new Error("Template freeze did not create and place a programmatic clip.");
    }
    const frozenTimeline = resultValue(
      core.deriveTimeline(store.currentProject, sequenceId),
      "derive template-first timeline",
    );
    log(
      `template frozen first: asset=${frozen.assetId} clip=${frozen.clipId} ` +
      `frames=${String(frozen.frames)} duration=${frozenTimeline.duration}`,
    );

    let engine = operationEngine(core, store, registry);
    const audit = new agent.AuditLog({ userDir: userRoot });
    meter = agent.CostMeter.open({
      userDir: userRoot,
      auditLog: audit,
      budgets: NO_BUDGETS,
    });
    const adapters = new agent.AdapterRegistry();
    adapters.register(new agent.DeterministicGenerationAdapter());
    const generation = new agent.GenerationExecutionService({
      projectStore: store,
      operationEngine: engine,
      adapters,
      jobs: queue,
      costMeter: meter,
    });
    const requested = await generation.request({
      adapterId: "adp_stubgenaaa",
      context: {
        sessionId: "ses_aaaaaaaaaa",
        projectId: store.currentProject.project.id,
        taskId: "no-footage-stub-generation",
        initiator: "creator",
      },
      request: {
        requestId: "01KNOFOOTAGEGENERATION",
        mode: "video",
        model: "ffmpeg-synth-v1",
        prompt: "Abstract camera-free editorial B-roll with a moving cobalt shape",
        width: 640,
        height: 360,
        durationFrames: CLIP_FRAMES,
        fps: store.currentProject.settings.timeline.fps,
        seed: 607,
        count: 1,
        providerSettings: {},
      },
    });
    if (requested.verdict !== "enqueued") {
      throw new Error(`Stub generation did not enqueue: ${JSON.stringify(requested)}`);
    }
    await awaitJob(queue, requested.job.jobId, "stub generation");
    const [candidate] = generation.reviewQueue();
    if (candidate === undefined) throw new Error("Stub generation produced no review candidate.");
    for (const item of candidate.review.checklist.items) {
      await generation.recordCreatorJudgment(
        candidate.candidateId,
        item.id,
        "pass",
        "Checked by the no-footage probe.",
      );
    }
    await generation.resolveReview(candidate.candidateId);
    const layersBeforeAcceptance = new Set(engine.currentProject.layers.map(({ id }) => id));
    const acceptance = resultValue(await generation.acceptCandidate(candidate.candidateId, {
      sequenceId,
      atFrame: CLIP_FRAMES,
      durationFrames: CLIP_FRAMES,
    }), "propose generated candidate acceptance");
    resultValue(
      await engine.acceptProposal(acceptance.id, "no-footage-probe"),
      "accept generated candidate",
    );
    const generatedAsset = engine.currentProject.assets.find(
      ({ rights }) => rights?.origin === "generated",
    );
    const generatedPlacementLayer = engine.currentProject.layers.find(
      ({ id }) => !layersBeforeAcceptance.has(id),
    );
    if (generatedAsset === undefined || generatedPlacementLayer === undefined) {
      throw new Error("Accepted generation did not freeze an asset and placement layer.");
    }
    log(
      `stub accepted: ${generatedAsset.id} ${generatedAsset.path} ` +
      `readonly lifecycle revision=${engine.currentProject.revision}`,
    );
    await execute(engine, [{
      op: "layer.remove",
      params: { layerId: generatedPlacementLayer.id },
    }], "clear generated candidate placement");

    engine = operationEngine(core, store, registry);
    const brollClipId = core.makeId("clp");
    const lowerThirdId = core.makeId("gfx");
    const brollDuration = exactFrameDuration(
      generatedAsset,
      store.currentProject.settings.timeline.fps,
    );
    await execute(engine, [
      {
        op: "clip.insert",
        params: {
          sequenceId,
          layerId: sequenceLayerId,
          index: 1,
          clipId: brollClipId,
          source: {
            assetId: generatedAsset.id,
            in: { frames: 0, fps: brollDuration.fps },
            out: brollDuration,
          },
        },
      },
      {
        op: "graphic.add",
        params: {
          templateId: LOWER_THIRD_TEMPLATE_ID,
          graphicId: lowerThirdId,
          anchor: `clip:${brollClipId}@0`,
          duration: {
            frames: 120,
            fps: store.currentProject.settings.timeline.fps,
          },
          params: {
            title: "Generated B-roll",
            subtitle: "No imported footage",
            accent: "#77E7C4",
            position: "left",
          },
          seed: 20260724,
        },
      },
    ], "assemble final no-footage timeline");

    const lowerThirdAnchor = resultValue(await core.resolveAnchor(
      engine.currentProject,
      `clip:${brollClipId}@0`,
      sequenceId,
    ), "resolve lower-third anchor");
    const finalTimeline = resultValue(
      core.deriveTimeline(engine.currentProject, sequenceId),
      "derive final timeline",
    );
    log(
      `final timeline: clips=${String(
        engine.currentProject.sequences.find(({ id }) => id === sequenceId)?.clips.length ?? 0
      )} duration=${finalTimeline.duration} lower-third=${lowerThirdAnchor.status}` +
      `${lowerThirdAnchor.timeline === undefined ? "" : `@${String(lowerThirdAnchor.timeline.frames)}`}`,
    );

    const exported = await renderService.renderExport({
      revision: store.currentProject.revision,
      deliverableId,
      variants: ["clean"],
      outputDir: outputRoot,
      skipValidationWarnings: true,
    });
    await awaitJob(queue, exported.jobId, "final no-footage export");
    const outputPath = render.exportOutputPath(outputRoot, deliverableId, "clean", "mp4");
    const reportPath = render.exportReportPath(outputPath);
    const probed = await media.probeMedia(outputPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const ffprobeSummary = {
      duration: probed.probe.duration,
      container: probed.container,
      streams: {
        video: probed.video === undefined
          ? []
          : [{
              codec: probed.video.codec,
              width: probed.video.width,
              height: probed.video.height,
              fps: probed.video.fps,
              pixelFormat: probed.video.pixFmt,
            }],
        audio: (probed.audio ?? []).map((stream) => ({
          codec: stream.codec,
          sampleRate: stream.sampleRate,
          channels: stream.channels,
          layout: stream.layout,
        })),
      },
    };
    log(`ffprobe: ${JSON.stringify(ffprobeSummary)}`);
    log(`output: ${outputPath}`);
    log(`export report: ${reportPath}`);
    log(
      `report: revision=${report.revision} durationFrames=${String(
        report.output.durationFrames
      )} validation=${report.validation.outcome}`,
    );
    return {
      outputPath,
      reportPath,
      projectRoot,
      frozen,
      ffprobe: ffprobeSummary,
      report,
    };
  } finally {
    queue?.close();
    meter?.close();
    await rm(runtime.runtimeRoot, { recursive: true, force: true });
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) {
  runNoFootageProbe().catch((error) => {
    console.error(
      `probe-no-footage: ${
        error instanceof Error ? error.stack ?? error.message : errorText(error)
      }`,
    );
    process.exitCode = 1;
  });
}
