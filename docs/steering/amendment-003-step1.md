# Amendment 003 Step 1 Steering Decision

Status: accepted by the task's standing ruling (no separate design pause)

## Decision

Extend the existing `overlay/v1` template boundary instead of adding a second motion
renderer. Templates may import only `@guyditor/render/primitives/v1`; the VM resolves
that exact module to a frozen deterministic API and rejects all other runtime imports.
The primitives version is part of graphic cache keys and the overlay toolchain
manifest.

Template manifests declare font and SVG assets with exact SHA-256 and rights metadata.
The registry validates declared paths, hashes, types, and licenses; the runtime repeats
the hash check immediately before registering a font or decoding an SVG. Project
template libraries use the existing project-over-user-over-built-in registry
precedence.

Pinned `brand_visual` content uses the documented
`guyditor-template-brand/v1` JSON convention. Parameter resolution happens before
painting in this order: explicit instance parameter, template-specific brand default,
global brand default, JSON-Schema default. Palette, font-slot, and logo-slot resources
travel in the render brand context and therefore resolve identically for previews,
overlays, and frozen clips.

`RenderService.templateFreeze()` paints a template directly at the selected
deliverable profile's exact resolution and frame rate, encodes deterministic H.264,
and constructs a `generated` asset with programmatic rights plus a hashed provenance
sidecar. It commits the prepared payload through the normal-risk `template.freeze`
semantic operation. With `placeAsClip`, that operation also inserts the frozen asset
into the sequence-bound video layer, allowing it to establish the first duration in
an empty project.

## Error boundaries

- Undeclared imports remain `E_TEMPLATE_SANDBOX`.
- Declared font/SVG byte mismatches fail as `E_TEMPLATE_ASSET_HASH`.
- Missing or invalid asset rights fail package validation.
- Invalid resolved brand parameters fail the existing
  `E_TEMPLATE_PARAMS_INVALID` boundary.
- Freeze never mutates the project until the encoded bytes, media hash, and
  provenance sidecar are complete.

## Verification

Use red/green focused Vitest coverage for the primitives API, word timing, asset
hashes, brand resolution, and empty-project freeze flow. Regenerate exact PNG golden
hashes for every built-in template and then run the complete command matrix from the
task.
