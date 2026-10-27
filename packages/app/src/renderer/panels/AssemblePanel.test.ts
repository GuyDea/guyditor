import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CandidateSegment, ContextFile } from "../../../../transcript/src/assembly/types.js";
import type { Asset } from "../../../../core/src/index.js";
import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import type {
  AiSettingsView,
  AssemblySessionView,
  ProjectSnapshot,
} from "../../shared/ipc.js";
import { useJobsStore } from "../state/jobs.js";
import { useWorkspaceStore } from "../state/view-state.js";
import {
  activeSession,
  AssemblePanel,
  assetLabels,
  cutRange,
  canSendMessage,
  evidenceSummary,
  fileRowTitle,
  nextSendPayload,
  settingsSummary,
  unsentNotice,
  usageLine,
} from "./AssemblePanel.js";
import { AiSettingsSection } from "./AiSettingsSection.js";
import type { AssemblePanelProps } from "./AssemblePanel.js";

const SETTINGS: AiSettingsView = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: "high",
  tightening: "ask",
  rates: { "claude-opus-5-5": { inputPerMTok: 5, outputPerMTok: 25 } },
  transport: { anthropic: "api", openai: "api" },
  cli: { claudePath: "claude", codexPath: "codex" },
  keys: { anthropic: true, openai: false },
  externalCalls: "ask",
  encryptionAvailable: true,
};

function snapshot(): ProjectSnapshot {
  const master = projectFixture();
  return {
    revision: master.revision,
    master,
    sidecarIndex: master.sidecars,
    projectPath: "/project",
  } as ProjectSnapshot;
}

function session(overrides: Partial<AssemblySessionView> = {}): AssemblySessionView {
  return {
    id: "asb_aaaaaaaaaa",
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    status: "conversing",
    settings: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", tightening: "ask", transport: "api" },
    inputs: { assetIds: ["ast_aaaaaaaaaa"], files: [], script: { mode: "auto" }, nextFileLabel: 1 },
    evidence: {
      sha256: "x",
      tokenEstimate: 10,
      assets: [{
        assetId: "ast_aaaaaaaaaa", ordinal: 1, fileName: "a.mov", capturedAt: "",
        captureSource: "file-mtime", durationMs: 1000, orderWarning: null,
      }],
      segments: [],
      groups: [],
      scriptBlocks: [],
      notes: [],
    },
    messages: [],
    plan: null,
    compiled: null,
    proposalId: null,
    tighteningJobId: null,
    error: null,
    ...overrides,
  } as unknown as AssemblySessionView;
}

function props(overrides: Partial<AssemblePanelProps> = {}): AssemblePanelProps {
  const refresh = vi.fn(() => Promise.resolve());
  return {
    snapshot: snapshot(),
    transcripts: [],
    annotations: [],
    proposals: [],
    skills: [],
    pinnedSkills: [],
    skillDrafts: [],
    restylePlan: null,
    exportReport: null,
    refreshProject: refresh,
    refreshAnnotations: refresh,
    refreshProposals: refresh,
    refreshSkills: refresh,
    refreshRestylePlan: refresh,
    refreshExportReport: refresh,
    setNotice: vi.fn(),
    initialSettings: SETTINGS,
    ...overrides,
  };
}

function file(overrides: Partial<ContextFile> & Pick<ContextFile, "label" | "name" | "kind">): ContextFile {
  return {
    path: `sidecars/context/asb_aaaaaaaaaa/${overrides.label}-${overrides.name}`,
    sha256: "x",
    bytes: 1229,
    mime: "text/markdown",
    sent: true,
    unsentReason: null,
    pages: null,
    role: "context",
    ...overrides,
  };
}

const OUTLINE = file({ label: "F1", name: "outline.md", kind: "text" });
const BUDGET = file({
  label: "F3", name: "budget.xlsx", kind: "other", bytes: 20_480, sent: false, unsentReason: "unsupported type",
});

/** The opening tag of the element carrying `testId`. */
function tag(html: string, testId: string): string {
  return new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`, "u").exec(html)?.[0] ?? "";
}

/** The markup of the list row carrying `testId`, up to its closing `</li>`. */
function row(html: string, testId: string): string {
  return new RegExp(`<li[^>]*data-testid="${testId}"[^>]*>.*?</li>`, "u").exec(html)?.[0] ?? "";
}

function render(overrides: Partial<AssemblePanelProps> = {}): string {
  return renderToStaticMarkup(createElement(AssemblePanel, props(overrides)));
}

beforeEach(() => {
  useWorkspaceStore.getInitialState().railCollapsed.assemble = false;
});

describe("Assemble panel", () => {
  it("renders inputs with the external notice and a disabled analyze button without a project", () => {
    const html = render({ snapshot: null });

    expect(html).toContain('data-testid="assemble-panel"');
    expect(html).toContain("P14");
    expect(html).not.toContain('data-testid="assembly-script-path"');
    expect(html).toContain("anthropic · claude-opus-5-5 · high · tightening: ask");
    expect(html).toMatch(/data-testid="assembly-analyze"[^>]*disabled/u);
    expect(html).not.toContain('data-testid="assembly-abandon"');
  });

  it("lists speech assets with transcript state", () => {
    const withSidecar = snapshot();
    const [first] = withSidecar.master.assets;
    const transcripts = [{ assetId: first!.id }] as AssemblePanelProps["transcripts"];

    const html = render({ snapshot: withSidecar, transcripts });

    expect(html).toContain(`data-testid="assembly-asset-${first!.id}"`);
    expect(html).toContain("✓");
    expect(html).toMatch(/data-testid="assembly-analyze"(?![^>]*disabled)/u);
    expect(render({ snapshot: withSidecar })).toContain("…");
  });

  it("renders question cards with jump and option buttons", () => {
    const html = render({
      initialSessions: [session({
        messages: [{
          role: "assistant",
          content: "{}",
          at: "t1",
          usage: { inputTokens: 100, outputTokens: 20, usd: 0.0123, estimated: true },
          reply: {
            status: "questions",
            summary: "Two takes of the intro.",
            questions: [
              {
                id: "q1",
                about: { assetId: "ast_aaaaaaaaaa", fromWord: "w000001", toWord: "w000004" },
                text: "Which intro take?",
                options: ["First", "Second"],
              },
              { id: "q2", about: null, text: "Keep the aside?", options: null },
            ],
          },
        }],
      })],
    });

    expect(html).toContain('data-testid="assembly-question-0"');
    expect(html).toContain('data-testid="assembly-jump-0"');
    expect(html).toContain('data-testid="assembly-option-0-0"');
    expect(html).toContain('data-testid="assembly-option-0-1"');
    expect(html).toContain('data-testid="assembly-question-1"');
    expect(html).not.toContain('data-testid="assembly-jump-1"');
    expect(html).toContain('data-testid="assembly-abandon"');
    expect(html).toContain("120 tokens · $0.01 (estimated)");
    expect(html).toContain('data-testid="assembly-evidence-summary"');
  });

  it("renders plan rows and the create button", () => {
    const html = render({
      initialSessions: [session({
        status: "planned",
        plan: {
          status: "plan",
          summary: "Plan ready.",
          tightening: null,
          cuts: [{
            scriptBlock: "B1", scriptSentences: null, assetId: "ast_aaaaaaaaaa",
            fromWord: "w000001", toWord: "w000004", reason: "Cleanest take",
          }],
          flags: [{ cutIndex: 0, kind: "stitch", note: "joins mid-sentence" }],
        },
        compiled: [{
          index: 0, assetId: "ast_aaaaaaaaaa",
          in: { frames: 24 * 65, fps: "24/1" }, out: { frames: 24 * 72, fps: "24/1" },
          timelineStart: { frames: 0, fps: "24/1" }, extent: { frames: 168, fps: "24/1" },
          reason: "Cleanest take", flags: [],
        }],
      })],
    });

    expect(html).toContain('data-testid="assembly-plan"');
    expect(html).toContain('data-testid="assembly-cut-0"');
    expect(html).toContain("a.mov");
    expect(html).toContain("01:05–01:12");
    expect(html).toContain("stitch");
    expect(html).toMatch(/data-testid="assembly-create-proposal"(?![^>]*disabled)/u);
  });

  it("offers a link to the proposal once created", () => {
    const html = render({
      initialSessions: [session({
        status: "proposed",
        proposalId: "prp_aaaaaaaaaa",
        plan: { status: "plan", summary: "s", tightening: null, cuts: [], flags: [] },
      })],
    });

    expect(html).toContain('data-testid="assembly-open-proposal"');
    expect(html).not.toContain('data-testid="assembly-create-proposal"');
  });

  it("disables send until there is evidence in a conversing session", () => {
    expect(render()).toMatch(/data-testid="assembly-send"[^>]*disabled/u);
    expect(render({ initialSessions: [session({ status: "created", evidence: null })] }))
      .toMatch(/data-testid="assembly-input"[^>]*disabled/u);
  });

  it("renders file rows with labels, sizes, reasons and remove buttons while created", () => {
    const image = file({ label: "F2", name: "board.png", kind: "image", bytes: 1_153_434, mime: "image/png" });
    const html = render({
      initialSessions: [session({
        status: "created",
        evidence: null,
        inputs: {
          assetIds: ["ast_aaaaaaaaaa"], files: [OUTLINE, image, BUDGET], script: { mode: "auto" }, nextFileLabel: 4,
        },
      })],
    });

    const outline = row(html, "assembly-file-F1");
    for (const text of ["F1", "outline.md", "text", "1.2 KB"]) expect(outline).toContain(text);
    expect(html).toContain('data-testid="assembly-file-remove-F1"');
    expect(tag(html, "assembly-file-F2")).toContain("1,600");
    expect(row(html, "assembly-file-F3")).toContain("not sent — unsupported type");
    const unreasoned = render({
      initialSessions: [session({
        status: "created",
        evidence: null,
        inputs: {
          assetIds: ["ast_aaaaaaaaaa"], files: [{ ...BUDGET, unsentReason: null }], script: { mode: "auto" }, nextFileLabel: 4,
        },
      })],
    });
    expect(row(unreasoned, "assembly-file-F3")).toContain("not sent — not supported");
    for (const id of ["assembly-add-files", "assembly-file-path", "assembly-file-path-add", "assembly-script-select"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    for (const value of ["auto", "none", "F1"]) expect(html).toContain(`value="${value}"`);
    expect(html).toContain("Auto — first Markdown with quoted lines");
    expect(html).toContain("F1 outline.md");
    expect(html).toContain('data-testid="assembly-abandon"');
  });

  it("locks the inputs once analysed", () => {
    const html = render({
      initialSessions: [session({
        inputs: { assetIds: ["ast_aaaaaaaaaa"], files: [OUTLINE], script: { mode: "auto" }, nextFileLabel: 2 },
      })],
    });

    expect(html).toContain('data-testid="assembly-file-F1"');
    expect(html).not.toContain('data-testid="assembly-file-remove-');
    expect(tag(html, "assembly-add-files")).toContain("disabled");
    expect(tag(html, "assembly-file-path")).toContain("disabled");
    expect(tag(html, "assembly-file-path-add")).toContain("disabled");
    expect(tag(html, "assembly-script-select")).toContain("disabled");
    expect(tag(html, "assembly-asset-ast_aaaaaaaaaa")).toContain("disabled");
  });

  it("locks the inputs while a prepare job runs, before the session shows preparing", () => {
    // Static rendering reads the store's initial state (the same seam the rail state uses above).
    const { jobs } = useJobsStore.getInitialState();
    jobs.push({
      jobId: "job_aaaaaaaaaa", kind: "assembly.prepare", state: "running", progress: 0, dependsOn: [],
      title: "Analyze footage for assembly", cancellable: true, createdAt: "2026-10-27T10:00:00.000Z",
    });
    try {
      const html = render({ initialSessions: [session({ status: "created", evidence: null })] });
      expect(tag(html, "assembly-add-files")).toContain("disabled");
      expect(tag(html, "assembly-script-select")).toContain("disabled");
      expect(tag(html, "assembly-asset-ast_aaaaaaaaaa")).toContain("disabled");
    } finally {
      jobs.length = 0;
    }
  });

  it("labels footage in capture order and from the evidence", () => {
    const assets = [
      { id: "ast_aaaaaaaaaa", path: "media/a.mov", captureTime: { value: "2026-10-27T11:00:00.000Z", source: "container" } },
      { id: "ast_bbbbbbbbbb", path: "media/b.mov", captureTime: { value: "2026-10-27T10:00:00.000Z", source: "container" } },
      { id: "ast_cccccccccc", path: "media/c.mov" },
    ] as unknown as Asset[];
    const created = "2026-10-27T12:00:00.000Z";

    expect([...assetLabels(assets, ["ast_aaaaaaaaaa", "ast_bbbbbbbbbb"], null, created)]).toEqual([
      ["ast_aaaaaaaaaa", "A2"], ["ast_bbbbbbbbbb", "A1"], ["ast_cccccccccc", "—"],
    ]);
    // No capture time: the main process orders it by the project's creation time, after the others.
    expect([...assetLabels(assets, ["ast_cccccccccc", "ast_aaaaaaaaaa", "ast_bbbbbbbbbb"], null, created)]).toEqual([
      ["ast_aaaaaaaaaa", "A2"], ["ast_bbbbbbbbbb", "A1"], ["ast_cccccccccc", "A3"],
    ]);
    const evidence = session().evidence!;
    expect(assetLabels(assets, ["ast_aaaaaaaaaa", "ast_bbbbbbbbbb"], {
      ...evidence,
      assets: [{ ...evidence.assets[0]!, assetId: "ast_aaaaaaaaaa", ordinal: 1 }],
    }, created)).toEqual(new Map([["ast_aaaaaaaaaa", "A1"], ["ast_bbbbbbbbbb", "—"], ["ast_cccccccccc", "—"]]));
    expect(render()).toMatch(/data-testid="assembly-asset-label-ast_aaaaaaaaaa"[^>]*>A1</u);
  });

  it("disables the script select while nothing is selected and no session exists", () => {
    const html = renderToStaticMarkup(createElement(AssemblePanel, {
      ...props(),
      snapshot: { ...snapshot(), master: { ...snapshot().master, assets: [] } },
    }));
    expect(tag(html, "assembly-script-select")).toContain("disabled");
    expect(tag(render(), "assembly-script-select")).not.toContain("disabled");
  });

  it("shows the new external notice", () => {
    expect(render()).toContain(
      "Sends the transcript, the conversation and the files you attach to anthropic. Never your footage.",
    );
  });
});

describe("Assemble helpers", () => {
  it("picks the newest non-abandoned session", () => {
    const sessions = [
      session({ id: "asb_bbbbbbbbbb", status: "abandoned" }),
      session({ id: "asb_cccccccccc", status: "planned" }),
      session({ id: "asb_dddddddddd", status: "created" }),
    ];

    expect(activeSession(sessions)?.id).toBe("asb_cccccccccc");
    expect(activeSession([])).toBeNull();
  });

  it("summarises evidence, settings, usage and cut ranges", () => {
    expect(settingsSummary(SETTINGS)).toBe("anthropic · claude-opus-5-5 · high · tightening: ask");
    expect(evidenceSummary(session())).toBe("1 clip · 0 segments · 0 repeat groups · script: no script");
    expect(usageLine(session())).toBeNull();
    expect(cutRange(undefined)).toBe("—");
    const segment = {
      assetId: "ast_aaaaaaaaaa", fromWord: "w000001", toWord: "w000004",
      start: { samples: 48_000 * 5, rate: 48_000 }, end: { samples: 48_000 * 12, rate: 48_000 },
    } as unknown as CandidateSegment;
    expect(cutRange(undefined, { assetId: "ast_aaaaaaaaaa", fromWord: "w000001", toWord: "w000004" } as never, [segment]))
      .toBe("00:05–00:12");
  });
});

describe("AI settings section", () => {
  function renderSettings(settings: AiSettingsView, initialCliStatus?: string): string {
    return renderToStaticMarkup(createElement(AiSettingsSection, {
      settings,
      onSettings: vi.fn(),
      setNotice: vi.fn(),
      initialModels: ["claude-opus-5-5"],
      ...(initialCliStatus === undefined ? {} : { initialCliStatus }),
    }));
  }

  it("renders provider, model, effort, tightening, key and rate controls", () => {
    const html = renderSettings(SETTINGS);

    for (const id of [
      "ai-provider-anthropic", "ai-provider-openai", "ai-model", "ai-effort",
      "ai-tightening", "ai-key", "ai-key-save", "ai-key-clear", "ai-key-status",
      "ai-rate-claude-opus-5-5",
    ]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain("Key saved ✓");
    expect(html).not.toContain("Keys will not persist");
  });

  it("shows the key field for API and the CLI path and Check for local CLI", () => {
    const api = renderSettings(SETTINGS);
    expect(tag(api, "ai-transport-api")).toContain("checked");
    expect(api).toContain('data-testid="ai-key"');
    expect(api).not.toContain('data-testid="ai-cli-path"');

    const cli = renderSettings(
      { ...SETTINGS, transport: { anthropic: "cli", openai: "api" } },
      "claude 2.1.309 (Claude Code) ✓",
    );
    expect(tag(cli, "ai-transport-cli")).toContain("checked");
    expect(cli).toContain("local CLI (claude)");
    expect(tag(cli, "ai-cli-path")).toContain('value="claude"');
    expect(cli).toContain('data-testid="ai-cli-check"');
    expect(cli).not.toContain('data-testid="ai-key"');
    expect(cli).toMatch(/data-testid="ai-cli-status"[^>]*>claude 2\.1\.309 \(Claude Code\) ✓</u);
  });

  it("shows the no-key and unencrypted-storage states", () => {
    const html = renderSettings({
      ...SETTINGS,
      keys: { anthropic: false, openai: false },
      encryptionAvailable: false,
    });

    expect(html).toContain("No key");
    expect(html).toContain("Keys will not persist across restarts on this system.");
  });
});

describe("send result handling", () => {
  const base = { sessionId: "asb_aaaaaaaaaa", text: "hello" };

  it("turns the confirm-cost result into a resend carrying the token", () => {
    const next = nextSendPayload(base, {
      kind: "confirm-cost", message: "m", confirmToken: "tok", estimatedUsd: 1, estimated: true,
    });
    expect(next).toEqual({ payload: { ...base, confirmToken: "tok" }, notice: null });
  });

  it("turns acknowledge-external into a resend with the flag", () => {
    const next = nextSendPayload(base, { kind: "acknowledge-external", provider: "anthropic", notice: "n" });
    expect(next).toEqual({ payload: { ...base, acknowledgeExternal: true }, notice: null });
  });

  it("surfaces blocked as a message with no resend, and a turn as nothing", () => {
    expect(nextSendPayload(base, { kind: "blocked", message: "No external calls." }))
      .toEqual({ payload: null, notice: "No external calls." });
    expect(nextSendPayload(base, { kind: "turn", session: session() }))
      .toEqual({ payload: null, notice: null });
  });

  it("keeps both the token and the flag when confirm-cost is followed by acknowledge-external", () => {
    const first = nextSendPayload(base, {
      kind: "confirm-cost", message: "m", confirmToken: "tok", estimatedUsd: 1, estimated: false,
    }).payload!;
    const second = nextSendPayload(first, {
      kind: "acknowledge-external", provider: "openai", notice: "n",
    }).payload;
    expect(second).toEqual({ ...base, confirmToken: "tok", acknowledgeExternal: true });
  });

  it("gates the Enter-key send on a conversing or planned session with evidence, idle, and text", () => {
    const ready = { status: "conversing" as const, hasEvidence: true, busy: false, pending: false, text: "hi" };
    expect(canSendMessage(ready)).toBe(true);
    expect(canSendMessage({ ...ready, text: "  " })).toBe(false);
    expect(canSendMessage({ ...ready, busy: true })).toBe(false);
    expect(canSendMessage({ ...ready, pending: true })).toBe(false);
    expect(canSendMessage({ ...ready, hasEvidence: false })).toBe(false);
    expect(canSendMessage({ ...ready, status: "planned" })).toBe(true);
    expect(canSendMessage({ ...ready, status: "proposed" })).toBe(false);
    expect(canSendMessage({ ...ready, status: undefined })).toBe(false);
  });
});

describe("assembly inputs helpers", () => {
  function turn(usd: number): AssemblySessionView["messages"][number] {
    return { role: "assistant", content: "{}", at: "t", reply: null, usage: { inputTokens: 100, outputTokens: 20, usd, estimated: false } };
  }
  const cli = session().settings;

  it("usage line for cli turns", () => {
    const claude = session({ settings: { ...cli, transport: "cli" }, messages: [turn(0)] });
    expect(usageLine(claude)).toBe("via claude (no cost reported)");
    const codex = session({ settings: { ...cli, provider: "openai", transport: "cli" }, messages: [turn(0)] });
    expect(usageLine(codex)).toBe("via codex (no cost reported)");
    const reported = session({ settings: { ...cli, transport: "cli" }, messages: [turn(0.42)] });
    expect(usageLine(reported)).toBe("120 tokens · $0.42");
  });

  it("summarises the script by label", () => {
    const evidence = session().evidence!;
    const blocks = Array.from({ length: 12 }, (_, n) => ({ id: `B${String(n + 1)}`, section: "", text: "", sentences: [] }));
    const scripted = session({
      inputs: { assetIds: ["ast_aaaaaaaaaa"], files: [{ ...OUTLINE, role: "script" }], script: { mode: "auto" }, nextFileLabel: 2 },
      evidence: { ...evidence, scriptBlocks: blocks },
    });
    expect(evidenceSummary(scripted)).toContain("script: F1 (12 blocks)");
    expect(evidenceSummary(session())).toContain("no script");
  });

  it("notices files that will not be sent at attach time", () => {
    expect(unsentNotice([OUTLINE], [OUTLINE, BUDGET])).toBe("F3 budget.xlsx: not sent — unsupported type");
    expect(unsentNotice([OUTLINE, BUDGET], [OUTLINE, BUDGET])).toBeNull();
    expect(unsentNotice([], [OUTLINE])).toBeNull();
    expect(unsentNotice([], [{ ...BUDGET, unsentReason: null }])).toBe("F3 budget.xlsx: not sent — not supported");
  });

  it("explains how images and PDFs are counted in the estimate", () => {
    expect(fileRowTitle(file({ label: "F2", name: "board.png", kind: "image" })))
      .toBe("Counted as 1,600 input tokens in the cost estimate");
    expect(fileRowTitle(file({ label: "F4", name: "deck.pdf", kind: "pdf", pages: 3 })))
      .toBe("Counted as 2,000 input tokens per page (3 pages)");
    expect(fileRowTitle(file({ label: "F5", name: "scan.pdf", kind: "pdf", pages: null })))
      .toBe("Counted as 2,000 input tokens per page");
    expect(fileRowTitle(OUTLINE)).toBeUndefined();
  });
});
