import type { FramingRect } from "../../../core/src/index.js";

interface Rect { x: number; y: number; w: number; h: number }

function rounded(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function percent(value: number): string {
  return `${String(rounded(value * 100))}%`;
}

export function cropVideoStyle(crop: FramingRect): {
  width: string;
  height: string;
  left: string;
  top: string;
} {
  return {
    width: percent(1 / crop.w),
    height: percent(1 / crop.h),
    left: percent(-crop.x / crop.w),
    top: percent(-crop.y / crop.h),
  };
}

export function projectTrackBox(box: Rect, crop: FramingRect): Rect {
  return {
    x: rounded((box.x - crop.x) / crop.w),
    y: rounded((box.y - crop.y) / crop.h),
    w: rounded(box.w / crop.w),
    h: rounded(box.h / crop.h),
  };
}
