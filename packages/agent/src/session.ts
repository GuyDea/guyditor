import { randomBytes } from "node:crypto";

import type { SessionRecord } from "./audit-types.js";
import type { AuditLog } from "./audit-log.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const SESSION_PREFIX = "ses";

export interface GatewaySession {
  sessionId: string;
  projectId: string;
  director: SessionRecord["director"];
  startedAt: string;
  policySnapshot: object;
}

export interface OpenSessionInput {
  projectId: string;
  director: SessionRecord["director"];
  policySnapshot: object;
}

export interface SessionManagerOptions {
  now?: () => Date;
  idFactory?: () => string;
}

function sessionId(): string {
  const bytes = randomBytes(10);
  let body = "";
  for (const byte of bytes) body += BASE32[byte & 31];
  return `${SESSION_PREFIX}_${body}`;
}

export class SessionManager {
  readonly #audit: AuditLog;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #sessions = new Map<string, GatewaySession>();

  public constructor(audit: AuditLog, options: SessionManagerOptions = {}) {
    this.#audit = audit;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? sessionId;
  }

  public open(input: OpenSessionInput): GatewaySession {
    const id = this.#idFactory();
    if (!/^ses_[a-z2-7]{10}$/.test(id)) throw new TypeError(`Invalid session ID ${id}.`);
    if (this.#sessions.has(id)) throw new Error(`Session ${id} is already open.`);
    const session: GatewaySession = {
      sessionId: id,
      projectId: input.projectId,
      director: structuredClone(input.director),
      startedAt: this.#now().toISOString(),
      policySnapshot: structuredClone(input.policySnapshot),
    };
    this.#audit.append({
      type: "session.start",
      sessionId: session.sessionId,
      projectId: session.projectId,
      director: session.director,
      policySnapshot: session.policySnapshot,
    });
    this.#audit.setSessionActive(id, true);
    this.#sessions.set(id, session);
    return structuredClone(session);
  }

  public close(sessionIdToClose: string): GatewaySession {
    const session = this.#sessions.get(sessionIdToClose);
    if (session === undefined) throw new Error(`Session ${sessionIdToClose} is not open.`);
    this.#audit.append({
      type: "session.end",
      sessionId: session.sessionId,
      projectId: session.projectId,
      director: session.director,
    });
    this.#sessions.delete(sessionIdToClose);
    this.#audit.setSessionActive(sessionIdToClose, false);
    return structuredClone(session);
  }

  public get(sessionIdToRead: string): GatewaySession | undefined {
    const session = this.#sessions.get(sessionIdToRead);
    return session === undefined ? undefined : structuredClone(session);
  }

  public currentSessionIds(): string[] {
    return [...this.#sessions.keys()];
  }
}
