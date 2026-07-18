import type { SemanticAnchor } from "../project/index.js";

export interface SemanticOperation {
  op: string;
  params: Record<string, unknown>;
  summary: string;
  inverse?: { op: string; params: Record<string, unknown> };
}

export interface TransactionRecord {
  id: string;
  baseRevision: string;
  resultRevision: string;
  operations: SemanticOperation[];
  instruction: {
    kind: "user-text" | "annotation" | "ui-direct" | "skill-policy";
    text?: string;
    annotation?: string;
  };
  actor: { kind: "human" | "agent" | "tool"; id: string; model?: string };
  versions: {
    app: string;
    schema: "guyditor/v1";
    skills: { id: string; version: string }[];
    presets: { id: string; version: number }[];
    tools: { name: string; version: string }[];
  };
  acceptance: {
    status: "accepted" | "auto-accepted-low-risk";
    by: string;
    at: string;
    proposal?: string;
  };
  reason?: string;
  orphanedAnchors: { owner: string; anchor: SemanticAnchor }[];
  addresses: string[];
  divergence?: string;
  undoOf?: string;
  redoOf?: string;
}

export interface RevisionLock {
  revision: string;
  masterSha256: string;
  assets: { id: string; path: string; sha256: string }[];
  sidecars: { name: string; schema: string; sha256: string }[];
  presets: { id: string; version: number; sha256: string }[];
  skills: { id: string; version: string; contentHash: string }[];
  profiles: { id: string; version: string }[];
  tools: { name: string; version: string }[];
}
