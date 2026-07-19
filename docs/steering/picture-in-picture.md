# Picture-in-picture steering decision

Date: 2026-07-19  
Status: accepted by the task's binding implementation specification

## Decision

The canonical `PipConfig`, semantic keyframes, placement constraints, preset references, and marked avoid regions remain sparse project-model data in `@guyditor/core`. Core owns their JSON Schema and the operation catalog, but not layout math.

`@guyditor/compositor` owns the deterministic constraint parser/solver, drag round-trip, motion-preset registry and curve sampling, semantic PiP timeline compilation, overlap diagnostics, and collision proposal planning. This follows Part 0 §0.3 and keeps the same pure functions available to preview and final render.

`@guyditor/render` consumes compiled compositor states. It lowers keyframed transforms to FFmpeg `n` expressions and lowers PiP style through deterministic mask/chrome assets plus alpha/overlay filter stages. No solved rectangles or sampled curves are written back to the master file.

`@guyditor/app` sends the same semantic `OperationInput` values for pointer drags that an agent sends. It may hold a transient drag rectangle or collision preview in Zustand, but accepted truth is refreshed from the project mirror after `OperationEngine` commits.

## Consequences

- Master-file changes contain constraints, semantic anchors, preset IDs, preset versions through pins, and optional preset parameters only.
- Output-size changes re-run the solver; frame-by-frame coordinate dumps are derived render data only.
- Collision results are explicit proposal operations with visible overlap evidence. M2 sources are captions, marked regions, and safe areas; tracking source types stay in the schema as M3 hooks and are reported as unavailable rather than silently ignored.
- Responsive override types remain schema-compatible because `PipConfig` references `ResponsivePlacement`, but authoring and per-aspect override behavior remain outside this task.

