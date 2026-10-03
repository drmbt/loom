# Presets follow-ups: a look's presets inside its component, and timeline cues

Rows: §T1505b and §T1508b. Written 2026-10-03 against main at `34fc4fb6`. Nothing here is built.

This builds on the landed presets system and on `docs/presets-scenes-layers-design-2026-09-29.md` (called "the base doc" below), including its §13 rulings and the second rulings (absolute morph clock, BACK fires, timeline cues as a later row). Each part gives the facts it rests on, a recommendation for every open question, the smallest slice worth building, the risks, a test plan, and the owner questions. Only questions the owner really has to answer are listed.

---

# Part 1: §T1505b, a look's presets inside its component definition

## 1.1 What exists

- **A bank is a root node, and everything finds it by type.** Store (`capturePresetValues`, `src/domain/presets/commands.ts:294`) and recall (`planPresetRecall`, `commands.ts:515`) resolve node names in the graph they are handed (`nodeByName`). Thirteen product files test `node.type === "presets"`. Among them are `requireBank` (`commands.ts:232`), shot expansion (`commands.ts:458`), the cue target (`cue-commands.ts:305`, `:484`), the rename clause (`src/domain/graph/names.ts:238`), the morph index (`morph-index.ts:101`), the Panel board (`controls.ts:259`) and the phone (`phone-snapshot.ts:247`).
- **The fade already reaches inside an instance.** A root bank that targets an instance's published key writes a record keyed by the instance's name. `buildMorphIndex` follows `publishedOrigins` from that key to every internal parameter it fans out to (`morph-index.ts:192` onward; built in `flatten.ts:1103`). §T1524b checked this on Dawn: a parent-bind Level reads exactly 0.5 at frame 30.
- **An instance stores its page in `node.parameters`** (`src/domain/components/instance.ts:10-19`). `setParameters` validates writes against the node's effective schema (`src/domain/commands/apply-patch.ts:680-711`). For an instance, that schema is the manifest `componentNodeDefinition` synthesizes from the published page (`src/domain/components/definition.ts:93-125`).
- **Per-instance overrides of internal nodes (`node.state.componentOverrides`, `instance.ts:23`) cannot be written.** No `GraphPatchOperation` writes `state` (`src/domain/types/patch.ts:25-103`), and nothing in the product writes it today.
- **Editing inside a definition happens in its own session.** That session has its own `GraphStore` and its own undo, and each commit is written back into the catalogue, where every instance sees it (`src/domain/components/session.ts:13-29, 57-70`). Definition commands such as publish or expose go to the registry and get no root undo (`src/domain/components/commands.ts:36-50, 415-427`). A preset bank inside a definition therefore already "works" in the session, but a recall there **rewrites the definition for every instance**. That is the wrong meaning for a performance.
- **A pulse inside a component fires with a flattened id** (`instance/inner`, `src/app/pulse-firing.ts:84-97`). `preset.recall { nodeId: "inst/bank" }` finds no root node and is refused. This is the gap §T1500b handed to this row.
- **Definitions travel.** Export/import (`component-file.ts`, with byte-level identity at `:92-94`) and cross-document paste (§T1493b) carry whole definitions, so anything stored in the definition graph travels at no extra cost. The headless MCP twin has no component catalogue at all (`src/mcp/serve.ts:245-246`).
- **`CommandContext` has no component catalogue.** The bus only has the node registry, so for an instance it sees the synthesized manifest and not the definition graph (`src/domain/commands/bus.ts` context fields). The app registers component commands with the catalogue at `src/app/app-runtime.ts:254`.
- No shipped example has a bank that targets a component instance (E82's banks target plain nodes), so no shipped document needs migrating.

## 1.2 The design

**The model in one sentence:** the preset *list* lives in the definition, so it travels; the *state* (`current`, running morphs) lives on each instance, so it is per-instance and undoable; and from the outside, **the instance is the bank**.

**Q1. Where does the bank live?** **Recommendation: an ordinary `presets` node inside the definition graph.** Do not add a definition-level field.
- Ruling 1's argument carries over unchanged. The JSON editor, the bank inspector section, the shape (`bank.ts`) and the parser are reused. Because the node is in the definition graph, export, import, paste and save carry it with no change to `GraphComponentDefinition` or to the component library schema.
- A bank inside a definition is a **page bank** when every token in its `targets` is `parent` or `parent.<key>` (Q2). Any other bank inside a definition stays what it is today: an authoring tool for the internals, used in the definition session with that session's undo.
- **v1 allows one page bank per definition.** A second one is a `validateComponentDefinition` warning that names both, and the first by node id is used. Addressing a specific bank as `city/looks` stays free for a later row.

**Q2. How does a preset name its targets?** **Recommendation: `parent` means the enclosing instance's published page, and `parent.<key>` means one published key.** This is the spelling §V81's `parent.<key>` binds already use. Preset values are keyed the same way: `{ "parent": { "tint": …, "speed": … } }`.
- The JSON shape does not change.
- A rename can never break it, because `parent` is not a node name.
- A preset holds only **published** keys. To reach an internal parameter, the author publishes it.
- A page bank whose targets name an internal node is not a page bank (see Q1). An instance's own overrides cannot be written by a patch (§1.1), so a per-instance write to an internal node is not possible without a new patch operation, and this design does not add one.
- A definition node actually *labelled* `parent` cannot be a page-bank target. The reserved word wins, and the warning names the node.

**Q3. Two instances of one definition: where do `current` and `morphs` live?** **Recommendation: on each instance, as two parameters the synthesized manifest adds.**
- When a definition has a page bank, `componentNodeDefinition` adds `presetCurrent` (string) and `presetMorphs` (code/json) to the instance's schema.
- Because they are in the schema, a recall writes them with `setParameters` in the **same patch** as the page values: one revision, one undo, one audit entry per instance. Paste carries them, `get_node` shows them, and §V66 validation passes.
- `component.publishParameter` refuses those two names.
- The inspector hides them from the page and shows the bank section instead (Q5).
- Morph records on an instance key their `from`/`to` by `parent`. `bankMorphRecords` (`morph-index.ts:101`) also reads instances' `presetMorphs` and maps `parent` to that instance's id **before** chaining. So a shot's record (keyed `city`, on a root shots bank) and the instance's own record (keyed `parent`) on the same key form one chain, as the base doc §5.3 requires.
- The two alternatives were rejected:
  - a hidden handle bank auto-created beside each instance doubles every address, and the presets no longer travel with the look;
  - `componentOverrides` needs a new patch operation, which changes the frozen contract.

**Q4. How does an instance recall from the outside?** **Recommendation: address the instance by its name, exactly as a bank is addressed today.**
- `preset.recall { nodeId: <instance id>, name }`, a cue `{ bank: "city", preset: "riot" }`, a shot `recalls: [{ bank: "city", preset: "riot" }]`, `recall_preset`, a Panel or phone strip naming `city`.
- One view, `bankOf(graph, catalogue, node)`, replaces the thirteen type tests. It returns:
  - the preset list (the node's own JSON, or the page bank's JSON from the definition);
  - the morph/curve defaults (from the inner bank, so they travel too);
  - the state holder and its keys: the bank node with `current`/`morphs`, or the instance with `presetCurrent`/`presetMorphs`;
  - the name map: `parent` → the instance's name.
- The planner translates `parent` before it lays out values. For an instance bank it does not apply the "bank holds values for itself" skip (`commands.ts:550`), because there the bank *is* the target.
- Renaming an instance keeps its cues with no change. The cue list's rename clause (kind 7, `names.ts:330-345`) rewrites `cues[].bank` for any renamed node, whatever its type. The bank clause (`names.ts:238`) does the same for a shot's `recalls[].bank`.
- The preset commands need the catalogue. Add it as a registration option, `registerPresetCommands(bus, { components })` and the same for cues, passed where `app-runtime.ts:254` passes it to the component commands. On a bus with no catalogue (the headless MCP twin), an instance-bank recall is refused by name with `preset.bank.noCatalogue`.
- **A pulse inside the definition** (the inner bank's `recall` driven by an expression, which is §T1500b's gap): `parameter.pulse` arrives with flattened id `inst/bank`, and the recall maps that prefix to the root instance and recalls there.
  - `select` is read from the **flattened** node, so an author who publishes the inner bank's `select` gets a per-instance "Look" field through the ordinary fan-out (§V80).
  - This is slice 2.
  - A **cue list** inside a definition stays refused by name. Its `current`/`standby` would be definition state shared by every instance, and a look carries presets, not a set list.
- **Nested instances** (a look inside another component) are not root nodes, and nothing at the root can write their page. Recalling one is refused by name in v1.

**Q5. Editing: in the definition or on an instance?** **Recommendation: Recall happens only on an instance. Store on an instance writes the definition. Hand-editing happens in the definition session.**
- **Store on an instance** captures the instance's page (`capturePresetValues` with the instance as the one whole target), rekeys it to `parent`, and writes the page bank's `presets` JSON into the definition through the same `commitDefinition` path that publishing uses (`components/commands.ts:415-427`). Every instance of that definition gains the preset, and it travels with the file.
  - **It has no root undo**, like every definition edit. The result says so, and Delete is the reverse.
  - This is owner question 1. The alternative is per-instance presets, which would be undoable but would not travel.
- **Inside the definition session** the inner bank's section shows the list, Delete, reorder and the morph fields, with the session's own undo.
  - Store and Recall there are refused by name ("store and recall from an instance"). There is no instance whose page could be captured or written, and a recall would rewrite every instance.
  - The inner bank's own `current`, `morphs` and `select` are labelled "per instance" and are not written there.

**Q6. Export, import, paste.**
- These need nothing new, because the page bank is part of the definition's content.
- A Store changes that content, so after it the identity rule (§T1395b) correctly treats a re-exported file as a *different* component: dropped into a project that holds the old version, it arrives as `city1`. That is the rule working as ruled, but it will surprise people, so the Store result names it.
- Pasting an instance carries `presetCurrent` and `presetMorphs`. Records from another session's epoch count as finished (base doc §5.4).

**Q7. Detach and upgrade.**
- **Detach** (`component.detach`) inlines the internals, so the page bank would become a root bank whose `parent` names nothing. In slice 2, detach rewrites it: each published key's value goes onto that key's internal `targets` (the mapping is in `definition.parameters`), and the instance's `presetCurrent` and `presetMorphs` go onto the bank. In v1, detach warns by name that the bank is now inert.
- **Upgrade** to a version without the preset: `presetCurrent` names a missing preset, and a recall is refused by name as it is today.

**Q8. Migrating from a bank beside the instance.** **Recommendation: keep both models, add an explicit command, and do no automatic migration.** Ruling 8's bank beside the instance stays valid: a bank may target anything, and it is the right tool for a set that spans several looks.
- `preset.moveIntoComponent { nodeId: bank }` (slice 2) applies when every value in the bank names one instance and nothing else (no `on`, no `recalls`, no other nodes). If anything else is named, it is refused, naming what stays beside.
- It does one definition write (the page bank, with values rekeyed to `parent` and presets merged by name; a name clash is refused) and **one root patch**. The root patch removes the bank beside the instance, copies its `current`/`morphs` to the instance, and points cues, shots and Panel items that named the bank at the instance.
- Undoing the root patch brings the bank beside the instance back, and the definition keeps its copy of the presets, which does no harm.
- No `SCHEMA_VERSION` bump. No shipped document is affected.

## 1.3 v1, the smallest useful slice

The goal: a look's presets are stored on one instance, recalled per instance, travel with the file, and play from a cue list.
1. `src/domain/presets/bank-view.ts` (new): `pageBankOf(definition)` and `bankOf(graph, catalogue, node)`. Replace the type tests in `commands.ts`, `cue-commands.ts`, `delete-command.ts`, `morph-index.ts` and `names.ts` with it. The UI and phone sites are slice 2, but each gets a test that fails while it still uses the bare type test.
2. `definition.ts`: synthesize `presetCurrent` and `presetMorphs`. `published-parameter.ts`: refuse those names.
3. `commands.ts` and `cue-commands.ts`: `parent` translation, the instance as state holder, the catalogue registration option, and the refusals for no catalogue, a nested instance, and Store/Recall inside a session.
4. `preset.store` on an instance writes the definition (owner question 1).
5. Inspector: an instance with a page bank shows `preset-bank-section.tsx` and hides the two synthesized keys.
6. Agent: `list_presets` lists instance banks (`src/agent/tools/presets.ts`).

**Slice 2:** Panel/board and phone membership (`controls.ts:259`, `phone-snapshot.ts:247`, `bank-join.ts`, `board-members.tsx`), the pulse from inside a definition, `preset.moveIntoComponent`, the detach rewrite.

## 1.4 Risks

- **Built but never wired.** Thirteen files test the type today. Any site that misses `bankOf` silently ignores instance banks. Mitigation: a gate under `src/domain/presets/` that greps `src/**` (excluding tests) for `=== PRESETS_NODE_TYPE` outside `bank-view.ts` and fails. It has to be added to `test:gates`, because it discovers its subjects with `readdirSync` (§V957, `gate-list.test.ts`).
- **Store has no root undo**, and it changes the component's identity (Q5, Q6).
- **Three builders of the morph index** (`compile.ts:921-922`, `flatten.ts:538/1103`, `render-harness.ts:792`). The `parent` mapping must sit inside `buildMorphIndex` and nowhere else, or the Dawn harness and the app will disagree. That is §B8's shape.
- **Synthesized keys on the page.** If the inspector does not hide them, every look grows two JSON fields.
- **The catalogue on the preset bus** is a new seam. `composition-seams` will not catch a missing option, so add a composed test that the app's bus can recall an instance bank.

## 1.5 Test plan

- Headless (`commands.test.ts`, `cue-commands.test.ts`): two instances `cityA` and `cityB` of one definition with a page bank.
  - Recalling `riot` on `cityA` gives one revision, one undo group and one `preset.recall` audit entry. Only `cityA`'s page and `presetCurrent` change; `cityB` stays byte-identical. One undo restores `cityA`.
  - Store on `cityA` adds the preset to the definition, after which `cityB` can recall it.
  - A cue `{bank: "cityA"}` fires as one patch. A shot that recalls `cityA` is one patch, and its own values win.
  - Renaming `cityA` rewrites the cue.
  - A recall on the headless twin is refused with `preset.bank.noCatalogue`.
- **The legitimate case the guard could swallow:** a definition bank that targets an internal node is *not* a page bank, and inside the definition session it still stores and recalls the internals with session undo.
- Travel: `component.export` (text) → `component.import` into a fresh document → recall on the new instance applies. A cross-document paste does the same.
- **Dawn, exact:** a definition holds a Level whose `brightness` is published. Recall on `cityA` with a 1 s linear morph from 0.2 to 0.8. At 60 fps, frame 30 reads exactly 0.5 on `cityA`'s output and exactly 0.2 on `cityB`'s, through the same harness as §T1524b's parent-bind test. A second test: a shots bank's record and the instance's own record on the same key chain together (the second recall continues from the on-screen value).
- Red-verify the `bankOf` gate by adding a bare type test, then restore it by editing.

## 1.6 Owner questions (§T1505b)

1. **Store on a look instance: should it write the component (every instance gets the preset and it travels with the file, but there is no undo — Delete is the reverse), or keep the preset on that one instance (undoable, but it does not travel)?** *Recommendation: write the component.* The whole point of the row is presets that travel.
2. **From outside, should the instance itself be the bank (cues, shots, Panel and phone name `city`), with one preset bank per component in v1?** *Recommendation: yes.* Several banks per look (`city/looks`, `city/fx`) can come later without breaking this.
3. **Should a bank beside the instance stay a first-class choice, with an explicit "Move presets into the component" command instead of automatic migration?** *Recommendation: yes.* It is still the right tool for a bank that spans several looks or layers, and no shipped document needs migrating.

---

# Part 2: §T1508b, timeline cues that an export reproduces

## 2.1 What exists

- **Three clocks are carried on every frame** (`src/domain/types/frame.ts:11-24`):
  - **timeline** `timeSeconds = frameIndex / fps`: wraps at the out point and jumps on a seek;
  - **absolute**: counts produced frames and is zeroed by a render;
  - **wall**.
- A morph runs on the absolute clock with an epoch, so an export never replays a live GO (base doc §5.4). `FrameClock` carries only `{ epoch, absTimeSeconds }` (`frame.ts:118-121`).
- **A seek replays from frame 0** (§V170, `src/app/timeline-scrubber.tsx:31-38`). A render resets the absolute clock, seeks to 0, and pre-rolls to the in point (`src/app/render-range.ts:205-218`). During a take, pulses that edit the document are blocked (`RENDER_BLOCKED_PULSE_COMMANDS`, `commands.ts:154`).
- **The resolver's seams for "outranks the stored slot":**
  - `drivers` (`resolve.ts:1137`);
  - `morphs` (`ParameterMorphs`: `keysOf` / `stepsAt` / `activeAt`, `resolve.ts:159-173`), which is the fold at `resolve.ts:897-905`.
  - The morph index is built per revision in three places (§1.4). `keysOf` feeds the values-only recompile (`frame-compile.ts:114-121`). `hasAnimatedParameters` asks whether any records exist (`graph-channels.ts:143-144`).
- **There is no keyframe system and no timeline track UI.** The timeline is a one-row strip in the header (`timeline-scrubber.tsx:11-24`). The audio track is placed on the same timeline (`src/app/use-audio-track.ts`), so a song position is in timeline seconds.
- **Layer on/off is the bypass flag**, which is structural. A driven structural parameter is refused at runtime (§T1014), and a layer's `picture` by name decides which chain gets compiled.

## 2.2 The design

**Q1. Where do cue times live?** **Recommendation: on the cues of the existing `cueList`, as an optional `at` (in timeline seconds), plus a new parameter on the list, `follow` (`live` | `timeline`, default `live`).**
- A list set to `timeline` *is* "the cue list as a pure function of the playhead" (ruling B). It is one concept for the operator: the set list, optionally clocked.
- **Why seconds:** they are the timeline's own time (`time` in expressions), they match the audio track, and they keep their musical position if the fps changes.
- `at` is absolute timeline seconds, not relative to the in point.
- A separate "cue track" node was considered and rejected. It would duplicate the list's JSON editor, its rename clause, its Panel and phone kinds and its agent tools, only to hold one more number per cue.
- **In `timeline` mode every cue needs `at`.** A cue without one is skipped, with a diagnostic on the list that names it. Mixing timed and manual cues in one list is owner question 3.

**Q2. The value at the playhead, and how fades are expressed.** **Recommendation: the morph fold from the base doc §5.3, run on `timeSeconds` instead of `absTimeSeconds`, with no epoch and no edit rule.** For each key that a timed cue covers:
- **Each cue's `to`** comes from planning that cue's recall without applying it: `planPresetRecall` as a cut, exposing its `after` map. It is computed per revision, so shots expand, ruling 4's skips apply, and an instance bank from Part 1 works the same way. The morph comes from the same ladder minus the recall's own rung: the cue's morph, else the preset's, else the bank's.
- **Before the first cue** that covers the key, the key shows the document's stored slot.
- **At `t`:** take the cues with `at ≤ t` on that key, in `at` order, and drop everything before the newest one that has finished. Start from that cue's `to`, or from the stored slot if none has finished. Then fold each remaining cue with `V = lerp(V, resolve(to_i), ease_i((t − at_i) / seconds_i))`.
  - A later cue that arrives mid-fade therefore continues from what is on screen, which is "from the previous cue's values at its time".
  - Both ends are resolved live, so an expression end keeps moving (ruling 2).
  - A morph of 0 cuts at `at`.
- **Implementation:** `buildMorphIndex` gains a second source of links, timeline links, and folds them in the same machinery, including the `publishedOrigins` fan-out into components. Its `stepsAt` returns timeline steps for a covered key once the playhead has passed the first cue, and otherwise the absolute-clock chain. One index, so all three builders get it, and `keysOf` and `activeAt` stay one set by construction.
- **Whether a cue has been reached** is decided by frame and computed once per revision: `frameIndex ≥ ceil(at·fps − 1e-9)`. Comparing `n/fps ≥ at` as floats can disagree by an ulp. Progress still uses `(timeSeconds − at)/seconds`.

**Q3. How a timed cue composes with manual GO, document values and live morphs.** **Recommendation: on a key it covers, the timeline outranks the stored slot and any live morph, from the first cue on that key until the list leaves `timeline` mode.** Drivers (`parent.` binds) still outrank everything, as now.
- A manual GO, a slider or the phone still **writes the document** as today. On a covered key the change does not show while the list follows the timeline. On every other key it shows normally, with its morph.
- So what plays is what exports. This is owner question 1. The alternative, the latest change wins, makes playback depend on when someone touched a fader, which an export cannot reproduce.
- Switching `follow` to `live` hands every key back to the document at the next frame. That is one parameter edit, and it is undoable.
- On a list in `timeline` mode, GO, BACK and fire are refused by name (`cue.timeline`, "this list follows the timeline; move the playhead"). Its stored `current`/`standby` are not written, because a document write per frame is forbidden (§V16).
- If two lists in `timeline` mode cover one key, they form one chain ordered by `at` (ties broken by list name, then position), and a warning names both.

**Q4. Seek, loop, scrub.** All three come from the timeline being a pure function of the playhead:
- after a seek, the frame shows the cues' state at that position;
- on each loop the cues replay, which is right on a timeline (and is exactly what the absolute clock exists to avoid for live morphs);
- a fade that crosses the out point is cut off by the wrap;
- a cue placed before the in point counts as already passed on every frame.
The seek itself still replays from frame 0 for feedback state (§V170). The cue values need no replay.

**Q5. What a timed cue cannot do.** **Recommendation: in v1, skip structural writes with a warning that names them.** This covers layer `on` (bypass), `compileTime` keys, and a layer's `picture` name. The planner already knows which keys are structural (`morphableKey`, `morph-index.ts:127`).
- A timed show fades layers that ship on at opacity 0, which is what E82 already does.
- Making on/off follow the playhead would need a compile keyed on which cue segment is active (recompiling at crossings, warmed by §T1507b's `compileLayerWarmPlan`). That is a separate row and owner question 2.
- Enums, strings and booleans that are not structural cut at `at`, through the same driver.

**Q6. Export determinism.**
- The renderer needs no change. A take steps the timeline from frame 0 (`render-range.ts:205-218`), and every timed value is a function of `(document, frameIndex)`.
- No command runs, and nothing is written: the document's revision is the same after an export as before.
- Live morphs still show their end state in an export, because a new epoch counts them as finished. A key that is both live-morphed and timed shows the timed value.

**Q7. What the operator sees.**
- **Inspector:** a covered parameter shows its **stored** value, which is the base doc §5.5's rule, with a chip "⏱ set" naming the list (in the "← Heat" chip's style, §T1514b). Hovering explains that the timeline drives it from cue N.
- **Store** captures stored values, not what is on screen. The chip makes that visible.
- **Cue list (inspector, Panel, phone):** `current` and `next` are derived from the latest frame's `timeSeconds`, and GO/BACK are disabled with their reason.
  - The phone republishes only when a cue is crossed, the same rule as `morphing` (§T1503b).
  - `FrameClock` gains `timeSeconds`, so surfaces and agents read one clock.
- **Bank strips** keep highlighting the stored `current`. While a list follows the timeline, they show a "timeline" mark instead of claiming a live preset.
- **Agent:** `list_cues` reports `follow`, each cue's `at`, and `timelineCurrent` at the page's clock. Timing is edited through `set_parameters` on the cues JSON.

**Q8. Editing UI, minimal v1.**
- The cue table (`cue-list-section.tsx`) gets an "At" column: seconds, shown as `m:ss.ff` at the project fps.
- Each row gets a "← playhead" button that writes the latest frame's `timeSeconds`. It is one patch, and the inspector is UI, so it may read the frame.
- A "Follow timeline" switch.
- **Slice 2:**
  - cue ticks on the header scrubber strip (still one row, so the header does not grow), where clicking a tick is one seek;
  - dragging a tick to retime its cue.

## 2.3 v1, the smallest useful slice

The goal: a cue list set to `timeline` drives the picture from the playhead, and an export reproduces it frame for frame.
1. `cue-list.ts`: `at?` on `Cue`, its parser, and a `cueReachedAt(fps)` helper. `cue-list.ts` node definition: the `follow` enum.
2. `commands.ts`: expose the planner's `after` map as a pure `presetRecallEnd(...)` that the index can call.
3. `morph-index.ts`: timeline links (Q2, Q3). `activeAt` returns true while a timeline list covers any key, so idle-skip renders the frame where a cue cuts (`src/runtime/execution/idle-skip-riders.test.ts`). `hasAnimatedParameters` counts a timeline list (`graph-channels.ts:143`).
4. `cue-commands.ts`: `cue.timeline` refusals. The `cue.list` query gains `timelineCurrent`.
5. `frame.ts` and `use-frame-loop.ts`: `FrameClock.timeSeconds`.
6. `cue-list-section.tsx`: the At column, "← playhead", the Follow switch. The inspector chip.

Panel and phone in timeline mode, and scrubber ticks, are slice 2. Structural cues are a separate row (owner question 2).

## 2.4 Risks

- **Three morph-index builders.** The timeline links must live inside `buildMorphIndex`, or the Dawn harness (`render-harness.ts:792`) renders something the app does not. That is §B8's shape.
- **Idle-skip.** A still document whose only motion is a timed cut must still render the crossing frame. `activeAt` has to say so. Test it.
- **Structural keys are skipped.** A show built on layer `on` will not play until the separate row lands. The warning has to be loud: it goes on the list and on each cue.
- **Operators may read the inspector's stored values as what is on screen.** The chip mitigates this. Store captures the document.
- **Cost:** per revision, one planner run per timed cue. Per frame, a binary search per covered key. Both are small next to the values-only recompile they ride on.

## 2.5 Test plan

- **Pure** (`morph-index` / new `timeline-cues.test.ts`):
  - before the first cue the value is the stored one;
  - a fade's progress is analytic, under every curve;
  - an interrupted fade continues from the on-screen value;
  - a cue is reached exactly on its frame (`at` = 0.1 s, 7/30 s);
  - a list in `live` mode contributes nothing (this is the legitimate case);
  - two lists on one key are ordered and the warning is raised;
  - a structural key in a timed cue is skipped by name.
- **Dawn, exact.** A Level with `brightness` stored at 0.2, 30 fps. Cue A at 1.0 s goes to 0.8 over 1 s, linear. Cue B at 2.5 s cuts to 0.4.
  - Frames 30, 45, 60 and 75 read 0.2, 0.5, 0.8 and 0.4.
  - Frame 45 rendered after a cold `seek(45)` is byte-identical to frame 45 of a play-through, and to frame 45 on the second lap.
  - Two exports of frames 0–90 are byte-identical.
  - The document's revision does not change across an export.
- **Precedence on Dawn.**
  - A live recall with a 1 s morph on the covered key, at frame 40: frames 41–60 equal the timeline-only render.
  - The same recall on an uncovered key fades as usual.
  - Switching to `live` at frame 50 shows the stored value at frame 51.
- **Bus.** GO, BACK and fire on a `timeline` list are refused with `cue.timeline`, and the document is untouched. `cue.list` reports `timelineCurrent`.
- **Red-verify.** Disable the timeline links in `buildMorphIndex`, watch the Dawn frame-45 claim fail, then restore by editing.

## 2.6 Owner questions (§T1508b)

1. **While a cue list follows the timeline, should it win on the parameters it covers, so that a fader, a GO or the phone moving one of them does not show until the list is switched back to live?** *Recommendation: yes.* Playback then equals the export. Letting the latest touch win makes a run depend on when someone touched a fader.
2. **Layer on/off, picture swaps and other structural settings in timed cues: should v1 skip them with a warning (timed shows fade layers that ship on at opacity 0, as E82 does), with a separate row to make them switch at cue times through recompiles at the crossings?** *Recommendation: skip in v1 and file the row.*
3. **Should a timed list be all timed (GO refused while it follows the timeline), with a show that needs a few manual cues running a second, live list beside it?** *Recommendation: yes.* Mixing both in one list makes "next" ambiguous, and GO cannot move the playhead without a seek that replays from frame 0.
