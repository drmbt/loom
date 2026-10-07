# Project code and core capability audit

**Audited 2026-10-06; recommendations revised, composition fixes and shared bloom implemented 2026-10-07.** Source findings below record the pre-fix review; the implementation sections state what has since changed.

The four projects already produce ordinary Loom documents. The problem is that many of their effects and performances still require substantial code to author, and shared functionality is accumulating in project folders. A user can open the resulting graph without the project's TypeScript, but often cannot build or modify an equivalent through ordinary nodes and controls.

The strongest evidence is direct reuse: Sentinel Bot and On Nothing import Furnace's effects and offline audio tooling. Some of this work already has a promotion requirement in `SPEC.md`, and several promotions have landed without consistently replacing their project copies. Start with equivalent existing nodes, ordinary parameter values and wiring. Package a repeated graph only when that makes it meaningfully easier to reuse. Add a core primitive only after identifying an operation existing composition cannot express or a measured execution problem it cannot reasonably meet.

## First composition fixes

The first slice repairs the existing component path before migrating finishing graphs:

| Finding | Implemented behavior | Regression proof |
| --- | --- | --- |
| Selection extraction loses variadic order | Crossing and synthesized feed edges retain order. Inputs whose ordering depends on IDs have their original comparator order made explicit, including peers left outside the selection. Unique explicit positions remain unchanged. Wrapping an older fixed exposure refuses ambiguous ties with hidden feeds instead of changing their meaning. | Furnace TAA depth/history bindings before/after extraction; color/data boundary paths; outgoing declared, sparse, unordered, tied and mixed layer orders; undo/redo; atomic refusal for ambiguous legacy wrapping. |
| Exposed ports lose interface metadata | Optionality is preserved. Deliberate whole-input exposure records `variadic: true`; older records and extracted individual slots retain fixed-input semantics. Whole inputs refuse alias exposures and internal wired/named feeds. | Real expose/connect commands, optional input validation, old/new library serialization, fixed-slot occupancy and atomic invalid-exposure refusal. |
| Published vector/color components freeze | Each expression/driven channel survives nested publication. Later whole-value publications and instance overrides supersede earlier projected channels; authored definition slots stay intact. Projection uses bounded channel operations and one override scan. | Dynamic nested uniforms, caller references, precedence/fanout and detach parity; moving nested color channels equal ordinary Solid pixels on Dawn. |
| Internal meshes do not load | Measurements use the canonical current flattening and write plain facts through `graph.applyPatch` to per-instance descendant overrides. Shared definitions stay unchanged; nested overrides use the same flatten/detach projection. | Mounted compile/mesh hooks with premeasured meshes, independent direct/nested assets, file changes, measured-fact persistence, save/reopen, source cleanup and invalid-edit rejection. |

The additive patch address is `setParameters.internalNodeId`, relative to the owning instance. It requires a current existing descendant, validates against its effective schema, and refuses mode slots or inherited-key removals that the current plain override format cannot represent. Root parameter writes and main's per-parameter reference-cycle model are unchanged.

These changes add no effect types or preset catalogue entries. Bloom consolidation follows below. Other finishing graphs, scene import, live pose interfaces and shared export quality remain subsequent slices governed by the composition policy below. The pre-fix compile/source findings remain useful as reproduction evidence, not as claims that all of those defects are still present.

## Shared bloom recipe

The next slice shares one filtering algorithm, with values and neighbouring nodes expressing
the finishes. `src/examples/bloom-pyramid.ts` builds nine ordinary nodes: HDR bright
extraction, four downsample levels and four tent upsample levels. Its three clockless shader
sources now live in `src/nodes/shaders/bloom-pyramid.wgsl.ts`, with the exact original bytes.
Furnace's `post.ts` retains only its project grade. Independent bright taps and downsampling
uses import the shared shaders directly; there is no compatibility re-export.

Furnace, Sentinel Bot and six On Nothing authoring sites use that recipe. The Cyc finish
changes threshold, knee, first-level firefly filtering and spread as values on the same
nodes. Addition, strength, streak, halo, lens and grade stay in the surrounding graph. This
removes duplicated filtering construction without adding a node type, per-look component
or preset bank. Projects still serialize ordinary nodes; instantiating a component in their
source factories would add library/plumbing changes without improving this consolidation.

The same recipe ships as **Bloom Pyramid**, authored through the existing Save Selection,
exposure and parameter-publication commands. A normal user places it from the Components
library, supplies Picture, feeds Glow into Add's first input and the original picture into
its second, then sets Add's Opacity. Bright is available separately for Streak or Halo.
Threshold, Knee, Radius, Spread and Firefly Filter are ordinary published controls. The nine
filter intermediates pin `rgba16float`; users can open the component and edit its nodes.
The existing palette-based Bloom remains a distinct finish. The working demonstration and
recipe are in `examples/components/Bloom-Pyramid.loom.json` and `examples/README.md`.

Source factories were serialized before and after migration for three Furnace options,
three Sentinel options and all 22 authored On Nothing shots. All 28 complete documents are
byte-identical, including source shader text, stable IDs, positions, explicit extra-input
orders, inherited formats, omitted radius defaults and per-level rounded resolutions.
Project artifacts and media therefore need no rewrite. A durable regression compares the
shared recipe against the independently saved Furnace, Sentinel and Cyc filtering graphs.
Only the new component was generated, using `--only Bloom-Pyramid`; the script's plan was
zero examples and one component.

### Why this representation

The bounded study made 52 one-frame Dawn captures and compared the existing Bloom, a five-scale colored
Threshold/Mask/Gaussian/Add recipe and the exact pyramid at 128×128 and 127×129. It also
tested an algebraic max-RGB/quadratic-knee bright extraction and linear Convolve/resizing
decompositions. These are evaluated candidates, not a proof that no smaller ordinary graph
can exist.

At 1920×1080 with float targets, the compiled plans give:

| Candidate | Dispatch/draw passes | Sum of compiled texture bytes |
| --- | ---: | ---: |
| Exact pyramid plus final Add | 10 | 27,662,400 |
| Five-scale colored Gaussian recipe plus final Add | 18 | 41,457,600 |
| Existing palette-based Bloom | 8 | 132,710,400 |
| Algebraic bright extraction alone | 25 | 103,680,000 |
| Shader bright extraction alone | 1 | 4,147,200 |

The byte sums include filter scratch targets, exclude the input fixture and are derived
from the compiler's texture sizes/formats. They are not peak resident memory measurements
or GPU timings; initialization/readback wall time is not used as a frame-time claim. The
project migration preserves its existing computation and resource requirements.

The ordinary bright algebra reproduces the equation but its multiple float16 passes
introduce cancellation/rounding: the near-threshold ramp differs by up to 0.0048828125, with
a cutoff-adjacent sample about 0.000244 against 0.000012 for the single shader. With Karis
filtering disabled, the Convolve downsample decomposition matches centered colored impulses
exactly at both sizes; corner impulses differ because intermediate border clamping changes
the filter. Isolating the tent upsample with a zero own-level image likewise matches the
centered fixture exactly, but differs at the border. Mixing an own-level image also requires
preserving the legacy nearest-texel read rather than substituting a bilinear composite.

The colored Gaussian candidate preserves hue on the tested impulses but has a different
halo profile at its tested values. It also lacks a proper prefilter before every reduced
branch; it is an approximate candidate, not an optimally tuned ordinary implementation.
Existing Bloom introduces its authored palette. A
nonzero 2×2 colored block was tested at both sizes: a single centered texel can disappear
during the legacy half-resolution sampling on the odd-sized frame. This existing behavior
is preserved, not silently repaired by consolidation. These results justify retaining the
exact shared shader graph for these consumers while leaving simpler ordinary bloom graphs
appropriate for other pictures. They do not justify a new public primitive or a general
filter-fusion system.

The shipped component has separate durable GPU proof: a colored HDR input at 193×109,
normal loader and real instantiation commands, edited values, save/reload, and byte-exact
Glow/Bright comparison against independent frozen legacy equations. It asserts the rounded
112×64 Glow and 97×55 Bright sizes, radiance above one, directional control effects and
float outputs in a byte-format host. A headless Chromium test places the library entry,
tunes Threshold, saves/reopens and enters its ordinary eleven-node interior including
boundaries. Moving subpixel sequences and live GPU frame timing remain unmeasured; no
broader performance claim is made.

## Composition policy

A different look usually needs different values on an existing node or its neighbours, different input data, or different wiring. These edits already live in the document. A named preset is optional when someone needs to recall settings; a look does not automatically earn a preset, component or node type. Even a wiring difference can remain an ordinary graph.

Use the smallest useful representation:

| Need | Default treatment | Reason to move further |
| --- | --- | --- |
| Adjust the look | Set values, expressions, inputs and neighbouring nodes | A required behavior cannot be expressed with the existing controls and graph. |
| Assemble a short, understandable chain | Keep the chain in the document | Multiple consumers repeat substantial wiring and need the same stable interface. |
| Reuse a substantial graph | Reuse or improve an existing component; create one if the interface warrants it | A specific semantic, data-access or measured execution limitation remains inside that graph. |
| Reuse a shader that ordinary nodes cannot reasonably express | Maintain it once inside a component with useful controls | It needs renderer-owned data or execution support unavailable through existing contracts. |
| Supply a missing general operation | Extend the responsible core contract, adding a node only where appropriate | A concrete consumer proves the missing operation and a focused test proves its semantics. |

The existing Bloom component publishes Threshold, Knee, Radius and Intensity (`src/examples/starter-components.ts:1529–1573`), but also contains a fixed highlight remap and chromatic palette. Its values cover variants of that particular effect; they do not make it equivalent to Furnace's HDR-preserving pyramid. Choose an existing graph when its semantics fit. When they do not, identify the actual difference before adding an abstraction. An effect's familiar name and a second consumer justify investigation, not a new type by themselves.

A component containing Custom WGSL can make a shader accessible without requiring every user to write it. That remains a shader implementation behind controls, so an ordinary-node version is preferable when it meets the same requirements. Keep the internal graph editable and publish the inputs and parameters consumers actually need. Avoid turning each project-specific setting combination into another library entry.

Source-code reuse alone does not complete this work. Moving a TypeScript helper to a shared folder helps maintainers but leaves the user authoring gap. Shared source is useful when it produces one reusable graph or shader component that the normal library and save/load paths support.

## Scope and portability

Counts are the filesystem inventory measured on 2026-10-06, not implementation complexity estimates or a live census. Non-test counts exclude files named `*.test.ts`; Sentinel's count still includes two test-support modules. Document counts include saved user variants.

| Project | Non-test TypeScript files | Lines | Loom documents | Main reason for custom code |
| --- | ---: | ---: | ---: | --- |
| Furnace | 22 | 4,462 | 1 | Asset-derived scene assembly, mechanical rig, musical director, rendering effects |
| Sentinel Bot | 19 | 6,299 | 1 | Procedural robot performance and environment, musical decisions, shared finishing effects |
| On Nothing | 51 | 15,716 | 24 | 22 authored shots plus two user variants; posing, cinematography, materials, effects and film export |
| Stage Previz | 11 | 1,922 | 3 | Imported stage/projector facts, control rig, beam haze and saved-session upgrades |
| Total | 103 | 28,399 | 29 | |

All 29 documents load using the real `loadProject`, the current node catalogue and each file's embedded component library, with zero unknown-node placeholders. This is schema/type recognition evidence, not a rendered-picture comparison or an asset-availability check.

Three distinct questions should govern future work:

1. **Can it execute from JSON plus media?** Most of these individual graphs can: build scripts serialize shader text, expressions, parameters and graph structure through `serializeCheckedProject` or `buildCheckedProjectFile`.
2. **Can an ordinary user author it without project TypeScript or shader programming?** Many shared operations still lack that surface. Embedding generated WGSL in JSON satisfies persistence, but does not provide usable controls or a reusable recipe.
3. **Does the delivered movie depend on external orchestration?** On Nothing's full edit and quality finishing do. The project's Python EDL and renderer add behavior outside an individual saved graph.

Media is separate from JSON by design (`SPEC.md:302–305`). Several generated documents have empty `assets` arrays while file parameters reference project media. Furnace requires its GLB/audio; Sentinel requires its locally prepared kit; On Nothing requires GLB/audio/HDRI-derived media. The Sentinel and On Nothing Blender instructions explicitly describe ignored/local assets. Stage Previz commits its GLB (`src/projects/stage-previz/session.ts:20–26`). Removing TypeScript does not make these documents self-contained; packaging/relinking needs its own proof through the existing asset system.

## Findings by project

### Furnace

`build.ts:32` writes the checked Loom document. `director.ts:95` constructs existing value nodes; `camera-path.ts:447` emits expressions. The TypeScript does not run as a separate director when the user opens the JSON.

The substantial shared candidates are the HDR bloom pyramid (`document.ts:541`, `post.ts`), bokeh DOF, normal-aware contact AO and SSR (`screen-space.ts:101,158,221`), and light scattering (`atmosphere.ts:58`). Both peer music projects import portions of these effects. First try existing nodes and components with the required settings, then test a reusable graph where the chain is substantial. DOF, SSR and scattering may need shared shader components; a new public node is an unresolved choice until their data and execution needs are established.

Imported cameras, markers, emitter origins and part pivots are baked into the document at build time (`scene-facts.ts:5–11`). Much of this information exists in decoded data, but ordinary graph users do not get equivalent scene-data outputs. Mechanical parent/pivot handling is handwritten in `rig-kernel.ts:18,40`. First distinguish a one-time import that creates ordinary nodes from linked runtime data that must follow file changes. Existing Geometry transforms already handle independent rigid placement; hierarchical deformation needs accessible rig data and a well-defined transform contract.

Furnace also carries a separate deferred lamp pass (`lamps.ts:5`). Current core Light in Points mode supports range culling and mapped color, intensity, direction and cone (`src/nodes/definitions/scene.ts:693`). Use it as the migration target once imported fixture points can reach the graph. Do not promote a second lamp engine merely because the project needed one earlier; picture and cost equivalence still need checking.

Keep the procedural Blender plant, industrial collision-based shot discovery, material/art-direction choices, molten-steel behavior and machinery choreography bespoke. Useful material or audio-analysis recipes can stay as ordinary graphs; package them only when repeated consumers benefit from the same interface.

### Sentinel Bot

`build.ts:35–37` writes 226 nodes using existing core types. Its 21 kernels and 10 custom materials largely describe the artwork. Core Sweep, Rope, Curve Frames, mesh instances, point lights, panels and presets are already used.

The strongest common-ground evidence is explicit Furnace imports for SSR, GTAO, DOF and bloom (`document.ts:19–20`), described as temporary pending stock equivalents (`document.ts:1272–1275`). Its own `air.ts:8–30` adds depth haze, analytic light scattering, height fog and clouds. Evaluate shared atmosphere graphs/shader components and the precise data they need; leave weather and place styling as values, inputs and authored wiring.

There is a demonstrated value-graph gap: the director could not hold a track-intensity-derived decision until the next phrase, so it removed the intensity condition and chose by bar number (`director.ts:143–153`). `valueStep` holds a generated hash derived from a count, not an arbitrary input sampled by a separate trigger. `valueDelay` retains rolling frame history. Neither supplies the required sample-and-hold. `SPEC.md:1911` already records this as T1651b.

`path.ts:4–8` emits CPU expressions and GPU WGSL for the same path. Investigate a shared curve-sampling surface that a camera/value graph and points can consume. Core already has authored curves, arcs and arc chains; the missing piece is convenient shared consumption of this procedural path, not basic curve generation.

Keep FBX conversion, mesh reduction, hinge measurement and the specific robot's gait, geometry, world composition and film references in assets/artwork. Build controls and rigs from current primitives where possible; only a demonstrated missing operation warrants extending core.

### On Nothing

`build.ts:9–18,43–46` serializes the individual shots, including generated bone tables, shaders and keyed expressions. The main authoring gaps are live posing, keyed motion editing and shared rendering effects.

`skin-kernel.ts:31–47,73–103` emits joint tables and ancestor walks into shader text; `car-rig.ts:34–62,76–93` repeats rigid-part hierarchy transforms. Accessible rig/pose data could support reusable FK and skin shader components instead of another asset-specific shader generator. This does not establish a need for public FK and Skin node types. Existing Mesh File In plays glTF skeletal clips without a custom posing kernel (`src/nodes/definitions/mesh-file-in.ts:173–188`); the gap is computed/live posing and its data interface, not basic animation playback. Keep reference poses, gait, contact timing and choreography as content.

`shots/motion.ts:30–44` converts keyed curves to expression text. `shots/closeups-held.ts:194,289–300` and `shots/mcu-rig.ts:5–14` solve targets at build time. Keyed channel editing can be investigated independently: a first authoring surface could generate existing expressions while preserving editable key/interpolation data. Pose-target/IK authoring depends on the pose contract. Do not import this project's particular Euler skin kernel wholesale as the general rigging implementation.

Promotion drift is visible. Closeups and Hands use stock Streak/Lens/Film Grade; CRT uses CRT Tube and Cyc uses Echo. But `document.ts:600,617,630,636` still embeds private Halo/Lens/Echo/CRT effects, and `shots/chain.ts:39–64` builds its own streak and bloom chain. These require targeted parity comparisons: some may be obsolete copies; others may expose a missing stock control or a deliberate variant.

The full film exceeds one shot document. `tools/on-nothing/cut.py:3–17,95–104` consumes an EDL, invokes shot/take renders with local clocks and audio positions, and assembles the cut. `render.ts:98–115,148–214,241–265` adds spatial supersampling, temporal accumulation, highlight trails and grain after accumulation. Those additions mean the final output is not described completely by a shot's JSON. Shared export should own quality sampling; intentional artistic trails and grain ordering should have explicit graph/finish semantics. Evaluate existing timeline Cue Lists before considering a separate sequence/document composition feature. A general NLE is not justified solely by this film.

Keep Blender modeling, MPFB adaptation, wardrobe, jewelry, camera compositions and reference-specific materials bespoke. Try material and handheld/flicker recipes as values and graphs first; offer components only where repeated assembly and a clear interface justify them.

### Stage Previz

This is the clearest proof that the project can be operated as ordinary app content. `session.ts:28–48` builds/loads through the real project paths, and `stage-previz-8.loom.json` repackages the scene into six components authored in the app.

The biggest shared gap is convenient projector haze authoring. `haze.ts:5–25` explains that core projectors illuminate surfaces while the project's shader marches the viewing ray through projector volumes. It manually reproduces camera/lens basis math, consumes scene depth, renders occluder depth from each projector, and wires lens settings into each beam pass. First test a reusable graph/shader component against current camera/projector/light data access. Extend the responsible core boundary if a required payload or execution operation cannot reach it. Preserve its beam/cookie/occlusion semantics; a simple additive beam sprite is not equivalent. This evidence does not yet establish that a new atmosphere node is necessary.

The imported cameras, rig mounts, pivots and deck height are baked in `facts.ts:3–8`. Camera selection/orbit/zoom are expanded into expressions in `slots.ts:77–113`. Imported scene metadata and a reusable shot-view rig would let users reproduce these operations through controls.

The custom updater is an architectural warning. `session.test.ts:26–29` explicitly proves the componentized session is refused: the updater cannot reach inside its six components. `rig.ts:444–472` replaces shader text using a generated-source marker and refreshes a baked fog-floor value. This is maintenance caused by copying implementation and asset facts into documents. Shared components should use their existing version/upgrade mechanism; changing asset facts should flow through the loader. Tour-specific assembly upgrades may still remain bespoke, with explicit limits.

Keep stage modeling, physical fixture layout, rig geometry, tour measurements and Resolume pixel-map export outside core. Syphon sources, sliders, panels, presets and cue lists already exist.

## Proposed dispositions

| Capability | First treatment | Escalation evidence |
| --- | --- | --- |
| Existing optics/film/CRT/echo copies | Existing stock nodes, adjusted values and surrounding wiring | A specific unmatched behavior; first consider a missing control or authored graph. |
| HDR bloom pyramid | Ordinary colored threshold/mask/blur/add for suitable looks; shared WGSL graph for the current exact pyramid | Exact component extraction compiled with unchanged passes/resources. An optimized public primitive needs further cost evidence. |
| DOF, contact AO and SSR | Existing AO where its semantics fit; shared shader components with explicit texture/scalar inputs | DOF needs no camera payload extension; nested SSR compiles with existing depth/normal and scalar camera fields. Remaining issues concern interface correctness, general camera semantics and cost. |
| Captured value on trigger/count change | Specify the general value-capture operation against existing value nodes | Strong primitive candidate: Sentinel cannot retain an arbitrary reading on a separate trigger. Specify initialization, vector values and deterministic replay/reset. |
| Imported cameras, markers, pivots and parent transforms | Reuse the decoder and loader; expose needed data through existing graph contracts | Imported facts cannot be accessed by normal graphs. Extend data access instead of adding a node for each asset convention. |
| Editable rigid/skeletal posing | Existing clips/Geometry transforms for sufficient cases; accessible rig data plus FK/Skin component experiments | Imported tables cannot reach ordinary graphs today. Existing packed texture/point mechanisms can do more than the projects use; establish indexed access and ownership before deciding on public types. |
| Depth fog and light/projector scattering | Depth-driven graphs and shared shader components with explicit density/light inputs | Required scene data, shadow access or integration cost cannot be met by composition. No separate type for each atmosphere look. |
| Audio structure, handheld motion, shot rigs, finish chains | Parameter values, expressions and existing nodes | Package substantial repeated wiring only when a stable interface helps consumers. |
| Keyed channel tracks and shared path sampling | Existing expressions/curves; improve their authoring and shared data access | A concrete editing or CPU/GPU sampling gap. Better UI/data access need not introduce another node type. |
| Supersampling, subframe accumulation and generic headless CLI | Shared export/runtime tooling | These are execution options and media ownership, not additional finishing-effect nodes. |
| Full multi-shot edit | Existing cues where sufficient; external editing otherwise | Establish shot-local time/reset and transition needs before considering a new subsystem. |
| Modeling, artwork, choreography, tour layouts | Assets, values and project graphs | Keep bespoke by explicit choice; generalize only a demonstrated reusable operation. |

The component interfaces need more precise treatment than the original audit gave them:

- Dedicated In/Out node variants cover textures, pointsets and values (`src/nodes/definitions/component-io.ts:154–158`), but direct exposed ports derive their actual internal type (`src/domain/components/definition.ts:44–87`). Save Selection retains direct exposures where a boundary variant cannot represent them (`save-selection.ts:228–236`). Camera, scene and data-texture interfaces are possible today. The restricted In/Out palette is an authoring limitation, not proof the component architecture cannot carry these payloads.
- A component can hide WGSL and publish useful controls without rewriting its effect as a core primitive. A repeated operation can still remain a graph or component. Extend core only after naming the unavailable semantics/data or measuring a cost composition cannot reasonably meet.

## Composition checks and remaining gaps

The following checks separate executable composition from a proposed future interface. Compile results are logical-plan evidence; they do not certify GPU pictures, timings or browser interactions.

### Exact bloom reuse is already possible

Furnace's bright pass uses max-RGB brightness and a quadratic knee that retains HDR color (`src/projects/furnace/post.ts:25–31`). Core Threshold emits a grayscale mask using smoothstep (`src/nodes/shaders/color.wgsl.ts:104–109`). The shipped Bloom also includes Level, Limit, Ramp and Lookup with fixed remap/palette settings. They are different semantics, not merely different defaults. A colored threshold/Mask/Blur/Add graph is a useful ordinary recipe where that look fits, but is not a proved exact replacement.

The pyramid's linear filters can be decomposed using Convolve, resizing and composites. Its first-level Karis weighting includes sample-dependent normalization (`post.ts:119–145`); reproducing it with image arithmetic requires further branches and passes. No missing linear-filter primitive or acceptable cost for that decomposition has been demonstrated.

A real `component.saveSelection` experiment selected the saved Furnace document's `bright`, four downsample nodes, four upsample nodes and `glow`, then compiled and saved/reloaded the result:

| Property | Original | Extracted component |
| --- | ---: | ---: |
| Selected computation nodes | 10 | 10 |
| Passes for the selected chain | 10 | 10 |
| Whole-document passes | 129 | 129 |
| Whole-document resources | 54 | 54 |
| Compile errors | 0 | 0 |

Every selected pass descriptor and every resource descriptor matched after removing the instance ID prefix; source-map/provenance metadata was excluded from the pass comparison. The embedded component saved and reloaded with zero unknown-node placeholders. This supports an exact shared WGSL-backed recipe without adding a node type. It reduces implementation duplication and authoring work; it preserves the execution cost. Published controls, different resolutions and live parameter edits still need their own acceptance checks.

### DOF and reflections do not currently need new payload types

Furnace's DOF entry point uses picture, depth, Far, Focus Distance, Aperture and Max Radius; it does not call the camera-basis/world-reconstruction helpers included in its source (`screen-space.ts:221–265`). Those are existing texture/scalar inputs. On Nothing's thin-lens variant needs different CoC parameters and fill behavior; compare those implementations rather than claiming one focus recipe covers both.

A separate two-level component compile experiment used Furnace's actual SSR shader, with Picture plus separate Depth and Normal sockets mapped to the Multi node's More input in orders 0 and 1. It compiled with no errors and bound `inputTexture1` to Render Depth and `inputTexture2` to Render Normal. A root camera channel published through scalar parameters across both levels reached the shader uniform. Another experiment exposed a Camera output through two component levels and wired it to Render's Camera input successfully.

These proofs justify component work, not automatic stock-node promotion. Current ray reconstruction is perspective-specific; orthographic cameras, aspect, depth encoding and animated camera frames need explicit scope. Name-only references also differ from wires: asking Render's Camera parameter for the component instance name failed after flattening, while its exposed typed wire worked. The named-source resolver needs attention if that authoring workflow is required (`src/compiler/source-reference-edges.ts`; `flatten.ts:843,918`).

The current SSR itself is limited: it marches visible depth and adds sampled lit radiance; it cannot recover hidden/offscreen surfaces, does not trace rough reflection cones, and does not integrate material-specific metallic/F0 (`screen-space.ts:178–210`). Packaging that shader does not deliver all physically based reflection behavior. Likewise, project contact AO darkens completed direct/emissive light and uses shaded normals; core AO affects ambient/environment and derives geometry normals from depth. Compare the intended behavior before consolidating implementations under one label.

### Existing component correctness issues come before broad migration

- **Variadic edge ordering.** A real extraction of Furnace's `taa` and `taaHistory` applied successfully and compiled with zero errors, but reversed the depth/history bindings. Originally `inputTexture1` read depth and `inputTexture2` read history; after extraction they read history and depth. `SelectionWiring` carries no order (`src/domain/components/save-selection.ts:23–27`), and the component command remints incoming edges without it (`commands.ts:810–816`), while the remaining internal history edge retains its order. Preserve order through extraction and test mixed internal/external inputs before trusting shader-component migrations. A new TAA type would hide this general defect.
- **Direct exposure metadata.** The derived exposed port retains type but drops optional/variadic flags (`definition.ts:76–87`). The SSR experiment used distinct explicit sockets; exposing one optional variadic More socket does not retain that interface's connection semantics. Preserve the needed flags or deliberately choose a fixed-slot component contract.
- **Driven compound publishing.** In the nested SSR experiment, publishing whole Eye with driven `eye.x/y/z` left shader values at defaults despite a clean compile. Explicit scalar publishing through both levels supplied the expected value. `published-page.ts:81–83,122–129` distinguishes the component-addressed values path from deferred bare-key slots. This is a concrete publishing limitation to reproduce and fix, not permission to accept static defaults silently.
- **Internal mesh ownership.** The app passes a flattened file graph into `useMeshSources`, then `sizedFor` looks up its mesh ID in the root graph and returns false for an internal node before checking its stored measurements (`src/app/app.tsx:888`; `use-mesh-sources.ts:133–144,216–224`). That path skips buffer registration even for a premeasured internal mesh. This finding is traced from source, not a new mounted-browser reproduction. A reusable rig can currently keep a root Mesh File In feeding its pointset socket; supporting internal file sources requires resolving facts and source ownership through the authored origin/instance. Mutating a shared definition with one instance's asset facts is not a safe general solution.

Component versioning also has specific limits. Saved instances pin a version and upgrades are explicit (`src/domain/components/upgrade.ts:11–18`). Migration records are descriptions, not executable asset/table remapping (`src/domain/types/components.ts:44–48`). Consolidating a shader into a component does not automatically repair every embedded library in previously saved files or replace a tour-specific asset updater.

### Imported facts need an authoring or data surface

The decoder provides cameras, certain markers, part pivots/orientations and joint bind matrices (`src/domain/mesh/glb.ts:51–123`). `PreparedMesh.mesh` holds them, but `meshFacts` exposes counts and text summaries (`src/points/mesh.ts:102–112,183–198`). Mesh File In supplies vertex points, not a marker/camera/joint-data output. Joint text discards full bind transforms; it should not become the general pose-table format.

For fixed scenes, an import command/dialog that creates ordinary Camera/Light/Geometry nodes through the existing command bus may remove the project's TypeScript without adding a runtime type. For linked scenes or large fixture/joint collections, expose deliberately typed numeric channels/pointsets/tables through the existing source ownership. These are separate use cases.

The decoder itself needs scoped improvements: its markers are named meshless leaf nodes excluding joints (`glb.ts:778–784`), part parents come from `loom_parent` extras rather than arbitrary glTF parentage (`:743–760`), and decoded results do not include photometric light records. Importing a general light rig requires that extraction, not merely a new UI over the current result.

### Rigid objects and live skinning require different decisions

Independent rigid objects can already use Mesh File In selection, Object/Part frame, and Geometry's Translate/Rotate/Scale/Pivot, including normal transforms (`mesh-file-in.ts:104–123`; `scene.ts:854–896`). Point Transform only owns positions and preserves normals (`point-transform.ts:190`), so substituting it for a lit rotating mesh can change shading.

Live articulation needs accessible rest/bind/parent data and pose ownership. It is not an engine-wide inability to read tables: kernels can read other slots of their own pointset with `pointAt`, and a packed pose texture can be read through `fieldAt` (`src/points/codegen.ts:352–388,992–995,1068–1071`). Multiple pointset inputs already exist elsewhere, such as Gather. The missing user-facing source and explicit indexed-access contract need to be established before choosing FK/Skin node types. Test a reusable FK shader component and a skin consumer of its table.

That contract must define local/world and bind coordinates, stable vertex-to-joint correspondence, parent cycles/mismatches, this-frame data ordering and rigid parts as one-influence cases. Reuse existing clip skinning and upload support where applicable, but do not inherit matrix interpolation or one project's Euler convention as an unstated universal behavior.

### Triggered value capture has stronger primitive evidence

The existing alternatives were checked beyond their names. `valueStep` hashes a quantized count; Trigger emits an edge; Delay retains rolling history. Preset Store copies stored parameter slots, including their expressions, rather than evaluating a channel reading at capture time (`src/domain/presets/commands.ts:515–555`). Timeline cues resolve saved preset ends by playhead and do not sample a live value at the trigger. A self-feedback value arrangement, including a path through Delay, encounters the value graph's cycle check, which reports the cycle and emits empty bags (`src/domain/channels/value-graph.ts:291–311`).

These mechanisms do not express Sentinel's required arbitrary channel-bag capture on a separate trigger/count change. A small stateful value operation remains justified. Its initialization, missing-channel behavior, vector/channel handling and deterministic reset/replay should use the existing value-node state contract; this does not justify a new director or sequencing framework.

### Existing sequencing is stronger than the old description

Timeline cues already switch structural settings, including Layer on/off, source references and published structural parameters (`src/domain/presets/timeline-cues.ts:54–72,326–370`). Export awaits the plan on each crossing (`src/app/render-range.ts:218–225,270–284`). The Cue List description saying those swaps are skipped is stale.

One-document film composition should therefore be tried before a new sequence subsystem. Local time can often be an ordinary value/expression offset. What remains unproved is equivalence to fresh per-shot rendering: cue changes do not automatically reset a component's history, provide a component-local clock or reproduce the EDL's warmup/audio alignment. Test two shots with a revisit, exact frame boundaries and export. The full 110-row edit is not the first acceptance experiment.

### Export sampling needs explicit temporal and finishing semantics

On Nothing averages converted RGBA8 output before its artistic highlight trails, cut detection and grain (`src/projects/on-nothing/render.ts:148–214,218–219`). Its exporter also recognizes particular grain parameters and disables them in the graph (`:241–265`). These choices are not a neutral reference implementation for general supersampling.

Separate shared export sampling/shutter/output resolution from artistic graph effects. Test trails with existing temporal/composite nodes. Grain that runs after accumulated output needs an explicit finishing/cadence boundary; inspecting parameter names and moving effects behind the user's graph is not a general contract.

Subframe execution also advances temporal nodes. Re-rendering a frame is not a free sample: it advances feedback, caches and simulations again (`src/app/render-range.ts:289–300`). Define sampling, replay/reset and output-frame cadence before consolidating the project accumulator. This calls for a shared execution contract, not a finishing node for every exporter option.

### Atmosphere composition has a specific remaining input limit

Depth-to-ramp/mask/composite graphs can express depth-weighted fog. World-height fog and physical in-scattering need ray/world reconstruction, which can live in a shader component. One light or projector with explicit controls, scene depth and light-depth textures is structurally feasible with existing nodes.

An arbitrary live pointset of lights cannot currently be wired as a buffer input to Custom WGSL. Multi offers picture plus three extra textures (`src/nodes/definitions/custom-wgsl.ts:350`), so importing marker points alone does not deliver general volumetric lighting. Split explicit passes or establish a suitable data-access contract for a collection; do not assume adding a Haze node resolves that interface. Shared WGSL modules already include map/light-depth helpers, but are parameter-free helpers rather than complete effects with bindings and controls (`src/nodes/shaders/shared-modules.ts:23–31,462–470`).

Render Light Depth also draws a sweep and exposes the first casting light; it is not a free redirect to every private shadow resource. The existing output may replace some project depth setup, but shadow framing and repeated draw cost need comparison. Furnace's smoke density, Sentinel's analytic light integral and Stage Previz's projector-cookie integration should be composable requirements, not separate types for their visual styles.

## Acceptance experiments before implementation choices

The compiled proofs establish which interfaces already work. The following bounded recipes settle quality and execution questions without first creating a new catalogue entry:

| Slice | Representative inputs and behavior | What settles the decision |
| --- | --- | --- |
| Bloom | HDR colored impulses, threshold ramps, moving subpixel and border sources; odd/even resolutions | Compare current Bloom, an ordinary colored/multiscale chain and the exact shader graph for hue, radiance, halo profile, size stability, passes and memory. |
| DOF | Sharp foreground edge over a bright defocused background; doubled resolution | Establish near/far coverage, bokeh/energy and CoC scaling separately for Furnace and thin-lens requirements. |
| AO and SSR | Crease versus flat/bumped surface; wet floor with a moving emissive object and camera roll | Specify which lighting AO changes and SSR's visible-depth limits before comparing pictures and cost. |
| Temporal component migration | Mixed internal/external depth/history inputs; camera cut, moving rig, reset, save/reload | Preserve explicit bindings and history ownership first; compare camera-only versus object-motion expectations. |
| Scene import and rigging | One static camera/light import; two independently sourced mesh instances; a two-joint live pose | Separate one-time authoring from linked reload, per-instance facts and indexed bind/pose data; test both a rigid part and weighted mesh. |
| Camera/key authoring | One keyed path shared by a camera and a Sweep | Keep keys editable and establish CPU/GPU sampling semantics without synchronous GPU readback assumptions. |
| Atmosphere | Constant-density slab, a light and an occluder, then a projector cookie/shift/keystone | Compare attenuation, scatter/shadows and two-camera consistency; measure one versus several sources and shadow sweeps. |
| Sequence and sampled export | Two shots plus a revisit, feedback warmup, audio offsets and post-accumulation grain | Prove frame boundaries, reset/cadence, replay and finishing order through the normal exporter. |

Use these cases to decide the smallest sufficient representation. Algebraic decomposition and successful compilation are useful evidence, but neither proves a node-only graph is practical or a new primitive is necessary. Migrate the relevant consumers only after the chosen recipe meets its picture and cost requirements.

## Scaling the implementation

Catalogue size, compiler cost and GPU cost are separate constraints. A smaller visible graph does not prove a cheaper frame: the compiler flattens components before planning (`src/compiler/compile.ts:127,896–909`). Component instances do not inherently fuse their passes, share their intermediate textures or cache identical work.

| Constraint | What to inspect | Preferred response |
| --- | --- | --- |
| Library size and discoverability | Entries that differ mainly by values or surrounding nodes | Use one graph/component with adjusted values. Create named presets only for useful recall workflows. Keep short chains visible. |
| Compiler work | Generated shader variants, text size, repeated compilation and flattening cost | Use existing shader emission/cache and uniform mechanisms; fix the measured issue rather than adding another cache. |
| GPU work and memory | Pass count, intermediate size/format, repeated depth/shadow sweeps and temporal history | Wire one shared producer to its consumers where semantics allow, size intermediates deliberately, and optimize the responsible execution path. |

Compare candidate graphs on the consumers' representative settings and outputs. Preserve HDR/color-space boundaries, temporal reset behavior and the picture the project actually relies on. Name an acceptable live/offline cost for the slice rather than prescribing an arbitrary universal pass limit. A large graph can be appropriate; a small graph with repeated scene sweeps can be expensive.

If a graph misses its budget, first identify which pass or resource is responsible. An internal optimization of an existing node/compiler/backend may solve it without a new public type. A dedicated multipass primitive becomes justified only when the cheaper execution cannot reasonably be exposed through the existing contracts. Do not build speculative fusion or caching infrastructure to make this audit's recommendations plausible.

Existing emitted-WGSL caching already addresses text regeneration (`src/runtime/backend/wgsl.ts:23–55,88–100`), and effect pipelines have a per-device cache (`src/runtime/backend/vgpu/warm-effects.ts:14–15`). Those mechanisms do not share per-instance textures/history or eliminate draw passes, and dispatch pipeline behavior differs. Measure the actual path instead of assuming each component copy recompiles every shader or that byte-identical shader caching makes its GPU work free.

## Existing capabilities and migration cautions

Several historical comments no longer describe core:

- Render already has AO, environment filtering, depth/normal/albedo and Light Depth outputs. Furnace's extra sun-depth rendering should be reassessed against current outputs (`scene.ts:2060–2066`).
- Render AO attenuates ambient/environment only (`scene.ts:1992–1998`). The project GTAO darkens the completed image. Choosing between them changes lighting semantics.
- Camera Blur exists, but its derivative does not cover channel-driven cameras (`camera-blur.ts:43–45`). Furnace's audio-driven camera cannot be replaced mechanically.
- Camera has Origin/Heading frames and world-pose channels (`scene.ts:158–202,208–247`). Share camera reconstruction from that contract before inventing another pose format.
- Material WGSL now has four texture inputs (`material-wgsl.ts:64–70,196–200`). Historical texture/vertex-color workarounds do not prove texture support is still missing. Automatic glTF image/material import is a separate question from wiring textures into a material.
- Light in Points mode, Curve/Sweep/Rope, glTF animation clips, panels, presets, timeline Cue Lists and deterministic range export already exist. The gap is often composing/discovering them or extending a specific limitation.

Project algorithms also carry approximations: camera-only temporal reprojection, style-specific AO, baked lamp lists and project-specific audio lookahead. Reconcile these with core semantics instead of canonizing them. Performance or fidelity equivalence needs measurements; loading JSON does not establish it.

## Preventing repeated project growth

`SPEC.md:1811` (T1402b) originally specifies stock-node promotions and requires the projects to switch over. The owner's 2026-10-07 direction refines the proposed destination: values and composition first, components when useful, primitives only for proved gaps. Preserve the requirement to migrate consumers and retire equivalent copies whichever representation is chosen. This audit revises the recommendations; the historical task wording remains in the spec.

For substantial custom project helpers, record the capability, current core alternatives, actual limitation and intended treatment, including a reason when the implementation remains bespoke. A second independent consumer triggers a reuse review, not automatic creation of a node, component or preset. Ordinary value/wiring changes need no separate abstraction decision or new tracking system.

Define completion by an ordinary user recipe: add existing nodes or instantiate the justified component, supply media, set values and wiring, save, reload and export through the normal application. Reuse existing components before adding another. A consolidation should include a focused visual comparison with the old consumer, migration of the relevant document sources, regeneration only of those artifacts, and removal of obsolete private copies. Performance-sensitive effects need a representative live cost check as well. Stop when the recipe meets those requirements; leave optional variants as values and surrounding graphs.

Current validation already protects code-built documents: `src/examples/checked-project.ts:11–29` diagnoses/refuses invalid saves and its source gate includes projects. However, the broader example authorability and app-parity suites enumerate examples/starter components (`src/examples/authorability.test.ts:114–122`, `app-parity.test.ts:63`). Neither answers whether a person can construct a large project without writing shader code. Add focused user recipes for promoted capabilities rather than a shader-count limit or blanket ban on TypeScript.

Suggested order: preserve extraction/publishing/source semantics with focused regression proof; complete equivalent migrations to existing stock nodes; package the exact shared bloom/DOF recipes where justified and specify triggered hold; establish static-import versus linked-data/live-pose needs; then test atmosphere composition and consolidate export-quality support. For each slice, record the existing-node attempt, any remaining limitation, the smallest representation that meets it, and the consuming projects to migrate. This is an order of investigations and focused changes, not a commitment to a list of new node types.

## Validation

The 2026-10-06 investigation traced all four projects' authoring/build/render boundaries and recorded the project census. All 29 `.loom.json` files loaded with zero unknown-node placeholders through the normal loader and embedded component installation; the four Stage Previz session tests and repository typecheck passed.

The 2026-10-07 review additionally traced component extraction, direct ports, published parameters, flattening, source references, mesh loading, decoder/table data, image-filter math, value-state capture, timeline structure and export cadence. Temporary, in-memory experiments used the real command bus/serializer/compiler for Furnace bloom/TAA and the compiler for nested camera/SSR interfaces. They established the plan-level results and failure bindings described above; no project file was rewritten.

`pnpm vitest run src/domain/components/commands.test.ts -t 'component.saveSelection'` passed three selected tests; `pnpm vitest run src/examples/concepts/e4-bloom.test.ts` passed six tests; `pnpm typecheck` passed. The passing extraction tests do not cover the mixed depth/history ordering regression found by the real-project experiment. Mesh-source ownership remains a source-derived finding requiring a mounted-app regression. GPU pictures, performance, complete user authoring workflows and sampled-export parity were not verified; each recommendation states the acceptance experiment still needed. No full test suite or artifact regeneration was used.

Implementation validation adds 528 scoped tests across 23 affected files, 14 real Dawn component tests, two headless Chromium component editor tests, 289 first-import tests, typecheck and a production build. Lint has no errors and four existing warnings outside this slice. The current 64-file gate run identified the removed mesh raw-read ledger entry, example sync failures and a sandboxed helper socket timeout. The ledger was removed with its now-absent raw read; the final component-sync/addressing/frame-path gate checks pass all 86 tests. All 148 selected example generation/roundtrip checks pass on isolated rerun; the helper refusal test passes outside the socket-restricted sandbox. The GPU suite likewise needs adapter access outside the sandbox. No generated example was rewritten, no fidelity benchmark was claimed and the full test suite was not run.

Shared-bloom validation adds 105 scoped CPU checks across six files, two Dawn acceptance
tests (nine one-frame renders), and three passing Chromium component editor tests including
the new library/tune/save/reopen path. The source-factory parity experiments retain all 28
complete document bytes. Typecheck, lint, 289 first-import checks and production build
pass; lint retains the same four unrelated warnings and the build retains its bundle-size
warning. The 64-file gate run passes 3,719 checks and times out only on the sandboxed helper
socket test; that one check passes on its isolated rerun with loopback access. No gate
failure remains unexplained. Only Bloom-Pyramid.loom.json was generated, no project/media
artifact changed and no full test suite was run.
