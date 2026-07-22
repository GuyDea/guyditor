import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RANDOM_ID_PREFIXES = Object.freeze([
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

export const CANONICAL_SERVICES = Object.freeze([
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

export const MAX_FILE_SIZE_BYTES = 100 * 1024;
export const LARGE_FILE_ALLOWLIST = new Set();

const SOURCE_ROOTS = ["packages", "workers"];
const IGNORED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".guyditor",
  ".pytest_cache",
  ".turbo",
  ".uv-cache",
  ".uv-python",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
]);
const IGNORED_FILE_NAMES = new Set(["uv.lock"]);
const CANONICAL_SERVICE_SET = new Set(CANONICAL_SERVICES);
const RANDOM_PREFIX_PATTERN = RANDOM_ID_PREFIXES.join("|");
const JS_IDENTIFIER_CONTINUE = String.raw`\p{ID_Continue}$_\u200C\u200D`;
const JS_IDENTIFIER_CONTINUE_AT_END = new RegExp(
  `[${JS_IDENTIFIER_CONTINUE}]$`,
  "u",
);
const ID_CANDIDATE_CONTINUE = `${JS_IDENTIFIER_CONTINUE}-`;
const RANDOM_ID_CANDIDATE = new RegExp(
  `(?<![${JS_IDENTIFIER_CONTINUE}])(?:${RANDOM_PREFIX_PATTERN})_[${ID_CANDIDATE_CONTINUE}]*`,
  "gu",
);
const VALID_RANDOM_ID = new RegExp(
  `^(?:${RANDOM_PREFIX_PATTERN})_[a-z2-7]{10}$`,
);
const WORD_ID_CANDIDATE = new RegExp(
  `(?<![${JS_IDENTIFIER_CONTINUE}])w\\d[${ID_CANDIDATE_CONTINUE}]*`,
  "gu",
);
const VALID_WORD_ID = /^w\d{6}$/;
const REVISION_ID_CANDIDATE = new RegExp(
  `(?<![${JS_IDENTIFIER_CONTINUE}])rev_[${ID_CANDIDATE_CONTINUE}]*`,
  "gu",
);
const VALID_REVISION_ID = /^rev_\d{5}$/;
const PASCAL_CASE_IDENTIFIER = new RegExp(
  `(?<![${JS_IDENTIFIER_CONTINUE}])[A-Z][${JS_IDENTIFIER_CONTINUE}]*`,
  "gu",
);
const JAVASCRIPT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);
const REGEX_LEADING_KEYWORDS = new Set([
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
]);

function normalizeRepoPath(filePath) {
  return path.posix.normalize(filePath.split(path.sep).join("/"));
}

async function collectFiles(rootDir) {
  const files = [];

  async function walk(absoluteDirectory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const relativePath = normalizeRepoPath(
        path.join(relativeDirectory, entry.name),
      );
      const absolutePath = path.join(absoluteDirectory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          await walk(absolutePath, relativePath);
        }
      } else if (entry.isFile() && !IGNORED_FILE_NAMES.has(entry.name)) {
        files.push({ absolutePath, relativePath });
      }
    }
  }

  for (const sourceRoot of SOURCE_ROOTS) {
    await walk(path.join(rootDir, sourceRoot), sourceRoot);
  }

  return files;
}

function editDistanceAtMostOne(left, right) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;

  if (shorter.length === longer.length) {
    let differences = 0;
    for (let index = 0; index < shorter.length; index += 1) {
      if (shorter[index] !== longer[index]) differences += 1;
      if (differences > 1) return false;
    }
    return true;
  }

  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      longIndex += 1;
    }
  }

  return true;
}

function closestCanonicalService(identifier) {
  if (CANONICAL_SERVICE_SET.has(identifier)) return undefined;
  return CANONICAL_SERVICES.find((service) =>
    editDistanceAtMostOne(identifier, service),
  );
}

function lexerOptions(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    hashComments: PYTHON_EXTENSIONS.has(extension),
    pythonStrings: PYTHON_EXTENSIONS.has(extension),
    slashComments: JAVASCRIPT_EXTENSIONS.has(extension),
  };
}

function isAnchoredPattern(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("^") && trimmed.endsWith("$");
}

function lexSource(source, { hashComments, pythonStrings, slashComments }) {
  const codeMask = new Array(source.length).fill(" ");
  const literals = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n" || source[index] === "\r") {
      codeMask[index] = source[index];
    }
  }

  function addLiteral(start, end) {
    const text = source.slice(start, end);
    if (text.length > 0 && !isAnchoredPattern(text)) {
      literals.push({ start, text });
    }
  }

  function skipLineComment(start) {
    const newline = source.indexOf("\n", start);
    return newline === -1 ? source.length : newline;
  }

  function skipBlockComment(start) {
    const closing = source.indexOf("*/", start + 2);
    return closing === -1 ? source.length : closing + 2;
  }

  function scanRegex(start) {
    let cursor = start + 1;
    let inCharacterClass = false;

    while (cursor < source.length) {
      const character = source[cursor];
      if (character === "\n" || character === "\r") return undefined;
      if (character === "\\") {
        cursor += cursor + 1 < source.length ? 2 : 1;
      } else if (character === "[" && !inCharacterClass) {
        inCharacterClass = true;
        cursor += 1;
      } else if (character === "]" && inCharacterClass) {
        inCharacterClass = false;
        cursor += 1;
      } else if (character === "/" && !inCharacterClass) {
        cursor += 1;
        while (/[A-Za-z]/.test(source[cursor] ?? "")) cursor += 1;
        return cursor;
      } else {
        cursor += 1;
      }
    }

    return undefined;
  }

  function scanQuoted(start, quote, delimiterLength = 1) {
    const delimiter = quote.repeat(delimiterLength);
    const contentStart = start + delimiterLength;
    let cursor = contentStart;

    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += cursor + 1 < source.length ? 2 : 1;
      } else if (source.startsWith(delimiter, cursor)) {
        addLiteral(contentStart, cursor);
        return cursor + delimiterLength;
      } else {
        cursor += 1;
      }
    }

    addLiteral(contentStart, source.length);
    return source.length;
  }

  function pythonFStringStart(start) {
    const firstCharacter = source[start]?.toLowerCase();
    if (
      !pythonStrings ||
      (firstCharacter !== "f" && firstCharacter !== "r") ||
      (start > 0 &&
        JS_IDENTIFIER_CONTINUE_AT_END.test(source.slice(0, start)))
    ) {
      return undefined;
    }

    for (const prefixLength of [2, 1]) {
      const prefix = source.slice(start, start + prefixLength).toLowerCase();
      const quote = source[start + prefixLength];
      if (
        (prefix === "f" || prefix === "fr" || prefix === "rf") &&
        (quote === "'" || quote === '"')
      ) {
        const quoteStart = start + prefixLength;
        const delimiterLength = source.startsWith(quote.repeat(3), quoteStart)
          ? 3
          : 1;
        return { delimiterLength, quote, quoteStart };
      }
    }

    return undefined;
  }

  function scanPythonFString(start, quote, delimiterLength) {
    const delimiter = quote.repeat(delimiterLength);
    let cursor = start + delimiterLength;
    let literalStart = cursor;

    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += cursor + 1 < source.length ? 2 : 1;
      } else if (source.startsWith(delimiter, cursor)) {
        addLiteral(literalStart, cursor);
        return cursor + delimiterLength;
      } else if (
        (source[cursor] === "{" && source[cursor + 1] === "{") ||
        (source[cursor] === "}" && source[cursor + 1] === "}")
      ) {
        cursor += 2;
      } else if (source[cursor] === "{") {
        addLiteral(literalStart, cursor);
        cursor = scanCode(cursor + 1, true);
        literalStart = cursor;
      } else {
        cursor += 1;
      }
    }

    addLiteral(literalStart, source.length);
    return source.length;
  }

  function scanTemplate(start) {
    let cursor = start + 1;
    let literalStart = cursor;

    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += cursor + 1 < source.length ? 2 : 1;
      } else if (source[cursor] === "`") {
        addLiteral(literalStart, cursor);
        return cursor + 1;
      } else if (source[cursor] === "$" && source[cursor + 1] === "{") {
        addLiteral(literalStart, cursor);
        cursor = scanCode(cursor + 2, true);
        literalStart = cursor;
      } else {
        cursor += 1;
      }
    }

    addLiteral(literalStart, source.length);
    return source.length;
  }

  function scanCode(start, stopAtTemplateBrace = false) {
    let braceDepth = 0;
    let cursor = start;
    let regexAllowed = true;

    while (cursor < source.length) {
      const character = source[cursor];
      const nextCharacter = source[cursor + 1];
      const fString = pythonFStringStart(cursor);

      if (slashComments && character === "/" && nextCharacter === "/") {
        cursor = skipLineComment(cursor + 2);
      } else if (
        slashComments &&
        character === "/" &&
        nextCharacter === "*"
      ) {
        cursor = skipBlockComment(cursor);
      } else if (hashComments && character === "#") {
        cursor = skipLineComment(cursor + 1);
      } else if (slashComments && character === "/" && regexAllowed) {
        const regexEnd = scanRegex(cursor);
        if (regexEnd !== undefined) {
          cursor = regexEnd;
          regexAllowed = false;
        } else {
          codeMask[cursor] = character;
          cursor += 1;
          regexAllowed = true;
        }
      } else if (fString) {
        cursor = scanPythonFString(
          fString.quoteStart,
          fString.quote,
          fString.delimiterLength,
        );
        regexAllowed = false;
      } else if (character === "'" || character === '"') {
        const delimiterLength =
          pythonStrings && source.startsWith(character.repeat(3), cursor)
            ? 3
            : 1;
        cursor = scanQuoted(cursor, character, delimiterLength);
        regexAllowed = false;
      } else if (character === "`") {
        cursor = scanTemplate(cursor);
        regexAllowed = false;
      } else if (stopAtTemplateBrace && character === "{") {
        codeMask[cursor] = character;
        braceDepth += 1;
        cursor += 1;
        regexAllowed = true;
      } else if (stopAtTemplateBrace && character === "}") {
        if (braceDepth === 0) return cursor + 1;
        codeMask[cursor] = character;
        braceDepth -= 1;
        cursor += 1;
        regexAllowed = false;
      } else if (/[A-Za-z_$]/.test(character)) {
        const identifierStart = cursor;
        while (/[A-Za-z0-9_$]/.test(source[cursor] ?? "")) {
          codeMask[cursor] = source[cursor];
          cursor += 1;
        }
        regexAllowed = REGEX_LEADING_KEYWORDS.has(
          source.slice(identifierStart, cursor),
        );
      } else {
        codeMask[cursor] = character;
        cursor += 1;
        if (!/\s/u.test(character)) {
          regexAllowed = "([{:;,=!?+-*%&|^~<>/".includes(character);
        }
      }
    }

    return cursor;
  }

  scanCode(0);
  return { code: codeMask.join(""), literals };
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function sourceLocation(starts, offset) {
  let lower = 0;
  let upper = starts.length;

  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (starts[middle] <= offset) lower = middle;
    else upper = middle;
  }

  return { column: offset - starts[lower] + 1, line: lower + 1 };
}

function addMatches(
  violations,
  literal,
  starts,
  pattern,
  isValid,
  describe,
) {
  for (const match of literal.text.matchAll(pattern)) {
    if (isValid(match[0])) continue;
    const location = sourceLocation(starts, literal.start + match.index);
    violations.push({
      ...location,
      kind: "id",
      message: describe(match[0]),
      token: match[0],
    });
  }
}

function inspectText(contents, filePath) {
  const violations = [];
  const starts = lineStarts(contents);
  const lexed = lexSource(contents, lexerOptions(filePath));

  for (const literal of lexed.literals) {
    addMatches(
      violations,
      literal,
      starts,
      RANDOM_ID_CANDIDATE,
      (candidate) => VALID_RANDOM_ID.test(candidate),
      (candidate) =>
        `Invalid ID "${candidate}"; expected <prefix>_[a-z2-7]{10}.`,
    );
    addMatches(
      violations,
      literal,
      starts,
      WORD_ID_CANDIDATE,
      (candidate) => VALID_WORD_ID.test(candidate),
      (candidate) => `Invalid word ID "${candidate}"; expected w plus six digits.`,
    );
    addMatches(
      violations,
      literal,
      starts,
      REVISION_ID_CANDIDATE,
      (candidate) => VALID_REVISION_ID.test(candidate),
      (candidate) =>
        `Invalid revision ID "${candidate}"; expected rev_ plus five digits.`,
    );
  }

  for (const match of lexed.code.matchAll(PASCAL_CASE_IDENTIFIER)) {
    const canonicalService = closestCanonicalService(match[0]);
    if (!canonicalService) continue;
    violations.push({
      ...sourceLocation(starts, match.index),
      kind: "service-name",
      message: `Non-canonical service-like name "${match[0]}"; did you mean "${canonicalService}"?`,
      token: match[0],
    });
  }

  return violations.sort(
    (left, right) => left.line - right.line || left.column - right.column,
  );
}

export async function checkConventions({
  rootDir = process.cwd(),
  allowedLargeFiles = LARGE_FILE_ALLOWLIST,
} = {}) {
  const normalizedAllowlist = new Set(
    [...allowedLargeFiles].map(normalizeRepoPath),
  );
  const violations = [];
  const files = await collectFiles(rootDir);

  for (const file of files) {
    let fileSize;
    try {
      fileSize = (await stat(file.absolutePath)).size;
    } catch (error) {
      violations.push({
        kind: "scan-error",
        message: `Could not stat file: ${error.message}`,
        path: file.relativePath,
      });
      continue;
    }

    if (
      fileSize > MAX_FILE_SIZE_BYTES &&
      !normalizedAllowlist.has(file.relativePath)
    ) {
      violations.push({
        kind: "file-size",
        message: `File is ${fileSize} bytes; limit is ${MAX_FILE_SIZE_BYTES} bytes.`,
        path: file.relativePath,
      });
      continue;
    }

    let contents;
    try {
      contents = await readFile(file.absolutePath);
    } catch (error) {
      violations.push({
        kind: "scan-error",
        message: `Could not read file: ${error.message}`,
        path: file.relativePath,
      });
      continue;
    }

    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");
    for (const violation of inspectText(text, file.relativePath)) {
      violations.push({ ...violation, path: file.relativePath });
    }
  }

  return violations;
}

export function formatViolation(violation) {
  const location = [violation.path, violation.line, violation.column]
    .filter((part) => part !== undefined)
    .join(":");
  return `${location}: ${violation.message}`;
}

export async function main() {
  try {
    const violations = await checkConventions();
    if (violations.length === 0) {
      console.log("Convention check passed.");
      return 0;
    }

    console.error(`Convention check failed (${violations.length} violation(s)):`);
    for (const violation of violations) {
      console.error(`- ${formatViolation(violation)}`);
    }
    return 1;
  } catch (error) {
    console.error(`Convention check could not run: ${error.message}`);
    return 1;
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) {
  process.exitCode = await main();
}
