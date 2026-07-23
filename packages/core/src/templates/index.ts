export type {
  ProgrammaticAnimationProvenance,
  TemplateAssetDeclaration,
  TemplateAssetKind,
  TemplateAssetLicense,
  TemplateBrandDefaults,
  TemplateDescriptor,
  TemplateInstallRequest,
  TemplateKind,
  TemplateProvider,
} from "./types.js";
export {
  LOTTIE_FEATURE_PROFILE_SCHEMA,
  LOTTIE_RENDERER_VERSION,
  analyzeLottieDocument,
} from "./lottie.js";
export type {
  AnalyzeLottieOptions,
  LottieAnalysis,
  LottieFeatureProfile,
  LottieSupportedFeature,
  LottieUnsupportedFeature,
} from "./lottie.js";
export { resolveBrandTemplateParams } from "./brand.js";
export {
  applyTemplateFreezeOperation,
  programmaticAnimationSidecar,
  serializeProgrammaticAnimationProvenance,
} from "./freeze.js";
