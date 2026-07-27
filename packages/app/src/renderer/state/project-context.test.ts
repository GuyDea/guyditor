import { describe, expect, it } from "vitest";

import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import type { ProjectSnapshot } from "../../shared/ipc.js";
import {
  deliverableNavigationContextKey,
  nextCycledId,
  projectDeliverableContextKey,
  projectSnapshotContextKey,
} from "./project-context.js";

function snapshot(
  projectPath = "/projects/alpha",
  revision = "rev_00001",
): ProjectSnapshot {
  const master = projectFixture();
  return {
    revision,
    master: { ...master, revision },
    sidecarIndex: [],
    projectPath,
  };
}

describe("project context", () => {
  it("keys project resources by both portable project path and revision", () => {
    expect(projectSnapshotContextKey(snapshot()))
      .not.toBe(projectSnapshotContextKey(snapshot("/projects/beta")));
    expect(projectSnapshotContextKey(snapshot()))
      .not.toBe(projectSnapshotContextKey(snapshot(
        "/projects/alpha",
        "rev_00002",
      )));
    expect(projectSnapshotContextKey(null)).toBeNull();
  });

  it("invalidates word navigation across deliverable and revision changes", () => {
    const current = snapshot();
    expect(deliverableNavigationContextKey(
      current,
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
      null,
    )).not.toBe(deliverableNavigationContextKey(
      current,
      "dlv_bbbbbbbbbb",
      "seq_bbbbbbbbbb",
      null,
    ));
    expect(deliverableNavigationContextKey(
      current,
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
      null,
    )).not.toBe(deliverableNavigationContextKey(
      snapshot("/projects/alpha", "rev_00002"),
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
      null,
    ));
  });

  it("invalidates navigation when another word is selected manually", () => {
    const current = snapshot();
    expect(deliverableNavigationContextKey(
      current,
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
      "wrd_aaaaaaaaaa",
    )).not.toBe(deliverableNavigationContextKey(
      current,
      "dlv_aaaaaaaaaa",
      "seq_aaaaaaaaaa",
      "wrd_bbbbbbbbbb",
    ));
  });

  it("distinguishes reused deliverable IDs across projects", () => {
    expect(projectDeliverableContextKey(
      snapshot("/projects/alpha"),
      "dlv_aaaaaaaaaa",
    )).not.toBe(projectDeliverableContextKey(
      snapshot("/projects/beta"),
      "dlv_aaaaaaaaaa",
    ));
  });

  it("cycles from no or out-of-scope selection without skipping an endpoint", () => {
    const ids = ["ann_aaaaaaaaaa", "ann_bbbbbbbbbb", "ann_cccccccccc"];
    expect(nextCycledId(ids, null, 1)).toBe("ann_aaaaaaaaaa");
    expect(nextCycledId(ids, "ann_dddddddddd", 1)).toBe("ann_aaaaaaaaaa");
    expect(nextCycledId(ids, null, -1)).toBe("ann_cccccccccc");
    expect(nextCycledId(ids, "ann_dddddddddd", -1)).toBe("ann_cccccccccc");
  });

  it("wraps an in-scope annotation selection in either direction", () => {
    const ids = ["ann_aaaaaaaaaa", "ann_bbbbbbbbbb", "ann_cccccccccc"];
    expect(nextCycledId(ids, "ann_cccccccccc", 1)).toBe("ann_aaaaaaaaaa");
    expect(nextCycledId(ids, "ann_aaaaaaaaaa", -1)).toBe("ann_cccccccccc");
  });
});
