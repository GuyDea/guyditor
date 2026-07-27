import { AsyncLocalStorage } from "node:async_hooks";

export class OperationLease<Key extends object> {
  readonly #afterStart: ((key: Key) => Promise<void>) | undefined;
  readonly #context = new AsyncLocalStorage<Key>();
  readonly #operations = new Map<Key, Set<Promise<unknown>>>();
  readonly #blocked = new Set<Key>();

  public constructor(afterStart?: (key: Key) => Promise<void>) {
    this.#afterStart = afterStart;
  }

  public isBlocked(key: Key): boolean {
    return this.#blocked.has(key);
  }

  public isRunning(key: Key): boolean {
    return this.#context.getStore() === key;
  }

  public run<Value>(
    key: Key,
    task: () => Promise<Value>,
  ): Promise<Value> {
    if (this.isRunning(key)) return Promise.resolve().then(task);
    if (this.#blocked.has(key)) {
      return Promise.reject(new Error("Operation lease is closing."));
    }
    const tracked = this.#context.run(key, async () => {
      await this.#afterStart?.(key);
      return task();
    });
    const operations = this.#operations.get(key) ?? new Set();
    operations.add(tracked);
    this.#operations.set(key, operations);
    const release = (): void => {
      operations.delete(tracked);
      if (operations.size === 0) this.#operations.delete(key);
    };
    void tracked.then(release, release);
    return tracked;
  }

  public async blockAndDrain(key: Key): Promise<void> {
    this.#blocked.add(key);
    const active = this.#operations.get(key);
    if (active !== undefined) await Promise.allSettled([...active]);
  }

  public release(key: Key): void {
    this.#blocked.delete(key);
  }
}
