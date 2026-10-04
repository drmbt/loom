# Authored vs flat graph: two types (T1552b)

## The cause

The document the user authored and the graph the compiler, the runtime and every per-frame reader evaluate were both typed `GraphDocument`. A consumer that needed the flattening therefore accepted `store.getGraph()` without complaint, and a component's internals did not exist for it. That happened in B29, B41, B177, B188, T615 (six sites with one cause), T1067, T1485b and T1550b. `frame-path-flattening.test.ts` held the line by spelling: it scans `src/app` for `store.getGraph`. It could not see `src/editor`, and it could not see a raw graph passed in from elsewhere.

## The names

- **`FlatGraph`** is `GraphDocument & { [flatGraphBrand]: true }` (`domain/types/graph.ts`). The key is a `declare const` unique symbol, so no module can write it.
  - Producers: only the flattener. `flattenComponents` makes one. `compiledWithoutCatalogue(graph)` covers the compile handed no catalogue, which reads the document as-is; there an instance meets the manifest's `component.notFlattened` tripwire.
  - Both producers sit in `compiler/flatten.ts`, behind one private `flat()` cast.
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
| per-frame readers | pulse watcher `step`, OSC `sync`, `graphChannelResolver` |
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
- **The checker refuses the mistake.** A probe file is compiled with the app's tsconfig, and the gate asserts errors on exactly three lines:
  - the store's document passed where the flattening is needed;
  - `parameterReadOptions` handed a bare document;
  - `authoredGraph(flat)`.

## The scan over `src/editor`: not extended

Every editor read that evaluates now goes through `parameterReadOptions` or `validateGraph`, and must say `authoredGraph(…)` or hand a `FlatGraph`. Every consumer that needs the flattening is typed. A `store.getGraph()` under `src/editor` therefore cannot reach either without a type error, or without a visible `authoredGraph(…)` a reviewer reads. The brand does the job the scan would have done there.

The scan over `src/app` cannot shrink yet:

- **The value graph is the frame paths' main consumer, and it is untyped.** `createValueGraphSession().evaluate(graph)` still takes `GraphDocument`. `domain/channels/value-graph.ts` carries another session's uncommitted work, so it was not touched. The `use-value-graph.ts` entry in `DECLARED_FRAME_PATHS` is still enforced only by spelling.
- **The undeclared-read ledger stays.** It also catches a new hook that walks `store.getGraph().nodes` itself, without handing the graph to any typed consumer.
- **What could go:** once `evaluate` takes `FlatGraph`, the zero-raw-reads half of `DECLARED_FRAME_PATHS` is type-enforced and can go.

## Left on `GraphDocument`

Each of these is handed a flat graph today and accepts either type. Typing them is mechanical; none of them evaluates parameters.

- `laser.sync`
- `PipelineHost`'s `graph`
- `hasAnimatedParameters`
- `instance-value-channels.ts`
- `examples/runtime-requirements.ts`
- `desktop/testing/output-fixture.ts`
- `mcp/serve.ts`
- `value-graph.ts`'s `evaluate`, named above

Merge note for the uncommitted Panel MIDI work (`value-graph.ts`, `controls-pane.tsx`): a `parameterReadOptions` call there must pass the flattening (`runtime.flattened.current().graph`, a `FlatGraph`) or `authoredGraph(document)`. Which one is that work's judgement: the controls pane reads authored Panels, and the value graph evaluates the flattening.
