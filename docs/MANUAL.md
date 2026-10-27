# Guyditor Manual

Every feature, where it lives, and how to use it. Organized the way the workspace
is: by workflow phase tab, then cross-cutting systems. Setup lives in
[README.md](../README.md); this manual assumes the app is running (`pnpm dev`).

**Conventions:** *Tab* = top-level phase tab. *Panel* = a dockable panel (drag its
header to move it, drag splitters to resize, click its master-rail entry to
restore a collapsed panel). Every agent-initiated change is a **proposal** you
review — nothing consequential applies silently, ever.

---

## 1. Quick start

1. **Create a project** (title bar → New project): pick a folder and a platform
   profile (defaults to `youtube-longform`). The profile sets resolution/fps.
2. **Drop footage** into the Media panel (Ingest tab). Hashing, probing, proxies,
   waveforms, and transcription start automatically — watch the global progress bar.
3. **Work left to right through the tabs**: Cut the story → Polish the look →
   Review agent proposals → Publish deliverables.

## 2. The workspace

| Feature | Where | How |
|---|---|---|
| Phase tabs | Top strip | `Ctrl+Alt+1..5` (Cmd on macOS). Each tab is a layout preset; nothing is locked — any panel can be added to any tab. |
| Master tool rail | Left edge, always visible | Every panel grouped by Ingest/Cut/Polish/Review/Publish/System. Click or press `Enter` to expand/collapse it in this tab; absent panels open in their home region. Arrow keys move between entries. |
| Panel resize / reorder | Any splitter / panel header | Drag splitters (keyboard-accessible). Drag a panel header to another region; multiple panels in a region become tabs. |
| Collapse | Panel header `–` or master tool rail | Collapsed panels stay assigned to the current tab and are restored from the single master rail; per-region rails are not used. |
| Reset layout | Layout menu | Per-tab reset, or "Reset all tabs" for the five defaults. Layouts persist per project. |
| Global progress bar | Title bar, always visible | Aggregate of all background work. Click it → the **waiting-on view**: running jobs (cancel/retry), queued chains, **waiting on you** (proposals, confirmations — badge), and external provider calls with spend. |
| Tab badges | On each phase tab | Live counts from the same data: proposals → Review, ingest chains → Ingest, failed exports/budget prompts → Publish. Click badge → jumps to the exact panel. |
| Inspector | Panel P4 (all tabs) | Schema-driven properties for the current selection; every edit is a semantic operation (undoable, journaled). |
| History viewer | Inspector panel | The transaction journal with entity/actor/revision filters; restore any revision (restores are forward transactions — history is never rewritten). |

## 3. Ingest tab — get material in

| Feature | Where | How |
|---|---|---|
| Import | Media panel: picker, drag-drop, path field | Files are hashed (SHA-256), probed, classified (video/audio/image/animation/subtitle), and **never modified** — Guyditor only references them. Duplicates dedupe by hash. |
| Watch folders | Media panel → watch config | Point at your OBS/camera-card folder; new files auto-ingest with session grouping and chained proxy/transcription jobs. Naming contract: [capture-integration.md](capture-integration.md). |
| Take markers | Media panel → asset → takes | Marker files/notes recorded during shooting attach as take metadata; spoken markers ("take three") are detected in the transcript. |
| Proxies & waveforms | Automatic per asset | Edit-tier proxies (960px H.264) power smooth scrubbing; regenerated automatically when stale. |
| Transcription | Automatic for speech assets | Local Whisper (choose model size per project); per-word timing refined by forced alignment when confidence is low. Nothing leaves your machine. |
| Relinking | Media panel (missing-media badge) | Moved files relink with hash verification, so a wrong file can't silently substitute. |
| Storage | Storage panel | Per-class cache sizes, projected proxy costs, safe cleanup (only disposable caches — never sources or project state). |

## 4. Cut tab — shape the story

| Feature | Where | How |
|---|---|---|
| Transcript editing | Transcript panel | Click a word → playhead seeks there. Select a range → **remove / retain / create clip / mark short candidate**. Fix transcription errors inline (word IDs are permanent; captions and edits anchored to words survive later changes). |
| Timeline editing | Timeline panel | Trim (edge drag or numeric), split at playhead, join, move (drag), duplicate, gap editing, layer enable/lock/reorder. Waveforms on every clip. Full undo/redo (`Ctrl+Z/Y`) — undos are forward journal entries. |
| Filler & pause assist | Transcript panel → Assist | Detects long pauses, filler words, repeats, false starts (configurable). Results compile into a **proposal** — review each removal; protections for beats, annotated moments, and dramatic pauses. |
| Pickups | Media panel → pickup wizard | Import a corrective re-recording of a flubbed line; it's transcribed, aligned, and spliced under audio-continuity checks — as a proposal. |
| Take comparison | Review tab or Media panel takes | Groups alternate takes of the same content, scores delivery (pace, pauses, fillers, loudness stability) weighted by your skills, recommends with a reason. Rejected takes stay accessible. |
| Continuity guards | Automatic on every cut | Warns about mid-word cuts, clicks, ambience jumps — with evidence and suggestions (micro-fade, crossfade). Warnings never block. |
| Jump-cut concealment | Timeline cut warnings → one click | Proposes punch-in alternation (1.0→1.12→1.25 crops) or smooth-cut transitions at visible jump cuts. |

### Assemble a rough cut (AI)

The **Assemble** panel (Cut tab, top right; Ingest tab, bottom right) turns a pile of raw takes of one presenter into a first-draft timeline. It never edits the timeline directly: the result is a **proposal** you review and accept like any other.

| Step | Where | How |
|---|---|---|
| Inputs | Assemble panel | The footage list shows every video/audio asset and whether its transcript is ready. Optionally enter the path to a script (plain text or Markdown); a copy is stored with the session. |
| Analyze | **Analyze footage** | Runs the job "Analyze footage for assembly". It waits for transcription that is already running, notes clips that have no transcript or no speech, and builds a text *evidence package* (candidate passages, repeat groups, script matches). It does not start transcription itself — import does that. |
| Chat | Conversation | The assistant either asks questions (cards with a **Jump** button to the passage and answer buttons) or returns a plan. Type in the box and **Send** to answer or instruct. A plan is only accepted when no questions are open. One automatic retry if a reply is malformed. The conversation stops accepting messages after 12 assistant replies; if the last one was still a question there is no plan, and the only way forward is **Start over**. |
| Plan | Plan table | Each cut shows its script block and reason; flag badges mark stitches, overrides, low confidence and unmatched lines. |
| Proposal | **Create proposal** / **Open proposal** | Creates one proposal with a reason. Nothing changes until you accept it. After you accept, Guyditor adds an open, non-blocking *review marker* for every flagged cut and, if tightening is on, queues the tightening proposal. Assembly proposals are born stale, so accept with **Rebase + accept** (one rebase per accept). |
| Tightening | AI settings | With `gentle`, after you accept the assembly proposal Guyditor queues a second proposal: long pauses (over 1.2 s) shortened to 0.5 s, "um/uh/erm/ehm" flagged for review (not removed), repeats and false starts. `off` skips it; `ask` lets the assistant raise it with you. |
| Start over | **Start over** | Once a session has a conversation it cannot be re-analysed; Start over abandons it and creates a fresh session. |

**The six rules the assistant follows**

1. **Latest take wins.** Among attempts at the same line, the one recorded last is used (by capture time, then position in the clip).
2. **...unless you say otherwise on camera.** "Use the first one", "take two", "the previous one was better" override rule 1 for that line. Such asides are instructions, never put into the cut.
3. **Script order** if you gave a script; recording order otherwise.
4. **Partial retakes stitch.** If a retake restarts mid-line, the plan may join the earlier head to the later tail. Every stitch gets a review marker (added once you accept).
5. **Ask, don't guess.** Ambiguous repeats, a line with no script match, an aside it cannot parse, or a clip with missing/out-of-order capture time become questions.
6. **Tightening is gentle and optional.** Dead air is trimmed, never removed to zero; a stray "ehm" stays; anything doubtful gets a marker.

**AI settings and keys.** The settings strip in the panel opens the AI section: provider (Anthropic or OpenAI), model (pick from the provider's list or type one), effort, tightening, API key (**Save** / **Clear**; the status reads "Key saved ✓" or "No key", and the key is never shown back), and a per-model rate table in $ per million tokens. Keys go into the OS-encrypted store; if the system cannot encrypt, the panel says "Keys will not persist across restarts on this system."

**What leaves the machine.** Only the evidence text (transcript wording, timings, script text) and the conversation — never audio or video; the panel says so. Your *external calls* setting (`allow` / `ask` / `block`) is honoured: `ask` shows one acknowledgement per session, `block` stops the call with a message. Every call goes through the cost meter (budgets from Settings; the cost is estimated when the model has no known rate, and you confirm with **Confirm $…** when a warning threshold applies) and is written to the audit log.

**Known limits.** Single camera only; the assistant is not told about separate audio recordings; a conversation that hits the 12-reply cap without a plan must be restarted; real-provider calls have not been exercised by automated tests (only the deterministic stub). For tests and demos, launch with `GUYDITOR_ASSEMBLY_STUB=1` to use the stub instead of a provider.

## 5. Polish tab — the look and sound

| Feature | Where | How |
|---|---|---|
| Captions | Caption track panel | Per-word highlighted subtitles from your corrected transcript. Pick/style a versioned preset (font, colors, outline, words-per-line, placement); per-word emphasis, break and timing overrides. Preview is the *same renderer* as export — what you see is what burns in. |
| Graphics & animations | Graphics panel (P8) | Place template instances (lower thirds, title cards, callouts, charts, infographics) anchored to words, beats, or frames. Parameters are schema-driven forms; brand colors/fonts fill in from your `brand_visual` skill. |
| Freeze to clip | Graphics panel → "Freeze selected to clip" | Renders a template to a real video asset and places it as a clip — this is how a project with **no footage at all** gets its first content. |
| Author new templates | Ask your director agent | Describe any visual (Vox-style counters, maps, kinetic type). The agent writes a template, the sandbox proves it deterministic, you review preview strips, and approval publishes it as a reusable versioned template. Unreviewed drafts can never render into a deliverable. |
| Brand assets | Graphics panel → Import package | SVG logos, licensed fonts, Lottie animations (validated at import; unsupported Lottie features rejected by name). |
| Green-screen keying | Key inspector (select presenter clip) | Eyedropper the key color, tune tolerance/edge/spill with live preview; check the matte over black/white/magenta/checkerboard; QC report flags halos, holes, edge chatter. |
| No-green-screen cutout | Key inspector → Neural matte | RobustVideoMatting separates the presenter from any background (CPU, ~2× realtime; needs the model file — see README). Result is a frozen matte asset. |
| Presenter placement | Layer list + arrangement picker | Five sandwich arrangements (over background, over screencast, between background and foreground, ...). |
| Picture-in-picture | PiP inspector | Place a floating presenter/webcam by dragging or constraints (`bottom_right, width: 24%`). Shapes (cutout/bubble/frame), borders/shadows, 12 motion presets, keyframed moves anchored to transcript words. Collision avoidance proposes repositioning away from captions/marked regions. |
| AI restyle (Kling) | Restyle plan panel | Select coverage (whole video or segments) → the planner cuts ≤10s chunks at word/silence boundaries → **whole-plan cost estimate before anything is sent** → each stylized chunk returns for review → seams hidden by infographic interstitials or punch-ins, resuming on the exact next frame. Stub mode works offline; live needs your Kling key. |
| Audio post | Inspector on clips + master | Per-clip gain/fades; six-stage master chain (denoise, EQ, compression, limiting); music/ambience layers with looping and **automatic ducking** under speech; loudness normalized to the platform target (verified on the exported file). |
| Meters | Preview panel edge | Momentary/short-term/integrated loudness + true peak vs the profile target, live during playback. |
| Image looks | Inspector on clips | Exposure/contrast/temperature/tint/saturation, saveable as versioned look presets. |

## 6. Review tab — the feedback loop

| Feature | Where | How |
|---|---|---|
| Frame annotations | Preview panel (paused) | Draw arrows, boxes, ellipses, pins, time-ranges; type notes. Coordinates are resolution-independent; anchors stick to the clip/word so they survive edits. |
| Ask the agent to act | Annotation → context package | The agent receives the marked frame, clean frame, transcript context, and layers — and answers with a proposal addressing that annotation. Accepting resolves the annotation with full traceability. |
| Proposals | Agent panel | Every agent change lands here: semantic diff ("Trim tail of clip X by 30 frames"), reason, risk class, warnings, orphaned-anchor alerts. **Accept / reject / request revision.** Rejection leaves your project byte-identical. |
| Assessments | Attached to proposals | When the agent scores pacing/clarity/retention, you see the criteria, what's observation vs inference, evidence links, and limitations — recommendations, never verdicts. |
| Specialist critic | Agent panel → request critique | An optional second model reviews the cut and files findings (note/minor/major with evidence). Adviser only; consent- and budget-gated. |
| Annotation lifecycle | Annotation list | open → addressed → resolved / rejected / reopened; accepted edits record which annotations they addressed. |

## 7. Publish tab — get it out

| Feature | Where | How |
|---|---|---|
| Deliverables | Deliverables/status panel | The long-form master plus any number of shorts, each with status (draft → in-review → approved → stale) and its own profile. Select one here or in Publish to make it the active distribution across Preview, Timeline, caption/edit targets, Graphics, B-roll, inspectors, Restyle, and Publish. The choice autosaves with the project and survives phase changes and reopen. The visible Transcript source stream remains project-wide. |
| Finding shorts | Agent candidates or manual | The agent proposes hook/coherence/payoff-scored candidates, or select any transcript passage/range → "derive short". |
| Independent short edits | Derived short's own sequence | A short is a real edit — its own ordering, pacing, graphics, CTA — never just a crop. Edits are tracked as intentional divergences. |
| Vertical reframing | Preview (portrait mode) per short | Subject tracking + per-shot framing decisions; presenter repositioned, layers rearranged (never center-cropped). Override any shot's crop manually — overrides survive re-derivation. |
| Staleness | Automatic | Editing long-form footage under an approved short (or restyled chunk, or chapter list) flags it **stale** with the affected range and a refresh proposal. Approved outputs are never overwritten. |
| Exports | Per deliverable → Export | Burned-in + clean video, SRT/VTT, six scored cover candidates, export report with hashes. Loudness verified on the delivered file. |
| Chapters | Publish panel | Generated from your named story beats; timestamps auto-update with edits (stale-flagged, never silently rewritten); paste-ready text. |
| Metadata | Publish panel editor | Drafted titles/descriptions/tags/hashtags per platform, editable, validated against each platform's length/count limits (over-limit fails loudly). |
| Thumbnails | Publish panel | Candidate frames + keyed presenter cutouts + template composition at platform spec. |
| Upload kits | Publish panel → Build kit | One folder per platform: videos, cover, subtitles, chapters, metadata, transcript, report — hash-verified so manual upload needs zero further checking. |
| Batch export | Publish panel | Validate + export many approved deliverables with per-item status and retry. |
| Interchange | Deliverable → Export OTIO | One-way OpenTimelineIO export for finishing elsewhere; a loss review shows exactly what doesn't survive (annotations, semantic anchors...). |

## 8. The agent, skills, and safety rails

| Feature | Where | How |
|---|---|---|
| Attach a director | Any MCP-capable model | The gateway starts with the app; connection info in `~/.guyditor/state/gateway.json`. The agent uses the same operations as the UI — and everything arrives as proposals. |
| Skills | Skills panel | Your editorial preferences as versioned local documents (pacing, filler policy, subtitle style, brand voice/visuals, hook rubrics). Projects **pin** skill versions — publishing a new version never changes an approved episode until you explicitly upgrade. |
| Learning from you | Proposal review → "save as example" | Accepted/rejected decisions can be captured into a skill as draft examples — activated only by explicit review and publish. The agent gets better without becoming opaque. |
| Automation policy | Project settings | Optionally allow specific low-risk operations to auto-accept (still journaled and auditable). Default: everything is reviewed. |
| Budgets | Status panel cost readout | Caps and warning thresholds per task/episode/lifetime. Expensive external calls show a **total cost estimate first** and block or ask when a cap would be crossed. |
| Audit log | `~/.guyditor/audit/` + Inspector | Every agent session: instructions, tool calls, proposals, every external call with what data classes were sent and what it cost. |
| Data boundaries | Settings | External transfer kill switch: disable all outbound provider calls while keeping every local feature. Secrets live in the OS keychain — never in project files, logs, or backups. |

## 9. Data safety

| Feature | Where | How |
|---|---|---|
| Backup | Storage panel → Backup | Hashed, deduplicated, verifiable backups of everything load-bearing (config: `backup.guyditor.yaml`); scheduled runs; test-restores without touching your working project. Credentials are never included. |
| Archival | Storage panel → Archive | Move heavy media to cold storage; the project stays searchable with previews; restore is hash-verified. |
| Machine loss | [runbooks/restore.md](runbooks/restore.md) | Full clean-machine rebuild: project + skills + presets + provider config (minus secrets, which you re-enter). |
| Versioning | History viewer | Every accepted edit is a revision with a snapshot + lock file; restore any revision; rebuild any revision bit-for-bit from locked inputs. The project file and history are plain text — readable with any editor, Git-friendly. |

## 10. Reference

- **Shortcuts**: phase tabs `Ctrl/Cmd+Alt+1..5`; frame step `←/→`; undo/redo
  `Ctrl+Z/Ctrl+Y`; full map in the in-app keyboard reference.
- **Project on disk**: `episode.guyditor.yaml` (the canonical project model,
  human-readable) · `workspace.guyditor.yaml` (portable non-editorial active-
  distribution state; safe fallback to primary if missing or invalid) ·
  `sidecars/` (transcripts, annotations, framing...) · `history/` (journal +
  revision snapshots) · `proposals/` (pending review) · `.guyditor/` (disposable
  caches — always safe to delete).
- **Env vars**: `GUYDITOR_FFMPEG`/`GUYDITOR_FFPROBE` (binary overrides),
  `GUYDITOR_ML_MODEL_DIR` (model cache), `GUYDITOR_ML_DISABLE` (drop ML
  capabilities), `GUYDITOR_RESTYLE_STUB=1` (force offline restyle).
- **Troubleshooting**: "Electron uninstall" → README setup note. ML features
  missing → `bash workers/mlworker/setup.sh`, check the capability list in
  Settings. Renders failing validation → the export report names the exact
  blocker (stale sidecar, missing asset, loudness, caption overflow).
