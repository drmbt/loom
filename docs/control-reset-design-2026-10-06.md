# Reset a control, or all of them, to what was saved (§T1619b)

2026-10-06. Owner: *"ways to reset controls individually or all according to what was saved or
something should be something useful accessible on both phone and browser"*. Slices 1 and 2
of section 5 are built (the default and its commands; the desk). The phone, slices 3 and 4,
is not: there the way back is still a preset written by hand (sentinel-bot's three `saved`
banks, `2bc870d4`). Where the build departs from this design, "AS BUILT" says so.

## What established tools call "saved", and how they reset

| Tool | What reset goes to | How one control is reset |
|---|---|---|
| [TouchDesigner](https://docs.derivative.ca/Component_Editor_Dialog) | A custom parameter's authored default: "the value that the parameter will be set to when it is "reset" via the parameter RMB menu". Set by copying the current value in ("click the arrow next to the default"), with "options for setting all defaults on the page or the entire component". [`par.default`](https://docs.derivative.ca/Par_Class) "Can only be set on Custom Parameters"; a built-in parameter's is its operator type's. `par.reset()`, `par.isDefault`, [`op.resetPars()`](https://docs.derivative.ca/OP_Class). | The parameter's right-click menu (its wording is a screenshot in the docs: INFERRED) |
| [TouchOSC](https://hexler.net/touchosc/manual/editor-control-values) | Each value's `Default`: "The value that this value object will hold when the document is loaded initially." | Nothing built in. The manual's [script examples](https://hexler.net/touchosc/manual/script-examples) time a double tap (300 ms) and write `ValueField.DEFAULT`. Its [Pager](https://hexler.net/touchosc/manual/controls) has `Double Tap` as a guard: "Require a double tap on the tab bar instead of a single press". |
| [Open Stage Control](https://openstagecontrol.ammd.net/docs/widgets/properties-reference/) | `default`: "the widget will be initialized with this value when the session is loaded" | `doubleTap`, per fader, knob and xy: "reset to its default value when receiving a double tap". A button's `doubleTap` is a guard ("require a double tap to be pushed"). |
| Lemur | No default property found | A script that times two presses (0.25 s): a [forum thread](https://community.midikinetics.com/viewtopic.php?p=5881). The manual was NOT read. |
| Ableton Live | The parameter's default | `Delete` on the selected control: ["Return to Default"](https://www.ableton.com/en/manual/live-keyboard-shortcuts/). [Push](https://www.ableton.com/en/manual/using-push-1/): "holding Delete and touching an encoder will reset the corresponding parameter to its default value". Double-click is [forum](https://forum.ableton.com/viewtopic.php?t=249022) knowledge: INFERRED. |
| [Notch](https://manual.notch.one/2026.1/en/docs/reference/user-interface/properties/) | "its default state". An [exposed property](https://manual.notch.one/2026.1/en/docs/workflows/working-with-media-servers/exposed-parameters/) has a default value beside its minimum and maximum (what sets it: INFERRED). | A Reset icon on every property; "Reset Node Properties" for a node |
| [Resolume](https://resolume.com/support/en/parameters) | default value | "right clicking on the slider or parameter name" |
| [ETC Eos](https://www.etcconnect.com/WebDocs/Controls/EosFamilyOnlineHelp/en/Content/08_Manual_Control/Home.htm) | The fixture library's default, or a Home Preset: "Any channels that are not included in the preset assigned to Home in Setup will use their library defaults." | [Home] with a selection |

Every quoted sentence was read in the vendor's page on 2026-10-06. Three things recur. **The
default belongs to the control**, is authored, and is kept apart from the current value.
**Setting it is copying the current value in**, for one control, a page, or everything. **Reset
is never a plain press**: a menu, a held key, or a double tap, which these surfaces also use to
guard a press that must not happen by accident. Correction to the row: TouchOSC has no
double-tap-to-default property; that is Open Stage Control's.

## 1. Which "saved"

| | The author saves mid-show | What goes stale | Document format | Driven, recall, morph, cue |
|---|---|---|---|---|
| **(a) the file as opened.** Exists: `parameter.revert`, "Revert to opened value" (§T1184), read from `store.getInitialState()` | Nothing this session. The next open, autosave restore (a snapshot about 2 s after every edit, offered at launch) or dev reload starts from the performed values: "saved" has moved and nobody decided it | Nothing against the file. A control made this session has none (refused by name) | none | Puts back the whole stored slot, so it would undo a MIDI learn made since opening |
| **(b) a default stored on the control**, set by "Set as default" | Nothing: the file holds value and default side by side | The default, when the author retunes and does not set it again. The mark shows it | Four parameter keys on three definitions, which go to version 2 with a `migrate`. `SCHEMA_VERSION` stays 5 | below |
| **(c) the node type's default.** Exists: `parameter.reset`, "Reset to default" (§V149) | nothing | Never, and never right: a Slider goes to 0.5 whatever its range | none | Clears the mode (§V149): a learned fader is unlearned |
| **(d) a designated preset.** Exists by hand; ETC's Home Preset is this shape | nothing | Whenever a shipped value changes, unless the preset is generated | none (a Panel parameter naming bank and preset) | The only one that can fade. One control is a partial recall, which does not exist; a control on two Panels has two |

**Recommended: (b).** A control's saved value is its DEFAULT, stored on the control, as
TouchDesigner, TouchOSC, Open Stage Control and Notch keep it. It starts as the value in the
file (a one-time load migration); after that only "Set as default" on the desk moves it. (a) is
what those surfaces mean by "the value at load", but they never write a performed value back
into the document and Loom does, on every save and autosave: under (a) a reload or a crash
mid-show makes wherever the sliders were the new "saved", exactly when Reset is needed.

As stored:

- Keys `defaultValue` (Slider), `defaultOn` (Toggle), `defaultX`, `defaultY` (XY Pad); a Button
  has nothing hand-set. Ordinary parameters: the inspector edits them, and undo, audit, copy
  and paste, component export and `get_node` carry them with nothing built.
- The three definitions go to version 2 with a `migrate` (the Ramp's lane, §V10): an older file
  loads with default := its stored value. An older build keeps the unknown keys (T91). A
  document SOURCE is written at the current version, so E81, E82 and sentinel-bot must author
  the key (E81 and E82 do, as built).
- AS BUILT (the lead's ruling, 2026-10-06): A CONTROL THAT STORES NO DEFAULT HAS NONE. It
  never reads the type's 0.5: `control.reset` refuses it by name (`control.default.missing`),
  the desk draws no mark on it and counts it as neither at nor away, and "Set as default" is
  what gives it one. A control made on the bus is born at its default (`bornWith`: the value
  it is created with). `src/examples/control-defaults.test.ts` fails a shipped control that
  stores none, with a ledger of exact counts for the three project files written before the
  rule.
- Each definition's `parametersFor` hands the stored default to its value key's schema default,
  so the inspector's existing "Reset to default" row, its `isOverridden` guard and the phone
  snapshot's `declared()` all mean this default. Today that row sends a Slider to 0.5 whatever
  its range (§T1184's pattern). Memoise it: schemas are read per frame.
- Read clamped into Min..Max, not snapped to Step (T652: reset restores what the author wrote).
- Cheaper, if the lead wants no version bump: no `migrate`, and a control that stores no default
  has no reset and no mark until someone presses Set as default.

How it sits. A **driven or MIDI-learned** control (the desk draws "driven", the phone does not
publish it) is not reset and not marked; Reset all skips it by name, and Reset never changes a
mode. A control that **drives** parameters takes them with it, as a hand move does. A **recall**
moves values, never defaults (Store skips the default keys, a recall does not write them), so a
recall from a phone cannot change what Reset means. In a **morph** a reset is a hand edit: by
the morph index's edit rule that key leaves the fade and cuts to its default at the next frame;
the rest keep fading. A key a **timed cue** list covers is the timeline's on screen (§T1508b
ruling 1): the reset is written and shows when the list lets go.

If the owner answers OPENED (Q1): no keys, no `migrate`, no Set as default; `control.reset`
reads the opened graph, value only, and the snapshot is built with it. Sections 2 to 4 stand.

## 2. One control

**What you see.** A slider has a thin tick on its track at the default, an XY pad a ring; each
brightens while the value is away. A toggle shows a small dot while its state is
not its default. After a reset the thumb sits on the tick and the control is outlined for a
moment. "Away" is further than 1/10000 of the range, one rule on both surfaces (the phone's
half in `PHONE_PAGE_LOGIC`). A phone's Panel tab carries a dot while any control on it is away.

**Phone.** Slider and XY pad: a DOUBLE TAP. A toggle needs none (a tap is the reset; the dot says
which state is the default). A Button, a Presets bank, a cue list and a Layer do not reset.

- A TAP is a touch that ends in `pointerup` inside the control within 300 ms, travelled under
  10 px (below `SLOP`, so never a drag), was never taken by the control, and did not land on a
  page still scrolling (a `scroll` event in the last 150 ms: the tap that stops a fling).
- A DOUBLE TAP is two taps on one control, the second landing within 300 ms of the first
  lifting (TouchOSC's figure) and within 32 px of it. The reset fires on the second lift.
- Why each accident fails: a flick is taken by the browser and ends in `pointercancel`; a drag
  is taken by the control; a resting finger is over 300 ms; one stray tap does nothing, as now
  (§T1607b); two fingers down together overlap and are not a sequence. Under `pan-y` and `none`
  the browser has no double-tap zoom to wait for (MDN; not measured on a phone).

Weighed and left. A **long press that fires** is the resting finger (a Button's hold is a rest
of 150 ms). A **long press that shows a Reset chip** is safe but slower: the fallback (Q2). A
**reset mark to tap** resets on a stray tap; it stays as the indicator. A **reset mode** is a
mode to forget (§T1607b on the lock toggle). If §T1610b (2) brings jump-to-touch back for a
control, its first tap would write, and that control takes the chip.

**Desk.** Right-click the control (on a board, in the Controls tab, on its own node): a short
`control` menu, menus-as-data, a new surface found by `data-control-node`: Reset, Set as
default, Reset all on this Panel, Set all as default on this Panel. Reset is disabled with its
reason when the control is at its default or driven. Right-click is what the owner asked for on
number fields (§T1033), and the node menu is at its row cap (§T1527b). Not double-click: §T1033
removed it, and a desk slider jumps to the pointer on press (`useDrag` writes on `pointerdown`),
so a double click would write two moves first. Keyboard: one keymap entry, `control.reset` on
the canvas selection (`inputFrom` selection as `nodeIds`, `when` `hasSelection`): selected
controls reset, a selected Panel resets its members. Both commands are in the palette. No
default key is proposed: a chord macOS and Chromium both leave alone has to be tried in the app.

AS BUILT. The tick is two notches, top and bottom of the track, so the caption and value
written inside a board slider's bar are never crossed; bright is the text colour, because the
signal colour is the fill it would vanish into. A toggle's dot sits in its corner, out of flow.
On a control's own canvas node the nearest marker wins: a right-click ON THE WIDGET opens the
control's menu, on the rest of the node the node's (whose menu is at its row cap). The chord is
`mod+alt+r`, beside GO and BACK, tried in headless Chromium; the menu prints no chord beside
Reset, because the chord acts on the canvas selection and the row on what was clicked. A
control-click, which is a right-click on a Mac, no longer moves a slider on its way to the menu.

## 3. Reset all

One rule for all of it: **nothing resets from one press.** One control takes two inputs on one
target (double tap) or in two places (menu, then row). All takes two places.

- **Phone.** A ↺ at the right end of the tab bar while a Panel tab shows, with the count, dim at
  zero. A tap opens a sheet: "Robot: 7 of 14 controls are away from their defaults", Reset 7,
  Cancel. The button sits mid-screen, not under ↺, and takes no tap for its first 400 ms, so a
  double tap on ↺ cannot go through. It resets the shown Panel, whole (not only the shown page),
  and only what that Panel publishes; a phone never resets the document. It asks because a
  phone has no undo (§V41: undo is per actor, and the page has no door to its own stack).
- **Desk.** The Controls tab's header, beside the pencil: ↺ with the count, opening a popover
  with the same sentence and one button. No second question: it is one undo group and ⌘Z puts
  every value back. With no Panel ("All controls") it means the document; otherwise the whole
  document is the palette's "Reset all controls".
- **Set as default** is the desk's alone (a phone recalls and resets; it never stores): the
  control menu, "Set all as default" in the board's edit toolbar (the pencil), the palette for
  the document. It changes no picture and is one undo group.

## 4. The write

Two DOMAIN commands, registered where `preset.recall` is, so `createDomainBus` (the headless
server, the e2e harness) has them; the editor's `control.*` are registered by the app only:

    control.reset       { nodeIds: NodeId[] } | { all: true }
    control.setDefault  { nodeIds: NodeId[] } | { all: true }
    control.resetAll, control.setAllDefaults   (AS BUILT: the whole document with no input,
                                                for the palette, which runs a command bare)

`nodeIds` holds controls and Panels; a Panel stands for its members (`panelMembers`). Each is
ONE `GraphPatch`: one revision, one undo group (split, as a recall is, so a drag's transaction
cannot swallow it), one audit entry under the actor. A driven control and a node that is not a
control are skipped by name. A reset that would change nothing is refused by name (the recall's
rule).

**The phone's wire** is one POST: `{ handle, values: { reset: true }, phase: "commit" }`, the
handle a control's or a Panel's. It sends the intent, not a value: the page resolves the default
against the document as it is NOW (why a recall carries a name and not an index). The vet takes
a published control or a remote Panel, `reset` alone, `true`, commit, and runs `control.reset`
as that phone. `PHONE_COMMANDS` gains that one; no phone write can spell `control.setDefault`.

**The snapshot** gains each control's default, clamped, and each `PhonePanel` a `handle`, its
node id. Publishing compares JSON, so Set as default republishes. The page draws a reset at
once from the default it holds; the next snapshot or a refusal (§T1526b) corrects it.

**At once.** The bus runs one command at a time. The first reset applies; a later one finds the
control already there and writes nothing, and `createPhoneWrites` drops it without a refusal
(its rule for a layer switch already in the state asked for). Two phones and the desk: one
revision, one audit entry, no sentence on any phone; a desk that came second is told the
control is already at its default. A reset against another hand's running drag: the last write
of each frame wins, as for any two hands on one control.

## 5. Slices

S2 and S3 are independent after S1 (disjoint paths); S4 needs S3.

1. **S1, the default and the two commands** (`controls.ts`, a domain module). The definitions
   change shape: gates, the catalogue walkers, E81 and E82 regenerated one at a time. ACCEPT on
   the real bus: a Slider 0..2 with default 1, moved to 1.7, then `control.reset`: it reads 1,
   the revision rose by one, the audit gained one `control.reset`, one undo gives 1.7. A Panel
   id resets its members and leaves another Panel's. A driven value is skipped by name. Nothing
   away: refused, revision unchanged. A version-1 file with value 1.1 loads with default 1.1.
   A Store of the whole node holds no default key. Mid-morph, the reset key resolves to its
   default at the next frame while a sibling key is still between its ends. `parameter.reset`
   on Value gives the same number. BUILT, with two things this list did not name: a control
   made from a parameter (`control.fromParameter`) is born at its default, and a preset whose
   target is a whole control holds only what a hand moves (§B261), so it cannot hold a default
   either. The two commands had no door until S2, which removed their entries from
   `COMMANDS_WITH_NO_INVOKER`.
2. **S2, the desk** (`src/editor/controls`, menus, keymap). ACCEPT, jsdom and one Playwright
   test: drag a slider on the Controls tab, the tick brightens; right-click, Reset: it reads the
   default, the audit gained exactly one `control.reset`, ⌘Z returns the dragged value. A wheel
   over the board, a drag, a click and a double click add none. ↺, then the popover's button:
   the Panel is home in one undo group. BUILT (`control-reset.test.tsx`,
   `src/tests/e2e/control-reset.spec.ts`). "ONE patch" is read in the browser from the saved
   document's revision. The palette lists all four commands; the two that act on a selection
   need one the palette cannot pass (it runs every command with empty input).
3. **S3, the phone's wire** (`phone-protocol`, `phone-snapshot`, `phone-writes`). ACCEPT,
   headless: the snapshot carries the defaults and the Panel's handle. A `reset` on a published
   slider runs `control.reset` as `remote-<phone>`, one audit entry; on a Panel's handle, that
   Panel only. A second key, a value that is not `true`, a `live` phase, a driven or unpublished
   control: refused by name. Already at default: nothing written, nothing refused. No write of
   any shape reaches `control.setDefault`.
4. **S4, the phone page.** ACCEPT in `src/tests/e2e/phone-touch.spec.ts` (touch-emulated
   Chromium, the real door, the real bus), the rules as bytes in `phone-page.test.ts`:
   (1) drag a slider off, double-tap it: the document reads the default and the door received
   exactly ONE write for it. (2) With every slider away, flick the tall board top to bottom,
   and twice in quick succession on one slider: zero writes. (3) One tap; two taps 800 ms
   apart; a tap on each of two neighbours; a 600 ms rest; a tap then a drag: no reset. (4) A
   pad's double tap: x and y in one write. (5) ↺, the sheet, Reset: one write with the Panel's
   handle, that Panel home, another untouched; a double tap on ↺ resets nothing. (6) Two phones
   double-tap one slider while the desk resets: one revision, no refusal shown. Red-verify by
   editing: a reset on a single tap fails (3); a cancelled touch counted as a tap fails (2).
   §T1609b's real-phone list gains the double tap and the tap that stops a fling.

## 6. Not in it (row text for the lead to number)

- **A LAYER'S FADER AND SWITCH RESET TOO.** A Layer on a board is not a control node and its
  opacity's default is the type's (1). Wanted: a default for it, drawn and reset like a slider.
- **RESET WITH A TIME.** Reset cuts. A fade home needs a morph record, and records live in a
  bank (`morphs`): say where a record without a bank lives, or make Reset all a bank's preset.
- **A PHONE UNDOES ITS OWN LAST PRESS.** Undo is per actor (§V41) and the phone page has no door
  to its stack. With one, Reset all could stop asking.
- **RESET ONE PAGE OF A PAGED BOARD.** Pages are derived on the phone (§T1610b (7)): it needs
  the desk to know pages, or a write naming several handles.
- **THE RESET SHEET LISTS WHAT IS AWAY**, each row resetting one control: the route with no
  gesture, and the only one for assistive technology (sliders are pointer-only).
- **SENTINEL-BOT: DEFAULTS FROM ITS TABLE, THE THREE `saved` BANKS GO** (§T1561b).
- **A PUBLISHED COMPONENT PARAMETER HAS AN AUTHORED DEFAULT**, as a TouchDesigner custom
  parameter on a component's page has: the same idea one level up.
- **A HARDWARE BUTTON RESETS** (Push: Delete and touch): MIDI learn onto `control.reset`.
- **DESK SLIDERS JUMP, PHONE SLIDERS DO NOT.** `control-widget.tsx` writes on `pointerdown`;
  decide whether the desk takes §T1607b's relative rule.
- **AGENT TOOLS** for the two commands, if S1's command-holder row does not already need them.

## 7. Questions for the owner

1. **When you press Reset, where should a control go?** DEFAULT (recommended): to a value the
   control remembers on purpose. It starts as whatever is in your file the first time you open
   it after this lands, and then changes only when you press "Set as default" on the desk;
   saving, reloading or a crash never moves it. OPENED: to wherever it was when the file was
   last opened; nothing to set up, but after a reload or a crash mid-show that is wherever you
   had left it.
2. **On the phone, how do you reset one slider or pad?** DOUBLE-TAP (recommended): two quick
   taps on it; a single tap still does nothing, a drag still drags, a flick still scrolls.
   HOLD: rest a finger on it for half a second, a small Reset button appears beside it, tap
   that; slower.
3. **Should "Reset all" on the phone ask first?** ASK (recommended): it says "Reset 7 controls
   on Robot" and you tap once more; a phone has no undo. NO: it resets at once.

Decided here without asking, to overrule if wrong: the word is "default"; a toggle has no
gesture of its own; a phone resets one Panel, never the document; a reset cuts, it does not
fade; a Button, a bank, a cue list and a Layer do not reset.

## Verified, and not

Read in the code: the control definitions and the board, the desk widget and pane, the phone
page, snapshot, vet and writes, the preset, morph and timed-cue modules, `parameter.reset` and
`parameter.revert`, both migration lanes, the menu and keymap tables, the e2e harness. NOT
verified: anything built or run; the double tap on a real phone; the fling-stop rule; what
`parametersFor` on three value nodes costs in the frame; how the `migrate` report reads on an
old file; TouchDesigner's menu wording; Lemur's manual; Ableton's double-click.
