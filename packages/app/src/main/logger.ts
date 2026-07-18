import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LogRecord {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  event: string;
  msg: string;
  data?: Record<string, unknown>;
  jobId?: string;
  sessionId?: string;
  txnId?: string;
  requestId?: string;
}

const SENSITIVE_KEY = /(?:secret|token|password|credential|authorization|api[-_]?key)/iu;

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function scrub(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "«redacted»";
  if (Array.isArray(value)) return value.map((entry) => scrub(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [childKey, scrub(child, childKey)]),
  );
}

export class StructuredLogger {
  readonly #logsDirectory: string;
  readonly #retentionDays: number;
  readonly #now: () => Date;

  public constructor(
    userDirectory: string,
    retentionDays: number,
    now: () => Date = () => new Date(),
  ) {
    this.#logsDirectory = join(userDirectory, "logs");
    this.#retentionDays = retentionDays;
    this.#now = now;
    mkdirSync(this.#logsDirectory, { recursive: true });
    this.prune();
  }

  public write(record: Omit<LogRecord, "ts">): void {
    const now = this.#now();
    const scrubbed = scrub({ ...record, ts: now.toISOString() }) as LogRecord;
    appendFileSync(
      join(this.#logsDirectory, `guyditor-${dateStamp(now)}.jsonl`),
      `${JSON.stringify(scrubbed)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  public prune(): void {
    const cutoff = this.#now().getTime() - this.#retentionDays * 86_400_000;
    for (const name of readdirSync(this.#logsDirectory)) {
      if (!/^guyditor-[0-9]{8}\.jsonl$/u.test(name)) continue;
      const path = join(this.#logsDirectory, name);
      if (statSync(path).mtimeMs < cutoff) rmSync(path);
    }
  }
}
