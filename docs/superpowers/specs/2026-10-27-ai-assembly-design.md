# AI-assisted rough-cut assembly — design

**Date:** 2026-10-27
**Status:** reviewed draft, awaiting creator approval
**Owner:** Martin (creator); design written with Claude
**Spec parts touched:** 3 (ingest/takes), 4 (transcript), 5 (operations/proposals), 8 (annotations), 9 (agent/adapters/audit/secrets), 10 (UI)

## 1. Intent

Martin records a talking-head episode on one iPhone, in one or more clips, keeping the
camera rolling and simply saying a line again when a take goes wrong. He wants to drop
those clips (and the episode script) into Guyditor and have it produce the cleaned-up
cut: the right take of every line, in script order, abandoned takes and between-take
chatter removed, pauses gently tightened. That cut is the starting point for everything
later (captions, graphics, shorts); nothing downstream is in scope here.

The judgement calls (which repeat is the real retake, what a mumbled aside meant, whether
a partial retake should be stitched onto the earlier take) go to a hosted LLM of the
creator's choosing. The model does not get to guess silently: anything it cannot settle
from the evidence it asks about, in a chat, pointing at the exact spot in the footage.
When everything is clear it emits a plan, which becomes a normal Guyditor proposal the
creator accepts with one click.

The first use is the `ep001-ai-dangerous-advice` episode: ~7 iPhone clips, built-in
audio, Martin alone in the woods, script in `whp-youtube/episodes/<ep>/final/script.raw.md`.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. One flow from "clips + script in" to "accepted sequence on the timeline", with the
  creator touching the keyboard only to answer questions and click Accept.
- G2. The model sees everything a human assistant editor would: timestamped words, pauses,
  low-confidence stretches, repeat detection, spoken asides, file order, the script.
- G3. Uncertainties are explicit, located (jump-to-footage), and resolved in a chat before
  any plan is made.
- G4. The result is a proposal: discarded takes stay recoverable, every cut carries a
  reason, review markers mark what the model wasn't sure about.
- G5. Provider, model and effort are the creator's choice (OpenAI or Anthropic), set in
  one place, with keys stored encrypted and never shown back.

**Non-goals (this design)**

- Multi-camera, separate audio recorders, A/V sync, screen recordings.
- Captions, graphics, B-roll, shorts, publish metadata. The accepted sequence is the
  hand-off point to those existing features.
- Running the model locally, or cloud transcription. Transcription stays local (Whisper
  via mlworker) exactly as today.
- Wiring the MCP `AgentGateway` into the app, or exposing this flow to external agents.
- Full script reconciliation (spec §4.6 / FR-202). Script matching here is a lightweight
  similarity hint for the model, not a transcript correction pass.
- Auto-accepting anything.

**Anti-goals (a build that does these has failed even if it "works")**

- The model silently picks a take when the evidence is ambiguous.
- An edit lands on the accepted timeline without a proposal.
- Video or audio bytes leave the machine. Only text goes to the provider.
- A rejected or superseded plan loses the conversation or the evidence it was built from.
- The flow works only when a script is supplied.

## 3. The creator's rules (binding on the prompt and the plan compiler)

- R1. **Latest take wins.** Among attempts at the same line, the one recorded last is
  used. "Last" is by capture time of the clip, then position within the clip.
- R2. **…unless said otherwise on camera.** An aside such as "use the first one", "the
  previous one was better", "take two", "that one" overrides R1 for that line. Asides are
  instructions, never content.
- R3. **Script order** when a script is given; recording order otherwise.
- R4. **Partial retakes stitch.** If the latest attempt restarts mid-line and only redoes
  the tail, the plan may join the earlier head with the later tail. Every stitch gets a
  review marker.
- R5. **Ask, don't guess.** Two passages that might or might not be the same line, a line
  with no script match, an aside the model can't parse, a clip whose capture time is
  missing or out of order: all are questions, not decisions.
- R6. **Tightening is gentle and optional.** Default on. Long dead air is trimmed, never
  removed to zero; a stray "ehm" stays; anything kept-but-doubtful gets a review marker.

## 4. Flow

```
footage + script ──► [A] prepare ──► [B] converse ──► [C] plan ──► [D] proposal(s) ──► accept
                     (local jobs)    (LLM turns)      (LLM turn)   (operations)
```

**[A] Prepare** (`assembly.prepare` job, local, no network)

1. Ensure every selected asset has a transcript; enqueue `transcribe` for those missing
   and wait (the job already exists, see §7.1). VAD is **not** required here: the
   prepare step needs only the gaps between aligned words, which the transcript already
   carries. (VAD is never persisted today and is only run inline by the filler job; the
   tightening step in [D].2 keeps using it exactly as now.)
2. Order assets by `captureTime.value`; flag any whose `captureTime.source` is
   `file-mtime` or whose order contradicts filename order.
3. Segment each transcript into **candidate segments**: runs of active words split at
   word gaps ≥ `segmentPauseMs` (builder default ~1500 ms) and at spoken markers.
4. Group segments by transcript similarity (reuse `groupTakeTranscripts`, §7.2) into
   **repeat groups**. Match each group to the best script block, if a script is present,
   and record the similarity score.
5. Mark **aside candidates**: short segments that match no script block and/or contain a
   spoken-marker phrase.
6. Write the **evidence package** (§5) to the assembly session sidecar and return a
   summary (assets, segments, groups, questions the pre-pass itself can already see, such
   as missing capture times).

**[B] Converse** (`Assembly.send` IPC, one LLM call per turn)

- First turn: system prompt + evidence package. The model replies with either
  `questions` or `plan` (§6).
- Each later turn: the creator's answer (free text, or a chosen option). The full
  conversation is resent each turn; context is small enough (see §5.4).
- The panel renders questions as cards with a **Jump** button (asset + word range →
  preview at that source time) and quick-reply buttons when the model offered options.
- The first call in a project also asks about tightening unless the setting is already
  `gentle` or `off` (§8.3).

**[C] Plan** — a model reply with `status: "plan"` ends the conversation. The panel
shows the plan as a readable list (one row per cut: script block, clip, time range,
reason, flags) before anything is created.

**[D] Proposals** (`Assembly.createProposal` IPC, local)

1. The **assembly proposal**: `clip.insert` per cut into sequence `main` on the A-roll
   layer, in plan order, plus `annotation.create` for every flag. Instruction kind
   `user-text` (the conversation), actor `{kind: "agent", id: "<provider>:<model>"}`,
   reason text from the plan summary, reason sources `media-evidence` (the evidence
   package hash) and `instruction` (the session id). Risk is whatever the catalog says
   for `clip.insert` (`normal`), so it always needs explicit acceptance.
2. On acceptance, if tightening is on: enqueue `assist.fillers.detect` for the kept
   assets with the **gentle rule set** (§8.3) and a new payload tag
   `scope: { assemblySessionId, keptRanges }`. The job-done handler recognises the tag
   and, before compiling, drops every candidate outside `keptRanges` (today
   `compileFillerProposal` hard-fails on candidates that fall outside timeline clips,
   which every discarded take would). The surviving candidates become a second proposal
   through the existing compile, extended to emit an `annotation.create` review marker per
   `reviewRequired` candidate. Two proposals keep "what was cut" and "what was tightened"
   separately reviewable.

Rejecting or superseding the assembly proposal returns the panel to the conversation
with the model's plan still visible; the creator can type what to change and get a new
plan. The session sidecar keeps every turn and every plan.

## 5. Evidence package

A single Markdown document built deterministically from project state. Hash-recorded in
the session sidecar so a plan can always be traced to exactly what the model saw.

### 5.1 Header

- Project name, number of assets, total speech duration, language.
- The creator's rules R1–R6 are *not* here; they live in the system prompt (§6.1).

### 5.2 Script (when present)

Blocks `S001…Snnn` in order, each with its section heading and text. Source: the raw
script Markdown (`script.raw.md` uses `>` blockquotes under `## n.` headings). **One
block per quoted paragraph**, i.e. split at blank `>` lines, not per blockquote group: a
group often holds 2–5 sentences, while the unit Martin re-says is a sentence or two, and
the similarity hint in §5.3 only means something when the block is about the size of a
take. Sentences inside a block are numbered so a cut can say `S014` / sentences 2–3.
Formatting (`<u>`, `**`, links) stripped. The script file is copied into the project as a
registered sidecar (`sidecars/scripts/<asb_id>.script.md`, listed in the master's
`sidecars` with its SHA-256) so backups and archives stay self-contained.

### 5.3 Footage

Per asset, in capture order:

```
## A3  cam_IMG_0423.MOV   captured 2026-10-20 14:32:07 (container)   dur 06:41
```

then its candidate segments:

```
### C3.07  02:14.320–02:31.890   group G12   script S014 (0.91)   conf 0.94   pause-before 2.1s
Could AI talk you into the dumbest decision of your life, without a single sentence that sounds stupid.
### C3.08  02:33.100–02:34.000   ASIDE?   spoken: "again"
again
```

Rules:

- Times are `mm:ss.mmm` from the start of the clip; the sidecar keeps the word ids
  (`wNNNNNN`) for each segment so the plan compiler never re-parses text.
- `pause-before` is the gap between the previous active word's end and this segment's
  first word start, from the transcript's word times.
- The script match score is the best match of the segment against the block, not a
  whole-block ratio, so a one-sentence take still scores well against a three-sentence
  block (builder: a sliding window over the block's sentences is enough).
- `conf` is mean word confidence; segments under a builder-chosen threshold are tagged
  `LOW-CONF`.
- `ASIDE?` is a hint only; the model decides.
- Groups list their members once in a short index after the footage, latest member last.

### 5.4 Size

Seven clips of a few minutes each is ~10k words; with per-segment headers the package is
well under 40k tokens. The design assumes everything fits in one context window; if a
project exceeds a builder-chosen limit the prepare job fails with a clear message rather
than truncating.

## 6. Model contract

### 6.1 System prompt

States the role (assistant editor assembling a single-presenter rough cut), rules R1–R6
verbatim, the evidence format, and the output contract below. It tells the model that
asides are instructions about the preceding or following attempt, that it must cite
segment ids for every decision, and that a `plan` is only allowed when it has no open
questions.

### 6.2 Output

Structured (tool call / JSON schema on both providers), one of:

```jsonc
{ "status": "questions",
  "summary": "…",                       // one paragraph, shown at the top
  "questions": [
    { "id": "Q1",
      "about": { "assetId": "ast_…", "fromWord": "w000120", "toWord": "w000134" },
      "text": "C3.07 and C3.09 read the same line; C3.09 stops after 'sentence'. Stitch, or use C3.07 whole?",
      "options": ["Stitch", "Use C3.07 whole", "Use C3.09 whole"] } ] }
```

```jsonc
{ "status": "plan",
  "summary": "…",
  "tightening": "gentle" | "off",       // only when the model asked and the creator answered
  "cuts": [
    { "scriptBlock": "S014",            // omitted when no script
      "scriptSentences": [2, 3],        // optional: which sentences of the block this cut covers
      "assetId": "ast_…", "fromWord": "w000120", "toWord": "w000134",
      "reason": "Latest of 3 attempts (G12); creator said 'again' after the first two." } ],
  "flags": [
    { "cutIndex": 4, "kind": "stitch" | "override" | "low-confidence" | "unmatched" | "other",
      "note": "Head from C2.11, tail from C3.09 at 'without'." } ] }
```

Validation on the main process: every word id exists and is active, `fromWord` precedes
`toWord` within one asset, cuts don't overlap, script blocks exist. A malformed reply is
sent back to the model once with the validation errors; a second failure surfaces as an
error in the panel (never a silent retry loop).

### 6.3 Turn limits

A conversation ends when the model returns a plan or after a builder-chosen cap on turns
(suggest 12) with a message asking the creator to simplify. Token usage per turn is
recorded (§9.3).

## 7. What exists and gets reused

(Verified against the code on 2026-10-27.)

7.1 **Transcripts and jobs.** `guyditor.transcript/v1` sidecars with per-word
`start/end` (sample time), `confidence`, `state`; `transcribe` runs automatically after
ingest. Word gaps give the prepare step its pauses. VAD is not persisted anywhere; the
filler job runs it inline (`packages/transcript/src/fillers/job.ts`), and only the
tightening step depends on it.

7.2 **Repeat grouping.** `groupTakeTranscripts(candidates, threshold)` in
`packages/transcript/src/take-comparison.ts` (token-Levenshtein against the group lead).
It takes `TakeTranscriptCandidate` records, which the prepare job builds from candidate
segments instead of `TakeRecord`s.

7.3 **Spoken markers.** `detectSpokenTakeMarkers` already runs after every
transcription and recognises "again", "cut that", "take N", "that was good/bad". The
prepare job reads the resulting `mrk_` records; the model handles any other phrasing.

7.4 **Proposals.** `OperationEngine.createProposal` (`packages/core/src/operations/`),
`clip.insert` with `{sequenceId, index, source:{assetId,in,out}, layerId}`,
`annotation.create` with `shape: "range"` and a `timeline` anchor. `ProposalPanel`
reviews and accepts. `E_OP_REASON_REQUIRED` enforces reason text + sources.

7.5 **Tightening.** `enqueueFillerDetection(jobs, {assetIds, fillerRules})`,
`FillerRuleSet`, `compileFillerProposal`, `reviewRequired` / `reviewWindows`.

7.6 **Capture time.** `Asset.captureTime {value, source: "container"|"file-mtime"}`
from ffprobe `creation_time` / `com.apple.quicktime.creationdate`, else mtime.

7.7 **Secrets and audit.** `SafeStorageCredentialStore` (Electron `safeStorage`),
`CredentialStore.get/set/delete`; `AuditLog` with `external.call` and `cost.charge`
records and `DataClass` `prompt|transcript`. `UserSettings.network.externalCalls`
(`allow|ask|block`) exists but is not consumed by anything yet.

7.8 **Navigation.** `jumpToAnnotation`, `OperationEngine.resolveNavigation`,
`usePreviewStore` in the renderer.

## 8. What is new

### 8.1 Services and IPC

- `ServiceName` **`Assembly`** (added to the closed union in `shared/ipc.ts`; `asb`
  added to `ID_PREFIXES`) with surface methods: `listSessions`, `createSession
  {assetIds, scriptPath?}`, `prepare {sessionId}` (enqueues the job), `send {sessionId,
  text | optionIndex}`, `createProposal {sessionId}`, `get {sessionId}`. Events:
  `assembly.updated {sessionId}` (new turn, job progress, plan ready).
- Every assembly session opens an agent **audit session** (`ses_`) through the existing
  `SessionManager` with `director: { profileId: "assembly", modelLabel: "<provider>/<model>",
  locality: "cloud" }`, closed when the assembly session ends. The `AuditLog` only
  accepts `ses_` ids, and this gives the proposal a `sessionId` for free. The MCP gateway
  stays unwired; only the session and audit pieces are used.
- `ServiceName` **`AiSettings`**: `get`, `update {provider, model, effort, tightening}`,
  `listModels {provider}` (queries the provider's model list when a key is present),
  `setKey {provider, key}`, `clearKey {provider}`, `keyStatus` (present/absent only).
  This is the first writable settings path; `settings.ts` gains `saveSettings` for the
  `ai` section only, merged on top of the file so unknown keys survive.

### 8.2 Session sidecar

`guyditor.assembly/v1` at `sidecars/assembly/<asb_id>.json`, schema in
`@guyditor/core` `schema/sidecars/`, registered in the master's `sidecars` list like
every other sidecar. Id prefix `asb_` (`asm_` is taken by assessments). Contents:
settings used (provider/model/effort), inputs (asset ids, script path + hash), evidence
package text + hash, messages (role, content, structured reply, token usage,
timestamp), plans, `proposalId`s, status (`preparing | conversing | planned | proposed |
accepted | abandoned`). Secrets never appear here; the audit log's credential scrubber
runs over anything written.

### 8.3 Settings (`ai` section)

```ts
ai: {
  provider: "anthropic" | "openai";
  model: string;                        // free text; the panel offers the provider's list
  effort: "low" | "medium" | "high" | "max";
  tightening: "ask" | "gentle" | "off"; // default "ask"
}
```

Effort maps to the provider's own dial (Anthropic: `thinking` budget / effort parameter;
OpenAI: `reasoning.effort`). Builder picks the exact mapping table and documents it in
the panel's hover text. Defaults: `anthropic`, the current top model, `high`.

**Gentle rule set** (a `FillerRuleSet` preset used by [D].2): pauses ≥ ~1.2 s shortened
to ~0.5 s rather than removed; single fillers kept (review marker when ≥ 2 within ~10 s);
repeats and false starts inside a kept take removed with a review marker. Thresholds are
the builder's call within those intentions.

### 8.4 LLM adapter

New adapter kind in `packages/agent/src/adapters/`:

```ts
interface LlmAdapter {
  id: "anthropic" | "openai" | "stub";
  complete(request: { system: string; messages: Message[]; responseSchema: JsonSchema;
                      effort: Effort; model: string; signal?: AbortSignal })
    : Promise<{ reply: unknown; usage: { input: number; output: number } }>;
  listModels(): Promise<string[]>;
}
```

Calls run in the main process only (renderer network is locked). Builder's choice
whether to use the official SDKs or `fetch`; either way one module per provider, both
using the provider's structured-output feature. The `stub` adapter replays scripted
replies and is what every automated test uses; it is also selectable via
`GUYDITOR_ASSEMBLY_STUB=1` like the restyle stub.

### 8.5 Panel

Dock panel id `assemble`, label **Assemble**, default location: right-top in the `cut`
phase layout (migration added like the `help` panel was). Three stacked regions:

1. **Inputs**: footage list (all speech-bearing assets, capture order, checkboxes,
   transcript status per row), script row (drop/choose a `.md`/`.txt`, shows name +
   hash), settings strip (provider · model · effort · tightening, click opens the AI
   settings sheet), and an **Analyze footage** button. A one-line notice under the
   button says what leaves the machine: *"Sends the transcript and script text to
   <provider>. Never audio or video."* When `network.externalCalls` is `ask`, the first
   send per project requires clicking through this notice; `block` disables the button
   with the reason shown.
2. **Conversation**: turns in order; model turns show the summary and question cards
   (text, Jump, option buttons); an input box with Send. While a turn is in flight the
   box is disabled and the status strip's global progress shows "Waiting for <model>".
3. **Plan**: appears when the model returns one; rows as in [C]; **Create proposal**
   button; after creation a link to the proposal in the Proposal panel.

AI settings sheet: provider radio, model combo (list from `listModels`, editable), effort
select, tightening select, API key field (write-only, with "Key saved ✓ / No key" status
and Clear), per provider.

### 8.6 Compiler (plan → operations)

Pure function in `packages/core` (or `packages/transcript`), fully unit-tested:

- Word range → source frames: first word start minus `leadPadMs`, last word end plus
  `tailPadMs` (builder defaults ~120/200 ms), clamped so the range never crosses into an
  adjacent segment's words, snapped to the asset's frame rate.
- `clip.insert` per cut, indices in plan order, `evidence` set to the cut's reason.
- `annotation.create` per flag: `shape: "range"`, `anchor: timeline` at the cut's start,
  `extent` the cut length, `body` = kind + note, `author: {kind: "agent", id: …}`,
  `state: "open"`, `blocking: false`.
- One proposal, reason text ≤ 280 chars (plan summary, truncated with "…"), sources
  `[{kind:"media-evidence", ref:<evidence hash>}, {kind:"instruction", ref:<asb_ id>}]`.

The A-roll layer is the main sequence's first video layer; if the sequence already has
clips the panel warns and the proposal appends after them (builder's call: appending is
simpler than merging and keeps a prior cut intact).

## 9. Boundaries, audit, cost

9.1 Only text is sent: the evidence package and the conversation. The prompt never
includes file paths outside the project, API keys, or the audit log.

9.2 Every provider call goes **through `CostMeter.preflight`/`record`**, the gate the
codebase already treats as the single door for external calls. That gate wants USD, so
settings carry a small rate table, `ai.rates: { [model]: { inputPerMTok, outputPerMTok } }`,
shipped with defaults for the models the panel lists and editable in the AI settings
sheet. A model with no rate is priced at the provider's most expensive known rate and
shown as "estimated" in the panel, so budget caps still bite. The estimate for preflight
is the package + conversation token count; `record` uses the provider's reported usage.
A `warn` result surfaces the existing confirm-token step in the panel; `blocked` is shown
with the budget that tripped. The audit file therefore gets `external.call` (data classes
`["prompt","transcript"]`) and `cost.charge` records the same way restyle does, and the
panel shows cumulative tokens and cost for the session.

9.3 `network.externalCalls` becomes a consumed setting (see 8.5). Nothing else in the app
changes behaviour because of it yet.

9.4 Keys: stored through `SafeStorageCredentialStore` under ref `llm.<provider>`; the
IPC never returns a key; when `safeStorage` is unavailable the panel says keys will not
persist across restarts (ephemeral store), matching current behaviour for Kling.

## 10. Testing

- Unit: segmentation (pause/marker splits), grouping adapter, script block parsing from
  `script.raw.md`, evidence rendering (snapshot against a fixture project), reply
  validation (every error class), plan compiler (padding, clamping, frame snapping,
  index order, annotation anchors), gentle rule set.
- Service host: `Assembly` and `AiSettings` methods with the stub adapter and an injected
  `CredentialStore`; verifies audit records, `externalCalls: block`, session sidecar
  round-trip, proposal creation and the tightening follow-up on accept.
- Playwright e2e (`packages/app/e2e/assembly.spec.ts`): the e2e harness runs without
  the mlworker, so the project comes from a **new multi-asset fixture template** with
  seeded transcripts (three clips, one line repeated, one spoken "again"), the way
  `ac001` seeds its single-asset project today. Then: Analyze → stub asks one question →
  answer → plan → Create proposal → Accept → the timeline holds the expected clips and
  one review annotation. The tightening follow-up is covered by the service-host test,
  not e2e, since it needs VAD. Stub and `data-testid` only.
- Contract: none new (no mlworker changes).
- Manual dogfood: ep001 footage, both providers, recorded in `docs/dogfood/`.

## 11. Left to the builder

- Exact thresholds (segment pause, confidence tag, padding, gentle rule set, turn cap).
- SDK vs `fetch`, and the effort mapping table per provider.
- Preview navigation for "asset at source time" when the asset is not on the timeline
  (extend `resolveNavigation` or reuse the take browser's preview path).
- Whether the prepare job is one `JobQueue` job with sub-steps or a chain; it must be
  cancellable and visible in the global progress overlay either way.
- Layout migration details for the new panel and the `ingest` phase (the panel is also
  useful there; builder decides whether it appears in both default layouts).
- Manual and traceability updates: `docs/MANUAL.md` section, `docs/traceability.md` rows
  (FR-005 moves from partial), an `docs/amendments/008-ai-assembly.md` pointer to this
  document.

## 12. Open risks

- Whisper may transcribe asides and lines with similar confidence; aside detection leans
  on the model. Mitigated by R5 and the review markers.
- Capture time on iPhone clips is in the container and reliable; AirDrop/Finder copies
  keep it. If a clip arrives via a path that strips metadata, the prepare job flags the
  mtime fallback and the model asks (R5).
- Structured-output support differs between providers and changes over time; the stub
  adapter keeps the rest of the system testable regardless.
