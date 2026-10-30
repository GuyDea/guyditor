import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  Asset,
  TakeComparison,
  TakeMarkerSidecar,
  TimeValue,
  WatchFolderConfig,
} from "../../../../core/src/index.js";
import type { JobStatus } from "../../shared/ipc.js";
import { sectionHelpKey } from "../help/help-texts.js";
import { errorMessage } from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import { usePreviewStore, useSelectionStore } from "../state/view-state.js";
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

export function MediaBrowserPanel({
  snapshot,
  transcripts,
  refreshProject,
  refreshProposals,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const jobs = useJobsStore((state) => state.jobs);
  const [kind, setKind] = useState<Asset["kind"] | "all">("all");
  const [path, setPath] = useState("");
  const [takeSidecars, setTakeSidecars] = useState<TakeMarkerSidecar[]>([]);
  const [takeComparisons, setTakeComparisons] = useState<TakeComparison[]>([]);
  const [selectedTakes, setSelectedTakes] = useState<string[]>([]);
  const [watchPath, setWatchPath] = useState("");
  const [watchConvention, setWatchConvention] = useState<"guyditor" | "flat">("guyditor");
  const [watchJobs, setWatchJobs] = useState({ proxy: true, analysis: true, transcription: true });
  const [pickupPath, setPickupPath] = useState("");
  const [pickupSlug, setPickupSlug] = useState("correction");
  const [pickupTargetAsset, setPickupTargetAsset] = useState("");
  const [pickupAsset, setPickupAsset] = useState("");
  const [pickupFromWord, setPickupFromWord] = useState("");
  const [pickupToWord, setPickupToWord] = useState("");
  const assets = useMemo(() => (snapshot?.master.assets ?? [])
    .filter((asset) => kind === "all" || asset.kind === kind), [kind, snapshot]);
  const setPlayhead = usePreviewStore((state) => state.setPlayhead);
  const selectWord = useSelectionStore((state) => state.selectWord);
  const setWordRange = useSelectionStore((state) => state.setWordRange);
  const watchFolders = snapshot?.master.watchFolders ?? [];
  const pickupPrompt = useMemo(() => {
    const sidecar = transcripts.find(({ assetId }) => assetId === pickupTargetAsset);
    if (sidecar === undefined) return undefined;
    const ordered = sidecar.segments.flatMap(({ words }) => words);
    const from = ordered.indexOf(pickupFromWord);
    const to = ordered.indexOf(pickupToWord);
    if (from === -1 || to < from) return undefined;
    const context = ordered.slice(Math.max(0, from - 6), Math.min(ordered.length, to + 7));
    return context.map((wordId) => ({
      wordId,
      text: sidecar.words[wordId]?.text ?? "",
      target: ordered.indexOf(wordId) >= from && ordered.indexOf(wordId) <= to,
    }));
  }, [pickupFromWord, pickupTargetAsset, pickupToWord, transcripts]);

  const refreshTakes = useCallback(async (): Promise<void> => {
    try {
      const [takes, comparisons] = await Promise.all([
        window.guyditor.call<TakeMarkerSidecar[]>("CaptureWatcher", "listTakes", {}),
        window.guyditor.call<TakeComparison[]>("CaptureWatcher", "listTakeComparisons", {}),
      ]);
      setTakeSidecars(takes);
      setTakeComparisons(comparisons);
    } catch {
      setTakeSidecars([]);
      setTakeComparisons([]);
    }
  }, []);

  useEffect(() => {
    if (snapshot === null) {
      setTakeSidecars([]);
      setTakeComparisons([]);
      setSelectedTakes([]);
    }
    else void refreshTakes();
  }, [refreshTakes, snapshot?.revision]);

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

  async function configureWatchFolders(next: WatchFolderConfig[]): Promise<void> {
    try {
      await window.guyditor.call("CaptureWatcher", "configure", { watchFolders: next });
      await refreshProject();
      setNotice(`Watching ${String(next.length)} capture folder${next.length === 1 ? "" : "s"}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function addWatchFolder(): Promise<void> {
    const folder = watchPath.trim();
    if (folder === "") return;
    const next = watchFolders.filter(({ path: configured }) => configured !== folder);
    next.push({
      path: folder,
      convention: watchConvention,
      autoIngest: true,
      autoJobs: watchJobs,
    });
    await configureWatchFolders(next);
    setWatchPath("");
  }

  async function importPickup(): Promise<void> {
    try {
      const imported = await window.guyditor.call<{ path: string; job: JobStatus }>(
        "MediaEngine",
        "importPickup",
        { path: pickupPath.trim(), slug: pickupSlug.trim() },
      );
      setPickupPath("");
      setNotice(`Imported immutable pickup to ${imported.path}; transcription is queued.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function proposePickup(): Promise<void> {
    try {
      const result = await window.guyditor.call<{ proposal?: { id: string }; message?: string }>(
        "TranscriptEngine",
        "proposePickup",
        {
          targetAssetId: pickupTargetAsset,
          pickupAssetId: pickupAsset,
          fromWord: pickupFromWord,
          toWord: pickupToWord,
          roomTonePaddingMs: 120,
        },
      );
      await Promise.all([refreshProject(), refreshProposals()]);
      setNotice(result.proposal === undefined
        ? result.message ?? "Pickup needs alignment review before a proposal can be created."
        : `Prepared pickup proposal ${result.proposal.id}; the accepted timeline is unchanged.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function compareSelectedTakes(): Promise<void> {
    try {
      const comparisons = await window.guyditor.call<TakeComparison[]>(
        "CaptureWatcher",
        "compareTakes",
        { takeIds: selectedTakes },
      );
      setTakeComparisons((current) => [
        ...comparisons,
        ...current.filter(({ id }) => !comparisons.some((comparison) => comparison.id === id)),
      ]);
      setSelectedTakes([]);
      await refreshProject();
      setNotice(`Compared ${String(comparisons.reduce((sum, comparison) => sum + comparison.candidates.length, 0))} transcript-similar takes.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function proposeTakeSelection(comparisonId: string, takeId: string): Promise<void> {
    try {
      const proposal = await window.guyditor.call<{ id: string }>(
        "CaptureWatcher",
        "selectTake",
        { comparisonId, takeId },
      );
      await refreshProposals();
      setNotice(`Prepared ${proposal.id} to select ${takeId}; every alternative remains accessible.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function jumpToCandidate(comparison: TakeComparison, takeId: string): void {
    const candidate = comparison.candidates.find(({ takeId: id }) => id === takeId);
    if (candidate === undefined) return;
    setPlayhead(candidate.sourceRange.in);
    if (comparison.slot.wordRange !== undefined) {
      selectWord(comparison.slot.wordRange.fromWord);
      setWordRange(comparison.slot.wordRange);
    }
  }

  return (
    <Panel
      id="media"
      title="Media"
      eyebrow="Assets / takes"
      actions={<>
        <button
          type="button"
          className="primary-action"
          data-testid="take-comparison-trigger"
          disabled={selectedTakes.length < 2}
          onClick={() => void compareSelectedTakes()}
        >Compare {selectedTakes.length < 2 ? "takes" : String(selectedTakes.length)}</button>
        <button type="button" data-testid="media-refresh" onClick={() => void refreshProject()}>
          Refresh
        </button>
      </>}
    >
      <div
        className="ingest-drop"
        data-testid="media-drop-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (snapshot === null) return;
          const paths = [...event.dataTransfer.files].flatMap((file) => {
            const resolved = window.guyditor.pathForFile(file);
            return resolved === "" ? [] : [resolved];
          });
          if (paths.length === 0) setNotice("Dropped files did not expose local paths.");
          else void ingest(paths);
        }}
      >
        <button
          type="button"
          className="primary-action"
          data-testid="media-ingest-picker"
          disabled={snapshot === null}
          onClick={() => void pickAndIngest()}
        >
          Import files
        </button>
        {snapshot === null
          ? <span className="empty-copy">Open a project to import media.</span>
          : <span>or drop media here</span>}
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
      <details className="capture-panel" data-testid="watch-folder-panel">
        <summary data-help={sectionHelpKey("media", "Capture watcher")}>Capture watcher <span>{String(watchFolders.length)}</span></summary>
        <p>Stable recordings are grouped into sessions, ingested, and chained into visible background jobs.</p>
        <div className="path-ingest">
          <input
            type="text"
            value={watchPath}
            placeholder="Watch-folder path"
            aria-label="Watch-folder path"
            data-testid="watch-folder-path"
            onChange={(event) => setWatchPath(event.target.value)}
          />
          <select
            aria-label="Capture naming convention"
            value={watchConvention}
            data-testid="watch-folder-convention"
            onChange={(event) => setWatchConvention(event.target.value as "guyditor" | "flat")}
          >
            <option value="guyditor">Guyditor naming</option>
            <option value="flat">Flat / per day</option>
          </select>
        </div>
        <div className="capture-options">
          {(["proxy", "analysis", "transcription"] as const).map((job) => (
            <label key={job}>
              <input
                type="checkbox"
                checked={watchJobs[job]}
                onChange={(event) => setWatchJobs({ ...watchJobs, [job]: event.target.checked })}
              />
              {job}
            </label>
          ))}
        </div>
        <button
          type="button"
          className="primary-action"
          data-testid="watch-folder-add"
          disabled={watchPath.trim() === "" || snapshot === null}
          onClick={() => void addWatchFolder()}
        >Add watcher</button>
        <ul className="watch-folder-list">
          {watchFolders.map((folder) => (
            <li key={folder.path}>
              <span><strong>{folder.path}</strong><small>{folder.convention} · ingest {folder.autoIngest ? "on" : "off"}</small></span>
              <button
                type="button"
                aria-label={`Remove watcher ${folder.path}`}
                onClick={() => void configureWatchFolders(watchFolders.filter(({ path: candidate }) => candidate !== folder.path))}
              >Remove</button>
            </li>
          ))}
        </ul>
      </details>
      <details className="capture-panel pickup-panel" data-testid="pickup-wizard">
        <summary data-help={sectionHelpKey("media", "Pickup repair")}>Pickup repair <span>import</span></summary>
        <p>Record on your usual rig with about 1 s of room tone on each side, then import the corrective line.</p>
        <div className="path-ingest">
          <input type="text" aria-label="Pickup file path" placeholder="Corrective recording path" value={pickupPath} data-testid="pickup-path" onChange={(event) => setPickupPath(event.target.value)} />
          <input type="text" aria-label="Pickup slug" placeholder="slug" value={pickupSlug} onChange={(event) => setPickupSlug(event.target.value)} />
          <button type="button" data-testid="pickup-import" disabled={pickupPath.trim() === "" || pickupSlug.trim() === "" || snapshot === null} onClick={() => void importPickup()}>Import</button>
        </div>
        <div className="pickup-grid">
          <input type="text" aria-label="Original asset ID" placeholder="Original asset ID" value={pickupTargetAsset} onChange={(event) => setPickupTargetAsset(event.target.value)} />
          <input type="text" aria-label="Pickup asset ID" placeholder="Pickup asset ID after ingest" value={pickupAsset} onChange={(event) => setPickupAsset(event.target.value)} />
          <input type="text" aria-label="First flawed word ID" placeholder="From w000000" value={pickupFromWord} onChange={(event) => setPickupFromWord(event.target.value)} />
          <input type="text" aria-label="Last flawed word ID" placeholder="To w000000" value={pickupToWord} onChange={(event) => setPickupToWord(event.target.value)} />
        </div>
        {pickupPrompt === undefined ? null : (
          <blockquote className="pickup-prompt" data-testid="pickup-teleprompter">
            {pickupPrompt.map(({ wordId, text, target }) => (
              <span key={wordId} data-target={target}>{text} </span>
            ))}
          </blockquote>
        )}
        <button
          type="button"
          className="primary-action"
          data-testid="pickup-propose"
          disabled={[pickupTargetAsset, pickupAsset, pickupFromWord, pickupToWord].some((value) => value.trim() === "")}
          onClick={() => void proposePickup()}
        >Transcribe, align &amp; propose splice</button>
        <small>File import is supported here. In-app recording and synthetic voice are intentionally not available.</small>
      </details>
      {takeComparisons.length === 0 ? null : (
        <section className="take-comparison-list" data-testid="take-comparisons">
          <header>
            <strong>Take comparison</strong>
            <span>Measured delivery + technical QC + creator rubric</span>
          </header>
          {takeComparisons.map((comparison) => (
            <article key={comparison.id} data-testid={`take-comparison-${comparison.id}`}>
              <div className="take-comparison-heading">
                <span>
                  <strong>{comparison.slot.scriptSection ?? comparison.id}</strong>
                  <small>{comparison.id} · all {String(comparison.candidates.length)} takes retained</small>
                </span>
                {comparison.recommendation === undefined ? null : (
                  <span className="state-chip" data-state="ready">
                    recommend {comparison.recommendation.takeId}
                  </span>
                )}
              </div>
              <div className="comparison-table-scroll">
                <table className="take-metric-table">
                  <thead><tr>
                    <th>Take</th><th>WPM</th><th>Silence</th><th>Fillers</th>
                    <th>Loudness var.</th><th>Restarts</th><th>Clipping</th>
                    <th>Noise floor</th><th>Preference</th><th>Review</th>
                  </tr></thead>
                  <tbody>
                    {comparison.candidates.map((candidate) => (
                      <tr
                        key={candidate.takeId}
                        data-recommended={comparison.recommendation?.takeId === candidate.takeId}
                      >
                        <th>{candidate.takeId}</th>
                        <td>{candidate.delivery.wordsPerMinute.toFixed(1)}</td>
                        <td>{(candidate.delivery.pauseRatio * 100).toFixed(1)}%</td>
                        <td>{candidate.delivery.fillerCount}</td>
                        <td>{candidate.delivery.energyVariance.toFixed(3)}</td>
                        <td>{candidate.delivery.restartCount}</td>
                        <td>{candidate.technical.audioClippingPct.toFixed(2)}%</td>
                        <td>{candidate.technical.noiseFloorDb.toFixed(1)} dB</td>
                        <td>{candidate.preference.score.toFixed(3)}</td>
                        <td>
                          <button type="button" onClick={() => jumpToCandidate(comparison, candidate.takeId)}>Jump</button>
                          <button
                            type="button"
                            className="primary-action"
                            disabled={comparison.selectedTakeId === candidate.takeId}
                            onClick={() => void proposeTakeSelection(comparison.id, candidate.takeId)}
                          >{comparison.selectedTakeId === candidate.takeId ? "Selected" : "Select"}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {comparison.recommendation === undefined ? null : (
                <div className="take-recommendation">
                  <strong>Reason · {comparison.recommendation.confidence} confidence</strong>
                  <ul>{comparison.recommendation.reasons.map((reason) => (
                    <li key={`${reason.criterion}-${reason.evidence}`}>
                      <strong>{reason.criterion}</strong> {reason.detail}
                      <small>{reason.evidence}</small>
                    </li>
                  ))}</ul>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
      <ol className="asset-list" data-testid="asset-list">
        {assets.map((asset) => {
          const proxy = jobState(jobs, asset.id, "proxy.generate");
          const transcribe = jobState(jobs, asset.id, "transcribe");
          const takes = takeSidecars.find(({ assetId }) => assetId === asset.id);
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
                {takes === undefined ? null : (
                  <details className="take-browser" data-testid={`takes-${asset.id}`}>
                    <summary>{String(takes.takes.length)} takes · {String(takes.markers.length)} markers</summary>
                    <ol>
                      {takes.takes.map((take) => (
                        <li key={take.id}>
                          <input
                            type="checkbox"
                            aria-label={`Include ${take.id} in comparison`}
                            checked={selectedTakes.includes(take.id)}
                            onChange={() => setSelectedTakes((current) => current.includes(take.id)
                              ? current.filter((id) => id !== take.id)
                              : [...current, take.id])}
                          />
                          <strong>T{String(take.index).padStart(2, "0")}</strong>
                          <span>{take.quality} · {String(take.range.start)}–{String(take.range.end)}f</span>
                          {take.notes.length === 0 ? null : <small>{take.notes.join(" · ")}</small>}
                        </li>
                      ))}
                    </ol>
                    {takes.markers.filter(({ detected }) => detected === true).map((marker) => (
                      <button
                        key={marker.id}
                        type="button"
                        className="spoken-marker"
                        title="Detected transcript marker; metadata only"
                      >{marker.note ?? "spoken marker"} · dismiss in metadata</button>
                    ))}
                  </details>
                )}
              </div>
            </li>
          );
        })}
        {assets.length === 0 ? <li className="empty-copy">No assets in this view.</li> : null}
      </ol>
    </Panel>
  );
}
