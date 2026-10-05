# Substeps on point kernels: assessment (T1583b)

Read-only assessment, 2026-10-05. The owner asked for it ("we should potentially support substeps") and for designs modelled on TouchDesigner and Notch. Figures marked "derived" are arithmetic, not measurements.

## Verdict

Build it as two rows, and do not present the first as the rope feature.

1. **Kernel steps (T1583b).** `substeps` on `pointKernel` as a per-frame value, with `ctx.substep`, `ctx.substeps` and `ctx.delta` divided. This is the correct primitive, not only the cheap one: it is TouchDesigner's GLSL POP `Passes` and Notch's "update steps".
2. **A rope/chain solver node (T1585b).** Both products ship ropes as a solver operator, not as a kernel with a number turned up. Notch's Rope Deformer is the model.

Sentinel-bot (10 strands × 54 links, T1561b) is blocked on neither: an exact one-pass strand solve can be written in a kernel today (see "Alternatives", item 4). That idiom is derived here and untested in the repo.

## Known facts, checked

- **Once per frame.** The node emits one `dispatch` pass (`points.ts:653-705`) and the encoder runs it once (`vgpu-backend.ts:1299-1337`). Loop regions are planned only for nodes declaring `temporal.substeps` (`substeps.ts:117-121`), which is Feedback alone (`feedback.ts:149-152`).
- **`pointAt` is Jacobi** (`codegen.ts:362-369`, `973-984`): it loads from the same read half as `p`.
- **Capacity max 1,000,000** (`points.ts:442`).
- **Params** reflect `f32 i32 u32 vec2f vec3f vec4f` only (`params-reflection.ts:387`).
- **Already in the engine:** passes repeat inside a frame for texture feedback (T387/T425: `plan.ts:285-330`, `expandLoops` at `:1005-1037`, live count at `vgpu-backend.ts:1221-1233`, mid-frame rebind at `:1508-1556`). A loop whose body holds a kernel's buffer pair is refused (`substeps.ts:238-299`), which is why points have no substeps today.

## Cost to build

**How a kernel frame runs today**
- The dispatch reads its packed pair's read half and writes the write half (`point-storage.ts:158-207`).
- Downstream binds the write half (`points.ts:734-737`); the compiler places the swap after the last pass that binds the pair (`compile.ts:2291-2339`).
- `timeSeconds`, `deltaSeconds` and `frameIndex` go into one uniform block per pass, once per `render()` (`resources.ts:1045-1048`, `vgpu-backend.ts:2558-2578`, `shared-uniforms.ts:120-134`).
- vgpu submits each `dispatch()` as its own command buffer, and a uniform `set` writes the queue immediately.

**Smallest correct shape**
- Wrap the kernel dispatch in the existing begin/end loop markers as the count carrier. That reuses the live count, the values-only recompile, the animator and span summing (`frame-compile.ts:291-295`, `389-393`; `animate-parameters.ts:64-70`).
- On the 2nd to Nth encode of that dispatch in a frame, the encoder swaps and rebinds the node's own pair, then writes the per-step uniforms.
- The trailing swap stays where it is.

| File | Change | Lines (est.) |
|---|---|---|
| `src/runtime/backend/vgpu/vgpu-backend.ts` | inner swap and per-step uniforms in `encode()`; divide delta in the `render()` uniform loop | 50–60 |
| `src/runtime/backend/plan.ts` | dispatch field naming the self-stepped pair; reader and structure key | 40 |
| `src/compiler/substeps.ts`, `compile.ts` | plan a region for a non-temporal declarer | 70 |
| `src/compiler/frame-compile.ts` | count lookup for that declarer | 10 |
| `src/domain/types/node-definition.ts` | node-level declaration (frozen contract: full `pnpm test`) | 15 |
| `src/points/codegen.ts` | optional `ctx.substep`/`ctx.substeps` by detection (§V309 pattern); `pointAt` docblock says "previous pass" | 50 |
| `src/nodes/definitions/points.ts` | parameter, uniform reservation, refusals | 40 |

About 300 product lines plus about 500 of tests.

**Risks, most silent first**
1. **Wrong half.** A `[dispatch, swap] × N` region leaves consumers reading step N−1, because they bind the write half. Swaps must sit between dispatches only.
2. **Per-step uniforms depend on vgpu submitting each dispatch separately.** Upstream proposes unified frame encoding; under that, every step would read the last index. N uniform slots (or dynamic offsets) is the durable fix, and the exact-value index test is the guard.
3. **`firstRun` stays 1 for all N dispatches of the seeding frame** (`vgpu-backend.ts:2561-2576`). It must be 1 on step 0 only.
4. **Random draws repeat in every step.** `pointHash` folds `frameIndex` only (`codegen.ts:683-685`, `rng.ts:22-31`). Fold the step in so that step 0 keeps today's stream.
5. **Processor mode.** Shared attributes are re-read from upstream every pass (`point-storage.ts:190-195`). A kernel whose whole schema is shared would run N identical passes; refuse by name.
6. **Offline.** Swap passes inside a region would split one `frame()` per iteration on the direct path; another reason to keep the inner swap out of the pass list. Offline sub-frames multiply the count (`frame.ts:105-112`).
7. **Seek (§V170).** No new rule, but each replayed frame costs N×.
8. **Nesting is a plan error** (`plan.ts:958-970`). It cannot happen while feedback loops refuse kernels; it needs a test.
9. **§V358 wants the region at count 1**, so every kernel's plan structure key changes once.
10. **Span budget.** The GPU timer holds 2048 spans per frame (`plan.ts:324-328`).

**Lifecycle.** `pointKernel` has no emit or compact, so nothing interacts. `pointKernelAdvanced` stays out of the first version: its kernel, scan, scatter, spawn and hook passes would have to repeat as a unit, and births would multiply against the 8-per-parent cap (`lifecycle.ts:46`).

## Benefit (derived)

- **Stiff springs.** An explicit chain is stable while `h·√(k/m) < 1`, so stiffness headroom grows as N². At 60 fps the limit on k/m is 3,600 at N=1, 230,400 at N=8, 921,600 at N=16 and 14.7M at N=64.
- **Chains with time-dividing substeps.** A hanging chain at that limit elongates by `g·h²·L(L+1)/2`. For 54 links at 0.06 m pitch (a 3.24 m rope):

| N | Elongation | Stretch |
|---|---|---|
| 1 | 4.05 m | 125% |
| 8 | 63 mm | 2.0% |
| 16 | 16 mm | 0.5% |
| 64 | 1 mm | 0.03% |

- **Chains with iterations at an undivided step** do far worse. Jacobi shrinks the smoothest error mode by cos(π/55) = 0.9984 per pass, about 610 passes per factor e; red/black halves that. "54 iterations" is the propagation bound, not convergence.
- **Why dividing `ctx.delta` matters.** Each substep injects N² less error: Macklin et al. 2019, [Small Steps in Physics Simulation](https://diglib.eg.org/handle/10.1145/3309486-3340247).
- **Latency.** Root motion reaches the tip in 6.8 frames at N=8, 3.4 at N=16 and 0.84 at N=64.
- **Collision.** Travel per step is v·dt/N. A tip at 10 m/s moves 167 mm per frame, 21 mm at N=8, against a 60 mm ring pitch. Point-to-point collision has no neighbour search, so it is an O(n²) loop per pass: fine at 540 points, impossible at 100k.

**What else rope needs**
- Red/black colouring needs substeps plus the index and nothing else (`phase = ctx.substep & 1`). Substeps are its prerequisite.
- Long-range attachment (clamp each point to within i·pitch of its anchor) and hierarchical skip links are writable today and independent of substeps.
- A dedicated edge-constraint pass is not a prerequisite for anything here.

## GPU cost

Two recorded figures exist, and they disagree by about 4× per point.

- **A:** 0.755 ms per dispatch at 1M points, 4 attributes, memory-bound, 64 back-to-back dispatches per frame on Dawn/Metal (`docs/vgpu-patch-notes.md:149-152`). It was an uncommitted probe; "per dispatch" is a reading of its stated 144 GB/s.
- **B:** the `pointTransform` apply pass, 0.019 ms at 25,600 points and 0.726 ms at 262,400 (`point-transform.ts:63-71`), extrapolated linearly.

| Points | Per dispatch (A / B) | N=8 | N=16 | N=64 |
|---|---|---|---|---|
| 100k | 0.076 / 0.24 ms | 0.6 / 1.9 ms | 1.2 / 3.9 ms | 4.8 / 15 ms |
| 1M | 0.755 / 2.9 ms | 6.0 / 23 ms | 12 / 47 ms | 48 / 187 ms |
| 540 | about 0.019 ms (submission floor) | 0.15 ms | 0.3 ms | 1.2 ms |

Against a 16.7 ms frame, 100k points is comfortable to N=16 and 1M is not real-time past N=8. No measurement of a neighbour-reading kernel, and no CPU cost per dispatch, is recorded.

## Alternatives in the engine today

1. **Chain N kernels through the processor port.** Each reads upstream's current position, so N−1 relaxations per frame work. There is no way back to the head (no pointset feedback node), so corrections never reach the integrator. It costs N nodes, N pipelines and N packed pairs.
2. **Texture feedback with `substeps`** (`feedback.ts:125-134`, up to 256). Simulate in a float texture, then `pointsFromTexture`. Position and previous position must share one RGBA texture; there is no divided delta and no step index.
3. **Transport.** `fps` is whole-graph. Offline `subframes` is a true substep but offline-only, and multiplies every pass.
4. **Solve the strand inside the kernel (no engine change).** For a strand pinned at the root, one root-to-tip sweep that moves only the child satisfies every distance constraint exactly. Each point re-walks its strand with at most 54 `pointAt` loads. O(L²) per strand, not momentum-conserving, and `ctx.dim` needs a wired grid edge.

## How TouchDesigner and Notch do it

From the official documentation, fetched 2026-10-05.

| Product, operator | Stepping control | Source |
|---|---|---|
| TD Feedback POP, Particle POP | one cook per frame; Pre-Roll; no substeps or iterations | [Feedback POP](https://docs.derivative.ca/Feedback_POP), [Particle POP](https://docs.derivative.ca/Particle_POP) |
| TD GLSL POP (custom kernel) | `Passes` ("Number of shader passes") and `Copy Previous Pass Output to Input`; GLSL TOP adds `uTDPass`, the pass index | [GLSL POP](https://docs.derivative.ca/GLSL_POP), [Write a GLSL TOP](https://docs.derivative.ca/Write_a_GLSL_TOP) |
| TD springs | no Spring POP; staff: "roll your own using a feedback loop with feedback POP and math mix POP or GLSL POP". Spring SOP (CPU) shrinks `Time Inc` below `1/$FPS` | [forum](https://forum.derivative.ca/t/spring-pop-equivalent/634487), [Spring SOP](https://docs.derivative.ca/Spring_SOP) |
| TD Flex Solver | `substeps` and `iterations` ("iterations in each substep"); Windows/NVIDIA only | [Flex Solver COMP](https://docs.derivative.ca/Nvidia_Flex_Solver_COMP) |
| TD Bullet Solver | `rate` only (timestep = 1/rate); joints through Constraint COMP | [Bullet Solver COMP](https://docs.derivative.ca/Bullet_Solver_COMP), [Constraint COMP](https://docs.derivative.ca/Constraint_COMP) |
| Notch Physics Root | Update Frame Rate, Min/Max Update Steps; the physics delta is derived from the frame delta and the number of update steps | [Physics Root](https://manual.notch.one/2026.1/en/docs/reference/nodes/physics/physics-root/) |
| Notch Rope / Cloth Deformer | Update FPS, Min/Max Update Steps; Stiffness, Spring Dampening, Bend Springs; anchors on first/second/last vertices; collision and force inputs. No iteration count | [Rope](https://manual.notch.one/2026.1/en/docs/reference/nodes/deformers/physics/rope-deformer/), [Cloth](https://manual.notch.one/2026.1/en/docs/reference/nodes/deformers/physics/cloth-deformer/) |
| Notch Particle Root | Fixed Update Rate; mode Substeps; Collision Resolution Passes | [Particle Root](https://manual.notch.one/2026.2/en/docs/reference/nodes/particles/particle-root/) |

Blender's XPBD Solver node takes the same shape: Substeps plus Constraint Iterations, wrapped in Hair and Cloth assets ([manual](https://docs.blender.org/manual/en/dev/modeling/geometry_nodes/simulation/xpbd_solver.html)).

**What this says**
- Running the simulation several times per displayed frame is a first-class control in both products.
- Notch expresses it as a rate with step clamps and derives the delta. That keeps the step size steady when a frame drops; a bare count doubles it.
- TD's custom-kernel node has exactly the proposed shape (a pass count, with a pass index on TOPs).
- Neither exposes colouring; it stays inside the solver.
- Neither treats rope as a user kernel. Notch ships the operator; TD has a known gap.

## Recommendation

**T1583b, kernel steps.**
- `substeps` (1–64) on `pointKernel` is a per-frame value, not compile-time. Notch's rate form is then the expression `clamp(ceil(delta * 240), 1, 16)`.
- A second count, `iterations`, in the same change: dispatches = substeps × iterations, capped, with `ctx.delta` divided by substeps only. That is the Flex and Blender shape, and it spares a red/black author a hand-typed divisor.
- Naming: Feedback's existing "Substeps" does not divide the shader's delta. The kernel's would. Say so in both parameter descriptions.

**T1585b, a Rope node** over a grid-topology pointset (`ctx.dim`: cols = links, rows = strands).
- Notch's vocabulary: Update Rate, Min/Max Update Steps, Gravity, Damping, Stiffness, Spring Damping, Bend Stiffness, Rest Length Scale, Anchor First/Second/Last, Collision Thickness; plus Iterations, from Flex.
- Anchors pin to the incoming, animated position. Collision comes from the field texture now, and from a second pointset when T1582b lands.
- Inside: distance and bend constraints solved by red/black passes on kernel steps, long-range attachment to anchors, and its own `simPosition`/`prevPosition` state.

**Tests for kernel steps (Dawn, exact values)**
- **Counter:** a kernel adding 1.0 to `position.x` reads back F·S for every slot: (4 frames, 3 steps) = 12 = (12, 1).
- **Consumer half:** a downstream processor's copy reads the same number, not F·S−1.
- **Index:** `acc += f32(ctx.substep)` is 28 after one frame at S=8, and 56 if every step read the last index.
- **Delta:** at S=8, `ctx.delta * 8.0` equals the frame delta bit for bit.
- **Propagation:** `v = max(p.v, pointAt(index-1).v)` from one seeded slot lights exactly slots 0..S after one frame.
- **`firstRun`:** seed to 100 on `firstRun`, otherwise add 1; frame 0 at S=4 reads 103.
- **Replay (§V170):** two runs to frame 5 at S=7 match byte for byte.
- **Live count:** driving 1 to 3 mid-run continues the count without a reset.
- **§V309:** a kernel naming neither member generates identical WGSL.
