import { useEffect, useMemo, useState } from "react";

import type { Deliverable, PublishMetadataDocument } from "../../../../core/src/index.js";
import type { PlatformProfile } from "../../../../deliver/src/index.js";
import { errorMessage } from "../ipc.js";
import { useSelectionStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

function codePoints(value: string): number {
  return [...value].length;
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function outputContents(deliverable: Deliverable): string[] {
  const common = ["video.burned.mp4", "video.clean.mp4", "subtitles.srt", "subtitles.vtt", "metadata.yaml", "transcript.txt", "export-report.json"];
  return deliverable.kind === "short"
    ? [...common, "covers/cover-01..06.jpg"]
    : [...common, "thumbnail.png", "chapters.txt"];
}

export function PublishPanel({ snapshot, refreshProject, refreshExportReport, setNotice }: WorkspacePanelProps): React.JSX.Element {
  const selectedId = useSelectionStore((state) => state.selectedDeliverableId);
  const selectDeliverable = useSelectionStore((state) => state.selectDeliverable);
  const deliverables = snapshot?.master.deliverables ?? [];
  const deliverable = deliverables.find(({ id }) => id === selectedId) ??
    deliverables.find(({ id }) => id === snapshot?.master.settings.primaryDeliverable) ??
    deliverables[0];
  const [profiles, setProfiles] = useState<PlatformProfile[]>([]);
  const [metadata, setMetadata] = useState<PublishMetadataDocument | null>(
    deliverable?.publish?.metadata ?? null,
  );
  const [batchIds, setBatchIds] = useState<string[]>(() => deliverables
    .filter(({ status }) => status === "approved")
    .map(({ id }) => id));
  const [buildKits, setBuildKits] = useState(true);
  const profile = profiles.find(({ id, version }) => `${id}@${version}` === deliverable?.profile);

  useEffect(() => {
    void window.guyditor.call<PlatformProfile[]>("DeliverableService", "profiles", {})
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    setMetadata(deliverable?.publish?.metadata ?? null);
  }, [deliverable]);

  const counts = useMemo(() => ({
    title: codePoints(metadata?.title ?? ""),
    description: codePoints(metadata?.description ?? ""),
    tags: metadata?.tags.reduce((total, tag) => total + codePoints(tag), 0) ?? 0,
    hashtags: metadata?.hashtags.length ?? 0,
  }), [metadata]);

  async function run(label: string, action: () => Promise<unknown>): Promise<void> {
    setNotice(`${label}…`);
    try {
      await action();
      await Promise.all([refreshProject(), refreshExportReport()]);
      setNotice(`${label} ready.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function edit<Key extends keyof PublishMetadataDocument>(key: Key, value: PublishMetadataDocument[Key]): void {
    setMetadata((current) => current === null ? current : { ...current, [key]: value });
  }

  if (snapshot === null || deliverable === undefined) {
    return <Panel id="publish" eyebrow="M3 · packaging" title="Publish"><p className="empty-copy">Open a project to assemble output sets.</p></Panel>;
  }

  const titleLimit = profile?.metadata.title?.maxChars;
  const descriptionLimit = profile?.metadata.description.maxChars;
  const tagLimit = profile?.metadata.tags?.totalMaxChars;
  const hashtagLimit = profile?.metadata.hashtags?.maxCount;
  const chapters = deliverable.publish?.chapters;
  const candidates = deliverable.kind === "short"
    ? Array.from({ length: 6 }, (_, index) => ({ id: `cover-${String(index + 1).padStart(2, "0")}`, label: `Cover ${String(index + 1).padStart(2, "0")}` }))
    : [
        { id: "frame-01", label: "Candidate frame" },
        { id: "keyed-cutout", label: "Keyed cutout" },
        { id: "template-title", label: "Template title" },
      ];

  return (
    <Panel
      id="publish"
      eyebrow="M3 · packaging"
      title="Publish"
      actions={<span className="state-chip" data-state={deliverable.status}>{deliverable.status}</span>}
    >
      <div className="publish-workspace">
        <label className="publish-deliverable">
          Deliverable
          <select value={deliverable.id} onChange={(event) => selectDeliverable(event.target.value)}>
            {deliverables.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.profile}</option>)}
          </select>
        </label>

        <section className="publish-section" aria-label="Metadata editor">
          <header><strong>Metadata</strong><span>{metadata?.status ?? "missing"}</span></header>
          {metadata === null ? (
            <button type="button" className="primary-action" onClick={() => void run("Draft metadata", async () => {
              const drafted = await window.guyditor.call<PublishMetadataDocument>("DeliverableService", "draftMetadata", { deliverableId: deliverable.id });
              setMetadata(drafted);
            })}>Draft from transcript + beats</button>
          ) : (
            <div className="metadata-fields">
              <label>Title<input value={metadata.title} onChange={(event) => edit("title", event.target.value)} /></label>
              <span className="limit-indicator" data-over={titleLimit !== undefined && counts.title > titleLimit}>{counts.title}/{titleLimit ?? "—"}</span>
              <label className="wide">Description<textarea rows={3} value={metadata.description} onChange={(event) => edit("description", event.target.value)} /></label>
              <span className="limit-indicator" data-over={descriptionLimit !== undefined && counts.description > descriptionLimit}>{counts.description}/{descriptionLimit ?? "—"}</span>
              <label>Tags<input value={metadata.tags.join(", ")} onChange={(event) => edit("tags", splitList(event.target.value))} /></label>
              <span className="limit-indicator" data-over={tagLimit !== undefined && counts.tags > tagLimit}>{counts.tags}/{tagLimit ?? "—"}</span>
              <label>Hashtags<input value={metadata.hashtags.join(" ")} onChange={(event) => edit("hashtags", splitList(event.target.value.replaceAll(" ", ",")))} /></label>
              <span className="limit-indicator" data-over={hashtagLimit !== undefined && counts.hashtags > hashtagLimit}>{counts.hashtags}/{hashtagLimit ?? "—"}</span>
              <label className="wide">CTA<input value={metadata.cta ?? ""} onChange={(event) => edit("cta", event.target.value)} /></label>
              <div className="publish-actions wide">
                <button type="button" onClick={() => void run("Save metadata", async () => {
                  const saved = await window.guyditor.call<PublishMetadataDocument>("DeliverableService", "saveMetadata", { deliverableId: deliverable.id, metadata });
                  setMetadata(saved);
                })}>Save draft</button>
                <button type="button" onClick={() => void run("Approve metadata", () => window.guyditor.call("DeliverableService", "approvePublish", { deliverableId: deliverable.id, targets: ["metadata"] }))}>Approve</button>
              </div>
            </div>
          )}
          <small>Metadata limits · title, description, tag characters, hashtag count</small>
        </section>

        {deliverable.kind === "longform" ? <section className="publish-section chapter-editor">
          <header><strong>Chapters</strong><span className="state-chip" data-state={chapters?.status ?? "missing"}>{chapters?.status ?? "missing"}</span></header>
          {chapters?.stale === undefined ? null : <p className="stale-warning">{chapters.stale.warning}</p>}
          <ol>{chapters?.chapters.map((chapter) => <li key={chapter.beatId}><time>{chapter.startSeconds}s</time><span>{chapter.title}</span></li>)}</ol>
          <div className="publish-actions">
            <button type="button" onClick={() => void run("Generate chapters", () => window.guyditor.call("DeliverableService", "generateChapters", { deliverableId: deliverable.id }))}>Generate from beats</button>
            <button type="button" disabled={chapters === undefined} onClick={() => void run("Approve chapters", () => window.guyditor.call("DeliverableService", "approvePublish", { deliverableId: deliverable.id, targets: ["chapters"] }))}>Approve</button>
          </div>
        </section> : null}

        <section className="publish-section">
          <header><strong>Thumbnail candidates</strong><span>{profile?.cover.resolution.width ?? "—"}×{profile?.cover.resolution.height ?? "—"}</span></header>
          <div className="thumbnail-picker">{candidates.map((candidate) => <button
            type="button"
            key={candidate.id}
            data-selected={deliverable.publish?.selectedThumbnail === candidate.id}
            onClick={() => void run("Select thumbnail", () => window.guyditor.call("DeliverableService", "selectThumbnail", { deliverableId: deliverable.id, composition: candidate.id }))}
          ><span>{candidate.label}</span><small>{candidate.id}</small></button>)}</div>
        </section>

        <section className="publish-section">
          <header><strong>Output set + kit</strong><span>{deliverable.profile}</span></header>
          <ul className="output-contents">{outputContents(deliverable).map((path) => <li key={path}>{path}</li>)}</ul>
          <div className="publish-actions">
            <button type="button" className="primary-action" onClick={() => void run("Export output set", () => window.guyditor.call("DeliverableService", "renderOutputSet", { deliverableId: deliverable.id }))}>Export output set</button>
            <button type="button" onClick={() => void run("Build upload kit", () => window.guyditor.call("DeliverableService", "buildKit", { deliverableId: deliverable.id }))}>Build upload kit</button>
            <button type="button" onClick={() => void run("Write text exports", () => window.guyditor.call("DeliverableService", "writeTextExports", { deliverableId: deliverable.id, targets: deliverable.kind === "longform" ? ["transcript", "chapters", "metadata"] : ["transcript", "metadata"] }))}>Text exports</button>
          </div>
        </section>

        <section className="publish-section batch-export">
          <header><strong>Batch export</strong><span>{batchIds.length} selected</span></header>
          <div>{deliverables.map((item) => <label key={item.id}><input
            type="checkbox"
            checked={batchIds.includes(item.id)}
            onChange={(event) => setBatchIds((current) => event.target.checked
              ? [...new Set([...current, item.id])]
              : current.filter((id) => id !== item.id))}
          />{item.name}<span className="state-chip" data-state={item.status}>{item.status}</span></label>)}</div>
          <label><input type="checkbox" checked={buildKits} onChange={(event) => setBuildKits(event.target.checked)} />Build upload kits after exports</label>
          <button type="button" className="primary-action" disabled={batchIds.length === 0} onClick={() => void run("Batch export", () => window.guyditor.call("DeliverableService", "batchExport", { deliverableIds: batchIds, buildKits }))}>Batch export</button>
        </section>
      </div>
    </Panel>
  );
}
