import {
  loudnessMeterStatus,
  meterFillPercent,
} from "../loudness-meter.js";
import type {
  LoudnessFrame,
  LoudnessTargetOverlay,
} from "../loudness-meter.js";

interface LoudnessMeterProps {
  available: boolean;
  frame: LoudnessFrame;
  target: LoudnessTargetOverlay;
  onReset(): void;
}

export function LoudnessMeter({
  available,
  frame,
  target,
  onReset,
}: LoudnessMeterProps): React.JSX.Element {
  const status = available
    ? loudnessMeterStatus(frame.integratedLufs, frame.truePeakDbtp, target)
    : "idle";
  const peaks = frame.truePeakDbtp.length === 0
    ? [-Infinity, -Infinity]
    : frame.truePeakDbtp;
  return (
    <section className="loudness-meter" data-testid="loudness-meter" aria-label="Preview loudness meter">
      <header>
        <div>
          <strong>PROGRAM METER</strong>
          <span data-testid="loudness-target">
            master {formatDb(target.integratedLufs)} LUFS · ceiling {formatDb(target.truePeakDbtp)} dBTP
          </span>
        </div>
        <span
          className="meter-verdict"
          data-status={status}
          data-testid="loudness-status"
          title="Advisory preview measurement. Export validation remains authoritative."
        >
          {available ? status : "unavailable"}
        </span>
        <button type="button" data-testid="loudness-reset" onClick={onReset}>Reset measurement</button>
      </header>
      <div className="meter-bank">
        <LoudnessBar label="M" value={frame.momentaryLufs} />
        <LoudnessBar label="S" value={frame.shortTermLufs} />
        <LoudnessBar label="I" value={frame.integratedLufs ?? -Infinity} target={target} />
        <div className="true-peak-bank" aria-label="Per-channel true peak">
          {peaks.map((peak, index) => (
            <div key={index} className="true-peak-channel">
              <span>TP {String(index + 1)}</span>
              <div className="true-peak-track">
                <i style={{ height: `${String(meterFillPercent(peak))}%` }} />
                <b style={{ bottom: `${String(meterFillPercent(target.truePeakDbtp))}%` }} />
              </div>
              <output>{formatDb(peak)}</output>
            </div>
          ))}
        </div>
      </div>
      <small>{target.profileId} · 10 Hz · preview proxy analysis</small>
    </section>
  );
}

function LoudnessBar({
  label,
  value,
  target,
}: {
  label: "M" | "S" | "I";
  value: number;
  target?: LoudnessTargetOverlay;
}): React.JSX.Element {
  const bandBottom = target === undefined
    ? 0
    : meterFillPercent(target.integratedLufs - target.toleranceLu);
  const bandHeight = target === undefined
    ? 0
    : meterFillPercent(target.integratedLufs + target.toleranceLu) - bandBottom;
  return (
    <div className="loudness-bar">
      <span>{label}</span>
      <div className="loudness-track">
        {target === undefined ? null : (
          <b className="target-band" style={{ bottom: `${String(bandBottom)}%`, height: `${String(bandHeight)}%` }} />
        )}
        <i style={{ height: `${String(meterFillPercent(value))}%` }} />
      </div>
      <output>{formatDb(value)}</output>
    </div>
  );
}

function formatDb(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1).replace("-", "−") : "−∞";
}
