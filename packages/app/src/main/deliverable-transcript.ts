import type { ProjectStore } from "../../../core/src/index.js";
import {
  extractTranscriptText,
} from "../../../deliver/src/index.js";
import type {
  DeliverableTranscript,
} from "../../../deliver/src/index.js";

import { transcriptSidecars } from "./project-readers.js";

export function deliverableTranscripts(
  sidecars: Awaited<ReturnType<typeof transcriptSidecars>>,
): DeliverableTranscript[] {
  return sidecars.map((sidecar) => ({
    assetId: sidecar.assetId,
    words: sidecar.segments.flatMap(({ words }) => words).flatMap((id) => {
      const word = sidecar.words[id];
      return word === undefined ? [] : [{
        id,
        text: word.text,
        punctAfter: word.punctAfter,
        state: word.state,
        start: structuredClone(word.start),
        end: structuredClone(word.end),
      }];
    }),
  }));
}

export async function publishTranscript(
  store: ProjectStore,
  deliverableId: string,
): Promise<{
  language: string;
  text: string;
}> {
  const project = store.currentProject;
  const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
  if (deliverable === undefined) throw new Error(`Deliverable ${deliverableId} does not exist.`);
  const sidecars = await transcriptSidecars(store);
  const words = sidecars.flatMap((sidecar) => Object.entries(sidecar.words).map(([id, word]) => ({
    id,
    assetId: sidecar.assetId,
    text: word.text,
    punctAfter: word.punctAfter,
    startSamples: word.start.samples,
    endSamples: word.end.samples,
    rate: word.start.rate,
    state: word.state,
    ...(sidecar.speakers.find(({ id: speakerId }) => speakerId === sidecar.segments
      .find(({ words: segmentWords }) => segmentWords.includes(id))?.speaker)?.label === undefined
      ? {}
      : { speaker: sidecar.speakers.find(({ id: speakerId }) => speakerId === sidecar.segments
          .find(({ words: segmentWords }) => segmentWords.includes(id))?.speaker)!.label }),
  })));
  const clips = deliverable.dependencies?.flatMap(({ source }) => source.words === undefined ? [] : [{
    assetId: source.assetId,
    startWordId: source.words.startWordId,
    endWordId: source.words.endWordId,
  }]) ?? [];
  if (clips.length === 0) {
    const sequence = project.sequences.find(({ id }) => id === deliverable.sequenceId);
    for (const clip of sequence?.clips ?? []) {
      if (clip.origin === "local") continue;
      const sidecar = sidecars.find(({ assetId }) => assetId === clip.asset);
      if (sidecar === undefined) continue;
      const [fpsNumerator = "0", fpsDenominator = "1"] = clip.source.in.fps.split("/");
      const fps = Number(fpsNumerator) / Number(fpsDenominator);
      const sourceStart = clip.source.in.frames / fps;
      const sourceEnd = clip.source.out.frames / fps;
      const ids = Object.entries(sidecar.words)
        .filter(([, word]) => word.state === "active" &&
          word.end.samples / word.end.rate > sourceStart &&
          word.start.samples / word.start.rate < sourceEnd)
        .map(([id]) => id)
        .sort();
      if (ids[0] !== undefined && ids.at(-1) !== undefined) {
        clips.push({ assetId: sidecar.assetId, startWordId: ids[0], endWordId: ids.at(-1)! });
      }
    }
  }
  const beatWordIds = project.beats.flatMap(({ anchor }) => {
    const match = /^word:(w[0-9]{6})/u.exec(anchor);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  return {
    language: sidecars.find(({ language }) => language.length > 0)?.language ?? "en",
    text: extractTranscriptText({ clips, beatWordIds, words }),
  };
}
