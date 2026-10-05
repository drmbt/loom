# What one more Geometry costs a frame

2026-10-05. A profile, taken before any performance code was written for T1581b's F1, and a plan for what it found. Companion to `docs/mesh-instancing-design-2026-10-05.md` (section 13 has F1 as built). P1 of the plan is built (T1603b, below); P2 has its design here (T1604b) and no code.

## The answer

**One more instanced Geometry costs about 1.2 ms of CPU and 0.3 ms of GPU a frame when the Render casts shadows, and about 0.5 ms of CPU and nothing on the GPU when it does not.** The triangles are not the cost. The cost is that the Render draws each Geometry in fifteen passes, each pass is rebuilt on the CPU every frame, and each is its own render pass on the device.

Eight small Geometries (the sentinel's claw as nine pieces instead of one) take the consumer's document from 50 to 31.5 frames a second in the app.

## What was measured, and how

- **Documents**: the consumer's own (`sentinelDocument`, one robot, 1280×720), with the claw rigid (5 Geometries) or hinged (13: eight more, each a Mesh File In, a Point Kernel, a Geometry in Instances mode with Shape: Mesh, ten instances of 384 to 476 triangles), and with shadows off or on. The two claw forms draw the same triangles.
- **The frame is run the way the app runs it** (`use-graph-compile.ts`, `use-frame-loop.ts`): the value graph, then `prepareFrameCompiler().compileFrame` (the values-only compile), then the uniform animator, then `backend.render`. Each is timed on the CPU. Every document was values-only; none fell back to a full compile.
- **GPU**: the device's timestamp queries. One headless `render()` is several vgpu frames; their extents are summed. Beside it, the wall time of a frame with the GPU drained (a readback of the output).
- **Device calls** are counted by wrapping the device (submits, encoders, passes, draws, buffer writes); CPU figures below are from runs without the wrapper.
- **Machine**: Apple M3 Max, Dawn on Metal, Node. It is shared: other sessions ran GPU work during some runs, and those runs are not used. A run counts as clean when no other headless browser was alive at its start or its end.
- **In the app**: one run of the consumer's `compare.mjs`, rigid then hinged then rigid, shadows on, on main before F1.
- The scripts are scratch and not in the repository (`scratchpad/perf-geometry.ts`, `perf-rejected.ts`, `perf-resolve.ts`).

## Numbers

Headless, per frame, median of 200 to 240 frames, clean runs.

| Document | Geometries | Plan passes | Draws | Dispatches | CPU | of which values-only compile | uniform push | encode and submit | GPU |
|---|---|---|---|---|---|---|---|---|---|
| rigid, shadows off | 5 | 55 | 17 | 9 | 6.2 ms | 3.3 | 0.3 | 2.0 | 5.8 ms |
| hinged, shadows off | 13 | 119 | 41 | 25 | 10.2 ms | 5.7 | 0.7 | 3.4 | 5.9 ms |
| rigid, shadows on | 5 | 105 | 67 | 9 | 6.9 ms | 3.4 | 0.5 | 2.4 | 8.5 ms |
| hinged, shadows on | 13 | 265 | 187 | 25 | 16.1 ms | 8.0 | 1.4 | 6.2 | 11.1 ms |

The two shadows-off rows were taken while the machine was busier than for the other two (their CPU is somewhat high); the differences below are within one pair each.

**Per added Geometry** (hinged minus rigid, divided by eight):

| | Plan passes | Draws | Dispatches | CPU | compile | push | encode and submit | GPU |
|---|---|---|---|---|---|---|---|---|
| shadows off | +8 | +3 | +2 | +0.49 ms | 0.30 | 0.04 | 0.17 | +0.02 ms |
| shadows on | +20 | +15 | +2 | +1.15 ms | 0.57 | 0.11 | 0.47 | +0.33 ms |

- The fifteen draws are the lit draw, the Normal layer, the Depth sweep and twelve cube-shadow faces. The two dispatches are the Geometry's resolve and its kernel.
- **On the device every draw is its own render pass**: 200 render passes and 200 draw calls a frame for the hinged document with shadows, 38 submits headless.
- **In the app** (headless Chromium, the document's own 1280×720): rigid 49.8 and 49.2 frames a second (median frame 16.7 ms), hinged 31.5 (33.2 ms). The consumer's "about 5 fps" was the same eight Geometries removed from a document with more switched on.

## Where the CPU goes

A CPU profile of the hinged document with shadows (V8 sampling, 330 frames), as shares of the values-only compile:

| Share | What |
|---|---|
| 29% | the Render's depth sweeps (`emitDepthSweep`): the depth shader's text built for every sweep of every geometry, and `cubeShadowVariant` rewriting that text for each of six faces |
| 15% | the Render's lit draw and G-buffer layers (`emitGeometry`, `sceneSurfaceModule`) |
| 14% | the point kernels regenerating their modules (`generateKernelModule`) and scanning their source with regular expressions |
| 9% | the verifier (`passStructureKey`): each pass serialised, shader text included, to prove its structure did not change |
| 33% | everything else: expressions, parameter resolution, the walk itself |

- Inside the first three rows, a fifth of the whole compile is the `wgsl` tag looking its text up: the pieces handed to it are rebuilt as new strings each frame, so each lookup hashes kilobytes again.
- **So more than half of the per-frame compile builds shader text that a values-only frame cannot change.** That is what "values-only" means, and the verifier checks it.
- Encoding is the device calls: a render pass begun and ended per draw, a bind group and a draw each.

## The plan, by what it would save

**P1. Do not rebuild shader text on a values-only frame.** About 5 of the 8 ms of compile at thirteen geometries with shadows, and about 0.4 of the 0.57 ms each added Geometry costs. **Built: see "P1 as built" below.**

**P2. One render pass per target, not per draw.** The hinged document with shadows has 200 passes over about twenty targets.
- On the CPU it is the 0.47 ms of encode and submit per added Geometry: about 0.03 ms a pass.
- On the GPU it is most of the 0.33 ms per added Geometry, and all of what an indirect draw costs (below), because each pass loads and stores its target on a tile-based GPU.
- It is a change in the backend's `encode` only: consecutive draws into one target that do not clear share one pass. The plan and the nodes are unchanged. The per-pass GPU timer then measures a group of draws, so a node's GPU row becomes its share of a pass; that is the cost of it and needs deciding.

**P3. F2 (several shapes on one Geometry), or batching the resolve passes: not the lever.** An added Geometry's two dispatches are about a tenth of its CPU cost and none of its GPU cost. F2 would remove sixteen dispatches from the hinged document and none of its 120 added draws. With P2 in place F2 becomes worth more, because then a shape is a draw in a pass that exists.

**The order this suggests**: P1's first step, then P2, then measure again before F2.

## Found on the way

- **An indirect draw was not a draw of its frame.** A geometry over a counted pointset draws indirect. The backend gave that draw its own command buffer, which cleared the target and was submitted at once: headless it erased the backdrop and every geometry before it, and in the app it ran ahead of the frame's passes and was erased by them. Fixed (`indirect-draw-order.gpu.test.ts`); F1 needed it.
- **An indirect draw is not free.** On this machine a render pass holding one indirect draw costs about 0.05 ms of GPU more than the same draw with a literal count, and about 0.12 ms when the device lacks `indirect-first-instance` (Dawn then validates the arguments in a compute pass ahead of each such render pass). Measured on the hinged document with all 150 mesh-instance draws indirect: 11.1 ms of GPU with literal draws, 18.5 ms indirect with the feature, 29 ms without it. The per-pass spans do not show it; the frame's extent and the wall time do. F1 therefore compacts only a geometry that can leave an instance out, and the device now asks for the feature.

## P1 as built (T1603b)

**A values-only frame builds no shader text.** Every generator that assembles a module is wrapped by `generatedOnce` (`runtime/backend/wgsl.ts`): the lit and G-buffer surface module, the three depth sweeps and `cubeShadowVariant`, the primitives' and the glass generators, the backdrop, the instance resolve pass, and the point kernels' modules (kernel, spawn hook, compaction, spawn). Called again with the same arguments, a generator returns the same result and runs nothing.

- **The key is derived, not declared.** It is a walk of the arguments themselves: every property of every options object, every element of every array. An option added to a generator later is in the key the day it is added. What the walk cannot describe (a function, a class instance) it refuses by throwing.
- **The walk is the lookup.** It descends a trie, a step per value; no key string is built. A string key was built first and cost 0.94 ms a frame on the hinged document (350 generator calls); the trie costs 0.55.
- **Results are shared, so they are frozen** once, deeply.
- **The verifier compares passes where they stand** (`samePassStructure`). It used to build each re-emitted pass's structure key, which serialises the shader text: 1.15 ms a frame. The comparison walks the same parts the key is made of, and a remembered text is the same string object as the base plan's.

**Measured**, the per-frame values-only compile alone (no device; median of 900 frames; the value graph evaluated as the app does):

| Document | Before | After |
|---|---|---|
| hinged, shadows on (13 geometries, 265 passes) | 8.0 ms | 2.8 ms |
| rigid, shadows on (5, 105) | 2.8 ms | 1.1 ms |
| hinged, shadows off (13, 119) | 4.6 ms | 1.9 ms |
| rigid, shadows off (5, 55) | 1.7 ms | 0.8 ms |

- Per added Geometry with shadows: 0.65 ms of compile before, 0.22 after.
- With the device in the loop the same documents' whole CPU frame went from 18.9 to 12.9 ms (hinged, shadows on) and from 7.9 to 6.0 ms (rigid); the compile's share there reads 8.7 to 3.5 ms and 3.8 to 1.9 ms.
- What is left of the 2.8 ms: the key walk (0.55), the pass comparison (0.27), and the nodes' own work of building option objects, uniforms and bindings for 265 passes. Encoding is now the larger half of the frame's CPU (7.4 of 12.9 ms): that is P2.

**The two gates** (`compiler/generated-text.test.ts`):

- On the consumer's hinged document and five shipped examples (E13, E33, E28, E69, E79), a values-only frame runs no generator and builds no template text, and what it splices equals a full compile done with nothing remembered, byte for byte.
- Every structural parameter of Geometry, Render, Material · WGSL, Point Kernel, Point Kernel · Advanced and Light is changed one at a time over a scene compiled before it: every `compileTime` parameter of each definition, every name it references another node by, and every Geometry parameter in Map mode, all derived from the definitions. After each change the plan equals the one a compile with nothing remembered gives. Code parameters include an edit that keeps the text's length.

**What the gates cannot see.** An emitter that assembles text by hand and then looks it up through the `wgsl` tag is not a wrapped generator and is not counted; it would be slow, not wrong. A scan of the 23 shipped examples with a Render found none on a values-only frame.

## P2, design: one render pass per target (T1604b; built, see "P2 as built" below)

**The change is in the encoder, not in the plan.** A plan pass stays what it is: one draw, with its own id, shader, bindings, uniforms and node. What changes is how many DEVICE render passes the backend opens for them.

- **A run.** Consecutive plan passes of kind `draw` with the same target, of which only the first may clear, are one run. Anything else ends a run: an effect, a dispatch, a swap, a loop marker, another target, a `clear: true`. The backend opens one render pass for a run and encodes each member as a draw inside it. One pure function over the pass list (`renderPassRuns`, in `plan.ts`) says where the runs are, and the encoder and every reader below call that one.
- **What it does to the hinged document**, counted from its plan with that rule: 200 device render passes become 43. Each of its two cube shadows is one run of 73 draws (six faces share one atlas target), the lit draws are one run of 14, and 27 draws stay alone: the Render emits each geometry's Normal and Depth layers one after the other, so those draws alternate targets. If the Render emits a layer's draws together (all Normal, then all Depth), which nothing forbids since neither reads the other, the count is about 19. That second step is a change in the Render's emission order and is part of this row.
- **Loops.** A run never crosses a loop marker, so a substep or kernel-step region keeps its boundary. Inside a body the rule is the same, on the expanded order the encoder already caches (`encodePasses`).
- **Order.** Nothing moves: a run is passes that were already adjacent. On the direct path a dispatch already ends the vgpu frame; on the loop path it already runs ahead of the frame's passes. An indirect draw is a member like any other (B253).
- **Timer spans.** A timestamp pair belongs to a device render pass, so a run has ONE span where its members had one each. This is the cost of P2 and the decision it needs:
  - the per-node GPU row cannot be exact for members of a run. The span is billed to the run and each member node is shown as a share-holder of it, said as such; no number is invented by dividing it;
  - while the performance panel or the perf timeline is open the backend encodes one pass per draw again, so a person measuring a node measures it. The grouped frame is the default, the exact one is on demand. Both are the same plan.
  - the 2,048-span ceiling per frame (T1583b) stops being a concern for scenes: twenty spans, not two hundred.
- **Uniforms and bindings** are per draw and stay so: a bind group and a draw call each. `updateUniforms({ passId })` addresses a plan pass and is unchanged, which is what the inspection orbit and the uniform animator use.
- **Previews.** A tile's synthesized passes (backdrop, then the object) are a run of two and can take the same encoder. Their pass ids, and the orbit's `passIds`, name plan passes and do not change.
- **The pipeline inspector** reads the installed plan's passes and keeps doing so. It can show the runs as a derived fact ("these fourteen draws share one render pass") from the same function, so it describes what the device does.
- **Gates.** The picture of every example that has a Render is unchanged (the pixel gates exist; the layer reorder moves no pixel, each layer has its own target). The device render pass count is asserted on a scene by counting `beginRenderPass`, as this profile did. A run that would cross a clear, a loop marker or a target is asserted not to form.
- **Expected.** Encode and submit are 0.47 ms per added Geometry today, about 0.03 ms a pass; most of the GPU's 0.33 ms per added Geometry and all of an indirect draw's 0.05 ms are per pass on a tile-based GPU. To be measured, not promised.

## P2 as built (T1604b)

Built as designed and ruled, with two things the design did not have: a run is ONE NODE's draws, and a multisampled target is left alone.

**The rule** (`renderPassRuns`, `src/runtime/backend/plan.ts`, the one definition). A run is consecutive `draw` passes of one node into one target, of which only the first may clear. An effect, a dispatch, a swap, a loop marker, another target, another node or a clearing draw ends it. The encoder opens one device render pass per run and draws each member in it. It finds a run by each draw's place in it, read off the plan as written, so a loop body's last draw never joins its own first.

- **One node per run.** The design let a run mix nodes and said its span would then be shared between them. Kept to one node, the per-node GPU figure stays a measurement and only the passes inside a node share. In the eleven plans checked (both sentinel-bot tiers and nine shipped examples) the rule shortens no run.
- **A skipped draw** (T1598b) is left out of its run. As the run's head it still clears.
- **A multisampled target is a pass per draw.** Measured, not reasoned: with it grouped, sentinel-bot's colour (rgba16float, 4× MSAA, 640 × 360) differed from one pass per draw on 0 to 8 of 230,400 pixels a frame, each by one unit in the last place of one channel, where two mesh-instanced geometries meet. Every single-sampled target was byte-identical. The cause was not found: the stock material showed it too, and built scenes of up to 8,192 interpenetrating instanced meshes under three casting lights did not show it at all. The frame must not depend on whether someone has the performance panel open, so the rule stays on the safe side. It costs the live tier five device passes (30 instead of 25).

**The Render's order.** Each G-buffer layer's draws are emitted together, after everything that draws the colour. A layer has its own target and its own depth, so no pixel moves. With no glass in the scene the backdrop, the opaque draws and the additive ones are one run. B256 changed no boundary: it took one draw out of the Depth output's run.

**Timing.** A run has one GPU span, named for its head and for how many passes share it (`head+13`). `spanBasePassId` bills it to the head, which is the right node. The telemetry hub reads the name: the head's row carries the figure, the others read "shared", and a pass's own span from a moment earlier is dropped when the run takes over, so a node is not billed twice. While the performance panel is on screen it holds a demand (`demandPassDetail`) and the backend encodes one pass per draw (`setExactPassTiming`); a hidden pane holds none. The CPU half stays per draw.

**Device render passes**, one per draw and grouped:

| Plan | One per draw | Grouped |
|---|---|---|
| shadow-caster test scene, Depth and Normal read (66 plan passes, 31 draws skipped) | 35 | 6 |
| sentinel-bot live as shipped (147 plan passes) | 122 | 30 |
| sentinel-bot offline as shipped (427 plan passes) | 362 | 38 |

Five cube shadows in the live tier are 84 draws and 5 clears: 89 passes before, 5 after.

**Measured**, sentinel-bot as shipped at `c74efba8`, one robot, 1280 × 720. Apple M3 Max, Dawn on Metal, headless, the frame run as the app runs it. Medians of 240 frames; the two encodings alternated in one process, so each row is one run of the script.

| Document | Encoding | Device passes | GPU per render | CPU per frame (encode, submit) | Wall, GPU drained |
|---|---|---|---|---|---|
| live (five casting lights) | one per draw | 122 | 15.1, 14.8 ms | 7.95, 7.74 (2.52, 1.26) | 24.7, 24.0 ms |
| live | grouped | 30 | 13.9, 14.0 ms | 6.36, 5.98 (1.65, 0.57) | 21.5, 21.3 ms |
| offline | one per draw | 362 | 23.8 ms | 18.2 (6.83, 3.06) | 42.8 ms |
| offline | grouped | 38 | 17.2, 17.2 ms | 12.5, 13.1 (3.51, 1.00) | 30.2, 30.9 ms |
| hinged claws, only the eyes cast, everything casts | one per draw | 130 | 11.7 ms | 10.9 | 23.5 ms |
| the same | grouped | 34 | 9.4 ms | 8.7 | 19.7 ms |
| rigid claw, only the eyes cast, everything casts | one per draw | 58 | 9.6 or 35 ms (see below) | 6.45 | 17.2 or 42 ms |
| the same | grouped | 26 | 9.2 ms | 5.74 | 16.5 ms |

The rigid document's one-per-draw run was bimodal: 91 renders near 9.6 ms and 149 near 35 ms (B251). Its row is not a clean comparison.

**Where the live frame goes** (grouped; each figure is the live document against the same document with that part off):

| Part | GPU | Wall |
|---|---|---|
| the whole frame | 13.9 ms | 21.4 ms |
| five cube shadows | 7.0 ms (50%) | 7.8 ms (36%) |
| the finish chain (reflections, occlusion, haze, focus, bloom, lens, grade) and the Depth and Normal layers only it reads | 3.9 ms (28%) | 4.4 ms (21%) |

**One casting point light with a caster list**, live tier: a fifth of what the five cost.

| | GPU | CPU | Wall |
|---|---|---|---|
| one pass per draw | 1.54 ms | 0.53 ms | 2.07 ms |
| grouped | 1.39 ms | 0.24 ms | 1.56 ms |

Grouping removes the passes, not the triangles: each light still draws its casters in six faces (about 3.9 million triangles a light for the hull, the rings and the claw).

**Each light on its own**, grouped: the live document with that one light's Cast Shadows off, against the control (GPU 13.8, 14.1, 13.7 ms; wall 21.4, 21.9, 21.0 ms in the same run).

| Shadow turned off | Casters | GPU saved | Wall saved |
|---|---|---|---|
| `light_eyes` | hull, ring, claw | 1.6 ms | 2.1 ms |
| `light_lamp0` | hull, ring, claw | 1.6 ms | 1.1 ms |
| `light_lamp1` | hull, ring, claw | 1.6 ms | 1.5 ms |
| `light_lamp2` | hull, ring, claw | 1.2 ms | 0.8 ms |
| `light_body` | ring, claw | 1.2 ms | 0.8 ms |
| all but the eyes | | 5.4 ms | 5.8 ms |
| all five | | 7.0 ms | 7.8 ms |

The wall figures move by about half a millisecond between identical runs, so the lamps are not separable by them. By GPU time the two cheaper ones are the body light (no hull) and `light_lamp2`.

**In the app**, one run: headless Chromium, the main checkout (before) and this branch (after) served side by side and opened in turn in one browser, the same document file.

| Document | Build | Frame interval, median | Frames per second | Header GPU readings |
|---|---|---|---|---|
| live | before | 41.1 ms | 26.3 | 23 to 31 ms |
| live | after | 40.7 ms | 26.2 | 26 to 31 ms |
| live | before | 41.9 ms | 24.0 | 25 to 38 ms |
| live | after | 33.4 ms | 28.7 | 22 to 27 ms |
| offline | before | 58.3 ms | 17.8 | 42 to 51 ms |
| offline | after | 49.7 ms | 21.7 | 29 to 34 ms |
| offline | before | 66.6 ms | 15.7 | 45 to 53 ms |

The offline tier is plainly faster. The live tier is not settled by this run: one "after" equals the controls and one is 8 ms better. The app's frame here is about twice the headless one and spread wide.

**Gates.** `render-pass-runs.test.ts`: the rule, the exact device pass count with a device-call counter, the loop rule, the span names, the Render's own runs. `render-pass-runs.gpu.test.ts` (Dawn): grouped and one-pass-per-draw pictures byte-identical on the test scene's three outputs, with additive light, with a draw arriving mid-run, and on five shipped Render examples. `hub.test.ts`, `performance-panel.test.tsx` and `composition-wiring.test.tsx` hold the timing rule and that the panel reaches the backend through the composed app. Beyond the gates: the output, colour, Depth and Normal of both sentinel-bot tiers and seven shipped examples hashed the same before the change and after it.

**Not built.**

- A preview tile's synthesized passes still open a pass each.
- The pipeline inspector does not show which draws share a device pass.
- A counted pointset's args dispatch is emitted at its first use, which can be between the colour's draws, where it splits that run (read from the code, not measured).
- Runs into a multisampled target, pending a cause for the one-unit difference.
