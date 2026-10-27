import { useCallback, useEffect, useMemo, useState } from "react";

import type { Asset } from "../../../../core/src/index.js";
import { formatBytes } from "../../../../transcript/src/assembly/context-files.js";
import type {
  AssemblyCut,
  AssemblySessionStatus,
  CandidateSegment,
  CompiledCut,
  ContextFile,
  ScriptChoice,
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

/** Session states whose inputs (footage, files, script) may still change: before Analyze, or after a failed one. */
export const INPUTS_EDITABLE: readonly AssemblySessionStatus[] = ["created", "failed"];

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
  const scriptFile = session.inputs.files.find(({ role }) => role === "script");
  const script = scriptFile === undefined
    ? "no script"
    : `${scriptFile.label} (${String(evidence.scriptBlocks.length)} blocks)`;
  return `${String(clips)} ${clips === 1 ? "clip" : "clips"} · ${String(evidence.segments.length)} segments · ${String(evidence.groups.length)} repeat groups · script: ${script}`;
}

export function usageLine(session: AssemblySessionView): string | null {
  const usages = session.messages.flatMap(({ usage }) => usage === null ? [] : [usage]);
  if (usages.length === 0) return null;
  const tokens = usages.reduce((sum, { inputTokens, outputTokens }) => sum + inputTokens + outputTokens, 0);
  const usd = usages.reduce((sum, { usd: cost }) => sum + cost, 0);
  if (session.settings.transport === "cli" && usd === 0) {
    return `via ${session.settings.provider === "openai" ? "codex" : "claude"} (no cost reported)`;
  }
  const estimated = usages.some(({ estimated: guess }) => guess) ? " (estimated)" : "";
  return `${String(tokens)} tokens · $${usd.toFixed(2)}${estimated}`;
}

/** `A<n>` per footage asset: evidence ordinals once analysed, else the selection in capture order; unselected → `—`. */
export function assetLabels(
  assets: readonly Asset[],
  selectedIds: readonly string[],
  evidence: AssemblySessionView["evidence"],
): Map<string, string> {
  const ordinals = new Map<string, number>();
  if (evidence === null) {
    const key = (asset: Asset): [string, string] => [asset.captureTime?.value ?? "", asset.path.split("/").pop() ?? ""];
    const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
    assets.filter(({ id }) => selectedIds.includes(id))
      .sort((a, b) => compare(key(a)[0], key(b)[0]) || compare(key(a)[1], key(b)[1]))
      .forEach(({ id }, index) => ordinals.set(id, index + 1));
  } else {
    for (const { assetId, ordinal } of evidence.assets) ordinals.set(assetId, ordinal);
  }
  return new Map(assets.map(({ id }) => {
    const ordinal = ordinals.get(id);
    return [id, ordinal === undefined ? "—" : `A${String(ordinal)}`];
  }));
}

/** Hover text for attachments the cost estimate counts at a flat rate. */
export function fileRowTitle(file: ContextFile): string | undefined {
  if (file.kind === "image") return "Counted as 1,600 input tokens in the cost estimate";
  if (file.kind === "pdf") return `Counted as 2,000 input tokens per page (${String(file.pages)} pages)`;
  return undefined;
}

/** Names the files an attach added that will not reach the model, or null when every new file is sent. */
export function unsentNotice(before: readonly ContextFile[], after: readonly ContextFile[]): string | null {
  const known = new Set(before.map(({ label }) => label));
  const unsent = after.filter(({ label, sent }) => !known.has(label) && !sent)
    .map(({ label, name, unsentReason }) => `${label} ${name}: not sent — ${unsentReason ?? "not supported"}`);
  return unsent.length === 0 ? null : unsent.join("; ");
}

function scriptValue(script: ScriptChoice): string {
  return script.mode === "label" ? script.label : script.mode;
}

function scriptChoice(value: string): ScriptChoice {
  return value === "auto" || value === "none" ? { mode: value } : { mode: "label", label: value };
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
  const [input, setInput] = useState("");
  const [filePath, setFilePath] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const assets = useMemo(
    () => (snapshot?.master.assets ?? []).filter(({ kind }) => kind === "video" || kind === "audio"),
    [snapshot],
  );
  const active = activeSession(sessions);
  const selectedIds = active?.inputs.assetIds ?? assets.map(({ id }) => id).filter((id) => !deselected.has(id));
  const editable = active === null || INPUTS_EDITABLE.includes(active.status);
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

  /** The session input changes apply to, created from the current selection on the first change. */
  async function ensureSession(): Promise<AssemblySessionView> {
    if (active !== null) return active;
    const created = await window.guyditor.call<AssemblySessionView>("Assembly", "create", {
      assetIds: selectedIds,
    });
    replaceSession(created);
    return created;
  }

  async function editInputs(edit: (session: AssemblySessionView) => Promise<AssemblySessionView>): Promise<void> {
    setBusy(true);
    try {
      replaceSession(await edit(await ensureSession()));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function attach(session: AssemblySessionView, paths: string[]): Promise<AssemblySessionView> {
    const next = await window.guyditor.call<AssemblySessionView>("Assembly", "addFiles", {
      sessionId: session.id,
      paths,
    });
    const notice = unsentNotice(session.inputs.files, next.inputs.files);
    if (notice !== null) setNotice(notice);
    return next;
  }

  async function addPickedFiles(): Promise<void> {
    try {
      const paths = await window.guyditor.call<string[]>("Assembly", "pickContextFiles", {});
      if (paths.length > 0) await editInputs((session) => attach(session, paths));
    } catch (error: unknown) {
      setNotice(errorMessage(error));
    }
  }

  function addTypedPath(): void {
    const path = filePath.trim();
    if (path === "") return;
    void editInputs(async (session) => {
      const next = await attach(session, [path]);
      setFilePath("");
      return next;
    });
  }

  function toggleAsset(assetId: string, checked: boolean): void {
    void editInputs(async (session) => {
      const others = session.inputs.assetIds.filter((id) => id !== assetId);
      const next = await window.guyditor.call<AssemblySessionView>("Assembly", "setAssets", {
        sessionId: session.id,
        assetIds: checked ? [...others, assetId] : others,
      });
      // Remembered locally too, so Start over keeps the selection.
      setDeselected((current) => {
        const kept = new Set(current);
        if (checked) kept.delete(assetId);
        else kept.add(assetId);
        return kept;
      });
      return next;
    });
  }

  async function analyze(): Promise<void> {
    setBusy(true);
    setPending(null);
    try {
      const target = await ensureSession();
      await window.guyditor.call<JobStatus>("Assembly", "prepare", { sessionId: target.id });
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
  const labels = assetLabels(assets, selectedIds, active?.evidence ?? null);
  const files = active?.inputs.files ?? [];
  const canAttach = snapshot !== null && editable && selectedIds.length > 0 && !busy;

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
                    checked={selectedIds.includes(asset.id)}
                    disabled={!editable || busy}
                    data-testid={`assembly-asset-${asset.id}`}
                    onChange={(event) => toggleAsset(asset.id, event.target.checked)}
                  />
                  {" "}<span className="file-label" data-testid={`assembly-asset-label-${asset.id}`}>
                    {labels.get(asset.id)}
                  </span>
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
        <ul className="assembly-files" data-testid="assembly-files">
          {files.map((file) => (
            <li key={file.label} data-testid={`assembly-file-${file.label}`} title={fileRowTitle(file)}>
              <span className="file-label">{file.label}</span>
              <span>{file.name}</span>
              <span>{file.kind}</span>
              <span>{formatBytes(file.bytes)}</span>
              {file.sent ? null : <span>not sent — {file.unsentReason}</span>}
              {editable ? (
                <button
                  type="button"
                  data-testid={`assembly-file-remove-${file.label}`}
                  disabled={busy}
                  aria-label={`Remove ${file.label}`}
                  onClick={() => void editInputs((session) => window.guyditor.call<AssemblySessionView>(
                    "Assembly",
                    "removeFile",
                    { sessionId: session.id, label: file.label },
                  ))}
                >Remove</button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="path-ingest">
          <button
            type="button"
            data-testid="assembly-add-files"
            disabled={!canAttach}
            onClick={() => void addPickedFiles()}
          >Add files…</button>
          <input
            type="text"
            value={filePath}
            placeholder="/path/to/outline.md"
            aria-label="File path"
            data-testid="assembly-file-path"
            disabled={!canAttach}
            onChange={(event) => setFilePath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addTypedPath();
            }}
          />
          <button
            type="button"
            data-testid="assembly-file-path-add"
            disabled={!canAttach || filePath.trim() === ""}
            onClick={addTypedPath}
          >Add</button>
        </div>
        <label>
          Script{" "}
          <select
            data-testid="assembly-script-select"
            value={active === null ? "auto" : scriptValue(active.inputs.script)}
            disabled={snapshot === null || !editable || busy}
            onChange={(event) => {
              const script = scriptChoice(event.target.value);
              void editInputs((session) => window.guyditor.call<AssemblySessionView>(
                "Assembly",
                "setScript",
                { sessionId: session.id, script },
              ));
            }}
          >
            <option value="auto">Auto — first Markdown with quoted lines</option>
            <option value="none">None</option>
            {files.filter(({ kind }) => kind === "text").map(({ label, name }) => (
              <option key={label} value={label}>{label} {name}</option>
            ))}
          </select>
        </label>
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
          Sends the transcript, the conversation and the files you attach to{" "}
          {settings?.provider ?? "your AI provider"}. Never your footage.
        </p>
        <div className="assembly-actions">
          <button
            type="button"
            className="primary-action"
            data-testid="assembly-analyze"
            disabled={snapshot === null || selectedIds.length === 0 || preparing || busy || !editable}
            onClick={() => void analyze()}
          >Analyze footage</button>
          {active !== null ? (
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
