# Generated text that grows with a document count: an audit (B260)

**Status, 2026-10-06: an audit and a proposal. No product code was changed.** Asked for by the lead after §B260 was proven: the Render emits one block of WGSL per Light and sums them in one chain, Apple's Metal compiler restructures that chain, and past about twenty lights the lit fragment falls off a cliff. The owner's instruction is that the cure be a core fix. This document says where else the same shape is written, proposes the rule, and designs the gate.

**How the numbers were taken.** No GPU run was made. Every "measured" figure is text: a small graph built at N = 1, 2, 4, 16 (and further where it mattered) of one item, compiled through the real `compileGraph` under the alias loader with nothing remembered (`forgetGeneratedText`), and for each generated shader the text length, the number of functions, the longest function body, the members of its uniform block, its `@binding` count, and for the plan the pass count and the number of distinct texts. Compile capabilities were Tier B with no device limits reported, so every bound that fired is the WebGPU baseline's. Largest counts in shipped documents were counted over all 112 files (74 `examples/*.loom.json`, 12 `examples/components`, 26 under `projects/`), and every one of them was also compiled (all clean) to read the sizes of what it really generates. Figures marked *read* come from reading the generator and were not measured. Figures marked *direct* come from calling the generator function itself, where a graph would have needed a mesh asset.

## 0. What was found, on one page

- **The B260 shape is written in four places, and three of them feed one chain.** The light blocks of the surface generator (B260 itself), the light blocks of the instances generator (a second copy), and the projector blocks, which are appended in both: in each generator's fragment function the lights and the projectors add into one `lit`. The chain a lit draw carries is lights + projectors, plus two environment terms. A casting light's shadow lookup sits inside its light block, so it is part of the same chain.
- **Largest shipped chain: 14 blocks and 30 `lit +=` statements in one function.** `projects/on-nothing/title.loom.json` has 13 lights and 1 projector (30 `lit +=`, a fragment function of 38,685 bytes, the longest function in any shipped plan). `incar` and `mcu2` have 9 lights and 5 projectors. B260 measured the cliff between 20 and 24 unshadowed point lights on a bare floor; the shipped scenes carry shadow lookups, projectors and Material · WGSL in the same function, and the §B260 row records no measurement of where their cliff is.
- **The fourth is Composite's fold**: `acc = blendPixel(acc, sample)` once per input, in one fragment function. It is bounded at 8 inputs by a named refusal and carries one `vec4f` per item.
- **Everything else that grows, grows as declarations and independent statements** (a member, an accessor function, a load and a store per point attribute; a binding per texture), or as passes that reuse one text. That costs compile time and pass count, not a register cliff.
- **Why rows are unrolled at all has one cause, stated in the code**: the plan's `UniformValue` is `number | boolean | readonly number[]` (`src/runtime/backend/plan.ts:21`), so a uniform block cannot be handed an array of rows. The Ramp says so in its docblock and declares `c0`…`c15`; Grid Warp declares `g0`…`g31`; the curve table declares `c0`…`c63`; the Render declares `light{i}Meta`, `projector{p}Matrix`, `shadow{s}Matrix`. The first three read the members back through an array constructor or a `switch` and index them with a run-time value, so their code does not grow. The Render unrolls the code as well.
- **The data form already exists three times in this codebase**, each put there on purpose: Cache, Echo and Slit Scan bind their whole history as one `texture_2d_array` and pick the layer from numbers in a uniform (T425: "what changes per frame is a NUMBER, and numbers travel as uniforms"); feedback substeps and kernel steps are a loop region with its count in the plan (T387, T1583b: "Emitting N copies would instead make the substep count STRUCTURAL"); a blur's radius is a uniform read by a WGSL loop. Their text is byte-identical at every count (measured).
- **A second, quieter class: counts written into the text as literals.** The text does not grow, but every value is a different shader: Environment Taps, Shadow Softness, Laser Path Slots, Ray Steps, Proximity Neighbours, and above all the byte offsets of every packed point region, which are literals computed from the point count. Changing how many points a producer has moves the text of every kernel-family shader that reads it.

## 1. The table

One row per site. **Growth per item** is text bytes (and how many of them land inside one function body), uniform members, bindings and passes. **Combined** says how the per-item pieces meet: *one chain* (a value carried from one item's statements into the next, in one function), *separate statements* (no carried value), *separate passes*, *switch arms*. **Class** is one of: B260-shaped; compile-time only; pass-count only; bounded by a small constant; count as text (no growth, but a different text per count); none.

### 1.1 The Render

Files: `src/nodes/shaders/scene-render.wgsl.ts` (the generators), `src/nodes/definitions/scene.ts` (`renderNode.compile`, from line 1814).

| # | Site | The count | Who decides | Growth per item | Combined | Bound today | Largest shipped | Class |
|---|---|---|---|---|---|---|---|---|
| R1 | `buildSceneSurfaceModule`: `lightField` (:1349), `lightBlock` (:1385), joined at :1451 | Lights in the Render's Lights list, on a lit material | author | PBR: 1,956 B, of which 1,888 in `fs`; Phong: 1,279 B (1,212 in `fs`). 3 members. 0 bindings, 0 passes. At 64 lights `fs` is 121,482 B. Unlit: 67 B and 3 members (declared and written, never read) | **one chain**: every block adds into `lit` (two `lit +=` per PBR or Phong light) | none | 13 (`on-nothing/title:shot`) | **B260-shaped** (this is B260) |
| R2 | `buildSceneInstancesWgsl`: `lightField` (:1935), `lightBlock` (:1938), joined at :1986. Primitive instances, billboards, beams | the same list | author | PBR: 1,894 B (1,826 in `fs`), 3 members | **one chain**, a second copy of R1's | none | 3 (`E33-Obol`, 9 lit draws through this generator in all shipped plans) | **B260-shaped** |
| R3 | `projectorBlocks` (:296), used by R1 and R2 | Projectors in the Render's Projectors list | author | no cookie, no occlusion: 1,261 B (976 in `fs`), 4 members (a mat4 and three vec4). Cookie and occlusion: 1,851 B (1,447 in `fs`), 4 members, 2 texture bindings, and 1 clear plus 1 depth draw per geometry | **one chain, the same one**: each block ends in `lit +=` into R1's `lit`. Each block sits under two `if`s (in front of the lens, inside the frustum) | with textures: 16 sampled textures a stage, `compiler/binding-budget` (an error on a device that reports no more) and `node.scene.textureBudget` (a warning); 8 projectors with both is 16 textures. Without textures: none | 5 (`on-nothing/crt`, `incar`, `mcu2`, `tableau`, `wide`, `zoom`, `wheel`, all occluding) | **B260-shaped** |
| R4 | A casting light's lookup inside its light block: `shadowFactorWgsl` (:1198), `pointShadowFactorWgsl` (:1152), `shadowFields` (:1289), `shadowBindings` (:1296) | Lights with Cast Shadows on | author | directional: the block is 4,012 B against 1,956 (3,862 in `fs`), 4 members, 1 texture binding, 1 clear and 1 sweep draw per caster geometry. Point: 4,140 B, 10 members (a vec4 and six mat4 more), 1 binding, 1 clear and 6 sweep draws per caster geometry | inside R1's chain; `shadow` multiplies that block's radiance | 16 sampled textures a stage (`compiler/binding-budget`, `node.scene.textureBudget`) | 6 casting (`on-nothing/cyc-wide`, `cyc`); 4 casting point lights (`furnace`) | **B260-shaped** (part of R1), and pass-count |
| R5 | Shadow matte, `shadowMatteWrite` (:1546) | the first 3 casting lights | constant 3 | about 2,260 B in `fs` per light up to 3, then 0. But 4 members and 1 binding per casting light without end: every shadow map is declared and bound, three are read (73 members and 18 bindings at 16) | separate statements (`matte.x`, `.y`, `.z`) | 3 for the code; the texture budget for the bindings | 6 casting | bounded by a small constant |
| R6 | One draw per geometry per sweep: `emitGeometry` (:2796), `emitDepthSweep` (:2043), `emitShadowPasses` (:2395), the projector phase (:2542), the G-buffer layers (:3291) | Geometries in the Render's Scenes list | author | text 0 (16 geometries of one material: the same 4 texts). Passes: 1 lit draw, plus 1 per G-buffer layer on (up to 3), 1 per casting directional light, 6 per casting point light, 1 per occluding projector, 1 for AO, 1 for the Depth output; a counted geometry adds an args dispatch and a mesh-instance geometry a resolve dispatch (`scene.ts:1336`). Measured: 12 passes a geometry with one casting point light, three layers, Depth and AO | separate passes, shared texts | none | 27 geometries (`E77:lightShot`); 244 passes in one plan (`on-nothing/incar`: 10 geometries, 2 casting point lights, 5 occluding projectors) | pass-count only |
| R7 | One lit text per distinct option set (model, maps, mesh rows, a Material · WGSL's code, a mesh instance's record offsets), each carrying every block of R1 to R4 | distinct materials and kinds of geometry | author | multiplies R1 to R4 | separate shaders | none | 4 distinct lit texts, 153,795 B together (`sentinel-bot`) | compile-time only |
| R8 | Group predicate on primitive instances, points, beams: `groupBlocks` (:1710). Same shape in `points.wgsl.ts:94` (Render Points) and `render-instances.wgsl.ts:46` | attributes the predicate names | author | 125 B, 1 storage binding, 1 struct member, 1 statement in `vs` | separate statements | 8 storage buffers a stage (`compiler/binding-budget`): 7 attributes pass, measured | 2 (`E34:bounce`) | bounded by a small constant |
| R9 | Mesh-instance draw bindings: `instancedStorageWgsl` (:1025), `packedBindingsWgsl` (`instance-resolve.wgsl.ts:84`) | packed buffers (producers) the draw reads | the author's chain | 64 B, 1 storage binding (*direct*) | declarations | 8 storage buffers a stage | producers per draw not counted; the only 3 mesh-instance geometries shipped are in `sentinel-bot` | bounded by a small constant |
| R10 | Material · WGSL `struct Params`: `customFields` (:1456), `customParams` (:1486) | fields the author declared | author | 38 B, 1 member, 13 B in `fs` (one constructor argument) | separate | none | 31 (`furnace:steel`) | compile-time only |
| R11 | Material · WGSL `struct Instance`: `instanceAccessors` (:1469), `instanceFill` (:1480); and `buildInstanceResolveWgsl` (`instance-resolve.wgsl.ts:151`) | fields the geometry bound | author | lit draw: 212 B, 1 function, 30 B in `fs`. Resolve pass: 405 B, 2 functions, 38 B in `resolve`. A Group attribute there: 219 B, 1 function (all *direct*) | separate statements | none by name | 4 (`sentinel-bot:material_hull`) | compile-time only |
| R12 | Environment Taps, Shadow Softness, AO Quality | a loop bound | author | 0: a WGSL loop with the count as a literal (7,542 B at 1 tap, 7,545 at 32) | a loop | 32; 4; three steps | 32 taps (`on-nothing/title`); softness 3 | count as text |
| R13 | Glass pyramid (5 levels: 5 functions, 5 bindings, an `if` ladder, `glassPyramidWgsl` :2624), prefiltered environment (4 spreads, :774), cube faces (6, a `switch`), the prefilter and AO passes | constants of the generator | definition | fixed | n/a | the constant | n/a | bounded by a small constant |

### 1.2 Compositing

| # | Site | The count | Who decides | Growth per item | Combined | Bound today | Largest shipped | Class |
|---|---|---|---|---|---|---|---|---|
| C1 | `blendFragmentWgsl` (`composite.wgsl.ts:61`): Composite, Over, Add, Multiply, Screen, Difference | edges on the variadic `in2` | author | 139 B (82 in `fs`), 1 texture binding | **one chain**: `acc = blendPixel(acc, sample)` per input, one `vec4f` carried | 8 (`MAX_COMPOSITE_LAYERS`, refused as `node.compile.tooManyInputs`; 9 refused, measured) | 5 (`E66:mix`, an Add) | bounded by a small constant (the chain form) |
| C2 | `switchFragmentWgsl` (`switch.wgsl.ts:28`) | edges on `inputs` | author | 140 B, in `sampleInput`'s `switch`; `fs` does not grow; 1 texture binding | switch arms, one runs | 8 (`MAX_TEXTURE_INPUTS`) | 3 (`E51:pick`) | bounded by a small constant |
| C3 | A stack of Layer nodes, or any chain of effect nodes | nodes | author | text 0 (five blend texts); 1 pass a node. Nothing in `src/compiler` fuses a chain into one shader (searched) | separate passes | none | 3 Layers (`E82`); 120 nodes in one graph (`E78`) | pass-count only |
| C4 | Custom WGSL · Multi (`custom-wgsl.ts:346`) | extra inputs | constant 3 | the author declares the bindings | n/a | 3 | 3 | none |

### 1.3 Points

| # | Site | The count | Who decides | Growth per item | Combined | Bound today | Largest shipped | Class |
|---|---|---|---|---|---|---|---|---|
| P1 | `buildGenerateKernelModule` (`points/codegen.ts:762`): `structFields` (:998), accessors (:1024), `loads` (:1045), `stores` (:1074) | attributes of the kernel's schema | author | 426 B, 2 functions (a load, a store), 63 B in `main` (one load, one store), 1 `Point` member. 0 bindings, 0 uniform members. 73 functions at 34 attributes | separate statements; the `Point` struct holds every attribute across the author's `process` | none by count; by size, `MAX_STORAGE_BUFFER_BINDING_BYTES` (128 MiB a half, `packing.ts:70`) | 8 (`sentinel-bot:kernel_claw`) | compile-time only |
| P2 | The kernel's `struct Params` (:1181) | fields the author declared | author | 1 uniform member, 1 constructor argument (*read*) | separate | none | 57 (`on-nothing/crt:skin`) | compile-time only |
| P3 | A kernel's storage bindings (:935) | producers it reads | the author's chain | 1 binding | declarations | 8 (`MAX_KERNEL_STORAGE_BINDINGS`, refused by name) | n/a | bounded by a small constant |
| P4 | Compaction and spawn copies: `copyRegionWgsl` (`points/lifecycle.ts:199`) in `scatterWgsl` (:215) and `spawnCopyWgsl` (:430) | attributes × components | author | 311 B and 327 B per vec4f attribute, all of it in `main` (5,256 B and 5,561 B at 16). The node's pass count does not move | separate statements (plain copies) | none | 3 (`E41:cloud`) | compile-time only |
| P5 | Spawn hook, `buildGenerateSpawnHookModule` (:1338) | as P1 | author | as P1 (*read*) | separate | none | n/a | compile-time only |
| P6 | Attributes carried through a curve node: `curveWgsl` (`curve.wgsl.ts:397`), `curve-resample.wgsl.ts:274`, `sweep.wgsl.ts:210` | attributes on the incoming edge | author (upstream) | Point Curve 502 B, Resample 596 B, Sweep 264 B per vec4f attribute, all in `main`. Curve Frames and Point Transform: 0 (they forward by reference) | separate statements | none | no Point Curve, Resample or Sweep node is in a shipped document | compile-time only |
| P7 | The curve's authored table: `tableWgsl` (`curve.wgsl.ts:116`), members at `point-curve.ts:469` | control points typed into Points | author | 64.5 B, 1.25 uniform members (`c{i}`, and one `r{g}` per four); `main` does not grow | switch arms | 64 (`CURVE_TABLE_LIMIT`, `points/curve.ts:1099`) | none shipped | bounded by a small constant |
| P8 | **Packed region offsets**: `regionAccessorWgsl` (`points/packing.ts:170`) and every `pk_N[<offset>u + …]` in the curve family | the point COUNT of the producer (offsets are stride × capacity, aligned to 256) | author | 0 B. But a line of 100 points against 200 moves 3 of 11 texts (kernel, frames, sweep); a kernel at 16 against 4,096 points differs in its offsets only | n/a | n/a | every point chain | count as text |
| P9 | Laser Path Slots (`const SLOTS_PER_POINT`), Ray Steps (a loop bound and a divisor), Proximity Neighbours (`const K`, two array sizes; Point Gather under it), a kernel's `ctx.dim` (`codegen.ts:1142`) | a count parameter | author | 0 B | a loop or a constant | 64; 256; 8 | 48 slots (`E50`), 64 steps (`E34`), 6 neighbours (`E54`) | count as text |

### 1.4 Counts that are already data (the precedents)

| # | Site | The count | Form | Measured |
|---|---|---|---|---|
| D1 | Cache, Echo, Slit Scan: Frames | history length | a ring bound as one `texture_2d_array`, `ringFrames` in a uniform (`cache.wgsl.ts:38`, `echo.wgsl.ts:33`, `slit-scan.wgsl.ts:28`) | Cache: identical text at 2, 4, 16, 64 frames |
| D2 | Feedback Substeps; kernel Substeps × Iterations | runs per frame | flat loop markers with `count` in the plan (`LoopPassDescriptor`, `plan.ts:311`; `expandLoops`, :1142) | kernel: identical text and the same plan at 1 to 256 iterations; feedback: identical at 1 to 16 substeps |
| D3 | Blur radius | taps | a uniform read by a WGSL loop | identical text at 1 to 64 |
| D4 | Ramp stops, Grid Warp points, Mesh File In lamp groups | table rows | a fixed-capacity table of named members (16 stops, 8 × 8 points, 8 gains) and the live count in a uniform | *read*; shipped maximum 7 stops, 3 lamp groups |
| D5 | Mesh File In joints, clip frames | rows of a fed buffer | a buffer and two uniforms; the text is a constant (`MESH_CLIP_WGSL`) | *read* |
| D6 | Point Grid Columns | points | uniforms | identical text at 8 and 16 columns |
| D7 | Preview tiles (`compile.ts`, from :1669) | previewed outputs | 1 or 2 passes each from a fixed set of texts; the preview's own light count is the constant 1 or 2 (`scenePreviewBallWgsl`, the third copy of the light block) | *read* |

### 1.5 A definition constant in the B260 form, on purpose

`PERLIN_4_CORNERS` (`noise.wgsl.ts:84`) writes the sixteen corners of 4D Perlin noise as sixteen blocks, each `acc = acc + …`, in one function. Its comment records why: unrolled it measured about 40 % faster on Metal than the loop. The count is the generator's, not the document's. It is listed because it is the same form at a fixed 16, measured the other way round, and the rule's exception for definition constants has to admit it.

### 1.6 Author text, and where there is none

- **Custom WGSL** (`custom-wgsl.ts`): the shader is the author's, bindings included. The generator adds only the `// @use` prelude: five shared modules exist, 645 to 3,746 B each (*direct*); no shipped source uses more than one.
- **Point kernels and Material · WGSL**: the author's code is placed inside generated text (P1, P2, R10, R11). A Material · WGSL's `surface()` result is live across every light block of R1.
- **Largest author functions in shipped plans**: `E70:shape` 29,138 B, `E68:temple` 18,597 B, `E57:forest` 16,959 B (fragment), `sentinel-bot:kernel_claw` 13,483 B (`process`). Their documents are generated from sources under `src/examples/**` and `src/projects/**`. Not read; see section 5.
- **No pass and no WGSL at all**: the value graph (`value-graph-nodes.ts`, `value-structure-nodes.ts`), the expression engine, Panel, Presets and their morphs (`MAX_MORPH_RECORDS` is CPU state), Cue List and Set Lists, audio, MIDI and OSC. Searched for `wgsl` and for pass descriptors: none.

## 2. The B260-shaped sites: the data form, what stops it, what a change of count costs

### 2.1 Lights (R1, R2)

- **Data form.** Three vec4 rows per light (48 bytes) in a table, a `lightCount` beside it, and one loop whose body is the light block as it stands: the block already reads three locals (`lightMeta`, `lightColor`, `lightVector`), so only its first three lines change. `docs/lights-from-pointset-design-2026-10-06.md` section 2.4 already gives a lit draw one storage buffer, the Render's light table; §T1623b puts named non-casting Lights in it. Both generators take the same loop text, as they take `POINT_FALLOFF_WGSL` and `ggxSpecularWgsl` today.
- **What stops it today.** Not WGSL: a non-casting light's block reads no texture. Two things in the plumbing. (1) A uniform block cannot be handed an array of rows: `UniformValue` is a flat list of numbers (`plan.ts:21`; the Ramp's docblock, `generators.wgsl.ts:17`, states it as the reason for its twenty named members). So the rows either go in a storage buffer, which costs one of eight storage bindings on a draw where a fully attributed mesh already uses seven (that design's own count), or the plan contract learns a row-array value. (2) The generators' options carry `lightCount: number`, and a number is what `Array.from({ length })` unrolls.
- **What a change of count costs today.** Adding or removing one Light changes the text of every lit draw of every Render that lists it: one text per distinct option set (R7), in both generators, and the shadow matte's variants. The Normal and Albedo layers are untouched (they are generated with `lightCount: 0`). Shipped worst case: sentinel-bot, 4 distinct lit texts, 154 KB. B260 measured a new lit text at about 60 ms plus 8.5 ms a light. In the data form it is a buffer write.
- **R2 is a separate edit.** A stopgap or a loop that lands only in `buildSceneSurfaceModule` leaves primitive instances, billboards and beams unrolled.

### 2.2 Casting lights (R4)

- **Data form.** The shadow maps as layers of one `texture_2d_array`, the slot's kind (directional or point), its matrices, softness and bias as row data, the PCF radius as a run-time loop bound (at most 4, as the parameter already clamps). Then the casting block is the same loop as 2.1.
- **What stops it today.** (1) A shader cannot index its texture bindings, and every slot has its own `shadowMap{s}`. (2) Softness and bias are literals in the text, and a slot is one of two text variants (one matrix, or a position and six face matrices over a 3 × 2 atlas). (3) An array needs one size for every layer; a directional map is 2× the output and a point atlas 1.5×. Both are the Render's own scratch targets, so the size is the Render's to choose. (4) Whether a scratch target can be an array with several layers written in one frame was not checked: the ring is an array, written one layer a frame.
- **Interim form (the lead's ruling in §B260)**: casting blocks stay blocks, each under its own guard, or the loop takes the slot's lookup through a `switch`.
- **What a change costs today.** Toggling Cast Shadows, or changing Shadow Softness or Shadow Bias (both compile-time), moves every lit text as in 2.1, and adds or removes a clear and one sweep draw per caster geometry (six for a point light).

### 2.3 Projectors (R3)

- **Data form.** A projector's rows (a mat4 and three vec4, 112 bytes) in the same table as the lights, a `projectorCount`, one loop. The occlusion depth maps are the Render's own scratch targets, all at 2×: layers of one array. A projector with no cookie and no occlusion (a focus light) is pure rows.
- **What stops it today.** The cookie. It is another node's output, with its own size and format, read through its own binding. Three ways through, to be ruled on: an array the Render fills with one blit per cookie (a pass each, and one cookie resolution); one binding per cookie read through a `switch` inside the loop (text then grows by a switch arm per cookie, which is a declaration bounded by the texture budget, not a chain); or cookies in an atlas.
- **What a change costs today.** Adding a projector, wiring or unwiring its cookie, or toggling Occlusion moves every lit text of the Render in both generators, and an occluding one adds a clear and a depth draw per geometry.
- **Not known.** Each projector block's `lit +=` sits under two `if`s, which is close to the guarded form B260 measured as cheap. That is by accident. A block with no cookie and no occlusion is branch-free arithmetic inside those `if`s, and whether Metal flattens them was not measured.

### 2.4 Composite's fold (C1)

- **Data form.** None without a texture array: the inputs are other nodes' outputs at their own sizes. The form that removes the chain is N − 1 two-input passes, which is what a stack of Layers already is: pass count instead of text.
- **What stops it.** Bindings cannot be indexed.
- **What a change costs today.** One more wire recompiles that one node (the count is in its pass id). The bound of 8 holds the chain to eight `vec4f`.

### 2.5 The two quieter classes

- **Per-attribute copies (P4, P6)** are byte copies with no typed access. Their data form is a small table of (base, words per point, components) walked by a loop. Nothing stops it. The kernel's own loads and stores (P1) are different: the author's code names the fields, so a `Point` member and an accessor per attribute are the node's type.
- **Counts as literals (R12, P8, P9).** The data form is a uniform. For the packed offsets nothing stops it: a point-count change already reallocates the buffers, but the texts that read them need not move.

## 3. The rule

Proposed for §V (the lead assigns the number):

> **GENERATED TEXT IS A FUNCTION OF WHAT A NODE IS, NEVER OF HOW MANY THE DOCUMENT HAS.** The text of a generated shader and the pass list of one node may depend on structure chosen per node (a material model, a blend, which optional inputs are wired, the names and types of a schema, the author's own source) and never on a COUNT the author raises by adding items: lights, projectors, casters, layers, inputs, list entries, table rows, points, steps, taps. A count is DATA: rows in a buffer or layers of a texture array walked by a loop with a run-time bound, a count in a uniform, a loop region with its count in the plan (the forms Cache's ring, feedback substeps and kernel steps already take: T425, T387, T1583b). Compiled at N and at 2N items, every text is byte-identical.
>
> **Exceptions, each one a row in the gate's ledger with its bound and its reason, and the ledger only shrinks:** (a) a count the DEFINITION fixes (five pyramid levels, sixteen Perlin corners), because the document cannot raise it; (b) one DECLARATION per item where the language forces it (a binding per texture or buffer read, because a shader cannot index its bindings; a member and an accessor per attribute of an author-declared schema, because the author's code names them), only as declarations and independent statements and only under a refusal by name at a stated count; (c) one PASS per item that reuses a text shared by every item (a draw per geometry per sweep). **Under no exception** may a function body grow per item while one value is carried from one item's statements into the next (`acc += …`, `acc = f(acc, item)`): that is §B260.

Notes for the ruling:

- **Composite (C1) breaks the last sentence as written.** Either it is rebuilt as passes, or the sentence admits a carried chain under a named refusal at 8 or fewer items with one texture sample per item. That is the lead's call; the ledger can hold it either way.
- **Kernel attributes (P1) have no count bound**, only a byte bound. Under (b) they need one, or a row saying why not.
- **Counts as literals** are covered by "byte-identical". A loop bound the compiler should see as a constant (Environment Taps) is a ledger row with that reason.
- **The seam that would make the rule a type**, in the spirit of §T1335b and §V1012: generators that take a document list should be handed a rows handle that offers a declaration, a loop and a count uniform, and no `length` to iterate at generation time; and the plan contract should carry a row table. Then the cheap path is the only path. That is a design of its own and is not specified here.

## 4. The gate

**Where.** `src/compiler/generated-text-growth.test.ts`, beside `generated-text.test.ts` (T1603b), which already derives structural parameters from the definitions. On `test:gates`: a new list appears exactly when a node definition's shape changes, which is when `test:gates` is run, and `vitest related` from a definition reaches hundreds of files.

**What it derives (not remembered).** From the node registry, every axis along which a document can raise a count:

1. every variadic input port (`inputs[].variadic`): 15 today, among them `render.scenes`, `render.lights`, `render.projectors`, `composite.in2`, `switch.inputs`;
2. every list reference (`sourceReferences[].list`);
3. every pointset input, as "attributes on the incoming edge";
4. every `compileTime` parameter of type number (a count that reaches structure);
5. every `code` parameter in JSON (a schema or a table) and in WGSL (the author's `struct Params` and `struct Instance`).

Each axis needs a row in the gate's ledger: a fixture that builds the graph at N, and the law it claims. **An axis with no row fails by name**, as a command with no coverage row fails `command-holder`. After every row has run, the gate reads `generatedTextCounts().byGenerator`: a `generatedOnce` generator that no row made run fails by name too, so a new generator cannot stay outside it.

**What it asserts, per axis, compiled at N = 1, 2, 4, 16 (clamped to the row's bound) with nothing remembered.** Exactly one law:

- **flat**: the set of distinct texts is byte-identical at every N. This is the rule; D1 to D3 and R6's texts pass it today.
- **literal**: the texts are identical once every numeric literal is replaced by one token. Needs a bound and a reason.
- **declarations**: no existing function body grows; what grows is members, bindings and whole new functions. The ledger states members, bindings and functions per item; the measurement must equal them.
- **statements**: a function body grows, and no name declared outside the text added per item is both read and written by it. The ledger states the function's name and its bytes per item; the measurement must equal them.
- **chain**: a function body grows and the text added per item both reads and writes a name declared outside it (`lit +=`, `acc = blendPixel(acc, …)`). Found mechanically: the per-item text is the difference of that function's body between N and N + 1; in it, an assignment whose left-hand name is not declared inside it and appears again on the right, or a compound assignment to such a name. **Allowed only in a `NOT_YET_DATA` list**, each entry with the task that removes or bounds it, and the list's length is asserted exactly, as `NOT_YET_RENAMED`'s counts are: it can go down by deleting a row and cannot go up without a reviewer seeing it.

Passes are a separate figure on every row: passes per item, and distinct texts per item, which must be 0.

**The bound is tested, not trusted.** A row that names a bound compiles at the bound (must compile) and at the bound plus one (must be refused with the diagnostic code the row names). For this audit `node.compile.tooManyInputs` was measured at exactly 8 and 9 inputs. `compiler/binding-budget` was seen to pass at 8 storage buffers and refuse at 17, and to pass at 16 sampled textures and refuse at 32; the steps in between were not compiled.

**The detector is checked against the known positive first** (§V968). Before §T1623b lands, `render.lights` must be classified *chain* by the gate with 1,888 bytes per item in `fs`. A detector that calls today's Render anything else sees nothing.

**What the ledger would say today** (from section 1): chain, unbounded: `render.lights` through both generators, `render.projectors`, a casting light; chain, bounded at 8: the six composite nodes; statements: Switch, the point kernels, compaction, the curve family; declarations: Group predicates, Material · WGSL fields, mesh-instance bindings; literal: Environment Taps, Shadow Softness, Slots, Steps, Neighbours, and every axis that changes a point count; flat: the rest.

**What it costs.** The registry yields 106 axes today over 152 definitions: 15 variadic ports (5 of them list references), 23 pointset inputs, 52 compile-time number parameters, 8 JSON and 8 WGSL code parameters. At 4 counts that is about 420 compiles of small graphs. Measured for this audit under plain node: 195 such compiles, a 64-light Render among them, in two processes of 0.31 s each, module loading included; compiling all 112 shipped documents took 1.04 s. Inside vitest the module transform will be most of it. A few seconds at the outside, with no GPU. Most of the 52 number parameters and the 23 pointset inputs can share two generic fixtures (set the value; a kernel with A attributes upstream); a row whose fixture does not compile fails, it is not skipped.

**What it cannot see.** Author text and the document sources that build it. The cost itself: it asserts the form that caused §B260, not a time. A chain hidden behind an array write or a function that returns through a pointer. A count decided inside a component and multiplied by its instances (not measured).

## 5. What was not read, and what was classified from reading alone

**Not read, or only searched:**

- `src/runtime/backend/vgpu/**`: how uniforms are written and how a ring is allocated. What is said about `UniformValue` comes from `plan.ts` and the generators' own comments. Whether a scratch target can be a multi-layer array written in one frame is unknown (2.2).
- `src/compiler/compile.ts` in full: the preview synthesis call sites and every use of a shader were read; the rest was searched. `flatten.ts`, `frame-compile.ts` and most of `substeps.ts` were not read. Component instances (N instances of one component) were not measured.
- `src/points/curve.ts`, `sweep.ts`, `topology.ts`, `mesh.ts`; the bodies of `curve-frames*.wgsl.ts`, `curve-resample.wgsl.ts` and `sweep.wgsl.ts` beyond their list-building lines (they were measured through the compiler instead).
- `src/runtime/previews/**` beyond a search for generated text (none found: `debug-effects.wgsl.ts` is a fixed set).
- The `compile()` of most plain filters, colour nodes, generators, optics, film, depth, matte, pose, person mask, media, text and the IO nodes. They were classified from the registry listing (no variadic port, no list, no count parameter) and from a search of `src/nodes/shaders/**` for text built in a TypeScript loop, which found only the sites in section 1.
- Document sources: `src/examples/documents/**`, `src/examples/shaders/**`, `src/projects/**`. A search finds list-building constructs in them (43 in `on-nothing/shots/mcu.ts`, 31 in `sentinel-bot/document.ts`, 15 in `sentinel-bot/rig.ts`); whether any of them writes WGSL per item was not read. The same shape can be written there, and neither this audit nor the proposed gate looks.
- `SPEC.md` beyond the rows for §B260, §T1623b and §T1589b.

**Classified from reading, with no text measurement:** the spawn hook (P5); the kernel's `struct Params` (P2); the legacy Render Instances group gate (same text shape as Render Points, which was measured); the Render's constants (R13); the shadow matte's cap of three was measured, its reason was read; Ramp, Grid Warp, Mesh File In (D4, D5); Echo and Slit Scan (Cache was measured); the preview tiles (D7); 4D Perlin (1.5); the lambert model's bytes per light (PBR, Phong and Unlit were measured).

**Measured by calling the generator, not through a graph:** the instance resolve pass and the mesh-instance lit draw (R9, R11), and the shared-module preludes.

**No GPU figure in this document is mine.** Every statement about cost is §B260's. "B260-shaped" here means the form of the text: per-item blocks in one function, one value carried through them. For the projectors and for the instances generator, that the form costs what it cost the lights is an inference.
