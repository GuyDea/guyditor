# Assembly inputs v2: context files and local-CLI providers — design

**Date:** 2026-10-27
**Status:** reviewed draft, awaiting creator approval
**Builds on:** `2026-10-27-ai-assembly-design.md` (merged to `main` at `2bb1fe1`), amendment 008
**Spec parts touched:** 4 (transcript evidence), 9 (adapters, audit, cost, data boundaries), 10 (UI)

## 1. Intent

Two extensions to the assembly feature, asked for after the first look at it:

1. **Context files.** The creator wants to hand the model *anything* that helps it
   understand the footage — the script, but also an outline, a previous episode's
   script, a shot list, a storyboard image, a PDF — through an ordinary multi-file
   picker, and then talk about those files in the chat by a short label ("use F2 for
   the order"). Non-text files are sent to the model too, not just listed.
2. **Local CLI as a provider.** Instead of an API key, a provider can be reached through
   the CLI already logged in on the machine: `claude` (Claude Code) for Anthropic,
   `codex` for OpenAI. Same chat, same plan, no key, no per-token bill.

The require-a-project change (welcome screen stays until a project is open) is a
separate small fix, not part of this design.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. Add any number of files to a session through a native multi-select picker (and the
  typed path row); each gets a stable label `F1, F2, …`; clips keep `A1, A2, …`; both
  label sets are visible in the panel and used by the model.
- G2. Text-like files go to the model inline; images and PDFs go as native image/document
  inputs; everything else is listed by name only, with a notice at attach time.
- G3. The script role survives: one file (default: the first Markdown file with quoted
  paragraphs) drives take-to-script-block matching; the creator can change or clear it.
- G4. A provider can be connected via **API key** or **local CLI**; a CLI turn produces the
  same validated reply, goes through the same external-send gate, and shows up in the
  audit log; it records $0 cost and no token usage.
- G5. Clear failures: CLI missing / not logged in / timed out / returned non-JSON each
  give a one-line message in the panel; nothing hangs.

**Non-goals**

- Streaming CLI output into the panel; the turn is one shot.
- Audio or video excerpts as context (the spec's "never your footage" line still holds).
- Editing attached files inside Guyditor; re-attach to update.
- Per-file "send / don't send" toggles (v2 if asked).

**Anti-goals**

- Footage bytes leave the machine. (Attached files are the creator's explicit choice;
  footage is not.)
- A file silently dropped from what the model sees. If it is not sent, the panel says so
  on the file row and the evidence lists it as "not sent".
- A CLI session that keeps state between turns on the CLI's side (no `--continue`): every
  turn is self-contained and reproducible from the session sidecar.

## 3. Context files

### 3.1 Model

```ts
interface ContextFile {
  label: string;               // "F1", assigned on attach, never reused within a session
  name: string;                // basename as attached
  path: string;                // sidecars/context/<asb_id>/<label>-<name>, project-relative
  sha256: string; bytes: number;
  mime: string;                // sniffed from extension + magic bytes
  kind: "text" | "image" | "pdf" | "other";
  sent: boolean;               // kind !== "other" and within size caps
  role: "script" | "context";
}
```

`AssemblySession.inputs.script` is replaced by `inputs.files: ContextFile[]` plus
`inputs.script: { mode: "auto" } | { mode: "label"; label: string } | { mode: "none" }`
(default `auto`). `auto` is resolved **at prepare time** to the first `text` file whose
Markdown contains quoted paragraphs, so a file attached later still qualifies and an
explicit `none` is never undone by a later attach. Any `text` file may be chosen
explicitly; one without quoted paragraphs yields zero script blocks and a note in the
evidence. The sidecar schema `guyditor.assembly/v1` is amended in place (the feature
merged today; no real sessions exist yet — builder note: if any exist on the creator's
machine they are test runs and may be abandoned).

**Session lifecycle.** A session now exists *before* Analyze: the first **Add files…**
(or typed path, or a change of the footage checkboxes) creates a `created` session with
the current footage selection; Analyze prepares *that* session. While a session is
`created` or `failed`, files can be added/removed and the footage selection changed
(`Assembly.setAssets`); from `preparing` on, both are read-only and **Start over** is the
way to change them (it is shown for `created` sessions too).

### 3.2 Classification and caps

- `text`: extension in `md, txt, srt, vtt, json, csv, tsv, yaml, yml, html, xml, log`
  **and** the bytes decode as UTF-8; cap 200 KB per file.
- `image`: `png, jpg/jpeg, gif, webp`; cap **5 MB per file** and 8000 px on a side
  (Anthropic's API limits, the lower of the two providers; the creator can switch provider
  after attaching, so the minimum across providers governs).
- `pdf`: cap 32 MB and 100 pages; OpenAI accepts the same file as `input_file`.
- `other`: everything else, listed only.
- Per-turn total of **raw** sent bytes: 20 MB (≈ 27 MB after base64, leaving room for the
  evidence text and history under Anthropic's 32 MB request limit); attaching beyond it
  is refused with the running total shown. The builder verifies the current published
  limits of both providers once and records them in a comment next to the constants.
- Files are copied, never moved; the original path is not stored (only the basename).

### 3.3 In the evidence package

A new section after `## Script`:

```
## Context files
### F1  outline.md   text   1,240 words   role: context
<inline text>
### F2  storyboard.png   image   1.1 MB   (attached as an image input)
### F3  budget.xlsx   other   40 KB   (not sent — unsupported type)
```

The script file keeps its `## Script` rendering (blocks `S001…`) **and** appears in the
list with `role: script` so the model can cite it as F-something too. The system prompt
gains one paragraph: what `A`, `C`, `S`, `F` labels mean, that `F` files are the creator's
reference material, and that the creator may refer to them by label.

### 3.4 Provider request shapes

`LlmMessage.content` becomes `LlmContentPart[]`:

```ts
type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: Uint8Array; label: string }
  | { type: "pdf"; mime: "application/pdf"; data: Uint8Array; label: string; name: string };
```

- Anthropic: `image` → `{ type: "image", source: { type: "base64", media_type, data } }`;
  `pdf` → `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`;
  each preceded by a text part `F2 (storyboard.png):`.
- OpenAI Responses: `image` → `{ type: "input_image", image_url: "data:<mime>;base64,…" }`;
  `pdf` → `{ type: "input_file", filename, file_data: "data:application/pdf;base64,…" }`.
- Attachments ride on the **first user message only** (with the evidence text); later
  turns resend the full history, so they are sent on every turn. The session sidecar
  stores labels and hashes, not bytes; bytes are re-read from `sidecars/context/` at send.
- Cost estimate: text as today; each image counts as 1,600 input tokens, each PDF page as
  2,000 (coarse, documented in the panel's hover text); CLI providers estimate $0.

### 3.5 Panel

- Inputs region: a **Add files…** button (native multi-select picker) next to the typed
  path row; a file list with rows `F1  outline.md  text  1.2 KB` and a remove button; a
  **Script** dropdown listing the text files (`none` allowed); the footage rows show their
  `A1…` labels. Test ids: `assembly-add-files`, `assembly-file-<label>`,
  `assembly-file-remove-<label>`, `assembly-script-select`, `assembly-asset-label-<id>`.
- The external-send notice becomes: *"Sends the transcript, the conversation and the
  files you attach to <provider>. Never your footage."*
- Files can be added or removed only while the session is `created` or `failed` (before
  Analyze); afterwards the list is read-only and **Start over** is the way to change it.

### 3.6 IPC

- `Assembly.pickContextFiles {}` → native dialog (`openFile`, `multiSelections`), returns
  the chosen absolute paths (main-process callback like `chooseMedia`).
- `Assembly.addFiles { sessionId, paths: string[] }` → view; `Assembly.removeFile
  { sessionId, label }` → view; `Assembly.setScript { sessionId, script: { mode, label? } }`
  → view; `Assembly.setAssets { sessionId, assetIds }` → view (allowed in `created`/`failed`).
- `create { assetIds }` no longer takes `scriptPath`; the panel creates the session on the
  first input change, then adds files. (The e2e keeps using the typed path row via
  `addFiles`.)

## 4. Local CLI providers

### 4.1 Settings

```ts
ai: {
  provider: "anthropic" | "openai";
  transport: { anthropic: "api" | "cli"; openai: "api" | "cli" };   // new, default "api"
  cli: { claudePath: string; codexPath: string };                   // new, default "claude" / "codex" (resolved on PATH)
  …existing keys
}
```

The settings section gets, per provider, a **Connect via** radio (API key / local CLI),
the key field shown only for API key, and a **Check** button for CLI that runs
`<cli> --version` and reports the version or the failure.

### 4.2 Adapters

Two new `LlmAdapter`s in `packages/agent/src/llm/`: `ClaudeCliAdapter`, `CodexCliAdapter`.
`createLlmAdapter(provider, options)` grows `options.transport`; the CLI adapters take
`{ binary, cwd, timeoutMs (300 000), spawn? }` with `spawn` injectable for tests.

**Envelope (data boundary).** The CLI must see exactly what the API would see: the
evidence/conversation text and the attached files. So both CLIs run with the session's
context directory `sidecars/context/<asb_id>/` as their working directory and only that
directory readable — never the project root (transcripts, other sessions, the master file)
and never the web. Claude: `--tools Read` (Read is the only way a one-shot `claude -p`
can look at an image or PDF; stdin is text) with no `--add-dir` beyond cwd; Codex:
`-C <contextDir> --sandbox read-only`. If a CLI cannot be confined this way in a tested
configuration, the builder reports it rather than widening the envelope.

**Claude Code CLI** (`claude 2.1.x`): one invocation per turn:
`claude -p --bare --no-session-persistence --tools Read --output-format json
--json-schema <schema> --model <model> --effort <low|medium|high|max>
--append-system-prompt-file <tmp>` with the conversation rendered to a single text prompt
on stdin (turns prefixed `Creator:` / `Assistant:` / `Validation:`), images and PDFs
referenced by their file name in cwd with an instruction to read them. The JSON envelope's
structured result is the reply; a missing or non-conforming result →
`LlmAdapterError("claude returned no structured reply", null, true)`.

**Codex CLI** (`codex-cli 0.159.x`): `codex exec --ephemeral --skip-git-repo-check
--sandbox read-only -C <contextDir> -m <model> -c model_reasoning_effort=<effort>
--output-schema <tmp schema> -o <tmp out> -i <image>… "<prompt>"`; the prompt carries the
system prompt, the rendered conversation and the PDF/text file names (PDFs by path only —
Codex has no PDF input; the evidence notes `(attached by path for CLI providers)`). The
last message file is parsed as the reply.

Common rules: the schema handed to the CLI is the same strict schema the OpenAI adapter
uses (wrapped `{ reply }`); stdout/stderr are captured, truncated to 64 KB, and included in the error on
failure; a non-zero exit or the timeout maps to a clear `LlmAdapterError` whose message
starts with `claude:` / `codex:`; `ENOENT` → *"<cli> not found — install it or set its path
in AI settings"*; an auth-looking failure (exit code with "login" / "unauthorized" in
output) → *"<cli> is not logged in — run `<cli>` once in a terminal"*. `listModels()` for
CLI transports returns the pricing table's known models for that provider (the CLIs have
no list command we can rely on).

### 4.3 Gates, audit, cost

- The external-send gate (`network.externalCalls`) applies unchanged: the CLI sends the
  same text to the same company.
- `CostMeter.preflight` is called with amount 0, `confidence: "quote"` (the cost of a
  CLI turn is not knowable up front). `record` uses **what the CLI reports** when it
  reports anything: `claude --output-format json` returns `usage` and `total_cost_usd`,
  which are recorded as-is (so a creator whose CLI bills through an API key sees the real
  number); Codex reports nothing and records 0. The spawned environment is passed through
  unchanged — Guyditor does not strip `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, because some
  creators run the CLIs on key auth. Provider in the audit record is `claude-cli` /
  `codex-cli`, purpose `assembly`, data classes `prompt`, `transcript`, plus `frames`
  when images or PDFs are attached (the closest existing class). The panel's usage line
  shows the reported cost, or "via claude (no cost reported)" when it is zero.
- Effort maps to the CLI's own flag (Claude: `--effort`, Codex: `model_reasoning_effort`;
  `max` → Codex `xhigh`).

### 4.4 Stub

`GUYDITOR_ASSEMBLY_STUB=1` keeps using the stub for both transports; the CLI adapters are
unit-tested with an injected `spawn` that replays canned stdout/exit codes (success,
non-JSON, ENOENT, non-zero exit, timeout).

## 5. Testing

- Transcript: `ContextFile` classification (extension + magic + UTF-8), caps, evidence
  section rendering (snapshot updated), prompt paragraph.
- Agent: content-part mapping for both API adapters (image + PDF parts, order, base64),
  both CLI adapters with injected spawn (the five failure classes above plus a success
  that returns the structured reply), `listModels` for CLI transports.
- App main: `addFiles`/`removeFile`/`setScript` (copy, hash, label monotonic, caps refused
  with the right message, read-only after prepare), `pickContextFiles` via the injected
  dialog callback, session sidecar round-trip with files, `send` re-reading bytes and
  passing parts, transport selection from settings, `Check` CLI button.
- Renderer: file rows and labels, script dropdown, add/remove disabled after prepare,
  the new notice text, Connect-via controls.
- e2e: the assembly fixture gains a second context file (a small PNG) and the spec
  attaches both through the typed path row, asserts the labels, and reaches a plan with
  the stub.
- Manual dogfood with both CLIs on ep001, recorded in `docs/dogfood/`.

## 6. Left to the builder

- Exact magic-byte sniffing library or hand-rolled checks; the token estimates per image/page.
- How the rendered conversation text for CLIs is formatted, as long as a validation turn
  is distinguishable.
- Whether `claude` reads PDFs natively via the path or needs the `Read` tool prompt; test
  once live and document.
- Layout of the file list inside the existing panel CSS.

## Addendum: rate table hidden

Added 2026-10-27 at the creator's request. The editable per-model rate table leaves the AI
settings section; nothing else in that section changes. The pre-send cost gate ("Confirm $…")
keeps working from the built-in `DEFAULT_LLM_RATES`, and `ai.rates` stays in `settings.json`
(still accepted by `AiSettings.update`) so the gate has its numbers; it is simply not exposed.
