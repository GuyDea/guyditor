import type { GdEvent, GdEventWithoutSeq } from "../shared/ipc.js";

export interface ProgressEvent {
  jobId: string;
  progress: number;
  etaSeconds?: number;
}

interface PendingProgress {
  event: ProgressEvent;
  timer: ReturnType<typeof setTimeout>;
}

export class JobProgressThrottle {
  readonly #emit: (event: ProgressEvent) => void;
  readonly #lastEmitted = new Map<string, number>();
  readonly #pending = new Map<string, PendingProgress>();

  public constructor(emit: (event: ProgressEvent) => void) {
    this.#emit = emit;
  }

  public publish(event: ProgressEvent): void {
    const now = Date.now();
    const last = this.#lastEmitted.get(event.jobId);
    if (last === undefined || now - last >= 100) {
      this.#emitNow(event, now);
      return;
    }
    const pending = this.#pending.get(event.jobId);
    if (pending !== undefined) {
      pending.event = event;
      return;
    }
    const timer = setTimeout(() => {
      const queued = this.#pending.get(event.jobId);
      if (queued === undefined) return;
      this.#pending.delete(event.jobId);
      this.#emitNow(queued.event, Date.now());
    }, 100 - (now - last));
    this.#pending.set(event.jobId, { event, timer });
  }

  public dispose(): void {
    for (const { timer } of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
    this.#lastEmitted.clear();
  }

  #emitNow(event: ProgressEvent, now: number): void {
    const pending = this.#pending.get(event.jobId);
    if (pending !== undefined) clearTimeout(pending.timer);
    this.#pending.delete(event.jobId);
    this.#lastEmitted.set(event.jobId, now);
    this.#emit(event);
  }
}

export class WindowEventPublisher {
  #sequence = 0;
  readonly #send: (channel: "gd:evt", event: GdEvent) => void;
  readonly #progress: JobProgressThrottle;

  public constructor(send: (channel: "gd:evt", event: GdEvent) => void) {
    this.#send = send;
    this.#progress = new JobProgressThrottle((event) => {
      this.publish({ kind: "job.progress", ...event });
    });
  }

  public publish(event: GdEventWithoutSeq): void {
    this.#sequence += 1;
    this.#send("gd:evt", { ...event, seq: this.#sequence } as GdEvent);
  }

  public publishProgress(event: ProgressEvent): void {
    this.#progress.publish(event);
  }

  public dispose(): void {
    this.#progress.dispose();
  }
}
