# Which geometry a light's shadow sweep draws (T1598b)

2026-10-05. Design first, then "As built" at the end.

## The problem

A casting light sweeps the whole scene into its shadow map: every geometry the Render names, once for a
directional light and six times for a point light (one per cube face). Nothing chooses. In the first consumer's
document (sentinel-bot) the eyes' point light redraws a 390,000-triangle tunnel bore six times, and the bore only
ever receives.

Two things decide whether a geometry belongs in a sweep, and they are different in kind:

1. **The author knows it never casts for this light.** A floor, a tunnel wall, a backdrop. No measurement can find
   this out: the bore is inside the light's range and in every face. This is a list.
2. **The light cannot reach it this frame.** It is further away than the shadow range, or it lies wholly outside
   one face's quarter of space. This is geometry, and it changes as things move.

## How the two products spell it

From `docs/td-notch-mechanisms-2026-10-05.md` (sections 5 and 7):

- **TouchDesigner.** The Light COMP has `shadowcasters`: a list of Geometry COMPs, written as a pattern, default
  `*`. Which objects a light *illuminates* is a different parameter in a different place, the Light Mask on the
  material ("the only way" to cull lights, per staff). TD does no distance culling of casters.
- **Notch.** The Light node has two inputs, `Affected Nodes` and `Excluded Nodes`, and a `Casts Shadows` switch.
  The lists govern what the light touches at all; they are include and exclude at once, exclude winning.

Both put the list **on the light**, not on the object. That is the right end: "does this floor cast" has a
different answer for each light, and a per-object switch (Loom's Shadow Only, a future "casts shadows") cannot say
so.

## What Loom takes

Two parameters on the Light, both lists of **geometry names**, both inactive unless Cast Shadows is on:

| Parameter | Meaning | Empty |
|---|---|---|
| Shadow Casters (`shadowCasters`) | the only geometries that cast this light's shadow | every geometry the Render draws casts |
| Shadow Exclude (`shadowExclude`) | geometries that do not cast this light's shadow | none is taken out |

The casters of light L in Render R are R's geometries, kept if Shadow Casters is empty or names them, minus what
Shadow Exclude names. Exclude wins, as in Notch.

- **Names, not patterns.** TD's field is a pattern. Loom's references are explicit names for the reason
  `source-references.ts` gives: a rename must rewrite every reference (§V128), and a pattern cannot be rewritten.
  The two parameters are registered source references, so a rename rewrites them, a dangling name is a compile
  error that names it (§V369), and a name that is not a geometry is refused by type.
- **Resolved by the Render.** A light may serve several Renders. The Light publishes the two lists as node ids on
  its payload; each Render filters its own geometries. A list that names nothing a Render draws leaves that
  Render's map empty, and the Render says so in a warning: the map is still cleared and sampled, so the author
  is paying for a shadow that cannot appear.
- **Casting only.** An excluded geometry is still lit by the light and still receives its shadows; it still
  casts for every other light. The Light Depth output draws the same casters as the shadow it mirrors.
- **Structure, not a value.** The lists change which draws exist, like Scenes does. Editing one is a recompile.

Shadow Only on the Geometry stays what it is: a body that casts and is not seen. The two compose.

## Reach: what a light cannot touch this frame

A point light's sweep stores, per face, the distance to the nearest caster within Shadow Extent. A caster
further away than that can only shadow receivers that are also further away, and those are unshadowed by rule.
A caster wholly outside one face's 90° frustum has every fragment discarded there. Both are provably empty
draws, so leaving them out cannot change a picture.

**The bound.** A sphere, in world space, on the geometry payload (`bounds`: centre and radius). It exists only
where it is known exactly without reading the GPU:

- A Mesh File In measures the sphere of its selection when it measures Vertices and Triangles (a new measured
  parameter, Bounds), and publishes it on its pointset edge unless a clip is posing the vertices.
- A Geometry in Surface mode that draws that pointset directly turns it by its own object Transform.
- Anything that moves points on the GPU (a Point Kernel, a clip, an instance placement) has no bound, and a
  geometry without one is always drawn. Nothing is guessed: §V426 says a guessed box crops shadows
  plausibly-wrong, and that rule holds here.

So this reaches static sets (rooms, props, a set split across several Mesh File In nodes by Select) and not
kernel-driven or instanced geometry. In sentinel-bot every geometry is kernel-driven, so reach removes nothing
there; the list is what that document needs.

**The test**, per casting point light and geometry with a bound, with `d` = centre − light position:

- out of range: `|d| − radius > Shadow Extent`, so the geometry is in no face;
- out of face `f` (axis `a`, the other two axes `u`, `v`): `a·d + radius·√2 < max(|u·d|, |v·d|)`, the four side
  planes of the pyramid.

Both are conservative: a sphere that touches the volume is drawn.

**It is a value, so the pass list cannot change.** The light moves, the geometry's Transform moves, and §V453
says a value never changes the plan's structure. So the draw stays in the plan and carries one more per-frame
value, `skip`, beside its uniform block; a skipped draw is not encoded that frame. The precedent is a loop's
count (T425): a number the encoder reads per frame, pushed through the same entry point as uniform values.
`skip` is outside the structure key, travels in the values-only frame compile, and is pushed by the uniform
animator when it flips.

Because a skipped draw is provably empty, a path that ignores `skip` (a preview program, an older reader) draws
the same picture. It is an optimisation that cannot be wrong by being missed.

Directional lights are not culled in this row. Their volume is a box around Shadow Centre and the same sphere
test applies; nothing asked for it yet.

## How it sits with per-view `visible_<view>` lists (T1581b F1 follow-up)

Three granularities, three places, and they compose:

| What is removed | Decided | Where | Cost |
|---|---|---|---|
| a geometry that never casts for this light | by the author | the Light's lists, at compile | none |
| a geometry the light cannot reach this frame | from a CPU bound | the Render, per frame, `skip` | a few multiplies |
| an instance the light cannot reach this frame | on the GPU | the Geometry's resolve pass, a `visible_<light>` list | a list and an indirect draw per pass |

F1 writes one `visible` list per Geometry (Group, live count). A per-view list is the same pass with one more
predicate and one more region: the camera's frustum, or a light's range sphere. It is the only way to cull
kernel-placed instances, since their positions exist only on the GPU. It is not built here because an indirect
draw costs about 0.05 ms per device pass on the measured machine and a point light has six passes per geometry;
T1604b (one device pass per run of draws) removes most of that, and the per-light list should be weighed after
it. When it comes it needs the shape's bound, which is the same Mesh File In sphere on the Shape Mesh edge.

## How it sits with lights from a pointset (T1589b)

T1589b decides which geometry a light **illuminates** (TD's Light Mask, Notch's Affected and Excluded Nodes) and
needs many lights. This row decides which geometry a light's **shadow map draws**. They share three things, so
that T1589b does not invent a second grammar:

- **The list lives on the light source and is resolved by the Render, by geometry node id, exclude winning.**
  T1589b's illumination lists are two more name-list parameters of the same kind on the same nodes.
- **Shadows for a chosen few are Light nodes.** A point of a light pointset has no name to hang a list on. A
  casting light in the many-light path is a named Light, and carries these two parameters as it does today.
- **The geometry's bound is one fact.** A light's range against a geometry's sphere is the same test whether it
  removes a shadow draw (here) or a light from a geometry's list (there).

## As built

Both halves are built as designed. What follows is where the code is, what the design did not say, and the numbers.

### The lists

- `shadowCasters` and `shadowExclude` on the Light (`src/nodes/definitions/scene.ts`), each a reference-fed input of
  the same name, registered in `SOURCE_REFERENCE_PARAMETERS` under `light`. The Light publishes them as node ids
  on its payload; the Render builds one keep-list per casting light and hands it to the sweep.
- The Light Depth output draws the same casters as the shadow it mirrors.
- A Render warns (`node.scene.shadowCasters`) when a light's lists leave none of its geometries.
- A Light now depends on the geometries it names, so naming one keeps that geometry compiled even if no Render
  draws it. Nothing is drawn for it; its own passes (a mesh instance's resolve) still run.

### Reach

- `PointsetBounds` rides a pointset edge (`CompiledNodeDescription.pointsets[port].bounds`); the compiler forwards
  it and drops a malformed one. A node builds its own edge description, so a node that does not copy the bound
  loses it, which is the safe direction.
- Mesh File In has a measured parameter Bounds (`x,y,z,r`, `formatMeshBounds` in `src/points/mesh.ts`): the middle
  of the vertices' box, the radius to the furthest vertex from the centre as written, rounded up. The app's loader
  writes it beside the other facts. It sizes nothing, so a document saved before it existed still feeds its meshes
  at once and gets the fact written; a mesh inside a component simply has no bound.
- The Geometry publishes `bounds` in world space for a Surface only (`transformedSphere`).
- `pointShadowFaceReaches` (`src/domain/geometry/camera.ts`) sits beside `pointShadowFaceMatrices` and shares
  its face table.
- `DrawPassDescriptor.skip`, `planSkippedDraws`, `UniformUpdate.skip`: the backend keeps a set of skipped draw
  ids per program, seeded from the plan, moved by `updateUniforms` and by a same-structure compile. A skipped
  draw that owns its target's clear still clears. The uniform animator pushes a flip, once, each way.

Not built, each a follow-up to schedule when a document wants it:

- a per-light `visible_<light>` list for instanced geometry (after T1604b, as above);
- reach for directional lights (a sphere against the shadow box);
- a bound from producers other than Mesh File In (a grid, a Point Transform), and a tighter shape than a sphere:
  a floor's sphere holds any light standing on it, so a floor is in all six faces whatever the test;
- the pipeline inspector does not show that a draw is skipped this frame; its row simply has no time.

### Gates

- `src/nodes/definitions/shadow-casters.test.ts` (no GPU): the sweep's draws under each list; the Light Depth
  output; the warning; the two refusals; a rename; the exact faces each geometry is encoded in; no bound without
  a measured sphere, through a kernel, for instances and under a clip; the bound through the Transform; a
  values-only frame that flips skips with the structure untouched; the measured sphere as text.
- `src/runtime/backend/vgpu/shadow-casters.gpu.test.ts` (Dawn, byte for byte): an excluded caster's shadow is
  gone from that light, there from the other, and the excluded geometry still receives; Shadow Casters alone;
  the culled picture equals the picture with every skipped draw drawn again; a cube driven into reach casts on
  the frame it arrives.
- `src/runtime/backend/vgpu/skipped-draw.test.ts`: a skipped draw asks the device for no pass and no draw call.
- `src/domain/geometry/camera.test.ts`: the reach test never leaves out a sphere the face's own matrix can see
  (5,000 spheres).
- `src/app/animate-parameters.test.ts`, `src/app/use-mesh-sources.test.tsx`: the push and the loader.

Each was seen red against the mutation it guards (36 mutations; one, rounding the centre more coarsely, is not
a defect and is not red). Ignoring `skip` in the backend leaves the Dawn pictures green, as designed: that is the
property that makes it safe, and the device-call test is what holds the saving.

### Measured: the consumer's one-eye-light case

sentinel-bot, one robot, 1280 × 720, shadows on with only `light_eyes` casting (the lamp's shadow off). Apple M3
Max, Dawn on Metal, headless, the frame run as the app runs it; medians of 240 frames, the control repeated in
each run and no other GPU job on the machine. "Before" is this commit's parent; the unlisted document measures
the same after, since nothing in it has a bound.

Hinged claws (13 geometries):

| Eyes' casters | Device render passes | Sweep GPU spans | GPU per render | CPU per frame | Wall, GPU drained |
|---|---|---|---|---|---|
| everything (before, and after with no list) | 127 | 6.2 ms | 7.7 to 8.7 ms | 9.5 to 10.0 ms | 18.7 to 20.3 ms |
| Shadow Exclude: `geometry_bore` | 121 | 5.0 ms | 7.8 ms | 9.6 ms | 19.1 ms |
| Shadow Casters: `geometry_hull geometry_ring` | 67 | 1.9 ms | 5.8 ms | 7.5 ms | 14.7 ms |
| no casting light | 54 | none | 5.1 ms | 7.3 ms | 14.4 ms |

Rigid claw (5 geometries):

| Eyes' casters | Device render passes | Sweep GPU spans | GPU per render | CPU per frame | Wall, GPU drained |
|---|---|---|---|---|---|
| everything | 55 | 3.5 to 3.6 ms | 6.3 to 6.7 ms | 5.0 to 5.3 ms | 12.9 to 13.8 ms |
| Shadow Exclude: `geometry_bore` | 49 | 2.7 ms | 6.2 ms | 4.9 ms | 12.6 ms |
| Shadow Casters: `geometry_hull geometry_ring` | 43 | 2.0 ms | 5.9 ms | 4.7 ms | 12.0 ms |
| no casting light | 30 | none | 5.1 ms | 4.1 ms | 10.9 ms |

Two things to read off it:

- **The bore was not the cost.** Taking the 390,000-triangle bore out of the eyes' sweep saves about 1 ms of
  sweep time and little of the frame. The sweep's cost in the hinged document is its 73 device passes: twelve
  casters in six faces each and the clear, eleven of them instanced pieces whose draws are small. That is
  T1604b's subject.
- **A list of two gives the shadow back.** With only the hull and the tentacles' rings casting, the eyes' shadow
  costs the hinged document 0.3 ms of wall time over no shadow at all (14.7 against 14.4), where casting
  everything costs 4.3. The nine claw pieces' shadows are a few pixels each.

Reach removes nothing in this document: every geometry in it is placed by a kernel. On the test scene (four
static meshes, two point lights) 31 of 48 sweep draws are skipped.
