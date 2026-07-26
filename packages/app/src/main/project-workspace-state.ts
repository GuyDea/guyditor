import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  isId,
  makeGuyditorError,
} from "../../../core/src/index.js";
import type { GuyditorProject } from "../../../core/src/index.js";
import { parse as parseYaml } from "yaml";

export const PROJECT_WORKSPACE_FILE = "workspace.guyditor.yaml";
const WORKSPACE_FORMAT = "guyditor.workspace/v1" as const;

export interface ProjectWorkspaceState {
  format: typeof WORKSPACE_FORMAT;
  activeDeliverableId: string;
}

export interface LoadedProjectWorkspaceState {
  state: ProjectWorkspaceState;
  warning?: string;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT";
}

function primaryState(project: GuyditorProject): ProjectWorkspaceState {
  const id = project.settings.primaryDeliverable;
  if (
    !isId("dlv", id) ||
    !project.deliverables.some((deliverable) => deliverable.id === id)
  ) {
    throw makeGuyditorError(
      "E_PROJECT_INVARIANT",
      `Primary deliverable ${id} does not exist.`,
      { affected: [id] },
    );
  }
  return {
    format: WORKSPACE_FORMAT,
    activeDeliverableId: id,
  };
}

function parseState(source: string): ProjectWorkspaceState {
  const value = parseYaml(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Workspace state must be a mapping.");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "activeDeliverableId" ||
    keys[1] !== "format"
  ) {
    throw new TypeError(
      "Workspace state must contain only format and activeDeliverableId.",
    );
  }
  if (record["format"] !== WORKSPACE_FORMAT) {
    throw new TypeError(
      `Unsupported workspace format ${String(record["format"])}.`,
    );
  }

  const activeDeliverableId = record["activeDeliverableId"];
  if (!isId("dlv", activeDeliverableId)) {
    throw new TypeError("Workspace activeDeliverableId is malformed.");
  }

  return {
    format: WORKSPACE_FORMAT,
    activeDeliverableId,
  };
}

function serialize(state: ProjectWorkspaceState): string {
  return [
    `format: ${state.format}`,
    `activeDeliverableId: ${state.activeDeliverableId}`,
    "",
  ].join("\n");
}

async function atomicWrite(path: string, source: string): Promise<void> {
  const temporary =
    `${path}.tmp-${String(process.pid)}-${randomBytes(8).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ProjectWorkspaceStateStore {
  readonly #path: string;
  #pendingWarning: string | undefined;
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(projectRoot: string) {
    this.#path = join(projectRoot, PROJECT_WORKSPACE_FILE);
  }

  #surface(
    loaded: LoadedProjectWorkspaceState,
  ): LoadedProjectWorkspaceState {
    const pendingWarning = this.#pendingWarning;
    this.#pendingWarning = undefined;
    if (pendingWarning === undefined) return loaded;

    return {
      ...loaded,
      warning: loaded.warning === undefined
        ? pendingWarning
        : `${pendingWarning} ${loaded.warning}`,
    };
  }

  public async load(
    project: GuyditorProject,
  ): Promise<LoadedProjectWorkspaceState> {
    await this.#writeTail;
    const fallback = primaryState(project);

    let source: string;
    try {
      source = await readFile(this.#path, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) {
        return this.#surface({ state: fallback });
      }
      return this.#surface({
        state: fallback,
        warning:
          `Could not read workspace selection (${errorDetail(error)}); ` +
          `using primary deliverable ${fallback.activeDeliverableId}.`,
      });
    }

    try {
      const state = parseState(source);
      if (
        !project.deliverables.some(
          (deliverable) => deliverable.id === state.activeDeliverableId,
        )
      ) {
        throw new TypeError(
          `Deliverable ${state.activeDeliverableId} no longer exists.`,
        );
      }
      return this.#surface({ state });
    } catch (error: unknown) {
      return this.#surface({
        state: fallback,
        warning:
          `Workspace selection is invalid (${errorDetail(error)}); ` +
          `using primary deliverable ${fallback.activeDeliverableId}.`,
      });
    }
  }

  public async initialize(
    project: GuyditorProject,
  ): Promise<ProjectWorkspaceState> {
    const fallback = primaryState(project);
    try {
      return await this.setActiveDeliverable(
        project,
        fallback.activeDeliverableId,
      );
    } catch (error: unknown) {
      this.#pendingWarning =
        `Could not initialize workspace selection; using primary deliverable ` +
        `${fallback.activeDeliverableId}: ${errorDetail(error)}`;
      return fallback;
    }
  }

  public async setActiveDeliverable(
    project: GuyditorProject,
    activeDeliverableId: string,
  ): Promise<ProjectWorkspaceState> {
    if (
      !isId("dlv", activeDeliverableId) ||
      !project.deliverables.some(
        (deliverable) => deliverable.id === activeDeliverableId,
      )
    ) {
      throw makeGuyditorError(
        "E_WORKSPACE_DELIVERABLE_NOT_FOUND",
        `Deliverable ${activeDeliverableId} does not exist in the open project.`,
        { affected: [activeDeliverableId] },
      );
    }

    const state: ProjectWorkspaceState = {
      format: WORKSPACE_FORMAT,
      activeDeliverableId,
    };
    const publication = this.#writeTail.then(() =>
      atomicWrite(this.#path, serialize(state)),
    );
    this.#writeTail = publication.catch(() => undefined);

    await publication;
    return state;
  }
}
