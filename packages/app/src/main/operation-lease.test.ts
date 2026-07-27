import { describe, expect, it } from "vitest";

import { OperationLease } from "./operation-lease.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

describe("OperationLease", () => {
  it("lets an admitted operation finish nested work while close drains it", async () => {
    const lease = new OperationLease<object>();
    const key = {};
    const entered = deferred();
    const release = deferred();
    let nestedCompleted = false;

    const operation = lease.run(key, async () => {
      entered.resolve();
      await release.promise;
      await lease.run(key, async () => {
        nestedCompleted = true;
      });
    });
    await entered.promise;

    let drained = false;
    const closing = lease.blockAndDrain(key).then(() => {
      drained = true;
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(drained).toBe(false);

    release.resolve();
    await Promise.all([operation, closing]);
    expect(nestedCompleted).toBe(true);
    await expect(lease.run(key, async () => undefined))
      .rejects.toThrow(/closing/iu);
  });
});
