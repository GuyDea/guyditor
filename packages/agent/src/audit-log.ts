import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuditSink, AuditSinkEvent } from "../../core/src/index.js";
import type {
  AuditPruneOptions,
  AuditPruneResult,
  AuditRecord,
  AuditRecordDraft,
  AuditReplay,
  AuditReplayWarning,
  AuditRetention,
  DataClass,
} from "./audit-types.js";

const DEFAULT_RETENTION_DAYS = 365;
const SESSION_ID = /^ses_[a-z2-7]{10}$/;
const DATA_CLASSES = new Set<DataClass>([
  "metadata",
  "prompt",
  "transcript",
  "frames",
  "audio",
  "video",
]);
const REDACTED = "«redacted»";

export interface AuditLogOptions {
  userDir?: string;
  retention?: Partial<AuditRetention>;
  now?: () => Date;
  credentialValues?: () => readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isNumber(value);
}

function isInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value);
}

function isOneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}

function isDataClasses(value: unknown): value is DataClass[] {
  return Array.isArray(value) && value.every((entry) =>
    typeof entry === "string" && DATA_CLASSES.has(entry as DataClass),
  );
}

function isOptionalDataClasses(value: unknown): boolean {
  return value === undefined || isDataClasses(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasBase(value: Record<string, unknown>): boolean {
  return isIsoTimestamp(value["ts"]) &&
    typeof value["sessionId"] === "string" && SESSION_ID.test(value["sessionId"]) &&
    isInteger(value["seq"]) && value["seq"] > 0 &&
    typeof value["projectId"] === "string" && value["projectId"].length > 0 &&
    typeof value["type"] === "string";
}

function isDirector(value: unknown): boolean {
  return isRecord(value) && isString(value["profileId"]) && isString(value["modelLabel"]) &&
    isOneOf(value["locality"], ["local", "remote"]);
}

function isPayloadSummary(value: unknown): boolean {
  return isRecord(value) && isOptionalNumber(value["frames"]) &&
    isOptionalNumber(value["transcriptWords"]) && isOptionalNumber(value["videoSeconds"]) &&
    isOptionalNumber(value["audioSeconds"]) && isOptionalNumber(value["promptChars"]);
}

function isUnits(value: unknown): boolean {
  return isRecord(value) && isOptionalNumber(value["inputTokens"]) &&
    isOptionalNumber(value["outputTokens"]) && isOptionalNumber(value["images"]) &&
    isOptionalNumber(value["seconds"]);
}

function isCost(value: unknown): boolean {
  return isRecord(value) && isNumber(value["estimated"]) && isOptionalNumber(value["actual"]);
}

function isTotals(value: unknown): boolean {
  return isRecord(value) && isNumber(value["taskUsd"]) && isNumber(value["episodeUsd"]) &&
    isNumber(value["cumulativeUsd"]);
}

function parsedAuditRecord(value: unknown): AuditRecord | undefined {
  if (!isRecord(value) || !hasBase(value)) return undefined;
  switch (value["type"]) {
    case "session.start":
    case "session.end":
      if (!isDirector(value["director"]) ||
        (value["policySnapshot"] !== undefined && !isRecord(value["policySnapshot"]))) return undefined;
      break;
    case "instruction":
      if (!isOneOf(value["source"], ["creator", "annotation"]) || !isString(value["text"]) ||
        !isOptionalString(value["annotationId"])) return undefined;
      break;
    case "tool.call":
    case "tool.result":
      if (!isString(value["tool"]) || !isString(value["callId"]) ||
        !isRecord(value["paramsDigest"]) ||
        (value["ok"] !== undefined && typeof value["ok"] !== "boolean") ||
        !isOptionalString(value["errorCode"]) ||
        !isOptionalDataClasses(value["dataClassesReturned"]) ||
        !isOptionalNumber(value["durationMs"])) return undefined;
      break;
    case "proposal.created":
    case "proposal.outcome":
      if (!isString(value["proposalId"]) || !isOptionalNumber(value["opCount"]) ||
        (value["riskClass"] !== undefined &&
          !isOneOf(value["riskClass"], ["low", "normal", "consequential"])) ||
        (value["outcome"] !== undefined &&
          !isOneOf(value["outcome"], ["accepted", "rejected", "withdrawn", "auto_accepted"])) ||
        !isOptionalString(value["transactionId"]) || !isOptionalString(value["revision"]) ||
        !isOptionalString(value["creatorFeedback"])) return undefined;
      break;
    case "external.call":
      if (!isString(value["adapterId"]) || !isString(value["provider"]) ||
        !isString(value["purpose"]) || !isDataClasses(value["dataClassesSent"]) ||
        !isPayloadSummary(value["payloadSummary"]) || !isUnits(value["units"]) ||
        !isCost(value["costUsd"]) || !isOneOf(value["outcome"], ["ok", "error", "cancelled"]) ||
        !isNumber(value["durationMs"])) return undefined;
      break;
    case "cost.charge":
      if (!isInteger(value["externalCallSeq"]) || value["externalCallSeq"] < 1 ||
        !isNumber(value["costUsd"]) || !isTotals(value["totals"])) return undefined;
      break;
    case "policy.autoaccept":
      if (!isString(value["proposalId"]) || !isString(value["transactionId"]) ||
        !isRecord(value["matchedPolicy"])) return undefined;
      break;
    case "budget.event":
      if (!isOneOf(value["level"], ["task", "episode", "cumulative"]) ||
        !isOneOf(value["kind"], ["warn", "cap_block", "creator_override"]) ||
        !isNumber(value["thresholdUsd"]) || !isNumber(value["projectedUsd"])) return undefined;
      break;
    case "template.author.submitted":
    case "template.author.reviewed":
      if (!isString(value["submissionId"]) || !isString(value["templateId"]) ||
        !isString(value["model"]) ||
        !isOneOf(value["status"], [
          "awaiting_review", "changes_requested", "rejected", "superseded", "published",
        ]) ||
        (value["decision"] !== undefined &&
          !isOneOf(value["decision"], ["approve", "reject", "request_changes"])) ||
        !isOptionalString(value["reason"]) || !isOptionalString(value["contentHash"])) {
        return undefined;
      }
      break;
    default:
      return undefined;
  }
  return value as unknown as AuditRecord;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortedJsonValue(child)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

function scrubString(value: string, credentialValues: readonly string[]): string {
  let scrubbed = value;
  for (const credential of [...credentialValues].filter((entry) => entry.length > 0)
    .sort((left, right) => right.length - left.length)) {
    scrubbed = scrubbed.split(credential).join(REDACTED);
  }
  return scrubbed
    .replace(/Bearer\s+[^\s,;]+/giu, REDACTED)
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, REDACTED)
    .replace(/AKIA[0-9A-Z]{16}/gu, REDACTED);
}

function scrubValue(value: unknown, credentialValues: readonly string[]): unknown {
  if (typeof value === "string") return scrubString(value, credentialValues);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, credentialValues));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    scrubValue(child, credentialValues),
  ]));
}

function retentionConfig(retention: Partial<AuditRetention> | undefined): AuditRetention {
  const retentionDays = retention?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxSessions = retention?.maxSessions;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError("Audit retentionDays must be a non-negative number.");
  }
  if (maxSessions !== undefined && (!Number.isInteger(maxSessions) || maxSessions < 0)) {
    throw new RangeError("Audit maxSessions must be a non-negative integer.");
  }
  return maxSessions === undefined ? { retentionDays } : { retentionDays, maxSessions };
}

function readWarning(sessionId: string, error: unknown): AuditReplayWarning {
  return {
    code: "read_error",
    sessionId,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

export class AuditLog implements AuditSink {
  readonly #userDir: string;
  readonly #retention: AuditRetention;
  readonly #now: () => Date;
  readonly #credentialValues: () => readonly string[];
  readonly #nextSequences = new Map<string, number>();
  readonly #activeSessions = new Set<string>();

  public constructor(options: AuditLogOptions = {}) {
    this.#userDir = options.userDir ?? join(homedir(), ".guyditor");
    this.#retention = retentionConfig(options.retention);
    this.#now = options.now ?? (() => new Date());
    this.#credentialValues = options.credentialValues ?? (() => []);
  }

  public get userDir(): string {
    return this.#userDir;
  }

  public append(draft: AuditRecordDraft): AuditRecord {
    this.#assertSessionId(draft.sessionId);
    const seq = this.#nextSequence(draft.sessionId);
    const candidate = scrubValue({ ...draft, seq, ts: this.#now().toISOString() }, this.#credentialValues());
    const record = parsedAuditRecord(candidate);
    if (record === undefined) throw new TypeError(`Invalid ${draft.type} audit record.`);
    const directory = join(this.#userDir, "audit");
    mkdirSync(directory, { recursive: true });
    appendFileSync(this.#sessionPath(draft.sessionId), `${canonicalJson(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.#nextSequences.set(draft.sessionId, seq + 1);
    return record;
  }

  public readSession(sessionId: string): AuditReplay {
    this.#assertSessionId(sessionId);
    let text: string;
    try {
      text = readFileSync(this.#sessionPath(sessionId), "utf8");
    } catch (error: unknown) {
      return isNotFound(error)
        ? { records: [], warnings: [] }
        : { records: [], warnings: [readWarning(sessionId, error)] };
    }
    const records: AuditRecord[] = [];
    const warnings: AuditReplayWarning[] = [];
    let previousSequence = 0;
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error: unknown) {
        warnings.push({
          code: "invalid_json",
          sessionId,
          line: index + 1,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const record = parsedAuditRecord(parsed);
      if (record === undefined || record.sessionId !== sessionId) {
        warnings.push({
          code: "invalid_record",
          sessionId,
          line: index + 1,
          message: "Line is not a valid audit record for this session.",
        });
        continue;
      }
      if (record.seq <= previousSequence) {
        warnings.push({
          code: "non_monotonic_sequence",
          sessionId,
          line: index + 1,
          message: `Sequence ${String(record.seq)} follows ${String(previousSequence)}.`,
        });
      }
      previousSequence = Math.max(previousSequence, record.seq);
      records.push(record);
    }
    return { records, warnings };
  }

  public prune(options: AuditPruneOptions = {}): AuditPruneResult {
    const protectedSessions = new Set([
      ...this.#activeSessions,
      ...(options.currentSessionIds ?? []),
    ]);
    for (const sessionId of protectedSessions) this.#assertSessionId(sessionId);
    const directory = join(this.#userDir, "audit");
    let entries: Array<{ sessionId: string; mtimeMs: number }>;
    try {
      entries = readdirSync(directory)
        .filter((name) => /^ses_[a-z2-7]{10}\.jsonl$/.test(name))
        .map((name) => ({
          sessionId: name.slice(0, -".jsonl".length),
          mtimeMs: statSync(join(directory, name)).mtimeMs,
        }))
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
    } catch (error: unknown) {
      if (isNotFound(error)) return { deletedSessionIds: [], keptSessionIds: [] };
      throw error;
    }

    const deleted = new Set<string>();
    const cutoff = this.#now().getTime() - this.#retention.retentionDays * 24 * 60 * 60 * 1_000;
    for (const entry of entries) {
      if (entry.mtimeMs < cutoff && !protectedSessions.has(entry.sessionId)) {
        this.#deleteSession(entry.sessionId);
        deleted.add(entry.sessionId);
      }
    }
    const maxSessions = this.#retention.maxSessions;
    if (maxSessions !== undefined) {
      const retained = entries.filter(({ sessionId }) => !deleted.has(sessionId));
      while (retained.length > maxSessions) {
        const index = retained.findIndex(({ sessionId }) => !protectedSessions.has(sessionId));
        if (index === -1) break;
        const [entry] = retained.splice(index, 1);
        if (entry !== undefined) {
          this.#deleteSession(entry.sessionId);
          deleted.add(entry.sessionId);
        }
      }
    }
    return {
      deletedSessionIds: [...deleted],
      keptSessionIds: entries.map(({ sessionId }) => sessionId)
        .filter((sessionId) => !deleted.has(sessionId)),
    };
  }

  public setSessionActive(sessionId: string, active: boolean): void {
    this.#assertSessionId(sessionId);
    if (active) this.#activeSessions.add(sessionId);
    else this.#activeSessions.delete(sessionId);
  }

  public record(event: AuditSinkEvent): void {
    if (event.sessionId === undefined) return;
    if (event.type === "operation.committed") {
      this.append({
        type: "tool.result",
        sessionId: event.sessionId,
        projectId: event.projectId,
        tool: "operation.commit",
        callId: event.transactionId,
        paramsDigest: {
          operationCount: event.operationCount,
          origin: event.origin,
          revision: event.revision,
          ...(event.proposalId === undefined ? {} : { proposalId: event.proposalId }),
        },
        ok: true,
        durationMs: 0,
      });
      return;
    }
    if (event.type === "proposal.created") {
      this.append({
        type: "proposal.created",
        sessionId: event.sessionId,
        projectId: event.projectId,
        proposalId: event.proposalId,
        opCount: event.opCount,
        riskClass: event.riskClass,
      });
      return;
    }
    this.append({
      type: "proposal.outcome",
      sessionId: event.sessionId,
      projectId: event.projectId,
      proposalId: event.proposalId,
      outcome: event.outcome,
      ...(event.transactionId === undefined ? {} : { transactionId: event.transactionId }),
      ...(event.revision === undefined ? {} : { revision: event.revision }),
    });
  }

  #nextSequence(sessionId: string): number {
    const known = this.#nextSequences.get(sessionId);
    if (known !== undefined) return known;
    const maximum = this.readSession(sessionId).records.reduce(
      (current, record) => Math.max(current, record.seq),
      0,
    );
    return maximum + 1;
  }

  #deleteSession(sessionId: string): void {
    rmSync(this.#sessionPath(sessionId));
    this.#nextSequences.delete(sessionId);
  }

  #sessionPath(sessionId: string): string {
    return join(this.#userDir, "audit", `${sessionId}.jsonl`);
  }

  #assertSessionId(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) throw new TypeError(`Invalid audit session ID ${sessionId}.`);
  }
}
