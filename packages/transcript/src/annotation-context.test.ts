import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as corePackage from "../../core/src/index.js";
import type {
  Annotation,
  AnnotationContextPackage,
  AnnotationContextProject,
  AnnotationService,
  AnnotationTranscriptSource,
  IdFactory,
  IdPrefix,
  ProjectStore,
  Result,
} from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import * as transcriptPackage from "./index.js";
import { serializeTranscriptSidecar } from "./sidecar.js";
import type { TranscriptSidecar } from "./types.js";

const NOW = new Date("2026-07-18T12:00:00Z");
const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

function ids(): IdFactory {
  const ordinals = new Map<IdPrefix, number>();
  return (prefix) => {
    const ordinal = ordinals.get(prefix) ?? 0;
    ordinals.set(prefix, ordinal + 1);
    const character = String.fromCharCode("a".charCodeAt(0) + ordinal);
    return `${prefix}_${character.repeat(10)}`;
  };
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(`${settled.error.code}: ${settled.error.message}`);
  return settled.value;
}

function transcript(): TranscriptSidecar {
  return {
    schema: "guyditor.transcript/v1",
    assetId: "ast_aaaaaaaaaa",
    audio: { rate: 48_000, channels: 1, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      engine: { name: "fixture", version: "1.0.0", model: "fixture" },
      alignment: { name: "fixture", version: "1.0.0", model: "fixture" },
      createdAt: NOW.toISOString(),
      jobId: "job_aaaaaaaaaa",
    },
    speakers: [{ id: "spk_aaaaaaaaaa", label: "Speaker" }],
    segments: [{
      id: "seg_aaaaaaaaaa",
      speaker: "spk_aaaaaaaaaa",
      language: "en",
      start: { samples: 0, rate: 48_000 },
      end: { samples: 28_800, rate: 48_000 },
      words: ["w000001", "w000002", "w000003"],
    }],
    words: {
      w000001: {
        text: "one",
        punctBefore: "",
        punctAfter: "",
        start: { samples: 0, rate: 48_000 },
        end: { samples: 8_000, rate: 48_000 },
        confidence: 1,
        alignment: "ctc",
        state: "active",
        origin: "asr",
      },
      w000002: {
        text: "two",
        punctBefore: "",
        punctAfter: "",
        start: { samples: 9_600, rate: 48_000 },
        end: { samples: 14_400, rate: 48_000 },
        confidence: 1,
        alignment: "ctc",
        state: "active",
        origin: "asr",
      },
      w000003: {
        text: "three",
        punctBefore: "",
        punctAfter: ".",
        start: { samples: 24_000, rate: 48_000 },
        end: { samples: 28_800, rate: 48_000 },
        confidence: 1,
        alignment: "ctc",
        state: "active",
        origin: "asr",
      },
    },
  };
}

async function fixture(): Promise<{
  project: AnnotationContextProject;
  service: AnnotationService;
  store: ProjectStore;
}> {
  const transcriptSidecar = transcript();
  const transcriptText = serializeTranscriptSidecar(transcriptSidecar);
  const root = await mkdtemp(join(tmpdir(), "guyditor-annctx-"));
  roots.push(root);
  const project = projectFixture();
  project.sidecars[0]!.inputs = [];
  project.sidecars[0]!.sha256 = createHash("sha256").update(EMPTY_ANNOTATIONS).digest("hex");
  project.sidecars.push({
    name: "transcript-ast_aaaaaaaaaa",
    path: "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json",
    schema: "guyditor.transcript/v1",
    sha256: createHash("sha256").update(transcriptText).digest("hex"),
    inputs: [{ asset: "ast_aaaaaaaaaa", sha256: project.assets[0]!.sha256 }],
  });
  const idFactory = ids();
  const store = await valueOf(Promise.resolve(corePackage.createProject(root, project, {
    idFactory,
    now: () => NOW,
  })));
  await mkdir(join(root, "sidecars/transcripts"), { recursive: true });
  await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");
  await writeFile(
    join(root, "sidecars/transcripts/ast_aaaaaaaaaa.transcript.json"),
    transcriptText,
    "utf8",
  );
  const transcriptApi = transcriptPackage as unknown as {
    createAnnotationTranscriptSource?: (
      sidecars: readonly TranscriptSidecar[],
    ) => AnnotationTranscriptSource;
  };
  expect(typeof transcriptApi.createAnnotationTranscriptSource).toBe("function");
  if (transcriptApi.createAnnotationTranscriptSource === undefined) {
    throw new Error("createAnnotationTranscriptSource is unavailable");
  }
  const transcriptSource = transcriptApi.createAnnotationTranscriptSource([transcriptSidecar]);
  const service = new corePackage.AnnotationService({
    idFactory,
    now: () => NOW,
    anchorResolvers: { wordLookup: transcriptSource },
  });
  const annotation: Annotation = {
    id: "ann_aaaaaaaaaa",
    shape: "note",
    body: "Tighten this line",
    geometry: null,
    anchor: { kind: "word", wordId: "w000003" },
    extent: { frames: 0, fps: "24/1" },
    canvasRef: { sequenceId: "seq_aaaaaaaaaa", aspect: "16:9" },
    state: "open",
    blocking: true,
    author: { kind: "human", id: "creator" },
    createdAt: NOW.toISOString(),
    history: [],
    context: { nearestWordId: "w000003" },
  };
  await valueOf(service.execute(store, [{
    op: "annotation.create",
    params: { annotation },
  }]));
  return {
    store,
    service,
    project: {
      store,
      transcript: transcriptSource,
      now: () => NOW,
    },
  };
}

describe("buildAnnotationContext", () => {
  it("assembles the normative package with proxy frame requests, transcript words, and layers", async () => {
    const api = corePackage as unknown as {
      buildAnnotationContext?: (
        project: AnnotationContextProject,
        annotationId: string,
      ) => Promise<Result<AnnotationContextPackage>>;
    };
    expect(typeof api.buildAnnotationContext).toBe("function");
    if (api.buildAnnotationContext === undefined) return;
    const { project, service, store } = await fixture();
    const annotation = await valueOf(service.get(store, "ann_aaaaaaaaaa"));
    expect(annotation).toBeDefined();
    if (annotation === undefined) return;
    expect(await valueOf(corePackage.resolveAnnotationRecord(
      store.currentProject,
      annotation,
      "seq_aaaaaaaaaa",
      project.transcript === undefined ? {} : { wordLookup: project.transcript },
    ))).toEqual({
      status: "resolved",
      timeline: { frames: 12, fps: "24/1" },
      source: { assetId: "ast_aaaaaaaaaa", time: { frames: 12, fps: "24/1" } },
    });

    const context = await valueOf(api.buildAnnotationContext(project, "ann_aaaaaaaaaa"));

    expect(context).toMatchObject({
      requestedFor: { annotationId: "ann_aaaaaaaaaa", anchor: "ann:ann_aaaaaaaaaa" },
      revision: "rev_00002",
      builtAt: NOW.toISOString(),
      position: {
        sequenceId: "seq_aaaaaaaaaa",
        timelineFrame: { frames: 12, fps: "24/1" },
        approximate: false,
      },
      files: {
        markedFrame: ".guyditor/cache/annctx/ann_aaaaaaaaaa/rev_00002/marked.frame-request.json",
        cleanFrame: ".guyditor/cache/annctx/ann_aaaaaaaaaa/rev_00002/clean.frame-request.json",
        proxyClip: ".guyditor/cache/annctx/ann_aaaaaaaaaa/rev_00002/nearby-frames.request.json",
      },
      clip: {
        startTimelineFrame: { frames: 0, fps: "24/1" },
        durationMs: 2000,
        truncated: false,
      },
      transcript: {
        words: [
          { id: "w000001", text: "one", startMs: 0, endMs: 167 },
          { id: "w000002", text: "two", startMs: 200, endMs: 300 },
          { id: "w000003", text: "three", startMs: 500, endMs: 600, anchor: true },
        ],
      },
      layers: [{
        layerId: "lyr_aaaaaaaaaa",
        zOrder: 0,
        type: "video",
        clipId: "clp_aaaaaaaaaa",
        assetId: "ast_aaaaaaaaaa",
        enabled: true,
        locked: false,
        opacity: 1,
        effectiveTransform: {},
        boundingBox: { x: 0, y: 0, width: 1, height: 1 },
        effects: [],
      }],
      annotation: { id: "ann_aaaaaaaaaa", history: [] },
      dataClasses: ["frames", "transcript", "metadata"],
    });

    const clean = JSON.parse(await readFile(
      join(store.root, context.files.cleanFrame),
      "utf8",
    )) as Record<string, unknown>;
    expect(clean).toMatchObject({
      kind: "frame-extraction",
      sequenceId: "seq_aaaaaaaaaa",
      timelineFrame: { frames: 12, fps: "24/1" },
      layers: [{
        proxyPath: ".guyditor/cache/proxies/ast_aaaaaaaaaa.aaaaaaaa.edit.mp4",
        frameIndex: 12,
      }],
    });
    const nearby = JSON.parse(await readFile(
      join(store.root, context.files.proxyClip!),
      "utf8",
    )) as { frames: Array<{ timelineFrame: { frames: number } }> };
    expect(nearby.frames.map(({ timelineFrame }) => timelineFrame.frames)).toEqual([11, 12, 13]);
  });
});
