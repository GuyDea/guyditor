import { cliVersion, createLlmAdapter, knownModels } from "../../../agent/src/index.js";
import type { CredentialStore, LlmTransport, SpawnFn } from "../../../agent/src/index.js";
import { saveAiSettings } from "./settings.js";
import type { AiSettings, UserSettings } from "./settings.js";

type Provider = AiSettings["provider"];
type ExternalCalls = UserSettings["network"]["externalCalls"];

export interface AiSettingsView extends AiSettings {
  keys: { anthropic: boolean; openai: boolean };
  externalCalls: ExternalCalls;
  encryptionAvailable: boolean;
}

export type CliCheck = { ok: true; version: string } | { ok: false; message: string };

export interface AiSettingsServiceOptions {
  userDirectory: string;
  credentials: CredentialStore;
  initial: AiSettings;
  externalCalls: ExternalCalls;
  encryptionAvailable: boolean;
  adapterFactory?: typeof createLlmAdapter;
  spawn?: SpawnFn;
}

const PROVIDERS: readonly string[] = ["anthropic", "openai"];
const EFFORTS: readonly string[] = ["low", "medium", "high", "max"];
const TIGHTENINGS: readonly string[] = ["ask", "gentle", "off"];
const TRANSPORTS: readonly string[] = ["api", "cli"];
const CREDENTIAL_ID = "llm";

function invalid(what: string): Error {
  return new Error(`E_AI_SETTINGS_INVALID: ${what}`);
}

function checkProvider(value: unknown): Provider {
  if (typeof value !== "string" || !PROVIDERS.includes(value)) throw invalid(`unknown provider ${String(value)}`);
  return value as Provider;
}

function validatedPatch(patch: Partial<AiSettings>, current: AiSettings): Partial<AiSettings> {
  const out: Partial<AiSettings> = {};
  if (patch.transport !== undefined) {
    const transport = { ...current.transport };
    for (const provider of PROVIDERS as Provider[]) {
      const value = patch.transport[provider];
      if (value === undefined) continue;
      if (!TRANSPORTS.includes(value)) throw invalid(`unknown transport ${String(value)}`);
      transport[provider] = value;
    }
    out.transport = transport;
  }
  if (patch.cli !== undefined) {
    const cli = { ...current.cli };
    for (const key of ["claudePath", "codexPath"] as const) {
      const value = patch.cli[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim() === "") throw invalid(`${key} must be a non-empty string`);
      cli[key] = value;
    }
    out.cli = cli;
  }
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
  #queue: Promise<unknown> = Promise.resolve();

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

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  public update(patch: Partial<AiSettings>): Promise<AiSettingsView> {
    return this.#serialized(async () => {
      const next = { ...this.#settings, ...validatedPatch(patch, this.#settings) };
      await saveAiSettings(this.#options.userDirectory, next);
      this.#settings = next;
      return this.get();
    });
  }

  public transport(provider: Provider): LlmTransport {
    return this.#settings.transport[provider];
  }

  public cliBinary(provider: Provider): string {
    return provider === "anthropic" ? this.#settings.cli.claudePath : this.#settings.cli.codexPath;
  }

  public checkCli(provider: Provider): Promise<CliCheck> {
    checkProvider(provider);
    return cliVersion(this.cliBinary(provider), provider === "anthropic" ? "claude" : "codex", this.#options.spawn);
  }

  public async listModels(provider: Provider): Promise<string[]> {
    checkProvider(provider);
    if (this.transport(provider) === "cli") return knownModels(provider);
    const apiKey = await this.apiKey(provider);
    if (apiKey === undefined || apiKey === "") throw new Error(`E_AI_KEY_MISSING: no API key for ${provider}`);
    return (this.#options.adapterFactory ?? createLlmAdapter)(provider, { apiKey }).listModels();
  }

  public setKey(provider: Provider, key: string): Promise<AiSettingsView> {
    checkProvider(provider);
    if (typeof key !== "string" || key === "") throw invalid("key must be a non-empty string");
    return this.#serialized(async () => {
      await this.#options.credentials.set(CREDENTIAL_ID, provider, key);
      return this.get();
    });
  }

  public clearKey(provider: Provider): Promise<AiSettingsView> {
    checkProvider(provider);
    return this.#serialized(async () => {
      await this.#options.credentials.delete(CREDENTIAL_ID, provider);
      return this.get();
    });
  }

  public surface(): Record<string, (params: never) => unknown> {
    return {
      get: () => this.get(),
      update: (params: Partial<AiSettings>) => this.update(params),
      listModels: ({ provider }: { provider: Provider }) => this.listModels(provider),
      setKey: ({ provider, key }: { provider: Provider; key: string }) => this.setKey(provider, key),
      clearKey: ({ provider }: { provider: Provider }) => this.clearKey(provider),
      checkCli: ({ provider }: { provider: Provider }) => this.checkCli(provider),
    };
  }
}
