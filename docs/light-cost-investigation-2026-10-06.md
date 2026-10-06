# Why the Render's cost grew faster than its light count (B260)

2026-10-06. An investigation, a stopgap that is built, and a design that is not. The stopgap landed as `97b7d630` (on the worker branch `1e5b81ab`). The design in section 11 is for review before anyone builds it.

Machine for every figure here: Apple M3 Max, Dawn on Metal, headless Node, macOS 26.3.1. It was shared with three other sessions doing GPU work, which is why section 2 exists. A figure is **measured** unless it says computed. A figure taken once says so.

## 0. The answer

**The cause.** The lit fragment function adds every light's terms into one variable, `lit`, in one straight chain through N unrolled blocks. Apple's Metal compiler runs with fast math. It takes all 2N terms out of their blocks, sums them in two chains at the end of the function, and so moves every light's lobe below every light's kind and range branch. The values a fragment holds live at once then grow with the light count: 39 + 12 for every light, read off the compiler's own output. Past the GPU's registers the cost per fragment jumps and then keeps growing faster than the count.

**The size of it.** One floor, PBR, point lights without shadows, 1280 × 720:

| Lights | 1 | 8 | 16 | 20 | 24 | 32 | 48 | 64 |
|---|---|---|---|---|---|---|---|---|
| Main's text, ms | 0.05 | 0.13 | 0.33 | 0.39 | 1.51 | 2.88 | 8.52 | 18.7 |
| Each block under a test of its own intensity | | 0.17 | | | 0.46 | 0.62 | | 1.31 |
| One loop over the same rows | | | | | | | | 1.11 |

Linear at 0.018 ms a light to 20 lights, then 3.8 times more for four more lights, then 18.7 ms where a straight line gives 1.2.

**On the consumer's document** (sentinel-bot live tier, one robot, 1280 × 720, 4× MSAA, no casting light, alternated in one process): 37 lights are 18.35 and 18.35 ms of GPU with main's text, 8.45 and 8.72 ms with the guard. Wall 28.8 and 27.9 ms against 18.2 and 18.4. With the guard the document pays about 0.075 ms a light, flat. Its cliff with main's text starts near 21 lights.

**What is built.** Above 8 lights each light's block does its work under `if (lightMeta.y != 0.0)`. At 8 or fewer the text is main's, byte for byte. Two gates hold it: one on the text (the cause), one on a 32-light picture (the values).

**What is not built.** The cure is that a light is data and the lit text holds no light at all. Section 11.

**Two things that were not the engine.** Yesterday's curve was bent by the GPU's clock, which follows recent load (section 2). And yesterday's compile figures compared a warm cache with a cold one (section 7).

## 1. Reproduction on a minimal scene

Through the real compiler and backend: one `pointGrid` of 16 × 16 points laid flat by a `pointKernel`, one `geometry` in Surface mode with a PBR material, a camera looking down so the floor covers every pixel (checked from the picture: 100%), N `light` nodes (Point, Inverse Square, Range 30, Cast Shadows off), one `render`, one `output`. 1280 × 720, no MSAA, one device render pass per draw (`setExactPassTiming`), so the lit draw has a span of its own. Medians of 30 frames after 12, a reference pass beside every frame (section 2). The timer's step is 0.066 ms.

| Lights | Lit draw, ms | Per added light since the row above, ms |
|---|---|---|
| 1 | 0.050 | |
| 2 | 0.056 | 0.006 |
| 4 | 0.066 | 0.005 |
| 8 | 0.131 | 0.016 |
| 12 | 0.239 | 0.027 |
| 16 | 0.328 | 0.022 |
| 20 | 0.393 | 0.016 |
| 24 | 1.507 | 0.279 |
| 28 | 1.901 | 0.099 |
| 32 | 2.884 | 0.246 |
| 40 | 5.898 | 0.377 |
| 48 | 8.520 | 0.328 |
| 64 | 18.74 | 0.639 |

Spread: from 28 lights up, the ratio of the lit draw to the reference stayed within 5% of its median between its 10th and 90th percentile (64 lights: 6.90 to 7.20 around 6.98). Below that the spread is one timer step, which is a tenth to a half of the figure itself. The first row run again last gave the same figure, and so did 24 lights (1.507 and 1.573).

**The smallest scene that shows it is the first one tried.** No mesh, no instances, no MSAA and no overdraw are needed. Section 3 has what each of them does to it.

**It is per fragment.** At 64 lights: 2.10, 5.24 and 19.07 ms at 320, 640 and 1280 pixels wide (one run, taken before the reference existed, so the smallest is a little high). The pixel counts are 1 : 4 : 16.

## 2. The measurement trap

**The rule for every later profile in this project: a fixed reference pass timed beside every frame, variants alternated in one process, and raw milliseconds never compared across runs.**

What was found, each measured:

1. **The GPU's clock follows its recent load.** The same 16-light draw took 1.245 ms on an idle GPU and 0.328 ms straight after a 64-light variant: 3.8 times. A fixed compute pass took 1.245 ms beside light variants and 0.524 ms beside heavy ones. A variant is therefore faster the more work its neighbours do, and a curve of cost against load taken in raw milliseconds is bent: light loads read slow, heavy loads read fast.
2. **Paced like the app, the clock cycles.** At a frame every 16.6 ms with the GPU idle between frames, raw frame time ran a sawtooth about nine frames long: 2.3 to 7.1 ms for one unchanged frame with two casting point lights, 1.2 to 4.7 ms with one. The reference ran the same sawtooth (0.4 to 1.1 or 1.3 ms). Kept busy, a frame of the same kind was steady (largest over smallest 1.27).
3. **Other sessions' GPU work stretches a render pass more than a compute pass.** In one disturbed run the 64-light draw read anything from 19 to 44 ms, and the reference 2.9 to 4.6 ms where it is 2.7 on a quiet machine. A disturbed run shows in the reference's own figure. Its ratios are still usable, and wide.
4. **A lone render pass that clears and draws, straight after a compute pass, reads erratically**: 0.07 or 0.85 ms for one and the same draw, with the reference steady. Encoded as the backend encodes a frame (a pass that clears, then the draw in a pass that loads) the same draw read 0.066 ms on every frame.
5. **Metal keeps compiled shaders on disk between processes.** A text compiled in any earlier run is "warm": a few milliseconds. Section 7.
6. **A salt must survive two compilers.** To make a text new to that cache a literal was added. `1.0 + SALT * 0.0` is folded away by Tint. A salt that differs in its eleventh digit is the same `f32`. What worked: `1.0 + params.eye.w * 0.4273`, four digits, a different one each round.

**The reference pass**, as used for every figure here. It is 30 lines and lives in the scratch scripts (section 12); it should become a tool under the test harness.

```wgsl
@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = f32(id.x) * 0.001;
  for (var i = 0u; i < 3000u; i++) { x = fract(sin(x * 12.9898 + f32(i)) * 43758.5453); }
  data[id.x] = x;
}
```

- 262,144 cells, 4,096 workgroups, its own timestamp pair. About 2.69 ms on this GPU at full clock.
- Submitted just ahead of every frame. It measures the clock, and at 3,000 iterations it also keeps the GPU busy, which holds the clock up.
- The figure reported is the frame-by-frame ratio of the measured span to the reference's, its median and its 10th and 90th percentiles. "At full clock" is that ratio times the fastest reference seen in the run.
- A run whose reference is well off its usual figure was disturbed, and says so.

**Earlier figures in this repository taken without it.** They are listed, not edited. Each is a raw GPU time, and each comparison between variants of different load crosses clock states.

- `docs/lights-from-pointset-design-2026-10-06.md`
  - Section 0: "today's unrolled blocks take a quarter less time than a loop over records (1.38 against 1.84 ms at 64)", and the consumer's 6.75, 10.75 and 24.05 ms with compile 0.16 to 1.23 s.
  - Section 2.1: the table of 5, 13, 21 and 37 lights (6.75, 7.54, 10.75, 24.05 ms; compile 157, 803, 906, 1,227 ms). The compile column is warm against cold (section 7 here).
  - Section 2.2: the whole probe table, "one light alone drew in 0.07 to 0.21 ms" (trap 4 above is the likely reason for that spread), and the paragraph "with every light reaching every pixel".
  - Section 2.5: the reason given for keeping a Single light's unrolled block (1.38 against 1.84 and 2.23 ms).
  - Sections 5.1, 5.2 and 5.3. The 5.3 estimate is computed from the smallest measured slope.
  - Section 9, rows 2 and 3 (0.72 against 0.26 ms; 1.38 against 1.84; 0.52 against 0.85).
  - Section 12, the last bullet of each list.
  - The probe's unrolled blocks call a function that returns one term, so they hold fewer values live per light than the engine's block and their cliff sits later (between 64 and 256 lights there, between 20 and 24 here). That its 64-light figure beat the loop is true of that shader below its own cliff at best, and it is not true of the Render's text at any count above 20.
- `docs/geometry-cost-profile-2026-10-05.md`
  - "Numbers": the GPU column (5.8, 5.9, 8.5, 11.1 ms) and the per-Geometry GPU figures (+0.02, +0.33 ms).
  - "Found on the way": 0.05 and 0.12 ms for an indirect draw; 11.1, 18.5 and 29 ms.
  - "P2 as built": every GPU and wall figure in the table of encodings; "where the live frame goes" (13.9, 7.0, 3.9 ms); one casting light (1.54, 1.39 ms); "each light on its own"; the header GPU readings in the app.
  - The two encodings were alternated in one process, which is half the rule. The differences between variants of very different load (shadows on against off) are the ones to retake.
  - Its "9.6 or 35 ms" row is two modes 3.6 times apart, which is the clock's own ratio.

## 3. One factor at a time

Each row is one change at 64 lights on the floor of section 1, where main's text is 18.7 ms. The changes were made to the lit shader's text on its way into the device (a wrapper round `createShaderModule` in the scratch harness), so nothing else in the frame differs. A patch that changes the uniform struct keeps its byte layout, because the backend still writes the block from the text the generator emitted.

| Change | Lit draw, ms | Reads as |
|---|---|---|
| none: main's text | 18.87, 18.81 | |
| the same 10 floats per light read, one trivial line of code per light | 0.19 | **not** the uniform block's size, nor the count of members |
| the same code per light, every block reading light 0's rows | 8.32 | the code alone carries it |
| named members replaced by an array of rows, still unrolled (at 32 lights: 2.88 against 3.29 and 3.35, a disturbed run) | no change | not how the uniforms are declared |
| no branch on `kind` and none on range: straight-line blocks | 13.96 | **not** the branches |
| each block a call of one function | 10.62 | **not** inlining: the compiler inlines it again |
| each `lit +=` through a `max(…, 0)` | 5.83, 5.70 | the chain of additions is part of it |
| a light's two terms summed in its block and added once under `if (lightMeta.y != 0.0)` | 1.31 | **the chain across lights is the cause** |
| each block's whole work under that test | 1.31, 1.31 | the same, and the form that was built |
| one loop over the rows, count known to the compiler | 1.09, 1.11 | |
| one loop, count read from a uniform | 1.25, 1.25 | |

At 32 lights, main's text against the stopgap, one more thing varied per row. This run was disturbed (the reference read 4.5 to 7.0 ms where it is 2.7 when the machine is quiet), so only the ratios to the reference are given, and the last column is what matters.

| Scene, 32 lights | Main's text ÷ reference | Stopgap ÷ reference | Main ÷ stopgap |
|---|---|---|---|
| the floor | 1.04 | 0.28 | 3.7 |
| 4× MSAA | 1.06 | 0.27 | 3.9 |
| 4× MSAA, three floors drawn far to near | 6.72 | 1.43 | 4.7 |
| a floor of 293,000 triangles | 2.35 | 0.52 | 4.5 |
| 576 primitive boxes (the other generator) | 1.17 | 0.30 | 3.9 |
| Phong instead of PBR | 0.43 | 0.21 | 2.0 |
| directional lights | 1.02 | 0.21 | 5.0 |
| point lights with no Range | 1.09 | 0.27 | 4.1 |

- **Fragments shaded multiply it and do not make it.** MSAA alone costs the lit draw nothing: a covered pixel is shaded once. Three layers under MSAA are each their own pass and are each shaded, six times the cost for three times the area. Small triangles cost about twice. In every case main's text is four to five times the stopgap's.
- **Lit draws.** Each lit draw with its own options has its own text and its own pipeline, and each carries all N blocks. The consumer's document has five distinct lit texts for 16 draws. The draw count multiplies fragments, not the per-fragment cost.
- **CPU.** One buffer write of 20 bytes a frame on the floor at every light count; `backend.render` 0.40 to 0.58 ms from 1 to 32 lights. The lights' rows are in the pass's uniform block and are written when values change. Not a factor.
- **The timing method.** Section 2. Every figure here is one device pass per draw, so the lit draw has its own span. What a pass of its own adds to a draw was not measured with a reference: the one pair taken (0.59 ms alone against 0.13 to 0.20 ms grouped with the backdrop, 8 lights) was taken before the reference existed and at two clock states, and is exactly the kind of pair section 2 says not to read.
- **Not varied on the floor**: a file mesh, mesh instances (both are in the consumer's pair), Lambert alone, SSAA.

## 4. The generated text at 4 and 32 lights

Dumped from the plan's lit pass (the scratch folder holds them).

| | 1 light | 4 lights | 32 lights |
|---|---|---|---|
| Characters | 5,520 | 11,373 | 66,133 |
| Uniform block | 336 bytes, 12 members | 480 bytes, 21 members | 1,824 bytes, 105 members |

- **Per light**: 1,951 characters of block and three `vec4f` members (`light{i}Meta`, `light{i}Color`, `light{i}Vector`), 48 bytes. A casting light adds its shadow lookup (about 2,200 characters for a point light with nine taps), one texture binding, and 64 or 400 bytes of matrices.
- **Per light squared**: nothing. No block holds a loop or a switch over the other lights or over slots. A casting point light switches over its own six faces.
- **Shared by every block and written N times**: the read of `params.specular` and `params.material`, and `alpha`, `NoV` and their products, which do not depend on the light. The compiler folds them into one.
- So the text is linear and honest. What is wrong with it is not in the text: it is what a compiler is allowed to do with a sum written as one chain.

## 5. What Apple's compiler does with it

Dawn was run with its `dump_shaders` toggle (`VGPU_DAWN_FLAGS="enable-dawn-features=dump_shaders"`), which prints the Metal source Tint makes of each WGSL module. That source is a plain transliteration: one `float3 v_10` for `lit`, each block in order, each `lit +=` in place, under `#pragma METAL fp math_mode(relaxed)`. Nothing in Tint's output is per light squared either.

The Metal source was then compiled with Apple's own front end, `xcrun -sdk macosx metal -S -emit-llvm`, which is the first half of what the driver does at pipeline creation. In its output for 24 lights:

- every arithmetic instruction carries `reassoc`;
- the function ends with two chains of 24 additions each: the 24 diffuse terms, summed and then multiplied once by the factor they shared (`albedo × (1 − metallic)`), and the 24 specular terms;
- the last basic block holds the lobes of several lights at once, and reads values defined hundreds of lines earlier: each light's `toLight` and `attenuation` (the merges of its kind branch) and its loaded colour;
- so the program is no longer N blocks. It is every light's branches, then every light's lobe, then the sums.

A count of the float components live at once, from that output read in the order it is written (the driver's backend may order it differently, so this is an estimate of what its register allocator faces and not that allocator's own figure):

| Lights | 4 | 8 | 12 | 16 | 20 | 24 | 32 | 64 |
|---|---|---|---|---|---|---|---|---|
| Main's text | 87 | 135 | 183 | 231 | 279 | 327 | 423 | 807 |
| The stopgap's text | | | 47 | 47 | | 47 | 47 | 47 |
| One loop | | | | | | | 43 | 43 |

Main's text is exactly 39 + 12 × lights. The guarded text is 47 at every count.

**What is proven and what is not.** That the compiler rearranges the sum and that live values grow by twelve a light is read from its output. That ending the chain at every light removes the growth is measured (sections 3 and 6). That the cliff itself is the fragment program running out of registers in the driver's backend is a **hypothesis**: the machine code is not visible. It fits a jump at a count rather than a slope, and it fits the cliff coming earlier for blocks that hold more live (section 8). Reverse-engineering notes on this GPU family give it 128 registers of 32 bits; the estimate crosses that near 8 lights and the cliff is at 20 to 24, so the estimate and the allocator do not count alike.

**Why the test of intensity works.** `lit` after the block is one of two values: what it was, or what it was plus this light. The compiler cannot move an addition across that merge. It also sinks the lobe into the branch, since nothing outside uses it, so the branch is not flattened into a select. Apple's output for the guarded text has two more basic blocks a light and no chain.

## 6. The proof

**On the floor**, a pair per count, the same process, reference beside every frame:

| Lights | Main's text | Guarded | Loop |
|---|---|---|---|
| 1 | 0.061 | 0.000 to 0.066 (one step); picture byte-identical | |
| 8 | 0.131 | 0.172 | |
| 24 | 1.500 | 0.459 | |
| 32 | 2.818 | 0.616 | |
| 64 | 18.87, 18.68 | 1.311, 1.312 | 1.114 |

**On the consumer's document**, built in the scratch script from `sentinelDocument` (the project's files were not edited), live tier, one robot, 1280 × 720, 4× MSAA, every Cast Shadows off, extra Light nodes as yesterday's script added them. Medians of 60 frames after 30. The guard here was the device-boundary patch, which is the two lines the generator now emits; the pair was not run again on the committed generator.

| Lights | Main's text, GPU ms | Guarded, GPU ms | Wall, ms |
|---|---|---|---|
| 5 | 5.90, 6.36 | 6.10 | 16.7, 16.9 against 17.3 |
| 13 | 6.42 | 6.49 | 18.7 against 17.8 |
| 21 | 7.73 | 6.82 | 18.0 against 16.1 |
| 37 | 18.35, 18.35 | 8.45, 8.72 | 28.8, 27.9 against 18.2, 18.4 |

- The 37-light pair was alternated: main, guard, main, guard. Normalised to the reference at its fastest: 17.6 and 16.6 against 8.5 and 8.2 ms. With main's text 11 and 13 of 60 renders were over 20 ms; with the guard none.
- The 5, 13 and 21 rows are one run each, in a second process.
- 37 lights with the guard cost 2.5 ms more than 5 lights: 0.075 ms a light at 4× MSAA over this document's overdraw. Yesterday's figure for the same step was 17.3 ms.

## 7. Compile time

**Which calls.** Shader module creation is Tint parsing and checking the text: 3 to 16 ms for the floor's five modules from 4 to 64 lights, linear in characters. Render pipeline creation is where the Metal compile happens, and it is the cost.

**Cold, three rounds, each with a text the cache on disk had never seen** (floor, the three render pipelines of the frame, of which the lit one is the only one that changes):

| Lights | Main's text, ms | Stopgap, ms | Loop, count from a uniform, ms |
|---|---|---|---|
| 8 | 56, 54, 54 | the same text | |
| 16 | 84, 87, 87 | 88, 87, 89 | 37, 36, 36 |
| 32 | 183, 191, 194 | 145, 151, 151 | 34, 36, 36 |
| 64 | 451, 465, 469 | 274, 277, 284 | 36, 36, 36 |

- Main's text grows faster than its length: 4, 6.5 and 8.5 ms a light over the three steps. The guarded text is about 4 ms a light. The loop does not grow.
- **Warm** (the same text again, another process): 2 to 14 ms for the three pipelines, 17 to 57 ms for all of `backend.compile`.

**The consumer's document**, three rounds, lit texts salted, then the same salt again for warm:

| Lights | `backend.compile` cold, main's text | of it the five lit pipelines | cold, stopgap | warm |
|---|---|---|---|---|
| 5 | 510, 509, 504 | 332, 332, 331 | the same text | 189, 195, 191 |
| 13 | 567, 555, 556 | 402, 389, 388 | 578, 566, 547 | 181, 183, 174 |
| 21 | 752, 722, 728 | 578, 556, 556 | 684, 680, 671 | 193, 196, 187 |
| 37 | 1,027, 1,012, 1,028 | 824, 825, 827 | 910, 902, 894 | 243, 234, 228 |

- **Objects.** 36 shader modules, 27 render pipelines and 9 compute pipelines at every light count. The count of lights changes the size of five texts and the number of nothing.
- **Distinct lit texts: five**, one per geometry with its own material and attributes, for 16 draws. None is compiled twice.
- **One text is created twice**, and it is not a lit one: `geometry_hull:instances:resolve`, 3,646 characters. It costs a module creation, not a Metal compile.
- **The memo.** `generatedOnce` is hit: a plan with a new light count runs one generator per lit text and reuses the rest (on the floor: 1 run, 2 reused). A values-only frame runs none, as its gate holds.
- **Why "5 to 13 lights cost 650 ms" yesterday.** The 5-light document had been compiled before and was warm (157 ms then; 189 to 195 ms warm here). The 13-light one was new and cold. Like for like and cold, 5 lights are 508 ms and 13 are 559: 51 ms for eight lights. The first cold compile of a process also paid about 300 ms once (seen here as 343 ms on nine compute pipelines that are 12 ms otherwise), which is the rest of yesterday's 803.

## 8. The stopgap as built

**The rule.** In `lightBlock` of both generators (`buildSceneSurfaceModule` and `buildSceneInstancesWgsl` in `src/nodes/shaders/scene-render.wgsl.ts`), when the Render lists more than `LIGHT_GUARD_ABOVE` = 8 lights, a block's work after its three uniform reads sits under `if (lightMeta.y != 0.0) { … }`. `lightMeta.y` is the Light's Intensity. At 8 or fewer nothing is emitted and the text is main's.

**Where the cliff sits**, floor at 1280 × 720, main's text against the guard. "Over" is main's text costing more than the guard by more than one timer step.

| Case | Equal at | Over at |
|---|---|---|
| stock PBR, no shadow | 20 (0.39 and 0.39) | 24 (1.51 against 0.46) |
| Material · WGSL (default source, PBR) | 16 (0.32, 0.31) | 20 (1.05 against 0.39) |
| one casting point light of nine taps among them | 16 (0.33, 0.33) | 20 (0.92 against 0.39) |
| one casting point light and Material · WGSL | 12 (0.26, 0.26) | a step apart at 16 (0.39 against 0.33); 20 not run |
| the consumer's document (meshes, mesh instances, Material · WGSL, 4× MSAA) | 13 | 21 (7.73 against 6.82) |

- **Not measured**: a file mesh with surface rows on the floor, several casting lights among many, a projector with a cookie or with occlusion, an environment in the same shader.
- **Why 8.** The heaviest case measured is already a step apart at 16, heavier combinations are unmeasured, and the guard costs nothing that could be resolved at 8, 12 or 16 lights. So the margin goes to the side that cannot hurt. The gate refuses a threshold above 12 until the table is measured again.

**What it changes besides speed.**

- A light of intensity 0 adds `0 × lobe` without the guard. That is zero wherever the lobe is finite, so the sum is the same sum.
- Where the lobe is NaN or infinite the unguarded block adds NaN for a light that is switched off, and the guarded block adds nothing. Derived from the text, not rendered: with Inverse Square and a light exactly at the fragment, `distance` is held at 1e-4, `toLight` is the zero vector, the attenuation is 1e4 and the diffuse term is 0, all finite; the halfway vector is then the view vector and `1 − VoH` can round below zero, where `pow(x, 5.0)` is not defined. The same happens where `toLight + viewDir` has no length. A light that is on runs the same code either way and shows the same NaN.
- A NaN intensity is "not zero" and still shows. The parameter's floor is 0, so no intensity is negative.
- The last bit of a sum can move on Metal, because the compiler no longer rearranges it. On the floor the picture is byte-identical at 1 light and differs in its hash from 8 lights up. The 32-light Dawn test agrees with the formula to 1/1024 with both texts.

**Projectors.** A Projector adds into the same `lit`. Its addition sits under two tests of the fragment's own place: in front of the lens, and inside the frustum. So `lit` is a merge after every projector and the chain ends there.

| 8 lights and | 0 | 8 | 16 | 24 projectors |
|---|---|---|---|---|
| lights unguarded, ms | 0.131 | 0.262 | 0.328 | 0.459 |
| lights guarded, ms | | 0.239 | 0.328 | 0.448 |

About 0.014 ms a projector, flat, and guarding the lights changes nothing. The threshold therefore counts lights. Projectors without a cookie and without occlusion; the other kinds were not measured. A first run of this table was disturbed and is not used.

**Shipped Renders.** 112 documents walked (`examples/*.loom.json`, `examples/components`, `projects/**/*.loom.json`), 63 Render nodes at any depth:

| Lights | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Renders | 19 | 13 | 8 | 7 | 2 | 2 | 1 | 6 | 1 | 3 | 1 |

- Four are over 8, all in `projects/on-nothing`: `title` (13), `incar`, `mcu2` and `sneaker` (9). Their lit text changes; their files do not.
- No example or component is over 7.
- Nothing freezes those four: no file under `src/` names them, the project's four test files read no document and no GPU, and `FRAME_ZERO_DIGESTS` hashes Point Kernel passes of `examples/` only.
- **The title pair.** The project's own `render.ts`, the title shot, 1280 × 544, one frame at t = 0, main's generator bytes against the stopgap: 1 of 696,320 pixels differs, by 1 of 255. A second render with the stopgap was identical to the first, so that pixel is the change.

**The gates.**

- `src/nodes/definitions/scene-light-guard.test.ts`
  - **The cause.** In no lit fragment function of either generator do more than 8 sources add into `lit` in one straight-line scope. A source is a light or a projector. A source whose additions sit under a branch on a value the compiler cannot know ends the run. Derived from the generators' output for 18 feature cases, with and without casting lights, at 1, 8, 9, 32 and 64 lights. Seen red with the guard off (108 modules), and with a projector written without its two tests.
  - **Byte identity.** No guard at 0, 1, 2, 5 and 8 lights, and each case's texts have the digest main's generator gave: the digests were read by putting main's file back and running the test. Seen red with the guard emitted from 5 lights.
  - The threshold may not pass 12.
- `src/nodes/definitions/scene-light-guard.gpu.test.ts`, Dawn. A 32-light picture equals ambient plus every light's term computed on the CPU, at 16 pixels of a grid surface and of a primitive instance; the lights are directional, soft, Inverse Square with a Range that leaves some pixels outside it, and intensity 0. Seen red with a guard that skips a faint light that is on.

## 9. B251

B251: GPU time flipping between about 6 and 39 ms with two cube-shadow atlases, steady with one. Tested against both findings on a small scene: two casting point lights over a dense floor (522,000 triangles unpaced, 293,000 paced), 1280 × 720.

- **Is it this cliff? No.** Two casting point lights' blocks do not cross it: 2.62 ms with main's text and 2.62 with each block guarded (unpaced, one pass per draw), and the same distribution paced. In the prototype of section 11.3 one, two, four and eight casting point lights cost the same guarded and unguarded.
- **Is it the clock? It makes this kind of reading, and B251's own shape was not reproduced.** Trap 2 of section 2 is the measurement: paced at 60 frames a second, raw frame time swings about threefold in a sawtooth, and the reference swings with it. But it does so with one casting light as much as with two, and B251 says one is steady. And B251's swing is 6.5 times, more than the 3.7 seen here. The headless figure quoted with B251 in the geometry profile (9.6 or 35 ms, 3.6 times) does match the clock's ratio.
- **So**: not the cliff. A reference pass in the app is the first thing to put beside B251's reading. Its larger swing and its difference between one light and two are not explained by anything measured here.

## 10. Ruled out, and not checked

**Ruled out, each by a measurement named above**: the uniform block's size and member count; the branch on `kind`; the range branch; the shadow code a non-casting light carries (it carries none); inlining; the form of the uniform declaration; a quadratic term in the text; MSAA; overdraw; triangle size; the number of lit draws; CPU-side uniform writes; one pass per draw as the cause of the curve's shape.

**Not checked**

- Any GPU but this one, any backend but Metal, and a browser. The stopgap's branch is harmless elsewhere; whether another compiler rearranges the sum the same way is unknown.
- The driver's machine code. The register explanation of the cliff is a hypothesis.
- The consumer's pair on the committed generator (it was taken with the device-boundary patch of the same two lines).
- A Render with more than 8 lights of which many cast. The casting prototype's largest case is 32 lights with 8 casting.
- Projectors with a cookie or occlusion.
- Whether the clock explains B251 in the app.

## 11. The cure: one light path

The design, with its casting-lights prototype, follows in the next commit of this document.

## 12. The scripts

Scratch, not in the repository: `scratchpad/b260/` of the worker's tree, copied to the session's scratchpad when this was written.

| File | What it is |
|---|---|
| `minimal.ts` | the floor through the compiler and the backend; variants by `key=value`; **the reference pass** (`makeReference`); text patches at the device boundary; the picture's hash and coverage; pacing; per-frame distributions |
| `patches.ts` | the one-factor text patches of section 3, and `guard`, `unguard`, `loop` |
| `consumer.ts` | yesterday's consumer script with the reference, the patches, a salt and the compile counters |
| `cold-compile.sh`, `cold-consumer.sh`, `cold-consumer-main.sh` | the cold and warm compile rounds of section 7 |
| `split-msl.py`, `to-ir.sh`, `live-values.py`, `live-values.sh` | Dawn's Metal source to Apple's IR to the live-value estimate of section 5 |
| `count-lights.mjs` | the lights of every shipped Render |
| `png-diff.mjs` | the title pair |
| `casting-array.ts` | the casting-lights prototype of section 11.3 |
| `wgsl/`, `msl/` | the dumped texts |
