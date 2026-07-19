import { useMemo, useState } from "react";

import type { Asset, TimeValue } from "../../../../core/src/index.js";
import type { JobStatus } from "../../shared/ipc.js";
import { errorMessage } from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

function assetName(asset: Asset): string {
  return asset.path.split(/[\\/]/u).at(-1) ?? asset.path;
}

function durationLabel(value: TimeValue | undefined): string {
  if (value === undefined) return "still";
  if ("samples" in value) return `${(value.samples / value.rate).toFixed(1)}s`;
  const [numerator = 1, denominator = 1] = value.fps.split("/").map(Number);
  return `${(value.frames * denominator / numerator).toFixed(1)}s`;
}

function jobState(jobs: JobStatus[], assetId: string, kind: string): JobStatus["state"] | null {
  return jobs.find((job) => job.kind === kind && job.title.includes(assetId))?.state ?? null;
}

function filePath(file: File): string | undefined {
  const candidate: unknown = file;
  if (typeof candidate !== "object" || candidate === null || !("path" in candidate)) return undefined;
  return typeof candidate.path === "string" && candidate.path.length > 0
    ? candidate.path
    : undefined;
}

export function MediaBrowserPanel({
  snapshot,
  refreshProject,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const jobs = useJobsStore((state) => state.jobs);
  const [kind, setKind] = useState<Asset["kind"] | "all">("all");
  const [path, setPath] = useState("");
  const assets = useMemo(() => (snapshot?.master.assets ?? [])
    .filter((asset) => kind === "all" || asset.kind === kind), [kind, snapshot]);

  async function ingest(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      const job = await window.guyditor.call<JobStatus>("MediaEngine", "ingest", { paths });
      setNotice(`Queued ${job.title}.`);
      setPath("");
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function pickAndIngest(): Promise<void> {
    try {
      const job = await window.guyditor.call<JobStatus | null>(
        "MediaEngine",
        "pickAndIngest",
        {},
      );
      setNotice(job === null ? "Import cancelled." : `Queued ${job.title}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <Panel
      id="media"
      title="Media"
      eyebrow="Assets / takes"
      actions={(
        <button type="button" data-testid="media-refresh" onClick={() => void refreshProject()}>
          Refresh
        </button>
      )}
    >
      <div
        className="ingest-drop"
        data-testid="media-drop-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const paths = [...event.dataTransfer.files].flatMap((file) => {
            const resolved = filePath(file);
            return resolved === undefined ? [] : [resolved];
          });
          if (paths.length === 0) setNotice("Dropped files did not expose local paths.");
          else void ingest(paths);
        }}
      >
        <button
          type="button"
          className="primary-action"
          data-testid="media-ingest-picker"
          onClick={() => void pickAndIngest()}
        >
          Import files
        </button>
        <span>or drop media here</span>
      </div>
      <div className="path-ingest">
        <input
          type="text"
          value={path}
          placeholder="Local path"
          aria-label="Media path"
          data-testid="ingest-path-input"
          onChange={(event) => setPath(event.target.value)}
        />
        <button
          type="button"
          data-testid="ingest-path-submit"
          disabled={path.trim() === "" || snapshot === null}
          onClick={() => void ingest([path.trim()])}
        >
          Add path
        </button>
      </div>
      <label className="filter-row">
        Kind
        <select
          value={kind}
          data-testid="media-kind-filter"
          onChange={(event) => setKind(event.target.value as Asset["kind"] | "all")}
        >
          {[
            "all", "video", "audio", "image", "animation", "subtitle", "generated", "other",
          ].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <ol className="asset-list" data-testid="asset-list">
        {assets.map((asset) => {
          const proxy = jobState(jobs, asset.id, "proxy.generate");
          const transcribe = jobState(jobs, asset.id, "transcribe");
          return (
            <li key={asset.id} data-testid={`asset-${asset.id}`}>
              <div className="asset-kind" data-kind={asset.kind}>{asset.kind.slice(0, 3)}</div>
              <div className="asset-copy">
                <strong>{assetName(asset)}</strong>
                <small>{asset.id} · {durationLabel(asset.probe.duration)}</small>
                <div className="chip-row">
                  <span className="state-chip" data-state={asset.integrity ?? "unknown"}>
                    integrity {asset.integrity ?? "unknown"}
                  </span>
                  {proxy === null ? null : (
                    <span className="state-chip" data-state={proxy} data-testid={`proxy-chip-${asset.id}`}>
                      proxy {proxy}
                    </span>
                  )}
                  {transcribe === null ? null : (
                    <span className="state-chip" data-state={transcribe} data-testid={`transcribe-chip-${asset.id}`}>
                      transcript {transcribe}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {assets.length === 0 ? <li className="empty-copy">No assets in this view.</li> : null}
      </ol>
    </Panel>
  );
}
