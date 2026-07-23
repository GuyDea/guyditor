import { describe, expect, it } from "vitest";

import { projectFixture } from "../project/test-fixtures.js";
import { OperationEngine } from "./engine.js";

const V1 = {
  id: "skl_aaaaaaaaaa",
  name: "editorial-pacing",
  version: "1.0.0",
  path: "skills/editorial-pacing/1.0.0/",
  contentHash: "a".repeat(64),
};

describe("skill.pin.set", () => {
  it("is a normal-risk semantic operation that associates and upgrades exact immutable pins", async () => {
    const project = projectFixture();
    project.skills = [];
    const engine = new OperationEngine(project, {
      idFactory: (prefix) => `${prefix}_cccccccccc`,
    });

    const dryRun = await engine.execute([{
      op: "skill.pin.set",
      params: { skillId: V1.id, pin: V1 },
    }], {
      baseRevision: "rev_00001",
      origin: "ui",
      dryRun: true,
    });
    expect(dryRun.ok, dryRun.ok ? undefined : dryRun.error.message).toBe(true);
    expect(dryRun).toMatchObject({
      ok: true,
      value: {
        riskClass: "normal",
        applied: [{ summary: "Pin editorial-pacing at 1.0.0" }],
      },
    });

    const associated = await engine.execute([{
      op: "skill.pin.set",
      params: { skillId: V1.id, pin: V1 },
    }], {
      baseRevision: "rev_00001",
      origin: "ui",
      dryRun: false,
    });
    expect(associated.ok).toBe(true);
    expect(engine.currentProject.skills).toEqual([V1]);

    const v2 = {
      ...V1,
      version: "2.0.0",
      path: "skills/editorial-pacing/2.0.0/",
      contentHash: "b".repeat(64),
    };
    const upgraded = await engine.execute([{
      op: "skill.pin.set",
      params: { skillId: V1.id, pin: v2 },
    }], {
      baseRevision: "rev_00002",
      origin: "ui",
      dryRun: false,
    });
    expect(upgraded).toMatchObject({
      ok: true,
      value: {
        applied: [{
          summary: "Upgrade editorial-pacing from 1.0.0 to 2.0.0",
          inverse: [{ op: "skill.pin.set", params: { skillId: V1.id, pin: V1 } }],
        }],
      },
    });
    expect(engine.currentProject.skills).toEqual([v2]);
  });

  it("rejects a pin whose identity does not match the operation", async () => {
    const project = projectFixture();
    project.skills = [];
    const result = await new OperationEngine(project).execute([{
      op: "skill.pin.set",
      params: { skillId: "skl_aaaaaaaaaa", pin: { ...V1, id: "skl_bbbbbbbbbb" } },
    }], {
      baseRevision: "rev_00001",
      origin: "ui",
      dryRun: true,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "E_SKILL_PIN" } });
  });
});
