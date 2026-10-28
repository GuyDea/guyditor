import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";

import type { SidecarRef } from "../../../core/src/index.js";
import schema from "../../../core/schema/sidecars/guyditor-assembly-v1.schema.json" with { type: "json" };
import type { AssemblySession } from "./types.js";

const validate = new Ajv2020({ allErrors: true, strict: true }).compile<AssemblySession>(schema);

function invalid(detail: string): never {
  throw new Error(`E_ASSEMBLY_SIDECAR_INVALID: ${detail}`);
}

export function createAssemblySession(input: {
  id: string;
  now: string;
  settings: AssemblySession["settings"];
  assetIds: string[];
}): AssemblySession {
  return {
    schema: "guyditor.assembly/v1",
    id: input.id,
    createdAt: input.now,
    updatedAt: input.now,
    status: "created",
    settings: { ...input.settings },
    inputs: { assetIds: [...input.assetIds], files: [], script: { mode: "auto" }, nextFileLabel: 1 },
    auditSessionId: null,
    externalAcknowledged: false,
    evidence: null,
    messages: [],
    plan: null,
    compiled: null,
    proposalId: null,
    tighteningJobId: null,
    error: null,
  };
}

function validateAssemblySession(value: unknown): AssemblySession {
  if (!validate(value)) {
    invalid(validate.errors?.map((error) =>
      `${error.instancePath || "/"} ${error.message ?? error.keyword}`).join("; ") ?? "schema error");
  }
  return value as AssemblySession;
}

export function parseAssemblySession(text: string): AssemblySession {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return invalid("expected valid JSON");
  }
  return validateAssemblySession(value);
}

export function serializeAssemblySession(session: AssemblySession): string {
  return `${JSON.stringify(validateAssemblySession(session), null, 2)}\n`;
}

export function assemblySidecarRef(session: AssemblySession, text: string): SidecarRef {
  return {
    name: `assembly-${session.id}`,
    path: `sidecars/assembly/${session.id}.json`,
    schema: session.schema,
    sha256: createHash("sha256").update(text).digest("hex"),
    inputs: [],
  };
}
