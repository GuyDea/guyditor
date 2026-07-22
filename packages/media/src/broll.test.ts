import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  derivePromptSynthesis,
  FfmpegError,
  resolveBrollSourcePath,
  synthesizePromptClip,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("FR-603 taxonomy entry paths", () => {
  it("maps local, licensed, still, and capture sources to ordinary ingest with rights defaults", () => {
    expect(resolveBrollSourcePath({
      sourceClass: "local-footage",
      path: "/captures/camera-a.mov",
    })).toMatchObject({
      kind: "ingest",
      request: {
        sources: [{
          path: "/captures/camera-a.mov",
          rights: { origin: "captured", confirmedBy: "creator", restrictions: [] },
        }],
      },
    });
    expect(resolveBrollSourcePath({
      sourceClass: "licensed-asset",
      path: "/downloads/stock.mp4",
    })).toMatchObject({
      kind: "ingest",
      request: {
        sources: [{ rights: { origin: "licensed", restrictions: [] } }],
      },
      rightsMissing: ["licenseName", "licensor"],
    });
    expect(resolveBrollSourcePath({
      sourceClass: "still-image",
      path: "/art/diagram.png",
      origin: "captured",
    })).toMatchObject({
      kind: "ingest",
      request: { sources: [{ rights: { origin: "captured" } }] },
    });
    expect(resolveBrollSourcePath({
      sourceClass: "screen-capture",
      path: "/captures/screen.mov",
    })).toMatchObject({
      kind: "ingest",
      request: { via: "watch", sources: [{ rights: { origin: "captured" } }] },
    });
  });

  it("routes templates and both generator classes without pretending local capability is installed", () => {
    expect(resolveBrollSourcePath({
      sourceClass: "programmatic-animation",
      templateId: "tpl_aaaaaaaaaa",
      version: "1.2.0",
      params: { metric: "37%" },
      seed: 7,
    })).toEqual({
      kind: "template",
      graphic: {
        templateId: "tpl_aaaaaaaaaa",
        version: "1.2.0",
        params: { metric: "37%" },
        seed: 7,
      },
    });
    expect(resolveBrollSourcePath({ sourceClass: "external-generation" })).toEqual({
      kind: "generate",
      local: false,
      availability: "available",
    });
    expect(resolveBrollSourcePath({ sourceClass: "local-generation" })).toEqual({
      kind: "generate",
      local: true,
      availability: "declared-unavailable",
      reason: "No local generation adapter is configured.",
    });
  });

  it("freezes an exported template through ingest with programmatic provenance and rights", () => {
    expect(resolveBrollSourcePath({
      sourceClass: "programmatic-animation",
      templateId: "tpl_aaaaaaaaaa",
      version: "1.2.0",
      params: { metric: "37%" },
      seed: 7,
      exportedPath: "/exports/chart.mp4",
      provenanceSidecar: "provenance-ast_aaaaaaaaaa",
    })).toMatchObject({
      kind: "ingest",
      request: {
        via: "generated",
        sources: [{
          path: "/exports/chart.mp4",
          generated: true,
          provenance: { sidecar: "provenance-ast_aaaaaaaaaa" },
          rights: { origin: "programmatic", confirmedBy: "creator", restrictions: [] },
        }],
      },
      programmaticProvenance: {
        templateId: "tpl_aaaaaaaaaa",
        version: "1.2.0",
        seed: 7,
        paramsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
  });
});

describe("FR-604 deterministic generator", () => {
  it("derives stable visual parameters from prompt and seed without rendered text", () => {
    const first = derivePromptSynthesis("Blue glass in orbit", 17);
    const repeated = derivePromptSynthesis("Blue glass in orbit", 17);
    const changed = derivePromptSynthesis("Blue glass in orbit", 18);

    expect(repeated).toEqual(first);
    expect(changed).not.toEqual(first);
    expect(first).toMatchObject({ seed: 17, renderedText: false });
  });

  it("synthesizes a playable prompt-seeded clip offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-broll-synth-"));
    roots.push(root);
    const outputPath = join(root, "candidate.mp4");

    let result: Awaited<ReturnType<typeof synthesizePromptClip>>;
    try {
      result = await synthesizePromptClip({
        outputPath,
        prompt: "Blue glass in orbit",
        seed: 17,
        width: 320,
        height: 180,
        durationFrames: 12,
        fps: "24/1",
      });
    } catch (error: unknown) {
      if (error instanceof FfmpegError) {
        throw new Error(error.stderrLines?.join("\n") ?? error.message);
      }
      throw error;
    }

    expect(result).toMatchObject({
      outputPath,
      durationSeconds: 0.5,
      seed: 17,
      mime: "video/mp4",
      width: 320,
      height: 180,
    });
    expect((await stat(outputPath)).size).toBeGreaterThan(100);
    expect((await readFile(outputPath)).subarray(4, 8).toString("ascii")).toBe("ftyp");
  });
});
