---
status: accepted        # accepted 2026-07-23 by the project owner (conversation)
implemented: 2026-07-23
affects: ["Part 7 §7.2–7.6 (templates)", "Part 9 §9.2 (gateway tools)", "Part 12 §12.3 (overlay renderer)", "BRD §13 (FR-600..602)"]
brd_ids: [FR-600, FR-602, FR-700, BR-007]
author: Claude Fable 5 (coordinator), from creator requirements 2026-07-23
date: 2026-07-23
---

# Amendment 003 — Motion design system: primitives, brand assets, agent-authored templates

## Problem

The creator requires the ability to produce **any visual** — editorial motion-graphics
in the style of Vox explainers (kinetic typography, animated charts/maps, photo-cutout
collage, textured backgrounds, word-anchored highlight marks) and beyond — without
being limited to a fixed built-in template set. Generative video (Kling/B-roll
adapters) covers footage but is the wrong tool for typography- and data-precise
graphics (FR-602). The template runtime is deterministic and sandboxed but currently
ships only four starter templates and no on-demand authoring path.

## Proposed change

### FR-610 — Motion primitives library

A versioned primitives layer inside the template runtime: text animation (per-word/
per-character reveals, tied to canonical word timing where anchored), easing/spring
system, shape/mask/wipe primitives, chart primitives (bar/line/counter/pie with exact
data params), map/geo primitives, image cutout placement (keyed stills via the
existing chroma/matte path) with shadows/borders, texture fills. Primitives are code
API surface for templates — versioned with the runtime, deterministic, covered by
pixel-exact goldens.

### FR-611 — Brand asset import for templates

Template packages and the project may register **SVG vector assets**, **licensed font
files**, and **Lottie/bodymovin animations** as hashed template assets. Lottie
playback MUST be deterministic (bundled renderer version pinned and hashed; no
network features; unsupported Lottie features rejected at import with a named list,
never silently dropped). The `brand_visual` skill supplies default colors/fonts/logo
slots to every template (FR-700 linkage).

### FR-612 — Agent-authored templates

The director may author NEW template packages on demand through a gateway flow:
(1) agent submits template source + manifest; (2) the sandbox validates determinism
(seeded RNG only, no clock/network/module escape — existing runtime rules) and
renders preview frames; (3) the creator reviews previews and accepts; (4) acceptance
publishes an immutable versioned template pinned like any other (FR-705 mechanics).
Unreviewed agent templates are never renderable into deliverables. Authored templates
may use only primitives + declared assets; the §7.3 sandbox is the enforcement
boundary (code review by the creator is optional, not assumed).

### Spec changes

- Part 7 §7.2: asset kinds extended (svg, font, lottie) with hash + license fields;
  §7.3: primitives API + Lottie determinism rules; new §7.14: agent authoring flow.
- Part 9 §9.2: gateway tools `template_author_submit`, `template_author_status`.
- Part 12 §12.3: overlay renderer gains the primitives/Lottie surface; font/renderer
  hashes already enter the toolchain manifest.

## Migration

None — additive. Existing templates keep working; primitives are a new import
surface.

## Alternatives considered

- Curated library only — rejected: cannot deliver "any visual we want"; every new
  style becomes a coordinator task instead of a conversation.
- Generative-video graphics — rejected: FR-602 text ban stands; precision/data
  visuals need determinism.
- External motion tools (After Effects handoff) — rejected as primary path (breaks
  agent-native workflow); Lottie import covers the asset-reuse case.

## Implementation timing

Immediately (campaign `impl/visuals-003`), sliced: (1) primitives + brand assets
(SVG/fonts), (2) Lottie import with determinism gate, (3) agent authoring flow +
Vox-style starter pack exercising all primitives, (4) e2e + goldens + gate wiring.
