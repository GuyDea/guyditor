import { useMemo, useState } from "react";

import type {
  ResolvedSkill,
  SkillManifest,
  SkillVersionDiff,
} from "../../../../agent/src/index.js";
import { errorMessage } from "../ipc.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

function semverParts(version: string): [number, number, number] {
  const parts = version.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function latestSkillVersions(skills: readonly SkillManifest[]): SkillManifest[] {
  const latest = new Map<string, SkillManifest>();
  for (const skill of skills) {
    const existing = latest.get(skill.id);
    if (existing === undefined || compareSemver(existing.version, skill.version) < 0) {
      latest.set(skill.id, skill);
    }
  }
  return [...latest.values()].sort((left, right) => left.title.localeCompare(right.title));
}

function versionList(skills: readonly SkillManifest[], skillId: string): string[] {
  return skills.filter(({ id }) => id === skillId)
    .map(({ version }) => version)
    .sort(compareSemver);
}

export function SkillsPanel({
  skills,
  pinnedSkills,
  skillDrafts,
  refreshProject,
  refreshSkills,
  setNotice,
}: WorkspacePanelProps): React.JSX.Element {
  const latest = useMemo(() => latestSkillVersions(skills), [skills]);
  const [detail, setDetail] = useState<ResolvedSkill | null>(null);
  const [diff, setDiff] = useState<SkillVersionDiff | null>(null);
  const [pendingUpgrade, setPendingUpgrade] = useState<{
    skillId: string;
    version: string;
  } | null>(null);
  const [pendingPublish, setPendingPublish] = useState<{
    skillId: string;
    version: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function inspect(skillId: string, version: string): Promise<void> {
    try {
      setDetail(await window.guyditor.call<ResolvedSkill>("SkillRegistry", "get", {
        skillId,
        version,
      }));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function associate(skillId: string, version: string): Promise<void> {
    setBusy(true);
    try {
      await window.guyditor.call("SkillRegistry", "associate", { skillId, version });
      await Promise.all([refreshProject(), refreshSkills()]);
      setNotice(`Pinned editorial skill ${skillId}@${version}.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reviewUpgrade(skillId: string, fromVersion: string, toVersion: string): Promise<void> {
    try {
      const next = await window.guyditor.call<SkillVersionDiff>("SkillRegistry", "diff", {
        skillId,
        fromVersion,
        toVersion,
      });
      setDiff(next);
      setPendingUpgrade({ skillId, version: toVersion });
      setPendingPublish(null);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function confirmUpgrade(): Promise<void> {
    if (pendingUpgrade === null) return;
    setBusy(true);
    try {
      await window.guyditor.call("SkillRegistry", "upgrade", pendingUpgrade);
      await Promise.all([refreshProject(), refreshSkills()]);
      setNotice(`Upgraded ${pendingUpgrade.skillId} to ${pendingUpgrade.version}; the change is journaled.`);
      setPendingUpgrade(null);
      setDiff(null);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reviewDraft(draft: ResolvedSkill): Promise<void> {
    const baseVersion = versionList(skills, draft.manifest.id)
      .filter((version) => compareSemver(version, draft.manifest.version) < 0)
      .at(-1);
    if (baseVersion === undefined) {
      setNotice(`Draft ${draft.manifest.id}@${draft.manifest.version} has no published base.`);
      return;
    }
    try {
      setDetail(draft);
      setDiff(await window.guyditor.call<SkillVersionDiff>("SkillRegistry", "diff", {
        skillId: draft.manifest.id,
        fromVersion: baseVersion,
        toVersion: draft.manifest.version,
      }));
      setPendingPublish({ skillId: draft.manifest.id, version: draft.manifest.version });
      setPendingUpgrade(null);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function publishDraft(): Promise<void> {
    if (pendingPublish === null) return;
    setBusy(true);
    try {
      await window.guyditor.call("SkillRegistry", "publishDraft", pendingPublish);
      await refreshSkills();
      setNotice(`Published immutable skill revision ${pendingPublish.skillId}@${pendingPublish.version}; project pins are unchanged.`);
      setPendingPublish(null);
      setDiff(null);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      id="skills"
      title="Editorial skills"
      eyebrow="Versioned preferences"
      actions={<button type="button" data-testid="skills-refresh" onClick={() => void refreshSkills()}>Refresh</button>}
    >
      <section className="skill-section" data-testid="project-skill-pins">
        <header><h3>Project pins</h3><span>{String(pinnedSkills.length)} active</span></header>
        {pinnedSkills.map((skill) => {
          const newest = latest.find(({ id }) => id === skill.manifest.id);
          const canUpgrade = newest !== undefined &&
            compareSemver(newest.version, skill.manifest.version) > 0;
          return (
            <article className="skill-card is-pinned" key={skill.manifest.id}>
              <div>
                <strong>{skill.manifest.title}</strong>
                <small>{skill.manifest.name} · v{skill.manifest.version}</small>
              </div>
              <span className="state-chip" data-state="ready">active</span>
              <p>{skill.manifest.summary}</p>
              <div className="chip-row">
                {skill.manifest.categories.map((category) => <span className="entity-chip" key={category}>{category}</span>)}
              </div>
              <div className="skill-actions">
                <button type="button" onClick={() => setDetail(skill)}>Read</button>
                {canUpgrade && newest !== undefined ? (
                  <button
                    type="button"
                    data-testid={`skill-review-upgrade-${skill.manifest.id}`}
                    onClick={() => void reviewUpgrade(
                      skill.manifest.id,
                      skill.manifest.version,
                      newest.version,
                    )}
                  >Review v{newest.version}</button>
                ) : null}
              </div>
            </article>
          );
        })}
        {pinnedSkills.length === 0 ? <p className="empty-copy">No skills are pinned to this project.</p> : null}
      </section>

      {diff === null ? null : (
        <section className="skill-diff" data-testid="skill-version-diff">
          <header>
            <strong>v{diff.fromVersion} → v{diff.toVersion}</strong>
            <span>{pendingPublish === null ? "explicit upgrade" : "publish review"}</span>
          </header>
          <p><del>{diff.metadata.summary.before}</del></p>
          <p><ins>{diff.metadata.summary.after}</ins></p>
          <dl>
            <div><dt>Rules +</dt><dd>{String(diff.rules.added.length)}</dd></div>
            <div><dt>Rules −</dt><dd>{String(diff.rules.removed.length)}</dd></div>
            <div><dt>Changed</dt><dd>{String(diff.rules.changed.length)}</dd></div>
            <div><dt>Examples +</dt><dd>{String(diff.examples.approved.added.length + diff.examples.rejected.added.length)}</dd></div>
          </dl>
          {diff.rules.added.length + diff.rules.removed.length + diff.rules.changed.length === 0 ? null : (
            <ul className="skill-diff-rules">
              {diff.rules.added.map((rule) => <li key={`add-${rule.id}`}><ins>+ {rule.text}</ins></li>)}
              {diff.rules.removed.map((rule) => <li key={`remove-${rule.id}`}><del>− {rule.text}</del></li>)}
              {diff.rules.changed.map((rule) => (
                <li key={`change-${rule.id}`}><del>{rule.before.text}</del><ins>{rule.after.text}</ins></li>
              ))}
            </ul>
          )}
          {diff.body.before === diff.body.after ? null : (
            <details className="skill-body-diff">
              <summary>Prose body changed</summary>
              <pre>− {diff.body.before}{"\n"}+ {diff.body.after}</pre>
            </details>
          )}
          <div className="skill-actions">
            <button type="button" onClick={() => {
              setDiff(null);
              setPendingUpgrade(null);
              setPendingPublish(null);
            }}>Cancel</button>
            {pendingPublish === null ? (
              <button
                type="button"
                className="primary-action"
                data-testid="skill-confirm-upgrade"
                disabled={busy}
                onClick={() => void confirmUpgrade()}
              >Upgrade project pin</button>
            ) : (
              <button
                type="button"
                className="primary-action"
                data-testid="skill-confirm-publish"
                disabled={busy}
                onClick={() => void publishDraft()}
              >Publish reviewed version</button>
            )}
          </div>
        </section>
      )}

      <section className="skill-section" data-testid="skill-library">
        <header><h3>Library</h3><span>{String(latest.length)} skills</span></header>
        {latest.map((skill) => {
          const pinned = pinnedSkills.some(({ manifest }) => manifest.id === skill.id);
          return (
            <article className="skill-card" key={skill.id}>
              <div><strong>{skill.title}</strong><small>{skill.name}</small></div>
              <div className="skill-version-row">
                {versionList(skills, skill.id).map((version) => (
                  <button key={version} type="button" onClick={() => void inspect(skill.id, version)}>v{version}</button>
                ))}
              </div>
              {!pinned ? (
                <button
                  type="button"
                  className="primary-action"
                  disabled={busy}
                  data-testid={`skill-associate-${skill.id}`}
                  onClick={() => void associate(skill.id, skill.version)}
                >Pin v{skill.version}</button>
              ) : null}
            </article>
          );
        })}
        {latest.length === 0 ? <p className="empty-copy">The global skill library is empty.</p> : null}
      </section>

      {skillDrafts.length === 0 ? null : (
        <section className="skill-section" data-testid="skill-drafts">
          <header><h3>Draft revisions</h3><span>inactive</span></header>
          {skillDrafts.map((draft) => (
            <article className="skill-card is-draft" key={`${draft.manifest.id}@${draft.manifest.version}`}>
              <div><strong>{draft.manifest.title}</strong><small>v{draft.manifest.version} · unpublished</small></div>
              <button
                type="button"
                data-testid={`skill-review-draft-${draft.manifest.id}-${draft.manifest.version}`}
                disabled={busy}
                onClick={() => void reviewDraft(draft)}
              >Review draft</button>
            </article>
          ))}
        </section>
      )}

      {detail === null ? null : (
        <section className="skill-reader" data-testid="skill-reader">
          <header><strong>{detail.manifest.title} · v{detail.manifest.version}</strong><button type="button" onClick={() => setDetail(null)}>Close</button></header>
          <pre>{detail.body}</pre>
          <h4>Rules</h4>
          <ul>{detail.manifest.rules.map((rule) => <li key={rule.id}><b>{rule.strength}</b> {rule.text}</li>)}</ul>
          {(detail.exampleContents?.approved.length ?? 0) +
            (detail.exampleContents?.rejected.length ?? 0) === 0 ? null : (
              <>
                <h4>Preference examples</h4>
                <ul>
                  {(["approved", "rejected"] as const).flatMap((decision) =>
                    detail.exampleContents?.[decision].map(({ example, payload }) => (
                      <li key={example.id}>
                        <b>{decision}</b> {example.description}
                        {payload === undefined ? null : <pre>{JSON.stringify(payload, null, 2)}</pre>}
                      </li>
                    )) ?? [])}
                </ul>
              </>
            )}
        </section>
      )}
    </Panel>
  );
}
