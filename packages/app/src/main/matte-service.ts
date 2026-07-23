import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  makeGuyditorError,
  makeId,
} from "../../../core/src/index.js";
import type {
  Asset,
  GuyditorProject,
  JobQueue,
  JobRecord,
  JsonValue,
  KeySettings,
  NeuralMatteParams,
  ProjectStore,
  SidecarRef,
} from "../../../core/src/index.js";
import {
  enqueueKeyQc,
} from "../../../media/src/index.js";
import type {
  KeyQcJobPayload,
  MlworkerMatteResult,
  MlworkerSupervisor,
} from "../../../media/src/index.js";
import type { CompositorModelOptions } from "../../../compositor/src/index.js";

import type { ExecuteRequest, ExecuteResult } from "../shared/ipc.js";

export interface MatteCandidate extends MlworkerMatteResult {
  clipId: string;
  sourceAssetId: string;
  jobId: string;
}

export interface MatteServiceOptions {
  store: ProjectStore;
  jobs: JobQueue;
  mlworker: Pick<MlworkerSupervisor, "hello">;
  execute: (request: ExecuteRequest) => Promise<ExecuteResult>;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sceneBoundariesForAsset(
  project: GuyditorProject,
  projectRoot: string,
  assetId: string,
): number[] {
  const reference = project.sidecars.find(({ schema, path }) =>
    schema === "guyditor.analysis/v1" && path === `sidecars/analysis/${assetId}.scene.shots.json`);
  if (reference === undefined) return [];
  try {
    const value = JSON.parse(readFileSync(join(projectRoot, reference.path), "utf8")) as unknown;
    const boundaries = jsonRecord(jsonRecord(value)?.["data"])?.["boundaries"];
    return Array.isArray(boundaries)
      ? boundaries.filter((frame): frame is number =>
          typeof frame === "number" && Number.isSafeInteger(frame) && frame >= 0)
      : [];
  } catch {
    return [];
  }
}

function matteCandidateFromJob(job: JobRecord): MatteCandidate | undefined {
  const payload = jsonRecord(job.payload);
  const source = jsonRecord(payload?.["source"]);
  const frames = jsonRecord(source?.["frames"]);
  const alpha = jsonRecord(payload?.["alpha"]);
  const engine = jsonRecord(payload?.["engine"]);
  const params = jsonRecord(payload?.["params"]);
  const stabilization = jsonRecord(params?.["stabilization"]);
  if (
    job.kind !== "matte" || job.state !== "done" ||
    payload?.["schema"] !== "guyditor.matte/v1" ||
    params === undefined ||
    payload["format"] !== "ffv1-gray-mkv" ||
    typeof payload["clipId"] !== "string" ||
    typeof payload["sourceAssetId"] !== "string" ||
    typeof payload["path"] !== "string" ||
    typeof payload["sha256"] !== "string" ||
    typeof payload["cacheKey"] !== "string" ||
    typeof source?.["path"] !== "string" || typeof source["sha256"] !== "string" ||
    typeof frames?.["from"] !== "number" || typeof frames["to"] !== "number" ||
    typeof payload["width"] !== "number" || typeof payload["height"] !== "number" ||
    typeof payload["frameCount"] !== "number" || typeof payload["fps"] !== "string" ||
    typeof alpha?.["minimum"] !== "number" || typeof alpha["maximum"] !== "number" ||
    typeof alpha["nonZeroFrames"] !== "number" ||
    engine?.["name"] !== "rvm" || typeof engine["version"] !== "string" ||
    (engine["model"] !== "rvm_mobilenetv3" && engine["model"] !== "rvm_resnet50") ||
    (params?.["model"] !== "rvm_mobilenetv3" && params["model"] !== "rvm_resnet50") ||
    typeof params["downsampleRatio"] !== "number" ||
    typeof stabilization?.["enabled"] !== "boolean" ||
    typeof stabilization["alphaMin"] !== "number" ||
    typeof stabilization["motionGain"] !== "number" ||
    typeof stabilization["minSpeckleArea"] !== "number"
  ) return undefined;
  return {
    clipId: payload["clipId"],
    sourceAssetId: payload["sourceAssetId"],
    jobId: job.jobId,
    schema: "guyditor.matte/v1",
    path: payload["path"],
    format: "ffv1-gray-mkv",
    sha256: payload["sha256"],
    cacheKey: payload["cacheKey"],
    source: {
      path: source["path"],
      sha256: source["sha256"],
      frames: { from: frames["from"], to: frames["to"] },
    },
    width: payload["width"],
    height: payload["height"],
    frameCount: payload["frameCount"],
    fps: payload["fps"],
    alpha: {
      minimum: alpha["minimum"], maximum: alpha["maximum"], nonZeroFrames: alpha["nonZeroFrames"],
    },
    engine: { name: "rvm", version: engine["version"], model: engine["model"] },
    params: {
      model: params["model"],
      downsampleRatio: params["downsampleRatio"],
      stabilization: {
        enabled: stabilization["enabled"],
        alphaMin: stabilization["alphaMin"],
        motionGain: stabilization["motionGain"],
        minSpeckleArea: stabilization["minSpeckleArea"],
      },
    },
  };
}

export class MatteService {
  readonly #store: ProjectStore;
  readonly #jobs: JobQueue;
  readonly #mlworker: Pick<MlworkerSupervisor, "hello">;
  readonly #execute: MatteServiceOptions["execute"];

  public constructor(options: MatteServiceOptions) {
    this.#store = options.store;
    this.#jobs = options.jobs;
    this.#mlworker = options.mlworker;
    this.#execute = options.execute;
  }

  public readonly onKeyQcRun: NonNullable<CompositorModelOptions["onKeyQcRun"]> = ({
    project,
    clipId,
    shotBoundaries,
  }) => {
    const clip = project.sequences.flatMap(({ clips }) => clips).find(({ id }) => id === clipId);
    if (clip === undefined) throw new Error(`Clip ${clipId} does not exist.`);
    const asset = project.assets.find(({ id }) => id === clip.asset);
    const key = clip.effects?.find(({ kind }) => kind === "key");
    if (asset === undefined || key === undefined) {
      throw new Error(`Clip ${clipId} has no keyed source asset.`);
    }
    const keySettings = key.params as unknown as KeyQcJobPayload["keySettings"];
    const matteAsset = keySettings.mode === "neural" && keySettings.neural?.matteAssetId !== undefined
      ? project.assets.find(({ id }) => id === keySettings.neural?.matteAssetId)
      : undefined;
    const matteMapping = matteAsset?.analyses?.["matte"] as {
      sourceFrames?: { from?: unknown };
    } | undefined;
    const generatedFrom = matteMapping?.sourceFrames?.from;
    if (keySettings.mode === "neural" && (matteAsset === undefined || typeof generatedFrom !== "number")) {
      throw new Error(`Clip ${clipId} has no accepted frozen matte mapping.`);
    }
    const sourceBoundaries = shotBoundaries.length > 0
      ? shotBoundaries
      : sceneBoundariesForAsset(project, this.#store.root, asset.id);
    enqueueKeyQc(this.#jobs, {
      projectRoot: this.#store.root,
      sourcePath: isAbsolute(asset.path) ? asset.path : resolve(this.#store.root, asset.path),
      clipId,
      assetId: asset.id,
      width: asset.video?.width ?? asset.image?.width ?? project.settings.timeline.width,
      height: asset.video?.height ?? asset.image?.height ?? project.settings.timeline.height,
      frameCount: Math.max(1, clip.source.out.frames - clip.source.in.frames),
      fps: clip.source.in.fps,
      keySettings,
      sourceFrameOffset: clip.source.in.frames,
      ...(matteAsset === undefined ? {} : {
        mattePath: isAbsolute(matteAsset.path)
          ? matteAsset.path
          : resolve(this.#store.root, matteAsset.path),
        matteFrameOffset: clip.source.in.frames - (generatedFrom as number),
      }),
      shotBoundaries: sourceBoundaries
        .filter((frame) => frame >= clip.source.in.frames && frame < clip.source.out.frames)
        .map((frame) => frame - clip.source.in.frames),
    });
  };

  public readonly onMatteGenerate: NonNullable<CompositorModelOptions["onMatteGenerate"]> = ({
    project,
    clipId,
    neural,
    shotBoundaries,
  }) => {
    const capability = this.#mlworker.hello?.capabilities.find(({ task }) => task === "matte");
    if (capability === undefined || capability.engine !== "rvm" ||
        (capability.models !== undefined && !capability.models.includes(neural.model))) {
      throw makeGuyditorError(
        "E_MATTE_CAPABILITY_MISSING",
        `RobustVideoMatting capability for ${neural.model} is not installed.`,
        {
          affected: [clipId],
          suggestion: "Install a supported RVM TorchScript model in the mlworker model directory, then restart the worker.",
        },
      );
    }
    const clip = project.sequences.flatMap(({ clips }) => clips).find(({ id }) => id === clipId);
    const asset = project.assets.find(({ id }) => id === clip?.asset);
    if (clip === undefined || asset === undefined) {
      throw new Error(`Clip ${clipId} has no available source asset.`);
    }
    this.#jobs.enqueue({
      kind: "matte",
      title: `Generate neural matte for ${clipId}`,
      cancellable: true,
      payload: {
        clipId,
        sourceAssetId: asset.id,
        input: {
          path: isAbsolute(asset.path) ? asset.path : resolve(this.#store.root, asset.path),
          frames: { from: clip.source.in.frames, to: clip.source.out.frames - 1 },
          fps: clip.source.in.fps,
          shotBoundaries: shotBoundaries.length > 0
            ? shotBoundaries
            : sceneBoundariesForAsset(project, this.#store.root, asset.id)
              .filter((frame) => frame >= clip.source.in.frames && frame < clip.source.out.frames),
        },
        params: neural as unknown as Record<string, JsonValue>,
        output: {
          dir: join(this.#store.root, ".guyditor", "cache", "mattes"),
          format: "ffv1-gray-mkv",
        },
      },
    });
  };

  public candidates(clipId: string): MatteCandidate[] {
    return this.#jobs.list({ kind: "matte", state: "done" }).flatMap((job) => {
      const candidate = matteCandidateFromJob(job);
      return candidate?.clipId === clipId ? [candidate] : [];
    });
  }

  public async accept(clipId: string, jobId: string): Promise<{
    assetId: string;
    path: string;
    revision: string;
  }> {
    const job = this.#jobs.get(jobId);
    const candidate = job === undefined ? undefined : matteCandidateFromJob(job);
    if (candidate === undefined || candidate.clipId !== clipId) {
      throw new Error(`Completed matte candidate ${jobId} for ${clipId} does not exist.`);
    }
    const current = this.#store.currentProject;
    const clip = current.sequences.flatMap(({ clips }) => clips).find(({ id }) => id === clipId);
    const sourceAsset = current.assets.find(({ id }) => id === candidate.sourceAssetId);
    if (clip === undefined || sourceAsset === undefined || clip.asset !== sourceAsset.id ||
        sourceAsset.sha256 !== candidate.source.sha256) {
      throw makeGuyditorError(
        "E_MATTE_SOURCE_CHANGED",
        "The source asset changed after this neural matte candidate was generated.",
        { affected: [clipId, candidate.sourceAssetId], suggestion: "Generate a new matte candidate." },
      );
    }
    const cacheRoot = resolve(this.#store.root, ".guyditor", "cache", "mattes");
    const candidatePath = resolve(candidate.path);
    if (!candidatePath.startsWith(`${cacheRoot}/`) || await sha256File(candidatePath) !== candidate.sha256) {
      throw makeGuyditorError(
        "E_MATTE_CANDIDATE_INVALID",
        "The neural matte candidate is outside the project cache or failed its hash check.",
        { affected: [clipId, jobId], suggestion: "Generate the matte again." },
      );
    }

    const priorKey = clip.effects?.find(({ kind }) => kind === "key")?.params as
      unknown as KeySettings | undefined;
    const reused = current.assets.find(({ sha256 }) => sha256 === candidate.sha256);
    if (reused !== undefined && (reused.kind !== "generated" || reused.provenance === undefined)) {
      throw makeGuyditorError(
        "E_OP_ASSET_CONFLICT",
        `Matte hash is already registered as non-generated asset ${reused.id}.`,
        { affected: [reused.id, clipId] },
      );
    }
    const matteAssetId = reused?.id ?? makeId("ast");
    const neural: NeuralMatteParams = {
      ...structuredClone(candidate.params),
      matteAssetId,
    };
    const settings: KeySettings = {
      schema: "guyditor/key@1",
      mode: "neural",
      neural,
      chroma: structuredClone(priorKey?.chroma ?? {
        keyColor: "#00B140",
        tolerance: 0.35,
        softness: 0.12,
        preBlur: 1.5,
        edge: { erodePx: 1, featherPx: 2 },
        spill: { mode: "despill", strength: 0.6 },
      }),
      masks: structuredClone(priorKey?.masks ?? []),
      ...(priorKey?.postColor === undefined ? {} : { postColor: structuredClone(priorKey.postColor) }),
    };
    if (reused !== undefined) {
      const accepted = await this.#execute({
        operations: [{ op: "clip.key.set", params: { clipId, settings } }],
        intent: "direct",
        label: `Accept neural matte ${jobId} for ${clipId}`,
      });
      return { assetId: reused.id, path: reused.path, revision: accepted.revision };
    }

    const matteRelativePath = `assets/mattes/${matteAssetId}.mkv`;
    const mattePath = join(this.#store.root, matteRelativePath);
    const sidecarName = `provenance-${matteAssetId}`;
    const sidecarRelativePath = `sidecars/provenance/${matteAssetId}.provenance.json`;
    const sidecarPath = join(this.#store.root, sidecarRelativePath);
    const provenance = {
      format: "guyditor.provenance/v1",
      assetId: matteAssetId,
      kind: "neural-matte",
      sourceAssetId: sourceAsset.id,
      sourceSha256: sourceAsset.sha256,
      sourceFrames: candidate.source.frames,
      model: candidate.params.model,
      params: candidate.params,
      mlworkerVersion: candidate.engine.version,
      jobId,
    };
    const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
    await Promise.all([
      mkdir(join(this.#store.root, "assets", "mattes"), { recursive: true }),
      mkdir(join(this.#store.root, "sidecars", "provenance"), { recursive: true }),
    ]);
    await copyFile(candidatePath, mattePath);
    await chmod(mattePath, 0o444);
    await writeFile(sidecarPath, provenanceText, "utf8");
    const matteBytes = (await stat(mattePath)).size;
    const sidecar: SidecarRef = {
      name: sidecarName,
      path: sidecarRelativePath,
      schema: "guyditor.provenance/v1",
      sha256: createHash("sha256").update(provenanceText).digest("hex"),
      generatedBy: { tool: "rvm", version: candidate.engine.version, job: jobId },
      inputs: [{ asset: sourceAsset.id, sha256: sourceAsset.sha256 }],
    };
    const asset: Asset = {
      id: matteAssetId,
      kind: "generated",
      path: matteRelativePath,
      sha256: candidate.sha256,
      bytes: matteBytes,
      container: "matroska",
      probe: {
        duration: { frames: candidate.frameCount, fps: candidate.fps },
        width: candidate.width,
        height: candidate.height,
        fps: candidate.fps,
      },
      analyses: {
        matte: {
          sourceAssetId: sourceAsset.id,
          sourceSha256: sourceAsset.sha256,
          sourceFrames: structuredClone(candidate.source.frames),
          model: candidate.params.model,
          params: structuredClone(candidate.params),
          mlworkerVersion: candidate.engine.version,
        },
      },
      video: {
        codec: "ffv1",
        width: candidate.width,
        height: candidate.height,
        fps: candidate.fps,
        pixFmt: "gray",
        hasAlpha: false,
        rotation: 0,
      },
      ingest: {
        at: new Date().toISOString(),
        ffprobeVersion: `mlworker ${candidate.engine.version}`,
        via: "generated",
      },
      provenance: { sidecar: sidecarName },
    };
    try {
      const accepted = await this.#execute({
        operations: [
          { op: "sidecar.register", params: { name: sidecarName, sidecar } },
          { op: "asset.ingest", params: { assets: [asset] } },
          { op: "clip.key.set", params: { clipId, settings } },
        ],
        intent: "direct",
        label: `Freeze and accept neural matte ${jobId} for ${clipId}`,
      });
      return { assetId: matteAssetId, path: matteRelativePath, revision: accepted.revision };
    } catch (error: unknown) {
      await Promise.allSettled([unlink(mattePath), unlink(sidecarPath)]);
      throw error;
    }
  }
}
