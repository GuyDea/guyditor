import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_AUTHORED_TEMPLATE_SOURCE_BYTES,
  TemplateAuthoringService,
  TemplateRegistry,
} from "./index.js";
import type {
  TemplateAuthorSubmission,
  TemplateAuthorValidationCheck,
} from "./index.js";

const temporaryDirectories: string[] = [];
const SESSION_ID = "ses_a2c3d4e5f6";
const MODEL = "test-director";
const SOURCE = `import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";
export default {
  render(ctx, params) {
    const progress = motion.easing.sample("ease-out", ctx.progress);
    motion.shapes.roundedRect(ctx.canvas, {
      x: 40,
      y: 40,
      width: 120 + params.value * progress,
      height: 72,
      radius: 12,
      fill: params.accent
    });
  }
};
`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function submission(
  patch: Partial<TemplateAuthorSubmission> = {},
): TemplateAuthorSubmission {
  return {
    name: "Animated stat badge",
    description: "A compact easing-driven score card.",
    manifest: {
      params: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["value", "accent"],
        properties: {
          value: { type: "number", minimum: 0, maximum: 100, default: 72 },
          accent: {
            type: "string",
            pattern: "^#[0-9A-Fa-f]{6}$",
            default: "#4DD6A4",
          },
        },
      },
      duration: {
        mode: "fixed",
        default: { frames: 30, fps: "30/1" },
      },
      assets: [],
    },
    source: SOURCE,
    ...patch,
  };
}

async function fixture(
  resolveAsset?: (declaration: TemplateAuthorSubmission["manifest"]["assets"][number]) =>
    Promise<Uint8Array>,
): Promise<{
  service: TemplateAuthoringService;
  registry: TemplateRegistry;
  userRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-template-authoring-"));
  temporaryDirectories.push(root);
  const userRoot = join(root, "templates");
  const registry = new TemplateRegistry({
    builtinsRoot: join(root, "builtins"),
    userRoot,
    draftRoot: join(userRoot, ".drafts"),
  });
  const ids = ["tas_a2c3d4e5f6", "tpl_b2c3d4e5f6", "tas_c2d3e4f5g6"];
  const service = new TemplateAuthoringService({
    registry,
    draftRoot: join(userRoot, ".drafts"),
    idFactory: () => {
      const next = ids.shift();
      if (next === undefined) throw new Error("fixture ID sequence exhausted");
      return next;
    },
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    probe: { frames: 3, framesPerSecondFloor: 0.1 },
    ...(resolveAsset === undefined ? {} : { resolveAsset }),
  });
  return { service, registry, userRoot };
}

function failedCheck(
  checks: readonly TemplateAuthorValidationCheck[],
  check: TemplateAuthorValidationCheck["check"],
): TemplateAuthorValidationCheck {
  const result = checks.find((candidate) => candidate.check === check);
  expect(result, `missing ${check} check`).toBeDefined();
  expect(result?.ok).toBe(false);
  return result!;
}

describe("FR-612 template authoring validation and review", () => {
  it("probes schema defaults and boundaries with two seeds, records performance, and creates a preview-only draft", async () => {
    const { service, registry, userRoot } = await fixture();

    const result = await service.submit(submission(), {
      sessionId: SESSION_ID,
      model: MODEL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checks.every(({ ok }) => ok)).toBe(true);
    expect(result.checks.find(({ check }) => check === "sandbox_probe")?.metrics)
      .toMatchObject({ parameterSamples: 3, seeds: 2, framesPerSample: 3 });
    expect(result.checks.find(({ check }) => check === "performance")?.metrics?.["framesPerSecond"])
      .toBeGreaterThan(0);
    expect(result.draft).toMatchObject({
      submissionId: "tas_a2c3d4e5f6",
      templateId: "tpl_b2c3d4e5f6",
      name: "Animated stat badge",
      status: "awaiting_review",
      provenance: { sessionId: SESSION_ID, model: MODEL },
    });
    expect(result.draft.previewPaths).toHaveLength(3);

    const catalog = await registry.list();
    expect(catalog.ok).toBe(true);
    expect(catalog.ok ? catalog.value : []).toEqual([
      expect.objectContaining({
        id: "tpl_b2c3d4e5f6",
        reviewState: "draft",
        authoringStatus: "awaiting_review",
        previewStripPaths: expect.any(Array),
      }),
    ]);
    await expect(registry.install({
      packagePath: join(userRoot, ".drafts", result.draft.submissionId),
    }, { dryRun: false })).resolves.toMatchObject({
      ok: false,
      error: { code: "E_TEMPLATE_UNREVIEWED" },
    });
  });

  it("returns a structured rejection matrix without persisting invalid drafts", async () => {
    const cases: Array<{
      name: string;
      input: TemplateAuthorSubmission;
      check: TemplateAuthorValidationCheck["check"];
      code: string;
    }> = [
      {
        name: "disallowed import",
        input: submission({
          source: 'import fs from "node:fs"; export default { render() { void fs; } };\n',
        }),
        check: "imports",
        code: "E_TEMPLATE_IMPORT_DISALLOWED",
      },
      {
        name: "ambient randomness",
        input: submission({
          source: "export default { render(ctx) { ctx.canvas.fillRect(Math.random(), 0, 1, 1); } };\n",
        }),
        check: "sandbox_probe",
        code: "E_TEMPLATE_SANDBOX",
      },
      {
        name: "invalid parameter schema",
        input: submission({
          manifest: {
            ...submission().manifest,
            params: {
              type: "object",
              properties: { value: { type: "number", unknownKeyword: true } },
            },
          },
        }),
        check: "param_schema",
        code: "E_TEMPLATE_PARAM_SCHEMA_INVALID",
      },
      {
        name: "oversized source",
        input: submission({ source: " ".repeat(MAX_AUTHORED_TEMPLATE_SOURCE_BYTES + 1) }),
        check: "source_size",
        code: "E_TEMPLATE_SOURCE_TOO_LARGE",
      },
    ];

    for (const testCase of cases) {
      const { service } = await fixture();
      const result = await service.submit(testCase.input, {
        sessionId: SESSION_ID,
        model: MODEL,
      });
      expect(result.ok, testCase.name).toBe(false);
      if (result.ok) continue;
      expect(result.checks.map(({ check }) => check), testCase.name).toEqual([
        "source_size",
        "source_parse",
        "imports",
        "manifest",
        "param_schema",
        "sandbox_probe",
        "determinism",
        "performance",
      ]);
      expect(
        failedCheck(result.checks, testCase.check).errors.map(({ code }) => code),
        testCase.name,
      ).toContain(testCase.code);
      await expect(service.status()).resolves.toEqual([]);
    }
  });

  it("allows a statically declared hash-pinned asset import through the same sandbox boundary", async () => {
    const svg = Buffer.from(
      ['<svg xmlns="http://www.', "w", '3.org/2000/svg" width="16" height="16">',
        '<rect width="16" height="16" fill="#4DD6A4"/></svg>'].join(""),
    );
    const asset = {
      name: "mark",
      kind: "svg" as const,
      file: "assets/mark.svg",
      sha256: createHash("sha256").update(svg).digest("hex"),
      license: {
        origin: "licensed" as const,
        licenseName: "Fixture license",
        licensor: "Fixture studio",
        restrictions: [],
      },
    };
    const { service } = await fixture(() => Promise.resolve(svg));
    const result = await service.submit(submission({
      manifest: { ...submission().manifest, assets: [asset] },
      source: `import mark from "asset:mark";
export default {
  render(ctx) {
    ctx.canvas.drawImage(ctx.staticAssets(mark), 0, 0, 16, 16);
  }
};`,
    }), { sessionId: SESSION_ID, model: MODEL });

    if (!result.ok) {
      throw new Error(JSON.stringify(result.checks));
    }
    expect(result.checks.every(({ ok }) => ok)).toBe(true);
  });

  it("rejects declared asset paths before they can escape the draft package", async () => {
    const bytes = Buffer.from("asset");
    const unsafeAsset = {
      name: "mark",
      kind: "image" as const,
      file: "../../outside.png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      license: {
        origin: "licensed" as const,
        licenseName: "Fixture license",
        licensor: "Fixture studio",
        restrictions: [],
      },
    };
    const { service } = await fixture(() => Promise.resolve(bytes));

    const result = await service.submit(submission({
      manifest: { ...submission().manifest, assets: [unsafeAsset] },
    }), { sessionId: SESSION_ID, model: MODEL });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(failedCheck(result.checks, "manifest").errors).toContainEqual(
      expect.objectContaining({ code: "E_TEMPLATE_MANIFEST_INVALID" }),
    );
  });

  it("publishes an immutable normal-registry version and archives rejection/change outcomes", async () => {
    const { service, registry, userRoot } = await fixture();
    const submitted = await service.submit(submission(), {
      sessionId: SESSION_ID,
      model: MODEL,
    });
    if (!submitted.ok) throw new Error("expected authored draft");

    const published = await service.review({
      submissionId: submitted.draft.submissionId,
      decision: "approve",
    });

    expect(published).toMatchObject({
      status: "published",
      published: {
        id: submitted.draft.templateId,
        version: "1.0.0",
        reviewState: "published",
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    const exact = await registry.get(submitted.draft.templateId, "1.0.0");
    expect(exact).toEqual({ ok: true, value: published.published });
    const publishedManifest = await readFile(
      join(userRoot, submitted.draft.templateId, "1.0.0", "template.yaml"),
      "utf8",
    );
    expect(publishedManifest).toContain("version: 1.0.0");
    await expect(service.review({
      submissionId: submitted.draft.submissionId,
      decision: "approve",
    })).rejects.toMatchObject({ code: "E_TEMPLATE_REVIEW_FINAL" });
  });

  it("keeps published content hashes independent of measured probe throughput", async () => {
    const first = await fixture();
    const second = await fixture();
    const firstDraft = await first.service.submit(submission(), {
      sessionId: SESSION_ID,
      model: MODEL,
    });
    const secondDraft = await second.service.submit(submission(), {
      sessionId: SESSION_ID,
      model: MODEL,
    });
    if (!firstDraft.ok || !secondDraft.ok) throw new Error("expected reproducible drafts");
    const firstPublished = await first.service.review({
      submissionId: firstDraft.draft.submissionId,
      decision: "approve",
    });
    const secondPublished = await second.service.review({
      submissionId: secondDraft.draft.submissionId,
      decision: "approve",
    });

    expect(firstPublished.published?.contentHash)
      .toBe(secondPublished.published?.contentHash);
  });

  it("requires a reason for rejection/change requests and links a superseding draft", async () => {
    const { service } = await fixture();
    const first = await service.submit(submission(), {
      sessionId: SESSION_ID,
      model: MODEL,
    });
    if (!first.ok) throw new Error("expected authored draft");
    await expect(service.review({
      submissionId: first.draft.submissionId,
      decision: "request_changes",
      reason: "Keep the badge inside title-safe.",
    })).resolves.toMatchObject({
      status: "changes_requested",
      reason: "Keep the badge inside title-safe.",
    });

    const replacement = await service.submit(submission({
      supersedes: first.draft.submissionId,
      source: SOURCE.replace("x: 40", "x: ctx.safeArea.left"),
    }), {
      sessionId: SESSION_ID,
      model: MODEL,
    });

    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(replacement.draft).toMatchObject({
      templateId: first.draft.templateId,
      supersedes: first.draft.submissionId,
      draftRevision: 2,
    });
    await expect(service.status(first.draft.submissionId)).resolves.toMatchObject({
      status: "superseded",
      supersededBy: replacement.draft.submissionId,
    });
    await expect(service.review({
      submissionId: replacement.draft.submissionId,
      decision: "reject",
      reason: "",
    })).rejects.toMatchObject({ code: "E_TEMPLATE_REVIEW_REASON_REQUIRED" });
  });

  it("returns an ordered structured failure for an invalid supersession target", async () => {
    const { service } = await fixture();

    const result = await service.submit(submission({
      supersedes: "tas_bbbbbbbbbb",
    }), { sessionId: SESSION_ID, model: MODEL });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.checks.map(({ check }) => check)).toEqual([
      "source_size",
      "source_parse",
      "imports",
      "manifest",
      "param_schema",
      "sandbox_probe",
      "determinism",
      "performance",
    ]);
    expect(failedCheck(result.checks, "manifest").errors).toContainEqual(
      expect.objectContaining({ code: "E_TEMPLATE_SUPERSESSION_INVALID" }),
    );
  });
});
