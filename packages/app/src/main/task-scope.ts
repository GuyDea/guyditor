export class TaskScope {
  readonly #tasks = new Set<Promise<unknown>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  public run<Value>(task: () => Promise<Value>): Promise<Value> {
    if (this.#closed) return Promise.reject(new Error("Task scope is closed."));
    const tracked = Promise.resolve().then(task);
    this.#tasks.add(tracked);
    const release = (): void => {
      this.#tasks.delete(tracked);
    };
    void tracked.then(release, release);
    return tracked;
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#drain();
    return this.#closePromise;
  }

  async #drain(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }
}
