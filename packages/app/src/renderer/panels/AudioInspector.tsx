import { useEffect, useState } from "react";

import type {
  DuckingConfig,
  GuyditorProject,
  Layer,
} from "../../../../core/src/index.js";
import { errorMessage, executeDirect } from "../ipc.js";
import { directEditDivergence } from "./direct-edit-divergence.js";

const AUDIO_ROLES = new Set<Layer["kind"]>(["audio", "music", "ambience", "sfx"]);
const DEFAULT_CONFIG: DuckingConfig = {
  enabled: true,
  mode: "auto",
  duckDb: -12,
  attackMs: 150,
  releaseMs: 400,
  holdMs: 250,
  minGapMs: 700,
};

interface AudioInspectorProps {
  layer: Layer | undefined;
  project: GuyditorProject | undefined;
  timelineFps: string;
  refreshProject(): Promise<void>;
  setNotice(message: string): void;
}

export function AudioInspector({
  layer,
  project,
  timelineFps,
  refreshProject,
  setNotice,
}: AudioInspectorProps): React.JSX.Element | null {
  const [config, setConfig] = useState<DuckingConfig>(DEFAULT_CONFIG);
  const [overrideAnchor, setOverrideAnchor] = useState(`timeline:0@${timelineFps}`);
  const [overrideGain, setOverrideGain] = useState(-12);

  useEffect(() => {
    if (layer !== undefined && AUDIO_ROLES.has(layer.kind)) {
      setConfig(layer.ducking === undefined ? DEFAULT_CONFIG : configOnly(layer.ducking));
    }
  }, [layer]);

  if (layer === undefined || !AUDIO_ROLES.has(layer.kind)) return null;

  async function commit(
    operations: Array<{ op: string; params: Record<string, unknown> }>,
    label: string,
    success: string,
  ): Promise<void> {
    try {
      await executeDirect(
        operations,
        label,
        project === undefined
          ? undefined
          : directEditDivergence(project, operations),
      );
      await refreshProject();
      setNotice(success);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  return (
    <section className="audio-inspector" data-testid="audio-inspector">
      <header>
        <div><strong>Ducking</strong><span>{layer.name} · {layer.kind}</span></div>
        <label className="duck-enabled">
          <input
            type="checkbox"
            checked={config.enabled}
            data-testid="duck-enabled"
            onChange={(event) => setConfig({ ...config, enabled: event.currentTarget.checked })}
          /> Enabled
        </label>
      </header>
      <div className="duck-config-grid">
        <label>Mode
          <select
            value={config.mode}
            data-testid="duck-mode"
            onChange={(event) => setConfig({ ...config, mode: event.currentTarget.value as "auto" | "manual" })}
          >
            <option value="auto">Auto · speech VAD</option>
            <option value="manual">Manual points</option>
          </select>
        </label>
        <NumberField label="Duck dB" testId="duck-db" value={config.duckDb} min={-96} max={0} onChange={(duckDb) => setConfig({ ...config, duckDb })} />
        <NumberField label="Attack ms" testId="duck-attack" value={config.attackMs} min={0} onChange={(attackMs) => setConfig({ ...config, attackMs })} />
        <NumberField label="Release ms" testId="duck-release" value={config.releaseMs} min={0} onChange={(releaseMs) => setConfig({ ...config, releaseMs })} />
        <NumberField label="Hold ms" testId="duck-hold" value={config.holdMs} min={0} onChange={(holdMs) => setConfig({ ...config, holdMs })} />
        <NumberField label="Min gap ms" testId="duck-min-gap" value={config.minGapMs} min={0} onChange={(minGapMs) => setConfig({ ...config, minGapMs })} />
      </div>
      <div className="duck-actions">
        <button
          type="button"
          className="primary-action"
          data-testid="duck-save"
          onClick={() => void commit(
            [{ op: "layer.ducking.set", params: { layerId: layer.id, config } }],
            `Set ducking on ${layer.id}`,
            `Saved ${config.mode} ducking at ${String(config.duckDb)} dB.`,
          )}
        >Save ducking</button>
        <button
          type="button"
          data-testid="duck-clear"
          onClick={() => void commit(
            [{ op: "layer.ducking.set", params: { layerId: layer.id, config: null } }],
            `Clear ducking on ${layer.id}`,
            `Cleared ducking on ${layer.name}.`,
          )}
        >Clear</button>
      </div>
      <div className="duck-override-row">
        <label>Exact anchor
          <input
            type="text"
            value={overrideAnchor}
            data-testid="duck-override-anchor"
            onChange={(event) => setOverrideAnchor(event.currentTarget.value)}
          />
        </label>
        <NumberField label="Gain dB" testId="duck-override-gain" value={overrideGain} min={-96} max={12} onChange={setOverrideGain} />
        <button
          type="button"
          data-testid="duck-override-add"
          disabled={layer.ducking === undefined}
          onClick={() => void commit(
            [{
              op: "layer.ducking.override",
              params: {
                layerId: layer.id,
                points: [
                  ...(layer.ducking?.overrides ?? []),
                  { at: overrideAnchor, gainDb: overrideGain },
                ],
              },
            }],
            `Add ducking point on ${layer.id}`,
            `Added manual ducking point at ${overrideAnchor}.`,
          )}
        >Add point</button>
      </div>
      <small>{String(layer.ducking?.overrides.length ?? 0)} manual points · exact semantic or rational-frame anchors</small>
    </section>
  );
}

function configOnly(config: DuckingConfig): DuckingConfig {
  return {
    enabled: config.enabled,
    mode: config.mode,
    duckDb: config.duckDb,
    attackMs: config.attackMs,
    releaseMs: config.releaseMs,
    holdMs: config.holdMs,
    minGapMs: config.minGapMs,
  };
}

function NumberField({
  label,
  testId,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  testId: string;
  value: number;
  min: number;
  max?: number;
  onChange(value: number): void;
}): React.JSX.Element {
  return (
    <label>{label}
      <input
        type="number"
        value={value}
        min={min}
        {...(max === undefined ? {} : { max })}
        data-testid={testId}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber || 0)}
      />
    </label>
  );
}
