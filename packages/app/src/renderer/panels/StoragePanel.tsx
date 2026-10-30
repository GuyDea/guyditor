import { useState } from "react";

import type {
  CleanupPlan,
  StorageCategory,
  StorageReport,
} from "../../../../media/src/index.js";
import { sectionHelpKey } from "../help/help-texts.js";
import { errorMessage } from "../ipc.js";
import { Panel } from "./Panel.js";

const CATEGORY_ORDER: readonly StorageCategory[] = [
  "sources",
  "generated",
  "project-state",
  "proxies",
  "caches",
  "renders",
  "archives",
  "jobs-db",
  "audit",
];

const CLEANABLE: readonly StorageCategory[] = ["proxies", "caches", "jobs-db"];

interface StoragePanelProps {
  initialReport?: StorageReport | null;
  initialArchivedStates?: Record<string, "offline" | "restored">;
  setNotice: (notice: string) => void;
}

export function storageSafetyLabel(
  category: StorageCategory,
  reclaimable: boolean,
): string {
  if (reclaimable) return "Safe to clean — regenerable";
  if (category === "renders") return "Explicit deletion only — reproducible export";
  return "Protected — load-bearing";
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1_000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function StoragePanel({
  initialReport = null,
  initialArchivedStates = {},
  setNotice,
}: StoragePanelProps): React.JSX.Element {
  const [report, setReport] = useState<StorageReport | null>(initialReport);
  const [archivedStates, setArchivedStates] = useState(initialArchivedStates);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [busy, setBusy] = useState(false);

  async function scan(): Promise<void> {
    setBusy(true);
    try {
      const [nextReport, nextStates] = await Promise.all([
        window.guyditor.call<StorageReport>("BackupService", "scan", {}),
        window.guyditor.call<Record<string, "offline" | "restored">>(
          "BackupService",
          "archiveStates",
          {},
        ),
      ]);
      setReport(nextReport);
      setArchivedStates(nextStates);
      setPlan(null);
      setNotice(`Storage scan completed at ${nextReport.scannedAt}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function planCleanup(): Promise<void> {
    setBusy(true);
    try {
      const next = await window.guyditor.call<CleanupPlan>("BackupService", "planCleanup", {
        categories: CLEANABLE,
      });
      setPlan(next);
      setNotice(`Review ${String(next.items.length)} disposable items before cleanup.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function executeCleanup(): Promise<void> {
    if (plan === null) return;
    setBusy(true);
    try {
      await window.guyditor.call("BackupService", "executeCleanup", { plan });
      setPlan(null);
      await scan();
      setNotice(`Cleaned ${formatStorageBytes(plan.totalBytes)} of verified disposable data.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
      setBusy(false);
    }
  }

  const offlineCount = Object.values(archivedStates).filter((state) => state === "offline").length;
  return (
    <Panel
      id="storage"
      title="Storage & recovery"
      eyebrow="Accounted / protected"
      actions={<button type="button" disabled={busy} onClick={() => void scan()}>Scan</button>}
    >
      {report === null ? <p>Run a scan to account for project and global storage.</p> : (
        <>
          <div className="storage-summary">
            <strong>{formatStorageBytes(report.volumeFreeBytes)} free</strong>
            <span>{String(report.orphans.length)} orphan{report.orphans.length === 1 ? "" : "s"}</span>
            <span>{String(offlineCount)} archived asset{offlineCount === 1 ? "" : "s"} offline</span>
          </div>
          <ol className="storage-categories">
            {CATEGORY_ORDER.map((category) => {
              const value = report.categories[category];
              return (
                <li key={category} data-testid={`storage-category-${category}`}>
                  <span><strong>{category}</strong><small>{String(value.files)} files</small></span>
                  <span><strong>{formatStorageBytes(value.bytes)}</strong><small>{storageSafetyLabel(category, value.reclaimable)}</small></span>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            data-testid="storage-plan-cleanup"
            disabled={busy}
            onClick={() => void planCleanup()}
          >Plan safe cleanup</button>
        </>
      )}
      {plan === null ? null : (
        <section className="cleanup-review" data-testid="storage-cleanup-review">
          <h3 data-help={sectionHelpKey("storage", "Cleanup review")}>Cleanup review</h3>
          <p>{String(plan.items.length)} verified regenerable items · {formatStorageBytes(plan.totalBytes)}</p>
          <button type="button" disabled={busy} onClick={() => void executeCleanup()}>
            Delete planned disposable files
          </button>
          <button type="button" disabled={busy} onClick={() => setPlan(null)}>Keep files</button>
        </section>
      )}
    </Panel>
  );
}
