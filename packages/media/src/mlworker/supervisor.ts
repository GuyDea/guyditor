import {
  spawn,
} from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import {
  failure,
  makeGuyditorError,
  success,
} from "../../../core/src/index.js";
import type {
  GuyditorError,
  JsonValue,
  Result,
} from "../../../core/src/index.js";

import type {
  MlworkerHello,
  MlworkerProgress,
  MlworkerRunOptions,
  MlworkerState,
  MlworkerStateEvent,
  MlworkerTaskMethod,
  MlworkerTaskRunner,
} from "./types.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const DEFAULT_FAILURE_WINDOW_MS = 10 * 60 * 1_000;
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 25_000] as const;
const REPAIR_SUGGESTION =
  "Restart the ML worker from Settings; if it still fails, start Guyditor in safe mode or reinstall the ML worker.";

interface SupervisorTiming {
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  livenessTimeoutMs?: number;
  cancelTimeoutMs?: number;
  failureWindowMs?: number;
  backoffMs?: readonly number[];
}

export interface MlworkerSupervisorOptions {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timing?: SupervisorTiming;
  onStateChange?: (event: MlworkerStateEvent) => void;
  onStderrLine?: (line: string) => void;
}

interface ActiveRequest {
  id: number;
  taskId: string;
  resolve: (result: Result<JsonValue>) => void;
  onProgress?: (progress: MlworkerProgress) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

interface SlotWaiter {
  resolve: (granted: boolean) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseHello(value: unknown): MlworkerHello | undefined {
  if (!isRecord(value)) return undefined;
  const device = value["device"];
  const capabilities = value["capabilities"];
  if (
    value["protocol"] !== 1 || typeof value["workerVersion"] !== "string" ||
    typeof value["python"] !== "string" || !isRecord(device) ||
    (device["type"] !== "cpu" && device["type"] !== "cuda" && device["type"] !== "mps") ||
    !Array.isArray(capabilities)
  ) return undefined;
  for (const capability of capabilities) {
    if (
      !isRecord(capability) || typeof capability["task"] !== "string" ||
      typeof capability["engine"] !== "string" ||
      typeof capability["engineVersion"] !== "string" ||
      (capability["models"] !== undefined &&
        (!Array.isArray(capability["models"]) ||
          !capability["models"].every((model) => typeof model === "string")))
    ) return undefined;
  }
  return isJsonValue(value) ? value as unknown as MlworkerHello : undefined;
}

function parseProgress(value: unknown): MlworkerProgress | undefined {
  if (
    !isRecord(value) || typeof value["taskId"] !== "string" ||
    typeof value["progress"] !== "number" || !Number.isFinite(value["progress"]) ||
    value["progress"] < 0 || value["progress"] > 1 ||
    (value["stage"] !== undefined && typeof value["stage"] !== "string")
  ) return undefined;
  return {
    taskId: value["taskId"],
    progress: value["progress"],
    ...(value["stage"] === undefined ? {} : { stage: value["stage"] }),
  };
}

function downError(message = "The ML worker is unavailable."): GuyditorError {
  return makeGuyditorError("E_MLWORKER_DOWN", message, {
    retry: "safe",
    suggestion: REPAIR_SUGGESTION,
  });
}

function cancelledError(taskId: string): GuyditorError {
  return makeGuyditorError(
    "E_MLWORKER_CANCELLED",
    `ML task ${taskId} was cancelled.`,
    { affected: [taskId], retry: "safe" },
  );
}

function taskError(taskId: string, message: string): GuyditorError {
  return makeGuyditorError("E_MLWORKER_TASK_FAILED", message, {
    affected: [taskId],
    retry: "safe",
    suggestion: "Retry the task; if it fails again, inspect the ML worker log and model installation.",
  });
}

function workerEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env["PYTHONHOME"];
  delete env["PYTHONPATH"];
  delete env["VIRTUAL_ENV"];
  env["PYTHONNOUSERSITE"] = "1";
  return env;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class MlworkerSupervisor implements MlworkerTaskRunner {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #timing: Required<SupervisorTiming>;
  readonly #onStateChange: ((event: MlworkerStateEvent) => void) | undefined;
  readonly #onStderrLine: ((line: string) => void) | undefined;
  readonly #startWaiters: Array<(result: Result<MlworkerHello>) => void> = [];
  readonly #slotWaiters: SlotWaiter[] = [];
  #slotHeld = false;
  #process: ChildProcessWithoutNullStreams | undefined;
  #state: MlworkerState = "stopped";
  #failureCount = 0;
  #lastFailureAt: number | undefined;
  #hello: MlworkerHello | undefined;
  #nextRequestId = 1;
  #active: ActiveRequest | undefined;
  #pendingPingId: number | undefined;
  #lastLiveness = 0;
  #stdoutRemainder = "";
  #stderrRemainder = "";
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #livenessTimer: ReturnType<typeof setInterval> | undefined;
  #manualStop = false;

  public constructor(options: MlworkerSupervisorOptions = {}) {
    const workerRoot = path.resolve(
      import.meta.dirname,
      "../../../../workers/mlworker",
    );
    this.#command = options.command ?? path.join(workerRoot, ".venv/bin/python");
    this.#args = options.args ?? ["-m", "mlworker", "--stdio"];
    this.#cwd = options.cwd ?? workerRoot;
    this.#env = workerEnvironment(options.env ?? {});
    this.#timing = {
      handshakeTimeoutMs:
        options.timing?.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      pingIntervalMs: options.timing?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
      livenessTimeoutMs:
        options.timing?.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS,
      cancelTimeoutMs: options.timing?.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
      failureWindowMs:
        options.timing?.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS,
      backoffMs: options.timing?.backoffMs ?? DEFAULT_BACKOFF_MS,
    };
    if (this.#timing.backoffMs.length === 0) {
      throw new RangeError("mlworker backoff must contain at least one delay");
    }
    this.#onStateChange = options.onStateChange;
    this.#onStderrLine = options.onStderrLine;
  }

  public get state(): MlworkerState {
    return this.#state;
  }

  public get failureCount(): number {
    return this.#failureCount;
  }

  public get hello(): MlworkerHello | undefined {
    return this.#hello === undefined ? undefined : structuredClone(this.#hello);
  }

  public start(): Promise<Result<MlworkerHello>> {
    if (this.#state === "ready" && this.#hello !== undefined) {
      return Promise.resolve(success(structuredClone(this.#hello)));
    }
    if (this.#state === "unavailable") {
      return Promise.resolve(failure(downError()));
    }
    this.#manualStop = false;
    if (this.#state === "stopped") this.#spawn();
    return new Promise((resolve) => this.#startWaiters.push(resolve));
  }

  public async stop(): Promise<void> {
    this.#manualStop = true;
    this.#clearProcessTimers();
    if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const child = this.#process;
    this.#process = undefined;
    this.#hello = undefined;
    this.#pendingPingId = undefined;
    this.#finishActive(failure(downError("The ML worker was stopped.")));
    this.#resolveStartWaiters(failure(downError("The ML worker was stopped.")));
    this.#setState("stopped");
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1_000);
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGKILL");
      });
    }
  }

  public async restart(): Promise<Result<MlworkerHello>> {
    await this.stop();
    this.#failureCount = 0;
    this.#lastFailureAt = undefined;
    this.#manualStop = false;
    return this.start();
  }

  public async runTask(
    method: MlworkerTaskMethod,
    params: Record<string, JsonValue>,
    options: MlworkerRunOptions = {},
  ): Promise<Result<JsonValue>> {
    const taskId = params["taskId"];
    if (typeof taskId !== "string" || taskId.length === 0) {
      return failure(taskError("", "mlworker taskId must be a non-empty string"));
    }
    if (signalIsAborted(options.signal)) return failure(cancelledError(taskId));
    // Exactly one task is in flight per worker process (spec §1.2). Concurrent
    // callers wait their turn in submission order rather than failing: the job
    // queue runs several jobs at once, and ingest/capture routinely make two ML
    // jobs runnable at the same instant.
    if (!await this.#acquireSlot(options.signal)) {
      return failure(cancelledError(taskId));
    }
    try {
      return await this.#runExclusive(method, params, options, taskId);
    } finally {
      this.#releaseSlot();
    }
  }

  #acquireSlot(signal: AbortSignal | undefined): Promise<boolean> {
    if (!this.#slotHeld) {
      this.#slotHeld = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: SlotWaiter = { resolve, signal, onAbort: undefined };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.#slotWaiters.indexOf(waiter);
          if (index === -1) return;
          this.#slotWaiters.splice(index, 1);
          signal.removeEventListener("abort", onAbort);
          resolve(false);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#slotWaiters.push(waiter);
    });
  }

  #releaseSlot(): void {
    const waiter = this.#slotWaiters.shift();
    if (waiter === undefined) {
      this.#slotHeld = false;
      return;
    }
    // Hand the slot straight to the next waiter. #slotHeld deliberately stays
    // true so a synchronous #acquireSlot cannot claim the slot in the window
    // before the woken waiter resumes.
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(true);
  }

  async #runExclusive(
    method: MlworkerTaskMethod,
    params: Record<string, JsonValue>,
    options: MlworkerRunOptions,
    taskId: string,
  ): Promise<Result<JsonValue>> {
    const started = await this.start();
    if (!started.ok) return started;
    if (signalIsAborted(options.signal)) return failure(cancelledError(taskId));
    if (this.#active !== undefined) {
      return failure(makeGuyditorError(
        "E_MLWORKER_BUSY",
        `ML task ${this.#active.taskId} is already running.`,
        { affected: [this.#active.taskId], retry: "safe" },
      ));
    }
    if (this.#state !== "ready" || this.#process === undefined) {
      return failure(downError());
    }

    return new Promise((resolve) => {
      const id = this.#nextRequestId++;
      const active: ActiveRequest = {
        id,
        taskId,
        resolve,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      if (options.signal !== undefined) {
        active.abortListener = () => this.#cancel(active);
        options.signal.addEventListener("abort", active.abortListener, { once: true });
      }
      this.#active = active;
      this.#lastLiveness = Date.now();
      if (!this.#send({ jsonrpc: "2.0", id, method, params })) {
        this.#finishActive(failure(downError()));
      }
    });
  }

  #spawn(): void {
    if (this.#manualStop || this.#state === "unavailable") return;
    this.#setState("starting");
    this.#hello = undefined;
    this.#stdoutRemainder = "";
    this.#stderrRemainder = "";
    const child = spawn(this.#command, [...this.#args], {
      cwd: this.#cwd,
      env: this.#env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#stdout(chunk, child));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.#stderr(chunk, child));
    child.once("error", (error) => this.#processFailed(child, error.message));
    child.once("close", (code, signal) => {
      this.#flushStderr();
      this.#processFailed(
        child,
        `exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${String(code)}`}`,
      );
    });
    this.#handshakeTimer = setTimeout(() => {
      this.#processFailed(child, "did not send mlworker.hello within 15 seconds");
    }, this.#timing.handshakeTimeoutMs);
    this.#handshakeTimer.unref();
  }

  #stdout(chunk: string, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child) return;
    this.#stdoutRemainder += chunk;
    const lines = this.#stdoutRemainder.split("\n");
    this.#stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.#processFailed(child, "wrote invalid JSON to stdout");
        return;
      }
      this.#message(message, child);
    }
  }

  #stderr(chunk: string, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child) return;
    this.#stderrRemainder += chunk;
    const lines = this.#stderrRemainder.split("\n");
    this.#stderrRemainder = lines.pop() ?? "";
    for (const line of lines) this.#onStderrLine?.(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  #flushStderr(): void {
    if (this.#stderrRemainder.length > 0) this.#onStderrLine?.(this.#stderrRemainder);
    this.#stderrRemainder = "";
  }

  #message(message: unknown, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child || !isRecord(message) || message["jsonrpc"] !== "2.0") {
      this.#processFailed(child, "sent an invalid JSON-RPC message");
      return;
    }
    if (message["method"] === "mlworker.hello") {
      if (this.#state !== "starting" || this.#hello !== undefined) {
        this.#processFailed(child, "sent an unexpected mlworker.hello notification");
        return;
      }
      const hello = parseHello(message["params"]);
      if (hello === undefined) {
        this.#processFailed(child, "sent an invalid mlworker.hello payload");
        return;
      }
      if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
      this.#hello = hello;
      this.#lastLiveness = Date.now();
      this.#setState("ready");
      this.#startHealthTimers(child);
      this.#resolveStartWaiters(success(structuredClone(hello)));
      return;
    }
    if (message["method"] === "$/progress") {
      const update = parseProgress(message["params"]);
      const active = this.#active;
      if (update !== undefined && active !== undefined && update.taskId === active.taskId) {
        this.#lastLiveness = Date.now();
        active.onProgress?.(update);
      }
      return;
    }
    if (typeof message["id"] !== "number") return;
    if (message["id"] === this.#pendingPingId) {
      this.#pendingPingId = undefined;
      this.#lastLiveness = Date.now();
      return;
    }
    const active = this.#active;
    if (active === undefined || message["id"] !== active.id) return;
    this.#lastLiveness = Date.now();
    const rpcError = message["error"];
    if (isRecord(rpcError)) {
      const code = rpcError["code"];
      const rpcMessage = typeof rpcError["message"] === "string"
        ? rpcError["message"]
        : "The ML worker task failed.";
      this.#finishActive(failure(
        code === -32800
          ? cancelledError(active.taskId)
          : taskError(active.taskId, rpcMessage),
      ));
      return;
    }
    if (!isJsonValue(message["result"])) {
      this.#processFailed(child, "sent a non-JSON task result");
      return;
    }
    this.#failureCount = 0;
    this.#lastFailureAt = undefined;
    this.#finishActive(success(message["result"]));
  }

  #startHealthTimers(child: ChildProcessWithoutNullStreams): void {
    this.#pingTimer = setInterval(() => {
      if (
        this.#process !== child || this.#state !== "ready" ||
        this.#active !== undefined || this.#pendingPingId !== undefined
      ) return;
      const id = this.#nextRequestId++;
      this.#pendingPingId = id;
      this.#send({ jsonrpc: "2.0", id, method: "ping", params: {} });
    }, this.#timing.pingIntervalMs);
    this.#pingTimer.unref();
    this.#livenessTimer = setInterval(() => {
      if (
        this.#process === child && this.#state === "ready" &&
        Date.now() - this.#lastLiveness >= this.#timing.livenessTimeoutMs
      ) this.#processFailed(child, "did not provide a liveness signal within 120 seconds");
    }, Math.min(this.#timing.pingIntervalMs, 1_000));
    this.#livenessTimer.unref();
  }

  #cancel(active: ActiveRequest): void {
    if (this.#active !== active || active.cancelTimer !== undefined) return;
    this.#send({
      jsonrpc: "2.0",
      method: "$/cancel",
      params: { taskId: active.taskId },
    });
    active.cancelTimer = setTimeout(() => {
      if (this.#active === active && this.#process !== undefined) {
        this.#processFailed(this.#process, `did not acknowledge cancellation for ${active.taskId}`);
      }
    }, this.#timing.cancelTimeoutMs);
    active.cancelTimer.unref();
  }

  #send(message: Record<string, JsonValue>): boolean {
    const child = this.#process;
    if (child === undefined || child.stdin.destroyed || !child.stdin.writable) return false;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  #finishActive(result: Result<JsonValue>): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#active = undefined;
    if (active.cancelTimer !== undefined) clearTimeout(active.cancelTimer);
    if (active.signal !== undefined && active.abortListener !== undefined) {
      active.signal.removeEventListener("abort", active.abortListener);
    }
    active.resolve(result);
  }

  #processFailed(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.#process !== child) return;
    this.#process = undefined;
    this.#hello = undefined;
    this.#pendingPingId = undefined;
    this.#clearProcessTimers();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    this.#finishActive(failure(downError(`The ML worker ${reason}.`)));
    if (this.#manualStop) return;
    const failedAt = Date.now();
    if (
      this.#lastFailureAt === undefined ||
      failedAt - this.#lastFailureAt > this.#timing.failureWindowMs
    ) this.#failureCount = 0;
    this.#lastFailureAt = failedAt;
    this.#failureCount += 1;
    if (this.#failureCount >= 3) {
      this.#setState("unavailable", reason);
      this.#resolveStartWaiters(failure(downError(`The ML worker ${reason}.`)));
      return;
    }
    this.#setState("restarting", reason);
    const delayIndex = Math.min(
      this.#failureCount - 1,
      this.#timing.backoffMs.length - 1,
    );
    const delay = this.#timing.backoffMs[delayIndex];
    if (delay === undefined) throw new Error("mlworker backoff delay is missing");
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      this.#spawn();
    }, delay);
    this.#restartTimer.unref();
  }

  #clearProcessTimers(): void {
    if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer);
    if (this.#livenessTimer !== undefined) clearInterval(this.#livenessTimer);
    this.#handshakeTimer = undefined;
    this.#pingTimer = undefined;
    this.#livenessTimer = undefined;
  }

  #resolveStartWaiters(result: Result<MlworkerHello>): void {
    for (const resolve of this.#startWaiters.splice(0)) resolve(result);
  }

  #setState(state: MlworkerState, reason?: string): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onStateChange?.({
      kind: "mlworker.state",
      state,
      failureCount: this.#failureCount,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}
