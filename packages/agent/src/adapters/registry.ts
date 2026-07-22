import type {
  AdapterUserConfig,
  BrollProviderAdapter,
  CriticAdapter,
  ProviderAdapter,
  RegisteredAdapter,
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
  readonly #byId = new Map<string, RegisteredAdapter>();
  readonly #byName = new Map<string, ProviderAdapter>();
  readonly #configuration = new Map<string, AdapterUserConfig>();

  public register(adapter: RegisteredAdapter): void {
    const adapterId = "descriptor" in adapter ? adapter.descriptor.adapterId : adapter.id;
    const canonicalName = "descriptor" in adapter
      ? adapter.descriptor.canonicalName
      : undefined;
    if (this.#byId.has(adapterId) || (canonicalName !== undefined && this.#byName.has(canonicalName))) {
      throw new Error(`Adapter ${adapterId}${canonicalName === undefined ? "" : `/${canonicalName}`} is already registered.`);
    }
    this.#byId.set(adapterId, adapter);
    if (canonicalName !== undefined && "descriptor" in adapter) {
      this.#byName.set(canonicalName, adapter);
    }
  }

  public resolve(idOrCanonicalName: string): RegisteredAdapter | undefined {
    return this.#byId.get(idOrCanonicalName) ?? this.#byName.get(idOrCanonicalName);
  }

  public resolveRestyle(idOrCanonicalName: string): RestyleAdapter | undefined {
    const adapter = this.resolve(idOrCanonicalName);
    return adapter !== undefined && "descriptor" in adapter && "restyle" in adapter
      ? adapter
      : undefined;
  }

  public resolveGeneration(idOrCanonicalName: string): BrollProviderAdapter | undefined {
    const adapter = this.resolve(idOrCanonicalName);
    return adapter !== undefined && "descriptor" in adapter && "submit" in adapter
      ? adapter
      : undefined;
  }

  public resolveCritic(adapterId: string): CriticAdapter | undefined {
    const adapter = this.#byId.get(adapterId);
    return adapter !== undefined && "kind" in adapter && adapter.kind === "critic"
      ? adapter
      : undefined;
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
      .filter((adapter): adapter is RestyleAdapter =>
        "descriptor" in adapter && "restyle" in adapter)
      .sort((left, right) =>
        left.descriptor.canonicalName.localeCompare(right.descriptor.canonicalName));
  }

  public generationAdapters(): BrollProviderAdapter[] {
    return [...this.#byId.values()]
      .filter((adapter): adapter is BrollProviderAdapter =>
        "descriptor" in adapter && "submit" in adapter)
      .sort((left, right) =>
        left.descriptor.canonicalName.localeCompare(right.descriptor.canonicalName));
  }

  public generationAvailability(idOrCanonicalName: string): {
    available: boolean;
    reason?: string;
  } {
    const adapter = this.resolveGeneration(idOrCanonicalName);
    if (adapter === undefined) {
      return {
        available: false,
        reason: `Generation adapter ${idOrCanonicalName} is not installed.`,
      };
    }
    if (adapter.descriptor.availability === "declared-unavailable") {
      return {
        available: false,
        reason: adapter.descriptor.unavailableReason ??
          `Generation adapter ${adapter.descriptor.adapterId} is unavailable.`,
      };
    }
    return { available: true };
  }

  public criticAdapters(): CriticAdapter[] {
    return [...this.#byId.values()]
      .filter((adapter): adapter is CriticAdapter => "kind" in adapter && adapter.kind === "critic")
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
