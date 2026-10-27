import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AssemblyCut,
  CandidateSegment,
  CompiledCut,
} from "../../../../transcript/src/assembly/types.js";
import type {
  AiSettingsView,
  AssemblySessionView,
  JobStatus,
  SendInput,
  SendResult,
} from "../../shared/ipc.js";
import { errorMessage } from "../ipc.js";
import { useJobsStore } from "../state/jobs.js";
import { jumpToProposal, jumpToWordRange } from "../workspace-navigation.js";
import { AiSettingsSection } from "./AiSettingsSection.js";
import { Panel } from "./Panel.js";
import type { WorkspacePanelProps } from "./types.js";

type Pending = Exclude<SendResult, { kind: "turn" }> & { resend: SendInput };

/** What a non-turn `send` result means for the next request. */
export function nextSendPayload(
  base: SendInput,
  result: SendResult,
): { payload: SendInput | null; notice: string | null } {
  switch (result.kind) {
    case "confirm-cost":
      return { payload: { ...base, confirmToken: result.confirmToken }, notice: null };
    case "acknowledge-external":
      return { payload: { ...base, acknowledgeExternal: true }, notice: null };
    case "blocked":
      return { payload: null, notice: result.message };
    case "turn":
      return { payload: null, notice: null };
  }
}

/** Whether the message box may send right now (button click and Enter key). */
export function canSendMessage(state: {
  status: AssemblySessionView["status"] | undefined;
  hasEvidence: boolean;
  busy: boolean;
  pending: boolean;
  text: string;
}): boolean {
  return (state.status === "conversing" || state.status === "planned") && state.hasEvidence && !state.busy &&
    !state.pending && state.text.trim() !== "";
}

export interface AssemblePanelProps extends WorkspacePanelProps {
  /** Test seams: `renderToStaticMarkup` does not run the mount fetch. */
  initialSessions?: AssemblySessionView[];
  initialSettings?: AiSettingsView;
}

const PAST_CREATED: readonly AssemblySessionView["status"][] = [
  "conversing", "planned", "proposed", "accepted",
];

export function activeSession(sessions: readonly AssemblySessionView[]): AssemblySessionView | null {
  return sessions.find(({ status }) => status !== "abandoned") ?? null;
}

export function settingsSummary(settings: AiSettingsView): string {
  return `${settings.provider} · ${settings.model} · ${settings.effort} · tightening: ${settings.tightening}`;
}

export function evidenceSummary(session: AssemblySessionView): string | null {
  const { evidence } = session;
  if (evidence === null) return null;
  const clips = evidence.assets.length;
  const script = session.inputs.script === null
    ? "no script"
    : `${String(evidence.scriptBlocks.length)} blocks`;
  return `${String(clips)} ${clips === 1 ? "clip" : "clips"} · ${String(evidence.segments.length)} segments · ${String(evidence.groups.length)} repeat groups · script: ${script}`;
}

export function usageLine(session: AssemblySessionView): string | null {
  const usages = session.messages.flatMap(({ usage }) => usage === null ? [] : [usage]);
  if (usages.length === 0) return null;
  const tokens = usages.reduce((sum, { inputTokens, outputTokens }) => sum + inputTokens + outputTokens, 0);
  const usd = usages.reduce((sum, { usd: cost }) => sum + cost, 0);
  const estimated = usages.some(({ estimated: guess }) => guess) ? " (estimated)" : "";
  return `${String(tokens)} tokens · $${usd.toFixed(2)}${estimated}`;
}

function clock(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function frameSeconds(time: CompiledCut["in"]): number {
  const [numerator, denominator] = time.fps.split("/").map(Number);
  return time.frames / ((numerator ?? 24) / (denominator ?? 1));
}

export function cutRange(
  compiled: CompiledCut | undefined,
  cut?: AssemblyCut,
  segments: readonly CandidateSegment[] = [],
): string {
  if (compiled !== undefined) {
    return `${clock(frameSeconds(compiled.in))}–${clock(frameSeconds(compiled.out))}`;
  }
  const first = segments.find(({ assetId, fromWord }) =>
    assetId === cut?.assetId && fromWord === cut.fromWord);
  const last = segments.find(({ assetId, toWord }) =>
    assetId === cut?.assetId && toWord === cut.toWord);
  return first === undefined || last === undefined
    ? "—"
    : `${clock(first.start.samples / first.start.rate)}–${clock(last.end.samples / last.end.rate)}`;
}

function isPreparing(jobs: JobStatus[]): boolean {
  return jobs.some(({ kind, state }) =>
    kind === "assembly.prepare" && (state === "queued" || state === "running"));
}

export function AssemblePanel({
  snapshot,
  transcripts,
  refreshProposals,
  setNotice,
  assemblyVersion = 0,
  initialSessions,
  initialSettings,
}: AssemblePanelProps): React.JSX.Element {
  const jobs = useJobsStore((state) => state.jobs);
  const [sessions, setSessions] = useState<AssemblySessionView[]>(initialSessions ?? []);
  const [settings, setSettings] = useState<AiSettingsView | null>(initialSettings ?? null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [scriptPath, setScriptPath] = useState("");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const assets = useMemo(
    () => (snapshot?.master.assets ?? []).filter(({ kind }) => kind === "video" || kind === "audio"),
    [snapshot],
  );
  const selectedIds = assets.map(({ id }) => id).filter((id) => !deselected.has(id));
  const active = activeSession(sessions);
  const preparing = isPreparing(jobs) || active?.status === "preparing";

  const reload = useCallback(async (): Promise<void> => {
    try {
      setSessions(await window.guyditor.call<AssemblySessionView[]>("Assembly", "list", {}));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }, [setNotice]);

  useEffect(() => {
    void reload();
  }, [reload, assemblyVersion]);

  useEffect(() => {
    let live = true;
    window.guyditor.call<AiSettingsView>("AiSettings", "get", {})
      .then((view) => {
        if (live) setSettings(view);
      })
      .catch((error: unknown) => setNotice(errorMessage(error)));
    return () => {
      live = false;
    };
  }, [setNotice]);

  function replaceSession(view: AssemblySessionView): void {
    setSessions((current) => current.some(({ id }) => id === view.id)
      ? current.map((session) => session.id === view.id ? view : session)
      : [view, ...current]);
  }

  async function analyze(): Promise<void> {
    setBusy(true);
    setPending(null);
    try {
      if (active !== null) {
        replaceSession(await window.guyditor.call<AssemblySessionView>(
          "Assembly",
          "abandon",
          { sessionId: active.id },
        ));
      }
      const created = await window.guyditor.call<AssemblySessionView>("Assembly", "create", {
        assetIds: selectedIds,
        ...(scriptPath.trim() === "" ? {} : { scriptPath: scriptPath.trim() }),
      });
      replaceSession(created);
      await window.guyditor.call<JobStatus>("Assembly", "prepare", { sessionId: created.id });
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
      void reload();
    }
  }

  async function startOver(): Promise<void> {
    if (active === null) return;
    setPending(null);
    try {
      replaceSession(await window.guyditor.call<AssemblySessionView>(
        "Assembly",
        "abandon",
        { sessionId: active.id },
      ));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  async function send(request: Omit<SendInput, "sessionId">): Promise<void> {
    if (active === null) return;
    const payload: SendInput = { sessionId: active.id, ...request };
    setBusy(true);
    try {
      const result = await window.guyditor.call<SendResult>("Assembly", "send", payload);
      if (result.kind === "turn") {
        replaceSession(result.session);
        setPending(null);
        setInput("");
      } else {
        setPending({ ...result, resend: nextSendPayload(payload, result).payload ?? payload });
      }
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function createProposal(): Promise<void> {
    if (active === null) return;
    setBusy(true);
    try {
      const created = await window.guyditor.call<{ proposalId: string; session: AssemblySessionView }>(
        "Assembly",
        "createProposal",
        { sessionId: active.id },
      );
      replaceSession(created.session);
      await refreshProposals();
      setNotice(`Prepared ${created.proposalId} from the assembly plan.`);
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const lastAssistant = active === null ? undefined : [...active.messages]
    .reverse().find(({ role }) => role === "assistant");
  const lastQuestions = lastAssistant?.reply?.status === "questions" ? lastAssistant.reply.questions : [];
  const conversing = active?.status === "conversing";
  const canSend = canSendMessage({
    status: active?.status,
    hasEvidence: active?.evidence != null,
    busy,
    pending: pending !== null,
    text: input,
  });
  const summary = active === null ? null : evidenceSummary(active);
  const usage = active === null ? null : usageLine(active);
  const plan = active?.plan ?? null;

  return (
    <Panel id="assemble" title="Assemble" eyebrow="AI rough cut">
      <section className="assemble-region" data-testid="assembly-inputs">
        <ol className="asset-list" data-testid="assembly-assets">
          {assets.length === 0 ? <li className="empty-copy">No video or audio assets yet.</li> : null}
          {assets.map((asset) => {
            const transcribed = transcripts.some(({ assetId }) => assetId === asset.id);
            return (
              <li key={asset.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={!deselected.has(asset.id)}
                    data-testid={`assembly-asset-${asset.id}`}
                    onChange={(event) => setDeselected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.delete(asset.id);
                      else next.add(asset.id);
                      return next;
                    })}
                  />
                  {" "}{asset.path.split("/").pop()}
                </label>
                <span
                  className="state-chip"
                  data-state={transcribed ? "done" : "queued"}
                  title={transcribed ? "Transcript ready" : "Transcript pending"}
                >{transcribed ? "✓" : "…"}</span>
              </li>
            );
          })}
        </ol>
        <div className="path-ingest">
          <input
            type="text"
            value={scriptPath}
            placeholder="Script path (optional)"
            aria-label="Script path"
            data-testid="assembly-script-path"
            onChange={(event) => setScriptPath(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="assembly-settings-summary"
          data-testid="assembly-settings-summary"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >{settings === null ? "AI settings" : settingsSummary(settings)}</button>
        {settingsOpen && settings !== null ? (
          <AiSettingsSection settings={settings} onSettings={setSettings} setNotice={setNotice} />
        ) : null}
        <p className="empty-copy" data-testid="assembly-external-notice">
          Sends the transcript and script text to {settings?.provider ?? "your AI provider"}. Never audio or video.
        </p>
        <div className="assembly-actions">
          <button
            type="button"
            className="primary-action"
            data-testid="assembly-analyze"
            disabled={snapshot === null || selectedIds.length === 0 || preparing || busy ||
              (active !== null && PAST_CREATED.includes(active.status))}
            onClick={() => void analyze()}
          >Analyze footage</button>
          {active !== null && active.status !== "created" ? (
            <button type="button" data-testid="assembly-abandon" onClick={() => void startOver()}>
              Start over
            </button>
          ) : null}
        </div>
        {active?.error ? <p className="empty-copy" role="alert">{active.error}</p> : null}
        {summary === null ? null : (
          <p data-testid="assembly-evidence-summary">{summary}</p>
        )}
      </section>

      <section className="assemble-region" data-testid="assembly-conversation">
        <div data-testid="assembly-messages">
          {(active?.messages ?? []).map((message, index) => (
            <p key={`${message.at}-${String(index)}`} data-role={message.role}>
              <strong>{message.role === "user" ? "You" : message.role === "assistant" ? "AI" : "Check"}</strong>{" "}
              {message.reply?.summary ?? message.content}
            </p>
          ))}
          {conversing ? lastQuestions.map((question, n) => (
            <div key={question.id} className="assembly-question" data-testid={`assembly-question-${String(n)}`}>
              <p>{question.text}</p>
              {question.about === null ? null : (
                <button
                  type="button"
                  data-testid={`assembly-jump-${String(n)}`}
                  onClick={() => question.about && void jumpToWordRange(
                    snapshot?.master,
                    question.about.assetId,
                    question.about.fromWord,
                    question.about.toWord,
                    setNotice,
                  )}
                >Jump</button>
              )}
              {(question.options ?? []).map((option, i) => (
                <button
                  key={option}
                  type="button"
                  data-testid={`assembly-option-${String(n)}-${String(i)}`}
                  disabled={busy}
                  onClick={() => void send({ optionIndex: i, questionId: question.id })}
                >{option}</button>
              ))}
            </div>
          )) : null}
        </div>
        {pending?.kind === "confirm-cost" ? (
          <div role="alert">
            <p>{pending.message}</p>
            <button
              type="button"
              className="primary-action"
              data-testid="assembly-confirm-cost"
              onClick={() => void send(pending.resend)}
            >Confirm ${pending.estimatedUsd.toFixed(2)}</button>
          </div>
        ) : null}
        {pending?.kind === "acknowledge-external" ? (
          <div role="alert">
            <p>{pending.notice}</p>
            <button
              type="button"
              className="primary-action"
              data-testid="assembly-acknowledge"
              onClick={() => void send(pending.resend)}
            >I understand — continue</button>
          </div>
        ) : null}
        {pending?.kind === "blocked" ? (
          <p role="alert" data-testid="assembly-blocked">{pending.message}</p>
        ) : null}
        <div className="path-ingest">
          <input
            type="text"
            value={input}
            placeholder="Tell the assistant what you want"
            aria-label="Message"
            data-testid="assembly-input"
            disabled={!conversing && active?.status !== "planned"}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canSend) void send({ text: input });
            }}
          />
          <button
            type="button"
            data-testid="assembly-send"
            disabled={!canSend}
            onClick={() => void send({ text: input })}
          >Send</button>
        </div>
        {usage === null ? null : <small data-testid="assembly-usage">{usage}</small>}
      </section>

      {plan === null || active === null ? null : (
        <section className="assemble-region" data-testid="assembly-plan-region">
          <p>{plan.summary}</p>
          <table data-testid="assembly-plan">
            <thead>
              <tr><th>Block</th><th>Clip</th><th>Range</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {plan.cuts.map((cut, i) => {
                const asset = assets.find(({ id }) => id === cut.assetId);
                const name = active.evidence?.assets.find(({ assetId }) => assetId === cut.assetId)?.fileName ??
                  asset?.path.split("/").pop() ?? cut.assetId;
                return (
                  <tr key={`${cut.assetId}-${cut.fromWord}-${String(i)}`} data-testid={`assembly-cut-${String(i)}`}>
                    <td>{cut.scriptBlock ?? "—"}</td>
                    <td>{name}</td>
                    <td>{cutRange(active.compiled?.[i], cut, active.evidence?.segments)}</td>
                    <td>
                      {cut.reason}{" "}
                      {plan.flags.filter(({ cutIndex }) => cutIndex === i).map((flag) => (
                        <span key={`${flag.kind}-${flag.note}`} className="state-chip" title={flag.note}>
                          {flag.kind}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {active.proposalId === null ? (
            <button
              type="button"
              className="primary-action"
              data-testid="assembly-create-proposal"
              disabled={active.status !== "planned" || busy}
              onClick={() => void createProposal()}
            >Create proposal</button>
          ) : (
            <button
              type="button"
              data-testid="assembly-open-proposal"
              onClick={() => active.proposalId !== null && jumpToProposal(active.proposalId)}
            >Open proposal</button>
          )}
        </section>
      )}
    </Panel>
  );
}
