export type {
  ProgrammaticAnimationProvenance,
  TemplateBrandDefaults,
  TemplateDescriptor,
  TemplateInstallRequest,
  TemplateKind,
  TemplateProvider,
} from "./types.js";
export { resolveBrandTemplateParams } from "./brand.js";
export {
  applyTemplateFreezeOperation,
  programmaticAnimationSidecar,
  serializeProgrammaticAnimationProvenance,
} from "./freeze.js";
