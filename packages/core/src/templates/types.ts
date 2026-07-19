import type { Result } from "../errors.js";
import type { FrameTime } from "../time/index.js";

export type TemplateKind =
  | "title"
  | "lower_third"
  | "diagram"
  | "callout"
  | "highlight"
  | "transition"
  | "motion";

export interface TemplateDescriptor {
  schema: "guyditor/template/v1";
  id: string;
  name: string;
  kind: TemplateKind;
  version: string;
  engine: "overlay/v1";
  duration: {
    mode: "fixed" | "param" | "intrinsic" | "anchor_span";
    default?: FrameTime;
  };
  params: Record<string, unknown>;
  contentHash: string;
}

export interface TemplateInstallRequest {
  packagePath?: string;
  builtinName?: string;
}

export interface TemplateProvider {
  latest(templateId: string): Result<TemplateDescriptor> | Promise<Result<TemplateDescriptor>>;
  get(
    templateId: string,
    version: string,
  ): Result<TemplateDescriptor> | Promise<Result<TemplateDescriptor>>;
  install?(
    request: TemplateInstallRequest,
    options: { dryRun: boolean },
  ): Result<TemplateDescriptor> | Promise<Result<TemplateDescriptor>>;
  uninstall?(
    templateId: string,
    version: string,
    options: { dryRun: boolean },
  ): Result<void> | Promise<Result<void>>;
}
