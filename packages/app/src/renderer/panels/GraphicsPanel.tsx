import { useEffect, useMemo, useState } from "react";

import type { PlacedItem } from "../../../../core/src/index.js";
import type { TemplateCatalogEntry } from "../../../../render/src/index.js";
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

export function GraphicsPanel({
  snapshot,
  refreshProject,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const [catalog, setCatalog] = useState<TemplateCatalogEntry[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedGraphicId, setSelectedGraphicId] = useState<string | null>(null);
  const [layerId, setLayerId] = useState("auto");
  const [anchorMode, setAnchorMode] = useState<"playhead" | "word">("playhead");
  const [durationMode, setDurationMode] = useState<"intrinsic" | "fixed" | "until">("intrinsic");
  const [durationFrames, setDurationFrames] = useState(90);
  const playhead = usePreviewStore((state) => state.playhead);
  const selectedWordId = useSelectionStore((state) => state.selectedWordId);
  const selectLayer = useSelectionStore((state) => state.selectLayer);
  const selectedTemplate = catalog.find(({ id }) => id === templateId);
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
    void window.guyditor.call<TemplateCatalogEntry[]>("RenderService", "templateCatalog", {})
      .then((entries) => {
        if (!current) return;
        setCatalog(entries);
        if (entries.length > 0 && templateId.length === 0) {
          setTemplateId(entries[0]!.id);
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
    setTemplateId(entry.id);
    setParams(defaults(entry));
    setSelectedGraphicId(null);
  }

  function chooseInstance(instance: GraphicInstance): void {
    setSelectedGraphicId(instance.item.id);
    setTemplateId(instance.item.template ?? "");
    setParams(structuredClone(instance.item.params ?? {}));
    setLayerId(instance.layerId);
    selectLayer(instance.layerId);
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
      <div className="template-rack" data-testid="template-browser">
        {catalog.map((entry) => (
          <button
            type="button"
            key={entry.id}
            data-active={entry.id === templateId && selectedGraphicId === null}
            data-testid={`template-${entry.builtinName ?? entry.id}`}
            onClick={() => chooseTemplate(entry)}
          >
            <img src={entry.previewDataUrl ?? entry.previewPath} alt="" />
            <span>{entry.name}</span>
            <small>{entry.kind.replace("_", " ")} · v{entry.version}</small>
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
              <button type="button" className="primary-action" data-testid="graphic-add" disabled={snapshot === null} onClick={() => void addGraphic()}>Place graphic</button>
            ) : (
              <>
                <button type="button" className="primary-action" data-testid="graphic-update" onClick={() => void updateGraphic()}>Apply params</button>
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
