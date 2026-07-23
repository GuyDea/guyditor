import { failure, makeGuyditorError, success } from "../errors.js";
import type { GuyditorProject, SkillPin } from "../project/index.js";
import type { ClipApplication } from "./clip.js";
import type { OperationInput } from "./types.js";

function invalid(message: string, affected: string[]) {
  return failure(makeGuyditorError("E_SKILL_PIN", message, { affected }));
}

export function applySkillOperation(
  project: GuyditorProject,
  input: OperationInput,
): ReturnType<typeof success<ClipApplication>> | ReturnType<typeof invalid> {
  const skillId = input.params["skillId"] as string;
  const requested = input.params["pin"] as SkillPin | null;
  const existing = project.skills.find(({ id }) => id === skillId);
  if (requested !== null && requested.id !== skillId) {
    return invalid(
      `skill.pin.set identity ${skillId} does not match pin ${requested.id}.`,
      [skillId, requested.id],
    );
  }
  if (requested !== null && existing !== undefined && existing.name !== requested.name) {
    return invalid(
      `Skill ${skillId} cannot change name from ${existing.name} to ${requested.name}.`,
      [skillId],
    );
  }
  const skills = project.skills.filter(({ id }) => id !== skillId);
  if (requested !== null) skills.push(structuredClone(requested));
  skills.sort((left, right) => left.id.localeCompare(right.id));
  const summary = requested === null
    ? `Unpin ${existing?.name ?? skillId}`
    : existing === undefined
      ? `Pin ${requested.name} at ${requested.version}`
      : `Upgrade ${requested.name} from ${existing.version} to ${requested.version}`;
  return success({
    model: { ...project, skills },
    inverse: [{
      op: "skill.pin.set",
      params: { skillId, pin: existing === undefined ? null : structuredClone(existing) },
    }],
    affected: [skillId],
    summary,
    mutations: [{
      entityId: skillId,
      entityType: "skill",
      change: requested === null ? "removed" : existing === undefined ? "added" : "modified",
      fields: [{ field: "pin", before: existing, after: requested ?? undefined }],
    }],
  });
}
