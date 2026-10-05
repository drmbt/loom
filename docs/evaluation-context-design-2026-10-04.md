# Evaluation context: one value, required fields (T1551b)

## The cause

A parameter read needs five inputs: the graph `op()` names resolve in, the catalogue, the frame, the channel resolver, and what the flattening knows (the preset morphs in flight and the component instances `op('<instance>').chan.<c>` can name). Before T1551b, `ParameterReadContext` made every input except `graph` and `registry` optional. About a dozen callers each built a partial context from whatever they held. Each new input had to be threaded into every caller by hand: the frame (B46), the morphs (T1497b), and the instances (T1485b). A caller that missed one still compiled. On a static document it also still looked right, because an absent input falls back silently (§V108's retained static, or the zero frame).

## What landed (step 1: the factory and its callers)

- **`ParameterReadContext` fields are all required:** `{ graph, registry, frame, channels, flattening }`. `frame` and `channels` may be `undefined`, but the key has to be written. `flattening: FlatteningReads` is `{ morphs, instanceChannels }`. A caller with nothing to pass says so by name with `NO_FLATTENING`, `NO_INSTANCES` or `NO_MORPHS`.
- **`FlattenedGraph extends FlatteningReads`.** The runtime passes its flattening to readers whole (`runtime.flattened.current()`). A field added to `FlatteningReads` therefore reaches every live reader without call-site changes. It is a type error in `flatten.ts`, in `NO_FLATTENING`, in the compiler's `flatteningReadsOf`, and at every hand-built literal (the inspector, OSC's port-settled read).
- **One live producer.** `LiveParameterReads` is `{ channels(), flattening() }`. `app.tsx`'s `liveReads` builds it once. The analyze, depth, vision, perform-window and viewer readers extend it instead of re-describing the tuple. The pulse watcher and the OSC pump take the flattening as a required argument.
- **The factory is now `parameterReadOptions(context)`.** `createParameterReadOptions` is a deprecated adapter that keeps the old optional-field shape. It exists for the one caller this step could not touch: `src/app/media-playback.ts`, which another session owns. The adapter reads no instance channels.
- **Gate:** `node-references.test.ts` (in `test:gates`) fails if any product file other than `media-playback.ts` calls the adapter.

### Survey: factory call sites before → after

| Site | graph | frame | channels | morphs | instances (before) | After |
|---|---|---|---|---|---|---|
| `compiler/validate.ts` | flat graph being compiled | resolution | resolution | resolution | resolution | `flatteningReadsOf(resolution)` |
| `compiler/time-probe.ts` | same | shifted | resolution | resolution | resolution | same |
| `compiler/frame-compile.ts` | retained graph | resolution | resolution | resolution ?? retained | resolution ?? retained | same |
| `editor/inspector/inspector.tsx` | document (or instance view) | panel's | prop | omitted (by design, T1525b) | `valueGraph.instanceChannels()` | explicit `NO_MORPHS` plus the instances |
| `domain/parameters/pulse.ts` | `flattened.graph` | frame | `channelsRef` | `flattened.morphs` | **missing** | `flattened`, whole |
| `app/use-osc-bridge.ts` (×2) | flat graph | frame | value-graph resolver | `flattened.morphs` (ports: omitted by design) | **missing** | `flattened`; ports read `{ NO_MORPHS, instances }` |
| `app/use-vision-bridge.ts` | tracked flat graph | frame | `liveReads` | `liveReads` | **missing** | `liveReads.flattening()` |
| `app/inference-parameters.ts` | tracked flat graph | frame | `liveReads` | `liveReads` | **missing** | same |
| `app/perform-mapping.ts` | caller's | at ?? last rendered | `liveReads` | `liveReads` | **missing** | same |
| `runtime/execution/analyze-channels.ts` | tracked flat graph | read | read | read | **missing** | `liveReads.flattening()`; the compile snapshot is explicit `NO_FLATTENING` |
| `app/media-playback.ts` | `context.graph()` | frame | getter | getter | **missing** | **not migrated** (adapter) |

## Step 2 as designed under T1551b (landed as T1557b; see the last section)

Seam audit finding 1 found 20 direct `resolveParameters` / `resolveParameterSchema` calls that never go through the factory. Four of them pass `channels` with no reader, which is B181's shape:

- `agent/tools/presets.ts`
- `presets/commands.ts`
- `presets/cue-commands.ts`
- `viewer/camera-pose.ts`

Closing those means making `resolveParameters` itself take the context. That touches about 30 product sites and 128 test call sites in 27 files. It also needs a judgement per site: an evaluation read or a storage read? And it needs `CommandContext` to supply frame, morphs and instances, which it cannot today (`bus.ts`). That is more than a day of work, and most of it sits in paths owned by other tracks, so it is designed here and not started.

### Design

1. **`resolveParameters(node, definition, read: ParameterReadOptions)` with `read` required.** `ParameterReadOptions` is a branded return type of `parameterReadOptions`, so an object literal cannot stand in for it. The factory stays the only producer, and the "options literal without a reader" shape stops typechecking instead of needing a gate.
2. **`resolveStored(node, definition)`** for the storage-side reads: commands that locate a slot, `morph-index.ts`, `parameter-commands.ts`, and `detach-values.ts`. These read what the document says on purpose, with no frame and no channels, and the name says so.
3. **Commands:** `CommandContext.readScope(): ParameterReadContext`, attached by the composition root the same way `attachFlattenedGraph` and `channelResolver()` are. `mcp/serve.ts` attaches the same producer headlessly. The four B181-shape sites above then read through it.
4. **Migration order:** add the brand and `resolveStored` first, re-export the old signature as deprecated, migrate one directory per commit, then delete the deprecated signature. Once that is done, the call gate in `node-references.test.ts` can go: the type does its job.
5. **`media-playback.ts`:** `MediaTransportContext.morphs` becomes `flattening: () => FlatteningReads`. `use-media-sources.ts` and `use-audio-input.ts` pass `() => runtime.flattened.current()`. The `readAll` call becomes `parameterReadOptions({ graph: context.graph(), registry: context.registry, frame, channels, flattening: context.flattening() })`. Then delete `createParameterReadOptions` and `LegacyParameterReadContext`, and empty the gate's allow-list down to `node-references.ts`.

## What landed (step 2, T1557b)

- **The brand.** `ParameterReadOptions` (`resolve.ts`) is `Pick<ResolveParametersOptions, "frame" | "channels" | "nodes" | "morphs">` plus a property keyed by a `declare const` unique symbol. No module can write that key, so an object literal cannot stand in for a read. There are two ways to hold one. `parameterReadOptions(context)` takes a complete `ParameterReadContext`. `STORED_READ` is the storage read and is named as one. `node-references.test.ts` (in `test:gates`) fails if any product module other than those two files casts to the type.
- **The signatures.** `resolveParameters(node, definition, read)`, `resolveParameterSchema(node, schema, read)` and `resolveParameter(node, key, definition, read)` take a required `ParameterRead`: the read plus `ResolveExtras` (`drivers`, `parentBind`, `schema`), which only a call site can know. Extras ride on a spread such as `{ ...read, drivers }`. The compiler's `resolveNodeParameters` and `resolveParameterValues` also take a required read. `ParameterResolution` no longer has a `nodes` field: no caller passed its own reader, and that override was the one way into `validateGraph` that bypassed the factory.
- **`resolveStored(node, definition, extras?)` and `resolveStoredSchema(node, schema, extras?)`** are the spelled-out storage read: no frame, no channels, no cross-node reader, no morphs. An expression resolves at the zero frame, and a driven value resolves to its retained static (§V108). The private `resolveStored` helper inside `resolve.ts` is now `resolveSlot`.
- **`CommandContext.readScope()` and `LoomBus.readScope()`** return a complete `ParameterReadContext`. The context holds the command's graph (the bus's version holds the store's current document), the registry, the frame the transport last produced, the app's channel resolver and its flattening. One closure inside `createCommandBus` produces both. Each input is attached by the composition root, the same way the existing inputs are:
  - `attachFlattenedGraph` now takes the flattening whole (`FlatteningReads & { graph }`). `use-graph-compile.ts` passes `flattenedRef.current`, and `bus.flattenedGraph()` still returns its graph.
  - `attachFrame` is new. `use-frame-loop.ts` attaches `latestFrameRef.current?.frame` in the same effect as the frame clock, so a command reads the frame on screen. A framed read of the app's value graph returns the last evaluated frame and never advances a stateful stage.
  - With nothing attached, the scope is frameless and uses `NO_FLATTENING`, which is the truth for a headless bus (§V338).
- **The four §B181-shape sites now read through the scope.** Each one got a failing test first. The test was written against the unfixed code and observed red, reproducing the literal bug (`op('k1').chan.value` read the retained static), and goes green with the fix:
  - `presets/commands.ts`: Recall reads the bank's Select, Morph and Curve through the new `bankSettings(view, registry, scope)`. A Recall pulse fired inside a look reads its flat bank over `{ ...readScope(), graph: flattened }`. Test: `morph-recall.test.ts`, "§T1557b — a bank's Morph driven by op('k1').chan.value".
  - `presets/cue-commands.ts`: GO reads the bank's Morph through `bankSettings`. The list's Keys and position, and the `cue.list` report, read through the scope. Test: `cue-commands.test.ts`, "§T1557b — GO on a bank whose Morph is …".
  - `agent/tools/presets.ts`: `list_presets` reads through `bankSettings` over `bus.readScope()`. Test: `agent/preset-tools.test.ts`, "§T1557b — list_presets on a bank …".
  - `editor/viewer/camera-pose.ts`: the new `cameraPoseAt(node, definition, scope)` is exactly what `graph-pane.tsx` calls, with `{ ...bus.readScope(), graph, registry }`. `readCameraPoseFacts` now takes a read. Test: `camera-pose.test.ts`, "§T1557b — a camera eye channel on op('k1').chan.value".
  - None of the four turned out to be a storage read on purpose. Two of them got narrower fixes: an **instance** bank's settings still read stored, because its page bank is a node of the definition's graph and no root channel, morph or `op()` name belongs to it (the per-instance read is the flat bank a pulse names), and Store's capture is stored by ruling 2 and never was one of the four sites.

### Per-site judgement (every direct product call)

| Site | Evaluation or storage | Reads through |
|---|---|---|
| `agent/tools/presets.ts` `bankView` (list_presets) | evaluation (§B181) | `bankSettings` over `bus.readScope()` |
| `presets/commands.ts` Recall's Select/Morph/Curve | evaluation (§B181) | `bankSettings(context.readScope())`; a pulse's flat bank over the flattened graph |
| `presets/commands.ts` `bankSettings` for an **instance** bank | storage, for now | `resolveStored`: the page bank lives in the definition (see above) |
| `presets/cue-commands.ts` Keys, position, `cue.list`, GO's Morph | evaluation (§B181) | `context.readScope()` / `bus.readScope()`; GO via `bankSettings` |
| `editor/viewer/camera-pose.ts` (graph-pane gizmo) | evaluation (§B181) | `cameraPoseAt` over `bus.readScope()` |
| `commands/parameter-commands.ts` copy (×2, T1008) | evaluation (§T1559b (2), ruled) | `context.readScope()` with no fade (`NO_MORPHS`), which is the inspector row's read: a copy copies what the row shows |
| `commands/parameter-commands.ts` mode switch seed | storage | `STORED_READ` (the seed is written into the document) |
| `presets/morph-index.ts` `bakedEnd` | storage | `STORED_READ` (stored space, no frame, by its docblock) |
| `components/detach-values.ts` | storage | `resolveStoredSchema` (writes the page back, as flattening resolves it) |
| `compiler/flatten.ts` published page | storage | `STORED_READ` (§V529: a pure function of the document) |
| `examples/runtime-requirements.ts` | storage | `STORED_READ` (a requirement is compile-time) |
| `app/use-requirement-diagnostics.ts` | storage | `resolveStored` (same rule as above) |
| `app/use-native-inputs.ts` | storage | `resolveStored` (which device; memoized per revision) |
| `app/use-native-outputs.ts` session key, name | storage | `resolveStored` (session key per revision) |
| `app/use-native-outputs.ts` `enabled` (Publish) | evaluation (§T1559b (2), ruled) | `bus.readScope()` over the flattened graph, once per frame in the pump's tick; the session acts on edges |
| `presets/timeline-cues.ts` (a timed cue's Morph and Curve) | storage (§T1559b (2), ruled 2026-10-05) | `resolveStored` (the plan is built once per revision, and a timed cue's fade is recomputed at every playhead). A root bank whose Morph or Curve is driven gets the named warning `cue.timeline.drivenMorph`; GO and Recall still read it live |
| `editor/component/component-page.tsx` `publishedValue` | storage | `resolveStored` ("what one of them holds") |
| `editor/component/component-scope.ts` `resolveInstanceValues` | storage | `resolveStored` (stored space by its docblock) |
| `editor/component/component-scope.ts` `resolveComponentParameters` | the caller's choice | takes a required `read` (no product caller; tests pass `STORED_READ`) |
| `editor/viewer/gizmo-tiles.ts` | storage | `resolveStored` (a handle edits the stored value; a driven key's handle is held) |
| `channels/graph-channels.ts` (the fold during a fade) | evaluation, no channels on purpose | `parameterReadOptions` with `channels: undefined` stated (every slot is settled to its static first; only the fold reads) |
| `compiler/validate.ts`, `time-probe.ts`, `frame-compile.ts` | evaluation | the factory (unchanged); the `nodes` override is gone |
| inspector ×2, `pulse.ts`, OSC ×2, vision, inference, perform mapping, analyze | evaluation | the factory (unchanged since T1551b) |
| `parameters/node-references.ts` `targetOf` | the producer | brands its own recursive read |
| `app/media-playback.ts` | evaluation | the factory, with `context.flattening()` whole (§T1559b (1)) |
| `app/use-media-sources.ts` (Text raster) | storage | `resolveStored` (§T1559b (1): built per document change, with no frame) |
| `domain/media/transport.ts` (free-run classification) | storage | `resolveStored` (§T1559b (1)) |
| `domain/channels/value-graph.ts` (a value node's own parameters) | evaluation | the factory, over the `FlatGraph` `evaluate` is handed, with this evaluation's channels, the frame and the flattening whole (`extras.flattening`, §T1559b (1)) |
| `editor/controls/controls-pane.tsx` (a driven widget's display) | evaluation, authored, no fade | the factory over `authoredGraph(store document)` with the app's channels, the frame on screen, `NO_MORPHS` and the instances off `bus.readScope()`. The pane lists authored widgets only (none inside a component, T1143), and mid-morph a control shows its document value (T1525b) |

### What is still open, and why

- **The deprecated overload: closed by §T1559b (1).** T1557b left one `@deprecated` overload on `resolveParameters` and `resolveParameterSchema` for four call sites it could not touch, and a ledger in `effective-schema-closure.test.ts` (`LEGACY_READ_CALLERS`) that asked the checker which declaration each call resolved to. All four have migrated, both overloads are deleted and the ledger went with them. See "T1559b (1)" below.
- **The headless server attaches nothing.** `mcp/serve.ts` has no transport (no frame), no channel resolver and no component catalogue (T1494b, so no instance and nothing inlined). The bus default (frameless, `NO_FLATTENING`) is therefore exactly its truth. Attaching the same values by hand would add no information. Every command it registers reads `context.readScope()` from the one producer inside `createCommandBus`.
- **A spread can still override a field:** `{ ...STORED_READ, channels }` typechecks. The brand stops a read from being *built* incompletely, not one from being deliberately altered. No product site does this, and the two greppable producers make it visible in review.
- **The call gate stays.** The T1129 check in `node-references.test.ts` (`createNodeReferenceReader` called only in its module) is still needed. The reader factory is exported for the reader's own tests, and the brand does not stop a module from building a bare reader.

## T1559b (1): the media callers moved

- **Design item 5 is done.** `MediaTransportContext.flattening: () => FlatteningReads` replaced `morphs`. Both doors pass the flattening whole: `use-media-sources.ts` passes `() => runtime.flattened.current()`, and `use-audio-input.ts` takes `getFlattening` (`app.tsx` passes the same getter; absent, it reads `NO_FLATTENING`). The runner reads through `parameterReadOptions`, so `op('<instance>').chan.<c>` on a transport parameter now reads the instance. Test: `media-playback.test.ts`, "§T1559b — a Movie's Speed driven by …", red-verified.
- **The Text raster and the free-run classification are storage reads.** They call `resolveStored`. Both are built per document change with no frame, which is what they always read.
- **`createParameterReadOptions` and `LegacyParameterReadContext` are deleted.** The `node-references.test.ts` block that allow-listed callers went with them, because a call to a deleted function is a type error.
- **No reader has a deprecated overload left.** `resolveParameters` lost its overload with the media callers. `resolveParameterSchema` lost its own once `value-graph.ts` landed on `parameterReadOptions` (the Panel MIDI work, `01b2ab30`). The loose options type's three barrel re-exports went too (`domain/parameters/index.ts`, `editor/inspector/parameter-resolver.ts`, `editor/inspector/index.ts`): nothing imported them, and no public function takes that type any more. `ResolveParametersOptions` itself stays exported from `resolve.ts`, because `node-references.ts` and `compiler/validate.ts` build their own types from it.
- **The ledger block is gone; a type probe replaced it.** `LEGACY_READ_CALLERS`, `collectLegacyReads` and the two ledger tests existed only while a loose call could compile. `effective-schema-closure.test.ts` now compiles one probe file with the app's tsconfig and asserts errors on exactly six lines: an options literal (`{ channels }`) and a missing read, on each of `resolveParameters`, `resolveParameterSchema` and `resolveParameter`. The three `STORED_READ` calls beside them must typecheck. Red-verified by putting an overload back on each of the first two.
- **The value graph takes the flattening by type.** `ValueGraphSession.evaluate(graph: FlatGraph, …)`; the placeholder `authoredGraph(graph)` inside it is gone. See `docs/graph-brands-design-2026-10-04.md`.
- **The value graph and the Controls pane read instances.** Found while typing `evaluate`: both built their read with the morphs or nothing, and no instances, which is the shape T1551b removed everywhere else.
  - *The value graph.* Since the Panel MIDI work a value node's own parameters resolve against the evaluation's channels. The reader was built with `{ ...NO_FLATTENING, morphs }`, so a Slider whose value is `op('analysis1').chan.level` published its retained value, while a texture node reading the same expression compiled to the instance's. `evaluate` now takes `extras.flattening: FlatteningReads` in place of `extras.morphs`, and `use-value-graph.ts` passes the runtime's flattening whole. The zero-frame twin passes the instances and `NO_MORPHS`, because the structural compile reads no fade.
  - *Ordering.* `op('<instance>')` names no node of the flattening, so `parameterDependencies` finds no dependency for it. The value graph now orders such a reader after the inner nodes the instance's value outputs publish from. Without that, a reader whose id sorts before `inst/…` reads a bag that is not published yet.
  - *The pane.* It read with `NO_FLATTENING`, so the same Slider showed its retained value, although the inspector's row for that slot reads the flattening's instances (T1485b). It now takes the instances from `bus.readScope()`.
  - Tests, each observed red first: `instance-channel-reference.test.ts`, "§T1559b — the value graph reads …" (both Sliders published 0.25; with the ordering alone removed, the early one still did), and `controls-pane.test.tsx`, "§T1559b — a widget driven by a component instance's channel" (the pane showed 0.25 while the Slider published 0.5).
  - Not done: `flattening` is an optional field of `extras`, so a caller can still leave it out. Two offline twins of the frame path do: `examples/concepts/helpers.ts` (`valueGraphRun`) and `tests/headless/cook-oracle.ts`. Making it required touches about 100 test calls.

## T1559b (2): the three stored follow-ups — two ruled live, timeline cues ruled stored

- **Parameter copy reads the row's read.** `capture` (`parameter-commands.ts`, both the whole-key and the component path) resolves through `context.readScope()`: the frame on screen, the app's channels, `op()` reads of the document as authored, and the flattening's instances. It reads no fade (`NO_MORPHS`), because the inspector's row shows the document's (destination) value mid-fade by design (T1525b), and the copy copies what the row shows. Test: `parameter-commands.test.ts`, "§T1559b — a copy reads what the row shows", red-verified (the copy gave the static 2 for `op('blur1').par.radius`, and the zero frame's 0 for `time / 10` on `tint.g`).
- **A native output's Publish follows a driven value.** `use-native-outputs.ts` still keys the session on the stored values per revision. `enabled` is read once per frame in the pump's tick through `bus.readScope()` over the flattened graph the node came from, morphs included. The tick reconciles, so a change of the resolved value acts once: an open on a rising edge, a close on a falling edge, and nothing re-applied while it holds. There is no debounce. A value that flips every frame is rate-limited by the existing drain rule: a close drains before the next open (`draining`), so sessions cannot stack up. Test: `use-native-outputs.test.tsx`, "§T1559b — Publish driven by an expression …", red-verified (at t = 2 s nothing opened).
- **Timeline cues read the bank's Morph stored, and say so when it is driven (second ruling, 2026-10-05: option (c) below).** The first ruling said "live" for all three, but it left one thing open for this site. GO reads the Morph once, at the moment of the command, and writes the seconds into the morph record it commits. A timed cue writes nothing. Its fade is recomputed from scratch at every playhead (`stepsAt(nodeId, key, frame)`, which is a pure function of the revision and the frame), and that is what makes playback, a cold seek and an export agree (§T1508b). A live Morph needs a moment to be read at, and both candidates break something:
  - **At the current frame:** the fade length changes during the fade, so `(t − at) / seconds(t)` can jump or run backwards, and "the newest finished cue" can become unfinished again.
  - **At the cue's reach frame (GO's analogue):** this needs channels at a past frame. The read world has none: a framed read of the value graph returns the last evaluated frame. It would only be exact for pure time expressions and pure channels. A stateful stage (Lag) or a device channel (MIDI, audio, OSC) would differ between playback, a seek and an export.
  
  Either way, the morph index (`MorphIndexInput`, built per revision in flatten and compile) would need a read scope it does not have today, and `ParameterMorphs.stepsAt` would need one passed through it. The options were: (a) read at the reach frame, accepting that it is exact only for deterministic drivers; (b) read at the current frame; (c) keep it stored and add a named warning on a timed list whose bank's Morph is driven.

  **Ruled (c), and built.** What a timed cue reads is unchanged: `resolveStored` on the bank, so an expression is read at the zero frame with no channels, and a channel or `op()` read falls back to the slot's stored value. What is new is the warning `cue.timeline.drivenMorph`:
  - **When.** A list that follows the timeline has a timed cue that takes its fade from the bank (neither the cue nor its preset carries a morph, and the recall is not refused), and the bank's Morph or Curve is in any mode but static. Curve is covered because the same line reads both (`presetMorph`), and an expression on it picks an option by index. One warning per list, bank and parameter, however many cues read it.
  - **What it says.** The cue list, the bank and the parameter by name, the value the timed cues use (`2 s`, or the curve), and that GO on a live list and a direct Recall read the driven value.
  - **Where.** `planTimelineCues` files it with the plan's other warnings, so the list's inspector section and `cue.list` show it. `compileGraph` also adds it to its diagnostics (`timelineCueProblems`), so it is in the Problems list of both composition roots through the `compile` source, with the BANK as its node: the person driving a Morph is looking at the bank, not at the list. It is the only timeline warning the compile carries. The others are about the list's own cues and are still shown only on the list.
  - **Not said for:** a static Morph; a bank that only a live list fires; a cue or preset with its own morph; an instance bank. An instance's Morph is its definition's page bank's, and GO reads that stored too (`bankSettings`), so the two doors already agree.
  - Tests: `compiler/timeline-cue-problems.test.ts` (the diagnostic and the fade's stored seconds in the plan's uniform), `timeline-cues.test.ts` and `instance-bank.test.ts` ("§T1559b (2)"), and `tests/integration/problems-registry.test.tsx` (the mounted app's Problems list). GO's live read is `cue-commands.test.ts`, "§T1557b — GO on a bank whose Morph is …". Red-verified.

