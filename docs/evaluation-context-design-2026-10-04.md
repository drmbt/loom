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

## What is not done (step 2) and why

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
