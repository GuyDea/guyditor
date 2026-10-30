import { readSettingsKey, replaceSettingsKey } from "./settings.js";

export interface WorkspaceLayoutServiceOptions {
  userDirectory: string;
}

/**
 * Stores the renderer's per-phase layout document under the `workspace` key of the
 * global settings.json. The document is opaque here; the renderer normalizes it on load.
 */
export class WorkspaceLayoutService {
  readonly #options: WorkspaceLayoutServiceOptions;

  public constructor(options: WorkspaceLayoutServiceOptions) {
    this.#options = options;
  }

  public async get(): Promise<unknown> {
    return (await readSettingsKey(this.#options.userDirectory, "workspace")) ?? null;
  }

  public save(document: unknown): Promise<void> {
    return replaceSettingsKey(this.#options.userDirectory, "workspace", document);
  }

  public surface(): {
    get: () => Promise<unknown>;
    save: (params: { document: unknown }) => Promise<void>;
  } {
    return {
      get: () => this.get(),
      save: ({ document }) => this.save(document),
    };
  }
}
