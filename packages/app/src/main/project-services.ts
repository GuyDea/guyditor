import type {
  AnnotationService,
  JobQueue,
  ProjectStore,
} from "../../../core/src/index.js";
import type {
  CaptureWatcher,
  MediaEngine,
} from "../../../media/src/index.js";
import type { TranscriptEngine } from "../../../transcript/src/index.js";
import type {
  RenderService,
  TemplateAuthoringService,
  TemplateRegistry,
} from "../../../render/src/index.js";
import type { CompositorModel } from "../../../compositor/src/index.js";
import type {
  BatchExportService,
  PublishService,
} from "../../../deliver/src/index.js";
import type {
  AdapterRegistry,
  GenerationExecutionService,
  RestyleExecutionService,
} from "../../../agent/src/index.js";

import type { RecoveryServices } from "./recovery-service.js";
import type { TakeComparisonService } from "./take-comparison-service.js";
import type { MatteService } from "./matte-service.js";
import type { OtioService } from "./otio-service.js";
import type { ProjectWorkspaceStateStore } from "./project-workspace-state.js";
import type { CaptureProjectMetadata } from "./capture-project-metadata.js";
import type { TaskScope } from "./task-scope.js";

export interface ProjectServices extends RecoveryServices {
  store: ProjectStore;
  workspace: ProjectWorkspaceStateStore;
  jobs: JobQueue;
  media: MediaEngine;
  capture: CaptureWatcher;
  captureMetadata: CaptureProjectMetadata;
  transcript: TranscriptEngine;
  annotations: AnnotationService;
  compositor: CompositorModel;
  matte: MatteService;
  otio: OtioService;
  render: RenderService;
  publish: PublishService;
  batch: BatchExportService;
  templates: TemplateRegistry;
  templateAuthoring: TemplateAuthoringService;
  adapters: AdapterRegistry;
  generation: GenerationExecutionService;
  restyle: RestyleExecutionService;
  takeComparisons: TakeComparisonService;
  followUps: TaskScope;
  unsubscribeJobs: () => void;
}
