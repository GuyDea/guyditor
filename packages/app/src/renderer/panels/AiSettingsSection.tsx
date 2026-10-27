import { useEffect, useState } from "react";

import type { AiSettingsView } from "../../shared/ipc.js";
import { errorMessage } from "../ipc.js";

type Provider = AiSettingsView["provider"];

interface AiSettingsSectionProps {
  settings: AiSettingsView;
  onSettings: (settings: AiSettingsView) => void;
  setNotice: (notice: string) => void;
  /** Test seam: skip the `listModels` round trip. */
  initialModels?: string[];
}

export function AiSettingsSection({
  settings,
  onSettings,
  setNotice,
  initialModels = [],
}: AiSettingsSectionProps): React.JSX.Element {
  const [models, setModels] = useState<string[]>(initialModels);
  const [key, setKey] = useState("");
  const hasKey = settings.keys[settings.provider];

  useEffect(() => {
    if (!hasKey) {
      setModels([]);
      return;
    }
    let active = true;
    window.guyditor.call<string[]>("AiSettings", "listModels", { provider: settings.provider })
      .then((listed) => {
        if (active) setModels(listed);
      })
      .catch(() => {
        if (active) setModels([]);
      });
    return () => {
      active = false;
    };
  }, [hasKey, settings.provider]);

  async function update(patch: Record<string, unknown>): Promise<void> {
    try {
      onSettings(await window.guyditor.call<AiSettingsView>("AiSettings", "update", patch));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function saveKey(): Promise<void> {
    try {
      onSettings(await window.guyditor.call<AiSettingsView>(
        "AiSettings",
        "setKey",
        { provider: settings.provider, key },
      ));
      setKey("");
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function clearKey(): Promise<void> {
    try {
      onSettings(await window.guyditor.call<AiSettingsView>(
        "AiSettings",
        "clearKey",
        { provider: settings.provider },
      ));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function setRate(model: string, field: "inputPerMTok" | "outputPerMTok", value: string): void {
    const parsed = Number(value);
    const current = settings.rates[model] ?? { inputPerMTok: 0, outputPerMTok: 0 };
    if (!Number.isFinite(parsed) || parsed < 0) return;
    void update({ rates: { ...settings.rates, [model]: { ...current, [field]: parsed } } });
  }

  return (
    <div className="ai-settings" data-testid="ai-settings">
      <div className="filter-row" role="radiogroup" aria-label="AI provider">
        {(["anthropic", "openai"] as const satisfies readonly Provider[]).map((provider) => (
          <label key={provider}>
            <input
              type="radio"
              name="ai-provider"
              value={provider}
              checked={settings.provider === provider}
              data-testid={`ai-provider-${provider}`}
              onChange={() => void update({ provider })}
            />
            {provider}
          </label>
        ))}
      </div>
      <label>
        Model
        <input
          type="text"
          list="ai-model-options"
          defaultValue={settings.model}
          key={`${settings.provider}-${settings.model}`}
          data-testid="ai-model"
          onBlur={(event) => {
            const model = event.target.value.trim();
            if (model !== "" && model !== settings.model) void update({ model });
          }}
        />
        <datalist id="ai-model-options">
          {models.map((model) => <option key={model} value={model} />)}
        </datalist>
      </label>
      <label>
        Effort
        <select
          value={settings.effort}
          data-testid="ai-effort"
          onChange={(event) => void update({ effort: event.target.value })}
        >
          {["low", "medium", "high", "max"].map((effort) => (
            <option key={effort} value={effort}>{effort}</option>
          ))}
        </select>
      </label>
      <label>
        Tightening
        <select
          value={settings.tightening}
          data-testid="ai-tightening"
          onChange={(event) => void update({ tightening: event.target.value })}
        >
          {["ask", "gentle", "off"].map((mode) => (
            <option key={mode} value={mode}>{mode}</option>
          ))}
        </select>
      </label>
      <div className="path-ingest">
        <input
          type="password"
          autoComplete="off"
          placeholder={`${settings.provider} API key`}
          aria-label="API key"
          value={key}
          data-testid="ai-key"
          onChange={(event) => setKey(event.target.value)}
        />
        <button
          type="button"
          data-testid="ai-key-save"
          disabled={key.trim() === ""}
          onClick={() => void saveKey()}
        >Save</button>
        <button
          type="button"
          data-testid="ai-key-clear"
          disabled={!hasKey}
          onClick={() => void clearKey()}
        >Clear</button>
      </div>
      <small data-testid="ai-key-status">{hasKey ? "Key saved ✓" : "No key"}</small>
      {settings.encryptionAvailable ? null : (
        <small data-testid="ai-encryption-warning">
          Keys will not persist across restarts on this system.
        </small>
      )}
      <table className="ai-rates">
        <thead>
          <tr><th>Model</th><th>$ / M in</th><th>$ / M out</th></tr>
        </thead>
        <tbody>
          {Object.entries(settings.rates).map(([model, rate]) => (
            <tr key={model} data-testid={`ai-rate-${model}`}>
              <td>{model}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  aria-label={`${model} input rate`}
                  defaultValue={rate.inputPerMTok}
                  onBlur={(event) => setRate(model, "inputPerMTok", event.target.value)}
                />
              </td>
              <td>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  aria-label={`${model} output rate`}
                  defaultValue={rate.outputPerMTok}
                  onBlur={(event) => setRate(model, "outputPerMTok", event.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
