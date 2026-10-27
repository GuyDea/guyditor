import { OperationEngine } from "../../../core/src/index.js";
import type {
  AuditSink,
  ProjectStore,
  Result,
  SidecarRef,
} from "../../../core/src/index.js";

export interface DerivedSidecarDeps {
  readonly appVersion: string;
  readonly auditSink: AuditSink;
}

function resultValue<Value>(result: Result<Value>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

export async function registerDerivedSidecar(
  deps: DerivedSidecarDeps,
  store: ProjectStore,
  sidecar: SidecarRef,
): Promise<void> {
  resultValue(await new OperationEngine(store.currentProject, {
    appVersion: deps.appVersion,
    committer: store,
    auditSink: deps.auditSink,
  }).execute([{
    op: "sidecar.register",
    params: { name: sidecar.name, sidecar },
  }], {
    baseRevision: store.currentProject.revision,
    origin: "system",
    dryRun: false,
    recordUndo: false,
    instruction: { kind: "ui-direct", text: `Register derived sidecar ${sidecar.name}` },
  }));
}
