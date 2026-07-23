import type {
  ProjectStore,
  RightsPolicy,
} from "../../../core/src/index.js";
import { validateDeliverableRights } from "../../../deliver/src/index.js";
import type {
  ExportValidationResult,
  RenderService,
} from "../../../render/src/index.js";

export async function validateExportWithRights(input: {
  render: RenderService;
  store: ProjectStore;
  deliverableId: string;
  revision: string;
  rightsPolicy: RightsPolicy;
}): Promise<ExportValidationResult> {
  const [renderValidation, rightsValidation] = await Promise.all([
    input.render.validateExport(input.deliverableId, input.revision),
    Promise.resolve(validateDeliverableRights(
      input.store.currentProject,
      input.deliverableId,
      input.rightsPolicy,
    )),
  ]);
  const checks = [
    ...renderValidation.checks,
    ...rightsValidation.checks.map((check) => ({
      id: check.code,
      status: check.status,
      message: check.message,
      affected: [check.assetId],
    })),
  ];
  return {
    ...renderValidation,
    checks,
    outcome: checks.some(({ status }) => status === "fail")
      ? "blocked"
      : checks.some(({ status }) => status === "warn") ? "warnings" : "pass",
  };
}
