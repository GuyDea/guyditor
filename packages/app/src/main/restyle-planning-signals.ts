import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AnchorResolverRegistry,
  resolveAnchor,
} from "../../../core/src/index.js";
import type { ProjectStore } from "../../../core/src/index.js";
import type { RestylePlanningSignals } from "../../../deliver/src/index.js";
import {
  buildWordTimelineMap,
  createTranscriptWordLookup,
} from "../../../transcript/src/index.js";
import { transcriptSidecars } from "./project-readers.js";

function framesAtFps(
  time: { num: number; den: number },
  fps: string,
): number {
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(fps);
  if (match === null) throw new Error(`Timeline fps ${fps} is invalid.`);
  return Math.round(time.num / time.den * Number(match[1]) / Number(match[2]));
}

function restyleAnalysisSignals(value: unknown): Pick<
  RestylePlanningSignals,
  "vadSilences" | "lowMotionFrames"
> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { vadSilences: [], lowMotionFrames: [] };
  }
  const record = value as Record<string, unknown>;
  const vadSilences = Array.isArray(record["vadSilences"])
    ? record["vadSilences"].flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const range = entry as Record<string, unknown>;
        return Number.isSafeInteger(range["startFrame"]) && Number.isSafeInteger(range["endFrame"])
          ? [{ startFrame: Number(range["startFrame"]), endFrame: Number(range["endFrame"]) }]
          : [];
      })
    : [];
  const lowMotionFrames = Array.isArray(record["lowMotionFrames"])
    ? record["lowMotionFrames"].filter((frame): frame is number =>
        typeof frame === "number" && Number.isSafeInteger(frame) && frame >= 0)
    : [];
  return { vadSilences, lowMotionFrames };
}

export async function planningSignals(
  store: ProjectStore,
  deliverableId: string,
): Promise<RestylePlanningSignals> {
  const project = store.currentProject;
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
  const sources = project.layers.filter(({ enabled, sequence }) =>
    enabled && sequence === deliverable.sequenceId).map(({ id }) => id);
  const sidecars = await transcriptSidecars(store);
  const timeline = buildWordTimelineMap({
    project,
    sequenceId: deliverable.sequenceId,
    sidecars,
    track: {
      id: "restyle-planning",
      name: "Restyle planning",
      sourceLayerIds: sources,
      preset: { presetId: "restyle-planning", version: 1 },
      styleOverrides: {},
      breakOverrides: [],
      emphasisOverrides: [],
      timingOffsets: [],
      enabled: true,
    },
  });
  let analysis: Pick<RestylePlanningSignals, "vadSilences" | "lowMotionFrames"> = {
    vadSilences: [],
    lowMotionFrames: [],
  };
  try {
    analysis = restyleAnalysisSignals(JSON.parse(await readFile(
      join(store.root, "sidecars/analysis/restyle-signals.json"),
      "utf8",
    )) as unknown);
  } catch {
    // Word gaps remain the deterministic fallback when analysis is unavailable.
  }
  const resolvers = new AnchorResolverRegistry();
  resolvers.registerWordLookup(createTranscriptWordLookup(sidecars));
  const beats = await Promise.all(project.beats.map(async (beat) => {
    const resolved = await resolveAnchor(
      project,
      beat.anchor,
      deliverable.sequenceId,
      resolvers.dependencies(),
    );
    return resolved.ok && resolved.value.status === "resolved" && resolved.value.timeline !== undefined
      ? { id: beat.id, frame: resolved.value.timeline.frames }
      : undefined;
  }));
  return {
    words: timeline.instances.map((word) => ({
      id: word.wordId,
      startFrame: framesAtFps(word.start, project.settings.timeline.fps),
      endFrame: framesAtFps(word.end, project.settings.timeline.fps),
    })),
    beats: beats.flatMap((beat) => beat === undefined ? [] : [beat]),
    vadSilences: analysis.vadSilences,
    lowMotionFrames: analysis.lowMotionFrames,
  };
}
