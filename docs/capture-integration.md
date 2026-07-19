# Capture integration contract

Guyditor v1 watches folders written by external recorders. It does not record A-roll in the app. This contract works with OBS and camera-card copies without a plugin or capture script.

## Recommended OBS settings

- Record MKV so an interrupted recording remains recoverable. Guyditor ingests MKV directly and does not rewrite originals.
- Use NVENC, AMF, or VideoToolbox at CQP 16–20, or x264 at CRF 16–18.
- Capture the source's native resolution and frame rate, with a 2 s keyframe interval and BT.709 color.
- Capture 48 kHz audio. Prefer separate tracks: Track 1 program mix, Track 2 microphone, and Track 3 desktop. Use PCM when disk permits, otherwise AAC 320k.
- Set OBS Filename Formatting to `%CCYY%MM%DD-%hh%mm%ss` for a useful capture timestamp. For full take parsing, rename or remux-free move the finished file to the convention below.
- Point the OBS recording path at a configured Guyditor watch folder. Hidden files and files ending in `.part` or `.tmp` are always ignored.

Camera cards can use the same contract: copy the card contents into a session directory below a watch folder. Verified offload tooling is not part of v1.

## Session and file names

With the `guyditor` convention, use a session directory named:

```text
<YYYYMMDD>-<HHMM>_<session-slug>/
20260717-0930_ep12-hooks/
```

Media within it uses:

```text
<role>[-<label>]_t<NN>[_<PP>].<ext>
```

`role` is `cam`, `screen`, `mic`, or `aux`; `NN` is a two-digit take; and optional `PP` is a split-recording part. Examples:

```text
cam-a_t03.mkv
mic-lav_t03.wav
screen_t03_01.mkv
```

The watcher creates a stable `ses_` capture-session ID, records it on every ingested asset, and seeds a full-asset `tak_` record. A plain or unmatched filename still ingests: it receives a per-day `unsorted` session and emits the non-blocking `E_CAPTURE_CONVENTION_UNMATCHED` warning. With the `flat` convention, all media is grouped per day without name parsing.

## Take marker intake

Put `markers.json`, `<mediafile>.markers.json`, or `notes.txt` beside session media. A media-specific JSON file applies only to that named media; the generic files apply to every asset in the session.

JSON intake is deliberately different from the persisted exact-time sidecar:

```json
{
  "format": "guyditor.take-markers-intake/v1",
  "session": "ep12-hooks",
  "clock": "recording",
  "markers": [
    { "at": 12.4, "type": "take-start", "take": 3 },
    { "at": 95.1, "type": "mistake", "note": "said 2019, meant 2016" },
    { "at": 141, "type": "take-end", "take": 3, "quality": "good" }
  ]
}
```

`clock` is either `recording` (floating-point seconds from media start) or `utc` (ISO 8601 timestamps matched against capture time). Marker `type` is one of `take-start`, `take-end`, `good`, `bad`, `mistake`, `note`, or `chapter`; `quality` is `good`, `bad`, or `flubbed`.

Text notes contain one event per line:

```text
00:00:12.400 TAKE 3 opening
00:01:35.200 FLUB said 2019, meant 2016
00:02:21.000 GOOD
```

Flags are `TAKE <n>`, `GOOD`, `BAD`, `FLUB`, `NOTE`, and `MARK`. Intake timestamps are converted once to integer source frames, with exact rational conversion and ties toward the earlier frame. Guyditor stores the result at `sidecars/takes/<astId>.takes.json` as `guyditor.take-markers/v1` and hash-registers it in the project. Reconciliation is idempotent: already represented intake markers are not duplicated.

After transcription, the default spoken-marker phrases are `marker`, `cut that`, `again`, `take <number>`, and `that was good`/`that was bad`. Candidates are word-anchored, marked `detected: true`, and only add dismissible metadata; they never trigger an edit. The phrase set is a direct runtime parameter until M4 editorial-skill integration.

## Watch-folder behavior

The runtime uses exactly pinned `chokidar@4.0.3` with `awaitWriteFinish.stabilityThreshold = 2000` ms and `pollInterval = 500` ms. After the add event, it independently confirms that file size remains unchanged for another 3000 ms.

At startup or manual reconciliation, the watcher scans configured folders and queues unregistered files. Media hashing provides final deduplication after a crash. Each stable media file queues `ingest`, then configured proxy, peaks, speech analysis, and transcription jobs. Dependencies and progress are visible in the global/status job overview. Completion emits a re-queryable `watcher.ingested` event containing the new asset IDs.

The project stores configuration as:

```ts
interface WatchFolderConfig {
  path: string;
  convention: "guyditor" | "flat";
  ignore?: string[];
  autoIngest: boolean;
  autoJobs: { proxy: boolean; analysis: boolean; transcription: boolean };
}
```

Defaults are auto-ingest with all three job groups enabled. Custom ignore entries are globs relative to the watched root. Originals remain immutable; watcher ingest never deletes, remuxes, or overwrites capture files.

## Pickup recordings

The Pickup Repair panel supports importing a corrective recording into `media/pickups/`. Record roughly 1 s of room tone before and after the corrected phrase. Imported files are copied as immutable originals, ingested with `via: pickup`, transcribed, force-aligned, and can then produce a review proposal. In-app recording is outside this task. Synthetic-voice correction is intentionally absent pending a future consent-gated provider adapter.
