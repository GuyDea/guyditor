import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import {
  DEFAULT_CAPTION_STYLE,
  serializeCaptionPreset,
} from "../../../transcript/src/index.js";
import { SkillRegistry } from "./registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SkillRegistry preference packs", () => {
  it("copies exact preset and skill versions into a fresh project without editing its revision", async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), "guyditor-pack-global-"));
    const rootA = await mkdtemp(join(tmpdir(), "guyditor-pack-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "guyditor-pack-b-"));
    const source = await mkdtemp(join(tmpdir(), "guyditor-pack-skill-"));
    roots.push(globalRoot, rootA, rootB, source);
    await mkdir(join(source, "examples"));
    await writeFile(join(source, "skill.yaml"), [
      "format: guyditor-skill/v1",
      "id: skl_aaaaaaaaaa",
      "name: pack-skill",
      "version: 1.0.0",
      "title: Pack skill",
      "categories: [subtitle_style, motion_transitions]",
      "summary: Use pre_aaaaaaaaaa@1 with pre_pipsmoothm@1.",
      "rules: []",
      "examples:",
      "  approved: []",
      "  rejected: []",
      "body: SKILL.md",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(source, "SKILL.md"), "# Portable behavior\n", "utf8");

    const caption = serializeCaptionPreset({
      format: "guyditor.caption-preset/v1",
      presetId: "pre_aaaaaaaaaa",
      name: "caption",
      version: 1,
      style: DEFAULT_CAPTION_STYLE,
    });
    await mkdir(join(rootA, "presets"));
    await writeFile(join(rootA, "presets/caption.yaml"), caption, "utf8");
    const modelA = projectFixture();
    modelA.skills = [];
    modelA.presets = [{
      id: "pre_aaaaaaaaaa",
      name: "caption",
      kind: "caption",
      version: 1,
      path: "presets/caption.yaml",
      sha256: createHash("sha256").update(caption).digest("hex"),
    }, {
      id: "pre_pipsmoothm",
      name: "pip-smooth-move",
      kind: "motion",
      version: 1,
      path: "builtin:pip-smooth-move@1",
      sha256: "6".repeat(64),
    }];
    const createdA = await createProject(rootA, modelA);
    if (!createdA.ok) throw createdA.error;
    const registry = new SkillRegistry({ globalRoot });
    await registry.publish(source);
    await registry.associateProject(createdA.value, "skl_aaaaaaaaaa", "1.0.0");

    const pack = await registry.createPreferencePack(createdA.value);
    const modelB = projectFixture();
    modelB.skills = [];
    modelB.presets = [];
    const packedB = await registry.applyPreferencePack(rootB, modelB, pack);
    expect(packedB.revision).toBe(modelB.revision);
    expect(packedB.presets).toEqual(createdA.value.currentProject.presets);
    expect(packedB.skills).toEqual(createdA.value.currentProject.skills);
    expect(await readFile(join(rootB, "presets/caption.yaml"), "utf8")).toBe(caption);
    expect(await readFile(join(rootB, packedB.skills[0]!.path, "SKILL.md"), "utf8"))
      .toBe("# Portable behavior\n");
  });
});
