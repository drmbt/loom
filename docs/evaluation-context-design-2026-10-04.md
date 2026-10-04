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
| `presets/timeline-cues.ts` | storage | `resolveStored` (the structure is built once per revision). Ruled live in §T1559b (2), but NOT changed: see "T1559b (2)" below — reported back for a second ruling |
| `editor/component/component-page.tsx` `publishedValue` | storage | `resolveStored` ("what one of them holds") |
| `editor/component/component-scope.ts` `resolveInstanceValues` | storage | `resolveStored` (stored space by its docblock) |
| `editor/component/component-scope.ts` `resolveComponentParameters` | the caller's choice | takes a required `read` (no product caller; tests pass `STORED_READ`) |
| `editor/viewer/gizmo-tiles.ts` | storage | `resolveStored` (a handle edits the stored value; a driven key's handle is held) |
| `channels/graph-channels.ts` (the fold during a fade) | evaluation, no channels on purpose | `parameterReadOptions` with `channels: undefined` stated (every slot is settled to its static first; only the fold reads) |
| `compiler/validate.ts`, `time-probe.ts`, `frame-compile.ts` | evaluation | the factory (unchanged); the `nodes` override is gone |
| inspector ×2, `pulse.ts`, OSC ×2, vision, inference, perform mapping, analyze | evaluation | the factory (unchanged since T1551b) |
| `parameters/node-references.ts` `targetOf` | the producer | brands its own recursive read |
| `app/media-playback.ts` | evaluation | the deprecated adapter (owned elsewhere; design item 5) |
| `app/use-media-sources.ts` (Text raster) | frameless evaluation | **deprecated overload**, in the ledger (owned elsewhere) |
| `domain/media/transport.ts` (free-run classification) | storage | **deprecated overload**, in the ledger (owned elsewhere; becomes `resolveStored`) |
| `domain/channels/value-graph.ts` | evaluation, channel-free | **deprecated overload**, in the ledger (another session's uncommitted work) |

### What is still open, and why

- **The deprecated overload is not deleted yet.** `resolveParameters` and `resolveParameterSchema` keep one `@deprecated` overload that takes the old optional options. They keep it because four call sites sit in files this step could not touch: `use-media-sources.ts`, `domain/media/transport.ts` and its test, and `value-graph.ts`. Until it goes, a call that lands on it still compiles. `effective-schema-closure.test.ts` (§T1557b block, `LEGACY_READ_CALLERS`) holds the line instead. It asks the TypeScript checker which declaration each call resolved to, and it fails on any caller of the deprecated overload that is not in its ledger. It also fails on a ledger entry that has migrated. When the ledger is empty, delete the overload and that block.
- **`value-graph.ts`.** The other session's uncommitted version calls `createParameterReadOptions`. That already fails T1551b's gate, and it needs `parameterReadOptions({ graph, registry, frame, channels, flattening })` instead. Either way its call becomes branded, so its `LEGACY_READ_CALLERS` entry goes stale: strike it when that work lands. `controls-pane.tsx`'s uncommitted call has the same `createParameterReadOptions` problem. This change does not break it.
- **The headless server attaches nothing.** `mcp/serve.ts` has no transport (no frame), no channel resolver and no component catalogue (T1494b, so no instance and nothing inlined). The bus default (frameless, `NO_FLATTENING`) is therefore exactly its truth. Attaching the same values by hand would add no information. Every command it registers reads `context.readScope()` from the one producer inside `createCommandBus`.
- **A spread can still override a field:** `{ ...STORED_READ, channels }` typechecks. The brand stops a read from being *built* incompletely, not one from being deliberately altered. No product site does this, and the two greppable producers make it visible in review.
- **The call gate stays.** The T1129 check in `node-references.test.ts` (`createNodeReferenceReader` called only in its module) is still needed. The reader factory is exported for the reader's own tests, and the brand does not stop a module from building a bare reader.

## T1559b (1): the media callers moved

- **Design item 5 is done.** `MediaTransportContext.flattening: () => FlatteningReads` replaced `morphs`. Both doors pass the flattening whole: `use-media-sources.ts` passes `() => runtime.flattened.current()`, and `use-audio-input.ts` takes `getFlattening` (`app.tsx` passes the same getter; absent, it reads `NO_FLATTENING`). The runner reads through `parameterReadOptions`, so `op('<instance>').chan.<c>` on a transport parameter now reads the instance. Test: `media-playback.test.ts`, "§T1559b — a Movie's Speed driven by …", red-verified.
- **The Text raster and the free-run classification are storage reads.** They call `resolveStored`. Both are built per document change with no frame, which is what they always read.
- **`createParameterReadOptions` and `LegacyParameterReadContext` are deleted.** The `node-references.test.ts` block that allow-listed callers went with them, because a call to a deleted function is a type error.
- **`resolveParameters` has no deprecated overload left.** `effective-schema-closure.test.ts` now proves that an options literal there is a type error. `resolveParameterSchema` keeps its overload for `value-graph.ts` alone, which is the only `LEGACY_READ_CALLERS` entry left (another session's uncommitted work). Delete it, and the ledger block, when that work lands.

## T1559b (2): the three stored follow-ups, ruled live

- **Parameter copy reads the row's read.** `capture` (`parameter-commands.ts`, both the whole-key and the component path) resolves through `context.readScope()`: the frame on screen, the app's channels, `op()` reads of the document as authored, and the flattening's instances. It reads no fade (`NO_MORPHS`), because the inspector's row shows the document's (destination) value mid-fade by design (T1525b), and the copy copies what the row shows. Test: `parameter-commands.test.ts`, "§T1559b — a copy reads what the row shows", red-verified (the copy gave the static 2 for `op('blur1').par.radius`, and the zero frame's 0 for `time / 10` on `tint.g`).
- **A native output's Publish follows a driven value.** `use-native-outputs.ts` still keys the session on the stored values per revision. `enabled` is read once per frame in the pump's tick through `bus.readScope()` over the flattened graph the node came from, morphs included. The tick reconciles, so a change of the resolved value acts once: an open on a rising edge, a close on a falling edge, and nothing re-applied while it holds. There is no debounce. A value that flips every frame is rate-limited by the existing drain rule: a close drains before the next open (`draining`), so sessions cannot stack up. Test: `use-native-outputs.test.tsx`, "§T1559b — Publish driven by an expression …", red-verified (at t = 2 s nothing opened).
- **Timeline cues still read the bank's Morph stored.** This was not changed, because the ruling left one thing open. GO reads the Morph once, at the moment of the command, and writes the seconds into the morph record it commits. A timed cue writes nothing. Its fade is recomputed from scratch at every playhead (`stepsAt(nodeId, key, frame)`, which is a pure function of the revision and the frame), and that is what makes playback, a cold seek and an export agree (§T1508b). A live Morph needs a moment to be read at, and both candidates break something:
  - **At the current frame:** the fade length changes during the fade, so `(t − at) / seconds(t)` can jump or run backwards, and "the newest finished cue" can become unfinished again.
  - **At the cue's reach frame (GO's analogue):** this needs channels at a past frame. The read world has none: a framed read of the value graph returns the last evaluated frame. It would only be exact for pure time expressions and pure channels. A stateful stage (Lag) or a device channel (MIDI, audio, OSC) would differ between playback, a seek and an export.
  
  Either way, the morph index (`MorphIndexInput`, built per revision in flatten and compile) would need a read scope it does not have today, and `ParameterMorphs.stepsAt` would need one passed through it. Options for the ruling: (a) read at the reach frame, accepting that it is exact only for deterministic drivers; (b) read at the current frame; (c) keep it stored and add a named warning on a timed list whose bank's Morph is driven.

