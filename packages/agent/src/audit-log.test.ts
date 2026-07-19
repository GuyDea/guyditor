import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditLog } from "./index.js";
import type { AuditRecordDraft } from "./index.js";

const directories: string[] = [];
const NOW = new Date("2026-07-19T10:00:00.000Z");
const PROJECT_ID = "prj_aaaaaaaaaa";
const SESSION_ID = "ses_aaaaaaaaaa";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function userDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guyditor-audit-"));
  directories.push(directory);
  return directory;
}

function sessionPath(userDir: string, sessionId = SESSION_ID): string {
  return join(userDir, "audit", `${sessionId}.jsonl`);
}

function instruction(sessionId = SESSION_ID): AuditRecordDraft {
  return {
    type: "instruction",
    sessionId,
    projectId: PROJECT_ID,
    source: "creator",
    text: "Tighten the ending.",
  };
}

describe("AuditLog", () => {
  it("round-trips every audit record schema kind with monotonic envelopes", () => {
    const userDir = userDirectory();
    const audit = new AuditLog({ userDir, now: () => NOW });
    const drafts: AuditRecordDraft[] = [
      {
        type: "session.start",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        director: {
          profileId: "adp_aaaaaaaaaa",
          modelLabel: "director-test",
          locality: "local",
        },
        policySnapshot: { automation: { enabled: false } },
      },
      instruction(),
      {
        type: "tool.call",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        tool: "proposal_create",
        callId: "call-1",
        paramsDigest: { opCount: 1 },
      },
      {
        type: "tool.result",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        tool: "proposal_create",
        callId: "call-1",
        paramsDigest: { proposalId: "prp_aaaaaaaaaa" },
        ok: true,
        dataClassesReturned: ["metadata"],
        durationMs: 7,
      },
      {
        type: "proposal.created",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        proposalId: "prp_aaaaaaaaaa",
        opCount: 1,
        riskClass: "normal",
      },
      {
        type: "proposal.outcome",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        proposalId: "prp_aaaaaaaaaa",
        outcome: "accepted",
        transactionId: "txn_aaaaaaaaaa",
        revision: "rev_00002",
        creatorFeedback: "Approved.",
      },
      {
        type: "external.call",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        adapterId: "adp_aaaaaaaaaa",
        provider: "provider-test",
        purpose: "critic_request",
        dataClassesSent: ["metadata", "prompt", "transcript", "frames", "audio", "video"],
        payloadSummary: {
          frames: 2,
          transcriptWords: 80,
          videoSeconds: 3,
          audioSeconds: 4,
          promptChars: 120,
        },
        units: { inputTokens: 100, outputTokens: 20, images: 2, seconds: 4 },
        costUsd: { estimated: 0.1, actual: 0.08 },
        outcome: "ok",
        durationMs: 125,
      },
      {
        type: "cost.charge",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        externalCallSeq: 7,
        costUsd: 0.08,
        totals: { taskUsd: 0.08, episodeUsd: 0.08, cumulativeUsd: 0.08 },
      },
      {
        type: "policy.autoaccept",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        proposalId: "prp_bbbbbbbbbb",
        transactionId: "txn_bbbbbbbbbb",
        matchedPolicy: { maxRisk: "low" },
      },
      {
        type: "budget.event",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        level: "task",
        kind: "warn",
        thresholdUsd: 1,
        projectedUsd: 1.25,
      },
      {
        type: "session.end",
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        director: {
          profileId: "adp_aaaaaaaaaa",
          modelLabel: "director-test",
          locality: "local",
        },
      },
    ];

    const written = drafts.map((draft) => audit.append(draft));
    const replay = audit.readSession(SESSION_ID);

    expect(replay.warnings).toEqual([]);
    expect(replay.records).toEqual(written);
    expect(replay.records.map(({ type }) => type)).toEqual(drafts.map(({ type }) => type));
    expect(replay.records.map(({ seq }) => seq)).toEqual(
      Array.from({ length: drafts.length }, (_, index) => index + 1),
    );
    expect(replay.records.every(({ ts }) => ts === NOW.toISOString())).toBe(true);
  });

  it("appends canonical lines and returns structured warnings for corrupt lines", () => {
    const userDir = userDirectory();
    const audit = new AuditLog({ userDir, now: () => NOW });
    audit.append(instruction());
    const firstBytes = readFileSync(sessionPath(userDir));

    audit.append({
      type: "tool.call",
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      tool: "project_summary",
      callId: "call-2",
      paramsDigest: { z: 2, a: { y: 1, b: 0 } },
    });
    const afterAppend = readFileSync(sessionPath(userDir));
    expect(afterAppend.subarray(0, firstBytes.length).equals(firstBytes)).toBe(true);
    expect(afterAppend.toString("utf8").split("\n")[1]).toBe(
      "{\"callId\":\"call-2\",\"paramsDigest\":{\"a\":{\"b\":0,\"y\":1},\"z\":2}," +
      "\"projectId\":\"prj_aaaaaaaaaa\",\"seq\":2,\"sessionId\":\"ses_aaaaaaaaaa\"," +
      "\"tool\":\"project_summary\",\"ts\":\"2026-07-19T10:00:00.000Z\",\"type\":\"tool.call\"}",
    );

    appendFileSync(sessionPath(userDir), "{not-json}\n", "utf8");
    appendFileSync(sessionPath(userDir), "{\"type\":\"instruction\"}\n", "utf8");
    const replay = audit.readSession(SESSION_ID);

    expect(replay.records).toHaveLength(2);
    expect(replay.warnings).toEqual([
      expect.objectContaining({ code: "invalid_json", line: 3, sessionId: SESSION_ID }),
      expect.objectContaining({ code: "invalid_record", line: 4, sessionId: SESSION_ID }),
    ]);
  });

  it("prunes by age and count while protecting current sessions", () => {
    const userDir = userDirectory();
    const audit = new AuditLog({
      userDir,
      now: () => NOW,
      retention: { retentionDays: 10, maxSessions: 2 },
    });
    const sessions = {
      current: "ses_aaaaaaaaaa",
      expired: "ses_bbbbbbbbbb",
      first: "ses_cccccccccc",
      second: "ses_dddddddddd",
      newest: "ses_eeeeeeeeee",
    } as const;
    for (const sessionId of Object.values(sessions)) audit.append(instruction(sessionId));
    const age = (sessionId: string, days: number): void => {
      const date = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
      utimesSync(sessionPath(userDir, sessionId), date, date);
    };
    age(sessions.current, 20);
    age(sessions.expired, 20);
    age(sessions.first, 3);
    age(sessions.second, 2);
    age(sessions.newest, 1);

    const result = audit.prune({ currentSessionIds: [sessions.current] });

    expect(result.deletedSessionIds.sort()).toEqual([
      sessions.expired,
      sessions.first,
      sessions.second,
    ].sort());
    expect(existsSync(sessionPath(userDir, sessions.current))).toBe(true);
    expect(existsSync(sessionPath(userDir, sessions.newest))).toBe(true);
  });
});
