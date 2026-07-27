import { resolve } from "node:path";

import type {
  OperationBatchResult,
  OperationCommitter,
  OperationEngine,
  OperationInput,
  Result,
} from "../../../core/src/index.js";

import type { ExecuteRequest } from "../shared/ipc.js";
import type {
  MatteProjectGuard,
  PreparedMatteCommit,
} from "./matte-service.js";
import type { ProjectServices } from "./project-services.js";

export interface PrepareMatteCommitOptions {
  request: ExecuteRequest;
  guard: MatteProjectGuard;
  project: ProjectServices;
  activeProject: () => ProjectServices | undefined;
  createEngine: (committer: OperationCommitter) => OperationEngine;
  onAccepted: (revision: string) => void;
}

function resultValue<Value>(result: Result<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function inverseOperations(result: OperationBatchResult): OperationInput[] {
  return result.applied.slice().reverse().flatMap(({ inverse }) => inverse);
}

function assertProjectGuard(options: PrepareMatteCommitOptions): void {
  const active = options.activeProject();
  const { guard, project } = options;
  if (
    active !== project ||
    active === undefined ||
    resolve(active.store.root) !== resolve(guard.projectPath) ||
    active.store.currentProject.project.id !== guard.projectId ||
    active.store.currentProject.revision !== guard.revision
  ) {
    throw {
      code: "E_PROJECT_CONTEXT_STALE",
      message:
        `The matte was prepared for ${guard.projectId} at ${guard.revision}, but that project context changed.`,
      affected: [guard.projectPath, guard.projectId, guard.revision],
      acceptedStateChanged: false,
      retry: "safe",
    };
  }
}

export async function prepareMatteCommit(
  options: PrepareMatteCommitOptions,
): Promise<PreparedMatteCommit> {
  const { guard, project, request } = options;
  assertProjectGuard(options);
  const engine = options.createEngine({
    commit: async (model, transaction) => {
      assertProjectGuard(options);
      return project.store.commit(model, transaction);
    },
  });
  const context = {
    baseRevision: guard.revision,
    origin: "ui" as const,
    recordUndo: false,
    instruction: { kind: "ui-direct" as const, text: request.label },
    ...(request.divergence === undefined ? {} : { divergence: request.divergence }),
  };
  resultValue(await engine.execute(request.operations, { ...context, dryRun: true }));
  return async () => {
    assertProjectGuard(options);
    const result = resultValue(await engine.execute(request.operations, {
      ...context,
      dryRun: false,
    }));
    const txnId = result.transactionId;
    if (txnId === undefined) {
      throw new Error("Accepted matte operation did not produce a transaction ID.");
    }
    const revision = project.store.currentProject.revision;
    try {
      options.onAccepted(revision);
    } catch {
      // The semantic commit is already durable; notification failures must not
      // make callers clean up files now referenced by accepted project state.
    }
    return { txnId, revision, inverse: inverseOperations(result) };
  };
}
