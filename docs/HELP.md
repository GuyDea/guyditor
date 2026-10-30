# Contextual help texts

This file holds the texts shown by Guyditor's help mode: in help mode, clicking a panel or section shows what it is good for and how to use it. It is bundled into the app like the manual and parsed by `packages/app/src/renderer/help/help-texts.ts`.

Format: one `## <key>` heading per entry (`panel.<id>`, `phase.<id>`, `chrome.<name>` or `section.<panel>.<slug>`), then `Title:`, `Where:` and an optional `Manual:` line (which must equal a `## ` heading of `MANUAL.md` exactly), then the two parts `### What it's good for` (a paragraph) and `### How to use it` (a numbered list of 2-5 steps). Plain words, every term defined, true to the code.

Martin reports unclear texts in chat; edit the entry and re-check the code.

## phase.ingest
Title: Ingest tab
Where: Phase tabs, top of the window
Manual: 3. Ingest tab — get material in

### What it's good for
The first stage: get your iPhone and OBS clips into the project and let Guyditor prepare them. Each tab is a saved arrangement of panels, nothing more; this one shows Media (import and browse clips), Deliverables & jobs (the Status panel, where the import work runs), Storage (disk space and backups) and Assemble (an AI first rough cut from your takes).

### How to use it
1. Click the tab, or press `Ctrl+Alt+1`.
2. Import clips in the Media panel; each gets background jobs for a proxy (a light copy for smooth scrubbing), a waveform (a picture of the sound) and a transcript.
3. The number on the tab counts those jobs still running or queued; click it to jump to the Status panel. It disappears when all are done.
4. Panels you move or close stay that way in this tab for this project; **Reset layout** in the title bar brings the default back.

## phase.cut
Title: Cut tab
Where: Phase tabs, top of the window
Manual: 4. Cut tab — shape the story

### What it's good for
Shape the story: decide what stays, what goes and in what order. It shows Preview (the picture), Transcript (edit by the words you said), Timeline, and Agent (titled Proposals: suggested edits you accept or reject), which shares the top-right spot with Assemble as tabs.

### How to use it
1. Click the tab, or press `Ctrl+Alt+2`. New projects open here.
2. In the Transcript, select the words you don't want and press **Remove range**. On the Timeline, select a clip to **Split** it at the playhead, **Trim** it or **Remove** it.
3. The number on the tab counts proposals to remove fillers or pauses that wait for you; click it to jump to the first one.
4. Any other panel can still be opened here from the tool rail on the left.

## phase.polish
Title: Polish tab
Where: Phase tabs, top of the window
Manual: 5. Polish tab — the look and sound

### What it's good for
Make the video look and sound finished: captions, titles, colour and audio. Captions are styled with the Caption track controls in the Transcript panel. It shows Graphics (titles, lower thirds and other templates), Preview, Transcript, Agent (Proposals) and Inspector (the settings of whatever clip or item you selected).

### How to use it
1. Click the tab, or press `Ctrl+Alt+3`.
2. Select a clip or graphic and adjust it in the Inspector.
3. Add titles from Graphics and check them and the captions in Preview (it may play the light proxy copies, so judge sharpness in the export).
4. If the video already looks and sounds the way you want, skip this tab; it never shows a number.

## phase.review
Title: Review tab
Where: Phase tabs, top of the window
Manual: 6. Review tab — the feedback loop

### What it's good for
Watch the cut critically and settle every open change. It shows Media (to compare alternative takes), Preview (pause and draw notes on the frame) and Agent (titled Proposals: every suggested change with its reason, waiting for your yes or no).

### How to use it
1. Click the tab, or press `Ctrl+Alt+4`.
2. Pause Preview and draw or type a note on the frame.
3. In Proposals, **Accept** or **Reject** each change, or type what to change and press **Supersede** to ask for a new version; rejecting leaves the project exactly as it was.
4. The number on the tab counts proposals waiting for review (notes you draw don't add to it); click it to jump to the first one.

## phase.publish
Title: Publish tab
Where: Phase tabs, top of the window
Manual: 7. Publish tab — get it out

### What it's good for
Get the finished video out: exports, shorts, chapters, titles and descriptions, thumbnails and upload kits. It shows Publish (packaging per platform) and Deliverables & jobs (the Status panel: your main video and each short, with their approval state and export jobs).

### How to use it
1. Click the tab, or press `Ctrl+Alt+5`.
2. In Deliverables & jobs, find the video (the main one or a short), press **Send review**, then **Approve**; only approved videos export.
3. In Publish, press **Export output set**, then **Build upload kit** (one folder per platform, ready to upload by hand).
4. The number on the tab counts failed exports and cost confirmations waiting; click it to open the Status panel.

## chrome.tool-rail
Title: Tool rail
Where: Left edge of the window
Manual: 2. The workspace

### What it's good for
The complete list of panels, grouped by the stage you use them in (Ingest, Cut, Polish, Review, Publish) plus System (Help, Storage, Inspector). From here you can open any panel in any tab, even one the current tab's layout leaves out, such as B-roll.

### How to use it
1. Hover the rail, or press **Tools ›** at its top, to see the names beside the letters.
2. Click an entry to open that panel in this tab; click again to collapse it. A panel that isn't in this tab opens in its usual spot.
3. The dot on the right: amber = open in this tab, blue = only in another tab, empty ring = not open here.
4. An amber dot on the letter means something waits there, such as clips still importing for Media; hover to see how many.

## chrome.global-progress
Title: Project activity
Where: Title bar, top right
Manual: 2. The workspace

### What it's good for
One bar for everything Guyditor does in the background (importing, proxies, transcripts, exports), plus a count of decisions waiting on you. Click it to see exactly what the project is waiting on and why.

### How to use it
1. The line under "Project activity" shows how many jobs are active, "waiting on you" or "idle" (nothing to do). Click it to open the list.
2. **Running**: jobs in progress, with Cancel; "ETA pending" means no time estimate yet.
3. **Needs attention**: failed jobs; **Retry chain** reruns one together with the failed jobs linked to it.
4. **Queued / blocked**: jobs waiting for a free slot or for another job, like a transcript waiting for its import ("Blocked on").
5. **Waiting on you**: proposals to review (**Review proposal** jumps to one) and cost confirmations (answer those where you started them). **External providers**: paid online calls in progress, with time and spend.

## panel.media
Title: Media
Where: Media panel
Manual: 3. Ingest tab — get material in

### What it's good for
Your library for this project: every video, audio file and image you have brought in, one row each. Guyditor only points at your files and never changes them. Badges on a row show background work: a proxy (a light copy of the clip that keeps scrubbing smooth; exports always use your originals) and a transcript (what is said, written out).

### How to use it
1. Press **Import files**, or drop clips onto the "or drop media here" strip.
2. A new row appears; its proxy and transcript badges show up once each job is queued, then change to "done" (long clips take a while).
3. Use the Kind menu to show only video, only audio and so on.
4. Clips the Capture watcher imported can show a "takes" row; tick two or more takes and press the Compare button in the panel header for speaking speed, pauses, fillers and a recommended take.

## section.media.capture-watcher
Title: Capture watcher
Where: Media panel
Manual: 3. Ingest tab — get material in

### What it's good for
Imports new recordings by itself: every file that lands in a folder you name (where OBS saves, or where you copy iPhone clips) while this project is open comes in, with the jobs you ticked: a proxy (a light copy for smooth scrubbing; exports use your originals), speech analysis (finding where someone talks) and a transcript. Originals are never changed. If you import by hand, skip it.

### How to use it
1. Type the folder's full path in "Watch-folder path"; files already there come in too.
2. "Guyditor naming" (preselected) groups clips by session folders like 20260717-0930_ep12-hooks, others by day; "Flat / per day" groups all by day.
3. Tick the jobs you want and press **Add watcher**; the folder is listed with "ingest on".
4. Copy a clip in; a few seconds after it stops growing it appears in the list below.
5. **Remove** stops watching that folder; clips already imported stay.

## section.media.pickup-repair
Title: Pickup repair
Where: Media panel
Manual: 4. Cut tab — shape the story

### What it's good for
Fixes a fluffed line without reshooting. A pickup is a short re-recording of just the wrong words (say, a misspoken price); Guyditor matches it word by word and proposes adding it at that spot. If a cut or another take fixes the line, skip this.

### How to use it
1. Enter the clip's ID (under its name) and the first and last wrong word IDs (hover a word in the Transcript, e.g. w000123); they show highlighted.
2. Re-record exactly those words, same mic, a second of silence either side.
3. Enter its path and a short name, press **Import**, and type its new ID as "Pickup asset ID".
4. Once transcribed, press **Transcribe, align & propose splice** (needs the ML worker speech tools, else "Forced alignment is unavailable").
5. Accept the proposal in Proposals: the line goes on a "Pickups" audio track. Limitation: the fluffed take is not muted and still plays underneath.

## panel.broll
Title: B-roll
Where: B-roll panel

### What it's good for
B-roll is the footage you cut away to while you keep talking: a shot of the street, a screen recording, a photo. This panel brings such material in together with a note of who owns it (its rights), and lets you generate clips that you check before they reach the timeline. For your own phone and OBS clips the Media panel is enough; you only need this for material you didn't shoot, or to record its rights.

### How to use it
1. No tab shows it by default: click **B** in the tool rail (Ingest group); it opens in the left column.
2. **Source classes**: say what kind of material it is and import it with its rights.
3. **Generation request**, then **Candidate review**: make a clip, check it and place it at the playhead.
4. **Rights indicators**: see which clips have ownership details and which lack them.

## section.broll.source-classes
Title: Source classes
Where: B-roll panel

### What it's good for
The seven kinds of B-roll Guyditor knows, each with its own way in. Picking the right one records who owns the file, so an export can warn you about anything you may not be allowed to use. For example, a stock clip you bought goes in as Licensed assets, with the licence and the seller.

### How to use it
1. Click a kind. Local footage, Licensed assets, Stills and Screen captures show a "Source path" box; only Licensed assets asks for licence details. The label under each kind shows its default rights.
2. Type the file's full path. For Licensed assets also fill License, Licensor (who sold it) and Purchase ref.
3. Press **Capture rights + ingest**: imported like any Media import, rights attached; a note flags missing licence details.
4. Programmatic animations are made in the Graphics panel; External generation uses **Generation request** below; Local generation is not available.

## section.broll.generation-request
Title: Generation request
Where: B-roll panel

### What it's good for
Asks a generator to make a B-roll clip from a description, showing the cost before anything is sent. Today only the built-in offline generator works: it makes a coloured box moving over a plain background, free, so you can try the flow; it does not draw what you describe. The online generator and ComfyUI (an image tool that runs on your computer) are listed as unavailable and can't be switched on yet.

### How to use it
1. Describe the shot in "Visual prompt"; "Negative prompt" lists what to keep out.
2. Set width, height, seconds and Count (1 to 4 versions).
3. Check "Preflight estimate" (the price before sending), then press **Run preflight + generate**. If a budget limit asks, the button turns into **Confirm cost + generate**.
4. When the job finishes, the clips wait in **Candidate review**. Don't ask for words in the picture: titles and labels come from Graphics templates.

## section.broll.candidate-review
Title: Candidate review
Where: B-roll panel

### What it's good for
Every generated clip (a candidate) waits here until you have checked it; nothing reaches your project before you accept it. You judge seven points, from fit with the topic and your brand to glitches, stray text in the picture and whether you may use it, because a clip that looks right can still be wrong.

### How to use it
1. Pick a candidate (#1, #2…) and play its preview.
2. For each of the seven points choose Pass, Fail or N/A and write a short note; every point needs a note.
3. Press **Resolve review**. If any point is Fail, **Accept + freeze** will refuse; press **Reject** or **Regenerate new** instead.
4. **Accept + freeze** copies the clip into the project and puts it on a new track at the playhead. Until then candidates sit in a cache that cleanup may delete.

## section.broll.rights-indicators
Title: Rights indicators
Where: B-roll panel

### What it's good for
Lists the project's clips by ID with their rights: who owns them and whether you may use them. It catches things like a stock clip with no licence recorded before you publish. The word in the header is how strict the export check is: warn (the default) only warns, block stops the export, off skips it.

### How to use it
1. Read each row: the clip's ID (the ast_… code under its name in Media), where it came from, and **Rights ready** or **Rights missing** (**Rights blocked** at the block level).
2. Clips imported in the Media panel have no rights note, so they show Rights missing too; with warn that only adds an export warning.
3. To record rights for a file, import it through **Source classes** with the right kind.
4. The strictness level is set in Guyditor's settings file, not in this panel.

## panel.transcript
Title: Transcript
Where: Transcript panel
Manual: 4. Cut tab — shape the story

### What it's good for
Every word said in your transcribed clips, written out, so you edit by reading: find the rambling sentence and cut it, no hunting on the timeline. Words with a dotted red underline may be misheard. The Caption track box sets how captions look: preset, size, colour, line breaks.

### How to use it
1. Click a word to move the playhead there; Shift+click a later word to select the span (shown at the top, like w000120 → w000135).
2. **Remove range** cuts the span from the timeline and closes the gap (footage must be on the timeline); **Create clip** adds it as a clip at the end. `Ctrl+Z` undoes.
3. **Correct word** fixes a misheard word: type it, press **Save correction**.
4. **Detect fillers** (top right; needs the ML worker, Guyditor's local speech tools) proposes shortening long pauses and cutting um/uh/erm, "like", "you know", "so", repeats and false starts; check it in Proposals before accepting.

## panel.assemble
Title: Assemble
Where: Assemble panel
Manual: 4. Cut tab — shape the story

### What it's good for
Turns raw takes of you talking to camera into a first rough cut: an AI assistant (Anthropic or OpenAI) reads the transcripts, never your video, keeps your last attempt at each line unless you say otherwise on camera ("use the first one"), and asks when unsure. It needs an API key or a logged-in `claude`/`codex` command; replies cost money. With one clean take, cut in the Transcript instead.

### How to use it
1. All clips start ticked; untick any to leave out. Attach a script or notes with **Add files…** and pick it under Script.
2. Click the settings line ("anthropic · …") to save an API key, or choose local CLI, press **Check**.
3. Press **Analyze footage**, type what you want, press **Send**; answer its questions until a plan table appears.
4. Press **Create proposal**, then accept it in Proposals (**Rebase + accept**); the cut lands after what is already on the timeline.

## panel.timeline
Title: Timeline
Where: Timeline panel
Manual: 4. Cut tab — shape the story

### What it's good for
Your video in order, one block per clip, with thumbnails and sound wave. Here you make fine cuts the Transcript can't: split a clip, shave frames (still pictures; 30 make a second at 30 fps) off its start or end, or reorder. `Ctrl+Z` undoes any edit.

### How to use it
1. Click a clip to select it (the playhead jumps to its start); drag it onto another to place it before that one.
2. To split, move the playhead inside it (Preview's slider or a Transcript word), press **Split**; **Join next** rejoins it to the next clip if both came from one split.
3. Type frames, pick **Head** (start) or **Tail** (end), press **Trim** to shorten. **Remove** deletes it and closes the gap; **Set gap** adds that many black frames before it.
4. A "!" marks a jump cut (the same shot jumps); click it for a proposal to hide it, like a zoom-in.

## panel.preview
Title: Preview
Where: Preview panel
Manual: 5. Polish tab — the look and sound

### What it's good for
Plays your edit with captions and graphics on top, as viewers will see it, but from the light proxy copies (the badge always reads PROXY), so judge sharpness in the export. The PROGRAM METER underneath checks loudness (overall volume, in LUFS) and peaks against your platform's target while it plays. You can also leave notes on a frame.

### How to use it
1. Press **Play** or **Pause**, drag the slider or type a frame number; the word being said shows below.
2. "PROXY PENDING": that clip's light copy isn't ready yet; "GAP": no clip there.
3. After some playing the meter reads pass, warn or fail; it is a guide, the export check decides. **Reset measurement** restarts it.
4. For a note, pause until the corner reads "settled", pick a shape (note, pin, rect…), type in "Annotation note" and press **Add at center**; it is listed below with **Resolve** and **Reject**.

## panel.graphics
Title: Graphics
Where: Graphics panel
Manual: 5. Polish tab — the look and sound

### What it's good for
Titles and on-screen text from ready-made templates; ten are built in, from title cards and lower thirds (your name and a line at the bottom of the frame) to callouts, counters and charts. Each sits on a layer above your footage, like your name when you first appear. A pinned skill named brand_visual supplies brand colours and fonts.

### How to use it
1. Click a template in the rack and fill its fields (* = required); the picture above updates.
2. Under Anchor pick the playhead or the selected Transcript word; under Duration, intrinsic (the template's own length), fixed or until frame.
3. Press **Place graphic**; it shows in Preview and in the list at the bottom. Click it there to **Apply params**, **Remove** it or move its layer with ↓ ↑.
4. **Freeze to clip** makes it a real video clip at the end of the timeline; **Import package** adds a template folder.

## panel.skills
Title: Editorial skills
Where: Skills panel
Manual: 8. The agent, skills, and safety rails

### What it's good for
A skill is a short written document of your editing taste with rules, such as how tight to cut pauses or your brand colours; pinning it to a project freezes its version, so a later change never alters a finished episode until you upgrade. Pinned skills guide an attached AI agent, the take comparison's scoring and, for a skill named brand_visual, Graphics colours and fonts. Guyditor cannot write new skills yet, so unless your library already has one it is empty; then skip this panel.

### How to use it
1. No tab shows it by default: click **K** in the tool rail (Polish group).
2. In **Library**, click a version to read it, then **Pin v…** to use it here.
3. It then shows in **Project pins**: **Read** shows its rules; **Review v…** appears when a newer version exists.
4. Examples you teach it from Proposals wait in **Draft revisions** until you publish them.

## section.skills.project-pins
Title: Project pins
Where: Skills panel

### What it's good for
The skills this project uses, each frozen at one version and marked "active". Frozen means a newer version in the library changes nothing here, so an episode you finished keeps the rules it was cut with. With nothing pinned the list reads "No skills are pinned to this project." and you can ignore it.

### How to use it
1. Pin a skill with **Pin v…** in Library below; it appears here with its version.
2. **Read** shows its full text, its rules and any saved examples; **Close** hides them.
3. When the library holds a newer version, **Review v…** shows what changed: rules added, removed or changed, and new examples.
4. Press **Upgrade project pin** to switch this project to it, or **Cancel** to stay; the upgrade is recorded in the project history.

## section.skills.library
Title: Library
Where: Skills panel

### What it's good for
Every skill on this computer, shared by all your projects, with each of its versions. A published version never changes; a change makes a new version. Guyditor has no button to write a skill from scratch, so the library starts empty ("The global skill library is empty.") and grows only when you publish a draft of a skill you already have.

### How to use it
1. Click a version button (such as v1.0.0) to read that version below.
2. Press **Pin v…** to use the newest version in this project; it appears under Project pins and its Pin button disappears.
3. To move a pinned skill to a newer version later, use **Review v…** in Project pins.

## section.skills.draft-revisions
Title: Draft revisions
Where: Skills panel

### What it's good for
Unpublished new versions of a skill, made when you teach it from your own decisions: after you accept or reject a proposal, Proposals offers to save that decision as an example. Drafts are inactive ("inactive" in the header): nothing uses them until you publish one and upgrade a project to it. This section only appears while a draft exists.

### How to use it
1. In Proposals, after **Accept** or **Reject**, pick the skill, say why (optional) and press **Save to new draft version**.
2. Here, press **Review draft** to see what changed against the last published version.
3. Press **Publish reviewed version** to add it to Library as a new version, or **Cancel**. Projects keep their old version.
4. To use it in this project, press **Review v…** under Project pins, then **Upgrade project pin**.
