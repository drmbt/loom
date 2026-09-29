# Presets, scenes and layers: a design for the owner to rule

Row: §T1398b. Date: 2026-09-29. Status: **design only, nothing built.** Every claim about today's code cites a file and line at commit `da128b49`. Section 13 lists the questions that need a ruling before any code.

---

## 1. The problem, in your words

> "a preset system in addition with a layering system so that we can actually build scenes with presets and shots and layers … mix and match … input, projection mapping, colorization, glitching FX layers … not always bespoke to the scene, and then the actual scene itself or multiples" (owner, 2026-09-27)

Put as requirements:

1. **Presets.** Save the current values of a set of parameters under a name, and bring them back later in one move. Undo takes the whole recall back in one step, and the audit trail shows who recalled it.
2. **Scenes.** A self-contained picture-maker (the "actual scene") with its own presets. You can have several.
3. **Layers.** A stack running input → scene(s) → FX (colourise, glitch) → mapping → output. Each layer can be switched on and off and faded, and an FX layer is not tied to one scene.
4. **Shots.** A named moment that sets several of the above at once.
5. **Recall from the performance surface:** from Panel buttons, and from the phone (§T1396b).

## 2. What exists today

### 2.1 The document and how it persists

- `ProjectDocument` holds `graph`, `settings`, `assets` and nothing else (`src/domain/types/graph.ts:399-408`). `GraphDocument` is nodes, edges, groups and viewport (`graph.ts:207-214`). Component definitions ride beside it at the file root under `componentLibrary` (`src/domain/project/project-file.ts:33`, the note at `:12-17`).
- `SCHEMA_VERSION = 5` (`src/domain/types/schemas.ts:12`). The ladder has four steps: preview pin→switch (`src/domain/migrations/document-migrations.ts:51`), feedback-by-name (`:86`), channel edge→Select (`:162`), right-handed roll (`:341`). Nodes also have their own per-definition migrations keyed on `definitionVersion` (`src/domain/migrations/node-migrations.ts:7-20`).
- A later build's unknown node type loads as a placeholder that keeps its data (`src/domain/project/forward-compat.ts:36-37`).
- `GraphNode.ui.bypassed` and `ui.muted` are document state (`graph.ts:145-146`). `GraphNode.state` is an open record (`schemas.ts:162-166`), but **no patch operation writes it, and copy/paste does not carry it.** `recreateOperations` restores ui, resolution and format and nothing else (`src/domain/commands/editor-commands.ts:262-285`). Only a dedicated command recipe writes `state`, for example `component.setParentBinding` (`src/domain/components/commands.ts:947-962`).

### 2.2 How the document changes: bus, patch, undo, audit, actors

- Every change goes through `AppCommandBus.execute`. A handler gets `context.apply(recipe)`, the one mutation primitive, and `apply` produces one revision, one undo group and one audit entry together (`src/domain/commands/bus.ts:137`, the note at `bus.ts:139-144`). `splitUndo` forces a fresh undo group even inside a transaction (`bus.ts:63`).
- A `GraphPatch` is a list of operations that apply all together or not at all (`src/domain/types/patch.ts:104-127`, §V32). A multi-node parameter write is several `setParameters` operations in one patch (`patch.ts:57`). The structural flags go through `setNodeUi` in the same patch (`patch.ts:69`).
- Undo is **per actor** (`src/domain/graph/store.ts:97`, key `kind:id` at `:102`). An undo group records before/after per entity (`store.ts:54-74`). One actor's undo is refused on an entity another actor has changed since ("Ask the other actor to undo their change first", `store.ts:531`).
- `Actor.kind` is `"human" | "agent" | "system"` (`src/domain/types/commands.ts:6-10`). There is no "remote" kind, so the phone would be `{kind: "human", id: "remote:<device>"}`. Each audit entry records actor, command name, undo group and status (`commands.ts:193-200`). The ring holds 512 entries (`store.ts:37`).
- Graph edits need no capability grant, because they are undoable and audited (`commands.ts:12-13`, §V38).
- A continuous gesture becomes one undo entry through a shared `transactionId` (`src/editor/inspector/parameter-editor.ts:13-33`).

### 2.3 Components

- A component is a subgraph behind published ports and published parameters (`src/domain/types/components.ts:16-61`). An instance stores **its published values in its own `node.parameters`** (`src/domain/components/instance.ts:10-19`), so writing an instance's page is an ordinary `setParameters` on one node.
- Definition edits (publish, expose) change the component registry and **not the document store**. `commitDefinition` validates and calls `components.register`: no revision, no undo group (`components/commands.ts:400-410`). Anything stored *inside* a definition inherits that property.
- A muted or bypassed instance is not inlined, so its whole interior costs nothing (`src/compiler/flatten.ts:663-681`, §T1032).
- §T1143 (open) records your view that a project-level surface "should just become a subgraph". §T962 and §T1395b (open) cover moving components between projects.

### 2.4 Panels and widgets

- §T1388b phase 1 shipped widget nodes (`slider`, `toggle`, `button`, `xyPad`), each publishing its hand-set value as a channel (`src/nodes/definitions/controls.ts:42-135`), and a `panel` node whose `layout` text lists `# Heading`, `> note` and widget names (`controls.ts:147-180`).
- The controls pane draws a Panel by looking up widget names (`src/editor/controls/controls-pane.tsx:100-109`). It writes through the parameter editor, one undo group per gesture (`controls-pane.tsx:96`). A widget whose value is driven refuses the gesture (`src/editor/controls/control-widget.tsx:85-89`).
- A **pulse** parameter fires a named bus command (`src/domain/types/parameters.ts:242-247`). An expression that becomes non-zero fires it on the rising edge (`src/app/pulse-firing.ts:10-28, 73`). That is how a beat, a MIDI note or a Button widget can trigger a command today.

### 2.5 The switching and mixing nodes

- `switch` (texture) picks one of up to 8 inputs by index, with an optional linear crossfade (§T1054, `src/nodes/definitions/switch.ts:204`). **It binds and cooks every source whatever the index is** (§T1014, `switch.ts:188-191`), so N scenes behind one Switch cost N scenes every frame.
- `cross` dissolves between two inputs by one factor (`src/nodes/definitions/composite.ts:265`).
- The composite family (`over`, `add`, `composite`, …) puts `in1` in front and folds the variadic `in2` behind it. Its one `opacity` scales **only the front** (`composite.ts:145-153`). With `in1` missing it emits no passes (`composite.ts:160-164`).
- `valueSwitch` picks or crossfades channel bags (`src/nodes/definitions/value-graph-nodes.ts:623`). `valueSelect` filters channels by name pattern (`value-graph-nodes.ts:1196`).
- There is **no 2D mapping node** (corner pin, mesh warp). `projector` is a 3D previz light (`src/nodes/definitions/scene.ts:172`).

### 2.6 Bypass, mute, and what costs GPU time

- Bypass turns a node into a wire from its **first kind-matching input** to its first output. A node with nothing to pass is muted instead (`src/domain/graph/bypass.ts:25-34`). Mute removes the node and every edge touching it, so consumers see a disconnected input (`src/compiler/compile.ts:657-700`).
- The compiler only builds what an active sink can reach (`src/compiler/prune.ts:10-16`). A chain that nothing reaches costs nothing. A visible preview tile counts as a sink.
- Bypass and mute are structural, so toggling either recompiles the downstream region (`src/compiler/recompile.ts:112-121`). A *driven* structural parameter is refused at runtime (§T1014, `switch.ts:181-183`). **On/off cannot follow an expression. Only a uniform can.**

### 2.7 Parameters, expressions, clocks

- A stored parameter is a bare value or a `ParameterSlot` holding the active mode plus every mode's last payload (`parameters.ts:384-395`). The modes are static, expression, bind, map, and the retired driven (`parameters.ts:347-369`).
- `resolveParameters` is the one read path (§V61, `src/domain/parameters/resolve.ts:30-60`). It already has a per-node **driver seam that outranks the stored slot** (`resolve.ts:153-155`), which is how `parent.<key>` fan-out reaches internals (`flatten.ts:555-587`).
- A frame carries timeline time and an optional wall clock, `wallSeconds` (`src/domain/types/frame.ts:23, 46`). Nodes may not read a wall clock (§V44).
- Precedent for "a table the user edits, stored as document state": the MIDI node keeps its learned mapping as a `code`/`json` parameter. Its note says: *"THE MAPPING IS DOCUMENT STATE … undo, autosave, the agent surface and the diff all work on it without anything being built for them"* (`src/nodes/definitions/midi.ts:89-110`).
- Node names are the reference currency (§V129). A rename rewrites every stored reference through one clause list (`src/domain/graph/names.ts:210-214`). Paste runs the same rewrite when it has to renumber a name (`editor-commands.ts:193-233`).

### 2.8 Window Out and the phone door

- Window Out (§T1391b) is a display sink (`src/nodes/definitions/window-out.ts:54`). It takes its picture by wire **or by name**, through the source-reference table (`src/domain/graph/source-references.ts:54`), and a closed window costs nothing. Its docblock states the house rule: *"everything is a node, not a device pane"* (`window-out.ts:19-21`, T960).
- The phone door (§T1396b, approved, not built) can **read published controls and write their values** as a remote human actor, "nothing else". Publishing means marking a Panel as remote.

### 2.9 What is missing

There is no preset object, no store or recall command, no layer concept, and no shot or cue. There is also no way to put a composited layer's on/off, fade and blend on one node that can be switched off at no cost.

---

## 3. The model on one page

```
   camera ──────────────┐
   (input)              ▼
                   [layer 1] picture = "cityScene"   blend over      opacity 1
                        ▼
                   [layer 2] picture = "smokeScene"  blend screen    opacity 0.4   (bypassed = off, costs 0)
                        ▼
      ┌──── glitch1 ◄───┤
      └──────────► [layer 3] picture = "glitch1"     blend replace   opacity 0.7   (wet/dry)
                        ▼
                   colorize1  (bypass = off)
                        ▼
                   mapping1   (2D warp, new node, separate row)
                        ▼
                   Window Out

   [presets "cityLooks"]  targets: cityScene             presets: dawn, noon, riot
   [presets "fx"]         targets: glitch1 colorize1     presets: clean, dirty
   [presets "shots"]      targets: layer1 layer2 layer3  presets: intro, drop   (each may also recall cityLooks/fx presets)
   [panel  "perform"]     layout names the banks and the layers → buttons, toggles, faders; marked remote for the phone
```

- A **preset** is a named entry in a **Presets node** (a bank). The bank lists the nodes it controls. Recall builds one patch across all of them: one revision, one undo step, one audit entry.
- A **scene** is a role, not a new type. It is usually a component instance, and its presets are a bank that targets the instance's published page.
- A **layer** is a new `layer` node. Its first input is the stack below, its picture comes by wire or by name, and it has opacity and blend. **Off is the node's bypass flag**, which passes the stack through and leaves the picture's chain unreached, so it costs nothing.
- A **shot** is a preset in a bank that targets layers and can also recall other banks' presets, all in the same patch. It plays the part of a Resolume column.
- **Panels** show banks as preset buttons and layers as toggle and fader. The phone gets the same rows from a remote Panel.

Nothing new is added at the document root. The whole structure is nodes, so persistence, undo, copy/paste, components and the agent surface all work without new plumbing.

---

## 4. Presets

### 4.1 Data shape

A bank is a node of the new type `presets`. Its parameters:

| key | type | meaning |
|---|---|---|
| `targets` | string, list of names | What Store captures: `glow` (every parameter of that node) or `glow.radius` (one key). Separated by spaces or commas, like Render's `scenes` (`source-references.ts:41`). |
| `presets` | `code` / `json` | The bank itself, format below. Editable by hand, like the MIDI mapping. |
| `select` | string | Which preset the Recall pulse recalls. **Drivable**, so an expression can choose (`op('midi1').chan.pad`). |
| `recall` | pulse, fires `preset.recall` with `{ nodeId: "$node" }` | Recalls `select`. Driven by an expression, it fires on a beat, a MIDI note or a Button widget. |
| `current` | string | The last preset recalled. Recall writes it in the same patch. Panels and the phone highlight it. |
| `morph` | number, seconds, default 0 | Phase 2. The default morph time. |

The JSON in `presets`, as the domain type (new, headless, `src/domain/presets/bank.ts`):

```ts
import type { StoredParameter } from "../types/parameters.ts";

/** The value of a bank's `presets` parameter. Its own version, migrated through the node's definitionVersion. */
export interface PresetBank {
  readonly version: 1;
  /** Order is button order on a Panel. */
  readonly presets: readonly Preset[];
}

export interface Preset {
  /** Unique within the bank. An identifier, so an expression and a Panel can spell it. */
  readonly name: string;
  /**
   * node NAME → parameter key → the STORED form, exactly as GraphNode.parameters holds it:
   * a bare value, or a whole slot (mode plus bindings). Recall writes these back verbatim.
   */
  readonly values: Readonly<Record<string, Readonly<Record<string, StoredParameter>>>>;
  /** Phase 3: node NAME → whether that layer is on. Written as ui.bypassed = !on. */
  readonly on?: Readonly<Record<string, boolean>>;
  /** Phase 4 (shots): other banks' presets, applied in the SAME patch, before this preset's own values. */
  readonly recalls?: ReadonlyArray<{ readonly bank: string; readonly preset: string }>;
  /** Phase 2: morph time for this preset. Absent means the bank's `morph`. */
  readonly morph?: number;
}
```

**Why node names and not ids.** Names are what expressions, source references and Panels already use (§V129), and they survive a paste into another document where ids are re-minted. Renames and paste renumbering stay correct with one new entry in the clause list (`names.ts:210`). That entry covers `targets`, `select`, `current`, the keys of `values` and `on`, and `recalls[].bank`. Paste and save-selection get it without extra work (`editor-commands.ts:233`).

### 4.2 Where it lives, and why a node

The bank is a node in the graph, usually next to what it controls, and its data sits in its parameters.

- **Undo, audit, autosave, copy/paste, save-as-component and the agent's `get_graph` already work.** This is the MIDI mapping argument (`midi.ts:89-100`) repeated.
- **It matches the house rule** that Panel, widgets and Window Out already follow: everything is a node (`window-out.ts:19-21`).
- **Banks are plural and local.** An FX chain carries its own bank ("not always bespoke to the scene"), a scene has its own, and shots have theirs.
- **The data has to be in parameters, not `node.state`.** State is not copied by paste (`editor-commands.ts:262-285`) and no patch operation can write it.

Rejected:
- *A document-root `presets` slice.* It needs a new store slice, a new `UndoGroup` field (`store.ts:54-74`), a schema bump, and a new clipboard path. It also has no canvas presence, so an FX chain and its presets cannot be copied together.
- *Presets stored in `node.state`.* Paste would lose them, and they could not be patched.
- *One global bank for the whole project.* It cannot travel with a reusable FX chain, and it grows into one long list.

### 4.3 Store

`preset.store { nodeId, name }`:

1. Resolve `targets` to nodes by name. For each node, take **every parameter in its effective schema except pulses**, or only the named key for a `node.key` entry.
2. Copy each one as stored. A slot stays a slot. A parameter with no stored value is written as its definition default, so that a later recall *resets* it instead of leaving whatever was there.
3. Write the new `presets` JSON with one `setParameters` on the bank node. That is one undo step: undoing a store removes the stored preset.

For a component instance, "every parameter" is its published page (`instance.ts:14-15`). **That is what a scene preset is.**

The output lists what was captured and names every target that could not be found. A missing target is never silent.

### 4.4 Recall: one patch, one undo, one audit entry

`preset.recall { nodeId, name?, morph? }`. Without `name` it recalls the bank's resolved `select`.

1. Parse the bank. Malformed JSON is refused with a diagnostic that names the bank.
2. Expand `recalls` depth-first (phase 4): refuse cycles by name, cap depth at 4, and let the preset's own values win over nested ones.
3. Resolve each node name in the current graph. For each key, check it against the node's effective schema and validate static values against the manifest (the same validation `setParameters` applies, §V66). **An unknown node, unknown key or invalid value is skipped with a warning that names it** (see question 4).
4. Build **one** `GraphPatch`: one `setParameters` per target node, `setNodeUi { bypassed }` per layer in `on` (phase 3), and `setParameters { current: name }` on the bank.
5. Apply it through `context.apply` with `splitUndo: true`, so a recall never merges into a drag that is still open (`bus.ts:63`). The result is one revision, one undo group labelled `Recall "riot" (cityLooks)`, and one audit entry `preset.recall` stamped with the invoking actor.
6. If everything was skipped, the answer is `rejected` with the diagnostics.

**Undo** brings every target back in one step, because the undo group holds per-entity before/after (`store.ts:54-74`). Undo belongs to the actor who recalled (`store.ts:97`). If the phone recalled, Cmd-Z on the laptop does not undo it. If the laptop then undoes an older edit on a node the phone's recall has since changed, the store refuses and says why (`store.ts:531`). That is the right behaviour, and it is stated here so it is not a surprise.

**What recall costs:** one commit, meaning one validation and one compile, the same as a single parameter edit however many targets there are. A recalled structural parameter, such as an enum marked compileTime or a source name, recompiles its region. That is a cut, and it is expected.

### 4.5 Parameters that are driven

A preset stores the **slot** and not the number the slot currently gives. Recalling "riot", where `glow.intensity` follows the audio, brings back *following the audio*. Recalling "dawn", where it is a fixed 0.2, brings back 0.2 and switches the mode to static. The inactive bindings a slot keeps (§V108) come back with it, so no expression is lost. To give a *widget-driven* look a preset, target the widget node: its `value` is plain and the targets keep reading its channel. (Question 2.)

### 4.6 Triggers

| from | how | audited as |
|---|---|---|
| inspector (bank section) | Store / Recall / Delete buttons → commands | the local human |
| Panel | a bank named in the layout draws one button per preset and highlights `current` (§9) | the local human |
| expression, MIDI, OSC, beat | `select` driven + `recall` pulse driven (`pulse-firing.ts:73`) | the pulse context, which is the app's actor |
| phone | a remote Panel's preset button (§9, question 12) | `human:remote:<device>` |
| agent | `recall_preset` tool (§10) | the agent |

---

## 5. Morph

**Recommendation: no morph in v1.** Recall is a cut. Morph is phase 2 and works as a runtime overlay. The document never holds intermediate values.

How phase 2 works:

1. `preset.recall` with `morph > 0` commits **the end state immediately**, as the same single patch as a cut. Undo, audit and saved files all see the destination.
2. The command also hands an app-side morph service the start values (what each target resolved to just before), the end values, the duration and a start wall time.
3. On every frame, for the morphing keys, the service provides a **driver** through the resolver's existing seam that outranks the stored slot (`resolve.ts:153-155`). The driver returns `lerp(start, end, ease(t))`, with `t` taken from `frame.wallSeconds` (`frame.ts:46`). Nodes never see a clock (§V44), and the same overlay reaches the value graph as well as the texture compile, because there is one read path (§V61, §V109).
4. Numbers, colours and vectors interpolate. Anything else (enum, string, boolean, a mode change, a source name, a layer's on/off) **cuts at the start**, which matches the document.
5. Any edit to a key that is morphing, by any actor, drops that key from the overlay. Undo cancels the whole morph. A new recall over keys that are still morphing starts from the value currently on screen, so nothing jumps.
6. Morph exists only live. An offline render sees the document, which is the end state, and stays deterministic.

The frame loop has to treat a document with a live morph as animated, and the value graph must honour the overlay. Both are phase 2 work, and both are named here so they are not discovered later.

Rejected:
- *Writing interpolated values to the document every frame* (one transaction, one live patch per frame). A 10-second morph at 60 Hz writes 600 audit entries into a 512-entry ring (`store.ts:37`), recompiles on every commit, and fights a human editing the same node.
- *Presets as channels*: constants per preset → `valueSwitch` with crossfade → every target reads `op('look').chan.x`. It morphs for free, and it **works today** as a stopgap. But it turns every target into an expression, it has no "store what I see", and each preset is a pile of nodes.
- *An interpolating expression written into each target, cleaned up at the end.* That is two commits, two undo steps, and a document that is wrong if you save mid-morph.

---

## 6. Scenes

**A scene is a role, not a type:** a node (in practice a component instance) whose output is a picture that some layer shows. No new data is needed.

- **Its presets** are a bank beside it whose `targets` names the instance. Store captures the published page, and recall writes the instance's `node.parameters`. That is per instance and undoable (`instance.ts:10-19`). This is TouchDesigner's "a COMP's custom parameters are its preset surface".
- **Several scenes** means several instances. Each costs GPU time only while a layer that is on shows it, or while its preview tile is visible (`prune.ts:10-16`).
- **Why a component and not a loose chain:** the published page is the natural, curated preset surface, and the component comes with its own label and name. A loose chain works too, since a layer names any node.

Rejected for v1: *a bank inside the component definition that targets its internals.* Recalling it would edit the library definition. That is not undoable (`components/commands.ts:400-410`) and it changes every linked instance. The useful version of the idea is a bank inside the definition that targets the **enclosing instance's page**, so the looks travel with the scene into another project. That belongs with component export and import (§T962, §T1395b). See question 8.

**Naming.** "Scene" already means a 3D scene here: Render's `scenes` list (`source-references.ts:41`) and the scene payloads (`src/domain/types/scene.ts:4`). This design never names a type or a parameter "scene". The layer's input is `picture`. See question 7.

---

## 7. Layers

### 7.1 The `layer` node (new)

| | |
|---|---|
| inputs | `below` (RGBA). **It is first**, so bypass passes it straight through (`bypass.ts:25-34`). Next, `picture` (RGBA), which comes by wire **or by name**. |
| `picture` | string, a source reference like Window Out's (`source-references.ts:54`) |
| `opacity` | number 0..1, a uniform, drivable |
| `blend` | enum, compileTime: `over` (picture over below with its alpha × opacity), `add`, `screen`, `multiply`, `replace` (a cross from below to picture by opacity, the wet/dry mix for an FX layer). Same maths as the composite family (§V140). |
| resolution, format | inherit `below` |

### 7.2 On/off and fade are two different controls

- **On/off is the layer node's bypass flag.** When off, `below` passes through unchanged and the picture's chain is no longer reachable, so it is pruned and **costs nothing**. It is structural: switching it recompiles the region (`recompile.ts:112-121`). It cannot follow an expression (§T1014), so commands, Panel toggles, presets and shots set it.
- **Fade is `opacity`.** It is a per-frame uniform that can take an expression, a widget, a morph or a beat. At 0 the picture still cooks.

The rule for the performer: **turn a layer off when you won't need it for a while, and fade it when you want it to move.** The first time a scene that has never been compiled is switched on, its pipelines compile, and that can hitch. After that the backend's caches serve it (per the perf review, pipelines are not evicted). Pre-warming belongs to a later row.

### 7.3 Swapping a scene in a layer

Changing `picture` from `"cityScene"` to `"smokeScene"` is a parameter write, and a preset can hold it. Only the named scene cooks. This is Resolume's "a layer plays one clip at a time". To crossfade scene A into scene B, use two layers: B above A, fade B's opacity up, then switch A off. Section 8 covers the step at the end.

### 7.4 FX, input, mapping

- **FX layer:** wire the stack into the FX chain (glitch, colourise) and into the layer's `below`, and name the FX output as `picture` with `blend: replace`. Opacity is then wet/dry. An FX node that needs no wet/dry is simply bypassed itself. The FX chain is ordinary nodes or a component, **so any scene can use it**.
- **Input layer:** whatever feeds the bottom `below`: a camera, a video, the phone camera (§T1397b), a constant.
- **Mapping:** the last node before Window Out. **A 2D warp or corner-pin node does not exist yet** (§2.5). It needs its own row, and it is not part of this design.

### 7.5 Why a new node

Rejected:
- *Over / Composite as the layer.* Their first input is the front (`composite.ts:113-118`), so bypass would pass the *layer* through and not the stack. Their opacity scales the front only, and with the front muted the node emits nothing (`composite.ts:160-164`).
- *Cross as the layer.* It is right for wet/dry but has no alpha-over. Adding blend modes would undo §T234's reason for keeping Cross a single-purpose node.
- *One Switch or Composite holding all layers.* A Switch cooks every source (§T1014), and a variadic port has no per-input opacity or on/off.
- *A document-level "layer stack" compiled into nodes.* That is a second representation of the graph that the canvas cannot show, and it breaks the everything-is-a-node rule.
- *Replicator-style generated layers.* Too much machinery for a stack of four to eight layers.

A **Layers view** (the stack listed as rows, Resolume-style) can come later. It would be *derived* by walking `below` from each Window Out and Output, never stored.

---

## 8. Shots

A shot is **a preset in a bank that targets layer nodes** (`picture`, `opacity`, `blend`, plus `on`) and **recalls other banks' presets** through `recalls`. Recalling a shot expands into one patch across layers, scenes and FX: one undo step, one audit entry. This is Resolume's column trigger, where one press sets a clip in every layer.

```jsonc
// bank "shots", targets "layer1 layer2 layer3"
{ "version": 1, "presets": [
  { "name": "drop",
    "values": { "layer1": { "picture": "cityScene", "opacity": 1 },
                "layer3": { "opacity": 0.8 } },
    "on": { "layer2": false, "layer3": true },
    "recalls": [ { "bank": "cityLooks", "preset": "riot" }, { "bank": "fx", "preset": "dirty" } ],
    "morph": 2 } ] }
```

**Sequencing** (a cue list with GO and next) is not in this design. The bank's `select` driven by a Count node, together with its `recall` pulse, already gives next and previous from a button, MIDI or a beat. See question 14.

**Transitions that end in a structural change** (fade B in, then switch A off to save its cost) would need a second commit when the morph ends. v1 leaves that step to the performer, as a second shot. See question 13.

---

## 9. Panels and the phone

**Panel.** The layout syntax stays the same (`controls.ts:147-157`): lines of node names. What changes is that the pane draws a row by node type, not only for widget types (`controls-pane.tsx:106`):

- a **bank** name → one button per preset with `current` highlighted, and a Store button (local only) → `preset.recall`, `preset.store`;
- a **layer** name → an on/off toggle, an opacity fader and the picture's name → `setNodeUi { bypassed }` (idempotent: **not** `node.toggleBypass`, because a remote double tap would flip it twice, `editor-commands.ts:60`), and `opacity` through the parameter editor (one undo group per drag).

**Phone (§T1396b).** The approved surface reads published controls and writes their *values*. A preset button is a command, not a value, and a layer toggle writes a ui flag. So the door has to be widened, narrowly: **for nodes named on a Panel marked remote, the phone may call `preset.recall` on those banks and set on/off and opacity on those layers.** Nothing else changes: no Store, no document read beyond the Panel, and every write is audited as `human:remote:<device>`. See question 12.

The alternative needs no widening: put a Button widget on the remote Panel and give the bank `select` and `recall` expressions that read it. It works, but the recall is audited as the laptop's actor, and it takes two controls to choose and fire.

---

## 10. What an agent sees

- Banks and layers are nodes. `get_graph` and `get_node` already show `targets`, the JSON, `current`, `picture`, `opacity` and `ui.bypassed`, and `list_node_definitions` describes the bank format in the definition text.
- New thin tools over the new commands, following `src/agent/tools/read.ts` and `mutate.ts`: `list_presets` (query `preset.list { nodeId? }` → banks with targets, preset names and current), `store_preset`, `recall_preset`, `delete_preset`.
- Layers need no new tool. `add_node`, `set_parameters` and `apply_graph_patch` with `setNodeUi` already reach them.
- An agent can also write a bank's JSON directly with `set_parameters`. A malformed bank reports at recall and in the inspector, and no data is lost.
- No new capability class. A recall is an audited, undoable graph edit (§V38).

## 11. Schema and migration

- **No `SCHEMA_VERSION` bump** (stays 5, `schemas.ts:12`) in any phase here. Everything is new node types plus JSON inside a parameter. Existing documents are unchanged, and older builds keep a new document's banks as placeholders (`forward-compat.ts:36-37`).
- The bank JSON carries its own `version`. A format change migrates through the `presets` node's `definitionVersion` (`node-migrations.ts:7-20`). The optional fields (`on`, `recalls`, `morph`) are added without a migration.
- Rename and paste: one new clause for banks (`names.ts:210`). `layer.picture` joins the source-reference table, which the existing clause already rewrites.
- Liveness: a bank does not read its targets each frame, so it is not a dependency of them, and they are not of it.
- Gates the build rows will meet: `command-holder` (a coverage row per new command), `emission-sites` (type strings named once), `composition-seams` (the phase-2 morph service factory must be reached from `app-runtime.ts` and `serve.ts`), and `layout` and `doc-drift` for any example.

## 12. Build plan (each slice a row)

| # | slice | contents | proves |
|---|---|---|---|
| a | **Preset bank core** | `src/domain/presets/bank.ts` (types, parse, capture planner, recall planner, all pure); `presets` node; `preset.store / recall / delete`; query `preset.list`; rename clause | Recall of 3 nodes = 1 revision, 1 undo group, 1 audit entry; one undo restores all three; a driven slot comes back driven; a missing target is skipped **by name**; paste renumbering rewrites the bank; a component instance's page is captured and recalled |
| b | **Bank surfaces** | inspector bank section (Store, Recall, Delete, current); Panel bank rows; agent tools | Panel click → document changes, one undo; the tool round-trip through the bus |
| c | **Layer node** | `layer` (below, picture by wire or name, opacity, blend); Panel layer rows; preset `on` | Dawn, exact values: bypassed = `below` bit for bit; the bypassed picture's chain has **no passes in the plan**; `over`/`replace` at opacity 0.5 give analytic values; swapping `picture` cooks only the named node |
| d | **Morph** | app-side overlay through the driver seam, wall clock, cancel on edit, value-graph parity | Frame N is between start and end values, analytically; save mid-morph = end state; an edit cancels its key; offline render = end state |
| e | **Shots + example** | `recalls` with a cycle and depth guard; an example: camera → two scenes → FX → Window Out with `cityLooks`, `fx` and `shots` banks and a Panel | One shot = one patch across banks; a cycle is refused by name; the example's claims from rendered pixels |
| f | **Phone recall** | the door widening from §9, after §T1396b | A phone recall is audited as remote; the door refuses a bank not on a remote Panel |

These become rows of their own, and none of them is part of this design: a **2D mapping node** (corner pin, then mesh warp); **banks inside component definitions** (with §T1395b); a **Layers view**; **pre-warming** a layer's pipelines before its first switch-on; a **cue list**.

## 13. Open questions for the owner

1. **Where do presets live?** In a Presets node (bank) in the graph, or in a new document-level list? *Recommendation: a node.* Undo, copy/paste, components and agents work unchanged. Several banks let FX and scenes keep their own. It matches Panel and Window Out.
2. **What does a preset hold for a parameter that is driven by an expression?** The whole slot (mode and expression), or the number it gives at the moment of storing? *Recommendation: the whole slot.* "riot follows the audio" should come back following the audio. To freeze a value, set it static before storing.
3. **Does a preset capture a fixed set declared on the bank (`targets`), or whatever keys each preset happened to save?** *Recommendation: the bank's `targets`, every non-pulse parameter of each target node, or single keys named `node.key`.* Every preset then covers the same keys, so recall is complete and a morph is well defined.
4. **A recall meets a missing node or an invalid value. Skip it and warn, or refuse the whole recall?** *Recommendation: skip and warn by name, and refuse only when nothing is left to apply.* In the middle of a show, a deleted node should not make a bank unusable.
5. **Morph in v1?** *Recommendation: no. v1 cuts. Phase 2 adds the runtime overlay* (the document takes the end state at once; the fade happens only on screen and live).
6. **Which clock does a morph run on?** *Recommendation: the wall clock (`wallSeconds`).* A 2-second morph should take 2 seconds even when the timeline is paused or looping.
7. **The word "scene" already means a 3D scene (Render's `scenes`).** Keep "scene" as the name of the performance role in UI text and docs, or choose another word ("look", "clip")? *Recommendation: keep "scene" for the role, and never use it for a type or parameter name.* The layer input is `picture`.
8. **Where does a scene's presets live?** In a bank beside the instance (per project, undoable), or inside the component so the looks travel with it (a store then edits the library, is not undoable, and changes every instance)? *Recommendation: beside the instance in v1. "Inside, targeting the instance's page" arrives with component export and import (§T1395b).*
9. **Layer on/off is the bypass flag.** It costs nothing when off, but it cannot follow an expression. Is that acceptable, with opacity as the drivable fade? *Recommendation: yes.* Making on/off expression-drivable means per-frame structural recompiles, which §T1014 refuses for good reasons.
10. **A new `layer` node, or reuse Over, Composite or Cross?** *Recommendation: a new node.* Its first input must be the stack so that bypass means "off". None of the existing nodes can take that role without changing what they already mean.
11. **Can a layer take its picture by name as well as by wire?** *Recommendation: yes*, as you ruled for Window Out. Swapping scenes becomes one parameter a preset can hold, and only the named scene cooks.
12. **Widen the phone door (§T1396b) so a remote Panel can recall presets and switch or fade layers?** *Recommendation: yes, limited to banks and layers named on a Panel marked remote, audited as the phone's actor, with no Store from the phone.* The alternative (a Button widget firing the bank's pulse) needs two controls and records the recall under the laptop's actor.
13. **A transition that should end by switching the lower layer off (to save its cost): a second automatic commit when the morph ends (two undo steps), or leave it to the performer?** *Recommendation: leave it to the performer in v1*, as a second shot, and revisit after the owner has played shows with it.
14. **Shots: may a preset recall other banks' presets (nested, cycle-checked, depth 4, own values win), or should a shot copy the values it needs?** *Recommendation: nested.* "Drop = city at riot + dirty FX" should follow when you re-store "riot".
15. **Cue list with GO and next?** *Recommendation: not now.* `select` driven by a Count node, together with the `recall` pulse, gives next and previous from any button, MIDI note or beat. Build a cue list only if that proves clumsy on stage.

## 14. How this compares, where it sharpened a choice

- **TouchDesigner** has no first-class preset object. The usual idiom is a table of parameter values applied by script, with a COMP's custom parameters as the thing a preset covers. That supports §6 (the published page as the preset surface) and a bank as a node in the network. TD's Switch TOP crossfade is §T1054, and its cost (every input cooks) is why a layer takes its picture by name. The Replicator was considered for generating layers and dropped as too heavy.
- **Resolume** structures a composition as layers, each with opacity, blend and bypass, playing one clip at a time. A column triggers a clip in every layer at once. That gave §7's split between on/off and opacity, §7.3's one-picture-per-layer swap by name, and §8's shot as a column. Resolume's per-layer transition time corresponds to the phase-2 morph.
