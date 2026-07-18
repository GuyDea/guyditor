# Guyditor Business Requirements

**Document status:** Draft v2 for product-owner review — incorporates the 2026-07-17 gap-analysis amendments  
**Date:** 2026-07-17  
**Product:** Guyditor  
**Document purpose:** Define the business outcomes, product behavior, scope, and acceptance criteria for an agent-native, local-first video-editing platform.

## 1. Executive summary

Guyditor will help a solo creator turn captured footage and supporting assets into polished long-form and short-form videos with substantially less repetitive editing work.

The product will combine:

- A frontier AI model, such as Codex or Claude, acting as the editing director and reasoning layer.
- Local media tools for transcription, analysis, compositing, previewing, and rendering.
- A custom visual timeline and review interface.
- Reusable local skills, brand rules, styles, and editing preferences.
- A declarative, human-readable project file that makes every accepted edit inspectable and versionable.

The creator must remain in control of subjective editorial decisions. The agent may analyze material, propose edits, build complete drafts, and automate repetitive work, but consequential changes must be reviewable as both a visual preview and a semantic text diff.

Guyditor is not intended to imitate a traditional non-linear editor feature for feature. Its advantage will be an agent-native workflow in which the creator can describe an outcome, inspect the result, annotate exact frames, and refine the project through conversation or direct manipulation.

## 2. Business problem

Producing one high-quality video currently requires many disconnected activities:

- Reviewing and organizing takes.
- Finding mistakes, pauses, filler words, and strong moments.
- Cutting and rearranging footage.
- Transcribing speech and correcting the transcript.
- Creating and timing subtitles.
- Adding per-word subtitle highlighting.
- Removing green screens and composing several visual layers.
- Creating animations, diagrams, callouts, and B-roll.
- Reviewing the result and communicating frame-specific changes.
- Reformatting the finished video for several social platforms.
- Repeating brand, subtitle, motion, and layout decisions across episodes.

Commercial editing products solve parts of this workflow, but the creator's preferences and project knowledge remain distributed across application state, memory, prompt histories, and manual habits. Edits are often difficult to review as structured changes, difficult to reproduce, and expensive to repeat across formats.

Guyditor must turn these activities into a coherent and progressively personalized workflow.

## 3. Product vision

The intended experience is:

1. The creator records the main presentation, screen captures, and any additional footage.
2. Guyditor imports and analyzes the material locally.
3. The agent builds or proposes an initial edit using the creator's reusable skills and preferences.
4. The creator reviews the video in a custom timeline, stops on any frame, and adds precise visual or textual feedback.
5. The agent responds with an edit proposal, preview, explanation, and semantic diff.
6. The creator accepts, rejects, or adjusts the proposal.
7. Guyditor produces a long-form master and derives platform-specific short-form videos with synchronized subtitles.
8. Every accepted decision remains traceable and reproducible.

The long-term product should allow the creator to spend most of their effort on recording, storytelling, judgment, and refinement rather than mechanical editing.

## 4. Target users

### 4.1 Primary user

A solo creator who:

- Records presenter-led educational, analytical, tutorial, or essay-style videos.
- Publishes long-form videos to YouTube.
- Repurposes long-form material for TikTok, Instagram Reels, and YouTube Shorts.
- Uses screen recordings, green-screen footage, images, diagrams, animation, and B-roll.
- Wants extensive automation without surrendering editorial control.
- Is comfortable using a visual interface and conversational instructions, but should not need to edit render commands or code.

### 4.2 Secondary users

The design should remain extensible to small creator teams, editors working with a creator, and recurring branded content, but real-time multi-user collaboration is not required for the initial release.

## 5. Product principles

### BR-001 — Local-first media processing

Raw footage, audio extraction, transcription, proxy creation, and routine rendering should run locally by default. The product must clearly identify any operation that sends media or derived content to an external service.

### BR-002 — Frontier model as director

The frontier model is responsible for reasoning, planning, interpreting instructions, applying reusable editorial skills, and proposing structured changes. It should invoke media capabilities through stable tools rather than manipulate the application by simulated mouse clicks.

### BR-003 — Provider independence

The core project format and editing workflow must not depend on a single model vendor. Codex or Claude may act as the main director. Specialized providers may optionally be used for video critique, B-roll generation, image generation, or other bounded services.

### BR-004 — Human control of subjective judgment

The system may evaluate pacing, takes, hooks, emotional delivery, clarity, and likely audience retention using explicit rubrics and learned preferences. These judgments must be presented as reasoned recommendations rather than objective facts. The creator must be able to compare alternatives and override them.

### BR-005 — Declarative source of truth

A human-readable master project file must describe the current edit. Rendered videos, preview files, generated commands, and caches are derived artifacts, not the authoritative project state.

### BR-006 — Semantic and reviewable changes

Agent and UI operations must produce meaningful changes such as “trim opening hook by 30 frames” or “move diagram from word w0042 to w0040.” They must not produce unexplained bulk rewrites.

### BR-007 — Progressive personalization

Repeated preferences must be capturable as local reusable skills, presets, and style definitions. The system should become more aligned with the creator's editorial language and brand over time without making its behavior opaque.

### BR-008 — Build through real production

The platform should be developed and validated while producing actual videos. Features should support an end-to-end episode workflow rather than exist only as isolated technical demonstrations.

## 6. Scope

### 6.1 Required product scope

The first complete product workflow must include:

- Project and asset ingestion.
- Proxy generation and local media analysis.
- Transcript generation, correction, and per-word alignment.
- Basic transcript-based and timeline-based editing.
- Multi-layer video composition.
- Green-screen removal and quality review.
- Picture-in-picture and floating-presenter layouts.
- Subtitles with per-word highlighting.
- Frame-accurate review annotations.
- A custom preview and timeline interface.
- Reusable visual, editorial, subtitle, and motion presets.
- Agent-proposed edits with previews and semantic diffs.
- Long-form YouTube output.
- Short-form TikTok, Instagram Reels, and YouTube Shorts derivatives.
- Optional generative or externally sourced B-roll through provider adapters.
- Versioning, provenance, reproducibility, and restoration of older edits.
- Capture-tool integration, record-time take markers, and pickup recording.
- Publish packaging: metadata drafting, chapter lists, thumbnails, and per-platform upload kits.
- Operational safeguards: backup, cost visibility, and an agent activity audit log.

### 6.2 Explicit non-goals for the initial release

The initial release is not required to provide:

- Every tool found in professional systems such as DaVinci Resolve, Premiere Pro, or After Effects.
- Real-time multi-user editing.
- A proprietary foundation model trained from scratch.
- A proprietary generative video model.
- Mobile editing applications.
- Direct publishing or social-account management.
- Full interchange fidelity with every external editor.
- Fully autonomous publication without creator review.

Direct publishing and social-account management are deferred from the initial release, not permanently excluded: review-gated upload assistance is recorded in Section 6.3 for reconsideration once the export workflow is proven in real use. Fully autonomous publication without creator review remains permanently out of scope.

### 6.3 Deferred capabilities under consideration

A structured gap analysis (2026-07-17) identified the following capabilities as valuable but consciously deferred. They are recorded here so their absence is a decision rather than an oversight, and each should be revisited once the initial workflow is proven on real episodes:

- Review-gated upload assistance to YouTube, TikTok, Instagram Reels, and YouTube Shorts: authenticated draft upload of an approved deliverable with its metadata, always gated on explicit creator review.
- A channel-level episode library with per-deliverable publish-status tracking and cross-episode transcript search.
- Project templates carrying timeline structure, and a shared cross-project brand media library with controlled update propagation.
- License-aware music and sound-effect sourcing adapters with per-platform rights validation at export.
- Import of platform analytics (retention curves, hook metrics) to calibrate the editorial rubrics of FR-700/FR-702.
- Script authoring and teleprompter support integrated with FR-202 script reconciliation.
- Verified camera-card offload and automatic session grouping beyond the watch-folder ingestion required by FR-009.
- Localization: translated subtitle deliverables and optional dubbed or synthesized audio tracks.

## 7. Core workflow requirements

### FR-001 — Project creation

The creator must be able to create a project, select a storage location, define the primary output format, and associate local reusable skills or brand profiles with the project.

### FR-002 — Asset ingestion

The system must import video, audio, still images, screen recordings, animations, subtitle files, and generated media without modifying the original source files.

Each source asset must receive a stable identifier and integrity hash. Metadata should include duration, dimensions, frame rate, audio properties, and capture time where available.

### FR-003 — Proxy workflow

The system must create lower-resolution proxies for responsive review while preserving links to full-resolution source media for final rendering. Missing, stale, or invalid proxies must be regenerable.

### FR-004 — Initial analysis

The system must be able to analyze imported footage for speech, silence, shot boundaries, visible subjects, framing, and technical issues. Analysis results must be stored as derived metadata and may be regenerated without changing the accepted edit.

### FR-005 — Draft generation

The agent must be able to propose or assemble an initial edit from selected takes, a script, a transcript, or a combination of these. The creator must be able to constrain the agent by target length, intended audience, platform, editorial style, and required content.

### FR-006 — Direct and conversational editing

The creator must be able to modify the same project through:

- Direct timeline operations.
- Transcript selection and text-based operations.
- Frame annotations.
- Natural-language instructions to the agent.

All four interaction modes must update the same underlying project model.

### FR-007 — Missing-media relinking

If an asset moves or becomes unavailable, the system must preserve the edit and allow the creator to relink the missing media. Hash and metadata checks must help prevent an incorrect replacement from being accepted silently.

### FR-008 — Audio and camera synchronization

The system must support synchronizing separately recorded audio and video using embedded time information, waveform analysis, or a manual synchronization point. The original tracks and synchronization decision must remain traceable.

### FR-009 — Capture integration and automated ingest

The system must define a documented integration contract with external recording tools rather than require in-app recording for the initial release. The contract must include recommended capture settings per source type, file and session naming conventions, and watch folders: when new session media appears in a configured location, the system must ingest it (FR-002) and trigger proxy, transcription, and analysis jobs automatically as visible background work. The contract must be usable with common tools such as OBS and camera-card copies without custom code.

### FR-010 — Record-time take markers

The system must be able to import take markers created during recording — for example marker files, timestamped notes, or hotkey logs following the documented convention — and attach them to ingested assets as structured take metadata such as take boundaries, quality flags, and noted mistakes. The system should also be able to detect spoken marker phrases in the transcript. Take metadata must be available to draft generation (FR-005) and take comparison (FR-304).

### FR-011 — Pickup recording and flubbed-line repair

The creator must be able to repair a misspoken word, number, or name inside an otherwise good take without leaving the workflow. The system must provide a guided pickup flow that captures or imports a short corrective recording, transcribes and force-aligns it (FR-200, FR-201), and splices it under the audio-continuity rules of FR-305 while updating word timing and captions (FR-208). Synthetic voice correction of the creator's own voice may be offered later through a provider adapter; it must be consent-gated, clearly disclosed in provenance, and reviewable like any other proposal.

## 8. Master project and versioning requirements

### FR-100 — Canonical master file

Every project must have one canonical, declarative master file using a documented and versioned schema, for example `episode.guyditor.yaml` with `format: guyditor/v1`.

The master file must describe or reference:

- Project settings.
- Assets and their immutable identifiers.
- Ordered sequences and source ranges.
- Audio and video layers.
- Transitions and effects.
- Captions and subtitle style.
- Annotations and their status.
- Long-form and short-form deliverables.
- Referenced sidecar files and their hashes.
- Reusable presets and skill versions.

### FR-101 — Stable and readable diffs

The format must use stable IDs and avoid cascading changes. Sequential clip positions should normally be derived from sequence order and duration rather than storing a changing absolute start time for every downstream clip.

### FR-102 — Time representation

Frame-accurate edits must use integer frames or lossless rational time. The project must distinguish:

- Source time: position in the original asset.
- Timeline time: position in the assembled output.
- Semantic anchors: transcript words, named story beats, or clip-relative events.

### FR-103 — Sidecars

Large or machine-oriented structures, such as thousands of per-word timestamps, may live in referenced sidecar files. The master file must identify their schema and integrity hash so a sidecar change is detectable.

### FR-104 — Atomic edit transactions

Every accepted edit must record:

- The base revision.
- The resulting revision.
- The semantic operations performed.
- The user instruction or review annotation that caused the change.
- The responsible human, agent, or tool.
- Relevant model, skill, preset, and tool versions.
- Acceptance status and timestamp.

### FR-105 — Proposed versus accepted state

The agent must not silently overwrite accepted project state. Proposed edits must be reviewable and separately identifiable until accepted. Rejection must leave the accepted revision unchanged.

### FR-106 — Version history

Text-based project state must be compatible with Git versioning. Binary source and render artifacts should be referenced rather than embedded in Git history unless the creator explicitly chooses otherwise.

### FR-107 — Reproducibility

An accepted revision must be reproducible from its master file, lock information, source assets, accepted generated assets, presets, and sidecars. Generated B-roll must be stored as an accepted asset rather than silently regenerated during a later render.

### FR-108 — Restoration and comparison

The creator must be able to restore an older accepted revision and compare two revisions through both a semantic text summary and representative visual previews.

## 9. Transcript and subtitle requirements

### FR-200 — Local transcription

The system must generate a transcript locally by default using a speech-recognition engine capable of timestamped segments and words. It must preserve detected language and confidence information where available.

### FR-201 — Per-word alignment

The system must produce canonical per-word timing suitable for subtitle highlighting. Where initial transcription timestamps are insufficient, the workflow must support forced alignment against the audio.

### FR-202 — Script reconciliation

When a source script exists, the system must compare it with spoken audio without replacing the observed transcript blindly. It must preserve meaningful deviations, restarts, or improvisation and allow the creator to choose the intended wording.

### FR-203 — Transcript correction

The creator must be able to correct words, punctuation, speaker attribution, and segmentation without losing the relationship to source audio. Timing changes must be explicit.

### FR-204 — Canonical word identity

Every transcript word must have a stable ID. Clips, captions, annotations, animations, and short-form excerpts must be able to anchor to word IDs so they survive upstream timeline changes where possible.

### FR-205 — Caption rendering

The system must support:

- Per-word highlighting.
- Phrase-by-phrase or line-by-line display.
- Configurable typeface, size, weight, color, outline, shadow, background, and emphasis.
- Configurable words per line and maximum line width.
- Placement rules and platform-safe areas.
- Speaker-aware styling where needed.
- Reusable and versioned caption presets.

### FR-206 — Caption preview and correction

Captions must be previewable at frame accuracy. The creator must be able to correct text, timing, line breaks, and emphasis before final render.

### FR-207 — Subtitle outputs

Every applicable deliverable must support:

- A video with subtitles burned in.
- A clean video without burned-in subtitles.
- SRT and VTT sidecars.

SRT or VTT must not be the canonical source for per-word highlighting because they cannot represent the full project semantics reliably.

### FR-208 — Synchronization through edits

Subtitles must remain synchronized after trimming, splitting, rearranging, speed changes, or short-form extraction. Any ambiguity or failed alignment must be surfaced for review.

## 10. Timeline and basic editing requirements

### FR-300 — Custom timeline

The initial product must include a custom timeline designed around review and agent collaboration. It need not reproduce every professional NLE control, but it must support the complete Guyditor workflow.

### FR-301 — Timeline operations

The creator and agent must be able to:

- Select, trim, split, remove, move, and duplicate clips.
- Create gaps and overlaps.
- Add and modify transitions.
- Enable, disable, lock, and reorder layers.
- Adjust clip audio levels and fades.
- Navigate by frame, time, clip, transcript word, annotation, and story beat.

### FR-302 — Transcript-based editing

The creator must be able to select transcript words or passages and apply operations such as remove, retain, create clip, or create short-form candidate. Transcript edits must update the timeline while preserving source traceability.

### FR-303 — Pause and filler assistance

The system may identify long pauses, filler words, repeated phrases, and false starts. Removal must be configurable and reviewable because a pause may be intentional, thoughtful, dramatic, or necessary for comprehension.

### FR-304 — Take comparison

The system must support comparing alternative takes using transcript content, delivery characteristics, technical quality, and creator-defined preferences. The agent must explain its recommendation and retain access to rejected alternatives.

### FR-305 — Audio continuity

Automated cuts must avoid obvious clicks, abrupt ambience changes, clipped phonemes, and visibly unnatural jump cuts. The system must provide warnings when a clean edit cannot be made automatically.

### FR-306 — Visual transforms and retiming

The system must support clip-level crop, scale, position, rotation, opacity, speed changes, freeze frames, and fades. Automated retiming must preserve transcript and caption synchronization or explicitly identify portions that require realignment.

### FR-307 — Image finishing

The creator must be able to apply basic exposure, contrast, white-balance, saturation, and color-matching corrections. Reusable looks may be applied through versioned presets, while source media remains unchanged.

### FR-308 — Audio post-production

The system must support synchronization correction, gain, fades, channel selection, loudness normalization, noise reduction, equalization, compression, and limiting at a level sufficient for clear creator-led videos. Automated processing must remain adjustable and bypassable.

### FR-309 — Music, ambience, and effects

The creator must be able to add music, room tone, ambience, and sound effects on separate tracks. The system must support fades, looping, timing anchors, and automatic or manual ducking beneath speech.

### FR-310 — Transition control

The system must support cuts, crossfades, audio crossfades, and reusable visual transitions. Transition duration and intent must be visible in the project state, and an agent should prefer restrained creator-approved presets unless instructed otherwise.

### FR-311 — Jump-cut concealment

Because pause and filler removal (FR-303) produces frequent cuts in continuous presenter footage, the system must offer remediation for visible jump cuts: automatic alternation of punch-in framing levels at cut points derived from a single high-resolution source, reusable smooth-cut transition presets, and, where synchronized alternate angles exist, angle switching. Remediation must be proposed as reviewable edits (FR-105), be configurable through editorial skills (FR-700), and never be silently applied.

## 11. Frame-accurate review and annotation requirements

### FR-400 — Precise review control

The creator must be able to pause and scrub to an exact frame or transcript word.

### FR-401 — Annotation types

At any review position, the creator must be able to add:

- A text note.
- A point or pin.
- A rectangle or ellipse.
- An arrow.
- A freehand drawing.
- A spotlight or highlighted region.
- A time range rather than a single frame.

### FR-402 — Stable annotation anchors

Annotations should anchor to a stable source clip and source frame, transcript word, object, or semantic beat where possible. Timeline-only anchors may be used when no stable alternative exists.

### FR-403 — Coordinate system

Visual annotations must use normalized or otherwise resolution-independent coordinates so they remain meaningful across proxy resolutions and output formats.

### FR-404 — Review annotation versus rendered overlay

The product must distinguish private review annotations from graphics intended to appear in the exported video. A creator may deliberately convert an annotation into a final overlay, but the two must not be confused automatically.

### FR-405 — Agent context package

When acting on an annotation, the agent must be able to receive the marked frame, a clean frame, nearby frames or a short proxy range, relevant transcript context, and project-layer metadata.

### FR-406 — Annotation lifecycle

Annotations must support open, addressed, resolved, rejected, and reopened states. Accepted edits must identify which annotation they addressed.

## 12. Multi-layer composition requirements

### FR-500 — Layer model

The composition system must support an ordered set of video, image, animation, text, caption, matte, adjustment, and audio layers.

### FR-501 — Presenter composition

The system must support a keyed or matted presenter placed:

- Over a static background.
- Over a screen recording.
- In front of an animation.
- Between a background and a foreground graphic.
- Alongside another video or diagram.

### FR-502 — Green-screen removal

The system must support high-quality chroma-key removal including configurable key color, tolerance, edge refinement, spill suppression, garbage masks, and color correction.

### FR-503 — Advanced matting path

Where traditional chroma keying is insufficient, the system should support an optional advanced or neural matting workflow. Temporal stabilization must be available to reduce edge shimmer and inconsistent transparency across frames.

### FR-504 — Key quality control

The keyed result must be reviewable over black, white, saturated, and checkerboard backgrounds. The system should detect or help identify halos, spill, holes, transparency errors, edge chatter, and lost hair or fine detail.

### FR-505 — Capture guidance

The product should provide capture-quality warnings or guidance because lighting, screen uniformity, motion blur, compression, and distance from the screen materially affect the achievable key quality.

### FR-506 — Generic picture-in-picture

Video-inside-video must be a general composition primitive rather than a one-off effect. It must support:

- Transparent presenter cutouts.
- Circular or elliptical webcam bubbles.
- Rounded or rectangular video frames.
- Borders, shadows, masks, and backgrounds.
- Full-body presenter layouts.
- Screen recordings shown inside device or monitor frames.

### FR-507 — Simple placement

The creator must be able to position and size picture-in-picture content by dragging it in the preview or by using human-readable constraints such as `bottom_right`, `width: 24%`, and `margin: 4%`.

### FR-508 — Picture-in-picture transitions

The system must provide reusable entrance, exit, and movement presets, including fade, pop, scale, slide, smooth move, expand to fullscreen, collapse from fullscreen, and swap with the background content.

### FR-509 — Keyframed movement

The creator must be able to pause at a frame or word, place the floating video, and create a transition to that state. Keyframes must remain readable in the master file through semantic anchors and named transition presets.

### FR-510 — Collision avoidance

Picture-in-picture placement must be able to avoid captions, marked interface regions, faces, diagrams, cursor highlights, and platform UI safe areas. Automatic repositioning must be previewable and reviewable.

### FR-511 — Responsive composition

A composition may define different layout constraints for landscape, vertical, square, or other deliverables. Separate layers should be recomposed where possible instead of flattening and center-cropping the landscape result.

## 13. Graphics, animation, and B-roll requirements

### FR-600 — Reusable graphics

The system must support reusable titles, lower thirds, diagrams, callouts, highlights, transitions, and motion templates. Templates must be parameterized and versioned.

### FR-601 — Timeline anchoring

Graphics and animation must be anchorable to source clips, transcript words, named beats, annotations, or explicit frame ranges.

### FR-602 — Agent-generated composition

The agent must be able to create or configure graphics and animation through structured project operations. Generated visual text must use deterministic programmatic rendering rather than depend on a generative video model to spell text correctly.

### FR-603 — B-roll sources

The system must support B-roll from:

- Existing local footage.
- Licensed stock or downloaded assets supplied by the creator.
- Still images and illustrations.
- Screen captures.
- Programmatic animations.
- External generative image or video providers.
- Future locally hosted generation models where hardware permits.

### FR-604 — Provider adapters

Generative B-roll must use provider adapters so a project is not permanently tied to one generation service. The initial workflow must include the adapter interface and at least one usable generation path.

### FR-605 — Generation provenance

Accepted generated assets must retain the prompt, provider, model, settings, seed where available, creation date, usage-rights information supplied by the provider, and content hash.

### FR-606 — Factual and brand review

Generated or sourced B-roll must be reviewable for factual relevance, research accuracy, brand fit, visual artifacts, and unintended implications. The system must not treat visual plausibility as factual verification.

## 14. Editorial intelligence and personalization requirements

### FR-700 — Explicit editorial skills

The creator must be able to maintain local reusable skills describing:

- Pacing preferences.
- Treatment of pauses and filler words.
- Preferred framing and cut frequency.
- Subtitle styling and emphasis rules.
- Motion and transition preferences.
- Brand voice and visual identity.
- Hook, clarity, and retention rubrics.
- Rules for research accuracy and uncertainty.

### FR-701 — Preference examples

Skills should be able to include approved and rejected examples. The system should learn from explicit acceptance and correction history without silently changing a project's behavior.

### FR-702 — Subjective assessment

The agent may score or compare moments for clarity, delivery, emotion, pacing, and likely retention. It must disclose the criteria used, distinguish observation from inference, and allow the creator to inspect the relevant footage.

### FR-703 — Optional specialist critic

The workflow may employ a specialist model capable of reviewing video directly. Such a model is an adviser; the primary editing agent remains responsible for translating its feedback into structured proposals, and the creator remains the final authority.

### FR-704 — Explainability

For meaningful editorial changes, the agent must provide a concise reason tied to the creator's instruction, an annotation, an explicit skill rule, or observable media evidence.

### FR-705 — Controlled evolution

Changes to reusable skills and presets must be versioned separately from episode edits. A project must be able to continue using the version with which it was approved.

## 15. Long-form and short-form deliverable requirements

### FR-800 — Long-form master

The system must export a high-quality landscape master suitable for YouTube, with configurable resolution, frame rate, codec, audio format, and caption options.

### FR-801 — Short-form creation modes

The system must support both:

- Automatic candidate discovery: the agent identifies self-contained moments with a hook, coherent idea, and payoff.
- Manual selection: the creator selects a timeline range, transcript passage, clip range, or semantic beat.

### FR-802 — Independent derivative edits

A short-form video must be derived from the canonical source project but may have its own hook, ordering, pacing, cuts, graphics, caption layout, call to action, and ending. It must not be limited to cropping the corresponding long-form range.

### FR-803 — Vertical recomposition

Landscape material must be recomposed for vertical delivery. The workflow must support:

- Face, body, and relevant-object tracking.
- Shot-specific crops.
- Repositioning or resizing the presenter.
- Responsive rearrangement of screen recordings, diagrams, B-roll, and picture-in-picture layers.
- Manual correction for every automated framing decision.

### FR-804 — Short-form subtitles

Short-form outputs must use the canonical word timing while allowing platform-appropriate changes to font size, line length, placement, animation, and per-word highlighting.

### FR-805 — Platform profiles

TikTok, Instagram Reels, and YouTube Shorts must be represented by configurable and versioned export profiles. Aspect ratio, resolution, duration constraints, codec settings, safe areas, audio loudness and true-peak targets, and other platform requirements must not be irreversibly hard-coded.

### FR-806 — Required short-form outputs

Each selected short must be able to produce:

- A vertical MP4 with subtitles burned in.
- A clean vertical MP4.
- SRT and VTT subtitle sidecars.
- Candidate cover frames.
- An export report with duration, technical settings, and warnings.

### FR-807 — Derivative dependency tracking

When an accepted change to the long-form project affects a derived short, the system must mark that short as stale. It must show the affected source range and offer a refreshed preview and diff. It must not overwrite an approved short silently.

### FR-808 — Batch export

The creator must be able to validate and export several approved short-form deliverables as a batch while preserving individual status and errors.

### FR-809 — Publish metadata drafting

For each deliverable, the agent must be able to draft platform-appropriate titles, descriptions, tags, hashtags, and calls to action from the transcript, story beats, and brand-voice skills. Drafts must be creator-editable, stored with the deliverable, and validated against platform-profile metadata constraints such as length and count limits (FR-805).

### FR-810 — Chapter generation

The system must derive a YouTube chapter list from named story beats and semantic anchors. Chapter timestamps must update automatically when accepted edits shift the timeline, follow the staleness rules of FR-807 rather than silently diverge, and be exportable as paste-ready text.

### FR-811 — Long-form thumbnails

The system must support producing candidate thumbnails for long-form deliverables using existing capabilities — frame selection, keyed presenter cutouts (FR-502), and graphics templates (FR-600) — exported at platform specification. This extends the cover-frame support of FR-806 to long-form outputs.

### FR-812 — Upload kit

For each approved deliverable, the system must produce a consolidated per-platform upload kit: video variants (burned-in and clean), thumbnail or cover, subtitle sidecars, chapter text, drafted metadata in a documented file format, and the export report. The kit must pass export validation (FR-1004) plus metadata validation so that manual upload requires no further file gathering or checking.

### FR-813 — Text exports

The system must export the corrected transcript as plain text, and chapters and metadata as text blocks, for use in descriptions, show notes, and reuse outside Guyditor.

## 16. User-interface requirements

### FR-900 — Unified workspace

The custom interface must combine at least:

- Media and asset browser.
- Video preview.
- Multi-layer timeline.
- Transcript and subtitle editor.
- Annotation tools.
- Agent conversation and proposed-change panel.
- Semantic diff and approval controls.
- Deliverable and render-status panel.

### FR-901 — Same model for UI and agent

The UI and agent must operate through the same structured editing API and project model. An operation performed visually must be expressible semantically, and an agent proposal must be visible and adjustable in the UI.

### FR-902 — Preview quality modes

The creator must be able to use responsive proxy preview for normal editing and request high-quality previews for critical areas such as green-screen edges, compositing, motion, and captions.

### FR-903 — Comparison workflow

The interface must support before/after and alternative-preview comparison for proposed edits, takes, keys, layouts, and short-form reframes.

### FR-904 — Undo and rejection

Direct UI actions must support undo and redo. Agent proposals must support accept, reject, and revise without corrupting the accepted project revision.

### FR-905 — Accessible project state

The project must remain understandable without the UI. A technically capable user must be able to inspect the master file and semantic history in ordinary text tools.

### FR-906 — Audio visibility

The editing interface must render audio waveforms on timeline clips and provide level and loudness metering during preview, sufficient to align cuts to speech and music, verify ducking (FR-309), and confirm platform loudness targets (FR-805) before export.

## 17. Rendering and export requirements

### FR-1000 — Local rendering

Standard preview and final rendering must work locally using installed media tooling. External rendering may be added later but must not be required for the core workflow.

### FR-1001 — Selective rendering

The system should render only affected ranges or dependent nodes for previews. Caches must be keyed by relevant project state and asset hashes so unchanged work can be reused safely.

### FR-1002 — Deterministic artifacts

Given the same accepted project revision, lock information, source assets, and deterministic render configuration, the system must produce functionally equivalent output. Nondeterministic external generations must be frozen as assets before acceptance.

### FR-1003 — Render queue

The creator must be able to queue previews and final exports, view progress, cancel work safely, and retry failed jobs.

### FR-1004 — Validation before export

Final export must validate:

- Missing or changed assets.
- Unsupported or unavailable effects.
- Stale transcripts or sidecars.
- Unresolved render-blocking annotations.
- Caption overflow and safe-area problems.
- Loudness or true-peak deviations from the platform profile target, clipping, and unintended silence.
- Invalid output settings.
- Known compositing or media errors.

### FR-1005 — Export report

Every final export must record the project revision, output profile, source hashes, render settings, warnings, and resulting file hash.

## 18. Interoperability requirements

### FR-1100 — Media standards

The system should accept and produce common professional and creator media formats through a mature media engine such as FFmpeg.

### FR-1101 — Subtitle interoperability

The system must import and export common subtitle sidecars while preserving richer internal word timing and style separately.

### FR-1102 — Timeline interchange

The system should support exporting a simplified interchange timeline, such as OpenTimelineIO or another appropriate format, for finishing in an external editor. Guyditor's richer project format remains canonical because external adapters may not preserve annotations, agent provenance, responsive layouts, semantic anchors, or all effects.

### FR-1103 — No lock-in of source assets

Source assets and final outputs must remain ordinary files accessible outside Guyditor. The project must not depend on an opaque proprietary media database.

## 19. Privacy, security, and rights requirements

### NFR-001 — Clear data boundaries

The product must distinguish local-only operations from operations that send prompts, transcripts, frames, audio, video, or metadata to external providers.

### NFR-002 — Minimum necessary disclosure

External model calls should send the minimum media and context necessary for the requested task. The creator must be able to disable external media transfer while retaining local editing functionality.

### NFR-003 — Secrets management

Provider credentials must not be stored in project files, committed to version control, or exposed in render logs.

### NFR-004 — Asset rights metadata

The system must allow the creator to record the source, license, and usage restrictions of stock or generated assets. It should warn when rights information required by the creator's workflow is missing.

### NFR-005 — Project integrity

Asset hashes and project validation must detect unintended file replacement or corruption. The system must not delete original source media as a side effect of editing.

### NFR-006 — Cost visibility and budgets

The system must show estimated and actual spend for external model, critic, and generation calls at task, episode, and cumulative levels. The creator must be able to set budget caps or warning thresholds, and the system must warn before starting operations expected to be expensive. Spend records must be part of the audit log (NFR-007).

### NFR-007 — Agent activity audit log

The system must keep a durable, inspectable log of agent activity per session: instructions received, tools invoked, proposals made, accepted, and rejected, and every external call actually issued with provider, data classes sent (NFR-001), token or unit counts, cost, and outcome. The audit log is operational history, remains separate from project state (R-007), and must have configurable retention.

## 20. Performance and operational requirements

### NFR-100 — Responsive editing

Normal timeline navigation, transcript selection, annotation, and proxy preview must remain responsive on the supported creator workstation. Expensive analysis or rendering must run as visible background jobs rather than freeze the interface.

### NFR-101 — Hardware adaptation

The system must detect available CPU, GPU, memory, storage, and media acceleration, then choose compatible processing paths. Lack of GPU access must result in a slower supported path or a clear capability warning rather than unexplained failure.

### NFR-102 — Storage awareness

The product must estimate storage use, identify caches and derived artifacts, and allow safe cache cleanup without deleting accepted project state or source media.

### NFR-103 — Recoverability

Interrupted analysis, proxy, and render jobs must fail safely. The accepted project state must remain valid after a crash or cancellation.

### NFR-104 — Actionable errors

Errors must identify the affected asset, project operation, or deliverable; explain whether accepted state was changed; and offer a safe retry, correction, or fallback where possible.

### NFR-105 — Extensibility

Transcription engines, renderers, model providers, B-roll generators, analysis tools, and exporters must connect through documented boundaries so they can evolve without changing the business-level project semantics.

### NFR-106 — Verifiable backup

The system must support an automated, verifiable backup strategy — built in or through documented integration with external backup tools — covering the master file, sidecars, skills, presets, accepted generated assets, and source media. Backup configuration must distinguish load-bearing state from disposable caches (NFR-102), and restores must be testable without disturbing the working project.

### NFR-107 — Archival and media offlining

The system must support archiving finished projects by moving heavy source media to offline or cold storage while keeping the master file, transcripts, and lightweight previews searchable. Archived media must be restorable through existing hashes and relinking (FR-007).

### NFR-108 — Cross-machine restore

A documented path must exist to rebuild a project and the full working environment — global skills, brand profiles, and provider configuration excluding secrets (NFR-003) — on a replacement machine from backups, with integrity verification.

### NFR-109 — Schema migration

When the project schema evolves beyond guyditor/v1, older projects must be migratable through an explicit, reviewable migration step. Migration must never alter editorial content silently, and the pre-migration project must remain recoverable.

## 21. Business rules

1. Original source media is immutable from Guyditor's perspective.
2. The accepted master project is the source of truth; MP4s and previews are build artifacts.
3. Every accepted media range refers back to an original asset and source time.
4. Detailed timing may be stored in sidecars, but every referenced sidecar is schema-versioned and hashed.
5. Agent changes are proposals until explicitly accepted or accepted under a creator-configured low-risk automation policy.
6. A user-visible diff and reason accompany every meaningful agent edit.
7. Review annotations do not appear in final output unless explicitly converted to renderable overlays.
8. Generated media is frozen as an asset before it becomes part of an accepted edit.
9. A short-form derivative may diverge editorially from the long-form video while retaining source traceability.
10. Upstream changes never silently overwrite approved derivatives.
11. Platform profiles and reusable skills are versioned inputs, not hidden global behavior.
12. Subjective AI judgments are recommendations supported by criteria and evidence, not guaranteed predictions of audience response.

## 22. Initial release acceptance scenarios

The initial complete workflow will be considered successful when the creator can perform all of the following in Guyditor:

### AC-001 — Build a long-form episode

Import multiple presenter takes, a screen recording, images, and audio; generate proxies and a transcript; assemble and refine a landscape YouTube video; and export an approved master.

### AC-002 — Inspect every accepted edit

Open the human-readable master file or semantic history and understand which clips, ranges, layers, captions, and deliverables changed between two revisions without interpreting a large cascade of unrelated timestamps.

### AC-003 — Correct word-highlight subtitles

Generate per-word-aligned captions, correct transcript errors, preview highlighting at frame accuracy, and export both burned-in and sidecar subtitle variants without visible cumulative drift.

### AC-004 — Review with visual notes

Pause at an exact frame, draw an arrow or region, add a note, ask the agent to address it, compare the proposed result, accept the edit, and see the annotation marked resolved with traceability to the accepted revision.

### AC-005 — Composite a presenter

Remove a green background from presenter footage, place the presenter between a supplied background and foreground animation, inspect the matte over diagnostic backgrounds, and render a clean composite.

### AC-006 — Use picture-in-picture

Place a floating presenter over a screencast by dragging in the preview or choosing a named layout, move the presenter at a transcript word using a transition preset, and preserve a concise semantic project diff.

### AC-007 — Create short-form derivatives

Ask the agent for candidate clips and manually select another passage; create vertical derivatives with shot-specific reframing and responsive layer layouts; correct the crop; preview per-word subtitles; and export platform-profiled versions for TikTok, Instagram Reels, and YouTube Shorts.

### AC-008 — Detect stale derivatives

Change a section of the long-form edit used by an approved short and receive a clear stale-derivative warning, affected-range explanation, and refresh proposal without overwriting the approved short.

### AC-009 — Reproduce a revision

Restore an older accepted revision and rebuild it from the recorded project state, source assets, frozen generated assets, skill versions, and render configuration.

### AC-010 — Reuse creator preferences

Apply a versioned local style or editorial skill to a new project and obtain the same subtitle, motion, framing, and review rules without manually recreating them.

### AC-011 — Package an upload kit

After final export, generate upload kits for the long-form video and one short: thumbnail, chapter list, metadata within platform limits, subtitle sidecars, and both video variants; then trim the long-form edit and receive a stale-chapter warning instead of silently outdated timestamps.

### AC-012 — Survive machine loss

Back up a project, restore it on a clean machine, verify integrity, and continue editing with skills, presets, and provider configuration intact except for re-entered secrets.

## 23. Product success indicators

The product should be evaluated against these outcomes after real episode use:

- A creator can finish a publishable long-form episode and its short-form derivatives without transferring the project to another editor for routine work.
- Mechanical editing time decreases across successive episodes as reusable skills and presets mature.
- Most agent proposals can be understood from their reason, semantic diff, and preview without inspecting generated commands.
- Transcript and caption corrections remain reusable across all deliverables.
- Approved short-form videos remain traceable to the long-form source while retaining independent editorial control.
- Older accepted versions remain rebuildable.
- The creator reports increased time spent on recording and editorial judgment relative to repetitive timeline manipulation.

These indicators should be measured using real projects before setting numerical automation or time-saving targets.

## 24. Delivery priorities

### Priority A — End-to-end foundation

- Canonical project schema and semantic edit operations.
- Asset ingestion, proxies, and local analysis.
- Transcript and word alignment.
- Custom preview, transcript, annotation, and timeline workspace.
- Basic video and audio editing.
- Agent proposal, diff, preview, and approval loop.
- Long-form render and export.
- Agent activity audit log, cost visibility, and backup foundations (NFR-006, NFR-007, NFR-106).

### Priority B — Creator presentation workflow

- Multi-layer composition.
- Green-screen keying and matte quality control.
- Picture-in-picture layouts, transitions, and collision avoidance.
- Per-word caption rendering and reusable styles.
- Graphics and animation templates.
- Audio waveforms and metering, jump-cut concealment, capture integration, and pickup recording (FR-906, FR-311, FR-009, FR-010, FR-011).

### Priority C — Multi-format publishing workflow

- Automatic and manual short selection.
- Vertical subject tracking and responsive recomposition.
- Platform profiles and safe areas.
- Burned-in and sidecar subtitles.
- Derivative dependency tracking and batch export.
- Publish packaging: metadata drafting, chapters, thumbnails, and upload kits (FR-809 to FR-813).

### Priority D — Editorial leverage

- Reusable local editorial skills and preference examples.
- Take comparison and pacing assistance.
- B-roll provider adapters and generation provenance.
- Specialist video-critic integration.
- Advanced matting and additional interchange formats.
- Archival and media offlining, schema migration tooling, and evaluation of the Section 6.3 deferred capabilities.

These priorities describe dependency order, not permission to postpone the promised end-to-end product scope indefinitely. Product development should exercise each completed layer on real video work as early as practical.

## 25. Risks and required mitigations

### R-001 — AI editorial judgment is unreliable

**Mitigation:** Use explicit rubrics, show evidence and alternatives, learn from accepted examples, and retain creator approval for consequential decisions.

### R-002 — Project diffs become noisy

**Mitigation:** Use stable IDs, source-relative or semantic anchors, derived sequence positions, formatted canonical output, and sidecars for dense machine data.

### R-003 — Green-screen quality is insufficient

**Mitigation:** Combine capture guidance, traditional keying, spill suppression, masks, temporal quality checks, and an optional advanced matting path.

### R-004 — Vertical conversion hides important content

**Mitigation:** Recompose separate layers, track subjects and interface regions, apply safe-area constraints, produce shot-level previews, and allow manual correction.

### R-005 — Provider or model behavior changes

**Mitigation:** Use provider adapters, version skills and models, freeze generated assets, and keep the canonical edit independent of any one provider.

### R-006 — Local processing exceeds available hardware or storage

**Mitigation:** Detect capabilities, use proxies and caches, provide slower fallbacks, estimate storage, and make cache cleanup safe.

### R-007 — Reproducibility is weakened by hidden state

**Mitigation:** Record schemas, hashes, tool and preset versions, generation provenance, and semantic operations; do not rely on application memory or chat history as project state.

### R-008 — Initial scope becomes a full professional NLE

**Mitigation:** Prioritize the documented creator workflow and structured agent operations. Add general-purpose editing functions when they support real production requirements rather than pursuing feature parity for its own sake.

### R-009 — Data loss in a local-first product

A single disk failure, theft, or ransomware event could destroy unrepeatable source footage and every project's history, making the reproducibility guarantees of FR-107 hollow.

**Mitigation:** Verifiable backups (NFR-106), managed archival (NFR-107), cross-machine restore (NFR-108), integrity hashes, and clear separation of load-bearing state from disposable caches.

## 26. Technical-design constraints derived from the business requirements

The later technical design must preserve these constraints:

- The editing engine exposes structured operations usable by both the UI and frontier agents.
- The canonical format is documented, schema-versioned, human-readable, and stable under small edits.
- FFmpeg or an equivalent mature media engine handles routine local media operations.
- Whisper-class local transcription plus a word-alignment path supplies canonical word timing.
- Complex programmatic composition may use a framework such as Remotion, but framework-specific state is compiled from the canonical project rather than becoming the only source of truth.
- OpenTimelineIO or editor-specific formats may be export targets but are not canonical.
- External AI services are optional adapters with explicit data boundaries.
- Binary media storage, text project versioning, and disposable caches remain separate concerns.

The implementation plan may select concrete libraries and deployment architecture only after this business-requirements document is reviewed and approved.

## 27. Glossary

**Accepted revision:** The current creator-approved project state.  
**Agent:** The frontier model and its tool-using workflow.  
**Annotation:** Review feedback tied to a frame, range, word, object, or project element.  
**Canonical master:** The authoritative human-readable edit description.  
**Derivative:** A deliverable, such as a Short, based on the canonical source project but allowed its own editorial overrides.  
**Generated asset:** Media produced by a generative model and frozen as an ordinary project asset after acceptance.  
**Pickup:** A short corrective recording used to repair a misspoken word or phrase inside an otherwise good take.  
**Proxy:** Lower-cost media used for responsive preview while retaining the full-resolution source for final output.  
**Semantic diff:** A human-understandable description of project operations rather than a low-level serialization change.  
**Sidecar:** A referenced text or data file containing detailed information such as per-word timing.  
**Source time:** A position within original media.  
**Timeline time:** A position in an assembled sequence.  
**Upload kit:** The consolidated per-platform bundle of video variants, thumbnail, subtitles, chapters, and metadata produced for manual upload.  
**Word ID:** A stable identifier for a transcript word used to anchor captions, edits, graphics, and derivatives.
