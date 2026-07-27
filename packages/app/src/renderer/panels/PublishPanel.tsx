import { useEffect, useMemo, useRef, useState } from "react";

import type { Deliverable, PublishMetadataDocument } from "../../../../core/src/index.js";
import type { OtioLoss, PlatformProfile } from "../../../../deliver/src/index.js";
import {
  activateDeliverable,
  resolveActiveDeliverable,
} from "../active-deliverable.js";
import { errorMessage, setActiveDeliverable } from "../ipc.js";
import type { ContextRequest } from "../state/async-context.js";
import { useSelectionStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import {
  batchIdsForProject,
  beginPublishRequest,
  contextualValue,
  createPublishBatchState,
  createPublishMetadataState,
  createPublishRequestGates,
  editPublishMetadata,
  invalidatePublishRequest,
  invalidatePublishRequests,
  isPublishRequestCurrent,
  publishContextKey,
  publishMetadataForContext,
  publishRequestKeys,
  reconcilePublishBatch,
  reconcilePublishMetadata,
  replacePublishMetadata,
  valueForContext,
} from "./publish-runtime.js";
import type {
  ContextualValue,
  PublishRequestKeys,
  PublishRequestResource,
} from "./publish-runtime.js";
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

const PUBLISH_REQUEST_RESOURCES = [
  "metadata",
  "chapters",
  "thumbnail",
  "output",
  "otio",
  "batch",
] as const satisfies readonly PublishRequestResource[];

export function PublishPanel({ snapshot, refreshProject, refreshExportReport, setNotice }: WorkspacePanelProps): React.JSX.Element {
  const selectedId = useSelectionStore((state) => state.selectedDeliverableId);
  const deliverables = snapshot?.master.deliverables ?? [];
  const deliverable = snapshot === null
    ? undefined
    : resolveActiveDeliverable(snapshot.master, selectedId);
  const projectPath = snapshot?.projectPath ?? null;
  const contextKey = projectPath === null || deliverable === undefined
    ? null
    : publishContextKey(projectPath, deliverable.id);
  const canonicalMetadata = deliverable?.publish?.metadata ?? null;
  const [profiles, setProfiles] = useState<PlatformProfile[]>([]);
  const [metadataState, setMetadataState] = useState(
    () => createPublishMetadataState(contextKey, canonicalMetadata),
  );
  const metadata = publishMetadataForContext(
    metadataState,
    contextKey,
    canonicalMetadata,
  );
  const [batchState, setBatchState] = useState(
    () => createPublishBatchState(projectPath, deliverables),
  );
  const batchIds = batchIdsForProject(batchState, projectPath, deliverables);
  const [buildKits, setBuildKits] = useState(true);
  const [otioPreview, setOtioPreview] =
    useState<ContextualValue<OtioLoss[]> | null>(null);
  const [otioMediaPaths, setOtioMediaPaths] = useState<"absolute" | "relative">("relative");
  const [otioAnnotations, setOtioAnnotations] = useState(false);
  const otioRequestKey = contextKey === null
    ? null
    : JSON.stringify([contextKey, otioMediaPaths, otioAnnotations]);
  const requestGates = useRef(createPublishRequestGates());
  const requestKeys = publishRequestKeys(projectPath, contextKey, otioRequestKey);
  const currentRequestKeys = useRef<PublishRequestKeys>(requestKeys);
  for (const resource of PUBLISH_REQUEST_RESOURCES) {
    if (currentRequestKeys.current[resource] !== requestKeys[resource]) {
      invalidatePublishRequest(requestGates.current, resource);
    }
  }
  currentRequestKeys.current = requestKeys;
  const otioLosses = valueForContext(otioPreview, otioRequestKey);
  const profile = profiles.find(({ id, version }) => `${id}@${version}` === deliverable?.profile);

  useEffect(() => {
    void window.guyditor.call<PlatformProfile[]>("DeliverableService", "profiles", {})
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    setMetadataState((current) =>
      reconcilePublishMetadata(current, contextKey, canonicalMetadata));
  }, [canonicalMetadata, contextKey]);

  useEffect(() => {
    setBatchState((current) =>
      reconcilePublishBatch(current, projectPath, deliverables));
  }, [deliverables, projectPath]);

  useEffect(() => {
    setOtioPreview(null);
  }, [otioRequestKey]);

  useEffect(() => () => {
    invalidatePublishRequests(
      requestGates.current,
      PUBLISH_REQUEST_RESOURCES,
    );
  }, []);

  const counts = useMemo(() => ({
    title: codePoints(metadata?.title ?? ""),
    description: codePoints(metadata?.description ?? ""),
    tags: metadata?.tags.reduce((total, tag) => total + codePoints(tag), 0) ?? 0,
    hashtags: metadata?.hashtags.length ?? 0,
  }), [metadata]);

  function requestIsCurrent(
    resource: PublishRequestResource,
    request: ContextRequest,
  ): boolean {
    return isPublishRequestCurrent(
      requestGates.current,
      resource,
      request,
      currentRequestKeys.current[resource],
    );
  }

  async function run(
    resource: PublishRequestResource,
    label: string,
    action: (request: ContextRequest) => Promise<unknown>,
  ): Promise<void> {
    const key = requestKeys[resource];
    if (key === null) return;
    const request = beginPublishRequest(requestGates.current, resource, key);
    setNotice(`${label}…`);
    try {
      await action(request);
      if (!requestIsCurrent(resource, request)) return;
      await Promise.all([refreshProject(), refreshExportReport()]);
      if (!requestIsCurrent(resource, request)) return;
      setNotice(`${label} ready.`);
    } catch (error: unknown) {
      if (requestIsCurrent(resource, request)) setNotice(errorMessage(error));
    }
  }

  async function reviewOtioLosses(): Promise<void> {
    const params = structuredClone(otioParams);
    await run("otio", "Review OTIO losses", async (request) => {
      const preview = await window.guyditor.call<{ losses: OtioLoss[] }>(
        "DeliverableService",
        "previewOtioExport",
        params,
      );
      if (!requestIsCurrent("otio", request)) return;
      setOtioPreview(contextualValue(request.contextKey, preview.losses));
    });
  }

  const otioParams = {
    deliverableId: deliverable?.id ?? "",
    mediaPaths: otioMediaPaths,
    includeBeatsAsMarkers: true,
    includeAnnotationsAsMarkers: otioAnnotations,
  };

  function edit<Key extends keyof PublishMetadataDocument>(key: Key, value: PublishMetadataDocument[Key]): void {
    if (contextKey === null || metadata === null) return;
    invalidatePublishRequest(requestGates.current, "metadata");
    setMetadataState((current) => {
      const base = publishMetadataForContext(current, contextKey, metadata);
      return base === null
        ? current
        : editPublishMetadata(current, contextKey, { ...base, [key]: value });
    });
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
          <select value={deliverable.id} onChange={(event) => {
            if (snapshot !== null) {
              void activateDeliverable(
                snapshot.master,
                event.target.value,
                setNotice,
                (deliverableId) => setActiveDeliverable(
                  snapshot.projectPath,
                  deliverableId,
                ),
              );
            }
          }}>
            {deliverables.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.profile}</option>)}
          </select>
        </label>

        <section className="publish-section" aria-label="Metadata editor">
          <header><strong>Metadata</strong><span>{metadata?.status ?? "missing"}</span></header>
          {metadata === null ? (
            <button type="button" className="primary-action" onClick={() => void run("metadata", "Draft metadata", async (request) => {
              const drafted = await window.guyditor.call<PublishMetadataDocument>("DeliverableService", "draftMetadata", { deliverableId: deliverable.id });
              if (requestIsCurrent("metadata", request)) {
                setMetadataState((current) =>
                  replacePublishMetadata(current, request.contextKey, drafted));
              }
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
                <button type="button" onClick={() => void run("metadata", "Save metadata", async (request) => {
                  const saved = await window.guyditor.call<PublishMetadataDocument>("DeliverableService", "saveMetadata", { deliverableId: deliverable.id, metadata });
                  if (requestIsCurrent("metadata", request)) {
                    setMetadataState((current) =>
                      replacePublishMetadata(current, request.contextKey, saved));
                  }
                })}>Save draft</button>
                <button type="button" onClick={() => void run("metadata", "Approve metadata", () => window.guyditor.call("DeliverableService", "approvePublish", { deliverableId: deliverable.id, targets: ["metadata"] }))}>Approve</button>
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
            <button type="button" onClick={() => void run("chapters", "Generate chapters", () => window.guyditor.call("DeliverableService", "generateChapters", { deliverableId: deliverable.id }))}>Generate from beats</button>
            <button type="button" disabled={chapters === undefined} onClick={() => void run("chapters", "Approve chapters", () => window.guyditor.call("DeliverableService", "approvePublish", { deliverableId: deliverable.id, targets: ["chapters"] }))}>Approve</button>
          </div>
        </section> : null}

        <section className="publish-section">
          <header><strong>Thumbnail candidates</strong><span>{profile?.cover.resolution.width ?? "—"}×{profile?.cover.resolution.height ?? "—"}</span></header>
          <div className="thumbnail-picker">{candidates.map((candidate) => <button
            type="button"
            key={candidate.id}
            data-selected={deliverable.publish?.selectedThumbnail === candidate.id}
            onClick={() => void run("thumbnail", "Select thumbnail", () => window.guyditor.call("DeliverableService", "selectThumbnail", { deliverableId: deliverable.id, composition: candidate.id }))}
          ><span>{candidate.label}</span><small>{candidate.id}</small></button>)}</div>
        </section>

        <section className="publish-section">
          <header><strong>Output set + kit</strong><span>{deliverable.profile}</span></header>
          <ul className="output-contents">{outputContents(deliverable).map((path) => <li key={path}>{path}</li>)}</ul>
          <div className="publish-actions">
            <button type="button" className="primary-action" onClick={() => void run("output", "Export output set", () => window.guyditor.call("DeliverableService", "renderOutputSet", { deliverableId: deliverable.id }))}>Export output set</button>
            <button type="button" onClick={() => void run("output", "Build upload kit", () => window.guyditor.call("DeliverableService", "buildKit", { deliverableId: deliverable.id }))}>Build upload kit</button>
            <button type="button" onClick={() => void run("output", "Write text exports", () => window.guyditor.call("DeliverableService", "writeTextExports", { deliverableId: deliverable.id, targets: deliverable.kind === "longform" ? ["transcript", "chapters", "metadata"] : ["transcript", "metadata"] }))}>Text exports</button>
          </div>
        </section>

        <section className="publish-section" aria-label="OpenTimelineIO interchange">
          <header><strong>OpenTimelineIO interchange</strong><span>one-way · derived</span></header>
          <p>Review the canonical-only losses before writing the non-canonical .otio timeline.</p>
          <div className="publish-actions">
            <label>Media paths<select value={otioMediaPaths} onChange={(event) => setOtioMediaPaths(event.target.value === "absolute" ? "absolute" : "relative")}><option value="relative">Relative</option><option value="absolute">Absolute file URLs</option></select></label>
            <label><input type="checkbox" checked={otioAnnotations} onChange={(event) => setOtioAnnotations(event.target.checked)} />Include private review annotations as markers</label>
          </div>
          {otioLosses === null ? null : <ul className="output-contents">{otioLosses.map((loss) => <li key={loss.construct}><strong>{loss.construct}</strong> · {loss.disposition} ({loss.ids.length})</li>)}</ul>}
          <div className="publish-actions">
            <button type="button" onClick={() => void reviewOtioLosses()}>Review OTIO losses</button>
            <button type="button" className="primary-action" disabled={otioLosses === null} onClick={() => void run("otio", "Export .otio", () => window.guyditor.call("DeliverableService", "exportOtio", otioParams))}>Export .otio</button>
          </div>
        </section>

        <section className="publish-section batch-export">
          <header><strong>Batch export</strong><span>{batchIds.length} selected</span></header>
          <div>{deliverables.map((item) => <label key={item.id}><input
            type="checkbox"
            checked={batchIds.includes(item.id)}
            onChange={(event) => setBatchState((current) => {
              const reconciled = reconcilePublishBatch(
                current,
                projectPath,
                deliverables,
              );
              return {
                ...reconciled,
                ids: event.target.checked
                  ? [...new Set([...reconciled.ids, item.id])]
                  : reconciled.ids.filter((id) => id !== item.id),
              };
            })}
          />{item.name}<span className="state-chip" data-state={item.status}>{item.status}</span></label>)}</div>
          <label><input type="checkbox" checked={buildKits} onChange={(event) => setBuildKits(event.target.checked)} />Build upload kits after exports</label>
          <button type="button" className="primary-action" disabled={batchIds.length === 0} onClick={() => void run("batch", "Batch export", () => window.guyditor.call("DeliverableService", "batchExport", { deliverableIds: batchIds, buildKits }))}>Batch export</button>
        </section>
      </div>
    </Panel>
  );
}
