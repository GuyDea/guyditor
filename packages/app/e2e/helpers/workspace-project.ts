import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  AnnotationService,
  createProject,
  JobQueue,
  OperationEngine,
} from "../../../core/src/index.js";
import type { ProjectStore, Result } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { TranscriptEngine } from "../../../transcript/src/index.js";
import {
  framingSidecarReference,
  serializeFramingSidecar,
} from "../../../deliver/src/index.js";
import type { FramingSidecar } from "../../../deliver/src/index.js";
import {
  peaksCachePaths,
  timelineFrameCachePaths,
} from "../../../media/src/index.js";
import {
  representativeSourceFrames,
  TIMELINE_FRAME_HEIGHT,
} from "../../src/renderer/panels/timeline-media.js";

const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";

export interface WorkspaceProjectOptions {
  transcript?: boolean;
  proposal?: boolean;
  queuedJob?: boolean;
  audioPost?: boolean;
  jumpCut?: boolean;
  derivedShort?: boolean;
  framing?: boolean;
  shortAnnotation?: boolean;
  timelineMedia?: boolean;
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
  const captionPresetPath = resolve(
    import.meta.dirname,
    "../../../../.fixtures/projects/ac003/presets/pre_aaaaaaaaaa@1.yaml",
  );
  const captionPresetBytes = await readFile(captionPresetPath);
  model.presets[0]!.sha256 = createHash("sha256")
    .update(captionPresetBytes)
    .digest("hex");
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
  if (options.timelineMedia === true) {
    model.assets[0]!.video = {
      codec: "h264",
      width: 1920,
      height: 1080,
      fps: "30/1",
      pixFmt: "yuv420p",
      hasAlpha: false,
      rotation: 0,
    };
  }
  if (options.jumpCut === true) {
    model.sequences[0]!.clips[1]!.source = {
      in: { frames: 48, fps: "24/1" },
      out: { frames: 72, fps: "24/1" },
    };
    model.presets.push({
      id: "pre_smoothcut2",
      name: "smooth-cut",
      kind: "transition",
      version: 1,
      path: "presets/pre_smoothcut2@1.yaml",
      sha256: "b".repeat(64),
    });
  }
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
  if (options.derivedShort === true) {
    model.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "Portrait short sequence",
      clips: [{
        id: "clp_cccccccccc",
        asset: "ast_aaaaaaaaaa",
        source: {
          in: { frames: 24, fps: "24/1" },
          out: { frames: 36, fps: "24/1" },
        },
      }],
    });
    model.layers.push({
      id: "lyr_cccccccccc",
      kind: "video",
      name: "Portrait short video",
      order: 0,
      enabled: true,
      locked: false,
      sequence: "seq_bbbbbbbbbb",
    });
    model.captions.push({
      ...structuredClone(model.captions[0]!),
      id: "cts_bbbbbbbbbb",
      name: "Portrait short captions",
      sourceLayerIds: ["lyr_cccccccccc"],
    });
    model.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "Portrait short",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_bbbbbbbbbb",
      captionsTrackId: "cts_bbbbbbbbbb",
      status: "draft",
      dependencies: [],
    });
    if (options.audioPost === true) {
      model.layers.push({
        id: "lyr_dddddddddd",
        kind: "music",
        name: "Portrait short music",
        order: 1,
        enabled: true,
        locked: false,
        sequence: "seq_bbbbbbbbbb",
      });
    }
  }
  let framing: FramingSidecar | undefined;
  if (options.framing === true) {
    if (options.derivedShort !== true) {
      throw new Error("The framing fixture requires a derived short.");
    }
    framing = {
      format: "guyditor.framing/v1",
      deliverableId: "dlv_bbbbbbbbbb",
      profile: "youtube-shorts@1.0.0",
      sourceRevision: model.revision,
      aspect: "9:16",
      requiredTrackAssets: [],
      decisions: [{
        decisionId: "fd_0001",
        shot: {
          clipId: "clp_cccccccccc",
          source: {
            start: { frames: 24, fps: "24/1" },
            end: { frames: 36, fps: "24/1" },
          },
        },
        mode: "crop",
        crop: {
          keyframes: [{
            at: { frames: 24, fps: "24/1" },
            rect: { x: 0.341796875, y: 0, w: 0.31640625, h: 1 },
          }],
        },
        subjects: [],
        confidence: 0,
        warnings: [],
      }],
    };
    model.sidecars.push(framingSidecarReference(framing, []));
  }
  const created = await valueOf(Promise.resolve(createProject(root, model)));
  if (options.timelineMedia === true) {
    const asset = created.currentProject.assets[0]!;
    const peaksPath = peaksCachePaths(created.root, asset).file;
    await mkdir(dirname(peaksPath), { recursive: true });
    await writeFile(peaksPath, `${JSON.stringify({
      format: "guyditor.peaks/v1",
      assetId: asset.id,
      sourceHash: asset.sha256,
      sampleRate: 48_000,
      tiers: [960, 9_600, 48_000].map((samplesPerPeak) => ({
        samplesPerPeak,
        data: Array.from({ length: 240 }, (_unused, index) =>
          index % 2 === 0 ? -48 - index % 32 : 48 + index % 32),
      })),
    })}\n`);
    const image = await readFile(resolve(
      import.meta.dirname,
      "../../../../templates/title-card/preview.png",
    ));
    for (const clip of created.currentProject.sequences[0]!.clips) {
      for (const sourceFrame of representativeSourceFrames(clip, 96)) {
        const paths = timelineFrameCachePaths(
          created.root,
          asset,
          sourceFrame,
          TIMELINE_FRAME_HEIGHT,
        );
        await mkdir(dirname(paths.file), { recursive: true });
        await writeFile(paths.file, image);
      }
    }
  }
  await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");
  await mkdir(join(root, "presets"), { recursive: true });
  await writeFile(
    join(root, "presets/pre_aaaaaaaaaa@1.yaml"),
    captionPresetBytes,
  );
  if (framing !== undefined) {
    const reference = framingSidecarReference(framing, []);
    const path = join(root, reference.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeFramingSidecar(framing), "utf8");
  }

  if (options.transcript === true) await addTranscript(created);
  if (options.shortAnnotation === true) {
    if (options.derivedShort !== true) {
      throw new Error("The short-annotation fixture requires a derived short.");
    }
    await addShortAnnotation(created);
  }
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

async function addShortAnnotation(store: ProjectStore): Promise<void> {
  const annotations = new AnnotationService({ appVersion: "0.0.0-e2e" });
  await valueOf(annotations.execute(store, [{
    op: "annotation.create",
    params: {
      annotation: {
        id: "ann_cccccccccc",
        shape: "pin",
        body: "Check this short frame",
        style: { color: "#f2b84b", strokeWidth: 0.004 },
        geometry: { kind: "pin", at: { x: 0.5, y: 0.5 } },
        anchor: {
          kind: "timeline",
          sequenceId: "seq_bbbbbbbbbb",
          frame: { frames: 0, fps: "24/1" },
        },
        extent: { frames: 0, fps: "24/1" },
        canvasRef: {
          sequenceId: "seq_bbbbbbbbbb",
          deliverableId: "dlv_bbbbbbbbbb",
          aspect: "9:16",
        },
        state: "open",
        blocking: false,
        author: { kind: "human", id: "fixture" },
        createdAt: "2026-07-19T00:00:00.000Z",
        history: [],
      },
    },
  }]));
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
    reason: {
      text: "Tighten the first beat",
      sources: [{ kind: "annotation", ref: "ann_bbbbbbbbbb" }],
    },
    addresses: ["ann_bbbbbbbbbb"],
  }));
}
