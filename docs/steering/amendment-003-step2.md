# Amendment 003 Step 2 — Deterministic Lottie Import

Status: implemented under the task's standing ruling (no separate design pause)

## Renderer decision

Guyditor uses the in-house `guyditor-lottie-subset/v1` interpreter instead of
`lottie-web`. The browser renderer depends on DOM renderer state and an animation
lifecycle designed around timers/RAF. Even when seeking with explicit frames, its
full feature surface would make the import gate and determinism proof depend on
renderer internals outside Guyditor's closed canvas contract.

The subset interpreter evaluates only the requested frame, paints synchronously onto
`@napi-rs/canvas`, and has no clock, RAF, DOM, or network surface. The
`lottie-canvas-shim/v1` version and its SHA-256 toolchain fingerprint enter graphic
overlay keys, template-freeze keys, and export toolchain hashes. The exact Lottie
file hash and computed feature profile are retained with the registered template
asset.

## Accepted feature profile

- Shape and precomposition layers, plus hash-registered raster image layers.
- Rectangle, ellipse, and cubic Bezier paths.
- Layer and group anchor, position, scale, rotation, and opacity transforms.
- Static properties and explicitly sampled temporal keyframes, including temporal
  cubic-Bezier easing and hold keyframes.
- Solid fills, solid strokes, line caps/joins, and simultaneous trim paths on
  stroked geometry.
- Additive/union and intersect path masks with full opacity.
- Package-relative raster references only when the referenced image is separately
  declared with its own SHA-256 and license metadata.
- Fill/stroke `nm` values as color-slot names; a template may map those names to
  resolved brand palette parameters.

## Rejected feature profile

The import gate reports every occurrence as `<feature> at <layer path>` and rejects
the whole file. It rejects expressions; text layers, font tables, and embedded
glyphs; embedded, unregistered, or network raster assets; solid, null, audio, camera,
and unknown layer types; 3D, skew, separated-dimension, parented, or collapsed
transforms; track mattes; layer effects/styles and non-normal blends; time remapping
and stretching; spatial/roving keyframes and changing Bezier-path topology; missing
or recursive precompositions;
stars/polygons, gradients, merge paths, repeaters, rounded-corner modifiers,
pucker/bloat, zig-zag, twist, and offset-path modifiers; dashed strokes; reversed
shape directions; individual trim mode and trimmed fills; and non-add/intersect,
inverted, feathered, expanded, or translucent masks.

## Shared painter boundary

Template preview, live graphic overlays, clean/burn-in export overlays, and
`template.freeze` all call `renderTemplatePng`. Lottie assets are re-hashed and
re-analyzed immediately before runtime decode. The `lottie-card` starter exercises
precompositions, masks, keyframes, fills, strokes, trim paths, and named brand color
slots without introducing text or network features.
