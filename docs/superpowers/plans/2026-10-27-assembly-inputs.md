# Assembly inputs v2 (context files, local-CLI providers) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the creator attach any files (`F1…`) to an assembly session — text inline, images and PDFs as native inputs, the rest listed by name — pick which one is the script, and reach Anthropic or OpenAI through the logged-in `claude` / `codex` CLI instead of an API key, with the same validated reply, gate, audit and cost record.

**Architecture:** File classification, caps, labels and script resolution are pure functions in `packages/transcript/src/assembly/context-files.ts`; the `guyditor.assembly/v1` sidecar is amended in place (`inputs.files`, tri-state `inputs.script`, `settings.transport`). The adapter contract gains `LlmContentPart[]` messages; two CLI adapters in `packages/agent/src/llm/` run behind one injectable `spawn` seam and are confined to `sidecars/context/<asb>/`. The main process grows an `assembly-files.ts` module and five `Assembly` IPC methods; `service-host.ts` only gets the picker callback plumbing. The panel creates the session on the first input change and locks inputs from `preparing` on.

**Tech Stack:** TypeScript (strict), Electron 43, React 19, vitest (`--project unit`), Playwright e2e, Node `child_process.spawn` (injected), existing `CostMeter`/`AuditLog`/`JobQueue`.

**Spec:** `docs/superpowers/specs/2026-10-27-assembly-inputs-design.md` (approved 2026-10-27, plus the "Addendum: rate table hidden" appended with this plan). Section numbers below (§) refer to it; `AI-plan` refers to `docs/superpowers/plans/2026-10-27-ai-assembly.md`.

## Global Constraints

- Files under `packages/` stay ≤ 100 KiB (`scripts/check-conventions.mjs:49`). `packages/app/src/main/service-host.ts` is 96,935 bytes: it gets only the `chooseContextFiles` callback plumbing (Task 7, ≤ 300 bytes). New IPC methods live in `assembly-service.ts` / `ai-settings-service.ts` surfaces and `surfaces.ts` manifests; file handling goes in the new `assembly-files.ts`.
- Cross-package imports are relative source paths (`"../../../transcript/src/index.js"`), never package names.
- Ids: `isId("asb", value)` (prefix first); labels `F<n>` from `F1`, assigned on attach, never reused within a session (§3.1).
- Storage: copies at `sidecars/context/<asb_id>/<label>-<name>`, project-relative; the original path is never stored, only the basename (§3.2).
- Classification (§3.2): `text` = extension in `md, txt, srt, vtt, json, csv, tsv, yaml, yml, html, xml, log` **and** UTF-8; `image` = `png, jpg/jpeg, gif, webp`; `pdf`; else `other`. Caps: text 200 KB; image 5 MB and 8000 px per side; PDF 32 MB and 100 pages; per-turn raw sent total 20 MB (refused with the running total). A file over its own cap is attached with `sent: false` and a reason; never silently dropped.
- Evidence: `## Context files` after `## Script`, lines `### F1  outline.md   text   1,240 words   role: context` / `### F2  storyboard.png   image   1.1 MB   (attached as an image input)` / `### F3  budget.xlsx   other   40 KB   (not sent — unsupported type)` (§3.3).
- Wire shapes (§3.4): Anthropic `image`/`document` base64 blocks, OpenAI `input_image` data URL / `input_file`, each preceded by a text part `F2 (storyboard.png):`; attachments ride on the first user message only; bytes re-read from `sidecars/context/` at send. Cost estimate: image 1,600 tokens, PDF page 2,000; CLI estimate $0 (`confidence: "quote"`).
- CLI envelope (§4.2): cwd = `sidecars/context/<asb>/`; `claude -p --safe-mode --restricted --no-session-persistence --tools Read --output-format json --json-schema … --model … --effort …` (never `--bare`: it disables OAuth auth, §4.2); `codex exec --ephemeral --skip-git-repo-check --sandbox read-only -C … -m … -c model_reasoning_effort=… --output-schema … -o … -i …`; never `--continue`; environment passed through unchanged; timeout 300 000 ms; error messages start `claude:` / `codex:`; ENOENT → `<cli> not found — install it or set its path in AI settings`; auth → `<cli> is not logged in — run `<cli>` once in a terminal`; `max` → Codex `xhigh`.
- Audit (§4.3): provider `claude-cli` / `codex-cli`, purpose `assembly`, data classes `prompt`, `transcript`, plus `frames` when images or PDFs are attached; `record` uses what the CLI reports (claude `usage` + `total_cost_usd`; codex 0).
- Settings (§4.1): `ai.transport.{anthropic,openai}` default `"api"`; `ai.cli.{claudePath,codexPath}` default `"claude"` / `"codex"`; `ai.rates` stays (addendum) but has no UI.
- Copy: notice *"Sends the transcript, the conversation and the files you attach to <provider>. Never your footage."*; usage line *"via claude (no cost reported)"* when a CLI turn reports $0.
- Test ids (§3.5): `assembly-add-files`, `assembly-file-<label>`, `assembly-file-remove-<label>`, `assembly-script-select`, `assembly-asset-label-<id>`.
- `GUYDITOR_ASSEMBLY_STUB=1` selects the stub regardless of transport; no unit test spawns a real `claude` / `codex`.
- Out of scope (§2 non-goals + AI-plan deferrals): streaming CLI output, audio/video excerpts, editing attached files, per-file send toggles, reasoning-budget cost estimate, per-session external ack, "Waiting for <model>", markers outside proposals, filler compile ordering.
- Before every commit: `pnpm exec vitest run --project unit <changed test files>`, `pnpm --filter @guyditor/<pkg> typecheck && pnpm --filter @guyditor/<pkg> lint` for each touched package, `pnpm check:conventions`. Shell-outs to Electron/Playwright use `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`.

## Review Focus

1. Two attached files with the same basename (`notes.md` from two folders) — both stored under distinct `<label>-<name>` paths and both listed; removing one leaves the other. → test in Task 7.
2. A `.txt`/`.md` that is not UTF-8 (Latin-1) — classified `other` with reason `not valid UTF-8`, never inlined as garbage. → test in Task 1.
3. An image whose extension lies (`.png` holding JPEG bytes, or random bytes) — mime follows the magic bytes; unknown bytes become `other`, never an image input the provider rejects. → test in Task 1.
4. Removing the explicitly selected script file — `script` falls back to `{ mode: "auto" }`; prepare never dereferences a dangling label. → test in Task 7.
5. A context file deleted from `sidecars/context/` after attach — `send` fails with `E_ASSEMBLY_FILE_MISSING` naming the label, the session stays `conversing` and a later send works. → test in Task 8.

---

### Task 1: Context file classification, caps, labels, script resolution

**Files:**
- Create: `packages/transcript/src/assembly/context-files.ts`, `context-files.test.ts`
- Modify: `packages/transcript/src/assembly/types.ts` (append the types below), `packages/transcript/src/assembly/index.ts` (export `./context-files.js`)

**Interfaces (Produces):**
```ts
// types.ts
export type ContextFileKind = "text" | "image" | "pdf" | "other";
export interface ContextFile {
  label: string; name: string; path: string; sha256: string; bytes: number; mime: string;
  kind: ContextFileKind; sent: boolean; unsentReason: string | null; pages: number | null; role: "script" | "context";
}
export type ScriptChoice = { mode: "auto" } | { mode: "label"; label: string } | { mode: "none" };
// context-files.ts
export const CONTEXT_FILE_CAPS: Readonly<{ textBytes: 204_800; imageBytes: 5_242_880; imagePx: 8000; pdfBytes: 33_554_432; pdfPages: 100; turnBytes: 20_971_520 }>; // comment beside it cites the provider limit pages checked today (Anthropic vision 5 MB / 8000 px, PDF 32 MB / 100 pages, request 32 MB; OpenAI PDF 32 MB / 100 pages)
export const TEXT_EXTENSIONS: ReadonlySet<string>; export const IMAGE_EXTENSIONS: ReadonlySet<string>;
export interface Classified { kind: ContextFileKind; mime: string; pages: number | null; sent: boolean; unsentReason: string | null }
export function classifyContextFile(name: string, bytes: Uint8Array): Classified;
export function sniffImageSize(bytes: Uint8Array): { width: number; height: number } | null; // PNG IHDR; JPEG SOF0/SOF2; GIF logical screen; WebP VP8/VP8L/VP8X
export function countPdfPages(bytes: Uint8Array): number;      // occurrences of /\/Type\s*\/Page(?![s])/g, minimum 1
export function isUtf8(bytes: Uint8Array): boolean;             // TextDecoder("utf-8", { fatal: true })
export function hasQuotedParagraphs(markdown: string): boolean; // any line whose trimmed form starts with ">"
export function resolveScript(files: readonly ContextFile[], choice: ScriptChoice, textOf: (file: ContextFile) => string): ContextFile | null;
export function contextFilePath(sessionId: string, label: string, name: string): string; // sidecars/context/<id>/<label>-<name>
export function sentBytesTotal(files: readonly ContextFile[]): number;                   // sum of bytes where sent
export function formatBytes(bytes: number): string;                                       // "1.2 KB" below 10 KB, "40 KB" below 1 MB, "1.1 MB" above
```
Rules: kind by extension first; `image`/`pdf` confirmed by magic bytes (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF8`, WebP `RIFF…WEBP`, PDF `%PDF-`) and the sniffed type wins over the extension; no recognised magic → `other`. `text` extension that is not UTF-8 → `other` with `unsentReason: "not valid UTF-8"`; other `other` → `"unsupported type"`. Caps set `sent: false` with reason `"over 200 KB"`, `"over 5 MB"`, `"over 8000 px"`, `"over 32 MB"`, `"over 100 pages"`. Mime for text kinds from a constant map (md → `text/markdown`, txt/log → `text/plain`, the rest their IANA type); `other` → `application/octet-stream`. `resolveScript`: `none` → null; `label` → that file if it exists and is `text`, else null; `auto` → the first `text` file in label order with `hasQuotedParagraphs(textOf(file))`, else null.

- [ ] **Step 1: Failing tests** in `context-files.test.ts` (build bytes by hand: a PNG header with a chosen IHDR width/height, `FF D8 FF E0`, `%PDF-1.4` plus N `/Type /Page` objects, Latin-1 `[0xE9, 0x20, 0x61]`):
  - `classifies by extension, magic bytes and UTF-8` — `outline.md` → `{ kind: "text", mime: "text/markdown", sent: true, unsentReason: null, pages: null }`; `s.png` (PNG magic) → image `image/png`; `d.pdf` with 3 page objects → pdf, `pages === 3`; `b.xlsx` → other, `sent === false`, reason `"unsupported type"`.
  - `a text extension that is not UTF-8 is other, not garbage` (Review Focus 2) — `notes.txt` Latin-1 bytes → `kind === "other"`, `unsentReason === "not valid UTF-8"`.
  - `trusts magic bytes over the extension` (Review Focus 3) — `x.png` with JPEG magic → `{ kind: "image", mime: "image/jpeg" }`; `y.png` with bytes `[1,2,3,4]` → `kind === "other"`.
  - `caps mark files as not sent with the reason` — text of 204_801 bytes → `"over 200 KB"`; PNG header width 8001 → `"over 8000 px"`; PDF with 101 page objects → `"over 100 pages"`.
  - `reads image dimensions from PNG, JPEG, GIF and WebP headers` — one synthetic header each → expected `{ width, height }`; garbage → null.
  - `resolveScript picks the first quoted markdown in auto and honours label and none` — files F1 `notes.txt` (no quotes), F2 `script.md` (quotes), F3 `outline.md` (quotes): auto → F2; `{ mode: "label", label: "F3" }` → F3; label of an image → null; none → null.
  - `paths, totals and sizes` — `contextFilePath("asb_aaaaaaaaaa", "F2", "a b.png") === "sidecars/context/asb_aaaaaaaaaa/F2-a b.png"`; `sentBytesTotal` ignores unsent files; `formatBytes(1229) === "1.2 KB"`, `formatBytes(40_960) === "40 KB"`, `formatBytes(1_153_434) === "1.1 MB"`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/transcript/src/assembly/context-files.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** (hand-rolled sniffing, no new dependency).
- [ ] **Step 4: Run** the test file + `pnpm --filter @guyditor/transcript typecheck && pnpm --filter @guyditor/transcript lint && pnpm check:conventions` — PASS.
- [ ] **Step 5: Commit** — `git add packages/transcript/src/assembly/{context-files.ts,context-files.test.ts,types.ts,index.ts}` — `feat(transcript): classify and cap assembly context files`

---

### Task 2: `LlmContentPart` messages, provider mappings, stub, prompt paragraph, known models

**Files:**
- Modify: `packages/agent/src/llm/types.ts:6-21`, `anthropic.ts:20-40`, `openai.ts:54-89`, `stub.ts:115-123`, `assembly-prompt.ts:14-16`, `pricing.ts` (append), `anthropic.test.ts`, `openai.test.ts`, `stub.test.ts`, `pricing.test.ts`, `assembly-prompt.test.ts`
- Modify (call sites of the changed contract): `packages/app/src/main/assembly-turn.ts:39-49`, `assembly-service.ts:347-350`, `assembly-turn.test.ts`

**Interfaces (Produces):**
```ts
export type LlmRole = "user" | "assistant" | "validation";   // API adapters send "validation" as "user"
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: Uint8Array; label: string; name: string }
  | { type: "pdf"; mime: "application/pdf"; data: Uint8Array; label: string; name: string };
export interface LlmMessage { role: LlmRole; content: LlmContentPart[] }
export function textMessage(role: LlmRole, text: string): LlmMessage;   // one text part
export function messageText(message: LlmMessage): string;                 // text parts joined with "\n"; binary parts contribute nothing
export interface LlmCompletion { reply: unknown; usage: { inputTokens: number; outputTokens: number }; reportedUsd?: number } // set only by CLI adapters
export function knownModels(provider: "anthropic" | "openai", rates?: Readonly<Record<string, LlmRate>>): string[]; // pricing.ts: keys starting "claude-" for anthropic, the rest for openai, sorted
// assembly-turn.ts: llmMessages(session, hint) now returns LlmMessage[] of text parts; validation messages keep role "validation"
```
Mapping rule in both API adapters: a message whose parts are all text serialises as today's plain string (joined with `"\n"`), so existing request bodies and tests are unchanged; a message with any binary part serialises as an array. Anthropic: text → `{ type: "text", text }`; image → `{ type: "text", text: "F2 (storyboard.png):" }` then `{ type: "image", source: { type: "base64", media_type: mime, data } }`; pdf → caption then `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`. OpenAI: text → `{ type: "input_text", text }`; image → caption as `input_text` then `{ type: "input_image", image_url: "data:<mime>;base64,<data>" }`; pdf → caption then `{ type: "input_file", filename: name, file_data: "data:application/pdf;base64,<data>" }`. Caption format is exactly `<label> (<name>):`. Stub parses `messageText(first user message)` and counts tokens over `messageText` of every message. Prompt: under `# Evidence format` add the paragraph *"Labels: A<n> are clips, C<asset>.<nn> candidate segments, S<nnn> script blocks, F<n> context files. "## Context files" lists the creator's reference material (an outline, a shot list, a previous script, images, PDFs): text files appear inline under their heading, images and PDFs are attached as inputs captioned with their label, and anything marked "not sent" is listed by name only. The creator may refer to these files by label ("use F2 for the order"); treat them as reference material, never as footage."*

- [ ] **Step 1: Failing tests** (existing `req()` helpers switch to `textMessage("user", "hi")`; expected bodies stay):
  - types: `messageText joins text parts and skips binary parts`.
  - anthropic: `sends images and PDFs as base64 blocks captioned with their label` — parts `[text "hi", image(png, data [1,2,3], F2, storyboard.png), pdf(data [1,2,3], F3, deck.pdf)]` → `body.messages[0].content` equals `[{type:"text",text:"hi"},{type:"text",text:"F2 (storyboard.png):"},{type:"image",source:{type:"base64",media_type:"image/png",data:"AQID"}},{type:"text",text:"F3 (deck.pdf):"},{type:"document",source:{type:"base64",media_type:"application/pdf",data:"AQID"}}]`; `text-only messages stay plain strings and validation turns are sent as user`.
  - openai: `sends images as data URLs and PDFs as input_file` — `input[0].content` equals the five-part array with `input_text` / `input_image: "data:image/png;base64,AQID"` / `input_file { filename: "deck.pdf", file_data: "data:application/pdf;base64,AQID" }`.
  - stub: `reads the evidence from text parts and ignores binary parts`.
  - pricing: `knownModels splits the table by provider` — every anthropic entry starts with `claude-`, no openai entry does, both sorted.
  - prompt: contains `"F<n> context files"` and `"## Context files"`.
  - app turn: `first turn carries the evidence` now expects `[textMessage("user", "EVIDENCE\n\ngo")]`; `retries once…` expects the validation message with `role: "validation"`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/agent/src/llm packages/app/src/main/assembly-turn.test.ts` — FAIL.
- [ ] **Step 3: Implement.** In `assembly-service.ts:347-350` the history length becomes `llmMessages(...).map(messageText).join("")`.
- [ ] **Step 4: Run** Step 2 + `assembly-service.test.ts` + `pnpm --filter @guyditor/agent typecheck && lint` + `pnpm --filter @guyditor/app typecheck && lint` + conventions — PASS.
- [ ] **Step 5: Commit** — `git add packages/agent/src/llm packages/app/src/main/assembly-turn.ts packages/app/src/main/assembly-turn.test.ts packages/app/src/main/assembly-service.ts` — `feat(agent): content parts in the llm contract with image and pdf inputs`

---

### Task 3: CLI process seam — `runCli`, failure classes, `cliVersion`

**Files:**
- Create: `packages/agent/src/llm/cli-process.ts`, `cli-process.test.ts`, `packages/agent/src/llm/__fixtures__/fake-spawn.ts`
- Modify: `packages/agent/src/llm/index.ts` (export `./cli-process.js`)

**Interfaces (Produces):**
```ts
export type CliName = "claude" | "codex";
export interface CliChild { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null; stdin: NodeJS.WritableStream | null; kill(signal?: NodeJS.Signals): boolean; on(event: "error", l: (e: NodeJS.ErrnoException) => void): this; on(event: "close", l: (code: number | null, signal: NodeJS.Signals | null) => void): this }
export type SpawnFn = (binary: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CliChild; // default: node:child_process spawn with stdio "pipe"
export const CLI_TIMEOUT_MS = 300_000; export const CLI_OUTPUT_EXCERPT = 65_536;
export interface CliRun { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean } // streams captured in full
export function runCli(input: { name: CliName; binary: string; args: readonly string[]; cwd: string; stdin?: string; timeoutMs?: number; spawn?: SpawnFn; env?: NodeJS.ProcessEnv }): Promise<CliRun>; // writes+ends stdin; on timeout kill("SIGTERM") and resolve timedOut; spawn "error" ENOENT → rejects LlmAdapterError(`${name} not found — install it or set its path in AI settings`, null, false); other spawn errors → LlmAdapterError(`${name}: ${message}`, null, true)
export function failureError(name: CliName, run: CliRun): LlmAdapterError; // timedOut → `${name}: timed out after ${s} s` retryable; /not logged in|unauthorized|please run \/login|run codex login/i in stdout+stderr → `${name} is not logged in — run \`${name}\` once in a terminal` non-retryable; else `${name}: exited with code ${code}\n${last 64 KB of stderr, then stdout}` retryable
export function cliVersion(binary: string, name: CliName, spawn?: SpawnFn): Promise<{ ok: true; version: string } | { ok: false; message: string }>; // `<binary> --version`, 10 000 ms; version = first stdout line trimmed; failures → message from the error above
// __fixtures__/fake-spawn.ts
export interface FakeRun { stdout?: string; stderr?: string; code?: number | null; error?: NodeJS.ErrnoException; hang?: boolean; onSpawn?: (binary: string, args: readonly string[], cwd: string) => void }
export interface FakeSpawn { spawn: SpawnFn; calls: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; killed: NodeJS.Signals | null }[] }
export function fakeSpawn(...runs: FakeRun[]): FakeSpawn; // each call consumes the next run: emit "error", or write stdout/stderr then "close"(code) on the next tick; hang never closes; kill() records the signal and emits close(null, signal)
```

- [ ] **Step 1: Failing tests** in `cli-process.test.ts`:
  - `captures output, exit code and stdin, and passes cwd and env through` — `runCli({ name: "claude", binary: "/x/claude", args: ["-p"], cwd: "/ctx", stdin: "hello", spawn })` → `{ code: 0, stdout: "out", stderr: "", timedOut: false }`; `calls[0]` has `binary "/x/claude"`, `args ["-p"]`, `cwd "/ctx"`, `env === process.env`, `stdin "hello"`.
  - `maps ENOENT to the not-found message` — rejects with `message === "codex not found — install it or set its path in AI settings"`, `retryable === false`.
  - `kills the child and reports a timeout` — `hang: true`, `timeoutMs: 10` → `timedOut === true`, `calls[0].killed === "SIGTERM"`; `failureError("codex", run).message` starts `"codex: timed out"`.
  - `recognises a login failure` — code 1, stderr `"Not logged in. Run codex login"` → ``"codex is not logged in — run `codex` once in a terminal"``, `retryable === false`.
  - `includes only the last 64 KB of output in a generic failure` — stderr 70 000 × `"x"` + `"END"`, code 2 → message starts `"claude: exited with code 2"`, contains `"END"`, length < 66_000, `retryable === true`.
  - `cliVersion returns the first stdout line or the failure` — `"2.1.309 (Claude Code)\n"` → `{ ok: true, version: "2.1.309 (Claude Code)" }` and `calls[0].args` equals `["--version"]`; ENOENT → `{ ok: false, message: /claude not found/ }`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/agent/src/llm/cli-process.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** + agent typecheck/lint + conventions — PASS. **Step 5: Commit** — `git add packages/agent/src/llm/{cli-process.ts,cli-process.test.ts,index.ts} packages/agent/src/llm/__fixtures__/fake-spawn.ts` — `feat(agent): injectable cli process runner with failure classes`

---

### Task 4: `ClaudeCliAdapter`, `CodexCliAdapter`, transport dispatch

**Files:**
- Create: `packages/agent/src/llm/cli-conversation.ts`, `claude-cli.ts`, `claude-cli.test.ts`, `codex-cli.ts`, `codex-cli.test.ts`
- Modify: `packages/agent/src/llm/types.ts:36-44` (options + dispatch), `index.ts` (exports)

**Interfaces:**
- Consumes: Task 3 `runCli`/`failureError`/`fakeSpawn`, Task 2 `messageText`/`knownModels`, `toOpenAiStrictSchema` (`openai.ts:29`).
- Produces:
```ts
export type LlmTransport = "api" | "cli";
export interface LlmCliOptions { binary: string; cwd: string; timeoutMs?: number; spawn?: SpawnFn; env?: NodeJS.ProcessEnv }
export interface LlmAdapterOptions { apiKey: string; fetch?: typeof fetch; baseUrl?: string; transport?: LlmTransport; cli?: LlmCliOptions }
// createLlmAdapter: transport "cli" → anthropic → ClaudeCliAdapter(options.cli), openai → CodexCliAdapter(options.cli); cli missing → LlmAdapterError("cli options missing", null, false); default "api" unchanged
export function renderCliConversation(messages: LlmMessage[]): { conversation: string; images: string[]; pdfs: string[] }; // turns as "Creator: …" / "Assistant: …" / "Validation: …" separated by blank lines; a binary part renders as "[F2 storyboard.png — see file F2-storyboard.png]"; images/pdfs list `${label}-${name}` in order
export class ClaudeCliAdapter implements LlmAdapter { readonly provider: "anthropic"; constructor(options: LlmCliOptions); complete(request): Promise<LlmCompletion>; listModels(): Promise<string[]> /* knownModels("anthropic") */ }
export class CodexCliAdapter implements LlmAdapter { readonly provider: "openai"; … listModels() /* knownModels("openai") */ }
```
Claude argv (exact): `["-p", "--safe-mode", "--restricted", "--no-session-persistence", "--tools", "Read", "--output-format", "json", "--json-schema", JSON.stringify(toOpenAiStrictSchema(request.responseSchema)), "--model", request.model, "--effort", request.effort, "--append-system-prompt", request.system]`; cwd `options.cwd`; stdin = `conversation` + (files ? `\n\nAttached files in the working directory — read each with the Read tool before answering: F2-storyboard.png (F2), F3-deck.pdf (F3)` : "") + `\n\nAnswer only through the structured output.` (`--append-system-prompt` takes the text inline: the `-file` variant is not in `claude --help` 2.1.309; the prompt is < 8 KB). Output: `JSON.parse(stdout)` fails → `LlmAdapterError("claude: returned non-JSON output\n<excerpt>", null, true)`; `is_error === true` → `LlmAdapterError("claude: " + (result ?? subtype), null, true)`; `structured_output` not an object with `reply` → `LlmAdapterError("claude returned no structured reply", null, true)`; else `{ reply: structured_output.reply, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }, reportedUsd: total_cost_usd ?? 0 }`. Non-zero exit / timeout → `failureError("claude", run)`.
Codex: temp dir `mkdtemp(join(tmpdir(), "guyditor-codex-"))` holding `schema.json` (the same wrapped strict schema) and `reply.json`, removed in `finally`; argv `["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", cwd, "-m", model, "-c", `model_reasoning_effort=${CODEX_EFFORT[effort]}`, "--output-schema", schemaPath, "-o", replyPath, ...images.flatMap((f) => ["-i", join(cwd, f)]), "-"]` (`-` = prompt on stdin, argv-size safe); `CODEX_EFFORT = { low: "low", medium: "medium", high: "high", max: "xhigh" }`; stdin = `request.system + "\n\n" + conversation` + (pdfs ? `\n\nPDF files in the working directory, by path: F3-deck.pdf (F3)` : "") + `\n\nAnswer only with JSON matching the output schema.`; reply = `JSON.parse(readFile(replyPath)).reply`, missing/empty file → `"codex returned no structured reply"`, non-JSON → `"codex: returned non-JSON output"`; `usage: { 0, 0 }`, `reportedUsd: 0`. Both: `timeoutMs ?? CLI_TIMEOUT_MS`, `env ?? process.env`.

- [ ] **Step 1: Failing tests** (fake spawn from Task 3; `SCHEMA` and `req()` as in `anthropic.test.ts`; `fakeSpawn` `onSpawn` writes `reply.json` for codex):
  - claude: `invokes claude confined to the context directory with the schema, model and effort` — `calls[0].args` equals the exact array above for `effort "high"`, `calls[0].cwd === "/ctx"`, stdin contains `"Creator: hi"` and ends with `"Answer only through the structured output."`; with an image part stdin contains `"F2-storyboard.png (F2)"` and `"Read tool"`.
  - claude: `returns the structured reply, usage and the reported cost` — stdout `{"type":"result","is_error":false,"structured_output":{"reply":{"a":"x"}},"usage":{"input_tokens":11,"output_tokens":22},"total_cost_usd":0.0123}` → `{ reply: { a: "x" }, usage: { inputTokens: 11, outputTokens: 22 }, reportedUsd: 0.0123 }`.
  - claude: `fails on non-JSON stdout, a prose-only envelope and an error envelope` — `"hello"` → `/^claude: returned non-JSON/`; `{"type":"result","result":"prose"}` → `"claude returned no structured reply"`; `{"is_error":true,"result":"boom"}` → `"claude: boom"`; all `retryable === true`.
  - claude: `maps not-found, login, exit code and timeout` — four runs → `"claude not found — install it or set its path in AI settings"`, ``"claude is not logged in — run `claude` once in a terminal"``, `/^claude: exited with code 2/`, `/^claude: timed out/`.
  - claude: `renders validation turns distinguishably` — messages user/assistant/validation → stdin contains `"Creator: go"`, `"Assistant: {"`, `"Validation: Your reply was rejected"`.
  - codex: `invokes codex exec read-only in the context directory with the schema and images` — args equal the exact array (with `-i /ctx/F2-storyboard.png`, last `"-"`), stdin starts with `"SYS\n\n"`, contains `"F3-deck.pdf (F3)"`; `schema.json` content deep-equals `toOpenAiStrictSchema(SCHEMA)`.
  - codex: `reads the reply from the output file and records zero cost` → `{ reply: { a: "x" }, usage: { inputTokens: 0, outputTokens: 0 }, reportedUsd: 0 }`; the temp directory no longer exists afterwards.
  - codex: `maps effort max to xhigh`; `fails when the output file is missing or not JSON`; `maps not-found, login, exit code and timeout` (messages with `codex`).
  - both: `lists the known models without spawning` — equals `knownModels(provider)`, `calls.length === 0`; `createLlmAdapter picks the CLI adapters for transport cli` and the API classes by default.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/agent/src/llm/claude-cli.test.ts packages/agent/src/llm/codex-cli.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm exec vitest run --project unit packages/agent/src/llm` + agent typecheck/lint + conventions — PASS. **Step 5: Commit** — `git add packages/agent/src/llm/{cli-conversation.ts,claude-cli.ts,claude-cli.test.ts,codex-cli.ts,codex-cli.test.ts,types.ts,index.ts}` — `feat(agent): claude and codex cli adapters confined to the context directory`

---

### Task 5: Settings `ai.transport` / `ai.cli`, `checkCli`, CLI model list

**Files:**
- Modify: `packages/app/src/main/settings.ts:8-14,80-86`, `ai-settings-service.ts:15-22,38-64,113-118,137-145`, `surfaces.ts:121-165`, `ai-settings-service.test.ts`, `settings.test.ts`, `surfaces.test.ts:155-164`

**Interfaces (Produces):**
```ts
export interface AiSettings { provider; model; effort; tightening; rates; transport: { anthropic: LlmTransport; openai: LlmTransport }; cli: { claudePath: string; codexPath: string } } // defaults { anthropic: "api", openai: "api" }, { claudePath: "claude", codexPath: "codex" }; mergeDefaults fills old files
export type CliCheck = { ok: true; version: string } | { ok: false; message: string };
export interface AiSettingsServiceOptions { …; spawn?: SpawnFn }
class AiSettingsService { transport(provider): LlmTransport; cliBinary(provider): string /* claudePath for anthropic, codexPath for openai */; checkCli(provider): Promise<CliCheck> /* cliVersion(cliBinary, name, spawn) */; listModels(provider) /* transport cli → knownModels(provider), no key needed */ }
// surface + manifest: update params gain transport { anthropic?, openai?: enum api|cli } and cli { claudePath?, codexPath?: string minLength 1 } (additionalProperties false); new checkCli { provider } → anyResult, budgetMs 15_000
```
`validatedPatch` rejects transport values outside `api|cli` and empty CLI paths with `E_AI_SETTINGS_INVALID`; a partial `transport`/`cli` patch merges over the current object.

- [ ] **Step 1: Failing tests:**
  - settings: `defaults transport to api and cli paths to the bare names` — `DEFAULT_SETTINGS.ai.transport` equals `{ anthropic: "api", openai: "api" }`, `.cli` equals `{ claudePath: "claude", codexPath: "codex" }`; `loadSettings` of `{"schema":1,"ai":{"provider":"openai"}}` fills both.
  - service: `persists transport and cli paths and rejects bad values` — `update({ transport: { anthropic: "cli" }, cli: { claudePath: "/opt/claude" } })` → file `ai.transport` equals `{ anthropic: "cli", openai: "api" }`, `ai.cli.claudePath === "/opt/claude"`, `ai.cli.codexPath === "codex"`; `update({ transport: { anthropic: "ssh" } })` and `update({ cli: { codexPath: "" } })` reject `/E_AI_SETTINGS_INVALID/`.
  - service: `listModels needs no key on the cli transport` — transport cli, no key → equals `knownModels("anthropic")`; api, no key → `/E_AI_KEY_MISSING/`.
  - service: `checkCli reports the version or the failure through the injected spawn` — `fakeSpawn({ stdout: "2.1.309 (Claude Code)\n", code: 0 })` → `{ ok: true, version: "2.1.309 (Claude Code)" }`, `calls[0].binary === "/opt/claude"`, `args` `["--version"]`; ENOENT → `{ ok: false, message: /claude not found/ }`.
  - surfaces: AiSettings methods sorted equal `["checkCli", "clearKey", "get", "listModels", "setKey", "update"]`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/main/ai-settings-service.test.ts packages/app/src/main/settings.test.ts packages/app/src/main/surfaces.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** + app typecheck/lint + conventions — PASS. **Step 5: Commit** — `git add packages/app/src/main/{settings.ts,settings.test.ts,ai-settings-service.ts,ai-settings-service.test.ts,surfaces.ts,surfaces.test.ts}` — `feat(app): ai transport and cli settings with a cli check`

---

### Task 6: Sidecar amendment (`inputs.files`, tri-state script, `settings.transport`), evidence `## Context files`, prepare resolves the script

**Files:**
- Modify: `packages/transcript/src/assembly/types.ts:116-133`, `session.ts:14-39`, `packages/core/schema/sidecars/guyditor-assembly-v1.schema.json:18-51` (+ `$defs/contextFile`), `evidence.ts:7-15,54-103`, `session.test.ts`, `evidence.test.ts`, `__snapshots__/evidence.test.ts.snap`
- Modify: `packages/app/src/main/assembly-service.ts:190-231` (`create`), `:233-254` (`prepare`), `assembly-prepare.ts:19-28,127-168`, `surfaces.ts:177-191` (`create` loses `scriptPath`), `assembly-service.test.ts` (script tests), `assembly-turn.test.ts:27-34`, `packages/app/src/renderer/panels/AssemblePanel.tsx:71-79,190-193` and `AssemblePanel.test.ts:47-77` (keep the renderer compiling: `script: { mode: "auto" }`, `files: []`, `nextFileLabel: 1`, `transport: "api"`; the panel's script-path row is removed here and replaced in Task 9)

**Interfaces (Produces):**
```ts
// types.ts
export type AssemblyTransport = "api" | "cli";   // transcript cannot import agent; agent's LlmTransport (Task 4) has the same values
settings: { provider; model; effort; tightening; transport: AssemblyTransport };
inputs: { assetIds: string[]; files: ContextFile[]; script: ScriptChoice; nextFileLabel: number };
export function createAssemblySession(input: { id; now; settings: AssemblySession["settings"]; assetIds: string[] }): AssemblySession; // files [], script { mode: "auto" }, nextFileLabel 1
// evidence.ts
export interface EvidenceContextFile { label: string; name: string; kind: ContextFileKind; bytes: number; role: "script" | "context"; sent: boolean; text: string | null; words: number | null; note: string | null }
export interface EvidenceInput { …; contextFiles: EvidenceContextFile[] }
// assembly-prepare.ts
export interface PrepareDeps { …; settings: () => AssemblySession["settings"] } // re-snapshotted at prepare: files, footage and AI settings all become fixed at Analyze; AssemblyService.prepareDeps() supplies it as () => this.#sessionSettings()
export function contextFileNotes(files: readonly ContextFile[], transport: AssemblyTransport, textOf: (f: ContextFile) => string): EvidenceContextFile[];
```
Schema: `settings.required` + `transport` (enum `api|cli`); `inputs.required` = `assetIds, files, script, nextFileLabel`; `script` = oneOf three objects with `mode` const and `additionalProperties: false`; `files` items `$defs/contextFile` mirroring `ContextFile` (`kind` enum, `role` enum, `unsentReason` / `pages` nullable). Evidence section rendered after `## Script` (after the header when there is no script) and before `## Footage`, omitted when `contextFiles` is empty: header `### <label>  <name>   <kind>   <words> words   role: <role>` for text files followed by `text` on the next line when non-null, `### <label>  <name>   <kind>   <formatBytes>   (<note>)` otherwise; `words` = count of `/\S+/g`, rendered with `toLocaleString("en-US")` (`1,240`). `contextFileNotes` rules: `role === "script"` → `text: null`, note `rendered as the script blocks above`; text sent → inline text, note null; image sent → `attached as an image input`; pdf sent → api `attached as a document input`, cli `attached by path for CLI providers: <label>-<name>`; not sent → `not sent — <unsentReason>`. `prepareSession` (after the status reset): `settings: deps.settings()`; `script = resolveScript(files, inputs.script, textOf)`; set `role: "script"` on it and `"context"` on the others and persist; `scriptBlocks = script ? parseScriptBlocks(text) : []`; notes gain `script: F1 script.md` or `script: none`, plus `F1 notes.md has no quoted paragraphs; no script blocks` when an explicit choice yields none. `AssemblyService.create({ assetIds })` and `prepare` use `#sessionSettings()` = `aiSettings.current()` + `transport: aiSettings.transport(provider)` with the stub override as today. The old `sidecars/scripts/` copy goes away (no migration: §3.1).

- [ ] **Step 1: Failing tests:**
  - session: `fresh()` drops `script`; `round-trips a fresh session` also asserts `inputs` equals `{ assetIds, files: [], script: { mode: "auto" }, nextFileLabel: 1 }` and `settings.transport === "api"`; `populated()` carries two files (F1 text `role: "script"`, F2 image) and `script: { mode: "label", label: "F1" }`; new `rejects the pre-v2 inputs shape` — a serialised session with `inputs.script: null` throws `/E_ASSEMBLY_SIDECAR_INVALID/`.
  - evidence: snapshot updated (fixture gains F1 text 8 words, F2 image 1_153_434 B sent, F3 other 40_960 B unsent); `lists context files after the script and before the footage` (index order); `inlines text, sizes binaries and says why a file is not sent` — contains `### F1  outline.md   text   8 words   role: context`, `### F2  storyboard.png   image   1.1 MB   (attached as an image input)`, `### F3  budget.xlsx   other   40 KB   (not sent — unsupported type)`; `omits the section without files`; `contextFileNotes` → script entry has `text: null` and the `rendered as the script blocks above` note; pdf note differs by transport.
  - service: `prepare resolves the script from the attached files, sets roles and lists them in the evidence` — seed `inputs.files` through `service.prepareDeps().updateSession` after copying `script.md` and a 1×1 PNG into `sidecars/context/<id>/` (test helper `seedFiles(h, id, [{ name, bytes }])`, replaced by `addFiles` in Task 7); after prepare: `files[0].role === "script"`, `files[1].role === "context"`, `evidence.scriptBlocks.length ≥ 1`, `evidence.text` contains `## Context files` and `### F2  dot.png   image`, notes contain `script: F1 script.md`; with `script: { mode: "none" }` → 0 blocks and `script: none`.
  - service: `prepare re-snapshots the AI settings` — change the harness `current()` model between `create` and `prepare` → `settings.model` is the new one; `create` no longer accepts `scriptPath` (schema test in `surfaces.test.ts`: `create.paramsSchema.properties` has no `scriptPath`).
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/transcript/src/assembly packages/app/src/main/assembly-service.test.ts packages/app/src/main/assembly-turn.test.ts packages/app/src/main/surfaces.test.ts packages/app/src/renderer/panels/AssemblePanel.test.ts` — FAIL. **Step 3: Implement;** review the new snapshot by eye against §3.3. **Step 4: Run** Step 2 + `pnpm --filter @guyditor/transcript typecheck && lint` + `pnpm --filter @guyditor/core typecheck` + `pnpm --filter @guyditor/app typecheck && lint` + conventions — PASS. **Step 5: Commit** — `git add packages/transcript/src/assembly packages/core/schema/sidecars/guyditor-assembly-v1.schema.json packages/app/src/main/{assembly-service.ts,assembly-service.test.ts,assembly-prepare.ts,assembly-turn.test.ts,surfaces.ts,surfaces.test.ts} packages/app/src/renderer/panels/{AssemblePanel.tsx,AssemblePanel.test.ts}` — `feat(transcript): context files in the assembly sidecar and evidence`

---

### Task 7: File lifecycle IPC — `addFiles`, `removeFile`, `setScript`, `setAssets`, `pickContextFiles`

**Files:**
- Create: `packages/app/src/main/assembly-files.ts`
- Modify: `packages/app/src/main/assembly-service.ts:50-63,190-231,539-549`, `surfaces.ts:173-218`, `service-host.ts:184-198,462,478,1030-1039`, `index.ts:275-282` (sibling callback), `assembly-service.test.ts`, `surfaces.test.ts:166-178`

**Interfaces:**
- Consumes: Task 1 `classifyContextFile`/`contextFilePath`/`sentBytesTotal`/`formatBytes`/`CONTEXT_FILE_CAPS`, Task 6 session shape.
- Produces:
```ts
// assembly-files.ts
export async function attachContextFiles(root: string, session: AssemblySession, paths: readonly string[]): Promise<Pick<AssemblySession["inputs"], "files" | "nextFileLabel">>; // per path: readFile (failure → Error("E_ASSEMBLY_INVALID_INPUT: <path> is not a readable file")); classify; if sent and sentBytesTotal(existing + this) > turnBytes → Error(`E_ASSEMBLY_FILES_TOO_LARGE: adding ${name} (${formatBytes(bytes)}) would put attached files at ${formatBytes(total)}; the limit is 20 MB`); label F<nextFileLabel>; mkdir -p sidecars/context/<id>; writeFile(copy); sha256 of bytes; role "context"
export async function detachContextFile(root: string, file: ContextFile): Promise<void>; // unlink, ENOENT ignored
// AssemblyService
export interface AssemblyServiceOptions { …; pickFiles?: () => Promise<string[]> }
addFiles(sessionId: string, paths: string[]): Promise<AssemblySessionView>;
removeFile(sessionId: string, label: string): Promise<AssemblySessionView>;   // unknown label → E_ASSEMBLY_INVALID_INPUT; removing the explicit script label resets script to { mode: "auto" }
setScript(sessionId: string, script: ScriptChoice): Promise<AssemblySessionView>; // label must exist and be kind "text", else E_ASSEMBLY_INVALID_INPUT
setAssets(sessionId: string, assetIds: string[]): Promise<AssemblySessionView>;   // same checks as create (extract #checkAssets)
pickContextFiles(): Promise<string[]>;                                           // options.pickFiles?.() ?? []
// all four mutators run #serialized and require status "created" | "failed", else Error(`E_ASSEMBLY_STATE: session ${id} is ${status}; inputs can only change before Analyze (Start over to change them)`)
```
Manifest: `create { assetIds }`; `pickContextFiles {}` (budget 20); `addFiles { sessionId, paths: string[] minItems 1 }` (budget 200); `removeFile { sessionId, label: ^F[0-9]+$ }`; `setScript { sessionId, script: oneOf [{mode:"auto"},{mode:"label",label},{mode:"none"}] }`; `setAssets { sessionId, assetIds (ast_ pattern, minItems 1) }`. `service-host.ts`: `WindowServiceHostOptions.chooseContextFiles?: () => Promise<string[]>`, field `#chooseContextFiles`, assignment, and `pickFiles: () => this.#chooseContextFiles?.() ?? Promise.resolve([])` in the `AssemblyService` constructor call. `index.ts`: `chooseContextFiles` = `dialog.showOpenDialog(window, { title: "Add context files", buttonLabel: "Add", properties: ["openFile", "multiSelections"] })`, `[]` when cancelled.

- [ ] **Step 1: Failing tests** (`assembly-service.test.ts`; the harness gets `pickFiles` and writes fixture files: `script.md` with a `>` line, `notes.md`, a 1×1 PNG, `%PDF-1.4` buffers of chosen sizes, `budget.xlsx`):
  - `addFiles copies, hashes and labels files monotonically` — add `script.md`, `notes.md` → labels `F1`, `F2`, `sidecars/context/<id>/F1-script.md` exists with the recorded sha256, `nextFileLabel === 3`; `removeFile("F1")` → file unlinked, `files` is `[F2]`; add again → `F3`, never `F1`.
  - `files with the same basename get distinct paths` (Review Focus 1) — `a/notes.md` and `b/notes.md` → paths end `F1-notes.md`, `F2-notes.md`, both listed.
  - `refuses attachments beyond the 20 MB turn total with the running total` — 15 MB pdf then 6 MB pdf → rejects `"E_ASSEMBLY_FILES_TOO_LARGE: adding big2.pdf (6.0 MB) would put attached files at 21.0 MB; the limit is 20 MB"`; `files.length === 1`.
  - `unsent files are kept and say why` — `budget.xlsx` → `sent === false`, `unsentReason === "unsupported type"`, still copied.
  - `setScript, removing the chosen script, and setAssets` (Review Focus 4) — `setScript({ mode: "label", label: "F1" })` ok; label of the PNG → `/E_ASSEMBLY_INVALID_INPUT/`; `removeFile("F1")` → `script` equals `{ mode: "auto" }`; `setAssets([SECOND])` → `assetIds` equals `[SECOND]`; `["ast_cccccccccc"]` → invalid.
  - `inputs are read-only from preparing on` — after prepare all four mutators reject `/E_ASSEMBLY_STATE/`; after a failed prepare (`transcripts: "none"`) `addFiles` works.
  - `pickContextFiles returns the dialog's paths` — `pickFiles: async () => ["/a.md"]` → `["/a.md"]`; without the option → `[]`.
  - surfaces: Assembly methods sorted equal `["abandon", "addFiles", "create", "createProposal", "get", "list", "pickContextFiles", "prepare", "removeFile", "send", "setAssets", "setScript"]`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/main/assembly-service.test.ts packages/app/src/main/surfaces.test.ts` — FAIL. **Step 3: Implement** (replace Task 6's `seedFiles` helper with `addFiles`). **Step 4: Run** Step 2 + `service-host.test.ts` + app typecheck/lint + `pnpm check:conventions` + `wc -c packages/app/src/main/service-host.ts` (< 97_300) — PASS. **Step 5: Commit** — `git add packages/app/src/main/{assembly-files.ts,assembly-service.ts,assembly-service.test.ts,surfaces.ts,surfaces.test.ts,service-host.ts,index.ts}` — `feat(app): attach, remove and choose assembly context files`

---

### Task 8: `send` with attachments, transport selection, CLI cost and audit

**Files:**
- Modify: `packages/app/src/main/assembly-turn.ts:6-19,39-49,92`, `assembly-service.ts:302-411`, `assembly-turn.test.ts`, `assembly-service.test.ts`

**Interfaces:**
- Consumes: Task 2 parts/`messageText`/`reportedUsd`, Task 4 `createLlmAdapter(provider, { apiKey, transport, cli })`, Task 5 `aiSettings.transport()/cliBinary()`.
- Produces:
```ts
export interface TurnDeps { …; attachments?: LlmContentPart[] }          // appended to the first user message's parts on every turn
export interface TurnUsage { inputTokens: number; outputTokens: number; reportedUsd?: number } // summed across the validation retry
export function llmMessages(session: AssemblySession, hint?: boolean, attachments?: LlmContentPart[]): LlmMessage[];
```
`#sendGuarded`: notice becomes *"Sends the transcript, the conversation and the files you attach to <provider>. Never your footage."*; `transport = session.settings.transport`; `auditProvider = transport === "cli" ? (provider === "anthropic" ? "claude-cli" : "codex-cli") : provider` used in `adapterId: llm.<auditProvider>`, `director.modelLabel: <auditProvider>/<model>` and `record.provider`; API key required only for `api`; adapter = `createLlmAdapter(provider, { apiKey, transport, cli: { binary: aiSettings.cliBinary(provider), cwd: join(root, "sidecars/context", session.id) } })` after `mkdir -p` of that cwd; attachments = for each file with `sent && kind ∈ {image, pdf}` read `join(root, file.path)` (missing → `Error(\`E_ASSEMBLY_FILE_MISSING: ${label} ${name} is missing from ${path}; start over and attach it again\`)`, thrown before any provider call, session untouched) → part with `data`, `mime`, `label`, `name`; estimate units `inputTokens = estimateTokens(system + history) + 1600 × images + 2000 × Σ pages`; CLI → `amount: 0`, `confidence: "quote"`; `dataClassesSent` adds `"frames"` and `payloadSummary.frames = attachments.length` when any; `price` for CLI → `{ usd: usage.reportedUsd ?? 0, estimated: false }`; `record(... actualUsd)` for CLI = summed `reportedUsd`.

- [ ] **Step 1: Failing tests:**
  - turn: `attachments ride on the first user message on every turn` — `attachments: [image part]`, two turns → both requests' first message has parts `[text, image]`, later user messages text-only; `sums reported cost across the validation retry` — completions `{ reportedUsd: 0.1 }` then `{ reportedUsd: 0.2 }` → `usage.reportedUsd === 0.3` (±1e-9).
  - service: `sends image and pdf bytes as parts, counts them in the estimate and audits the frames class` — `addFiles` PNG + 2-page PDF, prepare, send with a capturing adapter → first message parts `[text, image{label:"F1",name:"dot.png",data = file bytes}, pdf{label:"F2"}]`; `external.call` record has `dataClassesSent` containing `"frames"`, `provider "anthropic"`, `units.inputTokens ≥ 1600 + 4000`.
  - service: `a missing attachment fails the turn readably and keeps the session sendable` (Review Focus 5) — unlink the PNG → `send` rejects `/E_ASSEMBLY_FILE_MISSING: F1 dot.png is missing from sidecars\/context\//`, adapter never called, `get().status === "conversing"`; restore the file → `send` resolves `turn`.
  - service: `cli transport needs no key, quotes zero, records the reported cost and labels the audit <cli>` — `it.each([["anthropic","claude","claude-cli"],["openai","codex","codex-cli"]])`: harness `aiSettings` with `transport: () => "cli"`, `cliBinary: () => "/x/" + cli`, `apiKey: () => Promise.resolve(undefined)`; `adapterFactory` spy asserts options `{ apiKey: "", transport: "cli", cli: { binary: "/x/<cli>", cwd: join(root, "sidecars/context", id) } }` and returns an adapter resolving `{ reply: PLAN, usage: { 0, 0 }, reportedUsd: 0.42 }` → last message `usage` equals `{ inputTokens: 0, outputTokens: 0, usd: 0.42, estimated: false }`; `external.call.provider === "<cli>-cli"`, `adapterId === "llm.<cli>-cli"`; the `cost.charge` record has `costUsd === 0.42`; the context directory exists.
  - service: `the external notice names attached files` — ask mode → `notice === "Sends the transcript, the conversation and the files you attach to anthropic. Never your footage."`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/main/assembly-turn.test.ts packages/app/src/main/assembly-service.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** + app typecheck/lint + conventions — PASS. **Step 5: Commit** — `git add packages/app/src/main/{assembly-turn.ts,assembly-turn.test.ts,assembly-service.ts,assembly-service.test.ts}` — `feat(app): send assembly attachments and run cli transports with audit and cost`

---

### Task 9: Assemble panel — files, labels, script select, session on first change

**Files:**
- Modify: `packages/app/src/renderer/panels/AssemblePanel.tsx` (helpers `:63-115`, state `:132-140`, `analyze`/`startOver` `:179-216`, inputs region `:274-346`), `AssemblePanel.test.ts`, `packages/app/src/renderer/assemble.css`

**Interfaces:**
- Consumes: IPC `Assembly.pickContextFiles/addFiles/removeFile/setScript/setAssets` (Task 7), `ContextFile`/`ScriptChoice` types.
- Produces (exported for tests):
```ts
export function assetLabels(assets: readonly Asset[], selectedIds: readonly string[], evidence: AssemblySessionView["evidence"]): Map<string, string>; // evidence → "A" + ordinal; else selected assets numbered by captureTime?.value ?? "" then basename (orderAssets' rule); unselected → "—"
export function fileRowTitle(file: ContextFile): string | undefined; // image → "Counted as 1,600 input tokens in the cost estimate"; pdf → "Counted as 2,000 input tokens per page (<pages> pages)"; else undefined
export function usageLine(session): string | null; // cli and usd === 0 → "via claude (no cost reported)" (codex for openai); cli and usd > 0 → "<tokens> tokens · $x.xx"; api as today
export function evidenceSummary(session): string | null; // script part becomes "script: F1 (12 blocks)" from the file with role "script", else "no script"
export function unsentNotice(before: readonly ContextFile[], after: readonly ContextFile[]): string | null; // files new in `after` with sent === false → "F3 budget.xlsx: not sent — unsupported type" joined with "; ", else null (§2 G2: the notice at attach time)
export const INPUTS_EDITABLE: readonly AssemblySessionStatus[] = ["created", "failed"];
```
Behaviour: `ensureSession()` creates `{ assetIds: selectedIds }` when there is no non-abandoned session and returns it; every input change (checkbox → `setAssets`, **Add files…** `assembly-add-files` → `pickContextFiles` → `addFiles`, typed path row `assembly-file-path` + `assembly-file-path-add` (Enter too) → `addFiles { paths: [path] }`, `assembly-script-select` → `setScript`) goes through it; after every `addFiles` the panel calls `setNotice(unsentNotice(before, after))` when non-null; `assembly-add-files` and the path row are also disabled while no asset is selected (a session needs one), and a `setAssets` that would empty the selection is refused by the service and surfaces as the error notice; once the active session is past `INPUTS_EDITABLE`, checkboxes and the select are disabled, `assembly-add-files` and the path row are disabled, remove buttons are not rendered. Checked state comes from `active.inputs.assetIds` when a session exists, else local `deselected`. File list `assembly-files` rows `assembly-file-<label>`: `<label>  <name>  <kind>  <formatBytes>` (+ `not sent — <reason>` when unsent), `title={fileRowTitle(file)}`, button `assembly-file-remove-<label>`. Select options: `auto` ("Auto — first Markdown with quoted lines"), `none`, one per `text` file (`F1 outline.md`). Asset rows gain `<span data-testid="assembly-asset-label-<id>">A1</span>`. **Analyze** prepares the active session (creating one first if none); **Start over** (`assembly-abandon`) shows for every active session including `created`. Notice copy per Global Constraints. CSS: `.assembly-files li { display: flex; gap: 6px; align-items: center }`, `.assembly-files .file-label { font-family: ui-monospace, monospace }`.

- [ ] **Step 1: Failing tests** (`renderToStaticMarkup`, existing `session()`/`props()` helpers):
  - `renders file rows with labels, sizes, reasons and remove buttons while created` — session `created` with F1 text 1229 B, F2 image 1_153_434 B, F3 other unsent → html has `assembly-file-F1` containing `F1`, `outline.md`, `text`, `1.2 KB`; `assembly-file-remove-F1`; the F2 row `title` contains `1,600`; F3 row contains `not sent — unsupported type`; `assembly-add-files`, `assembly-file-path`, `assembly-file-path-add`, `assembly-script-select` with options `auto`, `none`, `F1` present; `assembly-abandon` present.
  - `locks the inputs once analysed` — `conversing` → no `assembly-file-remove-`, `assembly-add-files` and `assembly-script-select` carry `disabled`, asset checkboxes disabled.
  - `labels footage in capture order and from the evidence` — `assetLabels` with two assets whose capture times reverse their names → labels follow capture time; with evidence ordinals → `A<ordinal>`; unselected → `—`; the rendered row has `assembly-asset-label-<id>`.
  - `shows the new external notice` — contains `Sends the transcript, the conversation and the files you attach to anthropic. Never your footage.`
  - `usage line for cli turns` — `transport: "cli"`, one usage with `usd: 0` → `"via claude (no cost reported)"`; openai → `"via codex (no cost reported)"`; `usd: 0.42` → ends `$0.42`.
  - `summarises the script by label` — file with `role: "script"` and 12 blocks → contains `script: F1 (12 blocks)`; none → `no script`.
  - `notices files that will not be sent at attach time` — `unsentNotice([F1 text], [F1 text, F3 other])` equals `"F3 budget.xlsx: not sent — unsupported type"`; nothing new unsent → null.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/renderer/panels/AssemblePanel.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** + `pnpm --filter @guyditor/app typecheck && lint` + conventions — PASS (the live click-through is covered by the e2e in Task 12; do not start the dev app here). **Step 5: Commit** — `git add packages/app/src/renderer/panels/{AssemblePanel.tsx,AssemblePanel.test.ts} packages/app/src/renderer/assemble.css` — `feat(app): context files, labels and script choice in the Assemble panel`

---

### Task 10: AI settings — Connect via radio, CLI path and Check

**Files:**
- Modify: `packages/app/src/renderer/panels/AiSettingsSection.tsx:8-14,24-42,142-170`, `AssemblePanel.test.ts:26-35,248-280`

**Interfaces:**
- Consumes: `AiSettings.update { transport, cli }`, `AiSettings.checkCli` (Task 5); `AiSettingsSectionProps.initialCliStatus?: string` (test seam).

Controls for the current provider: radio group `name="ai-transport"` with `ai-transport-api` ("API key") and `ai-transport-cli` ("local CLI (claude)" / "(codex)"), `onChange → update({ transport: { [provider]: value } })`; when `api`: today's key row and `ai-key-status`; when `cli`: text input `ai-cli-path` (value `settings.cli.claudePath` / `codexPath`, `onBlur → update({ cli: { [key]: value } })`), button `ai-cli-check` calling `AiSettings.checkCli { provider }` and writing `ai-cli-status` as `claude 2.1.309 (Claude Code) ✓` or the failure message; the model datalist effect runs when `hasKey || transport === "cli"`.

- [ ] **Step 1: Failing tests** (`SETTINGS` fixture gains `transport: { anthropic: "api", openai: "api" }`, `cli: { claudePath: "claude", codexPath: "codex" }`):
  - `shows the key field for API and the CLI path and Check for local CLI` — api → `ai-transport-api` checked, `ai-key` present, no `ai-cli-path`; `transport.anthropic: "cli"` → `ai-transport-cli` checked, `ai-cli-path` with `value="claude"`, `ai-cli-check` present, no `ai-key`; `initialCliStatus: "claude 2.1.309 (Claude Code) ✓"` renders in `ai-cli-status`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/renderer/panels/AssemblePanel.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** + app typecheck/lint + conventions — PASS. **Step 5: Commit** — `git add packages/app/src/renderer/panels/{AiSettingsSection.tsx,AssemblePanel.test.ts}` — `feat(app): connect a provider via API key or local CLI in AI settings`

---

### Task 11: Hide the per-model rate table (addendum)

**Files:**
- Modify: `packages/app/src/renderer/panels/AiSettingsSection.tsx:77-82` (delete `setRate`), `:171-202` (delete `<table className="ai-rates">`), `packages/app/src/renderer/assemble.css:9` (delete `.ai-rates input` rule), `AssemblePanel.test.ts:258-268`, `docs/MANUAL.md:84`, `docs/amendments/008-ai-assembly.md:35`

Keep `AiSettings.rates`, `DEFAULT_LLM_RATES`, the `patch.rates` validation in `ai-settings-service.ts` and the pre-send "Confirm $…" gate untouched; `SETTINGS.rates` stays in the test fixture. No schema or fixture change. (`packages/app/src/renderer/manual.test.ts` does not pin this paragraph — checked.)

- [ ] **Step 1: Failing test** — rename `renders provider, model, effort, tightening, key and rate controls` to `…, key controls`, drop `"ai-rate-claude-opus-5-5"` from the id list, add `expect(html).not.toContain('data-testid="ai-rate-')`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/app/src/renderer/panels/AssemblePanel.test.ts` — FAIL (`ai-rate-` still rendered).
- [ ] **Step 3: Implement** the deletions; MANUAL line 84 loses the clause "and a per-model rate table in $ per million tokens" (the sentence ends after the key status clause); amendment 008 line 35 gains the sentence *"The rate editor is not exposed in the UI as of this branch; the cost gate uses the stored rates."*
- [ ] **Step 4: Run** the test file + `pnpm exec vitest run --project unit packages/app/src/renderer/manual.test.ts` + app typecheck/lint + conventions — PASS.
- [ ] **Step 5: Commit** — `git add packages/app/src/renderer/panels/{AiSettingsSection.tsx,AssemblePanel.test.ts} packages/app/src/renderer/assemble.css docs/MANUAL.md docs/amendments/008-ai-assembly.md` — `feat(app): hide the per-model rate table in AI settings`

---

### Task 12: Fixture PNG and e2e through the typed path row

**Files:**
- Modify: `scripts/make-fixtures.mjs:1544-1561` (`ASSEMBLY_STORYBOARD_PNG`, write `.fixtures/scripts/assembly-storyboard.png`), `scripts/fixture-spec.mjs:1` (`FIXTURE_GENERATOR_VERSION` → `"1.7.0"`), `packages/app/e2e/assembly.spec.ts:28-33`

`.fixtures/` is gitignored and regenerated by `pnpm fixtures`; the version bump is what invalidates stale copies. `ASSEMBLY_STORYBOARD_PNG` = `Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")` (a 1×1 PNG), written beside `assembly.raw.md`.

- [ ] **Step 1: Update the e2e** — after `dock-tab-assemble`: fill `assembly-file-path` with the script path, click `assembly-file-path-add`; same for the PNG; expect `assembly-file-F1` to contain `assembly.raw.md` and `assembly-file-F2` to contain `assembly-storyboard.png` and `image`; expect `assembly-script-select` to have value `auto`; expect `assembly-asset-label-ast_assemblyaa` to have text `A1`; then `assembly-analyze` and the rest of the flow unchanged.
- [ ] **Step 2: Run** `pnpm fixtures && pnpm --filter @guyditor/app build && env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS pnpm --filter @guyditor/app test:e2e e2e/assembly.spec.ts` — FAIL (PNG missing).
- [ ] **Step 3: Implement** the generator change and `pnpm fixtures`. **Step 4: Run** Step 2 again, then `node --test scripts/make-fixtures.test.mjs` (the gate's runner; not a vitest project) and `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node scripts/test-e2e.mjs` (full suite) — PASS.
- [ ] **Step 5: Commit** — `git add scripts/make-fixtures.mjs scripts/fixture-spec.mjs packages/app/e2e/assembly.spec.ts` — `test(e2e): attach a script and an image to the assembly session`

---

### Task 13: Docs, amendment 009, traceability, CLI dogfood

**Files:**
- Modify: `docs/MANUAL.md:67` (Inputs row: **Add files…**, labels `F1…`, what is sent per kind and the caps, the Script dropdown, read-only after Analyze), `:84` (Connect via API key or local CLI, **Check**), `:86` (files you attach leave the machine; a CLI sends the same text and files to the same company; CLI turns show the reported cost or "via claude (no cost reported)"), `:88` (known limits: no CLI streaming, PDFs by path for Codex), `docs/amendments/008-ai-assembly.md` (one line under "Change" pointing at amendment 009), `docs/traceability.md:12-16` (add `ASM-006` context files → `context-files.test.ts`, `evidence.test.ts`, `assembly-service.test.ts`, `AssemblePanel.test.ts`, `assembly.spec.ts`; `ASM-007` CLI providers → `cli-process.test.ts`, `claude-cli.test.ts`, `codex-cli.test.ts`, `ai-settings-service.test.ts`, `assembly-service.test.ts`; status `implemented`, note that real CLI runs are manual), `docs/PROJECT-STATE.md:23-27` (one paragraph)
- Create: `docs/amendments/009-assembly-inputs.md` (front matter like 008; Problem; Change with links to the design and this plan; New persisted names: `sidecars/context/<asb_id>/<label>-<name>`, `inputs.files` / `inputs.script` / `inputs.nextFileLabel` / `settings.transport` in `guyditor.assembly/v1` (amended in place, no migration), settings `ai.transport` and `ai.cli`, audit providers `claude-cli` / `codex-cli`; Known limitations; Migration: none), `docs/dogfood/2026-10-27-assembly-cli.md`

- [ ] **Step 1: Write the docs**; open MANUAL in the app's Help panel once to check the section renders.
- [ ] **Step 2: Write the dogfood note skeleton** — `docs/dogfood/2026-10-27-assembly-cli.md` with the checks below each marked **not run**, and `ASM-007` set to `partial` in traceability. The implementer never runs `claude` or `codex` (they send data to a provider and need the creator's logged-in account); the coordinator runs the checks with the creator's go-ahead after the branch review and fills the note in. Checks to list: the Check button output per CLI; one session on ep001 with the script, one PNG and one PDF attached, transport `cli` per provider — the turn's reported cost line and whether `claude` read the PDF natively or needed the Read instruction (§6); the **confinement check**: a one-off `claude -p --safe-mode --restricted --no-session-persistence --tools Read` run from a context directory asked to print `../../episode.guyditor.yaml` — expected: it cannot. If it can, record it in the note and under amendment 009's limitations; do not widen or work around (§4.2).
- [ ] **Step 3: Run** `pnpm check:conventions && pnpm test` (full unit suite) — PASS.
- [ ] **Step 4: Commit** — `git add docs/MANUAL.md docs/amendments/008-ai-assembly.md docs/amendments/009-assembly-inputs.md docs/traceability.md docs/PROJECT-STATE.md docs/dogfood/2026-10-27-assembly-cli.md` — `docs: assembly inputs manual, amendment 009, traceability, cli dogfood`

---

## Self-review notes

- Spec coverage: §3.1 model/lifecycle → Tasks 1, 6, 7, 9; §3.2 classification and caps → Task 1 (refusal copy in Task 7); §3.3 evidence section and prompt paragraph → Tasks 6, 2; §3.4 request shapes, first-message attachments, cost estimate → Tasks 2, 8; §3.5 panel and notice → Tasks 9, 8; §3.6 IPC → Task 7; §4.1 settings and Connect via → Tasks 5, 10; §4.2 adapters, envelope, failure classes → Tasks 3, 4; §4.3 gates, audit, cost, effort mapping → Tasks 8, 4; §4.4 stub → Tasks 2, 8; §5 testing matrix → the tasks' test lists plus Task 12 (e2e) and Task 13 (dogfood); §6 builder items pinned: hand-rolled sniffing (Task 1), CLI conversation format (Task 4), PDF handling verified in dogfood (Task 13), file-list CSS (Task 9); addendum → Task 11.
- Calls made where the design was silent: `ContextFile` gains `unsentReason` and `pages`, `inputs` gains `nextFileLabel`, `settings` gains `transport`, the image part gains `name` (all needed for the no-reuse, not-silently-dropped, cost-estimate and CLI-by-filename rules); AI settings are re-snapshotted at prepare; the script entry in `## Context files` is not re-inlined; removing the chosen script resets to `auto`; the typed path row is `assembly-file-path` + `assembly-file-path-add`; Connect-via ids `ai-transport-api|cli`, `ai-cli-path`, `ai-cli-check`, `ai-cli-status`; `claude` gets `--append-system-prompt <text>` (the `-file` variant is not in `claude --help` 2.1.309); codex reads the prompt from stdin (`-`) because the evidence can exceed the 128 KB single-argument limit; the token-estimate hover text sits on the image/PDF file rows; a new amendment 009 rather than editing 008.
