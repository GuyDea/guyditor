/** Exact rational serialized as "<num>/<den>" with den > 0 and gcd = 1. */
export type Rational = string;

export interface FrameTime {
  frames: number;
  fps: Rational;
}

export interface SampleTime {
  samples: number;
  rate: number;
}

export type TimeValue = FrameTime | SampleTime;

export type Ordering = -1 | 0 | 1;

export interface RoundedFrameTime {
  time: FrameTime;
  preRoundingFrames: Rational;
}
