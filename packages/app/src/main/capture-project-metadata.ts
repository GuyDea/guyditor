import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";

import {
  convertTimeRounding,
  makeId,
  parseTakeMarkerSidecar,
  serializeTakeMarkerSidecar,
} from "../../../core/src/index.js";
import type {
  Asset,
  OperationEngine,
  ProjectStore,
  TakeMarkerSidecar,
} from "../../../core/src/index.js";
import {
  importJsonTakeMarkers,
  importTakeNotes,
} from "../../../transcript/src/index.js";

interface CaptureProjectMetadataOptions {
  store: ProjectStore;
  engine: () => OperationEngine;
  publishRevision: (revision: string) => void;
}

function assetTiming(
  asset: Asset,
  timelineFps: string,
): { fps: string; endFrame: number } {
  const fps = asset.video?.fps ?? asset.probe.fps ?? timelineFps;
  const duration = asset.probe.duration;
  if (duration === undefined) return { fps, endFrame: 1 };
  const converted = "frames" in duration
    ? convertTimeRounding(duration, fps)
    : convertTimeRounding(
        { frames: duration.samples, fps: `${String(duration.rate)}/1` },
        fps,
      );
  return {
    fps,
    endFrame: converted.ok ? Math.max(1, converted.value.time.frames) : 1,
  };
}

function markerFingerprint(
  marker: TakeMarkerSidecar["markers"][number],
): string {
  return JSON.stringify({
    at: marker.at,
    type: marker.type,
    note: marker.note ?? null,
    anchor: marker.anchor ?? null,
    detected: marker.detected ?? false,
    source: marker.source,
  });
}

function takeIdentity(
  take: TakeMarkerSidecar["takes"][number],
): string {
  return JSON.stringify({
    assetId: take.assetId,
    index: take.index,
    range: take.range,
  });
}

export class CaptureProjectMetadata {
  readonly #store: ProjectStore;
  readonly #engine: () => OperationEngine;
  readonly #publishRevision: (revision: string) => void;
  #mutationTail: Promise<void> = Promise.resolve();

  public constructor(options: CaptureProjectMetadataOptions) {
    this.#store = options.store;
    this.#engine = options.engine;
    this.#publishRevision = options.publishRevision;
  }

  public async list(): Promise<TakeMarkerSidecar[]> {
    await this.#mutationTail;
    return this.#listCurrent();
  }

  async #listCurrent(): Promise<TakeMarkerSidecar[]> {
    return Promise.all(this.#store.currentProject.sidecars
      .filter(({ schema }) => schema === "guyditor.take-markers/v1")
      .map(async ({ path }) => parseTakeMarkerSidecar(
        await readFile(join(this.#store.root, path), "utf8"),
      )));
  }

  public async seedTake(
    assetId: string,
    seed: { id: string; index: number },
  ): Promise<void> {
    await this.#mutate(async () => {
      const project = this.#store.currentProject;
      const asset = project.assets.find(({ id }) => id === assetId);
      if (asset === undefined) throw new Error(`Capture asset ${assetId} is unavailable.`);
      const sidecar = await this.#sidecar(assetId);
      if (sidecar.takes.some(({ id }) => id === seed.id)) return;
      const timing = assetTiming(asset, project.settings.timeline.fps);
      sidecar.takes.push({
        id: seed.id,
        assetId,
        index: seed.index,
        range: { start: 0, end: timing.endFrame, fps: timing.fps },
        quality: "unrated",
        notes: [],
        sourceMarkerIds: [],
      });
      await this.#persist(sidecar);
    });
  }

  public timing(assetId: string): { fps: string; endFrame: number } {
    const project = this.#store.currentProject;
    const asset = project.assets.find(({ id }) => id === assetId);
    if (asset === undefined) throw new Error(`Capture asset ${assetId} is unavailable.`);
    return assetTiming(asset, project.settings.timeline.fps);
  }

  public async addMarkers(
    assetId: string,
    markers: TakeMarkerSidecar["markers"],
  ): Promise<void> {
    await this.#mutate(async () => {
      const existing = await this.#sidecar(assetId);
      const fingerprints = new Set(existing.markers.map(markerFingerprint));
      const additions = markers.filter((marker) => {
        const fingerprint = markerFingerprint(marker);
        if (fingerprints.has(fingerprint)) return false;
        fingerprints.add(fingerprint);
        return true;
      });
      if (additions.length === 0) return;
      existing.markers.push(...additions);
      await this.#persist(existing);
    });
  }

  public async importMarkerFile(
    markerPath: string,
    sessionId: string,
  ): Promise<void> {
    const project = this.#store.currentProject;
    const markerName = basename(markerPath).toLocaleLowerCase("en");
    const specificName = markerName === "markers.json" || markerName === "notes.txt"
      ? undefined
      : markerName.slice(0, -".markers.json".length);
    const assets = project.assets.filter((asset) => {
      if (asset.session !== sessionId) return false;
      if (specificName === undefined) return true;
      const mediaName = basename(asset.path).toLocaleLowerCase("en");
      return mediaName === specificName ||
        mediaName.slice(0, -extname(mediaName).length) === specificName;
    });
    const text = await readFile(markerPath, "utf8");
    let changed = false;
    for (const asset of assets) {
      const timing = assetTiming(asset, project.settings.timeline.fps);
      const imported = markerName.endsWith(".json")
        ? importJsonTakeMarkers(text, {
            assetId: asset.id,
            fps: timing.fps,
            assetEndFrame: timing.endFrame,
            idFactory: makeId,
            ...(asset.captureTime === undefined
              ? {}
              : { captureStart: asset.captureTime.value }),
          })
        : importTakeNotes(text, {
            assetId: asset.id,
            fps: timing.fps,
            assetEndFrame: timing.endFrame,
            idFactory: makeId,
          });
      const importedForAsset = await this.#mutate(async () => {
        const existing = await this.#sidecar(asset.id);
        const markerIds = new Map(existing.markers.map((marker) => [
          markerFingerprint(marker),
          marker.id,
        ]));
        const markers = imported.markers.filter((marker) => {
          const fingerprint = markerFingerprint(marker);
          if (markerIds.has(fingerprint)) return false;
          markerIds.set(fingerprint, marker.id);
          return true;
        });
        const importedMarkers = new Map(imported.markers.map((marker) => [
          marker.id,
          markerFingerprint(marker),
        ]));
        const takes = existing.takes.map((take) => structuredClone(take));
        let takesChanged = false;
        for (const importedTake of imported.takes) {
          const merged = {
            ...structuredClone(importedTake),
            sourceMarkerIds: importedTake.sourceMarkerIds.flatMap((markerId) => {
              const fingerprint = importedMarkers.get(markerId);
              const persistedId = fingerprint === undefined
                ? undefined
                : markerIds.get(fingerprint);
              return persistedId === undefined ? [] : [persistedId];
            }),
          };
          const index = takes.findIndex((take) =>
            takeIdentity(take) === takeIdentity(importedTake));
          if (index < 0) {
            takes.push(merged);
            takesChanged = true;
            continue;
          }
          const replacement = { ...merged, id: takes[index]!.id };
          if (JSON.stringify(takes[index]) !== JSON.stringify(replacement)) {
            takes[index] = replacement;
            takesChanged = true;
          }
        }
        if (markers.length === 0 && !takesChanged) return false;
        await this.#persist({
          ...existing,
          markers: [...existing.markers, ...markers],
          takes,
        });
        return true;
      });
      changed ||= importedForAsset;
    }
    if (changed) this.#publishRevision(this.#store.currentProject.revision);
  }

  async #sidecar(assetId: string): Promise<TakeMarkerSidecar> {
    const existing = (await this.#listCurrent()).find((sidecar) =>
      sidecar.assetId === assetId);
    return existing ?? {
      format: "guyditor.take-markers/v1",
      assetId,
      markers: [],
      takes: [],
    };
  }

  async #persist(sidecar: TakeMarkerSidecar): Promise<void> {
    const content = serializeTakeMarkerSidecar(sidecar);
    const relativePath = `sidecars/takes/${sidecar.assetId}.takes.json`;
    const absolutePath = join(this.#store.root, relativePath);
    let previous: Buffer | undefined;
    try {
      previous = await readFile(absolutePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(join(this.#store.root, "sidecars/takes"), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await this.#engine().execute([
          {
            op: "asset.markers.attach",
            params: {
              assetId: sidecar.assetId,
              markerIds: sidecar.markers.map(({ id }) => id),
              sidecar: { path: relativePath, sha256 },
            },
          },
          {
            op: "asset.takes.set",
            params: {
              assetId: sidecar.assetId,
              takeIds: sidecar.takes.map(({ id }) => id),
              sidecar: { path: relativePath, sha256 },
            },
          },
        ], {
          baseRevision: this.#store.currentProject.revision,
          origin: "system",
          dryRun: false,
          recordUndo: false,
          instruction: { kind: "ui-direct", text: "Attach capture take metadata" },
        });
        if (result.ok) return;
        if (result.error.code !== "E_OP_STALE_BASE" || attempt === 2) {
          throw result.error;
        }
      }
    } catch (error: unknown) {
      if (previous === undefined) {
        await rm(absolutePath, { force: true });
      } else {
        await writeFile(absolutePath, previous);
      }
      throw error;
    }
  }

  #mutate<Value>(mutation: () => Promise<Value>): Promise<Value> {
    const result = this.#mutationTail.then(mutation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
