import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

import type { FrameTime } from "../../core/src/index.js";
import type { PlatformProfile } from "../../deliver/src/index.js";

interface ThumbnailTransform { x?: number; y?: number; w?: number; h?: number; opacity?: number }

type ThumbnailLayer =
  | { kind: "frame"; assetId: string; at: FrameTime; transform?: ThumbnailTransform }
  | { kind: "cutout"; assetId: string; at: FrameTime; keyPresetId: string; transform?: ThumbnailTransform }
  | { kind: "template"; templateId: string; params: Record<string, unknown>; transform?: ThumbnailTransform }
  | { kind: "image"; assetId: string; transform?: ThumbnailTransform };

export interface ThumbnailComposition {
  format: "guyditor-thumb/v1";
  name: string;
  canvas: { width: number; height: number };
  layers: readonly ThumbnailLayer[];
}

export interface ThumbnailProviders {
  frame(layer: Extract<ThumbnailLayer, { kind: "frame" }>): Promise<Buffer>;
  cutout(
    layer: Extract<ThumbnailLayer, { kind: "cutout" }>,
    keyPresetId: string,
  ): Promise<Buffer>;
  template(layer: Extract<ThumbnailLayer, { kind: "template" }>): Promise<Buffer>;
  image(layer: Extract<ThumbnailLayer, { kind: "image" }>): Promise<Buffer>;
}

type ThumbnailProfile = Pick<PlatformProfile, "id" | "cover">;

export function thumbnailCompositionPlan(
  composition: ThumbnailComposition,
  profile: ThumbnailProfile,
): { width: number; height: number; requiresKeying: boolean; templateIds: string[] } {
  const expected = profile.cover.resolution;
  if (composition.canvas.width !== expected.width || composition.canvas.height !== expected.height) {
    throw new RangeError(
      `Thumbnail ${composition.name} must use ${String(expected.width)}×${String(expected.height)} for ${profile.id}.`,
    );
  }
  return {
    width: expected.width,
    height: expected.height,
    requiresKeying: composition.layers.some(({ kind }) => kind === "cutout"),
    templateIds: composition.layers.flatMap((layer) =>
      layer.kind === "template" ? [layer.templateId] : []),
  };
}

function destination(
  transform: ThumbnailTransform | undefined,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number; opacity: number } {
  return {
    x: (transform?.x ?? 0) * width,
    y: (transform?.y ?? 0) * height,
    w: (transform?.w ?? 1) * width,
    h: (transform?.h ?? 1) * height,
    opacity: transform?.opacity ?? 1,
  };
}

export async function renderThumbnailComposition(input: {
  composition: ThumbnailComposition;
  profile: ThumbnailProfile;
  format: "png" | "jpg";
  providers: ThumbnailProviders;
}): Promise<{ bytes: Buffer; width: number; height: number; mime: "image/png" | "image/jpeg" }> {
  const plan = thumbnailCompositionPlan(input.composition, input.profile);
  if (!input.profile.cover.formats.includes(input.format)) {
    throw new TypeError(`Thumbnail format ${input.format} is not allowed by ${input.profile.id}.`);
  }
  const canvas = createCanvas(plan.width, plan.height);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, plan.width, plan.height);
  for (const layer of input.composition.layers) {
    const bytes = layer.kind === "frame"
      ? await input.providers.frame(layer)
      : layer.kind === "cutout"
        ? await input.providers.cutout(layer, layer.keyPresetId)
        : layer.kind === "template"
          ? await input.providers.template(layer)
          : await input.providers.image(layer);
    const image = await loadImage(bytes);
    const target = destination(layer.transform, plan.width, plan.height);
    context.save();
    context.globalAlpha = target.opacity;
    context.drawImage(image, target.x, target.y, target.w, target.h);
    context.restore();
  }
  const bytes = input.format === "png"
    ? canvas.toBuffer("image/png")
    : await canvas.encode("jpeg", 90);
  if (bytes.length > input.profile.cover.maxBytes) {
    throw new RangeError(
      `Thumbnail is ${String(bytes.length)} bytes; ${input.profile.id} allows ${String(input.profile.cover.maxBytes)}.`,
    );
  }
  return {
    bytes,
    width: plan.width,
    height: plan.height,
    mime: input.format === "png" ? "image/png" : "image/jpeg",
  };
}

let thumbnailWriteOrdinal = 0;

export async function writeThumbnailComposition(input: {
  projectRoot: string;
  deliverableId: string;
  composition: ThumbnailComposition;
  rendered: { bytes: Buffer; mime: "image/png" | "image/jpeg" };
}): Promise<{ compositionPath: string; imagePath: string }> {
  if (!/^[A-Za-z0-9._-]+$/u.test(input.composition.name)) {
    throw new TypeError("Thumbnail composition name may contain only letters, numbers, dot, underscore, and dash.");
  }
  const extension = input.rendered.mime === "image/png" ? "png" : "jpg";
  const base = `publish/${input.deliverableId}/thumbnails/${input.composition.name}`;
  const compositionPath = `${base}.yaml`;
  const imagePath = `${base}.${extension}`;
  const absoluteComposition = join(input.projectRoot, compositionPath);
  const absoluteImage = join(input.projectRoot, imagePath);
  await mkdir(dirname(absoluteComposition), { recursive: true });
  thumbnailWriteOrdinal += 1;
  const suffix = `.tmp-${String(process.pid)}-${String(thumbnailWriteOrdinal)}`;
  const temporaryComposition = `${absoluteComposition}${suffix}`;
  const temporaryImage = `${absoluteImage}${suffix}`;
  try {
    await Promise.all([
      writeFile(temporaryComposition, stringify(input.composition, { lineWidth: 0 }), "utf8"),
      writeFile(temporaryImage, input.rendered.bytes),
    ]);
    await rename(temporaryImage, absoluteImage);
    await rename(temporaryComposition, absoluteComposition);
  } finally {
    await Promise.all([
      rm(temporaryComposition, { force: true }).catch(() => undefined),
      rm(temporaryImage, { force: true }).catch(() => undefined),
    ]);
  }
  return { compositionPath, imagePath };
}
