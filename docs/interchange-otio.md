# OpenTimelineIO interchange

Guyditor exports a one-way, derived OpenTimelineIO 0.17.x `.otio` JSON file from
the Publish panel. Choose relative media paths for a portable project tree or
absolute paths for interchange on the current machine, review the reported
losses, and then export. Review annotations are private by default and appear as
red markers only when explicitly enabled.

## Round-trip-safe subset

The following information has a direct OTIO representation and is preserved by
the export:

- the selected deliverable name and zero global start;
- bottom-to-top video track order and audio tracks;
- clips, media references, and exact source ranges expressed as native integer
  frames plus rational frame-rate metadata;
- explicit gaps and exact-frame crossfades;
- custom transition identity and parameters in `metadata.guyditor`;
- linear speed changes and freezes;
- named beats and markers resolved to timeline frames; and
- canonical fragments in opaque `metadata.guyditor` for forensic inspection.

"Round-trip-safe" here means a conforming external OTIO reader can retain this
subset when reading and rewriting the file. It does not make OTIO canonical
Guyditor state. Every file is stamped `metadata.guyditor.canonical = false`.

## Declared losses

Every preview and export returns a structured `losses` list. Review annotation
lifecycle is flattened to optional markers. Agent provenance, transactions,
proposals, and skill/preset versions are opaque metadata only. Responsive
layouts collapse to the selected deliverable. Semantic anchors resolve to
absolute frames. Chroma keys, neural mattes, masks, transforms, looks, PiP
presets, keyframes, and non-linear retimes are not executable in other editors.
Captions and per-word timing are not OTIO tracks; publish burned-in video or the
SRT/VTT sidecars alongside the interchange file.

These losses are why external edits cannot replace `guyditor/v1`. Importing an
externally modified `.otio` is explicitly out of scope for v1 in §12.10; this
implementation therefore exports only.
