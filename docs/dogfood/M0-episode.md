# M0 dogfood report — "Video Zero"

**Episode title:** Video Zero (M0 scaffold-era render, not a creator episode)
**Date:** 2026-07-18
**Milestone:** M0 — repo scaffold + core schema + OperationEngine skeleton

Per Part 0 §0.6, the M0 dogfood obligation is: *render a 10 s "video zero" from a
hand-written master file over fixture media through `RenderService`.* The result is a
12 s master (360 frames at 30/1) rendered entirely through shipped code paths.

## Source-footage inventory

Script-generated fixture media (`pnpm fixtures`, `.fixtures/manifest.json`):

| Asset | Content | Used range |
|---|---|---|
| `bars-1080p30-10s.mp4` | SMPTE HD bars, burned-in frame counter, 1 kHz tone | frames 0–120 and 150–240 |
| `screencast-1080p30-15s.mp4` | `testsrc2` motion content with a hard cut at frame 225 | frames 225–345 |

## Shipped features used

- Master file built programmatically via `@guyditor/core` (`ProjectStore.createProject`
  + commit), canonical YAML on disk, revision snapshot, lock file, transaction journal.
- `deriveTimeline` produced the expected timeline (three clips, one 30-frame
  `gapBefore` rendered as black + silence); output duration matches the derivation
  exactly at 30/1.
- `RenderService.renderExport` → render-graph IR → single FFmpeg invocation compiled by
  `@guyditor/media`, executed as a `render.export` job on the SQLite-backed `JobQueue`
  with parsed progress.
- Export report recorded revision, profile `youtube-longform@1.0.0`, source hashes,
  settings, and output SHA-256
  (`e201d3c745b2ce2582ca0bc525fb52973e09b23647d4836c3de41a2ee6376fb7`).
- Reproduce locally: `pnpm fixtures && node scripts/video-zero.mjs` (also wired into
  `pnpm gate:m0`).

## Manual workarounds needed

None for the M0 scope. Known scope limits (all tracked in `docs/traceability.md`
notes, unsupported paths fail with `E_RENDER_UNSUPPORTED` naming the owning part):
transitions, overlaps, multi-layer video, keying, transforms, captions/overlays,
proxies, freeze effects.

## §23 metrics snapshot

Not applicable at M0 — the §14.11 metrics instrumentation ships with the UI (M1+).
Recorded as deferred, not skipped silently.
