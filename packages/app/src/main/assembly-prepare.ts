import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Asset, JobQueue, MarkerRecord, ProjectStore, TimeValue } from "../../../core/src/index.js";
import {
  contextFileNotes,
  groupSegments,
  hasQuotedParagraphs,
  orderAssets,
  parseScriptBlocks,
  renderEvidencePackage,
  resolveScript,
  segmentTranscript,
  terminalJob,
} from "../../../transcript/src/index.js";
import type {
  AssemblySession,
  CandidateSegment,
  ContextFile,
  TranscriptSidecar,
} from "../../../transcript/src/index.js";

export interface PrepareDeps {
  store: ProjectStore;
  readSession: (id: string) => Promise<AssemblySession>;
  /** Read-modify-write under the service's write queue; returns the stored result. */
  updateSession: (id: string, change: (current: AssemblySession) => AssemblySession) => Promise<AssemblySession>;
  transcripts: () => Promise<TranscriptSidecar[]>;
  markers: (assetId: string) => Promise<MarkerRecord[]>;
  jobs: JobQueue;
  /** The AI settings to snapshot at Analyze: files, footage and settings all become fixed there. */
  settings: () => AssemblySession["settings"];
  transcriptWait?: { intervalMs: number; deadlineMs: number };
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

const DEFAULT_TRANSCRIPT_WAIT = { intervalMs: 250, deadlineMs: 15_000 };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error("Cancelled while waiting for a transcript."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The transcript sidecar is written by a host follow-up shortly after the transcribe job is done. */
async function awaitSidecar(
  deps: PrepareDeps,
  assetId: string,
  signal: AbortSignal,
): Promise<TranscriptSidecar | undefined> {
  const { intervalMs, deadlineMs } = deps.transcriptWait ?? DEFAULT_TRANSCRIPT_WAIT;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    signal.throwIfAborted();
    const found = (await deps.transcripts()).find((sidecar) => sidecar.assetId === assetId);
    if (found !== undefined || Date.now() >= deadline) return found;
    await sleep(intervalMs, signal);
  }
}

async function gather(
  deps: PrepareDeps,
  session: AssemblySession,
  signal: AbortSignal,
  reportProgress: (progress: number) => void,
  notes: string[],
): Promise<{ prepared: Prepared[]; language: string }> {
  const transcripts = await deps.transcripts();
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
      const finished = await terminalJob(deps.jobs, waitFor, signal, { cancelOnAbort: false });
      if (finished.state === "done") sidecar = await awaitSidecar(deps, asset.id, signal);
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
  script: ContextFile | null,
  textOf: (file: ContextFile) => string,
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
  // Auto resolution only picks quoted Markdown; an explicit choice without quotes yields no blocks.
  const scriptText = script === null ? "" : textOf(script);
  const scriptBlocks = script !== null && hasQuotedParagraphs(scriptText) ? parseScriptBlocks(scriptText) : [];
  notes.push(script === null ? "script: none" : `script: ${script.label} ${script.name}`);
  if (script !== null && scriptBlocks.length === 0) {
    notes.push(`${script.label} ${script.name} has no quoted paragraphs; no script blocks`);
  }
  const { segments, groups } = groupSegments(rawSegments, scriptBlocks);
  return renderEvidencePackage({
    projectName: project.project.name,
    language,
    assets: ordered,
    segments,
    groups,
    scriptBlocks,
    contextFiles: contextFileNotes(session.inputs.files, session.settings.transport, textOf, scriptBlocks.length > 0),
    notes,
  });
}

/** Reads every sent text file up front; a file missing from the project fails the prepare. */
async function readContextTexts(root: string, files: readonly ContextFile[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const file of files.filter(({ kind, sent }) => kind === "text" && sent)) {
    try {
      texts.set(file.label, await readFile(join(root, file.path), "utf8"));
    } catch {
      throw new Error(`E_ASSEMBLY_INVALID_INPUT: context file ${file.label} ${file.name} is missing from the project`);
    }
  }
  return texts;
}

/** Keeps an abandon that landed while preparation was running. */
function transition(change: (current: AssemblySession) => AssemblySession) {
  return (current: AssemblySession): AssemblySession =>
    current.status === "abandoned" ? current : change(current);
}

export async function prepareSession(
  deps: PrepareDeps,
  sessionId: string,
  signal: AbortSignal,
  reportProgress: (progress: number) => void,
): Promise<AssemblySession> {
  const started = await deps.updateSession(sessionId, transition((current) =>
    ({
      ...current, status: "preparing", error: null, evidence: null, messages: [], plan: null,
      compiled: null, proposalId: null, tighteningJobId: null, settings: deps.settings(),
    })));
  if (started.status === "abandoned") return started;
  try {
    const texts = await readContextTexts(deps.store.root, started.inputs.files);
    const textOf = (file: ContextFile): string => texts.get(file.label) ?? "";
    const script = resolveScript(started.inputs.files, started.inputs.script, textOf);
    const withRole = (file: ContextFile): ContextFile =>
      ({ ...file, role: file.label === script?.label ? "script" : "context" });
    const resolved = await deps.updateSession(sessionId, transition((current) =>
      ({ ...current, inputs: { ...current.inputs, files: current.inputs.files.map(withRole) } })));
    if (resolved.status === "abandoned") return resolved;
    const evidence = await build(deps, resolved, script, textOf, signal, reportProgress);
    return await deps.updateSession(sessionId, transition((current) =>
      ({ ...current, evidence, status: "conversing" })));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return deps.updateSession(sessionId, transition((current) =>
      ({ ...current, status: "failed", error: message })));
  }
}

export function registerAssemblyPrepareExecutor(queue: JobQueue, deps: PrepareDeps): void {
  queue.registerExecutor("assembly.prepare", async (job, { signal, reportProgress }) => {
    const sessionId = (job.payload as { sessionId: string }).sessionId;
    const session = await prepareSession(deps, sessionId, signal, reportProgress);
    return { sessionId, status: session.status };
  });
}
