# Steering Decision: Cached timeline frames with overlaid waveforms

- **Status:** Accepted
- **Date:** 2026-07-28
- **Owners:** Guyditor
- **Related:** `docs/superpowers/specs/2026-07-28-timeline-media-tiles-design.md`

## Context

The timeline currently renders each clip as a solid-color button containing only
its clip ID and duration. It requests waveform peaks only for the selected clip
and renders the beginning of the coarsest peaks tier without accounting for the
clip source range or zoom. Consequently, the timeline cannot be scanned by image
content and does not satisfy FR-906 or the manual's promise of waveforms on every
audio-bearing clip.

## Constraints

- Frame and peak previews are derived, disposable cache data and must not enter the
  project model, journal, revisions, or backup-critical state.
- The existing virtualized timeline, edit operations, selection, drag behavior,
  playhead, annotations, and jump-cut controls must remain responsive.
- Waveforms must cover every visible audio-bearing clip, including video assets
  with embedded audio, rather than depending on selection.
- Frame extraction must tolerate missing proxies, offline media, and individual
  decode failures without blocking or disabling the clip.
- Renderer code cannot receive arbitrary filesystem paths from untrusted input.

## Decision

Generate representative JPEG frames lazily in the main process and cache them
under `.guyditor/cache/timeline-frames/`, keyed by asset identity, source hash,
source frame, and thumbnail height. A bounded, single-flight resolver will prefer
the edit proxy and fall back to source media. A batched `MediaEngine` IPC method
will return file URLs only for validated assets and cache-owned output paths.

The renderer will sample frames evenly across each visible clip's trimmed source
range and overlay a clip-range- and zoom-aware SVG waveform over the resulting
filmstrip. Audio-only clips will show the waveform over the neutral clip
background; silent video clips will show only their frames. Missing frames retain
the neutral background, and missing peaks render a flat baseline.

## Alternatives

Hidden proxy `<video>` elements painted into renderer canvases were rejected
because many simultaneous seeks and decoders would make scrolling and zooming
fragile. Ingest-time sprite sheets were rejected because they add work for media
that may never enter a timeline and provide imprecise coverage after trim and zoom
changes. A single poster frame was rejected because it does not expose visual
changes within longer clips.

## Consequences

Visible clips become recognizable by image and audio content without expanding
embedded audio into a separate track. The first view of uncached frames can fill
in asynchronously, and the new cache consumes additional disposable disk space.
The project cache estimate will account for timeline frames so this cost remains
visible.

## Boundaries / Interfaces

- `packages/media` owns frame cache paths, extraction, validation, concurrency,
  and cache-size accounting.
- The main-process `MediaEngine` surface owns batched frame resolution and
  conversion of cache paths to file URLs.
- Renderer helpers own representative-frame selection and peaks projection.
- `TimelinePanel` owns visible-clip orchestration and visual stacking only.
- Existing project schemas, timeline operations, `readPeaks`, proxy generation,
  and preview playback contracts remain unchanged.

## Data / Migrations

No schema, project-data, journal, or migration changes are required. Cache entries
are hash-keyed and can be deleted or regenerated safely.

## Security / Scale

Requests are limited to an existing project asset, unique non-negative source
frames, an allowed thumbnail height, and a small per-request frame count. Output
paths are derived internally beneath the project cache. Extraction uses argument
arrays rather than shell interpolation, runs with bounded concurrency, and
deduplicates identical in-flight work.

## Verification / Rollout

Unit tests will cover deterministic frame selection, cache paths and reuse,
validated extraction commands, bounded failure behavior, peaks tier selection,
source-range cropping, and waveform aggregation. Renderer coverage will verify
that frames and waveforms coexist on every applicable visible clip, including
degraded placeholders. Existing timeline interaction tests will protect
selection, trim, split, reorder, annotations, and active-deliverable behavior.
