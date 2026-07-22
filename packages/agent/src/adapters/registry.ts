import type {
  AdapterUserConfig,
  ProviderAdapter,
  RestyleAdapter,
} from "./types.js";

function assertNonSecret(value: unknown, path = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNonSecret(child, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:secret|password|token|api.?key)/iu.test(key) &&
      !/(?:ref|reference)$/iu.test(key)
    ) {
      throw new TypeError(`Adapter ${path}.${key} contains a secret-bearing setting.`);
    }
    assertNonSecret(child, `${path}.${key}`);
  }
}

export class AdapterRegistry {
  readonly #byId = new Map<string, ProviderAdapter>();
  readonly #byName = new Map<string, ProviderAdapter>();
  readonly #configuration = new Map<string, AdapterUserConfig>();

  public register(adapter: ProviderAdapter): void {
    const { adapterId, canonicalName } = adapter.descriptor;
    if (this.#byId.has(adapterId) || this.#byName.has(canonicalName)) {
      throw new Error(`Adapter ${adapterId}/${canonicalName} is already registered.`);
    }
    this.#byId.set(adapterId, adapter);
    this.#byName.set(canonicalName, adapter);
  }

  public resolve(idOrCanonicalName: string): ProviderAdapter | undefined {
    return this.#byId.get(idOrCanonicalName) ?? this.#byName.get(idOrCanonicalName);
  }

  public resolveRestyle(idOrCanonicalName: string): RestyleAdapter | undefined {
    const adapter = this.resolve(idOrCanonicalName);
    return adapter !== undefined && "restyle" in adapter ? adapter : undefined;
  }

  public configure(adapterId: string, config: AdapterUserConfig): void {
    if (!this.#byId.has(adapterId)) throw new Error(`Adapter ${adapterId} is not registered.`);
    assertNonSecret(config);
    this.#configuration.set(adapterId, structuredClone(config));
  }

  public configuration(adapterId: string): AdapterUserConfig | undefined {
    const config = this.#configuration.get(adapterId);
    return config === undefined ? undefined : structuredClone(config);
  }

  public restyleAdapters(): RestyleAdapter[] {
    return [...this.#byId.values()]
      .filter((adapter): adapter is RestyleAdapter => "restyle" in adapter)
      .sort((left, right) =>
        left.descriptor.canonicalName.localeCompare(right.descriptor.canonicalName));
  }
}
