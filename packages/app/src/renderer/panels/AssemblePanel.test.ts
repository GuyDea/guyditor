import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CandidateSegment } from "../../../../transcript/src/assembly/types.js";
import { projectFixture } from "../../../../core/src/project/test-fixtures.js";
import type {
  AiSettingsView,
  AssemblySessionView,
  ProjectSnapshot,
} from "../../shared/ipc.js";
import { useWorkspaceStore } from "../state/view-state.js";
import {
  activeSession,
  AssemblePanel,
  cutRange,
  evidenceSummary,
  settingsSummary,
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
    settings: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", tightening: "ask" },
    inputs: { assetIds: ["ast_aaaaaaaaaa"], script: null },
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
    expect(html).toContain('data-testid="assembly-script-path"');
    expect(html).toContain("anthropic · claude-opus-5-5 · high · tightening: ask");
    expect(html).toContain("Sends the transcript and script text to anthropic. Never audio or video.");
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
      assetId: "ast_a", fromWord: "w1", toWord: "w4",
      start: { samples: 48_000 * 5, rate: 48_000 }, end: { samples: 48_000 * 12, rate: 48_000 },
    } as unknown as CandidateSegment;
    expect(cutRange(undefined, { assetId: "ast_a", fromWord: "w1", toWord: "w4" } as never, [segment]))
      .toBe("00:05–00:12");
  });
});

describe("AI settings section", () => {
  function renderSettings(settings: AiSettingsView): string {
    return renderToStaticMarkup(createElement(AiSettingsSection, {
      settings,
      onSettings: vi.fn(),
      setNotice: vi.fn(),
      initialModels: ["claude-opus-5-5"],
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
