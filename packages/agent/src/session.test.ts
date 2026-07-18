import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditLog, SessionManager } from "./index.js";

const directories: string[] = [];
const NOW = new Date("2026-07-19T12:00:00.000Z");

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SessionManager", () => {
  it("opens and closes a session lifecycle through the audit log", () => {
    const userDir = mkdtempSync(join(tmpdir(), "guyditor-session-"));
    directories.push(userDir);
    const audit = new AuditLog({ userDir, now: () => NOW });
    const sessions = new SessionManager(audit, {
      now: () => NOW,
      idFactory: () => "ses_aaaaaaaaaa",
    });

    const session = sessions.open({
      projectId: "prj_aaaaaaaaaa",
      director: {
        profileId: "adp_aaaaaaaaaa",
        modelLabel: "director-test",
        locality: "remote",
      },
      policySnapshot: { automation: { enabled: false }, boundaries: { killSwitch: false } },
    });
    const closed = sessions.close(session.sessionId);
    const replay = audit.readSession(session.sessionId);

    expect(session).toEqual({
      sessionId: "ses_aaaaaaaaaa",
      projectId: "prj_aaaaaaaaaa",
      director: {
        profileId: "adp_aaaaaaaaaa",
        modelLabel: "director-test",
        locality: "remote",
      },
      startedAt: NOW.toISOString(),
      policySnapshot: { automation: { enabled: false }, boundaries: { killSwitch: false } },
    });
    expect(closed).toEqual(session);
    expect(replay.records.map(({ type }) => type)).toEqual(["session.start", "session.end"]);
    expect(sessions.get(session.sessionId)).toBeUndefined();
  });
});
