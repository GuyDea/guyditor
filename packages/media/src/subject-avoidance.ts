import type { AvoidRegion } from "../../core/src/index.js";
import type { MlworkerTrackBox } from "./mlworker/types.js";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function stableToken(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  let token = "";
  for (let index = 0; index < 10; index += 1) {
    left = Math.imul(left ^ index, 0x27d4eb2d) >>> 0;
    right = Math.imul(right ^ (index + 17), 0x165667b1) >>> 0;
    token += ID_ALPHABET[(index % 2 === 0 ? left : right) & 31];
  }
  return token;
}

export function subjectTrackAvoidRegions(
  boxes: readonly MlworkerTrackBox[],
  timelineFrame: number,
): AvoidRegion[] {
  if (!Number.isSafeInteger(timelineFrame) || timelineFrame < 0) {
    throw new RangeError("Subject collision-provider frame must be a non-negative safe integer.");
  }
  return boxes.filter(({ conf }) => conf >= 0.5).map((box): AvoidRegion => ({
    id: `avr_${stableToken(`${box.kind}:${box.trackId}`)}`,
    source: box.kind === "face"
      ? "face"
      : box.kind === "screen-region" ? "diagram" : "subject",
    hardness: "soft",
    rect: { x: box.x, y: box.y, w: box.w, h: box.h },
    frames: { from: timelineFrame, to: timelineFrame },
  }));
}
