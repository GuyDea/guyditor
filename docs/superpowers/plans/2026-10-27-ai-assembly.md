# AI-assisted rough-cut assembly — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From imported clips plus an optional script, produce a reviewed, model-planned rough cut as a Guyditor proposal, with a chat for uncertainties and a provider/model/effort setting the creator controls.

**Architecture:** Pure logic (script parsing, segmentation, evidence rendering, reply validation, plan compiling) lives in `packages/transcript/src/assembly/` and is unit-tested without Electron. Provider adapters live in `packages/agent/src/llm/` behind one `LlmAdapter` interface with a deterministic stub. The app's main process gets two new services (`AssemblyService`, `AiSettingsService`) in their own modules, wired into `service-host.ts` with the fewest possible lines, and one new dock panel.

**Tech Stack:** TypeScript (strict), Electron 43, React 19 renderer, vitest (`--project unit`), Playwright e2e, Node `fetch` for provider HTTP, existing `OperationEngine`/`JobQueue`/`CostMeter`/`AuditLog`.

**Spec:** `docs/superpowers/specs/2026-10-27-ai-assembly-design.md` (approved 2026-10-27). Section numbers below (§) refer to it.

## Global Constraints

- Files under `packages/` must stay ≤ 100 KiB (`scripts/check-conventions.mjs:49`); `packages/app/src/main/service-host.ts` has ~1.7 KB left. Task 1 frees room; later tasks add at most a constructor line, two `case`s and one hook call there.
- Cross-package imports use relative source paths (`"../../../core/src/index.js"`), never package names.
- Ids are `<prefix>_` + 10 chars of `[a-z2-7]` (`packages/core/src/project/ids.ts`); new prefix `asb`. Word ids are `w` + 6 digits.
- Only text leaves the machine: evidence package + conversation. Never file paths outside the project, keys, or audio/video (§9.1). All provider HTTP runs in the main process (renderer network is locked).
- `E_OP_REASON_REQUIRED`: proposal reason text non-empty and ≤ 280 chars, `sources` non-empty (§8.6).
- Stub mode: `GUYDITOR_ASSEMBLY_STUB=1` selects the stub adapter regardless of settings (§8.4); every automated test uses it.
- e2e: `data-testid` selectors only, no sleeps; `pnpm test:e2e` builds first.
- Copy fixed by the spec: panel label **Assemble**; notice *"Sends the transcript and script text to <provider>. Never audio or video."*; sidecar schema id `guyditor.assembly/v1`; settings keys `ai.provider|model|effort|tightening|rates`.
- Run before every commit: `pnpm exec vitest run --project unit <changed test files>`, `pnpm --filter @guyditor/<pkg> typecheck && pnpm --filter @guyditor/<pkg> lint`, `pnpm check:conventions`.

## Review Focus

1. A selected clip whose transcript has zero active words (silence, B-roll) — prepare must skip it with a note in the summary, not throw. → test in Task 10.
2. A script with headings and plain paragraphs but no `>` quotes — parser falls back to paragraph blocks instead of producing zero blocks. → test in Task 3.
3. A model plan that cites a deleted word, reverses `fromWord`/`toWord`, or spans two assets — rejected by validation, never compiled. → tests in Task 6.
4. Two clips with the same container capture time (burst recording) — order falls back to file name and the evidence carries an order warning. → test in Task 4.
5. Provider HTTP 429/5xx or a non-JSON body — the turn fails with a readable message, the session stays `conversing`, and a retry is possible. → tests in Task 8.

---

### Task 1: Free headroom in service-host.ts (move the filler follow-up)

**Files:**
- Create: `packages/app/src/main/filler-follow-up.ts`
- Modify: `packages/app/src/main/service-host.ts:1066-1069`, `:2344-~2400` (`#createFillerProposal`)
- Test: existing `packages/app/src/main/service-host.test.ts` (filler proposal cases)

**Interfaces:**
- Produces: `export interface FillerFollowUpDeps { auditSink: AuditSink; engine: (project: ProjectServices) => OperationEngine; publish: (event: GdEventWithoutSeq) => void }` and `export async function createFillerProposal(deps: FillerFollowUpDeps, project: ProjectServices, job: JobRecord): Promise<void>` — the body of today's `#createFillerProposal`, unchanged in behaviour. Task 12 extends it.

- [ ] **Step 1: Run the existing filler proposal tests to record the baseline**

Run: `pnpm exec vitest run --project unit packages/app/src/main/service-host.test.ts -t filler`
Expected: PASS (note the count).

- [ ] **Step 2: Move the method body into `filler-follow-up.ts` as `createFillerProposal`; replace the method with a one-line delegation; drop now-unused imports from service-host.ts**

- [ ] **Step 3: Verify**

Run: `pnpm exec vitest run --project unit packages/app/src/main/service-host.test.ts -t filler && pnpm --filter @guyditor/app typecheck && pnpm --filter @guyditor/app lint && pnpm check:conventions && wc -c packages/app/src/main/service-host.ts`
Expected: same PASS count; size ≥ 4 KB below 102400.

- [ ] **Step 4: Commit** — `refactor(app): move filler follow-up out of service-host`

---

### Task 2: Assembly types, `asb` id prefix, session sidecar schema

**Files:**
- Create: `packages/transcript/src/assembly/types.ts`, `packages/transcript/src/assembly/session.ts`, `packages/transcript/src/assembly/session.test.ts`, `packages/transcript/src/assembly/index.ts` (re-exports), `packages/core/schema/sidecars/guyditor-assembly-v1.schema.json`
- Modify: `packages/core/src/project/ids.ts:3-32` (append `"asb"`), `scripts/check-conventions.mjs:5` (`RANDOM_ID_PREFIXES` add `asb`), `packages/transcript/src/index.ts` (export `./assembly/index.js`)

**Interfaces (Produces — every later task imports these from `assembly/index.js`):**

```ts
export type AssemblyProvider = "anthropic" | "openai" | "stub";
export type AssemblyEffort = "low" | "medium" | "high" | "max";
export type TighteningMode = "ask" | "gentle" | "off";
export interface ScriptBlock { id: string /* S001 */; section: string; text: string; sentences: string[] }
export interface CandidateSegment {
  id: string /* C<assetOrdinal>.<nn>, nn 2-digit */; assetId: string; fromWord: string; toWord: string;
  start: SampleTime; end: SampleTime; text: string; pauseBeforeMs: number | null;
  confidence: number | null; lowConfidence: boolean; groupId: string | null /* G<n> */;
  scriptMatch: { block: string; score: number } | null; aside: boolean; markerPhrases: string[];
}
export interface SegmentGroup { id: string; memberIds: string[] /* capture order, latest last */; scriptBlock: string | null }
export interface EvidenceAsset {
  assetId: string; ordinal: number; fileName: string; capturedAt: string;
  captureSource: "container" | "file-mtime"; durationMs: number; orderWarning: string | null;
}
export interface AssemblyEvidence {
  text: string; sha256: string; tokenEstimate: number; assets: EvidenceAsset[];
  segments: CandidateSegment[]; groups: SegmentGroup[]; scriptBlocks: ScriptBlock[]; notes: string[];
}
export interface AssemblyQuestion { id: string; about: { assetId: string; fromWord: string; toWord: string } | null; text: string; options: string[] | null }
export interface AssemblyCut { scriptBlock: string | null; scriptSentences: [number, number] | null; assetId: string; fromWord: string; toWord: string; reason: string }
export interface AssemblyFlag { cutIndex: number; kind: "stitch" | "override" | "low-confidence" | "unmatched" | "other"; note: string }
export type AssemblyPlan = { status: "plan"; summary: string; tightening: "gentle" | "off" | null; cuts: AssemblyCut[]; flags: AssemblyFlag[] };
export type AssemblyReply = { status: "questions"; summary: string; questions: AssemblyQuestion[] } | AssemblyPlan;
export interface CompiledCut { index: number /* clip index in sequence */; assetId: string; in: FrameTime; out: FrameTime; timelineStart: FrameTime; extent: FrameTime; reason: string; flags: AssemblyFlag[] }
export interface AssemblyUsage { inputTokens: number; outputTokens: number; usd: number; estimated: boolean }
export interface AssemblyMessage { role: "user" | "assistant" | "validation"; content: string; reply: AssemblyReply | null; usage: AssemblyUsage | null; at: string }
export type AssemblySessionStatus = "created" | "preparing" | "conversing" | "planned" | "proposed" | "accepted" | "abandoned" | "failed";
export interface AssemblySession {
  schema: "guyditor.assembly/v1"; id: string; createdAt: string; updatedAt: string; status: AssemblySessionStatus;
  settings: { provider: AssemblyProvider; model: string; effort: AssemblyEffort; tightening: TighteningMode };
  inputs: { assetIds: string[]; script: { name: string; path: string; sha256: string } | null };
  auditSessionId: string | null; externalAcknowledged: boolean; evidence: AssemblyEvidence | null;
  messages: AssemblyMessage[]; plan: AssemblyPlan | null; compiled: CompiledCut[] | null;
  proposalId: string | null; tighteningJobId: string | null; error: string | null;
}
// session.ts
export function createAssemblySession(input: { id: string; now: string; settings: AssemblySession["settings"]; assetIds: string[]; script: AssemblySession["inputs"]["script"] }): AssemblySession;
export function parseAssemblySession(text: string): AssemblySession;   // throws Error("E_ASSEMBLY_SIDECAR_INVALID: …")
export function serializeAssemblySession(session: AssemblySession): string; // JSON, 2-space, trailing newline
export function assemblySidecarRef(session: AssemblySession, text: string): SidecarRef; // name `assembly-<id>`, path `sidecars/assembly/<id>.json`, schema "guyditor.assembly/v1", sha256 of text, inputs: [] (the evidence hash lives inside the file)
```

The JSON schema mirrors `AssemblySession` with `additionalProperties: false` throughout and `evidence.text` as string.

- [ ] **Step 1: Write failing tests** in `session.test.ts`:
  - `round-trips a fresh session` — `parseAssemblySession(serializeAssemblySession(createAssemblySession(...)))` deep-equals the input; `status === "created"`, `messages.length === 0`, `externalAcknowledged === false`.
  - `rejects a sidecar with the wrong schema id` — `parseAssemblySession('{"schema":"guyditor.transcript/v1"}')` throws `/E_ASSEMBLY_SIDECAR_INVALID/`.
  - `sidecar ref points at sidecars/assembly` — `assemblySidecarRef(session, text).path === "sidecars/assembly/asb_aaaaaaaaaa.json"` and `sha256` equals `createHash("sha256").update(text).digest("hex")`.
  - `asb is a known id prefix` — `isId("asb_aaaaaaaaaa", "asb") === true` (from core ids).
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/transcript/src/assembly/session.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** types.ts, session.ts (validate with the JSON schema via the same validator fillers/takes use — see `packages/core/src/takes/comparison.ts:242` for the pattern), index.ts, schema file, `asb` prefix.
- [ ] **Step 4: Run** the test file, then `pnpm --filter @guyditor/transcript typecheck && pnpm --filter @guyditor/core typecheck && pnpm check:conventions` — expect PASS.
- [ ] **Step 5: Commit** — `feat(transcript): assembly session types and sidecar`

---

### Task 3: Script block parser

**Files:**
- Create: `packages/transcript/src/assembly/script.ts`, `script.test.ts`, fixture `packages/transcript/src/assembly/__fixtures__/script.raw.md` (copy the first two sections of `why-humans-play_sources/whp-youtube/episodes/ep001-ai-dangerous-advice/final/script.raw.md`, ~40 lines)

**Interfaces:**
- Produces: `export function parseScriptBlocks(markdown: string): ScriptBlock[]`; `export function splitSentences(text: string): string[]` (split on `[.!?]` followed by whitespace or end; keep punctuation; trim; drop empties).

Rules (§5.2): a block is one quoted paragraph — consecutive `>` lines joined with spaces, split at `>`-only lines and at non-quote lines. `section` is the nearest preceding `## ` heading text (`""` before any). Strip `<u>`, `</u>`, `**`, `*`, Markdown links `[text](url)` → `text`, and `[F-010](…)` style refs entirely. Ids `S001…` in document order. **Fallback:** if the document contains no `>` lines, treat each non-heading paragraph (blank-line separated) as a block.

- [ ] **Step 1: Failing tests:**
  - `parses quoted paragraphs under headings` — fixture yields ≥ 10 blocks; `blocks[0].section === "1. The answer that sounded right"`; `blocks[0].text.startsWith("Could AI talk you into")`; no block text contains `<u>` or `**` or `](http`.
  - `splits a multi-sentence block into sentences` — the block starting "In a case reported in 2024" has `sentences.length === 2`.
  - `falls back to plain paragraphs` (Review Focus 2) — `parseScriptBlocks("# T\n\n## A\n\nFirst para.\n\nSecond para.")` yields 2 blocks with section `"A"`.
  - `empty input yields no blocks` — `parseScriptBlocks("")` is `[]`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** — `feat(transcript): parse script blocks for assembly`

---

### Task 4: Candidate segments, repeat groups, script matching, asides

**Files:**
- Create: `packages/transcript/src/assembly/segments.ts`, `segments.test.ts`, test helper `packages/transcript/src/assembly/__fixtures__/scripted-transcript.ts`
- Modify: `packages/transcript/src/take-comparison.ts` (export the private token-similarity function as `export function transcriptSimilarity(a: string, b: string): number` if not already exported; no behaviour change)

**Interfaces:**
- Consumes: `TranscriptSidecar`, `TranscriptWord`, `MarkerRecord` (core takes), `groupTakeTranscripts`, `transcriptSimilarity`, `ScriptBlock`.
- Produces:
```ts
export interface SegmentInput { assetId: string; ordinal: number; sidecar: TranscriptSidecar; markers: readonly MarkerRecord[] }
export interface SegmentOptions { segmentPauseMs: number /* default 1500 */; lowConfidenceBelow: number /* default 0.6 */; groupThreshold: number /* default 0.8 */; asideMaxWords: number /* default 6 */ }
export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions;
export function segmentTranscript(input: SegmentInput, options?: Partial<SegmentOptions>): CandidateSegment[];
export function groupSegments(segments: CandidateSegment[], scriptBlocks: ScriptBlock[], options?: Partial<SegmentOptions>): { segments: CandidateSegment[]; groups: SegmentGroup[] }; // fills groupId/scriptMatch/aside on copies
export function scoreScriptMatch(text: string, block: ScriptBlock): number; // max transcriptSimilarity over sentence windows of 1..3 consecutive sentences and the whole block
export function orderAssets(assets: { assetId: string; fileName: string; capturedAt: string; captureSource: "container" | "file-mtime" }[]): EvidenceAsset[]; // sort by capturedAt then fileName; orderWarning when source is file-mtime, when two share capturedAt, or when capture order disagrees with fileName order
// __fixtures__/scripted-transcript.ts
export function scriptedTranscript(assetId: string, utterances: { atMs: number; text: string }[], rate?: number /* 48000 */, wordOrdinalStart?: number /* 1 */): TranscriptSidecar; // 300 ms per word, 80 ms word gap, confidence 0.95, word ids from `w` + zero-padded wordOrdinalStart upward
```
Segment rules (§4 [A].3, §5.3): walk active words in time order; start a new segment when the gap between previous `end` and this `start` ≥ `segmentPauseMs`, or when a marker of `source: "spoken"` lies in that gap; `pauseBeforeMs` = that gap (null for the first). `text` joins words with `punctBefore/punctAfter`. `confidence` = mean of non-null confidences. `markerPhrases` = notes of spoken markers inside the segment's range. `aside` = `markerPhrases.length > 0` or (`wordCount ≤ asideMaxWords` and best script score < 0.5 when a script exists). Groups: `groupTakeTranscripts` over non-aside segments as candidates (`takeId` = segment id); groups with one member get `groupId` too; `memberIds` in (asset ordinal, segment index) order; `scriptBlock` = block with the highest mean score among members, or null when no script or score < 0.5.

- [ ] **Step 1: Failing tests:**
  - `splits at long pauses and spoken markers` — transcript with "line one words here" at 0 ms, "again" at 2200 ms (with a spoken marker at that time), "line one words here" at 3000 ms → 3 segments, `segments[1].markerPhrases` contains `"again"`, `segments[2].pauseBeforeMs` ≈ 800 ± 100.
  - `groups repeated lines and keeps capture order` — two assets (ordinals 1, 2) each with the same line → one group `G1`, `memberIds` equal `["C1.01","C2.01"]`.
  - `matches a one-sentence take against a three-sentence block` — `scoreScriptMatch("he stayed home", block with sentences [..., "He stayed home."])` ≥ 0.8.
  - `marks short unmatched segments as asides only with a script` — "again" is `aside === true` with a script, and with `scriptBlocks = []` only when it carries a marker phrase.
  - `orders clips by capture time with warnings` (Review Focus 4) — three assets, two sharing `capturedAt` → sorted by fileName within the tie and both carry `orderWarning` matching `/same capture time/`; a `file-mtime` source carries `/modified time/`.
  - `flags low confidence` — words at 0.3 → `lowConfidence === true`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** segments.test.ts and `take-comparison.test.ts` — PASS. **Step 5: Commit** — `feat(transcript): candidate segments and repeat groups for assembly`

---

### Task 5: Evidence package renderer

**Files:**
- Create: `packages/transcript/src/assembly/evidence.ts`, `evidence.test.ts`, snapshot `evidence.test.ts.snap` (vitest `toMatchSnapshot`)

**Interfaces:**
- Produces:
```ts
export interface EvidenceInput { projectName: string; language: string; assets: EvidenceAsset[]; segments: CandidateSegment[]; groups: SegmentGroup[]; scriptBlocks: ScriptBlock[]; notes: string[] }
export const EVIDENCE_TOKEN_LIMIT = 120_000;
export function estimateTokens(text: string): number;            // Math.ceil(text.length / 4)
export function renderEvidencePackage(input: EvidenceInput): AssemblyEvidence; // throws Error("E_ASSEMBLY_EVIDENCE_TOO_LARGE: <n> tokens > limit") above the limit
export function formatClipTime(time: SampleTime): string;         // "mm:ss.mmm"
```
Layout exactly as §5.1–5.3: `# Evidence` header lines; `## Script` with `### S001 — <section>` + text; `## Footage` with `## A<ordinal>  <fileName>   captured <ISO> (<source>)   dur <mm:ss>` then `### C1.07  00:02.140–00:31.890   group G12   script S014 (0.91)   conf 0.94   pause-before 2.1s` (omit a field when null; append `LOW-CONF`; append `ASIDE?   spoken: "again"` when aside), text on the next line; `## Groups` index `G12: C1.07, C3.02` (latest last); `## Notes` bullets.

- [ ] **Step 1: Failing tests:** `renders the documented layout` (snapshot over a 2-asset fixture from Task 4's helper); `omits the script section without a script`; `rejects packages over the token limit` (notes with a 500k-char string → throws `/E_ASSEMBLY_EVIDENCE_TOO_LARGE/`); `hash is sha256 of text`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; review the snapshot by eye against §5.3 before committing. **Step 5: Commit** — `feat(transcript): render assembly evidence package`

---

### Task 6: Reply schema and validation

**Files:**
- Create: `packages/transcript/src/assembly/reply.ts`, `reply.test.ts`

**Interfaces:**
- Produces:
```ts
export const ASSEMBLY_REPLY_SCHEMA: Readonly<Record<string, unknown>>; // JSON schema of AssemblyReply; strict-compatible: every property required, optionals typed ["…","null"], additionalProperties false everywhere, top-level oneOf on status
export interface ReplyContext { words: Map<string, { assetId: string; state: "active" | "deleted"; order: number }>; scriptBlocks: ScriptBlock[]; assetIds: string[] }
export function validateAssemblyReply(value: unknown, context: ReplyContext): Result<AssemblyReply>; // core Result; error code "E_ASSEMBLY_REPLY_INVALID", message lists every problem joined by "; "
```
Checks (§6.2): schema shape; each `about`/cut word id exists and is `active` and belongs to `assetId`; `fromWord` order ≤ `toWord` order; cuts of the same asset do not overlap; `scriptBlock` exists; `flags[].cutIndex` in range; `questions.length ≥ 1` for `questions`; `cuts.length ≥ 1` for `plan`.

- [ ] **Step 1: Failing tests:** `accepts a valid plan`; `accepts a valid question list`; `rejects a deleted word` (Review Focus 3); `rejects reversed word order`; `rejects a cut spanning two assets` (`fromWord` of asset A, `toWord` of asset B); `rejects overlapping cuts`; `rejects an unknown script block`; `schema is strict-compatible` (walk the schema: every object has `additionalProperties: false` and `required` listing all `properties`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** — `feat(transcript): assembly reply schema and validation`

---

### Task 7: Plan compiler (cuts → operations, review markers)

**Files:**
- Create: `packages/transcript/src/assembly/compile.ts`, `compile.test.ts`

**Interfaces:**
- Consumes: `convertTimeRounding` (`packages/core/src/time/operations.ts:202`), `Annotation` (core), `OperationInput`.
- Produces:
```ts
export interface CompileContext { sequenceId: string; layerId: string; fps: Rational; existingClips: { in: FrameTime; out: FrameTime; gapBefore?: FrameTime | null }[]; words: Map<string, TranscriptWord & { assetId: string }>; segments: CandidateSegment[]; assetDurations: Map<string, FrameTime>; leadPadMs?: number /* 120 */; tailPadMs?: number /* 200 */ }
// CompiledCut comes from Task 2's types.ts
export function compileAssemblyPlan(plan: AssemblyPlan, context: CompileContext): Result<{ operations: OperationInput[]; cuts: CompiledCut[] }>;
export function reviewMarkerAnnotations(cuts: CompiledCut[], input: { sequenceId: string; deliverableId: string; aspect: string; authorId: string; now: string; idFactory: (prefix: "ann") => string }): Annotation[];
```
Rules (§8.6): `in` = first word start − leadPad, `out` = last word end + tailPad, each clamped to the enclosing segment's neighbours (never before the previous segment's last word end, never after the next segment's first word start) and to `[0, assetDuration]`, converted with `convertTimeRounding` to `fps`. Operations are `clip.insert` with `index = existingClips.length + i`, `evidence = cut.reason`. `timelineStart` = sum of existing clip lengths (+ gaps) + preceding cuts. Annotations: `shape: "range"`, `anchor: { kind: "timeline", sequenceId, frame: timelineStart.frames }`, `extent` = cut extent, `body` = `"<kind>: <note>"`, `state: "open"`, `blocking: false`, `author: { kind: "agent", id: authorId }`, `history: []`, `geometry: null`, `canvasRef: { sequenceId, deliverableId, aspect }`.

- [ ] **Step 1: Failing tests:** `pads and snaps a cut to frames` (24/1 fps, word 1.000–2.500 s → in = frame 21 (0.88 s), out = frame 65 (2.70 s)); `clamps padding at segment neighbours`; `appends after existing clips` (two existing 48-frame clips → first `index === 2`, `timelineStart.frames === 96`); `rejects a cut beyond asset duration` (error `E_ASSEMBLY_CUT_OUT_OF_RANGE`); `one annotation per flagged cut` (two cuts, flags on cut 1 only → 1 annotation anchored at cut 1's `timelineStart`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** — `feat(transcript): compile assembly plans into clip operations`

---

### Task 8: LLM adapter interface, pricing, system prompt, stub adapter

**Files:**
- Create: `packages/agent/src/llm/types.ts`, `pricing.ts`, `pricing.test.ts`, `assembly-prompt.ts`, `assembly-prompt.test.ts`, `stub.ts`, `stub.test.ts`, `index.ts`
- Modify: `packages/agent/src/index.ts` (export `./llm/index.js`)

**Interfaces:**
- Produces:
```ts
export interface LlmMessage { role: "user" | "assistant"; content: string }
export interface LlmRequest { model: string; effort: AssemblyEffort; system: string; messages: LlmMessage[]; responseSchema: Readonly<Record<string, unknown>>; maxOutputTokens: number; signal?: AbortSignal }
export interface LlmCompletion { reply: unknown; usage: { inputTokens: number; outputTokens: number } }
export class LlmAdapterError extends Error { constructor(message: string, readonly status: number | null, readonly retryable: boolean) }
export interface LlmAdapter { readonly provider: AssemblyProvider; complete(request: LlmRequest): Promise<LlmCompletion>; listModels(): Promise<string[]> }
export interface LlmAdapterOptions { apiKey: string; fetch?: typeof fetch; baseUrl?: string }
export function createLlmAdapter(provider: AssemblyProvider, options: LlmAdapterOptions): LlmAdapter; // "stub" ignores options
// pricing.ts
export interface LlmRate { inputPerMTok: number; outputPerMTok: number }
export const DEFAULT_LLM_RATES: Readonly<Record<string, LlmRate>>; // keys are model ids; ship entries for claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5 and the OpenAI models listModels returns by default — the builder copies current USD/MTok values from each provider's pricing page at implementation time and cites the page in a comment
export function resolveRate(rates: Readonly<Record<string, LlmRate>>, provider: AssemblyProvider, model: string): { rate: LlmRate; estimated: boolean }; // unknown model → highest input+output rate among that provider's known models, estimated: true; "stub" → zeros
export function estimateUsd(rate: LlmRate, usage: { inputTokens: number; outputTokens: number }): number;
export const ASSEMBLY_OUTPUT_TOKEN_ESTIMATE = 4000;
// assembly-prompt.ts
export function assemblySystemPrompt(): string; // role, rules R1–R6 verbatim from §3, evidence format summary, output contract (§6.2), "never answer outside the schema"
```
Stub behaviour (`StubLlmAdapter`, deterministic, reads the evidence text from the first user message using the Task 5 layout): on the first assistant turn, if any segment line carries `ASIDE?`, reply `questions` with one question `Q1` about that segment (`options: ["Instruction, drop it", "It is a line, keep it"]`); otherwise, or on any later turn, reply `plan`: for every group take the last member; non-aside ungrouped segments in capture order; order cuts by `script S…` block id when present, else capture order; reason `"Latest of <n> attempts (G<k>)"` or `"Only attempt"`; one flag `kind: "other"` per multi-member group; `tightening: null`; usage `{inputTokens: estimateTokens(all text), outputTokens: 200}`. `listModels()` → `["stub-model"]`.

- [ ] **Step 1: Failing tests:**
  - pricing: `unknown model is priced at the provider maximum and marked estimated`; `estimateUsd scales per million tokens` (1M in + 1M out at {3, 15} → 18).
  - prompt: contains `"Latest take wins"`, `"Ask, don't guess"`, `"status"`, and no `{`-template leftovers.
  - stub: `asks about an aside on the first turn` (evidence from Task 5 fixture with an `ASIDE?` line → `status === "questions"`, `questions[0].about.assetId` is that segment's asset); `plans latest-wins after the answer` (second call → `plan` with one cut per group, cut for G1 is the last member); `plans immediately without asides`; `createLlmAdapter("stub", …).provider === "stub"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (stub may reuse Task 4/5 parsing helpers by importing from transcript). **Step 4: Run** — PASS. **Step 5: Commit** — `feat(agent): llm adapter contract, pricing, assembly prompt, stub`

---

### Task 9: Anthropic and OpenAI adapters

**Files:**
- Create: `packages/agent/src/llm/anthropic.ts`, `anthropic.test.ts`, `openai.ts`, `openai.test.ts`
- Modify: `packages/agent/src/llm/index.ts` (`createLlmAdapter` dispatch)

**Interfaces:**
- Produces: `AnthropicLlmAdapter`, `OpenAiLlmAdapter` implementing `LlmAdapter`; both take `LlmAdapterOptions` and use `options.fetch ?? globalThis.fetch`.

Anthropic (`POST {baseUrl ?? "https://api.anthropic.com"}/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`): body `{ model, max_tokens: budget + maxOutputTokens, system, messages, thinking: { type: "enabled", budget_tokens: budget }, tools: [{ name: "assembly_reply", description: "Return the assembly reply.", input_schema: responseSchema }], tool_choice: { type: "auto" } }` with `budget` = low 2048 / medium 8192 / high 16384 / max 32768 (forced `tool_choice` is incompatible with thinking, so the system prompt demands the tool). `reply` = `input` of the first `tool_use` block; no such block → `LlmAdapterError("model did not call assembly_reply", null, true)`. Usage from `usage.input_tokens/output_tokens`. `listModels`: `GET /v1/models` → `data[].id`. HTTP ≥ 400 → `LlmAdapterError(<status> + body `error.message` if present, status, status === 429 || status ≥ 500)`.

OpenAI (`POST {baseUrl ?? "https://api.openai.com"}/v1/responses`, `Authorization: Bearer`): body `{ model, instructions: system, input: messages, reasoning: { effort: low→"low", medium→"medium", high→"high", max→"high" }, max_output_tokens: maxOutputTokens, text: { format: { type: "json_schema", name: "assembly_reply", schema: responseSchema, strict: true } } }`. `reply` = `JSON.parse` of the concatenated `output[].content[].text` where `type === "output_text"`; parse failure → `LlmAdapterError("non-JSON reply", null, true)`. Usage `usage.input_tokens/output_tokens`. `listModels`: `GET /v1/models` → `data[].id` sorted. Errors as above.

- [ ] **Step 1: Failing tests** (inject `fetch` as `vi.fn` returning `new Response(JSON.stringify(body), { status })`; assert on the request URL, headers and parsed body):
  - anthropic: `sends thinking budget and the reply tool`; `returns the tool_use input and usage`; `fails readably on 429` (Review Focus 5: error `retryable === true`, message contains `"429"`); `fails when no tool call`.
  - openai: `sends reasoning effort and strict json schema`; `parses output_text json`; `fails readably on 500 and non-JSON` (status 200 with body `"not json"` → `/non-JSON/`).
  - `createLlmAdapter` returns the right class per provider.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** both test files + `pnpm --filter @guyditor/agent typecheck && lint` — PASS. **Step 5: Commit** — `feat(agent): anthropic and openai llm adapters`

---

### Task 10: AI settings — persisted `ai` section, `AiSettingsService`, IPC surface

**Files:**
- Create: `packages/app/src/main/ai-settings-service.ts`, `ai-settings-service.test.ts`
- Modify: `packages/app/src/main/settings.ts` (interface + defaults + `saveAiSettings`), `packages/app/src/shared/ipc.ts:14-19` (`ServiceName` + `"AiSettings"`), `packages/app/src/main/surfaces.ts` (manifest), `packages/app/src/main/service-host.ts` (`AppServiceHostOptions.settings` gains `ai` and `externalCalls`; one `case "AiSettings"` returning `this.#app.aiSettings.surface()`), `packages/app/src/main/index.ts:336-353` (pass `ai` + `network.externalCalls` + `userDirectory`)

**Interfaces:**
- Produces:
```ts
// settings.ts
export interface AiSettings { provider: "anthropic" | "openai"; model: string; effort: AssemblyEffort; tightening: TighteningMode; rates: Record<string, LlmRate> }
// UserSettings gains `ai: AiSettings`; DEFAULT_SETTINGS.ai = { provider: "anthropic", model: "claude-opus-5-5", effort: "high", tightening: "ask", rates: { ...DEFAULT_LLM_RATES } }
export async function saveAiSettings(userDirectory: string, ai: AiSettings): Promise<void>; // read file (or {}), replace only `ai`, write atomically (tmp + rename), keep unknown keys
// ai-settings-service.ts
export interface AiSettingsView extends AiSettings { keys: { anthropic: boolean; openai: boolean }; externalCalls: "allow" | "ask" | "block"; encryptionAvailable: boolean }
export class AiSettingsService {
  constructor(options: { userDirectory: string; credentials: CredentialStore; initial: AiSettings; externalCalls: UserSettings["network"]["externalCalls"]; encryptionAvailable: boolean; adapterFactory?: typeof createLlmAdapter });
  current(): AiSettings;
  externalCalls(): "allow" | "ask" | "block";
  async apiKey(provider: "anthropic" | "openai"): Promise<string | undefined>; // credentials.get("llm", provider)
  surface(): Record<string, (params: never) => unknown>; // get, update, listModels, setKey, clearKey
}
```
IPC manifest (`budgetMs: 20`, `anyResult`): `get {}` → `AiSettingsView`; `update { provider?, model?, effort?, tightening?, rates? }` → view (validates enums, persists via `saveAiSettings`); `listModels { provider }` → `string[]` (adapter `listModels`; no key → error `E_AI_KEY_MISSING`); `setKey { provider, key: minLength 1 }` → view (never echoes the key); `clearKey { provider }` → view.

- [ ] **Step 1: Failing tests** (service with `EphemeralCredentialStore` and a temp user dir):
  - `reports key presence without the value` — after `setKey`, `get().keys.anthropic === true` and `JSON.stringify(get())` does not contain the key.
  - `persists updates and keeps unknown settings keys` — write `settings.json` with `{"schema":1,"custom":true}`, `update({ effort: "low" })`, re-read file: `custom === true` and `ai.effort === "low"`; `loadSettings` returns `effort: "low"`.
  - `rejects an unknown provider` — `update({ provider: "x" })` throws `/E_AI_SETTINGS_INVALID/`.
  - `listModels requires a key` — throws `/E_AI_KEY_MISSING/`; with a key, uses the injected adapter factory's list.
  - surfaces test: `IPC_SURFACES` contains `AiSettings` with those five methods.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** tests + app typecheck/lint + `pnpm check:conventions` (size!) — PASS. **Step 5: Commit** — `feat(app): ai provider settings and credentials service`

---

### Task 11: `AssemblyService` — sessions, prepare job, sidecar persistence, IPC

**Files:**
- Create: `packages/app/src/main/assembly-service.ts`, `assembly-prepare.ts`, `assembly-service.test.ts`
- Modify: `packages/app/src/shared/ipc.ts` (`ServiceName` + `"Assembly"`; `GdEvent` + `{ kind: "assembly.updated"; seq: number; sessionId: string }`; `export type AssemblySessionView`), `surfaces.ts` (manifest), `service-host.ts` (lazy per-project `AssemblyService` in a `WeakMap<ProjectServices, AssemblyService>`, `case "Assembly"`, executor registration next to `:1081`)

**Interfaces:**
- Consumes: Tasks 2–5, `transcriptSidecars(store)` (`project-readers.ts:13`), take-marker sidecar parsing (`packages/core/src/takes/sidecar.ts`), `JobQueue.enqueue/registerExecutor/onChange`, the persist pattern of `take-comparison-service.ts:321-341` (`sidecar.register`, origin `"system"`, `recordUndo: false`).
- Produces:
```ts
export type AssemblySessionView = Omit<AssemblySession, "evidence"> & { evidence: Omit<AssemblyEvidence, "text"> | null };
export interface AssemblyServiceOptions { project: ProjectServices; store: ProjectStore; engine: () => OperationEngine; aiSettings: AiSettingsService; auditLog: AuditLog; costMeter: CostMeter; publish: (event: GdEventWithoutSeq) => void; now?: () => Date; idFactory?: IdFactory; adapterFactory?: typeof createLlmAdapter; environment?: NodeJS.ProcessEnv }
export class AssemblyService {
  constructor(options: AssemblyServiceOptions);
  async list(): Promise<AssemblySessionView[]>;
  async create(input: { assetIds: string[]; scriptPath?: string }): Promise<AssemblySessionView>; // copies the script to sidecars/scripts/<asb>.script.md (sha256), writes + registers the session sidecar, status "created"
  prepare(sessionId: string): JobStatus; // enqueue kind "assembly.prepare", title "Analyze footage for assembly", payload { sessionId }, cancellable: true
  async get(sessionId: string): Promise<AssemblySessionView>;
  async abandon(sessionId: string): Promise<AssemblySessionView>;
  surface(): Record<string, (params: never) => unknown>;
}
// assembly-prepare.ts
export interface PrepareDeps { store: ProjectStore; readSession: (id: string) => Promise<AssemblySession>; writeSession: (s: AssemblySession) => Promise<void>; transcripts: () => Promise<TranscriptSidecar[]>; markers: (assetId: string) => Promise<MarkerRecord[]>; jobs: JobQueue }
export function registerAssemblyPrepareExecutor(queue: JobQueue, deps: PrepareDeps): void;
export async function prepareSession(deps: PrepareDeps, sessionId: string, signal: AbortSignal, reportProgress: (p: number) => void): Promise<AssemblySession>;
```
`prepareSession`: status → `preparing`; for each asset without a transcript sidecar, if a `transcribe` job for it is queued/running wait for it (`queue.onChange`, honouring `signal`), else add note `"<fileName>: no transcript — run transcription first"` and skip; assets with zero active words → note `"<fileName>: no speech, skipped"` (Review Focus 1); build `EvidenceAsset[]` via `orderAssets` (capturedAt from `asset.captureTime`), segments via Task 4, groups, evidence via Task 5; store, status → `conversing`; on any throw status → `failed` with `error`. Progress: assets done / total. Session writes always go through one serialized `writeSession` that rewrites the file and re-runs `sidecar.register` with the same `name` (verify in `engine.ts` that `sidecar.register` upserts by name; if it appends, make it upsert — low-risk op, add a test in `engine.test.ts`).

IPC manifest: `list {}`, `create { assetIds: string[] minItems 1 (ast_ pattern), scriptPath?: string }`, `prepare { sessionId: ^asb_… }`, `get { sessionId }`, `abandon { sessionId }`; `send`/`createProposal` are added in Tasks 12–13.

- [ ] **Step 1: Failing tests** (`testAppHost` pattern from `service-host.test.ts`; project from a template with two transcripted video assets — extend the test fixture builder used there, or build with `createProject` + two `scriptedTranscript` sidecars registered):
  - `create copies the script and registers the session sidecar` — after `create`, `store.currentProject.sidecars` has `schema "guyditor.assembly/v1"` and `sidecars/scripts/<id>.script.md` exists with the recorded sha256.
  - `prepare builds evidence and publishes assembly.updated` — run the executor directly via `prepareSession`; `status === "conversing"`, `evidence.groups.length ≥ 1`, publish spy called with `{ kind: "assembly.updated", sessionId }`.
  - `prepare skips a silent clip with a note` — asset whose transcript has no active words → `evidence.notes` contains `/no speech/`.
  - `prepare fails cleanly without transcripts` — status `failed`, `error` matches `/no transcript/`.
  - `views omit evidence text` — `get()` result has no `evidence.text` key.
  - surfaces: `Assembly` manifest has `list/create/prepare/get/abandon`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** + typecheck/lint + conventions — PASS. **Step 5: Commit** — `feat(app): assembly sessions and prepare job`

---

### Task 12: `AssemblyService.send` — audit session, cost gate, provider turn, validation retry

**Files:**
- Modify: `packages/app/src/main/assembly-service.ts`, `assembly-service.test.ts`, `surfaces.ts` (`send`)
- Create: `packages/app/src/main/assembly-turn.ts`, `assembly-turn.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (`agent/src/session.ts:41,48`), `CostMeter.preflight/record` (`cost-meter.ts:234,322`), `AuditLog`, Task 6 `validateAssemblyReply`, Task 8 prompt/pricing, `AiSettingsService.current()/apiKey()/externalCalls()`.
- Produces:
```ts
export type SendInput = { sessionId: string; text?: string; optionIndex?: number; questionId?: string; confirmToken?: string; acknowledgeExternal?: boolean };
export type SendResult =
  | { kind: "turn"; session: AssemblySessionView }
  | { kind: "confirm-cost"; message: string; confirmToken: string; estimatedUsd: number; estimated: boolean }
  | { kind: "blocked"; message: string }
  | { kind: "acknowledge-external"; provider: AssemblyProvider; notice: string };
// assembly-turn.ts (pure orchestration, injectable)
export interface TurnDeps { adapter: LlmAdapter; system: string; schema: Readonly<Record<string, unknown>>; context: ReplyContext; maxTurns: number /* 12 */ }
export async function runAssemblyTurn(session: AssemblySession, userText: string, deps: TurnDeps): Promise<{ session: AssemblySession; usage: { inputTokens: number; outputTokens: number } }>; // appends the user message, calls adapter with full history (first user message = evidence text + "\n\n" + user text on turn 1), validates; on E_ASSEMBLY_REPLY_INVALID appends a "validation" message with the errors and calls once more; second failure → throws Error("E_ASSEMBLY_REPLY_INVALID: …"); plan → status "planned" and session.plan set; questions → status "conversing"; over maxTurns → throws Error("E_ASSEMBLY_TURN_LIMIT")
```
`send` flow: resolve adapter (`GUYDITOR_ASSEMBLY_STUB=1` → stub; else `createLlmAdapter(settings.provider, { apiKey })`, missing key → error `E_AI_KEY_MISSING`); the external gate applies only to real providers (the stub sends nothing): `externalCalls === "block"` → `{ kind: "blocked" }`; `"ask"` and `!session.externalAcknowledged && !acknowledgeExternal` → `{ kind: "acknowledge-external", notice: "Sends the transcript and script text to <provider>. Never audio or video." }` (acknowledging sets `externalAcknowledged` and persists); the service owns one `SessionManager` built in its constructor from `options.auditLog`; open the audit session on first send: `sessionManager.open({ projectId, director: { profileId: "assembly", modelLabel: "<provider>/<model>", locality: "remote" }, policySnapshot: { externalCalls } })`, store `auditSessionId`; the user text for `optionIndex` is the option string. Cost: `estimate = { adapterId: "llm." + provider, currency: "USD", amount: estimateUsd(rate, { inputTokens: estimateTokens(system + history), outputTokens: ASSEMBLY_OUTPUT_TOKEN_ESTIMATE }), units: {...}, confidence: estimated ? "heuristic" : "pricebook" }`; `preflight(estimate, { sessionId: auditSessionId, projectId, taskId: session.id, initiator: "creator" }, confirmToken)` → `warn` → `{ kind: "confirm-cost" }`, `blocked` → `{ kind: "blocked" }`. After the turn (or on adapter error) `costMeter.record({ context, estimate, provider, purpose: "assembly", dataClassesSent: ["prompt", "transcript"], payloadSummary: { promptChars, transcriptWords }, units: { inputTokens, outputTokens }, actualUsd: estimateUsd(rate, usage), outcome, durationMs })`. Adapter errors → session stays `conversing`, `error` set to the message, rethrown as `E_ASSEMBLY_PROVIDER: <message>`. Also: when `settings.tightening === "ask"` and the session has no user turns yet, the first user text is prefixed with `"Tightening preference: ask me before planning. "` so the model raises it as a question; a plan's `tightening` answers it. Publish `assembly.updated` after every persisted change.

- [ ] **Step 1: Failing tests:**
  - turn: `first turn carries the evidence`; `retries once on an invalid reply then succeeds` (adapter mock returns bad then good; messages contain one `validation` role); `fails after the second invalid reply`; `stops at the turn limit`.
  - service: `blocks when externalCalls is block`; `asks for acknowledgement once when externalCalls is ask` (first `send` → `acknowledge-external`; second with `acknowledgeExternal: true` → `turn`; third needs no flag); `surfaces a cost warning and proceeds with the token` (budgets `{ task: { warnUsd: 0, capUsd: null } }` → `confirm-cost`, resend with `confirmToken` → `turn`); `records external.call and cost.charge in the audit log` (read the session's audit file; both record types present with `dataClassesSent` containing `"transcript"`); `keeps the session conversing on a provider error` (Review Focus 5: adapter throws `LlmAdapterError("429", 429, true)` → `send` rejects `/E_ASSEMBLY_PROVIDER/`, `get().status === "conversing"`, `error` matches `/429/`, a second `send` works).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** + typecheck/lint/conventions — PASS. **Step 5: Commit** — `feat(app): assembly conversation turns with cost gate and audit`

---

### Task 13: Proposal creation, acceptance hook, review markers, gentle tightening

**Files:**
- Modify: `packages/app/src/main/assembly-service.ts` (+ `createProposal`, `onProposalAccepted`), `assembly-service.test.ts`, `surfaces.ts` (`createProposal`), `packages/app/src/main/filler-follow-up.ts` (kept-range filter + review markers), `service-host.ts` (`#acceptProposal`: one line `await this.#assemblyFor(project)?.onProposalAccepted(proposalId)`; `assist.fillers.detect` done-handler passes through unchanged), `packages/transcript/src/fillers/types.ts` (`EnqueueFillerDetectionInput.scope?`, `FillerDetectionResult.scope?`), `fillers/job.ts` (copy `scope` from payload into the result), `fillers/index.ts` (export `GENTLE_FILLER_RULE_SET`)
- Create: `packages/transcript/src/fillers/gentle.ts`, test additions in `fillers/job.test.ts` and `packages/app/src/main/filler-follow-up.test.ts`

**Interfaces:**
- Produces:
```ts
// fillers
export interface FillerScope { assemblySessionId: string; keptRanges: SourceSampleRange[] }
export const GENTLE_FILLER_RULE_SET: FillerRuleSet = { version: 1, pauses: { minRemovableMs: 1200, keepAtSentenceBoundaryMs: 1500, retainMs: 500 }, fillers: { remove: [], review: ["um", "uh", "erm", "ehm"], keep: [] }, repeats: { enabled: true, minWords: 3 }, falseStarts: { enabled: true }, limits: DEFAULT_FILLER_RULE_SET.limits, padding: { cutPaddingMs: 120 } };
// filler-follow-up.ts
export function withinKeptRanges(candidate: FillerCandidate, scope: FillerScope | undefined): boolean; // no scope → true; else same assetId and start ≥ kept.start and end ≤ kept.end comparing in seconds (samples / rate)
// AssemblyService
async createProposal(sessionId: string): Promise<{ proposalId: string; session: AssemblySessionView }>;
async onProposalAccepted(proposalId: string): Promise<void>;
```
`createProposal`: requires status `planned`; builds `CompileContext` from the master (sequence = `deliverables.find(id === settings.primaryDeliverable).sequenceId`, layer = lowest-order `kind: "video"` layer bound to it, `fps = settings.timeline.fps`, existing clips, word map from transcripts, `assetDurations` from `asset.probe.duration`); `engine.createProposal({ operations, instruction: { kind: "user-text", text: plan.summary }, actor: { kind: "agent", id: "<provider>:<model>", model }, sessionId: auditSessionId, reason: { text: plan.summary.slice(0, 280 with "…"), sources: [{ kind: "media-evidence", ref: evidence.sha256 }, { kind: "instruction", ref: session.id }] }, addresses: [] })`; store `proposalId`, status `proposed`, and the `CompiledCut[]` in `session.compiled`. `onProposalAccepted`: find the session by `proposalId`; status `accepted`; create review markers via `project.annotations.execute(store, annotation.create ops from reviewMarkerAnnotations(...), { origin: "agent", sessionId: auditSessionId, dryRun: false })`; if effective tightening (`plan.tightening ?? settings.tightening`) is `"gentle"`: `enqueueFillerDetection(project.jobs, { assetIds: cut assets, fillerRules: GENTLE_FILLER_RULE_SET, scope: { assemblySessionId, keptRanges: cuts as SourceSampleRange } })`, store `tighteningJobId`. `createFillerProposal` (Task 1 module): when the result carries `scope`, drop candidates failing `withinKeptRanges` before compiling; for every compiled `reviewRequired` candidate with a `wordRange`, create an annotation (`shape: "range"`, `anchor: { kind: "word", wordId: fromWord }`, `extent: { frames: 0, fps }`, `body: "review: <evidence>"`, `author: { kind: "agent", id: "assist.fillers.detect" }`) through `project.annotations.execute` with `origin: "agent"`.

- [ ] **Step 1: Failing tests:**
  - fillers: `executor carries scope into its result`; `GENTLE_FILLER_RULE_SET shortens pauses instead of removing them` (`retainMs === 500`, `fillers.remove` empty).
  - follow-up: `withinKeptRanges accepts inside and rejects outside and other assets`; `scoped results only compile kept candidates and add review markers` (two candidates, one outside → proposal has one op; one `reviewRequired` → one annotation created with `author.kind === "agent"`).
  - service: `createProposal appends clips after existing ones with a reason` (proposal `operations[0].op === "clip.insert"`, `riskClass === "normal"`, status `proposed`); `rejects createProposal before a plan` (`/E_ASSEMBLY_NOT_PLANNED/`); `acceptance creates review markers and enqueues gentle tightening` (accept via the host's OperationEngine `acceptProposal` IPC → annotations list has the flag marker anchored at the cut's `timelineStart`; a job of kind `assist.fillers.detect` exists whose payload `scope.assemblySessionId` is the session; `status === "accepted"`); `tightening off enqueues nothing`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** all touched test files + `service-host.test.ts` + typecheck/lint/conventions — PASS. **Step 5: Commit** — `feat(app): assembly proposals, review markers, gentle tightening`

---

### Task 14: Renderer — Assemble panel, AI settings section, layout migration, App wiring

**Files:**
- Create: `packages/app/src/renderer/panels/AssemblePanel.tsx`, `AssemblePanel.test.ts`, `packages/app/src/renderer/panels/AiSettingsSection.tsx`
- Modify: `renderer/state/layout-state.ts` (`DOCK_PANEL_IDS` + `"assemble"`; freeze today's 13 ids as `PRE_ASSEMBLE_DOCK_PANEL_IDS` with a guard `isPreAssembleWorkspaceLayout` and `migratePreAssembleLayout(previous, phase)` modelled on `migratePreOnboardingLayout` (:604-626): copy regions, append `"assemble"` to `right-top` for `cut` and `right-bottom` for `ingest`, `railCollapsed.assemble = false`; dispatch from `parseLayout` (:543) and `parseWorkflowLayouts` (:561); `PANEL_PLACEMENTS` (:208-257) gets `assemble` in `cut`/right-top and `ingest`/right-bottom), `renderer/state/tool-rail.ts:52-66` (`assemble: { icon: "A", name: "Assemble" }`), `renderer/panels/Panel.tsx:85` (`panelNumber` → `assemble: 14`), `renderer/App.tsx:1081` (`assemble: <AssemblePanel {...panelProps} />`) and `:782` (`job.state` for kind `assembly.prepare` → `refreshProject()`), `App.tsx` event subscription `window.guyditor.on("assembly.updated", …)` → bump a `assemblyVersion` counter passed down via a new optional `WorkspacePanelProps.assemblyVersion?: number`, `renderer/workspace-navigation.ts` (`export async function jumpToWordRange(assetId: string, fromWord: string, toWord: string, setNotice): Promise<void>` — mirror `MediaBrowserPanel.jumpToCandidate` :215-222: `revealPanel("preview")`, `setPlayhead(<source frame of fromWord>)`, `selectWord(fromWord)`, `setWordRange(fromWord, toWord)`), `layout-state.test.ts` (migration cases)

**Interfaces:**
- Consumes: IPC `Assembly.*`, `AiSettings.*` (Tasks 10–13), `errorMessage`, `useJobsStore`, `Panel`.

Panel (§8.5) — three regions with these test ids:
- Inputs: asset list `assembly-asset-<assetId>` checkboxes (default: all `video`/`audio` assets, capture order; row shows ✓/… transcript state from `transcripts`/jobs), script path row `assembly-script-path` (a text input like the Media panel's Local path; no native picker in this plan), settings strip `assembly-settings-summary` ("anthropic · claude-opus-5-5 · high · tightening: ask") toggling `AiSettingsSection`, notice `assembly-external-notice` with the fixed copy, button `assembly-analyze` (disabled while no project, no selected assets, or a prepare job is running; label "Analyze footage"), summary `assembly-evidence-summary` ("3 clips · 7 segments · 2 repeat groups · script: 12 blocks").
- Conversation: `assembly-messages`, per question card `assembly-question-<n>` with `assembly-jump-<n>` (calls `jumpToWordRange`) and option buttons `assembly-option-<n>-<i>`; input `assembly-input` + `assembly-send` (first send before any evidence is disabled). `confirm-cost` result renders `assembly-confirm-cost` ("Confirm $X.XX") which resends with the token; `acknowledge-external` renders `assembly-acknowledge` which resends with `acknowledgeExternal: true`; `blocked` renders the message.
- Plan: table `assembly-plan` with rows `assembly-cut-<i>` (block, clip name, `mm:ss–mm:ss`, reason, flag badges), `assembly-create-proposal`; after creation a link button `assembly-open-proposal` calling `jumpToProposal`.
- `AiSettingsSection`: provider radios `ai-provider-anthropic|openai`, model combo `ai-model` (datalist from `listModels` when a key exists), effort select `ai-effort`, tightening select `ai-tightening`, key field `ai-key` + `ai-key-save` + `ai-key-clear`, status text `ai-key-status` ("Key saved ✓" / "No key"), rates table `ai-rate-<model>` (two number inputs), and a line when `encryptionAvailable === false`: "Keys will not persist across restarts on this system."
- All state the panel needs comes from `Assembly.list/get` refreshed on mount and on `assemblyVersion` change; the newest non-abandoned session is the active one.

- [ ] **Step 1: Failing tests:**
  - layout: `migrates a pre-assemble layout without resetting regions` (a saved v2 layout with 13 ids parses, keeps its regions, and gains `assemble` in `right-top`); `default cut layout places assemble right-top`.
  - panel (renderToStaticMarkup, store mock pattern from `StatusStripPanel.test.ts:10`): `renders inputs with the external notice and a disabled analyze button without a project`; `lists speech assets with transcript state`; `renders question cards with jump and option buttons` (feed a session view via a mocked `window.guyditor.call` resolving `Assembly.list`); `renders plan rows and the create button`.
  - `Panel.tsx` `panelNumber("assemble") === 14`; `PANEL_LABELS.assemble.name === "Assemble"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** renderer tests + `pnpm --filter @guyditor/app typecheck && lint` — PASS; then `pnpm --filter @guyditor/app dev` once and click through Analyze → stub turn with `GUYDITOR_ASSEMBLY_STUB=1` (reload the window after renderer edits: dev mode has no HMR). **Step 5: Commit** — `feat(app): Assemble panel and AI settings`

---

### Task 15: Fixture template `assembly` and Playwright e2e

**Files:**
- Modify: `scripts/make-fixtures.mjs` (`createAssemblyProjectTemplate` + `makeScriptedTranscriptFixture`), `scripts/fixture-spec.mjs:3` (`REQUIRED_PROJECT_TEMPLATES` + `"assembly"`), `.fixtures/scripts/assembly.raw.md` (generated by the same script)
- Create: `packages/app/e2e/assembly.spec.ts`

**Interfaces:**
- Produces: template `.fixtures/projects/assembly`: three video assets `ast_assemblyaa|ab|ac` (bytes copied from `bars-1080p30-10s.mp4`, capture times 10:00:00, 10:00:40, 10:01:30 `container`), transcripts: A = "Could AI talk you into the dumbest decision of your life" at 0.5 s, "again" at 6.0 s with a spoken take marker, same line at 7.5 s; B = "Your gut says no mine did too"; C = "Then I read a medical case from Switzerland"; script file with those three lines as three quoted paragraphs under `## 1. Hook`. `makeScriptedTranscriptFixture({ assetId, rate, utterances, wordOrdinalStart })` mirrors Task 4's test helper in plain JS.

- [ ] **Step 1: Write the e2e** `assembly.spec.ts` (fails until the template exists): `launchApp({ projectTemplate: ".fixtures/projects/assembly" })` with `process.env.GUYDITOR_ASSEMBLY_STUB = "1"` set before launch; click `phase-tab-cut`; fill `assembly-script-path` with the template's script path; click `assembly-analyze`; expect `assembly-evidence-summary` to contain `"3 clips"`; click `assembly-send`; expect `assembly-question-0` visible; click `assembly-option-0-0`; expect `assembly-plan` rows `assembly-cut-0..2`; click `assembly-create-proposal`; click the Proposal panel's accept control (reuse the test id `ac004.spec.ts` uses); assert via `page.evaluate(() => window.guyditor.call("ProjectStore", "snapshot", {}))` that the main sequence has 3 clips whose first clip's asset is `ast_assemblyaa` with `in.frames > 150` (the second attempt), and via `AnnotationService.list` that exactly one annotation has `author.kind === "agent"`; assert `JobQueue.list` holds no `assist.fillers.detect` job (default tightening is `ask` and the stub's plan leaves `tightening: null`, so nothing is enqueued).
- [ ] **Step 2: Run** `pnpm fixtures && pnpm test:e2e -- e2e/assembly.spec.ts` — FAIL (template missing).
- [ ] **Step 3: Implement** the template generator and regenerate.
- [ ] **Step 4: Run** `pnpm fixtures && node scripts/test-e2e.mjs` (full, builds first) — expect the new spec PASS and the existing suite unchanged.
- [ ] **Step 5: Commit** — `test(e2e): assembly fixture template and end-to-end flow`

---

### Task 16: Docs, traceability, amendment pointer

**Files:**
- Modify: `docs/MANUAL.md` (new "Assemble a rough cut" section: inputs, the six rules in creator words, the chat, review markers, AI settings and keys, what leaves the machine, stub mode), `docs/traceability.md` (FR-005 → `implemented` citing Tasks 11–15 tests; add rows for the new assembly behaviour under Part 9 with test paths), `docs/PROJECT-STATE.md` (one paragraph), `docs/amendments/008-ai-assembly.md` (create: title, date, pointer to the spec and this plan, list of new settings keys and the `asb` prefix)

- [ ] **Step 1: Write the docs.** No tests; the Help panel renders `MANUAL.md` verbatim — open it in the app once and check the new section renders.
- [ ] **Step 2: Run** `pnpm check:conventions && pnpm test` (full unit suite) — PASS.
- [ ] **Step 3: Commit** — `docs: assembly manual section, traceability, amendment 008`

---

## Self-review notes

- Spec coverage: §3 rules → Task 8 prompt + Task 4 ordering + stub; §4 [A] → Task 11; [B] → Task 12 + 14; [C]/[D] → Task 13; §5 → Tasks 3–5; §6 → Tasks 6, 8, 9, 12; §7 reuse → referenced by file:line; §8.1 → Tasks 10–13; §8.2 → Task 2; §8.3 → Tasks 10, 13; §8.4 → Tasks 8–9; §8.5 → Task 14; §8.6 → Task 7; §9 → Task 12 (gate, audit, acknowledge) + Task 10 (keys); §10 → each task's tests + Task 15; §11 builder items are pinned above (thresholds in Tasks 4, 7, 13; `fetch` over SDKs in Task 9; navigation in Task 14; one job with progress in Task 11; both phase layouts in Task 14; docs in Task 16).
- Deviation from the spec, deliberate: prepare does not enqueue transcription itself (Task 11) — it waits for in-flight `transcribe` jobs and otherwise reports which clips still need it, because the existing enqueue needs an extracted audio path that only ingest produces. Ingest already auto-transcribes, so the gap only appears for clips imported with transcription switched off.
- Added in this plan, not in the spec: `AssemblySession.compiled` and `externalAcknowledged` (Task 2, used in Tasks 12–13), `FillerScope` on filler jobs (Task 13), `WorkspacePanelProps.assemblyVersion` (Task 14), the stub bypassing the external-send gate (Task 12).
