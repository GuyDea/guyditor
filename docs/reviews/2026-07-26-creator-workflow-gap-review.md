# Creator workflow gap review

- **Date:** 2026-07-26
- **Reviewed branch:** `fix/selected-deliverable-context`
- **Scope:** the creator workflow from project creation and source intake through
  editing, derivative shorts, captions, B-roll/animation, preview, feedback,
  progress, autosave, reopen, and distribution.

## Outcome

Guyditor has a substantial editing and distribution foundation, but the complete
workflow in the creator requirement is not yet end to end. Independent
long-form/short editing, annotations, generated B-roll review, motion templates,
publish kits, job progress, and project-directory autosave/reopen are implemented.
The explicit one-physical-file project requirement is not. The largest remaining
product gaps are a single-file project container, caption creation in a fresh
project, assembling arbitrary imported media, script reconciliation, distinct
source-transcript/active-edit modes, stock-provider discovery, placing and
trimming ordinary footage, full composite/comparison preview,
progressive-reveal captions, direct spatial feedback authoring, and universal
activity reporting.

## Requirements matrix

| Creator requirement | Status | Evidence and gap |
|---|---|---|
| Create a project, autosave it, and reopen it next session as one project file | **Gap against the literal single-file requirement; directory autosave/reopen meets** | Create/open selects a directory. `episode.guyditor.yaml`, load-bearing sidecars, history, proposals, media references, and portable `workspace.guyditor.yaml` are separate files. `packages/app/e2e/active-deliverable.spec.ts` proves directory copy and fresh-profile reopen, but copying only one file cannot reopen the complete edit. A versioned, atomically saved container must embed all load-bearing project state; large source media may remain verified external references. |
| Upload several videos | **Partial / blocking for arbitrary assembly** | Picker and batch ingest hash, probe, deduplicate, preserve originals, and queue proxy/peaks/transcription follow-ups (`FR-002`, `FR-003`; Media panel). This branch also replaces removed Electron `File.path` drag/drop access with the narrow `webUtils.getPathForFile` preload bridge. Speech-bearing media can become an initial clip after transcription through Transcript “Create clip”. There is still no source monitor or whole-file/time-based append, insert, or overwrite path for silent, untranscribed, still, or arbitrary footage. |
| Upload an accompanying script | **Gap** | Transcript creation/correction exists, but script import, deviation analysis, creator reconciliation choices, and `transcript.reconcile.apply` remain `FR-202: todo`. A transcript or subtitle file is not a substitute for the requested script workflow. |
| Cut the source video | **Partial end to end; meets once clips already exist** | Timeline and transcript cuts are semantic, undoable operations for clips already in a sequence. The missing generic Media-to-Timeline assembly path blocks cutting arbitrary videos uploaded into a new project. Decoded-PCM zero-crossing refinement also remains partial (`FR-305`), and modeled transitions can still be rejected by rendering because visual transition compilation is partial (`FR-310`). |
| Create and independently edit multiple distributions | **Mostly meets on this branch; transcript UX remains ambiguous** | One project-portable active distribution now drives Preview, Timeline, caption and sequence mutation targets, Graphics, B-roll, inspectors, Restyle, and Publish. Short edits journal accurate divergence classes while review/analysis actions remain non-divergent; the packaged active-deliverable test covers cut, caption, audio, framing, graphics, and annotation operations. Transcript still displays one global canonical asset-word stream while navigation/removal/caption actions target the active sequence. It needs separate “Source transcript” and timeline-instance-preserving “Active edit” modes; simple sequence filtering would hide source words and collapse repeated instances. Lexical word-ID shift selection can also cross sidecars or select the wrong temporal order. |
| Add attractive subtitles with progressive word reveal | **Partial / blocking in a fresh project** | The compiler/painter supports versioned presets, deterministic line breaking, per-word timing/highlight, emphasis, breaks, and cue nudges (`FR-205`, `FR-804`), but fixtures mask a creation gap: a real new project has no caption preset or track, and the UI offers no atomic create-and-assign action. Even pre-seeded projects expose only a subset of the modeled style controls. Standard captions keep or dim prior words; future words remain visible, so progressive reveal is absent. Motion-template reveal primitives (`FR-610`) do not change caption rendering. |
| Create animations | **Meets within a closed template/PiP path; otherwise partial** | Versioned motion primitives, SVG/Lottie assets, PiP keyframes/presets, sandboxed template rendering, authored-template review, live overlay, freeze, and export are implemented (`FR-600`–`FR-612`). The creator can configure or place an installed/agent-authored template, but there is no general visual keyframe/vector animation authoring surface. Generative video is a separate reviewed B-roll path. |
| Find stock footage | **Gap** | The B-roll taxonomy accepts a local path to an already acquired licensed asset and records rights. There is no stock-provider search/browse API, result preview, license retrieval, or in-app download flow. “Licensed asset” intake is not stock discovery. |
| Cut stock footage and fit it into the edit | **Partial / blocking workflow gap** | Generated candidates can be accepted with a duration and timeline placement. An ordinary ingested licensed asset has no creator-facing insert/overlay placement and source in/out trimming flow in B-roll or Media. The current Preview is also not a complete generic multi-layer compositor, so fit cannot be judged reliably in context. |
| Preview the current result | **Partial** | Proxy playback, exact settled-frame checks, portrait framing, captions, graphics, PiP, and key previews exist. The full multi-layer compositor/HQ degradation ladder remains partial (`FR-902`), and binding toggle/side-by-side/wipe comparison sessions are `FR-903: todo`. Proposal context also still lacks rendered marked/clean PNG/MP4/audio artifacts (`FR-405: partial`). |
| Give intuitive, precise feedback | **Partial** | Frame/range/spatial annotation data, lifecycle controls, proposal evidence, context packages, navigation, and annotation-to-rendered-overlay conversion exist (`FR-400`–`FR-406`). This branch fixes sequence leakage and resolves point/range annotations to stable timeline positions, with point notes visible for exactly one frame. The Preview authoring surface still omits freehand/spotlight, hardcodes center geometry and timeline anchors, supplies no stable source projection, offers no click/drag placement, repositioning, geometry/text editing, deletion, or blocking-note toggle, and renders raw persisted rather than derived addressed state. Missing rendered context artifacts and comparison preview further weaken feedback on composited/proposed changes. |
| Always show what is processing and its progress | **Partial** | The global indicator and drill-down cover persistent JobQueue work, dependencies, retries, creator waits, aggregate progress, and provider-wait records (`FR-907`). Direct RPC work such as the up-to-30-second template freeze and transient preview/resource requests remain panel-local; collapsed global progress shows an aggregate rather than the current action, and the external-provider wait shape is incomplete. The literal “at every point” requirement needs one activity contract for any operation exceeding the UI acknowledgement budget, including phase, current action, determinate/indeterminate progress, cancellation where possible, and terminal state. |
| Produce platform distributions | **Meets for implemented profiles** | Long-form/short profiles, independent lifecycle/staleness, burned/clean exports, subtitles, covers, metadata, chapters, reports, batch export, and upload kits are implemented (`FR-800`–`FR-813`, `AC-007`, `AC-011`). |

## Correctness defects addressed on this branch

- Active short selection now controls every editing surface instead of only Publish.
- Active distribution autosaves as project-portable, non-editorial workspace state.
- Project hydration, workspace autosave, resource refreshes, notices, word
  navigation, and proposal evidence ignore stale or cross-project responses.
- Workspace IPC reads/writes identify the expected project and fail safely after a
  project switch.
- Every project-bound RPC remains leased to its originating project for the full
  call, including preliminary file reads/writes and nested semantic operations.
  A switch drains already-admitted edits, publish flows, provider/generation
  work, take selection, and matte acceptance before closing that project, then
  rejects newly late callbacks instead of mutating the newly opened project.
- Competing open/close requests are serialized, so a slower open cannot overwrite
  a later project choice or reinstall services after the window host closes.
- Project job follow-ups for transcripts, filler proposals, and capture guidance
  are tracked and drained before another project becomes active.
- Capture watcher shutdown unsubscribes and drains active file/job handlers.
  Offline saved watch roots warn without blocking project open; a genuine staged
  startup failure closes all staged services and leaves no hidden active project.
- Capture take/marker metadata remains bound to the originating store, serializes
  read/merge/write/commit across all assets, merges amended imports without
  duplicating prior markers, retries revision races, and restores prior bytes if
  the semantic commit fails.
- Undo/redo retain transaction identity and derivative divergence.
- Late direct-edit, undo, and redo responses cannot repopulate a newly opened
  project's cleared undo history.
- Direct short edits classify cut, order, pacing, caption, framing, graphics, and
  audio divergence from the content actually touched; non-editorial operations do
  not create false divergence.
- Accepted generation/restyle output, neural mattes, template freeze, converted
  annotations, and jump-cut proposals now preflight and retain the correct short
  divergence instead of applying unclassified or misleading edits.
- Long-running or file-producing accept paths bind preflight to the intended
  project revision, recompute ownership from exact operations, publish
  non-overwriting artifacts, and clean failures without deleting files after a
  successful semantic commit.
- Electron drag/drop resolves native file paths through a narrow preload bridge
  compatible with Electron 43 rather than relying on removed `File.path`.
- Point/range annotations render only over their resolved half-open time span,
  Timeline markers remain fixed at resolved frames and scoped to the selected
  sequence, and annotation resolution caches cannot leak across project/anchor
  changes.
- Preview settles with an explicit warning when the selected clip has no proxy
  instead of leaving annotation creation permanently disabled.
- The packaged Electron regression proves canonical project/history bytes do not
  change merely because the active distribution changes, and that the choice
  survives a copied-project/fresh-profile reopen.

## Recommended delivery order for the remaining gaps

1. **Single-file project container:** replace or wrap the directory layout with a
   versioned physical `.guyditor` container that atomically autosaves the master,
   workspace state, sidecars, journal, proposals, and integrity metadata. Keep
   large media external when desired, but make one file sufficient to reopen the
   complete edit.
2. **Caption bootstrap and reveal:** atomically pin/copy a bundled preset, create
   the primary caption track, and assign it when a project is created (or expose
   one equivalent creator action). Then add a closed, canonical-time
   progressive-reveal policy and golden-test preview/export parity.
3. **Initial assembly and ordinary media placement:** let any imported video,
   audio, still, or animation become a source-trimmed primary clip or timed
   overlay through the Media and Timeline UI, including append/insert/overwrite,
   order, crop/scale/position, replace, and slip controls.
4. **Transcript modes plus script reconciliation:** add a canonical per-asset
   Source transcript mode for correction/create-clip and a timeline-ordered Active
   edit mode using word instances (including duplicates). Then import plain
   text/DOCX/PDF-derived scripts,
   align it to transcript words, show omissions/additions/reorders, and require an
   explicit creator choice before applying a reconciliation.
5. **Stock discovery and rights acquisition:** add provider-neutral search,
   thumbnails/previews, licensing/attribution capture, download/freeze, and explicit
   offline/unavailable behavior.
6. **Full composite and comparison preview:** use the export-equivalent graph for
   proxy/HQ preview and add toggle, side-by-side, and wipe comparison sessions.
7. **Direct spatial feedback:** add every modeled tool, click/drag drawing,
   selection handles, reposition/resize, text editing, deletion, blocking-note
   controls, and derived addressed state while retaining canonical frame/range
   anchors and proposal evidence.
8. **Universal activity visibility:** represent direct async work as short-lived
   activities in the same global model; define and test the acknowledgement
   budget below which panel-local state is sufficient.

## Acceptance tests still needed

- Create an empty project, import two videos, source-trim and assemble both into the
  primary timeline, make a cut, save, close, and reopen with the edit intact.
- Create a real empty project, add its first caption track/preset through the
  product UI, style it, and verify progressive reveal at exact word boundaries in
  preview and burned export.
- Switch between Source transcript and Active edit modes; prove source words stay
  available for assembly while repeated timeline word instances retain their
  order and independent selection.
- Import video plus script, reconcile deliberate script/transcript deviations,
  save, close, and reopen with choices intact.
- Search a deterministic stock-provider stub, inspect license terms, acquire a clip,
  set source in/out, place it over a short, reframe it, and preview/export the same
  composition.
- Compare before/after with toggle, side-by-side, and wipe while a proposal remains
  unaccepted and canonical bytes remain unchanged.
- Draw, move, resize, edit, resolve, and reopen a spatial annotation at an exact
  preview coordinate and prove the context package points at the same content.
- Assert every deliberately long-running action appears in the global activity
  model with phase, progress or indeterminate state, cancellation/retry semantics,
  and a terminal outcome.
- Copy only the required single project file to a fresh profile/machine fixture
  and reopen the complete edit without the original project directory.
