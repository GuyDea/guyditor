import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  deriveTimeline,
  parseProjectYaml,
} from "../../../core/src/index.js";
import { probeMedia } from "../../../media/src/index.js";
import {
  exportOutputPath,
  exportReportPath,
} from "../../../render/src/index.js";
import type { ExportReport } from "../../../render/src/index.js";
import { dhashFrame, hammingDistance } from "../../../render/test/golden/dhash.js";
import { launchApp } from "../helpers/launch-app.js";

interface GoldenManifest {
  frames: Array<{
    at: { frames: number; fps: string };
    dhash: string;
    maxDistance: number;
    reason: string;
  }>;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

async function nextRevision(page: Page, action: () => Promise<void>, timeout = 30_000): Promise<string> {
  const indicator = page.getByTestId("revision-indicator");
  const before = await indicator.textContent();
  await action();
  await expect.poll(async () => indicator.textContent(), { timeout }).not.toBe(before);
  const after = await indicator.textContent();
  if (after === null) throw new Error("Revision indicator disappeared.");
  return after;
}

async function importFixture(page: Page, fixturePath: string): Promise<void> {
  await nextRevision(page, async () => {
    await page.getByTestId("ingest-path-input").fill(fixturePath);
    await page.getByTestId("ingest-path-submit").click();
  });
  await expect(page.getByTestId("job-state-ingest")).toHaveText("done", {
    timeout: 30_000,
  });
}

function exactFrames(duration: string, fps: string): number {
  const [durationNumerator, durationDenominator] = duration.split("/").map(BigInt);
  const [fpsNumerator, fpsDenominator] = fps.split("/").map(BigInt);
  const numerator = durationNumerator! * fpsNumerator!;
  const denominator = durationDenominator! * fpsDenominator!;
  if (numerator % denominator !== 0n) {
    throw new Error(`Timeline duration ${duration} is not integral at ${fps}.`);
  }
  return Number(numerator / denominator);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("AC-001 — builds and exports the M1 long-form composition", async ({}, testInfo) => {
  test.setTimeout(240_000);
  testInfo.annotations.push({
    type: "M1 3-layer delta",
    description: "The UI assembles and verifies three enabled sequence layers, then disables the M2-only audio/image composite layers before the M1 single-video renderer runs.",
  });
  testInfo.annotations.push({
    type: "M1 job delta",
    description: "The template carries its deterministic synthetic transcript sidecar; standalone analysis jobs are not present in the M1 job catalog.",
  });
  const launched = await launchApp({
    projectTemplate: join(REPOSITORY_ROOT, ".fixtures/projects/basic"),
  });
  try {
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00001");
    await expect(launched.page.getByTestId("deliverable-dlv_aaaaaaaaaa"))
      .toContainText("approved");

    const fixturePaths = [
      "bars-1080p30-10s.mp4",
      "greenscreen-720p30-6s.mp4",
      "screencast-1080p30-15s.mp4",
      "stills/diagram-1080.png",
      "stills/logo-256.png",
      "speech-48k-20s.wav",
    ].map((relativePath) => join(REPOSITORY_ROOT, ".fixtures", relativePath));
    for (const fixturePath of fixturePaths) await importFixture(launched.page, fixturePath);

    await expect(launched.page.getByTestId("proxy-chip-ast_aaaaaaaaaa"))
      .toHaveText("proxy done", { timeout: 60_000 });
    await expect(launched.page.getByTestId("proxy-chip-ast_cccccccccc"))
      .toHaveText("proxy done", { timeout: 60_000 });
    await expect(launched.page.getByTestId("proxy-chip-ast_dddddddddd"))
      .toHaveText("proxy done", { timeout: 60_000 });
    await expect(launched.page.getByTestId("transcript-word-stream"))
      .toContainText("guide");
    const transcript = JSON.parse(await readFile(
      join(launched.projectPath!, "sidecars/transcript-speech.json"),
      "utf8",
    )) as { provenance: { engine: { model: string } }; words: Record<string, unknown> };
    expect(transcript.provenance.engine.model).toBe("synthetic-word-list");
    expect(Object.keys(transcript.words)).toHaveLength(40);

    await nextRevision(launched.page, async () => {
      await launched.page.getByTestId("layer-enable-lyr_bbbbbbbbbb").click();
    });
    await nextRevision(launched.page, async () => {
      await launched.page.getByTestId("layer-enable-lyr_cccccccccc").click();
    });
    await expect(launched.page.getByTestId("layer-enable-lyr_aaaaaaaaaa")).toHaveText("On");
    await expect(launched.page.getByTestId("layer-enable-lyr_bbbbbbbbbb")).toHaveText("On");
    await expect(launched.page.getByTestId("layer-enable-lyr_cccccccccc")).toHaveText("On");

    await launched.page.getByTestId("timeline-clip-clp_aaaaaaaaaa").click();
    await launched.page.getByTestId("timeline-trim-value").fill("5");
    await launched.page.getByTestId("timeline-trim-tail").click();
    await nextRevision(launched.page, () => launched.page.getByTestId("timeline-trim-submit").click());

    await launched.page.getByTestId("timeline-clip-clp_bbbbbbbbbb").click();
    await launched.page.getByTestId("timeline-trim-value").fill("3");
    await launched.page.getByTestId("timeline-trim-head").click();
    await nextRevision(launched.page, () => launched.page.getByTestId("timeline-trim-submit").click());

    await launched.page.getByTestId("timeline-clip-clp_cccccccccc").click();
    await launched.page.getByTestId("preview-frame-input").fill("250");
    await nextRevision(launched.page, () => launched.page.getByTestId("timeline-split-submit").click());

    await launched.page.getByTestId("timeline-zoom").fill("0.5");
    await nextRevision(launched.page, () =>
      launched.page.getByTestId("timeline-clip-clp_dddddddddd")
        .dragTo(launched.page.getByTestId("timeline-clip-clp_aaaaaaaaaa"))
    );

    await nextRevision(launched.page, async () => {
      await launched.page.getByTestId("layer-enable-lyr_bbbbbbbbbb").click();
    });
    const exportRevision = await nextRevision(launched.page, async () => {
      await launched.page.getByTestId("layer-enable-lyr_cccccccccc").click();
    });
    await expect(launched.page.getByTestId("layer-enable-lyr_bbbbbbbbbb")).toHaveText("Off");
    await expect(launched.page.getByTestId("layer-enable-lyr_cccccccccc")).toHaveText("Off");

    await launched.page.getByTestId("render-export-primary").click();
    await expect(launched.page.getByTestId("job-state-render-export"))
      .toHaveText("done", { timeout: 120_000 });
    await expect(launched.page.getByTestId("export-report"))
      .toContainText(exportRevision, { timeout: 10_000 });

    const projectPath = launched.projectPath;
    if (projectPath === undefined) throw new Error("AC-001 project was not copied.");
    const masterText = await readFile(join(projectPath, "episode.guyditor.yaml"), "utf8");
    const parsedMaster = parseProjectYaml(masterText);
    expect(parsedMaster.ok).toBe(true);
    if (!parsedMaster.ok) throw parsedMaster.error;
    const master = parsedMaster.value;
    expect(master.project.name).toBe("M1 basic template");
    expect(master.deliverables[0]?.profile).toBe("youtube-longform@1.0.0");
    expect(master.layers.filter(({ enabled }) => enabled).map(({ id }) => id))
      .toEqual(["lyr_aaaaaaaaaa"]);

    const outputPath = exportOutputPath(
      join(projectPath, "exports"),
      "dlv_aaaaaaaaaa",
      "clean",
      "mp4",
    );
    const report = JSON.parse(await readFile(
      exportReportPath(outputPath),
      "utf8",
    )) as ExportReport;
    expect(report).toMatchObject({
      reportVersion: "guyditor-export-report/1",
      revision: exportRevision,
      deliverableId: "dlv_aaaaaaaaaa",
      profile: { id: "youtube-longform", version: "1.0.0" },
      renderSettings: {
        vcodec: "libx264",
        acodec: "aac",
        pixFmt: "yuv420p",
        container: "mp4",
      },
      output: {
        path: outputPath,
        fps: "30/1",
        width: 1920,
        height: 1080,
      },
    });
    expect(report.revision).toMatch(/^rev_\d{5}$/u);
    expect(report.sources.length).toBeGreaterThan(0);
    for (const source of report.sources) {
      expect(master.assets.find(({ id }) => id === source.assetId)?.sha256).toBe(source.sha256);
    }
    const outputBytes = await readFile(outputPath);
    expect(report.output.sha256).toBe(sha256(outputBytes));

    const derived = deriveTimeline(master, "seq_aaaaaaaaaa");
    expect(derived.ok).toBe(true);
    if (!derived.ok) throw derived.error;
    const expectedFrames = exactFrames(derived.value.duration, master.settings.timeline.fps);
    expect(report.output.durationFrames).toBe(expectedFrames);
    const probe = await probeMedia(outputPath);
    expect(probe.video).toMatchObject({
      codec: "h264",
      fps: "30/1",
      width: 1920,
      height: 1080,
      pixFmt: "yuv420p",
    });
    expect(probe.probe.duration).toEqual({ frames: expectedFrames, fps: "30/1" });
    expect(probe.container?.split(",")).toContain("mp4");

    const golden = JSON.parse(await readFile(
      join(REPOSITORY_ROOT, "packages/render/test/golden/ac001.golden.json"),
      "utf8",
    )) as GoldenManifest;
    for (const frame of golden.frames) {
      const actual = dhashFrame(outputPath, frame.at.frames);
      expect(
        hammingDistance(actual, frame.dhash),
        `${frame.reason}: expected ${frame.dhash}, received ${actual}`,
      ).toBeLessThanOrEqual(frame.maxDistance);
    }

    const journal = (await readFile(
      join(projectPath, "history/transactions.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line) as {
      id: string;
      operations: Array<{ op: string; summary: string }>;
    });
    expect(journal.every(({ id }) => /^txn_[a-z2-7]{10}$/u.test(id))).toBe(true);
    expect(journal.flatMap(({ operations }) => operations).every(({ summary }) =>
      summary.trim().length > 0
    )).toBe(true);
    expect(journal.slice(1).map(({ operations }) => operations.map(({ op }) => op))).toEqual([
      ["asset.ingest"],
      ["asset.ingest"],
      ["asset.ingest"],
      ["asset.ingest"],
      ["asset.ingest"],
      ["asset.ingest"],
      ["layer.enable"],
      ["layer.enable"],
      ["clip.trim"],
      ["clip.trim"],
      ["clip.split"],
      ["clip.move"],
      ["layer.disable"],
      ["layer.disable"],
    ]);
  } finally {
    await launched.electronApp.close();
  }
});
