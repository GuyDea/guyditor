import { resolve } from "node:path";

import type {
  OperationEngine,
  ProjectStore,
} from "../../../core/src/index.js";

import { OperationLease } from "./operation-lease.js";
import type { ProjectServices } from "./project-services.js";

interface ProjectContextCoordinatorOptions {
  activeProject: () => ProjectServices | undefined;
  createEngine: (project: ProjectServices) => OperationEngine;
  afterStart?: (store: ProjectStore) => Promise<void>;
}

export class ProjectContextCoordinator {
  readonly #activeProject: ProjectContextCoordinatorOptions["activeProject"];
  readonly #createEngine: ProjectContextCoordinatorOptions["createEngine"];
  readonly #lease: OperationLease<ProjectStore>;
  #lifecycle: Promise<void> = Promise.resolve();

  public constructor(options: ProjectContextCoordinatorOptions) {
    this.#activeProject = options.activeProject;
    this.#createEngine = options.createEngine;
    this.#lease = new OperationLease(options.afterStart);
  }

  public serialize<Value>(task: () => Promise<Value>): Promise<Value> {
    const result = this.#lifecycle.then(task, task);
    this.#lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  public current(): ProjectServices {
    const project = this.#activeProject();
    if (
      project === undefined ||
      this.#lease.isBlocked(project.store) && !this.#lease.isRunning(project.store)
    ) {
      throw {
        code: "E_PROJECT_NOT_OPEN",
        message: "Open a Guyditor project first.",
        affected: [],
        acceptedStateChanged: false,
        retry: "none",
      };
    }
    return project;
  }

  public requirePath(projectPath: string): ProjectServices {
    const project = this.current();
    if (resolve(project.store.root) !== resolve(projectPath)) {
      throw {
        code: "E_PROJECT_CONTEXT_STALE",
        message: `The requested project context ${projectPath} is no longer open.`,
        affected: [projectPath],
        acceptedStateChanged: false,
        retry: "safe",
      };
    }
    return project;
  }

  public require(store: ProjectStore): ProjectServices {
    const project = this.#activeProject();
    if (
      project?.store !== store ||
      this.#lease.isBlocked(store) && !this.#lease.isRunning(store)
    ) {
      throw {
        code: "E_PROJECT_CONTEXT_STALE",
        message: `The project context ${store.root} is no longer open.`,
        affected: [store.root],
        acceptedStateChanged: false,
        retry: "safe",
      };
    }
    return project;
  }

  public engine(
    store: ProjectStore,
  ): Pick<OperationEngine, "createProposal" | "execute"> {
    this.require(store);
    return {
      createProposal: (input) => this.run(
        store,
        (project) => this.#createEngine(project).createProposal(input),
      ),
      execute: (operations, context) => this.run(
        store,
        (project) => this.#createEngine(project).execute(operations, context),
      ),
    };
  }

  public run<Value>(
    store: ProjectStore,
    task: (project: ProjectServices) => Promise<Value>,
  ): Promise<Value> {
    const project = this.require(store);
    return this.#lease.run(store, () => task(project));
  }

  public async deactivate(
    project: ProjectServices,
    close: () => Promise<void>,
  ): Promise<void> {
    const store = project.store;
    try {
      await this.#lease.blockAndDrain(store);
      if (this.#activeProject() === project) await close();
    } finally {
      this.#lease.release(store);
    }
  }

}
