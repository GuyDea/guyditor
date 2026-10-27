import { createLlmAdapter } from "../../../agent/src/index.js";
import type { CredentialStore } from "../../../agent/src/index.js";
import { saveAiSettings } from "./settings.js";
import type { AiSettings, UserSettings } from "./settings.js";

type Provider = AiSettings["provider"];
type ExternalCalls = UserSettings["network"]["externalCalls"];

export interface AiSettingsView extends AiSettings {
  keys: { anthropic: boolean; openai: boolean };
  externalCalls: ExternalCalls;
  encryptionAvailable: boolean;
}

export interface AiSettingsServiceOptions {
  userDirectory: string;
  credentials: CredentialStore;
  initial: AiSettings;
  externalCalls: ExternalCalls;
  encryptionAvailable: boolean;
  adapterFactory?: typeof createLlmAdapter;
}

const PROVIDERS: readonly string[] = ["anthropic", "openai"];
const EFFORTS: readonly string[] = ["low", "medium", "high", "max"];
const TIGHTENINGS: readonly string[] = ["ask", "gentle", "off"];
const CREDENTIAL_ID = "llm";

function invalid(what: string): Error {
  return new Error(`E_AI_SETTINGS_INVALID: ${what}`);
}

function checkProvider(value: unknown): Provider {
  if (typeof value !== "string" || !PROVIDERS.includes(value)) throw invalid(`unknown provider ${String(value)}`);
  return value as Provider;
}

function validatedPatch(patch: Partial<AiSettings>): Partial<AiSettings> {
  const out: Partial<AiSettings> = {};
  if (patch.provider !== undefined) out.provider = checkProvider(patch.provider);
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || patch.model.trim() === "") throw invalid("model must be a non-empty string");
    out.model = patch.model;
  }
  if (patch.effort !== undefined) {
    if (!EFFORTS.includes(patch.effort)) throw invalid(`unknown effort ${String(patch.effort)}`);
    out.effort = patch.effort;
  }
  if (patch.tightening !== undefined) {
    if (!TIGHTENINGS.includes(patch.tightening)) throw invalid(`unknown tightening ${String(patch.tightening)}`);
    out.tightening = patch.tightening;
  }
  if (patch.rates !== undefined) {
    for (const [model, rate] of Object.entries(patch.rates)) {
      for (const value of [rate.inputPerMTok, rate.outputPerMTok]) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw invalid(`rate for ${model} must be finite and >= 0`);
        }
      }
    }
    out.rates = structuredClone(patch.rates);
  }
  return out;
}

export class AiSettingsService {
  readonly #options: AiSettingsServiceOptions;
  #settings: AiSettings;

  public constructor(options: AiSettingsServiceOptions) {
    this.#options = options;
    this.#settings = structuredClone(options.initial);
  }

  public current(): AiSettings {
    return structuredClone(this.#settings);
  }

  public externalCalls(): ExternalCalls {
    return this.#options.externalCalls;
  }

  public apiKey(provider: Provider): Promise<string | undefined> {
    return this.#options.credentials.get(CREDENTIAL_ID, provider);
  }

  public async get(): Promise<AiSettingsView> {
    const [anthropic, openai] = await Promise.all([this.apiKey("anthropic"), this.apiKey("openai")]);
    return {
      ...this.current(),
      keys: { anthropic: (anthropic ?? "") !== "", openai: (openai ?? "") !== "" },
      externalCalls: this.#options.externalCalls,
      encryptionAvailable: this.#options.encryptionAvailable,
    };
  }

  public async update(patch: Partial<AiSettings>): Promise<AiSettingsView> {
    const next = { ...this.#settings, ...validatedPatch(patch) };
    await saveAiSettings(this.#options.userDirectory, next);
    this.#settings = next;
    return this.get();
  }

  public async listModels(provider: Provider): Promise<string[]> {
    checkProvider(provider);
    const apiKey = await this.apiKey(provider);
    if (apiKey === undefined || apiKey === "") throw new Error(`E_AI_KEY_MISSING: no API key for ${provider}`);
    return (this.#options.adapterFactory ?? createLlmAdapter)(provider, { apiKey }).listModels();
  }

  public async setKey(provider: Provider, key: string): Promise<AiSettingsView> {
    checkProvider(provider);
    if (typeof key !== "string" || key === "") throw invalid("key must be a non-empty string");
    await this.#options.credentials.set(CREDENTIAL_ID, provider, key);
    return this.get();
  }

  public async clearKey(provider: Provider): Promise<AiSettingsView> {
    checkProvider(provider);
    await this.#options.credentials.delete(CREDENTIAL_ID, provider);
    return this.get();
  }

  public surface(): Record<string, (params: never) => unknown> {
    return {
      get: () => this.get(),
      update: (params: Partial<AiSettings>) => this.update(params),
      listModels: ({ provider }: { provider: Provider }) => this.listModels(provider),
      setKey: ({ provider, key }: { provider: Provider; key: string }) => this.setKey(provider, key),
      clearKey: ({ provider }: { provider: Provider }) => this.clearKey(provider),
    };
  }
}
