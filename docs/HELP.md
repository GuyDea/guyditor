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
Make the video look and sound finished: captions, titles, green screen and music levels. Captions are styled with the Caption track controls in the Transcript panel. It shows Graphics (titles, lower thirds and other templates), Preview, Transcript, Agent (Proposals) and Inspector (details and tools for whatever you selected).

### How to use it
1. Click the tab, or press `Ctrl+Alt+3`.
2. Select a clip or a layer name on the Timeline (Cut tab); the Inspector here then offers green-screen keying for a clip, Ducking (music turns down while you talk) for a music layer, picture-in-picture for a video layer. Volume, fades and colour have no editors yet.
3. Add titles from Graphics and check them and the captions in Preview (it may play the light proxy copies, so judge sharpness in the export).
4. If the video already looks and sounds the way you want, skip this tab; it never shows a number.

## phase.review
Title: Review tab
Where: Phase tabs, top of the window
Manual: 6. Review tab — the feedback loop

### What it's good for
Watch the cut critically and settle every open change. It shows Media (to compare alternative takes), Preview (pause and pin notes to a frame) and Agent (titled Proposals: every suggested change with its reason, waiting for your yes or no).

### How to use it
1. Click the tab, or press `Ctrl+Alt+4`.
2. Pause Preview, pick a shape, type in "Annotation note" and press **Add at center**; the note sits at the middle of the frame.
3. In Proposals, **Accept** or **Reject** each change; rejecting leaves the project exactly as it was. **Supersede** files the same edits again against the current project, with your typed text as the reason.
4. The number on the tab counts proposals waiting for review (notes you add don't count); click it to jump to the first one.

## phase.publish
Title: Publish tab
Where: Phase tabs, top of the window
Manual: 7. Publish tab — get it out

### What it's good for
Get the finished video out: exports, shorts, chapters, titles and descriptions, thumbnails and upload kits. It shows Publish (packaging per platform) and Deliverables & jobs (the Status panel: your main video and each short, with their approval state and export jobs).

### How to use it
1. Click the tab, or press `Ctrl+Alt+5`.
2. In Deliverables & jobs, find the video (the main one or a short), press **Send review**, then **Approve**; only approved videos export.
3. In Publish, press **Export output set**, then **Build upload kit** (one folder per platform, ready to upload by hand). Today kits build for shorts only: the main video's kit needs approved chapters and a thumbnail image that nothing generates yet.
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
Every word said in your transcribed clips, written out, so you edit by reading: find the rambling sentence and cut it, no hunting on the timeline. Words with a dotted red underline may be misheard. The Caption track box sets how captions look.

### How to use it
1. Click a word to move the playhead there; Shift+click a later word to select the span (shown at the top).
2. **Remove range** cuts the span from the timeline and closes the gap (footage must be on the timeline); **Create clip** adds it as a clip at the end. `Ctrl+Z` undoes.
3. **Correct word** fixes a misheard word: type it, press **Save correction**.
4. **Detect fillers** (needs the ML worker: local speech tools) shows "Queued …". Later a proposal appears in Proposals (where suggested edits wait for your Accept), shortening long pauses and cutting um/uh/erm, "like", "you know", "so", repeats and false starts; check it first.

## panel.assemble
Title: Assemble
Where: Assemble panel
Manual: 4. Cut tab — shape the story

### What it's good for
Turns raw takes of you talking into a first rough cut: an AI assistant reads transcripts, never your video, keeps your last attempt at each line unless you say otherwise on camera ("use the first one"), and asks when unsure. It needs an API key or a logged-in `claude`/`codex` command, and replies cost money; for one clean take, use the Transcript.

### How to use it
1. Untick clips to leave out. Attach a script or notes with **Add files…** and pick it under Script.
2. In the settings line, save an API key or choose local CLI and press **Check**.
3. **Analyze footage**, then type what you want, press **Send** (it may first ask **I understand — continue** or **Confirm $…**); answer its questions until a plan table appears.
4. **Create proposal**, then **Accept** it in Proposals, the suggested-edits panel (shown as **Rebase + accept** if the project changed); it lands after existing clips.

## panel.timeline
Title: Timeline
Where: Timeline panel
Manual: 4. Cut tab — shape the story

### What it's good for
Your video in order, one block per clip, with thumbnails and sound wave. For fine cuts the Transcript can't do: split a clip, shave frames (still pictures; 30 make a second at 30 fps) off its start or end, or reorder. Edits show at once; `Ctrl+Z` undoes them.

### How to use it
1. Click a clip to select it (the playhead jumps to its start); drag it onto another to place it before that one.
2. To split, move the playhead inside it (Preview slider or Transcript word), press **Split**; **Join next** rejoins two split halves.
3. Type frames in the first box, pick **Head** (start) or **Tail** (end), press **Trim** to shorten. **Set gap** puts the second box's frames of black before it (0 clears); **Remove** deletes it.
4. A "!" marks a jump cut (the same shot jumps); click it for a suggested fix (like a zoom-in) in Proposals, awaiting your Accept.

## panel.preview
Title: Preview
Where: Preview panel
Manual: 5. Polish tab — the look and sound

### What it's good for
Plays your edit with captions and graphics on top, as viewers will see it, but from the light proxy copies (the badge always reads PROXY), so judge sharpness in the export. The PROGRAM METER underneath checks loudness (overall volume, in LUFS) and peaks against the project's target (normally −14 LUFS) while it plays. You can also leave notes on a frame.

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
Titles and on-screen text from ready-made templates; ten are built in, from title cards and lower thirds (your name and a line along the bottom) to callouts, counters and charts. Each sits on a layer above your footage. A pinned skill named brand_visual supplies brand colours and fonts; skip this panel if you want no on-screen text.

### How to use it
1. Click a template in the rack and fill its fields (* = required); the picture above updates.
2. Under Anchor pick the playhead or the selected Transcript word; under Duration, intrinsic (the template's own length), fixed or until frame.
3. Press **Place graphic**: it appears in Preview and in the list at the bottom. Click it there to **Apply params**, **Remove** it or move its layer with ↓ ↑.
4. **Freeze to clip** makes it a real video clip at the end of the timeline; **Import package** adds a template folder.

## panel.skills
Title: Editorial skills
Where: Skills panel
Manual: 8. The agent, skills, and safety rails

### What it's good for
A skill is a short written document of your editing taste with rules, such as how tight to cut pauses or your brand colours; pinning it to a project freezes its version, so a later change never alters a finished episode until you upgrade. Pinned skills guide an attached AI agent, the take comparison's scoring and, for a skill named brand_visual, Graphics colours and fonts. This app's panels cannot write new skills yet, so unless your library already has one it is empty; then skip this panel.

### How to use it
1. No tab shows it by default: click **K** in the tool rail (Polish group).
2. In **Library**, click a version to read it, then **Pin v…** to use it here.
3. It then shows in **Project pins**: **Read** shows its rules; **Review v…** appears when a newer version exists.
4. Examples taught in Proposals (the suggested-edits panel) wait in **Draft revisions**.

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
Every skill on this computer, shared by all your projects, with each of its versions. A published version never changes; a change makes a new version. No panel in this app writes a skill from scratch, so the library starts empty ("The global skill library is empty."); in the app it grows only when you publish a draft of a skill you already have.

### How to use it
1. Click a version button (such as v1.0.0) to read that version below.
2. Press **Pin v…** to use the newest version in this project; it appears under Project pins and its Pin button disappears.
3. To move a pinned skill to a newer version later, use **Review v…** in Project pins.

## section.skills.draft-revisions
Title: Draft revisions
Where: Skills panel

### What it's good for
Unpublished new versions of a skill, made when you teach it from your own decisions: after you accept or reject a proposal, Proposals (the panel where suggested edits wait) offers to save that decision as an example. Drafts are inactive ("inactive" in the header): nothing uses them until you publish one and upgrade a project to it. This section only appears while a draft exists.

### How to use it
1. In Proposals, after **Accept** or **Reject**, pick the skill, say why (optional) and press **Save to new draft version**.
2. Here, press **Review draft** to see what changed against the last published version.
3. Press **Publish reviewed version** to add it to Library as a new version, or **Cancel**. Projects keep their old version.
4. To use it in this project, press **Review v…** under Project pins, then **Upgrade project pin**.

## panel.agent
Title: Proposals
Where: Agent panel (titled Proposals)
Manual: 6. Review tab — the feedback loop

### What it's good for
A proposal is a change Guyditor suggests instead of making it: filler cuts from the Transcript, a jump-cut fix from the Timeline, an Assemble rough cut, a new short. Each waits here with its reason; nothing changes until you accept it, and rejecting leaves the project exactly as it was.

### How to use it
1. Click a proposal (a lone one opens by itself) to read its reason and changes.
2. **Accept** applies it, **Reject** drops it; either way it leaves the list. Empty, it reads "No open proposals."
3. "stale" means the project changed since: Accept reads **Rebase + accept** where safe, else greys out; **Supersede** refiles the same edits against the current project, your typed text as the reason.
4. Below, **Save to new draft version** keeps the decision as an example for a pinned skill.
5. Ignore the "Segmented AI restyle" box on top: a paid AI restyle needing a Kling key no panel can enter.

## panel.status
Title: Deliverables & jobs
Where: Status panel (titled Deliverables & jobs)
Manual: 7. Publish tab — get it out

### What it's good for
A deliverable is one video you will publish: your main video, plus any short (an upright clip for Shorts, TikTok or Reels) made from it. This panel lists them with their state (draft, in-review, approved, stale), every background job (imports, transcripts, exports) and the last export's report. Publish only exports approved videos.

### How to use it
1. Click a video to make it the one Preview, Timeline and Publish work on.
2. Press **Send review**, then **Approve**; the chip then reads approved.
3. **Render primary export** writes the main video, without burned-in captions, to the project's exports folder, even unapproved; a failed check shows at the window's bottom. Its report shows below.
4. A reviewed short turns "stale" when you edit footage it uses: **Build refresh review**, then **Accept refresh** or **Keep stale**. The main video stays approved after edits.
5. Jobs: **Cancel** stops one, **Retry** reruns a failed one. **Derive short** makes a new short.

## section.status.derive-a-short
Title: Derive a short
Where: Status panel (Deliverables & jobs), opened with Derive short
Manual: 7. Publish tab — get it out

### What it's good for
Makes a short, an upright (9:16) video for YouTube Shorts, TikTok or Instagram Reels, from part of your main video, say the 40 seconds with your best tip. It is its own edit, not a crop, and arrives as a proposal (a suggested change waiting in Proposals for your Accept).

### How to use it
1. First select the words in the Transcript (Cut tab: click the first, Shift+click the last), then press **Derive short** here with Source on Transcript passage; or use Timeline range with start and end frames.
2. Type a Name, pick a Platform; the box below lists its size, length and loudness limits.
3. Press **Create proposal**, then **Accept** it in Proposals: the short appears in the list as draft.
4. Clip range takes clip IDs. Discovered candidate and Beat range need story beats, which the app can't create; **Discover candidates** queues a job, **Load results** then shows only the whole recording, if it fits.

## panel.publish
Title: Publish
Where: Publish panel
Manual: 7. Publish tab — get it out

### What it's good for
Packs the video picked under Deliverable for upload: title, description, tags, chapters, covers, exported files and an upload kit (one folder per platform; you upload by hand). Limitation: kits work for shorts only; the main video's kit needs chapters, made from story beats the app can't create, and a thumbnail image nothing makes yet.

### How to use it
1. Press **Draft from transcript + beats** for a rough title, description and tags from your words; rewrite them, keep each counter (e.g. 52/100) within its limit, press **Save draft**, then **Approve**.
2. Approve the video itself in Deliverables & jobs (**Send review**, **Approve**).
3. Press **Export output set**: video with and without burned-in captions, subtitles and, for a short, six covers, in the exports folder.
4. When that job reads done in the Deliverables & jobs list, with no changes in between, press **Build upload kit**; the folder appears under exports/kits. **Text exports**, **Export .otio**, **Batch export** are optional.

## panel.help
Title: Help & manual
Where: Help panel (the "?" button in the title bar)

### What it's good for
The whole user manual inside the app, searchable, plus a Getting started checklist and the keyboard map. For a quick answer about one part of the screen use help mode instead: while it is on, clicking a panel or section explains it instead of doing anything.

### How to use it
1. Click **?** in the title bar to open this panel; type in "Search manual" to show only the sections containing that text.
2. Turn help mode on with **ⓘ** next to **?** (it then reads "Help mode") or press Shift+F1, then click any panel or section.
3. In the popup, **Open in manual** jumps to the matching manual section here. Esc closes the popup, Esc again leaves help mode; Shift+F1 also switches it off.
4. **Restart tour** replays the guided tour; **Show welcome** reopens the welcome screen.

## section.help.getting-started
Title: Getting started
Where: Help panel

### What it's good for
A six-step checklist that takes one video from start to export: open a project, import media, wait for the transcript, make an edit, review a proposal (a suggested change in the Proposals panel), export. Steps tick themselves (✓) as you do them; the count beside the heading, such as 2/6, shows how far you are.

### How to use it
1. Do each step anywhere in the app; you can't tick one by hand.
2. "Make your first accepted edit" ticks with any saved change (even an import counts); "Review an agent proposal" with **Accept** or **Reject** in Proposals.
3. "Export your first deliverable" ticks once an export report exists, for example after **Render primary export** in Deliverables & jobs.
4. Once you know your way around, press **Dismiss checklist**; **Show checklist** brings it back.

## section.help.keyboard-map
Title: Keyboard map
Where: Help panel

### What it's good for
Every keyboard shortcut in one list. The ones you'll use most while cutting a vlog: Space plays or pauses, ← / → step one frame (with Shift, ten) and Ctrl+Alt+1…5 switch tabs (Cmd on a Mac). Playback keys do nothing while you type in a box, and in help mode keys only steer help.

### How to use it
1. Click **Keyboard map** to open or close the list.
2. Keys 1 to 9 open Media, Preview, Transcript, Inspector, Agent (Proposals), Timeline, Status, Graphics and Publish.
3. Alt+← / Alt+→ move between transcript words, A / Shift+A between Preview notes; Home goes to frame zero.
4. Undo is Ctrl+Z; redo is Ctrl+Shift+Z or **Redo** in the title bar. The listed Ctrl+Y does not work yet.

## panel.storage
Title: Storage & recovery
Where: Storage panel
Manual: 3. Ingest tab — get material in

### What it's good for
Shows where this project's disk space goes, by kind: sources (your original clips, never touched), generated (accepted B-roll and other clips Guyditor made), project-state (project file, history, transcripts), proxies (light copies for smooth scrubbing), caches, renders (your exports) and more. When vlogs fill your disk, it frees space safely. Despite the name, backup and archiving have no buttons here yet.

### How to use it
1. Press **Scan**: free space, orphans (cache files of clips no longer in the project) and each kind's size, each marked whether it is safe to clean (only proxies, caches and the job list are).
2. Press **Plan safe cleanup**; a Cleanup review appears below listing what would go.
3. Decide there: deleting frees the space, but proxies don't come back by themselves (see Cleanup review).
4. If your disk isn't filling up, you don't need this panel.

## section.storage.cleanup-review
Title: Cleanup review
Where: Storage panel, after Plan safe cleanup
Manual: 3. Ingest tab — get material in

### What it's good for
The last check before anything is deleted. It counts what would go: every proxy (light copy for smooth scrubbing), every cache file (such as waveforms, timeline thumbnails, B-roll candidates not yet accepted, short candidates) and the finished entries in the job list. Your original clips, project, transcripts and exports are never touched.

### How to use it
1. Read the line, such as "120 verified regenerable items · 3.4 GB".
2. Press **Delete planned disposable files** (the panel then rescans), or **Keep files** to cancel.
3. Limitation: proxies and waveforms are not rebuilt by themselves yet, so Preview shows "PROXY PENDING" and clips lose their waveform. Clean only when you need the space; exports still work, they use your originals.
4. If a file changed after planning, the cleanup refuses; press **Plan safe cleanup** again.

## panel.inspector
Title: Inspector
Where: Inspector panel
Manual: 2. The workspace

### What it's good for
Shows what you selected (a Timeline clip or layer, a transcript word, a Preview note) as raw text, plus tools that appear with the right selection: green-screen keying (cutting you out of the background) for a clip, Ducking (music turns down while you talk) for an audio layer, Picture in picture for a video layer. Volume, fades and colour have no editors yet.

### How to use it
1. Select something; **Copy selected ID** copies its ID.
2. With a clip selected and no key set, **Enable chroma key** removes a green screen (Key method turns it off). Without a green screen: **Use neural matte**, **Generate matte candidate**, **Accept + freeze matte** (needs the ML worker's matte model).
3. Click a layer's name on the Timeline: a music or audio layer shows Ducking (**Save ducking**), a video layer Picture in picture (**Place / update**).
4. **Reveal project** shows the project folder, **Copy path** copies it, **History** lists every change.

## section.inspector.semantic-history
Title: Semantic history
Where: Inspector panel, opened with History
Manual: 2. The workspace

### What it's good for
The project's change log: every saved change, oldest first, described in words. Use it to find when a clip disappeared or what an accepted proposal (a suggested edit from the Proposals panel) actually did. You can't go back to an old version from here yet: **Restore revision** and **Compare revisions** are greyed out.

### How to use it
1. Press **History** at the top of the Inspector.
2. Each row shows the revision it created (rev_00012 is the 12th saved state), who made it (human:ui is you editing directly; other rows come from proposals and automatic work such as imports) and each change.
3. To follow one clip, paste its ID (the Inspector's **Copy selected ID**) into "Entity ID"; "Actor" and "Revision" filter the same way.
4. **Close** hides the list. To take back a recent edit, use **Undo** in the title bar.
