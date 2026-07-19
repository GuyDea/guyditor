import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  AnnotationService,
  createProject,
  JobQueue,
  OperationEngine,
} from "../../../core/src/index.js";
import type { ProjectStore, Result } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { TranscriptEngine } from "../../../transcript/src/index.js";

const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";

export interface WorkspaceProjectOptions {
  transcript?: boolean;
  proposal?: boolean;
  queuedJob?: boolean;
  audioPost?: boolean;
}

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

export async function createWorkspaceProject(
  options: WorkspaceProjectOptions = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-workspace-template-"));
  const model = projectFixture();
  model.project.name = "Workspace e2e";
  model.assets[0]!.path = resolve(import.meta.dirname, "../../../../.fixtures/bars-1080p30-10s.mp4");
  model.assets[0]!.audio = [{
    index: 0,
    codec: "aac",
    sampleRate: 48_000,
    channels: 1,
    layout: "mono",
  }];
  model.assets[0]!.probe.audio = { rate: 48_000, channels: 1 };
  model.sidecars[0]!.inputs = [];
  model.sidecars[0]!.sha256 = createHash("sha256").update(EMPTY_ANNOTATIONS).digest("hex");
  if (options.audioPost === true) {
    model.sequences[0]!.audio = { targetLufs: -16, truePeakDb: -1.5 };
    model.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "music",
      name: "Music bed",
      order: 1,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    });
  }
  const created = await valueOf(Promise.resolve(createProject(root, model)));
  await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");

  if (options.transcript === true) await addTranscript(created);
  if (options.proposal === true) await addProposal(created);
  if (options.queuedJob === true) {
    const { queue } = JobQueue.open(join(root, ".guyditor/jobs.sqlite"));
    queue.enqueue({
      kind: "manual.wait",
      title: "Manual cancellable hold",
      payload: null,
      cancellable: true,
    });
    queue.close();
  }
  return root;
}

async function addTranscript(store: ProjectStore): Promise<void> {
  const transcript = new TranscriptEngine({
    appVersion: "0.0.0-e2e",
    idFactory: (prefix) => prefix === "seg" ? "seg_aaaaaaaaaa" :
      prefix === "spk" ? "spk_aaaaaaaaaa" : `${prefix}_cccccccccc`,
  });
  await valueOf(transcript.createFromTranscription(store, "ast_aaaaaaaaaa", {
    language: "en",
    languageProbability: 1,
    engine: { name: "e2e", version: "1", model: "fixture" },
    jobId: "job_aaaaaaaaaa",
    segments: [{
      index: 0,
      start: { samples: 0, rate: 48_000 },
      end: { samples: 48_000, rate: 48_000 },
      text: "one two three",
      avgLogprob: 0,
      noSpeechProb: 0,
      words: [
        { text: "one", start: { samples: 2_400, rate: 48_000 }, end: { samples: 9_600, rate: 48_000 }, probability: 0.98 },
        { text: "two", start: { samples: 16_800, rate: 48_000 }, end: { samples: 24_000, rate: 48_000 }, probability: 0.96 },
        { text: "three", start: { samples: 31_200, rate: 48_000 }, end: { samples: 40_800, rate: 48_000 }, probability: 0.94 },
      ],
    }],
  }));
}

async function addProposal(store: ProjectStore): Promise<void> {
  const annotations = new AnnotationService({ appVersion: "0.0.0-e2e" });
  await valueOf(annotations.execute(store, [{
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
        blocking: false,
        author: { kind: "human", id: "fixture" },
        createdAt: "2026-07-19T00:00:00.000Z",
        history: [],
      },
    },
  }]));
  const engine = new OperationEngine(store.currentProject, {
    appVersion: "0.0.0-e2e",
    committer: store,
    proposalStore: store,
    idFactory: () => "prp_bbbbbbbbbb",
  });
  await valueOf(engine.createProposal({
    operations: [{
      op: "clip.trim",
      params: {
        clipId: "clp_aaaaaaaaaa",
        edge: "tail",
        delta: { frames: 1, fps: "24/1" },
        snapPolicy: "none",
      },
    }],
    instruction: { kind: "annotation", annotation: "ann_bbbbbbbbbb" },
    actor: { kind: "agent", id: "stub-director", model: "deterministic" },
    reason: { text: "Tighten the first beat", sources: [] },
    addresses: ["ann_bbbbbbbbbb"],
  }));
}
