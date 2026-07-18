import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProject } from "../../../core/src/index.js";
import { projectFixture } from "../../../core/src/project/test-fixtures.js";
import { describe, expect, it } from "vitest";

import type { GdEvent } from "../shared/ipc.js";
import { WindowEventPublisher } from "./events.js";
import { AppServiceHost } from "./service-host.js";

describe("AppServiceHost", () => {
  it("executes clip.trim through a window service and emits the committed revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "guyditor-host-project-"));
    const userDirectory = await mkdtemp(join(tmpdir(), "guyditor-host-user-"));
    const created = await createProject(root, projectFixture());
    expect(created.ok).toBe(true);
    const events: GdEvent[] = [];
    const publisher = new WindowEventPublisher((_channel, event) => events.push(event));
    const appHost = new AppServiceHost({
      appVersion: "0.0.0-test",
      autoStartMlworker: false,
      settings: {
        auditRetentionDays: 365,
        budgets: {
          task: { warnUsd: 1, capUsd: 5 },
          episode: { warnUsd: 25, capUsd: null },
          cumulative: { warnUsd: 100, capUsd: null },
        },
        maxConcurrentJobs: 1,
      },
      userDirectory,
    });
    const windowHost = appHost.createWindowHost({ publisher });
    await windowHost.openProject(root);

    const operationService = windowHost.resolveService("OperationEngine");
    expect(operationService).toBeDefined();
    const execute = operationService?.["execute"];
    expect(typeof execute).toBe("function");
    const result = await Reflect.apply(execute as (...args: unknown[]) => unknown, operationService, [{
      operations: [{
        op: "clip.trim",
        params: {
          clipId: "clp_aaaaaaaaaa",
          edge: "tail",
          delta: { frames: -1, fps: "24/1" },
          snapPolicy: "none",
        },
      }],
      intent: "direct",
      label: "Trim fixture clip by one frame",
    }]) as { revision: string; txnId: string };

    expect(result.revision).toBe("rev_00002");
    expect(result.txnId).toMatch(/^txn_[a-z2-7]{10}$/u);
    expect(events).toContainEqual({
      kind: "project.revision",
      revision: "rev_00002",
      seq: expect.any(Number),
    });
    expect(await readFile(join(root, "history/transactions.jsonl"), "utf8"))
      .toContain('"op":"clip.trim"');

    await windowHost.close();
    await appHost.close();
  });
});
