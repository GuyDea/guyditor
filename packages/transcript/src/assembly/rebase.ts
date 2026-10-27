import type { GuyditorProject, Proposal } from "../../../core/src/index.js";

/**
 * An assembly proposal may be rebased over unrelated revisions only while the spot its clips go
 * to is untouched: the sequence still has exactly as many clips as the first insert index.
 */
export function isRebaseSafeAssemblyProposal(
  proposal: Pick<Proposal, "operations" | "reason">,
  project: GuyditorProject,
): boolean {
  if (proposal.operations.length === 0 || !proposal.operations.every(({ op }) => op === "clip.insert")) {
    return false;
  }
  if (!proposal.reason.sources.some(({ kind, ref }) => kind === "instruction" && /^asb_/u.test(ref))) return false;
  const indexes = proposal.operations.map(({ params }) => params["index"]);
  const sequenceIds = new Set(proposal.operations.map(({ params }) => params["sequenceId"]));
  if (sequenceIds.size !== 1 || indexes.some((index) => typeof index !== "number")) return false;
  const sequence = project.sequences.find(({ id }) => id === [...sequenceIds][0]);
  return sequence !== undefined && sequence.clips.length === Math.min(...(indexes as number[]));
}
