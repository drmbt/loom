# What one more Geometry costs a frame

2026-10-05. A profile, taken before any performance code was written for T1581b's F1, and a plan for what it found. Companion to `docs/mesh-instancing-design-2026-10-05.md` (section 13 has F1 as built).

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

**P1. Do not rebuild shader text on a values-only frame.** About 5 of the 8 ms of compile at thirteen geometries with shadows, and about 0.4 of the 0.57 ms each added Geometry costs.
- First step, small and local: remember generated modules by what they are generated from. `cubeShadowVariant` by its input string; the depth and surface generators by their options; a kernel's module by its source and schema. Each is a pure function, and the reflection memo in `params-reflection.ts` is the pattern.
- The verifier then compares the same string object and can stop at identity.
- A larger step, not proposed yet: a compile mode in which a node returns values without text.

**P2. One render pass per target, not per draw.** The hinged document with shadows has 200 passes over about twenty targets.
- On the CPU it is the 0.47 ms of encode and submit per added Geometry: about 0.03 ms a pass.
- On the GPU it is most of the 0.33 ms per added Geometry, and all of what an indirect draw costs (below), because each pass loads and stores its target on a tile-based GPU.
- It is a change in the backend's `encode` only: consecutive draws into one target that do not clear share one pass. The plan and the nodes are unchanged. The per-pass GPU timer then measures a group of draws, so a node's GPU row becomes its share of a pass; that is the cost of it and needs deciding.

**P3. F2 (several shapes on one Geometry), or batching the resolve passes: not the lever.** An added Geometry's two dispatches are about a tenth of its CPU cost and none of its GPU cost. F2 would remove sixteen dispatches from the hinged document and none of its 120 added draws. With P2 in place F2 becomes worth more, because then a shape is a draw in a pass that exists.

**The order this suggests**: P1's first step, then P2, then measure again before F2.

## Found on the way

- **An indirect draw was not a draw of its frame.** A geometry over a counted pointset draws indirect. The backend gave that draw its own command buffer, which cleared the target and was submitted at once: headless it erased the backdrop and every geometry before it, and in the app it ran ahead of the frame's passes and was erased by them. Fixed (`indirect-draw-order.gpu.test.ts`); F1 needed it.
- **An indirect draw is not free.** On this machine a render pass holding one indirect draw costs about 0.05 ms of GPU more than the same draw with a literal count, and about 0.12 ms when the device lacks `indirect-first-instance` (Dawn then validates the arguments in a compute pass ahead of each such render pass). Measured on the hinged document with all 150 mesh-instance draws indirect: 11.1 ms of GPU with literal draws, 18.5 ms indirect with the feature, 29 ms without it. The per-pass spans do not show it; the frame's extent and the wall time do. F1 therefore compacts only a geometry that can leave an instance out, and the device now asks for the feature.
