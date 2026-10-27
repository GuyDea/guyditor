import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  classifyContextFile,
  classifyOversizedContextFile,
  CONTEXT_FILE_CAPS,
  contextFilePath,
  formatBytes,
  sentBytesTotal,
} from "../../../transcript/src/index.js";
import type { AssemblySession, ContextFile } from "../../../transcript/src/index.js";

/**
 * Copies `paths` into `sidecars/context/<session>/`, classified and labelled `F<n>` in order.
 * All or nothing: a failing path removes the copies this call already wrote. The caller persists the result.
 * A file over the largest cap can never be sent, so it is listed unsent without being read, hashed or copied.
 */
export async function attachContextFiles(
  root: string,
  session: AssemblySession,
  paths: readonly string[],
): Promise<Pick<AssemblySession["inputs"], "files" | "nextFileLabel">> {
  const files = [...session.inputs.files];
  let nextFileLabel = session.inputs.nextFileLabel;
  const written: ContextFile[] = [];
  try {
    for (const source of paths) {
      const unreadable = new Error(`E_ASSEMBLY_INVALID_INPUT: ${source} is not a readable file`);
      const size = await stat(source).then((info) => (info.isFile() ? info.size : null), () => null);
      if (size === null) throw unreadable;
      const name = basename(source);
      const label = `F${String(nextFileLabel)}`;
      const path = contextFilePath(session.id, label, name);
      if (size > CONTEXT_FILE_CAPS.pdfBytes) {
        // Not read, so not hashed; the copy never exists and detachContextFile tolerates that.
        files.push({ label, name, path, sha256: "", bytes: size, ...classifyOversizedContextFile(name), role: "context" });
        nextFileLabel += 1;
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(source);
      } catch {
        throw unreadable;
      }
      const file: ContextFile = {
        label,
        name,
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        ...classifyContextFile(name, bytes),
        role: "context",
      };
      const total = sentBytesTotal([...files, file]);
      if (file.sent && total > CONTEXT_FILE_CAPS.turnBytes) {
        throw new Error(
          `E_ASSEMBLY_FILES_TOO_LARGE: adding ${name} (${formatBytes(bytes.length)}) would put attached files at ${formatBytes(total)}; the limit is 20 MB`,
        );
      }
      await mkdir(join(root, dirname(file.path)), { recursive: true });
      await writeFile(join(root, file.path), bytes);
      written.push(file);
      files.push(file);
      nextFileLabel += 1;
    }
  } catch (error: unknown) {
    await Promise.all(written.map((file) => detachContextFile(root, file)));
    throw error;
  }
  return { files, nextFileLabel };
}

/** Removes a file's copy; one that is already gone is fine. */
export async function detachContextFile(root: string, file: ContextFile): Promise<void> {
  try {
    await unlink(join(root, file.path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
