import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject, makeId } from "../../../core/src/index.js";
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

import { createFillerProposal } from "./filler-follow-up.js";
import type { FillerFollowUpDeps } from "./filler-follow-up.js";
import type { ProjectServices } from "./project-services.js";

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
  const store = valueOf(await createProject(root, model));
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
  const project = { store, templates: undefined } as unknown as ProjectServices;
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
});
