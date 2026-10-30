# Contextual help ("What's this?" mode) — design

Status: draft for approval · 2026-10-30 · branch `feat/contextual-help`

## Why

Martin imported nine iPhone clips and met a Media panel full of words he could
not decode: "Generate proxy", "Capture watcher", "Pickup repair", a queue of
"Transcribe ast_…" jobs. The manual exists (Help panel) and so does a guided
tour, but neither answers "what is *this thing in front of me* for, and how do
I use it?" at the moment the question comes up.

**Success:** while working, Martin can switch on help mode, click any panel or
section he doesn't understand, and come away knowing what it is good for and
how to use it — without opening the manual or asking someone.

**The failure he named (anti-goal):** the feature works mechanically but he
*still* can't understand what a section does or how it works. The texts are the
product; the mode and the popup are delivery.

## What he decided

- **Help mode is a toggle.** A help icon in the title bar switches help mode on
  and off. While it is on, clicks explain things instead of doing them.
- **The answer is a popup in the middle of the screen.**
- **Each answer covers two things: what it is good for, and how to use it.**
- **Granularity: panels and their sections.** Individual buttons, badges
  (e.g. "PROXY RUNNING") and fields are out of scope.
- **Nothing navigates in help mode.** Phase tabs, rail entries and dock tabs
  explain themselves instead of switching; he leaves help mode to move around.
- **Texts ship as drafted; he fixes them as he goes** by telling Claude in chat
  which ones didn't help. No in-app editing or flagging.

He approved the three-moment mockup (normal use → help mode on with outlines →
centred popup for "Capture watcher") in the brainstorm session.

## Behaviour

1. **Toggle.** A help-mode button sits next to the existing Help button in the
   title bar (`data-testid="help-mode-toggle"`); the existing Help button
   already shows "?", so the toggle uses a distinct glyph or a "Help mode"
   label. Pressed state is obvious (filled,
   labelled "Help mode"). *(Claude's call:)* `Shift+F1` also toggles it, and the
   shortcut appears in the manual's keyboard map.
2. **Help mode on.**
   - Every element that has help gets a dashed outline; the help target under
     the pointer is highlighted and the cursor is the help cursor.
   - A one-line banner says "Help mode: click a panel or section to see what it
     does. Esc closes a popup; Esc again leaves help mode." *(Claude's call: banner
     placement is the builder's: a fixed overlay under the title bar, on the right,
     that takes no row of the shell grid and lets clicks through.)*
   - Clicks are intercepted before they reach the app: a click on a help target
     opens its popup; any other click does nothing, so help mode can never
     start an import, cancel a job or change the project. The toggle, the
     popup itself and the title-bar Help button keep working.
   - *(Claude's call:)* the same guarantee covers the keyboard and drag-and-drop.
     While help mode is on, the app's keyboard shortcuts (play, undo/redo,
     panel focus, annotation cycling, …) and typing into fields are blocked
     except `Esc` and `Shift+F1`, and drops (file import, dock-tab re-docking)
     are refused. One shared "help mode active" gate is read by the window
     keydown handler and the drop/drag handlers.
   - When targets nest (a section inside a panel), the innermost one wins.
   - **Nothing navigates** (Martin's decision): a phase tab, a tool-rail entry
     or a dock tab opens its explanation instead of switching, and a collapsed
     section's header explains the section instead of expanding it. To look at
     something that is not on screen he leaves help mode, goes there, and turns
     help mode back on.
   - Keyboard: `Esc` closes an open popup; `Esc` with no popup leaves help
     mode. *(Claude's call:)* help mode is not remembered across restarts.
3. **The popup.**
   - Centred modal over a dimmed app, title = the panel/section name, a small
     "where" line (e.g. "Media panel").
   - Two labelled parts: **What it's good for** (a short paragraph) and **How to
     use it** (a short numbered list, including what you'll see when it is
     working).
   - Optional **Open in manual** button when a matching manual section exists:
     it opens the Help panel scrolled to that section (the manual already
     renders `data-manual-section="<heading>"`), and closes the popup.
     *(Claude's call:)* links may be coarse — most manual headings cover a whole
     tab, and that is acceptable; no new manual headings are required. The Help
     panel needs small new plumbing: reveal the panel, clear its search filter,
     scroll to the heading.
   - **Close** button and `Esc` close it; help mode stays on so he can click the
     next thing.
4. **Help mode off** restores normal clicks immediately; nothing else in the
   app changes.

## Coverage

Every one of these gets a help text in the first release:

- **All 14 dock panels** in `PANEL_LABELS` (`packages/app/src/renderer/state/tool-rail.ts`):
  Media, Preview, Transcript, Inspector, Agent, Timeline, Status, Graphics,
  Publish, Skills, B-roll, Storage, Help, Assemble.
- **Workspace chrome** *(Claude's call on granularity)*: each of the five phase
  tabs (Ingest, Cut, Polish, Review, Publish: what that stage of the work is
  for and which panels it brings up), the master tool rail as a whole (its
  frame and group labels), and the global progress button (its text also
  explains the "What are we waiting on?" popover it opens). A tool-rail entry
  or a dock tab for a panel shows that panel's text.
- **Every section inside a panel with a fixed, visible header** *(Claude's
  call on the rule)*: collapsible `<details><summary>` blocks with fixed text
  (e.g. Capture watcher, Pickup repair, Project pins), fixed `<h3>` section
  headings, and titled dialogs a panel opens (e.g. Semantic history, Derive a
  short, Cleanup review). Headers generated per item — one per clip, per
  proposal entity type, per changed skill — are not sections and get no text.
  The help target is the header itself (the `<summary>` or heading), so it
  works whether a section is open or closed. The plan lists the final
  inventory. A test scans `panels/*.tsx` for `<summary>` and `<h3>` with fixed
  text and fails when one has no help key, with an explicit, commented
  allowlist for the per-item ones, so coverage cannot silently rot.

Panels or sections that only appear in certain states (e.g. a section shown
only when a project has transcripts) still get a text; help mode simply shows
an outline on whatever is on screen.

## The texts

The bar, from Martin's anti-goal: after reading a text he understands what the
section does and how to use it. Rules every text follows:

- **Plain words; define every term.** No unexplained jargon. "Proxy" is
  explained as "a light copy of each clip that keeps scrubbing smooth; exports
  always use your originals", not left as a word.
- **His situation, not feature-speak.** Say what it does for someone editing a
  vlog from phone or OBS footage, with a concrete example where it helps.
- **How to use it = steps**, 2–5 of them, ending with what he'll see when it
  works (e.g. "the clip's badge changes from PROXY RUNNING to PROXY READY"),
  and when he doesn't need it at all.
- **True to the code.** Each text is checked against what the code actually
  does, not only the manual — the 2026-10-30 queue investigation showed the
  manual can be thinner than the real behaviour. If the code and manual
  disagree, the text follows the code and the discrepancy is noted for the
  manual.
- **Short.** A paragraph and a list; it must fit the popup without scrolling
  at the default window size.

Existing copy to start from: the 20 guided-tour stops (`GuidedTour.tsx`),
`docs/MANUAL.md`, `docs/capture-integration.md`, and the panel code.

**Where texts live** *(Claude's call):* one Markdown file, `docs/HELP.md`,
bundled into the renderer with `?raw` exactly like the manual
(`manual-source.ts`). One `##` section per help key, each with the two labelled
parts and an optional manual-section link. One plain file keeps "fix this one"
requests from chat to a single, obvious edit. The parser fails loudly (a test)
on a malformed entry.

## Fixing texts later

Martin reports unclear texts in chat; Claude edits `docs/HELP.md` (and checks
the code again for that section). No feedback button, no in-app editor.

## Non-goals

- Help for individual buttons, badges, fields or menu items.
- Hover tooltips or explanations that appear without help mode.
- AI-generated or live answers; texts are static.
- In-app editing or "this didn't help" flagging.
- Changing the guided tour, or replacing the manual.
- Translation.

## Testing

- Unit: the help file parses; every entry has both parts; every help key used
  in the renderer has an entry and every entry is used; every manual link names
  a real manual heading; every `PANEL_LABELS` panel has an entry.
- Unit or component: help mode swallows clicks on non-targets and opens the
  innermost target's popup.
- e2e: toggle help mode, click the Media panel's Capture watcher section, see
  the popup with both parts, `Esc` closes it and help mode stays on, a second
  `Esc` leaves it, and a normal click then works again.
- Text quality cannot be tested; Martin judges it in use.

## Docs

Update `docs/MANUAL.md` (help mode, the toggle and `Shift+F1`), add an
amendment for the feature, and a traceability row, following how amendments
007–009 were recorded.

## Left to the builder

Visual styling within the app's existing look, the outline/highlight
technique, how help keys are attached to elements (a `data-help` attribute is
the obvious route), the parser's exact format, file and component names, and
the amendment/traceability identifiers.
