import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AuditLog } from "./audit-log.js";
import type {
  CostChargeRecord,
  DataClass,
  ExternalCallRecord,
} from "./audit-types.js";

const COST_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS cost_records (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  external_call_seq INTEGER NOT NULL CHECK(external_call_seq > 0),
  adapter_id TEXT NOT NULL,
  estimated_usd REAL NOT NULL CHECK(estimated_usd >= 0.0),
  actual_usd REAL NOT NULL CHECK(actual_usd >= 0.0),
  recorded_at TEXT NOT NULL,
  UNIQUE(session_id, external_call_seq)
) STRICT;
CREATE INDEX IF NOT EXISTS cost_records_task ON cost_records(project_id, task_id);
CREATE INDEX IF NOT EXISTS cost_records_project ON cost_records(project_id);
`;

export interface CostEstimate {
  adapterId: string;
  currency: string;
  amount: number;
  units: object;
  confidence: "quote" | "pricebook" | "heuristic";
}

export interface BudgetThreshold {
  warnUsd: number | null;
  capUsd: number | null;
}

export interface BudgetConfig {
  task: BudgetThreshold;
  episode: BudgetThreshold;
  cumulative: BudgetThreshold;
}

export const DEFAULT_BUDGETS: BudgetConfig = {
  task: { warnUsd: 1, capUsd: 5 },
  episode: { warnUsd: 25, capUsd: null },
  cumulative: { warnUsd: 100, capUsd: null },
};

export interface CostContext {
  sessionId: string;
  projectId: string;
  taskId: string;
  initiator: "creator" | "agent";
}

export type Preflight =
  | { verdict: "proceed" }
  | {
      verdict: "warn";
      level: "task" | "episode" | "cumulative";
      message: string;
      confirmToken: string;
    }
  | {
      verdict: "blocked";
      level: "task" | "episode" | "cumulative";
      message: string;
    };

export interface ExternalCallActual {
  context: CostContext;
  estimate: CostEstimate;
  provider: string;
  purpose: string;
  dataClassesSent: DataClass[];
  payloadSummary: ExternalCallRecord["payloadSummary"];
  units: ExternalCallRecord["units"];
  actualUsd: number;
  outcome: ExternalCallRecord["outcome"];
  durationMs: number;
}

export interface CostLevelTotals {
  estimatedUsd: number;
  actualUsd: number;
}

export interface CostStatus {
  taskUsd: number;
  episodeUsd: number;
  cumulativeUsd: number;
  estimated: { taskUsd: number; episodeUsd: number; cumulativeUsd: number };
  levels: {
    task: CostLevelTotals;
    episode: CostLevelTotals;
    lifetime: CostLevelTotals;
  };
  budgets: BudgetConfig;
}

export interface RecordedCost {
  externalCall: ExternalCallRecord;
  charge: CostChargeRecord;
  status: CostStatus;
}

export interface OutstandingCostConfirmation {
  confirmToken: string;
  projectId: string;
  taskId: string;
  level: BudgetLevel;
  message: string;
  estimatedUsd: number;
  createdAt: string;
}

export interface CostMeterOptions {
  userDir?: string;
  auditLog: AuditLog;
  budgets?: BudgetConfig;
  now?: () => Date;
  confirmTokenFactory?: () => string;
}

type BudgetLevel = "task" | "episode" | "cumulative";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAmount(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number.`);
  }
}

function assertThreshold(value: BudgetThreshold, level: BudgetLevel): void {
  if (value.warnUsd !== null) assertAmount(value.warnUsd, `${level} warnUsd`);
  if (value.capUsd !== null) assertAmount(value.capUsd, `${level} capUsd`);
}

function budgets(config: BudgetConfig | undefined): BudgetConfig {
  const selected = config ?? DEFAULT_BUDGETS;
  assertThreshold(selected.task, "task");
  assertThreshold(selected.episode, "episode");
  assertThreshold(selected.cumulative, "cumulative");
  return structuredClone(selected);
}

function assertContext(context: CostContext): void {
  if (context.sessionId.length === 0 || context.projectId.length === 0 || context.taskId.length === 0) {
    throw new TypeError("Cost context IDs must not be empty.");
  }
}

function assertEstimate(estimate: CostEstimate): void {
  if (estimate.adapterId.length === 0) throw new TypeError("Cost estimate adapterId must not be empty.");
  if (estimate.currency !== "USD") {
    throw new RangeError(`CostMeter v1 budgets require USD, received ${estimate.currency}.`);
  }
  assertAmount(estimate.amount, "Estimated cost");
  if (!isRecord(estimate.units)) throw new TypeError("Cost estimate units must be an object.");
}

function numberColumn(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== "number") throw new Error(`Invalid costmeter.sqlite value for ${column}.`);
  return value;
}

function optionalStringColumn(row: Record<string, unknown> | undefined, column: string): string | undefined {
  if (row === undefined) return undefined;
  const value = row[column];
  if (typeof value !== "string") throw new Error(`Invalid costmeter.sqlite value for ${column}.`);
  return value;
}

function defaultConfirmToken(): string {
  return `confirm-${crypto.randomUUID()}`;
}

export class CostMeter {
  readonly #database: DatabaseSync;
  readonly #databasePath: string;
  readonly #auditLog: AuditLog;
  readonly #budgets: BudgetConfig;
  readonly #now: () => Date;
  readonly #confirmTokenFactory: () => string;
  readonly #lastTaskByProject = new Map<string, string>();
  readonly #outstandingConfirmations = new Map<string, OutstandingCostConfirmation>();
  #closed = false;

  private constructor(database: DatabaseSync, databasePath: string, options: CostMeterOptions) {
    this.#database = database;
    this.#databasePath = databasePath;
    this.#auditLog = options.auditLog;
    this.#budgets = budgets(options.budgets);
    this.#now = options.now ?? (() => new Date());
    this.#confirmTokenFactory = options.confirmTokenFactory ?? defaultConfirmToken;
  }

  public static open(options: CostMeterOptions): CostMeter {
    const userDir = options.userDir ?? join(homedir(), ".guyditor");
    const stateDirectory = join(userDir, "state");
    mkdirSync(stateDirectory, { recursive: true });
    const databasePath = join(stateDirectory, "costmeter.sqlite");
    const database = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      database.exec("PRAGMA journal_mode = WAL;");
      database.exec(COST_SCHEMA_DDL);
      return new CostMeter(database, databasePath, { ...options, userDir });
    } catch (error: unknown) {
      database.close();
      throw error;
    }
  }

  public get databasePath(): string {
    return this.#databasePath;
  }

  public preflight(estimate: CostEstimate, context: CostContext): Preflight {
    this.#ensureOpen();
    assertEstimate(estimate);
    assertContext(context);
    this.#lastTaskByProject.set(context.projectId, context.taskId);
    const status = this.statusForTask(context.projectId, context.taskId);
    const projected: Record<BudgetLevel, number> = {
      task: status.taskUsd + estimate.amount,
      episode: status.episodeUsd + estimate.amount,
      cumulative: status.cumulativeUsd + estimate.amount,
    };
    const orderedLevels: readonly BudgetLevel[] = ["task", "episode", "cumulative"];
    for (const level of orderedLevels) {
      const cap = this.#budgets[level].capUsd;
      if (cap !== null && projected[level] > cap) {
        this.#budgetEvent(context, level, "cap_block", cap, projected[level]);
        return {
          verdict: "blocked",
          level,
          message: `${level} projected spend $${projected[level].toFixed(2)} exceeds cap $${cap.toFixed(2)} (E_BUDGET_CAP).`,
        };
      }
    }
    for (const level of orderedLevels) {
      const warning = this.#budgets[level].warnUsd;
      if (warning !== null && projected[level] > warning) {
        this.#budgetEvent(context, level, "warn", warning, projected[level]);
        const confirmToken = this.#confirmTokenFactory();
        const message = `${level} projected spend $${projected[level].toFixed(2)} exceeds warning $${warning.toFixed(2)}.`;
        this.#outstandingConfirmations.set(confirmToken, {
          confirmToken,
          projectId: context.projectId,
          taskId: context.taskId,
          level,
          message,
          estimatedUsd: estimate.amount,
          createdAt: this.#now().toISOString(),
        });
        return {
          verdict: "warn",
          level,
          message,
          confirmToken,
        };
      }
    }
    return { verdict: "proceed" };
  }

  public record(actual: ExternalCallActual): RecordedCost {
    this.#ensureOpen();
    assertContext(actual.context);
    assertEstimate(actual.estimate);
    assertAmount(actual.actualUsd, "Actual cost");
    assertAmount(actual.durationMs, "External call durationMs");
    this.#lastTaskByProject.set(actual.context.projectId, actual.context.taskId);
    const external = this.#auditLog.append({
      type: "external.call",
      sessionId: actual.context.sessionId,
      projectId: actual.context.projectId,
      adapterId: actual.estimate.adapterId,
      provider: actual.provider,
      purpose: actual.purpose,
      dataClassesSent: [...actual.dataClassesSent],
      payloadSummary: structuredClone(actual.payloadSummary),
      units: structuredClone(actual.units),
      costUsd: { estimated: actual.estimate.amount, actual: actual.actualUsd },
      outcome: actual.outcome,
      durationMs: actual.durationMs,
    });
    if (external.type !== "external.call") throw new Error("AuditLog returned the wrong record type.");
    const before = this.statusForTask(actual.context.projectId, actual.context.taskId);
    const totals = {
      taskUsd: before.taskUsd + actual.actualUsd,
      episodeUsd: before.episodeUsd + actual.actualUsd,
      cumulativeUsd: before.cumulativeUsd + actual.actualUsd,
    };
    const charge = this.#auditLog.append({
      type: "cost.charge",
      sessionId: actual.context.sessionId,
      projectId: actual.context.projectId,
      externalCallSeq: external.seq,
      costUsd: actual.actualUsd,
      totals,
    });
    if (charge.type !== "cost.charge") throw new Error("AuditLog returned the wrong record type.");
    this.#database.prepare(`
      INSERT INTO cost_records (
        session_id, project_id, task_id, external_call_seq, adapter_id,
        estimated_usd, actual_usd, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actual.context.sessionId,
      actual.context.projectId,
      actual.context.taskId,
      external.seq,
      actual.estimate.adapterId,
      actual.estimate.amount,
      actual.actualUsd,
      this.#now().toISOString(),
    );
    for (const [confirmToken, confirmation] of this.#outstandingConfirmations) {
      if (
        confirmation.projectId === actual.context.projectId &&
        confirmation.taskId === actual.context.taskId
      ) this.#outstandingConfirmations.delete(confirmToken);
    }
    return {
      externalCall: external,
      charge,
      status: this.statusForTask(actual.context.projectId, actual.context.taskId),
    };
  }

  public status(projectId: string): CostStatus {
    this.#ensureOpen();
    const current = this.#lastTaskByProject.get(projectId);
    const latest = current ?? optionalStringColumn(
      this.#database.prepare(`
        SELECT task_id AS taskId FROM cost_records
        WHERE project_id = ? ORDER BY id DESC LIMIT 1
      `).get(projectId),
      "taskId",
    );
    return this.statusForTask(projectId, latest ?? "");
  }

  public outstandingConfirmations(projectId: string): OutstandingCostConfirmation[] {
    this.#ensureOpen();
    return [...this.#outstandingConfirmations.values()]
      .filter((confirmation) => confirmation.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((confirmation) => structuredClone(confirmation));
  }

  public confirm(confirmToken: string, context: CostContext): boolean {
    this.#ensureOpen();
    assertContext(context);
    const confirmation = this.#outstandingConfirmations.get(confirmToken);
    if (
      confirmation === undefined ||
      confirmation.projectId !== context.projectId ||
      confirmation.taskId !== context.taskId
    ) return false;
    this.#outstandingConfirmations.delete(confirmToken);
    const threshold = this.#budgets[confirmation.level].warnUsd ?? 0;
    const status = this.statusForTask(context.projectId, context.taskId);
    const current = confirmation.level === "task"
      ? status.taskUsd
      : confirmation.level === "episode"
        ? status.episodeUsd
        : status.cumulativeUsd;
    this.#budgetEvent(
      context,
      confirmation.level,
      "creator_override",
      threshold,
      current + confirmation.estimatedUsd,
    );
    return true;
  }

  public statusForTask(projectId: string, taskId: string): CostStatus {
    this.#ensureOpen();
    const task = this.#total(
      "SELECT COALESCE(SUM(estimated_usd), 0.0) AS estimated, COALESCE(SUM(actual_usd), 0.0) AS actual FROM cost_records WHERE project_id = ? AND task_id = ?",
      [projectId, taskId],
    );
    const episode = this.#total(
      "SELECT COALESCE(SUM(estimated_usd), 0.0) AS estimated, COALESCE(SUM(actual_usd), 0.0) AS actual FROM cost_records WHERE project_id = ?",
      [projectId],
    );
    const lifetime = this.#total(
      "SELECT COALESCE(SUM(estimated_usd), 0.0) AS estimated, COALESCE(SUM(actual_usd), 0.0) AS actual FROM cost_records",
      [],
    );
    return {
      taskUsd: task.actualUsd,
      episodeUsd: episode.actualUsd,
      cumulativeUsd: lifetime.actualUsd,
      estimated: {
        taskUsd: task.estimatedUsd,
        episodeUsd: episode.estimatedUsd,
        cumulativeUsd: lifetime.estimatedUsd,
      },
      levels: { task, episode, lifetime },
      budgets: structuredClone(this.#budgets),
    };
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#outstandingConfirmations.clear();
    this.#database.close();
  }

  #total(sql: string, parameters: string[]): CostLevelTotals {
    const row = this.#database.prepare(sql).get(...parameters);
    if (row === undefined) return { estimatedUsd: 0, actualUsd: 0 };
    return {
      estimatedUsd: numberColumn(row, "estimated"),
      actualUsd: numberColumn(row, "actual"),
    };
  }

  #budgetEvent(
    context: CostContext,
    level: BudgetLevel,
    kind: "warn" | "cap_block" | "creator_override",
    thresholdUsd: number,
    projectedUsd: number,
  ): void {
    this.#auditLog.append({
      type: "budget.event",
      sessionId: context.sessionId,
      projectId: context.projectId,
      level,
      kind,
      thresholdUsd,
      projectedUsd,
    });
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("CostMeter is closed.");
  }
}
