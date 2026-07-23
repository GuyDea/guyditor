export { compileFiltergraph } from "./filtergraph.js";
export {
  TemplateRegistry,
  templateDescriptor,
  validateTemplatePackage,
} from "./template-registry.js";
export type {
  LoadedTemplatePackage,
  TemplateAssetDeclaration,
  TemplateAssetLicense,
  TemplateCatalogEntry,
  TemplateFontDeclaration,
  TemplateManifest,
  TemplateRegistryOptions,
} from "./template-registry.js";
export { createSeededRng } from "./seeded-rng.js";
export {
  TEMPLATE_CANVAS_VERSION,
  TEMPLATE_RENDERER_VERSION,
  loadTemplateRuntime,
  renderTemplatePng,
  resolveTemplateDuration,
} from "./template-runtime.js";
export {
  PRIMITIVES_V1_VERSION,
  primitivesV1,
} from "./primitives/v1.js";
export {
  LOTTIE_RENDERER_VERSION,
  LOTTIE_SHIM_VERSION,
  createLottieAnimation,
  drawLottie,
  lottieToolchainHash,
  renderLottiePng,
} from "./lottie.js";
export type {
  DrawLottieOptions,
  LottieAnimation,
  RenderLottiePngOptions,
} from "./lottie.js";
export type {
  PrimitiveEasing,
  PrimitiveFrameTime,
  PrimitiveWordTiming,
  PrimitivesV1,
  TextRevealOptions,
  TextRevealResult,
} from "./primitives/v1.js";
export type { LoadedTemplateRuntime } from "./template-runtime.js";
export {
  GRAPHIC_OVERLAY_RENDERER_VERSION,
  graphicOverlayToolchain,
  renderGraphicFrame,
  renderGraphicOverlaySequence,
} from "./graphic-overlay.js";
export type {
  GraphicFrameOptions,
  GraphicOverlayOptions,
  GraphicOverlayPlan,
  GraphicSequenceOptions,
} from "./graphic-overlay.js";
export type {
  BrandContext,
  DurationSpec,
  OverlayCanvas2D,
  OverlayImage,
  ResolvedFont,
  ResolvedFontMap,
  SeededRng,
  TemplateModule,
  TemplateRenderContext,
  TemplateRenderOptions,
  TemplateStaticContext,
} from "./template-contract.js";
export { paintCaptionFrame } from "./caption-painter.js";
export type { CaptionPaintContext } from "./caption-painter.js";
export {
  CAPTION_CANVAS_VERSION,
  CAPTION_FONT_FAMILY,
  CAPTION_FONT_PATH,
  CAPTION_FONT_SHA256,
  CAPTION_OVERLAY_RENDERER_VERSION,
  captionOverlayKey,
  captionOverlayToolchain,
  createCaptionTextMeasurer,
  renderCaptionFrameToContext,
  renderCaptionOverlaySequence,
  renderCaptionPng,
} from "./caption-overlay.js";
export type {
  CaptionOverlayPlan,
  CaptionOverlayVersions,
} from "./caption-overlay.js";
export type { CompiledFiltergraph } from "./filtergraph.js";
export { compileRenderGraph, validateRenderGraph } from "./graph.js";
export type { CompileRenderGraphOptions, DiagnosticBackground } from "./graph.js";
export { rasterizeKeyMasks } from "./key-mask.js";
export { rasterizePipAssets } from "./pip-assets.js";
export type { RasterizedPipAssets, RasterizePipAssetsOptions } from "./pip-assets.js";
export type {
  RasterizedKeyMask,
  RasterizeKeyMasksOptions,
} from "./key-mask.js";
export type {
  AudioStage,
  AudioChainNodeParams,
  ColorNodeParams,
  CompositeNodeParams,
  EncodeNodeParams,
  KeyNodeParams,
  OverlayNodeParams,
  PipNodeParams,
  RenderGraph,
  RenderNode,
  RenderNodeKind,
  SourceNodeParams,
  ToolchainManifest,
  TimelineInsertNodeParams,
  TransformNodeParams,
  TrimNodeParams,
} from "./ir.js";
export {
  insertedDurationFrames,
  restyleTimelineInsertionForItem,
  restyleTimelineInsertions,
  sourceFrameToOutputFrame,
} from "./timeline-insertions.js";
export type { RestyleTimelineInsertion } from "./timeline-insertions.js";
export { compileDuckingEnvelope } from "./ducking.js";
export type {
  CompileDuckingEnvelopeInput,
  DuckingEnvelopePoint,
  ResolvedDuckingOverride,
  SpeechInterval,
} from "./ducking.js";
export {
  measureDeliveredLoudness,
  normalizeMasterLoudness,
} from "./loudness.js";
export type {
  LoudnessRunner,
  LoudnessRunResult,
  NormalizeMasterLoudnessInput,
  NormalizeMasterLoudnessResult,
} from "./loudness.js";
export { loadRenderProfile } from "./profile.js";
export { framingPreviewSpec } from "./framing-preview.js";
export type { FramingPreviewSpec, FramingPreviewSpecInput } from "./framing-preview.js";
export { framingPreviewStripSvg, renderFramingPreviewStrip } from "./framing-strip.js";
export type {
  FramingPreviewStripInput,
  FramingPreviewStripPanel,
} from "./framing-strip.js";
export type {
  LoadedRenderProfile,
  RenderProfile,
} from "./profile.js";
export {
  RenderService,
  exportOutputPath,
  exportReportPath,
  outputSetPaths,
  subtitleOutputPaths,
} from "./service.js";
export type {
  DiagnosticRenderRequest,
  DiagnosticRenderResult,
  EquivalenceResult,
  ExportEnqueueResult,
  ExportReport,
  ExportRequest,
  OutputSetPaths,
  OutputSetEnqueueResult,
  OutputSetRequest,
  ExportValidationCheckResult,
  ExportValidationResult,
  FunctionalEquivalenceSpec,
  RenderRequest,
  RenderServiceOptions,
  TemplateFreezeRequest,
  TemplateFreezeResult,
} from "./service.js";
export { validateOverlayLayout, validatePublishMetadataCheck } from "./validation.js";
export { laplacianVariance } from "./cover-analysis.js";
export {
  renderThumbnailComposition,
  thumbnailCompositionPlan,
  writeThumbnailComposition,
} from "./thumbnail.js";
export type {
  ThumbnailComposition,
  ThumbnailProviders,
} from "./thumbnail.js";
