import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OperationEngine,
  createProject,
  formatRevision,
} from "./index.js";
import type {
  GuyditorProject,
  IdPrefix,
  ProjectStore,
  Result,
  TransactionRecord,
} from "./index.js";
import { projectFixture } from "./project/test-fixtures.js";

const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true }),
  ));
});

function body(ordinal: number): string {
  let value = ordinal;
  let result = "";
  for (let index = 0; index < 10; index += 1) {
    result = `${BASE32[value % BASE32.length]}${result}`;
    value = Math.floor(value / BASE32.length);
  }
  return result;
}

function id(prefix: string, ordinal: number): string {
  return `${prefix}_${body(ordinal)}`;
}

function fortyClipProject(): GuyditorProject {
  const project = projectFixture();
  project.project.name = "AC-002 40 clips";
  project.assets[0]!.probe.duration = { frames: 1_000, fps: "24/1" };
  project.sequences[0]!.clips = Array.from({ length: 40 }, (_, index) => ({
    id: id("clp", index + 1),
    asset: "ast_aaaaaaaaaa",
    source: {
      in: { frames: index * 10, fps: "24/1" },
      out: { frames: index * 10 + 8, fps: "24/1" },
    },
  }));
  project.sidecars[0]!.inputs = [];
  project.sidecars[0]!.sha256 = createHash("sha256")
    .update(EMPTY_ANNOTATIONS)
    .digest("hex");
  return project;
}

function idFactory(): (prefix: IdPrefix) => string {
  let ordinal = 100;
  return (prefix) => id(prefix, ordinal++);
}

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

interface ChangedLine {
  kind: "added" | "removed";
  line: string;
  index: number;
}

function changedLines(beforeText: string, afterText: string): ChangedLine[] {
  const before = beforeText.trimEnd().split("\n");
  const after = afterText.trimEnd().split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () =>
    new Uint16Array(after.length + 1));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] = before[left] === after[right]
        ? lengths[left + 1]![right + 1]! + 1
        : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!);
    }
  }
  const changes: ChangedLine[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      left += 1;
      right += 1;
    } else if (
      right < after.length &&
      (left === before.length || lengths[left]![right + 1]! >= lengths[left + 1]![right]!)
    ) {
      changes.push({ kind: "added", line: after[right]!, index: right });
      right += 1;
    } else {
      changes.push({ kind: "removed", line: before[left]!, index: left });
      left += 1;
    }
  }
  return changes;
}

function lineOwners(text: string): Array<string | undefined> {
  const lines = text.trimEnd().split("\n");
  const owners: Array<string | undefined> = Array.from({ length: lines.length });
  let owner: string | undefined;
  let ownerIndent = Number.POSITIVE_INFINITY;
  for (const [index, line] of lines.entries()) {
    const indentation = /^\s*/u.exec(line)?.[0].length ?? 0;
    if (line.trim() !== "" && indentation < ownerIndent) owner = undefined;
    const match = /\bid: ((?:clp|cts|dlv)_[a-z2-7]{10})\b/u.exec(line);
    if (match !== null) {
      owner = match[1];
      ownerIndent = indentation;
      if (index > 0 && lines[index - 1]?.trim() === "-") owners[index - 1] = owner;
    }
    owners[index] = owner;
  }
  return owners;
}

function changedEntityIds(
  beforeText: string,
  afterText: string,
  changes: readonly ChangedLine[],
): string[] {
  const beforeOwners = lineOwners(beforeText);
  const afterOwners = lineOwners(afterText);
  return [...new Set(changes.flatMap((change) => {
    const owner = change.kind === "added"
      ? afterOwners[change.index]
      : beforeOwners[change.index];
    return owner === undefined ? [] : [owner];
  }))];
}

function transaction(
  store: ProjectStore,
  resultRevision: string,
  operation: TransactionRecord["operations"][number],
  ordinal: number,
): TransactionRecord {
  return {
    id: id("txn", 500 + ordinal),
    baseRevision: store.currentProject.revision,
    resultRevision,
    operations: [operation],
    instruction: { kind: "ui-direct" },
    actor: { kind: "human", id: "ac002" },
    versions: {
      app: "0.0.0-test",
      schema: "guyditor/v1",
      skills: [],
      presets: [],
      tools: [],
    },
    acceptance: {
      status: "accepted",
      by: "ac002",
      at: `2026-07-19T09:${String(ordinal).padStart(2, "0")}:00.000Z`,
    },
    orphanedAnchors: [],
    addresses: [],
  };
}

describe("AC-002 — inspect every accepted edit", () => {
  it("keeps every consecutive snapshot entity-local and the 40-clip move within 12 lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-ac002-"));
    roots.push(root);
    const ids = idFactory();
    const store = await valueOf(createProject(root, fortyClipProject(), {
      appVersion: "0.0.0-test",
      idFactory: ids,
      now: () => new Date("2026-07-19T09:00:00.000Z"),
    }));
    await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");
    const engine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-test",
      committer: store,
      idFactory: ids,
      now: () => new Date("2026-07-19T09:01:00.000Z"),
    });

    for (let index = 0; index < 9; index += 1) {
      await valueOf(engine.execute([{
        op: "clip.trim",
        params: {
          clipId: id("clp", index + 1),
          edge: index % 2 === 0 ? "tail" : "head",
          delta: { frames: 1, fps: "24/1" },
        },
      }], {
        baseRevision: engine.currentProject.revision,
        dryRun: false,
        origin: "ui",
      }));
    }
    await valueOf(engine.execute([{
      op: "clip.move",
      params: { clipId: id("clp", 40), toIndex: 1 },
    }], {
      baseRevision: engine.currentProject.revision,
      dryRun: false,
      origin: "ui",
    }));

    const captionModel = structuredClone(store.currentProject);
    captionModel.revision = "rev_00012";
    captionModel.captions[0]!.styleOverrides = {
      color: "#F2B84BFF",
      sizePct: 5.9,
    };
    await valueOf(store.commit(captionModel, transaction(store, captionModel.revision, {
      op: "caption.style.set",
      params: { captionId: "cts_aaaaaaaaaa", color: "#F2B84BFF", sizePct: 5.9 },
      summary: "Set captions style to 5.9 percent warm gold",
    }, 11)));

    const deliverableModel = structuredClone(store.currentProject);
    deliverableModel.revision = "rev_00013";
    deliverableModel.deliverables.push({
      id: "dlv_bbbbbbbbbb",
      kind: "short",
      name: "AC-002 derivative",
      profile: "youtube-shorts@1.0.0",
      sequenceId: "seq_aaaaaaaaaa",
      status: "draft",
      dependencies: [{ deliverableId: "dlv_aaaaaaaaaa", revision: "rev_00012" }],
    });
    await valueOf(store.commit(deliverableModel, transaction(store, deliverableModel.revision, {
      op: "deliverable.derive",
      params: { sourceDeliverableId: "dlv_aaaaaaaaaa", deliverableId: "dlv_bbbbbbbbbb" },
      summary: "Derive AC-002 short from the primary deliverable",
    }, 12)));

    await expect(readFile(join(root, "history/revisions/rev_00001.yaml"), "utf8"))
      .resolves.toContain("revision: rev_00001");
    await expect(readFile(join(root, "history/revisions/rev_00013.yaml"), "utf8"))
      .resolves.toContain("revision: rev_00013");

    for (let revision = 2; revision <= 13; revision += 1) {
      const beforeText = await readFile(join(
        root,
        "history/revisions",
        `${formatRevision(revision - 1)}.yaml`,
      ), "utf8");
      const afterText = await readFile(join(
        root,
        "history/revisions",
        `${formatRevision(revision)}.yaml`,
      ), "utf8");
      const changes = changedLines(beforeText, afterText);
      const expectedEntity = revision <= 10
        ? id("clp", revision - 1)
        : revision === 11
          ? id("clp", 40)
          : revision === 12
            ? "cts_aaaaaaaaaa"
            : "dlv_bbbbbbbbbb";
      expect(changedEntityIds(beforeText, afterText, changes), formatRevision(revision))
        .toEqual([expectedEntity]);
      if (revision === 11) {
        expect(changes.filter(({ line }) => !/^revision:/u.test(line)).length).toBeLessThanOrEqual(12);
        expect(changedEntityIds(beforeText, afterText, changes))
          .not.toContain(id("clp", 1));
      }
    }

    const journalPath = join(root, "history/transactions.jsonl");
    const journalText = await readFile(journalPath, "utf8");
    const journal = journalText.trim().split("\n")
      .map((line) => JSON.parse(line) as TransactionRecord);
    expect(journal).toHaveLength(13);
    for (const record of journal.slice(1)) {
      expect(record.operations).toHaveLength(1);
      expect(record.operations[0]!.summary).toMatch(/\S+ \S+/u);
      expect(record.operations[0]!.summary).not.toMatch(/^Pending /u);
    }

    const jq = spawnSync("jq", ["-c", ".", journalPath], {
      encoding: "utf8",
      shell: false,
    });
    if (jq.error !== undefined && "code" in jq.error && jq.error.code === "ENOENT") {
      console.warn("AC-002 jq assertion skipped: jq is not installed.");
    } else {
      expect(jq.status, jq.stderr).toBe(0);
      expect(jq.stdout.trim().split("\n")).toHaveLength(13);
    }
  });
});
