import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectStore,
  canonicalizeYaml,
} from "../index.js";
import type {
  IdPrefix,
  Result,
  SkillPin,
  WatchFolderConfig,
} from "../index.js";

const temporaryDirectories: string[] = [];
const FIXED_NOW = new Date("2026-07-18T09:30:00.000Z");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-create-"));
  temporaryDirectories.push(root);
  return root;
}

async function profilesDirectory(root: string): Promise<string> {
  const profiles = join(root, "profiles");
  const profileDirectory = join(profiles, "youtube-longform");
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(join(profileDirectory, "1.0.0.yaml"), [
    "format: guyditor-profile/v1",
    "id: youtube-longform",
    "version: 1.0.0",
    "kind: longform",
    "video:",
    "  resolution: { width: 2560, height: 1440 }",
    "  fps: { allowed: [\"25/1\", \"50/1\"], default: \"25/1\" }",
    "audio:",
    "  sampleRate: 96000",
    "  channels: 6",
    "",
  ].join("\n"), "utf8");
  return profiles;
}

function deterministicId(prefix: IdPrefix): string {
  return `${prefix}_aaaaaaaaaa`;
}

async function valueOf<T>(result: Promise<Result<T>>): Promise<T> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.value;
}

async function allPaths(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const child = join(relative, entry.name);
    paths.push(child);
    if (entry.isDirectory()) paths.push(...await allPaths(root, child));
  }
  return paths;
}

describe("ProjectStore.createProject", () => {
  it("creates a project in an existing empty directory from profile-derived defaults", async () => {
    const sandbox = await temporaryRoot();
    const profiles = await profilesDirectory(sandbox);
    const target = join(sandbox, "empty-project");
    await mkdir(target);
    const skill: SkillPin = {
      id: "skl_aaaaaaaaaa",
      name: "brand-voice",
      version: "2.0.0",
      path: "skills/brand-voice/2.0.0/",
      contentHash: "b".repeat(64),
    };
    const watchFolder: WatchFolderConfig = {
      path: "/captures/guyditor-inbox",
      convention: "guyditor",
      autoIngest: true,
      autoJobs: { proxy: true, analysis: true, transcription: true },
    };

    const store = await valueOf(ProjectStore.createProject(target, {
      name: "Episode 12 — Hooks",
      skills: [skill],
      watchFolders: [watchFolder],
    }, {
      appVersion: "1.0.0-test",
      idFactory: deterministicId,
      now: () => FIXED_NOW,
      profilesDirectory: profiles,
    }));

    expect(store.root).toBe(target);
    expect(store.currentProject).toMatchObject({
      format: "guyditor/v1",
      revision: "rev_00001",
      project: {
        id: "prj_aaaaaaaaaa",
        name: "Episode 12 — Hooks",
        created: FIXED_NOW.toISOString(),
      },
      settings: {
        timeline: { fps: "25/1", width: 2560, height: 1440 },
        audio: { sampleRate: 96_000, channels: 6 },
        primaryDeliverable: "dlv_aaaaaaaaaa",
      },
      watchFolders: [watchFolder],
      skills: [skill],
      sequences: [{ id: "seq_aaaaaaaaaa", name: "main", clips: [] }],
      deliverables: [{
        id: "dlv_aaaaaaaaaa",
        kind: "longform",
        profile: "youtube-longform@1.0.0",
        sequenceId: "seq_aaaaaaaaaa",
        status: "draft",
      }],
    });
    await expect(readFile(join(target, "episode.guyditor.yaml"), "utf8"))
      .resolves.toBe(canonicalizeYaml(store.currentProject));
    await expect(readFile(join(target, "history/HEAD"), "utf8"))
      .resolves.toBe("rev_00001\n");
    await expect(readFile(
      join(target, "history/revisions/rev_00001.yaml"),
      "utf8",
    )).resolves.toBe(canonicalizeYaml(store.currentProject));

    const lock = JSON.parse(await readFile(
      join(target, "history/revisions/rev_00001.lock.json"),
      "utf8",
    )) as { profiles: unknown[]; revision: string };
    expect(lock).toMatchObject({
      revision: "rev_00001",
      profiles: [{ id: "youtube-longform", version: "1.0.0" }],
    });

    const transactions = (await readFile(
      join(target, "history/transactions.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line) as {
      baseRevision: string;
      operations: Array<{ op: string; summary: string }>;
      resultRevision: string;
    });
    expect(transactions).toEqual([expect.objectContaining({
      baseRevision: "rev_00000",
      resultRevision: "rev_00001",
      operations: [expect.objectContaining({
        op: "project.create",
        summary: "Create project Episode 12 — Hooks",
      })],
    })]);

    const paths = await allPaths(target);
    for (const expected of [
      "sidecars",
      "history",
      "history/revisions/rev_00001.yaml",
      "history/revisions/rev_00001.lock.json",
      "proposals",
      "media/pickups",
      ".guyditor/cache",
      ".gitignore",
    ]) expect(paths).toContain(expected);
  });

  it("rejects a target nested in a project or its cache without scaffolding it", async () => {
    const sandbox = await temporaryRoot();
    const profiles = await profilesDirectory(sandbox);
    const projectRoot = join(sandbox, "parent-project");
    await valueOf(ProjectStore.createProject(projectRoot, { name: "Parent" }, {
      idFactory: deterministicId,
      now: () => FIXED_NOW,
      profilesDirectory: profiles,
    }));

    const nested = join(projectRoot, "nested");
    const nestedResult = await ProjectStore.createProject(nested, { name: "Nested" }, {
      idFactory: deterministicId,
      now: () => FIXED_NOW,
      profilesDirectory: profiles,
    });
    expect(nestedResult).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_LOCATION_INVALID" },
    });

    const cacheTarget = join(projectRoot, ".guyditor/cache/accidental-project");
    const cacheResult = await ProjectStore.createProject(cacheTarget, { name: "Cache" }, {
      idFactory: deterministicId,
      now: () => FIXED_NOW,
      profilesDirectory: profiles,
    });
    expect(cacheResult).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_LOCATION_INVALID" },
    });
    await expect(readdir(nested)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(cacheTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-empty unrelated target directory", async () => {
    const sandbox = await temporaryRoot();
    const profiles = await profilesDirectory(sandbox);
    const target = join(sandbox, "non-empty");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "user data", "utf8");

    const result = await ProjectStore.createProject(target, { name: "Nope" }, {
      idFactory: deterministicId,
      now: () => FIXED_NOW,
      profilesDirectory: profiles,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_LOCATION_INVALID" },
    });
    await expect(readFile(join(target, "keep.txt"), "utf8"))
      .resolves.toBe("user data");
  });

  it("rejects symlinked targets that resolve inside a project or its cache", async () => {
    const sandbox = await temporaryRoot();
    const profiles = await profilesDirectory(sandbox);
    const projectRoot = join(sandbox, "parent-project");
    await valueOf(ProjectStore.createProject(projectRoot, { name: "Parent" }, {
      idFactory: deterministicId,
      now: () => FIXED_NOW,
      profilesDirectory: profiles,
    }));
    const projectAlias = join(sandbox, "project-alias");
    await symlink(projectRoot, projectAlias, "dir");
    const nested = await ProjectStore.createProject(
      join(projectAlias, "nested"),
      { name: "Nested through symlink" },
      {
        idFactory: deterministicId,
        now: () => FIXED_NOW,
        profilesDirectory: profiles,
      },
    );
    expect(nested).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_LOCATION_INVALID" },
    });

    const cacheAlias = join(sandbox, "cache-alias");
    await symlink(join(projectRoot, ".guyditor/cache"), cacheAlias, "dir");
    const cached = await ProjectStore.createProject(
      join(cacheAlias, "nested"),
      { name: "Cache through symlink" },
      {
        idFactory: deterministicId,
        now: () => FIXED_NOW,
        profilesDirectory: profiles,
      },
    );
    expect(cached).toMatchObject({
      ok: false,
      error: { code: "E_PROJECT_LOCATION_INVALID" },
    });
  });
});
