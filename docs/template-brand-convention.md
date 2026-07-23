# Template brand defaults

A pinned `brand_visual` skill may contain exactly one fenced JSON block:

````markdown
```guyditor-template-brand/v1
{
  "schema": "guyditor-template-brand/v1",
  "palette": { "accent": "#77E7C4", "background": "#102A43" },
  "fonts": { "fontFamily": "Inconsolata Guyditor" },
  "logoSlots": { "logoSlot": "brand" },
  "params": { "accent": "#66CCAA" },
  "templates": {
    "tpl_e2f3g4h5j6": { "background": "#091A2A" }
  }
}
```
````

`palette`, `fonts`, and `logoSlots` document the named visual resources exposed to
template painters through `ctx.brand`. A resource whose key exactly matches a
template property also becomes that parameter's brand default; unmatched resource
keys remain context-only and are not added as undeclared parameters. Use `params`
(global) or `templates.<tpl_id>` (template-specific) when the resource slot and
parameter names differ. A font value must name a font declared and hash-verified by
that template package; a logo-slot value names a slot, never an unverified
filesystem path.

Before schema validation and painting, parameter values resolve in this order:

1. explicit instance parameter;
2. template-specific `brand_visual` parameter;
3. global `brand_visual` parameter, then matching palette/font/logo resource key;
4. template JSON-Schema `default`.

The same resolver runs for catalog previews, live template frames, placed overlays,
and frozen template clips. Malformed blocks, undeclared fonts/assets, hash
mismatches, and resolved values that violate the template parameter schema fail
closed.
