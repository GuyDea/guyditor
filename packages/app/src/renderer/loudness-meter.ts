export interface LoudnessFrame {
  momentaryLufs: number;
  shortTermLufs: number;
  integratedLufs: number | null;
  truePeakDbtp: number[];
}

export interface LoudnessTargetOverlay {
  integratedLufs: number;
  toleranceLu: number;
  truePeakDbtp: number;
  profileId: string;
}

export type LoudnessMeterStatus = "idle" | "pass" | "warn" | "fail";

export interface LoudnessMeterController {
  reset(): void;
  resume(): Promise<void>;
  dispose(): Promise<void>;
}

export const LOUDNESS_WORKLET_SOURCE = String.raw`
const PRE_B = [1.53512485958697, -2.69169618940638, 1.19839281085285];
const PRE_A = [-1.69065929318241, 0.73248077421585];
const RLB_B = [1, -2, 1];
const RLB_A = [-1.99004745483398, 0.99007225036621];

class GuyditorLoudnessWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset();
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "reset") this.reset();
    };
  }

  reset() {
    this.filterStates = [];
    this.blockEnergy = 0;
    this.blockSamples = 0;
    this.energies = [];
    this.previousSamples = [];
    this.blockPeaks = [];
    this.peakHistory = [];
  }

  filter(sample, channel) {
    const state = this.filterStates[channel] || {
      pre: { x1: 0, x2: 0, y1: 0, y2: 0 },
      rlb: { x1: 0, x2: 0, y1: 0, y2: 0 },
    };
    this.filterStates[channel] = state;
    const biquad = (value, part, b, a) => {
      const result = b[0] * value + b[1] * part.x1 + b[2] * part.x2 -
        a[0] * part.y1 - a[1] * part.y2;
      part.x2 = part.x1;
      part.x1 = value;
      part.y2 = part.y1;
      part.y1 = result;
      return result;
    };
    return biquad(biquad(sample, state.pre, PRE_B, PRE_A), state.rlb, RLB_B, RLB_A);
  }

  lufs(energy) {
    return energy <= 0 ? -Infinity : -0.691 + 10 * Math.log10(energy);
  }

  windowEnergy(count) {
    const values = this.energies.slice(-count);
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  integrated() {
    if (this.energies.length < 4) return null;
    const windows = [];
    for (let index = 3; index < this.energies.length; index += 1) {
      windows.push((this.energies[index] + this.energies[index - 1] +
        this.energies[index - 2] + this.energies[index - 3]) / 4);
    }
    const absolute = windows.filter((energy) => this.lufs(energy) >= -70);
    if (absolute.length === 0) return null;
    const absoluteMean = absolute.reduce((sum, energy) => sum + energy, 0) / absolute.length;
    const relativeGate = this.lufs(absoluteMean) - 10;
    const gated = absolute.filter((energy) => this.lufs(energy) >= relativeGate);
    if (gated.length === 0) return null;
    return this.lufs(gated.reduce((sum, energy) => sum + energy, 0) / gated.length);
  }

  publish() {
    const channels = Math.max(this.blockPeaks.length, 1);
    const truePeakDbtp = [];
    for (let channel = 0; channel < channels; channel += 1) {
      const history = this.peakHistory[channel] || [];
      history.push(this.blockPeaks[channel] || 0);
      if (history.length > 30) history.shift();
      this.peakHistory[channel] = history;
      const peak = Math.max(...history, Number.MIN_VALUE);
      truePeakDbtp.push(20 * Math.log10(peak));
    }
    this.energies.push(this.blockEnergy / Math.max(1, this.blockSamples));
    this.port.postMessage({
      momentaryLufs: this.lufs(this.windowEnergy(4)),
      shortTermLufs: this.lufs(this.windowEnergy(30)),
      integratedLufs: this.integrated(),
      truePeakDbtp,
    });
    this.blockEnergy = 0;
    this.blockSamples = 0;
    this.blockPeaks = [];
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const frameCount = input[0] ? input[0].length : 128;
    const oversample = 4;
    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input[Math.min(channel, Math.max(0, input.length - 1))];
      if (source) output[channel].set(source);
    }
    for (let channel = 0; channel < input.length; channel += 1) {
      const samples = input[channel];
      let previous = this.previousSamples[channel] || 0;
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        const weighted = this.filter(sample, channel);
        this.blockEnergy += weighted * weighted;
        for (let phase = 1; phase <= oversample; phase += 1) {
          const interpolated = previous + (sample - previous) * phase / oversample;
          this.blockPeaks[channel] = Math.max(this.blockPeaks[channel] || 0, Math.abs(interpolated));
        }
        previous = sample;
      }
      this.previousSamples[channel] = previous;
    }
    this.blockSamples += frameCount;
    if (this.blockSamples >= sampleRate / 10) this.publish();
    return true;
  }
}

registerProcessor("guyditor-loudness", GuyditorLoudnessWorklet);
`;

export function loudnessMeterStatus(
  integratedLufs: number | null,
  truePeakDbtp: readonly number[],
  target: LoudnessTargetOverlay,
): LoudnessMeterStatus {
  if (integratedLufs === null) return "idle";
  if (truePeakDbtp.some((peak) => peak > target.truePeakDbtp)) return "fail";
  const distance = Math.abs(integratedLufs - target.integratedLufs);
  if (distance > target.toleranceLu) return "fail";
  return distance > target.toleranceLu / 2 ? "warn" : "pass";
}

export function meterFillPercent(lufs: number): number {
  return Math.max(0, Math.min(100, (lufs + 60) / 46 * 100));
}

export async function createLoudnessMeter(
  element: HTMLMediaElement,
  onFrame: (frame: LoudnessFrame) => void,
): Promise<LoudnessMeterController> {
  const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
  const moduleUrl = URL.createObjectURL(new Blob(
    [LOUDNESS_WORKLET_SOURCE],
    { type: "text/javascript" },
  ));
  try {
    await context.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  const source = context.createMediaElementSource(element);
  const worklet = new AudioWorkletNode(context, "guyditor-loudness", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const listener = (event: MessageEvent<unknown>): void => {
    if (isLoudnessFrame(event.data)) onFrame(event.data);
  };
  worklet.port.addEventListener("message", listener);
  worklet.port.start();
  source.connect(worklet);
  worklet.connect(context.destination);
  return {
    reset: () => worklet.port.postMessage({ type: "reset" }),
    resume: async () => context.resume(),
    dispose: async () => {
      worklet.port.removeEventListener("message", listener);
      source.disconnect();
      worklet.disconnect();
      await context.close();
    },
  };
}

function isLoudnessFrame(value: unknown): value is LoudnessFrame {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["momentaryLufs"] === "number" &&
    typeof record["shortTermLufs"] === "number" &&
    (record["integratedLufs"] === null || typeof record["integratedLufs"] === "number") &&
    Array.isArray(record["truePeakDbtp"]) &&
    record["truePeakDbtp"].every((peak) => typeof peak === "number");
}
