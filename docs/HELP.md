# Contextual help texts

This file holds the texts shown by Guyditor's help mode: click the help-mode button in the title bar, then click a panel or section to read what it is good for and how to use it. It is bundled into the app like the manual and parsed by `packages/app/src/renderer/help/help-texts.ts`.

Format: one `## <key>` heading per entry (`panel.<id>`, `phase.<id>`, `chrome.<name>` or `section.<panel>.<slug>`), then `Title:`, `Where:` and an optional `Manual:` line (which must equal a `## ` heading of `MANUAL.md` exactly), then the two parts `### What it's good for` (a paragraph) and `### How to use it` (a numbered list of 2-5 steps). Plain words, every term defined, true to the code.

Martin reports unclear texts in chat; edit the entry and re-check the code.

## panel.media
Title: Media
Where: Media panel
Manual: 3. Ingest tab — get material in

### What it's good for
This is your library for the project: every video, audio file and image you have brought in, one row each. Everything you edit starts here. Guyditor only points at your files and never changes them, and each row shows badges for the background work being done on it (a proxy, which is a light copy of the clip that keeps scrubbing smooth while exports always use your originals, and a transcript, the written-out words of what is said).

### How to use it
1. Press Import files, or drop clips onto the "or drop media here" strip, to add footage. Typing a file's full path into the "Local path" field and pressing Add path does the same.
2. Watch the new row appear in the list; its badges change from "proxy running" to "proxy done" (and the same for the transcript) as the background work finishes.
3. Use the Kind menu to show only video, only audio and so on.
4. If a clip holds several attempts at the same line, open its "takes" row, tick two or more and press Compare to see how they differ side by side.
5. Filming into a folder instead? The Capture watcher section imports for you, so you can skip step 1.

## section.media.capture-watcher
Title: Capture watcher
Where: Media panel
Manual: 3. Ingest tab — get material in

### What it's good for
Imports new recordings by itself. You give it a folder, for example the one OBS saves into or the one where you copy your iPhone clips, and every file that lands there while this project is open is imported without you pressing Import files. It waits until the file has finished being written, groups it with the other clips from the same day, and starts the background jobs you ticked: a proxy (a light copy of the clip that keeps scrubbing smooth; exports always use your originals), a speech analysis that finds where you are talking, and a transcript (the words you said, written out). Your original files are never changed. If you import by hand, you do not need it.

### How to use it
1. Type the folder's full path into "Watch-folder path". Files already sitting in that folder are imported too, so point it at a folder of footage you want in this project.
2. Pick the naming: "Flat / per day" groups clips by the day they were recorded and suits most people; "Guyditor naming" is only for session folders named like 20260717-0930_ep12-hooks (a clip that does not fit is still imported).
3. Tick the background jobs you want (proxy, analysis and transcription are all ticked to start with) and press Add watcher.
4. Record or copy a clip into the folder. A few seconds after the file stops growing, it appears in the list of clips below with its proxy and transcript badges, and the folder shows in this section's list with "ingest on".
5. To stop watching a folder, press Remove next to it; clips already imported stay.
