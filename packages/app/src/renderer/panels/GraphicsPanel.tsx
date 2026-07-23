import { useEffect, useMemo, useState } from "react";

import type { PlacedItem } from "../../../../core/src/index.js";
import type {
  TemplateCatalogEntry,
  TemplateFreezeResult,
} from "../../../../render/src/index.js";
import { errorMessage, executeDirect } from "../ipc.js";
import { usePreviewStore, useSelectionStore } from "../state/view-state.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

interface ParameterProperty {
  type?: string;
  title?: string;
  default?: unknown;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

interface ParameterSchema {
  required?: unknown[];
  properties?: Record<string, ParameterProperty>;
}

interface GraphicInstance {
  item: PlacedItem;
  layerId: string;
  layerName: string;
  layerOrder: number;
}

function schemaOf(entry: TemplateCatalogEntry | undefined): ParameterSchema {
  return entry?.params as ParameterSchema | undefined ?? {};
}

function defaults(entry: TemplateCatalogEntry): Record<string, unknown> {
  const params = structuredClone(entry.previewParams);
  for (const [name, property] of Object.entries(schemaOf(entry).properties ?? {})) {
    if (!(name in params) && property.default !== undefined) params[name] = property.default;
  }
  return params;
}

function valueLabel(name: string): string {
  return name.replace(/([a-z])([A-Z])/gu, "$1 $2");
}

function parameterValue(
  property: ParameterProperty,
  raw: string | boolean,
): unknown {
  if (property.type === "boolean") return Boolean(raw);
  if (property.type === "integer") return Math.round(Number(raw));
  if (property.type === "number") return Number(raw);
  return String(raw);
}

function templateCatalog(): Promise<TemplateCatalogEntry[]> {
  return window.guyditor.call<TemplateCatalogEntry[]>(
    "RenderService",
    "templateCatalog",
    {},
  );
}

function catalogKey(entry: TemplateCatalogEntry): string {
  return `${entry.id}@${entry.version}#${entry.submissionId ?? "published"}`;
}

export function GraphicsPanel({
  snapshot,
  refreshProject,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const [catalog, setCatalog] = useState<TemplateCatalogEntry[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedGraphicId, setSelectedGraphicId] = useState<string | null>(null);
  const [layerId, setLayerId] = useState("auto");
  const [anchorMode, setAnchorMode] = useState<"playhead" | "word">("playhead");
  const [durationMode, setDurationMode] = useState<"intrinsic" | "fixed" | "until">("intrinsic");
  const [durationFrames, setDurationFrames] = useState(90);
  const [freezing, setFreezing] = useState(false);
  const [reviewReason, setReviewReason] = useState("");
  const playhead = usePreviewStore((state) => state.playhead);
  const selectedWordId = useSelectionStore((state) => state.selectedWordId);
  const selectLayer = useSelectionStore((state) => state.selectLayer);
  const selectedTemplate = catalog.find((entry) => catalogKey(entry) === templateKey);
  const schema = schemaOf(selectedTemplate);
  const required = new Set(schema.required?.filter((value): value is string => typeof value === "string") ?? []);
  const graphicLayers = snapshot?.master.layers.filter((layer) =>
    layer.kind === "text" || layer.kind === "animation") ?? [];
  const instances = useMemo(() => graphicLayers.flatMap((layer) =>
    (layer.items ?? []).flatMap((item) => item.template === undefined
      ? []
      : [{ item, layerId: layer.id, layerName: layer.name, layerOrder: layer.order }])),
  [graphicLayers]);
  const selectedInstance = instances.find(({ item }) => item.id === selectedGraphicId);

  useEffect(() => {
    let current = true;
    void templateCatalog()
      .then((entries) => {
        if (!current) return;
        setCatalog(entries);
        if (entries.length > 0 && templateKey.length === 0) {
          setTemplateKey(catalogKey(entries[0]!));
          setParams(defaults(entries[0]!));
        }
      })
      .catch((error: unknown) => current ? setNotice(errorMessage(error)) : undefined);
    return () => { current = false; };
  }, [setNotice, snapshot?.projectPath]);

  useEffect(() => {
    let current = true;
    if (selectedTemplate === undefined) {
      setPreviewUrl(null);
      return () => { current = false; };
    }
    const timer = window.setTimeout(() => {
      void window.guyditor.call<{ dataUrl: string }>("RenderService", "templateFrame", {
        templateId: selectedTemplate.id,
        params,
      }).then(({ dataUrl }) => {
        if (current) setPreviewUrl(dataUrl);
      }).catch(() => {
        if (current) setPreviewUrl(selectedTemplate.previewDataUrl ?? selectedTemplate.previewPath);
      });
    }, 80);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [params, selectedTemplate]);

  function chooseTemplate(entry: TemplateCatalogEntry): void {
    setTemplateKey(catalogKey(entry));
    setParams(defaults(entry));
    setSelectedGraphicId(null);
    setReviewReason("");
  }

  async function reviewDraft(
    decision: "approve" | "reject" | "request_changes",
  ): Promise<void> {
    if (selectedTemplate?.submissionId === undefined) return;
    const reason = reviewReason.trim();
    if (decision !== "approve" && reason.length === 0) {
      setNotice("Add a review reason before rejecting or requesting changes.");
      return;
    }
    try {
      await window.guyditor.call(
        "TemplateAuthoringService",
        "review",
        {
          submissionId: selectedTemplate.submissionId,
          decision,
          ...(reason.length === 0 ? {} : { reason }),
        },
      );
      const entries = await templateCatalog();
      setCatalog(entries);
      const next = entries.find(({ id }) => id === selectedTemplate.id) ?? entries[0];
      if (next === undefined) {
        setTemplateKey("");
        setParams({});
      } else {
        chooseTemplate(next);
      }
      setNotice(
        decision === "approve"
          ? `Published ${selectedTemplate.name} as an immutable template version.`
          : decision === "reject"
            ? `Rejected ${selectedTemplate.name}: ${reason}`
            : `Requested changes to ${selectedTemplate.name}: ${reason}`,
      );
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function chooseInstance(instance: GraphicInstance): void {
    setSelectedGraphicId(instance.item.id);
    const templateId = instance.item.template;
    const pin = templateId === undefined ? undefined : snapshot?.master.templates?.[templateId];
    const entry = catalog.find((candidate) =>
      candidate.id === templateId &&
      (pin === undefined ||
        candidate.version === pin.version && candidate.contentHash === pin.contentHash));
    setTemplateKey(entry === undefined ? "" : catalogKey(entry));
    setParams(structuredClone(instance.item.params ?? {}));
    setLayerId(instance.layerId);
    selectLayer(instance.layerId);
  }

  async function importTemplatePackage(): Promise<void> {
    try {
      const packagePath = await window.guyditor.call<string | null>(
        "ProjectStore",
        "pickTemplatePackage",
        {},
      );
      if (packagePath === null) {
        setNotice("Template import cancelled.");
        return;
      }
      const previous = new Set(catalog.map(({ id, version }) => `${id}@${version}`));
      await executeDirect([{
        op: "template.install",
        params: { packagePath },
      }], "Import template package");
      const entries = await templateCatalog();
      setCatalog(entries);
      const installed = entries.find(({ id, version }) =>
        !previous.has(`${id}@${version}`));
      if (installed !== undefined) chooseTemplate(installed);
      const lottieAssets = installed?.assets.filter(({ kind }) => kind === "lottie") ?? [];
      setNotice(
        installed === undefined
          ? "Template package validated; the immutable version was already installed."
          : `Imported ${installed.name}${
              lottieAssets.length === 0
                ? ""
                : ` with ${String(lottieAssets.length)} deterministic Lottie asset${
                    lottieAssets.length === 1 ? "" : "s"
                  }`
            }.`,
      );
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function anchor(): string | undefined {
    if (anchorMode === "word") {
      return selectedWordId === null ? undefined : `word:${selectedWordId}`;
    }
    const deliverable = snapshot?.master.deliverables.find(
      ({ id }) => id === snapshot.master.settings.primaryDeliverable,
    );
    return deliverable === undefined
      ? undefined
      : `timeline:${deliverable.sequenceId}@${String(playhead.frames)}`;
  }

  function duration(): PlacedItem["duration"] | undefined {
    if (durationMode === "intrinsic") return "intrinsic";
    if (durationMode === "fixed") {
      return { frames: Math.max(1, durationFrames), fps: playhead.fps };
    }
    const deliverable = snapshot?.master.deliverables.find(
      ({ id }) => id === snapshot.master.settings.primaryDeliverable,
    );
    return deliverable === undefined
      ? undefined
      : { until: `timeline:${deliverable.sequenceId}@${String(playhead.frames + Math.max(1, durationFrames))}` };
  }

  async function addGraphic(): Promise<void> {
    const placement = anchor();
    const placedDuration = duration();
    if (selectedTemplate === undefined || placement === undefined || placedDuration === undefined) {
      setNotice(anchorMode === "word" ? "Select a transcript word before placing this graphic." : "Open a deliverable before placing graphics.");
      return;
    }
    try {
      await executeDirect([{
        op: "graphic.add",
        params: {
          templateId: selectedTemplate.id,
          ...(layerId === "auto" ? {} : { layerId }),
          anchor: placement,
          duration: placedDuration,
          params,
        },
      }], `Add ${selectedTemplate.name}`);
      await refreshProject();
      setNotice(`Placed ${selectedTemplate.name} at ${placement}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function updateGraphic(): Promise<void> {
    if (selectedInstance === undefined) return;
    try {
      await executeDirect([{
        op: "graphic.param.set",
        params: { graphicId: selectedInstance.item.id, patch: params },
      }], `Update ${selectedInstance.item.id}`);
      await refreshProject();
      setNotice(`Updated ${selectedInstance.item.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function freezeTemplate(): Promise<void> {
    if (snapshot === null || selectedTemplate === undefined) return;
    setFreezing(true);
    try {
      const result = await window.guyditor.call<TemplateFreezeResult>(
        "RenderService",
        "templateFreeze",
        {
          revision: snapshot.master.revision,
          deliverableId: snapshot.master.settings.primaryDeliverable,
          templateId: selectedTemplate.id,
          params,
          ...(durationMode === "intrinsic"
            ? {}
            : { durationFrames: Math.max(1, durationFrames) }),
          placeAsClip: true,
        },
      );
      await refreshProject();
      setNotice(
        `Froze ${selectedTemplate.name} to ${result.assetId} and placed ${result.clipId ?? "the clip"}.`,
      );
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setFreezing(false);
    }
  }

  async function removeGraphic(): Promise<void> {
    if (selectedInstance === undefined) return;
    try {
      await executeDirect([{
        op: "graphic.remove",
        params: { graphicId: selectedInstance.item.id },
      }], `Remove ${selectedInstance.item.id}`);
      setSelectedGraphicId(null);
      await refreshProject();
      setNotice(`Removed ${selectedInstance.item.id}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function moveLayer(direction: -1 | 1): Promise<void> {
    if (snapshot === null || selectedInstance === undefined) return;
    const index = snapshot.master.layers.findIndex(({ id }) => id === selectedInstance.layerId);
    const toIndex = Math.max(0, Math.min(snapshot.master.layers.length - 1, index + direction));
    if (index === toIndex) return;
    try {
      await executeDirect([{
        op: "layer.reorder",
        params: { layerId: selectedInstance.layerId, toIndex },
      }], `Reorder ${selectedInstance.layerName}`);
      await refreshProject();
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <Panel id="graphics" title="Graphics" eyebrow="Pinned template rack">
      <div className="template-browser-actions">
        <span>{selectedTemplate?.name ?? "No template selected"}</span>
        <div>
          <button
            type="button"
            data-testid="template-import"
            disabled={snapshot === null || freezing}
            onClick={() => void importTemplatePackage()}
          >
            Import package
          </button>
          <button
            type="button"
            className="freeze-action"
            data-testid="template-browser-freeze"
            disabled={
              snapshot === null || selectedTemplate === undefined || freezing ||
              selectedTemplate.reviewState === "draft"
            }
            onClick={() => void freezeTemplate()}
          >
            {freezing ? "Freezing…" : "Freeze selected to clip"}
          </button>
        </div>
      </div>
      <div className="template-rack" data-testid="template-browser">
        {catalog.map((entry) => (
          <button
            type="button"
            key={`${entry.id}@${entry.version}`}
            data-active={catalogKey(entry) === templateKey && selectedGraphicId === null}
            data-testid={`template-${entry.builtinName ?? entry.submissionId ?? entry.id}`}
            onClick={() => chooseTemplate(entry)}
          >
            <img src={entry.previewDataUrl ?? entry.previewPath} alt="" />
            <span>{entry.name}</span>
            <small>
              {entry.reviewState === "draft"
                ? "awaiting review"
                : `${entry.kind.replace("_", " ")} · v${entry.version}`}
            </small>
          </button>
        ))}
      </div>
      {selectedTemplate === undefined ? (
        <p className="empty-copy">No valid template packages are installed.</p>
      ) : (
        <div className="graphic-compose">
          {previewUrl === null ? null : (
            <img className="template-live-preview" src={previewUrl} alt={`${selectedTemplate.name} live preview`} data-testid="template-live-preview" />
          )}
          {selectedTemplate.previewStripDataUrls === undefined ? null : (
            <div
              className="template-preview-strip"
              data-testid="template-preview-strip"
              aria-label={`${selectedTemplate.name} probe frames`}
            >
              {selectedTemplate.previewStripDataUrls.map((url, index) => (
                <img
                  key={url}
                  src={url}
                  alt={`Probe frame ${String(index + 1)}`}
                />
              ))}
            </div>
          )}
          <div className="template-param-grid">
            {Object.entries(schema.properties ?? {}).map(([name, property]) => {
              const value = params[name] ?? property.default ?? "";
              const label = `${valueLabel(name)}${required.has(name) ? " *" : ""}`;
              if (property.enum !== undefined) {
                return (
                  <label key={name}>{label}
                    <select value={String(value)} onChange={(event) => {
                      const next = event.currentTarget.value;
                      setParams((current) => ({
                        ...current,
                        [name]: parameterValue(property, next),
                      }));
                    }}>
                      {property.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
                    </select>
                  </label>
                );
              }
              if (property.type === "boolean") {
                return (
                  <label key={name} className="graphic-checkbox">
                    <input type="checkbox" checked={Boolean(value)} onChange={(event) => {
                      const next = event.currentTarget.checked;
                      setParams((current) => ({ ...current, [name]: next }));
                    }} />
                    {label}
                  </label>
                );
              }
              const color = property.pattern?.includes("0-9A-Fa-f") === true;
              return (
                <label key={name}>{label}
                  <input
                    type={color ? "color" : property.type === "number" || property.type === "integer" ? "number" : "text"}
                    value={String(value)}
                    {...(property.minimum === undefined ? {} : { min: property.minimum })}
                    {...(property.maximum === undefined ? {} : { max: property.maximum })}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      setParams((current) => ({
                        ...current,
                        [name]: parameterValue(property, next),
                      }));
                    }}
                  />
                </label>
              );
            })}
          </div>
          {selectedTemplate.assets.filter(({ kind }) => kind === "lottie").map((asset) => (
            <p className="lottie-profile" key={asset.name} data-testid="lottie-feature-profile">
              Lottie · {asset.name} · {
                asset.featureProfile?.features.join(", ") ?? "profile unavailable"
              }
            </p>
          ))}
          {selectedTemplate.reviewState !== "draft" ? null : (
            <section className="template-author-review" data-testid="template-author-review">
              <header>
                <strong>Awaiting creator review</strong>
                <span>Preview only</span>
              </header>
              <p>{selectedTemplate.description ?? "Agent-authored template draft."}</p>
              <label>
                Review reason
                <input
                  data-testid="template-review-reason"
                  type="text"
                  value={reviewReason}
                  placeholder="Required for changes or rejection"
                  onChange={(event) => setReviewReason(event.currentTarget.value)}
                />
              </label>
              <div>
                <button
                  type="button"
                  className="primary-action"
                  data-testid="template-review-approve"
                  onClick={() => void reviewDraft("approve")}
                >
                  Approve & publish
                </button>
                <button
                  type="button"
                  data-testid="template-review-changes"
                  onClick={() => void reviewDraft("request_changes")}
                >
                  Request changes
                </button>
                <button
                  type="button"
                  data-testid="template-review-reject"
                  onClick={() => void reviewDraft("reject")}
                >
                  Reject
                </button>
              </div>
            </section>
          )}
          <div className="graphic-placement">
            <label>Anchor
              <select data-testid="graphic-anchor" value={anchorMode} onChange={(event) => setAnchorMode(event.currentTarget.value as "playhead" | "word")}>
                <option value="playhead">playhead · {playhead.frames}</option>
                <option value="word" disabled={selectedWordId === null}>word · {selectedWordId ?? "none"}</option>
              </select>
            </label>
            <label>Duration
              <select value={durationMode} onChange={(event) => setDurationMode(event.currentTarget.value as "intrinsic" | "fixed" | "until")}>
                <option value="intrinsic">intrinsic</option>
                <option value="fixed">fixed</option>
                <option value="until">until frame</option>
              </select>
            </label>
            {durationMode === "intrinsic" ? null : (
              <label>Frames<input type="number" min="1" value={durationFrames} onChange={(event) => setDurationFrames(Math.max(1, event.currentTarget.valueAsNumber || 1))} /></label>
            )}
            <label>Layer
              <select value={layerId} onChange={(event) => setLayerId(event.currentTarget.value)}>
                <option value="auto">new / auto</option>
                {graphicLayers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
              </select>
            </label>
          </div>
          <div className="graphic-actions">
            {selectedInstance === undefined ? (
              <>
                <button type="button" className="primary-action" data-testid="graphic-add" disabled={snapshot === null || freezing || selectedTemplate.reviewState === "draft"} onClick={() => void addGraphic()}>Place graphic</button>
                <button type="button" className="freeze-action" data-testid="template-freeze" disabled={snapshot === null || freezing || selectedTemplate.reviewState === "draft"} onClick={() => void freezeTemplate()}>
                  {freezing ? "Freezing…" : "Freeze to clip"}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="primary-action" data-testid="graphic-update" onClick={() => void updateGraphic()}>Apply params</button>
                <button type="button" className="freeze-action" data-testid="template-freeze" disabled={freezing} onClick={() => void freezeTemplate()}>
                  {freezing ? "Freezing…" : "Freeze to clip"}
                </button>
                <button type="button" data-testid="graphic-remove" onClick={() => void removeGraphic()}>Remove</button>
                <button type="button" aria-label="Move graphics layer down" onClick={() => void moveLayer(-1)}>↓</button>
                <button type="button" aria-label="Move graphics layer up" onClick={() => void moveLayer(1)}>↑</button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="graphic-instance-list" data-testid="graphic-instance-list">
        {instances.map((instance) => (
          <button key={instance.item.id} type="button" data-active={selectedGraphicId === instance.item.id} onClick={() => chooseInstance(instance)}>
            <strong>{typeof instance.item.params?.["title"] === "string"
              ? instance.item.params["title"]
              : catalog.find(({ id }) => id === instance.item.template)?.name ?? instance.item.template}</strong>
            <small>{instance.item.at} · {instance.layerName} #{String(instance.layerOrder)}</small>
          </button>
        ))}
      </div>
    </Panel>
  );
}
