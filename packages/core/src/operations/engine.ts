import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { randomBytes } from "node:crypto";

import trimSchema from "./schemas/clip.trim.json" with { type: "json" };
import splitSchema from "./schemas/clip.split.json" with { type: "json" };
import joinSchema from "./schemas/clip.join.json" with { type: "json" };
import removeClipSchema from "./schemas/clip.remove.json" with { type: "json" };
import restoreClipSchema from "./schemas/clip.restore.json" with { type: "json" };
import insertClipSchema from "./schemas/clip.insert.json" with { type: "json" };
import moveClipSchema from "./schemas/clip.move.json" with { type: "json" };
import duplicateClipSchema from "./schemas/clip.duplicate.json" with { type: "json" };
import setClipGapSchema from "./schemas/clip.gap.set.json" with { type: "json" };
import setClipOverlapSchema from "./schemas/clip.overlap.set.json" with { type: "json" };
import setClipAudioGainSchema from "./schemas/clip.audio.gain.set.json" with { type: "json" };
import setClipAudioFadeSchema from "./schemas/clip.audio.fade.set.json" with { type: "json" };
import setClipAudioOffsetSchema from "./schemas/clip.audio.offset.set.json" with { type: "json" };
import setClipAudioChannelsSchema from "./schemas/clip.audio.channels.set.json" with { type: "json" };
import setClipAudioChainSchema from "./schemas/clip.audio.chain.set.json" with { type: "json" };
import setSequenceAudioMasterSchema from "./schemas/sequence.audio.master.set.json" with { type: "json" };
import setClipLoopSchema from "./schemas/clip.loop.set.json" with { type: "json" };
import setClipAnchorSchema from "./schemas/clip.anchor.set.json" with { type: "json" };
import setLayerDuckingSchema from "./schemas/layer.ducking.set.json" with { type: "json" };
import setLayerDuckingOverrideSchema from "./schemas/layer.ducking.override.json" with { type: "json" };
import setClipColorSchema from "./schemas/clip.color.set.json" with { type: "json" };
import applyClipLookSchema from "./schemas/clip.look.apply.json" with { type: "json" };
import addLayerSchema from "./schemas/layer.add.json" with { type: "json" };
import removeLayerSchema from "./schemas/layer.remove.json" with { type: "json" };
import reorderLayerSchema from "./schemas/layer.reorder.json" with { type: "json" };
import enableLayerSchema from "./schemas/layer.enable.json" with { type: "json" };
import disableLayerSchema from "./schemas/layer.disable.json" with { type: "json" };
import lockLayerSchema from "./schemas/layer.lock.json" with { type: "json" };
import unlockLayerSchema from "./schemas/layer.unlock.json" with { type: "json" };
import setLayerSchema from "./schemas/layer.set.json" with { type: "json" };
import setLayerTransformSchema from "./schemas/layer.transform.set.json" with { type: "json" };
import setLayerMatteSchema from "./schemas/layer.matte.set.json" with { type: "json" };
import setPipStyleSchema from "./schemas/pip.style.set.json" with { type: "json" };
import placePipSchema from "./schemas/pip.place.json" with { type: "json" };
import addPipKeyframeSchema from "./schemas/pip.keyframe.add.json" with { type: "json" };
import removePipKeyframeSchema from "./schemas/pip.keyframe.remove.json" with { type: "json" };
import applyPipPresetSchema from "./schemas/pip.preset.apply.json" with { type: "json" };
import solvePipAvoidSchema from "./schemas/pip.avoid.solve.json" with { type: "json" };
import markRegionSchema from "./schemas/region.mark.json" with { type: "json" };
import setClipKeySchema from "./schemas/clip.key.set.json" with { type: "json" };
import setClipKeyMaskSchema from "./schemas/clip.key.mask.set.json" with { type: "json" };
import setClipTransformSchema from "./schemas/clip.transform.set.json" with { type: "json" };
import setClipPunchInSchema from "./schemas/clip.punchin.set.json" with { type: "json" };
import switchClipSourceSchema from "./schemas/clip.source.switch.json" with { type: "json" };
import arrangeCompositionSchema from "./schemas/composition.arrange.json" with { type: "json" };
import runKeyQcSchema from "./schemas/key.qc.run.json" with { type: "json" };
import setTransitionSchema from "./schemas/transition.set.json" with { type: "json" };
import removeTransitionSchema from "./schemas/transition.remove.json" with { type: "json" };
import assetIngestSchema from "./schemas/asset.ingest.json" with { type: "json" };
import assetRemoveSchema from "./schemas/asset.remove.json" with { type: "json" };
import assetMarkersAttachSchema from "./schemas/asset.markers.attach.json" with { type: "json" };
import assetTakesSetSchema from "./schemas/asset.takes.set.json" with { type: "json" };
import transcriptCreateSchema from "./schemas/transcript.create.json" with { type: "json" };
import transcriptWordCorrectSchema from "./schemas/transcript.word.correct.json" with { type: "json" };
import transcriptWordReplaceSchema from "./schemas/transcript.word.replace.json" with { type: "json" };
import transcriptWordInsertSchema from "./schemas/transcript.word.insert.json" with { type: "json" };
import transcriptWordDeleteSchema from "./schemas/transcript.word.delete.json" with { type: "json" };
import transcriptWordRetimeSchema from "./schemas/transcript.word.retime.json" with { type: "json" };
import transcriptSegmentSplitSchema from "./schemas/transcript.segment.split.json" with { type: "json" };
import transcriptSegmentMergeSchema from "./schemas/transcript.segment.merge.json" with { type: "json" };
import transcriptSpeakerAssignSchema from "./schemas/transcript.speaker.assign.json" with { type: "json" };
import transcriptRealignSchema from "./schemas/transcript.realign.json" with { type: "json" };
import transcriptRangeRemoveSchema from "./schemas/transcript.range.remove.json" with { type: "json" };
import transcriptRangeRetainSchema from "./schemas/transcript.range.retain.json" with { type: "json" };
import transcriptRangeCreateClipSchema from "./schemas/transcript.range.createClip.json" with { type: "json" };
import transcriptRangeShortCandidateSchema from "./schemas/transcript.range.shortCandidate.json" with { type: "json" };
import pickupSpliceSchema from "./schemas/pickup.splice.json" with { type: "json" };
import projectWatchFoldersSetSchema from "./schemas/project.watchFolders.set.json" with { type: "json" };
import captionTrackAddSchema from "./schemas/caption.track.add.json" with { type: "json" };
import captionTrackRemoveSchema from "./schemas/caption.track.remove.json" with { type: "json" };
import captionTrackSetSchema from "./schemas/caption.track.set.json" with { type: "json" };
import captionStyleSetSchema from "./schemas/caption.style.set.json" with { type: "json" };
import captionBreakSetSchema from "./schemas/caption.break.set.json" with { type: "json" };
import captionBreakClearSchema from "./schemas/caption.break.clear.json" with { type: "json" };
import captionWordEmphasisSetSchema from "./schemas/caption.word.emphasis.set.json" with { type: "json" };
import captionCueRetimeSchema from "./schemas/caption.cue.retime.json" with { type: "json" };
import captionPresetUpgradeSchema from "./schemas/caption.preset.upgrade.json" with { type: "json" };
import anchorRebindSchema from "./schemas/anchor.rebind.json" with { type: "json" };
import annotationCreateSchema from "./schemas/annotation.create.json" with { type: "json" };
import annotationUpdateSchema from "./schemas/annotation.update.json" with { type: "json" };
import annotationDeleteSchema from "./schemas/annotation.delete.json" with { type: "json" };
import annotationResolveSchema from "./schemas/annotation.resolve.json" with { type: "json" };
import annotationRejectSchema from "./schemas/annotation.reject.json" with { type: "json" };
import annotationReopenSchema from "./schemas/annotation.reopen.json" with { type: "json" };
import annotationConvertSchema from "./schemas/annotation.convert.json" with { type: "json" };
import graphicAddSchema from "./schemas/graphic.add.json" with { type: "json" };
import graphicParamSetSchema from "./schemas/graphic.param.set.json" with { type: "json" };
import graphicAnchorSetSchema from "./schemas/graphic.anchor.set.json" with { type: "json" };
import graphicRetimeSchema from "./schemas/graphic.retime.json" with { type: "json" };
import graphicRemoveSchema from "./schemas/graphic.remove.json" with { type: "json" };
import templatePinSchema from "./schemas/template.pin.json" with { type: "json" };
import templateInstallSchema from "./schemas/template.install.json" with { type: "json" };
import templateUninstallSchema from "./schemas/template.uninstall.json" with { type: "json" };
import restylePlanCreateSchema from "./schemas/restyle.plan.create.json" with { type: "json" };
import restyleSegmentApproveSchema from "./schemas/restyle.segment.approve.json" with { type: "json" };
import seamTreatmentSetSchema from "./schemas/seam.treatment.set.json" with { type: "json" };
import {
  AnchorResolverRegistry,
  computeAnchorTransitions,
  resolveNavigationTarget,
  validateProjectAnchors,
} from "../anchors/index.js";
import type {
  AnchorValidationReport,
  AnchorResolverDependencies,
  NavigationTarget,
  TimelinePosition,
} from "../anchors/index.js";
import {
  failure,
  makeGuyditorError,
  success,
} from "../errors.js";
import type { Result } from "../errors.js";
import {
  formatRevision,
  makeId,
  parseRevision,
  validateProject,
} from "../project/index.js";
import type {
  GuyditorProject,
  IdPrefix,
} from "../project/index.js";
import type { TransactionRecord } from "../store/types.js";
import type { TemplateProvider } from "../templates/index.js";
import { applyClipOperation } from "./clip.js";
import type { ClipApplication } from "./clip.js";
import {
  applyAudioColorOperation,
  isAudioColorOperation,
} from "./audio-color.js";
import { applyLayerOperation } from "./layer.js";
import { applyTransitionOperation } from "./transition.js";
import { applyAssetOperation } from "./asset.js";
import { applyProjectOperation } from "./project.js";
import { applyAnchorOperation } from "./anchor.js";
import { assessBatchRisk, buildSemanticDiff } from "./diff.js";
import { applyGraphicOperation, applyTemplateOperation } from "./graphic.js";
import { applyRestyleOperation } from "../restyle/operations.js";
import type {
  AppliedOperation,
  AuditSink,
  AuditSinkEvent,
  AutomationPolicy,
  CreateProposalRequest,
  ContinuityGuard,
  ContinuityWarning,
  OperationBatchResult,
  OperationContext,
  OperationInput,
  Proposal,
  ProposalStore,
  RiskClass,
} from "./types.js";

export type IdFactory = (prefix: IdPrefix) => string;

export interface OperationCommitter {
  commit(
    model: GuyditorProject,
    transaction: TransactionRecord,
  ): Promise<Result<GuyditorProject>>;
  readTransaction?(id: string): Promise<Result<TransactionRecord>>;
  readAcceptedRevision?(): Promise<Result<string>>;
  restore?(targetRevision: string): Promise<Result<GuyditorProject>>;
}

export interface DispatchedOperationApplication {
  model: GuyditorProject;
  inverse: OperationInput[];
  redo?: OperationInput;
  affected: string[];
  summary: string;
}

export type OperationDispatcher = (
  project: GuyditorProject,
  input: OperationInput,
  context: OperationContext,
) => Result<DispatchedOperationApplication> |
  Promise<Result<DispatchedOperationApplication>>;

export interface OperationEngineOptions {
  idFactory?: IdFactory;
  committer?: OperationCommitter;
  appVersion?: string;
  now?: () => Date;
  operationDispatcher?: OperationDispatcher;
  anchorResolvers?: AnchorResolverRegistry | AnchorResolverDependencies;
  proposalStore?: ProposalStore;
  automationPolicy?: AutomationPolicy;
  approvedTransitionPresets?: readonly string[];
  continuityGuard?: ContinuityGuard;
  auditSink?: AuditSink;
  templateProvider?: TemplateProvider;
  seedFactory?: () => number;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
interface CatalogEntry {
  captionImpact: AppliedOperation["captionImpact"];
  riskClass: RiskClass;
  summaryTemplate: string;
  validate: ValidateFunction<Record<string, unknown>>;
}

function catalogEntry(
  schema: object,
  riskClass: RiskClass,
  captionImpact: AppliedOperation["captionImpact"],
  summaryTemplate: string,
): CatalogEntry {
  return {
    validate: ajv.compile<Record<string, unknown>>(schema),
    riskClass,
    captionImpact,
    summaryTemplate,
  };
}

const catalog = new Map<string, CatalogEntry>([
  ["asset.ingest", catalogEntry(assetIngestSchema, "normal", "none", "Ingest {n} assets")],
  ["asset.remove", catalogEntry(assetRemoveSchema, "normal", "none", "Remove {n} assets")],
  ["asset.markers.attach", catalogEntry(assetMarkersAttachSchema, "low", "none", "Attach {n} markers to {asset}")],
  ["asset.takes.set", catalogEntry(assetTakesSetSchema, "low", "none", "Set take metadata for {asset}")],
  ["project.watchFolders.set", catalogEntry(projectWatchFoldersSetSchema, "low", "none", "Configure {n} capture watch folders")],
  ["clip.trim", catalogEntry(trimSchema, "normal", "none", "Trim {clip}")],
  ["clip.split", catalogEntry(splitSchema, "normal", "none", "Split {clip}")],
  ["clip.join", catalogEntry(joinSchema, "normal", "none", "Join {clips}")],
  ["clip.remove", catalogEntry(removeClipSchema, "normal", "shift", "Remove {clip}")],
  ["clip.restore", catalogEntry(restoreClipSchema, "normal", "shift", "Restore {n} clips")],
  ["clip.insert", catalogEntry(insertClipSchema, "normal", "shift", "Insert {asset} range at position {index}")],
  ["clip.move", catalogEntry(moveClipSchema, "normal", "shift", "Move {clip} to {dest}")],
  ["clip.duplicate", catalogEntry(duplicateClipSchema, "normal", "shift", "Duplicate {clip}")],
  ["clip.gap.set", catalogEntry(setClipGapSchema, "normal", "shift", "Set gap before {clip} to {gap}")],
  ["clip.overlap.set", catalogEntry(setClipOverlapSchema, "normal", "shift", "Overlap {clip} with previous by {t}")],
  ["layer.add", catalogEntry(addLayerSchema, "normal", "none", "Add {kind} layer '{name}'")],
  ["layer.remove", catalogEntry(removeLayerSchema, "low", "none", "Remove layer '{name}' ({n} clips)")],
  ["layer.reorder", catalogEntry(reorderLayerSchema, "low", "none", "Move layer '{name}' to position {i}")],
  ["layer.enable", catalogEntry(enableLayerSchema, "low", "none", "Enable layer '{name}'")],
  ["layer.disable", catalogEntry(disableLayerSchema, "low", "none", "Disable layer '{name}'")],
  ["layer.lock", catalogEntry(lockLayerSchema, "low", "none", "Lock layer '{name}'")],
  ["layer.unlock", catalogEntry(unlockLayerSchema, "low", "none", "Unlock layer '{name}'")],
  ["layer.set", catalogEntry(setLayerSchema, "low", "none", "Set layer '{name}'")],
  ["layer.transform.set", catalogEntry(setLayerTransformSchema, "normal", "none", "Transform layer '{name}'")],
  ["layer.matte.set", catalogEntry(setLayerMatteSchema, "normal", "none", "Set matte on layer '{name}'")],
  ["pip.style.set", catalogEntry(setPipStyleSchema, "normal", "none", "Style PiP on {layerId}")],
  ["pip.place", catalogEntry(placePipSchema, "normal", "none", "Place {layerId} {placement.anchor}")],
  ["pip.keyframe.add", catalogEntry(addPipKeyframeSchema, "normal", "none", "Add PiP keyframe at {keyframe.at}")],
  ["pip.keyframe.remove", catalogEntry(removePipKeyframeSchema, "normal", "none", "Remove PiP keyframe {keyframeId}")],
  ["pip.preset.apply", catalogEntry(applyPipPresetSchema, "normal", "none", "Apply PiP preset {presetId}@{version} at {at}")],
  ["pip.avoid.solve", catalogEntry(solvePipAvoidSchema, "low", "none", "Plan collision avoidance for {layerId}")],
  ["region.mark", catalogEntry(markRegionSchema, "low", "none", "Mark avoid region")],
  ["clip.key.set", catalogEntry(setClipKeySchema, "normal", "none", "Set key on {clip}")],
  ["clip.key.mask.set", catalogEntry(setClipKeyMaskSchema, "normal", "none", "Set key mask on {clip}")],
  ["clip.transform.set", catalogEntry(setClipTransformSchema, "normal", "none", "Transform {clip}")],
  ["clip.punchin.set", catalogEntry(setClipPunchInSchema, "normal", "none", "Punch in {clip} to {level}x")],
  ["clip.source.switch", catalogEntry(switchClipSourceSchema, "normal", "none", "Switch {clip} to synchronized source {assetId}")],
  ["composition.arrange", catalogEntry(arrangeCompositionSchema, "normal", "none", "Arrange {sequence}")],
  ["key.qc.run", catalogEntry(runKeyQcSchema, "low", "none", "Analyze key quality for {clip}")],
  ["clip.audio.gain.set", catalogEntry(setClipAudioGainSchema, "low", "none", "Set {clip} gain to {gainDb} dB")],
  ["clip.audio.fade.set", catalogEntry(setClipAudioFadeSchema, "low", "none", "Set audio fades on {clip}")],
  ["clip.audio.offset.set", catalogEntry(setClipAudioOffsetSchema, "normal", "none", "Shift {clip} audio by {offset}")],
  ["clip.audio.channels.set", catalogEntry(setClipAudioChannelsSchema, "low", "none", "Use {mapping} channel(s) on {clip}")],
  ["clip.audio.chain.set", catalogEntry(setClipAudioChainSchema, "normal", "none", "Set audio chain on {target}")],
  ["sequence.audio.master.set", catalogEntry(setSequenceAudioMasterSchema, "normal", "none", "Set master loudness target {targetLufs} LUFS / {truePeakDb} dBTP")],
  ["clip.loop.set", catalogEntry(setClipLoopSchema, "low", "none", "Loop {clip} with {loopCrossfade} crossfade")],
  ["clip.anchor.set", catalogEntry(setClipAnchorSchema, "normal", "none", "Anchor {clip} start to {anchor}")],
  ["layer.ducking.set", catalogEntry(setLayerDuckingSchema, "low", "none", "Set ducking on {layer}")],
  ["layer.ducking.override", catalogEntry(setLayerDuckingOverrideSchema, "low", "none", "Set manual ducking points on {layer}")],
  ["clip.color.set", catalogEntry(setClipColorSchema, "low", "none", "Adjust color on {clip}")],
  ["clip.look.apply", catalogEntry(applyClipLookSchema, "low", "none", "Apply look {presetId}@{presetVersion} to {target}")],
  ["transition.set", catalogEntry(setTransitionSchema, "normal", "none", "Set {kind} ({duration}) between {a} and {b}")],
  ["transition.remove", catalogEntry(removeTransitionSchema, "normal", "none", "Remove {kind} between {a} and {b}")],
  ["pickup.splice", catalogEntry(pickupSpliceSchema, "normal", "realign", "Replace {wordRange} with pickup {pickupAssetId}")],
  ["transcript.create", catalogEntry(
    transcriptCreateSchema,
    "low",
    "shift",
    "Register canonical transcript for {asset}",
  )],
  ["transcript.word.correct", catalogEntry(
    transcriptWordCorrectSchema,
    "low",
    "shift",
    "Correct {word}",
  )],
  ["transcript.word.replace", catalogEntry(
    transcriptWordReplaceSchema,
    "low",
    "shift",
    "Replace {wordRange}",
  )],
  ["transcript.word.insert", catalogEntry(
    transcriptWordInsertSchema,
    "low",
    "shift",
    "Insert words in {segment}",
  )],
  ["transcript.word.delete", catalogEntry(
    transcriptWordDeleteSchema,
    "low",
    "shift",
    "Delete {wordRange}",
  )],
  ["transcript.word.retime", catalogEntry(
    transcriptWordRetimeSchema,
    "low",
    "realign",
    "Retime {word}",
  )],
  ["transcript.segment.split", catalogEntry(
    transcriptSegmentSplitSchema,
    "low",
    "shift",
    "Split {segment}",
  )],
  ["transcript.segment.merge", catalogEntry(
    transcriptSegmentMergeSchema,
    "low",
    "shift",
    "Merge {segments}",
  )],
  ["transcript.speaker.assign", catalogEntry(
    transcriptSpeakerAssignSchema,
    "low",
    "shift",
    "Assign {speaker}",
  )],
  ["transcript.realign", catalogEntry(
    transcriptRealignSchema,
    "normal",
    "realign",
    "Realign {wordRange}",
  )],
  ["transcript.range.remove", catalogEntry(
    transcriptRangeRemoveSchema,
    "normal",
    "shift",
    "Remove {wordRange} ({duration})",
  )],
  ["transcript.range.retain", catalogEntry(
    transcriptRangeRetainSchema,
    "consequential",
    "shift",
    "Retain only {n} passages ({duration}) in {sequence}",
  )],
  ["transcript.range.createClip", catalogEntry(
    transcriptRangeCreateClipSchema,
    "normal",
    "shift",
    "Create clip from {wordRange}",
  )],
  ["transcript.range.shortCandidate", catalogEntry(
    transcriptRangeShortCandidateSchema,
    "low",
    "none",
    "Mark {wordRange} as short-form candidate",
  )],
  ["caption.track.add", catalogEntry(captionTrackAddSchema, "low", "shift", "Add caption track {name}")],
  ["caption.track.remove", catalogEntry(captionTrackRemoveSchema, "low", "shift", "Remove caption track {captionId}")],
  ["caption.track.set", catalogEntry(captionTrackSetSchema, "low", "shift", "Configure caption track {captionId}")],
  ["caption.style.set", catalogEntry(captionStyleSetSchema, "low", "shift", "Style caption track {captionId}")],
  ["caption.break.set", catalogEntry(captionBreakSetSchema, "low", "shift", "Set caption break after {afterWordId}")],
  ["caption.break.clear", catalogEntry(captionBreakClearSchema, "low", "shift", "Clear caption break after {afterWordId}")],
  ["caption.word.emphasis.set", catalogEntry(captionWordEmphasisSetSchema, "low", "shift", "Set caption emphasis on {wordId}")],
  ["caption.cue.retime", catalogEntry(captionCueRetimeSchema, "low", "retime", "Nudge caption cue {firstWordId}")],
  ["caption.preset.upgrade", catalogEntry(captionPresetUpgradeSchema, "normal", "shift", "Upgrade caption preset on {captionId}")],
  ["anchor.rebind", catalogEntry(
    anchorRebindSchema,
    "normal",
    "none",
    "Rebind anchor on {owner} to {anchor}",
  )],
  ["annotation.create", catalogEntry(
    annotationCreateSchema,
    "low",
    "none",
    "Added {shape} annotation {id} at {anchorDescription}",
  )],
  ["annotation.update", catalogEntry(
    annotationUpdateSchema,
    "low",
    "none",
    "Edited annotation {id} ({changedFields})",
  )],
  ["annotation.delete", catalogEntry(
    annotationDeleteSchema,
    "normal",
    "none",
    "Deleted annotation {id}",
  )],
  ["annotation.resolve", catalogEntry(
    annotationResolveSchema,
    "low",
    "none",
    "Resolved annotation {id} via {txnId|manual: reason}",
  )],
  ["annotation.reject", catalogEntry(
    annotationRejectSchema,
    "low",
    "none",
    "Rejected annotation {id}: {reason}",
  )],
  ["annotation.reopen", catalogEntry(
    annotationReopenSchema,
    "low",
    "none",
    "Reopened annotation {id}: {reason}",
  )],
  ["annotation.convert", catalogEntry(
    annotationConvertSchema,
    "normal",
    "none",
    "Converted annotation {id} to overlay {itemId} on {layerId}",
  )],
  ["graphic.add", catalogEntry(
    graphicAddSchema,
    "normal",
    "none",
    "Add {template.name} '{params.title}' at {anchor}",
  )],
  ["graphic.param.set", catalogEntry(
    graphicParamSetSchema,
    "low",
    "none",
    "Update graphic {graphicId} parameters",
  )],
  ["graphic.anchor.set", catalogEntry(
    graphicAnchorSetSchema,
    "normal",
    "none",
    "Move graphic {graphicId} to {anchor}",
  )],
  ["graphic.retime", catalogEntry(
    graphicRetimeSchema,
    "normal",
    "none",
    "Retime graphic {graphicId}",
  )],
  ["graphic.remove", catalogEntry(
    graphicRemoveSchema,
    "normal",
    "none",
    "Remove graphic {graphicId}",
  )],
  ["template.pin", catalogEntry(
    templatePinSchema,
    "consequential",
    "none",
    "Pin template {templateId} to {version}",
  )],
  ["template.install", catalogEntry(
    templateInstallSchema,
    "low",
    "none",
    "Install template package",
  )],
  ["template.uninstall", catalogEntry(
    templateUninstallSchema,
    "low",
    "none",
    "Uninstall template {templateId}@{version}",
  )],
  ["restyle.plan.create", catalogEntry(
    restylePlanCreateSchema,
    "consequential",
    "none",
    "Create restyle plan for {deliverableId}",
  )],
  ["restyle.segment.approve", catalogEntry(
    restyleSegmentApproveSchema,
    "consequential",
    "none",
    "Approve restyle segment {chunkId}",
  )],
  ["seam.treatment.set", catalogEntry(
    seamTreatmentSetSchema,
    "consequential",
    "none",
    "Set restyle seam {seamId} treatment to {treatment.kind}",
  )],
]);

const RISK_RANK: Record<RiskClass, number> = {
  low: 0,
  normal: 1,
  consequential: 2,
};

function maximumRisk(classes: readonly RiskClass[]): RiskClass {
  return classes.reduce<RiskClass>(
    (maximum, current) => RISK_RANK[current] > RISK_RANK[maximum] ? current : maximum,
    "low",
  );
}

function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath === "" ? "/" : error.instancePath;
  return `${path} ${error.message ?? error.keyword}`;
}

function operationFailure(
  code: `E_${Uppercase<string>}`,
  message: string,
  affected: readonly string[] = [],
) {
  return failure(makeGuyditorError(code, message, { affected }));
}

function actorFor(context: OperationContext): TransactionRecord["actor"] {
  if (context.origin === "ui") return { kind: "human", id: "ui" };
  if (context.origin === "agent") {
    return { kind: "agent", id: context.sessionId ?? "agent" };
  }
  return { kind: "tool", id: "system" };
}

function instructionFor(context: OperationContext): TransactionRecord["instruction"] {
  return context.origin === "ui"
    ? { kind: "ui-direct" }
    : { kind: "skill-policy" };
}

export class OperationEngine {
  readonly #idFactory: IdFactory;
  readonly #committer: OperationCommitter | undefined;
  readonly #appVersion: string;
  readonly #now: () => Date;
  readonly #operationDispatcher: OperationDispatcher | undefined;
  readonly #anchorDependencies: AnchorResolverDependencies;
  readonly #proposalStore: ProposalStore | undefined;
  readonly #automationPolicy: AutomationPolicy | undefined;
  readonly #approvedTransitionPresets: ReadonlySet<string>;
  readonly #continuityGuard: ContinuityGuard | undefined;
  readonly #auditSink: AuditSink | undefined;
  readonly #templateProvider: TemplateProvider | undefined;
  readonly #seedFactory: () => number;
  readonly #autoAcceptsBySession = new Map<string, number>();
  readonly #undoStack: Array<{
    transactionId: string;
    inverse: OperationInput[];
    redo: OperationInput[];
    expectedHead: string;
  }> = [];
  readonly #redoStack: Array<{
    originalTransactionId: string;
    inverse: OperationInput[];
    redo: OperationInput[];
    expectedHead: string;
  }> = [];
  #project: GuyditorProject;

  public constructor(project: GuyditorProject, options: OperationEngineOptions = {}) {
    this.#project = project;
    this.#idFactory = options.idFactory ?? ((prefix) => makeId(prefix));
    this.#committer = options.committer;
    this.#appVersion = options.appVersion ?? "0.0.0";
    this.#now = options.now ?? (() => new Date());
    this.#operationDispatcher = options.operationDispatcher;
    this.#anchorDependencies = options.anchorResolvers instanceof AnchorResolverRegistry
      ? options.anchorResolvers.dependencies()
      : options.anchorResolvers ?? {};
    this.#proposalStore = options.proposalStore;
    this.#automationPolicy = options.automationPolicy;
    this.#approvedTransitionPresets = new Set(options.approvedTransitionPresets ?? []);
    this.#continuityGuard = options.continuityGuard;
    this.#auditSink = options.auditSink;
    this.#templateProvider = options.templateProvider;
    this.#seedFactory = options.seedFactory ?? (() => randomBytes(4).readUInt32BE(0));
  }

  public get currentProject(): GuyditorProject {
    return this.#project;
  }

  public async execute(
    batch: OperationInput[],
    context: OperationContext,
  ): Promise<Result<OperationBatchResult>> {
    return this.#execute(batch, context, false);
  }

  async #execute(
    batch: OperationInput[],
    context: OperationContext,
    allowProposalCommit: boolean,
    captureDryRun?: (project: GuyditorProject) => void,
  ): Promise<Result<OperationBatchResult>> {
    const base = this.#project;
    if (context.baseRevision !== base.revision) {
      return operationFailure(
        "E_OP_STALE_BASE",
        `Operation base ${context.baseRevision} does not match accepted revision ${base.revision}.`,
      );
    }
    if (
      !context.dryRun && !allowProposalCommit &&
      (context.origin === "agent" || context.actor?.kind === "agent" ||
        context.proposalId !== undefined)
    ) {
      return operationFailure(
        "E_OP_AGENT_DIRECT",
        "Agent and proposal-linked operations must be committed through proposal acceptance.",
      );
    }
    if (
      !context.dryRun && !allowProposalCommit &&
      batch.some(({ op }) =>
        op === "restyle.plan.create" || op === "restyle.segment.approve" ||
        op === "seam.treatment.set")
    ) {
      return operationFailure(
        "E_OP_PROPOSAL_REQUIRED",
        "Restyle plans, segment approvals, and seam treatments must be committed through proposal acceptance.",
        batch.filter(({ op }) => op.startsWith("restyle.") || op.startsWith("seam."))
          .map(({ op }) => op),
      );
    }

    let working = base;
    const applied: AppliedOperation[] = [];
    const applications: ClipApplication[] = [];
    for (const requested of batch) {
      const beforeOperation = working;
      const definition = catalog.get(requested.op);
      if (definition === undefined) {
        return operationFailure("E_OP_UNKNOWN", `Unknown operation ${requested.op}.`);
      }
      const params = structuredClone(requested.params);
      if (requested.op === "clip.remove" && params["closeGap"] === undefined) {
        params["closeGap"] = true;
      }
      if (
        requested.op === "clip.split" &&
        typeof params["at"] === "string" &&
        params["at"].startsWith("word:")
      ) {
        return operationFailure(
          "E_OP_SCHEMA",
          "clip.split word anchors are deferred until transcripts are available; use clip-relative integer frames in M0.",
        );
      }
      if (!definition.validate(params)) {
        const detail = definition.validate.errors?.map(formatSchemaError).join("; ") ??
          "unknown schema error";
        return operationFailure(
          "E_OP_SCHEMA",
          `${requested.op} parameters failed schema validation: ${detail}`,
        );
      }

      const normalized = { op: requested.op, params };
      let application: Result<ClipApplication>;
      if (isAudioColorOperation(requested.op)) {
        application = applyAudioColorOperation(working, normalized, this.#idFactory);
      } else if (requested.op.startsWith("project.")) {
        application = applyProjectOperation(working, normalized);
      } else if (requested.op.startsWith("asset.")) {
        application = applyAssetOperation(working, normalized);
      } else if (requested.op === "anchor.rebind") {
        application = applyAnchorOperation(working, normalized);
      } else if (requested.op.startsWith("clip.")) {
        application = applyClipOperation(working, normalized, this.#idFactory);
      } else if (requested.op.startsWith("layer.")) {
        application = applyLayerOperation(working, normalized, this.#idFactory);
      } else if (requested.op.startsWith("transition.")) {
        application = applyTransitionOperation(working, normalized, this.#idFactory);
      } else if (requested.op.startsWith("graphic.")) {
        application = this.#templateProvider === undefined
          ? operationFailure(
              "E_TEMPLATE_PROVIDER_UNAVAILABLE",
              "Template graphics require an installed template provider.",
              [requested.op],
            )
          : await applyGraphicOperation(
              working,
              normalized,
              this.#templateProvider,
              this.#idFactory,
              this.#seedFactory,
            );
      } else if (requested.op.startsWith("template.")) {
        application = this.#templateProvider === undefined
          ? operationFailure(
              "E_TEMPLATE_PROVIDER_UNAVAILABLE",
              "Template operations require an installed template provider.",
              [requested.op],
            )
          : await applyTemplateOperation(
              working,
              normalized,
              this.#templateProvider,
              context.dryRun,
          );
      } else if (requested.op.startsWith("restyle.") || requested.op.startsWith("seam.")) {
        application = await applyRestyleOperation(working, normalized, this.#templateProvider);
      } else if (this.#operationDispatcher === undefined) {
        application = operationFailure(
          "E_OP_DISPATCH_UNAVAILABLE",
          `Operation ${requested.op} has no domain dispatcher.`,
          [requested.op],
        );
      } else {
        const dispatched = await this.#operationDispatcher(working, normalized, context);
        application = dispatched.ok
          ? success({ ...dispatched.value, mutations: [] })
          : dispatched;
      }
      if (!application.ok) return application;
      working = application.value.model;
      applications.push(application.value);
      let warnings: ContinuityWarning[] = [];
      if (this.#continuityGuard !== undefined) {
        try {
          warnings = [...await this.#continuityGuard({
            before: beforeOperation,
            after: working,
            operation: normalized,
          })];
        } catch {
          // Continuity evidence is advisory: unavailable/corrupt derived inputs
          // degrade to no warning and never block an otherwise valid edit.
        }
      }
      applied.push({
        op: requested.op,
        params: application.value.redo?.params ?? params,
        summary: application.value.summary,
        inverse: application.value.inverse,
        captionImpact: definition.captionImpact,
        warnings,
        affected: application.value.affected,
      });
    }

    const transitions = await computeAnchorTransitions(
      base,
      working,
      this.#anchorDependencies,
    );
    if (!transitions.ok) return transitions;
    working = transitions.value.project;
    const valid = validateProject(working);
    if (!valid.ok) return valid;
    const diffOrphans = transitions.value.orphanedAnchors.map((orphan) => ({
      owner: orphan.owner,
      anchor: orphan.anchor,
      anchorPath: orphan.anchorPath,
      reason: orphan.reason,
    }));
    const diff = buildSemanticDiff(base, working, applications, applied, diffOrphans);
    const result: OperationBatchResult = {
      base: base.revision,
      applied,
      riskClass: assessBatchRisk(
        base,
        applied,
        diff,
        context.origin,
        [...this.#approvedTransitionPresets],
        maximumRisk(applied.map(({ op }) => catalog.get(op)!.riskClass)),
        working,
      ),
      diff,
    };
    if (context.dryRun) {
      captureDryRun?.(working);
      return success(result);
    }

    const resultRevision = formatRevision(parseRevision(base.revision) + 1);
    const committedCandidate = { ...working, revision: resultRevision };
    const transactionId = this.#idFactory("txn");
    const actor = context.actor ?? actorFor(context);
    const transaction: TransactionRecord = {
      id: transactionId,
      baseRevision: base.revision,
      resultRevision,
      operations: applied.map((operation) => ({
        op: operation.op,
        params: operation.params,
        summary: operation.summary,
        ...(operation.inverse.length === 0
          ? {}
          : {
              inverse: operation.inverse.length === 1
                ? operation.inverse[0]
                : operation.inverse,
            }),
      })),
      instruction: context.instruction ?? instructionFor(context),
      actor,
      versions: {
        app: this.#appVersion,
        schema: "guyditor/v1",
        skills: base.skills.map(({ id, version }) => ({ id, version })),
        presets: base.presets.map(({ id, version }) => ({ id, version })),
        tools: [],
      },
      acceptance: context.acceptance ?? {
        status: "accepted",
        by: actor.id,
        at: this.#now().toISOString(),
        ...(context.proposalId === undefined
          ? {}
          : { proposal: context.proposalId }),
      },
      ...(context.reason === undefined ? {} : { reason: context.reason }),
      orphanedAnchors: transitions.value.orphanedAnchors.map(({ owner, anchor }) => ({
        owner,
        anchor,
      })),
      addresses: [...(context.addresses ?? [])],
      ...(context.undoOf === undefined ? {} : { undoOf: context.undoOf }),
      ...(context.redoOf === undefined ? {} : { redoOf: context.redoOf }),
    };
    const committed = this.#committer === undefined
      ? success(committedCandidate)
      : await this.#committer.commit(committedCandidate, transaction);
    if (!committed.ok) return committed;
    this.#project = committed.value;
    this.#recordAudit({
      type: "operation.committed",
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      projectId: committed.value.project.id,
      transactionId,
      revision: committed.value.revision,
      ...(context.proposalId === undefined ? {} : { proposalId: context.proposalId }),
      origin: context.origin,
      operationCount: applied.length,
    });
    if (
      context.origin === "ui" &&
      context.recordUndo !== false &&
      context.undoOf === undefined &&
      context.redoOf === undefined
    ) {
      this.#undoStack.push({
        transactionId,
        inverse: applied.slice().reverse().flatMap(({ inverse }) => inverse),
        redo: applied.map(({ op, params }) => ({ op, params })),
        expectedHead: committed.value.revision,
      });
      this.#redoStack.splice(0);
    }
    return success({ ...result, transactionId });
  }

  public async undo(): Promise<Result<OperationBatchResult>> {
    const entry = this.#undoStack.at(-1);
    if (entry === undefined) {
      return operationFailure("E_OP_UNDO_EMPTY", "There is no direct UI transaction to undo.");
    }
    const acceptedRevision = this.#committer?.readAcceptedRevision === undefined
      ? success(this.#project.revision)
      : await this.#committer.readAcceptedRevision();
    if (!acceptedRevision.ok) return acceptedRevision;
    if (
      entry.expectedHead !== this.#project.revision ||
      entry.expectedHead !== acceptedRevision.value
    ) {
      this.#undoStack.pop();
      return operationFailure(
        "E_OP_UNDO_STALE",
        `Transaction ${entry.transactionId} is no longer at HEAD; use revert instead.`,
        [entry.transactionId],
      );
    }
    const undone = await this.execute(entry.inverse, {
      baseRevision: this.#project.revision,
      origin: "ui",
      dryRun: false,
      undoOf: entry.transactionId,
      recordUndo: false,
    });
    if (!undone.ok) return undone;
    this.#undoStack.pop();
    this.#redoStack.push({
      originalTransactionId: entry.transactionId,
      inverse: entry.inverse,
      redo: entry.redo,
      expectedHead: this.#project.revision,
    });
    return undone;
  }

  public async redo(): Promise<Result<OperationBatchResult>> {
    const entry = this.#redoStack.at(-1);
    if (entry === undefined) {
      return operationFailure("E_OP_REDO_EMPTY", "There is no undone UI transaction to redo.");
    }
    const acceptedRevision = this.#committer?.readAcceptedRevision === undefined
      ? success(this.#project.revision)
      : await this.#committer.readAcceptedRevision();
    if (!acceptedRevision.ok) return acceptedRevision;
    if (
      entry.expectedHead !== this.#project.revision ||
      entry.expectedHead !== acceptedRevision.value
    ) {
      this.#redoStack.pop();
      return operationFailure(
        "E_OP_REDO_STALE",
        `The redo for ${entry.originalTransactionId} is no longer based at HEAD.`,
        [entry.originalTransactionId],
      );
    }
    const redone = await this.execute(entry.redo, {
      baseRevision: this.#project.revision,
      origin: "ui",
      dryRun: false,
      redoOf: entry.originalTransactionId,
      recordUndo: false,
    });
    if (!redone.ok) return redone;
    this.#redoStack.pop();
    if (redone.value.transactionId !== undefined) {
      this.#undoStack.push({
        transactionId: redone.value.transactionId,
        inverse: entry.inverse,
        redo: entry.redo,
        expectedHead: this.#project.revision,
      });
    }
    return redone;
  }

  public async revertTransaction(id: string): Promise<Result<OperationBatchResult>> {
    const reader = this.#committer?.readTransaction;
    if (reader === undefined) {
      return operationFailure(
        "E_OP_HISTORY_UNAVAILABLE",
        "Transaction history is not configured for this operation engine.",
        [id],
      );
    }
    const loaded = await reader.call(this.#committer, id);
    if (!loaded.ok) return loaded;
    const inverse: OperationInput[] = [];
    for (const operation of loaded.value.operations.slice().reverse()) {
      if (operation.inverse === undefined) {
        return operationFailure(
          "E_OP_REVERT_CONFLICT",
          `Transaction ${id} has no complete inverse; restore its base revision instead.`,
          [id],
        );
      }
      inverse.push(...(Array.isArray(operation.inverse)
        ? operation.inverse
        : [operation.inverse]));
    }
    const reverted = await this.execute(inverse, {
      baseRevision: this.#project.revision,
      origin: "ui",
      dryRun: false,
      instruction: { kind: "ui-direct" },
      reason: `Revert transaction ${id}`,
      recordUndo: false,
    });
    return reverted.ok
      ? reverted
      : operationFailure(
          "E_OP_REVERT_CONFLICT",
          `Transaction ${id} cannot be reverted cleanly (${reverted.error.message}); restore a revision instead.`,
          [id],
        );
  }

  public async restoreRevision(targetRevision: string): Promise<Result<GuyditorProject>> {
    const restore = this.#committer?.restore;
    if (restore === undefined) {
      return operationFailure(
        "E_PROJECT_RESTORE",
        "Revision restore is not configured for this operation engine.",
        [targetRevision],
      );
    }
    const restored = await restore.call(this.#committer, targetRevision);
    if (!restored.ok) return restored;
    this.#project = restored.value;
    this.#undoStack.splice(0);
    this.#redoStack.splice(0);
    return restored;
  }

  public async createProposal(
    request: CreateProposalRequest,
  ): Promise<Result<Proposal>> {
    const store = this.#proposalStore;
    if (store === undefined) {
      return operationFailure(
        "E_PROPOSAL_STORE_UNAVAILABLE",
        "Proposal persistence is not configured for this operation engine.",
      );
    }
    const id = this.#idFactory("prp");
    const createdAt = this.#now().toISOString();
    const proposedRevision = formatRevision(parseRevision(this.#project.revision) + 1);
    const draft: Proposal = {
      id,
      baseRevision: this.#project.revision,
      status: "draft",
      operations: request.operations.map(({ op, params }) => ({
        op,
        params: structuredClone(params),
        summary: `Pending ${op}`,
      })),
      instruction: structuredClone(request.instruction),
      actor: structuredClone(request.actor),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      reason: structuredClone(request.reason),
      riskClass: "normal",
      addresses: [...request.addresses],
      ...(request.warnings === undefined
        ? {}
        : { warnings: structuredClone(request.warnings) }),
      orphanedAnchors: [],
      createdAt,
    };
    const savedDraft = await store.saveProposal(draft, {
      ...structuredClone(this.#project),
      revision: proposedRevision,
    });
    if (!savedDraft.ok) return savedDraft;
    let capturedProject: GuyditorProject | undefined;
    const dryRun = await this.#execute(
      request.operations,
      {
        baseRevision: draft.baseRevision,
        origin: request.actor.kind === "agent" ? "agent" : "system",
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        dryRun: true,
      },
      false,
      (project) => {
        capturedProject = project;
      },
    );
    if (!dryRun.ok) return dryRun;
    if (
      request.actor.kind === "agent" &&
      dryRun.value.riskClass !== "low" &&
      request.reason.text.trim() === ""
    ) {
      return operationFailure(
        "E_OP_REASON_REQUIRED",
        "Normal and consequential agent proposals require a concise reason.",
      );
    }
    const proposed = capturedProject;
    if (proposed === undefined) {
      return operationFailure(
        "E_PROPOSAL_DRY_RUN",
        "Proposal dry-run did not produce a proposed project.",
      );
    }
    const proposedProject: GuyditorProject = proposed;
    const warnings = [...new Map([
      ...(request.warnings ?? []),
      ...dryRun.value.applied.flatMap(({ warnings: entries }) => entries),
    ].map((warning) => [
      `${warning.code}:${warning.boundary.beforeClip ?? "-"}:${warning.boundary.afterClip ?? "-"}:${warning.evidence}`,
      warning,
    ])).values()];
    const proposal: Proposal = {
      id,
      baseRevision: dryRun.value.base,
      status: "ready",
      operations: dryRun.value.applied.map((operation) => ({
        op: operation.op,
        params: operation.params,
        summary: operation.summary,
        ...(operation.inverse.length === 0
          ? {}
          : { inverse: operation.inverse.length === 1 ? operation.inverse[0] : operation.inverse }),
      })),
      instruction: structuredClone(request.instruction),
      actor: structuredClone(request.actor),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      reason: structuredClone(request.reason),
      riskClass: dryRun.value.riskClass,
      addresses: [...request.addresses],
      applied: dryRun.value.applied,
      diff: dryRun.value.diff,
      warnings,
      orphanedAnchors: dryRun.value.diff.orphanedAnchors.map(({ owner, anchor }) => ({
        owner,
        anchor,
      })),
      createdAt,
    };
    const saved = await store.saveProposal(proposal, {
      ...proposedProject,
      revision: proposedRevision,
    });
    if (!saved.ok) return saved;
    this.#recordAudit({
      type: "proposal.created",
      ...(proposal.sessionId === undefined ? {} : { sessionId: proposal.sessionId }),
      projectId: this.#project.project.id,
      proposalId: proposal.id,
      opCount: proposal.operations.length,
      riskClass: proposal.riskClass,
    });
    return this.#shouldAutoAccept(proposal)
      ? this.#acceptProposal(proposal.id, "auto", true)
      : saved;
  }

  public acceptProposal(id: string, resolvedBy: string): Promise<Result<Proposal>> {
    return this.#acceptProposal(id, resolvedBy, false);
  }

  async #acceptProposal(
    id: string,
    resolvedBy: string,
    automatic: boolean,
  ): Promise<Result<Proposal>> {
    const store = this.#proposalStore;
    if (store === undefined) {
      return operationFailure(
        "E_PROPOSAL_STORE_UNAVAILABLE",
        "Proposal persistence is not configured for this operation engine.",
      );
    }
    const loaded = await store.readProposal(id);
    if (!loaded.ok) return loaded;
    const proposal = loaded.value;
    if (proposal.status !== "ready") {
      return operationFailure(
        "E_PROPOSAL_STATE",
        `Proposal ${id} cannot be accepted from status ${proposal.status}.`,
        [id],
      );
    }
    const acceptedRevision = await store.readAcceptedRevision();
    if (!acceptedRevision.ok) return acceptedRevision;
    if (
      proposal.baseRevision !== acceptedRevision.value ||
      proposal.baseRevision !== store.head ||
      proposal.baseRevision !== this.#project.revision
    ) {
      const stale: Proposal = { ...proposal, staleBase: true };
      const updated = await store.updateProposal(stale);
      if (!updated.ok) return updated;
      return operationFailure(
        "E_PROPOSAL_STALE",
        `Proposal base ${proposal.baseRevision} does not match accepted revision ${acceptedRevision.value}.`,
        [id],
      );
    }
    const acceptedAt = this.#now().toISOString();
    const executed = await this.#execute(
      proposal.operations.map(({ op, params }) => ({ op, params })),
      {
        baseRevision: proposal.baseRevision,
        origin: proposal.actor.kind === "agent" ? "agent" : "system",
        ...(proposal.sessionId === undefined ? {} : { sessionId: proposal.sessionId }),
        proposalId: proposal.id,
        dryRun: false,
        actor: proposal.actor,
        instruction: proposal.instruction,
        acceptance: {
          status: automatic ? "auto-accepted-low-risk" : "accepted",
          by: automatic ? "automation-policy" : resolvedBy,
          at: acceptedAt,
          proposal: proposal.id,
        },
        reason: proposal.reason.text,
        addresses: proposal.addresses,
        recordUndo: false,
      },
      true,
    );
    if (!executed.ok) {
      if (executed.error.code !== "E_OP_STALE_BASE") return executed;
      const stale: Proposal = { ...proposal, staleBase: true };
      const updated = await store.updateProposal(stale);
      if (!updated.ok) return updated;
      return operationFailure(
        "E_PROPOSAL_STALE",
        `Proposal ${id} became stale before its commit reached HEAD.`,
        [id],
      );
    }
    const resolved: Proposal = {
      ...proposal,
      status: "accepted",
      resolvedAt: acceptedAt,
      resolvedBy,
      ...(executed.value.transactionId === undefined
        ? {}
        : { resultTransaction: executed.value.transactionId }),
    };
    const updated = await store.updateProposal(resolved);
    if (!updated.ok) return this.#proposalFinalizationFailure(id, updated.error.message);
    const archived = await store.archiveProposal(id);
    if (!archived.ok) return this.#proposalFinalizationFailure(id, archived.error.message);
    if (automatic) {
      const session = proposal.sessionId ?? proposal.actor.id;
      this.#autoAcceptsBySession.set(
        session,
        (this.#autoAcceptsBySession.get(session) ?? 0) + 1,
      );
    }
    this.#recordAudit({
      type: "proposal.outcome",
      ...(proposal.sessionId === undefined ? {} : { sessionId: proposal.sessionId }),
      projectId: this.#project.project.id,
      proposalId: proposal.id,
      outcome: automatic ? "auto_accepted" : "accepted",
      ...(resolved.resultTransaction === undefined
        ? {}
        : { transactionId: resolved.resultTransaction }),
      revision: this.#project.revision,
    });
    return success(resolved);
  }

  #proposalFinalizationFailure(id: string, detail: string): Result<never> {
    return failure(makeGuyditorError(
      "E_PROPOSAL_FINALIZE",
      `Accepted state changed, but proposal ${id} could not be finalized: ${detail}`,
      {
        affected: [id],
        acceptedStateChanged: true,
        retry: "unsafe",
        suggestion: "Reopen the project to reconcile the proposal from its journal transaction.",
      },
    ));
  }

  public rejectProposal(id: string, resolvedBy: string): Promise<Result<Proposal>> {
    return this.#resolveProposal(id, "rejected", resolvedBy);
  }

  public withdrawProposal(id: string, resolvedBy: string): Promise<Result<Proposal>> {
    return this.#resolveProposal(id, "withdrawn", resolvedBy);
  }

  async #resolveProposal(
    id: string,
    status: "rejected" | "withdrawn",
    resolvedBy: string,
  ): Promise<Result<Proposal>> {
    const store = this.#proposalStore;
    if (store === undefined) {
      return operationFailure(
        "E_PROPOSAL_STORE_UNAVAILABLE",
        "Proposal persistence is not configured for this operation engine.",
      );
    }
    const loaded = await store.readProposal(id);
    if (!loaded.ok) return loaded;
    if (loaded.value.status !== "ready") {
      return operationFailure(
        "E_PROPOSAL_STATE",
        `Proposal ${id} cannot be ${status} from status ${loaded.value.status}.`,
        [id],
      );
    }
    const resolved: Proposal = {
      ...loaded.value,
      status,
      resolvedAt: this.#now().toISOString(),
      resolvedBy,
    };
    const updated = await store.updateProposal(resolved);
    if (!updated.ok) return updated;
    const archived = await store.archiveProposal(id);
    if (!archived.ok) return archived;
    this.#recordAudit({
      type: "proposal.outcome",
      ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
      projectId: this.#project.project.id,
      proposalId: resolved.id,
      outcome: status,
    });
    return success(resolved);
  }

  #recordAudit(event: AuditSinkEvent): void {
    try {
      this.#auditSink?.record(event);
    } catch {
      // Operational audit is deliberately separate from accepted project state.
    }
  }

  public async supersedeProposal(
    id: string,
    replacement: CreateProposalRequest,
  ): Promise<Result<Proposal>> {
    const store = this.#proposalStore;
    if (store === undefined) {
      return operationFailure(
        "E_PROPOSAL_STORE_UNAVAILABLE",
        "Proposal persistence is not configured for this operation engine.",
      );
    }
    const current = await store.readProposal(id);
    if (!current.ok) return current;
    if (current.value.status !== "ready") {
      return operationFailure(
        "E_PROPOSAL_STATE",
        `Proposal ${id} cannot be superseded from status ${current.value.status}.`,
        [id],
      );
    }
    const created = await this.createProposal(replacement);
    if (!created.ok) return created;
    const superseded: Proposal = {
      ...current.value,
      status: "superseded",
      supersededBy: created.value.id,
      resolvedAt: this.#now().toISOString(),
      resolvedBy: replacement.actor.id,
    };
    const updated = await store.updateProposal(superseded);
    if (!updated.ok) return updated;
    const archived = await store.archiveProposal(id);
    return archived.ok ? created : archived;
  }

  #shouldAutoAccept(proposal: Proposal): boolean {
    const policy = this.#automationPolicy;
    if (
      policy === undefined || !policy.enabled || proposal.actor.kind !== "agent" ||
      proposal.riskClass !== "low"
    ) return false;
    if (proposal.operations.length > policy.maxOpsPerProposal) return false;
    if (
      policy.allowedOperations.length > 0 &&
      proposal.operations.some(({ op }) => !policy.allowedOperations.includes(op))
    ) return false;
    const session = proposal.sessionId ?? proposal.actor.id;
    return (this.#autoAcceptsBySession.get(session) ?? 0) < policy.maxAutoAcceptsPerSession;
  }

  public resolveNavigation(
    project: GuyditorProject,
    target: NavigationTarget,
    scope?: string,
  ): Promise<Result<TimelinePosition>> {
    return resolveNavigationTarget(
      project,
      target,
      this.#anchorDependencies,
      scope,
    );
  }

  public validateProject(
    project: GuyditorProject = this.#project,
    scope?: string,
  ): Promise<Result<AnchorValidationReport>> {
    const valid = validateProject(project);
    return valid.ok
      ? validateProjectAnchors(
          project,
          scope,
          this.#anchorDependencies,
        )
      : Promise.resolve(valid);
  }
}
