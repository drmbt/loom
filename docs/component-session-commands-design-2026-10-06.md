# What a command means inside a component session

T1694b. 2026-10-06. Survey and design. A census of every command, how each door picks its bus, what TouchDesigner and Notch do, one rule, its gates, and how it lands with pull request #1. Nothing under `src/` changes in this task.

The seam under it: a Reset pulse inside a component says `Pulse "resetPulse" fires "runtime.resetFeedback", which no track has registered.` Pull request #1 fixes that one command with a hand-written forward. The owner's ruling (2026-10-06): "this needs to be a proper clean rule, not a patch in certain spots so it needs to be a core thing that stuff inherits in a way so we can have this way and that way and something in between in different spots right?"

## How this was made, and how far to trust each part

- **Measured.** Four scratch files under the worktree's `scratchpad/` (gitignored, listed in §7) ran the real code in jsdom with no GPU: the mounted `<App>` and its root bus, a dive through `graph.diveIn`, the session bus the app itself opened (captured by wrapping `openComponentSession`), and real key events through the real keymap. Everything in this document marked "measured" comes from those runs. No product test was run.
- **Derived by script.** The command list is `bus.listCommands()` of the mounted app, not a list I kept. The pulse list is every pulse parameter of every registered node type. The census table in §1.7 is generated from one classification map, and the script refuses to print when the map and the measured lists disagree on a name or on which bus holds it.
- **Read by me.** `src/domain/commands/{bus,index,input-schema,parameter-commands,command-holder,editor-commands,node-output-commands}.ts`, `src/domain/components/{session,commands,internal-resolutions}.ts`, `src/domain/presets/{commands,bank-view}.ts`, `src/app/{use-component-editing,component-navigation,runtime-commands,media-commands,perform-commands,viewer-commands,pulse-firing,graph-pane}.ts(x)`, the bus wiring of `src/app/app.tsx`, `src/editor/keymap/{engine,keymap-provider,keymap-hooks,defaults}.ts(x)`, `src/editor/menus/{context-menu-host,input,schemas}.ts(x)`, `src/editor/palette/entries.ts`, `src/domain/diagnostics/classes.ts` and its gate, `src/tests/integration/{component-boundary-surfaces,command-input-data}.test.ts(x)`, and pull request #1's four hunks on the subject. Where a statement rests on reading alone it says "by reading".
- **The reference tools.** Four pages of the TouchDesigner documentation were fetched and are quoted (Clone, Feedback TOP, Replicator COMP, Undo). The fetch goes through a summarising reader, so read each quotation as close to the page, not as checked against it letter by letter. The rest of the TouchDesigner section is working knowledge and says so. Notch rests on one search result of its manual. §6 lists what was not verified.

## 0. The findings in one page

1. **The brief's premise needs two corrections.** A session bus is not "the component commands and nothing else": it is `createDomainBus` plus the component commands, 61 commands. And pulses on main fire **seven** commands, not six: `runtime.resetFeedback` (4 node types), `runtime.resetInference` (3), `media.cue` (2), `media.reload` (2), `preset.recall`, `cue.go`, `cue.back` (1 each), on 14 pulse parameters of 12 node types. `feedback.reset` is a string in one test fixture (`src/domain/parameters/resolve.test.ts`); `cue.go` and `cue.back` are named through constants, which the brief's grep did not see.
2. **The mounted app's root bus holds 117 commands. The session bus it opens on a dive holds 74**: the 61 domain twins and 13 that a pane registers on both buses by hand. The other **43 throw `UnknownCommandError`** when a pane that edits through the session bus fires them (measured, all 43). Four of them are pulse commands, which is the reported bug.
3. **The reported bug is the mild half. The other half acts on the wrong document.** The keymap, the command palette and every context-menu row dispatch on the ROOT bus while the editor is inside a component, and they send the ids of the graph on the canvas. Measured through the real app:
   - **Cmd+Z inside a component undoes the project.** Inside Bloom (a session open, nine interior nodes on the canvas), one `mod+z` removed a node added at the root before the dive; the root audit reads `graph.undo:applied` and the session's is empty.
   - **Delete inside a component can delete a root node.** The shipped example E47 Hologram has a root node `cut` (the DepthCut instance) and a node `cut` inside DepthCut. Inside DepthCut, with the interior `cut` selected, the Delete key removed the ROOT `cut`, the instance being edited, and left the interior node (session revision unchanged). E75 Resonance collides too: inside TimeGrid, the interior `grid` shares its id with the root's Point Grid node. Without a collision the root bus refuses the key (`node.missing`) and the node on the canvas stays.
   - 33 of the 61 twins are named by a key binding or a menu row, so they take that road.
4. **So there are two mirror-image defects and one cause.** A door on the session bus cannot reach a root command (refused, or thrown). A door on the root bus cannot reach a session command (refused, or the root is edited). The cause: two islands, and each door picks one by hand. T969(b), T1195 and T1257 patched the second direction for seven commands by registering them twice; pull request #1 patches the first direction for one.
5. **Eight separate roads already cross the boundary** (§1.6), each written for one case: the pull request's forward, `parameter.pulse` falling through to the flattening, `preset.recall` splitting `inst/bank` by hand, `node.setChannelMask`'s `internalNodeId`, `node.setResolution`'s flat id, the inspector's `instanceParameters`, the dual holders, and the preview panes' `flatOf`. Six places join or split a flat id by hand.
6. **T1541b's recall is a second mechanism, and it disagrees with itself by door.** A Recall pulse fired by an EXPRESSION inside a look reaches its instance (the watcher runs on the flattening, the root command decodes `inst/bank`). The same pulse fired by the inspector's BUTTON inside the component is refused: "there is no instance here". In the editor there always is one: the path the user dived through.
7. **The rule (§3).** A session bus has a parent. Every command declares, at its registration, one of three things it means inside a session: `definition` (the graph in hand: the session's own copy runs, and it is never inherited), `instance` (state of the instance the editor is viewing: inherited, with its node addresses rewritten onto that instance by one function, derived from the input schema), or `app` (it names no document node: inherited unchanged). A `definition` handler may hand a call up through one primitive (the "in between": a page bank's recall, a cue key). A declared `refused` is not built: the census finds no command that needs it, and the bus itself issues the two refusals that exist (no instance is being viewed; the session has no copy of a graph command).
8. **Proposed assignment of the 117: 64 `definition` (3 of which hand up), 9 `instance`, 44 `app`.** Two twins change side: `project.setSettings` and `component.export` are `app`. Five root-only commands (`control.*`) are graph edits and need a twin.
9. **The doors follow from the rule.** Once a session bus answers every command, an editor door (keymap, palette, menus, canvas, inspector) dispatches on the edit bus and nothing else is ever right for it; the 13 double registrations and the split view stores (T1195 M2, M3) go away with it.
10. **Landing.** Merge pull request #1 as it is. Slice 1 then replaces `registerForwardedResetFeedback` with the rule, keeps the contributor's test as the first claim, makes the pulse commands right on the session bus and gates the class. Slice 2 moves the doors and closes finding 3.

## 1. The census

### 1.1 Two buses, and what each holds (measured)

| Bus | Built by | Commands | Queries |
|---|---|---|---|
| Root, headless (`createAppRuntime`) | `createDomainBus` + component, project, control commands | 69 | |
| Root, app mounted | the above + 48 registered by hooks and panes at mount | **117** | 12 |
| Session, as `openComponentSession` builds it | `createDomainBus` + component commands with `host` | 61 | 7 |
| Session, as the mounted app leaves it after a dive | the above + 13 a pane registers on its own bus | **74** | 7 |

The 13: `graph.selectAll`, `graph.selectNodes`, `view.frameAll`, `view.frameSelected`, `view.home`, `view.toggleMinimap`, `ui.openNodeSearch`, `ui.beginRename`, `ui.toggleEdgeFlow`, `ui.toggleReferenceLines`, `ui.toggleTimingOverlay`, `preview.setView`, `preview.resetView`. All 13 are on the root as well. For the first seven the pane fills a holder on both buses, or shares one module-level store (`doorBuses`, `graph-pane.tsx`, `graph-canvas.tsx`); for the other six a holder or a store is kept per bus (`sharedForBus(bus, key)`).

A session bus also starts with its own empty grant store, no channel resolver, no frame clock and no flattening (`createDomainBus({ store, registry })`, `session.ts:124`). It is an island for reads as well as for commands.

### 1.2 How each door picks its bus

| Door | Dispatches on | The ids it sends | How known |
|---|---|---|---|
| Keymap (`KeymapProvider bus={runtime.bus}`, `app.tsx`) | **root, always** | the canvas selection: ids of the graph in view | measured |
| Command palette (`useKeymap().bus`, `useRunCommand`) | **root**; lists the root's commands, runs each with `{}` | none | by reading |
| Context-menu rows (`ContextMenuHost`) | reads the graph and `hasCommand` from its `bus` prop (the session bus on the canvas and in the inspector), then RUNS through `useRunCommand`, the keymap's bus: **root** | the target under the cursor, in the graph it read | by reading |
| Canvas gestures (`GraphPane`, `GraphCanvas`: `useAppRuntime()` is `editing.runtime`) | session | interior ids | by reading; the session's answers measured |
| Inspector, pulse button included (`parameter-editor.ts`) | session | interior ids | by reading |
| Inspector, a published value or a channel mask (`instanceParameters`, `use-component-editing.ts`) | the root bus, or an ancestor's session bus | the owning instance, plus a path | by reading |
| Preset and cue sections of the inspector | session | interior ids | by reading |
| A Panel drawn on the canvas | the canvas's bus | interior ids | by reading |
| Component bar (`ComponentBar bus={runtime.bus}`) | root | the canvas selection | by reading |
| Top bar, transport, project menu | root | none | by reading |
| Controls pane, Layers | root; they show the root document | root ids | by reading |
| Expression-fired pulses (`pulse-firing.ts`) | root | FLAT ids, from the flattening | by reading |
| Phone (`phone-writes.ts`) | root; its snapshot is the root graph | root ids | by reading |
| Agent tools, MCP bridge, WebMCP | root; no tool takes a component path (T1197) | root ids | by reading |

Nothing but the editor opens a session (`use-component-editing.ts`; the starter-component build script is the only other caller). The phone and an agent are never inside one.

### 1.3 What happens today, by class

The table in §1.7 gives each command's class. What a class means inside a component:

- **Twin (61).** From a session-bus door it edits the definition, with the session's own undo. This is the road that works. From a root-bus door the ROOT bus runs it with interior ids: refused when the root has no node of that id (measured: `node.missing`, `selection.empty`, `parameter.pulse.node`), carried out on the root node when it has one (measured, E47), and carried out on the root document when the command names no node (`graph.undo` measured; `graph.redo`, `graph.paste`, `graph.layoutAll`, `control.resetAll` by reading). 16 twins are named by a key binding, 27 by a menu row, 33 by either.
- **Both, by hand (13).** Seven share one handler and work from either bus (T969(b), T1195, T1257). Three display switches and the preview lens keep one STORE per bus, so the root command writes one and the canvas inside reads the other: `applied`, and nothing changes (T1195's M3, still so by reading). `ui.beginRename` reads the root graph and refuses an interior node (measured: `rename.unknownNode`; T1195's M1).
- **Root only (43).** From a root-bus door it runs. For the 29 that name no node that is right. From a session-bus door `execute` throws `UnknownCommandError` (measured for all 43) inside a `void` promise, so nothing is shown: by reading, that is the inspector's node reference button (`ui.openHelp`), a Window Out's Open button (`perform.toggle`), a double-click on a nested instance and the inspector's Enter (`graph.diveIn`), and a node's "+N more" chip (`ui.showProblems`). Through a pulse it is refused by name, because `parameter.pulse` asks `hasCommand` first: the reported bug.

Which commands silently act on the root while the user is looking at a definition: every twin a key or a menu row names (33), on an id collision or when it names no node. Which act on the instance when the pane shows the definition: a published value and a channel mask, on purpose (`instanceParameters`). Which act on the definition when the user may mean the instance: a preset recall on an inner bank and a cue list's GO, from the inspector, which rewrite the definition for every instance.

### 1.4 The pulse commands

| Command | Pulse parameters | On a session bus | Button inside (session bus) | Fired by an expression inside (root bus, flat id) |
|---|---|---|---|---|
| `runtime.resetFeedback` | `resetPulse` on Feedback, Echo, Cache, Slit Scan | no | refused, `parameter.pulse.unregistered` (the report; by reading) | works: the plan keys history by flat id (T615) |
| `runtime.resetInference` | `reset` on Depth, Matte, Pose | no | refused, the same | works, by reading |
| `media.cue` | `cuePulse` on Movie File In, Audio File In | no | refused, the same | by reading it works if the media hooks key by flat id; not verified |
| `media.reload` | `reload` on the same two | no | refused, the same | as above |
| `preset.recall` | `recall` on Presets | twin | an inner bank: rewrites the definition, for every instance. A page bank: refused, `preset.bank.inDefinition` | a page bank one level deep: recalled on ITS instance (T1541b). Deeper, or an inner bank: refused, `preset.bank.nested` |
| `cue.go` | `go` on Cue List | twin | steps the definition's list and recalls its bank, for every instance | refused: the root has no node `inst/cues` (by reading) |
| `cue.back` | `back` on Cue List | twin | as `cue.go` | as `cue.go` |

None of the seven answers the same by both doors. Four refuse from the button and, as far as read, work from an expression; of the three twins, one refuses a page bank from the button and recalls it from an expression, and two edit the definition from the button and are refused from an expression.

One more thing these have in common, by reading: `runtime.resetFeedback`, `runtime.resetInference`, `media.cue` and `media.reload` never read `context.dryRun`. A dry run of any of them does the thing (§V36).

### 1.5 T1541b: how a recall inside a definition reaches its instance

It is not the session's doing. The pulse watcher steps the FLATTENED root document, so a recall pulse inside a look fires `parameter.pulse` on the root bus with the flat id `city/looks`; `parameter.pulse` finds that node in `bus.flattenedGraph()` and substitutes the flat id for `$node`; and `preset.recall` on the root bus runs `pageBankPulse` (`presets/commands.ts`), which splits the id on `/`, requires exactly two parts, and checks that the first is a root instance whose definition's page bank is the second. Then it recalls on the instance.

So it is the same IDEA as the pull request's forward (a flat id names a node of one instance, and the root command acts on that instance) and a second, separate mechanism: decoded inside one handler, one level deep, with its own string split. On a session bus the same command takes the other branch, `inDefinitionRefusal`: `catalogue.host !== null` and the bank is a page bank, so it refuses with "there is no instance here". Under the rule in §3 both become one road: the session knows which instance is in view, hands the call up with the flat id, and the root command does what it already does.

### 1.6 The roads that already cross the boundary

| # | Road | Where | What it carries |
|---|---|---|---|
| 1 | The pull request's forward | `registerForwardedResetFeedback` (pr-1) | one command, session to root, ids prefixed with the path |
| 2 | A flat id accepted in `nodeId` | `parameter.pulse` (`parameter-commands.ts:579`, T615) | pulses fired on the root for a node inside an instance |
| 3 | `inst/bank` split by hand | `pageBankPulse` (T1541b) | a page bank's recall, one level |
| 4 | `{ nodeId: instance, internalNodeId: path }` | `node.setChannelMask`, the `setNodeChannelMask` patch operation | a per-instance mask override |
| 5 | A flat id split on the first `/` | `node.setChannelMask`, `node.setResolution` on the root | the same overrides, addressed flat |
| 6 | `instanceParameters.target` and `.channelTarget` | `use-component-editing.ts` | the inspector's writes to a published value, to the bus of whoever owns it |
| 7 | Two holders, one handler | `doorBuses` (`graph-pane.tsx`, `graph-canvas.tsx`) | 7 view commands, root to canvas |
| 8 | `flatOf` and `flattenedNodeId(prefix, id)` | the preview hook, `side-panes.tsx` | reads of the plan from a dived pane (T1019, T1202) |

Places that build or take apart a flat id themselves, outside `flattenedNodeId`: `use-component-editing.ts` (`path.join("/")`, twice), `presets/commands.ts` (`split("/")`, `includes("/")`, `indexOf("/")`), `node-output-commands.ts` (two `indexOf`), `describe-operation.ts`, `document-findings.ts`, and the pull request's `path().join(COMPONENT_ID_SEPARATOR)`. T1216 already records that `ComponentPath` means two different things (the editor's `["a","b"]`, the compiler's `["a","a/b"]`) and that `.join("/")` is right for one of them. The inverse already exists and nothing above uses it: the flattening records a `ComponentSource { nodeId, path, internalNodeId }` for every flat node (`flatten.ts`).

### 1.7 Every command

Generated by `scratchpad/table.mjs` from the measured lists. "Registered by": `domain` is `createDomainBus` (every bus), `components` is `registerComponentCommands` (every bus; `host` set in a session), `app-runtime` is the composition root (root only), `hook/pane` is a React hook or a pane at mount. "On a session bus today": `twin` (its own copy), `both (pane)` (registered twice by hand), `root only`. The last column adds only what §1.3 does not already say for the class. PULSE marks the seven of §1.4.

| Command | Registered by | Addresses | On a session bus today | Declared (proposed) | Today inside a component, beyond its class |
|---|---|---|---|---|---|
| `audio.saveTrack` | hook/pane | the recorded audio track, a file | root only | app |  |
| `audio.toggleTrackRecording` | hook/pane | the audio recorder | root only | app |  |
| `channel.copy` | domain | a node's channel, the clipboard | twin | definition |  |
| `component.detach` | components | an instance node of the graph in hand | twin | definition |  |
| `component.export` | components | the catalogue, a file | twin | app | twin has no file writer: refuses by name in a session |
| `component.exposePort` | components | the definition being edited | twin | definition | refused at the root by name (`NOT_INSIDE`) |
| `component.import` | components | the catalogue, a file, a position in the graph in hand | twin | definition | twin has no file reader: refuses in a session unless handed text |
| `component.instantiate` | components | the catalogue, a position in the graph in hand | twin | definition |  |
| `component.publishParameter` | components | the definition being edited | twin | definition | refused at the root by name |
| `component.reorderParameter` | components | the definition being edited | twin | definition | refused at the root by name |
| `component.saveSelection` | components | nodes of the graph in hand | twin | definition |  |
| `component.setParentBinding` | components | a node of the definition | twin | definition | refused at the root by name |
| `component.setPublishedParameter` | components | the definition's page | twin | definition | refused at the root by name |
| `component.unexposePort` | components | the definition being edited | twin | definition | refused at the root by name |
| `component.unpublishParameter` | components | the definition being edited | twin | definition | refused at the root by name |
| `component.upgradeInstance` | components | an instance node of the graph in hand | twin | definition |  |
| `control.bindParameter` | app-runtime | nodes of a graph (a patch) | root only | definition | no twin: by reading, its parameter-menu row inside is greyed as "no track has registered it" |
| `control.fromParameter` | app-runtime | nodes of a graph (a patch) | root only | definition | no twin, as above |
| `control.learnMidi` | app-runtime | nodes of a graph (a patch) | root only | definition | no twin |
| `control.reset` | domain | control nodes, or every control of the graph | twin | definition |  |
| `control.resetAll` | domain | every control of the graph | twin | definition |  |
| `control.setAllDefaults` | domain | every control of the graph | twin | definition |  |
| `control.setDefault` | domain | control nodes | twin | definition |  |
| `control.unbindParameter` | app-runtime | nodes of a graph (a patch) | root only | definition | no twin, as above |
| `control.unlearnMidi` | app-runtime | nodes of a graph (a patch) | root only | definition | no twin |
| `cue.back` | domain | a cue list node, or the one whose Keys switch is on | twin | definition, hands up | PULSE. twin: steps the definition's list for every instance; fired by an expression (root, flat id) it is refused |
| `cue.fire` | domain | a cue list node | twin | definition |  |
| `cue.go` | domain | a cue list node, or the one whose Keys switch is on | twin | definition, hands up | PULSE. as `cue.back` |
| `cue.setStandby` | domain | a cue list node | twin | definition |  |
| `export.renderRange` | hook/pane | the transport, the backend, files | root only | app |  |
| `graph.applyPatch` | domain | the graph in hand | twin | definition |  |
| `graph.copySelection` | domain | nodes, the clipboard | twin | definition | the clipboard is per bus: a copy inside cannot be pasted outside |
| `graph.cutSelection` | domain | nodes, the clipboard | twin | definition |  |
| `graph.diveIn` | hook/pane | a node on the canvas | root only | app, canvas ids | `i` works (root bus, reads the view); a double-click or the inspector's Enter inside THROWS |
| `graph.duplicateSelection` | domain | nodes | twin | definition |  |
| `graph.jumpUp` | hook/pane | the editor's path | root only | app |  |
| `graph.layout` | domain | nodes | twin | definition |  |
| `graph.layoutAll` | domain | the graph in hand | twin | definition | `l` inside goes to the root bus, which lays out the ROOT document (its answer measured: validated, 1 operation) |
| `graph.paste` | domain | the clipboard, the graph in hand | twin | definition |  |
| `graph.redo` | domain | the store's history | twin | definition | as `graph.undo` |
| `graph.removeNodes` | domain | nodes | twin | definition | Delete inside removes the ROOT node of the same id (measured on E47) |
| `graph.revertTransaction` | domain | the store's history | twin | definition |  |
| `graph.selectAll` | hook/pane | the canvas | both (pane) | app |  |
| `graph.selectNodes` | hook/pane | nodes on the canvas | both (pane) | app, canvas ids |  |
| `graph.undo` | domain | the store's history | twin | definition | Cmd+Z inside undoes the PROJECT (measured) |
| `gridWarp.deleteLine` | domain | a Grid Warp node | twin | definition |  |
| `gridWarp.insertLine` | domain | a Grid Warp node | twin | definition |  |
| `laser.estop` | hook/pane | the laser device | root only | app |  |
| `layout.reset` | hook/pane | the pane layout | root only | app |  |
| `media.cue` | hook/pane | a media element, by plan (flat) node id | root only | instance | PULSE. refused inside (`parameter.pulse.unregistered`) |
| `media.reload` | hook/pane | a media element, by plan (flat) node id | root only | instance | PULSE. refused inside |
| `node.bringToFront` | domain | nodes | twin | definition |  |
| `node.openViewer` | hook/pane | the viewer, a node of the plan | root only | instance | by reading: the key inside hands the interior id to the root plan |
| `node.rename` | domain | a node | twin | definition |  |
| `node.setChannelMask` | domain | a node, or `internalNodeId` inside an instance | twin | definition | the inspector inside sends it to the ROOT bus with `internalNodeId`: a per-instance override, on purpose |
| `node.setFormat` | domain | a node | twin | definition |  |
| `node.setResolution` | domain | a node; on the root also a flat id | twin | definition |  |
| `node.setValuePlotMode` | domain | a node | twin | definition |  |
| `node.toggleBackground` | domain | nodes | twin | definition |  |
| `node.toggleBypass` | domain | nodes | twin | definition |  |
| `node.toggleDisplay` | domain | nodes | twin | definition |  |
| `node.togglePin` | domain | nodes | twin | definition |  |
| `node.toggleRender` | domain | nodes | twin | definition |  |
| `parameter.copy` | domain | a parameter, the clipboard | twin | definition |  |
| `parameter.copyReference` | domain | a parameter, the clipboard | twin | definition |  |
| `parameter.copyValue` | domain | a parameter, the clipboard | twin | definition |  |
| `parameter.paste` | domain | a parameter, the clipboard | twin | definition |  |
| `parameter.pulse` | domain | a pulse parameter; on the root also a flat id | twin | definition | the dispatcher: asks `hasCommand` of the bus it runs on |
| `parameter.removeUndeclared` | domain | a node | twin | definition |  |
| `parameter.reset` | domain | a parameter | twin | definition |  |
| `parameter.revert` | domain | a parameter | twin | definition |  |
| `parameter.setMode` | domain | a parameter | twin | definition |  |
| `perform.toggle` | hook/pane | perform windows, by Window Out node id | root only | instance | the inspector's Open button inside THROWS; id space not verified |
| `preset.delete` | domain | a bank node, or an instance that is one | twin | definition | a page bank is refused inside |
| `preset.moveIntoComponent` | domain | a bank node beside an instance | twin | definition |  |
| `preset.recall` | domain | a bank node, or an instance; on the root also `inst/bank` | twin | definition, hands up | PULSE. twin: an inner bank rewrites the definition; a page bank is refused (`preset.bank.inDefinition`); fired by an expression it reaches the instance (T1541b) |
| `preset.store` | domain | a bank node, or an instance that is one | twin | definition | a page bank is refused inside |
| `preview.resetView` | hook/pane | a per-node preview lens | both (pane) | instance | one store per bus: the root command and the canvas inside hold two |
| `preview.setView` | hook/pane | a per-node preview lens | both (pane) | instance | as above |
| `project.compile` | hook/pane | the compiler, the backend | root only | app |  |
| `project.new` | app-runtime | the project | root only | app |  |
| `project.open` | app-runtime | the project, a file | root only | app |  |
| `project.save` | app-runtime | the project, a file | root only | app |  |
| `project.setSettings` | domain | the project's settings | twin | app | twin writes a session store's settings, which nothing reads: `applied`, no effect |
| `project.validate` | domain | the graph in hand | twin | definition |  |
| `runtime.resetFeedback` | hook/pane | temporal history in the backend, by plan (flat) node id | root only | instance | PULSE. the reported refusal |
| `runtime.resetInference` | hook/pane | the inference worker, by plan (flat) node id | root only | instance | PULSE. refused inside |
| `transport.pause` | hook/pane | the transport | root only | app |  |
| `transport.play` | hook/pane | the transport | root only | app |  |
| `transport.seek` | hook/pane | the transport | root only | app |  |
| `transport.stepFrame` | hook/pane | the transport | root only | app |  |
| `transport.toggleLoop` | hook/pane | the transport | root only | app |  |
| `transport.togglePlay` | hook/pane | the transport | root only | app |  |
| `ui.beginRename` | hook/pane | a node on the canvas | both (pane) | app, canvas ids | reads the ROOT graph: `rename.unknownNode` for an interior node (measured; T1195 M1) |
| `ui.closeCommandPalette` | hook/pane | the palette | root only | app |  |
| `ui.createComponent` | hook/pane | nodes on the canvas | root only | app, canvas ids | the prompt's `component.saveSelection` then runs on the root bus (by reading) |
| `ui.openCommandPalette` | hook/pane | the palette | root only | app |  |
| `ui.openHelp` | hook/pane | the help panel | root only | app | the inspector's reference button inside THROWS |
| `ui.openLayouts` | hook/pane | the layout menu | root only | app |  |
| `ui.openNodeSearch` | hook/pane | the node browser, a canvas position | both (pane) | app |  |
| `ui.openSettings` | hook/pane | the settings dialog | root only | app |  |
| `ui.showNodeInfo` | hook/pane | a node, and its rows in the plan | root only | instance | reads the ROOT graph: `inspect.unknownNode` (measured; T1215) |
| `ui.showPipeline` | hook/pane | the pipeline panel | root only | app |  |
| `ui.showProblems` | hook/pane | the Problems list | root only | app | a node's "+N more" chip inside THROWS |
| `ui.toggleEdgeFlow` | hook/pane | a canvas display switch | both (pane) | app | one store per bus (T1195 M3): `applied`, nothing changes |
| `ui.toggleReferenceLines` | hook/pane | a canvas display switch | both (pane) | app | as above |
| `ui.toggleTimingOverlay` | hook/pane | a canvas display switch | both (pane) | app | as above |
| `view.frameAll` | hook/pane | the canvas camera | both (pane) | app |  |
| `view.frameSelected` | hook/pane | nodes on the canvas | both (pane) | app, canvas ids |  |
| `view.home` | hook/pane | the canvas camera | both (pane) | app |  |
| `view.toggleFullscreen` | hook/pane | the window | root only | app |  |
| `view.toggleMinimap` | hook/pane | a canvas display switch | both (pane) | app |  |
| `viewer.cameraHome` | hook/pane | the viewer camera | root only | app |  |
| `viewer.editMapping` | hook/pane | the viewer | root only | app |  |
| `viewer.fly` | hook/pane | the viewer camera | root only | app |  |
| `viewer.flyCamera` | hook/pane | the viewer camera | root only | app |  |
| `viewer.frameContent` | hook/pane | the viewer camera | root only | app |  |

Totals: 117 commands. Today: 61 twins, 13 on both by hand, 43 root only. Proposed: 64 `definition` (3 hand up), 9 `instance`, 44 `app` (5 take canvas ids).

The nine `instance` rows are not equally sure. Four are certain (the pulse commands that key on plan ids). `node.openViewer`, `ui.showNodeInfo`, `preview.setView` and `preview.resetView` each need a look of their own before they are declared (T1215 has the reading for node info: it needs the flat id for the plan and the interior node for the label, and the flattening's `ComponentSource` gives both). `perform.toggle` depends on which graph `windowNodes()` lists, which I did not verify.

## 2. The reference tools

### 2.1 TouchDesigner

There is no second bus because there is no second document. One project is one tree of operators; a COMP's children are operators like any other, and every operator has a path (`/project1/base1/feedback1`).

- **A pulse belongs to its operator.** The Feedback TOP's page (fetched): Reset Pulse "Resets the feedback in a single frame when clicked", and it is that operator's parameter. From a script it is `op('feedback1').par.resetpulse.pulse()`. The button, the script and an expression in the parameter all address the same operator by its place in the tree, so where the user is standing changes nothing (working knowledge).
- **A network pane shows one COMP's network, and the keys act on that pane.** Delete, copy, paste, layout act on the selected children of the network the pane shows. Two panes can show two networks. The application-level things (the timeline, the perform window, save) are not scoped to a pane at all (working knowledge).
- **Undo is one history for the project** (working knowledge). The Undo page (fetched) lists what is undoable: node create, delete, placement, flags, wiring, renaming, parameter changes by hand or by script. It does not describe a history per network, and a pulse is not in its list.
- **Lookups inherit up the tree.** `me.time` finds the nearest Time COMP above the operator; parent shortcuts and `iop`/`ipar` resolve by walking up. A COMP is not an island: what it does not own it gets from its parents (working knowledge). This is the model for "a session bus has a parent".
- **Clones answer "one definition, many instances" by never editing a definition apart from an instance.** The Clone page (fetched): "All clones will be forced to contain the same children operators (nodes) inside the component. This includes the wiring between the nodes, the layout of the nodes, the parameter values, and the flags", while top-level custom parameters keep "the parameter definitions are the same, but the values are not mirrored". Structure flows from the master. But each clone is a real COMP with real children, so each has its own cooked state: pulsing Reset on `/project1/clone2/feedback1` clears clone2's loop and no other. Standing inside a clone, a pulse means THAT clone. Reaching every clone is done with data, not with a UI command: one channel or one expression that every clone's parameter reads, or a script that loops over them.
- **The Replicator COMP** (fetched) "is the 'for-loop' of operators": it creates a component per table row, and its pulses (Recreate All Operators, Recreate Missing Operators) act on the replicator, while each replicant is its own operator tree with its own state.

### 2.2 Notch

Much thinner, and stated as such. Notch nests by reference: a Layer Precomp node renders another layer inside this one, with its own time mode and offset, and "any exposed values from inside that layer will also be carried over"; the manual's summary also says several such nodes "will rerender that original layer" (search result of the manual, 0.9.23 page; the full page was not read). So a nested layer is evaluated per reference, with its exposed properties per reference, which is the clone answer again: the state belongs to the reference, the structure to the layer. Simulation state in Notch follows the timeline (scrubbing re-simulates) rather than a per-node Reset pulse; I found no documented per-node reset command and did not verify how a block's instances on a media server reset.

### 2.3 What applies here

Our definition is edited apart from its instances, with its own store, revision and undo. That is the one real difference, and it is the source of the question the reference tools never have to ask: which instance does a runtime command inside a definition mean?

- **The editor is never inside a definition in the abstract.** It gets there by diving through an instance, and the breadcrumb path names it. That path is the TouchDesigner answer: the instance you are standing in. `openComponentSession` does not know the path today; the hook that opens it does (`store.getPath`).
- **Structure is the master's; state is the instance's.** A graph edit inside a session is an edit to the master and reaches every instance (§V79, as cloning does). A pulse, a reset, a cue of a media file, the picture in the viewer are state of one instance and live in the root plan under flat ids.
- **Everything else is inherited.** The transport, the project, the help panel are not the component's and do not stop existing inside it.
- **Every instance is reached with data.** An expression on a definition's Reset already fires once per instance, because the watcher steps the flattening. No command needs to do it.

## 3. The rule

### 3.1 One sentence

**A session bus has a parent, and every command says at its registration what it means inside a session: the graph in hand, the instance in view, or neither.**

### 3.2 The declared behaviours

A required field on `CommandRegistration`, beside `inputSchema` and under the same rule T1556b set for it: a command cannot be registered without saying.

```ts
type InSession =
  | "definition"                               // the graph in hand
  | { definition: true; handsUp: string }      // the graph in hand, and the handler may hand a call up; the sentence says when
  | "instance"                                 // state of the instance in view
  | "app";                                     // names no document node
```

| Behaviour | What the session bus does | Who |
|---|---|---|
| `definition` | Runs its OWN registration, on the session's store, with the session's undo. Never inherited: if the session has no copy, the command is absent there (a build defect, gated in §4). A root registration of the same name is shadowed. | graph edits, parameter edits, clipboard, undo, presets, cues, component commands |
| `instance` | Has no copy. Rewrites every node address in the input onto the instance in view, executes on the parent, maps the result's node ids back. With no instance in view it refuses by name. | `runtime.resetFeedback`, `runtime.resetInference`, `media.cue`, `media.reload`; after their own look, the viewer and node-info commands |
| `app` | Has no copy. Executes on the parent, input unchanged. | transport, project, files, panels, the canvas camera, the viewer camera |

**"In between" is one primitive, not a fourth list.** A `definition` handler gets `context.handUp()`: run this same call as an inherited one (addresses rewritten if it has any). It is for a command whose meaning depends on what it is aimed at, and the registration says so in words:

- `preset.recall` aimed at a PAGE bank: the page belongs to an instance, so the call goes up as `<instance>/<bank>` and the root command does what T1541b already taught it. Aimed at an inner bank it stays in the definition. (`preset.store` and `preset.delete` on a page bank could take the same road; question 1 recommends they stay refused for now.)
- `cue.go` and `cue.back` with no `nodeId` (the global keys): the performer's cue list is in the show, so the call goes up unchanged. With a `nodeId` they act on that list in the graph in hand.

**A declared `refused` is not built.** The brief's starting position has it as a fourth behaviour. The census finds no command that makes no sense inside a session, and a behaviour nobody picks is speculative. What exists are two refusals the bus itself issues, each with a sentence a person can act on:

- `session.noInstance`: `"Reset" acts on a running instance of "Bloom", and this editor is not open through one.` (A session opened with no path: the build script today, a library-side editor later.)
- A `definition` command the session has no copy of is not offered (`hasCommand` false) and `execute` throws naming the defect. §4's gate keeps that set empty.

The day a command must be refused inside, `{ refused: sentence }` is one more arm of the union and one more case in the same switch.

**"Every instance of the definition" is a parameter of `instance`, and it is not built either.** The addressing function (§3.4) can map one interior id to the flat id in the viewed instance or to the flat ids in every instance; which one is the CALLER's choice (a modifier on the gesture), never the command's, because the same Reset is wanted both ways. The default is the instance in view (T1541b, and the clone model). Nothing asks for the other today, and the data road already does it: an expression on the definition's pulse fires in every instance.

### 3.3 What the bus does

`createCommandBus({ store, registry, parent?, scope? })`, where `scope` is what the opener knows: `{ component: { id, version }, instancePath: () => readonly NodeId[] | undefined }`. The path is read at call time, because one session outlives a move between two instances of the same component (the pull request notes this).

- `hasCommand(name)`: own, or the parent has it and it is not `definition`.
- `execute(name, input, context)`: own registration first. Otherwise the parent's `inSession`: `app` executes on the parent; `instance` rewrites, executes on the parent, maps back; `definition` is the defect above.
- `inputSchemaOf`, `listCommands`: own, then inherited, so the palette and the data gates see one list.
- `parameter.pulse` needs no change to work: it asks `hasCommand` and calls `execute` on the bus it runs on, and both now answer for the fired command. Its sentence "which no track has registered" stays for a command nobody registered anywhere.
- The parent of every session is the ROOT bus, nested or not. Instance state and app state live at the root; an ancestor's session is another definition, reached only by the published-value road (§1.6 road 6), which this rule leaves alone.

The same parent answers three reads a session cannot answer today, in a later slice (§5): grants (inherited as they are), the frame clock (inherited as it is, so a morph recalled inside a component fades instead of cutting), and the channel resolver and flattening (instance-addressed, through the same function).

### 3.4 Addresses: one function, derived from the schema

Today a schema cannot say which of its strings are node addresses. `idInput` is one `z.string().min(1)` shared by node ids, edge ids, component ids, parameter keys and transaction ids, and `nodeIdsInput` is an array of it (`input-schema.ts`). `NodeId` is a plain `string` alias, so the types cannot tell either.

- **Two marked schemas** in `input-schema.ts`: `nodeIdInput` ("a node of a document") and `canvasNodeIdInput` ("a node as the canvas shows it"). Marked by identity (a `WeakSet` of schema instances), not by a name or a description, so `.optional()`, `z.array(...)` and `.extend(...)` keep the mark (they wrap or carry the same instance) and a refinement that mints a new instance loses it loudly (§4, G3). `nodeIdsInput` becomes `z.array(nodeIdInput)`.
- **One walker**, `nodeAddressesOf(schema)`: objects by key, optionals and nullables to their inner type, arrays to their element, unions to the option that parses. It returns the paths of the marked leaves. The rewrite and the gate both read it.
- **One addressing module**, `src/domain/components/addressing.ts`, beside `flattenedNodeId`: `toInstance(path, id)` takes the EDITOR's path (T1216's first convention, and its type says so) and folds `flattenedNodeId` over it; `fromInstance(path, flatId)` strips it, or says the id is outside. Root-side decoding (`pageBankPulse`, the two `indexOf` in `node-output-commands.ts`) reads the flattening's `ComponentSource` instead of splitting a string. After that, nothing outside this module and `flatten.ts` names the separator.
- **Canvas ids are never rewritten.** `view.frameSelected`, `graph.selectNodes`, `graph.diveIn`, `ui.createComponent` and `ui.beginRename` name nodes of the graph on the canvas and are answered by whichever canvas is mounted, through its holder. They are `app`.
- **An address that is absent stays absent.** `runtime.resetFeedback {}` means every loop in the project at the root, and it means the same inside a session: the session rewrites addresses, it never invents one. (`mod+shift+r` is a project key. Question 3 in §6.)

### 3.5 Outputs, diagnostics, audit, undo, dry run, nesting

- **Diagnostics.** A `nodeId` on a returned diagnostic that lies under the viewed instance's prefix comes back as the interior id, so the inspector's badge and a Problems row point at a node the pane holds. Any other id is left as it is: a flat id is a true name, and it reads as a path. Message text is not touched.
- **Outputs.** No input schema describes an output, so an `instance` registration says how its output's ids map back, and the type requires it exactly when the output type has a string in it (the `InputKeysCovered` technique). The four pulse commands return counts and need nothing; `perform.toggle` (`open: string[]`) and `node.openViewer` (`nodeId`) will.
- **Audit.** The actor is the invoking actor, unchanged (§V30). One fact, one entry, in the store whose state it is about: the session's twin audits in the session store as today (`parameter.pulse`), and an inherited command that applies is recorded on the ROOT store with `via: { component, version, instance }`, an optional field added to `AuditEntry` and carried on the invocation. That is where `graph.audit` and an agent read it; a session's own audit dies with the session. (A direct root call of `runtime.resetFeedback` writes no applied entry today. Same gap, same fix.)
- **Undo.** `graph.undo` and `graph.redo` are `definition`: inside a component they act on the component's history and never fall through, which is finding 3 closed by construction once the doors move. An inherited command that edits the ROOT document (a page bank's recall on the instance; nothing in slice 1) puts its step in the root's history, and its result says so in one `info` line, as T1505b's Store on an instance already does ("no root undo, said in the result"). One timeline across the boundary is the TouchDesigner behaviour and is a larger design: question 2.
- **Dry run.** The invocation passes through as it is. The addresses are rewritten, the parent validates, nothing is audited (§V36). This requires the four pulse commands to honour `dryRun`, which they do not today.
- **Nesting.** The path is the whole chain from the root, innermost last; `toInstance(["a","b"], "fb")` is `a/b/fb`. A hand-up from two levels down arrives at the root as `a/b/looks`, and the root command's own rule decides (today: `preset.bank.nested`, a refusal that is already written).

### 3.6 The doors and the holders, which the rule makes simple

- **A door dispatches on the bus of the graph its ids come from.** An editor door (keymap, palette, context menus, canvas, inspector, component bar) takes the edit bus, which now answers everything. A door onto the project (transport bar, Controls pane, phone, agent, the pulse watcher) takes the root bus. `ContextMenuHost` runs a row on the bus it read the graph from, not on the keymap's.
- **State a command holds is app state unless it says otherwise.** `sharedForBus(bus, key)` resolves to the root of `bus`, so a holder or a store exists once and the canvas at any depth fills and reads the same one. The exceptions are named: the preset catalogue holder (it carries the session's `host`). The clipboard moves to the root with this, which is what lets a copy inside paste outside.
- With both, the 13 double registrations, `doorBuses`, and T1195's M2 and M3 are deleted rather than extended.

### 3.7 Where the declaration lives

At the registration, as a required field. The diagnostics table (`classes.ts`) is the precedent for the gate's shape but not for the place: a diagnostic code is a bare string with no object to hang a class on, so it needed a table. A command already has a registration object with required fields, the bus reads the declaration from it at run time, and a second hand-kept table of 117 names in `src/domain` would have to name commands of `src/app` and `src/editor`. §1.7 is the initial assignment; after slice 1 the registrations are the table, and `bus.listCommands()` with the declaration beside each name prints it.

Registrars follow the declaration: one that registers `definition` commands is called for every document bus (the root and each session), one that registers `instance` or `app` commands for the root alone. `control-commands.ts` is the registrar this moves today, and the two capabilities a session's component commands lack (the file reader for `component.import`; `component.export` becomes `app`) are the same omission.

### 3.8 Considered and not chosen

- **One bus, and the scope carried on the invocation** (the literal TouchDesigner shape: `execute(name, input, { ...context, scope: path })`). It is the same routing table in another place. The root bus would have to know every open session, `InvocationContext` (a frozen type) would carry a path, and each door would still choose, an invocation where it now chooses a bus. The session's store, revision and undo are separate either way (T130), so the second bus is not what the rule removes; the island is.
- **A forward per command** (the pull request; T969(b)'s double registration). It is what the ruling excludes, and §1.6 is what it grows into.
- **A table beside the diagnostics classes.** §3.7.
- **A session that inherits everything it lacks, with no declaration.** It would fix the reported bug in a few lines and make finding 3 worse: `control.fromParameter`, a graph edit with no twin, would fall through and patch the root with interior ids. The declaration is what tells a graph edit from everything else.

## 4. The gates

Each is against the cause, derived, and red-verified before it is trusted. None is a list of commands.

- **G1. Every command declares.** By the type: `inSession` is required, as `inputSchema` is. The runtime guard for a cast (`registerCommand` throws) follows T1556b's.
- **G2. Every command data can name is reachable on a session bus.** Extends `command-input-data.test.ts` (keymap bindings, menu rows, pulse templates) with the phone's `PHONE_COMMANDS` and the Panel's commands, and asks of a session opened the way the product opens it: `hasCommand`, and a dry run that answers (applied, validated, or a refusal with a sentence), never a throw. Commands only a hook registers are run in the mounted app, as T1195's gate does, so the count of skipped rows is zero rather than reported.
- **G3. Every string in an inherited command's input is classified.** For an `instance` command, every `ZodString` leaf of its schema is `nodeIdInput`, `canvasNodeIdInput`, or marked as plain text with a reason; an unmarked one fails by command and path. For an `app` command, a `nodeIdInput` leaf fails ("an app command names no document node"). And the rewrite is exercised: for every `instance` command the gate builds an input with a sentinel in every address leaf, runs it through a session whose parent records, and requires every sentinel to arrive under the prefix and nothing else to change.
- **G4. The case the guard could swallow: a session command that must NOT fall through.** Derived over every `definition` command: a root document holding a node X and an instance, a session on that instance's component, the command run on the SESSION bus with X (or with no address), and the root's revision, graph object and audit length are unchanged. A command that hands up is run on its definition arm here, and its other arm has a test of its own that names the instance it reached. The two literal repros ride with it, through the real app: Cmd+Z inside a component leaves the project's last edit alone, and Delete on the interior `cut` of E47's DepthCut removes the interior node and leaves the instance. The mirror: every `instance` and `app` command run on a session bus leaves the SESSION store's revision unchanged.
- **G5. No definition command is missing from a session.** Every `definition` command the mounted root holds is one the opened session holds itself. Fails by name; `control.*` are the five it finds today.
- **G6. One joiner.** A source gate in the family of `bank-view.test.ts` and `helper.test.ts`: `COMPONENT_ID_SEPARATOR`, and a `"/"` passed to `split`, `join`, `indexOf` or `includes` in a file that handles node ids, appear only in `addressing.ts` and `flatten.ts`. The six sites of §1.6 are its first ledger, each with the slice that removes it; the ledger can only shrink.
- **T1195's gate, turned round.** It asks every command the same question at the root and after a dive, on the ROOT bus, because that is where doors dispatched. After slice 2 it asks on the EDIT bus, and its excuse list (`graph.jumpUp`) is unchanged.

What these cannot see, stated: a handler that takes a canvas id and resolves it against `context.graph` instead of the canvas (T1195's M1; `ui.beginRename` and `ui.showNodeInfo` today). G2's dry run inside a session with a real interior id catches the two that exist; a new one is caught only if its command is named by data.

## 5. How it lands

### 5.1 Pull request #1

**Merge it as it stands, before the rule.** Its forward is correct for its case, tested through the editor's own bus with two instances so the wrong instance cannot pass, and it is one of several unrelated things in that pull request (31 files). Holding an outside contribution for a redesign it did not ask for is the wrong trade, and the owner's ruling is about where the code ends up, which slice 1 settles.

- The contributor's test, `a Reset pulse inside a component clears ITS instance's history (VNB6)`, stays byte for byte except one line: its recording double of `runtime.resetFeedback` gains `inSession: "instance"` when the field becomes required. It is slice 1's first claim: it must stay green when `registerForwardedResetFeedback` and its call are deleted, and red when the session's `parent` is dropped.
- `RESET_FEEDBACK_INPUT` stays (one schema, one declaration). The forward's docblock moves, shortened, to the rule.
- At the merge, the forward's docblock gets one line naming the task that deletes it (the testing bar's rule for a comment that predicts work).
- If the merge cannot happen first, the order reverses without loss: slice 1 lands, and the pull request drops two hunks (`runtime-commands.ts`, `use-component-editing.ts`) and keeps its test.

### 5.2 The slices

**Slice 1: the rule, for the session bus.** The smallest slice that makes the four refused pulse commands work from the inspector, sends a page bank's recall to its instance, declares all seven, and gates the class.

- `bus.ts`: `parent` and `scope`; `inSession` required; the fall-through in `hasCommand`, `execute`, `inputSchemaOf`, `listCommands`; `session.noInstance`.
- `input-schema.ts` and `addressing.ts`: the two marked schemas, the walker, `toInstance` / `fromInstance`.
- All 117 registrations gain the field (mechanical; §1.7 is the assignment), and so do the test doubles: 22 `registerCommand` calls in 8 test and support files. The four certain `instance` commands are declared, mark their addresses, and honour `dryRun`. The five uncertain ones are declared `app` for now with the task id of slice 3, so nothing about them changes in this slice.
- `openComponentSession({ parent, instancePath })`; the hook passes `runtime.bus` and `store.getPath`.
- `preset.recall` on a page bank hands up (question 1 decides it). `cue.go` and `cue.back` with no address hand up in slice 2, when a key can first reach a session bus.
- `registerForwardedResetFeedback` deleted. Gates G1, G2, G3, G5, G6's ledger, and G4's derived half.
- Not in it: the doors. The keymap still dispatches on the root, so finding 3 stands until slice 2.

**Slice 2: the doors and the holders.** `KeymapProvider`, the palette and the component bar take the edit bus; `ContextMenuHost` runs on its own bus; `sharedForBus` resolves to the root; the 13 double registrations and `doorBuses` go; `control.*` and the file reader reach sessions; `project.setSettings` and `component.export` stop being twins. G4's two literal repros, T1195's gate turned round. This is the slice that closes "Cmd+Z undoes the project" and "Delete removes the instance", and it should follow slice 1 at once.

**Slice 3: the rest of `instance`, and one decoder.** `node.openViewer`, `ui.showNodeInfo` (with T1215), `preview.*`, `perform.toggle`, each after its own look. `pageBankPulse` and `node-output-commands.ts` decode through `ComponentSource`; G6's ledger empties. `ui.beginRename` resolves through the canvas.

**Slice 4: what else a session inherits.** Grants, the frame clock, the channel resolver; queries (5 of the root's 12 are absent from a session); the audit's `via`; and, if question 2 goes that way, one undo timeline. T1197 (an agent's component path) should take `addressing.ts` as its one convention.

### 5.3 Found on the way, not fixed (this task writes no product code)

Row text for these is in the report to the lead. Each is small beside the rule, and slices 1 and 2 close most of them.

1. Cmd+Z inside a component undoes the project; Delete on an interior node whose id a root node shares deletes the root node (E47 `cut`, E75 `grid`); `l` goes to the root bus. Measured. Closed by slice 2.
2. Session-bus panes throw `UnknownCommandError` into a `void` promise for 43 commands. Closed by slice 1.
3. `runtime.resetFeedback`, `runtime.resetInference`, `media.cue`, `media.reload` ignore `dryRun` (by reading). Slice 1.
4. `graph.diveIn`'s result reports the path it left, not the one it entered (measured: `{"path":[]}` on a dive that opened a session). It reads the path from a ref that updates on the next render.
5. The parameter menu's "Publish to component" row sends `{ nodeId, parameterKey }` to `component.publishParameter`, whose schema is `{ key, definition, targets }` (by reading; a row with a builder is not checked by `command-input-data.test.ts`).
6. `project.setSettings` on a session bus reports `applied` and writes settings nothing reads (by reading). Slice 2.
7. Copy inside a component cannot be pasted outside, or the reverse: the node and parameter clipboards are per bus and only the root has the system clipboard (by reading). Slice 2.
8. A cue list inside a definition keeps its position in the definition, so GO inside one instance moves every instance's list. Not a defect of this seam; it is the question of per-instance stored state, which T1505b answered for a page bank only.

## 6. Not verified, and the questions

### 6.1 Not verified

- Nothing was run in a real browser or on a GPU. Every measurement is jsdom with React Flow stubbed.
- A context-menu row was not clicked. That its dispatch goes to the root bus is read from `ContextMenuHost` (`useRunCommand`) and the single `KeymapProvider`; `graph-pane.tsx`'s own docblock says the opposite ("the canvas right-click menu dispatches on it") and I believe it is out of date.
- The four silent throws of §1.3 are read from the call sites; what was measured is that the session bus throws for those names.
- Whether the media hooks and `perform.toggle`'s `windowNodes()` key by flat id. If they key by root id, `media.*` and `perform.toggle` cannot reach a node inside an instance by any road today, and the hooks need the fix, not the rule.
- The pull request's test was read, not run. That main refuses the same call follows from `parameter.pulse` and the measured absence of the command on the session bus.
- The marked-schema walker is designed against zod 3.24's wrappers by reading its behaviour (`.optional()` and `z.array()` keep the inner instance); no prototype was written.
- The undo of an in-session `component.detach` and the stale-session rebase (T1540b, T1545b) were read and are untouched by the rule, but no case was run through a parented bus.
- Notch, beyond one manual summary. The TouchDesigner points marked "working knowledge".
- Queries were counted, not classified.

### 6.2 Questions for the owner

1. **A page bank's Recall and Store pressed inside its component.** T1505b ruled them refused: "there is no instance here". In the editor there is one, the instance you dived through, and an expression on the same pulse already reaches it (T1541b). **Recommendation: Recall goes to the instance in view; Store stays refused inside until someone wants it,** because Store on an instance writes the definition and doing that from inside the definition's own session meets the stale-session rule (T1540b).
2. **Cmd+Z inside a component.** **Recommendation, now: it undoes the component's own edits and never the project's;** a step that landed in the project (a recall on the instance) says so and is undone from the project. The TouchDesigner behaviour is one history across both, in order, and leaving a component would then keep its edits undoable. That is a design of its own and gets a row if you want it.
3. **`mod+shift+r` (reset all feedback) pressed inside a component.** **Recommendation: the whole project, as outside.** The other reading is "this instance's loops only".
4. **Order with pull request #1.** **Recommendation: merge it first** (§5.1).
5. **A gesture for "reset in every instance".** **Recommendation: not built.** An expression on the definition's pulse does it today.

## 7. The scratch files

In the worktree's `scratchpad/` (gitignored; not committed), with a copy handed to the lead session's scratchpad under `T1694b/`. Run with `pnpm vitest run --config scratchpad/vitest.census.config.ts <file> --maxWorkers=1 --minWorkers=1`.

- `census.test.tsx`: the root bus headless and mounted, the session bus as built, every pulse parameter of the registry. Writes `census.json`.
- `session.test.tsx`: the session the mounted app opens on a dive (captured by wrapping `openComponentSession`), its commands, and every root command dry-run on it. Writes `session.json`.
- `doors.test.tsx`: `mod+z` through the real keymap after a dive; the root bus's answers to interior ids.
- `collision.test.tsx`: E47 loaded through `loadProject`, a dive into DepthCut (session and canvas contents asserted in the output), the interior `cut` selected, the Delete key.
- `collisions.mjs`: root ids against embedded definitions' interior ids over `examples/*.loom.json` (74 files, 13 with components, 2 colliding).
- `census-static.mjs`, `table.mjs`: the registration sites, and the table of §1.7.

## 8. As built (T1695b and T1696b, 2026-10-07)

Slices 1 and 2 are built as §3 to §5 describe, with these differences and decisions.

- **The field is `inSession`**, on `CommandRegistration` (`src/domain/commands/bus.ts`). The hand-up primitive is `context.session.handUp()`, present only on a session bus, and it throws for a registration that did not declare `handsUp`. Three commands declare it: `preset.recall` (a page bank, to the instance in view), `cue.go` and `cue.back` (no list named, to the show).
- **G3 is also a registration-time refusal.** An `instance` command whose schema holds an undeclared string, or no node address, or that has no `rejectionOutput`, does not register. Pull request #1's own test double was the first thing it would have caught: with a plain `z.string()` schema its ids were not rewritten.
- **A session does not register its own copy of a command it inherits** (the bus throws), so the double registrations cannot come back unnoticed.
- **`sharedForBus` resolves to the root from slice 1**, not slice 2: with inheritance a pane's `if (bus.hasCommand(x)) return` guard stops registering on the session bus, so what the command holds has to be the root's from the same commit. `sharedForDocument` is the per-bus form, used by the preset catalogue holder.
- **`ui.beginRename` asks the canvas which nodes it shows** (T1195's M1, for rename): inherited, it would otherwise have refused every node inside a component.
- **Ruled 2026-10-06:** the four instance commands and a page bank's recall answer the same from the button inside and from an expression. An inner bank's recall and a cue list's GO and BACK edit the component from the button and are refused from a running instance by name (`preset.bank.inner`, `cue.list.inInstance`), because the state they write is the component's.
- **Doors (slice 2):** the keymap, the palette, the component bar and the component library dispatch on the edit bus; `ContextMenuHost` runs a row on the bus it read its target from; `doorBuses`, `rootBus` and the 13 double registrations are gone; `control.*` and the component file picker reach sessions; the node and parameter clipboards are one per project (B292).
- **Not built, as §3 says:** a declared `refused`; "every instance"; the audit's `via`; one undo timeline; output id mapping (no inherited command returns ids yet).
- **Left for T1697b:** `node.openViewer`, `ui.showNodeInfo`, `preview.setView`, `preview.resetView` and `perform.toggle` are declared `app` with a note at each registration; the eleven files in `flat-id-joiner.test.ts`'s `OWED` list.
- **Left for T1698b:** grants, the frame clock and the channel resolver on a session bus; queries.

Under a model where a component is a folder of real nodes and only a LINKED component has a definition edited apart from its instances: `inSession`, the marked schemas and `addressing.ts` stay as they are (they are facts about commands and about names). The bus's `parent` and `scope`, `sharedForBus`'s root rule and `openComponentSession`'s three options stay for linked components and are not reached by a dive into a plain folder, which edits the project through the project's bus. Nothing in either slice assumes a dive opens a session: the doors take `editing.bus`, which is the project's bus whenever no session is live.
