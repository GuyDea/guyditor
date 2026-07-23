# Agent-authored template contract

FR-612 lets an attached director propose a new deterministic overlay template without
installing or publishing it. The creator must review the rendered result before the
template can enter a project, a frozen programmatic asset, or an export.

## Gateway loop

1. Call `template_author_submit` with `name`, `description`, `manifest`, and
   TypeScript `source`.
2. Read the returned validation `checks`. A failed submission is not persisted; fix
   the named check and submit again.
3. On success, use `template_author_status` with the returned `submissionId`.
   The template browser shows the draft as **Awaiting review**, with its sandbox
   probe frames and schema-derived parameter form.
4. The creator chooses **Approve & publish**, **Request changes**, or **Reject**.
   Rejection and change requests retain the creator's reason for the director.
5. After a change request, resubmit with `supersedes` set to the prior
   `tas_…` submission. The replacement keeps the template identity, increments the
   draft revision, and archives the prior draft as `superseded`.

Approval publishes `1.0.0` into the normal immutable template registry. Its canonical
`contentHash` is then pinned by `graphic.add`, `template.freeze`, and export exactly
like a built-in or imported template. Approval never mutates an existing published
version.

## Submission shape

```json
{
  "name": "Signal stat badge",
  "description": "An easing-driven score badge.",
  "manifest": {
    "kind": "motion",
    "duration": {
      "mode": "fixed",
      "default": { "frames": 60, "fps": "30/1" }
    },
    "params": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "additionalProperties": false,
      "required": ["value", "accent"],
      "properties": {
        "value": { "type": "number", "minimum": 0, "maximum": 100, "default": 72 },
        "accent": {
          "type": "string",
          "pattern": "^#[0-9A-Fa-f]{6}$",
          "default": "#4DD6A4"
        }
      }
    },
    "previewParams": { "value": 72, "accent": "#4DD6A4" },
    "assets": [],
    "safeAreaAware": true
  },
  "source": "import { primitivesV1 as motion } from \"@guyditor/render/primitives/v1\";\nexport default { render(ctx, params) { /* deterministic drawing */ } };"
}
```

`kind`, `previewParams`, and `safeAreaAware` are optional. `kind` defaults to
`motion`; preview parameters default to values derived from the parameter schema.
Fixed and parameter-driven durations require positive default frames and a rational
fps. The parameter schema is compiled in Ajv draft-2020-12 strict mode.

Source is capped at **65,536 UTF-8 bytes**. It must default-export an object with
`render(ctx, params)` and may optionally provide the existing deterministic
`duration(params, media)` function.

## Available surface

The only code import is:

```ts
import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";
```

The surface includes the versioned text reveals, easing/fixed-step springs,
shapes/masks/wipes, charts/counters, SVG path highlights, cutout placement, seeded
textures, and deterministic Lottie drawing documented by primitives/v1. Use
`ctx.rng` for variation. `Math.random`, `Date`, clocks, timers, network, process,
ambient modules, dynamic import, and direct `require` are unavailable.

Declared image, SVG, or Lottie assets use the existing FR-611 declaration:

```json
{
  "name": "mark",
  "kind": "svg",
  "file": "assets/mark.svg",
  "sha256": "64 lowercase hex characters",
  "license": {
    "origin": "licensed",
    "licenseName": "Example license",
    "licensor": "Example studio",
    "restrictions": []
  }
}
```

The SHA-256 must already identify a registered project asset; the authoring service
copies and re-verifies those bytes. Source may import its declared name only:

```ts
import mark from "asset:mark";

export default {
  render(ctx) {
    ctx.canvas.drawImage(ctx.staticAssets(mark), 20, 20, 120, 120);
  },
};
```

An undeclared `asset:…` import fails static validation and the sandbox's module
resolution boundary. Package-relative traversal, hash mismatches, unsupported
Lottie features, and missing assets fail closed.

## Validation checks

Every response contains all eight ordered checks:

1. `source_size`
2. `source_parse`
3. `imports`
4. `manifest`
5. `param_schema`
6. `sandbox_probe`
7. `determinism`
8. `performance`

If an earlier stage prevents a later stage, the later result carries
`E_TEMPLATE_CHECK_SKIPPED`. Each error has a stable `code`, a message, and an
optional schema path.

The render probe derives three parameter sets: defaults, lower schema boundaries,
and upper schema boundaries. It renders configurable frame samples spread across the
duration with two fixed seeds. Every sampled frame is rendered twice and the PNG
bytes must be identical. The probe records throughput and applies a configurable
frames-per-second floor; the default is a deliberately generous **1 fps** budget so
the measurement catches pathological templates without tuning templates to a
development machine.

Probe metrics stay in draft status and audit evidence. They are excluded from
published package hashing, so machine speed cannot change otherwise identical
published content.

## Review boundary

Draft packages live in the registry's hidden `.drafts` area. The template browser
may call the direct template preview painter, display the probe strip, and edit
preview parameters. All deliverable-bound paths treat a draft descriptor as
unreviewed:

- `graphic.add` and edits refuse it;
- `template.freeze` refuses it before frames or assets are materialized;
- the graphic overlay resolver refuses it before live deliverable or export painting.
- the generic template installer refuses hidden authoring packages and `-draft.N`
  versions, so copying a draft path cannot bypass review.

Each returns `E_TEMPLATE_UNREVIEWED` with `acceptedStateChanged: false`. These checks
are service boundaries, not UI affordances; disabling the browser's Place and Freeze
buttons is only an additional cue.

The audit log records `template.author.submitted` and `template.author.reviewed`
against the originating director session, including model label, template/submission
IDs, outcome, creator reason, and the published content hash.
