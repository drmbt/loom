# A rope solver node: strands that hang, lag and whip (T1585b)

**Status, 2026-10-06: slices 1 (the strand and its time), 2 (the second pin and the anchors) and 4 (the bend limit) are built and measured on a device. Sections 1 to 13 are the design as ruled on 2026-10-05; section 14 is what slice 1 built, measured and changed; section 15 is what the first consumer's review added (a bend limit above all), of which 15.2 to 15.5 are now built; section 16 is what slice 2 built, measured and changed; section 17 is what slice 4 built, measured and changed, with one case not closed (17.8).** Where a sentence in sections 1 to 13 is no longer true, it says so and points at 14 or 15.

The row asks for a Rope node over a strips pointset, in Notch's vocabulary, with anchors that pin to the incoming animated position, collision, and cloth as a later sibling. The owner's standard for it (2026-10-05): consider how TouchDesigner and Notch do this, and build the good and right thing, not a brittle, unscalable or slow shortcut. The first consumer is sentinel-bot (T1561b), whose tentacles the owner called "very stiff and not floppy ropey", then "flight mode still looks too stiff", and whose motion must not "glitch around and teleport".

Read for this: `docs/point-kernel-substeps-assessment-2026-10-05.md`, `docs/td-notch-mechanisms-2026-10-05.md`, `docs/curve-family-design-2026-10-05.md`, `docs/mesh-instancing-design-2026-10-05.md` (sections 9 and 13), the kernel steps as built (`src/points/codegen.ts`, `src/nodes/definitions/points.ts`, `src/compiler/substeps.ts`, `src/runtime/backend/plan.ts`, `src/runtime/backend/vgpu/kernel-steps.gpu.test.ts`), the clocks (`src/domain/types/frame.ts`, `src/domain/transport/live-clock.ts`), `src/projects/sentinel-bot/**` at `36b4d516` (read only), and the pages and papers in section 13.

Three kinds of figure appear, and each is labelled:

- **measured**: recorded in the repo by someone else, on a device. Cited with its source.
- **derived**: arithmetic from measured figures or from a formula given here.
- **model**: from a CPU model of the candidate methods written for this design (float64 unless it says single precision). Appendix A describes it. It is not the GPU and it is not committed.

## 0. The design on one page

- **A rope is a strand: one strip of a strips pointset** (T1586b). The Rope node takes strips in and hands the same strips out, with `position` simulated and `velocity` published. Everything else on the edge passes by reference, so Curve Frames, Resample, Sweep and instancing take a simulated rope exactly as they take an authored curve.
- **An anchor pins a point to the incoming point of the same slot.** Whatever animates the incoming strip (a kernel, a Curve, a Line under a Transform) drags the rope. An anchor has a weight from 0 to 1 that can change every frame and can come from an attribute, per strand or per point. That weight is the consumer's "the claw lets go".
- **The method is XPBD in small steps, with each strand's stretch constraints solved together.** The linear system XPBD relaxes one constraint at a time (Macklin et al. 2016, eq. 16) is tridiagonal on a chain, so one GPU thread per strand solves it exactly, in a walk along the strand of the kind Curve Frames already makes. A step repeats that Newton step until every segment is within 1/8192 of its length, up to Iterations times.
- **It is not the relaxation the row sketched**, and the reason is a number. At 16 dispatches a frame on a 54-link strand driven the way the consumer drives it (model): red/black relaxation with long-range attachments leaves a segment 31% long and the strand 7.7% long; the chain solve leaves every segment within 0.012%, and still does at 4 dispatches. Section 2 has the table.
- **It has one honest limit, and a guard for it.** A step must be shorter than the time a transverse wave takes to cross one segment, `h < √(m·l ÷ T)`. Inside it the rope does not stretch. Outside it (a body stopped dead from 9 m/s, a 1,000-link strand cracking like a whip at too coarse a step) a segment is momentarily long, and Max Stretch, Notch's parameter, clamps it without adding speed.
- **Time is Notch's.** Update Rate with Min and Max Update Steps gives a step count per frame, and the step is the frame's delta divided by that count. Loom's frame delta is already a whole number of project frames live, and a whole fraction of one offline, so at a rate that is a multiple of the project's the step is the same size live, after a dropped frame, in fixed-step and offline. No frame-mode branch exists in the node.
- **On the GPU it is one dispatch per update step**, on the loop region kernel steps already built (T1583b), with two small engine changes: the region's count may be declared as a rate, and a stepped node may emit one more pass that is not stepped. The program is the node's own shader module, not a generated point kernel.
- **Collision** is against a floor, against a second pointset (points are spheres, strips are capsule chains, and a strip with Inside on is a tube to stay within), against a height field as Ray reads it, and against a distance function written in WGSL. The consumer's bore, with its deck, is the last of these.
- **Cloth is a sibling, not this row.** It shares the node's shell, time, anchors, forces and colliders. Its solve is different, and that is where red/black colouring on `ctx.iteration` belongs.

Where this differs from the row and the assessment, each is a decision in section 11.3: the method (D1), the program's shape (D2), no long-range attachment (D1), `position` and `velocity` as state where the row had `simPosition` and `prevPosition` (D12), and rest lengths that are not simply the incoming strip's (D7).

## 1. How TouchDesigner and Notch do it

**The reference is `docs/td-notch-mechanisms-2026-10-05.md`** (TouchDesigner §5, Notch §5) and the table in the substeps assessment. Their facts are not repeated. This section adds what this session read on 2026-10-05; every page is listed in section 13.

### 1.1 TouchDesigner

There is no rope, chain or spring operator on the GPU. What exists, and what people build:

- **Spring SOP (CPU geometry).** It "deforms and moves the input geometry using spring 'forces' on the edges of polygons and on masses attached to each point." Its parameters are the shape of a rope node in miniature:
  - **Fixed Points**, a point group that "will remain unaffected by the forces", and **Fixed Points go to Source Positions**: whether the pinned points follow the animated input. That is this row's "an anchor pins to the incoming animated position".
  - **Reset** ("While On resets the spring effect") and **Reset Pulse**; **Preroll Time**; **Time Inc**, by default `1/$FPS`, made smaller for accuracy.
  - External Force, Wind, Turbulence; Mass and Drag per point; Spring Constant; limit planes with Hit Behavior and gains normal and tangent to the surface. Three inputs: source, collision object, force.
- **POPs.** Derivative staff, asked for the closest POP to the Spring SOP: "there's no equivalent right now in POPs, you would have to roll your own using a feedback loop with feedback POP and math mix POP or GLSL POP." On a user's verlet soft body: "It might be possible to replace the feedback and the glsl Verlet integration by a Particle POP." The Particle POP has Initialize, Start, Play, Speed and Pre-Roll, and no substep or iteration count.
- **Bullet.** The Constraint COMP joins rigid bodies point to point, by a hinge or by a slider. The page does not mention chains, ropes or iterations. A chain of bodies is possible and is rigid-body work on the CPU.
- **What people build**, as community assets, both on compute shaders:
  - chainGpu (Mickey van Olst, 2023): "chain-like physics on the GPU", for "flowers, plants, grass, tentacles, hair and trees". Each segment has a target orientation and takes a velocity toward it. The author: "not intended to be a fully featured physics engine".
  - Constraint Simulation Tool (Josef Pelz, 2021): "Spring constraint based simulation for polygonial SOP geometry", with stiffness and "stress resistance" scaled by attributes.
- Flex in TouchDesigner is fluids only and ends with the RTX 40 series (the reference).

### 1.2 Notch

The Rope Deformer and the Cloth Deformer share one design. From the 2026.2 manual:

- **What it runs on.** "Applies a rope simulation to the selected geometry"; each edge "will be treated as an independant piece of rope". "Commonly used together with the Object to Lines node, with extra subdivisions added to improve detail."
- **Stepping.**
  - Frame Rate Mode: Free ("allowed to run as fast as possible") or Fixed ("more deterministic simulation results by advancing the simulation at a consistent rate"), with a Fixed Frame Rate.
  - Update Frame Rate: "An update frame rate of 240 in a project running at 60 fps, 4 update steps will be executed per frame. If a frame is dropped, more steps will be added to other frames to maintain simulation quality, up to the max update steps cap."
  - Min Update Steps ("If the frame rate is running very high, this can force extra steps") and Max Update Steps ("If the frame rate is running low, this caps the updates per frame").
  - Simulation Speed.
  - The Physics Root page says how the step size follows: "Once the number of steps for the frame has been determined, the physics time delta is derived from the render frame's time delta and the number of physics update steps." It also names the trap: "a lower render FPS results in more physics steps required to meet the physics FPS, which in turn adds load on the system and reduces the render FPS."
- **Forces.** Gravity ("pushes the rope in the -y direction"); Dampening ("Reduces the velocity of all the forces acting on the rope over time"); a Force Affectors input (Force, Turbulence and Transform affectors). Cloth adds Air Drag.
- **The rope.**
  - Spring Model: Stiff ("a sharper stiffness curve") or Flexible ("a stretchier and more flexible rope sim").
  - Stretch Mode: Unlimited or Max Limit, with **Max Stretch**: "The maximum amount a rope segment may stretch beyond its rest length before being clamped by the solver."
  - Rest Length Scale: "Multiplies the current length of each edge ... Useful for making a rope which shrinks or expands."
  - Stiffness, Spring Dampening; Bend Springs, Bend Stiffness, Bend Dampening.
  - Self Collisions and Collision Thickness ("Thickness of the rope used for self intersections").
- **Anchors.**
  - Anchor 1st Vertices, Anchor 2nd Vertices, Anchor Last Vertices: each "Pins the ... vertex along the rope, so it isn't affected by rope forces."
  - Anchor Mode: **Hard** ("snapped directly to their target positions"), **Soft Weightmap** ("move toward their target positions gradually, with the amount of softness controlled by a weightmap"), **Soft Constant** ("a single constant softness value").
  - Anchor Strength ("How strongly pinned anchor edges pull the simulation towards their target transform") and Anchor Dampening ("Damps oscillation ... so the cloth settles without springing").
  - The deformer sits on animated geometry, so an anchor's target is the vertex's animated position.
- **Collision.** An input, "Collision Nodes", typically a 3D Primitive. Elsewhere in the product: Primitive Collision (sphere, box, cylinder, plane, with Inverted), collision against a procedural (a signed distance field generated as shader code), Collision Mesh ("less robust than collisions with convex hulls ... A high frame rate ... is recommended").
- **Cloth beyond the rope.** Shear Stiffness; Self Collisions Off, Simple ("per vertex within a small radius") or Accurate ("per polygon"); Volumetric Pressure, Target Volume, Constant Pressure with a weightmap. "Meshes primarily built from Quads"; "render a low res sim and subdivide after".
- **Not on these pages:** how the solver works, an iteration count, a reset control, pre-roll, what a teleport does, friction, twist.

### 1.3 Two other products, read for one point each

- **Unreal Engine's cloth**, for teleports. `EClothingTeleportMode` has three values: None ("simulate as normal"), **Teleport** ("causing no intertial effects but keep the sim mesh shape") and **TeleportAndReset** ("... and reset the sim mesh shape"). A distance threshold and a rotation threshold on the component decide when a move counts as one.
- **Obi Rope** (Unity), the nearest shipping XPBD rope. "Ropes are built by chaining particles using distance and bend constraints." Its particles "have no orientation (only a position), torsion effects cannot be simulated, and ropes cannot retain its rest shape."

### 1.4 Where they agree

1. **Rope is a solver operator on line geometry**, not a user kernel with a number turned up. Notch ships it; TouchDesigner's staff name the gap; the community fills it with compute shaders.
2. **The simulation runs at its own rate.** Notch's rate with step clamps, the Spring SOP's Time Inc. Notch derives the step from the frame and the count.
3. **Pinned points follow the animated input.** The Spring SOP's "go to Source Positions"; Notch's deformer over animated geometry, with soft anchors as a strength and a damping.
4. **A hard limit on stretch is its own control** beside stiffness: Notch's Max Stretch.
5. **Forces and colliders arrive from outside**, as inputs.
6. **Neither simulates twist**, and neither documents a teleport.

### 1.5 Comparison

| Capability | TouchDesigner | Notch | Loom today | Loom proposed |
|---|---|---|---|---|
| Rope as an operator | none on the GPU; Spring SOP on the CPU; community compute shaders | Rope Deformer | none; sentinel-bot's closed-form trail | Rope node (3) |
| What it runs on | SOP polygons | line geometry, a rope per edge | n/a | a strips pointset, a rope per strip |
| Many ropes in one object | yes | yes | n/a | rows of one pointset; parallel across strands |
| Steps per frame | Spring SOP Time Inc; GLSL POP Passes for a kernel of one's own; none on the other POPs | Update Frame Rate, Min and Max Update Steps | `substeps`, `iterations` on Point Kernel | Update Rate, Min and Max Update Steps (6.3) |
| Step size after a dropped frame | not documented | more steps, up to the cap; delta derived from the frame and the count | an expression on Substeps | the same rule as Notch, built in |
| Solver passes inside a step | none | not documented | `iterations` | Iterations: Newton steps to a tolerance (2.5) |
| Stretch | spring constant | Stiffness, Spring Model | by hand | none by default; Stretch as a compliance |
| A hard stretch limit | no | Max Stretch | no | Max Stretch, as a guard that adds no speed |
| Rest length | initial tension | the edge's length; Rest Length Scale | by hand | measured when seeded, a number, or an attribute; Rest Length Scale |
| Bend | no | Bend Springs, Bend Stiffness, Bend Dampening | by hand | Bend Stiffness, Bend Damping |
| Gravity and damping | External Force; Drag | Gravity; Dampening | by hand | Gravity; Damping toward a Wind |
| Forces | a force input; Wind; Turbulence | Force Affectors input | a kernel | a per-point acceleration attribute; a kernel upstream is the affector |
| Mass per point | Mass attribute | not documented | by hand | Mass, also per point |
| Anchors | a point group | first, second, last vertex | by hand | first, second, last; any point by an attribute |
| Anchors follow animation | "go to Source Positions" | the deformed geometry | n/a | always: the incoming point of the slot (4.1) |
| Soft anchors | no | Soft Weightmap, Soft Constant; Strength, Dampening | n/a | Soft; Anchor Strength (Hz), Anchor Damping (4.3) |
| Anchor weight per rope, per frame | group membership | a weightmap | n/a | a number, an expression, or an attribute (4.4) |
| Two anchors further apart than the rope | not documented | not documented | the Arc falls short | the earlier holds, the later falls short (4.6) |
| Reset | Reset, Reset Pulse | not documented | Feedback's Reset; a seek | Reset, as Feedback's (4.8) |
| Pre-roll | Preroll Time; Pre-Roll on POPs | not documented | no | follow-up R5 |
| Teleport | no | not documented | n/a | Teleport Distance; Carry or Reset (4.7) |
| Collide with primitives | limit planes; a collision input | Collision Nodes input | Ray against a height field | a floor; spheres and capsule chains from a pointset (5.2) |
| Stay inside a tube | no | Inverted, on particle collision | no | a strip collider with Inside |
| Collide with a distance function | no | procedural collision | `fieldAt` in a kernel | a WGSL distance function on the node |
| Friction | gain tangent | not documented | by hand | Friction |
| Self collision | no | Self Collisions, Collision Thickness | no | follow-up R3 |
| Tension as data | no | no | no | `tension`, optional |
| Twist | no | no | no | follow-up R4; Curve Frames derives the frame |
| Deterministic replay | not stated | Fixed mode "more deterministic" | every stateful kernel (§V170) | byte-identical on a device (6.4) |
| Cloth | no POP | Cloth Deformer | no | sibling row R2 (8) |

## 2. The method

### 2.1 What is asked of it

The owner wants a rope that is floppy, that does not stretch like rubber, and that whips. In solver terms:

- **Floppy**: no bending stiffness unless asked for, little damping, real inertia. A point lags because it has momentum, not because a formula delays it.
- **Does not stretch**: the distance constraints along a strand are solved to convergence, however long the strand and however hard it is pulled.
- **Whips**: momentum is conserved along the strand, so a wave sent down it speeds up toward the light, free end.

The budget named is about 16 dispatches a frame for one robot's 550 rope points (10 strands of 55; 630 counts the claws' phalanges, which are not rope). It has to say what it costs at 100,000 points.

### 2.2 The candidates

Each is stated with what it gives at 54 links (the consumer: 0.06 m pitch, 3.24 m) and at 1,000 links (60 m at the same pitch), and what it needs. `h` is the step, `dt ÷ N` at N substeps of a 60 fps frame; `a` is the acceleration the strand feels along its length; `L` is the number of links.

**1. Explicit springs.**

- Stable only while `h·√(k/m) < 1`, so the stiffest spring a step allows is `k/m = 1/h²`. Hanging at that limit the strand is longer by `a·h²·L(L+1) ÷ 2` (the assessment's formula).
- 54 links at 1 g: 63 mm at N = 8, 15.8 mm (0.49%) at N = 16, each at the knife edge. A margin of four in stiffness is four times the stretch.
- 1,000 links: 5.3 m of 60 m at N = 16. The error grows as L².
- One dispatch per substep. In the model's dead-stop run at 16 substeps its worst segment reached 9,000% at the limit and 142% at a quarter of it.
- Not a candidate.

**2. Position-based dynamics by relaxation** (Müller et al. 2007), in red/black passes on kernel steps. This is what the row sketched and what `kernel-steps.gpu.test.ts` proves on 16 links.

- Unconditionally stable. Its stiffness is whatever the iteration count and the step make it.
- A correction travels one link per pass. One red/black sweep per substep leaves a hanging strand longer by `a·h²·L² ÷ 2`: the test's `128·g·h²` at L = 16, and the model reproduces 62.08 mm at L = 54, N = 8. That is the explicit spring's error at its stability limit, without the instability.
- The smooth error mode of a chain pinned at one end shrinks by cos²(π ÷ 2L) per sweep: 0.99915 at 54 links, 1,182 sweeps for a factor of e; 405,285 sweeps at 1,000 links. Iterations at an undivided step do not converge in any affordable count; substeps do better because each divides the error by N² (Macklin et al. 2019).
- Two dispatches per substep at best (the predict folded into the first colour by recomputing the partner's prediction; the proof kernel uses three). So 16 dispatches are 8 substeps: 62 mm (1.9%) hanging at 1 g. Under the consumer's motion the model reads 51% on the worst segment and 18% on the length.

**3. XPBD** (Macklin, Müller, Chentanez 2016).

- The same relaxation with a compliance per constraint, `α̃ = α ÷ h²`, so a stiffness means the same at any step and iteration count. With zero compliance it is PBD.
- It is the right formulation: a parameter with a unit, soft anchors as compliant attachments, damping with a derivation. It does not converge any faster.
- The paper itself points at the alternative. Its Gauss–Seidel update is one way to solve the linear system `[∇C·M⁻¹·∇Cᵀ + α̃]·Δλ = −C − α̃·λ` (its eq. 16); it describes itself as "a compliant version of [Goldenthal et al.'s] Fast Projection algorithm, combined with an iterative Gauss-Seidel solver".

**4. Follow the leader** (Müller, Kim, Chentanez 2012).

- One sweep from the root sets each point at exactly its length from the one before. Inextensible in one pass at any L and any step.
- The leader never feels the follower, so momentum is not conserved. The paper's velocity correction hides it for hair.
- It cannot hold a second anchor.
- In the model's driven run the tip reaches 88 m/s where the converged reference reaches 41: it gains energy. Used as a finishing sweep on a 1,000-link strand it took the energy from 1.9 × 10⁵ J to 3 × 10¹⁰ J.
- Floppy and inextensible; it does not whip, it lashes.

**5. Long-range attachments** (Kim, Chentanez, Müller-Fischer 2012).

- Not a solver: an addition to relaxation. No point may be further from an anchor than the rope between them.
- Exact for a strand pulled straight. It says nothing along a curved path: a strand bent over a rib, or over the robot's own hull, stretches as before.
- The model's relaxation with it: 31% on the worst segment and 7.7% on the length at 54 links; 103% and 21.5% at 1,000.

**6. The chain solve: XPBD's linear system solved exactly per strand.**

- On a chain, link `i` shares a point only with links `i − 1` and `i + 1`, so the matrix of eq. 16 is tridiagonal: `Aᵢᵢ = wᵢ + wᵢ₊₁ + α̃ᵢ`, `Aᵢ,ᵢ₊₁ = −wᵢ₊₁·(nᵢ·nᵢ₊₁)`, with `w` the inverse masses and `n` the links' unit directions. It is diagonally dominant, so forward elimination and back substitution solve it in one pass each along the strand, with no pivoting.
- This is Han and Harada's formulation for hair (2013: "the formulated matrix is diagonally dominant, it can be solved by an efficient direct solver"), Goldenthal et al.'s fast projection (2007) on a chain, and what molecular dynamics does for chain molecules with rigid bonds (Bailey and Lowe 2009). Deul et al. (2018) do the same for rods on trees, solving every constraint of an acyclic structure at once in a few Newton iterations.
- One solve is one Newton step of the projection onto "every segment has its length". The constraints are not linear, so it repeats until they hold; inside the step limit of 2.6 the model takes 1.0 to 1.5 solves a step.
- A correction reaches the whole strand in one solve, at any L. Internal impulses cancel in pairs, so momentum is conserved exactly. A mass ratio costs nothing: where the Small Steps paper reports a 1:100,000 ratio leaving 3.2 m of error on a 0.2 m chain after 100 substeps, a direct solve is exact.
- Hanging at rest it is exact: the model reads a sag of 0 and a tension of 529.740000 N at the top of 54 links (54 × 9.81), at 1, 4 and 16 substeps. With a compliance it reads 145.6785 mm against the closed form `α·m·g·L(L+1) ÷ 2` = 145.6785 mm, at 1, 4 and 16 substeps.
- It is serial along a strand and parallel across strands, which is the walk Curve Frames makes (measured: its cost follows the strip's length, not the number of strips).
- Its limit is 2.6.

### 2.3 The model's table

One strand of 54 links of 0.06 m, unit masses, 60 fps, gravity 9.81, no drag, laid out behind its first point. The first point is driven the way the consumer drives a socket: eased from rest to 9 m/s over a second, swaying half a metre at 0.8 Hz and a quarter at 1.3 Hz, eased to rest again; 4 seconds. The anchor's target is interpolated across the substeps. "Worst segment" is the largest strain of any segment at the end of any substep; "length" is the largest error in the strand's total length.

| Method | Dispatches a frame | Substeps | Worst segment | Length | Peak tip speed |
|---|---|---|---|---|---|
| Red/black relaxation, one sweep | 16 | 8 | 51.5% | 18.1% | 23 m/s |
| The same with long-range attachment | 16 | 8 | 30.8% | 7.7% | 25 m/s |
| Follow the leader, with its velocity correction | 16 | 16 | 0 | 0 | 88 m/s |
| Chain solve, to 1/8192, at most 4 Newton steps | 16 | 16 | 0.012% | at most that | 32 m/s |
| The same | 8 | 8 | 0.012% | | 30 m/s |
| The same | 4 | 4 | 0.012% | | 26 m/s |
| Reference: chain solve, 256 substeps, 4 Newton steps | 256 | 256 | 0.000% | | 41 m/s |

- The chain solve took 1.01 Newton steps a substep at 16 substeps, 1.08 at 8 and 1.44 at 4 (never more than 3).
- **It damps.** The tip peaks at 32 m/s at 16 substeps and 26 at 4, against 41 for the reference: implicit stepping loses energy, more at a coarser step. Follow the leader gains it. A free tip with no drag is chaotic, so no two step sizes agree on its path after a few seconds; what compares is strain, energy and peak speed.
- The same strand in single precision (model, with a drag of 0.5/s), the arithmetic done relative to the strand's first point: 0.012% at the origin, and 0.13% at 960 m from it, where one unit in the last place of a stored position is 0.10% of a segment (6.9).

**A dead stop**: the same strand, its first point taken from 9 m/s to rest in one frame (540 m/s², 55 g).

| Method | Substeps | Worst segment | Substeps that end with a segment over 1% |
|---|---|---|---|
| Relaxation with long-range attachment | 8 | 33.9% (length 7.8%) | |
| Chain solve, at most 2 Newton steps | 16 | 4.96% | 4 of 3,840 |
| Chain solve, at most 4 | 16 | 1.16% | 1 of 3,840 |
| Chain solve, at most 8 | 16 | 0.012% | 0 |
| Chain solve, at most 8 | 8 | 1.73% | 1 of 1,920 |
| Chain solve, at most 4, no guard | 4 | 180% | 9 of 960 |
| Chain solve, at most 4, Max Stretch 2% | 4 | 2.00% | 5 of 960 |

**1,000 links** (60 m), the consumer's motion.

| Method | Substeps | Worst segment | Note |
|---|---|---|---|
| Relaxation with long-range attachment | 8 | 103% | length 21.5% |
| Chain solve, at most 2 Newton steps | 16 | 43% | 213 of 3,840 substeps over 1% |
| Chain solve, at most 4 | 16 | 0.018% | 1.5 Newton steps a substep |
| Chain solve, at most 8 | 8 | 5.5% | 29 of 1,920 over 1% |
| Chain solve, at most 4, drag 1/s | 8 | 0.027% | |
| Chain solve, at most 4, no guard | 4 | 430% | does not converge at this step |
| Chain solve, at most 4, Max Stretch 2% | 4 | 2.00% | energy 1.96 × 10⁵ J; reference 1.93 × 10⁵ J |

### 2.4 The choice

**The chain solve (6), inside XPBD's formulation (3), stepped in small steps, with Max Stretch as the guard.** Against the owner's three words at 16 dispatches for 550 points:

- **Does not stretch**: 0.012% on the consumer's motion, where relaxation with long-range attachments leaves 31%. The same holds at 4 dispatches, so the budget has room in it.
- **Floppy**: bending is its own parameter and is zero by default. Nothing in the stretch solve stiffens a bend.
- **Whips**: the solve conserves momentum and reaches the whole strand at once. It does not gain energy; it loses some, and less at a finer step.

What it gives up:

- **A program of its own.** The work is per strand, not per point, so it is not a `pointAt` kernel (7.2).
- **Long strands cost by their length** (7.6), and v1 stops at 1,024 points a strand (R1).
- **It has a step limit** (2.6) where relaxation only gets softer. The guard is what makes a step past the limit a bounded error and not a glitch.
- **It does not carry over to cloth as it is** (8).

What would change this recommendation: if the measurement in slice 1 (D11) shows a 55-point walk costing several times what Curve Frames' does, the fallback is relaxation in coloured passes with more substeps, and its stretch figures above are the price.

### 2.5 The step, exactly

For one strand, one update step of length `h`. `x` and `v` are the stored position and velocity, `w = 1 ÷ mass`, `l` the segments' rest lengths, `t` an anchor's target (4.1), `a` its weight.

```
1  predict     v′ = wind + (v − wind)·e^(−damping·h)
               x̂ = x + h·v′ + h²·(gravity + force)

2  anchors     for each point with a > 0:
                 Hard and a = 1:   x̂ = t,  w = 0
                 otherwise:        ω = 2π·strength,  g = a ÷ (1 − a) if Hard, a if Soft
                                   κ = (ω·h)²·g,  δ = 2·ratio·ω·h·√g
                                   x̂ = (x̂ + κ·t + δ·(x + t − t_before)) ÷ (1 + κ + δ)
                                   w = w ÷ (1 + κ + δ)

3  bend        when Bend Stiffness > 0: one Gauss–Seidel sweep along the strand (3.2)

4  stretch     up to Iterations times:
                 Cᵢ = |x̂ᵢ₊₁ − x̂ᵢ| − lᵢ,  nᵢ the unit direction
                 stop when every |Cᵢ + α̃ᵢ·λᵢ| < lᵢ ÷ 8192        (λ is zero when the step begins)
                 solve  A·Δλ = −C − α̃·λ          (tridiagonal: forward, then back)
                        Aᵢᵢ = (wᵢ + wᵢ₊₁)·(1 + ε) + α̃ᵢ,  Aᵢ,ᵢ₊₁ = −wᵢ₊₁·(nᵢ·nᵢ₊₁),  α̃ᵢ = stretch·lᵢ ÷ h²
                 x̂ᵢ += wᵢ·(nᵢ₋₁·Δλᵢ₋₁ − nᵢ·Δλᵢ),  λ += Δλ
                 collide (5.1)

5  velocity    v = (x̂ − x) ÷ h, with friction at contacts

6  guard       a segment longer than lᵢ·(1 + Max Stretch), or shorter than lᵢ·(1 − Max Stretch),
               is set to that length by moving its later point; positions only

7  collide     once more, positions only;  x = x̂
```

- **Step 2 is one statement for every anchor.** A spring to a target, taken implicitly, is the same as moving the predicted point part of the way to the target and making the point that much heavier. So a free point, a soft anchor and a hard pin are one formula with a pull between 0 and 1, and the stretch solve that follows needs no special case (4.2). `t_before` is the target one step earlier.
- **ε is 2⁻¹², and only on a strand with two or more anchored points.** Between two pins a taut, straight strand makes the system singular (its tension is not determined). In the model, at one Newton step a substep, such a strand without ε ends 0.87% out and above its own chord; with it, within 0.008%. On a strand with one anchor or none the matrix is positive definite, ε is zero, and a hanging strand is an exact fixed point (section 10).
- **A segment whose two points are both pinned** has nothing to solve and is skipped.
- **A segment with no rest length** (padding, or a mapped length of zero) is a weld: its later point sits on its earlier one and the two move as one mass.
- **The tolerance is the solver's, not a parameter**: 1/8192 of a segment, 7 µm on the consumer's 60 mm.
- **The tension** in segment `i` is `−λᵢ ÷ h²`, in newtons for masses in kilograms. It is the solve's own by-product.
- **Step 6 is Notch's Max Stretch.** It runs after the velocity is taken, so it moves points and adds no speed. Inside the step limit it moves nothing: in the model, 0 of 207,360 segments on the consumer's motion at 16 substeps. A segment whose later point is pinned is left as it is; what bounds that one is the reach rule of 4.6.
- **As built** (14.1): the drag is `v ÷ (1 + damping·h)`; the exit is tested after each Newton step, not before; and steps 1, 4 and 5 are two loops along the strand.

### 2.6 The step limit

XPBD's derivation drops one term: how the constraint forces' directions turn as the points move (the geometric stiffness; "we use the approximation that K ≈ M"). On a rope that term is the tension straightening a bend, the thing that makes a taut string a spring sideways. Relaxation gets by through "repeated local linearizations"; a global solve treats it one Newton step at a time. Tournier et al. (2015) name the symptom, "spurious transverse vibrations when pulling hard on thin inextensible objects", and the cure.

So a step has to be shorter than the time a transverse wave takes to cross one segment:

```
h < √(m·l ÷ T)        with T the tension;  for a strand of N links carried at acceleration a:  h < √(l ÷ (a·N))
```

| Strand | At 1 g | At 10 g | At 55 g |
|---|---|---|---|
| 54 links of 0.06 m | 10.6 ms: 2 substeps of a 60 fps frame | 3.4 ms: 5 | 1.4 ms: 12 |
| 250 links of 0.06 m | 4.9 ms: 4 | 1.6 ms: 11 | 0.67 ms: 25 |
| 1,000 links of 0.06 m | 2.5 ms: 7 | 0.78 ms: 22 | 0.33 ms: 50 |

- Derived. The model agrees: 54 links through a 55 g stop hold at 16 substeps and not at 8; 1,000 links hold their length at 16 substeps and not at 4.
- **Past the limit the Newton steps stop converging.** A segment is long for a few steps, and Max Stretch holds it. The model shows no blow-up in any case run: at one substep a frame on 1,000 links the energy peaks at about twice the reference's.
- **It is a limit on resolution too.** Halving the segment length halves the step the same rope allows.
- **Drag helps**: a tip that cannot reach 100 m/s never makes the tension that needs the small step.
- **The cure is a follow-up** (R6): Tournier et al.'s geometric stiffness in the system, which turns the scalar tridiagonal solve into a block one and lifts the limit "up to several orders of magnitude".

### 2.7 Other shapes considered

| Alternative | What it buys | Why not |
|---|---|---|
| Implicit springs with a global solve (Baraff and Witkin 1998) | large steps | a sparse solve over the whole system every step, heavy numerical damping; the chain solve is the same idea where the structure makes it free |
| A workgroup per strand with shared memory and barriers (TressFX's layout) | every relaxation pass of a step in one dispatch | the baseline workgroup is 256 invocations, so 256 points a strand; it is still relaxation |
| Parallel cyclic reduction of the tridiagonal system | depth log₂ L in place of L | six to ten dispatches a step where the walk is one; right only for very long strands (R1) |
| The finishing sweep (candidate 4 after the solve) | exactly zero stretch every step | it gains energy as it corrects, catastrophically on long strands (2.2); the guard keeps its bound without its speed |
| A pointset feedback loop with relaxation kernels | no new node | the row exists because both products ship an operator |

## 3. The node

**`pointRope`, titled Rope, kind word `rope`, category "points".** Stateful: `{ reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false }`, as Point Kernel.

### 3.1 Ports

| Port | Kind | | What it is |
|---|---|---|---|
| `in`, "Strands" | pointset, requires `position` | required | The strands, as strips. Each strip is one rope. Its points are the seed pose, the anchors' targets every frame, and the rest lengths when they are measured |
| `colliders`, "Colliders" | pointset, requires `position` | optional | What the rope collides with (5.2) |
| `field`, "Height Field" | texture | optional | A height field, as Ray reads one (5.2) |
| `out`, "Strands" | pointset | | The same strips: `position` and `velocity` owned by this node, everything else by reference, the claim and the capacity unchanged |

### 3.2 Parameters

ⓢ marks a structural parameter (it changes a binding or the program). The rest are uniform writes (§V5), and an enum that is not structural is a uniform flag, so that a value never decides the plan's structure (§V453). "Map" means the parameter takes a per-point attribute in Map mode; switching a parameter into Map mode is structural, as everywhere.

**Simulation**

| Key | Label | Type | Default | Meaning |
|---|---|---|---|---|
| `updateRate` | Update Rate | number, 1 to 3,840 | 240 | Solver steps per second of the piece. Notch's Update Frame Rate, and its own example value |
| `minSteps` | Min Update Steps | number, 1 to 64 | 1 | Fewest steps in a frame |
| `maxSteps` | Max Update Steps | number, 1 to 64 | 16 | Most steps in a frame. Set equal to Min for a fixed count |
| `iterations` | Iterations | number, 1 to 8 | 4 | The most Newton steps one update step takes. It stops sooner, as soon as every segment is within 1/8192 of its length |
| `speed` | Simulation Speed | number, 0 to 4 | 1 | Scales the time a step advances |
| `gravity` | Gravity | number | 9.81 | m/s², toward −Y. Notch's Physics Root says of its own: it "should be adjusted to reflect the scale of the scene" |
| `force` | Force | vec3, Map vec3f | 0, 0, 0 | An acceleration added to every point, or to each point by its own attribute. A kernel upstream is the force affector |
| `damping` | Damping | number | 0.5 | Per second: how fast a point's velocity falls toward the Wind's. Notch's Dampening |
| `wind` | Wind | vec3, Map vec3f | 0, 0, 0 | The velocity of the air, m/s |
| `mass` | Mass | number, Map f32 | 1 | Kilograms per point. A heavy handle and a light tip are a whip |

**Rope**

| Key | Label | Type | Default | Meaning |
|---|---|---|---|---|
| `segmentLength` | Segment Length | number, Map f32 | 0 | Metres between a point and the next. 0 measures each segment of the incoming strip when the rope is seeded. Mapped, it is read at a segment's first point when the rope is seeded. (It was to be read every frame "so a strand can pay out"; 15.7 measured that and withdrew it: a winch is Length Out) |
| `restLengthScale` | Rest Length Scale | number, Map f32 | 1 | Multiplies every rest length. Notch's, "for making a rope which shrinks or expands" |
| `stretch` | Stretch | number | 0 | Compliance: the fraction a segment lengthens per newton of tension. 0 is a rope that does not stretch |
| `stretchDamping` | Stretch Damping | number | 0 | Notch's Spring Dampening. Inactive while Stretch is 0 |
| `maxStretch` | Max Stretch | number, 0 to 10 | 0.02 | The most a segment may be longer or shorter than its rest length, as a fraction, at the end of a step. Notch's, and its guard (2.5) |
| `bendStiffness` | Bend Stiffness | number, Map f32 | 0 | How hard a strand springs straight. 0 is a chain |
| `bendDamping` | Bend Damping | number | 0 | Notch's Bend Dampening |

Stretch and Bend Stiffness are each written in the form whose zero is a rope: a compliance for stretch, because the default is infinitely stiff, and a stiffness for bend, because the default is none. Bend is one constraint per interior point, `(pᵢ₊₁ − pᵢ) ÷ lᵢ − (pᵢ − pᵢ₋₁) ÷ lᵢ₋₁`, which is zero on a straight run and linear in the points, solved as XPBD with compliance 1 ÷ Bend Stiffness in one Gauss–Seidel sweep per step. The sweep is serial inside the walk, so each constraint sees the one before it. A stiff rod is not this node (R4).

**Anchors**

| Key | Label | Type | Default | Meaning |
|---|---|---|---|---|
| `anchorFirst` | Anchor First | number 0 to 1, Map f32 | 1 | How firmly the first point of each strand is held to its incoming point. Mapped, the attribute is read at that point: a weight per strand |
| `anchorSecond` | Anchor Second | number 0 to 1, Map f32 | 0 | The second point. With the first, it fixes the direction the strand leaves in |
| `anchorLast` | Anchor Last | number 0 to 1, Map f32 | 0 | The last point |
| `anchorMode` | Anchor Mode | Hard, Soft | Hard | Hard: weight 1 is the target itself. Soft: weight 1 is a spring of Anchor Strength (4.3) |
| `anchorStrength` | Anchor Strength | number, Hz | 2 | How fast a soft or partly weighted anchor draws its point in |
| `anchorDamping` | Anchor Damping | number | 1 | Damping ratio of that pull; 1 arrives without springing |
| `pinAttribute` ⓢ | Pin Attribute | attribute name | empty | An f32 weight on every point: Notch's weightmap. A point takes the larger of this and its Anchor weight |

**Reset and teleport**

| Key | Label | Type | Default | Meaning |
|---|---|---|---|---|
| `reset` | Reset | boolean | off | Holds the rope on its incoming points for as long as it is on (Feedback's Reset; the Spring SOP's) |
| `teleportDistance` | Teleport Distance | number | 0 | Metres. A strand whose first anchored point's target moves further than this in one frame is teleported. 0 is never |
| `teleportMode` | Teleport | Carry, Reset | Carry | Carry moves the strand's whole state by that jump and keeps its shape and speed. Reset puts it on its incoming points at rest (4.7) |

**Collision**

| Key | Label | Type | Default | Meaning |
|---|---|---|---|---|
| `thickness` | Collision Thickness | number, Map f32 | 0.01 | The rope's radius against every collider, metres |
| `friction` | Friction | number, 0 to 1 | 0.3 | How much of a sliding point's motion a contact takes |
| `depenetrationSpeed` | Depenetration Speed | number | 4 | m/s. The fastest a collider pushes a point out of itself (5.4) |
| `floor` | Floor Collisions | boolean | off | A plane at Floor Height. Notch's Physics Root has the pair |
| `floorHeight` | Floor Height | number | 0 | |
| `collidersInside` | Inside | boolean | off | The rope stays inside the collider spheres and tubes. Notch's Inverted |
| `colliderRadius` | Collider Radius | number | 0.1 | For collider points that carry no `radius` |
| `fieldExtent`, `fieldHeightScale`, `fieldHeightOffset` | | number | 4, 1, 0 | Ray's three, with Ray's meaning |
| `collision` ⓢ | Collision · WGSL | code | empty | A distance function (5.2). Its `struct Params` becomes controls on this node, as a kernel's does |

**Output**

| Key | Label | Type | Default | Meaning |
|---|---|---|---|---|
| `tensionOutput` ⓢ | Tension | boolean | off | Publish `tension` |

**Added after the consumer's review**, each with its table in section 15: Bend Limit and Min Bend Radius (15.2); Length Out (15.7).

### 3.3 Attributes

**Read from `in`:**

| Attribute | When | For |
|---|---|---|
| `position` vec3f | always | the seed pose; every anchor's target, every frame; the rest lengths when Segment Length is 0 |
| `live` f32 | when the edge carries it | a segment touching a padding slot has no length, so padding stays collapsed on its live end, as the curve family's R4 says |
| whatever a Map names | per parameter | weights, mass, lengths, thickness, force, wind |

After the seeding frame the incoming position of a point is read only while that point's anchor weight is above zero, and of every point on a Reset or a teleport that resets. (As built: the three stations' incoming points are read every frame whatever their weights, and every point's when a Pin Attribute is named, so that a weight rising from 0 finds a target already followed; 16.1, item 2.)

**Published on `out`:**

| Attribute | Type | Meaning |
|---|---|---|
| `position` | vec3f | the simulated point. It replaces the incoming `position` on the edge |
| `velocity` | vec3f | m/s. A pinned point's is its target's |
| `tension` | f32, optional | newtons in the segment after this point; 0 on a strand's last point |

- An incoming `velocity` or `tension` of the same type is replaced by this node's; of another type the node refuses by name (Gather's rule).
- Every other attribute passes by reference (§V197), `live` and `orient` among them.

**State, private to the node** (one packed pair): `position`, `velocity`, the target each point had last frame, and each segment's measured length. 52 bytes a point. As built it is a pair for what a step carries and two plain buffers for the rest, 128 bytes a point (14.1, 14.2).

### 3.4 What it refuses, by name (§V288)

- An edge that claims `points` or a mesh: `stripsOnEdge`'s sentence, with the Topology node as the fix. A grid is taken, and its rows are the strands.
- A closed strip. A loop makes the system cyclic (R7).
- A strip of more than 1,024 points (R1).
- A counted input, as Point Kernel and Resample refuse it.
- A parameter in Map mode that has none; a Map naming an attribute the edge does not carry, or one of the wrong type.
- More storage buffers than the baseline's eight (§V588).
- More than 1,024 collider elements (5.2).
- A Collision · WGSL whose text does not declare the function, or declares a name the module owns.

### 3.5 What Curve Frames needs after it

Nothing more than the edge carries: the strips claim, `position`, `live` by reference, and an `orient` on each strand's first point if the frame is to be seeded from the socket (`seed: Orient Attribute`). Curve Frames then replaces `orient` on every point.

- **Twist is derived, not simulated** (the curve family's C11). The frame is carried from the seed along the rope's present shape, so as a rope writhes its rings can turn about its axis. Neither product simulates twist, and Obi's manual says the same of its ropes. R4 is the row for it.
- **A strand held at both ends wants its last frame to match the claw.** Curve Frames spreads a mismatch along a closed strip only. An end seed for an open strip is follow-up R8.

## 4. Anchors and driving

### 4.1 The target

**An anchor's target is the incoming position of its own slot, this frame.** The rope does not know what moved it.

- **Within a frame the target moves in a straight line** from where it was last frame to where it is now, a share per step. Without that, a body moving at 9 m/s would move its sockets 15 cm in the first step of every frame and nothing in the rest, and a 60 Hz jolt would run down every rope. The node keeps last frame's target for this (state, 3.3).
- **A pinned point's published velocity is its target's**, the frame's move divided by the frame's delta. Section 10 tests exactly that, because it is what a snapped anchor gets wrong.

### 4.2 The pull

Every anchored point is one formula (2.5, step 2). A spring of stiffness `k` to a target `t`, with a damper `c` on the point's motion relative to the target's, stepped implicitly, is the minimum of

```
m·|x − x̂|² ÷ 2h²  +  k·|x − t|² ÷ 2  +  c·|(x − x_before) − (t − t_before)|² ÷ 2h
```

which is the predicted point moved toward the target, `x̂ ← (x̂ + κ·t + δ·(…)) ÷ (1 + κ + δ)`, with `κ = k·h² ÷ m` and `δ = c·h ÷ m`, and a point of mass `m·(1 + κ + δ)` in the solve that follows.

- **A free point is κ = 0. A hard pin is κ → ∞**: the point is the target and has no inverse mass.
- **It is unconditionally stable**, and it is exact for the spring and the stretch constraints together, not one after the other.
- **It needs no constraint of its own**, so the chain system stays tridiagonal with any number of anchors, anywhere on the strand.

### 4.3 Hard and Soft

Both are that formula. They differ in how the weight `a` becomes a stiffness, `k = m·(2π·strength)²·g(a)`:

| Mode | `g(a)` | At weight 1 | In between |
|---|---|---|---|
| Hard | `a ÷ (1 − a)` | the point is the target | a spring that stiffens without bound as the weight nears 1 |
| Soft | `a` | a spring of Anchor Strength, which lags a moving target | a weaker spring |

- **Hard is continuous from free to pinned.** That is what makes a slow hand-over land: the claw is on its rung before the weight reaches 1, and the last frame of the ramp changes nothing.
- **Soft never pins.** It is Notch's Soft Constant with the weight as its softness, and Soft Weightmap when the weight is an attribute. Its use here: a claw that reaches toward a wandering target without being snapped to it.
- Anchor Damping is a damping ratio: `c = 2·ratio·√(k·m)`.
- **Changed after slice 1** (15.4): the mass in `k` is the mass the anchor carries, the strand's, and not the point's own. With the point's own, a strand hangs metres below a half-weighted anchor. And a weight between 0 and 1 under Hard is stated as what the consumer's reach needs: a blend toward the target.

### 4.4 The weight, per frame and per strand

- A number: every strand alike. An expression on it: every strand alike, changing.
- **Map mode: a weight per strand.** `anchorLast` mapped to an attribute reads it at each strand's last point. The consumer's kernel writes `grabbing × (1 − swimming)` there, and that is "the claw lets go".
- `pinAttribute`: a weight on every point, for a cable clipped along its length, and the form cloth will want.
- Weights are per frame. They are not interpolated across a frame's steps; a weight that ramps over seconds does not need it.

### 4.5 Grab and release without a pop

**A weight that changes continuously moves its point continuously.** That is a property of the formula, not a filter on top of it. On one strand, a claw 1.5 m from its rung, the weight on a quintic from 0 to 1 over three seconds, held two, back to 0 over three (model):

| Mode, Anchor Strength | Largest move of the claw in one frame, 60 fps | The same at 120 fps | Ratio | Off the rung a tenth of a second before weight 1 |
|---|---|---|---|---|
| Hard, 1.5 Hz | 46.8 mm | 23.4 mm | 1.998 | 0.000 mm |
| Hard, 4 Hz | 66.2 mm | 33.2 mm | 1.997 | 0.000 mm |
| Soft, 1.5 Hz | 35.0 mm | 17.5 mm | 1.999 | 724 mm (it is a spring) |
| Hard, the weight stepped to 1 in one frame | 4,172 mm | | | |
| Soft, the weight stepped to 1 | 107 mm | 55 mm | 1.945 | |

- **Halve the frame and the largest move halves**: the motion is continuous. This is the test of `rig.gpu.test.ts`, on a rope.
- **A stepped weight under Hard is a pop, by definition**: weight 1 means "be there". The description says so. Ramp the weight, or use Soft, when the point is not already at its target.
- **A stepped weight under Soft is not a pop**: a force steps; a position does not.
- **A continuity test has to hold everything indexed by strand or robot fixed.** The consumer measured a 33 cm pop that was not in its rig by reading N robots in unison as one robot at N instants, when a per-robot phase made each instant a different robot. The rows above are one strand, stepped through time, at two frame rates.

### 4.6 Two anchors, and a target out of reach

A strand pinned at both ends with slack is the consumer's holding tentacle and the hanging cable. The solve handles it as it handles one pin.

**When the two targets are further apart than the rope is long**, something has to give, and it is the later anchor:

- Before the solve, a target further from an earlier pinned point than the rope between them, times `1 + Max Stretch`, is pulled in to that reach along the line to it.
- So the earlier station wins, the strand runs straight toward the target it cannot reach, and its end falls short. **Length is kept; the target is not.** This is the Curve node's Arc out of reach, in the same words.
- Model: 3.24 m of rope, the far target eased out to 4 m, Max Stretch 0. The last point stops at x = 3.240000 m.
- With Max Stretch at 0.1 the rope gives a tenth before the target is lost; with a Stretch compliance it gives like a bungee up to that.
- The gap is the consumer's `slip`. It is not published in v1.
- **As built** (16.1, item 5): the reach is measured from the nearest earlier hard pin. **A finding** (16.5): past the step limit the Max Stretch guard leaves what the solve did not close on the segment before the far pin, and the reach rule does not bound that.

### 4.7 Teleports

A rope has inertia, so an anchor that jumps 40 m in a frame is an anchor that moved at 2,400 m/s. Without help the rope is dragged across the scene: in the model, through a 960 m jump, the tip reaches 369 m/s and only the guard holds the length.

**Teleport Distance** says how far a strand's first anchored point may move in one frame before it counts as a teleport, and **Teleport** says what then happens. These are Unreal's two modes:

| Mode | What it does | For |
|---|---|---|
| **Carry** | every point of the strand moves by that jump; velocities are kept; targets are not interpolated across the jump | a world that wraps |
| **Reset** | the strand is put on its incoming points, at rest | a cut to another place or another pose |

- **The consumer needs Carry, and it is exact for it.** Its travel distance loops at 960 m (`speed_travel`, `limit: "loop"`), and its path is periodic over that distance, so once a lap every socket jumps by exactly (0, 0, −960) with the same frame around it. Carried, the frame after the jump is the frame it would have had (model: the two differ by 0).
- **Carry is a translation.** A teleport that also turns the body leaves the strand in its old attitude for a moment. Carrying the rotation needs the root's frame as an input (R9).
- **Off by default.** A threshold in metres is a guess about the scene's scale, and a default that silently carries a fast gesture would be a rope that sometimes does not whip.
- A timeline seek needs neither: it resets (6.4). A timeline lap is not a seek, and an anchor that jumps at the lap because its animation loops is a teleport like any other.
- **As built** (14.1, item 4): Carry reckons the target's own travel out of the jump, from the speed it had last frame, so a socket that wraps while it moves keeps moving. The 960 m lap is a test, exact through the wrap (14.5).
- **Reset as a teleport seeds the incoming points as they are**, like every seed: the node builds no pose, so it has no hand to flip (15.3).

### 4.8 Reset

- **`reset`**, a boolean, holds the rope on its incoming points at rest for as long as it is on. A pulse on it is "reset now", for a shot cut the document knows about. It is Feedback's parameter by name and meaning, and the Spring SOP's.
- A reset also re-measures the rest lengths when Segment Length is 0.
- The app's "reset feedback" command and a seek clear the state, and the next frame seeds (6.2).
- **What Reset holds the rope on is the incoming points, slot for slot.** The node builds no pose of its own at any seed, so there is no reference axis for a strand's chord to swing through and no side for its slack to change (15.3).

## 5. Collision

### 5.1 When, and what is guaranteed

- **Colliders act inside the stretch loop and once more at the very end** (2.5, steps 4 and 7). The last word in a step is a collider's.
- **So at the end of every step no point is inside a collider**, by its Thickness, provided Depenetration Speed lets it out in one step, which it does for any point that was outside at the step's start.
- **A point in contact is exactly on the surface**: `centre + normal × (radius + thickness)` for a sphere.
- **What that costs the length**: a push changes the segments beside it by at most the push. The next step's solve takes it back. At 960 steps a second a point moving at 10 m/s enters a surface by at most 10 mm before it is stopped.

### 5.2 Sources

**1. Floor.** A plane at Floor Height: `y ≥ floorHeight + thickness`. Notch's Floor Collisions.

**2. A second pointset, `colliders`.** A stock node can bind a second pointset today, as Gather does; the row's "when T1582b exists" is a kernel's limit, not this node's.

| The collider edge claims | Each element is | Radius |
|---|---|---|
| `points`, or anything that is not strips | a sphere at each point | its `radius` attribute, or Collider Radius |
| strips | a capsule between each point and the next, a chain per strip | `radius` at each end, blended along the segment |
| strips, with Inside on | a tube to stay within | the same |

- **The search is once per frame, in a pass of its own**, fully parallel: each rope point finds its nearest element, at where it is and at where its velocity would take it by the frame's end, and keeps the two indices. Each step then tests those two elements exactly. This is the Small Steps paper's arrangement ("collision detection once per-frame and re-using the contact set over multiple substeps").
- **Brute force.** 550 rope points against 128 elements is 70,400 tests a frame; 100,000 against 1,024 is 102 million, about what a frame can spare (derived). More than 1,024 collider elements are refused by name; a window that follows each point along a strip, or a grid, is R3.
- **Colliders are seen where they are this frame** in every step of it. A fast collider is not swept.
- **A box and a cylinder are not offered as primitives**, though Notch's primitive collision has them. Either is a line of a distance function (source 4).

**3. A height field, `field`.** Ray's convention exactly: R is a height over world x and z within ±Extent, scaled and offset. A point stays above it by its Thickness, pushed along the field's normal. For terrain.

**4. A distance function, Collision · WGSL.**

```wgsl
struct Params {
  bore: f32, // @default 2.6  The radius of the wall.
};
// Metres from `position` to the nearest surface: positive in free space, negative inside a solid.
fn collisionDistance(position: vec3f, p: Params) -> f32 { … }
```

- The node takes the function's gradient by four evaluations around the point and pushes the point out along it until the distance is its Thickness.
- `struct Params` is reflected into controls on the node, by the reflector kernels and materials use; `// @use` resolves shared modules.
- This is Notch's procedural collision: the same distance function that builds a surface collides with it.
- It runs inside the walk, four evaluations per point per round. The function should be cheap.

**The sources act together.** One node takes any of them at once, in a fixed order, and the distance function is last and so exact where two disagree (15.6). The consumer needs two: its bore as a function and its body as a capsule.

### 5.3 What the consumer's bore needs

The bore is a tube round a curve: a point is inside while its distance to the centreline is under the radius there. The tunnel also has a flat deck 0.74 of a radius below the axis, ribs that stand in 12 cm, and halls where the radius nearly doubles.

**Can the curve family give that cheaply? Yes, for the round part.**

- The centreline as a strip of 128 points, a metre apart, over the 115 m window the bore's grid already rides, with a `radius` attribute that swells in the halls. A ten-line kernel writes it from `pathAt`, as the bore's own kernel does, with a Topology node after it.
- That strip into `colliders`, Inside on. Cost: 550 × 128 tests a frame in the contacts pass, and two capsule tests per point per step.
- The radius is the ribs' crest, so nothing passes through a rib. Between ribs a rope lies up to 17 cm off the liner, which reads as lying on the ribs.
- **It does not give the deck.** A tube is round, and gravity will lay a free tentacle through the floor.

**So the bore is a distance function** (source 4), fifteen lines over the consumer's own `pathWgsl()`: the nearest point of the centreline by one Newton step from `z = position.z`, the radius there with the halls' swell, the larger of the tube's and the deck's distances, and the ribs if they are wanted. It is exact, it costs a constant per point, and it is the same text that places the wall.

The tube collider stays in v1 as the stock form, for a cable in a pipe. A collider that takes a swept profile from T1587b (a square duct, a deck) is R3's last item.

### 5.4 Friction and depenetration

- **Friction** takes a share of a contact point's sideways move in the step, up to all of it: position-based Coulomb friction, as Müller et al. and the Small Steps paper have it. 0 slides; 1 sticks.
- **Depenetration Speed** is the Small Steps paper's `v_max`: a point found deep inside a collider (a collider that appeared, a teleport without Carry) is let out at no more than this speed, so it does not leave at the speed of the error. A point that was outside when the step began is never slowed by it.
- No bounce. A rope does not.

### 5.5 Self-collision and strand against strand

Named follow-ups, with their cost (R3).

- **Within a strand**: L² ÷ 2 pairs a step. 1,458 at 54 points, serial in the walk, is affordable; 31,000 at 250 is not. It needs a sort along the strand or a grid.
- **Strand against strand**: every point against every other, as a parallel pass of its own between steps, reading the other strands as they were a step ago and moving each point half the overlap. 550 points are 300,000 tests a step; 100,000 points are 10¹⁰ and need a grid. Proximity and T1582b want the same grid.
- The consumer's ten tentacles leave ten sockets set round the body and stream back side by side; they cross when the body turns. Brute force up to a few thousand points is the first slice of this follow-up.
- Notch's Collision Thickness is for self-collision only. Here Thickness is the rope's radius against everything, and will be against itself.

## 6. State, time and determinism

### 6.1 State

One packed pair, read half and write half, as a kernel's (§V22): `position`, `velocity`, last frame's target, the measured segment length. The node is stateful, so it is never skipped (§V155). As built, the pair holds what a step carries (`position`, `velocity`, `tension`) and a buffer of its own holds what is written once a frame or once at seeding (14.1, item 3).

### 6.2 The first frame

On the run that finds its storage fresh (`firstRun`, T510: a load, a seek, a structural edit, a device loss), and on every run while Reset is on:

- `position` is the incoming point, `velocity` is zero, last frame's target is the incoming point, and each segment's length is measured.
- `firstRun` is 1 on run 0 of the seeding frame only (T1583b), so the seeding run takes the place of that frame's first step and the rest of its steps are ordinary. On the live clock the frame after a reset has a delta of zero, and they do nothing.
- **The seed has no hand.** A fresh state, Reset and Teleport with Reset are one function, and it copies the incoming points. The node builds no arc and no hang, so it makes no choice of side that a chord's direction could flip (15.3, with its test).
- **The incoming strip is the pose a rope starts in.** A straight line starts as a straight line and falls. A consumer that wants a settled first frame hands in a settled pose. Running the solver ahead before the first frame is shown (the Spring SOP's Preroll Time) is follow-up R5; it needs the seeding frame to run extra steps of the node's own length.

### 6.3 Time

**The step count and the step size follow Notch's Physics Root**, and for a reason of Loom's own.

```
steps = clamp(round(delta × Update Rate), Min Update Steps, Max Update Steps)
h     = Simulation Speed × delta ÷ steps
```

- **`delta` is the frame's timeline delta**, the one clock a frame's time and step both come from (§V172). On the live clock it is a whole number of project frames, `k ÷ fps`: one normally, more when ticks were late, at most a quarter of a second's worth (`live-clock.ts`). Offline it is `1 ÷ (fps × sub-frames)`.
- **So at an Update Rate that is a multiple of the project's rate the step is one size everywhere.** At 240 on a 60 fps project (derived):

| Frame | delta | Steps | Step |
|---|---|---|---|
| live, on time | 1/60 | 4 | 1/240 |
| live, one tick late | 2/60 | 8 | 1/240 |
| offline, 4 sub-frames | 1/240 | 1 | 1/240 |
| offline, 8 sub-frames | 1/480 | 1 (the minimum) | 1/480 |
| live, a quarter-second stall | 15/60 | 16 (the maximum) | 1/64 |
| a 50 fps project | 1/50 | 5 | 1/250 |

- **"If a frame is dropped, more steps will be added"** is the second row, with nothing kept from one frame to the next.
- **When Max clamps, the step grows and no time is lost.** The rope stays with the timeline and the track; it is less accurate for that frame, and the guard bounds what that costs. The other choice, a fixed step with an accumulator that carries the remainder over, leaves the rope behind the frame by a remainder that varies, which is the defect §V735 names. Max is also what stops the loop Notch's manual warns of, where slow frames ask for more steps.
- **Frame Rate Mode has no parameter here.** Notch's Free mode is Min equal to Max; its Fixed mode is the rule above.
- **The count is the node's to derive**, not an expression the author types. That is the first of the two engine changes (7.3). As built, the backend derives it for each frame it renders, from that frame's delta (14.1, item 1).

### 6.4 A seek

§V170: a backward seek resets stateful nodes and replays from frame 0. The rope adds no rule.

- A seek clears its buffers, the next run seeds, and the replay steps each frame once at one project frame per call.
- **Frame N reached by a replay is byte for byte frame N reached by a run that only ever went to N**, on one device, because nothing in the step depends on anything but the state, the frame's delta and the frame's inputs. This is `kernel-steps.gpu.test.ts`'s seek test, and section 10 repeats it on the rope.
- Each replayed frame costs its steps.

### 6.5 Offline is live

- **The node has no frame-mode branch**, so there is nothing for §V662 to get wrong. Realtime, fixed-step and offline run the same passes with the same arithmetic.
- **What differs is which frames exist.** A live run that drops frame 2 goes from frame 1 to frame 3 in one tick of eight steps, with the anchor on a straight line between its two samples; an export visits frame 2 and samples the anchor there. Same step size, a different anchor path, so a different rope by as much as the anchor's path bends in one frame. That is true of every stateful kernel, and it is why an export is the reference.
- **Two exports of one project are byte-identical**, on one device.

### 6.6 A lap, a pause, a zero delta

- **A timeline lap is not a seek** (T464). The state is kept. The rope reads the delta and no clock, so nothing in it wraps.
- **A paused transport renders no frames**, so the rope does not step. A step button is one frame of one project frame.
- **A step of zero length changes nothing**: every division by `h` is guarded, and the run stores what it loaded. The seeding frame is this case.

### 6.7 Its clock, declared (§V436)

Delta-driven. It reads `deltaSeconds` and nothing else: no time, no frame index, no absolute clock.

### 6.8 Randomness and order

None and fixed. No random draw; no atomics; one thread per strand, each writing only its own strand; every loop bounded by the strand's length or by Iterations. The early exit from the Newton loop depends on the data and is the same every time the data is.

### 6.9 Precision

- **The walk works relative to the strand's first point.** It subtracts that point from every position it loads and adds it back when it stores, so a strand a kilometre from the origin does the arithmetic of one at the origin. In the single-precision model, at 960 m, this takes the worst segment from 0.51% to 0.13%.
- **What is left is the stored position's own resolution**: one unit in the last place at 960 m is 0.061 mm, 0.10% of a 60 mm segment. The consumer chose 960 m for that reason.
- **1,024 links in single precision** (model, the consumer's motion, drag 0.5/s, 16 substeps): 0.17% on the worst segment, against 0.018% in double. The system's condition grows with L².
- **Across devices** `sqrt` and division are not bit-specified by WGSL, as for every float kernel. Tests use fixtures whose results are exact, or state a derived bound (section 10).

## 7. GPU plan

### 7.1 Passes per frame

| Pass | Dispatches | Threads | When |
|---|---|---|---|
| Contacts | 1 | one per point | only with `colliders` wired |
| Step | one per update step: 1 to 64 | one per strand | always |

- The step pass is wrapped in the loop region kernel steps built (T1583b): one dispatch that reads the read half of the node's pair and writes the write half, run `count` times, the encoder swapping between runs, each run with its own uniform block (`deltaSeconds` already divided, `substep`, `substeps`, `firstRun` on run 0).
- Consumers bind the write half. There is no pass after the last step.
- Iterations is a loop inside the step's shader, not more dispatches. The region's own `iterations` stays 1.
- **At the budget**: 16 steps are 16 dispatches, 17 with colliders.

### 7.2 The program

**Its own shader module** (`src/nodes/shaders/rope.wgsl.ts`), generated per configuration, with a CPU reference beside it (`src/points/rope.ts`) that is the test oracle, as `curve.ts` is. Not a `pointKernel`-generated program:

- A kernel is `process(p, ctx) → Point`, once per point, reading neighbours as they were a run ago. The chain solve is once per strand, in order, reading what it has just written.
- It binds a scratch buffer and a second pointset.
- The loop region does not care: `steps` is a declaration on any node definition, and the backend writes the frame's uniforms into any dispatch by member name.

**One invocation per strand:**

1. Load the strand's first point; work relative to it.
2. Predict and pull each point (steps 1 and 2 of 2.5), writing `x̂` into the write half, which is the working copy.
3. The bend sweep, if any.
4. Forward elimination along the strand, writing two floats a segment to scratch; back substitution from the tip, writing positions and the multiplier. Collide. Repeat to the tolerance.
5. Velocity, guard, collide, store.

- **Three to five loops over the strand** a step, each as light as Resample's length walk or lighter than Curve Frames'. (As built: two, and each about 1.6 times the weight of Curve Frames' walk; 14.1, 14.3.)
- **Bindings**, of the baseline's eight (§V588): the pair's read half, its write half (read and write), scratch, the incoming producer's buffer (one more per extra producer a Map reaches), the colliders. Four as a rule, five with colliders.
- **A fingerprint pins the program's text** once slice 1's measurement has fixed the order of its floating-point operations, as the curve family pins its short walk.

### 7.3 Engine changes

**Two, both small, both in `compiler/substeps.ts` and the declaration it reads.**

1. **The count as a rate.** `KernelStepsDeclaration` names two parameters that hold counts. The Rope's count is derived from the frame, so the declaration gains a second form:

```ts
steps: { substeps: { rate: "updateRate", min: "minSteps", max: "maxSteps" }, iterations: … }
```

   - `kernelStepCounts` and the per-frame push of the region's count evaluate `clamp(round(delta × rate), min, max)`; `prepare` is the Max's value, or 64 if it is driven.

2. **A node may emit a dispatch that is not stepped.** `applyKernelSteps` refuses a node that declares `steps` and emits anything but one dispatch ("kernel steps repeat exactly one"). The Rope with colliders emits two: the contacts pass, once, and the step. The rule becomes "exactly one dispatch that reads and writes the node's own pair", which `steppedPair` already finds per pass; the others run once, before the region, in plan order (§V168).

- `domain/types/node-definition.ts` is the frozen contract, so this lands with every test that reaches the declaration, by name (ruled with D3: no full-suite run).
- **As built** (14.1, item 1): the declaration and both changes in `substeps.ts` are as written here, and the count itself is derived at the backend from the rate the region carries, because the compiler does not see every frame a host renders.
- Point Kernel is not touched and its generated WGSL does not change (§V309).

Nothing else: a second pointset input, Map mode on a point node, `firstRun`, the per-run uniform blocks and reflected `struct Params` all exist.

### 7.4 Where red/black colouring belongs

The Rope does not use `ctx.iteration`. Colouring is how per-point passes relax constraints without two of them writing one point, and it is right where there is no order to walk:

- **A chain by relaxation** (the proof in `kernel-steps.gpu.test.ts`, and R1's fallback): link `j` has colour `j & 1`; run `r` of a substep relaxes colour `r & 1`; a closed strand of odd length needs a third colour at its seam.
- **Cloth** (section 8): a grid's edges along U are two colours, along V two more, each diagonal two more. `ctx.iteration % colours` picks the set.

One correction to the assessment while here: red/black does not converge faster per dispatch than Jacobi. For the linearised problem its spectral radius per sweep is Jacobi's squared, and a sweep is two dispatches. What it buys is that the colour relaxed last is exact, and no averaging.

### 7.5 Memory

| Points | State (52 B × 2 halves) + scratch (16 B) |
|---|---|
| 550 to 630 | 74 KiB |
| 2,750 (five robots) | 322 KiB |
| 100,000 | 11.4 MiB |
| 1,000,000 | 114 MiB |

Derived. Contacts add 8 bytes a point when colliders are wired. As built: 128 bytes a point (14.2).

### 7.6 Cost

**All derived; none measured. Slice 1 has since measured them: 14.3 has the table beside this one's ranges.** Two measured figures bound a step:

- **Per point, memory-bound**: a kernel run costs 0.050 ms at 100,000 points and 0.65 to 0.69 ms at 1,000,000 (measured, T1583b, four attributes; it settles the assessment's two estimates, 0.076 and 0.24 ms at 100,000, below the lower one). The rope touches about twice the bytes.
- **Per strand, depth-bound**: a walk's cost follows the strand's length. Curve Frames' two walks cost 0.03 ms for 1,563 × 64, 0.21 for 400 × 250, 1.21 for 98 × 1,024 and 1.26 for 976 × 1,024; a length walk alone is under 0.1 ms for 1,024 (measured, T1586b). The rope's step is three to five loops between those two weights: about 0.5 to 1.0 µs per point of strand length.

A step costs about the larger of the two.

| Points | Strands × points | One step | 16 steps | 4 steps | Relaxation, 16 runs (measured cost × 16) |
|---|---|---|---|---|---|
| 550 | 10 × 55 | at the submission floor, 0.02 to 0.07 ms | 0.3 to 1.1 ms | 0.1 to 0.3 ms | about 0.3 ms (the assessment's floor, derived) |
| 100,000 | 1,818 × 55 | 0.05 to 0.1 ms | 0.8 to 1.6 ms | 0.2 to 0.4 ms | 0.8 ms |
| 100,000 | 400 × 250 | 0.13 to 0.25 ms | 2 to 4 ms | 0.5 to 1 ms | 0.8 ms |
| 100,000 | 98 × 1,024 | 0.5 to 1.0 ms | 8 to 16 ms | 2 to 4 ms | 0.8 ms |
| 1,000,000 | 18,182 × 55 | 1.0 to 1.3 ms | 16 to 21 ms | 4 to 5 ms | 10.4 to 11.0 ms |
| 1,000,000 | 976 × 1,024 | 1.3 to 2.0 ms | 21 to 32 ms | 5 to 8 ms | 10.4 to 11.0 ms |

- **The consumer**: under a millisecond of GPU for one robot at 16 steps, and the same for five, since strands run side by side.
- **100,000 points as short strands** (hair, grass, a curtain of cables): about a millisecond at 16 steps.
- **Long strands pay by their length, and need the steps** (2.6): 1,024-point strands are 8 to 16 ms at 16 steps. That is the case R1 is for.
- **A million points** is real time at 4 steps for short strands, which the step limit allows them at 1 g.
- **Relaxation is cheaper per frame on long strands and does not hold their length** (2.3). It is the same cost on short ones.
- **Not known at all**: what a dispatch costs the CPU. The assessment recorded none, and T1604b's profile says a pass is what is expensive. Sixteen dispatches of a region are one segment for the encoder, with a swap between each.

**Slice 1 measures before anything depends on the program's bytes** (D11): the step at 10 × 55, 1,818 × 55, 400 × 250, 98 × 1,024 and 18,182 × 55, on the GPU timer, and the CPU time of 16 dispatches.

### 7.7 Limits

- `rows × cols ≤ 1,000,000`, and the packed size bound, as for every pointset.
- 1,024 points a strand (R1). 64 update steps a frame. 8 Newton steps a step.
- 1,024 collider elements.
- The eight storage bindings of the baseline.

## 8. Cloth, the sibling

A grid's rows are strips (`stripsOf`), so a grid wired into the Rope today is a curtain of separate threads. Cloth is those threads joined across. It is its own row (R2) with its own design round. What that round starts with:

**Shared with the rope, as built for it:**

- The node's shell: the state layout, seeding, Reset, Teleport, the time rule, the loop region.
- The formulation: XPBD, compliance as the stretch parameter, the predict and velocity steps, Damping toward a Wind, Mass.
- Anchors: the pull of 4.2 and `pinAttribute`, which is Notch's cloth, where the weightmap is the only way to pin.
- Colliders: every source of 5.2, and the contacts pass.
- Max Stretch as the guard; `tension` as an output.

**Extra, and why it is a separate design:**

- **The stretch solve.** A grid's constraints are not a chain. Two routes, to be measured against each other:
  - coloured relaxation in per-point passes (7.4), small steps, with long-range attachments from the pinned edge. This is the Small Steps paper's cloth and what the row sketched for rope. A patent search for long-range attachments returns US 9,070,220 B2, assigned to NVIDIA; the row should know before it leans on them.
  - the chain solve along every row, then along every column, alternately: each thread of the weave exact in turn. It needs a walk along V (the curve family's C8).
- **Shear and bend across threads**, which only relaxation reaches.
- **Air drag by the face's normal**, which is what makes a flag fly; Notch's Air Drag.
- **Pressure and volume** (Notch's three), for soft bodies.
- **Collision by triangle, and self-collision** (Notch: Off, Simple, Accurate).
- **Normals after the solve**, for the Surface that draws it.
- **Wrapped grids**: a seam makes a row a loop (R7).

## 9. Consumers

### 9.1 The sentinel's tentacle

```
kernel_strands (pointKernel, 55 points × 10 tentacles × robots: 54 rings and the hub)
    position   station 0: the first ring, where the socket holds it.  station 1: one pitch along the way the socket faces.
               station 54: where the gait wants the claw.  between: a straight run back along the tunnel (the seed pose)
    hold       on a strand's last point: grabbing × (1 − swimming)
    orient     on station 0: the socket's frame, for Curve Frames' seed
    charge, along, seed, matte: as now
  ─▶ topology_strands (Connectivity: Strips, 55 × 10·robots)
  ─▶ rope_tentacles (pointRope)
       updateRate 480 to 960, maxSteps 16, iterations 4
       gravity 1 to 3, damping 1.5                           water, not air
       segmentLength 0 (measured from the seed pose), maxStretch 0.02
       bendLimit on, minBendRadius 0.15, iterations 8          rings 0.06 m apart must not turn more than 0.4 rad (15.2)
       anchorFirst 1, anchorSecond 1, anchorLast = map(hold), anchorMode Hard, anchorStrength 1.5
       lengthOut = map(out)                                  the winch (15.7)
       teleportDistance 100, teleport Carry                  the 960 m lap
       thickness 0.05, friction 0.3
       collision = the bore's distance function with its deck (slice 5), AND colliders ◀─ the body's capsule (slice 3), together (15.6)
  ─▶ frames_tentacles (pointCurveFrames: Minimise Twist, seed Orient Attribute)
  ─▶ geometry_ring (Instances, Shape Mesh, orient = map(orient))
     resample_tip (count 1, at the end) ─▶ geometry_claw
```

**What goes from `rig.ts`** (names and lines at `36b4d516`):

- The arcs: `sinc`, `halfTurn`, `arcAt`, `turned`, `Bend`, `along`, the constants `NECK`, `ARM` and `BOW_LIMIT` (lines 284 to 329).
- The trail: `Trail`, `trailRadius`, `trailBack`, `trailShape` (344 to 421), and `strokeOpen` unless the stroke is kept as a force (below).
- In `process`: the trailing, gesturing and loose bends (522 to 543); the hold solve and the blend between holding and trailing (545 to 562); the stow test and the station's place on the arcs (564 to 577); the whole trail branch (578 to 607); the ripple (608 to 612); the per-station frame (613 to 614), which is Curve Frames'.
- A strand pinned at both ends with slack is the held arc. A strand pinned at one end, in a body's wake, with drag, is the trail. Between them is a weight.

**What stays:**

- The gait: `plant`, `swingOf`, and the swing between rungs. It says where a claw is pinned, and the rope follows that target exactly while its weight is 1.
- `grabbing`: which tentacles hold, with its quintic hand-over over some three seconds. It becomes `hold`, unchanged.
- The robot's frame, `carried`, the sockets.
- The lights: `charge`, and `along`, which Curve Frames' `curveU` can replace.
- The claw's phalanges, from the strand's end frame, as the curve family's 5.5 leaves them.

**What the consumer decides:**

- **The swimming stroke** (`strokeOpen`) flung the tips open on the beat. On a rope that is a force: `force` mapped to an attribute the kernel writes, outward from the body's axis on the stroke. The tips then arrive late by themselves.
- **Feeling about** (`gesture`): a claw drawn softly toward a wandering target. That was Anchor Mode Soft and a second Rope. After the review it is the one node under Hard with `hold` at 0.3 to 0.5: a fractional Hard weight is that blend (15.4).
- **Stowing slack in the body**: the rope and the bore hold slack now. Reeling in and paying out is Length Out, mapped per strand (15.7); a mapped Segment Length driven to zero does not hold.

**What serves the owner's words:**

- "can't move jerkily", "shouldn't glitch around and teleport": continuity is 4.5; the lap is 4.7; a step past the limit is held by the guard and adds no speed.
- "a tail should lag the body": inertia and Damping. The lag is the rope's, at every point, by how far it is from the socket.
- "too bobby": the body is not the rope's business. The rope reads the body; it does not move it (R10).

### 9.2 A cable between two moving points

```
(two movers) ─▶ curve_span (pointCurve, basis Arc, arcLength 3.24 m in Metres, segments 54)
  ─▶ rope_cable (anchorFirst 1, anchorLast 1; gravity 9.81; damping 0.5)
  ─▶ frames_cable ─▶ sweep or instances
```

- The Arc is the seed pose and both targets, every frame, at exactly the cable's length: its stations are equal chords, so Segment Length 0 measures the right thing.
- The rope hangs it as a catenary and swings it as the ends move.
- When the movers part further than the cable is long, the first end holds and the last falls short, as the Arc's own end does.
- Model: the two pins between 2 m and 3.2 m apart on 3.24 m of rope, swinging, 16 substeps: worst segment 0.0094%, one Newton step a substep.

### 9.3 A whip driven from one end

```
line_whip (pointLine, 64 points over 2 m) ─▶ transform_hand (the hand's position and turn) ─▶ kernel_taper (mass: 8 at the handle to 0.25 at the tip)
  ─▶ rope_whip (anchorFirst 1, anchorSecond 1; mass = map(mass); gravity 9.81; damping 0.1; updateRate 960, maxSteps 32, iterations 6)
  ─▶ frames_whip ─▶ sweep
```

- The first two points are the handle: where it is and which way it points.
- **The taper is what cracks.** A wave carries its momentum into less and less mass. The chain solve has no trouble with a mass ratio, where relaxation loses it.
- The tip's speed is bounded by the step (2.6). A whip is the case that wants a high Update Rate and a short strand.

## 10. Tests

On Dawn through the compiler and the backend, red-verified, with the wire-cut case wherever a wire or a mapped parameter is involved. Values are exact where the fixture allows, and otherwise a bound derived here; no bands chosen to pass (§V147). Every GPU result is also held to `src/points/rope.ts` at single precision. Fixtures follow `kernel-steps.gpu.test.ts`: 16 links of 2⁻¹⁰ m, gravity 8, a frame of 1/64 s, so that every step and every product is a dyadic fraction.

**The hanging chain**

- **Sag.** One strand hung from its first point along −Y, at 1, 4 and 8 update steps, 64 frames. With one anchor ε is zero, the links' directions are exactly (0, −1, 0), every pivot of the elimination is exactly 1, and the solve returns each point to where it hung: **the sag is 0, bit for bit, at every step count.** The relaxation kernel on this same fixture sags 128·g·h²: 2⁻⁸ at 8 substeps, a quarter of the chain's length. The assessment's formula for explicit springs, `g·h²·L(L+1) ÷ 2`, is the other number this replaces.
- **Tension.** With Tension on, segment `k` reads exactly `(16 − k) × 8` newtons: 128 at the top, 8 at the tip.
- **With a compliance.** Stretch 2⁻¹⁰, Max Stretch 1. Segment `k` stretches by 2⁻¹⁷·(16 − k) and the chain by 2⁻¹⁷ × 136 = 0.00103759765625 m, the closed form `α·m·g·L(L+1) ÷ 2` with `α = stretch × l`. The test hangs the chain at exactly that length and reads that every segment stays within 1/8192 of a segment of it (the solver's own exit), at 1, 4 and 8 steps: a fixed point whatever the step, which is XPBD's claim. The control is Stretch 0, where the chain draws up to its rest length.
- If the device's square root is not exact on the perfect squares of the first two, they too become "within 1/8192 of a segment", and slice 1 says which it was.
- The seeding run takes the place of the first frame's first step, as in the kernel-steps test.

**Free fall**

- **A released anchor.** That hanging strand, an exact fixed point, with Damping 0, has Anchor First driven from 1 to 0 at frame 4. From then every point is lower by exactly `g·h²·k(k+1) ÷ 2` after `k` steps (2⁻¹⁵ × 2,080 = 0.0634765625 after 64 steps of 1/512 s), every segment is exactly its length, and `velocity.y` is exactly `−g·h·k`: it falls at g, as one body.
- **From a start that is exact on any device.** The same strand with Anchor First 0 and Reset on for four frames, then off: the same numbers. Reset holds the strand on its incoming points, so this does not lean on the hanging fixed point.
- The control: the anchor left on, and the first point has not moved.

**A moving anchor**

- **It is its target.** The pinned point's `position` is bit-equal to the incoming point, every frame.
- **Its velocity is the target's.** An anchor moved 2⁻⁴ a frame reads `velocity` = 2⁻⁴ ÷ delta exactly. A solver that snapped the anchor in the first step reads 0 there. This is the test that the target is interpolated.
- **Inertia.** A strand towed along its own axis at a constant speed and then released (zero gravity, zero damping) keeps that velocity at every point, bit for bit.
- **Length.** A strand whose anchor sways inside the step limit, the limit derived in the test from `h < √(l ÷ (a·N))` for the fixture's acceleration: no segment is ever more than 1/8192 from its length.
- **Momentum.** A free strand left writhing: its centroid advances by the same vector every frame, to a bound of one unit in the last place per point per step. Red-verified against a correction applied to one end of a segment only.
- **The guard.** An anchor moved a hundred lengths in one frame with Teleport off: no segment ends a frame beyond `1 + Max Stretch`, to a unit in the last place. Cut Max Stretch to 10 and one does.

**Steps and time**

- **Notch's rule.** At Update Rate 256 on the 64 fps fixture a frame is 4 steps. One tick of two frames (8 steps) equals two ticks of one frame, byte for byte, for a strand whose anchor stands still.
- **Sub-frames.** Four sub-frames of one step each equal one frame of four steps, byte for byte, on the same strand.
- **No mode.** The same frames as `fixed-step`, `offline` and `realtime` are byte-identical.
- **Seek.** Play to frame 5; reset temporal history; replay to 3: the bytes of a run that only went to 3, and not those at 5. The pattern of the kernel-steps test.
- **A step of no length.** A frame of delta 0, its anchor still, leaves every byte as it was.

**Anchors**

- **A weight per strand.** Two strands, `anchorLast` mapped to an attribute that is 1 on one and 0 on the other: one hangs from both ends, one from its first. Cut the map and both follow the parameter.
- **Out of reach.** A straight strand along +X whose last target is eased to 1.25 lengths away, Max Stretch 0: the last point is exactly one length from the first, at x = 2⁻⁶, on the line to the target.
- **Grab and release.** ONE strand, everything indexed by strand held fixed. The last point's weight on a quintic over 192 frames: the largest move of that point in a frame, at 64 fps and at 128 fps, is in a ratio between 1.8 and 2.2 (the model reads 1.998). The control is the weight stepped in one frame, which moves the point by the whole gap. This is the family's one inequality, in the form `rig.gpu.test.ts` and the Arc's test already use: a ratio of two measured maxima whose closed form is 2.
- **Hard lands.** On the last frame of that ramp, and on every frame while the weight is 1, the point is bit-equal to its target. Under Soft at weight 1 it is not, by more than a segment.

**Teleport and reset**

- **Carry.** A strand mid-swing; its anchor jumps by (0, 0, −64), Teleport Distance 8: every velocity is bit for bit what it was, and every point is where it was plus the jump, to a unit in the last place at the new place.
- **Reset mode**: every point is its incoming point and every velocity is zero.
- **Off**: some point is not where Carry would have put it.
- **Reset on**: the same, for as long as it is on; and with Segment Length 0 a strand reset onto a longer incoming strip has the longer rest lengths.

**Collision**

- **A sphere.** A strand dropped across a sphere of radius 2⁻³ with Thickness 2⁻⁶: for every point, at every frame, the squared distance to the centre is at least (2⁻³ + 2⁻⁶)², to a unit in the last place.
- **Exactly the thickness.** A strand of two points falling straight onto the sphere's pole comes to rest with its lower point at exactly `centre.y + 2⁻³ + 2⁻⁶`.
- **Wire cut**: with the colliders edge cut, a point is inside.
- **Inside.** A strand swung in a tube stays within `radius − thickness` of its centreline; with Inside off it leaves.
- **The floor**, a height field against Ray's own readback of the same field, and a distance function that is the same sphere, each to the same statement.

**Definition tests** (headless): every refusal sentence of 3.4; the derived step count for every row of 6.3's table; a Rope with nothing optional wired binds four storage buffers and emits one dispatch inside one region, and with colliders five and a second dispatch before it.

**Reported, not asserted**: the measurements of 7.6.

**As built, and added since.** 14.5 lists slice 1's tests file by file, and 14.4 says which are exact on the device (all that this section claimed exact; no fallback was needed). Added by the review: the bend limit's tests (15.2), a fractional weight's rest and its following of a moving target (15.4), every seed in every direction (15.3, built), the 960 m lap by itself (14.5, built), the winch (15.7), and a fast pin in slice 2's measurement (15.5). Slice 1 has one anchor, so this section's tests of a second pin, of weights per strand and of the reach rule are slice 2's.

## 11. Build plan

### 11.1 Slices

Each is shippable and each is a prefix of the whole: the names, the attributes, the step and its order are fixed by the slice that introduces them.

| | Slice | Contents | Tests | What it unblocks |
|---|---|---|---|---|
| 1 | The strand | the node, strips in and out, state and seeding; the rate form of `steps` (7.3); Update Rate, Min and Max Update Steps, Iterations, Simulation Speed; Gravity, Force, Damping, Wind, Mass; Segment Length, Rest Length Scale, Stretch, Max Stretch; Anchor First as a number, Hard; `velocity`, `tension`; `src/points/rope.ts`; the measurement that fixes the program | the hanging chain, free fall, a moving anchor, steps and time, the refusals | a rope that hangs from a moving point |
| 2 | Anchors | Anchor Second and Last; Map mode on all three; Soft, Anchor Strength, Anchor Damping; the reach rule; Reset; Teleport Distance and mode; `pinAttribute` | anchors, teleport and reset | **the consumer's first step**: the trail and the held arc leave `rig.ts` |
| 3 | Colliders | Thickness, Friction, Depenetration Speed; the floor; the `colliders` pointset with spheres, capsule chains and Inside; the contacts pass, and the unstepped dispatch it needs (7.3) | the sphere, the tube, the floor | a round bore; cables in pipes |
| 4 | Bend | Bend Stiffness, Bend Damping, Stretch Damping | a three-point strand against the constraint's closed form | a strand that leaves its socket along it; antennae |
| 5 | A distance function | Collision · WGSL with reflected Params | the same sphere as a function | **the consumer's bore**, with its deck |
| 6 | A height field | the `field` input | against Ray | ropes on terrain |

- Slices 3 and 4 depend only on 1. Slice 5 depends on 3 for the contact step.
- **For the consumer the order is 1, 2, then 5 by way of 3.** After slice 2 its tentacles are ropes with no walls, which works under water with low gravity and is wrong the moment one hangs.
- **Changed after the consumer's review** (15.1): the order is 1, 2, 4 with the bend limit, 5, 3. Slice 5 no longer depends on slice 3, and slice 6 is not planned. Slice 4 gains Bend Limit and Min Bend Radius; slice 2 gains Length Out.
- **Slice 1 as built is narrower than its row**, by the coordinator's brief: no Force, Wind, Segment Length or Stretch Damping, and Reset and Teleport moved up from slice 2 (14).
- **Slice 2 as built** (16): the row's contents, with Segment Length as a number added and Length Out left to its own slice.

### 11.2 Accepted limitations, as follow-up rows

| | Row | Why it is not in v1 |
|---|---|---|
| R1 | Strands longer than 1,024 points | the walk's cost follows the strand's length. The blocked form the curve family built (a summary per block, a fold, a write) fits a tridiagonal solve as a Schur complement on the block seams; parallel cyclic reduction and coloured relaxation are the alternatives. Chosen by measurement |
| R2 | Cloth | section 8. Its own design round |
| R3 | Self-collision; strand against strand; more than 1,024 collider elements; colliders swept between frames; a collider that takes T1587b's swept profile | a neighbour grid, which Proximity and T1582b also want; brute force up to a few thousand points first |
| R4 | Twist as state, and stiff rods | a frame per segment in the state and a banded solve (Kugelstadt and Schömer 2016; Deul et al. 2018). The curve family's C11 |
| R5 | Pre-roll | the seeding frame has to run extra steps at the node's own step size, which the region cannot ask for today |
| R6 | The geometric stiffness in the chain system (Tournier et al. 2015) | lifts the step limit of 2.6. The system becomes block tridiagonal, three by three |
| R7 | Closed strands | a cyclic tridiagonal system (one extra solve and a correction). A wrapped grid needs it too |
| R8 | Curve Frames: an end seed for an open strip, the mismatch spread along it | a held claw's frame. A change to Curve Frames, not to the rope |
| R9 | Teleport Carry with the body's turn | the root's `orient` this frame and last |
| R10 | The rope pulls its anchor | the tension read back to the value graph a frame late and fed to what moves the body. It needs the point-to-scalar reduce (the curve family's C12) and a value loop with a delay in it (T1600b) |
| R11 | A rest shape from the incoming strip | bend toward the animated pose, not toward straight: a tail that returns to its rig. Hair wants it |
| R12 | Drag by direction | a rope crossing the air feels more of it than one sliding along itself. What makes an eel and a streamer |
| R13 | A warning when a strand ends a step beyond its tolerance | a GPU fact; the point-to-scalar reduce again |
| R14 | Tearing | cut where `tension` passes a threshold. The strips claim has no way to say a strand ended early except `live` |
| R15 | Branches | a tree is still a direct solve (Deul et al.); a strip is not a tree |
| R16 | Lengths and stiffness in a material's units, per metre | so a rope resampled to twice the points is the same rope. Every per-segment parameter here changes meaning with the pitch, as Notch's do |
| R17 | The gap to an out-of-reach target, published | the consumer's `slip` |
| R18 | Short strands solved in function-local arrays | slice 1 measured many short strands at 1.5 µs a point a step, three times a plain kernel, because the working values are a storage buffer read and written per point per loop (14.3). A program for strands of up to 64 points that keeps them in locals is the thing to measure |
| R19 | A plan-level refusal when a stepped dispatch's uniform block uses one of the backend's names for something else | the backend writes `iterations`, `substep`, `seed` and the rest by name; the Rope lost its Newton cap to that until a test found it (14.1, item 7). Today one definition test guards one node |

### 11.3 Decisions to rule

Each with the recommendation.

- **D1. The method.** Recommended: XPBD in small steps with each strand's stretch constraints solved together as a tridiagonal system, Newton steps to a tolerance, and no long-range attachment. The row and the assessment sketched red/black relaxation on kernel steps with long-range attachments; at the row's own budget the model puts that at 31% on the worst segment and this at 0.012% (2.3). Alternative: build the row's sketch, accept the stretch, and spend it down with substeps.
- **D2. The program.** Recommended: the node's own shader module, one invocation per strand, on the kernel-steps region; Iterations a loop in the shader; 1,024 points a strand in v1. Alternative: generate it through `pointKernel`, which fits relaxation and not a solve.
- **D3. The engine changes.** Recommended: a rate form on `KernelStepsDeclaration`, and one unstepped dispatch allowed beside the stepped one (7.3). Alternatives: a hidden Substeps parameter whose default is an expression; the nearest-collider search inside the first step of each frame, serial along the strand.
- **D4. Iterations.** Recommended: the most Newton steps in a step, default 4, with the exit at 1/8192 fixed in the solver. Alternative: a fixed count with no exit, simpler and dearer.
- **D5. Max Stretch.** Recommended: a guard on positions after the velocity is taken, default 2%, on both sides of the rest length. Alternative: Notch's two-value Stretch Mode with Unlimited as a choice.
- **D6. Anchors.** Recommended: the pull of 4.2; weights as numbers from 0 to 1 with Map mode; Hard and Soft as two shapes of one formula; Anchor Strength in hertz; the earlier station wins when two cannot both be met. Alternative: Notch's three modes as an enum, with booleans for the three stations and a weightmap input.
- **D7. Rest lengths.** Recommended: measured from the incoming strip when seeded, or a number, or a mapped attribute read every frame. The curve family's 5.4 says "rest lengths are the input's segment lengths"; read every frame that would make a moving anchor stretch its own last segment. Alternative: the incoming strip's lengths every frame, with the consumer keeping an exact two-ended curve upstream.
- **D8. Teleport and Reset.** Recommended: Teleport Distance off by default, Carry or Reset, and a Reset boolean as Feedback's. Alternative: a default threshold, as Unreal has.
- **D9. Time.** Recommended: Notch's rule (6.3), default 240 with 1 to 16 steps, no accumulator, no Frame Rate Mode. Alternative: a fixed step with an accumulator, which trades a varying lag for a constant step.
- **D10. Collision.** Recommended: colliders have the last word in a step; the sources of 5.2 in the slices of 11.1; the distance function as a code parameter in v1 because the first consumer's wall needs it. Alternative: the tube alone in v1 and the function as a follow-up.
- **D11. The measurement gate.** Recommended: slice 1 measures the step at five layouts and the CPU time of 16 dispatches before the program's text is pinned, and D1 is revisited if a 55-point step costs several times Curve Frames' walk.
- **D12. State and names.** Recommended: `position` and `velocity` as state, where the row had `simPosition` and `prevPosition` (the previous position is the read half; velocity is what damping, friction and consumers want); the output's `position` replaces the incoming one; `pointRope`, "Rope", `rope`; `velocity`, `tension`; the keys of 3.2. Stretch as a compliance and Bend Stiffness as a stiffness, each with zero meaning a rope.
- **D13. Gravity and forces.** Recommended: Gravity a number toward −Y as Notch's, and Force a vec3 with Map mode for everything else. Alternative: one vec3.
- **D14. Closed strips** refused in v1 (R7), and a grid's rows taken as separate strands.
- **D15. Pre-roll** as a follow-up (R5), with the incoming strip as the starting pose.
- **D1 to D15 were ruled as recommended on 2026-10-05**, D3 without a full-suite run. **D16 to D23**, from the consumer's review and from slice 1, are in 15.8 and were ruled as recommended on 2026-10-06. **D24 to D29**, from slice 2, are in 16.10.

### 11.4 What this design has not verified

- **Anything on a device.** Every cost in 7.6 is derived. Whether a 55-point walk sits at the submission floor, and what 16 dispatches cost the CPU, is slice 1's first job (D11).
- **Exactness on the device.** The bit-exact tests of section 10 hold in the arithmetic; they lean on the device's square root being exact on perfect squares, as the curve family's exact tests already do. Each has its fallback written beside it.
- **Bend, collision and friction** are not in the model. Their order in the step and their guarantees are design; their constants (one sweep of bend a step, two collider candidates a point) are first guesses to be checked against the reference in their slices.
- **The loop region under a node that is not a Point Kernel.** Read from `substeps.ts`, `plan.ts` and the backend, where nothing names the kernel; not run.
- **Single precision past what Appendix A ran**: one motion, at 54, 1,000 and 1,024 links.
- **Since verified by slice 1** (14.3, 14.4): the costs; exactness on the device, which held everywhere it was claimed; and the loop region under a node that is not a Point Kernel. Still not verified: everything in 15.9.
- **The look.** That a rope with these defaults reads as the consumer's squid is the consumer's to judge on slice 2. The model says it lags, keeps its length and does not pop; it does not say it is beautiful.

## 12. Found on the way

Not fixed; not in scope.

- **The consumer's world jumps 960 m once a lap.** `speed_travel` loops at the path's period and `pathAt` returns `(x, y, z)`, so every socket's world z falls by 960 at the wrap. A closed-form rig cannot see it. Anything with state on those points can, and needs 4.7's Carry.
- **The assessment's convergence figure is for a chain pinned at both ends.** It gives cos(π ÷ 55) per Jacobi pass and "red/black halves that". For a strand pinned at one end the smooth mode is a quarter wave, cos²(π ÷ 108) per red/black sweep: 1,182 sweeps for a factor of e, and a sweep is two dispatches. Red/black and Jacobi converge at the same rate per dispatch (7.4).
- **`KernelStepsDeclaration` can name only parameters that hold a count** (7.3).
- **Curve Frames has no end seed** (R8).
- **Notch's Collision Thickness is self-collision's**, by its own description. The row lists it as if it were the rope's radius against colliders.
- **A patent search for long-range attachments returns US 9,070,220 B2** (NVIDIA). Noted for R2; nothing here uses them.
- **The backend writes a stepped dispatch's run numbers into any uniform member that has one of their names** (`deltaSeconds`, `substep`, `substeps`, `iteration`, `iterations`, `firstRun`, `seed`, and the frame's `timeSeconds`, `frameIndex`, `pointer`, `absTimeSeconds`, `absFrameIndex`). A node that uses one of those names for a value of its own reads the backend's, in silence. Found in slice 1 (14.1, item 7); R19.
- **Point Kernel's Substeps description offers `clamp(ceil(delta * 240), 1, 16)`** as the rate form. `ceil` and `round` agree on every delta the clocks produce at a rate that divides evenly; at 144 fps both give 2. No change needed.

## 13. Sources

The reference survey: `docs/td-notch-mechanisms-2026-10-05.md`. The assessment: `docs/point-kernel-substeps-assessment-2026-10-05.md`. The neighbours: `docs/curve-family-design-2026-10-05.md`, `docs/mesh-instancing-design-2026-10-05.md`.

Notch, manual 2026.2, read 2026-10-05:

- Rope Deformer: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/physics/rope-deformer/
- Cloth Deformer: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/physics/cloth-deformer/
- Deformers, Physics: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/physics/
- Physics Root: https://manual.notch.one/2026.2/en/docs/reference/nodes/physics/physics-root/
- Force Affector: https://manual.notch.one/2026.2/en/docs/reference/nodes/physics/affectors/force-affector/
- Collision Mesh: https://manual.notch.one/2026.2/en/docs/reference/nodes/physics/collision-mesh/
- Primitive Collision Affector: https://manual.notch.one/2026.2/en/docs/reference/nodes/particles/affectors/primitive-collision-affector/
- Particle Root: https://manual.notch.one/2026.2/en/docs/reference/nodes/particles/particle-root/

TouchDesigner, read 2026-10-05:

- Spring SOP: https://docs.derivative.ca/Spring_SOP
- Particle POP: https://docs.derivative.ca/Particle_POP
- Constraint COMP: https://docs.derivative.ca/Constraint_COMP
- "Spring POP equivalent" (staff reply): https://forum.derivative.ca/t/spring-pop-equivalent/634487
- "Volume Constraint Soft Body" (staff reply): https://forum.derivative.ca/t/volume-constraint-soft-body/553728
- chainGpu Physics Simulation Tool (community): https://derivative.ca/community-post/asset/chaingpu-physics-simulation-tool/68172
- Constraint Simulation Tool (community): https://derivative.ca/community-post/asset/constraint-simulation-tool/65109

Other products:

- Unreal Engine, `EClothingTeleportMode`: https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/ClothingSystemRuntimeInterface/EClothingTeleportMode (the page refused a direct fetch; the three values and their descriptions are from the search result for it)
- Obi Rope, rope setup: https://obi.virtualmethodstudio.com/manual/7.0/ropesetup.html
- Blender's XPBD Solver node is cited in the assessment; its page returned only navigation here and was not re-read.

Method, read here from the papers themselves:

- Macklin, Müller, Chentanez, "XPBD: Position-Based Simulation of Compliant Constrained Dynamics", Motion in Games 2016, doi 10.1145/2994258.2994272. https://matthias-research.github.io/pages/publications/XPBD.pdf (sections 1 to 5: eq. 16, the linear system; eq. 26, damping; "K ≈ M")
- Macklin, Storey, Lu, Terdiman, Chentanez, Jeschke, Müller, "Small Steps in Physics Simulation", SCA 2019, doi 10.1145/3309486.3340247. https://mmacklin.com/smallsteps.pdf (all of it: substeps against iterations; collision once per frame; eq. 10, the depenetration speed; the 1:100,000 chain)

Method, from their abstracts and records:

- Müller, Heidelberger, Hennix, Ratcliff, "Position based dynamics", Journal of Visual Communication and Image Representation 18(2), 2007, doi 10.1016/j.jvcir.2007.01.005.
- Han, Harada, "Tridiagonal Matrix Formulation for Inextensible Hair Strand Simulation", VRIPHYS 2013, doi 10.2312/PE.vriphys.vriphys13.011-016. https://diglib.eg.org/handle/10.2312/PE.vriphys.vriphys13.011-016
- Deul, Kugelstadt, Weiler, Bender, "Direct Position-Based Solver for Stiff Rods", Computer Graphics Forum 37(6), 2018, doi 10.1111/cgf.13326. https://animation.rwth-aachen.de/publication/0557/
- Goldenthal, Harmon, Fattal, Bercovier, Grinspun, "Efficient Simulation of Inextensible Cloth", SIGGRAPH 2007. https://www.cs.columbia.edu/cg/ESIC/esic.html
- Tournier, Nesme, Gilles, Faure, "Stable Constrained Dynamics", SIGGRAPH 2015. https://hal-lirmm.ccsd.cnrs.fr/hal-01157835v2
- Müller, Kim, Chentanez, "Fast Simulation of Inextensible Hair and Fur", VRIPHYS 2012, doi 10.2312/PE/vriphys/vriphys12/039-044. https://diglib.eg.org/handle/10.2312/PE.vriphys.vriphys12.039-044
- Kim, Chentanez, Müller-Fischer, "Long Range Attachments: A Method to Simulate Inextensible Clothing in Computer Games", SCA 2012, pp. 305–310. The patent: https://patents.google.com/patent/US9070220
- Bailey, Lowe, "MILCH SHAKE: An efficient method for constraint dynamics applied to alkanes", Journal of Computational Chemistry 30, 2009, pp. 2485–2493. https://dare.uva.nl/id/70ba7de5-7da0-4ff2-9ab7-cf885694e868

For the bend limit (15.2), from their abstracts and records, read 2026-10-06:

- Han, Harada, "Real-time Hair Simulation with Efficient Hair Style Preservation", VRIPHYS 2012, doi 10.2312/PE/vriphys/vriphys12/045-051. https://diglib.eg.org/handle/10.2312/PE.vriphys.vriphys12.045-051 (local and global shape constraints as positional goals, relaxed before the edge-length constraints; TressFX)
- Han and Harada 2013, Müller, Kim and Chentanez 2012, and Deul et al. 2018, all above: the tridiagonal solve is for length only; Follow The Leader is one positional pass with a velocity correction; the direct solver for stiff rods puts bend and twist in the system with stretch.

Method, cited from memory and not re-read:

- Baraff, Witkin, "Large Steps in Cloth Simulation", SIGGRAPH 1998.
- Provot, "Deformation Constraints in a Mass-Spring Model to Describe Rigid Cloth Behavior", Graphics Interface 1995 (a limit on stretch as a separate pass).
- Kugelstadt, Schömer, "Position and Orientation Based Cosserat Rods", SCA 2016.
- AMD TressFX (a thread group per batch of strands).
- WebGPU's default limits (256 invocations in a compute workgroup).

## 14. Slice 1 as built (2026-10-06)

The strand and its time: `pointRope` ("Rope", kind `rope`), strips in and strips out, `position` and `velocity` as state, stepped by the kernel-steps region at a rate. Everything in this section was run on Dawn (Metal, this machine) unless it says model.

**Files.** `src/points/rope.ts` (the CPU reference, single precision, the oracle), `src/nodes/shaders/rope.wgsl.ts` (the same step in WGSL, operation for operation), `src/nodes/definitions/point-rope.ts`, and the engine changes in `src/compiler/substeps.ts`, `src/compiler/frame-compile.ts`, `src/runtime/backend/plan.ts`, `src/runtime/backend/vgpu/vgpu-backend.ts`, `src/app/animate-parameters.ts` and `src/domain/types/node-definition.ts`.

**Parameters in slice 1:** Update Rate, Min and Max Update Steps, Iterations, Simulation Speed, Gravity, Damping, Mass, Rest Length Scale, Stretch, Max Stretch, Anchor First, Reset, Teleport Distance, Teleport (Carry or Reset), and the Tension switch. Force, Wind, Segment Length and Stretch Damping are in section 3.2 and not in this slice. Any parameter in Map mode is refused by name.

### 14.1 Where the build differs from sections 2 to 7

Each is a change to what was ruled, with its reason. None changes the method (D1).

1. **The step count is derived by the backend, not by the compiler** (7.3 said the compiler's per-frame push evaluates it).
   - The structural compile has no frame. The app's per-frame compile runs only for a document in which something animates. The headless harness and the MCP server each compile on their own schedule. A count the compiler owned would be right in one of those hosts.
   - So the region carries the rate and its two clamps as values (`KernelStepsDescriptor.rate`), and the backend computes `clamp(round(delta × rate), min, max)` for each frame it renders, from that frame's own delta (`rateSubsteps`, the one place the rule is written). The compiler states the count of the frame it was compiled at with the same function.
   - Measured: with the backend's derivation taken out, a Rope in a document where nothing animates runs one step a frame at every frame rate; three of the four whole-stack tests go red and only the animated one stays green (`src/tests/headless/rope-steps.gpu.test.ts`).
   - This touched `vgpu-backend.ts`: a map of rates per region, three more names accepted on a region's value push, and five lines in `render()` before the step counts are resolved.
2. **The step is two loops along the strand, not three to five** (7.2).
   - The first version made four (predict, eliminate, substitute, finish) and measured three to four times Curve Frames' two walks at every strand length. That was D11's stop condition.
   - Now the prediction is folded into the forward elimination and the stored position, velocity and tension into the back substitution. A step that converges in one Newton step and breaks no stretch limit is two loops. Each further Newton step is two more. The Max Stretch guard is a third loop only on a step that left a segment beyond it.
3. **Rest lengths and the anchor's history are not in the stepped pair** (3.3 and 6.1 said one packed pair).
   - The region swaps the pair between runs, so every run must write every word of it. Values written once a frame, or once at seeding, would be copied by every run.
   - They live in a buffer of their own, two vec4f a point: the target the point's anchor had when the last frame ended with the measured length of the segment after it, and how fast that target was moving.
4. **Carry is dead reckoning, not "move by the jump"** (4.7).
   - On the frame of a wrap the target goes from 959.875 m to 0. That difference is the jump of −960 m and the eighth of a metre the socket travels in any frame. Moved by the whole difference, the strand lands in the right place with the socket standing still in it for one frame: every point reads 0 m/s on that frame.
   - The node keeps the target's speed from the last frame. On a teleport it takes the target to have come from `target − speed × frame`, moves the strand by the rest, and tows on. What is lost is the anchor's acceleration over that one frame.
   - The lap test is exact through the wrap (14.4).
5. **Drag is `v ÷ (1 + damping·h)`**, the implicit form, where 2.5 wrote `e^(−damping·h)`. It is as stable, agrees to second order, and a division rounds the same on the device and in the reference where an exponential does not. Wind is not in this slice.
6. **Convergence is checked after each solve, without a square root.** 2.5 tested before each Newton step. The built step always takes one Newton step and then reads `(|d|² − l²) ÷ 2l` for each segment as it stores it, which is the distance from its length to first order. It stops when every segment is within `l ÷ 8192 + 10⁻⁷ m`.
7. **A naming hazard in the uniform block, found by a test.** The backend writes a stepped dispatch's own `iterations` (runs per substep, 1 here) into any uniform member of that name. The block first called its Newton cap `iterations`, so the device took one Newton step whatever the parameter said, and the swaying strand stood at one and a half tolerances. The member is `solves`. A definition test now holds that the block declares none of the backend's names except the four it wants (`deltaSeconds`, `substep`, `substeps`, `firstRun`).
8. **Past a Max Stretch of 1 only the long side limits.** `1 − Max Stretch` is clamped at zero; a negative shortest length squared read every segment as too short and ran the guard's loop on every step.

**What slice 1 does not do, on purpose:**

- One anchor, the strand's first point. A weight between 0 and 1 is the pull of 4.2 with Anchor Strength fixed at 2 Hz and a damping ratio of 1; 15.4 says what that showed.
- `live` is not read. A padding segment is an ordinary segment of no length whose points keep their mass. The weld of 2.5 is slice 2's.
- ε (2.5) is not there: with one anchor the system is positive definite.

**The one existing test that changed:** the list of step declarers in `src/compiler/kernel-steps.test.ts` is now `["pointKernel", "pointRope"]`, and its count checks apply to count declarations only. Every other kernel-steps test is byte for byte what T1583b left.

### 14.2 Memory as built

| | Bytes a point |
|---|---|
| The stepped pair: `position` and `velocity`, two halves | 64 (68 with Tension), on 256-byte region bases |
| Kept: anchor target, rest length, anchor speed | 32 |
| Scratch: working position, inverse mass, two coefficients, the multiplier | 32 |
| Total | 128 |

Section 7.5 derived 120. A million points are 122 MiB.

### 14.3 The measurement (D11)

Dawn on Metal, Node, 100 frames a run, best of 7 runs. "Wall" is CPU and GPU together with the queue drained, less the same graph without the node. The GPU timer's quantum on this device is 0.066 ms. The strands start level and swing down from sockets that sway, so a step is real work. The machine was shared with other sessions; the small layouts moved by a factor of two between runs.

| Strands × points | Curve Frames, two walks | Rope, a step, at 16 steps a frame | at 4 | at 1 | Design's range for a step (7.6) |
|---|---|---|---|---|---|
| 1 × 55 | 0.03 | 0.03 to 0.05 | 0.04 to 0.10 | 0.07 to 0.18 | |
| 10 × 55 | 0.04 | 0.07 to 0.14 | 0.09 to 0.22 | 0.13 to 0.53 | 0.02 to 0.07 |
| 1,818 × 55 | 0.05 | 0.11 to 0.12 | 0.15 to 0.23 | 0.32 to 0.45 | 0.05 to 0.1 |
| 400 × 250 | 0.22 | 0.38 to 0.40 | 0.75 to 0.91 | 1.50 to 1.93 | 0.13 to 0.25 |
| 98 × 1,024 | 0.90 | 1.41 to 1.43 | 4.7 | 5.8 to 5.9 | 0.5 to 1.0 |
| 18,181 × 55 | 0.46 | 1.43 to 1.50 | 1.5 to 1.7 | 4.0 to 4.5 | 1.0 to 1.3 |

All in milliseconds, wall.

- **A step's cost follows how many loops it makes.** With the solve held to one Newton step, a step costs 0.38 ms at 400 × 250 and 1.44 ms at 98 × 1,024 inside the step limit (two loops), and 0.63 to 0.66 ms and 1.82 to 1.85 ms outside it, where the guard's loop runs as well (three). With Iterations at 4 and the fixture far past the limit, as it is at one step a frame, every step runs all four Newton steps: 1.9 ms and 5.8 ms. Inside the limit (16 steps here) one Newton step converges and Iterations costs nothing.
- **Per point of strand length a loop costs about 0.7 µs** (1.43 ms over two loops of 1,024). Curve Frames' walk costs 0.45 µs. So a calm step is 1.6 times Curve Frames' two walks on long strands.
- **D11's question, one 55-point strand's step against Curve Frames' walk:** 0.03 to 0.05 ms against 0.03 ms, with both GPU spans at the timer's quantum. Not several times. D1 stands.
- **Many short strands are bound by throughput, not depth.** A million points as 18,181 strands of 55 cost 1.4 to 1.5 ms a step, where a plain per-point kernel over the same points costs 0.44 ms and Curve Frames 0.46 ms. That is 1.5 µs a point a step. The scratch is a storage buffer read and written per point per loop; a version that keeps a short strand's working values in function-local arrays is the follow-up to measure (R18).
- **A dispatch costs the CPU about 0.02 ms** (a stepped Point Kernel of the same points, 16 steps against 1: 0.019 to 0.023 ms each, at every layout up to 100,000 points). Sixteen dispatches are 0.3 to 0.4 ms of CPU a frame in this host. 7.6 had no figure.
- **The consumer's layout** (10 × 55): 0.35 ms a frame at 4 steps and 1.2 ms at 16, wall, in Node, on the quieter of the two runs; 0.9 ms and 2.2 ms on the other. The design's range was 0.1 to 0.3 and 0.3 to 1.1.
- **The design's ranges were low for long strands** by a factor of 1.5 to 3 for a calm step, and a step that runs all four Newton steps costs four times a calm one on top of that.

### 14.4 What the device changed

- **Bit-exactness survived the device's square root and division everywhere the design claimed it.** No test needed the fallback written beside it. Exact, with `toBe` or `toEqual` on the words read back: the hanging strand's sag (0) and tension ((16 − k) × 8 N) at 1, 4 and 8 steps, also against the reference word for word; the released fall (0.0634765625 m at 1 m/s after 64 steps); the fall from Reset; the tow (position and velocity of every point on every frame); the step counts read off a fall; one tick of two frames against two ticks of one, and four sub-frames against one frame, byte for byte; the three frame modes; the seek; the frame of no length and Simulation Speed 0; Reset; Teleport with Reset; the 960 m lap; every seed in every direction (14.5).
- **Held to a derived bound, because the closed form is not a float:** the compliance (the solver's exit tolerance a segment); length under a swaying anchor (the exit tolerance plus the stored position's spacing); the thrown anchor under the guard (Max Stretch plus the spacing at 100 m); Carry against a twin that never jumped (the spacing at 64 m).
- **Device against reference in general motion:** a strand swinging for 640 steps differs from `rope.ts` by 1.04 × 10⁻⁵ m at most on a one-metre strand. WGSL does not specify the last place of a square root or a division, and a device may fuse a multiply and an add. The tests assert 10⁻⁴ there and say why.
- **The uniform collision** (14.1, item 7) is the one thing the device found that the reference could not.
- **The cost** (14.3): the four-loop step was three to four times Curve Frames, and the two-loop step is the fix.

### 14.5 Tests as built

| File | Tests | What it holds |
|---|---|---|
| `src/points/rope.test.ts` | 29 | the reference against closed forms: seeding, the hanging fixed point and its tension, Mass, a compliance, free fall, momentum, the interpolated target, a part weight's rest, weight 0, the guard and that it adds no speed, the hold, Reset, Teleport Reset, Carry through a wrap, every seed in every direction |
| `src/nodes/definitions/point-rope.gpu.test.ts` | 24 | the same claims on Dawn through the compiler and the backend, and the device against the reference |
| `src/nodes/definitions/point-rope.test.ts` | 16 | the edge, the bindings, the uniform block, every refusal sentence |
| `src/compiler/kernel-steps.test.ts` | 38 (17 new) | the rate rule row by row of 6.3's table, the Rope's region, the per-frame path, the plan reader, one dispatch that steps beside one that does not |
| `src/tests/headless/rope-steps.gpu.test.ts` | 4 | the count through the frame driver and the offline transport at 64 fps, 32 fps and in sub-frames |
| `src/tests/headless/harness-probe-frames.gpu.test.ts` | 3 | the harness's per-frame buffer probe |
| `src/app/animate-parameters.test.ts` | 9 (1 new) | a driven rate reaches the region as a pushed value |

- Each device test names what it was seen red against. 14 mutations of the shader, the reference and the backend, 7 of the compiler, the plan reader and the animator, and 1 of the harness were applied by edit, seen red, and removed by edit.
- **The 960 m lap is a test by itself** (the consumer's item 7): Teleport Distance 100, Carry, 54 segments, a socket at 8 m/s; the pitch is 2⁻⁴ m and the socket moves 2⁻³ m a frame so that every position before, at and after the wrap is a float. Every point is one pitch behind the last and at 8 m/s on all 39 frames, to the bit. The control with Teleport off is dragged at more than 1,000 m/s.
- **The harness has a per-frame buffer probe** (item 8): `probeFrames` on `renderHeadless` reads `probeBuffers` after each named frame into `bufferFrames`. It refuses a frame the render never steps, and a probe with no buffer named.

### 14.6 A fast pin, on the reference (model, single precision)

Slice 2's measurement includes a pin at weight 1 moving at the consumer's speeds (15.5). The far-end pin does not exist yet, so this is the first point of a 54-segment strand of 60 mm, swept at 2 Hz, 60 frames a second, Max Stretch out of the way:

| Peak speed, peak acceleration | 1 step a frame | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| 4 m/s, 50 m/s² | 39% | 0.017% | 0.012% | 0.013% | 0.012% |
| 8 m/s, 101 m/s² | 285% | 21% | 0.013% | 0.012% | 0.012% |

The worst segment, as a share of its length. The default Update Rate of 240 (four steps at 60 frames a second) holds the attack. 2.6's formula gives 4.7 ms and 3.3 ms for these, which is four steps and six; the reference holds with two and four. The formula is conservative, because the peak acceleration lasts an instant.

## 15. After the consumer's review (2026-10-06)

The first consumer (sentinel-bot, T1561b) read the design against its rig and its tests. This section is what changes. Nothing in it is built except where it says so. Figures are model (float64, Appendix A's strand, the scripts kept in the session's scratch) unless they say measured.

### 15.1 The order of the slices

**1, 2, 4 with the bend limit, 5, then 3.** A height field (6) is not planned.

- Slice 4 comes before the walls because rings that pass through each other are wrong in every shot, and a tentacle through a wall only where it hangs.
- Slice 5 (the distance function, for the bore and its deck) comes before slice 3 (the colliders pointset, for the body's capsule). Slice 5 no longer depends on slice 3: the contact step is built with the first of them.

### 15.2 The bend limit

**The requirement.** The consumer's rings are rigid, 0.06 m apart, with a shell radius of 0.049 m. Neighbours intersect past a turn of about 0.4 rad (23°) at a joint, and its rig test holds a bend radius of at least 0.15 m. Bend Stiffness (3.2) is a spring: it resists a bend and bounds nothing. What is wanted is a limit.

**The parameter: Min Bend Radius, in metres**, with a switch.

| Key | Label | Type | Default | Meaning |
|---|---|---|---|---|
| `bendLimit` ⓢ | Bend Limit | boolean | off | The rope does not bend tighter than Min Bend Radius |
| `minBendRadius` | Min Bend Radius | number, metres | 0.15 | The radius of the tightest curve the rope makes. A joint between two segments of mean length `l` may turn at most `2·asin(l ÷ 2R)` |

- A radius and not an angle, because a radius is a property of the rope and an angle is a property of how finely it is cut. Resampled to twice the points, the same radius is half the angle at each joint.
- The consumer's 0.4 rad at a 0.06 m pitch is a radius of 0.151 m. A radius of 0.15 m on its 54 links of 59.3 mm is 0.3977 rad (22.79°).
- The switch is structural and the radius is a value (§V453): with the limit on, the step is a different program (below).

**As built the row is the turn itself and not this distance: see 17.2, which supersedes the next paragraph's choice of scalar and D16's wording. The band, the one-sidedness and the elimination are as described here.**

**As a constraint.** The turn at joint `j` is fixed by the chord across it: with the two segments at their lengths `a` and `b`, `|p[j+1] − p[j−1]|² = a² + b² + 2ab·cos(turn)`. So "no joint turns more than this" is a one-sided distance constraint between second neighbours, `|p[j+1] − p[j−1]| ≥ chord(j)`. It is the same kind of row as a stretch constraint, with a gradient on two points.

**A guard after the solve, like Max Stretch, does not work, and the reason is the consumer's own test.** That test is a rope at rest. In the model: 54 links, 3.2 m, both ends pinned 0.5 m apart, gravity 9.81, Damping 0.5, 60 frames a second, 4 steps a frame, Iterations 4.

| How the limit is held | Largest turn at rest | On the way there | Worst segment | Comes to rest |
|---|---|---|---|---|
| Not at all | 50.5°, 2.22 × the limit | 112° | 0.004% | yes |
| Positions only after the velocity, turning the rest of the strand rigidly | 57° | 179° | 1,400% | no: 210 m/s |
| Positions only after the velocity, moving each joint's later point | 22.8° at one instant | 180° | 82% | no: 42 m/s |
| A Gauss–Seidel sweep of the limit before each Newton step | 25.1°, 1.10 × | 33° | 0.011% | yes |
| The same, Iterations 8 | 24.1°, 1.06 × | 31° | 0.007% | yes |
| **In the solve**: the limit's active rows solved with the stretch rows | 22.80°, 1.001 × | 23.15° | 0.007% | yes |

- **Without a limit the hanging rope turns 50.5° at its lowest joint.** So the test cannot pass without one, and with one it is not vacuous.
- **A positions-only guard fails at rest.** Gravity pulls the bottom of the loop tighter in every step. A guard that moves points without telling the velocity leaves the rope still falling into the limit: each step's velocity is the solve's, which contains the fall, and the correction grows until the strand tears. Max Stretch escapes this only because inside the step limit the solve already holds the length and the guard moves nothing. A limit that acts on a rope at rest has to be in what the velocity is taken from.
- **A sweep is relaxation again.** It carries a correction one joint a pass, and a run of joints at the limit is exactly a run. This is the hair literature's usual form: TressFX's local shape constraints are positional goals relaxed before the length constraints (Han and Harada 2012), and Follow The Leader is a single positional pass with a velocity correction (Müller et al. 2012).
- **In the solve it holds to the row's own compliance.** This is the direct solvers' form (Deul et al. 2018, for stiff rods), on the scalar system this node already solves.

**How it enters the stretch solve.** Order the rows along the strand as they occur: `s₀, b₁, s₁, b₂, s₂, …`, with `sₖ` the stretch row of segment `k` and `bⱼ` the limit's row at joint `j`. Each row shares a point with at most four rows either side. The system is symmetric, positive definite and banded, half-width 4, and the model's banded elimination without pivoting solves it with nothing outside the band (checked on every solve it made). It is still one forward walk and one back along the strand.

- **The limit is one-sided.** A row is in the system while its chord is short of its limit, or while it was pushing its two points apart earlier in the same step. A row that ends up pulling is left out of the next Newton step.
- **The exit test gains the turn**: a step stops when every segment is within `l ÷ 8192` and every joint within 2⁻¹⁰ of its limit.
- **The limit's rows carry a compliance of 2⁻¹⁰** of their diagonal. It keeps the system solvable when the limit cannot be met, and it decides who gives: length and pins hold, and the bend gives. At rest that is the 0.1% in the table.
- With the switch off the step is the tridiagonal one of slice 1, unchanged.

**Under motion** (model: the far pin 0.9 m out and swept at 2 Hz, so the limit can be met throughout):

| | 1 m/s, 4 steps | 4 m/s, 4 steps | 4 m/s, 16 steps | 8 m/s, 16 steps |
|---|---|---|---|---|
| No limit | 119° | 180° | 180° | 180° |
| Sweep, Iterations 4 | 1.39 × | 2.13 × | 1.51 × | 2.44 × |
| In the solve, Iterations 4 | 1.07 ×; 1% of frames over by 5% | 1.38 ×; 18% | 1.13 ×; 1% | 1.59 ×; 20% |
| In the solve, Iterations 8 | 1.003 ×; none | 1.054 ×; none | 1.008 ×; none | 1.065 ×; none |

The worst turn over four seconds, as a multiple of the limit, and the share of frames more than 5% over it.

- **Iterations is the ceiling that matters here.** At 8 the limit holds within 7% at the attack's 8 m/s (16 steps a frame), within 1% at the stride's 4 m/s at 16 steps and within 6% at 4 steps. The solve takes 2.2 to 3.8 Newton steps a step doing it, and the worst segment stays within 0.13%.
- **With Bend Limit on, Iterations defaults to 8**, and the description says a rope that still creases under fast motion wants a higher Update Rate, as one that stretches does.
- **There is no positions-only bend guard.** The model tried one behind the solve, set 5% past the limit, moving each joint's later point: it stretched a segment by 22% during the first swing. The bound is what the solve reaches.
- **At rest the active rows switch on and off between steps.** In the model the positions repeat from frame to frame (0.00 µm at 4 steps a frame; 19 µm at 16) while the published velocity of the points at the limit reads up to 6 mm/s. If that shows, slice 4 keeps a row in the system from one step to the next while it is pushing.

**With pins.** A rope pinned by position at both ends can open its loop wider than its pins are apart, as the model's 3.2 m between pins 0.5 m apart does. It cannot meet the radius when it is too short to turn back on itself at that radius, or when a pin is pulled to where only a crease reaches. Then the limit's compliance lets it give, and the stretch rows and the pins hold. 4.6's reach rule is unchanged. A strand held at its first two points (Anchor Second) leaves along that direction, and the limit at the second point keeps the third from folding back over the socket.

**With colliders.** Colliders keep the last word in a step (5.1). A push can tighten a joint by as much as the push; the next step's solve takes it back, as it does for a segment's length. So at the end of a step: no point is inside a collider; a joint beside a contact may be past its limit by that step's push. A collider whose corner is tighter than the rope's radius wins, and the rope creases round it. That is stated in the description.

**With Bend Stiffness.** The spring is the soft part under the limit and is unchanged: 3.2's constraint, which is zero on a straight run and linear in the points, in one sweep before the solve. A distance spring between second neighbours would not do for it: its force vanishes as the strand straightens.

**What it costs** (derived; nothing here is measured). Two rows a point in place of one, each with four coefficients in place of one: about three times the scratch a point (16 floats in place of 8) and several times the arithmetic. Slice 1 measured that a step's cost follows its loops and its Newton steps more than its arithmetic (14.3), so a step with the limit on is estimated at 1.5 to 3 times a plain Newton step, times the 2 to 4 Newton steps it takes while the limit is active under motion. For the consumer's 10 × 55 that is 0.2 to 0.5 ms a step where slice 1 measured 0.07 to 0.14. **Slice 4 measures before its program is pinned**, as slice 1 did, and reports if a 55-point step with the limit costs more than three times one without.

**Its tests.**

- The consumer's: 54 links, 3.2 m, both ends pinned 0.5 m apart, Min Bend Radius 0.15 m, Iterations 8, settled. The largest turn at any joint is at most the limit times (1 + 2⁻¹⁰) plus the exit tolerance. The control is the switch off: 50.5° in the model, more than twice the limit.
- The same strand with the far pin swept at 1 m/s and at 4 m/s, read at every frame through the harness's per-frame probe (14.5): the largest turn, against the bound slice 4's measurement fixes. The model's 1.003 × and 1.054 × are what to expect.
- Length is kept while the limit acts: every segment within tolerance at rest.
- A straight strand with the limit on is the bytes of one with it off, at rest and in free fall: a limit that is not reached changes nothing.
- On the reference first, in closed form: three points, the middle one pushed until the chord is short. The joint ends on its limit and the two segments on their lengths.

### 15.3 The seed has no hand

**The finding** (measured on the consumer's rig). A held arc built in closed form bowed its slack toward a direction projected at right angles to the chord. When the chord swung through that direction the bow changed sides: 1.29 m of tentacle in one step, however fine the step. A straight walk never met it.

**For the rope.** While it runs, inertia holds the side it is on, and the solve makes no such choice. A pose the node BUILT when seeding would make it.

- **The node builds no pose.** A fresh state (a load, a seek, a structural edit), Reset, and Teleport with Reset are one function, and it copies the incoming points slot for slot, at rest. Pre-roll (R5), when it exists, runs the solver from that same seed.
- **So the node holds no reference axis and there is no tie-break**, because there is no choice to break. The side a slack strand bows to at its seed is whatever the incoming strip gave it. An incoming strip built by an Arc carries the Arc's own stated hand (the Curve node's Bow); the consumer's kernel carries the rig's.
- **Where a choice could enter later, and the rule for it.** A strand seeded SHORTER than its rest lengths between two pins (Rest Length Scale above 1, or the winch of 15.7 paying out against a far pin) has slack and no shape for it. The node still builds nothing: it seeds the incoming points, and the solve pays the slack out under the forces present. Gravity bows it downward, continuously in the chord's direction, through a hairpin of no width where the chord is vertical. With no force across the chord (no gravity, or a chord exactly along it, and the strand exactly straight) nothing moves it sideways and it stays straight and short until something does. That is a rope with nowhere to go, and it is not a flip. Slice 2 tests that case when it builds the second pin.

**Run, in slice 2** (16.6): a strand seeded short between two pins, in every direction. It has no hand, to the bit. It also has one direction, exactly along gravity, where the strand stays straight while its neighbours fall into a loop: measured, and offered as D29.

**Built, in slice 1:** on the reference and on Dawn, a slack arc turned so that its chord sweeps a whole turn (in three families: the bow in the plane of the sweep and through gravity's axis; across the sweep; along gravity), seeded by a fresh state, by Reset and by Teleport with Reset. The device test lays 128 strands, one a direction, four of them exactly on an axis, with dyadic coordinates. Each seed is the incoming arc to the bit, and between neighbouring directions no point moves further than the sweep itself moves it. Seen red against a seed that bows its slack across a projected axis.

### 15.4 A weight between 0 and 1, under Hard

**The requirement.** One node holds a claw that is handed over on a ramp to 1 and a claw that reaches toward a wandering target at a weight of 0.3 to 0.5. So a fractional Hard weight has to be a blend toward the target, or Anchor Mode has to be mappable per strand.

**It is a blend, and Anchor Mode stays one parameter.** Under Hard a weight `a` is a spring to the target of stiffness `k = M·(2π·strength)²·a ÷ (1 − a)` with Anchor Damping's ratio (4.3). At 0.5 that is exactly Soft at weight 1; at 0.3 it is Soft at 0.43. The point follows a wandering target with a lag of about `1 ÷ (2π·strength·√g)` seconds and is not snapped to it; as the weight nears 1 the lag goes to nothing and at 1 the point is the target. One mode covers the hand-over and the reach.

**What slice 1 showed: the stiffness has to be scaled by the mass the anchor carries, not by the point's own.** 4.3 wrote `k = m·…` with `m` the point's mass. The reference with that formula, a strand of 17 points hung from an anchor at weight 0.5 and Anchor Strength 2 Hz, comes to rest 0.861 m below its target, in closed form `N·g ÷ ((2π·strength)²·g(a))` and to the solver's tolerance at 1, 4 and 8 steps (a test in `rope.test.ts`). The consumer's 55 points at 9.81 would hang 3.4 m low at 0.5 and 8.0 m at 0.3. That is a blend toward a point far below the target.

- **Change to 4.3: `M` is the strand's whole mass for First, Second and Last**, and the point's own for a weight from `pinAttribute`, where every point is held and carries only itself.
- Then the rest offset under the strand's full weight is `g ÷ ((2π·strength)²·g(a))`, whatever the strand's length: 62 mm at 0.5 and 145 mm at 0.3 at 2 Hz; 16 mm and 36 mm at 4 Hz. Anchor Strength then means what its unit says: the frequency of the strand on its anchor.
- The pull stays one formula and stays unconditionally stable; only `κ` and `δ` are larger.

**Built in slice 2** (16.7): 62.12 mm and 144.95 mm on the consumer's 55 points, on the reference and on Dawn; a wandering target followed 10 to 44 mm behind at weights 0.5 to 0.3; Hard at 0.5 equal to Soft at 1 byte for byte.

**Stated in the description, and tested in slice 2:**

- The rest offset in closed form, at weights 0.3 and 0.5, at three step counts.
- A target moved on a sine: the point follows with the gain and the lag of the second-order filter the pull is, to the solver's tolerance on a strand of one point, where it is exact.
- The ramp of 4.5 unchanged: the largest move in a frame halves when the frame does.
- The wire-cut case: with the weight's map cut, every strand takes the parameter.

### 15.5 Slice 2's measurement

- **A fast pin at weight 1.** The claw's target crosses about 4 m/s in every stride and about 8 m/s in an attack. Slice 2 measures a far-end pin swept at both, on Dawn, and reports the worst segment at 2, 4, 8 and 16 steps a frame beside 14.6's figures for the first point. **Measured** (16.4): 0.0072% at the stride and 0.0125% at the attack at Update Rate 240, the held points on their targets to the bit; the attack needs two steps a frame.
- **The hold weight is one mapped weight** on a strand's last point, `anchorLast = map(hold)`.
- **Anchor Second at weight 1, one pitch along the way the socket faces, is the direction the strand leaves in.** Confirmed by the consumer. With the first two points pinned, the first segment has both ends held and is skipped (2.5), and the bend limit of 15.2 acts from the third point.

### 15.6 Two collision sources at once

The consumer needs the bore as a distance function, with its deck, AND the robot's body as one capsule (about 1.7 m long, 0.45 m in radius) from a colliders pointset. No strand against strand in v1.

**One node takes every source together.** A collide (5.1) applies each wired source in a fixed order, and the last is the one that is exact when two disagree:

1. the `colliders` pointset: spheres, capsule chains, a tube;
2. the height field;
3. the floor;
4. the distance function.

- **The distance function is last because it is the world.** A point squeezed between the body and the wall ends on the wall's side of the wall and may be inside the body by what is left. The other order would put a tentacle outside the tunnel.
- Each source pushes along its own normal until the point is its Thickness outside. One round of all four is one collide; the stretch loop runs a collide per Newton step and one more at the end (2.5).
- **Bindings.** Slice 1's step binds five storage buffers. The colliders add their position and the contacts buffer, and a `radius` from another producer one more: eight, which is the baseline's limit (§V588). The distance function adds none. A mapped parameter whose attribute lives in yet another producer's buffer is then one too many and is refused by name, with the fix (gather the attribute onto the strands upstream).
- **The contacts pass** for one capsule is trivial, and is the same pass as for 1,024.
- Friction is one number for every source in v1.

### 15.7 A winch

The consumer wants to reel a tentacle in and pay it out at about 1 m/s. Section 3.2 offered that as Segment Length in Map mode, "read every frame at a segment's first point, so a strand can pay out". **Measured before it is promised, that form does not hold, and the description must not offer it.**

Model: 54 segments of 60 mm hanging from a socket, reeled in 2 m, held, paid out 2 m; the lengths changed in every step.

| How the strand is wound | Feed | Steps a frame | A still strand: worst segment long by | A swinging strand |
|---|---|---|---|---|
| The first segments' lengths go to nothing, one after another | 1 m/s | 4 | 0.006 mm | 16 mm, a quarter of a pitch |
| | 1 m/s | 16 | 0.000 mm | 1.1 mm |
| | 4 m/s | 4 | 0.03 mm, and the strand is thrown 1.4 m | 73 mm |
| | 4 m/s | 16 | 0.005 mm, thrown 0.7 m | 12 mm |
| Wound-in points parked on the socket; the first live segment kept between a quarter and one and a quarter pitches | 1 m/s | 4 | 0.006 mm | 0.006 mm |
| | 4 m/s | 4 | 0.006 mm | 0.007 mm |
| | 4 m/s | 16 | 0.002 mm | 0.007 mm |

- **A segment wound to nothing has no step limit to stay inside.** 2.6's limit is `h < √(m·l ÷ T)`, and it goes to zero with `l`. At 6 mm of segment under this strand's 530 N it is 3.4 ms; at 0.6 mm, 1.1 ms; and no step count is small enough for the last of it. On the slice-1 reference in single precision the same winch leaves a still strand's segment 6 mm long at 16 steps a frame.
- **Lengths changed once a frame are worse still**: a segment's length then steps by 17 mm in the frame's first step and nothing in the rest, which is the 60 Hz jolt the anchor's target is interpolated to avoid (4.1). Measured on the reference: tension peaks of 60,000 N on a strand that weighs 530 N.

**The design: a length, per strand.**

| Key | Label | Type | Default | Meaning |
|---|---|---|---|---|
| `lengthOut` | Length Out | number, metres, Map f32 | 0 | How much of each strand is out of its first anchor. 0 is all of it. Mapped, it is read at each strand's first point |

- **Wound-in points are parked on the first anchor**: pinned to its target, out of the solve, with `live` 0 on the edge so that nothing draws them and Curve Frames skips them.
- **The first live segment's rest length stays between a quarter and one and a quarter of its own measured length.** When winding in takes it to a quarter, its later point is parked and the next segment becomes the first live one, a quarter longer. When paying out takes it to one and a quarter, a parked point is released a quarter of a pitch along the way to the next point, at that point's velocity. Either way the strand's length is continuous and no live point moves.
- **The length is interpolated across a frame's steps**, like the target, from a value kept from the last frame.
- **Momentum.** Each live point moves at the feed's speed along the strand; that is the momentum a winch gives. A parked point's momentum leaves with it, as into a drum, and a released point enters at the feed's speed. A swinging strand wound in swings faster, as a shortened pendulum does. A feed that starts or stops in one step is an impulse on the whole strand; ease it.
- **The step limit**: the shortest live segment is a quarter of a pitch, so 2.6's limit halves while a strand is being wound. How many more Newton steps that costs is not known: the model's own exit test miscounts on segments of no length, so it reports none here.
- A parked point that is released comes out along the strand as it is, so the node still builds no pose (15.3).
- **Segment Length in Map mode stays**, for strands whose segments differ, and is read when seeded and on Reset. It is no longer read every frame. A value of 0 there is still a weld (2.5).

**What the consumer relies on, and what slice 2 leaves in place for it:**

1. **A point keeps its identity whatever the length.** Ring `k` is always ring `k`: point `k` of a strand is slot `k`, wound in or out. A parked point is still its slot, with `live` 0; nothing is renumbered and nothing is compacted. Slice 2 addresses its stations by slot (the first, the second, the last) and keeps each point's history in its own slot, so this holds as built.
2. **The parked end is the Anchor First end.** Wound-in points park on the first anchor, and the last point is the free one or the second pin. Slice 2's walk runs from the first point outward, and its reach rule and its guard both count from the first end, which is the order parking needs.

One thing the winch slice has to decide: **Anchor Second reads the strand's second slot**, and once points are parked that slot is on the socket with the rest. The direction a strand leaves in then has to be held on the first live segment, one past the last parked point.

**The winch's acceptance case, from the first consumer (sentinel-bot `697f33f7`).** It wound a tentacle in by hand with what slice 2 has: wound-in rings parked on the socket by a Pin Attribute at 1, and a weight per point ramping over a hand-over as the tentacle took the wall. Measured there: the strand tore near the socket, a segment 30 % long, and folded, 167° between rings. A ring that should have been inside the body was pulled out of it by the rope while it was only half held, and a ring being wound past its neighbours kinked at the socket. The winch slice is done when that hand-over, with Length Out doing the winding, keeps every live segment at its length and every joint inside the bend limit, near the socket above all, on Dawn and read per frame.

It is its own slice, after the bend limit, and is measured on Dawn before its description is written.

### 15.8 Decisions to rule

- **D16. The bend limit is a constraint in the solve**, as one-sided rows between second neighbours in a banded system with the stretch rows, and there is no positions-only bend guard. (Built with the row on the turn at a joint and not on that distance: 17.2, D32.) Alternative: the Gauss–Seidel sweep, which is cheaper and leaves the consumer's rest test 6 to 10% over its limit.
- **D17. Its parameter is Min Bend Radius in metres behind a structural switch**, with Iterations defaulting to 8 while it is on. Alternative: a largest turn in degrees, which reads directly as the rings' geometry and changes meaning with the pitch.
- **D18. Slices in the order 1, 2, 4, 5, 3**, slice 5 no longer depending on slice 3, and no slice 6.
- **D19. An anchor's stiffness is scaled by the strand's mass** for First, Second and Last, and by the point's own for `pinAttribute`. Alternative: leave 4.3 as written and document that Anchor Strength has to be raised with the strand's length.
- **D20. Anchor Mode stays one parameter for the node**; a fractional Hard weight is the consumer's reach. Alternative: Anchor Mode in Map mode per strand.
- **D21. The winch is Length Out, with parked points**, and Segment Length is read at seeding only. Alternative: keep Segment Length read every frame, clamped to a quarter of the measured length, and leave winding to Rest Length Scale, which shortens every segment alike and would close the consumer's rings up.
- **D22. Collision sources act together in the order colliders, field, floor, distance function**, the last exact.
- **D23. The count at the backend** (14.1, item 1), already built: ruled after the fact, because slice 1's whole-stack test cannot pass without it.

### 15.9 What this round has not verified

- **The bend limit on a device, and its cost.** The banded solve is model, in double precision. Its conditioning in single precision on 1,024 points is not known. (Now measured: 17.4 and 17.10.)
- **The winch on a device**, and with a far pin.
- **The second pin**, ε, the reach rule and the weld: slice 2.
- **A strand seeded short between two pins** (15.3): stated, not run.
- **Whether the active rows' switching at rest shows.** 26 µm in the model. (Measured: it does not, 17.4.)

## 16. Slice 2 as built (2026-10-06)

The second pin and the anchors. Everything here was run on Dawn (Metal, this machine) unless it says reference (the CPU reference, single precision) or model.

**Added to the node:** Anchor Second and Anchor Last; Map mode on Anchor First, Second and Last (a weight per strand); Anchor Mode (Hard, Soft), Anchor Strength, Anchor Damping; Pin Attribute; Segment Length as a number; the rule for two anchors out of reach; the softened pivots for a strand with two anchors (2.5's ε).

**Not in this slice:** Segment Length in Map mode, Force, Wind, Stretch Damping, Mass in Map mode, `live` and the weld, Length Out (the winch, 15.7), colliders, bend.

### 16.1 What was decided in building it

1. **An anchor's stiffness is sized for the strand's mass** (D19), built as ruled. A station's pull is `N·(2π·strength)²·gain` with `N` the strand's point count; a Pin Attribute's is sized for one point. A point with both takes the station's when the station's weight is at least the pin's.
2. **A target's history is kept whether or not its weight is above zero.** 3.3 said the incoming position is read only while a weight is above zero. Built that way, a weight that rises from 0 finds a target last seen when the strand was seeded, and the pull's damper takes the whole distance since as one frame of motion. Measured: the last point's target runs away at 4 m/s for two seconds, then its weight becomes 0.01. The tip gains 2.1 m/s in that frame with the history kept, which is under what the spring itself gives (3.4 m/s), and 46 m/s without. So the three stations always follow their targets, and every point does when a Pin Attribute is named.
3. **A teleport is judged on the first point's incoming position**, while any station's weight is above zero or a Pin Attribute is named. Every anchor's history then goes with the strand by the same jump. 4.7 said "the first anchored point"; the first point is always tracked, and a body that wraps carries every station with it.
4. **The pivots are softened on a strand with two or more stations above zero, or a Pin Attribute.** 2.5 said two or more anchored points. With one anchor or none nothing is softened.
5. **The reach is measured from the nearest earlier hard pin**, and a pin drawn in is stored at the reach, on the line to its target. A soft anchor's target is drawn in the same way.
6. **A hard pin is stored where the forward sweep places it**, as its target, and neither the back substitution nor the Max Stretch guard writes it again. That is what keeps "the pinned point is the incoming point" true to the bit on any device.
7. **A weight in Map mode replaces the parameter.** With the map cut, every strand takes the parameter.
8. **The incoming side is bound as whole producer buffers**, read by offset. The incoming points and a weight the same kernel wrote are one binding. The step's own four buffers leave room for four producers; a fifth is refused by name.
9. **Segment Length (a number) was added**, though the brief did not list it. The first consumer's incoming strip is a straight run with its last point already where the claw goes. Measured from that, the rope has one segment as long as the distance to the claw. With the number every segment is the number. Two tests hold it, on the reference and on Dawn.
10. **Weights are per frame.** They are not walked across a frame's steps (4.4), and the hand-over below does not need it.

### 16.2 What the device changed

- **The hanging strand is no longer exact to the bit on Dawn at 4 and 8 steps a frame.** Slice 1's program kept it exact at 1, 4 and 8. Slice 2's program does the same arithmetic for a free point inside a larger text. The first stepped frame reads a top tension of 128.00009 N where 128 is exact: one last place of the top segment's stretch, so of its square root. Metal compiles with fast math (§B260), and which square root becomes a reciprocal estimate is the compiler's choice, made again whenever the text changes. Two rewrites (a division per component; the unsoftened pivot written out) did not bring it back.
  - The test now uses the fallback section 10 wrote for it: every segment within the solver's exit tolerance, and the tension within what that carries. The reference is still exact, and is asserted exact.
  - Slice 1's other exact tests still pass exactly on the new program: the falls, the tow, the step counts, the byte comparisons, the lap, the seeds.
- **With two anchors a step solves to the tolerance and not to the last place**, on the reference too. That is the softening (item 4), by design. The two pins themselves are exact.
- **Exact on Dawn in this slice:** every hard pin against the incoming point of the same frame; Hard at 0.5 against Soft at 1, byte for byte; a chord and its mirror image (16.6); a sheeted grid's free fall.
- **Device against reference** on a strand hung between two pins, and on one with a pin in its middle: within 10⁻⁴ m of a one-metre strand, as in slice 1.

### 16.3 Cost (measured by the GPU timing rule)

The GPU clock on this machine follows its recent load, so each figure is the node's own pass divided by a fixed reference compute pass timed beside the same frame. All five variants of a layout were alive in one process and visited in turn for three rounds of 240 frames, the first again last. One step of 1/240 s a frame, strands at rest. The timer's quantum is 0.066 ms, so these are means over 720 frames.

| Strands × points | | Curve Frames, two walks | Rope, first point held | first, second and last held | last weight from an attribute | Pin Attribute named |
|---|---|---|---|---|---|---|
| 1 × 55 | span ÷ reference | 0.128 (0.131 again) | 0.107 | 0.107 | 0.108 | 0.237 |
| | raw, ms | 0.086 (0.098) | 0.076 | 0.082 | 0.078 | 0.182 |
| 10 × 55 | span ÷ reference | 0.163 (0.162) | 0.151 | 0.148 | 0.151 | 0.277 |
| | raw, ms | 0.105 (0.121) | 0.103 | 0.097 | 0.109 | 0.180 |
| 1,818 × 55 | span ÷ reference | 0.234 (0.235) | 0.261 | 0.253 | 0.258 | 0.569 |
| | raw, ms | 0.144 (0.141) | 0.157 | 0.165 | 0.163 | 0.356 |
| 400 × 250 | span ÷ reference | 0.570 (0.550) | 1.603 | 1.185 | 1.161 | 2.583 |
| | raw, ms | 0.356 (0.368) | 1.017 | 0.750 | 0.732 | 1.557 |

The reference pass ran between 0.52 ms and 1.06 ms during the run; multiply a ratio by 0.524 for milliseconds at its fastest.

- **The one figure the design leans on, taken this way:** one 55-point strand's calm step is 0.83 of Curve Frames' two walks (0.107 against 0.128 and 0.131). D11 stands.
- **Anchors at the three stations cost nothing that can be measured**, mapped or not: within 2% of the strand held at its first point.
- **A Pin Attribute doubles a step** (1.8 to 2.2 times). Every point then reads its incoming point and its kept target, and writes the target back once a frame; at one step a frame that is every step, which is its worst case.
- **At 250 points a calm step is 2.1 times Curve Frames** (1.16 to 1.19 against 0.55 to 0.57). Slice 1's figure, taken without a reference, was 1.7.
- The strands held only at their first point were still swinging at 250 points when timed (1.60), so that cell is a busier step and not a dearer program.

### 16.4 The far pin at speed

The first consumer's stride, on Dawn through the frame driver at 60 frames a second, read every frame for six seconds with the harness's per-frame probe. A tentacle of 54 segments of 62.5 mm, its first two points on a socket that moves down the tunnel, its last point held to a target that stands on a rung for 70% of a step and crosses 2 m to the next in the other 30%.

| Claw's fastest | Steps a frame | Worst segment | Held points off their targets |
|---|---|---|---|
| 4 m/s, the stride | 4 (Update Rate 240) | 0.0072% | 0, to the bit |
| 8 m/s, the attack | 4 (Update Rate 240) | 0.0125% | 0 |
| 8 m/s | 1 | 177%, on the last segment | 0 |
| 8 m/s | 2 (Min Update Steps 2) | 0.0125% | 0 |
| 16 m/s | 4 (Update Rate 240) | 0.0130% | 0 |

- **The attack needs two steps a frame.** Update Rate 240 gives four, and holds twice the attack's speed. Min Update Steps 2 matters only where the rate has been turned down.
- **Two steps hold it only because the target is walked across them** (4.1). With the target put at its end in a frame's first step, the same two steps leave a segment 30 tolerances out.
- The solver's tolerance is 0.0122% of a segment plus 0.1 µm; the last 0.0003% is the stored position's spacing 16 m down the tunnel.

### 16.5 A finding: the stretch guard with a far pin

Past the step limit Max Stretch holds every segment but one. The guard walks out from the first point and moves each segment's later point, and it leaves a point that is pinned (2.5). So on a strand held at both ends, whatever the solve did not close lands on the segment before the far pin: 177% in the attack at one step a frame, with every other segment within 2%.

- It shows only past the step limit, which Update Rate 240 is two speeds away from.
- 2.5 said the reach rule bounds that segment. It does not: the reach rule answers a target the rope cannot reach, and this is a solve that did not finish.
- **Proposed (D24):** between two hard pins the guard is one pass back from the later pin and one pass out from the earlier one, positions only, on a step that needs it. That is two more loops on such a step and none on any other. Not built: it changes D5 as ruled. (Ruled and built in slice 4: 17.7.)

### 16.6 A strand seeded short between two pins

The rule of 15.3 was run as written: the node builds no pose. The seed is the incoming points, and the solve pays the slack out under what acts on it. Sixteen segments on a straight chord of 0.5 m, asked to be half as long again (Rest Length Scale 1.5), both ends held, gravity 8.

- **The seed is the incoming chord to the bit, in every direction** (128 directions on Dawn, four of them exactly an axis).
- **Nothing has a hand.** A chord and its mirror image across the vertical stay mirror images to the bit, at 1, 16 and 384 frames, on the reference and on Dawn. A seed that bowed its slack toward an axis would put both on one side; that is what the test was seen red against.
- **Gravity takes the slack to the low side.** On the reference, on chords at least 11° from vertical and settled for six seconds, no point lies further from its place under the next direction than the far pin itself moved.
- **A chord exactly along gravity has no low side, and the strand stays on it**, straight and short, on neither side: every point's sideways coordinate is 0 to the bit. That is the tie-break: there is none, and nothing is chosen.
- **That one direction is not the limit of its neighbours.** A few degrees from vertical the slack is a narrow loop beside the lower pin, and it swings to the other side faster than the chord turns. Settled (the same after 6 s and after 24 s, reference): points are 60 mm apart between the chords 3.8° and 1.8° from vertical, whose far pins are 22 mm apart. And the chord exactly on the vertical, straight, is 248 mm from its neighbour at 1.8°, which has fallen into its loop. 15.3 said the slack passes "through a hairpin of no width where the chord is vertical"; the neighbours do tend to that, and the vertical strand itself does not get there.
- **Without gravity nothing decides, and rounding does** (reference): neighbouring directions end 104 to 150 mm apart.
- **It is a violent start**: points reach 4 m/s, and the segment before the far pin is 37% long while it lasts (16.5).

So: a strand seeded short is an impossible pose, resolved without a hand and without grace, and with one direction (exactly along gravity) where it is not resolved at all. Hand the node a pose that already holds its slack (the Curve node's Arc at the rope's length), or give Segment Length the spacing the strip really has.

### 16.7 A weight between 0 and 1

- **The rest offset** (D19) on the consumer's 55 points at 60 mm, gravity 9.81, Anchor Strength 2 Hz: 62.12 mm at weight 0.5 and 144.95 mm at 0.3 in closed form. The reference and Dawn rest there within the solver's tolerance carried through the spring (0.03 mm and 0.07 mm). Sized for one point's mass, Dawn reads 3.42 m and 7.96 m.
- **A target that moves steadily is followed with no lag** (reference): the pull's damper acts on the motion relative to the target.
- **Feeling about** (D20), on Dawn, per frame: a tip drawn toward a target that wanders a quarter of a metre each way at 0.3 to 0.8 Hz.

| Weight | The tip is behind its target by | Allowed by the closed form |
|---|---|---|
| 0.3 | 23 to 44 mm | 196 mm |
| 0.4 | 15 to 30 mm | 130 mm |
| 0.5 | 10 to 22 mm | 88 mm |

  - The closed form allows the strand's whole weight on the spring; the tip carries less of it, which is why the bound is loose.
  - At weight 1 the tip is the target on every frame, to the bit. At 0 it is never within 0.3 m.
  - The largest move in a frame at 64 frames a second is 1.999 times that at 128: it moves without a pop.
- **Hard at 0.5 is Soft at 1**, byte for byte on Dawn. Anchor Mode stays one parameter.
- **The hand-over** (4.5), on Dawn, per frame: the last point's weight on a quintic over three seconds. The tip's largest move in a frame halves when the frame does (the ratio is between 1.8 and 2.2, and reads 1.99 on the reference). From the frame the weight is 1 the tip is its target to the bit, and a tenth of a second before it is within a millimetre.

### 16.8 A grid of several sheets as input

T1587b's claim `grid:{cols}x{rows}x{sheets}` reaches the Rope through `stripsOf`, which gives it rows × sheets strips. **It works as that many strands**, and the claim passes through unchanged. Sheet `s`, row `y` is strand `s × rows + y`, which is the slot order the walk already follows. Tested on the definition (the strand count, the claim, and a claim for more points than the edge carries refused) and on Dawn (two sheets of two rows: all four strands fall by the closed form).

### 16.9 Tests as built

| File | Tests | What slice 2 added |
|---|---|---|
| `src/points/rope.test.ts` | 51 (22 new) | D19 in closed form on 17 and on the consumer's 55 points; a pin sized for a point; Hard against Soft; a steady target followed with no lag; a weight that rises from nothing; two pins with slack; a taut strand; out of reach, and the nearest pin; Segment Length; a weight per strand with its wire cut; a pin attribute; the hand-over; the lap with both ends held; a strand seeded short |
| `src/nodes/definitions/point-rope-anchors.gpu.test.ts` | 13 (new file) | the same on Dawn, and a sheeted grid |
| `src/tests/headless/rope-anchors.gpu.test.ts` | 10 (new file) | per frame through the frame driver: the stride and the attack; the hand-over; a weight that rises from nothing; feeling about |
| `src/nodes/definitions/point-rope.test.ts` | 20 (5 new, 1 replaced) | the bindings by producer; the three maps and where each is read; the pin attribute; every new refusal; a sheeted grid |
| `src/nodes/definitions/point-rope.gpu.test.ts` | 24 | unchanged but for the hanging strand, now on its fallback (16.2) |

Red-verified by edit and restored by edit: 12 mutations of the shader and 11 of the reference.

### 16.10 Decisions to rule

- **D24. The stretch guard between two hard pins** walks back from the later pin and then out from the earlier one (16.5). Alternative: leave it, and say that a strand held at both ends past its step limit shows it in the segment before the far pin.
- **D25. A target's history is kept at any weight** (16.1, item 2), already built. Alternative: 3.3 as written, with a kick when a weight rises from 0.
- **D26. A teleport is judged on the first point's incoming position** (item 3), already built.
- **D27. Segment Length as a number is in** (item 9), already built, because the consumer's seed needs it.
- **D28. A Pin Attribute's cost** (16.3). It doubles a step because every point's target is followed every frame. Alternative: follow a pinned point's target only while its weight is above zero, and accept the kick of item 2 for a pin weight that rises from 0.
- **D29. A strand seeded short exactly along gravity stays straight** (16.6). Recommended: leave it, and say so in Segment Length's and Rest Length Scale's descriptions. Alternative: tip such a strand toward a fixed world axis by a last place, so that it falls into the loop its neighbours have. That is a hand, at that one direction only.

D24 to D29 were ruled as recommended; D24 is built (17.7), and D28 and D29 are said in the descriptions.

### 16.11 What this slice has not verified

- **Two anchors in single precision on long strands.** The softened pivots were run at 17 and 55 points.
- **A Pin Attribute with many pins**, beyond one in the middle of a strand and every point at once.
- **The hanging strand's exactness on another device.** It held on this one until the program changed.
- **A strand seeded short without gravity on Dawn.** Reference only.
- **The look.** The consumer's to judge.

## 17. Slice 4 as built (2026-10-06)

The bend limit in the solve (D16, D17), the guard between two pins (D24), and what the first consumer's own Rope (sentinel-bot `697f33f7`) asked of the anchors. Files: `src/points/rope.ts` (the reference), `src/nodes/shaders/rope.wgsl.ts` (the program), `src/nodes/definitions/point-rope.ts` (the node), and the tests in 17.11. Every figure here is **measured on Dawn** (Metal, single precision, read per frame with `probeFrames`) unless it says **reference** (the CPU reference, single precision, the same operations in the same order).

Read 17.8 before using the limit between two held ends: one case is **not closed**.

### 17.1 What was built

1. **Bend Limit**, a structural switch, and **Min Bend Radius** in metres (D17). With the switch on the step is another program: one banded system of the joints' rows and the segments' rows. With it off the program is the tridiagonal one, with none of the limit's text (17.9).
2. **The rows are compliant** (D30, ruled after the first build: 17.3).
3. **Length before bend** (D36, new): a step that cannot keep the rope's length with the limit in it is solved again without it (17.8).
4. **The guard between two hard pins** walks back from the later pin and then out from the earlier (D24: 17.7).
5. **A hard pin is exact, always** (D31): a held point that directly follows a held point is not drawn in (17.6).
6. **A weight within a millionth of 1 is 1** (17.6).
7. **Iterations defaults to 8 while the limit is on** (D35), through `parametersFor`, and the node read with no stored value agrees.
8. Descriptions: what the limit holds, exceeds, costs and needs; what a weight of 1 is; how to let go.

Not built: Bend Stiffness (D34, its own slice), a softness for the limit that an author sets (row text in 17.13), the winch (15.7).

### 17.2 The row is the turn at a joint (D32; D16's wording superseded)

D16 and 15.2 describe the limit as a one-sided **distance between second neighbours**. As built the row is the **turn itself**: the joint at point `j` turns by the angle between the two segments that meet there, and may turn at most `2·asin((a + b) ÷ 4R)`, `a` and `b` their rest lengths. Its gradient turns each of the two segments about the joint: on the point before, a unit vector square to the first segment over that segment's length; on the point after, the same for the second; on the joint, minus their sum. It is the same band (each row shares a point with at most four rows either side), the same one-sidedness, the same elimination. What is superseded is only which scalar the row holds, and the reason is single precision:

- **The distance between second neighbours is `2l·cos(turn ÷ 2)`.** It moves with the SQUARE of a small turn. On a strand cut into a thousand pieces the limit is a turn of 1.21°, and the whole of it changes that distance by less than a stored position's last place.
- **The length of the curvature vector is `2·sin(turn ÷ 2)`.** It stops moving as a fold nears 180°, and its gradient there points along the fold and not across it. Seen: the consumer's loop, seeded as a V, came to rest with a full turn in it.
- The angle moves evenly from 0 to 180°.

A joint's row is in the system while it is past its limit, while it has pushed the strand straighter earlier in the same step, or while it is within 2⁻¹⁰ of its limit and has not been let go (`ROPE_BEND_BAND`). A Newton step turns a joint back by at most half a radian (`ROPE_BEND_STEP`).

**A pose handed in folded far past the limit can open into a loop with a full turn in it (D33).** Every probe and test here seeds a pose the rope could lie in: the strand hangs straight and its far end is carried to its pin over six seconds.

### 17.3 The softening: two forms, and why the second (D30)

A bend row needs something on its pivot: where the limit cannot be met the system is otherwise singular. Two forms were built and measured.

**A, a raised pivot** (the first build): the row's diagonal times `1 + 2⁻¹⁰`, nothing on the right-hand side. Exact where the limit can be met. **B, a compliance** (as built now): `2⁻¹⁰` of the diagonal the joint's rest lengths give its row, added to the diagonal, with that times what the joint has pushed so far on the right-hand side — the form a segment with Stretch already has.

| | A, a raised pivot | B, a compliance (as built) |
|---|---|---|
| The consumer's loop at rest, Update Rate 240 | 1.0001 of the limit | 1.0001 |
| The same at 960 | 1.0000 | 1.0000 |
| A 250-point loop at rest (reference) | 1.004, at 8 Newton steps a step | 1.030, at 4 (as with no limit) |
| Far pin swept at 4 m/s, 240 | 1.068 | 1.011, and 1.146 on the build before (see below) |
| Swept at 4 m/s, 960 | 1.000 | 1.001 (1.004) |
| Swept at 8 m/s, 240 | **1.655, a segment at the 2 % guard** | 1.241, worst segment 0.2 % (1.155, 0.12 %) |
| Swept at 8 m/s, 960 | 1.016 | 1.024 (1.150) |
| 1,024 points at 960: one joint; radius over 32 joints | 1.065; 0.1415 m | 1.283; 0.118 m |
| Reference, another sweep at 8 m/s, 16 steps a frame | **2.87, a point thrown 0.78 m in a frame** | 1.03 |
| Newton steps a step in motion (reference, six sweeps) | 3.0 to 7.0 | 2.1 to 4.9 (1.3 to 1.9 with no limit) |
| Cost at rest, 10 × 55 (17.10) | 1.34 | 1.45 |
| Cost at rest, 400 × 250 | **3.30** | 1.76 |

**Why A was not kept.** A resting bend's multipliers are a smooth mode along the arc, and that mode's share of the diagonal falls with the fourth power of the number of joints at the limit together: about 10⁻⁵ for thirty. A pivot raised by 2⁻¹⁰ then closes a few percent of it at each Newton step, and a 250-point loop took all eight of them in every step, at rest. A smaller raise converges (2⁻¹⁶: four steps) and throws the rope in fast motion. And where the rows cannot all be met a raised pivot has **no fixed point**: the multiplier grows at every Newton step. That is the thrown point.

**What B costs is exactness, by a stated amount.** A resting joint stands past its limit by its compliance times the moment it carries. It is a closed form, and the tests hold it (17.11): a strand held out level by its first two points rests joint `j` at `limit + 2⁻¹⁰·(1, 5 or 6) ÷ b²·g·h²·Σ(xᵢ − xⱼ)`, the sum over the points beyond it. On a loop it is 1.0001 of the limit at 55 points, 1.001 at 108 and 1.030 at 250 (reference): it grows with about the fourth power of the point count, because the compliance is a share of each row's own diagonal.

**In motion the figure moves from build to build.** The two columns of B's swept figures are the same solve before and after its last change (which of two equal expressions carries the compliance, and 17.8's rule, which does not fire in these runs). A whipped rope is chaotic and the worst joint of four seconds moves with the last place. The description gives ranges, and the tests' ceilings sit above them.

### 17.4 What the device gives

54 segments of 0.06 m (3.24 m), both ends held 0.5 m apart, Min Bend Radius 0.15 m: a joint may turn 23.07°. Iterations 8.

| | Largest turn, of the limit | Worst segment | Largest move of a point in a frame |
|---|---|---|---|
| At rest, no limit, Update Rate 240 | 2.189 | 0.0035 % | 4.51 µm |
| At rest, limit on, 240 | **1.0001**, five joints at it | 0.0035 % | 3.50 µm |
| At rest, limit on, 960 | **1.0000** | 0.0003 % | 28.2 µm (37.7 with no limit) |
| At rest, limit on, 120 | 1.0003 | 0.0013 % | 0.77 µm |
| Far pin swept at 4 m/s, 240 | 1.011; over by 1 % in 1 % of frames | 0.012 % | |
| Swept at 4 m/s, 960 | 1.001 | 0.008 % | |
| Swept at 8 m/s, 240 | 1.241; over by 1 % in 52 % of frames, by 5 % in 20 % | 0.195 % | |
| Swept at 8 m/s, 960 | 1.024; over by 1 % in 2 % of frames | 0.012 % | |
| Swept at 4 m/s, 240, no limit | 7.8 | 0.012 % | |
| Swept at 4 m/s, 240, Iterations 4 | 1.174 | 0.23 % | |
| Swept at 8 m/s, 240, Iterations 4 | 7.8: steps solved without the limit (17.8) | 1.8 % | |

- **The active rows' switching at rest does not show** (15.9's open question; the model said 26 µm). With the limit on the resting loop moves less in a frame than the same loop with none, at every rate.
- **A 1,024-point strand** of the same 3.24 m at Update Rate 960: the tightest radius over 32 joints is 0.118 m where 0.15 is asked (0.069 m with no limit), one joint at 1.283 of its limit, worst segment 0.013 %. The reference gives the same (0.1180 m, 1.284). At 240 a strand this fine is past its own step limit with or without the bend limit (reference: 19 times the limit, segments at the guard). 15.9 asked what the conditioning is there: with the compliance the solve is stable at 960, and the limit is soft by a fifth.
- The model's 1.001 at rest and 1.003 to 1.065 moving held at rest and at 4 m/s. At 8 m/s and 240 it did not.

### 17.5 The consumer's cases, on fixtures of this repo's own

53 segments of 0.06 m (3.18 m), Update Rate 240, Iterations 8, Damping 1.5, read from the fourth second to the fourteenth. The limit is 23.07°.

**Case 1, held at both ends with slack.** Socket and the ring after it held (Anchor First and Second at 1), the claw on rungs 2.2 m to the side that it crosses between at 3.2 m/s, gravity 1.5. Largest turn at each joint, joint 1 first, in degrees:

| | Joints 1 to 8 | Elsewhere |
|---|---|---|
| Socket facing aft, no limit | **81.6** 3.8 4.2 5.3 6.6 8.1 9.4 10.2 | up to 35.5 near the claw |
| Socket facing aft, limit on | **23.1 23.1 23.1** 15.5 5.7 6.9 8.1 9.2 | 23.1 on the last fifteen |
| Socket facing straight away from the claw, no limit | **136.8** 3.5 3.7 3.9 4.2 4.5 5.0 5.3 | up to 49.7 |
| Facing away, limit on | **23.1 23.1 23.1 23.1 23.1 23.1** 18.4 10.0 | up to 23.1 |

**Across a held pair the joint's row is still in the system.** Two of its three points cannot move, so the row turns the third: the strand leaves the socket inside a cone about the socket's own direction, and the turn it needs is spread over the joints after it. The held points are their incoming points on every frame.

**Case 2, a part Anchor Last.** A loose strand towed at 3.2 m/s, its last point drawn at 0.3 or 0.1 toward a target that wanders beside the body. No limit: 45.6° and 48.3° at the last joint, 133° and 145° at the worst. Limit on: 23.1° at every joint, the last three among them. **A station's pull does not need spreading to stop the kink; the limit stops it.** What spreading would add is a direction at the end, which one point cannot have: that is a Pin Attribute's, a weight and a target on each of the last points (reference: a pin tapering over the last eight points, limit on, 23.1° too).

**Case 3, the limit and the pins cannot both be had.** Every point drawn by a Pin Attribute at 0.95 toward a swaying curve 2.5 % shorter than the rope. No limit: 54.6° at a joint, the rope buckling between its targets. Limit on: 23.2° (1.005 of the limit), worst segment 0.010 %, everything finite. **The pins give**: the rope lies up to 61 mm from its targets, against 20 mm. A weight under 1 is a pull and not a hold, so this case has an answer. The case that does not is 17.8.

### 17.6 A held point is exact, and what letting go does (D31)

**What the consumer measured as "a pin at 1 trails by millimetres" was the reach rule.** Its own walk, run here (720 frames, its fixture, read only): of 247,616 rings pinned at exactly 1, 244,447 were on their incoming point to the bit, and every one of the other 3,169 sat after a pair of held incoming points further apart than 1.02 ring pitches. Its rig holds rings up to 16 % further apart than the pitch; drawn in to the rope's length (4.6), each ring trailed the one before it, 99 mm at ring 53. The second ring's 8.4 mm was the same thing: its first two incoming rings were 1.16 pitches apart.

**As ruled and built:** a hard pin that directly follows a hard pin is not drawn in. The segment between two held points has nothing it can move, and a held point is where it is told to be. The reach rule is unchanged across points the solve can move. On the same walk after the change: **247,616 of 247,616 on their incoming point to the bit.** Anchor First and Second at 1 are both exact, and the first segment is as long as they are apart.

**A weight within a millionth of 1 is 1** (`1 − 2⁻²⁰`, stations by number or map, and the pin). A weight computed upstream as `mix(a, 1.0, s)` can land on the last float below 1, and under Hard that is a spring 16 million times the one at a half. Measured without the rule: such a pin is 0.36 µm off its target. So that was not the consumer's millimetres, and it is fixed all the same.

**Letting go of a strand held longer than itself.** Every point pinned to a strip 16 % longer than the rope (0.51 m over the strand), then released.

| | The far end moves, in the frame of the release | Fastest stored speed after | Then |
|---|---|---|---|
| A weight cut from 1 to 0 in one frame | 1,181 mm | **55.6 m/s** | The rope is thrown through its anchor: 0.8 m a frame for eight frames, 6.9 m from its strip |
| A weight ramped down over 0.2 s | 695 mm | 4.0 m/s | Under 2.6 m/s from the next frame on; every segment at its length |
| A cut, the strip 2.5 % longer | 179 mm | 8.0 m/s | Thrown, 0.13 m a frame at first |
| A ramp, the strip 2.5 % longer | 86 mm | 0.65 m/s | Still |
| A cut, the strip at the rope's own pitch | 17 mm | 1.0 m/s | Swings down under gravity |

- **A rope has its own length the moment it is free to.** In the first step a weight is under 1 the strand takes it back, and its far end moves by the whole over-length in that frame, cut or ramp. Nothing in the solver spreads that over time.
- **What differs is the speed left in it.** Cut, nothing holds the strand as it shortens and the step's whole correction is speed (the Max Stretch guard adds none, but the solve got there first). Ramped, the weight a frame after 1 is still a pull thousands of times as stiff as the one at a half, sized to hold each point, and it takes the speed out.
- Anchor Mode's description says so, and Pin Attribute's and Anchor First's point at it: ramp a weight down; a cut throws the rope. (It is in Anchor Mode's because a description has a budget of a thousand characters, §V852, and Pin Attribute's was over it. For the same reason Bend Limit's says what the limit is, holds at rest and needs; Min Bend Radius's says by how much it is exceeded in motion; and Iterations' says what it costs.)

### 17.7 The guard between two pins (D24), as built

On a step that ends with a segment beyond Max Stretch, a strand with a hard pin past its first point is walked back from its LAST hard pin and then out from its first point, positions only. A strand with no such pin is walked out only, and is the words it was: eight hashes of its positions and velocities, taken from the reference before the change, are pinned.

- The attack at one step a frame (16.5's 177 % on the segment before the claw): every segment within 2 %.
- **One pass each way is not a solver.** On a strand thrown far from any shape it could lie in, what the two passes cannot close lands on the segment before the later pin. Seen twice while building 17.8: 7.7 % on a strand folded back taut, and 1,549 % on a 1,024-point strand at Update Rate 240 when the guard was handed a worse answer than the one it used to get. Both are closed by 17.8's rule, not by the guard.

### 17.8 Where the limit cannot be met (D36), and what is not closed

**The case.** A strand held hard at both ends, with less rope between them than a turn of that radius takes. For example: socket and second ring held facing one way, the claw held behind them. Nothing can meet the limit. Its rows are near-rigid (a compliance of 2⁻¹⁰), so they push with whatever it takes, the push lands on the strand's own pins, and the part of the strand between the bend and the far pin is a chain under compression, whose joints are free inside their limit: it buckles back and forth.

**Built: length before bend.** A step that ends with a segment beyond Max Stretch is one the solve could not finish with the limit in it. It is solved again from where its points were placed, with no joint in the system: the rope keeps its length and its pins, and the bend gives for that step. Where that cannot be finished either (a step too coarse for the strand, limit or no limit) it is solved a third time as it was the first, because the first answer is the better one to hand the guard. A point's placed position is kept for this: twenty floats of scratch a point with the limit on, where the tridiagonal step has eight.

- It never fires in any run of 17.4 or 17.5 at Iterations 8.
- A strand taut and folded back comes to rest as the same strand with no limit does, a crease at the socket, every segment at its length. Before the rule (reference): 74 m/s and a segment 66 % long.
- It costs the limit where a step is too coarse for it: at 8 m/s, Update Rate 240 and Iterations 4, steps are solved without it and the strand folds as if it had none.

**Not closed.** Reference, 16 segments of 1/16 m, the first two points held facing +X, the last held straight behind the second at `d` segments' distance, 15 segments of rope, radius 0.15 m. The limit can be met up to `d` = 7.

| `d`, segments | 4 steps a frame: fastest point in the last 2 s; worst segment | 16 steps a frame |
|---|---|---|
| 7 (can be met) | at rest; 0.00 % | at rest |
| 7.5 | 0.9 m/s; 0.00 % | 7.5 m/s |
| 8 | 9.2 m/s; 0.01 % | 38 m/s |
| 9 | 8.1 m/s; 0.76 % | 35 m/s; 1.0 % |
| 10 | 12.1 m/s; 1.98 % | 42 m/s; 1.9 % |
| 11 | **64 m/s; 2.04 %** | **291 m/s; 2.8 %** |
| 12 | at rest (solved without the limit) | **288 m/s; 4.3 %** |
| 13 to 14.5 | at rest (solved without the limit) | at rest |

**Between "can be met" and "taut", a limited strand held at both ends does not come to rest, and it is worse at a higher Update Rate.** The bend itself is steady (six joints 1° to 14° past the limit); what moves is the straight run after it. It is the same thing that disqualified form A, in a narrower place, and the same strand with no limit is at rest in every row. The node's description says what the limit needs between two held ends. What was tried, on the reference:

- **A softer limit rests.** At `d` = 10 and 4 steps: about 10 m/s at 2⁻¹⁰, 6.8 at 2⁻⁸, 1.0 at 2⁻⁶, at rest at 2⁻⁴, in the same shape. The bend's push is what its compliance lets it be. A softness the author sets is row text in 17.13.
- **Solving again whenever a step did not converge** (not only when a segment is beyond Max Stretch) rests every row above, and takes the limit away in legitimate motion: 7.7 times the limit in the swept loops, 40 % of steps solved without it.
- **Solving again when a segment is merely out of its tolerance** is worse than neither (39 m/s at `d` = 10).
- **Leaving the limit out for 64 steps after such a step** rests `d` = 10 to 12 at 4 steps a frame, not `d` = 8 to 9.5, and nothing more at 16.
- Precision and the iteration cap are not the cause: double precision and 64 Newton steps give the same.

### 17.9 The program without the limit, frozen

`point-rope.test.ts` pins a fingerprint of the whole plan for each shape the step's text takes with Bend Limit off, and asserts that text has none of the limit's words. The fingerprints moved three times in this slice, each for a change every Rope was meant to get. The limit's own text never moved them (checked after its first build, between the first and second rows below).

| Shape | Before slice 4 | After D24 | After the weight rule | After D31 (pinned) |
|---|---|---|---|---|
| The default, strips 55 × 10 (and a grid of two sheets) | `d0e84b664e3a02c9` | `3f93405abc0ffa5b` | `336c4d27432dc11a` | `3c0dde6bb79537aa` |
| Tension | `b6287c178b6842d4` | `947fe70578caafbe` | `2d19174ecb7dd069` | `2ea65f9e5ac95d03` |
| Three stations, Soft, a Segment Length, a Teleport Distance | `685a14404b827483` | `d9154b9cad27b27d` | `35a67ae3154e88ed` | `e4a053ef65156952` |
| Three stations mapped | `1a0ff459afd44b33` | `10c3211540a2c91d` | `35cfd5d6e705ae53` | `4fe60f089a1f03be` |
| A pin, Tension, a mapped last station | `c70a6645e23e9905` | `c7523787dd0a7a3f` | `bf07c4e187d715e2` | `e461f63999f7672a` |
| One strand to a row of 550 | `7a2dddea9f4ba2c9` | `efffb0de419c991b` | `1822ca97cd25723e` | `b10beddbf8f34796` |

Values with the limit off: a strand with no hard pin past its first point, and no weight within a millionth of 1, is unchanged to the bit (the hashes of 17.7). A strand with held points that are neighbours and further apart than a segment is changed, on purpose (17.6).

### 17.10 Cost (measured by the GPU timing rule)

One step of 1/240 s a frame, Iterations 8 in every variant, a fixed reference pass timed beside every frame, the variants alternated in one process with the first repeated last. Span is the node's own pass; the figure is span ÷ reference. Metal, 3 rounds of 240 frames, reference 0.524 ms at its fastest.

| | Limit off | Limit on | On ÷ off |
|---|---|---|---|
| 10 × 55, loops at rest | 0.1826 (again 0.1790) | 0.2649 | **1.45** |
| 10 × 55, hanging straight (no joint at its limit) | 0.1781 | 0.2440 | 1.37 |
| 10 × 55, far pin swept at 4 m/s | 0.2292 | 0.5454 | **2.38** |
| 400 × 250, loops at rest | 3.065 (again 3.068) | 5.405 | **1.76** |
| 400 × 250, hanging straight | 0.909 | 1.500 | 1.65 |
| 400 × 250, swept at 4 m/s | 3.100 | 9.884 | **3.19** |

Raw span means, in the same order, off then on: 0.127 and 0.175 ms; 0.118 and 0.164; 0.164 and 0.366; 1.774 and 3.186; 0.545 and 0.872; 1.831 and 5.869. Curve Frames in the same process: 0.183 and 0.571. At 10 × 55 a span is two timer quanta (0.066 ms), so those ratios are means over 720 frames and no better than a tenth.

- **What drives it is the Newton steps a step takes, which Iterations caps.** One Newton step of the banded solve is 1.4 to 1.65 times a tridiagonal one. At rest the count is the unlimited strand's (reference: 1.0 on 55 points, 4.0 on 250). In motion it is two to three times it (2.1 to 4.9 against 1.3 to 1.9).
- **400 × 250 swept is over three times.** A 250-point strand swept at 4 m/s at 240 is past its own step limit, limit or no limit (segments at the guard in both); it is here because it was asked for, not as a use.
- Form A, at rest only: 1.34 and **3.30** (17.3).
- The design's estimate was 1.5 to 3.

### 17.11 Tests as built

- **`points/rope.test.ts`, 77.** New: the beam in closed form at two radii (statics on the resting shape); the limit one-sided (a loop resting on its limit drawn out straight keeps every segment's length); the limit on and never reached is the hanging strand and the falling strand to the bit; the consumer's loop at rest at 4 and 16 steps, and its stillness against the same loop with no limit; a strand taut and folded back comes to rest; a held point exact at every point of a strip 16 % longer, 5 % shorter and uneven; Anchor First and Second both exact; the reach rule unchanged across a point the solve can move; a weight at the last float below 1; D24's two cases and the eight hashes.
- **`nodes/definitions/point-rope.test.ts`, 31.** The switch is structure (the id, the block, twenty floats); off, the text has none of the limit's words; Iterations' default by both ways in; the fingerprints of 17.9.
- **`nodes/definitions/point-rope-bend.gpu.test.ts`, 3, Dawn.** The beam's closed form on the device, and the device against the reference to four digits; the strand taut and folded back.
- **`tests/headless/rope-bend.gpu.test.ts`, 16, Dawn, per frame.** 17.4's rows, 17.5's three cases with a ceiling on every joint index, a strand held at every point to a strip up to 18 % longer, the ramp and the cut. `ROPE_REPORT=1` prints what each measured. It takes two minutes, most of it the 1,024-point strand.
- **`nodes/definitions/point-rope-anchors.gpu.test.ts`, 15**, two of them new: a weight a rounding short of 1 as a pin and as a mapped station.
- Red-verified by edit and restored by edit: 10 mutations of the reference and 6 of the shader.

**Two rules are not pinned by any test.** Keeping a joint within 2⁻¹⁰ of its limit in the system, and flagging a step whose joint ends up holding the strand bent, were added for form A, where a resting bend chattered without them. With the compliance a resting joint stands past its limit and is in the system anyway. Reference, with each taken out: the resting loop is as still; at sixteen steps a frame it takes 1.8 Newton steps a step where it takes 1.0 with the band; the six sweeps are no better and no worse than chaos makes them. They are kept as measured, and D39 asks whether to take them out.

**The swept ceilings are above a range, not at a figure** (17.3): 1.25 at 4 m/s and 240, 1.02 at 960; 1.5 at 8 m/s and 240, 1.25 at 960.

### 17.12 Decisions to rule

- **D36. Length before bend**, already built (17.8): a step that ends beyond Max Stretch with the limit in it is solved again without it, and a third time as the first where that fails too. Alternative: leave such a step to the guard, which is 74 m/s on a strand folded back taut.
- **D37. A limited strand held at both ends with less rope than the radius needs does not come to rest** (17.8's table). Not closed. Recommended: the two rows of 17.13 (a softness the author sets, which rests it at 2⁻⁴; Bend Stiffness, which would resist the buckling), and the description as it now reads. Alternative: leave the limit out for some steps after D36 fires, which closes part of the table at 4 steps a frame and none of it at 16.
- **D38. Letting go of a strand held longer than itself** (17.6): a cut throws it at 56 m/s. Built: the descriptions say to ramp. Alternative: in the step a segment between two held points becomes free, take its over-length up in positions only, as the guard does. Not built and not measured.
- **D39. The band and the let-go flag** (17.11) are not pinned by a test. Recommended: keep them. Alternative: take both out, for a simpler rule and 0.8 of a Newton step more a step at rest at sixteen steps a frame.
- **D40. The description gives the limit's excess in motion as ranges**, because two builds of one solve gave 1.011 and 1.146 for the same sweep.

### 17.13 Row texts

- **Rope: a softness for the bend limit that an author sets.** The limit's rows are compliant by 2⁻¹⁰ of each row's own diagonal, a constant. Make it a parameter. Measured, reference, single precision, the compliance form: at 2⁻¹² a 250-point loop rests at 1.008 of its limit where 2⁻¹⁰ gives 1.030, and a 55-point one at 1.0000; in six sweeps of a 55-point loop at 4 to 8 m/s it never reached the guard (worst turn 1.006 to 1.119, worst segment 0.17 %); on 108 points one sweep gave 1.59 with a segment 0.74 % long; on 250 points at 16 steps a frame it reached the guard (9.7 times the limit, 2 %) where 2⁻¹⁰ gave 1.59 and 0.17 %. So 2⁻¹² is stable in fast motion on a coarse strand and not on a fine one. (Those ran before the solve's last change.) The other way, softer is what rests a strand that cannot meet the limit (17.8): 2⁻⁴ rests where 2⁻¹⁰ does not. A share of the diagonal is not a physical compliance: what a resting bend gives grows with the fourth power of the point count and the limit stiffens with the Update Rate, so the row should also say what the parameter's unit is.
- **Rope: Bend Stiffness, the spring under the limit** (3.2, D34). A resistance to bending below the limit, in the same banded system. Besides its look it is what a chain under compression lacks (17.8): the straight run after a bend that cannot be met buckles because nothing resists it.
- **Rope: take up a held strand's over-length without speed** (D38), if ruled.

### 17.14 What this slice has not verified

- **17.8's case on a device.** The table is the reference. The device was run on the taut case only.
- **Cases 1 to 3 on the consumer's own rig.** They are fixtures of this repo's with its lengths and weights.
- **The limit with a Pin Attribute holding points inside the bend**, beyond case 3's pulls.
- **The limit in three dimensions under twist.** Every fixture's bend is planar or nearly so; the row is written for any plane.
- **Another device.** Every figure is Metal.
- **The 250-point figures at rest on a device**, beyond the cost. They are the reference.

## Appendix A. The model

A CPU model of one strand, written for this design in plain JavaScript and kept in the session's scratch. It is not product code and is not committed. Section 2.5 is its step.

- **Strand**: 54 or 1,000 links of 0.06 m, unit masses, laid out along −Z from its first point. Gravity 9.81 along −Y. 60 frames a second, each cut into the substeps named, with the anchor's target on a straight line across a frame.
- **The consumer's motion**: the first point's speed along +Z is `9·ease(t)` for the first second, 9 until 2.5 s, `9·(1 − ease((t − 2.5) ÷ 0.5))` after, with `ease` the quintic `x³(6x² − 15x + 10)`; it sways `0.5·sin(2π·0.8·t)` in X and `0.25·sin(2π·1.3·t)` in Y. Four seconds.
- **The dead stop**: 9 m/s along +Z with a sway, and no motion at all from 2 s.
- **Relaxation**: predict; pin; odd links, then even links, each moving both ends by their share; then, with long-range attachment, any point further from the pin than the rope between them is pulled in to that distance.
- **Follow the leader**: the 2012 paper's sweep and its velocity correction at 0.9.
- **The chain solve**: 2.5's step 4, with ε = 2⁻¹².
- **Energy**: kinetic plus gravitational, summed over the free points.
- **Single precision**: every stored value and every scalar result rounded with `Math.fround`.
- **What it does not hold**: collision, bend, friction and the GPU. Those sections are design, and their numbers are derived.
- **Added on 2026-10-06 for section 15**, in the same scratch: the bend limit four ways on the consumer's hanging loop, with the far pin still and swept (the banded solve checks on every solve that no coefficient falls outside its band); the winch two ways. Bend is therefore in the model now; collision and friction are not.
