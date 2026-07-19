import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { AgentGateway, AuditLog, AC004_GATEWAY_TOOLS } from "../../../agent/src/index.js";
import { runStubDirector } from "../../../agent/test/stub-director/index.js";
import {
  openProject,
  parseAnnotationSidecar,
} from "../../../core/src/index.js";
import type { Result, TransactionRecord } from "../../../core/src/index.js";
import { launchApp } from "../helpers/launch-app.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

async function valueOf<Value>(result: Promise<Result<Value>>): Promise<Value> {
  const settled = await result;
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw settled.error;
  return settled.value;
}

test("AC-004 — reviews an exact-frame visual note through the real gateway", async () => {
  test.setTimeout(90_000);
  const launched = await launchApp({
    projectTemplate: join(REPOSITORY_ROOT, ".fixtures/projects/annotated"),
  });
  let gateway: AgentGateway | undefined;
  try {
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00001");

    await launched.page.getByTestId("annotation-seek-ann_aaaaaaaaaa").click();
    await expect(launched.page.getByTestId("preview-frame-input")).toHaveValue("90");
    await launched.page.getByTestId("preview-surface").click();
    await launched.page.keyboard.press("ArrowRight");
    await expect(launched.page.getByTestId("preview-frame-input")).toHaveValue("91");
    await launched.page.keyboard.press("ArrowLeft");
    await expect(launched.page.getByTestId("preview-frame-input")).toHaveValue("90");

    await launched.page.getByTestId("annotation-tool-arrow").click();
    await launched.page.getByTestId("annotation-body").fill("Point to the pacing problem");
    await launched.page.getByTestId("annotation-create-center").click();
    await expect(launched.page.getByTestId("annotation-list"))
      .toContainText("Point to the pacing problem");

    await launched.page.getByTestId("annotation-tool-rect").click();
    await launched.page.getByTestId("annotation-body").fill("Trim this annotated ending");
    await launched.page.getByTestId("annotation-create-center").click();
    await expect(launched.page.getByTestId("annotation-list"))
      .toContainText("Trim this annotated ending");
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00003");

    const projectPath = launched.projectPath;
    if (projectPath === undefined) throw new Error("AC-004 project was not copied.");
    const annotationsPath = join(projectPath, "sidecars/annotations.yaml");
    const drawn = parseAnnotationSidecar(await readFile(annotationsPath, "utf8"));
    const arrow = drawn.annotations.find(({ body }) => body === "Point to the pacing problem");
    const rectangle = drawn.annotations.find(({ body }) => body === "Trim this annotated ending");
    expect(arrow).toMatchObject({
      shape: "arrow",
      anchor: { kind: "timeline", frame: { frames: 90, fps: "30/1" } },
      geometry: {
        kind: "arrow",
        from: { x: 0.32, y: 0.65 },
        to: { x: 0.66, y: 0.35 },
      },
      state: "open",
    });
    expect(rectangle).toMatchObject({
      shape: "rect",
      anchor: { kind: "timeline", frame: { frames: 90, fps: "30/1" } },
      geometry: {
        kind: "rect",
        origin: { x: 0.34, y: 0.34 },
        size: { x: 0.32, y: 0.32 },
      },
      state: "open",
    });
    if (rectangle === undefined) throw new Error("Rectangle annotation was not persisted.");

    const acceptedBeforeProposal = await readFile(join(projectPath, "episode.guyditor.yaml"));
    const store = await valueOf(openProject(projectPath, { appVersion: "0.0.0-ac004" }));
    const userDirectory = join(launched.userDataDirectory, ".guyditor");
    const audit = new AuditLog({ userDir: userDirectory });
    gateway = new AgentGateway({
      auditLog: audit,
      project: store,
      stateDirectory: join(userDirectory, "state"),
      director: {
        profileId: "adp_bbbbbbbbbb",
        modelLabel: "ac004-scripted-no-model",
        locality: "local",
      },
    });
    const started = await gateway.start();
    const stub = await runStubDirector({
      annotationId: rectangle.id,
      clipId: "clp_aaaaaaaaaa",
      gatewayStateFile: started.stateFile,
      trimFrames: 2,
    });
    expect(stub.tools).toEqual([...AC004_GATEWAY_TOOLS].sort());
    expect(stub.context).toMatchObject({
      annotation: { id: rectangle.id, body: "Trim this annotated ending" },
      position: { timelineFrame: { frames: 90, fps: "30/1" } },
    });
    expect(stub.status).toMatchObject({
      id: stub.proposal.id,
      status: "ready",
      addresses: [rectangle.id],
      operations: [{ op: "clip.trim" }],
    });
    await gateway.close();
    gateway = undefined;

    expect(await readFile(join(projectPath, "episode.guyditor.yaml")))
      .toEqual(acceptedBeforeProposal);
    await launched.page.getByTestId("proposal-refresh").click();
    await expect(launched.page.getByTestId(`proposal-${stub.proposal.id}`)).toBeVisible();
    await expect(launched.page.getByTestId(`proposal-diff-${stub.proposal.id}`))
      .toContainText("Trim");
    const comparison = launched.page.getByTestId(`proposal-preview-${stub.proposal.id}`);
    await expect(comparison).toBeDisabled();
    await expect(comparison).toHaveAttribute("title", "Comparison rendering is M2");

    await launched.page.getByTestId(`proposal-accept-${stub.proposal.id}`).click();
    await expect(launched.page.getByTestId("revision-indicator")).toHaveText("rev_00004");
    await expect(launched.page.getByTestId("proposal-list")).toContainText("No open proposals");

    const journal = (await readFile(
      join(projectPath, "history/transactions.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line) as TransactionRecord);
    const accepted = journal.at(-1);
    expect(accepted).toMatchObject({
      baseRevision: "rev_00003",
      resultRevision: "rev_00004",
      instruction: { kind: "annotation", annotation: rectangle.id },
      acceptance: { status: "accepted", proposal: stub.proposal.id },
      addresses: [rectangle.id],
      operations: [
        { op: "clip.trim" },
        { op: "annotation.resolve", params: { annotationId: rectangle.id } },
      ],
    });
    expect(accepted?.id).toMatch(/^txn_[a-z2-7]{10}$/u);

    const resolved = parseAnnotationSidecar(await readFile(annotationsPath, "utf8"))
      .annotations.find(({ id }) => id === rectangle.id);
    expect(resolved).toMatchObject({
      state: "resolved",
      resolvedBy: { revision: "rev_00004", txnId: accepted?.id },
    });

    if (stub.proposal.sessionId === undefined) {
      throw new Error("Gateway proposal did not retain its audit session ID.");
    }
    const auditReplay = audit.readSession(stub.proposal.sessionId);
    expect(auditReplay.warnings).toEqual([]);
    expect(auditReplay.records.filter(({ type }) => type === "tool.call").map((record) =>
      record.type === "tool.call" ? record.tool : ""
    )).toEqual(["context_package", "proposal_create", "proposal_get"]);
    expect(auditReplay.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "proposal.created", proposalId: stub.proposal.id }),
      expect.objectContaining({
        type: "proposal.outcome",
        proposalId: stub.proposal.id,
        outcome: "accepted",
        revision: "rev_00004",
      }),
    ]));
  } finally {
    await gateway?.close();
    await launched.electronApp.close();
  }
});
