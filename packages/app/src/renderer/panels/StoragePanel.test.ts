import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StorageReport } from "../../../../media/src/index.js";
import { useWorkspaceStore } from "../state/view-state.js";
import {
  StoragePanel,
  storageSafetyLabel,
} from "./StoragePanel.js";

const report: StorageReport = {
  scannedAt: "2026-07-23T12:00:00.000Z",
  projectDir: "/project",
  volumeFreeBytes: 20 * 1024 ** 3,
  volumeCapacityBytes: 100 * 1024 ** 3,
  categories: {
    sources: { bytes: 5_000_000, files: 1, reclaimable: false },
    generated: { bytes: 1_000_000, files: 1, reclaimable: false },
    "project-state": { bytes: 10_000, files: 8, reclaimable: false },
    proxies: { bytes: 2_000_000, files: 2, reclaimable: true },
    caches: { bytes: 500_000, files: 4, reclaimable: true },
    renders: { bytes: 3_000_000, files: 1, reclaimable: false },
    archives: { bytes: 20_000, files: 1, reclaimable: false },
    "jobs-db": { bytes: 30_000, files: 1, reclaimable: true },
    audit: { bytes: 40_000, files: 2, reclaimable: false },
  },
  externalSources: [],
  orphans: [{ path: "/project/.guyditor/cache/orphan.bin", bytes: 100 }],
};

describe("StoragePanel", () => {
  it("labels disposable, protected, and explicit-only classes without implying unsafe cleanup", () => {
    expect(storageSafetyLabel("proxies", true)).toBe("Safe to clean — regenerable");
    expect(storageSafetyLabel("sources", false)).toBe("Protected — load-bearing");
    expect(storageSafetyLabel("renders", false)).toBe("Explicit deletion only — reproducible export");
  });

  it("renders per-class byte totals, safety labels, orphan count, and archived asset state", () => {
    useWorkspaceStore.getInitialState().collapsed.storage = false;
    const html = renderToStaticMarkup(createElement(StoragePanel, {
      initialReport: report,
      initialArchivedStates: { ast_aaaaaaaaaa: "offline" },
      setNotice: () => undefined,
    }));

    expect(html).toContain('data-testid="storage-category-sources"');
    expect(html).toContain('data-testid="storage-category-proxies"');
    expect(html).toContain("5.0 MB");
    expect(html).toContain("2.0 MB");
    expect(html).toContain("Protected — load-bearing");
    expect(html).toContain("Safe to clean — regenerable");
    expect(html).toContain("1 orphan");
    expect(html).toContain("1 archived asset offline");
    expect(html).toContain('data-testid="storage-plan-cleanup"');
  });
});
