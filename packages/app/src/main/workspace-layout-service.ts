import { readSettingsKey, replaceSettingsKey } from "./settings.js";

export interface WorkspaceLayoutUpdate {
  clientId: string;
  activePhase: string;
  layouts: Record<string, unknown>;
}

export interface WorkspaceLayoutServiceOptions {
  userDirectory: string;
  /** Called after each merged write with the stored document and the client that sent it. */
  onChange?: (document: unknown, clientId: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stores the renderer's per-phase layout document under the `workspace` key of the
 * global settings.json. Updates carry only changed phases and are merged one at a time,
 * so windows never revert each other's untouched phases. Phase layouts are opaque here;
 * the renderer normalizes them on load.
 */
export class WorkspaceLayoutService {
  readonly #options: WorkspaceLayoutServiceOptions;
  #updates: Promise<void> = Promise.resolve();

  public constructor(options: WorkspaceLayoutServiceOptions) {
    this.#options = options;
  }

  public async get(): Promise<unknown> {
    return (await readSettingsKey(this.#options.userDirectory, "workspace")) ?? null;
  }

  public update(change: WorkspaceLayoutUpdate): Promise<void> {
    const next = this.#updates.then(() => this.#merge(change));
    this.#updates = next.catch(() => undefined);
    return next;
  }

  async #merge({ clientId, activePhase, layouts }: WorkspaceLayoutUpdate): Promise<void> {
    const stored = await this.get();
    const storedLayouts = isRecord(stored) && isRecord(stored["layouts"]) ? stored["layouts"] : {};
    const document = { activePhase, layouts: { ...storedLayouts, ...layouts } };
    await replaceSettingsKey(this.#options.userDirectory, "workspace", document);
    this.#options.onChange?.(document, clientId);
  }

  public surface(): {
    get: () => Promise<unknown>;
    update: (params: WorkspaceLayoutUpdate) => Promise<void>;
  } {
    return {
      get: () => this.get(),
      update: (params) => this.update(params),
    };
  }
}
