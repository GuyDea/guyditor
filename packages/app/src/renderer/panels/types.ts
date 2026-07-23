import type {
  Annotation,
  Proposal,
  RestylePlan,
} from "../../../../core/src/index.js";
import type { ExportReport } from "../../../../render/src/index.js";
import type { TranscriptSidecar } from "../../../../transcript/src/index.js";
import type { ResolvedSkill, SkillManifest } from "../../../../agent/src/index.js";
import type { ProjectSnapshot } from "../../shared/ipc.js";

export interface WorkspacePanelProps {
  snapshot: ProjectSnapshot | null;
  transcripts: TranscriptSidecar[];
  annotations: Annotation[];
  proposals: Proposal[];
  skills: SkillManifest[];
  pinnedSkills: ResolvedSkill[];
  skillDrafts: ResolvedSkill[];
  restylePlan: RestylePlan | null;
  exportReport: ExportReport | null;
  refreshProject: () => Promise<void>;
  refreshAnnotations: () => Promise<void>;
  refreshProposals: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshRestylePlan: () => Promise<void>;
  refreshExportReport: () => Promise<void>;
  setNotice: (notice: string) => void;
}
