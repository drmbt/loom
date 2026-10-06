# Authored vs flat graph: two types (T1552b)

## The cause

The document the user authored and the graph the compiler, the runtime and every per-frame reader evaluate were both typed `GraphDocument`. A consumer that needed the flattening therefore accepted `store.getGraph()` without complaint, and a component's internals did not exist for it. That happened in B29, B41, B177, B188, T615 (six sites with one cause), T1067, T1485b and T1550b. `frame-path-flattening.test.ts` held the line by spelling: it scans `src/app` for `store.getGraph`. It could not see `src/editor`, and it could not see a raw graph passed in from elsewhere.

## The names

- **`FlatGraph`** is `GraphDocument & { [flatGraphBrand]: true }` (`domain/types/graph.ts`). The key is a `declare const` unique symbol, so no module can write it.
  - Producers: only the flattener. `flattenComponents` makes one. `compiledWithoutCatalogue(graph)` covers the compile handed no catalogue, which reads the document as-is; there an instance meets the manifest's `component.notFlattened` tripwire.
  - Both producers sit in `compiler/flatten.ts`, behind one private `flat()` cast.
  - `compiledWithoutCatalogue` also names two graphs that are evaluated with no catalogue outside a compile: the node-body plot's cut-out (`editor/nodes/value-plot-chain.ts`, T1559b) and the placeholder empty graph in `use-analyze-channels.ts`.
- **The authored store graph stays `GraphDocument`.** Most code that edits, saves, patches or lays out the document is untouched. That is why the brand sits on the flat side: it has one producer, while the authored side has hundreds of readers.
- **`AuthoredGraph`** is a second brand, made only by `authoredGraph(graph)`, which refuses a `FlatGraph`. It exists for the sites that **evaluate** parameters and legitimately accept either side. Each of them must now say which side it reads.
- **`FlatOrAuthoredGraph`** is the union those evaluating sites take.
- **A spread keeps the kind.** `{ ...flat, nodes }` is still a `FlatGraph`, which is how a transform of the flattening stays flat. This is the same accepted hole as `{ ...STORED_READ, channels }`.
- **Kind-preserving transforms are generic over `G extends GraphDocument`:** `synthesizeSourceReferenceEdges`, `applyTimelineStructure`, and the layer warm-up's spread.

## Where each is consumed

### Takes `FlatGraph`

A bare `GraphDocument` is a type error at each of these.

| Area | Consumer |
|---|---|
| compiler | `FlattenedGraph.graph`, `RetainedCompile.graph`, `timeProbeFor`, the per-frame compiler (reads `retained.graph`) |
| bus | `attachFlattenedGraph`, `flattenedGraph()` |
| app compile | `GraphCompileResult.flatGraph` |
| per-frame readers | the value graph's `evaluate` (T1559b), pulse watcher `step`, OSC `sync`, `graphChannelResolver` |
| media | `MediaTransportContext.graph`, `useMediaSources`, `useAudioInput`'s `getGraph` |
| Analyze | `analyzeChannelEntries`, `analyzeOperationOf`, `analyzeReadbacks`, `useAnalyzeChannels.track` |
| vision / inference | `track`, the vision `graph` getter, `minIntervalAt`, `inferenceParametersAt` |
| file and device doors | `useFileReferences`, `requirementDiagnostics`, `useNativeInputs`, `useNativeOutputs`, `useScreenSources` |
| inspector | `InstanceParameters.read` (the inspector's instance view reads the flattening) |

### Takes `FlatOrAuthoredGraph`

`ParameterReadContext.graph` (so `parameterReadOptions`), `validateGraph`, and `liveParameters` (perform mapping).

### Reads the document as authored, on purpose

These sites now say `authoredGraph(…)` by name:

| Site | Why it reads the authored document |
|---|---|
| the bus's `readScope()` | a command addresses authored ids |
| the inspector | the node the user selected |
| `project.validate` | "the whole document", instances whole |
| perform windows | a Window Out is an authored node |
| the viewer's mapping overlay | the pane's authored `graph` |
| the graph pane's camera gizmo | authored ids |
| agent `list_presets` | reads the document |
| `cue.list` | reads the document |
| test reads (`testRead`) | a test document with no flattening behind it |

Where a command must read the flattening (a Recall pulse fired inside a look), it overrides `graph` with `bus.flattenedGraph()`, which is typed flat.

## The gate

`frame-path-flattening.test.ts` (in `test:gates`) gains a §T1552b block with two checks. Both were red-verified.

- **No brand forged.** An `as FlatGraph` cast in any product module other than `compiler/flatten.ts` fails the gate, as does an `as AuthoredGraph` outside `domain/types/graph.ts`. Tests may force the defect on purpose: `component-animation.test.ts`'s raw-document controls do. Tests mint flat graphs through `flatDocument(graph)` (`compiler/test-support.ts`). It throws on a document holding a component instance, because handing that to a flat consumer is the mistake itself.
- **The checker refuses the mistake.** A probe file is compiled with the app's tsconfig, and the gate asserts errors on exactly seven lines:
  - the store's document passed where the flattening is needed;
  - `parameterReadOptions` handed a bare document;
  - `authoredGraph(flat)`;
  - the value graph's `evaluate` handed the store's document (T1559b);
  - `evaluate` handed `authoredGraph(document)` (T1559b);
  - `evaluate` called with no third argument, so no flattening is said (T1559b);
  - `evaluate` handed inputs with no `flattening` among them (T1559b).

## The scan over `src/editor`: not extended

Every editor read that evaluates now goes through `parameterReadOptions` or `validateGraph`, and must say `authoredGraph(…)` or hand a `FlatGraph`. Every consumer that needs the flattening is typed. A `store.getGraph()` under `src/editor` therefore cannot reach either without a type error, or without a visible `authoredGraph(…)` a reviewer reads. The brand does the job the scan would have done there.

The scan over `src/app` did not shrink either, and T1559b looked again once the value graph was typed:

- **The value graph is typed now.** `ValueGraphSession.evaluate(graph: FlatGraph, …)` (T1559b). The frame path and its zero-frame twin in `use-value-graph.ts` hand it `runtime.flattened.current().graph`. The store's document is a type error there, with or without `authoredGraph(…)`, and the probe above holds that.
- **`DECLARED_FRAME_PATHS` keeps its zero-raw-reads half.** This document used to say that half could go once `evaluate` took `FlatGraph`. It cannot: a type only sees a hand-off. A frame path that walks `store.getGraph().nodes` itself reaches no typed consumer. One example is skipping the evaluation when the document holds no value node, which is T615 again for every value node inside a component. The scan is what refuses that read in those three files, where it cannot be declared with a reason.
- **The undeclared-read ledger stays**, for the same reason, across the rest of `src/app`.

## Left on `GraphDocument`

Each of these is handed a flat graph today and accepts either type. Typing them is mechanical; none of them evaluates parameters.

- `laser.sync`
- `PipelineHost`'s `graph`
- `hasAnimatedParameters`
- `instance-value-channels.ts`
- `examples/runtime-requirements.ts`
- `desktop/testing/output-fixture.ts`
- `mcp/serve.ts`

## The value graph and the Controls pane (T1559b)

The Panel MIDI work landed (`01b2ab30`) with two `parameterReadOptions` calls. Each now says which side it reads.

- **The value graph evaluates the flattening**, by type. Callers surveyed:
  - `use-value-graph.ts` (the frame path and the zero-frame twin) and the offline harness (`render-harness.ts`) already handed the flattening.
  - `cook-oracle.ts` handed the store's document when it had no catalogue. It now says `compiledWithoutCatalogue(…)`, which is the graph its own compile evaluates.
  - `editor/nodes/value-plot-chain.ts` is the one product caller outside the frame path. It cuts a chain out of the pane's graph and samples it on a hypothetical clock in a throwaway session. Every node in the cut-out declares or propagates a plot period, which a component instance never does, so the cut-out holds no instance and is minted with `compiledWithoutCatalogue`. `FlatOrAuthoredGraph` was considered for `evaluate` and rejected: `bus.readScope().graph` is already an `AuthoredGraph`, so the union would let a frame path evaluate the authored document with no visible word, and the evaluator has no correct answer for an authored instance (it skips it, which is T615).
  - `examples/channel-integrity.test.ts` walks a starter-component file with no catalogue on purpose, and says so with the same producer.
  - Every other caller is a test and uses `flatDocument(…)`. `midi-controls.test.ts` and the Playwright fixture `panel-midi-fixture.html` read `runtime.flattened.current().graph`, as the app does.
  - `mcp/serve.ts` and `bridge-host.ts` build no value graph session.
- **The Controls pane reads the authored document, with no fade**, plus the flattening's instances off `bus.readScope()` (see `docs/evaluation-context-design-2026-10-04.md`, "T1559b (1)"). The authored, no-fade read is right for the two cases checked:
  - A Panel control inside a component is never shown. The pane lists the widgets of the root document it is handed, and publishing a Panel from inside a component is open work (T1143, T1388b phase 2).
  - A control whose value fades in a preset morph shows its document value, which is the destination, by design (`docs/presets-scenes-layers-design-2026-09-29.md` §5.5, T1525b). Only a driven widget samples the read at all; a static one shows what the document stores.
