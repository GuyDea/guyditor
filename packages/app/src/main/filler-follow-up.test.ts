import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnotationService, createProject, makeId, OperationEngine, parseAnnotationSidecar } from "../../../core/src/index.js";
import type {
  AuditSink,
  IdPrefix,
  JobRecord,
  JsonValue,
  ProjectStore,
  Result,
} from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { TranscriptEngine } from "../../../transcript/src/index.js";

import type { FillerCandidate } from "../../../transcript/src/index.js";
import { createFillerProposal, withinKeptRanges } from "./filler-follow-up.js";
import type { FillerFollowUpDeps } from "./filler-follow-up.js";
import type { ProjectServices } from "./project-services.js";

const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function domainId(prefix: IdPrefix | "seg" | "spk"): string {
  if (prefix === "seg") return "seg_aaaaaaaaaa";
  if (prefix === "spk") return "spk_aaaaaaaaaa";
  return makeId(prefix);
}

async function transcribedProject(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-filler-follow-up-"));
  roots.push(root);
  const model = projectFixture();
  model.assets[0]!.kind = "audio";
  model.assets[0]!.probe = {
    duration: { samples: 960_000, rate: 48_000 },
    audio: { rate: 48_000, channels: 1 },
  };
  delete model.assets[0]!.video;
  model.assets[0]!.audio = [{
    index: 0,
    codec: "pcm_s16le",
    sampleRate: 48_000,
    channels: 1,
    layout: "mono",
  }];
  model.sequences[0]!.clips = [{
    id: "clp_aaaaaaaaaa",
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: 0, fps: "24/1" },
      out: { frames: 480, fps: "24/1" },
    },
  }];
  model.skills = [];
  model.sidecars[0]!.inputs = [];
  model.sidecars[0]!.sha256 = createHash("sha256").update(EMPTY_ANNOTATIONS).digest("hex");
  const store = valueOf(await createProject(root, model));
  await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");
  const transcript = new TranscriptEngine({
    idFactory: domainId,
    now: () => new Date("2026-07-19T00:00:00Z"),
  });
  const word = (text: string, start: number, end: number) => ({
    text,
    start: { samples: start, rate: 48_000 },
    end: { samples: end, rate: 48_000 },
    probability: 1,
  });
  valueOf(await transcript.createFromTranscription(store, "ast_aaaaaaaaaa", {
    language: "en",
    languageProbability: 1,
    jobId: "job_aaaaaaaaaa",
    engine: { name: "test", version: "1", model: "fixture" },
    segments: [{
      index: 0,
      start: { samples: 0, rate: 48_000 },
      end: { samples: 960_000, rate: 48_000 },
      text: "one two three",
      avgLogprob: 0,
      noSpeechProb: 0,
      words: [
        word("one", 24_000, 48_000),
        word("two", 120_000, 139_200),
        word("three", 192_000, 216_000),
      ],
    }],
  }));
  return store;
}

function harness(store: ProjectStore) {
  const publish = vi.fn();
  const deps: FillerFollowUpDeps = {
    appVersion: "0.0.0-test",
    auditSink: { record: vi.fn() } as unknown as AuditSink,
    publish,
  };
  const annotations = new AnnotationService({ appVersion: "0.0.0-test" });
  const project = { store, templates: undefined, annotations } as unknown as ProjectServices;
  return { deps, project, publish };
}

function job(payload: JsonValue): JobRecord {
  return { kind: "assist.fillers.detect", state: "done", payload } as unknown as JobRecord;
}

const PAUSE = {
  id: "fil_pause00001",
  kind: "pause",
  sourceRange: {
    assetId: "ast_aaaaaaaaaa",
    start: { samples: 140_000, rate: 48_000 },
    end: { samples: 190_000, rate: 48_000 },
  },
  rule: "pause.removable",
  evidence: "Silence between two and three.",
  warnings: [],
  defaultSelected: true,
};

describe("createFillerProposal", () => {
  it("does nothing when detection found no candidates", async () => {
    const store = await transcribedProject();
    const { deps, project, publish } = harness(store);
    await createFillerProposal(deps, project, job({ candidates: [], reviewWindows: [] }));
    expect(publish).not.toHaveBeenCalled();
    const proposalDirs = await readdir(join(store.root, "proposals")).catch(() => []);
    expect(proposalDirs).toEqual([]);
  });

  it("writes one proposal and publishes proposal.updated for a candidate", async () => {
    const store = await transcribedProject();
    const { deps, project, publish } = harness(store);
    await createFillerProposal(deps, project, job({
      candidates: [PAUSE],
      reviewWindows: [],
    } as unknown as JsonValue));
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0] as { kind: string; proposalId: string };
    expect(event.kind).toBe("proposal.updated");
    const proposal = valueOf(await store.readProposal(event.proposalId));
    expect(proposal.status).toBe("ready");
    expect(proposal.operations.length).toBeGreaterThan(0);
  });

  it("throws on a malformed detection payload", async () => {
    const store = await transcribedProject();
    const { deps, project, publish } = harness(store);
    await expect(createFillerProposal(deps, project, job({ nope: true })))
      .rejects.toThrow("assist.fillers.detect result is invalid");
    expect(publish).not.toHaveBeenCalled();
  });

  it("scoped results commit review markers before the proposal so it accepts cleanly", async () => {
    const store = await transcribedProject();
    const { deps, project, publish } = harness(store);
    const reviewed = {
      id: "fil_review0001",
      kind: "filler",
      wordRange: { fromWord: "w000001", toWord: "w000001" },
      sourceRange: {
        assetId: "ast_aaaaaaaaaa",
        start: { samples: 24_000, rate: 48_000 },
        end: { samples: 48_000, rate: 48_000 },
      },
      rule: "filler.review",
      evidence: "Possible filler: one.",
      warnings: [],
      defaultSelected: false,
      reviewRequired: true,
    };
    await createFillerProposal(deps, project, job({
      candidates: [reviewed, PAUSE],
      reviewWindows: [],
      scope: {
        assemblySessionId: "asb_aaaaaaaaaa",
        keptRanges: [{
          assetId: "ast_aaaaaaaaaa",
          start: { samples: 0, rate: 48_000 },
          end: { samples: 960_000, rate: 48_000 },
        }],
      },
    } as unknown as JsonValue));
    const event = publish.mock.calls[0]![0] as { proposalId: string };
    const proposal = valueOf(await store.readProposal(event.proposalId));
    // The filler is never cut in a scoped (gentle) run; the pause is.
    expect(proposal.operations.some(({ op }) => op === "transcript.range.remove")).toBe(false);
    expect(proposal.operations.some(({ op }) => op.startsWith("clip."))).toBe(true);
    // Not stale: nothing was committed between creation and acceptance.
    expect(proposal.baseRevision).toBe(store.currentProject.revision);
    const annotations = project.annotations;
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-test",
      committer: { commit: (model, transaction) => annotations.commitAccepted(store, model, transaction) },
      proposalStore: store,
      auditSink: deps.auditSink,
    });
    valueOf(await engine.acceptProposal(proposal.id, "creator"));
    const after = parseAnnotationSidecar(await readFile(join(store.root, "sidecars/annotations.yaml"), "utf8"));
    expect(after.annotations).toHaveLength(1);
    expect(after.annotations[0]).toMatchObject({
      author: { kind: "agent" },
      body: "review: Possible filler: one.",
      anchor: { kind: "word", wordId: "w000001" },
    });
  });

  it("scoped results never select fillers but keep pauses and repeats", async () => {
    const store = await transcribedProject();
    const { deps, project, publish } = harness(store);
    const filler = {
      id: "fil_filler0001",
      kind: "filler",
      wordRange: { fromWord: "w000001", toWord: "w000001" },
      sourceRange: {
        assetId: "ast_aaaaaaaaaa",
        start: { samples: 24_000, rate: 48_000 },
        end: { samples: 48_000, rate: 48_000 },
      },
      rule: "filler.um",
      evidence: "Filler: one.",
      warnings: [],
      defaultSelected: false,
    };
    const repeat = {
      ...filler,
      id: "fil_repeat0001",
      kind: "repeat",
      wordRange: { fromWord: "w000002", toWord: "w000002" },
      sourceRange: {
        assetId: "ast_aaaaaaaaaa",
        start: { samples: 120_000, rate: 48_000 },
        end: { samples: 139_200, rate: 48_000 },
      },
      rule: "repeat.word",
      evidence: "Repeat: two.",
    };
    await createFillerProposal(deps, project, job({
      candidates: [PAUSE, filler, repeat],
      reviewWindows: [],
      scope: {
        assemblySessionId: "asb_aaaaaaaaaa",
        keptRanges: [{
          assetId: "ast_aaaaaaaaaa",
          start: { samples: 0, rate: 48_000 },
          end: { samples: 960_000, rate: 48_000 },
        }],
      },
    } as unknown as JsonValue));
    const event = publish.mock.calls[0]![0] as { proposalId: string };
    const proposal = valueOf(await store.readProposal(event.proposalId));
    const removed = proposal.operations
      .filter(({ op }) => op === "transcript.range.remove")
      .map(({ params }) => (params["wordRange"] as { fromWord: string }).fromWord);
    expect(removed).toEqual(["w000002"]);
    expect(proposal.operations.some(({ op }) => op.startsWith("clip."))).toBe(true);
  });
});

describe("withinKeptRanges", () => {
  const candidate = (assetId: string, start: number, end: number) => ({
    sourceRange: { assetId, start: { samples: start, rate: 48_000 }, end: { samples: end, rate: 48_000 } },
  }) as FillerCandidate;
  const scope = {
    assemblySessionId: "asb_aaaaaaaaaa",
    keptRanges: [{
      assetId: "ast_aaaaaaaaaa",
      start: { samples: 1_000, rate: 24_000 },
      end: { samples: 2_000, rate: 24_000 },
    }],
  };

  it("accepts inside and rejects outside and other assets", () => {
    expect(withinKeptRanges(candidate("ast_aaaaaaaaaa", 3_000, 4_000), undefined)).toBe(true);
    // 1000/24000 s = 2000/48000 s; sample rates differ, comparison is in seconds.
    expect(withinKeptRanges(candidate("ast_aaaaaaaaaa", 2_000, 4_000), scope)).toBe(true);
    expect(withinKeptRanges(candidate("ast_aaaaaaaaaa", 1_999, 4_000), scope)).toBe(false);
    expect(withinKeptRanges(candidate("ast_aaaaaaaaaa", 2_000, 4_001), scope)).toBe(false);
    expect(withinKeptRanges(candidate("ast_bbbbbbbbbb", 2_000, 4_000), scope)).toBe(false);
  });
});
