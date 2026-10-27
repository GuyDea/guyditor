import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Asset, JobQueue, MarkerRecord, ProjectStore, TimeValue } from "../../../core/src/index.js";
import {
  groupSegments,
  orderAssets,
  parseScriptBlocks,
  renderEvidencePackage,
  segmentTranscript,
  terminalJob,
} from "../../../transcript/src/index.js";
import type {
  AssemblySession,
  CandidateSegment,
  TranscriptSidecar,
} from "../../../transcript/src/index.js";

export interface PrepareDeps {
  store: ProjectStore;
  readSession: (id: string) => Promise<AssemblySession>;
  writeSession: (session: AssemblySession) => Promise<void>;
  transcripts: () => Promise<TranscriptSidecar[]>;
  markers: (assetId: string) => Promise<MarkerRecord[]>;
  jobs: JobQueue;
}

interface Prepared {
  asset: Asset;
  fileName: string;
  durationMs: number;
  sidecar: TranscriptSidecar;
}

function durationMsOf(time: TimeValue | undefined): number | null {
  if (time === undefined) return null;
  if ("frames" in time) {
    const [numerator, denominator = "1"] = time.fps.split("/");
    return Math.round((time.frames * Number(denominator) * 1000) / Number(numerator));
  }
  return Math.round((time.samples * 1000) / time.rate);
}

function hasActiveWords(sidecar: TranscriptSidecar): boolean {
  return Object.values(sidecar.words).some(({ state }) => state === "active");
}

function pendingTranscribe(jobs: JobQueue, assetId: string): string | undefined {
  return jobs.list({ kind: "transcribe", state: ["queued", "running"] })
    .find(({ payload }) =>
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
      && payload["assetId"] === assetId)?.jobId;
}

async function gather(
  deps: PrepareDeps,
  session: AssemblySession,
  signal: AbortSignal,
  reportProgress: (progress: number) => void,
  notes: string[],
): Promise<{ prepared: Prepared[]; language: string }> {
  let transcripts = await deps.transcripts();
  const language = transcripts[0]?.language ?? "und";
  const assets = session.inputs.assetIds.map((id) => {
    const asset = deps.store.currentProject.assets.find((candidate) => candidate.id === id);
    if (asset === undefined) throw new Error(`Asset ${id} is no longer in the project.`);
    return asset;
  });
  const prepared: Prepared[] = [];
  for (const [index, asset] of assets.entries()) {
    signal.throwIfAborted();
    const fileName = basename(asset.path);
    let sidecar = transcripts.find(({ assetId }) => assetId === asset.id);
    const waitFor = sidecar === undefined ? pendingTranscribe(deps.jobs, asset.id) : undefined;
    if (waitFor !== undefined) {
      await terminalJob(deps.jobs, waitFor, signal);
      transcripts = await deps.transcripts();
      sidecar = transcripts.find(({ assetId }) => assetId === asset.id);
    }
    if (sidecar === undefined) {
      notes.push(`${fileName}: no transcript — run transcription first`);
    } else if (!hasActiveWords(sidecar)) {
      notes.push(`${fileName}: no speech, skipped`);
    } else {
      const durationMs = durationMsOf(asset.probe.duration);
      if (durationMs === null) notes.push(`${fileName}: duration unknown`);
      prepared.push({ asset, fileName, durationMs: durationMs ?? 0, sidecar });
    }
    reportProgress((index + 1) / assets.length);
  }
  return { prepared, language };
}

async function build(
  deps: PrepareDeps,
  session: AssemblySession,
  signal: AbortSignal,
  reportProgress: (progress: number) => void,
): Promise<AssemblySession["evidence"]> {
  const notes: string[] = [];
  const { prepared, language } = await gather(deps, session, signal, reportProgress, notes);
  if (prepared.length === 0) throw new Error(`Nothing to assemble — ${notes.join("; ")}`);
  const project = deps.store.currentProject;
  const ordered = orderAssets(prepared.map(({ asset, fileName, durationMs }) => ({
    assetId: asset.id,
    fileName,
    capturedAt: asset.captureTime?.value ?? project.project.created,
    captureSource: asset.captureTime?.source ?? "file-mtime",
    durationMs,
  })));
  const rawSegments: CandidateSegment[] = [];
  for (const evidenceAsset of ordered) {
    const { sidecar } = prepared.find(({ asset }) => asset.id === evidenceAsset.assetId)!;
    rawSegments.push(...segmentTranscript({
      assetId: evidenceAsset.assetId,
      ordinal: evidenceAsset.ordinal,
      sidecar,
      markers: (await deps.markers(evidenceAsset.assetId)).filter(({ source }) => source === "spoken"),
    }));
  }
  const script = session.inputs.script;
  const scriptBlocks = script === null
    ? []
    : parseScriptBlocks(await readFile(join(deps.store.root, script.path), "utf8"));
  const { segments, groups } = groupSegments(rawSegments, scriptBlocks);
  return renderEvidencePackage({
    projectName: project.project.name,
    language,
    assets: ordered,
    segments,
    groups,
    scriptBlocks,
    notes,
  });
}

export async function prepareSession(
  deps: PrepareDeps,
  sessionId: string,
  signal: AbortSignal,
  reportProgress: (progress: number) => void,
): Promise<AssemblySession> {
  let session: AssemblySession = { ...await deps.readSession(sessionId), status: "preparing", error: null };
  await deps.writeSession(session);
  try {
    const evidence = await build(deps, session, signal, reportProgress);
    session = { ...session, evidence, status: "conversing" };
  } catch (error: unknown) {
    session = {
      ...session,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await deps.writeSession(session);
  return session;
}

export function registerAssemblyPrepareExecutor(queue: JobQueue, deps: PrepareDeps): void {
  queue.registerExecutor("assembly.prepare", async (job, { signal, reportProgress }) => {
    const sessionId = (job.payload as { sessionId: string }).sessionId;
    const session = await prepareSession(deps, sessionId, signal, reportProgress);
    return { sessionId, status: session.status };
  });
}
