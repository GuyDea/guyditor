import { describe, expect, it } from "vitest";

import type {
  Deliverable,
  PublishMetadataDocument,
} from "../../../../core/src/index.js";
import {
  batchIdsForProject,
  beginPublishRequest,
  contextualValue,
  createPublishBatchState,
  createPublishMetadataState,
  createPublishRequestGates,
  editPublishMetadata,
  invalidatePublishRequest,
  isPublishRequestCurrent,
  publishContextKey,
  publishMetadataForContext,
  publishRequestKeys,
  reconcilePublishBatch,
  reconcilePublishMetadata,
  replacePublishMetadata,
  valueForContext,
} from "./publish-runtime.js";

function metadata(
  title: string,
  status: PublishMetadataDocument["status"] = "draft",
): PublishMetadataDocument {
  return {
    format: "guyditor-publish/v1",
    deliverableId: "dlv_aaaaaaaaaa",
    profile: "youtube-longform@1.0.0",
    language: "en",
    title,
    description: `${title} description`,
    tags: [],
    hashtags: [],
    status,
  };
}

function deliverable(
  id: string,
  status: Deliverable["status"],
): Deliverable {
  return {
    id,
    kind: "longform",
    name: id,
    profile: "youtube-longform@1.0.0",
    sequenceId: "seq_aaaaaaaaaa",
    status,
  };
}

describe("publish context runtime", () => {
  it("keeps unrelated resource generations independent and keys batch work to the project", () => {
    const contextA = publishContextKey("/project-a", "dlv_aaaaaaaaaa");
    const contextB = publishContextKey("/project-a", "dlv_bbbbbbbbbb");
    const keysA = publishRequestKeys(
      "/project-a",
      contextA,
      JSON.stringify([contextA, "relative", false]),
    );
    const keysB = publishRequestKeys(
      "/project-a",
      contextB,
      JSON.stringify([contextB, "absolute", true]),
    );
    const gates = createPublishRequestGates();
    const metadata = beginPublishRequest(gates, "metadata", keysA.metadata!);
    const chapters = beginPublishRequest(gates, "chapters", keysA.chapters!);
    const output = beginPublishRequest(gates, "output", keysA.output!);
    const otio = beginPublishRequest(gates, "otio", keysA.otio!);
    const batch = beginPublishRequest(gates, "batch", keysA.batch!);

    expect(isPublishRequestCurrent(gates, "metadata", metadata, keysA.metadata))
      .toBe(true);
    expect(isPublishRequestCurrent(gates, "chapters", chapters, keysA.chapters))
      .toBe(true);
    expect(isPublishRequestCurrent(gates, "output", output, keysA.output))
      .toBe(true);
    expect(isPublishRequestCurrent(gates, "otio", otio, keysA.otio)).toBe(true);
    expect(isPublishRequestCurrent(gates, "batch", batch, keysB.batch)).toBe(true);
    expect(isPublishRequestCurrent(gates, "metadata", metadata, keysB.metadata))
      .toBe(false);
    expect(isPublishRequestCurrent(gates, "otio", otio, keysB.otio)).toBe(false);

    beginPublishRequest(gates, "thumbnail", keysB.thumbnail!);
    expect(isPublishRequestCurrent(gates, "chapters", chapters, keysA.chapters))
      .toBe(true);
    const newerMetadata = beginPublishRequest(
      gates,
      "metadata",
      keysA.metadata!,
    );
    expect(isPublishRequestCurrent(gates, "metadata", metadata, keysA.metadata))
      .toBe(false);
    expect(isPublishRequestCurrent(
      gates,
      "metadata",
      newerMetadata,
      keysA.metadata,
    )).toBe(true);
    invalidatePublishRequest(gates, "metadata");
    expect(isPublishRequestCurrent(
      gates,
      "metadata",
      newerMetadata,
      keysA.metadata,
    ))
      .toBe(false);
    expect(isPublishRequestCurrent(gates, "chapters", chapters, keysA.chapters))
      .toBe(true);
  });

  it("keeps an edit made while save is deferred dirty and suppresses the stale save result and notice", async () => {
    const key = publishContextKey("/project-a", "dlv_aaaaaaaaaa");
    const gates = createPublishRequestGates();
    let state = createPublishMetadataState(key, metadata("A"));
    const notices: string[] = [];
    let resolveSave!: (value: PublishMetadataDocument) => void;
    const save = new Promise<PublishMetadataDocument>((resolve) => {
      resolveSave = resolve;
    });
    const request = beginPublishRequest(gates, "metadata", key);
    const completion = save.then((saved) => {
      if (!isPublishRequestCurrent(gates, "metadata", request, key)) return;
      state = replacePublishMetadata(state, key, saved);
      notices.push("Save metadata ready.");
    });

    invalidatePublishRequest(gates, "metadata");
    state = editPublishMetadata(state, key, metadata("B"));
    resolveSave(metadata("Saved A"));
    await completion;

    expect(state).toMatchObject({
      contextKey: key,
      dirty: true,
      value: { title: "B" },
    });
    expect(notices).toEqual([]);
  });

  it("preserves dirty metadata across same-context refreshes and syncs clean approvals", () => {
    const key = publishContextKey("/project-a", "dlv_aaaaaaaaaa");
    let state = createPublishMetadataState(key, metadata("Canonical"));
    state = editPublishMetadata(state, key, metadata("Local edit"));
    state = reconcilePublishMetadata(state, key, metadata("Unrelated refresh"));

    expect(state.dirty).toBe(true);
    expect(publishMetadataForContext(state, key, null)?.title).toBe("Local edit");

    state = replacePublishMetadata(state, key, metadata("Saved"));
    state = reconcilePublishMetadata(state, key, metadata("Saved", "approved"));
    expect(state.dirty).toBe(false);
    expect(publishMetadataForContext(state, key, null)?.status).toBe("approved");
  });

  it("never exposes metadata or OTIO results across projects with the same deliverable IDs", () => {
    const projectA = publishContextKey("/project-a", "dlv_aaaaaaaaaa");
    const projectB = publishContextKey("/project-b", "dlv_aaaaaaaaaa");
    const stateA = editPublishMetadata(
      createPublishMetadataState(projectA, metadata("Project A")),
      projectA,
      metadata("Unsaved A"),
    );

    expect(publishMetadataForContext(stateA, projectB, metadata("Project B"))?.title)
      .toBe("Project B");

    const lossesA = contextualValue(projectA, [{ construct: "A" }]);
    expect(valueForContext(lossesA, projectA)).toEqual([{ construct: "A" }]);
    expect(valueForContext(lossesA, projectB)).toBeNull();
  });

  it("preserves valid batch choices within a project and resets to approvals on project change", () => {
    const approvedA = deliverable("dlv_aaaaaaaaaa", "approved");
    const draftB = deliverable("dlv_bbbbbbbbbb", "draft");
    let state = createPublishBatchState("/project-a", [approvedA, draftB]);
    state = { ...state, ids: [draftB.id] };
    state = reconcilePublishBatch(state, "/project-a", [draftB]);
    expect(batchIdsForProject(state, "/project-a", [draftB])).toEqual([draftB.id]);

    const approvedC = deliverable("dlv_cccccccccc", "approved");
    expect(batchIdsForProject(state, "/project-b", [approvedC])).toEqual([approvedC.id]);
    state = reconcilePublishBatch(state, "/project-b", [approvedC]);
    expect(state).toEqual({ projectPath: "/project-b", ids: [approvedC.id] });
  });
});
