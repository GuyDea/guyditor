import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import { failure, makeGuyditorError, success } from "../errors.js";
import type { Result } from "../errors.js";
import type { GuyditorProject, Layer, PlacedItem } from "../project/index.js";
import type { TemplateDescriptor, TemplateProvider } from "../templates/index.js";
import type { IdFactory } from "./engine.js";
import type { ClipApplication, EntityMutation } from "./clip.js";
import type { OperationInput } from "./types.js";

function graphicFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
): ReturnType<typeof failure> {
  return failure(makeGuyditorError(code, message, { affected }));
}

async function descriptorForAdd(
  project: GuyditorProject,
  templateId: string,
  provider: TemplateProvider,
): Promise<Result<TemplateDescriptor>> {
  const pin = project.templates?.[templateId];
  const resolved = pin === undefined
    ? await provider.latest(templateId)
    : await provider.get(templateId, pin.version);
  if (!resolved.ok || pin === undefined) return resolved;
  return resolved.value.contentHash === pin.contentHash
    ? resolved
    : graphicFailure(
        "E_TEMPLATE_MISSING_VERSION",
        `Template ${templateId}@${pin.version} does not match pinned content hash ${pin.contentHash}.`,
        [templateId],
      );
}

function formatParamError(error: ErrorObject): string {
  const path = error.instancePath === "" ? "/" : error.instancePath;
  return `${path} ${error.message ?? error.keyword}`;
}

function validateParams(
  descriptor: TemplateDescriptor,
  params: Record<string, unknown>,
): Result<Record<string, unknown>> {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile<Record<string, unknown>>(descriptor.params);
    if (validate(params)) return success(params);
    const detail = validate.errors?.map(formatParamError).join("; ") ?? "unknown schema error";
    return graphicFailure(
      "E_TEMPLATE_PARAMS_INVALID",
      `Parameters for ${descriptor.name} failed validation: ${detail}.`,
      [descriptor.id],
    );
  } catch (error: unknown) {
    return graphicFailure(
      "E_TEMPLATE_PARAMS_INVALID",
      `Parameter schema for ${descriptor.name} is invalid: ${error instanceof Error ? error.message : String(error)}.`,
      [descriptor.id],
    );
  }
}

function nextLayerOrder(layers: readonly Layer[]): number {
  return layers.reduce((maximum, layer) => Math.max(maximum, layer.order), -1) + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(target);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (isRecord(value)) {
      result[key] = mergePatch(isRecord(result[key]) ? result[key] : {}, value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reversePatch(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const hadBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (!hadBefore && hasAfter) {
      patch[key] = null;
    } else if (hadBefore && !hasAfter) {
      patch[key] = structuredClone(before[key]);
    } else if (isRecord(before[key]) && isRecord(after[key])) {
      const nested = reversePatch(before[key], after[key]);
      if (Object.keys(nested).length > 0) patch[key] = nested;
    } else if (!equalJson(before[key], after[key])) {
      patch[key] = structuredClone(before[key]);
    }
  }
  return patch;
}

function graphicLocation(
  project: GuyditorProject,
  graphicId: string,
): { layerIndex: number; itemIndex: number; layer: Layer; item: PlacedItem } | undefined {
  for (const [layerIndex, layer] of project.layers.entries()) {
    const itemIndex = layer.items?.findIndex(({ id }) => id === graphicId) ?? -1;
    const item = layer.items?.[itemIndex];
    if (item !== undefined) return { layerIndex, itemIndex, layer, item };
  }
  return undefined;
}

async function pinnedDescriptor(
  project: GuyditorProject,
  item: PlacedItem,
  provider: TemplateProvider,
): Promise<Result<TemplateDescriptor>> {
  const templateId = item.template;
  const pin = templateId === undefined ? undefined : project.templates?.[templateId];
  if (templateId === undefined || pin === undefined) {
    return graphicFailure(
      "E_TEMPLATE_MISSING_VERSION",
      `Graphic ${item.id} has no resolvable pinned template.`,
      [item.id, ...(templateId === undefined ? [] : [templateId])],
    );
  }
  const resolved = await provider.get(templateId, pin.version);
  if (!resolved.ok) return resolved;
  return resolved.value.contentHash === pin.contentHash
    ? resolved
    : graphicFailure(
        "E_TEMPLATE_MISSING_VERSION",
        `Template ${templateId}@${pin.version} does not match pinned content hash ${pin.contentHash}.`,
        [item.id, templateId],
      );
}

async function applyAdd(
  project: GuyditorProject,
  input: OperationInput,
  provider: TemplateProvider,
  idFactory: IdFactory,
  seedFactory: () => number,
): Promise<Result<ClipApplication>> {
  const templateId = input.params["templateId"] as string;
  const descriptor = await descriptorForAdd(project, templateId, provider);
  if (!descriptor.ok) return descriptor;
  const params = structuredClone(input.params["params"] as Record<string, unknown>);
  const validated = validateParams(descriptor.value, params);
  if (!validated.ok) return validated;

  const graphicId = input.params["graphicId"] as string | undefined ?? idFactory("gfx");
  if (project.layers.some((layer) => layer.items?.some(({ id }) => id === graphicId))) {
    return graphicFailure("E_OP_ID_CONFLICT", `Graphic ${graphicId} already exists.`, [graphicId]);
  }
  const requestedLayerId = input.params["layerId"] as string | undefined;
  let layerId = requestedLayerId;
  let createdLayer: Layer | undefined;
  let layer = requestedLayerId === undefined
    ? undefined
    : project.layers.find(({ id }) => id === requestedLayerId);
  if (requestedLayerId !== undefined && layer === undefined) {
    return graphicFailure("E_OP_NOT_FOUND", `Layer ${requestedLayerId} does not exist.`, [requestedLayerId]);
  }
  if (layer !== undefined && layer.kind !== "text" && layer.kind !== "animation") {
    return graphicFailure(
      "E_GRAPHIC_LAYER_KIND",
      `Layer ${layer.id} must be a text or animation layer for template graphics.`,
      [layer.id],
    );
  }
  if (layer?.locked === true) {
    return graphicFailure("E_LAYER_LOCKED", `Layer ${layer.id} is locked.`, [layer.id]);
  }
  if (layer === undefined) {
    layerId = idFactory("lyr");
    createdLayer = {
      id: layerId,
      kind: "animation",
      name: "Graphics",
      order: nextLayerOrder(project.layers),
      enabled: true,
      locked: false,
      items: [],
    };
    layer = createdLayer;
  }
  const seed = input.params["seed"] as number | undefined ?? seedFactory();
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    return graphicFailure(
      "E_GRAPHIC_SEED_INVALID",
      "Graphic seed must be a uint32 assigned once at creation.",
      [graphicId],
    );
  }
  const item: PlacedItem = {
    id: graphicId,
    template: templateId,
    at: input.params["anchor"] as string,
    duration: structuredClone(input.params["duration"] as PlacedItem["duration"]),
    params: validated.value,
    seed,
  };
  const nextLayer: Layer = { ...layer, items: [...(layer.items ?? []), item] };
  delete nextLayer.sequence;
  const layers = createdLayer === undefined
    ? project.layers.map((candidate) => candidate.id === nextLayer.id ? nextLayer : candidate)
    : [...project.layers, nextLayer];
  const templates = {
    ...(project.templates ?? {}),
    [templateId]: project.templates?.[templateId] ?? {
      version: descriptor.value.version,
      contentHash: descriptor.value.contentHash,
    },
  };
  const mutations: EntityMutation[] = [
    ...(createdLayer === undefined ? [] : [{
      entityId: nextLayer.id,
      entityType: "layer" as const,
      change: "added" as const,
      fields: [{ field: "$entity", after: nextLayer }],
    }]),
    {
      entityId: item.id,
      entityType: "item",
      change: "added",
      fields: [{ field: "$entity", after: item }],
    },
  ];
  const title = typeof params["title"] === "string" && params["title"].length > 0
    ? ` ‘${params["title"]}’`
    : "";
  return success({
    model: { ...project, layers, templates },
    inverse: [{ op: "graphic.remove", params: { graphicId } }],
    redo: {
      op: "graphic.add",
      params: {
        ...input.params,
        graphicId,
        layerId,
        seed,
      },
    },
    affected: mutations.map(({ entityId }) => entityId),
    summary: `Add ${descriptor.value.name}${title} at ${item.at}`,
    mutations,
  });
}

async function applyParamSet(
  project: GuyditorProject,
  input: OperationInput,
  provider: TemplateProvider,
): Promise<Result<ClipApplication>> {
  const graphicId = input.params["graphicId"] as string;
  const located = graphicLocation(project, graphicId);
  if (located === undefined) {
    return graphicFailure("E_OP_NOT_FOUND", `Graphic ${graphicId} does not exist.`, [graphicId]);
  }
  if (located.layer.locked) {
    return graphicFailure("E_LAYER_LOCKED", `Layer ${located.layer.id} is locked.`, [located.layer.id]);
  }
  const descriptor = await pinnedDescriptor(project, located.item, provider);
  if (!descriptor.ok) return descriptor;
  const before = structuredClone(located.item.params ?? {});
  const after = mergePatch(before, input.params["patch"] as Record<string, unknown>);
  const validated = validateParams(descriptor.value, after);
  if (!validated.ok) return validated;
  const item = { ...located.item, params: validated.value };
  const layer = {
    ...located.layer,
    items: located.layer.items!.map((candidate, index) =>
      index === located.itemIndex ? item : candidate),
  };
  const layers = project.layers.map((candidate, index) =>
    index === located.layerIndex ? layer : candidate);
  const title = typeof after["title"] === "string" && after["title"].length > 0
    ? ` ‘${after["title"]}’`
    : "";
  return success({
    model: { ...project, layers },
    inverse: [{
      op: "graphic.param.set",
      params: { graphicId, patch: reversePatch(before, after) },
    }],
    affected: [graphicId],
    summary: `Update ${descriptor.value.name}${title}`,
    mutations: [{
      entityId: graphicId,
      entityType: "item",
      change: "modified",
      fields: [{ field: "params", before, after }],
    }],
  });
}

async function applyItemField(
  project: GuyditorProject,
  input: OperationInput,
  provider: TemplateProvider,
  field: "at" | "duration",
): Promise<Result<ClipApplication>> {
  const graphicId = input.params["graphicId"] as string;
  const located = graphicLocation(project, graphicId);
  if (located === undefined) {
    return graphicFailure("E_OP_NOT_FOUND", `Graphic ${graphicId} does not exist.`, [graphicId]);
  }
  if (located.layer.locked) {
    return graphicFailure("E_LAYER_LOCKED", `Layer ${located.layer.id} is locked.`, [located.layer.id]);
  }
  const descriptor = await pinnedDescriptor(project, located.item, provider);
  if (!descriptor.ok) return descriptor;
  const before = structuredClone(located.item[field]);
  const parameter = field === "at" ? "anchor" : "duration";
  const after = structuredClone(input.params[parameter] as PlacedItem[typeof field]);
  const item = { ...located.item, [field]: after };
  const layer = {
    ...located.layer,
    items: located.layer.items!.map((candidate, index) =>
      index === located.itemIndex ? item : candidate),
  };
  const layers = project.layers.map((candidate, index) =>
    index === located.layerIndex ? layer : candidate);
  const operation = field === "at" ? "graphic.anchor.set" : "graphic.retime";
  return success({
    model: { ...project, layers },
    inverse: [{ op: operation, params: { graphicId, [parameter]: before } }],
    affected: [graphicId],
    summary: field === "at"
      ? `Move ${descriptor.value.name} to ${String(after)}`
      : `Retime ${descriptor.value.name}`,
    mutations: [{
      entityId: graphicId,
      entityType: "item",
      change: "modified",
      fields: [{ field, before, after }],
    }],
  });
}

async function applyRemove(
  project: GuyditorProject,
  input: OperationInput,
  provider: TemplateProvider,
): Promise<Result<ClipApplication>> {
  const graphicId = input.params["graphicId"] as string;
  const located = graphicLocation(project, graphicId);
  if (located === undefined) {
    return graphicFailure("E_OP_NOT_FOUND", `Graphic ${graphicId} does not exist.`, [graphicId]);
  }
  if (located.layer.locked) {
    return graphicFailure("E_LAYER_LOCKED", `Layer ${located.layer.id} is locked.`, [located.layer.id]);
  }
  const descriptor = await pinnedDescriptor(project, located.item, provider);
  if (!descriptor.ok) return descriptor;
  const layer = {
    ...located.layer,
    items: located.layer.items!.filter((_, index) => index !== located.itemIndex),
  };
  const layers = project.layers.map((candidate, index) =>
    index === located.layerIndex ? layer : candidate);
  const params = structuredClone(located.item.params ?? {});
  return success({
    model: { ...project, layers },
    inverse: [{
      op: "graphic.add",
      params: {
        templateId: located.item.template!,
        layerId: located.layer.id,
        graphicId: located.item.id,
        anchor: located.item.at,
        duration: structuredClone(located.item.duration),
        params,
        seed: located.item.seed!,
      },
    }],
    affected: [graphicId],
    summary: `Remove ${descriptor.value.name}`,
    mutations: [{
      entityId: graphicId,
      entityType: "item",
      change: "removed",
      fields: [{ field: "$entity", before: structuredClone(located.item) }],
    }],
  });
}

export async function applyGraphicOperation(
  project: GuyditorProject,
  input: OperationInput,
  provider: TemplateProvider,
  idFactory: IdFactory,
  seedFactory: () => number,
): Promise<Result<ClipApplication>> {
  if (input.op === "graphic.add") {
    return applyAdd(project, input, provider, idFactory, seedFactory);
  }
  if (input.op === "graphic.param.set") {
    return applyParamSet(project, input, provider);
  }
  if (input.op === "graphic.anchor.set") {
    return applyItemField(project, input, provider, "at");
  }
  if (input.op === "graphic.retime") {
    return applyItemField(project, input, provider, "duration");
  }
  if (input.op === "graphic.remove") {
    return applyRemove(project, input, provider);
  }
  return graphicFailure("E_OP_UNKNOWN", `Unknown graphic operation ${input.op}.`);
}

export async function applyTemplateOperation(
  project: GuyditorProject,
  input: OperationInput,
  provider: TemplateProvider,
  dryRun: boolean,
): Promise<Result<ClipApplication>> {
  if (input.op === "template.install") {
    if (provider.install === undefined) {
      return graphicFailure(
        "E_TEMPLATE_INSTALL_UNAVAILABLE",
        "The active template provider cannot install packages.",
      );
    }
    const descriptor = await provider.install({
      ...(typeof input.params["packagePath"] === "string"
        ? { packagePath: input.params["packagePath"] }
        : {}),
      ...(typeof input.params["builtinName"] === "string"
        ? { builtinName: input.params["builtinName"] }
        : {}),
    }, { dryRun });
    if (!descriptor.ok) return descriptor;
    return success({
      model: project,
      inverse: [{
        op: "template.uninstall",
        params: { templateId: descriptor.value.id, version: descriptor.value.version },
      }],
      affected: [descriptor.value.id],
      summary: `Install ${descriptor.value.name} ${descriptor.value.version}`,
      mutations: [],
    });
  }
  if (input.op === "template.uninstall") {
    if (provider.uninstall === undefined) {
      return graphicFailure(
        "E_TEMPLATE_INSTALL_UNAVAILABLE",
        "The active template provider cannot uninstall packages.",
      );
    }
    const templateId = input.params["templateId"] as string;
    const version = input.params["version"] as string;
    if (project.templates?.[templateId]?.version === version) {
      return graphicFailure(
        "E_TEMPLATE_PIN_IN_USE",
        `Template ${templateId}@${version} is pinned by this project and cannot be uninstalled.`,
        [templateId],
      );
    }
    const removed = await provider.uninstall(templateId, version, { dryRun });
    if (!removed.ok) return removed;
    return success({
      model: project,
      inverse: [],
      affected: [templateId],
      summary: `Uninstall ${templateId}@${version}`,
      mutations: [],
    });
  }
  if (input.op !== "template.pin") {
    return graphicFailure("E_OP_UNKNOWN", `Unknown template operation ${input.op}.`);
  }
  const templateId = input.params["templateId"] as string;
  const version = input.params["version"] as string;
  const before = project.templates?.[templateId];
  if (before === undefined) {
    return graphicFailure(
      "E_TEMPLATE_MISSING_VERSION",
      `Template ${templateId} is not pinned by this project.`,
      [templateId],
    );
  }
  const descriptor = await provider.get(templateId, version);
  if (!descriptor.ok) return descriptor;
  const after = { version, contentHash: descriptor.value.contentHash };
  const templates = { ...(project.templates ?? {}), [templateId]: after };
  const affected = project.layers.flatMap((layer) =>
    (layer.items ?? []).filter((item) => item.template === templateId).map(({ id }) => id));
  return success({
    model: { ...project, templates },
    inverse: [{
      op: "template.pin",
      params: { templateId, version: before.version },
    }],
    affected,
    summary: `Upgrade ${descriptor.value.name} from ${before.version} to ${version} (${String(affected.length)} instances)`,
    mutations: [{
      entityId: project.project.id,
      entityType: "project",
      change: "modified",
      fields: [{ field: `templates.${templateId}`, before, after }],
    }],
  });
}
