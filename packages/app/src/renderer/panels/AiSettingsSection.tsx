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
  /** Test seam: show a CLI check result without running the check. */
  initialCliStatus?: string;
}

export function AiSettingsSection({
  settings,
  onSettings,
  setNotice,
  initialModels = [],
  initialCliStatus = "",
}: AiSettingsSectionProps): React.JSX.Element {
  const [models, setModels] = useState<string[]>(initialModels);
  const [key, setKey] = useState("");
  const [cliStatus, setCliStatus] = useState(initialCliStatus);
  const hasKey = settings.keys[settings.provider];
  const transport = settings.transport[settings.provider];
  const cliName = settings.provider === "anthropic" ? "claude" : "codex";
  const cliPathKey = settings.provider === "anthropic" ? "claudePath" : "codexPath";
  const canList = hasKey || transport === "cli";

  useEffect(() => {
    if (!canList) {
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
  }, [canList, settings.provider]);

  async function update(patch: Record<string, unknown>): Promise<void> {
    try {
      onSettings(await window.guyditor.call<AiSettingsView>("AiSettings", "update", patch));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function checkCli(): Promise<void> {
    setCliStatus("Checking…");
    try {
      const result = await window.guyditor.call<{ ok: true; version: string } | { ok: false; message: string }>(
        "AiSettings",
        "checkCli",
        { provider: settings.provider },
      );
      setCliStatus(result.ok ? `${cliName} ${result.version} ✓` : result.message);
    } catch (error: unknown) {
      setCliStatus(errorMessage(error));
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
      <div className="filter-row" role="radiogroup" aria-label="Connect via">
        {(["api", "cli"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="ai-transport"
              value={value}
              checked={transport === value}
              data-testid={`ai-transport-${value}`}
              onChange={() => void update({ transport: { [settings.provider]: value } })}
            />
            {value === "api" ? "API key" : `local CLI (${cliName})`}
          </label>
        ))}
      </div>
      {transport === "api" ? (
        <>
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
        </>
      ) : (
        <>
          <div className="path-ingest">
            <input
              type="text"
              aria-label={`${cliName} path`}
              defaultValue={settings.cli[cliPathKey]}
              key={`${cliPathKey}-${settings.cli[cliPathKey]}`}
              data-testid="ai-cli-path"
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== "" && value !== settings.cli[cliPathKey]) void update({ cli: { [cliPathKey]: value } });
              }}
            />
            <button type="button" data-testid="ai-cli-check" onClick={() => void checkCli()}>Check</button>
          </div>
          <small data-testid="ai-cli-status">{cliStatus}</small>
        </>
      )}
      {settings.encryptionAvailable ? null : (
        <small data-testid="ai-encryption-warning">
          Keys will not persist across restarts on this system.
        </small>
      )}
    </div>
  );
}
