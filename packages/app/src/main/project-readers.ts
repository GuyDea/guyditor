import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore, TransactionRecord } from "../../../core/src/index.js";
import { parseTranscriptSidecar } from "../../../transcript/src/index.js";

export async function history(store: ProjectStore): Promise<TransactionRecord[]> {
  const contents = await readFile(join(store.root, "history/transactions.jsonl"), "utf8");
  return contents.split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TransactionRecord);
}

export function transcriptSidecars(store: ProjectStore) {
  return Promise.all(store.currentProject.sidecars
    .filter(({ schema }) => schema === "guyditor.transcript/v1")
    .map(async ({ path }) => parseTranscriptSidecar(
      await readFile(join(store.root, path), "utf8"),
    )));
}
