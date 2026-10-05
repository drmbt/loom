# Node names carry their kind: `kind_role`

T1593b. Owner's ruling, 2026-10-05. Phase 1 is built; phase 2 (the sweep of shipped names) is planned in section 10 and not started.

The owner's reason: "it's pretty damn hard that we need to zoom in and figure out, ah okay, this is this kind of operator". A new node is auto-named from its type (`blur1`), and then nearly every shipped node was renamed to a bare role (`dye1`, `lamp`, `pathx1`), which throws the identification away. TouchDesigner practice keeps the operator type in the name (`null_out`, `constant_color`), so a node says what it is on the canvas and inside every `op('…')`.

## 1. The rule

A node's name is its **kind**, one underscore, then its **role**.

| Name | Node type | Reads as |
| --- | --- | --- |
| `slider_lamp` | `slider` | the slider for the lamp |
| `light_lamp` | `light` | the light that is the lamp |
| `blur_diffuse` | `blur` | the blur that diffuses |
| `lfo_pathx` | `lfo` | the LFO driving path x |
| `kernel_joints` | `pointKernel` | the point kernel for the joints |
| `mesh_car01` | `meshFileIn` | the mesh file for car 01 |
| `comp_holo` | a component instance | the component used as the hologram |

Three forms conform, and no others:

| Form | Example | When |
| --- | --- | --- |
| `kind` | `blur` | a deliberate bare name |
| `kind<digits>` | `blur1`, `kernel12` | what auto-naming mints; the node has no role yet |
| `kind_<role>` | `blur_diffuse`, `lfo_path_x` | a named node |

## 2. The parts, the separator, the characters

- **Kind**: lowercase ASCII letters only. No digit, no underscore. One word per node type, from one table (section 3).
- **Separator**: exactly one underscore between kind and role.
- **Role**: letters, digits and underscores, starting with a letter or a digit. It may contain further underscores (`lfo_path_x`). Letters and digits are Unicode (`blur_größe`, `blur_ぼかし`): nothing in the reference grammar needs ASCII.
- **Nothing else.** A space, a comma, a dot, a colon or a hyphen in a name breaks one of the forms that hold names: a name list splits on spaces and commas (a Render's `lights`), a preset target is `name.key`, a legacy channel is `name:channel`. Today the document accepts such names and those references then fail quietly; a conforming name cannot hit that.
- **Case matters.** A name is an identifier. `Blur_soft` is a different name from `blur_soft` and does not conform.

Because a kind has no digit and no underscore, a name parses one way: the kind is everything before the first underscore, or before the trailing digits. `camerablur1` is a Camera Blur's auto-name and can never be read as a `camera`.

## 3. Where a kind comes from: one table

`NODE_KINDS` in `src/domain/graph/node-kinds.ts` maps every node type to its kind. The full table is section 13. 148 types, 132 distinct kinds, 59 of them different from the old base.

**Decision: one central table is the only source, not a field on each definition.** Reasons:

1. The kinds are one shared namespace, like TouchDesigner's operator type names. Whether two types may share a word is a property of the set, and it can only be reviewed as a list.
2. Everything that uses a kind is a pure function of `(name, type)`: auto-naming, the rename rule, the gate, the builders, the phase 2 sweep. With the table in the domain they need no registry in hand. `SOURCE_REFERENCE_PARAMETERS` is keyed by node type in the same folder for the same reason.
3. No node definition file is edited. Several are being changed by other sessions, and definitions stamped out by a factory would need plumbing for a field.

The cost is a second place to touch when adding a node type. It is one line, and it is enforced: the table is **total**, and `src/examples/node-names.test.ts` (on `pnpm test:gates`) fails by name when a registered type has no row, or a row names a type that is gone.

How each kind was chosen:

1. The type, lowercased, when that is one word: `blur`, `noise`, `feedback`.
2. A leading family word is dropped: `point…`, `value…`, `custom…`, `component…`, `render…`. The family is already drawn on the node (body wash, port colours); the kind names the operation. `pointKernel` → `kernel`, `valueMath` → `math`, `customWgsl` → `wgsl`.
3. A file input is named for its medium: `movieFileIn` → `movie`, `meshFileIn` → `mesh`.
4. A compound stays whole when no single word says it: `cornerpin`, `camerablur`, `personmask`.
5. Wherever possible the kind is the word the library shows as the title, so it can be found by typing it.

**Kinds are unique except for 11 declared families** (`KIND_FAMILIES`; a test holds the declaration equal to what the table actually shares, both ways). Two reasons a kind is shared, and no third:

| Why | Kind | Types |
| --- | --- | --- |
| Variants of one thing | `wgsl` | `customWgsl`, `customWgslMulti` |
| | `kernel` | `pointKernel`, `pointKernelAdvanced` |
| | `material` | `materialUnlit`, `materialPhong`, `materialPbr`, `materialGlass`, `materialWgsl` |
| | `in` | `componentIn`, `componentInPoints`, `componentInValue` |
| | `out` | `componentOut`, `componentOutPoints`, `componentOutValue` |
| The same operation on another payload, under the same title | `limit` | `limit`, `valueLimit` |
| | `slope` | `slope`, `valueSlope` |
| | `switch` | `switch`, `valueSwitch` |
| | `range` | `valueRange`, `pointRange` |
| | `transform` | `transform`, `pointTransform` |
| | `circle` | `circle`, `pointCircle` |

The second group is TouchDesigner's own model: a Transform TOP and a Transform SOP are both `transform1`. Members of a family are numbered in one sequence (`limit1`, `limit2`), so names stay unique.

**Two special cases.**

- A **component instance** is `comp`, whatever the component (`comp_holo`). The canvas already labels an instance "component" rather than repeating the component's own name (T639/T640), and a component's id is the user's own word, which could collide with a built-in kind.
- A component's **In and Out** are not bound by the convention. Their name is the label of the socket the component shows from outside (`boundary-ports.ts`), so `in_depth` would put the direction on the socket twice. They are auto-named with their kind (`in1`, `out1`), never prefixed on a rename, and the gate does not ask them to conform.

A type the table does not hold (a test fixture, a definition registered at runtime) falls back to the old base, `nameBaseFor(type)`.

## 4. Who names a node, and what each does

| Door | What it stores |
| --- | --- |
| A new node, no label | `kind` + the next free number: `blur1`, `kernel1`, `movie1`. An unrenamed node already conforms. |
| `node.rename` (the command) | The kind goes in front of a name that lacks it, and the result says so (`node.name.kind`). `exact: true` stores the name as given. `label: null` clears it. |
| The title editor | Calls `node.rename`. Section 6. |
| Agent `add_node` with `label`, and `rename_node` | Same rule. `data.name` in the result is the name that was stored. `exactLabel` / `exact` opt out. |
| A patch (`addNode.label`, `setNodeLabel`) | **Exactly what it carries.** A patch is replayable and its references were written against its own labels (§V324, §V325). |
| "Control from Panel" | `slider_brightness`, `toggle_flipU`, `xypad_pinTopRight`. The channel it publishes stays the bare word. |
| MIDI learn | `midiin1`, and `count_midi` for the press counter. |
| Paste, duplicate, detach, flatten | The copied name, renumbered when taken (`slider_lamp` → `slider_lamp1`). Still conforming. |
| A new component instance | Unnamed, as before. Open question 4. |

**Where the rule lives: in the command, not in each surface.** `node.rename` is the one door the title editor and an agent's rename both use (§V78), so the rule is stated once there. The patch operation underneath stays exact. The convention belongs to the act of naming, never to the replay of one.

**One function decides conformance**: `conformsToKind(name, kind)`. Beside it: `withKind(kind, role)`, `roleOf(name, kind)`, `roleFromText(text)` (free text to a role: `Bloom pass` → `Bloom_pass`), and `nameInKind(typed, kind)` / `conventionalName(typed, type)`, which is the rename rule:

- typed text that already conforms is taken as it is (`blur_soft`, `blur2`);
- text that conforms once cleaned is cleaned and not prefixed twice (`blur soft`, `Blur_soft` → `blur_soft`);
- anything else gets the kind in front (`soft` → `blur_soft`, `Bloom pass` → `blur_Bloom_pass`).

**Collisions.** The brief says a collision auto-numbers (§V129). The code has refused an explicit name that is taken since §V325, suggesting the free neighbour, and the existing tests hold that. I kept it: the refusal now reads `the name "slider_lamp" is already in use. "slider_lamp2" is free.` Auto-numbering still applies to names the app mints. Open question 1.

**References.** A rename still rewrites every stored reference in the same patch (§V128), now to the prefixed name. Tested through the real bus: `op('slider1')` becomes `op('slider_lamp')`.

## 5. Stored names never move

A kind is read when a name is **minted** or **checked**. It is never read when a document is loaded. Changing a row in the table changes what the next new node is called and what the gate asks of shipped files. It rewrites nothing.

A Point Kernel auto-named `pointkernel1` last week is still `pointkernel1`, every reference to it still resolves, and the next one added beside it is `kernel1`. This is tested (`node-naming.test.ts`, "a stored name never moves when a kind changes").

No migration, no schema bump, and no shipped example's bytes change in phase 1: `sync.test.ts` and `component-sync.test.ts` stay green on `pnpm test:gates`.

## 6. The title editor

The only place a person types a node name is the title on the canvas (double-click, `n`, or Rename… in the menu, which all open the same field). **The inspector has no name field** and the palette has no rename prompt; both show or open the title editor. If an inspector field is added later it must call `node.rename` and should reuse this field.

**What I chose.** The field is two parts that read as one: the kind and its underscore as fixed text (`slider_`), then the input, which holds the role alone (`lamp`). One border, one background.

- It opens on the role: `lamp` for `slider_lamp`; empty for an auto-name, because `blur1` has no role yet; the whole cleaned name for one that does not carry its kind.
- A space becomes an underscore **as it is typed**, so the field shows the name that will be stored.
- Typing a name that already carries the kind (`slider_lamp`, `slider2`) is taken as it is.
- With the kind kept and no role typed there is nothing to rename to, and the name stays.

**Removing the kind is possible and deliberate.** The fixed part is a toggle:

- **Backspace** with the caret at the very start of the role switches it off. It has to be a fresh press: a held key that has just emptied the role stops at the kind.
- A **click** on the kind does the same, and a second click brings it back.
- Off, the kind stays on screen, struck through, and the name is stored exactly as typed (`exact: true`). Spaces are spaces again.

**Why this and not the alternatives.**

- *A modifier on Enter* (say Alt+Enter stores the name bare): invisible until known, and the field would show one name while storing another.
- *A separate clearable chip with an ×*: more chrome in the most crowded row in the app, for an act that should be rare.
- *Backspace at the start* is the key someone presses when they want what is left of the caret gone, so the gesture already means this. Requiring a fresh press keeps "clear the role" and "drop the kind" apart.

**Enter and blur differ in one case.** For a name that does not carry its kind yet (`dye1` on a Feedback), the field opens showing `feedback_` in front of `dye1`. Enter is an answer and gives it the kind. Leaving the untouched field renames nothing: opening a field and clicking away is not an edit, and must not rewrite references (§V33). Everywhere else Enter and blur both commit, as before.

**Not verified in a browser.** jsdom paints nothing. The tests hold the behaviour (25 cases in `node-rename.test.tsx`), not the look. The kind is styled to give up its room before the input and never take more than half the name slot, and that claim needs a look in a real browser on a 178 px node, with a long kind such as `camerablur_`.

## 7. The gate and its ledger

`src/examples/node-names.test.ts`, on `pnpm test:gates`. It reads the shipped bytes of every `.loom.json` under `examples/`, `examples/components/` and `projects/`: the root graph and every component graph the file embeds. A named node whose name does not carry its type's kind fails it.

Not counted: an unnamed node, and a component's In and Out.

Phase 1 renames nothing, so the files written before the rule are in `NOT_YET_RENAMED`, each with the **exact number** of names it still owes. It is a count, not an allow-list, and it is checked both ways:

| Situation | The gate says |
| --- | --- |
| A file not on the ledger has a non-conforming name | names each node, its type and the kind it wants; a new document does not go on the ledger |
| A listed file now conforms | remove its line |
| A listed file's count went down | lower its line to N |
| A listed file's count went up | a non-conforming name was added to an old file; name the new node `kind_role` |
| A line names a file that is not shipped | remove the line |

Today, under the new kinds:

| Set | Files | Named nodes the rule binds | Not conforming |
| --- | --- | --- | --- |
| `examples/` | 74 | 1,799 | 1,732 |
| `examples/components/` | 12 | 53 | 50 |
| `projects/` | 26 | 1,541 | 1,515 |
| **Total** | **112** | **3,393** | **3,297** |

106 files are on the ledger. The 6 that are not have no named nodes at all.

The brief's figure was 1,714 named and 1,653 non-conforming. That counted the root graphs of the examples only, against the old bases. This table also counts embedded component graphs and the projects, against the new kinds, so the numbers are not comparable line for line.

The same file also holds the kind table total over the catalogue, both ways.

Red-verified on the real set by editing: one ledger line raised, one lowered, one removed, and one kind row removed. Each failed with the instruction above. The gate's own cases also run on hand-built files, so a red result there is about the gate.

## 8. The canvas

**Built: the type label hides when the name carries its kind.** T416 shows the type beside the name once a rename has spent the identification. It used to hide only for `kind<digits>`. It now asks `conformsToKind`, so `blur_diffuse  Blur` never shows the same word twice, and a name without its kind (`Bloom pass`) still gets the label. A small change: one line, the one function. The setting that hides the label entirely is unchanged.

For a family kind the label also hides (`material_floor` no longer shows "Material · PBR"). The variant stays on hover and in the inspector's type badge. If the variant matters at a glance, the fix is to show the label when the kind is shared and the titles in the family differ; I did not build that.

**Not built: reading a node at low zoom.** This is the owner's actual complaint, and the name convention does not solve it alone. Measured from the CSS: a node is 178 px wide and its header text is 11 px (`--fs-meta`), the type label 10 px. At 50 % zoom the name is 5.5 px tall; at 25 % it is under 3 px. Below roughly 70 % nothing in the header can be read, whatever it says. The canvas zooms out to 5 %.

What would help most, in order:

1. **A kind label that does not shrink.** Below a zoom threshold, draw the kind over the node's header band at a constant on-screen size. Mechanism: the canvas writes its zoom into one CSS variable on its container (one write per zoom change, no per-node React render, §V16), and the label's size is `calc(11px / var(--canvas-zoom))`. It is an overlay, so no node box changes (§V389). Two tiers: kind alone when far out, `kind_role` closer in.
2. **The kind in a heavier weight inside the name** (`**blur**_diffuse`), at every zoom. Cheap, but it only helps where text is already legible.
3. **Colour by kind family.** T712 already washes the body by payload family; that is what reads at 10 % zoom, and it could be strengthened at low zoom.

I implemented none of these. Each is a visual judgement that needs a real browser and the owner's eye, and item 1 touches how every node renders.

## 9. Judgement calls in the kind table

Each of these could reasonably go the other way.

| Call | Chosen | Alternative | Why |
| --- | --- | --- | --- |
| Same title on another payload | shared kind (`limit`, `slope`, `switch`, `range`, `transform`, `circle`) | invent a word (`clamp`, `ring`, `xform`) | The kind should be the word the library shows. TouchDesigner shares these names. Cost: the name alone does not say texture or value; the node's wash does. |
| The five materials | one family, `material` | `unlit`, `phong`, `pbr`, `glass` (TouchDesigner's MAT names) | Their titles are "Material · X". A look moved from Phong to PBR keeps its name. Cost: the name does not say the shading model. |
| `customWgsl` and its multi-input form | one family, `wgsl` | `wgsl` and `wgslmulti` (TouchDesigner has `glsl` and `glslmulti`) | Same reasoning as materials. |
| Component instance | `comp` | the component's own name (`depthpoints_holo`) | Short, stable, cannot collide with a built-in kind. Cost: the name does not say which component. |
| `geometry` | full word | `geo` (TouchDesigner's default) | The ruling asks for the full kind word. It is the most common scene node (342 shipped). |
| `output` / component `out` | `output` and `out` | `out` for both | Different things. Every shipped Output is named `out1` today; phase 2 makes it `output1`. |
| `pointCircle` | `circle`, shared with the texture Circle | `ring` | Same shape on points. |
| Point shapes | `grid`, `line`, `sphere`, `tube`, `torus`, `box` | keep `pointgrid` … | The ruling's own example drops `point` (`kernel`, not `pointkernel`). These are TouchDesigner's POP names. |
| `renderPoints` / `renderInstances` / `renderSurface` | `points`, `instances`, `surface` | one family `render` | Named for what they draw; distinct. `surface` may be confused with a surface material in the projects. |
| `pointGenerator` | `generator` | `points` (taken by Render Points) | |
| `textureToAttribute`, `pointsFromTexture` | `texattr`, `texpoints` | `sample`, `fromtexture` | Abbreviated from the titles, as TouchDesigner does (`topto`, `hsvadj`). The least natural words in the table. |
| `audioPattern` | `pattern` | `audiopattern` (12 letters) | Too long. Cost: loses the `audio…` family with `audioin`, `audiofile`. |
| `audioFileIn` | `audiofile` | `audio` | `audio` alone would not say which of three audio sources. |
| `annotate` | `note` | `annotation` | Every shipped one is already named `note…`. |
| `filmGrade`, `cameraBlur`, `personMask`, `cornerPin`, `gridWarp`, `crtTube`, `slitScan`, `channelIn`, `cueList`, `xyPad`, `laserPath` | kept whole | `grade`, `person`, `pin`, `warp` … | No single word says it without ambiguity. `grade` is also a common role on other kinds. |
| Unicode in roles | allowed | ASCII only, as TouchDesigner | No reference form needs ASCII. |

## 10. Phase 2: the sweep (planned, not started)

Rename every shipped name to `kind_role`, rewrite every reference, regenerate, empty the ledger.

### 10.1 What carries a name

In the **document sources** (the only files edited by hand):

| What | Where | Size |
| --- | --- | --- |
| `label:` literals | `src/examples/documents/*.ts` | 1,410 in 68 of 71 files |
| | `src/examples/starter-components.ts` | 111 |
| | `src/projects/**` | 350 in 24 files (furnace 59, on-nothing 259, sentinel-bot 32) |
| Labels built from a template (`` `${label}1` ``) | mostly `src/projects/**` | 78; these need hand edits, not a string swap |
| `op('…')` in expression sources | examples, starter components, projects | 158 + 5 + 56 literals, plus strings built in code |
| Name parameters: Feedback `source`, Geometry `material`, Render `scenes` / `camera` / `lights` / `projectors`, the point renderers' and Camera Blur's `camera`, a Layer's picture, a Window Out's input | the same sources | not counted; often built from arrays of labels |
| Preset banks: `targets`, and the bank JSON keyed by node name (`values`, `on`, `recalls.bank`, morph records) | 3 shipped banks | |
| Cue lists: each cue's `bank` | 1 | |
| Panel boards: `member` | 5 stored boards | |

Every one of these reference kinds is a clause of `rewriteNodeNameReferences` (expressions, legacy channels, source references, preset banks, panel boards, cue lists). The sweep must apply **the same semantics to the sources**: the same token rules for lists, only the part before the dot in a target, never a preset or cue name that happens to share a spelling.

Outside the sources:

| What | Checked by | Size |
| --- | --- | --- |
| `.md` claims, fenced `name(type)` lines | `doc-drift.test.ts` | 181 lines in 54 of 74 files |
| Names in `.md` prose and `op('…')` in `.md` | `doc-claims.test.ts` | 6 `op('…')`; prose not counted |
| `examples/README.md` | `readme.test.ts` | 1 `op('…')` |
| Tests that address a shipped node by name | themselves | 26 files under `src/examples` and `src/projects` (8 need a GPU); up to 21 more elsewhere read a shipped document |
| Project render scripts and shot files that set a parameter by label | not gated | `src/projects/*/render.ts`, `director.ts`, `shots/*.ts`, `edl.json`; to be read, not assumed |
| Playwright specs that find a node by its text | themselves | not counted |
| The ledger | the gate | 106 lines, all removed |

**Thumbnails do not carry names.** `thumbnails.test.ts` checks existence and size only, and a correct rename changes no pixel. They need no regeneration. They are the cheapest proof the sweep cut nothing: an example that renders differently afterwards has a reference that was missed.

Not touched: a user's saved documents (section 5), and a saved project's own copy of a starter component, which wins over the shipped one on load.

### 10.2 How each role is derived

I ran a draft of these rules over all 3,297 names (read-only, in the scratchpad; the tool itself is phase 2 work). Every name got a conforming proposal.

| Rule | What it does | Example | Names |
| --- | --- | --- | --- |
| **R1** | The old habit was label = id + `1`. The id is the author's own word for the role. | id `dye`, `dye1` on a Feedback → `feedback_dye`; `pathx1` on an LFO → `lfo_pathx` | 2,508 (76 %) |
| **R1′** | Otherwise strip the trailing number. | `noteBanks` → `note_…` (then R2) | 275 |
| **R2** | A role that restates the kind loses the restating word. If nothing is left, the name is `kind<n>`. | `out1` on an Output → `output1`; `cam1` → `camera1`; `wallgrid1` → `grid_wall`; `matfloor1` → `material_floor`; `halolvl1` → `level_halo` | 514, about 199 distinct (type, name) pairs |
| **R3** | Never two nodes under one name in a graph: keep the old number when stripping would collide. | `renderpoints2` → `points2`; `soften1`, `soften2` keep their digits | 117 of the above |

So `out1` on an Output becomes **`output1`**, not `output_out`: a role that only repeats the kind is no role.

R2 needs a small table of the words authors used for each kind (`geo`, `mat`, `cam`, `lvl`, `pts`, `proj` …). It is a draft and it is where the judgement lies. The sweep tool should **print a review table, old → new with the rule that produced it, before writing anything**, and a person reads the R2 rows. Cases a rule cannot decide:

- **Single letters left over**: `slag1` → `lag_s`, `clim1` → `limit_c`, `pstep1` → `step_p`. Technically right, unreadable. They need real roles.
- **Case of what is left**: `camA1` → `camera_A`, `projL1` → `projector_L`, `noteBanks` → `note_Banks` or `note_banks`.
- **A role that is a synonym, not a restatement**: `shot1` on a Render (43 of them). I would keep `render_shot`; `render1` loses the author's word.
- **Authors' own type words that are now another kind**: `surf1` on a Material · WGSL (19) → `material_surf`, while `surface` is the kind of Render Surface.
- **Names with an inner underscore already**: `mesh_car01`, `lens_dof1`, `place_car11`. The first conforms once the trailing `1` goes (`mesh_car0`).
- **The trailing digit that is part of the word**: `streak01` is id `streak0` plus the habit's `1`, so `wgsl_streak0`; `key11` is `key1` + `1`. R1 handles these because it reads the id, but a name whose id is not its label needs a look.
- **Component instances**: `holo1` → `comp_holo`, `analysis1` → `comp_analysis`.
- **Unnamed nodes** (81 in the root graphs, 249 counting the component graphs files embed, most of them a component's In and Out): leave them. The gate does not count them.

### 10.3 Order

One example at a time, per CLAUDE.md, because an unscoped regeneration sweeps other sessions' work.

1. Land the sweep tool and its review table. No document changes. The owner or lead reads the R2 rows.
2. **Starter components first** (12 files, `--only <ComponentName>`). Examples embed copies of them, so they must be settled before the examples that carry them.
3. **Examples that embed a component**, each: edit the source, regenerate `--only E<n>`, fix its `.md` claims, run its own tests by name, lower or remove its ledger line, commit source, JSON, `.md` and ledger together.
4. **The remaining examples**, the same way, in batches by owning track so no batch crosses a session's in-flight document.
5. **Projects**, through each project's own `build.ts`: furnace (1 document), on-nothing (25 documents from one source tree, so one edit moves 25 ledger lines), sentinel-bot (owned by another session; coordinate).
6. The ledger is empty. Keep the gate and the empty map: from then on every shipped name conforms with no exceptions.

Per example the proof is: `sync.test.ts` (bytes match source), `doc-drift.test.ts`, `reference-integrity.test.ts` (no `op('…')` names a node that is not there), and the example's own claims test where it has one. The GPU claims tests are the proof that nothing was cut, and should run for the examples a batch touched, not for all.

### 10.4 Size

| | Files |
| --- | --- |
| Document sources | about 93 (68 + 1 + 24) |
| Generated `.loom.json` | 106 |
| `.md` | 54, up to 74 |
| Tests | 26, up to about 47, plus Playwright specs not yet counted |
| README, docs, the ledger | about 4 |
| **Total** | **roughly 290 to 330 files, 3,297 names** |

## 11. Open questions

1. **Collisions.** The brief says auto-number; the code refuses an explicit name that is taken and suggests the free one (§V325). I kept the refusal. Is that right, or should the title editor take the suggestion on a second Enter?
2. **The six cross-payload families** (`limit`, `slope`, `switch`, `range`, `transform`, `circle`). Shared as in TouchDesigner, or distinct words?
3. **`material` as one family**, or a kind per shading model?
4. **Component instances.** `comp`, or the component's own name? And should a new instance be auto-named (`comp1`) instead of staying unnamed, so it can be addressed by `op('…')` from the start?
5. **In and Out.** Exempt as built, or `in_depth` with the socket label taken from the role? The second changes how sockets are labelled and must not move a published socket name.
6. **Performance surfaces show node names.** A Presets bank, a Layer and a Cue List are captioned by their node name on a Panel board and on the phone, and the Layers view titles each layer the same way (`controlNameOf`). After the sweep they read `presets_looks`, `layer_graphic`, `cuelist_set` on stage. I recommend those surfaces show the role (`looks`, `graphic`, `set`). Sliders, toggles, buttons and pads are not affected: they show their Caption, or else their channel.
7. **Starter component versions.** Renaming a shipped component's internal nodes changes its definition but nothing addressable from outside. Bump the version or not? I would not.
8. **`apply_graph_patch`.** A label in a patch is stored exactly. Should the agent tool add a warning when one does not conform? Not built.
9. **The low-zoom kind label** (section 8). Wanted?
10. **The kind words in section 9**, especially `texattr`, `texpoints`, `pattern`, `geometry`, `points`.
11. **The R2 word table and the single-letter leftovers** (section 10.2) need a person.
12. **sentinel-bot.** Its ledger line (43) will move when that session's in-flight document change lands; the gate will say so and name the new number.

## 12. TouchDesigner: what was checked and what was not

Read from Derivative's documentation:

- The [OP class](https://docs.derivative.ca/OP_Class) gives an operator a `name` ("Get or set the operator name"), a read-only `base` ("the beginning portion of the name occurring before any digits") and read-only `digits` ("the numeric value of the last consecutive group of digits in the name"). TouchDesigner itself models a name as a base plus digits, which is our `kind<digits>` form.
- Derivative hosts a community tutorial, [Naming Things in TouchDesigner](https://derivative.ca/community-post/tutorial/naming-things-touchdesigner/71482), whose summary is the problem this row is about: "Ever looked at an old project and tried to figure out wtf `op('../base4/null1['chan1']` means?" The tutorial is a video; I could read only its summary.

**Not read from a page**, and stated here from common practice and the owner's own description: that a new operator is named type plus number (`noise1`); that names are limited to letters, digits and underscores; the `null_out` / `constant_color` habit; and the default names used as a guide in section 9 (`glsl`, `glslmulti`, `geo`, `phong`, `pbr`, `topto`, `hsvadj`). The OP class page does not state the allowed characters. Treat these as recollection until someone checks them in the application.

## 13. The table

Generated from `NODE_KINDS`. The code is the source; this is a snapshot of 2026-10-05. "Before" is what a new node of that type was auto-named until now.

| Type | Library title | Kind | A new node | Before | Note |
| --- | --- | --- | --- | --- | --- |
| **generator** | | | | | |
| `solid` | Solid | `solid` | `solid1` | same |  |
| `noise` | Noise | `noise` | `noise1` | same |  |
| `ramp` | Ramp | `ramp` | `ramp1` | same |  |
| `uv` | UV | `uv` | `uv1` | same |  |
| `checker` | Checker | `checker` | `checker1` | same |  |
| `circle` | Circle | `circle` | `circle1` | same | family |
| `rectangle` | Rectangle | `rectangle` | `rectangle1` | same |  |
| `matte` | Matte | `matte` | `matte1` | same |  |
| `personMask` | Person Mask | `personmask` | `personmask1` | same |  |
| `text` | Text | `text` | `text1` | same |  |
| **shader** | | | | | |
| `customWgsl` | Custom WGSL | `wgsl` | `wgsl1` | `customwgsl1` | family |
| `customWgslMulti` | Custom WGSL · Multi | `wgsl` | `wgsl1` | `customwgslmulti1` | family |
| **output** | | | | | |
| `output` | Output | `output` | `output1` | same |  |
| `syphonOut` | Syphon Out | `syphonout` | `syphonout1` | same |  |
| `window` | Window Out | `window` | `window1` | same |  |
| `ndiOut` | NDI Out | `ndiout` | `ndiout1` | same |  |
| `spoutOut` | Spout Out | `spoutout` | `spoutout1` | same |  |
| `oscOut` | OSC Out | `oscout` | `oscout1` | same |  |
| `laserOut` | Laser Out | `laserout` | `laserout1` | same |  |
| **filter** | | | | | |
| `transform` | Transform | `transform` | `transform1` | same | family |
| `flip` | Flip | `flip` | `flip1` | same |  |
| `mirror` | Mirror | `mirror` | `mirror1` | same |  |
| `crop` | Crop | `crop` | `crop1` | same |  |
| `tile` | Tile | `tile` | `tile1` | same |  |
| `cornerPin` | Corner Pin | `cornerpin` | `cornerpin1` | same |  |
| `gridWarp` | Grid Warp | `gridwarp` | `gridwarp1` | same |  |
| `blur` | Blur | `blur` | `blur1` | same |  |
| `edge` | Edge | `edge` | `edge1` | same |  |
| `convolve` | Convolve | `convolve` | `convolve1` | same |  |
| `displace` | Displace | `displace` | `displace1` | same |  |
| `remap` | Remap | `remap` | `remap1` | same |  |
| `slope` | Slope | `slope` | `slope1` | same | family |
| `streak` | Streak | `streak` | `streak1` | same |  |
| `halo` | Halo | `halo` | `halo1` | same |  |
| `lens` | Lens | `lens` | `lens1` | same |  |
| `flare` | On-Axis Flare | `flare` | `flare1` | same |  |
| `crt` | CRT | `crt` | `crt1` | same |  |
| `crtTube` | CRT Tube | `crttube` | `crttube1` | same |  |
| `cameraBlur` | Camera Blur | `camerablur` | `camerablur1` | same |  |
| `depth` | Depth | `depth` | `depth1` | same |  |
| `pose` | Pose | `pose` | `pose1` | same |  |
| **color** | | | | | |
| `level` | Level | `level` | `level1` | same |  |
| `hsv` | HSV | `hsv` | `hsv1` | same |  |
| `threshold` | Threshold | `threshold` | `threshold1` | same |  |
| `limit` | Limit | `limit` | `limit1` | same | family |
| `lookup` | Lookup | `lookup` | `lookup1` | same |  |
| `reorder` | Reorder | `reorder` | `reorder1` | same |  |
| `premultiply` | Premultiply | `premultiply` | `premultiply1` | same |  |
| `filmGrade` | Film Grade | `filmgrade` | `filmgrade1` | same |  |
| **composite** | | | | | |
| `composite` | Composite | `composite` | `composite1` | same |  |
| `cross` | Cross | `cross` | `cross1` | same |  |
| `over` | Over | `over` | `over1` | same |  |
| `add` | Add | `add` | `add1` | same |  |
| `multiply` | Multiply | `multiply` | `multiply1` | same |  |
| `screen` | Screen | `screen` | `screen1` | same |  |
| `difference` | Difference | `difference` | `difference1` | same |  |
| `mask` | Mask | `mask` | `mask1` | same |  |
| `layer` | Layer | `layer` | `layer1` | same |  |
| **temporal** | | | | | |
| `feedback` | Feedback | `feedback` | `feedback1` | same |  |
| `cache` | Cache | `cache` | `cache1` | same |  |
| `echo` | Echo | `echo` | `echo1` | same |  |
| `slitScan` | Slit Scan | `slitscan` | `slitscan1` | same |  |
| **points** | | | | | |
| `pointKernel` | Point Kernel | `kernel` | `kernel1` | `pointkernel1` | family |
| `pointRay` | Ray | `ray` | `ray1` | `pointray1` |  |
| `textureToAttribute` | Texture To Attribute | `texattr` | `texattr1` | `texturetoattribute1` |  |
| `renderPoints` | Render Points | `points` | `points1` | `renderpoints1` |  |
| `pointGenerator` | Point Generator | `generator` | `generator1` | `pointgenerator1` |  |
| `pointGrid` | Grid Points | `grid` | `grid1` | `pointgrid1` |  |
| `pointLine` | Line Points | `line` | `line1` | `pointline1` |  |
| `pointCircle` | Circle Points | `circle` | `circle1` | `pointcircle1` | family |
| `pointSphere` | Sphere Points | `sphere` | `sphere1` | `pointsphere1` |  |
| `pointTube` | Tube Points | `tube` | `tube1` | `pointtube1` |  |
| `pointTorus` | Torus Points | `torus` | `torus1` | `pointtorus1` |  |
| `pointBox` | Box Points | `box` | `box1` | `pointbox1` |  |
| `pointsFromTexture` | Points From Texture | `texpoints` | `texpoints1` | `pointsfromtexture1` |  |
| `renderInstances` | Render Instances | `instances` | `instances1` | `renderinstances1` |  |
| `renderSurface` | Render Surface | `surface` | `surface1` | `rendersurface1` |  |
| `pointTopology` | Topology | `topology` | `topology1` | `pointtopology1` |  |
| `meshFileIn` | Mesh File In | `mesh` | `mesh1` | `meshfilein1` |  |
| `pointGather` | Gather | `gather` | `gather1` | `pointgather1` |  |
| `pointProximity` | Proximity | `proximity` | `proximity1` | `pointproximity1` |  |
| `pointRange` | Range | `range` | `range1` | `pointrange1` | family |
| `pointTransform` | Transform | `transform` | `transform1` | `pointtransform1` | family |
| `laserPath` | Laser Path | `laserpath` | `laserpath1` | same |  |
| `pointKernelAdvanced` | Point Kernel (Advanced) | `kernel` | `kernel1` | `pointkerneladvanced1` | family |
| **utility** | | | | | |
| `null` | Null | `null` | `null1` | same |  |
| `switch` | Switch | `switch` | `switch1` | same | family |
| `annotate` | Annotation | `note` | `note1` | `annotate1` |  |
| **component** | | | | | |
| `componentIn` | In | `in` | `in1` | `componentin1` | family, socket-named |
| `componentOut` | Out | `out` | `out1` | `componentout1` | family, socket-named |
| `componentInPoints` | In (points) | `in` | `in1` | `componentinpoints1` | family, socket-named |
| `componentOutPoints` | Out (points) | `out` | `out1` | `componentoutpoints1` | family, socket-named |
| `componentInValue` | In (value) | `in` | `in1` | `componentinvalue1` | family, socket-named |
| `componentOutValue` | Out (value) | `out` | `out1` | `componentoutvalue1` | family, socket-named |
| **value** | | | | | |
| `lfo` | LFO | `lfo` | `lfo1` | same |  |
| `constant` | Constant | `constant` | `constant1` | same |  |
| `timer` | Timer | `timer` | `timer1` | same |  |
| `analyze` | Analyze | `analyze` | `analyze1` | same |  |
| `mouse` | Mouse | `mouse` | `mouse1` | same |  |
| `channelIn` | Channel In | `channelin` | `channelin1` | same |  |
| `valueMath` | Math | `math` | `math1` | `valuemath1` |  |
| `valueLimit` | Limit | `limit` | `limit1` | `valuelimit1` | family |
| `valueSelect` | Select | `select` | `select1` | `valueselect1` |  |
| `valueSlope` | Slope | `slope` | `slope1` | `valueslope1` | family |
| `valueTrigger` | Trigger | `trigger` | `trigger1` | `valuetrigger1` |  |
| `valueLag` | Lag | `lag` | `lag1` | `valuelag1` |  |
| `valueFilter` | Filter | `filter` | `filter1` | `valuefilter1` |  |
| `valueSwitch` | Switch | `switch` | `switch1` | `valueswitch1` | family |
| `valueStep` | Step | `step` | `step1` | `valuestep1` |  |
| `valueNormalize` | Normalize | `normalize` | `normalize1` | `valuenormalize1` |  |
| `valueSpeed` | Speed | `speed` | `speed1` | `valuespeed1` |  |
| `valueRange` | Range | `range` | `range1` | `valuerange1` | family |
| `valueTail` | Tail | `tail` | `tail1` | `valuetail1` |  |
| `valueBeat` | Beat | `beat` | `beat1` | `valuebeat1` |  |
| `valueTrend` | Trend | `trend` | `trend1` | `valuetrend1` |  |
| `valueRate` | Rate | `rate` | `rate1` | `valuerate1` |  |
| `valueNovelty` | Novelty | `novelty` | `novelty1` | `valuenovelty1` |  |
| `valueCount` | Count | `count` | `count1` | `valuecount1` |  |
| `valueDelay` | Delay | `delay` | `delay1` | `valuedelay1` |  |
| `valueExpression` | Expression | `expression` | `expression1` | `valueexpression1` |  |
| `slider` | Slider | `slider` | `slider1` | same |  |
| `toggle` | Toggle | `toggle` | `toggle1` | same |  |
| `button` | Button | `button` | `button1` | same |  |
| `xyPad` | XY Pad | `xypad` | `xypad1` | same |  |
| `panel` | Panel | `panel` | `panel1` | same |  |
| `presets` | Presets | `presets` | `presets1` | same |  |
| `cueList` | Cue List | `cuelist` | `cuelist1` | same |  |
| `audioPattern` | Audio Pattern | `pattern` | `pattern1` | `audiopattern1` |  |
| **input** | | | | | |
| `movieFileIn` | Movie File In | `movie` | `movie1` | `moviefilein1` |  |
| `webcam` | Webcam | `webcam` | `webcam1` | same |  |
| `screenIn` | Screen In | `screenin` | `screenin1` | same |  |
| `syphonIn` | Syphon In | `syphonin` | `syphonin1` | same |  |
| `ndiIn` | NDI In | `ndiin` | `ndiin1` | same |  |
| `spoutIn` | Spout In | `spoutin` | `spoutin1` | same |  |
| `audioIn` | Audio In | `audioin` | `audioin1` | same |  |
| `audioFileIn` | Audio File In | `audiofile` | `audiofile1` | `audiofilein1` |  |
| `midiIn` | MIDI In | `midiin` | `midiin1` | same |  |
| `oscIn` | OSC In | `oscin` | `oscin1` | same |  |
| **render** | | | | | |
| `camera` | Camera | `camera` | `camera1` | same |  |
| `light` | Light | `light` | `light1` | same |  |
| `projector` | Projector | `projector` | `projector1` | same |  |
| `geometry` | Geometry | `geometry` | `geometry1` | same |  |
| `render` | Render | `render` | `render1` | same |  |
| `materialUnlit` | Material · Unlit | `material` | `material1` | `materialunlit1` | family |
| `materialPhong` | Material · Phong | `material` | `material1` | `materialphong1` | family |
| `materialPbr` | Material · PBR | `material` | `material1` | `materialpbr1` | family |
| `materialGlass` | Material · Glass | `material` | `material1` | `materialglass1` | family |
| `materialWgsl` | Material · WGSL | `material` | `material1` | `materialwgsl1` | family |
