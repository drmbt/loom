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

**Status: a design for review. Nothing in this section is built.** The stopgap of section 8 is a branch in a block that should not exist. The owner's standard for the cure is a fix of the whole and not a shader trick: so the cure is that a light is data, in one place, read one way.

### 11.1 The property

**The lit shader's text is the same for any number of lights of any kind.** Adding a Light, removing one, switching one on or off, turning Cast Shadows on, changing a Light's Type or re-ordering the list creates no shader module and no pipeline. It is a write to a buffer and, for a casting light, the use of one more layer of a texture that exists.

It can be gated as it is stated (11.7).

### 11.2 Every light is a row

- **One table per Render**: the light table T1589b's first slice builds (records, a grid of cells, one storage binding on a lit draw, one loop in the lit shader). A point of a pointset Light is a row. **A named Light is a set of one row.** A Projector is a row (11.5).
- **The lit text holds no light.** No `light{i}` uniform member, no block per light, no `shadowMap{i}` binding. The lit pass's own uniform block is the camera, the material and the surface, and its size no longer depends on the Render's lists.
- **The record.** T1589b's 64 bytes are `place` (xyz, range), `color` (rgb × intensity, falloff law), `aim` (xyz, cosine of the outer half-angle) and `cone` (cosine of the inner, three floats free). The free three carry what a named light needs: its **kind**, its **shadow slot** (0 for none), and its **source number** (which Light it came from, for Lit Only and Lit Exclude). Still 64 bytes.
- **Always-walked rows.** A directional light, and a point light with no Range, reach every pixel: a grid cannot leave them out. They are the first G rows of the table and are walked by a plain loop whose count is a value. Rows with a Range go through the grid, named or not.
- **A count the compiler cannot know.** Both loops take their bounds from the table, never from the text. Measured on the floor at 64 lights: a loop with its count in the text 1.11 ms, with its count read from a uniform 1.25 ms, main's blocks 18.7 ms; pipeline creation cold 36 ms at 16, 32 and 64 lights against 86, 189 and 462 ms. A count in the text is also a text per count, which the property forbids, and it invites the compiler to unroll: at 32 lights a loop with a literal count once read 1.84 ms in a disturbed run and was not followed up.
- **Where a named Light's row comes from.** A pointset Light's rows are written on the GPU by its resolve pass. A named Light's values are known on the CPU, as its uniforms are today. They must reach the table without a shader of their own whose text counts lights. **This needs one new seam in the backend: values for a region of a buffer**, carried by the plan and written by `queue.writeBuffer` at compile and on every values-only frame, as a uniform block's values are. The uniform animator pushes them as it pushes uniforms. Without that seam a named row needs a dispatch that copies from a uniform array, and that array's length is in a text again.
- **What stays a compile-time fact**: the table's capacity (T1589b's 1,024, refused by name beyond it) now counts named Lights too.

### 11.3 Casting lights

Today a casting light is a block with its own texture binding, because a shader cannot index its bindings. The form that can be indexed:

- **Two layered targets per Render, each one binding.** `texture_2d_array<f32>`, `r32float`, read with `textureLoad(maps, texel, layer, 0)`.
  - One for directional maps, a layer a light, at today's size (2 × the output).
  - One for point lights, a layer a light, each layer the 3 × 2 atlas of cube faces it is today (1.5 × the output, radial distance ÷ range).
- **No cube array, no depth texture, no comparison sampler.** The lookup stays what it is: a texel load and a compare written out, with the tap kernel the PCF gate pins. That is deliberate. `textureSampleCompare` may not be called in a loop whose trip count differs between pixels (it takes a derivative); `textureSampleCompareLevel` may, but it needs a depth format, a comparison sampler and hardware filtering in place of the exact kernel. `textureLoad` has no such rule and is what the Render uses for every texture it reads.
- **The baseline tier.** `texture_2d_array` and a layer index in `textureLoad` are WebGPU core; a device's floor is 256 layers. Two sampled textures replace N of the sixteen a lit draw may bind, which is today's hard cap on casting lights and goes.
- **The backend already has the resource.** A `ring` (T237, T321) is a texture with `depthOrArrayLayers`, a view per layer to render into and one `2d-array` view to bind. A layered shadow target is a ring that does not rotate, with a depth attachment shared by its layers (the sweeps run one after the other and each clears depth first).
- **The row carries its slot; the slot has a row of its own.** A second region of the table, one entry a slot: for a point light its place and range and the six face matrices its sweep drew with (400 bytes, as its uniforms are today); for a directional light its matrix (64 bytes); and the slot's softness class and extra bias. The lookup reads `shadowRows[slot]`. The six named matrices and the `switch` over them become one indexed read.
- **Shadow Softness is a class, not a loop bound.** Measured in the prototype below: with the tap count read from the row and used as the loops' bounds the lookup costs 1.7 times as much (the compiler can no longer unroll nine taps). With the row choosing between loops of constant bounds it costs nothing. So the text holds one kernel per softness value, 0 to 4, and the row picks. Shipped documents use 0, 1, 2 and 3, and one Render mixes two.
- **Shadow Bias** is a literal in the text today and becomes a float of the slot's row.
- **The sweeps do not change.** A depth sweep's shader holds no light. Its target becomes a layer. Caster lists and reach culling (T1598b) decide which draws a sweep has and which are skipped, exactly as now.
- **Render-pass runs (T1604b).** A run is consecutive draws of one node into one target; the target's identity gains its layer. A point light's six faces go into one layer's tiles and stay one run. Device passes: the same count as today.
- **Sizes.** Every directional map of a Render is one size today and every point atlas another, so a layer per light loses nothing. If a light is ever given a resolution of its own, it is a rectangle inside its layer and the slot's row carries it; the lookup already clamps its taps to a tile.
- **Allocation.** The arrays have as many layers as the Render has casting lights of that kind. Turning Cast Shadows on allocates a layer: a resource is rebuilt, no text changes. Grown in steps (1, 2, 4, 8) it is rebuilt rarely.
- **The shadow matte layer** (T1414b) reads slots 0 to 2 of the same arrays. Its text is fixed already.

**The prototype, measured.** `scratchpad/b260/casting-array.ts`. The lit text is the engine's own (`sceneSurfaceWgsl`, PBR grid surface, point lights, cube atlases, nine taps); its uniform block is filled at the offsets its struct declares; the array form is derived from that text by rewriting where the rows and the maps come from, so both forms read the same bytes. Their pictures agree to a half float's step at every count (identical at one light). Raw WebGPU, one floor, 2560 × 1440 so that the figures clear the timer's step (a quarter of each is the 1280 × 720 figure), no MSAA, reference beside every frame. The shadow maps hold synthetic distances: no sweep is drawn, since the sweeps are the same draws in both forms.

| Lights / casting | Blocks, a binding a light (main) | Blocks, each guarded | One loop, one array | Loop, taps as loop bounds | Loop, taps as a class | Lit text, characters: blocks / loop |
|---|---|---|---|---|---|---|
| 1 / 1 | 0.197, 0.197 | 0.197 | 0.197, 0.262 | 0.328 | 0.262 | 7,719 / 7,671 |
| 2 / 2 | 0.328, 0.393 | 0.328 | 0.448, 0.459 | 0.655 | 0.459 | 11,847 / 7,671 |
| 4 / 4 | 0.704, 0.721 | 0.721 | 0.786, 0.852 | 1.311 | 0.852 | 20,103 / 7,671 |
| 8 / 8 | 1.507, 1.573 | 1.442 | 1.573, 1.638 | 2.687 | 1.704 | 36,618 / 7,671 |
| 32 / 4 | 13.31 | 2.75 | 2.56 | 2.88 | | 74,863 / 7,672 |
| 32 / 8 | 15.47, 15.93 | 3.34 | 3.02, 3.19 | 3.80 | 3.18 | 83,574 / 7,672 |

Milliseconds at full clock; two figures are two runs, the second with some disturbance. The timer's step is 0.066 ms.

- **Casting lights as rows cost what they cost as blocks**, within one timer step at 1, 4 and 8, and one to two steps more at 2 (a pair repeated three times: 0.39 against 0.46 each time). About a twentieth more at eight.
- **With non-casting lights around them the loop is the fastest form**: 32 lights of which 8 cast are 3.0 to 3.2 ms as rows, 3.3 guarded, 15.5 to 15.9 as main has them.
- **One binding instead of N; a text that does not grow.** Pipeline creation cold: 119 to 174 ms for the loop at every count; 127 to 240 ms for the blocks up to 8 lights and 365 to 400 ms at 32. Each once.
- **Not measured**: directional casting lights in the loop (the same resource, a simpler lookup), a mix of both kinds, softness above 1, the sweeps into layers, MSAA, and the whole of it through the backend.

### 11.4 Lists

Lit Only and Lit Exclude (T1589b slice 3) were designed with two mechanisms: for a Single light, a generator option that leaves its block out of a draw; for a pointset Light, a source number in the record and a mask on the draw. With every light a row there is one: the record's source number against the draw's mask, a uniform of the draw, tested first in the loop. Editing a list stops being a recompile.

### 11.5 Projectors

A Projector is a light with a picture, and it adds into the same sum. Its block is as unrolled as a light's (one a projector, with its own cookie and depth bindings), and twelve shipped Renders list projectors, seven of them five.

- **A projector is a row**: its matrix, its place and brightness, its tint and falloff switch, its throw distance (112 bytes today), a cookie layer and an occlusion layer. It is walked by the same loop, with its frustum test first, as today.
- **Occlusion.** A projector's depth sweep already renders into a scratch target at 2 × the output, the size of a directional shadow map. It becomes a layer of that array. The lookup is the directional one with a divide by `w`, which a kind in the slot's row selects.
- **The cookie is the hard part, and the answer is a copy.** A cookie is any texture of any size wired to the node. It cannot be a layer of an array without being drawn into one. So the Render owns a cookie array of one size and each projector's cookie is copied into its layer when it changes: one small pass a live cookie a frame, none for a still one. The size is one constant of the Render (the largest cookie's, capped), stated on the row.
- **The alternative** is a bounded exception: projectors keep a binding each, up to a stated number, and the text grows with them. It breaks the property for a count the documents already use (five). Not recommended.
- **Not measured.** The cookie copy, and a projector walked in the loop.

### 11.6 What still changes the text, and why that is right

- **The material**: its model, a Material · WGSL's code, which maps are bound.
- **The surface**: grid, file mesh and its rows, mesh instances, primitive instances, points, beams; additive; which G-buffer layer.
- **The Render's features**: an environment and whether it is prefiltered; ambient occlusion.

Each of these is a different computation per fragment, chosen by a person editing structure, and each is one of a small fixed set. None of them is a count of things in a document. That is the line: **text may depend on which features exist, never on how many of something there are.**

Two smaller questions sit on that line and need a ruling:

| | Question | Recommendation |
|---|---|---|
| D1 | Does a Render with no casting light carry the shadow lookup and bind the two arrays (one layer each, unused)? | Yes. Otherwise the first Cast Shadows recompiles every lit shader, which the property forbids. The cost is two of sixteen texture bindings and one untaken branch a row. |
| D2 | Are all five softness kernels always in the text, or only the classes in use? | All five. Shadow Softness then stops being compile-time: it is a value of the slot's row. The prototype saw no cost in choosing between two. |
| D3 | The same for projectors: is the projector lookup always in the text? | Yes, by D1's reasoning, with a cookie array of one layer when there is none. |
| D4 | A named row's values: the new buffer-values seam (11.2), or a copy dispatch | The seam. A copy dispatch puts a count back in a text. |

### 11.7 What it does to every shipped Render, and how it lands

- **Every lit text changes**: 63 Renders, of which 44 list a light, 27 have a casting light (six at most, four point lights at most) and 12 a projector. With D1 a Render of no lights changes too.
- **Pictures.** The sum is taken in another order, so the last bit can move on Metal. Measured for the stopgap, which is the smaller change: byte-identical at one light on the floor; 1 pixel of 696,320 by 1 of 255 at 13 lights on a real shot. The loop's picture had the guard's hash at 64 lights on the floor.
- **Exact claims.** The Dawn tests assert exact values from one or two lights (`scene-render.gpu.test.ts`: a byte from `0.8 × (0.12 + 1)`). They are expected to hold and must be run, not assumed: every `*.gpu.test.ts` that renders a Render, and every example's claims test.
- **`FRAME_ZERO_DIGESTS`** hashes Point Kernel passes only. A Light's resolve pass and the Render's gather and grid passes are not kernel nodes. It does not move.
- **The stopgap's digests** (`TEXT_AT_AND_BELOW_THE_THRESHOLD`) are a promise that ends with the blocks. They are deleted with `LIGHT_GUARD_ABOVE`, in the slice that removes the last block.
- **The gates the design makes possible.**
  - **Text.** For every feature case of both generators, the lit module for 0, 1, 8 and 64 lights, for any mix of kinds, casting or not, and for 0 and 12 projectors is one string. And no lit module contains a numbered `light`, `shadow` or `projector` name.
  - **Device calls.** On the mock host, with the counter of `device-calls.test-support.ts`: adding a Light, removing one, turning Cast Shadows on, changing Type and re-ordering the list each create no shader module and no render pipeline.
  - **Values.** The stopgap's 32-light test carries over as it is: the picture is the formula's sum.
  - **Culling is invisible** is T1589b's own test and now covers named Lights.

**Slices, each landing green.**

1. **T1589b slice 1 as designed**: pointset lights in the table, the grid, the loop in the surface generator. Named Lights are still blocks, with the stopgap. A Render with no pointset Light keeps its text.
2. **The buffer-values seam** in the backend, with its own tests, used by nothing yet.
3. **Named Lights that do not cast are rows.** Always-walked rows and ranged rows; `kind` a field. Their blocks go. Casting Lights are still blocks, and the stopgap stays for them. This is the slice that changes every shipped Render's text for the first time: pictures compared across all of them, exact claims re-run, the text gate arrives for non-casting counts.
4. **Layered shadow targets.** The sweeps draw into layers; the remaining casting blocks read `maps` at a literal layer. No picture moves: byte identity on every casting example is the gate.
5. **Casting Lights are rows.** The lookup moves into the loop, softness and bias become values (D2). The last block goes, and with it `LIGHT_GUARD_ABOVE`, its gate's cause half and its digests. The text gate covers every kind; the device-call gate arrives.
6. **Projectors are rows**, with the cookie array.
7. **The other generator** (primitive instances, points, beams), which T1589b has as its slice 4: the loop is one exported string in both.

Slices 3 and 4 are independent. Each of 3, 5, 6 and 7 moves lit text, and each is one landing with one comparison of every shipped Render's picture.

### 11.8 What it changes in T1589b

- **Section 2.5 goes.** "A Light in Single mode is what it is today: its uniforms, its unrolled block" was held up by one measurement: the blocks 1.38 ms against the loop 1.84 ms at 64 lights that reach every pixel. That was a probe whose blocks hold fewer values live than the Render's, below its own cliff, without a reference. On the Render's text the blocks are 18.7 ms at 64 lights and a loop is 1.1 to 1.25. There is no count at which the blocks are worth keeping beside the loop.
- **L5 is reversed** (a Single light keeps its block in a Render with a grid). **Row 2 of its section 9, which is T1623b, stops being a follow-up to decide on a document**: it is slices 3 and 5 here, for every named Light and not only those with a Range.
- **L4, `kind` compile-time, is no longer needed for the shader.** Its two reasons were that a spot could not add a uniform row without changing every Render's text, and that Points mode could not refuse Directional by a value. With `kind` a field of a row the first is gone: a spot is two fields every row has. What is right for the property is that **`kind` stays a value**, as it is today, so changing a Light's Type recompiles nothing. The refusal is then the open half: either a pointset of directional lights is simply legal (N suns from N points, which is what the row would mean), or `kind` is made compile-time for that refusal alone. Recommended: legal, with no refusal. It needs the lead's ruling, since L4 was ruled the other way.
- **Section 3.5 keeps its model and changes its mechanism.** A casting light is still a Light the author places. It is a row with a slot instead of a block with a binding. Its follow-up, shadow slots given on the GPU to the nearest lights of a pointset (section 9, row 1), comes much nearer: the lookup already reads its slot from a row.
- **Section 3.9**: the table gains the always-walked region, the slot rows and the CPU-written rows; `node.scene.lightCapacity` counts named Lights.
- **Slice 1's acceptance 8** ("a Render with no pointset Light has the plan it had") is true of slice 1 and ends, by ruling, at slice 3 here.
- **Slice 3 (the lists)** has one mechanism instead of two (11.4). **Slice 4** is slice 7 here.
- **Its cost model** (section 5) holds in shape. Its figures were taken without a reference and are in the list of section 2.

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

## 13. Slice 2 as built: values for a region of a buffer

Built and tested; used by no product node yet. It is the seam section 11.2 asked for (ruling D4), and the mechanism T1640b wants for the other tables.

**What it is.** A pass kind, `write` (`BufferWritePassDescriptor`, `src/runtime/backend/plan.ts`): a table of rows whose values are known on the CPU, written into a region of a storage buffer.

| Field | Meaning | Structure or value |
|---|---|---|
| `resourceId` | a plain storage buffer: not a pair, not fed by a source | structure |
| `offset` | byte offset of the first row, a multiple of 4 | structure |
| `row` | one row as the type of each 32-bit word: `f32`, `u32` or `i32` | structure |
| `capacity` | rows the region has room for | structure |
| `countOffset` | where the live row count is written as one `u32`; absent, it is not written | structure |
| `values.rows` | the live rows, row after row, one number a word | value |
| `values.count` | how many rows that is | value |

- **It is a pass so that it has an id.** Its values then take every road a uniform block's take, with no second mechanism: `planUniformValues` carries them, `updateUniforms({ passId })` addresses them, the uniform animator diffs and pushes them, a values-only compile applies them and rolls them back with the rest, and a device rebuild flushes them.
- **It encodes nothing.** The bytes are written once, ahead of the next frame's first pass, wherever the pass stands in the list. It is no command buffer of its own (a frame with a table submits what the same frame submits without one). It does end a run of draws, as every pass that is not a draw does, so a node emits it ahead of its draws.
- **Only the region's own bytes are written, and only when its values move.** A dispatch may own other bytes of the same buffer, which is what the Render's light table needs: pointset records written on the GPU beside named rows written here.
- **Only the live rows are written.** Rows past the count keep what they last held. A reader walks `count` rows, never the capacity.
- **A count within the capacity is a write.** A count over it is refused by name and the rows already there stay. One function decides what fits (`bufferRegionProblem`), for a plan being read and for a value pushed on a frame, so the two cannot disagree.
- **A node may emit it.** `write` joined the pass kinds a definition may emit (`compile.ts`); the table is a scratch buffer of the node's own (`{ key, kind: "buffer", stride, capacity }`). A driven parameter that feeds a row keeps the document on the values-only frame path.
- **Two things empty a buffer behind the plan's back, and both put the rows back**: a boundary clear (a seek, a document open) and a lost device.

**Refused by name**, before anything is built: rows over the capacity; a count that is not the rows given; a word that is not of its type (a fraction or a negative number in a `u32`, a NaN anywhere); a region that ends past its buffer; a region that shares a byte with another; a count word inside its own rows; a target that is not a plain storage buffer (a pair, an indirect buffer, a buffer fed by a source). A pass a node emits carries the node's id, so the refusal reaches the Problems pane under the node.

**Tests**, each seen red by one edit and restored by editing:

| File | Holds | Seen red by |
|---|---|---|
| `runtime/backend/buffer-write.test.ts` | the reader: rows and count are outside the structure signature, where they go is inside it; every refusal above, word for word; the bytes | the count put into the structure key; every word encoded as a float; the rows left out of the plan's values |
| `runtime/backend/vgpu/buffer-write.test.ts` (mock host, device calls counted) | the first frame writes rows and count at the region's bytes; a frame where nothing moved writes nothing; a pushed value, a values-only compile and the animator are writes with no shader module and no pipeline; no extra submit; over the capacity writes nothing; a boundary clear and a lost device put the rows back | the per-frame write removed (4 of 5); the capacity check removed; the re-arm after a clear removed; the animator's hunk removed; the frame-split rule removed (3 submits for 2) |
| `runtime/backend/vgpu/buffer-write.gpu.test.ts` (Dawn) | a compute kernel reads two tables of one buffer, floats and mixed words, each at its own bytes with its own count; a pushed row is read on the next frame; over the capacity leaves the rows; a boundary clear brings them back | the per-frame write removed (every row reads "not live"); every word encoded as a float |
| `compiler/buffer-write.test.ts` | a node's pass reaches the plan under the node's id; a driven row stays on the values-only path with no generator run and no text built (the counts `generated-text.test.ts` uses); the frame's passes equal a full compile's; the animator pushes on the frame a row moves and on no other; a driven Capacity is refused the fast path by name; rows that outgrow the table are refused by the node's name | `write` taken out of the kinds a node may emit (4 of 5); the animator's hunk removed |
| `compiler/buffer-write.gpu.test.ts` (Dawn) | the whole road: an expression drives a parameter, the values-only compile and the animator carry it, a FRAGMENT shader sums the live rows. Gain 1 then 8, two rows then four: the pixel is (3, 0.75, 1), then (24, 0.75, 1), then (80, 2.5, 2), exactly. Thirteen rows are refused and the picture stays | the per-frame write removed (black); the animator's hunk removed (the pixel stays at frame 0's) |

The fixture node is `compiler/buffer-write.fixture.ts` (a Table Probe: a scratch buffer, a `write` pass and a draw whose text holds no row and no count). The device-call counter is `countBuildsAndWrites` in `runtime/backend/vgpu/device-calls.test-support.ts`, beside the existing `countDeviceCalls`.

**For the three tables of T1640b.** A row is words: a Ramp stop (a position and a colour) is five `f32`, and a curve point (x, y, z, scale, and its roll) five. Grid Warp's packing was not read.

- **Grid Warp** is a draw and **the curve table**'s reader is a dispatch (read from their definitions). Both pass kinds bind buffers today. They can move as the seam stands.
- **The Ramp is an effect pass, and an effect pass has no buffer bindings** (`EffectPassDescriptor` has textures and samplers). Moving the Ramp needs `buffers` on an effect pass first. Not built here.

**For slice 3 of the one light path.** A named Light's record is one row of sixteen words; the Render emits one `write` pass for its named rows, into its light table at the offset behind the pointset records, with the count in the table's header.

**Not built, and not checked.**

- A region is rewritten whole when any of its rows moves: all the live rows, not the changed one. At 1,024 rows of 64 bytes that is 64 KB a changed frame. Not measured.
- Bytes a dispatch writes are not checked against a region's. Two regions that overlap are refused; a dispatch that writes into a region is not seen.
- With cook policy "auto" a frame in which only a row moved is encoded because every pushed value marks the plan dirty. Read from the code, not tested under that policy.
- The pipeline inspector lists the pass as a utility row with its count and capacity. Not looked at in the app.
- No browser run.

**Hunks in files other sessions are in** (the Rope worker is in the first two):

- `src/runtime/backend/plan.ts`: one import; `BufferWord`, `BufferRegionValues` and `BufferWritePassDescriptor` above `PassDescriptor`, and one more member of that union; one line in `readPass`; one case in `referencedResourceIds`; one line after `kernelStepsDiagnostics`; one case in `passKeyParts`; one line in `planUniformValues`.
- `src/runtime/backend/vgpu/vgpu-backend.ts`: two imports; `applyUniforms` hands a pass with no block to the region path, and the region functions follow it (`regionsToWrite`, `regionPass`, `pendingRegions`, `applyRegionValues`, `writeBufferRegions`); one line in the boundary clear after the plain buffers are zeroed; `encodeSegmented`'s `deferred` rule leaves `write` out; one call after `uploadExternalBuffers`; `updateUniforms` accepts a region's pass id; `write` added to three lists of pass kinds that bind nothing.
- `src/compiler/compile.ts`: `write` in `NODE_EMITTABLE_PASS_KINDS` and in one list of kinds with no textures. `src/app/animate-parameters.ts`: five lines in `blocksOf`. `src/editor/inspect/pipeline-model.ts`, `pipeline-panel.tsx`, `pipeline-track.tsx`: one case and two map entries, which the type checker asked for.
- Everything else is in the new file `src/runtime/backend/buffer-write.ts`.

## 14. Slice 3 as built: a named Light that does not cast is a row

Built, measured and written up in `docs/lights-from-pointset-design-2026-10-06.md`, section 15. Where it differs from 11.2 as designed:

- **The always-walked rows are three runs, not one loop**: rows of any kind, the named point lights with no Range, the named suns, the last two in loops written for their kind that take two rows a turn. One plain loop cost three fifths more than the blocks it replaced at one to nine lights; this form costs 12 and 14 % more at one and two, 7 and 3 % more at four and eight, and less from nine up (15.2 there, with everything that was tried).
- **A named Light's row is a whole record in a buffer of the Render's own, gathered like any set**, not four writes into the table's regions (ruled). So a Render with a lit Surface runs a gather and the grid's build every frame, whatever its table holds.
- **The property of 11.1 holds for the Lights that do not cast** and is gated as stated: one lit string at 0, 1, 8 and 64 of any mix, and on the mock device no shader module and no pipeline for a Light added, removed, re-ordered or re-typed. Casting Lights are still blocks, each under the guard at every count beside the walk; the instances generator and a tile's preview still unroll.
- **No whole shipped frame moved by more than 3 %**, and every shipped picture is within one step of a half float of what it was, bar three channel values at two steps that the guard alone moves (15.7 and 15.9 there).
