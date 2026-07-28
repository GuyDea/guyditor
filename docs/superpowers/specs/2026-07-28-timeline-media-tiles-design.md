# Timeline Media Tiles Design

- **Status:** Approved
- **Date:** 2026-07-28
- **Branch:** `fix/timeline-media-tiles`
- **Related:** `docs/steering/timeline-media-tiles.md`

## Purpose

Make timeline clips visually and aurally navigable. Video clips must show
representative source frames, and every audio-bearing clip must show its waveform
whether or not it is selected. For video with embedded audio, the waveform is
drawn over the video filmstrip so both timing signals remain in one compact tile.

## Current behavior

`TimelinePanel` renders a solid tile containing `clip.id` and the clip duration.
It calls `MediaEngine.readPeaks` only for the selected clip's asset and renders at
most 60 bars from the beginning of the last peaks tier. The result is not cropped
to the clip's source range, does not respond to zoom, and disappears when the clip
is not selected. No timeline code requests preview frames.

## Goals

- Render representative frames across every visible video clip's trimmed source
  range.
- Overlay a readable waveform on every visible clip whose asset has audio,
  including video assets with embedded audio.
- Make frame count and waveform detail respond deterministically to clip width and
  zoom.
- Preserve virtualized scrolling and all current clip interactions.
- Degrade safely while cache data is missing or source media is offline.
- Keep all new artifacts disposable and reflect their size in cache accounting.

## Non-goals

- Separate embedded camera audio into an independent editable track.
- Change project schemas, clip timing, audio mixing, gain, fades, ducking, preview
  playback, or render output.
- Add project thumbnails, media-browser thumbnails, archive preview generation, or
  a general-purpose image service.
- Persist derived frame or waveform state in project data.

## Approved visual treatment

The approved tile combines a multi-frame filmstrip with a waveform overlay:

- Clip height is 68 CSS pixels; the containing clip row expands to accommodate the
  tile without colliding with the ruler or markers.
- Frames fill the tile edge-to-edge using `object-fit: cover`, with no gutters
  between adjacent source moments.
- A low-opacity dark scrim covers the footage. The waveform uses a light blue line
  with a dark outline so it remains legible over changing luminance.
- Clip ID stays pinned to the top-left and duration to the top-right. Their
  backgrounds preserve text contrast.
- The selected clip retains the amber outline. Playhead, annotations, restyle
  boundaries, and jump-cut controls remain above decorative media.
- Audio-only clips use the existing neutral clip background beneath the waveform.
  Silent video clips omit the waveform. Clips with neither available preview
  frames nor peaks retain the existing neutral appearance.

Frame images and waveforms are decorative and `aria-hidden`. The clip button keeps
an accessible name containing its clip ID and duration. Media layers use
`pointer-events: none`, leaving click, keyboard, and drag handling on the existing
button.

## Architecture

### Media frame cache

Add a focused media module that owns timeline frame artifacts:

```text
.guyditor/cache/timeline-frames/
  <assetId>.<hash8>/
    <sourceFrame>.h96.jpg
```

The canonical cache key contains the asset ID, the first eight characters of the
source SHA-256, the non-negative native video frame, and the thumbnail height.
Files are written to a `.part` sibling and atomically renamed. Hash-keyed
directories make stale results unreachable after source replacement.

Timeline tiles request the 96-pixel height tier. The height remains part of the
contract so a later density tier can coexist without changing cache semantics.
Cache estimation gains a `timelineFrames` class and includes it in `totalBytes`.

For each missing frame, the resolver:

1. validates that the asset belongs to the open project and contains video;
2. resolves an existing edit proxy, otherwise the source path;
3. converts the native source frame to an exact seek time using the asset video
   frame rate;
4. invokes ffmpeg with argument arrays to select one video frame, scale it to
   96 pixels high while preserving aspect ratio, encode JPEG, and omit audio;
5. atomically publishes the result and returns its file URL.

Resolution uses a concurrency limit of two ffmpeg processes per open project.
Identical cache keys share one in-flight promise. Cache hits perform only a
non-empty-file check.

### Main-process API

Extend `MediaEngine` with:

```ts
interface ResolveTimelineFramesParams {
  assetId: string;
  sourceFrames: number[];
  height: 96;
}

interface TimelineFrameResolution {
  sourceFrame: number;
  url: string | null;
}
```

`resolveTimelineFrames` accepts at most 12 unique non-negative source frames and
returns results in request order. A missing or invalid asset rejects the request.
Decode, proxy, source, or individual output failures become `url: null` for the
affected frame, allowing other frames to render. URLs are produced only from
internally derived cache paths.

The existing `readPeaks` API remains unchanged. The renderer requests peaks once
per unique visible audio-bearing asset and retains the result by asset ID and
source hash for the mounted project revision.

### Renderer decomposition

Keep `TimelinePanel` responsible for sequence derivation, virtualization, edit
controls, and clip placement. Extract media-specific behavior into focused units:

- a pure helper for representative source-frame selection;
- a pure helper for peaks tier selection, clip-range slicing, and display-column
  aggregation;
- a clip-media component that renders filmstrip images, waveform SVG, scrim, and
  degraded placeholders;
- a loader hook that batches unique visible asset requests and ignores stale
  asynchronous results.

This separation makes sampling and degraded behavior testable without Electron or
ffmpeg and prevents `TimelinePanel` from accumulating cache mechanics.

## Representative-frame selection

The displayed clip width is already deterministic from derived duration and
`zoomPixelsPerFrame`. For an inner width `W`:

```text
frameCount = clamp(ceil(W / 96), 1, 12)
```

The source duration is `source.out.frames - source.in.frames`. Each representative
frame is the center of an equal source-time partition:

```text
source.in + floor((index + 0.5) * sourceDuration / frameCount)
```

Values are clamped to `source.out - 1`, duplicate frames are removed while
preserving order, and the remaining images divide the tile width evenly. This
keeps the first and last images away from cut boundaries, updates naturally with
trim and zoom changes, and bounds each clip request.

Only the existing virtualized `visibleClips` window requests frames. Wider zoom
levels may request additional representatives, but previously extracted frames
remain reusable when the deterministic sample positions coincide.

## Waveform projection

Waveforms use the existing three-tier `guyditor.peaks/v1` cache. For each visible
audio-bearing clip:

1. convert the trimmed source in/out frames to source seconds and then to peak
   sample indices at 48 kHz;
2. compute source samples per display pixel from the clip duration and inner
   width;
3. choose the smallest tier whose `samplesPerPeak` is no greater than four times
   the samples represented by one pixel, falling back to the finest tier when
   zoomed in;
4. crop min/max pairs to the clip source range;
5. aggregate them into at most one vertical min/max line per two CSS pixels.

The result is rendered as one non-interactive SVG per clip. Its `viewBox` matches
the computed display columns, allowing CSS to scale it with the tile without
creating one DOM element per audio bucket. Selection does not participate in
loading or rendering.

When peaks are absent, the component renders a low-contrast horizontal baseline
instead of hiding all audio indication. A later successful project refresh can
replace the baseline with peaks without changing clip geometry.

## Asynchronous state and degraded behavior

Frame and peaks requests are keyed by project revision, sequence, asset source
hash, source range, representative frames, and thumbnail tier as applicable.
Effects mark themselves stale during cleanup. Late results from a prior
deliverable, trim, zoom, or revision cannot overwrite the current tile.

Individual frame failures leave that partition transparent so the neutral clip
background shows through. A failed batch request degrades all requested frames for
that clip without affecting selection or editing. Missing peaks render the flat
baseline. Neither condition produces a blocking notice during ordinary scrolling.

The renderer retains successful results for the mounted project and reuses them
across clips referencing the same asset and frame. The main process remains the
authority for filesystem cache reuse and extraction single-flight behavior.

## Performance constraints

- Maximum 12 frame requests per visible clip.
- Maximum two concurrent ffmpeg frame extractions per open project.
- No frame work for audio-only or non-visible clips.
- No peaks request for assets without audio.
- One SVG waveform per visible audio-bearing clip, with no more than one display
  column per two CSS pixels.
- Timeline interaction and scrolling do not await media promises.
- Cache hits avoid ffmpeg and source-media reads.

## Testing

### Media unit tests

- Cache paths change with asset hash, source frame, and height.
- Valid cache hits skip extraction.
- Missing frames compile the expected seek, video mapping, scale, JPEG, and
  no-audio arguments.
- Writes publish atomically and never expose `.part` files.
- Duplicate in-flight requests invoke extraction once.
- The concurrency limiter never runs more than two extractions.
- Missing proxy fallback and individual extraction failures return the documented
  degraded result.
- Cache estimation includes timeline-frame bytes.

### Renderer unit tests

- Representative sampling handles narrow, wide, short, trimmed, and duplicate
  source ranges.
- Peaks tier selection changes with zoom and follows the fixed selection rule.
- Waveform projection excludes audio before/after the clip and aggregates within
  the display-column bound.
- Audio-only, silent-video, embedded-audio, missing-frame, and missing-peaks states
  render the approved layers.
- Every applicable visible clip renders its waveform independently of selection.
- Stale asynchronous results are ignored after revision, deliverable, trim, or
  zoom changes.

### Integration regression

A renderer integration fixture will provide deterministic frame URLs and peaks for
multiple clips. It will assert that filmstrip images and waveform SVGs coexist,
that an unselected audio-bearing clip still has a waveform, and that clip
selection/edit controls keep their existing behavior. Existing Electron tests for
trim, split, reorder, annotations, and active deliverables remain required green
coverage.

## Acceptance criteria

- Every visible video clip with available media shows representative frames from
  its own trimmed source range.
- Every visible audio-bearing clip shows either its range-correct waveform or the
  degraded flat baseline, regardless of selection.
- Embedded audio is overlaid on the video filmstrip in the approved hybrid style.
- Trimming or zooming recomputes frame and waveform coverage without stale results.
- Missing proxies, offline sources, or absent peaks never block clip interaction.
- Cache accounting reports timeline-frame storage.
- Relevant unit, renderer, Electron, type, lint, and convention checks pass.
