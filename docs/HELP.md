# Contextual help texts

This file holds the texts shown by Guyditor's help mode: in help mode, clicking a panel or section shows what it is good for and how to use it. It is bundled into the app like the manual and parsed by `packages/app/src/renderer/help/help-texts.ts`.

Format: one `## <key>` heading per entry (`panel.<id>`, `phase.<id>`, `chrome.<name>` or `section.<panel>.<slug>`), then `Title:`, `Where:` and an optional `Manual:` line (which must equal a `## ` heading of `MANUAL.md` exactly), then the two parts `### What it's good for` (a paragraph) and `### How to use it` (a numbered list of 2-5 steps). Plain words, every term defined, true to the code.

Martin reports unclear texts in chat; edit the entry and re-check the code.

## panel.media
Title: Media
Where: Media panel
Manual: 3. Ingest tab — get material in

### What it's good for
Your library for this project: every video, audio file and image you have brought in, one row each. Guyditor only points at your files and never changes them. Badges on a row show background work: a proxy (a light copy of the clip that keeps scrubbing smooth; exports always use your originals) and a transcript (what is said, written out).

### How to use it
1. Press Import files, or drop clips onto the "or drop media here" strip.
2. A new row appears; its proxy and transcript badges show up once each job is queued, then change to "done" (long clips take a while).
3. Use the Kind menu to show only video, only audio and so on.
4. Clips the Capture watcher imported can show a "takes" row; tick two or more and press Compare takes (panel header) for speaking speed, pauses, fillers and a recommended take.

## section.media.capture-watcher
Title: Capture watcher
Where: Media panel
Manual: 3. Ingest tab — get material in

### What it's good for
Imports new recordings by itself. Give it a folder, such as the one OBS saves into or where you copy your iPhone clips, and every file that lands there while this project is open is imported for you. It also queues the jobs you ticked: a proxy (a light copy that keeps scrubbing smooth; exports use your originals), speech analysis and a transcript. Originals are never changed. If you import by hand, skip it.

### How to use it
1. Type the folder's full path into "Watch-folder path". Files already in it are imported too.
2. "Guyditor naming" (preselected) groups clips by session folders like 20260717-0930_ep12-hooks, the rest by the day the file was saved; "Flat / per day" groups all by that day.
3. Tick the jobs you want and press Add watcher; the folder is listed with "ingest on".
4. Copy a clip into the folder; a few seconds after it stops growing it appears in the clip list below.
5. Remove stops watching a folder; clips already imported stay.
