import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectStore } from "../../core/src/index.js";
import { projectFixture } from "../../core/src/project/test-fixtures.js";
import { AssessmentStore } from "./assessment-store.js";
import type { ResolvedSkill } from "./skills/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AssessmentStore", () => {
  it("persists resolvable assessment evidence and verifies pinned rubric references", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-assessment-"));
    roots.push(root);
    const project = new ProjectStore(root, projectFixture(), { appVersion: "test" });
    const skill = {
      manifest: {
        id: "skl_aaaaaaaaaa",
        name: "retention",
        version: "1.0.0",
        title: "Retention",
        categories: ["hooks_retention"],
        summary: "Keep promises legible.",
        rules: [{ id: "promise", category: "hooks_retention", strength: "prefer", text: "Make the promise legible." }],
        examples: { approved: [], rejected: [] },
        contentHash: "a".repeat(64),
      },
      body: "# Retention",
      presetReferences: [],
    } satisfies ResolvedSkill;
    const store = new AssessmentStore({ projectRoot: root, project, skills: [skill] });
    const assessment = {
      assessmentId: "asm_aaaaaaaaaa",
      framing: "recommendation",
      question: "Does this hook establish the promise?",
      criteria: [{
        id: "promise",
        source: "skill_rule",
        skillId: skill.manifest.id,
        ruleId: "promise",
        text: "Make the promise legible.",
      }],
      subjects: [{
        ref: { assetId: "ast_aaaaaaaaaa" },
        observations: [{
          id: "obs-1",
          text: "The result appears after the opening sentence.",
          evidence: [{ assetId: "ast_aaaaaaaaaa", sourceRange: { start: { frames: 0, fps: "30/1" }, durFrames: 60 } }],
        }],
        inferences: [{ text: "The promise may feel delayed.", basedOn: ["obs-1"], confidence: "medium" }],
        scores: [{ criterionId: "promise", value: 3, scale: "1-5" }],
      }],
      limitations: "No audience-retention data is available.",
    } as const;

    await expect(store.submit(assessment)).resolves.toMatchObject({ assessmentId: "asm_aaaaaaaaaa" });
    await expect(store.get("asm_aaaaaaaaaa")).resolves.toEqual(assessment);
  });
});
