import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OperationEngine,
  createProject,
} from "../../../core/src/index.js";
import type {
  ProjectStore,
  Result,
} from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { motionPresetPin } from "../../../compositor/src/index.js";
import {
  DEFAULT_CAPTION_STYLE,
  serializeCaptionPreset,
} from "../../../transcript/src/index.js";
import { SkillRegistry } from "./registry.js";

const SKILL_ID = "skl_aaaaaaaaaa";
const CAPTION_PRESET_ID = "pre_aaaaaaaaaa";
const MOTION_PRESET_ID = "pre_pipsmoothm";
const LOOK_PRESET_ID = "pre_cccccccccc";
const EMPTY_ANNOTATIONS = "format: guyditor.annotations/v1\nannotations: []\n";

async function valueOf<Value>(result: Promise<Result<Value>> | Result<Value>): Promise<Value> {
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return settled.value;
}

async function skillSource(
  root: string,
  version: string,
  ruleText = "Allow annotation.resolve and caption.style.set.",
): Promise<string> {
  const directory = join(root, `skill-${version}`);
  await mkdir(join(directory, "examples"), { recursive: true });
  await writeFile(join(directory, "SKILL.md"), [
    "# Editorial pacing",
    "",
    `Use caption preset ${CAPTION_PRESET_ID}@1.`,
    `Use motion preset ${MOTION_PRESET_ID}@1.`,
    `Use look preset ${LOOK_PRESET_ID}@3.`,
    "",
  ].join("\n"), "utf8");
  await writeFile(join(directory, "skill.yaml"), [
    "format: guyditor-skill/v1",
    `id: ${SKILL_ID}`,
    "name: editorial-pacing",
    `version: ${version}`,
    "title: Editorial pacing",
    "categories: [pacing, subtitle_style, motion_transitions]",
    "summary: Reusable editorial decisions.",
    "rules:",
    "  - id: rule_allowed_ops",
    "    category: pacing",
    "    strength: must",
    `    text: ${ruleText}`,
    "  - id: rule_no_color_auto",
    "    category: brand_visual",
    "    strength: avoid",
    "    text: Do not auto-accept clip.color.set.",
    "examples: { approved: [], rejected: [] }",
    "body: SKILL.md",
    "",
  ].join("\n"), "utf8");
  return directory;
}

async function projectAt(root: string, withMotion = true): Promise<ProjectStore> {
  const model = projectFixture();
  model.sidecars[0]!.sha256 = createHash("sha256").update(EMPTY_ANNOTATIONS).digest("hex");
  model.sidecars[0]!.inputs = [];
  model.skills = [];
  const caption = serializeCaptionPreset({
    format: "guyditor.caption-preset/v1",
    presetId: CAPTION_PRESET_ID,
    name: "captions",
    version: 1,
    style: DEFAULT_CAPTION_STYLE,
  });
  await mkdir(join(root, "presets"), { recursive: true });
  await writeFile(join(root, `presets/${CAPTION_PRESET_ID}@1.yaml`), caption, "utf8");
  model.presets = [{
    id: CAPTION_PRESET_ID,
    name: "captions",
    kind: "caption",
    version: 1,
    path: `presets/${CAPTION_PRESET_ID}@1.yaml`,
    sha256: createHash("sha256").update(caption).digest("hex"),
  }, ...(withMotion ? [motionPresetPin(MOTION_PRESET_ID)] : []), {
    id: LOOK_PRESET_ID,
    name: "Warm documentary",
    kind: "look",
    version: 3,
    path: "builtin:look-warm-documentary@3",
    sha256: "c".repeat(64),
  }];
  const store = await valueOf(createProject(root, model, { appVersion: "0.0.0-test" }));
  await writeFile(join(root, "sidecars/annotations.yaml"), EMPTY_ANNOTATIONS, "utf8");
  return store;
}

describe("SkillRegistry project pinning and controlled evolution", () => {
  it("snapshots on association, verifies full pinned content, and upgrades only by a journaled skill.pin.set", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skill-pin-"));
    const registry = new SkillRegistry({ globalRoot: join(root, "global") });
    await registry.publish(await skillSource(root, "1.0.0"));
    const store = await projectAt(join(root, "project"));

    const associated = await registry.associateProject(store, SKILL_ID, "1.0.0", {
      appVersion: "0.0.0-test",
      actorId: "creator",
    });

    expect(associated.pin).toMatchObject({
      id: SKILL_ID,
      name: "editorial-pacing",
      version: "1.0.0",
      path: "skills/editorial-pacing/1.0.0/",
    });
    expect(store.currentProject.skills).toEqual([associated.pin]);
    expect((await registry.pinned(store))[0]).toMatchObject({
      manifest: expect.objectContaining({ version: "1.0.0" }),
      body: expect.stringContaining("caption preset"),
      presetReferences: [
        { id: CAPTION_PRESET_ID, version: 1 },
        { id: LOOK_PRESET_ID, version: 3 },
        { id: MOTION_PRESET_ID, version: 1 },
      ],
    });
    expect(await readFile(join(
      store.root,
      "skills/editorial-pacing/1.0.0/SKILL.md",
    ), "utf8")).toContain("Editorial pacing");

    const journalAfterV1 = await readFile(join(store.root, "history/transactions.jsonl"), "utf8");
    expect(journalAfterV1).toContain('"op":"skill.pin.set"');
    expect(journalAfterV1).toContain('"version":"1.0.0"');
    const revisionAfterV1 = store.currentProject.revision;

    await registry.publish(await skillSource(root, "2.0.0", "Allow only annotation.resolve."));
    expect(store.currentProject.revision).toBe(revisionAfterV1);
    expect(store.currentProject.skills[0]!.version).toBe("1.0.0");
    expect((await registry.pinned(store))[0]!.manifest.version).toBe("1.0.0");
    expect(await readFile(join(store.root, "history/transactions.jsonl"), "utf8"))
      .toBe(journalAfterV1);

    const upgraded = await registry.upgradeProject(store, SKILL_ID, "2.0.0", {
      appVersion: "0.0.0-test",
      actorId: "creator",
    });
    expect(upgraded.pin.version).toBe("2.0.0");
    expect(store.currentProject.revision).not.toBe(revisionAfterV1);
    expect((await registry.pinned(store))[0]!.manifest.version).toBe("2.0.0");
    const journal = await readFile(join(store.root, "history/transactions.jsonl"), "utf8");
    const pinTransactions = journal.trim().split("\n").map((line) => JSON.parse(line) as {
      operations: Array<{ op: string }>;
    }).flatMap(({ operations }) => operations).filter(({ op }) => op === "skill.pin.set");
    expect(pinTransactions).toHaveLength(2);
  });

  it("raises E_SKILL_HASH before returning a corrupted pinned skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skill-hash-"));
    const registry = new SkillRegistry({ globalRoot: join(root, "global") });
    await registry.publish(await skillSource(root, "1.0.0"));
    const store = await projectAt(join(root, "project"));
    await registry.associateProject(store, SKILL_ID, "1.0.0");
    await writeFile(
      join(store.root, "skills/editorial-pacing/1.0.0/SKILL.md"),
      "corrupted\n",
      "utf8",
    );

    await expect(registry.pinned(store)).rejects.toMatchObject({
      code: "E_SKILL_HASH",
      affected: [SKILL_ID],
    });
  });

  it("resolves preset references and derives an inspectable low-risk automation allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skill-policy-"));
    const registry = new SkillRegistry({ globalRoot: join(root, "global") });
    await registry.publish(await skillSource(root, "1.0.0"));
    const store = await projectAt(join(root, "project"));
    await registry.associateProject(store, SKILL_ID, "1.0.0");
    const active = await registry.pinned(store);

    expect(registry.resolveAutomationPolicy({
      enabled: true,
      maxRisk: "low",
      allowedOperations: ["annotation.resolve", "caption.style.set", "clip.color.set"],
      maxOpsPerProposal: 5,
      maxAutoAcceptsPerSession: 10,
      notify: "toast",
    }, active)).toEqual({
      enabled: true,
      maxRisk: "low",
      allowedOperations: ["annotation.resolve", "caption.style.set"],
      maxOpsPerProposal: 5,
      maxAutoAcceptsPerSession: 10,
      notify: "toast",
    });
    expect(registry.resolveAutomationPolicy({
      enabled: true,
      maxRisk: "low",
      allowedOperations: [],
      maxOpsPerProposal: 5,
      maxAutoAcceptsPerSession: 10,
      notify: "toast",
    }, active).allowedOperations).toEqual(["annotation.resolve", "caption.style.set"]);

    const missingPresetStore = await projectAt(join(root, "missing-preset"), false);
    const revisionBefore = missingPresetStore.currentProject.revision;
    await expect(registry.associateProject(missingPresetStore, SKILL_ID, "1.0.0"))
      .rejects.toMatchObject({
      code: "E_SKILL_PRESET",
      affected: [SKILL_ID, MOTION_PRESET_ID],
    });
    expect(missingPresetStore.currentProject.revision).toBe(revisionBefore);
    expect(missingPresetStore.currentProject.skills).toEqual([]);

    const fabricatedMotionStore = await projectAt(join(root, "fabricated-motion"));
    fabricatedMotionStore.currentProject.presets = fabricatedMotionStore.currentProject.presets.map((pin) =>
      pin.kind === "motion" ? { ...pin, path: "builtin:pip-imaginary@1" } : pin);
    await expect(registry.associateProject(fabricatedMotionStore, SKILL_ID, "1.0.0"))
      .rejects.toMatchObject({ code: "E_SKILL_PRESET", affected: [SKILL_ID, MOTION_PRESET_ID] });

    const fabricatedLookStore = await projectAt(join(root, "fabricated-look"));
    fabricatedLookStore.currentProject.presets = fabricatedLookStore.currentProject.presets.map((pin) =>
      pin.kind === "look" ? { ...pin, path: "builtin:look-imaginary@3" } : pin);
    await expect(registry.associateProject(fabricatedLookStore, SKILL_ID, "1.0.0"))
      .rejects.toMatchObject({ code: "E_SKILL_PRESET", affected: [SKILL_ID, LOOK_PRESET_ID] });
  });
});

describe("SkillRegistry explicit preference examples", () => {
  it("captures accepted and rejected proposal diffs as separate draft versions without changing the pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skill-example-"));
    const exampleIds = ["ex_approved", "ex_rejected"];
    const registry = new SkillRegistry({
      globalRoot: join(root, "global"),
      exampleIdFactory: () => exampleIds.shift() ?? "ex_fallback",
      now: () => new Date("2026-07-22T10:00:00.000Z"),
    });
    await registry.publish(await skillSource(root, "1.0.0"));
    const store = await projectAt(join(root, "project"));
    await registry.associateProject(store, SKILL_ID, "1.0.0");

    const acceptedEngine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-test",
      committer: store,
      proposalStore: store,
      idFactory: (prefix) => `${prefix}_cccccccccc`,
    });
    const acceptedProposal = await valueOf(acceptedEngine.createProposal({
      operations: [{
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: -1, fps: "24/1" },
          snapPolicy: "none",
        },
      }],
      instruction: { kind: "user-text", text: "Tighten this beat" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa" },
      reason: { text: "The ending drags.", sources: [{ kind: "skill-rule", ref: "rule_allowed_ops" }] },
      addresses: [],
    }));
    await valueOf(acceptedEngine.acceptProposal(acceptedProposal.id, "creator"));
    const acceptedDraft = await registry.captureExample({
      project: store,
      proposalId: acceptedProposal.id,
      skillId: SKILL_ID,
      decision: "approved",
      description: "Tighter ending accepted.",
    });

    const rejectedEngine = new OperationEngine(store.currentProject, {
      appVersion: "0.0.0-test",
      committer: store,
      proposalStore: store,
      idFactory: (prefix) => `${prefix}_dddddddddd`,
    });
    const rejectedProposal = await valueOf(rejectedEngine.createProposal({
      operations: [{
        op: "clip.trim",
        params: {
          clipId: "clp_bbbbbbbbbb",
          edge: "head",
          delta: { frames: 1, fps: "24/1" },
          snapPolicy: "none",
        },
      }],
      instruction: { kind: "user-text", text: "Try a faster entrance" },
      actor: { kind: "agent", id: "ses_aaaaaaaaaa" },
      reason: {
        text: "Test a more abrupt cut.",
        sources: [{ kind: "instruction", ref: "Try a faster entrance" }],
      },
      addresses: [],
    }));
    await valueOf(rejectedEngine.rejectProposal(rejectedProposal.id, "creator"));
    const rejectedDraft = await registry.captureExample({
      project: store,
      proposalId: rejectedProposal.id,
      skillId: SKILL_ID,
      decision: "rejected",
      description: "Entrance felt too abrupt.",
    });

    expect(acceptedDraft.manifest.version).toBe("1.0.1");
    expect(acceptedDraft.manifest.examples.approved.at(-1)).toMatchObject({
      id: "ex_approved",
      description: "Tighter ending accepted.",
      provenance: { projectId: store.currentProject.project.id },
    });
    expect(rejectedDraft.manifest.version).toBe("1.0.2");
    expect(rejectedDraft.manifest.examples.rejected.at(-1)).toMatchObject({
      id: "ex_rejected",
      description: "Entrance felt too abrupt.",
    });
    expect(rejectedDraft.manifest.examples.approved).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ex_approved" }),
    ]));
    expect(rejectedDraft.exampleContents?.rejected.at(-1)?.payload).toMatchObject({
      format: "guyditor.skill-example/v1",
      decision: "rejected",
      proposalId: rejectedProposal.id,
      semanticDiff: expect.objectContaining({ entries: expect.any(Array) }),
    });
    expect(store.currentProject.skills[0]!.version).toBe("1.0.0");
    expect(await registry.versions(SKILL_ID)).toEqual(["1.0.0"]);

    const artifact = acceptedDraft.manifest.examples.approved.at(-1)!.media!;
    const payload = JSON.parse(await readFile(join(
      registry.globalRoot,
      ".drafts/editorial-pacing/1.0.1",
      artifact.path,
    ), "utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      format: "guyditor.skill-example/v1",
      decision: "approved",
      proposalId: acceptedProposal.id,
      context: expect.objectContaining({
        projectId: store.currentProject.project.id,
        instruction: expect.objectContaining({ text: "Tighten this beat" }),
      }),
    });
    expect(payload["semanticDiff"]).toEqual(expect.objectContaining({
      entries: expect.any(Array),
    }));

    await registry.publishDraft(SKILL_ID, "1.0.2");
    await registry.upgradeProject(store, SKILL_ID, "1.0.2");
    const active = (await registry.pinned(store))[0]!;
    expect(active.manifest.examples.approved).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ex_approved" }),
    ]));
    expect(active.manifest.examples.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ex_rejected" }),
    ]));
    expect(active.exampleContents?.approved[0]?.payload).toMatchObject({
      decision: "approved",
      proposalId: acceptedProposal.id,
    });
  });
});
