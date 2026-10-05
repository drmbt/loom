# A rope solver node: strands that hang, lag and whip (T1585b)

**Status, 2026-10-05: design only. Nothing here is built, and nothing here was measured on a device.**

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
| `segmentLength` | Segment Length | number, Map f32 | 0 | Metres between a point and the next. 0 measures each segment of the incoming strip when the rope is seeded. Mapped, it is read every frame at a segment's first point, so a strand can pay out |
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

### 3.3 Attributes

**Read from `in`:**

| Attribute | When | For |
|---|---|---|
| `position` vec3f | always | the seed pose; every anchor's target, every frame; the rest lengths when Segment Length is 0 |
| `live` f32 | when the edge carries it | a segment touching a padding slot has no length, so padding stays collapsed on its live end, as the curve family's R4 says |
| whatever a Map names | per parameter | weights, mass, lengths, thickness, force, wind |

After the seeding frame the incoming position of a point is read only while that point's anchor weight is above zero, and of every point on a Reset or a teleport that resets.

**Published on `out`:**

| Attribute | Type | Meaning |
|---|---|---|
| `position` | vec3f | the simulated point. It replaces the incoming `position` on the edge |
| `velocity` | vec3f | m/s. A pinned point's is its target's |
| `tension` | f32, optional | newtons in the segment after this point; 0 on a strand's last point |

- An incoming `velocity` or `tension` of the same type is replaced by this node's; of another type the node refuses by name (Gather's rule).
- Every other attribute passes by reference (§V197), `live` and `orient` among them.

**State, private to the node** (one packed pair): `position`, `velocity`, the target each point had last frame, and each segment's measured length. 52 bytes a point.

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

### 4.8 Reset

- **`reset`**, a boolean, holds the rope on its incoming points at rest for as long as it is on. A pulse on it is "reset now", for a shot cut the document knows about. It is Feedback's parameter by name and meaning, and the Spring SOP's.
- A reset also re-measures the rest lengths when Segment Length is 0.
- The app's "reset feedback" command and a seek clear the state, and the next frame seeds (6.2).

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

One packed pair, read half and write half, as a kernel's (§V22): `position`, `velocity`, last frame's target, the measured segment length. The node is stateful, so it is never skipped (§V155).

### 6.2 The first frame

On the run that finds its storage fresh (`firstRun`, T510: a load, a seek, a structural edit, a device loss), and on every run while Reset is on:

- `position` is the incoming point, `velocity` is zero, last frame's target is the incoming point, and each segment's length is measured.
- `firstRun` is 1 on run 0 of the seeding frame only (T1583b), so the seeding run takes the place of that frame's first step and the rest of its steps are ordinary. On the live clock the frame after a reset has a delta of zero, and they do nothing.
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
- **The count is the node's to derive**, not an expression the author types. That is the first of the two engine changes (7.3).

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

- **Three to five loops over the strand** a step, each as light as Resample's length walk or lighter than Curve Frames'.
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

- `domain/types/node-definition.ts` is the frozen contract, so this lands with the full suite, once.
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

Derived. Contacts add 8 bytes a point when colliders are wired.

### 7.6 Cost

**All derived; none measured.** Two measured figures bound a step:

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
       anchorFirst 1, anchorSecond 1, anchorLast = map(hold), anchorMode Hard, anchorStrength 1.5
       teleportDistance 100, teleport Carry                  the 960 m lap
       thickness 0.05, friction 0.3
       collision = the bore's distance function (slice 5); or colliders ◀─ the centreline strip, Inside (slice 3)
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
- **Feeling about** (`gesture`): a claw drawn softly toward a wandering target. That is Anchor Mode Soft, and one node has one mode, so the tentacles that feel about would be a second Rope, or the gesture goes.
- **Stowing slack in the body**: the rope and the bore hold slack now. If the look still wants it, `segmentLength` mapped, zero on the stowed segments.

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

### 11.4 What this design has not verified

- **Anything on a device.** Every cost in 7.6 is derived. Whether a 55-point walk sits at the submission floor, and what 16 dispatches cost the CPU, is slice 1's first job (D11).
- **Exactness on the device.** The bit-exact tests of section 10 hold in the arithmetic; they lean on the device's square root being exact on perfect squares, as the curve family's exact tests already do. Each has its fallback written beside it.
- **Bend, collision and friction** are not in the model. Their order in the step and their guarantees are design; their constants (one sweep of bend a step, two collider candidates a point) are first guesses to be checked against the reference in their slices.
- **The loop region under a node that is not a Point Kernel.** Read from `substeps.ts`, `plan.ts` and the backend, where nothing names the kernel; not run.
- **Single precision past what Appendix A ran**: one motion, at 54, 1,000 and 1,024 links.
- **The look.** That a rope with these defaults reads as the consumer's squid is the consumer's to judge on slice 2. The model says it lags, keeps its length and does not pop; it does not say it is beautiful.

## 12. Found on the way

Not fixed; not in scope.

- **The consumer's world jumps 960 m once a lap.** `speed_travel` loops at the path's period and `pathAt` returns `(x, y, z)`, so every socket's world z falls by 960 at the wrap. A closed-form rig cannot see it. Anything with state on those points can, and needs 4.7's Carry.
- **The assessment's convergence figure is for a chain pinned at both ends.** It gives cos(π ÷ 55) per Jacobi pass and "red/black halves that". For a strand pinned at one end the smooth mode is a quarter wave, cos²(π ÷ 108) per red/black sweep: 1,182 sweeps for a factor of e, and a sweep is two dispatches. Red/black and Jacobi converge at the same rate per dispatch (7.4).
- **`KernelStepsDeclaration` can name only parameters that hold a count** (7.3).
- **Curve Frames has no end seed** (R8).
- **Notch's Collision Thickness is self-collision's**, by its own description. The row lists it as if it were the rope's radius against colliders.
- **A patent search for long-range attachments returns US 9,070,220 B2** (NVIDIA). Noted for R2; nothing here uses them.
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

Method, cited from memory and not re-read:

- Baraff, Witkin, "Large Steps in Cloth Simulation", SIGGRAPH 1998.
- Provot, "Deformation Constraints in a Mass-Spring Model to Describe Rigid Cloth Behavior", Graphics Interface 1995 (a limit on stretch as a separate pass).
- Kugelstadt, Schömer, "Position and Orientation Based Cosserat Rods", SCA 2016.
- AMD TressFX (a thread group per batch of strands).
- WebGPU's default limits (256 invocations in a compute workgroup).

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
