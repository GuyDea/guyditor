import { describe, expect, it } from "vitest";

import {
  OperationEngine,
} from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { createTranscriptWorkspace } from "../operations.js";

describe("caption semantic operations", () => {
  it("adds and sparsely updates tracks with reversible word-anchored overrides", async () => {
    const project = projectFixture();
    const workspace = createTranscriptWorkspace([], [], (prefix) => `${prefix}_bbbbbbbbbb`);
    const engine = new OperationEngine(project, {
      idFactory: (prefix) => `${prefix}_bbbbbbbbbb`,
      operationDispatcher: workspace.dispatcher,
    });

    const result = await engine.execute([
      {
        op: "caption.track.add",
        params: {
          name: "Second captions",
          sourceLayerIds: ["lyr_aaaaaaaaaa"],
          preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
          enabled: true,
        },
      },
      {
        op: "caption.style.set",
        params: { captionId: "cts_bbbbbbbbbb", styleOverrides: { color: "#F2B84BFF", wordsPerLine: 3 } },
      },
      {
        op: "caption.break.set",
        params: { captionId: "cts_bbbbbbbbbb", afterWordId: "w000001", kind: "line" },
      },
      {
        op: "caption.word.emphasis.set",
        params: { captionId: "cts_bbbbbbbbbb", wordId: "w000001", emphasis: true },
      },
      {
        op: "caption.cue.retime",
        params: { captionId: "cts_bbbbbbbbbb", firstWordId: "w000001", startMs: -25, endMs: 40 },
      },
    ], { baseRevision: project.revision, origin: "ui", dryRun: true });

    expect(result.ok).toBe(true);
    expect(engine.currentProject.captions).toHaveLength(1);
    if (!result.ok) return;
    expect(result.value.applied.map(({ op }) => op)).toEqual([
      "caption.track.add",
      "caption.style.set",
      "caption.break.set",
      "caption.word.emphasis.set",
      "caption.cue.retime",
    ]);
    expect(result.value.applied.at(-1)?.inverse).toEqual([{
      op: "caption.cue.retime",
      params: { captionId: "cts_bbbbbbbbbb", firstWordId: "w000001", clear: true },
    }]);
    const changed = result.value.diff.entries.find(({ entityId }) => entityId === "cts_bbbbbbbbbb");
    expect(changed).toBeDefined();
  });

  it("upgrades only the selected track's pinned preset version at normal risk", async () => {
    const project = projectFixture();
    project.presets.push({
      id: "pre_bbbbbbbbbb",
      name: "captions v2",
      kind: "caption",
      version: 2,
      path: "presets/pre_bbbbbbbbbb@2.yaml",
      sha256: "b".repeat(64),
    });
    const workspace = createTranscriptWorkspace([], [], (prefix) => `${prefix}_bbbbbbbbbb`);
    const engine = new OperationEngine(project, { operationDispatcher: workspace.dispatcher });
    const result = await engine.execute([{
      op: "caption.preset.upgrade",
      params: {
        captionId: "cts_aaaaaaaaaa",
        preset: { presetId: "pre_bbbbbbbbbb", version: 2 },
      },
    }], { baseRevision: project.revision, origin: "ui", dryRun: true });

    expect(result).toMatchObject({ ok: true, value: { riskClass: "normal" } });
  });
});
