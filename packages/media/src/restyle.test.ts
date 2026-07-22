import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyDeterministicRestyleFilter,
  materializeRestyleSegment,
  probeMedia,
  runFfmpeg,
} from "./index.js";
import { parseProjectYaml } from "../../core/src/index.js";

const roots: string[] = [];
const FIXTURE_ROOT = resolve(".fixtures");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-restyle-media-"));
  roots.push(root);
  return root;
}

async function hash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function firstFrameHash(path: string): Promise<string> {
  const frame = await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", path,
    "-frames:v", "1",
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1",
  ]);
  return createHash("sha256").update(frame.stdout, "latin1").digest("hex");
}

describe("deterministic restyle media", () => {
  it("creates byte-identical visibly filtered stub outputs with the source shape", async () => {
    const root = await directory();
    const input = join(FIXTURE_ROOT, "bars-1080p30-10s.mp4");
    const first = join(root, "first.mp4");
    const second = join(root, "second.mp4");

    await applyDeterministicRestyleFilter({
      inputPath: input,
      outputPath: first,
      width: 1920,
      height: 1080,
      fps: "30/1",
      durationSeconds: 1,
    });
    await applyDeterministicRestyleFilter({
      inputPath: input,
      outputPath: second,
      width: 1920,
      height: 1080,
      fps: "30/1",
      durationSeconds: 1,
    });

    expect(await hash(first)).toBe(await hash(second));
    expect(await firstFrameHash(first)).not.toBe(await firstFrameHash(input));
    const probed = await probeMedia(first);
    expect(probed.probe).toMatchObject({
      width: 1920,
      height: 1080,
      fps: "30/1",
      duration: { frames: 30, fps: "30/1" },
    });
  }, 30_000);

  it("materializes an exact cross-clip timeline range for adapter upload", async () => {
    const root = await directory();
    const parsed = parseProjectYaml(await readFile(
      join(FIXTURE_ROOT, "projects/basic/episode.guyditor.yaml"),
      "utf8",
    ));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outputPath = join(root, "segment.mp4");

    const result = await materializeRestyleSegment({
      project: parsed.value,
      sequenceId: "seq_aaaaaaaaaa",
      range: { startFrame: 90, endFrame: 150 },
      outputPath,
    });

    expect(result).toEqual({
      outputPath,
      durationSeconds: 2,
      sourceAssetIds: ["ast_aaaaaaaaaa", "ast_dddddddddd"],
    });
    const probed = await probeMedia(outputPath);
    expect(probed.probe).toMatchObject({
      width: 1920,
      height: 1080,
      fps: "30/1",
      duration: { frames: 60, fps: "30/1" },
    });
  }, 30_000);
});
