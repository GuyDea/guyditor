import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, ".fixtures");
const PROFILES_ROOT = path.join(REPOSITORY_ROOT, "profiles");
const TEMPLATES_ROOT = path.join(REPOSITORY_ROOT, "templates");
const WORKER_ROOT = path.join(REPOSITORY_ROOT, "workers", "mlworker");
const INFOGRAPHIC_TEMPLATE_ID = "tpl_d2e3f4g5h6";
const CALLOUT_TEMPLATE_ID = "tpl_c2d3e4f5g6";
const SOURCE_FRAMES = 180;
const FOREGROUND_START_FRAME = 70;
const FOREGROUND_DURATION_FRAMES = 40;
const SAMPLE_FRAMES = Object.freeze({
  before: FOREGROUND_START_FRAME - 1,
  at: FOREGROUND_START_FRAME + 5,
  after: FOREGROUND_START_FRAME + FOREGROUND_DURATION_FRAMES,
});
const OUTPUT_SIZE = Object.freeze({ width: 1080, height: 1920 });
const PRESENTER_TRANSFORM = Object.freeze({
  scale: 2,
  position: { x: 0.5, y: 0.35 },
});

function resultValue(result, label) {
  if (!result.ok) {
    throw new Error(`${label}: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function runTypeScriptBuild(runtimeRoot) {
  const compiler = path.join(REPOSITORY_ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [
    compiler,
    "-p",
    path.join(REPOSITORY_ROOT, "packages", "app", "tsconfig.json"),
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
      `Could not build the matte probe runtime: ${
        result.error?.message ?? `${result.stdout}${result.stderr}`.trim()
      }`,
    );
  }
}

async function buildRuntime() {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "guyditor-matte-probe-runtime-"));
  runTypeScriptBuild(runtimeRoot);
  await symlink(
    path.join(REPOSITORY_ROOT, "node_modules"),
    path.join(runtimeRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const runtimeFont = path.join(runtimeRoot, "render", "assets", "fonts", "Inconsolata.otf");
  await mkdir(path.dirname(runtimeFont), { recursive: true });
  await copyFile(
    path.join(REPOSITORY_ROOT, "packages", "render", "assets", "fonts", "Inconsolata.otf"),
    runtimeFont,
  );
  const [core, media, deliver, render, compositor, matteModule] = await Promise.all([
    import(pathToFileURL(path.join(runtimeRoot, "core", "src", "index.js")).href),
    import(pathToFileURL(path.join(runtimeRoot, "media", "src", "index.js")).href),
    import(pathToFileURL(path.join(runtimeRoot, "deliver", "src", "index.js")).href),
    import(pathToFileURL(path.join(runtimeRoot, "render", "src", "index.js")).href),
    import(pathToFileURL(path.join(runtimeRoot, "compositor", "src", "index.js")).href),
    import(pathToFileURL(path.join(runtimeRoot, "app", "src", "main", "matte-service.js")).href),
  ]);
  return {
    core,
    media,
    deliver,
    render,
    compositor,
    MatteService: matteModule.MatteService,
    runtimeRoot,
  };
}

async function requireFixtureManifest() {
  const manifestPath = path.join(FIXTURE_ROOT, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const fixture = manifest.files?.["greenscreen-720p30-6s.mp4"];
  if (
    fixture === undefined ||
    !Array.isArray(fixture.groundTruth?.subjectBoundingBoxPath) ||
    fixture.groundTruth.subjectBoundingBoxPath.length !== SOURCE_FRAMES
  ) {
    throw new Error(
      "The greenscreen fixture and its 180-frame deterministic subject path are required; run pnpm fixtures.",
    );
  }
  return { manifest, fixture };
}

function terminal(job) {
  return job?.state === "done" || job?.state === "failed" || job?.state === "cancelled";
}

async function awaitJob(queue, jobId, label, timeoutMs = 1_200_000) {
  let job = queue.get(jobId);
  if (!terminal(job)) {
    job = await new Promise((resolveJob, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`${label}: timed out waiting for ${jobId}`));
      }, timeoutMs);
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
        job?.error?.message ?? `job ${jobId} ended in ${job?.state ?? "an unknown state"}`
      }`,
    );
  }
  return job;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rgb(frame, x, y) {
  const boundedX = Math.max(0, Math.min(frame.width - 1, Math.round(x)));
  const boundedY = Math.max(0, Math.min(frame.height - 1, Math.round(y)));
  const offset = (boundedY * frame.width + boundedX) * 4;
  return {
    coordinate: { x: boundedX, y: boundedY },
    rgba: [
      frame.data[offset],
      frame.data[offset + 1],
      frame.data[offset + 2],
      frame.data[offset + 3],
    ],
  };
}

function luma([red, green, blue]) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function colorDistance(left, right) {
  return Math.sqrt(
    (left[0] - right[0]) ** 2 +
    (left[1] - right[1]) ** 2 +
    (left[2] - right[2]) ** 2,
  );
}

function mattePeakPoint(frame, box) {
  const fromX = Math.max(0, Math.floor(box.x));
  const toX = Math.min(frame.width, Math.ceil(box.x + box.width));
  const fromY = Math.max(0, Math.floor(box.y));
  const toY = Math.min(frame.height, Math.ceil(box.y + box.height));
  let peak = { x: fromX, y: fromY, alpha: -1 };
  for (let y = fromY; y < toY; y += 1) {
    for (let x = fromX; x < toX; x += 1) {
      const alpha = frame.data[(y * frame.width + x) * 4];
      if (alpha > peak.alpha) peak = { x, y, alpha };
    }
  }
  return peak;
}

function outputPresenterPoint(sourcePoint) {
  const fit = Math.min(OUTPUT_SIZE.width / 1280, OUTPUT_SIZE.height / 720);
  const fittedWidth = Math.round(1280 * fit);
  const fittedHeight = Math.round(720 * fit);
  const fitted = {
    x: (OUTPUT_SIZE.width - fittedWidth) / 2 + sourcePoint.x * fit,
    y: (OUTPUT_SIZE.height - fittedHeight) / 2 + sourcePoint.y * fit,
  };
  return {
    x:
      PRESENTER_TRANSFORM.position.x * OUTPUT_SIZE.width +
      (fitted.x - OUTPUT_SIZE.width / 2) * PRESENTER_TRANSFORM.scale,
    y:
      PRESENTER_TRANSFORM.position.y * OUTPUT_SIZE.height +
      (fitted.y - OUTPUT_SIZE.height / 2) * PRESENTER_TRANSFORM.scale,
  };
}

function frameSeconds(frame, fps = 30) {
  return (frame / fps).toFixed(9);
}

async function extractPng(media, sourcePath, outputPath, frame) {
  await media.runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-ss",
    frameSeconds(frame),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    outputPath,
  ]);
}

function exactDuration(asset) {
  const duration = asset?.probe?.duration;
  if (duration === undefined || !("frames" in duration)) {
    throw new Error(`Asset ${asset?.id ?? "unknown"} has no exact frame duration.`);
  }
  return duration;
}

function publicJobSeconds(job) {
  if (job.startedAt === undefined || job.finishedAt === undefined) return undefined;
  return (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1_000;
}

export async function runMatteVerticalProbe({ log = console.log } = {}) {
  const sandboxRoot = await mkdtemp(path.join(tmpdir(), "guyditor-matte-vertical-"));
  const projectRoot = path.join(sandboxRoot, "project");
  const outputRoot = path.join(sandboxRoot, "exports");
  const framesRoot = path.join(sandboxRoot, "frames");
  const userRoot = path.join(sandboxRoot, "user");
  const runtime = await buildRuntime();
  const {
    core,
    media,
    deliver,
    render,
    compositor: compositorModule,
    MatteService,
  } = runtime;
  const { fixture } = await requireFixtureManifest();
  let queue;
  let worker;
  try {
    log(`probe root: ${sandboxRoot}`);
    log(`RVM model directory: ${process.env.GUYDITOR_ML_MODEL_DIR ?? "(worker default)"}`);

    const store = resultValue(await core.createProject(projectRoot, {
      name: "Neural Matte Vertical Probe",
      primaryOutputFormat: "youtube-longform@1.0.0",
    }, {
      profilesDirectory: PROFILES_ROOT,
    }), "create project");
    const primaryDeliverableId = store.currentProject.settings.primaryDeliverable;
    const primaryDeliverable = store.currentProject.deliverables.find(
      ({ id }) => id === primaryDeliverableId,
    );
    const primarySequenceId = primaryDeliverable?.sequenceId;
    const primaryLayerId = store.currentProject.layers.find(
      ({ kind, sequence }) => kind === "video" && sequence === primarySequenceId,
    )?.id;
    if (primarySequenceId === undefined || primaryLayerId === undefined) {
      throw new Error("The created project has no primary sequence-bound video layer.");
    }

    queue = core.JobQueue.open(
      path.join(projectRoot, ".guyditor", "jobs.sqlite"),
      { concurrency: 1 },
    ).queue;
    worker = new media.MlworkerSupervisor({
      command: path.join(WORKER_ROOT, ".venv", "bin", "python"),
      args: ["-m", "mlworker", "--stdio"],
      cwd: WORKER_ROOT,
      env: {
        ...(process.env.GUYDITOR_ML_MODEL_DIR === undefined
          ? {}
          : { GUYDITOR_ML_MODEL_DIR: process.env.GUYDITOR_ML_MODEL_DIR }),
      },
      onStderrLine: (line) => log(`mlworker stderr: ${line}`),
    });
    const hello = resultValue(await worker.start(), "start mlworker");
    const matteCapability = hello.capabilities.find(({ task }) => task === "matte");
    if (
      matteCapability?.engine !== "rvm" ||
      !matteCapability.models?.includes("rvm_mobilenetv3")
    ) {
      throw core.makeGuyditorError(
        "E_MATTE_CAPABILITY_MISSING",
        "The worker did not advertise the rvm_mobilenetv3 matte capability.",
        {
          affected: ["rvm_mobilenetv3"],
          suggestion:
            "Install rvm_mobilenetv3_fp32.torchscript under GUYDITOR_ML_MODEL_DIR and rerun.",
        },
      );
    }
    log(
      `worker: device=${hello.device.type} engine=${matteCapability.engine}` +
      `@${matteCapability.engineVersion} model=rvm_mobilenetv3`,
    );

    const mediaEngine = new media.MediaEngine({
      jobQueue: queue,
      followUpJobs: [],
      mlworker: worker,
    });
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

    let compositorModel;
    const engine = () => new core.OperationEngine(store.currentProject, {
      committer: store,
      proposalStore: store,
      templateProvider: registry,
      operationDispatcher: compositorModel.dispatchOperation,
    });
    const execute = async (operations, label, divergence) => {
      const executed = resultValue(await engine().execute(operations, {
        baseRevision: store.currentProject.revision,
        origin: "ui",
        dryRun: false,
        recordUndo: false,
        instruction: { kind: "ui-direct", text: label },
        ...(divergence === undefined ? {} : { divergence }),
      }), label);
      return {
        revision: store.currentProject.revision,
        txnId: executed.transactionId ?? "txn_probe",
        inverse: [],
      };
    };
    const matteService = new MatteService({
      store,
      jobs: queue,
      mlworker: worker,
      execute: ({ operations, label, divergence }) => execute(operations, label, divergence),
    });
    compositorModel = new compositorModule.CompositorModel({
      onMatteGenerate: matteService.onMatteGenerate,
      onKeyQcRun: matteService.onKeyQcRun,
    });

    const ingested = mediaEngine.ingest(store, {
      sources: [{ path: path.join(FIXTURE_ROOT, "greenscreen-720p30-6s.mp4") }],
      via: "manual",
      followUpJobs: [],
    });
    const ingestJob = await awaitJob(queue, ingested.jobId, "fixture ingest");
    const ingestResult = ingestJob.payload;
    const sourceAssetId = ingestResult.assets?.[0]?.assetId;
    const sourceAsset = store.currentProject.assets.find(({ id }) => id === sourceAssetId);
    if (sourceAsset === undefined) throw new Error("Fixture ingest produced no source asset.");
    const sourceDuration = exactDuration(sourceAsset);
    const primaryClipId = core.makeId("clp");
    await execute([{
      op: "clip.insert",
      params: {
        sequenceId: primarySequenceId,
        layerId: primaryLayerId,
        index: 0,
        clipId: primaryClipId,
        source: {
          assetId: sourceAsset.id,
          in: { frames: 0, fps: sourceDuration.fps },
          out: sourceDuration,
        },
      },
    }], "Place the presenter fixture");
    log(
      `ingest: asset=${sourceAsset.id} clip=${primaryClipId} ` +
      `${sourceAsset.video.width}x${sourceAsset.video.height}@${sourceAsset.video.fps}`,
    );

    const matteParams = {
      model: "rvm_mobilenetv3",
      downsampleRatio: 0.25,
      stabilization: {
        enabled: false,
        alphaMin: 0.35,
        motionGain: 4,
        minSpeckleArea: 0.00001,
      },
    };
    const matteJobsBefore = new Set(queue.list({ kind: "matte" }).map(({ jobId }) => jobId));
    const matteWallStarted = performance.now();
    await execute([{
      op: "key.matte.generate",
      params: {
        clipId: primaryClipId,
        neural: matteParams,
      },
    }], "Generate the RVM matte candidate");
    const matteJob = queue.list({ kind: "matte" }).find(
      ({ jobId }) => !matteJobsBefore.has(jobId),
    );
    if (matteJob === undefined) throw new Error("Matte dispatch did not enqueue a worker task.");
    let lastLoggedProgress = -1;
    const unsubscribeProgress = queue.onChange(({ job }) => {
      if (job.jobId !== matteJob.jobId) return;
      const decile = Math.floor(job.progress * 10);
      if (decile > lastLoggedProgress) {
        lastLoggedProgress = decile;
        log(`matte progress: ${String(Math.round(job.progress * 100))}%`);
      }
    });
    const completedMatteJob = await awaitJob(queue, matteJob.jobId, "RVM matte inference");
    unsubscribeProgress();
    const matteWallSeconds = (performance.now() - matteWallStarted) / 1_000;
    const matteJobSeconds = publicJobSeconds(completedMatteJob);
    const candidates = matteService.candidates(primaryClipId);
    const candidate = candidates.find(({ jobId }) => jobId === matteJob.jobId);
    if (candidate === undefined) throw new Error("The completed matte task produced no review candidate.");
    const acceptedMatte = await matteService.accept(primaryClipId, candidate.jobId);
    const matteAsset = store.currentProject.assets.find(({ id }) => id === acceptedMatte.assetId);
    if (matteAsset === undefined) throw new Error("Matte acceptance produced no frozen generated asset.");
    log(
      `matte accepted: job=${candidate.jobId} asset=${matteAsset.id} ` +
      `alpha=${String(candidate.alpha.minimum)}..${String(candidate.alpha.maximum)} ` +
      `nonZeroFrames=${String(candidate.alpha.nonZeroFrames)}/${String(candidate.frameCount)}`,
    );
    log(
      `matte timing: wall=${matteWallSeconds.toFixed(3)}s` +
      `${matteJobSeconds === undefined ? "" : ` job=${matteJobSeconds.toFixed(3)}s`} ` +
      `device=${hello.device.type} ratio=${String(matteParams.downsampleRatio)}`,
    );

    // The shipped acceptance service keeps optional chroma settings for neural
    // despill. This probe deliberately applies only the accepted neural alpha:
    // no chroma mode, chroma alpha, or despill is used in the rendered short.
    const neuralOnlySettings = {
      schema: "guyditor/key@1",
      mode: "neural",
      neural: {
        ...candidate.params,
        matteAssetId: matteAsset.id,
      },
      masks: [],
    };
    await execute([{
      op: "clip.key.set",
      params: { clipId: primaryClipId, settings: neuralOnlySettings },
    }], "Use only the accepted neural matte");

    const frozenBackground = await renderService.templateFreeze({
      revision: store.currentProject.revision,
      deliverableId: primaryDeliverableId,
      templateId: INFOGRAPHIC_TEMPLATE_ID,
      params: {
        title: "Neural Matte",
        body: "Frozen template animation behind a separately composited presenter.",
        accent: "#77E7C4",
        logoSlot: "none",
      },
      seed: 20260723,
      durationFrames: SOURCE_FRAMES,
      placeAsClip: false,
    });
    log(
      `template.freeze: asset=${frozenBackground.assetId} ` +
      `${String(frozenBackground.width)}x${String(frozenBackground.height)} ` +
      `frames=${String(frozenBackground.frames)}`,
    );

    const selection = { clips: [primaryClipId] };
    const resolvedSources = resultValue(
      deliver.resolveDerivationSources(store.currentProject, [], selection),
      "resolve short derivation",
    );
    const shortsBefore = new Set(
      store.currentProject.deliverables.filter(({ kind }) => kind === "short").map(({ id }) => id),
    );
    const proposalEngine = engine();
    const proposal = resultValue(await proposalEngine.createProposal({
      operations: [{
        op: "deliverable.derive",
        params: {
          kind: "short",
          name: "Neural Matte Presenter Short",
          profile: "youtube-shorts@1.0.0",
          from: selection,
          resolvedSources,
        },
      }],
      instruction: { kind: "user-text", text: "Derive the neural matte vertical probe" },
      actor: { kind: "tool", id: "probe-matte-vertical" },
      reason: {
        text: "Build a reviewable 9:16 derivative from the full presenter clip.",
        sources: [{ kind: "instruction", ref: "probe-task" }],
      },
      addresses: [],
    }), "create short derivation proposal");
    resultValue(
      await proposalEngine.acceptProposal(proposal.id, "probe-matte-vertical"),
      "accept short derivation proposal",
    );
    const shortDeliverable = store.currentProject.deliverables.find(
      ({ id, kind }) => kind === "short" && !shortsBefore.has(id),
    );
    const shortSequence = store.currentProject.sequences.find(
      ({ id }) => id === shortDeliverable?.sequenceId,
    );
    const shortPresenterLayer = store.currentProject.layers.find(
      ({ kind, sequence }) => kind === "video" && sequence === shortDeliverable?.sequenceId,
    );
    const shortClip = shortSequence?.clips[0];
    if (
      shortDeliverable === undefined ||
      shortSequence === undefined ||
      shortPresenterLayer === undefined ||
      shortClip === undefined
    ) {
      throw new Error("Accepted short derivation is missing its deliverable, sequence, layer, or clip.");
    }

    await execute([{
      op: "clip.key.set",
      params: { clipId: shortClip.id, settings: neuralOnlySettings },
    }], "Apply the accepted neural matte to the derivative", "graphics");
    await execute([
      {
        op: "clip.transform.set",
        params: {
          clipId: shortClip.id,
          scale: PRESENTER_TRANSFORM.scale,
          position: PRESENTER_TRANSFORM.position,
        },
      },
      {
        op: "composition.arrange",
        params: {
          sequenceId: shortSequence.id,
          arrangementRef: "presenter_over_background",
          assignments: {
            background: frozenBackground.assetId,
            presenter: shortPresenterLayer.id,
          },
        },
      },
    ], "Compose the vertical background and matted presenter", "framing");

    const backgroundLayer = store.currentProject.layers.find(
      ({ items }) => items?.some(({ asset }) => asset === frozenBackground.assetId),
    );
    if (backgroundLayer === undefined) {
      throw new Error("Presenter arrangement did not create the frozen background layer.");
    }
    const containedBackgroundHeight = Math.round(
      OUTPUT_SIZE.width * frozenBackground.height / frozenBackground.width,
    );
    const landscapeToVerticalCover = OUTPUT_SIZE.height / containedBackgroundHeight;
    const foregroundGraphicId = core.makeId("gfx");
    await execute([{
      op: "layer.transform.set",
      params: {
        layerId: backgroundLayer.id,
        transform: {
          anchor: { x: 0.5, y: 0.5 },
          position: { x: 0.5, y: 0.5 },
          scale: { x: landscapeToVerticalCover, y: landscapeToVerticalCover },
          rotationDeg: 0,
        },
      },
    }], "Cover the vertical canvas", "framing");
    await execute([{
      op: "graphic.add",
      params: {
        templateId: CALLOUT_TEMPLATE_ID,
        graphicId: foregroundGraphicId,
        anchor: `clip:${shortClip.id}@${String(FOREGROUND_START_FRAME)}`,
        duration: {
          frames: FOREGROUND_DURATION_FRAMES,
          fps: store.currentProject.settings.timeline.fps,
        },
        params: {
          label: "FOREGROUND",
          body: "This callout is above the presenter.",
          accent: "#FFD166",
          pointer: "bottom",
        },
        seed: 20260724,
      },
    }], "Add the foreground callout", "graphics");
    const foregroundLayer = store.currentProject.layers.find(
      ({ items }) => items?.some(({ id }) => id === foregroundGraphicId),
    );
    if (foregroundLayer === undefined) throw new Error("The foreground graphic layer was not created.");
    const relevantLayerIds = new Set([
      backgroundLayer.id,
      shortPresenterLayer.id,
      foregroundLayer.id,
    ]);
    const relevantLayers = store.currentProject.layers
      .filter(({ id }) => relevantLayerIds.has(id))
      .sort((left, right) => left.order - right.order)
      .map(({ id, kind, name, order }) => ({ id, kind, name, order }));
    log(`vertical layer stack: ${JSON.stringify(relevantLayers)}`);

    const exported = await renderService.renderExport({
      revision: store.currentProject.revision,
      deliverableId: shortDeliverable.id,
      variants: ["clean"],
      outputDir: outputRoot,
      skipValidationWarnings: true,
    });
    await awaitJob(queue, exported.jobId, "vertical short export");
    const outputPath = render.exportOutputPath(
      outputRoot,
      shortDeliverable.id,
      "clean",
      "mp4",
    );
    const reportPath = render.exportReportPath(outputPath);
    const [probed, exportReport] = await Promise.all([
      media.probeMedia(outputPath),
      readFile(reportPath, "utf8").then((text) => JSON.parse(text)),
    ]);
    if (probed.video === undefined) throw new Error("The exported short has no video stream.");
    const dimensionsPass =
      probed.video.width === OUTPUT_SIZE.width &&
      probed.video.height === OUTPUT_SIZE.height;

    await mkdir(framesRoot, { recursive: true });
    const extractedFrames = {};
    for (const [label, frame] of Object.entries(SAMPLE_FRAMES)) {
      const framePath = path.join(
        framesRoot,
        `${label}-${String(frame).padStart(4, "0")}.png`,
      );
      await extractPng(media, outputPath, framePath, frame);
      extractedFrames[label] = framePath;
    }

    const mattePath = path.resolve(projectRoot, acceptedMatte.path);
    const sourcePath = path.resolve(projectRoot, sourceAsset.path);
    const pixelEvidence = {};
    for (const [label, frame] of Object.entries(SAMPLE_FRAMES)) {
      const box = fixture.groundTruth.subjectBoundingBoxPath[frame];
      const [sourceFrame, matteFrame, outputFrame] = await Promise.all([
        media.extractRgbaFrame(sourcePath, frame, 1280, 720, "30/1"),
        media.extractRgbaFrame(mattePath, frame, 1280, 720, "30/1"),
        media.extractRgbaFrame(outputPath, frame, OUTPUT_SIZE.width, OUTPUT_SIZE.height, "30/1"),
      ]);
      const peak = mattePeakPoint(matteFrame, box);
      const sourcePoint = { x: peak.x, y: peak.y };
      const outputPoint = outputPresenterPoint(sourcePoint);
      const sourceSample = rgb(sourceFrame, sourcePoint.x, sourcePoint.y);
      const matteSample = rgb(matteFrame, sourcePoint.x, sourcePoint.y);
      const outputSample = rgb(outputFrame, outputPoint.x, outputPoint.y);
      const transformedHalfWidth =
        box.width * (OUTPUT_SIZE.width / 1280) * PRESENTER_TRANSFORM.scale / 2;
      const backgroundSample = rgb(
        outputFrame,
        outputPoint.x - transformedHalfWidth - 70,
        outputPoint.y,
      );
      pixelEvidence[label] = {
        frame,
        manifestBox: box,
        sampleStrategy: "maximum accepted-matte alpha inside manifest subject box",
        sourceSubject: sourceSample,
        matteAlpha: matteSample.rgba[0],
        outputHead: outputSample,
        adjacentBackground: backgroundSample,
        sourceLuma: Math.round(luma(sourceSample.rgba)),
        outputLuma: Math.round(luma(outputSample.rgba)),
        adjacentBackgroundLuma: Math.round(luma(backgroundSample.rgba)),
      };
    }

    const calloutBounds = {
      x: OUTPUT_SIZE.width - OUTPUT_SIZE.width * 0.05 - OUTPUT_SIZE.width * 0.54,
      y: OUTPUT_SIZE.height * 0.05 + 38 * OUTPUT_SIZE.height / 360,
      width: OUTPUT_SIZE.width * 0.54,
      height: 94 * OUTPUT_SIZE.height / 360,
    };
    const atPoint = pixelEvidence.at.outputHead.coordinate;
    const atCalloutFill = pixelEvidence.at.outputHead.rgba;
    const assertions = {
      output1080x1920: dimensionsPass,
      neuralOnly:
        neuralOnlySettings.mode === "neural" &&
        neuralOnlySettings.chroma === undefined &&
        store.currentProject.sequences
          .find(({ id }) => id === shortSequence.id)
          ?.clips[0]
          ?.effects?.find(({ kind }) => kind === "key")
          ?.params?.mode === "neural",
      matteHasSubjectAtSamples: Object.values(pixelEvidence).every(
        ({ matteAlpha }) => matteAlpha >= 64,
      ),
      presenterOccludesBackgroundBefore:
        pixelEvidence.before.outputLuma >= pixelEvidence.before.adjacentBackgroundLuma + 35,
      presenterOccludesBackgroundAfter:
        pixelEvidence.after.outputLuma >= pixelEvidence.after.adjacentBackgroundLuma + 35,
      foregroundPointOverlapsPresenter:
        atPoint.x >= calloutBounds.x &&
        atPoint.x < calloutBounds.x + calloutBounds.width &&
        atPoint.y >= calloutBounds.y &&
        atPoint.y < calloutBounds.y + calloutBounds.height,
      foregroundOccludesPresenter:
        pixelEvidence.at.sourceLuma >= 160 &&
        pixelEvidence.at.matteAlpha >= 64 &&
        colorDistance(atCalloutFill, [15, 20, 24]) <= 65 &&
        pixelEvidence.at.outputLuma <= pixelEvidence.at.sourceLuma - 70,
      fixtureGreenDoesNotReplaceBackground: Object.values(pixelEvidence).every(
        ({ adjacentBackground }) => {
          const [red, green, blue] = adjacentBackground.rgba;
          return green - Math.max(red, blue) < 45;
        },
      ),
    };
    const failures = Object.entries(assertions)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    const report = {
      worksEndToEnd: failures.length === 0,
      failures,
      projectRoot,
      outputPath,
      reportPath,
      extractedFrames,
      source: {
        fixture: "greenscreen-720p30-6s.mp4",
        assetId: sourceAsset.id,
        clipId: primaryClipId,
      },
      matte: {
        jobId: candidate.jobId,
        assetId: matteAsset.id,
        model: candidate.params.model,
        downsampleRatio: candidate.params.downsampleRatio,
        stabilization: candidate.params.stabilization,
        alpha: candidate.alpha,
        wallSeconds: Number(matteWallSeconds.toFixed(3)),
        ...(matteJobSeconds === undefined
          ? {}
          : { workerJobSeconds: Number(matteJobSeconds.toFixed(3)) }),
        device: hello.device,
        engineVersion: candidate.engine.version,
      },
      background: {
        templateId: INFOGRAPHIC_TEMPLATE_ID,
        assetId: frozenBackground.assetId,
        frames: frozenBackground.frames,
        sourceResolution: {
          width: frozenBackground.width,
          height: frozenBackground.height,
        },
      },
      short: {
        deliverableId: shortDeliverable.id,
        profile: shortDeliverable.profile,
        sequenceId: shortSequence.id,
        presenterClipId: shortClip.id,
        layers: relevantLayers,
        foregroundGraphicId,
        foregroundAnchor: `clip:${shortClip.id}@${String(FOREGROUND_START_FRAME)}`,
      },
      ffprobe: {
        container: probed.container,
        duration: probed.probe.duration,
        video: {
          codec: probed.video.codec,
          width: probed.video.width,
          height: probed.video.height,
          fps: probed.video.fps,
          pixelFormat: probed.video.pixFmt,
        },
        audio: probed.audio ?? [],
      },
      exportReport: {
        revision: exportReport.revision,
        validation: exportReport.validation.outcome,
        durationFrames: exportReport.output.durationFrames,
        sha256: exportReport.output.sha256,
      },
      calloutBounds,
      pixelEvidence,
      assertions,
      probeScriptSha256: sha256Text(await readFile(fileURLToPath(import.meta.url), "utf8")),
    };
    const probeReportPath = path.join(sandboxRoot, "probe-report.json");
    await writeFile(probeReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`ffprobe: ${JSON.stringify(report.ffprobe)}`);
    log(`frames: ${JSON.stringify(extractedFrames)}`);
    log(`pixel evidence: ${JSON.stringify(pixelEvidence)}`);
    log(`assertions: ${JSON.stringify(assertions)}`);
    log(`output: ${outputPath}`);
    log(`probe report: ${probeReportPath}`);
    if (failures.length > 0) {
      throw new Error(`Layer-order assertions failed: ${failures.join(", ")}`);
    }
    return { ...report, probeReportPath };
  } finally {
    await worker?.stop();
    queue?.close();
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) {
  runMatteVerticalProbe().catch((error) => {
    console.error(
      `probe-matte-vertical: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
