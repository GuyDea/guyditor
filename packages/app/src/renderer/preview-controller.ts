function fpsParts(fps: string): { numerator: number; denominator: number } {
  const match = /^(\d+)\/(\d+)$/u.exec(fps);
  if (match === null) throw new TypeError(`Invalid frame rate ${fps}.`);
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (numerator <= 0 || denominator <= 0) throw new RangeError(`Invalid frame rate ${fps}.`);
  return { numerator, denominator };
}

export function frameCenterSeconds(frame: number, fps: string): number {
  const rate = fpsParts(fps);
  return (frame + 0.5) * rate.denominator / rate.numerator;
}

export function nudgeFrameCenterSeconds(
  frame: number,
  fps: string,
  direction: "earlier" | "later",
): number {
  const rate = fpsParts(fps);
  const offset = direction === "earlier" ? 0.25 : 0.75;
  return (frame + offset) * rate.denominator / rate.numerator;
}

export function nominalFps(fps: string): number {
  const rate = fpsParts(fps);
  return Math.ceil(rate.numerator / rate.denominator);
}

export function formatTimecode(frame: number, fps: string): string {
  const rate = nominalFps(fps);
  const safeFrame = Math.max(0, Math.round(frame));
  const ff = safeFrame % rate;
  const totalSeconds = Math.floor(safeFrame / rate);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return [hours, minutes, seconds, ff]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}
