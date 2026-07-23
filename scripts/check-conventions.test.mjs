import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  CANONICAL_SERVICES,
  RANDOM_ID_PREFIXES,
  checkConventions,
} from "./check-conventions.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function makeRepository(files) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "guyditor-conventions-"));
  temporaryDirectories.push(rootDir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }

  return rootDir;
}

test("exports the binding Part 0 ID prefixes and canonical services", () => {
  assert.deepEqual(RANDOM_ID_PREFIXES, [
    "ast",
    "clp",
    "seq",
    "lyr",
    "trn",
    "cts",
    "ann",
    "dlv",
    "pre",
    "tpl",
    "skl",
    "beat",
    "mrk",
    "tak",
    "tkc",
    "asm",
    "crt",
    "ses",
    "job",
    "txn",
    "prp",
    "adp",
  ]);
  assert.deepEqual(CANONICAL_SERVICES, [
    "ProjectStore",
    "OperationEngine",
    "MediaEngine",
    "TranscriptEngine",
    "CompositorModel",
    "RenderService",
    "JobQueue",
    "AgentGateway",
    "AuditLog",
    "CostMeter",
    "BackupService",
    "DeliverableService",
    "AnnotationService",
    "SkillRegistry",
    "AdapterRegistry",
    "CaptureWatcher",
  ]);
});

test("accepts every canonical random ID prefix", async () => {
  const ids = RANDOM_ID_PREFIXES.map((prefix) => `${prefix}_abcdefghij`);
  const rootDir = await makeRepository({
    "packages/core/src/ids.ts": [...ids, "w000042", "rev_00017"]
      .map((id) => JSON.stringify(id))
      .join("\n"),
  });

  assert.deepEqual(await checkConventions({ rootDir }), []);
});

test("reports malformed random, word, and revision IDs with line numbers", async () => {
  const rootDir = await makeRepository({
    "packages/core/src/ids.ts": [
      "const asset = 'ast_BAD';",
      'const word = "w123";',
      "const revision = `rev_12`;",
    ].join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ kind, path: filePath, line, token }) => ({
      kind,
      path: filePath,
      line,
      token,
    })),
    [
      { kind: "id", path: "packages/core/src/ids.ts", line: 1, token: "ast_BAD" },
      { kind: "id", path: "packages/core/src/ids.ts", line: 2, token: "w123" },
      { kind: "id", path: "packages/core/src/ids.ts", line: 3, token: "rev_12" },
    ],
  );
});

test("consumes malformed Unicode and hyphenated ID candidates as whole tokens", async () => {
  const rootDir = await makeRepository({
    "packages/core/src/ids.ts": [
      "ast_abcdefghijé",
      "w123456é",
      "rev_12345é",
      "w123abc",
      "ast_abcdefghij-extra",
    ]
      .map((id) => JSON.stringify(id))
      .join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ line, token }) => ({ line, token })),
    [
      { line: 1, token: "ast_abcdefghijé" },
      { line: 2, token: "w123456é" },
      { line: 3, token: "rev_12345é" },
      { line: 4, token: "w123abc" },
      { line: 5, token: "ast_abcdefghij-extra" },
    ],
  );
});

test("does not mistake unrelated words and identifiers for IDs", async () => {
  const rootDir = await makeRepository({
    "packages/core/src/unrelated.ts": [
      "latest_value",
      "workflow123",
      "preview_12",
      "draw123frames",
      "astrology",
      "$ast_BAD",
      "$w123",
      "$rev_12",
      "éast_BAD",
    ]
      .map((value) => JSON.stringify(value))
      .join("\n"),
  });

  assert.deepEqual(await checkConventions({ rootDir }), []);
});

test("checks ID-shaped string values without flagging ordinary code identifiers", async () => {
  const rootDir = await makeRepository({
    "packages/core/src/identifiers.ts": [
      "const job_id = 1;",
      "const beat_index = 2;",
      "const pre_render = true;",
      "const malformed = 'ast_BAD';",
    ].join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ line, token }) => ({ line, token })),
    [{ line: 4, token: "ast_BAD" }],
  );
});

test("handles escaped quotes and preserves ID diagnostic columns", async () => {
  const lines = [
    "malformed = 'escaped\\' ast_BAD'",
    'const word = "escaped\\" w123"',
    "const revision = `escaped\\` rev_12`",
  ];
  const rootDir = await makeRepository({
    "packages/core/src/escapes.ts": lines.join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ column, line, token }) => ({ column, line, token })),
    [
      { column: lines[0].indexOf("ast_BAD") + 1, line: 1, token: "ast_BAD" },
      { column: lines[1].indexOf("w123") + 1, line: 2, token: "w123" },
      { column: lines[2].indexOf("rev_12") + 1, line: 3, token: "rev_12" },
    ],
  );
});

test("reports IDs in multiline template literal text with source locations", async () => {
  const lines = ["const message = `first line", "  ast_BAD", "last line`;"];
  const rootDir = await makeRepository({
    "packages/core/src/template.ts": lines.join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ column, line, token }) => ({ column, line, token })),
    [{ column: 3, line: 2, token: "ast_BAD" }],
  );
});

test("does not scan code identifiers inside template interpolation as literal text", async () => {
  const rootDir = await makeRepository({
    "packages/core/src/template.ts":
      "const message = `job is ${job_id}`;\n",
  });

  assert.deepEqual(await checkConventions({ rootDir }), []);
});

test("tracks nested template interpolation while scanning nested string values", async () => {
  const lines = [
    "const message = `outer ${ {",
    "  job_id,",
    "  nested: `inner ${job_id}` ,",
    '  note: "ast_BAD",',
    "} } tail`;",
  ];
  const rootDir = await makeRepository({
    "packages/core/src/nested-template.ts": lines.join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ column, line, token }) => ({ column, line, token })),
    [
      {
        column: lines[3].indexOf("ast_BAD") + 1,
        line: 4,
        token: "ast_BAD",
      },
    ],
  );
});

test("masks JavaScript regex literals without hiding following code", async () => {
  const lines = [
    String.raw`const matcher = /[\/"']/giu; ProjectsStore;`,
    "const quotient = total / ProjectsStore;",
    "const result = `match ${/}/.test(value) ? ProjectsStore : ProjectState}`;",
  ];
  const rootDir = await makeRepository({
    "packages/core/src/regex.ts": lines.join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ column, line, token }) => ({ column, line, token })),
    lines.map((line, index) => ({
      column: line.indexOf("ProjectsStore") + 1,
      line: index + 1,
      token: "ProjectsStore",
    })),
  );
});

test("recognizes regex literals after exact expression-leading keywords", async () => {
  const keywords = [
    "return",
    "throw",
    "yield",
    "await",
    "case",
    "delete",
    "typeof",
    "void",
    "new",
    "in",
    "of",
    "instanceof",
  ];
  const lines = [
    ...keywords.map((keyword) => {
      const prefix = ["in", "of", "instanceof"].includes(keyword)
        ? `value ${keyword}`
        : keyword;
      const suffix = keyword === "case" ? ":" : ";";
      return `${prefix} /["']/${suffix} ProjectsStore;`;
    }),
    "returning / ProjectsStore;",
  ];
  const rootDir = await makeRepository({
    "packages/core/src/keyword-regex.ts": lines.join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ column, line, token }) => ({ column, line, token })),
    lines.map((line, index) => ({
      column: line.indexOf("ProjectsStore") + 1,
      line: index + 1,
      token: "ProjectsStore",
    })),
  );
});

test("separates Python f-string replacement fields from literal text", async () => {
  const lines = [
    'message = f"job {job_id} {ProjectsStore}"',
    'raw_message = fr"job {job_id} {ProjectsStore}"',
    'reverse_raw = RF"job {job_id} {ProjectsStore}"',
    'escaped = F"literal {{ast_BAD}}"',
    'plain = "job_id"',
  ];
  const rootDir = await makeRepository({
    "workers/mlworker/fstrings.py": lines.join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ column, kind, line, token }) => ({
      column,
      kind,
      line,
      token,
    })),
    [
      {
        column: lines[0].indexOf("ProjectsStore") + 1,
        kind: "service-name",
        line: 1,
        token: "ProjectsStore",
      },
      {
        column: lines[1].indexOf("ProjectsStore") + 1,
        kind: "service-name",
        line: 2,
        token: "ProjectsStore",
      },
      {
        column: lines[2].indexOf("ProjectsStore") + 1,
        kind: "service-name",
        line: 3,
        token: "ProjectsStore",
      },
      {
        column: lines[3].indexOf("ast_BAD") + 1,
        kind: "id",
        line: 4,
        token: "ast_BAD",
      },
      {
        column: lines[4].indexOf("job_id") + 1,
        kind: "id",
        line: 5,
        token: "job_id",
      },
    ],
  );
});

test("handles multiline triple-quoted Python strings and f-strings", async () => {
  const lines = [
    'message = f"""job {job_id}',
    '{ProjectsStore}"""',
    "single = rf'''job {job_id} {ProjectsStore}'''",
    'plain = """ast_BAD"""',
    String.raw`escaped = F"""escaped \""" literal {{ast_BAD}}"""`,
  ];
  const rootDir = await makeRepository({
    "workers/mlworker/triple_fstrings.py": lines.join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ column, kind, line, token }) => ({
      column,
      kind,
      line,
      token,
    })),
    [
      {
        column: lines[1].indexOf("ProjectsStore") + 1,
        kind: "service-name",
        line: 2,
        token: "ProjectsStore",
      },
      {
        column: lines[2].indexOf("ProjectsStore") + 1,
        kind: "service-name",
        line: 3,
        token: "ProjectsStore",
      },
      {
        column: lines[3].indexOf("ast_BAD") + 1,
        kind: "id",
        line: 4,
        token: "ast_BAD",
      },
      {
        column: lines[4].indexOf("ast_BAD") + 1,
        kind: "id",
        line: 5,
        token: "ast_BAD",
      },
    ],
  );
});

test("does not scan comments or string contents for service identifiers", async () => {
  const rootDir = await makeRepository({
    "packages/core/src/comments.ts": [
      "// don't use ast_BAD",
      "/* 'w123' */",
      "// ProjectsStore",
      'const note = "ProjectsStore";',
    ].join("\n"),
    "workers/mlworker/comments.py": [
      "# don't use rev_12",
      "# 'ast_BAD'",
      "# ProjectsStore",
    ].join("\n"),
  });

  assert.deepEqual(await checkConventions({ rootDir }), []);
});

test("exempts anchored Part 0 validator pattern strings", async () => {
  const rootDir = await makeRepository({
    "packages/core/src/patterns.ts": [
      "^ast_[a-z2-7]{10}$",
      String.raw`^w\d{6}$`,
      String.raw`^rev_\d{5}$`,
    ]
      .map((pattern) => JSON.stringify(pattern))
      .join("\n"),
  });

  assert.deepEqual(await checkConventions({ rootDir }), []);
});

test("ignores local Python environments, installers, caches, and locks", async () => {
  const rootDir = await makeRepository({
    "workers/mlworker/__pycache__/bad.pyc": "ast_BAD\n",
    "workers/mlworker/.pytest_cache/bad.txt": "w123\n",
    "workers/mlworker/.venv/lib/bad.py": Buffer.alloc(100 * 1024 + 1, "x"),
    "workers/mlworker/.uv-cache/archive/bad.py": Buffer.alloc(100 * 1024 + 1, "x"),
    "workers/mlworker/.uv-python/cpython/lib/bad.py": Buffer.alloc(100 * 1024 + 1, "x"),
    "workers/mlworker/uv.lock": Buffer.alloc(100 * 1024 + 1, "x"),
  });

  assert.deepEqual(await checkConventions({ rootDir }), []);
});

test("scans ordinary source directories named cache", async () => {
  const rootDir = await makeRepository({
    "packages/render/src/cache/bad.ts": "const bad = 'ast_BAD';\n",
  });

  const violations = await checkConventions({ rootDir });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, "packages/render/src/cache/bad.ts");
  assert.equal(violations[0].token, "ast_BAD");
});

test("reports only file size for oversized files unless they are allowlisted", async () => {
  const relativePath = "packages/core/src/large.txt";
  const rootDir = await makeRepository({
    [relativePath]: Buffer.concat([
      Buffer.from("'ast_BAD'\n"),
      Buffer.alloc(100 * 1024 + 1, "x"),
    ]),
  });

  const violations = await checkConventions({ rootDir });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "file-size");
  assert.equal(violations[0].path, relativePath);

  const allowlistedViolations = await checkConventions({
    rootDir,
    allowedLargeFiles: new Set([relativePath]),
  });
  assert.equal(allowlistedViolations.length, 1);
  assert.equal(allowlistedViolations[0].kind, "id");
  assert.equal(allowlistedViolations[0].token, "ast_BAD");
});

test("accepts canonical services and legitimate PascalCase names but flags near misses", async () => {
  const rootDir = await makeRepository({
    "packages/core/src/services.ts": [
      ...CANONICAL_SERVICES,
      "ProjectState",
      "ProjectsStore",
      "Projectstore",
      "projectStore",
    ].join("\n"),
  });

  const violations = await checkConventions({ rootDir });

  assert.deepEqual(
    violations.map(({ kind, line, token }) => ({ kind, line, token })),
    [
      {
        kind: "service-name",
        line: CANONICAL_SERVICES.length + 2,
        token: "ProjectsStore",
      },
      {
        kind: "service-name",
        line: CANONICAL_SERVICES.length + 3,
        token: "Projectstore",
      },
    ],
  );
});

test("the current source tree follows the conventions", async () => {
  const rootDir = path.resolve(import.meta.dirname, "..");

  assert.deepEqual(await checkConventions({ rootDir }), []);
});
