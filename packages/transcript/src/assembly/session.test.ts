import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { isId } from "../../../core/src/index.js";
import {
  assemblySidecarRef,
  createAssemblySession,
  parseAssemblySession,
  serializeAssemblySession,
} from "./index.js";

function fresh() {
  return createAssemblySession({
    id: "asb_aaaaaaaaaa",
    now: "2026-10-27T10:00:00.000Z",
    settings: { provider: "stub", model: "stub-1", effort: "medium", tightening: "ask" },
    assetIds: ["ast_aaaaaaaaaa", "ast_bbbbbbbbbb"],
    script: { name: "script.md", path: "/tmp/script.md", sha256: "0".repeat(64) },
  });
}

describe("assembly session sidecar", () => {
  it("round-trips a fresh session", () => {
    const session = fresh();
    const parsed = parseAssemblySession(serializeAssemblySession(session));
    expect(parsed).toEqual(session);
    expect(parsed.status).toBe("created");
    expect(parsed.messages.length).toBe(0);
    expect(parsed.externalAcknowledged).toBe(false);
  });

  it("rejects a sidecar with the wrong schema id", () => {
    expect(() => parseAssemblySession('{"schema":"guyditor.transcript/v1"}')).toThrow(/E_ASSEMBLY_SIDECAR_INVALID/);
  });

  it("sidecar ref points at sidecars/assembly", () => {
    const session = fresh();
    const text = serializeAssemblySession(session);
    const ref = assemblySidecarRef(session, text);
    expect(ref.path).toBe("sidecars/assembly/asb_aaaaaaaaaa.json");
    expect(ref.sha256).toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("asb is a known id prefix", () => {
    expect(isId("asb", "asb_aaaaaaaaaa")).toBe(true);
  });
});
