import { createHash } from "node:crypto";
import { cp, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SkillRegistry } from "./registry.js";

const SKILL_ID = "skl_aaaaaaaaaa";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeSkillSource(
  root: string,
  options: {
    version?: string;
    ruleText?: string;
    category?: string;
  } = {},
): Promise<string> {
  const directory = join(root, `source-${options.version ?? "1.0.0"}`);
  const example = `${JSON.stringify({ proposal: "prp_aaaaaaaaaa", outcome: "approved" })}\n`;
  await mkdir(join(directory, "examples"), { recursive: true });
  await writeFile(join(directory, "examples/example.json"), example, "utf8");
  await writeFile(join(directory, "SKILL.md"), "# Pacing\n\nKeep the thesis moving.\n", "utf8");
  await writeFile(join(directory, "skill.yaml"), [
    "format: guyditor-skill/v1",
    `id: ${SKILL_ID}`,
    "name: creator-pacing",
    `version: ${options.version ?? "1.0.0"}`,
    "title: Creator pacing",
    `categories: [${options.category ?? "pacing"}]`,
    "summary: Creator pacing rules.",
    "rules:",
    "  - id: rule_hook",
    "    category: hooks_retention",
    "    strength: must",
    `    text: ${options.ruleText ?? "Reach the thesis quickly."}`,
    "examples:",
    "  approved:",
    "    - id: ex_good",
    "      description: Accepted hook.",
    "      media:",
    "        path: examples/example.json",
    `        sha256: ${sha256(example)}`,
    "  rejected: []",
    "body: SKILL.md",
    "",
  ].join("\n"), "utf8");
  return directory;
}

describe("SkillRegistry format and immutable publishing", () => {
  it("publishes the exact §9.5 layout, hashes it, and lists immutable semver versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-"));
    const globalRoot = join(root, "library");
    const registry = new SkillRegistry({ globalRoot });
    const v1Source = await writeSkillSource(root);

    const published = await registry.publish(v1Source);

    expect(published).toMatchObject({
      id: SKILL_ID,
      name: "creator-pacing",
      version: "1.0.0",
      categories: ["pacing"],
    });
    expect(published.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await registry.list("global")).toEqual([published]);
    expect(await registry.versions(SKILL_ID)).toEqual(["1.0.0"]);
    expect(await registry.get(SKILL_ID)).toMatchObject({
      manifest: published,
      body: "# Pacing\n\nKeep the thesis moving.\n",
      presetReferences: [],
    });
    expect(await registry.verify(SKILL_ID, "1.0.0")).toEqual({
      ok: true,
      expected: published.contentHash,
      actual: published.contentHash,
    });

    await writeFile(join(v1Source, "SKILL.md"), "changed source", "utf8");
    expect((await registry.get(SKILL_ID, "1.0.0")).body)
      .toBe("# Pacing\n\nKeep the thesis moving.\n");

    const conflicting = await writeSkillSource(root, {
      version: "1.0.0",
      ruleText: "Use a different rule.",
    });
    await expect(registry.publish(conflicting)).rejects.toMatchObject({
      code: "E_SKILL_IMMUTABLE",
      acceptedStateChanged: false,
    });
  });

  it("rejects categories outside the binding closed enum", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-invalid-"));
    const registry = new SkillRegistry({ globalRoot: join(root, "library") });
    const source = await writeSkillSource(root, { category: "cinematic_vibes" });

    await expect(registry.publish(source)).rejects.toMatchObject({
      code: "E_SKILL_FORMAT",
    });
  });

  it("serializes concurrent immutable version publishes without losing the index", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-concurrent-"));
    const globalRoot = join(root, "library");
    const firstRegistry = new SkillRegistry({ globalRoot });
    const secondRegistry = new SkillRegistry({ globalRoot });
    const [v1, v2] = await Promise.all([
      writeSkillSource(root, { version: "1.0.0" }),
      writeSkillSource(root, { version: "2.0.0" }),
    ]);

    await Promise.all([firstRegistry.publish(v1), secondRegistry.publish(v2)]);

    const reader = new SkillRegistry({ globalRoot });
    expect(await reader.versions(SKILL_ID)).toEqual(["1.0.0", "2.0.0"]);
    await expect(reader.get(SKILL_ID, "1.0.0")).resolves.toMatchObject({
      manifest: { version: "1.0.0" },
    });
    await expect(reader.get(SKILL_ID, "2.0.0")).resolves.toMatchObject({
      manifest: { version: "2.0.0" },
    });
  });

  it("keeps the winning immutable version when registry instances race for one destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-same-version-"));
    const globalRoot = join(root, "library");
    const firstSource = await writeSkillSource(join(root, "first"), {
      ruleText: "First contender.",
    });
    const secondSource = await writeSkillSource(join(root, "second"), {
      ruleText: "Second contender.",
    });

    const settled = await Promise.allSettled([
      new SkillRegistry({ globalRoot }).publish(firstSource),
      new SkillRegistry({ globalRoot }).publish(secondSource),
    ]);

    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const published = await new SkillRegistry({ globalRoot }).get(SKILL_ID, "1.0.0");
    expect(published.manifest.rules[0]?.text).toMatch(/^(First|Second) contender\.$/u);
  });

  it("reclaims a dead publisher lock and adopts its fully installed orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-recovery-"));
    const globalRoot = join(root, "library");
    const source = await writeSkillSource(root);
    const token = "00000000-0000-4000-8000-000000000000";
    const owners = join(globalRoot, ".publish-locks");
    await mkdir(owners, { recursive: true });
    const owner = join(owners, `${token}.json`);
    await writeFile(owner, `${JSON.stringify({
      format: "guyditor-skill-publish-lock/v1",
      token,
      pid: 2_147_483_647,
      createdAt: "2026-07-22T10:00:00.000Z",
    })}\n`, "utf8");
    await link(owner, join(globalRoot, ".publish.lock"));
    const reclaimToken = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(globalRoot, ".publish.reclaim"));
    await writeFile(join(globalRoot, ".publish.reclaim/owner.json"), `${JSON.stringify({
      format: "guyditor-skill-publish-lock/v1",
      token: reclaimToken,
      pid: 2_147_483_647,
      createdAt: "2026-07-22T10:00:00.000Z",
    })}\n`, "utf8");
    await mkdir(join(globalRoot, "creator-pacing"), { recursive: true });
    await cp(source, join(globalRoot, "creator-pacing/1.0.0"), { recursive: true });

    const published = await new SkillRegistry({ globalRoot }).publish(source);

    expect(published.version).toBe("1.0.0");
    expect(await new SkillRegistry({ globalRoot }).versions(SKILL_ID)).toEqual(["1.0.0"]);
    await expect(readFile(join(globalRoot, ".publish.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a package without the required examples directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-layout-"));
    const registry = new SkillRegistry({ globalRoot: join(root, "library") });
    const source = await writeSkillSource(root);
    await rm(join(source, "examples"), { recursive: true });
    await writeFile(join(source, "skill.yaml"), [
      "format: guyditor-skill/v1",
      `id: ${SKILL_ID}`,
      "name: creator-pacing",
      "version: 1.0.0",
      "title: Creator pacing",
      "categories: [pacing]",
      "summary: Creator pacing rules.",
      "rules: []",
      "examples:",
      "  approved: []",
      "  rejected: []",
      "body: SKILL.md",
      "",
    ].join("\n"), "utf8");

    await expect(registry.publish(source)).rejects.toMatchObject({
      code: "E_SKILL_FORMAT",
    });
  });

  it("refuses to read a published version whose immutable bytes were edited externally", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-tamper-"));
    const globalRoot = join(root, "library");
    const registry = new SkillRegistry({ globalRoot });
    await registry.publish(await writeSkillSource(root));
    await writeFile(
      join(globalRoot, "creator-pacing/1.0.0/SKILL.md"),
      "# Tampered\n",
      "utf8",
    );

    await expect(registry.get(SKILL_ID, "1.0.0")).rejects.toMatchObject({
      code: "E_SKILL_HASH",
    });
    await expect(registry.list("global")).rejects.toMatchObject({
      code: "E_SKILL_HASH",
    });
  });

  it("creates editable drafts while keeping published files untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-draft-"));
    const registry = new SkillRegistry({ globalRoot: join(root, "library") });
    await registry.publish(await writeSkillSource(root));

    const draft = await registry.createDraft({
      base: { skillId: SKILL_ID, version: "1.0.0" },
      version: "1.1.0",
    });
    const updated = await registry.updateDraft({
      skillId: SKILL_ID,
      version: "1.1.0",
      body: "# Pacing\n\nLet conclusions breathe.\n",
      rules: [{
        id: "rule_pause",
        category: "pauses_fillers",
        strength: "prefer",
        text: "Keep thinking pauses.",
      }],
    });

    expect(draft.manifest.version).toBe("1.1.0");
    expect(updated.body).toContain("conclusions breathe");
    expect((await registry.get(SKILL_ID, "1.0.0")).body).toContain("thesis moving");
    expect(await registry.drafts(SKILL_ID)).toEqual([
      expect.objectContaining({ manifest: expect.objectContaining({ version: "1.1.0" }) }),
    ]);
    expect(await registry.diff(SKILL_ID, "1.0.0", "1.1.0")).toMatchObject({
      body: { after: "# Pacing\n\nLet conclusions breathe.\n" },
      rules: { added: [expect.objectContaining({ id: "rule_pause" })] },
    });

    const published = await registry.publishDraft(SKILL_ID, "1.1.0");
    expect(published.version).toBe("1.1.0");
    expect(await registry.versions(SKILL_ID)).toEqual(["1.0.0", "1.1.0"]);
    expect(await registry.drafts(SKILL_ID)).toEqual([]);
    await expect(registry.updateDraft({
      skillId: SKILL_ID,
      version: "1.1.0",
      body: "forbidden",
    })).rejects.toMatchObject({ code: "E_SKILL_DRAFT_NOT_FOUND" });
  });

  it("reports inspectable rule, example, and prose differences between versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-skills-diff-"));
    const registry = new SkillRegistry({ globalRoot: join(root, "library") });
    await registry.publish(await writeSkillSource(root));
    await registry.createDraft({
      base: { skillId: SKILL_ID, version: "1.0.0" },
      version: "2.0.0",
    });
    await registry.updateDraft({
      skillId: SKILL_ID,
      version: "2.0.0",
      body: "# Pacing\n\nOpen faster.\n",
      rules: [{
        id: "rule_hook",
        category: "hooks_retention",
        strength: "must",
        text: "Reach the thesis in twelve seconds.",
      }],
    });
    await registry.publishDraft(SKILL_ID, "2.0.0");

    const diff = await registry.diff(SKILL_ID, "1.0.0", "2.0.0");
    expect(diff.rules.changed).toEqual([expect.objectContaining({ id: "rule_hook" })]);
    expect(diff.body).toEqual({
      before: "# Pacing\n\nKeep the thesis moving.\n",
      after: "# Pacing\n\nOpen faster.\n",
    });
    expect(diff.examples.approved.unchanged).toEqual(["ex_good"]);

    const yaml = await readFile(
      join(root, "library/creator-pacing/2.0.0/skill.yaml"),
      "utf8",
    );
    expect(yaml).toContain("format: guyditor-skill/v1");
    expect(yaml).toContain("body: SKILL.md");
  });
});
