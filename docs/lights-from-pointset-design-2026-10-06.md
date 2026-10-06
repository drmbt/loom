# Lights from a pointset: a many-light path inside the Render (T1589b)

**Status, 2026-10-06: ruled, and slices 1 and 2 are built.** The lead ruled L1 to L12 as recommended and the consumer answered C1 to C6 (section 10). Section 13 is slice 1 as built (point lights from a pointset, culled), section 14 slice 2 (cone and aim), each with its measurements.

**What replaced parts of this document the same day: ONE LIGHT PATH** (`docs/light-cost-investigation-2026-10-06.md`, section 11; SPEC row T1623b; its 11.8 lists what it changes here). B260 found why a Render's cost grew faster than its light count: a straight chain of unrolled light blocks is what a compiler sinks to the end of the function. The cure is that every light in the app is a row of the table this document designs: a named Light as a set of one, a casting light as a row with a shadow slot, a projector as a row. So the table, the records, the grid and the loop below are the permanent path and not a path beside the blocks. Read with that in mind:

- **Section 2.5 and ruling L5 are gone.** There is no count at which the blocks are worth keeping beside the loop. Named Lights that do not cast become rows in T1623b's third slice, casting ones in its fifth.
- **Ruling L4 is reversed: `kind` stays a value.** It is a field of every row, so changing a Light's Type writes a float and compiles nothing, and a pointset of directional lights is legal (that many suns). Section 3.6's reasons for making it compile-time no longer hold.
- **The record of section 3.9 is 64 bytes with its last three floats given**: kind, shadow slot (0 for none), source number (which Light a row came from, the one mechanism of the lists, section 3.4 and slice 3).
- **No text holds a count of lights.** Every loop takes its bounds from the table.
- **The figures of sections 2.1, 2.2, 4, 5.1 and 5.2 were taken without a clock reference.** The GPU's clock follows its recent load, so a figure in milliseconds from one run cannot be set against one from another. They stand as first taken. The two comparisons the choice of method rested on (the grid against a plain loop at 256 and 1,024 lights) are re-taken under the rule in section 5.4, and hold.

The row asks for light position, colour, intensity, range and cone from point attributes; a many-light path inside the Render; include and exclude lists; shadows for a chosen few. The furnace's project-code lamp pass (T1402b) is the prototype and is switched over when this lands. The owner's standard is the one of the instancing and curve rows: model it on how TouchDesigner and Notch do it, from their documentation, and build the general shape.

Read for this: `docs/td-notch-mechanisms-2026-10-05.md` (the reference), `docs/shadow-casters-design-2026-10-05.md`, `docs/geometry-cost-profile-2026-10-05.md`, `docs/mesh-instancing-design-2026-10-05.md`, `src/nodes/definitions/scene.ts` and `src/nodes/shaders/scene-render.wgsl.ts` (the Light, the Render and the lit generators), `src/nodes/shaders/instance-resolve.wgsl.ts`, `src/points/attributes.ts`, `src/compiler/bindings.ts`, `src/projects/furnace/{lamps,fixtures,gi,screen-space}.ts`, `src/projects/sentinel-bot/{document,tunnel}.ts`, and the TouchDesigner and Notch pages of section 11, fetched on 2026-10-06. Neither program was run. A number is marked **measured** (on a device, section 5 says how) or **computed** (arithmetic from measured figures).

## 0. The design on one page

- **A Light gains a Points input.** In Mode: Points the light is repeated at every point of a pointset, as a Geometry in Instances mode repeats a shape. Colour, intensity, range, cone and aim are the Light's own parameters: one value for every point, or in Map mode a per-point attribute. One node makes light, in both modes.
- **The many-light path is clustered forward.** A compute pass per Render sorts the lights into a grid of cells over the view (tiles on screen, slices in depth). The lit shader finds its pixel's cell and shades only the lights in it. Lighting stays in the lit draw, so the multisampled colour target, additive geometry, primitive instances, every material model and Material · WGSL are lit by the one loop.
- **Deferred is not chosen** because it lights only what is in the single-sample G-buffer. The furnace accepts that and has a temporal pass after it; the first consumer here renders with MSAA and no temporal pass.
- **A cell holds a bitmask, not a list.** A list has a length, and a cell past its length drops lights without saying so (Notch documents such a limit: 64 a tile). A bitmask has one bit per light slot, so the only limit is the capacity of the pointsets, which is known at compile and refused by name.
- **A Light in Single mode is untouched.** A Render that lists no pointset Light emits the shader text it emits today, byte for byte. Measured: for lights that reach every pixel, today's unrolled blocks take a quarter less time than a loop over records (1.38 against 1.84 ms at 64).
- **Lists are on the light.** Lit Only and Lit Exclude name geometries, as Shadow Casters and Shadow Exclude do (T1598b), and are resolved by the Render.
- **Shadows for a chosen few are Lights in Single mode**, as `docs/shadow-casters-design-2026-10-05.md` ruled. Shadow slots given by the GPU to the nearest lights of a pointset are the Notch shape and are designed here as a follow-up row.
- **Measured.** On the consumer's document sixteen more unshadowed Light nodes take the frame's GPU time from 6.75 to 10.75 ms and thirty-two to 24.05 ms, and pipeline compilation from 0.16 to 1.23 s. In a probe of the technique, 256 lights cost 9.31 ms unrolled, 1.84 ms as a plain loop and 0.33 ms through the grid, whose build costs 0.07 ms.

## 1. How TouchDesigner and Notch do it, and where Loom stands

URL shorthand: **D/** = https://docs.derivative.ca/ , **F/** = https://forum.derivative.ca/t/ , **M/** = https://manual.notch.one/2026.2/en/docs/ , **N/** = `M/reference/nodes/` , **W1** = https://manual.notch.one/2026.1/en/docs/whats-new/everything/ , **R1** = https://manual.notch.one/2026.1/en/docs/whats-new/release-notes/1-0-0/ . "[staff]" marks a post by a Derivative staff account. **read** means the sentence is on the page; **inferred** is this document's reading of what the pages say.

### 1.1 TouchDesigner (read)

- **A light is a Light COMP.** `lighttype` point | cone | distant; `coneangle` ("angle within which the light remains at full intensity"), `conedelta`, `coneroll`; `attenuated`, `attenuationstart`, `attenuationend` ("no light radiates beyond"), `attenuationexp`; `dimmer` ("Lights with Dimmer intensity below 0.001 are ignored"); `shadowtype`, `shadowcasters`, `shadowresolution`; `projmap` (D/Light_COMP).
- **The Render TOP lists them**: `lights`, "Specifies which Lights will be used to render the scene. You can use Pattern Matching here as well." (D/Render_TOP).
- **Forward, with the count compiled in.** `#define TD_NUM_LIGHTS <defined at compile time>`, `uniform TDLight uTDLights[TD_NUM_LIGHTS]`, and "Shaders in TouchDesigner are dynamically recompiled based on a few things such as the number and types of lights in the scene." A material loops `for(int i = 0; i < TD_NUM_LIGHTS; i++)` (D/Write_a_GLSL_Material).
- **The scaling answer is a per-object mask.** "You can use 100s of lights in your scene, as long as only a limited number of lights affect each individual object (using the Light Mask parameter)." Past that: "use a Render Pass TOP to re-render the same geos" with another set of lights and add the results (D/Phong_MAT_Shader_Resource_Usage). The mask is on the **Geometry COMP**: `lightmask`, "By default all lights used in the Render TOP will affect geometry renderer. This parameter can be used to specify a sub-set of lights to be used for this particular geometry." (D/Geometry_COMP). [staff] "The only way to do that right now is with the 'light mask' parameter in the Geometry COMP." (F/glsl-or-phong-shading-3-closest-lights-only/7986, 2016).
- **Lights are not instanced.** A user asked for it in 2020 ("What if lights could be instanced similar to how geometry is instanced?"); no staff reply (F/light-instancing-similar-to-geometry-instancing/145354). That post speaks of a limit of 32 Light COMPs; the documentation read here states no such number.
- **Deferred shading exists as a staff example, not a feature.** [staff] "There is no limitation (except for speed) of the number of lights you can use"; "this technique is poor with transparent objects"; "not antialias in your main render, do all your deferred rendering work and then use the Anti-Alias TOP at the end." (F/deferred-shading/497, 2008).
- Not confirmed: any culling of lights by distance or by view; any clustered or tiled path.

### 1.2 Notch (read, with what is inferred marked)

- **A light is a node with two lists.** Light, Omni Light, Spot Light, Area Light, Directional Light, Sky Light (N/lighting/). Spot Light: `Light Cone Angle`, `Light Inner Cone Angle`, `Cone Base Radius`, `Brightness`, `Falloff Mode` {Inner / Outer Radius (Legacy) | Inv-Squared Distance (Physical)}, `Inner Attenuation Distance`, `Attenuation Distance` ("Maximum distance the light reaches"), `Penumbra Falloff Power`, `Casts Shadows`; inputs `Affected Nodes` ("Choose which nodes are affected by the light node. By default, all are affected.") and `Excluded Nodes` (N/lighting/spot-light/).
- **Lights are cloned.** A cloner clones its child nodes, and the list of what can be cloned names "Lights." (M/learning/working-in-3d/cloners/). "Cloning of lights (long requested feature)" and "The number and quality of lights has been increased across all renderers. Lights are generated and culled on the GPU, allowing them to be cloned." [W1].
- **The culling is by tile, with a length.** "Increased the per-tile light limit from 32 to 64."; "Fixed a bug related to light tile culling, which could result in rendering artifacts at some resolutions."; "A “Lighting Far Plane” property was added to control the maximum distance used for light culling, which also affects scattering."; "Improved light culling performance and added support for various camera types" [R1]. The renderer page: `Lighting Far Plane`, "Controls the distance away from the camera at which lighting will no longer be calculated." (N/rendering/standard-renderer/).
- **Shading is from a visibility buffer.** `Render Mode` "Changes the method used for rendering the visibility buffer"; ambient occlusion reads "screen space data from the G-Buffer" (N/rendering/standard-renderer/). Antialiasing there is part of the renderer: Edge AA "Applies MSAA to the visibility buffer, then applies a single MSAA pass to all other lighting and shading passes, but using the information from the visibility buffer" (N/rendering/hybrid-renderer/). Transparency is sorted per node or per pixel, the latter "limited to 16 overlapping objects at once". *Inferred*: lighting is deferred, and it stays antialiased because the buffer it is deferred from is itself multisampled.
- **Shadows are per light and budgeted by the renderer.** `Casts Shadows` on each light; one `Shadow Map Resolution` "for all the shadow casting lights in the scene"; "Further away lights use lower shadow map resolutions, and are cut off after a certain distance." (N/rendering/standard-renderer/). "Added support for cloned lights and shadow maps." appears under the particle lighting node [R1]. *Inferred*: a cloned light casts if its Light does, and the renderer decides which maps are drawn and how large.
- **Scale.** "billions of polys, thousands of lights" (M/learning/lighting-and-renderers/nura-rendering-architecture/). No number is given beyond the per-tile 64.
- Not in the manual: whether a clone's colour reaches a cloned light; what happens to the sixty-fifth light of a tile.

### 1.3 Outside the two products (read)

The method chosen in section 2 is the common one on WebGPU. three.js: `ClusteredLightsNode(maxLights = 1024, tileSize = 32, zSlices = 24, maxLightsPerCluster = 64)`, "the view frustum is subdivided into a 3D grid of clusters (X × Y screen tiles times an exponentially-spaced set of Z depth slices) ... Unlike 2D tiled lighting, clustered shading culls lights that share screen pixels but lie at different depths" (https://threejs.org/docs/pages/ClusteredLightsNode.html). Bevy: `ClusterConfig::FixedZ`, "Fixed number of `Z` slices, `X` and `Y` calculated to give square clusters with at most total clusters" (https://docs.rs/bevy/latest/bevy/light/cluster/enum.ClusterConfig.html).

### 1.4 Comparison

| | TouchDesigner | Notch | Loom today | Loom proposed |
|---|---|---|---|---|
| Where lights come from | one Light COMP each (read) | a Light node; a cloner repeats it (read) | one Light node each, listed by name in the Render | a Light node; with Points wired, one light at every point |
| What varies per light | every parameter, per COMP (read) | the clone's transform; nothing else is documented (read) | every parameter, per node | place, colour, intensity, range, aim and cone, each a value or a mapped attribute |
| How many | "100s" in a scene, a limited number per object (read) | "thousands" (read) | any number, each one a block of shader in every lit draw; 37 measured at 24 ms | 1,024 points of capacity per Render in the first build, refused by name past it |
| Culling | none documented; the author masks per object (read) | on the GPU, by tile, 64 a tile, to a far plane (read) | none: every lit pixel evaluates every light | on the GPU, by cell (tile and depth slice), no length per cell |
| Lists | Light Mask on the geometry: which lights light it (read) | Affected Nodes and Excluded Nodes on the light (read) | none for lighting; Shadow Casters and Shadow Exclude on the light | Lit Only and Lit Exclude on the light, beside the shadow lists |
| Shadows | per Light COMP, with a caster list (read) | per light; the renderer sizes and cuts maps by distance (read) | per Light node: one sweep, or six for a point light | per Light in Single mode; a pointset's lights do not cast (follow-up: slots for the nearest) |
| Shading | forward, count compiled in (read) | from a visibility buffer (read); deferred (inferred) | forward, count compiled in | forward; listed Lights compiled in, pointset lights walked from the grid |
| Antialiasing with many lights | multisampled forward render (read) | Edge AA on the visibility buffer (read) | MSAA or SSAA on the lit draw | unchanged: the lights are in the lit draw |
| Transparent and additive | sorted blending or order-independent (read) | sorted per node or per pixel (read) | additive geometry is lit as any other; glass takes no lights | unchanged |
| Cost model | lights per object × pixels of that object (inferred) | lights per tile × pixels (inferred) | lights × lit pixels | lights in the pixel's cell × lit pixels, plus one build a frame |

Loom today is the TouchDesigner shape. The row asks for the Notch shape: lights as rows of data, culled on the GPU. What is taken from Notch is the data model and the culling. What is not taken is its visibility buffer, which is a renderer and not a feature (section 2.3).

## 2. The method

### 2.1 What the Render does today

- The Render lists Light nodes by name. Each light is three named `vec4f` uniforms and one generated block in the fragment stage of **every** lit draw (`lightBlock` in `sceneSurfaceModule`, and its twin in `sceneInstancesWgsl`). The count is structural: adding a light recompiles every lit shader.
- Nothing is culled. A block computes its falloff, its range window and the whole BRDF for every fragment, in or out of range.
- A casting light adds a shadow map (one sweep, or six faces of a cube atlas), one sampled texture on every lit draw, and its matrices in the uniform block.
- The Light has two types, Directional and Point. There is no cone.
- **Measured on the consumer's document** (sentinel-bot live tier, no casting light, 1280 × 720, 4× MSAA; section 5.2):

  | Light nodes | GPU per render | Wall, GPU drained | Pipeline compile |
  |---|---|---|---|
  | 5 (as shipped, shadows off) | 6.75 ms | 13.3, 12.9 ms | 157, 161 ms |
  | 13 | 7.54 ms | 13.8 ms | 803 ms |
  | 21 | 10.75 ms | 17.0 ms | 906 ms |
  | 37 | 24.05 ms | 31.0 ms | 1,227 ms |

  The cost is not linear: eight more lights are 0.8 ms, sixteen 4.0 ms, thirty-two 17.3 ms. The cause was not looked for. The tunnel has a lamp every 12.8 m. Its bore is drawn for 115 m, which is nine lamps, and the far plane at 240 m would be nineteen: between the 13-light and the 21-light row, before any of them casts, with a compile of about a second on every structural edit.

### 2.2 The three candidates

**(a) A loop over a storage buffer of lights.** The lit shader walks every light and leaves early when the fragment is out of its range. No grid.

**(b) Clustered forward.** A compute pass builds a grid over the view; a cell knows which lights touch it; the lit shader walks its cell's lights.

**(c) Deferred lighting from the G-buffer**, as the furnace does: a full-screen pass after the Render reads Depth, Normal and Albedo and adds the lamps.

**Measured in a probe** (a tunnel seen from inside, 1280 × 720, `rgba16float`, 4× MSAA, the Render's own GGX lobe and falloff; lights hung in rings so that a wall point is in reach of about five whatever the count; section 5.1). GPU time of the lit draw, and of the grid's build pass. The timer's step is 0.066 ms.

| Lights | Unrolled, as today | (a) Loop | (b) Grid, bitmask | (b) build | Grid of tiles only, no depth slices | Grid with lists of 64 |
|---|---|---|---|---|---|---|
| 16 | 0.72 ms | 0.26 ms | 0.20 ms | under a step | 0.46 ms | 0.20 ms |
| 64 | 1.38 ms | 0.52 ms | 0.20 ms | under a step | 0.66 ms | 0.20 ms |
| 256 | 9.31 ms | 1.84 ms | 0.33 ms | 0.07 ms | 2.23 ms | 0.26 ms |
| 1,024 | not run | 7.93 ms | 0.85 ms | 0.39 ms | 9.11 ms | 0.52 ms, and it drops lights |

- One light alone drew in 0.07 to 0.21 ms, so the grid at 16 and 64 lights is at the floor of what the probe can see.
- Lights walked per pixel, read back from the grid the device built: 2.0, 4.5, 9.9 and 11.1 for the four counts, where 1.9, 4.1, 6.6 and 5.4 are in reach. The fullest cell held 6, 18, 64 and 248 lights.
- **A grid of tiles without depth slices is useless in a tunnel**: every lamp down the bore stands behind the same pixels, so a pixel walks all 16, all 64, all 256, and 855 of 1,024. That is the consumer's scene, and it is why the grid has slices.
- **With every light reaching every pixel** (nothing to cull): the loop 1.84 ms at 64 and 8.91 ms at 256; the grid 2.23 and 10.62 ms. The grid's walk costs a fifth more than a plain loop when it cannot help. The unrolled blocks at 64 lights, which never leave early, were 1.38 ms: faster than either.

### 2.3 The choice: (b), clustered forward

**Against (a).** For the first consumer alone (a) would do: 75 lamps are about 0.5 ms in the probe. It is not chosen because it is linear in the count where the grid is flat: 1.84 against 0.33 ms at 256, 7.93 against 0.85 ms at 1,024. And (a) is not a different design: it is (b) with one cell. The records, the loop body and the bindings are the same. The grid is one dispatch more.

**Against (c).** Its cost is comparable. What rules it out is what it cannot light.

- **The multisampled colour target.** `msaaWhen` names the Render's `out` only: the Depth, Normal and Albedo outputs are single-sample. A deferred sum is computed per pixel from them and added to a resolved picture, so every edge is aliased in exactly the light the lamps give. In a tunnel lit by its lamps that is most of the light on every silhouette. The furnace has this, and has a temporal pass after it (`taa.ts`); sentinel-bot has none. Notch antialiases its deferred lighting by multisampling the buffer it shades from (section 1.2), and TouchDesigner's staff example says to switch antialiasing off. Loom's plan has no multisampled texture read.
- **Additive geometry, primitive instances, points and beams.** They write no G-buffer layer (`scene.ts`: an additive surface "writes no G-buffer layer"; primitive instances, points and beams "do not write it"). A deferred lamp does not light them. In the lit draw they take the same loop.
- **The material model.** The G-buffer holds normal, roughness, base colour and metallic. It does not hold which model shades the surface (lambert, phong, pbr) or a phong's specular colour, so a deferred pass shades everything with one lobe. `lamps.ts` does: GGX for all.
- **The lists.** Which geometry a light lights is known per draw. In a deferred pass it needs a geometry id per pixel, which is another G-buffer layer.
- **Passes.** Each layer is one more draw of every surface geometry (there is no multiple-render-target pass: `docs/mesh-instancing-design-2026-10-05.md`, F4). The consumer has Depth and Normal on for its finish chain; Albedo would be a third. Not measured here.
- Deferred keeps one real advantage: it shades each pixel once, where forward shades every fragment that passes the depth test. The Render has no depth prepass, so a scene with heavy overdraw pays for it. Section 9 names the row.

**For (b), the two reasons that decide.**

1. Lighting stays in the lit draw. One loop serves the multisampled target, SSAA, additive surfaces, mesh instances, every material model and Material · WGSL, and it is the loop body the Render already has.
2. The cost follows the lights that reach a pixel, not the count: flat to 64, 0.33 ms at 256, 0.85 ms at 1,024 in the probe, with a build of 0.07 and 0.39 ms.

### 2.4 The grid

- **Cells.** About 144 tiles on screen, as near square as the Render's aspect allows (16 × 9 for 16:9, 12 × 12 for a square), by 24 slices in depth: 3,456 cells. Slices are exponential between the camera's Near and Far, so each is 1.42 times as deep as the one before it for the consumer's camera (0.05 to 240). A probe with 32 × 18 × 32 cells was no faster (0.85 ms at 1,024 lights for both), so the grid is not a knob: these are constants of the generator, as the Render's ambient occlusion bias is (§V90).
- **A cell is a bitmask**: one bit per light slot of the Render, `ceil(capacity / 32)` words. Its invocation of the build pass walks the lights and sets the bit of each whose range sphere touches the cell's box in view space. One invocation owns one cell's words and writes nothing else: no atomics, no order to depend on, the same bits on every device and every replay (§V45).
- **Why not a list per cell.** A list has a length. The probe's fullest cell held 248 lights of 1,024: the far end of a tunnel, where the whole bore stands behind a few tiles and a slice is tens of metres deep. A list of 64 dropped 184 of them, and the only way to know is to read the GPU back. Notch documents such a length, and three.js defaults to one. A bitmask cannot overflow. It costs more to walk when the capacity is large and the cell nearly empty (0.85 against 0.52 ms at 1,024, where the list was also shading fewer lights); section 9 names the row that removes that.
- **The fragment** takes its tile from `position.xy` and its slice from its view depth, and walks the set bits of its cell's words with `countTrailingZeros`. Every texture read in the lit shader is a `textureLoad`, so nothing in the loop needs uniform control flow.
- **Culling is exact, not approximate.** A light with a Range contributes exactly zero at and beyond it (the window `(1 − (d/range)⁴)²` is clamped), so leaving it out of a cell it does not touch adds `+0.0`. The cell's box is grown by a part in ten thousand so that rounding between the build's `pow` and the fragment's `log` can only add a light to a cell, never lose one. The picture with the grid equals the picture with every bit set; that is slice 1's acceptance test.
- **An orthographic camera** has slices of equal depth and tiles that do not widen. `ortho` is a value of the Camera, so it is a flag in the build's uniforms and both forms are in the text, as the ambient occlusion resolve already has it.
- **A tile is a share of the picture, not a count of pixels.** Under SSAA the scene surface is twice the size and the grid is the same grid. Each Render builds its own grid for its own camera.
- **One storage binding on a lit draw.** The Render owns one buffer, its light table: the records and the cells as regions of it, bound whole and read by offset through the point kernels' accessors (`regionAccessorWgsl`, T1076). A fully attributed mesh Surface binds seven storage buffers today; eight is the baseline (§V588). Two bindings would not fit.

### 2.5 The existing Light nodes

> **Reversed by B260 (2026-10-06).** The first and last points below argue that unrolled blocks are the faster shape for lights that reach every pixel. That was read off 64 blocks in the probe's small shader. In the Render's own shader the straight chain of blocks is the slow path past about twenty (B260: 18.7 ms at 64 lights where a loop takes 1.1), and above eight each block now works under a test of its own (`LIGHT_GUARD_ABOVE`). Named Lights that do not cast become rows of the table (T1623b). What stands: slice 1 leaves a Light in Single mode as it is, a Render with no pointset Light emits the text it emitted, and the loop body is the light block.

- **A Light in Single mode is what it is today**: its uniforms, its unrolled block, its shadow map. A Render that lists no pointset Light emits today's passes and shader text byte for byte (§V309). The probe says why this is right and not only safe: for lights that reach every pixel, which is a Light as it is placed (Range defaults to 0, unlimited), the unrolled blocks were 1.38 ms at 64 where the loop was 1.84 ms and the grid 2.23 ms.
- **A Light in Points mode is rows in the Render's light table**, walked from the grid.
- **They are one shading function.** The loop body is the light block: `POINT_FALLOFF_WGSL` and `ggxSpecularWgsl` are interpolated into both, as they are already shared by the two generators and the preview (§V349). What differs is where the three rows come from (named uniforms, or a record) and that the record path leaves early out of range.
- **A document with both**:

  ```
  render_shot.lights = "light_sun light_eyes light_lamps"

  light_sun     Type: Directional, Cast Shadows     an unrolled block, a shadow sweep
  light_eyes    Type: Point, Cast Shadows           an unrolled block, a cube atlas
  light_lamps   Mode: Points, 75 points             75 records, walked from the grid
  ```

  The lit shader has two blocks and one loop. List order is light order for the blocks, as today; the records have no order that shows.
- **Named point Lights do not join the grid in this row.** A named Light with a Range would be culled there, and the probe says that is worth 0.72 against 0.26 ms at sixteen. It needs the shadow lookup inside the loop (a switch over the casting slots, since a shader cannot index its texture bindings), and it changes the text of every Render that has a pointset Light and a casting Light. It is a named follow-up (section 9), to be weighed on a document that has many named Lights.

### 2.6 Materials

- **Stock materials.** Lambert, phong and pbr take the loop where they take the blocks. Unlit takes neither.
- **Material · WGSL.** Nothing changes for the author. `surface()` returns albedo, roughness, metallic, normal and emissive; the blocks and then the loop run on what it returned. `fwidth` is taken before the loop, as now.
- **What an author must know**: three things.
  - The generator declares more names (`lightTable`, `lightCell…`, `lightRecord…`), and every name it declares is reserved (`SURFACE_RESERVED_NAMES`, derived from a run with every feature on). A material that declares one of them is refused by name, as today.
  - A material cannot read the lights. One that draws something of its own from a lamp (the consumer's `lampSeen` mirror, its haze) keeps its own parameters. Section 9 names the row.
  - The loop adds one storage buffer to the draw. A mesh Surface with uv, colour, surface and emissive rows is then at eight, the baseline.
- **Glass** takes no lights today (its generators have no light block) and takes none here.
- **Transparent surfaces.** The Geometry's Blend is Opaque or Additive; there is no alpha-blended surface. An additive surface is the lit generator with `additive: true` and gets the loop in slice 1. Primitive instances, points and beams draw through `sceneInstancesWgsl` and get it in slice 4.

## 3. The node surface

### 3.1 One node: the Light, with a Points input

- **Rejected: a new node** ("Lights from Points"). It would declare Color, Intensity, Falloff, Range, the cone and the two lists again, and two nodes that make light drift. The instancing design rejected a separate Instancer for the same reason (D2 of `docs/mesh-instancing-design-2026-10-05.md`).
- **The input** is `points` (label "Points"), a pointset that carries `position`, on a real wire: GPU data flows on wires (§V372). The Light draws no input socket today (its two list inputs are fed by name and are not rendered), and a node's port rows are the taller of its two columns (`nodePortRows`), so one input beside the one output makes no Light taller. No shipped layout moves.
- **The mode is a parameter**, `mode`: Single (default) or Points, compile-time. The wire alone could decide, as a Projector's cookie does, but then Position could not say that it is not read: `inactiveWhen` sees values, not wires (§V146). Points mode with nothing wired refuses by name. A wire in Single mode is not read, and the port's description says so; when sockets can hide (T1599b) this one hides in Single mode.
- **The name** is `light_<role>`: `light_lamps`. The kind is `light`; no row in `NODE_KINDS`.

### 3.2 Parameters

New or changed rows only. Everything else on the Light is as it is.

| Key | Label | Type, range | Default | Applies | In Map mode |
|---|---|---|---|---|---|
| `mode` | Mode | enum `single` \| `points`, compile-time | `single` | always | — |
| `kind` | Type | enum, **`spot` appended**; becomes compile-time (3.6) | `directional` | always | — |
| `color` | Color | colour, display space | white | always | a vec4f attribute, linear, multiplies it |
| `intensity` | Intensity | number, floor 0 | 1 | always | an f32, or one channel of a float vector, multiplies it |
| `position` | Position | vec3, world units | 1, 2, 1.5 | Single. Points: inactive, each light stands at its point | a vec3f attribute is each light's place instead of `position` |
| `range` | Range | number, floor 0, world units | 0 in Single (unlimited); **10 in Points** | Point, Spot | an f32, or one channel, multiplies it |
| `direction` | Direction | vec3, the way the light travels | −0.4, −0.8, −0.45 | Directional, Spot | a vec3f attribute, in world space, replaces it |
| `orient` | Orient | vec4, identity; Map mode only | 0, 0, 0, 1 | Points, Spot | a vec4f unit quaternion turns Direction per point |
| `cone` | Cone | number, 1 to 360, degrees, bounded | 60 | Spot | an f32, or one channel, multiplies it |
| `coneSoftness` | Cone Softness | number, 0 to 1, bounded | 0.4 | Spot | not mappable |
| `litOnly` | Lit Only | geometry names | empty | always | — |
| `litExclude` | Lit Exclude | geometry names | empty | always | — |
| `shadows` and the shadow rows | | | | Single. Points: inactive and ignored | — |

- **One rule for a mapped number or colour: the attribute multiplies the value**, as a Geometry's Size and a Sweep's Radius have it (T721). The number on the node stays live for every point, and the attribute is a factor. Set the value to 1 and the attribute is the number itself. A direction and a place have no product: the attribute stands alone, as a Geometry's mapped Orient does.
- **Cone** is the full angle at which the light reaches zero. **Cone Softness** is the share of the half-angle over which it fades: the light is full inside `(1 − softness) × cone / 2` and falls by `smoothstep` on the cosine to zero at `cone / 2`. 0.4 is the furnace's fixture (`fixtures.ts`: inner = 0.6 × outer). A cone of 359° or more is every direction, also as the furnace has it, so a pointset can mix spots and bare lamps by one attribute.
- **Orient** turns the Direction per point: `aim = R(orient) · direction`. With Direction (0, −1, 0) and the `orient` of Curve Frames, each lamp of a tunnel shines along its own frame's down. It is the Geometry's Orient: a vec4f quaternion, right-handed and active, Map mode only, identity otherwise (T723).
- **Range defaults to 10 in Points mode**, through `parametersFor`, as a mesh instance's Size defaults to 1 (O3 of the instancing design). The declared 0 is "unlimited", and an unlimited light is in every cell: every lit pixel pays for every one. That is legal and stated on the row, and it is the wrong default for a set. **A light whose range comes out at zero or less from a map is off**, not unlimited: a dead slot's attribute is zeros.
- **A light is off** when its intensity or its mapped range is zero or less, or its slot is beyond a counted pointset's live count. It sets no bit and costs no pixel. There is no Group on the Light: a subset is made upstream (a Range, a kernel), or by an intensity of zero, which is what TouchDesigner does with a dimmer under 0.001.
- **Units.** Place and range in world units, which the projects use as metres. Angles in degrees. Colour is linear in an attribute and display-referred on the node, as a Geometry's tint is. Intensity is the Light's own: with Inverse Square, the radiance at one unit.
- **Falloff** (Soft or Inverse Square) is one value for all points of a Light.
- **Maps this node honours**: `color`, `intensity`, `position`, `range`, `direction`, `orient`, `cone`. A map on anything else, any map in Single mode, and a map naming an attribute the points do not carry or of another type, each refuse by name with the list of what the points provide (the existing resolvers, §V288).

### 3.3 Which attributes are read by name

**`position`, and nothing else.** It is required of the edge, as every pointset consumer requires it.

- Every other per-light value is a parameter of the Light in Map mode, and the map names its attribute. The examples and the documentation use `color` (vec4f), `intensity` (f32), `range` (f32), `direction` (vec3f), `orient` (vec4f) and `cone` (f32), so a document reads `color: map("color")`.
- **When an attribute is absent**: an unmapped parameter is its value for every point, which is the default. A map that names an absent attribute refuses by name. It never reads as zero.
- **Why not pick attributes up by name**, as a material's `struct Instance` fields are (D9 of the instancing design). There the material declares the names it reads. Here nothing would: a light at every vertex of a Mesh File In would take the file's vertex `color`, and a kernel that grows an attribute called `range` for its own use would change the lights. TouchDesigner's instancing is an explicit pick per parameter for the same reason.

### 3.4 The lists

Two more name lists on the Light, in the idiom of Shadow Casters and Shadow Exclude (T1598b), in both modes:

| Parameter | Meaning | Empty |
|---|---|---|
| Lit Only (`litOnly`) | the only geometries this light lights | every geometry the Render draws is lit |
| Lit Exclude (`litExclude`) | geometries this light does not light | none is taken out |

- The geometries lit by light L in Render R are R's geometries, kept if Lit Only is empty or names them, less what Lit Exclude names. Exclude wins.
- **Names, registered as source references**, so a rename rewrites them (§V128), a dangling name is a compile error that names it (§V369), and a name that is not a geometry is refused by type. Each is a reference-fed input, as the shadow lists are.
- **Resolved by the Render**, by geometry node id. A light may serve several Renders; each filters its own geometries. A list that leaves none of a Render's geometries is a warning there (`node.scene.litGeometry`).
- **Lighting only.** A geometry a light does not light still casts that light's shadow if the shadow lists say so: a body can block a light that does not light it. Notch's two lists govern both at once; here the four lists say two things.
- **Structure.** The lists decide which draws read which lights; editing one is a recompile.
- **In the shader.** For a Light in Single mode the draw of a geometry it does not light has no block for it: a generator option names the light indices left out, and a Render with no list emits today's text. For a Light in Points mode each record carries its Light's number and the draw a mask of the pointset Lights that light it, one more uniform, tested first in the loop. Both exist only when a list does.
- TouchDesigner puts the list on the geometry (Light Mask). The shadow-caster row ruled for the light's end, and its reason holds here: a per-geometry switch cannot say "not by this light".

### 3.5 Shadows for a chosen few

**The rule in this row**, as `docs/shadow-casters-design-2026-10-05.md` ruled it: a point of a pointset has no name to hang a list on, so **a casting light is a Light in Single mode**, listed in the Render beside the pointset Light, with its own Shadow Casters and Shadow Exclude.

- **Which few**: the ones the author places. The consumer has this today: three Lights that stand at the three stations nearest the robot, by expression.
- **So that a lamp is not lit twice**, the pointset's kernel dims the stations the named Lights stand at, by the weight they fade with (the consumer's `near`). The two weights sum to one, so the set changes with nothing lit changing.
- **What it costs.** Per casting point light with a caster list, on the consumer's live tier: 1.2 to 1.6 ms of GPU (measured, `docs/geometry-cost-profile-2026-10-05.md`, "Each light on its own"). Five are 7.0 ms, half the frame. Each is one sampled texture of the sixteen a lit draw may bind (`node.scene.textureBudget`). So the few is two to four at 60 frames a second on this machine (computed from those figures).
- **Cast Shadows on a Light in Points mode** is inactive and ignored, and its row says where the shadow belongs.

**What Notch does instead, and the follow-up.** Every light may cast, and the renderer budgets the maps by distance. The Loom shape of that is a number on the pointset Light, Shadow Slots: that many cube atlases, given each frame on the GPU to the lights nearest a focus (the camera by default), each fading as it nears the edge of the set so that a change of owner is not a pop. It needs the shadow sweep to read its light's place from a buffer instead of a uniform, the lit lookup to do the same, and the reach test of T1598b to do without a CPU position. It is designed as a row in section 9 and not built here.

### 3.6 Type: Spot, and `kind` becomes compile-time

- **Spot is a type of the Light in both modes**, so that a cone is not something only a pointset has. In Single mode a spot is one more uniform row (`light{i}Aim`: direction, cosine of the outer half-angle) and the cone factor in its block, emitted for the lights that are spots.
- **For that, `kind` must be compile-time.** Today it is a value (the block branches on `lightMeta.x`). As a value it could not add a row without changing the text of every Render (§V309), and Points mode could not refuse Directional without a refusal decided by a value (§V453). The cost: changing a Light's Type recompiles. It is an enum, not something a document animates.
- **In a record** a point light is a spot with a cosine of −2: one shape, no branch on type.

### 3.7 The Light's description

`list_node_definitions` ships the description and not a parameter's own text (T1214), so the mode goes there:

> A light other nodes reference by NAME: a Render lists any number in its lights parameter. Directional lights travel along Direction; Point lights sit at Position; Spot lights sit there and shine along Direction inside Cone. Mode: POINTS repeats the light at every point of the Points input, N lights from ONE node, never N nodes: each stands at its point's position, and Color, Intensity, Range, Direction, Orient and Cone take a per-point attribute in Map mode. A Render culls such lights by their Range on the GPU, so a lamp every few metres of a long set costs what the lamps near each pixel cost; give them a Range. Lit Only and Lit Exclude choose which geometries a light lights. Only a light in Single mode casts shadows.

### 3.8 Refusals and limits, all by name

| Code | Where | When |
|---|---|---|
| `node.scene.lightPoints` | Light | Mode: Points with nothing wired to Points |
| `node.scene.lightKind` | Light | Mode: Points with Type: Directional |
| `node.parameter.map` | Light | a map this node does not honour, or in Single mode; an absent or mistyped attribute |
| `node.scene.reference` | Light | a list names a node that is not a geometry |
| `node.scene.lightCapacity` | Render | its pointset Lights hold more than 1,024 points of capacity together; names each Light and its capacity |
| `node.scene.lightSources` | Render | more than seven pointset Lights (3.9). Gone with T1623b slice 3: a gather pass a set (15.1) |
| `node.scene.litGeometry` (warning) | Render | a Light's lists leave none of this Render's geometries |
| the binding budget (`compiler/bindings.ts`) | compiler | a lit draw that would bind a ninth storage buffer |

### 3.9 What is emitted

```
pointKernel ──▶ light (Mode: Points) ──by name──▶ render

light_lamps:lights:resolve     dispatch, one invocation a point
  reads   the points' attributes (one binding a producer), the Light's values
  writes  scratch:light_lamps:lightRecords    place, colour × intensity, aim, cone

render_shot:lights:gather      dispatch, one invocation a slot
  reads   each pointset Light's records
  writes  the records region of scratch:render_shot:lightTable, with each Light's number

render_shot:lights:grid        dispatch, one invocation a cell
  reads   the table's records, the camera
  writes  the table's cells

render_shot:scene:<i>          every lit draw binds the table, once
```

- **The Light owns its resolve pass and its records** and publishes them on its payload, as a Geometry owns its instance records (D8). Two Renders that list one Light resolve it once. The record is `place` (xyz, range), `color` (rgb × intensity, falloff law), `aim` (xyz, cosine of the outer half-angle), `cone` (cosine of the inner): 64 bytes a light, in the packed layout every producer uses.
- **The Render owns the table.** Its lit draws may bind one buffer, so it copies the records of every pointset Light it lists into its own, one after the other. The gather pass binds the table and one record buffer per Light: eight storage buffers is seven Lights. More is refused by name; chaining a second gather is a follow-up.
- **The capacity is the contract.** A Render's table has as many slots as its pointset Lights have capacity, live or not, and at most 1,024. Dead and dark slots cost nothing per pixel, but they count. This is what makes the limit a compile-time fact: a table compacted to its live lights would overflow at run time, on the GPU, where nothing can say so.
- **Order.** The three dispatches are emitted in the Render's shadow phase, before the backdrop, so they do not split the run of draws into the colour target (T1604b). The generators are wrapped by `generatedOnce`, so a values-only frame builds no text (T1603b).
- **Values.** The camera and the Light's own values reach the passes as uniforms. A turning camera, a breathing Intensity and a driven Range are writes, never a rebuild (§V5).

### 3.10 The baseline tier

`TIER_B_CAPABILITIES` reports no features and one limit; every other limit is the WebGPU floor. The design needs compute passes and storage buffers read in the fragment stage, both core, and stays inside the floor: one more storage buffer on a lit draw (eight of eight at worst), no more sampled textures, no more uniform blocks, a workgroup of 64, a table under half a megabyte. **It runs on the baseline tier.** One draw can go over: primitive instances whose Group predicate reads four or more attributes while Tint, Size and Orient are all mapped bind eight today and nine with the table. The existing budget diagnostic refuses it by name, and only in a Render that lists a pointset Light.

## 4. Culling

- **Where: on the GPU.** A pointset's lights exist only there, written by a kernel that frame. There is no readback anywhere in the path.
- **Against what: the view, by range.** A light is in a cell when its range sphere touches the cell's box. A light outside the frustum whose range reaches in is in the cells it reaches. A light beyond the camera's Far, or wholly outside the view, is in none.
- **Per frame.** The grid is rebuilt every frame from that frame's lights and that frame's camera. It keeps nothing between frames.
- **The shadow reach idea.** T1598b skips a shadow draw when a geometry's CPU sphere is out of a light's range. The grid is the same test, light against cell, per pixel and on the GPU, so it needs no bound from the geometry and reaches kernel-moved and instanced geometry, which T1598b cannot. A per-geometry test would add nothing to it for pointset lights. It could skip the block of a Single light for a far geometry, but that is a value and cannot change the text; it belongs with the follow-up that moves named Lights into the grid.
- **The cost per frame** (the probe, measured; 3,456 cells):

  | Lights | Build, GPU | Lit draw, GPU | Walked per pixel | Fullest cell | Cells, memory |
  |---|---|---|---|---|---|
  | 16 | under 0.07 ms | 0.20 ms | 2.0 | 6 | 14 KB |
  | 64 | under 0.07 ms | 0.20 ms | 4.5 | 18 | 28 KB |
  | 256 | 0.07 ms | 0.33 ms | 9.9 | 64 | 111 KB |
  | 1,024 | 0.39 ms | 0.85 ms | 11.1 | 248 | 442 KB |

  The memory column is computed. On the CPU the path is three dispatches more a frame. By the geometry profile's figures (about 0.03 ms of encoding a pass, and a values-only compile of 2.3 ms over this document's 58 passes) that is 0.1 to 0.2 ms, computed.
- **Limits, and what happens past them.**
  - More than 1,024 points of capacity in one Render: a compile error naming the Lights (`node.scene.lightCapacity`).
  - More than seven pointset Lights in one Render: a compile error (`node.scene.lightSources`). Lifted by T1623b slice 3 (15.1).
  - A cell cannot overflow.
  - A light without a Range is in every cell. That is slow, not wrong, and the Range row says it.
  - Nothing is decided on the GPU that the CPU would have to report.

## 5. Cost model, and how the numbers were taken

**The model.** A lit pixel costs the blocks of the Render's Single lights, plus a walk of its cell: `ceil(capacity / 32)` word reads, and for each set bit one record and one range test, and for each light in reach the BRDF. The frame costs one build, cells × capacity sphere tests. A casting light costs what it costs today.

### 5.1 The probe (measured)

- A scratch script, not in the repository: raw WebGPU on the device `vgpu/node` hands out, so it is the technique and not the engine's path. Apple M3 Max, Dawn on Metal, headless.
- A tube 2.6 m in radius and 240 m long seen from inside, 1280 × 720, `rgba16float`, 4× MSAA, every pixel covered once. The fragment shader is the Render's GGX lobe, its inverse-square falloff and its range window, with a cone.
- Four ways of handing it N lights: N unrolled blocks reading named uniforms with no early exit (the Render today); a loop over a storage buffer with the range test first; the grid as a bitmask; the grid as lists of 64.
- Lights hang in rings 0.35 m inside the wall, spaced so that the count per wall area and the range (1.25 spacings) keep about five in reach of a wall point: range 19.6, 9.8, 4.9 and 2.4 m for 16, 64, 256 and 1,024.
- Each figure is the median of 60 frames after 15, from a timestamp query pair on the pass, each frame waited for. The timer's step is 0.066 ms. Pipeline creation for the unrolled text: 3, 9 and 34 ms for 16, 64 and 256 lights.
- "Walked per pixel" is counted on the CPU over every eighth pixel from the cells read back off the device; "in reach" is computed from the light positions.
- What it is not: the Render's shader (no shadows, no environment, one constant material), a browser, or more than one machine.
- **Taken without a clock reference** (B260): each way ran its frames in a block of its own, one after another, and the GPU's clock moves with its recent load. The table's columns are not comparable to the hundredth it prints. Section 5.4 re-takes the two rows a decision rested on.

### 5.2 The consumer's document (measured, one run)

- `sentinelDocument`, live tier, one robot, 1280 × 720, with the five lights' Cast Shadows off, and then with 8, 16 and 32 more Light nodes (Point, Inverse Square, Range 30, no shadow) named in the Render's Lights: the lamps a forward Render would need.
- The frame run as the app runs it (the value graph, the values-only compile, the uniform animator, the render), with a copy of the scratch harness of `docs/geometry-cost-profile-2026-10-05.md`. The lights were added to the built document in the script; the consumer's files were not edited. Apple M3 Max, Dawn on Metal, headless. Medians of 180 frames after 30. GPU time is the sum of the render's frame extents from timestamp queries; wall time is a frame with the output read back.
- The control was run twice in the run and repeated to the hundredth: 6.75 and 6.75 ms without shadows, 13.70 and 13.70 ms as shipped.
- The table is in section 2.1. With the five shadows on and sixteen more lights the frame was 18.68 ms of GPU against 13.70 ms.
- Pipeline compilation is `backend.compile` of the plan, once per document, in the order the variants ran.
- The harness also sums GPU spans by group. Spans overlap on this GPU (T1243: the frame figure is the extent, "never a sum of the spans"), and those sums were several times the extent in every variant. They are not used here.
- **Taken without a clock reference too**, and its rise with the light count is B260: the cause was found there (the chain of sums), measured against a reference, and answered by the guard. Use that document's figures for what a Light node costs, not the table of section 2.1.

### 5.3 What the consumer should expect (computed)

- A lamp at every station of the 960 m lap is 75 points: three words a cell.
- Range 30 m at 12.8 m apart puts 4.7 lamps in reach of a point on the axis. The probe walked 1.05 to 1.5 lights for each one in reach at 16 to 256 lights, so a pixel walks five to seven lamps.
- Eight more Light nodes cost this document 0.79 ms, a tenth of a millisecond for a light every pixel evaluates. Five to seven lamps a pixel should therefore be in the region of 0.5 to 0.8 ms of GPU for all 75, where sixteen of them as Light nodes are 4.0 ms and thirty-two 17.3 ms. That takes the smallest of the measured slopes, and the slope rose with the count for a reason not found, so it is an estimate. Slice 1's acceptance replaces it with a measurement.
- The five cube shadows stay 7.0 ms. This row does not touch them.
- Replaced by the measurement of section 13.4.

### 5.4 The measurement rule, and the grid against the loop re-taken (measured)

**The rule** (B260, for every figure from here on): a fixed reference compute pass is submitted beside every frame and timed by its own timestamp pair; the variants alternate in one process; a figure is given raw and as a share of the reference taken beside it; raw milliseconds are never compared across runs. "At full clock" is a share times the fastest reference median of its run.

The probe of 5.1 again, the same scene and shaders, with the two ways alone: the plain loop (a), and the grid of bitmasks with its build (b). Bursts of six frames a variant, the first two dropped, round after round. Two runs, with a reference of 0.59 and of 2.82 ms.

| Lights | Run | (a) loop, raw | (a) share of reference | (b) grid + build, raw | (b) share | (a) over (b) |
|---|---|---|---|---|---|---|
| 256 | 1 | 1.57 ms | 2.67 | 0.33 + 0.07 ms | 0.75 | 3.6 |
| 256 | 2 | 1.70 ms | 0.595 | 0.59 + 0.13 ms | 0.244 | 2.4 |
| 1,024 | 1 | 6.49 ms | 9.78 | 0.92 + 0.39 ms | 2.07 | 4.7 |
| 1,024 | 2 | 6.29 ms | 2.09 | 0.79 + 0.39 ms | 0.429 | 4.9 |

- **The choice stands.** The grid with its build is 2.4 to 3.6 times cheaper than the loop at 256 lights and 4.7 to 4.9 times at 1,024. Section 2.3 said 1.84 against 0.33 ms and 7.93 against 0.85 ms, which leaves the build out and reads more into the hundredths than they hold.
- The grid's lit draw is a few steps of the timer (0.066 ms), so its share moves by a third between frames. The first run's reference was nine steps long, too short; the second is the one to quote.
- Nothing else of 5.1 was re-taken: the unrolled column is B260's subject, and the lists and the grid without slices were ruled out by what they do, not by a figure.

## 6. Time and determinism

- **There is no frame of latency.** A pointset edge names the half that holds this frame's data (§V231). The plan orders the kernel's dispatch, then the Light's resolve, then the Render's gather and grid, then the lit draws, all in one frame: a lamp the kernel moved in frame f lights frame f from where it is in frame f. Slice 1 has a test for exactly this.
- **Substeps and kernel steps** (T1583b) run inside the kernel's own loop region; the resolve runs once after it and reads the last state.
- **Nothing is kept.** No pass here reads its own output of the frame before, so there is nothing to reset on a seek (§V170), and a frame rendered alone equals the same frame in a run.
- **Deterministic by construction.** Each record is written by one invocation and each cell's words by one. No atomics, no scan, no hash, no clock.
- **A counted pointset** (one that spawns and kills) moves its slots under compaction (§V73). A light is a row of this frame's values, so that does not show: nothing here keeps a slot's identity across frames. Shadow slots would (section 9).
- **Where latency would come from.** A CPU reader of a GPU pointset is a frame late (the curve design's C2). Nothing in this design reads the lights on the CPU. A pass outside the Render that wants a lamp's place takes it as a parameter, as the consumer's haze does today.

## 7. The furnace switch-over

`lamps.ts` lights the furnace's surfaces from 65 fixtures after the Render: a Custom WGSL · Multi over the lit frame with Depth, Normal and Albedo, the fixtures baked into the shader as constants (`fixtureTableWgsl`), every fixture walked for every pixel.

**Becomes the stock path**

- The fixtures as points: one Light, Type: Spot, Mode: Points, 65 points, with `color`, `intensity`, `range`, `direction` and `cone` mapped.
- The lighting itself. `lampsWgsl` and the `lamps` node are deleted. The lamps are in the Render's colour, so they are antialiased by its MSAA, they light the additive and instanced geometry, and the surfaces take them through their own material model.
- The reach by brightness: the fixture kernel writes `range = sqrt(peak / cutoff)` per fixture per frame. The stock window is the furnace's own, `(1 − (d/range)⁴)²`.

**Stays project code**

- Reading the fixtures out of the GLB's markers (`fixturesOf`).
- **How a fixture behaves**: the area dimmers, the chase, the failing ballast's stutter, the beacon's turn, the riders on the two crane bridges (`LAMP_FUNCTIONS`, `LAMP_PARAMS`). This moves from "for every pixel, for every fixture" into a point kernel generated from the same table, which writes the 65 points once a frame. It is the furnace's own rig-kernel idiom.
- The atmosphere (`atmosphere.ts`), which lights the smoke from the same table. It keeps its baked copy until a pass outside the Render can read a Light's records (section 9). Both come from `fixturesOf`, so a fixture moved in Blender still moves both.
- The global illumination and the screen-space passes. `GI_COMPOSITE` reads Albedo, so Albedo Output stays on.

**What will differ, to be looked at in a render pair**

- The specular lobe. `lamps.ts` uses a Schlick-GGX geometry term; the Render uses the height-correlated Smith term (`ggxSpecularWgsl`). The diffuse is the same (neither divides by π, on purpose).
- Near a fixture. `lamps.ts` holds the distance at 0.5 m; the Render's inverse square holds it at 1 cm. A high bay under the roof will burn the roof more. Whether that wants a source radius on the Light is a question for that slice (section 10).
- Edges, which are no longer aliased in the lamps' light.
- `solo`, the tuning switch that shows the lamps alone, is gone; a Render with no ambient and no other light is the same view.

On-nothing has a fixture pass of the same kind (T1402b says so). It was not read for this document.

## 8. Slices

Each lands and is tested on its own. Dawn tests assert exact or analytically derived values (§V147), through the compiler and the backend.

**Slice 1. Point lights from a pointset, culled.** The consumer's slice.

- Built: `mode` and the Points input; maps on `color`, `intensity`, `position`, `range`; the resolve pass and the records on the Light's payload; the gather and grid passes; the loop in the Surface generator (grids, meshes, mesh instances, additive surfaces, Material · WGSL); the capacity and source refusals; `parametersFor` for Range.
- Acceptance:
  1. **What the consumer reads back.** A floor under three lights from a three-point pointset, red, green and blue, far enough apart that their ranges do not meet. The pixel under each reads that light's value from the formula (albedo × colour × intensity ÷ height² × window) and none of the others. With the Light taken out of the Render's Lights those three pixels read ambient; with the Color map cut, each reads the white light's value.
  2. **Culling is invisible.** 300 lights over a scene, a moving camera, five frames: the picture equals, byte for byte, the picture drawn through a grid of one cell, in which every pixel walks every light the view can reach. The generator takes its grid's dimensions as an argument and the node passes the constants, so the reference needs no switch in the product. This is T1598b's own test of its skip. Seen red by shrinking a cell's box.
  3. **No latency.** A kernel steps one light a known distance each frame. The brightest floor pixel of frame f is under the light's place in frame f.
  4. **Dead slots are dark.** A counted pointset with one of two points killed: its pixel reads ambient.
  5. **A map multiplies.** Intensity 2 with an attribute of 0.5 reads as intensity 1 with none.
  6. **The limits refuse by name**, with no device: 1,025 points; eight pointset Lights; Points with nothing wired; a map on `shadowBias`; a map naming an absent attribute.
  7. **The budget.** A mesh Surface with every row compiles with eight storage buffers at the baseline tier and no diagnostic.
  8. **Nothing else moved.** A Render with no pointset Light has the plan it had: the hash of the plan before and after on E13, E33, E28, E69 and E79, the five the generated-text gate uses.
  9. **Values stay values.** A driven Intensity, Range and Color on a Points light stay on the values-only frame path; `generated-text.test.ts` sees no generator run.
  10. **Antialiased.** With Antialias: MSAA, the row of pixels across a lit silhouette holds a value strictly between its two sides.
  11. **Device calls.** Three compute passes more; the colour target is still one run.
  12. **The consumer's frame**, measured as section 5.2 was: 75 lamps as one Light against the same document with none.
- A thinner first landing exists if wanted: the same slice with a grid of one cell is candidate (a), and is a true prefix.

**Slice 2. Cone and aim.** Type: Spot in both modes; `cone`, `coneSoftness`; maps on `direction`, `orient`, `cone`; `kind` compile-time.

- Acceptance: a spot aimed straight down at a floor. The pixel on the axis equals the point light's; a pixel outside the cone reads ambient exactly; a pixel inside the inner angle equals the point light's at that pixel. With `orient` mapped to a quarter turn the brightest pixel moves to where the turned axis meets the floor, and with the map cut it moves back. A Render with no spot has the plan it had. Changing Type recompiles and is correct after (the structural-parameter gate).

**Slice 3. The lists.** Lit Only and Lit Exclude, both modes.

- Acceptance, on Dawn and byte for byte, in T1598b's pattern: a geometry a light excludes has the pixels it has with that light gone, while its neighbour keeps the pixels it has with the light there; the excluded geometry still casts that light's shadow on the neighbour; Lit Only alone; a rename rewrites both lists; a dangling name and a camera's name each refuse; a list that leaves nothing warns; a Render with no list has the plan it had.

**Slice 4. Every lit draw.** The loop in `sceneInstancesWgsl`: primitive instances, points and beams with a lit material.

- Acceptance: a lit box instance and a lit spherical point under a pointset light each read the formula's value; the loop text in the two generators is one exported string (§V349); a draw at nine storage buffers is refused by the budget diagnostic, by name.

**Slice 5. The furnace.** Section 7.

- Acceptance: `lamps.ts` and its node are gone and nothing imports them; the furnace's own gates; three stills before and after, for the owner; the frame's GPU time before and after from the project's render script.

Slices 2 and 3 are independent of each other. Slice 5 needs 1 and 2.

## 9. Accepted limitations, as rows to file

1. **SHADOW SLOTS FOR THE NEAREST LIGHTS OF A POINTSET LIGHT.** A pointset's lights do not cast; the casting few are Lights in Single mode, and the pointset's kernel dims the ones they stand in for. wanted: `shadowSlots` on a Light in Points mode, that many cube atlases given each frame on the GPU to the lights nearest a focus (the camera, or a named node), each fading as it nears the edge of the set. needs the point-light sweep and the lit lookup to read a light's place from a buffer, the reach test of T1598b to do without a CPU position, and a slot's sweeps skipped when its light is out of view. Notch budgets shadow maps by distance ("Further away lights use lower shadow map resolutions, and are cut off after a certain distance"). cost per slot as a casting point light today, 1.2 to 1.6 ms on the consumer.
2. **NAMED POINT AND SPOT LIGHTS IN THE GRID.** A Light in Single mode is an unrolled block evaluated by every lit pixel. with a Range it could be a record and be culled (probe: 0.72 against 0.26 ms at sixteen lights of which two reach a pixel), and a casting one would take its shadow inside the loop by a switch over the slots. it changes the text of a Render that has both, and for unlimited lights the blocks are faster (1.38 against 1.84 ms at 64). decide on a document with many named Lights. **Overtaken by B260: filed as T1623b and REQUIRED, for the Lights that do not cast; section 13.3 says what slice 1 already holds for it.**
3. **A TWO-LEVEL MASK, AND CAPACITY PAST 1,024.** A cell's walk reads every word of its mask: 32 at 1,024 lights, where a list of the same lights was 0.52 against 0.85 ms. one summary word per cell that says which words are set makes the walk follow the lights present, and the capacity can then rise.
4. **A CONE AGAINST A CELL.** A spot is culled by its range sphere. A narrow spot is in every cell of that sphere and leaves each pixel by its cone test. a cone-against-box test in the build would keep it out.
5. **A PASS OUTSIDE THE RENDER READS A LIGHT'S RECORDS.** A Custom WGSL binds textures, not pointsets, so a haze or air pass cannot read the lights: the furnace's atmosphere keeps a baked copy of its fixtures and the consumer's haze takes five lamp positions as parameters. wanted with the stock air pass of T1402b: the records as an input, or a `// @use lights` module. the same answers a Material · WGSL that wants to draw from a lamp.
6. **MARKERS OF A GLB AS A POINTSET.** The furnace and on-nothing each turn `lamp.*` markers into generated shader text. wanted: Mesh File In publishes a selection of markers as points (position, direction, and the numeric extras as attributes), so fixtures reach a Light with no generated code.
7. **MORE THAN SEVEN POINTSET LIGHTS IN A RENDER.** The gather pass binds one record buffer a Light. chain a second gather, or let a pointset merge upstream (there is no merge node).
8. **HOW MANY LIGHTS A PIXEL WALKED, AS A VIEW.** The count is on the GPU. a debug output of the Render (lights walked per pixel) and a figure in the performance panel would say where a set is too dense or a Range too long.
9. **A LIGHT'S TILE IN POINTS MODE** shows the stock scene under the node's own values. wanted: the set, as points in their colours.
10. **GLASS TAKES NO LIGHTS.** As today: the glass generators have no light block, so a lamp has no highlight on a pane. not changed by this row.
11. **NO DEPTH PREPASS.** Forward shading pays the lights for every fragment that passes the depth test. with many lights, heavy overdraw multiplies the loop; the Depth output's sweep, drawn first into the colour target's depth, would make every lit fragment a visible one. measure on a scene with overdraw before building.
12. **AREA LIGHTS, PROJECTION IMAGES AND IES PROFILES PER LIGHT.** Notch has all three on its lights. not designed here; a Projector is Loom's light with a picture and is one node each.

## 10. Open questions

**For the lead**

| | Question | Recommendation |
|---|---|---|
| L1 | The Light with a Points input and a Mode, or a new node | The Light. One node makes light; no shipped layout moves (3.1). |
| L2 | Per-point values by Map mode, or picked up by attribute name | Map mode. `position` alone is read by name (3.3). |
| L3 | The names: `mode` (Single, Points), `litOnly`, `litExclude`, `cone`, `coneSoftness`, `orient` | As written. Lit Only and Lit Exclude stand beside Shadow Casters and Shadow Exclude and cannot be taken for them. |
| L4 | `kind` becomes compile-time | Yes. It is what lets Spot add a row without touching any existing text, and Points refuse Directional by structure (3.6). |
| L5 | A Light in Single mode keeps its unrolled block, even in a Render with a grid | Yes, in this row. Row 2 of section 9 moves them, after a measurement on a document that wants it. **Reversed by B260 after the ruling: T1623b moves the Lights that do not cast, straight after slice 1.** |
| L6 | Shadow slots: a slice of this row, or their own row | Their own row, filed now. The ruled shape (named casting Lights) serves the consumer today, and slots touch the sweep and the reach test. |
| L7 | 1,024 points and seven pointset Lights a Render as the first build's limits, each a named error | Accept. Both are structural and lifted by rows 3 and 7. |
| L8 | Range defaults to 10 in Points mode through `parametersFor` | Yes, as O3 did for a mesh instance's Size. |
| L9 | A mapped number multiplies the value (Intensity, Range, Cone); a mapped colour multiplies; a mapped place or direction replaces | Yes. It is T721's rule and the Sweep's. |
| L10 | Cast Shadows on a Points light is inactive and ignored, not a refusal | Inactive. Flipping Mode on a casting Light should not stop the render. |
| L11 | A source radius on the Light (the furnace holds distance at 0.5 m) | Decide in slice 5 from the render pair. Do not add it before. |
| L12 | Slice 1 whole, or first with one cell | Whole. The grid is one dispatch and the test that proves it is the simplest one in the slice. |

**For the consumer**

| | Question | Recommendation |
|---|---|---|
| C1 | One point per station of the lap (75), or only the stations in the window | All 75. Culling makes the far ones free and the kernel needs no window. |
| C2 | Which lamps cast | Keep the three named casting Lights as they are and dim their stations in the lamp kernel by `1 − near`. Say how many slots row 1 should be designed for. |
| C3 | Range 30 m at 12.8 m apart is 4.7 lamps on every pixel | It is the cost: about a fifth less at Range 24. Your call on the look. |
| C4 | Points or spots for the plates | Spots pointing along the frame's down would stop a plate lighting the crown beside it; that is slice 2 and `orient` from the path's frame. |
| C5 | The motes are lit in their kernel today, the haze takes five lamp positions | Leave both. Lit points take the stock lamps in slice 4; the haze waits for row 5. |
| C6 | Lit Exclude: is there a geometry the lamps should not light | None seen in the document. Say if there is one. |

**Answered by the consumer, 2026-10-06** (through the lead). C1: all 75 stations, one Light. C2: no lamp casts on its live tier; offline, three named lamp Lights cast, their stations dimmed in the kernel by 1 minus near. C3: Range 24, given that the falloff is windowed to zero at the range (it is). C4: spots, a cone of about 150 degrees with a high Cone Softness and `orient` from the path's frame, so slice 2 follows slice 1 directly. C5: leave the motes and the haze. C6: nothing excluded. Sections 3.1 to 3.5 fit, and Map mode per parameter is right. Two things it added: several pointset Lights in one Render, each with its own values (tested in slice 1 with three); and for shadow slots (T1622b), design for 2 on a live tier and 4 offline, with a NAMED NODE as the focus, not the camera. For T1626b the record a pass reads must carry direction and cone as well as place, colour and intensity: slice 1's record holds place, range, colour times intensity and the falloff law, and slice 2 adds the aim and the cone as two more rows (13.2).

## 11. Sources

Fetched on 2026-10-06. Notch pages were read from the page source, since the manual's navigation fills a summarising fetch; their quotations are the page's own words. TouchDesigner, three.js and Bevy pages were read through a fetch that returns extracts: a quotation from them is as the extract gave it, and where `docs/td-notch-mechanisms-2026-10-05.md` quotes the same sentence the two agree.

- TouchDesigner: https://docs.derivative.ca/Light_COMP , https://docs.derivative.ca/Render_TOP , https://docs.derivative.ca/Geometry_COMP , https://docs.derivative.ca/Write_a_GLSL_Material , https://docs.derivative.ca/Phong_MAT_Shader_Resource_Usage , https://docs.derivative.ca/PBR_MAT (states nothing about a light count).
- TouchDesigner forum: https://forum.derivative.ca/t/glsl-or-phong-shading-3-closest-lights-only/7986 , https://forum.derivative.ca/t/light-instancing-similar-to-geometry-instancing/145354 , https://forum.derivative.ca/t/deferred-shading/497 .
- Notch 2026.2: https://manual.notch.one/2026.2/en/docs/reference/nodes/lighting/ , `…/lighting/light/` , `…/lighting/spot-light/` , https://manual.notch.one/2026.2/en/docs/reference/nodes/rendering/standard-renderer/ , `…/rendering/hybrid-renderer/` , https://manual.notch.one/2026.2/en/docs/learning/working-in-3d/cloners/ , https://manual.notch.one/2026.2/en/docs/learning/lighting-and-renderers/nura-rendering-architecture/ , https://manual.notch.one/2026.2/en/docs/whats-new/everything/ (nothing on lights).
- Notch 2026.1: https://manual.notch.one/2026.1/en/docs/whats-new/everything/ , https://manual.notch.one/2026.1/en/docs/whats-new/release-notes/1-0-0/ .
- https://threejs.org/docs/pages/ClusteredLightsNode.html , https://docs.rs/bevy/latest/bevy/light/cluster/enum.ClusterConfig.html .

## 12. Not checked, and found on the way

**Not checked**

- Neither program was run. Notch's `/reference/nodes/wip/` pages return 401. Its algorithm is known here only from release-note sentences.
- TouchDesigner's 2025 release notes were searched, not read through, for a many-light feature; none was found.
- The probe is one synthetic scene on one machine through raw WebGPU. No browser run, and no device at the baseline limits: section 3.10 is reasoned from the limits.
- The proposed path on the consumer's document is computed (5.3). Only today's path was measured there.
- Deferred was not prototyped, and the cost of an Albedo layer on the consumer's document was not measured.
- The orthographic form of the grid, SSAA, and a Render at a non-16:9 aspect are designed, not tried.
- On-nothing's fixture pass was not read.
- Why unrolled lights cost more than linearly on the consumer's document. (Found since: B260.)

**Found on the way** (not fixed then: this was a document. The first two were fixed with slice 1; the third is B260.)

- `docs/shadow-casters-design-2026-10-05.md` says TouchDesigner's Light Mask is "on the material". The documentation puts it on the Geometry COMP's Render page (`lightmask`); the Phong MAT page only refers to it. The reference survey has it right ("a per-object light mask").
- The header comment of `src/nodes/shaders/scene-render.wgsl.ts` says "a uniform array carries thousands of lights before the block limit". The lights are not an array but generated members and blocks, and 37 of them took the consumer's frame to 24 ms and its pipeline compile to 1.2 s.
- The cost of unrolled lights on the consumer's document rises faster than their count (0.10, 0.25 and 0.54 ms a light at 8, 16 and 32 more). In the probe's small shader it did not (0.045 ms a light at 16, 0.022 at 64, 0.036 at 256). Not explained.

## 13. Slice 1 as built (2026-10-06)

Point lights from a pointset, culled: section 8's slice 1 with all twelve acceptance items, built as the first slice of the one light path (T1623b). Added on the way by the consumer's answers, the Sweep's second slice, B260 and the one-light-path ruling: three pointset Lights in one Render; a pointset light on a Sweep of two strips; a pointset Light beside more Lights in Single mode than B260's guard starts at; a pointset of directional lights; the record's kind and source number; loop bounds from the table.

### 13.1 Where it is

- `src/nodes/shaders/scene-lights.wgsl.ts`: the Light's resolve, the Render's gather and grid build, the lit draw's declarations and its walk. Its header comment is the layout's one statement.
- `src/nodes/definitions/light-records.ts`, `light-points.ts`: the two buffers and the limits; the Light's half and the Render's half, so `scene.ts` holds a call to each.
- `src/nodes/definitions/scene.ts`: the Light's Mode row, Points input and `parametersFor`; the Render's table block after the shadow sweeps and before the backdrop.
- `src/nodes/shaders/scene-render.wgsl.ts`: `lightBlock` takes its three rows (and its guard) as parameters; one option, `lightGrid`, a flag; three interpolations that are empty without it. `sceneInstancesWgsl` is not touched.
- Tests: `light-points.test.ts` (the plan, no GPU), `src/runtime/backend/vgpu/light-points.gpu.test.ts` (Dawn), over the scenes of `light-points.fixture.ts`.

### 13.2 The table as built

- **The record is four rows, 64 bytes.** `place` (xyz where the light stands, w its range: 0 unlimited and in every cell, below 0 off and in none). `color` (rgb colour times intensity, w the falloff law). `aim` (xyz the way the light travels, a directional light's Direction; w the cosine of a cone's outer half-angle, −1 until slice 2). `cone` (x the cosine of the inner half-angle, −1 likewise; **y the kind**, 0 directional and 1 point; **z the shadow slot**, 0 for none and written by nothing yet; **w the source number**, the Light's place in the Render's Lights counted from 0, Lights in Single mode included).
- **A table is a header, the records row by row, then the cells.** The header is four words: rows, words a cell, where the cells start, a spare. The gather writes it every frame from its values. Behind it stands every record's `place`, then every `color`, every `aim`, every `cone`.
  - Row by row, because the build wants only places and most of what a fragment reads is the place of a light it is out of range of. Measured (13.4's method, the two layouts alternated in one process, 1,024 lights and nothing shaded): 0.43 to 0.46 of the reference against 0.51 to 0.56 record by record, the build alone 0.26 to 0.33 against 0.46 ms; with every light in reach the two cost the same.
  - A Light's own buffer keeps record after record: it is written once and copied once.
  - **For the buffer-values seam** (T1623b slice 2, on main): a region of rows of this table is four byte ranges, one a row of the record, so a named Light's rows are four writes of four-float rows; or they are written whole, 64 bytes each, into a buffer laid out as a Light's own and gathered like any set. The header's fourth word is spare for a count the lit walk reads. If one write of whole records into the table is wanted instead, the layout is three functions of `scene-lights.wgsl.ts` and costs what is measured above.
- **Two views of the one buffer.** The passes that write it see words. The lit draw only reads and sees four-word elements (`array<vec4u>`): one load a row in place of four. Measured the same way, pictures byte for byte the same: 0.58 of the reference against 0.67 at 64 lights that all reach every pixel, 0.43 against 0.52 at 1,024 with nothing shaded. The build keeps the word view because its invocations each own one cell's words, and a write of one component of an element may read and write the whole element.
- **No text holds a count.** The lit draw, the Light's resolve, the gather and the grid build are each ONE string for three lamps, three hundred and a thousand (a plan test compares them). The walk's word count and the cells' start, and the build's row count, are read from the header; where a Light's rows go in the table and how many it has are values of the gather.
- **In §V1029's ledger** (`src/compiler/generated-text-growth.test.ts`, four rows): flat in the attributes on the Light's edge; flat in the count of points (64 to 1,024); a literal in the Light's own resolve when a mapped attribute sits behind another (the packed accessor's byte offset, as every reader of a packed pointset has it); and in the count of pointset Lights the gather grows by a binding, a uniform row, four accessors and a copy block of 357 bytes a Light, independent statements under the refusal at seven (exception b). A gather PASS a Light, all of one text, would be flat and lift the seven (T1628b).
- **`kind` is a value, in both modes.** A set of lamps and a set of suns compile the same shaders; the Type is one float of the resolve's values, and a driven Type stays on the values-only frame path. **A pointset of directional lights is legal**: each row travels along the Light's Direction, has no place that matters and no range, and its bit is in every cell. There is no refusal.
- **Rows a grid cannot leave out** (a directional row, a point row with no Range) are walked from the cells like any other until T1623b's third slice gives them a region of their own.
- **The grid's dimensions are values, not constants of the generator.** The lit draw reads `lightGrid` (tiles, slices, the orthographic flag), `lightLens` (the surface's size, Near and Far) and `lightDepth`; the build reads the same. So the reference of acceptance item 2 is the same program with other values, written by the test, and the product has no switch.
- **A fragment's depth is `dot(lightDepth, world)`**, a row taken from the draw's own view-projection (its w row for a perspective camera, its z row scaled to view depth for an orthographic one), so the build and the fragment cannot disagree about the camera.
- **Primitive instances, points and beams** with a lit material are not lit by these lights until the other generator's slice. A Render that has both says so by name (`node.scene.lightDraw`, a warning) instead of drawing them dark in silence.
- **B260's guard and the walk.** Above eight Lights in Single mode each block works under a test that its light is on. A turn of the walk is a scope of its own already and takes none. A Dawn case holds nine blocks and a set in one Render. Both go when the last block does.
- **Acceptance item 2 is six views of three hundred lamps**, not one moving camera: a perspective camera, a low rolled one, one among the lamps, an orthographic one, SSAA, and a picture twice as wide as high. Each is byte for byte the picture through one cell. The cells are read back to show that the comparison is not of a grid that kept everything.
- **Acceptance item 10 is exact**: under 4x MSAA an edge pixel of a lit quad holds a quarter, a half or three quarters of the lit value.
- **Acceptance item 8** (a Render with no pointset Light has the plan and text it had) holds, and ends by ruling when named Lights become rows.

### 13.3 What the next slices find here

- **Cone and aim** (slice 2): the `aim` and `cone` rows exist and are carried through the gather; the resolve writes a cone that holds every direction. The slice adds the Light's rows, the maps and the test in the walk.
- **Named Lights as rows** (T1623b slice 3): a row with no range and a directional row are walked today (tested on Dawn); the kind is read from the row; the source number counts Lights in Single mode too, so a named Light's row takes the number it already has. What that slice adds is the CPU-written rows (the buffer-values seam) and the always-walked region.
- **The lists** (one mechanism): the source number is in every row; nothing reads it yet.
- **Shadow slots**: the slot field is in every row and is 0.

### 13.4 Measured, under the rule of 5.4

Apple M3 Max, Dawn on Metal, headless, 1280 × 720, on a machine other sessions were using (the reference ran between 2.7 and 4.3 ms where it is 2.7 alone). Scratch scripts, not in the repository; the reference and the harness are copies of B260's. Every figure is of the build as it lands unless it says otherwise.

**A minimal scene through the engine**: a PBR floor filling the picture, N point lights over it that ALL reach every pixel (Range 30), as N Light nodes in Single mode and as one Light in Points mode over N points. Every variant twice, alternated; 40 frames after 12. GPU time of the lit draw plus the table's three dispatches.

| Lights | As | Raw, two takes | Share of reference | A light, share | Lit pipeline, new text |
|---|---|---|---|---|---|
| 8 | Single | 0.20, 0.20 ms | 0.070, 0.065 | 0.0081 to 0.0087 | 115 ms |
| 8 | Points | 0.26, 0.26 ms | 0.089, 0.095 | 0.011 to 0.012 | 49 ms |
| 16 | Single, guarded | 0.39, 0.33 ms | 0.116, 0.116 | 0.0073 | 101 ms |
| 16 | Points | 0.46, 0.46 ms | 0.167, 0.146 | 0.0091 to 0.0104 | the same text as 8 |
| 64 | Single, guarded | 1.44, 1.57 ms | 0.488, 0.500 | 0.0076 to 0.0078 | 332 ms |
| 64 | Points | 1.64, 1.90 ms | 0.568, 0.608 | 0.0089 to 0.0095 | the same text |
| 64 | Points, the kind taken back to a constant in the text (scratch) | 1.38, 1.51 ms | 0.511, 0.490 | 0.0077 to 0.0080 | |
| 256 | Points | 7.80, 9.96 ms | 2.23, 2.32 | 0.0087 to 0.0091 | the same text |
| 1,024 | Points | 38.4, 40.2 ms | 9.46, 9.40 | 0.0092 | the same text |
| 1,024, Range 1 | Points | 1.38, 1.31 ms | 0.457, 0.463 | | the same text |

- **No cliff.** A light of the table costs the same share from 16 to 1,024. The lit text is 8.2 thousand characters at every count, against 19, 35 and 131 thousand for 8, 16 and 64 blocks.
- **Nothing to cull is the walk's worst case, and there a row costs more than a guarded block**: a sixth to a fifth more at 64. That is what T1623b's third slice moves into the table.
- **The kind as a value is most of that difference.** With the kind put back in the text as a constant (a patch in the scratch harness, the same picture) a row costs what a guarded block costs: 0.49 to 0.51 against 0.49 to 0.50 at 64. The ruling stands on what it buys (no recompile on a change of Type); this is its price in the walk, a tenth to a fifth. T1623b's always-walked region is where directional rows go, and once they are there the grid's walk holds none and could do without the test.
- **Loop bounds from the table cost nothing that could be resolved**: with the cell's word count put back as a literal the share moved both ways between two takes (0.73 and 0.70 as built against 0.67 and 0.69 at 64 lights; 0.55 and 0.53 against 0.57 and 0.48 at 1,024 with nothing shaded; taken before the lit draw's element view).
- **With a range the grid is the point**: 1,024 lights that each reach a pool of the air over the floor, none of them the floor itself, are 1.3 to 1.4 ms, the table's build included (0.26 to 0.33 ms).
- The two ways draw the same picture: the largest difference of a channel is 4.9e-4, one step of a half float at that level.

**The consumer's frame** (acceptance item 12): `sentinelDocument`, live tier, one robot, built by the consumer's own code and not edited; the lamps added to the built graph in the script. One Point Kernel of 75 points (a lamp at every station of the lap, its place from the consumer's own path and chamber functions, its tone from its own `lampTone`), one Light in Points mode, Intensity 26, Range 24, Inverse Square, Color in Map mode. Run as the app runs a frame; 120 frames after 30; each variant twice, alternated. **Run twice**: once before the record and the table took their final shape, and again on the build as it lands, because a figure of a build that no longer exists is not the acceptance. The second:

| Variant | GPU, raw | Reference | GPU / reference | At full clock | Wall, GPU drained | CPU |
|---|---|---|---|---|---|---|
| as it ships (5 Lights) | 7.67, 7.54 ms | 3.21, 3.15 ms | 2.43, 2.42 | 6.85, 6.83 ms | 19.7, 19.8 ms | 5.88, 6.61 ms |
| with the 75 lamps | 7.80, 8.85 ms | 2.82, 3.15 ms | 2.71, 2.77 | 7.62, 7.80 ms | 20.9, 23.2 ms | 5.92, 6.12 ms |
| the 75 lamps, the three named lamp Lights out | 8.65, 7.93 ms | 3.15, 2.88 ms | 2.61, 2.71 | 7.37, 7.63 ms | 23.1, 21.3 ms | 6.88, 6.05 ms |

- **GPU: the 75 lamps add 0.27 to 0.34 of the reference**, 0.8 to 1.0 ms at this run's fastest clock (a reference of 2.82 ms). The control's two takes agree to a hundredth. Without the three named lamp Lights the frame is 0.18 to 0.29 of the reference over the control, 0.5 to 0.8 ms.
- **The first run** (the earlier build: a record of two rows, the kind a constant) read 0.05 to 0.22 of the reference for the same lamps, on a control whose own two takes differed by 0.17. The two runs are not a measurement of what the final shape costs; the minimal scene above is.
- **CPU**: 0.4 to 0.8 ms more a frame in the first run (the values-only compile 0.1 to 0.3 over seven more passes, encoding 0.15 to 0.2, submitting 0.1); not resolved in the second (5.9 and 6.6 ms without the lamps, 5.9 and 6.1 with).
- **Device calls a frame**: 14 submits and encoders become 20; 9 compute passes become 13 (the lamps' kernel and the three of the table); 21 render passes and 46 draw calls stay; 40 buffer writes become 42. The plan goes from 71 passes to 78, and stays on the values-only path.
- **Why six submits for four dispatches.** Every dispatch is its own submit on this backend, and a dispatch that follows anything but a dispatch opens a new frame of the device's (`encodeSegmented`). The lamps' kernel has a swap pass, which the plan places after its last reader, the Light's resolve: so it stands between the resolve and the Render's gather and splits the frame once more. Counted on the mock device for the three-lamp scene: 3 submits with no kernel, 5 with the kernel alone, 9 with the table, and one more for each further pointset Light.
- Nothing was said by the compiler: the consumer's motes are unlit, so the `node.scene.lightDraw` warning does not fire.

### 13.5 Tests, and what was seen red

- `light-points.test.ts`, 26 tests with no GPU; `light-points.gpu.test.ts`, 19 on Dawn.
- **51 mutations of the product, one at a time, 49 seen red** (two of them against §V1029's gate: a lit text that differs past 128 lights, and an eighth pointset Light gathered). Not red: the depth row taken from the clip z row in place of the w row (the same wrong depth for a light and for a fragment, and a twentieth of a unit at a tile's side: no pixel of the six views moves); and a cell's box not grown at all (the six views do not hit the rounding the margin is there for). The MSAA case is not reached by any of them.
- A Render with no pointset Light: the plans of E13, E33, E28, E69 and E79 were captured whole (passes, shader text, bindings, uniforms) before any generator was touched and compared after the first build and after the merges of the Sweep's second slice and of B260's stopgap: identical each time. Their fingerprints, taken with that first capture, are frozen in `light-points.test.ts` and hold on the tree as it lands; the whole-plan comparison was not repeated after the table took its final shape. B260's own 18 digests of the lit text at and below eight lights are green, as are the one-sheet pins of `grid-sheets.test.ts` and `point-sweep.test.ts`.

### 13.6 Not checked, and found on the way

**Not checked**

- A browser, and a device at the baseline limits: the eight-buffer budget is asserted at the plan, not on such a device.
- More than one machine; the figures above are one M3 Max under other sessions' load.
- The consumer's own look with the lamps: the runs measure cost, and no picture of it was looked at.
- A camera that moves between frames under a pointset Light, as pictures: the six views stand still, and the driven camera is held at the plan (a values-only frame).
- Where the walk's remaining cost over a block goes once the kind is a constant: nothing was left to resolve at 64 lights, and it was not looked for at other counts.
- Whether the element view helps on a GPU other than Apple's.
- Glass, primitive instances, points and beams: not lit by design until their slices.

**Found**

- **A kernel's swap pass can stand between two draws of the colour target.** When a lit draw is the last reader of a pointset, the swap follows it and the device's render pass is split there (seen for `kernel_floor` in the test scene; it is not new with this slice, and is a cousin of T1615b's third item).
- **Anything that is not a dispatch counts as work a dispatch would overtake** in `encodeSegmented`, a swap included, so a kernel costs one more frame of the device's (an encoder and a submit) besides its own dispatch. The comment there says an unnecessary split costs one empty command buffer. That is one for every kernel in a frame.
- **A Light in Single mode with Points wired keeps the upstream kernel in the plan.** Nothing reads it. Flipping Mode back does not stop the kernel's dispatch.
- **`from` is a reserved word of WGSL** and Dawn refuses it as a name; the plan tests on the mock device do not see that. Only the Dawn file did.

## 14. Slice 2 as built (2026-10-06): cone and aim

Type: Spot for the rows of a pointset Light, as section 8's slice 2 states it and as the one light path wants it: a spot is a kind of ROW. A Light in Single mode is not a row yet (T1623b slice 3), so there a Spot shines as a Point light and says so.

### 14.1 What a Light gained

| Key | Label | Type, range | Default | In Map mode |
|---|---|---|---|---|
| `kind` | Type | enum, `spot` appended; a value | `directional` | — |
| `cone` | Cone | number, 1 to 360, degrees | 60 | an f32, or one channel, multiplies it |
| `coneSoftness` | Cone Softness | number, 0 to 1 | 0.4 | not mappable |
| `orient` | Orient | vec4, a unit quaternion | 0, 0, 0, 1 | a vec4f attribute in its place |
| `direction` | Direction | as it was | as it was | a vec3f attribute, world space, in its place |

- **The aim of a row** is `R(orient) · direction`, written as a unit vector: the Light's Direction or the mapped vec3f, turned by the Light's Orient or the mapped quaternion. A quaternion is taken as a turn whatever its length.
- **The cone of a row** is two cosines: of half the Cone, where the light reaches zero, and of `(1 − Cone Softness)` of that, inside which it is whole; between them a smoothstep on the cosine, written out because `smoothstep` with equal edges (a Cone Softness of 0) has no defined value.
- **A row with no cone** (a point light, a directional one, a Cone of 359 degrees or more) holds −2 and −1 for the two: no direction's cosine is under −2, so its share is exactly 1.
- **Off, and in no cell**: a spot or a sun whose direction comes out at nothing, and a spot whose mapped Cone comes out at nothing, beside what switched a row off in slice 1.
- **The record's kind** is 0 directional, 1 point, 2 spot. Type, Cone, Cone Softness, Direction and Orient are all floats of the Light's own resolve pass: a set of lamps, of spots and of suns compile the same shaders, and a document that drives any of them stays on the values-only frame path.
- **Culling is by the range sphere.** The build does not know a cone (T1625b).

### 14.2 The walk has one shape

The cone of EVERY row is tested, whatever its kind. A first form tested only the rows that are spots (a second branch on the kind beside the one for a directional row). Set beside each other (13.4's method, alternated in one process, the same pictures):

| 64 lights, all in reach | Spots only | Every row |
|---|---|---|
| point rows | 0.67, 0.69 | 0.68, 0.65 |
| spots, Cone 30 | 0.44, 0.43 | 0.29, 0.27 |
| spots, Cone 150 | 0.82, 0.80 | 0.68, 0.68 |

Shares of the reference, two takes. The second branch is what cost. Slice 1's own walk, which has no cone test and reads the aim row inside its branch on the kind, costs 0.52 and 0.52 of the reference with 1,024 lights and nothing shaded where this one costs 0.40 and 0.41: reading the row for every light came out cheaper than reading it under a branch. Why was not looked for.

### 14.3 Where it departs from the brief, for the lead to rule

- **Orient is read as a VALUE too**, not in Map mode only. The brief (and section 3.2) had it Map mode only, as a Geometry's is. There a value has nothing to turn, so a Geometry REFUSES an authored one; a Light has a Direction, so a refusal would be decided by a value, and ignoring it would drop an authored number in silence. Reading it costs one uniform: as a value it turns the direction of every light of the set, in Map mode each point brings its own. If Map mode only is wanted, it is one line and an `inactiveWhen`.
- **A Spot in Single mode: a warning, `node.scene.lightSpot`, by the node's name.** The Light shines as a Point light from Position; its plan is the Point light's plan value for value (the test compares the two fingerprints). It is in the compile's diagnostics, which the Problems pane's `compile` source and the headless server both read. The compile runs on every revision, so an authored Type: Spot is said from the edit that makes it and stops with the edit that ends it.
  - **What that does not cover**: a Type DRIVEN to Spot between revisions. A values-only frame recompiles the node and drops its diagnostics (`frame-compile.ts`: "per-frame resolution diagnostics are dropped"), as it drops every node's. No carrier exists for a problem a compiled node raises on one frame and not the next; the value graph's own source is the only per-frame one. Building one is a seam in `compileFrame` and in the app's frame loop, not in a Light. It goes with this warning when named Lights become rows.
- **The text of a Render that lists a pointset Light moved**: its walk now tests a cone. It is still one string at every count and every Type. A Render with no pointset Light has the text it had (the five fingerprints, B260's digests). Nothing shipped lists a pointset Light.
- **A point row costs more than in slice 1 where every light is shaded, and less where none is** (14.4).

### 14.4 Measured, under the rule of 5.4

The minimal scene of 13.4 (a PBR floor, N lights 1.5 above it, Range 30 so that every light's range holds every pixel), the lights one Light in Points mode. Spots shine straight down. Every variant twice, alternated; 40 frames after 12; on a machine other sessions were loading (the reference ran at 4.1 to 6.3 ms). Lit draw plus the table's three dispatches, as a share of the reference.

| Lights | What | Share of reference, two takes | Against point rows |
|---|---|---|---|
| 64 | Lights in Single mode, guarded blocks | 0.50, 0.51 | |
| 64 | point rows | 0.66, 0.70 | 1 |
| 64 | point rows, the walk without a cone test (slice 1's, a scratch patch) | 0.61, 0.64 | 0.91 to 0.92 |
| 64 | spots, Cone 30 | 0.27, 0.30 | 0.41 to 0.42 |
| 64 | spots, Cone 150 | 0.66, 0.68 | 0.97 to 0.99 |
| 64 | spots, Cone 360 (the point lights' picture) | 0.70, 0.68 | 0.97 to 1.06 |
| 256 | point rows | 2.67, 2.71 | 1 |
| 256 | point rows, the walk without a cone test | 2.43, 2.38 | 0.88 to 0.91 |
| 256 | spots, Cone 30 | 1.10, 1.10 | 0.41 |
| 1,024, Range 1 | point rows, nothing shaded | 0.40, 0.41 | 1 |
| 1,024, Range 1 | the walk without a cone test | 0.52, 0.52 | 1.26 to 1.28 |

- **A narrow spot costs two fifths of a point light of the same range.** It is walked by every pixel its range sphere holds and leaves at its cone, before its colour is read and before the lobe. A Cone 30 spot 1.5 above a floor lights a disc 0.8 across: about one row in sixty is shaded at a pixel (computed), so nearly all of that two fifths is the walk. A cone-against-cell test in the build (T1625b) is what would take it away.
- **A wide spot costs what a point light costs.**
- **The cone test costs a point row a tenth where every light is shaded** (0.05 to 0.06 of the reference at 64 lights, 0.24 to 0.34 at 256), and the walk is a fifth cheaper than slice 1's where none is.

The consumer's frame was not run again: its lamps as spots are the consumer's to place.

### 14.5 Tests, and what was seen red

- `light-points.test.ts`, 31 tests with no GPU; `light-points.gpu.test.ts`, 25 on Dawn.
- The acceptance of section 8's slice 2, on Dawn: a spot straight down reads the point light's value to the bit on its axis and inside its inner angle, the stated share of it in the fade, and exactly nothing outside the cone, which under an ambient is the pixel of the Render with no light; a Cone Softness of 0 is a hard edge; a Cone of 359 or 360 is the point lights' whole picture; a mapped Cone multiplies. Orient in Map mode carries each lamp's light a quarter turn round its foot, each lamp by its own turn, and the same turn as a value gives the same picture byte for byte. Direction in Map mode gives each lamp a way of its own. The point lights' programs draw the spots' picture after one float is written.
- **The brightest pixel is not where a slanted spot's axis meets the floor**: the inverse square pulls it toward the lamp. The test asserts the value where the axis meets the floor, and that the brightest pixel lies between the lamp's foot and that place and is carried a quarter turn round the foot by the turn.
- **The consumer's case**: three lamps on a path climbing at 45 degrees along a wall, Direction (0, −1, 0), Orient mapped from the `orient` of Curve Frames, Cone 150, Cone Softness 0.8. Along each lamp's own down the wall reads the three lamps' analytic values; the crown beside a lamp (on along the path, level with it in the path's frame) reads exactly nothing, where the same lamps as point lights light it as brightly as the wall below; with the map cut the light falls straight down the world instead.
- **75 mutations of the product, one at a time, 72 seen red.** Not red: the two of 13.5, and the walk shading a fragment its cone leaves nothing for (nothing times a finite lobe is nothing: the early exit is a cost, and a clock is not a gate).
- **Acceptance item 10 of slice 1 is now reached by a mutation**: a Render whose lit draws leave the walk out under MSAA.
- §V1029's gate asked for no new row: none of the new parameters is a count.

### 14.6 Not checked

- The inspector: the three new rows, and the reasons the rows not read give.
- The Problems pane showing the warning in the app; it is asserted in the compile's diagnostics.
- A Light's tile in Points mode (it shows the stock scene under the node's values, T1630b).
- Curve Frames on a path that bends, into a Light: the test's path is straight, so its three frames are one. That each point's own turn is read is held by a kernel's attribute.
- A spot under a counted pointset, a spot on a mesh Surface, a spot beside guarded blocks: each is slice 1's case with one more value, and none was run as a spot.
- A browser, a second GPU.

## 15. T1623b slice 3 as built (2026-10-06): a Light in Single mode that does not cast is a row

The third slice of the one light path (`docs/light-cost-investigation-2026-10-06.md`, section 11). Before it a Render unrolled a block of its lit shader for every Light in Single mode. Now such a Light is one row of the Render's light table, written as values, and the lit text of a Surface is one string whatever the Render lists. Casting Lights are still blocks (slices 4 and 5); primitive instances, points and beams still read every Light in Single mode as a block (slice 7); a tile's preview keeps its two stock lights (ruled).

### 15.1 What a Render emits now

Every Render that draws a lit Surface has a table, lights or none. A Render whose Surfaces are all unlit or glass has none.

```
render_shot:lights:header     write: the table's eight header words, as values
render_shot:lights:named      write: the named Lights' records, 64 bytes each, into scratch:<render>:lightNamed
render_shot:lights:gather:0   dispatch: the named records into the table
render_shot:lights:gather:<i> dispatch: the i-th Light in Points mode's records into the table
render_shot:lights:grid       dispatch: one invocation a cell, over the rows with a range
```

- **The header is written by the CPU**, through the buffer-values seam, where slice 1's gather wrote it from its uniforms. Its eight words: the rows a region holds, the words a cell, where the cells start, how many rows reach every pixel; how many rows are live, where the rows of any kind end, where the point rows end, one spare.
- **The named rows are whole records in a buffer of the Render's own**, laid out as a Light's records are and gathered like any set. Its room grows in steps of 32 rows (`NAMED_LIGHT_STEP`), so that a Light added, removed, re-ordered or re-typed inside a step is a write: the plan's structure is the same structure (`isUniformOnlyChange`), and on the mock device it creates no shader module and no pipeline.
- **The gather is one text for every set** (T1628b): a pass a set, each binding the table and its own records, with the row its records go to, how many, and what to add to each row's source number as three values. The limit of seven Lights in Points mode is gone, and `node.scene.lightSources` with it. What bounds a Render now is the table's 1,024 rows: every slot of every pointset Light and the named Lights' steps (`node.scene.lightCapacity`). **A pointset Light may therefore hold 992 points where it held 1,024** beside up to 32 named Lights.
- **The order of the rows is a value of the frame**:

  | Run | Rows | Walked by |
  |---|---|---|
  | rows of any kind that reach every pixel | a pointset's rows with no Range; named spots with a cone and no Range | one loop, kind and cone tested, one row a turn |
  | point rows | named point lights with no Range (and named spots whose Cone is every direction) | a loop written for them, two rows a turn |
  | suns | named directional lights | a loop written for them, two rows a turn |
  | the rest | named Lights with a Range, named Lights that are off, then the pointset Lights with a Range | the grid's cells; an off row is in none |

  Within a run the named rows stand in the Render's list order: the order is a filter of the list, never a sort.
- **A casting Light's block stands under B260's guard at every count** where the draw walks the table. `LIGHT_GUARD_ABOVE` stays 8 and is now the rule for the texts with no table: the instances generator's, a tile's preview, the shadow matte.

### 15.2 The always-walked rows: what was tried, measured

The brief's form was one plain loop over the rows that reach every pixel. It cost three fifths more than the blocks it replaces, so the stop condition of the slice applied; the form built is the one that met it.

Method: the lit draw alone (`setExactPassTiming`) of a PBR floor that fills 7680 x 4320 (the timestamps of this device step by 65.5 microseconds, so the draw has to be that large for a tenth to show), a fixed reference compute pass beside every frame, main's tree and this one loaded in ONE process and alternated, two takes, the first variant repeated last, 50 frames after 12, the machine quiet (reference 2.75 ms). Figures are the lit draw as a share of the reference, summed over the frames. The lights are a mix as shipped: one sun; a sun and a point light; from four up two suns and the rest point lights with no Range. Each row form was a text patch on the lit module, so the pictures of all forms were compared and are the same picture, equal to main's to one step of a half float.

| Lights | Blocks (main) | One loop, kind and cone tested | A loop a kind, one row a turn, an off test | As built |
|---|---|---|---|---|
| 1 | 0.340, 0.334, 0.332 | 0.474, 0.474 | 0.394, 0.379 | 0.373, 0.380 |
| 2 | 0.525, 0.512 | 0.784, 0.768 | 0.603, 0.589 | 0.595, 0.585 |
| 4 | 0.860, 0.848 | 1.397, 1.366 | 0.998, 0.997 | 0.918, 0.910 |
| 8 | 1.622, 1.616 | 2.641, 2.611 | 1.905, 1.887 | 1.679, 1.660 |
| 9 (blocks guarded) | 1.897, 1.880 | 2.940, 2.969 | 2.114, 2.134 | 1.847, 1.858 |
| 16 | 3.499, 3.466, 3.459 | | | 3.227, 3.177 |
| 32 | 7.845, 7.672 | | | 6.472, 6.514 |
| 64 | 17.63, 17.57 | | | 13.28, 12.93 |

As built against blocks: +12 % at 1, +14 % at 2, +7 % at 4, +3 % at 8, −2 % at 9, −8 % at 16, −16 % at 32, −25 % at 64. The two middle columns are from a run of their own, in which blocks read 0.333 and 0.327 at 1, 0.504 and 0.506 at 2, 0.839 and 0.864 at 4, 1.624 and 1.608 at 8, 1.882 and 1.914 at 9.

What was tried, each alternated with main's blocks in one process:

| Form | Against blocks |
|---|---|
| the three reads' addresses hoisted by hand | no gain: the compiler does it |
| no cone test at all (wrong for a spot) | 0.30 to 0.25 of the reference at eight point lights: the cone's normalise and smoothstep is the largest single part |
| a branch on the kind round the aim read and the cone (one loop, pay by kind) | +43 to +50 %: the compiler flattens the branch, and a third row read costs what it saves |
| a loop a kind, one row a turn, no off test | +18 to +20 % at 1, +8 to +16 % at 4, +2 % at 8 |
| a loop a kind, two rows a turn, no off test | +0 to +4 % at 1, equal at 4 and 8, −7 % at 9 |
| three and four rows a turn | the same as two |
| the first eight rows at literal row numbers, no loop | +5 % at 1, +2 % at 2, −4 % at 4 and 8; 31 KB of text against 22 |

- **What a row paid over a block is the kind test, the cone and the off test.** They go where the CPU can sort the rows: a named Light's kind and whether it is off are values the Render has.
- **Why two rows a turn costs less than one was not found.** The work a row is the same. It was measured twice, on a loaded machine and on a quiet one.
- **What is left at one and two lights is in the two loops themselves**: with the any-kind loop and the ranged half patched out of the text the draw costs 0.364 of the reference against 0.373 with them, and 0.335 for one block.
- **B260's rule holds by counting.** The gate counts a row of the table as a source: every place in the text that shades a row. In a draw that walks the table the longest run of sources in one straight line is 1, at 0 to 32 casting blocks, in each of the eleven Surface cases with and without casting Lights (132 texts). A turn's second row stands under a test of the loop's bound, which is a merge.

### 15.3 The rows with a range: the kind test went, and a named Light whose Range covers the picture costs more than its block did

The slice 2 ruling was to measure the grid's walk with and without the kind test once the always-walked rows were apart, and keep the cheaper. A directional light has no range, so the Render stands every one among the always-walked rows; a row found through a cell is a point light or a spot.

| Lights with a Range, all in reach of every pixel | With the kind test | Without (kept) |
|---|---|---|
| 64 | 2.41, 2.43, 2.91 | 2.25, 2.19, 2.54 |
| 256 | 9.77, 9.59, 9.31 | 9.13, 8.70, 8.70 |

Shares of the reference, three takes, 2560 x 1440, the same pictures. Without it the walk is 7 to 13 % cheaper.

- **What it costs in robustness**: a directional row written past the always-walked ones would be shaded as a light at its place. The Render orders its rows from the Lights' own values on every compile, whole or values-only, so no path of the app writes one there. A test that poked a Type into a Light's resolve pass alone, behind the Render's back, drew the wrong picture and was rewritten to drive the Type the way the app's frames do.
- **A named Light with a Range that reaches the whole picture costs more than its block did**, between two fifths and a half more with the kind test and 7 to 13 % under that without (measured, lit draw only, 3840 x 2160, the pictures byte for byte main's):

  | Named Lights, Range 30 over a floor of 16 | Blocks (main, guarded) | Rows through the grid (with the kind test) |
  |---|---|---|
  | 16 | 0.94, 0.98, 1.02 | 1.45, 1.48 |
  | 64 | 4.30, 4.05 | 6.22, 5.70 |

  A row found through a cell reads four rows of its record and tests a cone it mostly does not have. Where the light does NOT reach, the row costs a place read and a compare, and its block cost the whole lobe: that is the trade a Range makes. One shipped document has named Lights with a Range (the consumer's three lamps). Splitting a cell's rows by kind as the always-walked rows are (two passes over a cell's words, each with a turn written for its kind) is the same cure and was not built here.

### 15.4 What a row holds, and why it is the numbers the block read

A named Light's record is computed on the CPU (`namedLightRecord`) as a Light in Points mode resolves a point's on the GPU. Two of its numbers are written the way the block they replace read them, because a shipped picture showed the difference:

- **A directional row's aim is the Light's Direction as authored, at any length.** Its reader normalises it (the light block does). Normalising it on the CPU, in doubles, moved the direction by the last bit of a float from what the shader's own `normalize` gives, and a glossy lobe (the GGX denominator is a difference of near-equal numbers) showed that in E77 as 201 channel values moved by one step of a half float and one by two. With the direction as authored E77 differs from main in 74 values, each by one step: exactly what B260's guard on its one casting Light moves by itself (measured: main against main with every block guarded, 73 values). A spot's aim is a unit vector: its cone is measured against it.
- **A row's colour is colour times intensity as ONE FLOAT PRODUCT of the two floats** (`Math.fround`), which is what the shader computed from its two uniform rows, and not the product of two doubles rounded once.

### 15.5 What is said

| Code | Class | By | When |
|---|---|---|---|
| `node.scene.lightEverywhere` (new) | advice | the Render | more than 32 of its rows reach every pixel (directional lights, lights with no Range), as authored; a pointset counts every point of its capacity. One such row costs every lit pixel one light: 0.21 of the reference on the 8K floor, 0.036 ms a row for a Surface that fills 1920 x 1080 on this machine, 1.1 ms at 32 (computed from the 16 and 64 rows of 15.2). |
| `node.scene.lightSpot` | degraded | the Light | Type: Spot with Cast Shadows on, in Single mode: a casting Light is still a block and a block takes no cone. |
| `node.scene.lightSpot` | degraded | the Render | a draw of primitive instances, points or beams under a Spot in Single mode that does not cast: that generator still reads every Light as a block (slice 7), so the spot has its cone on the Render's Surfaces and none on that draw. Said for each such draw, by the geometry's name and the spot's. |
| `node.scene.lightSources` | | | gone, with the limit it refused. |
| `node.scene.lightCapacity` | never | the Render | the table's 1,024 rows: now counts the named Lights' steps. |

A value driven across any of these between revisions is not said: a values-only frame keeps no node's diagnostics (T1646b).

### 15.6 Where it departs from the brief and the rulings, for the lead

- **The always-walked rows are three runs and two loops take two rows a turn**, where the brief had one plain loop: 15.2. Two of the header's spare words say where the runs end.
- **A directional row's aim is not a unit vector when the CPU wrote it**: 15.4.
- **The named rows' room is a step of 32, counted against the table's 1,024 rows**: a pointset Light may hold 992 points where it held 1,024.
- **A Render with a lit Surface runs two dispatches a frame for its table whatever it holds** (the named rows' gather and the grid's build): a dispatch has no skip by value, and both pipelines must exist before the first Light is added. Row text for a skip went to the lead (T1642b).
- **Every lit Surface draw binds one more storage buffer, the table**, where only a Render with a pointset Light's did. A fully attributed file mesh is then at the eight a stage is guaranteed.
- **The text of an unlit Surface moved too**: it no longer declares the three uniform rows of each Light it never read (E13's wall).
- **A tile's preview and a Render's lit draw are no longer one string** (ruled: previews keep their two stock lights). The gate that held them equal (T1292) now holds each to the generator call it must equal and one light's shading to the same characters in both.
- **The grid's walk lost its kind test** (ruled: keep the cheaper): 15.3.

### 15.7 Shipped frames, whole (measured)

Each document through its tree's own `renderHeadless` (the value graph, a compile a frame, the animator), main's tree and this one loaded in one process and run in turn (main, mine, main, mine, main, mine, main), 120 frames a run after 12, every frame read back. The frame's GPU time is the extent from its first timed pass's start to its last one's end, read off the backend's own timestamp writes; the figure is the sum of the extents over the sum of the references. The machine was shared (reference 2.9 to 3.5 ms where it is 2.75 quiet), so each run's least contended tenth is given beside it.

| Document | Named, casting | Before (four runs) | After (three runs) | Median | Least contended tenth |
|---|---|---|---|---|---|
| E20 Gooeyball | 2, 0 | 0.533, 0.394, 0.412, 0.393 | 0.503, 0.394, 0.392 | −4.5 % | −3.2 % |
| E63 Skin | 2, 0 | 0.458, 0.468, 0.495, 0.485 | 0.460, 0.472, 0.476 | −2.7 % | −4.4 % |
| E76 Verdant Lotus | 2, 1 (no lit Surface) | 5.78, 5.81, 6.61, 6.29 | 5.84, 5.79, 6.33 | −7.2 % | −0.3 % |
| E79 Crucible | 5, 2 | 1.099, 0.955, 0.989, 0.966 | 0.999, 1.015, 1.063 | +2.6 % | +2.5 % |
| on-nothing quad | 1, 0 and 0, 1 | 3.972, 4.016, 3.939, 3.970 | 4.079, 4.114, 4.072 | +2.7 % | +2.4 % |
| on-nothing mcu2 | 9, 0 | 13.10, 13.24, 13.54, 13.15 | 13.35, 13.51, 13.10 | +0.8 % | +1.6 % |
| the consumer (sentinel), as it stands at main `fd871e17` | 3 with a Range and a sun, 1, and two sets | 3.197, 3.240, 3.199, 3.183 | 3.162, 3.179, 3.162 | −1.1 % | −2.7 % |
| E13 Prism | 1, 0 (no lit Surface) | 1.586, 1.562, 1.586 | 1.540, 1.593 | +0.5 % | +1.3 % |

- **No frame moved by more than 3 %.** The two that moved the same way in every run are quad (one point light over file meshes under MSAA: the frame is its lit draw, and one light is where a row costs a tenth more than its block) and E79.
- E20's frame is nineteen timestamp steps long: a step is 5 % of it, and only the sum over a run sees under one.
- Raw medians of a run, as the reference moved between 2.9 and 4.5 ms: E20 1.2 to 1.8 ms a frame, E63 1.4 to 2.0, E76 16.7 to 21.6, E79 2.4 to 2.6, quad 11.9 to 13.0, mcu2 36 to 45, the consumer 9.1 to 9.4.
- The consumer's document moved twice on main while this slice was built. Its row is the last version, timed on a quiet machine (reference 2.82 to 3.0 ms; 9.1 to 9.4 ms a frame raw). The version before it (three named Lights with a Range, one casting, one set) read 2.975, 2.841, 2.768, 2.980 before and 2.842, 2.781, 3.013 after.

### 15.8 The first compile, cold (measured)

A lit text that walks the table is longer than a text with one block and shorter than one with nine, and it is the same text at every count. Metal's cache on disk was defeated by adding one live float, new for every run, to each lit text; the machine was loaded (load average 14), so these are to be read as sizes, not as fine figures.

The floor's lit pipeline alone, three processes, the first variant of each not read:

| Lights | Blocks (main): characters, ms | The walk: characters, ms |
|---|---|---|
| 1 | 5,994: 73, 75, 74 | 21,798: 148, 130, 127 at any count |
| 2 | 7,945: 85, 71, 147 | |
| 4 | 11,847: 198, 114, 168 | |
| 8 | 19,651: 217, 105, 211 | |
| 9 | 21,926: 250, 164, 214 | |
| 16 | 35,871: 204, 179, 308 | |
| 64 | 131,535: 645, 591, 771 | |

A whole document's first compile (every shader module and pipeline the device was asked for, one frame rendered, main and this tree in turn three times):

| Document | Before: pipelines, their ms, first build to last | After |
|---|---|---|
| E20 (one lit text: 6,965 characters to 17,726) | 10: 351, 247, 297 ms; 390, 282, 332 | 12: 352, 328, 368 ms; 404, 388, 411 |
| E79 (one lit text: 21,933 to 30,005) | 38: 423, 284, 341 ms; 676, 427, 493 | 40: 458, 373, 425 ms; 668, 534, 601 |
| the consumer (seven lit texts: 251,194 to 286,679) | 70: 2,919, 3,301, 2,935 ms; 3,361, 3,967, 3,410 | 72: 4,006, 3,155, 3,189 ms; 4,566, 3,734, 3,657 |

- **A Render with one or two Lights compiles about 55 to 80 ms longer the first time**, once, and never again for a Light added. Ruled an accepted trade.
- The two pipelines more are the named rows' gather and, where the Render had no table, the grid's build.

### 15.9 Every shipped Render's picture, before and after (measured)

Each of the 62 Renders of the shipped examples and projects (the starter component's is drawn through E47), its own target read back at frames 0 and 60 through each tree's own `renderHeadless`, main at `90156c33` against this tree, raw bytes. A step is one step of a half float's own bits.

| Document | Render | Named, casting, sets | Passes | Frame 0 | Frame 60 |
|---|---|---|---|---|---|
| E13-Prism | render_shot | 1, 0, 0 | 47 to 47 | same bytes | same bytes |
| E20-Gooeyball | render_shot | 2, 0, 0 | 14 to 18 | 32 of 3.7 M, 1 step | 34 of 3.7 M, 1 step |
| E25-Stage | render_shota | 1, 0, 0 | 14 to 14 | same bytes | same bytes |
| E25-Stage | render_shotb | 1, 0, 0 | 14 to 14 | same bytes | same bytes |
| E27-Relief | render_shot | 0, 0, 0 | 32 to 32 | same bytes | same bytes |
| E28-Sundial | render_shot | 0, 1, 0 | 22 to 26 | 115 of 5.3 M, 1 step | 108 of 5.3 M, 1 step |
| E30-Nave | render_shot | 0, 0, 0 | 14 to 14 | same bytes | same bytes |
| E33-Obol | render_shot | 2, 1, 0 | 41 to 45 | 103 of 3.7 M, 1 step | 118 of 3.7 M, 1 step |
| E34-Lidar | render_shot | 1, 1, 0 | 62 to 66 | 105 of 3.7 M, 1 step | 117 of 3.7 M, 1 step |
| E36-Facade | render_shot | 1, 0, 0 | 27 to 31 | same bytes | 1 of 3.7 M, 1 step |
| E37-Sirocco | render_shot | 0, 0, 0 | 18 to 18 | same bytes | same bytes |
| E41-Cinder | render_shot | 0, 0, 0 | 31 to 31 | same bytes | same bytes |
| E42-Current | render_shot | 1, 0, 0 | 20 to 20 | same bytes | same bytes |
| E45-Pulse | render_shotA | 0, 0, 0 | 33 to 33 | same bytes | same bytes |
| E45-Pulse | render_shotB | 0, 0, 0 | 33 to 33 | same bytes | same bytes |
| E47-Hologram | render_shot | 0, 0, 0 | 45 to 45 | same bytes | same bytes |
| E48-Marionette | render_shot | 0, 0, 0 | 13 to 13 | same bytes | same bytes |
| E54-Quorum | render_nodes | 0, 0, 0 | 34 to 34 | same bytes | same bytes |
| E54-Quorum | render_webs | 0, 0, 0 | 34 to 34 | same bytes | same bytes |
| E63-Skin | render_shot | 2, 0, 0 | 18 to 22 | 38 of 3.7 M, 1 step | 37 of 3.7 M, 1 step |
| E69-Burnish | render_shot | 0, 1, 0 | 28 to 32 | 61 of 3.7 M, 1 step | 70 of 3.7 M, 1 step |
| E75-Resonance | render_lightshot | 0, 0, 0 | 145 to 149 | same bytes | same bytes |
| E75-Resonance | render_shot | 2, 2, 0 | 145 to 149 | 7 of 3.7 M, 1 step | 4 of 3.7 M, 1 step |
| E76-Verdant-Lotus | render_lightshot | 0, 0, 0 | 129 to 129 | same bytes | same bytes |
| E76-Verdant-Lotus | render_shot | 2, 1, 0 | 129 to 129 | same bytes | same bytes |
| E77-Ember-Monoliths | render_lightshot | 0, 0, 0 | 225 to 229 | same bytes | same bytes |
| E77-Ember-Monoliths | render_shot | 2, 1, 0 | 225 to 229 | 74 of 3.7 M, 1 step | 73 of 3.7 M, 1 step |
| E78-Aether-Orrery | render_lightshot | 0, 0, 0 | 241 to 245 | same bytes | same bytes |
| E78-Aether-Orrery | render_shot | 2, 1, 0 | 241 to 245 | 14 of 3.7 M, 1 step | 10 of 3.7 M, 1 step |
| E79-Crucible | render_shot | 5, 2, 0 | 122 to 126 | 86 of 3.7 M, 1 step | 84 of 3.7 M, 1 step |
| furnace/furnace | render_shot | 2, 5, 0 | 125 to 129 | 418 of 8.3 M, 2 steps | 408 of 8.3 M, 1 step |
| furnace/furnace | render_sunshot | 0, 0, 0 | 125 to 129 | same bytes | same bytes |
| on-nothing/cards | render_type | 0, 0, 0 | 12 to 16 | same bytes | same bytes |
| on-nothing/crt | render_shot | 6, 2, 0 | 93 to 97 | 76 of 6.3 M, 1 step | 76 of 6.3 M, 1 step |
| on-nothing/cyc-wide | render_shot | 1, 6, 0 | 65 to 69 | 319 of 6.3 M, 1 step | 378 of 6.3 M, 1 step |
| on-nothing/cyc | render_shot | 0, 6, 0 | 54 to 58 | 341 of 6.3 M, 1 step | 312 of 6.3 M, 1 step |
| on-nothing/halo | render_shot | 4, 0, 0 | 57 to 61 | 11 of 6.3 M, 1 step | 10 of 6.3 M, 1 step |
| on-nothing/hands | render_shot | 2, 0, 0 | 54 to 58 | 255 of 6.3 M, 1 step | 276 of 6.3 M, 1 step |
| on-nothing/incar | render_paneshot | 0, 0, 0 | 246 to 254 | same bytes | same bytes |
| on-nothing/incar | render_shot | 7, 2, 0 | 246 to 254 | 29 of 6.3 M, 1 step | 23 of 6.3 M, 1 step |
| on-nothing/lights | render_shot | 2, 1, 0 | 66 to 70 | 260 of 6.3 M, 1 step | 285 of 6.3 M, 1 step |
| on-nothing/mcu | render_shot | 5, 0, 0 | 36 to 40 | 64 of 6.3 M, 1 step | 66 of 6.3 M, 1 step |
| on-nothing/mcu2 | render_shot | 9, 0, 0 | 108 to 112 | 15 of 6.3 M, 1 step | 31 of 6.3 M, 1 step |
| on-nothing/mirror | render_shot | 0, 1, 0 | 43 to 47 | 373 of 6.3 M, 1 step | 329 of 6.3 M, 1 step |
| on-nothing/pendant | render_shot | 3, 0, 0 | 43 to 47 | 163 of 6.3 M, 1 step | 146 of 6.3 M, 1 step |
| on-nothing/prism | render_shot | 2, 0, 0 | 63 to 71 | same bytes | 99 of 6.3 M, 1 step |
| on-nothing/prism | render_wallshot | 0, 1, 0 | 63 to 71 | 529 of 25.1 M, 1 step | 446 of 25.1 M, 1 step |
| on-nothing/quad | render_backview | 0, 1, 0 | 50 to 58 | same bytes | same bytes |
| on-nothing/quad | render_shot | 1, 0, 0 | 50 to 58 | 1 of 6.3 M, 1 step | 1 of 6.3 M, 1 step |
| on-nothing/ring | render_shot | 3, 0, 0 | 33 to 37 | 4 of 6.3 M, 1 step | 8 of 6.3 M, 1 step |
| on-nothing/sleep-like-a-baby-2 | render_stage | 1, 1, 0 | 44 to 48 | 2 of 8.3 M, 1 level of 255 | 2 of 8.3 M, 1 level of 255 |
| on-nothing/sleep-like-a-baby | render_stage | 1, 0, 0 | 22 to 26 | same bytes | same bytes |
| on-nothing/sneaker | render_shot | 8, 1, 0 | 112 to 116 | 28 of 6.3 M, 1 step | 30 of 6.3 M, 1 step |
| on-nothing/split | render_carshot | 2, 0, 0 | 92 to 100 | 261 of 6.3 M, 1 step | 224 of 6.3 M, 2 steps |
| on-nothing/split | render_floorshot | 0, 1, 0 | 92 to 100 | 319 of 6.3 M, 1 step | 250 of 6.3 M, 1 step |
| on-nothing/tableau | render_shot | 5, 2, 0 | 213 to 217 | 30 of 6.3 M, 1 step | 51 of 6.3 M, 1 step |
| on-nothing/title | render_glassshot | 0, 0, 0 | 200 to 204 | same bytes | same bytes |
| on-nothing/title | render_shot | 9, 4, 0 | 200 to 204 | 9 of 6.3 M, 1 step | 14 of 6.3 M, 1 step |
| on-nothing/wheel | render_shot | 1, 1, 0 | 151 to 155 | 110 of 6.3 M, 1 step | 107 of 6.3 M, 1 step |
| on-nothing/wide | render_shot | 5, 2, 0 | 213 to 217 | 61 of 6.3 M, 1 step | 54 of 6.3 M, 1 step |
| on-nothing/zoom | render_shot | 5, 2, 0 | 213 to 217 | 46 of 6.3 M, 1 step | 49 of 6.3 M, 2 steps |
| sentinel-bot/sentinel | render_shot | 4, 1, 2 | 126 to 130 | 94 of 3.7 M, 1 step | 125 of 3.7 M, 1 step |

- **25 Renders are the same bytes at both frames**: the Renders that list no Light, those whose Surfaces take none (unlit, glass) or that draw primitive instances alone (which read their Lights as they did), and two that are lit and did not move by a stored bit: quad's back view (one casting Light) and sleep-like-a-baby (an 8-bit target).
- **37 moved, 34 of them by one step at most.** A Render moves where its lit Surface's text moved: the walk sums in the table's order, and a casting Light's block stands under a guard.
- **Three hold ONE channel value that moved by two steps**: on-nothing zoom (frame 60) and the car shot of split (frame 60), where main's own tree with every light block guarded and nothing else changed moves the same pixel by the same two steps; and the furnace (frame 0), where the guard alone also moves one value by two steps, at another pixel. In all three it is B260's guard, which this slice puts on every casting block: a block under a test is compiled with another order of operations, and a glossy lobe's denominator is a difference of near-equal numbers.
- **The consumer's Render**: 94 and 125 channel values of 3.7 million, each by one step; in its last version on main (`fd871e17`) 99 and 119, each by one step. Its finished frame, behind its own finishing chain, differs in 28 and 38 values, by up to five steps at frame 0 and two at frame 60: the chain enlarges a last-bit move in its darkest pixels (the largest is 2.4e-4).

### 15.10 Tests, and what was seen red

- **New**: `light-rows.test.ts` (16 tests, no GPU) and `light-rows.gpu.test.ts` (10 on Dawn), over the fixture's floor under Lights in Single mode (`namedLights`).
- **The property, as stated in 11.1**: the lit module is ONE string at 0, 1, 8 and 64 Lights that do not cast, of every mix of kinds, beside a pointset Light or not; the whole plan's structure is the same inside a step of the named rows; and on the mock device a Light added, removed, re-ordered or re-typed, and every one taken out, creates no shader module and no pipeline, while the table's header is written with the new count.
- **On Dawn**: a named point light, a sun and a spot each by the Render's own arithmetic, through its own walk, with the header read back off the device; a named Light with a Range through the grid, exactly nothing beyond it, the picture through one cell the same bytes, and a sun beside it taken once; two Lights swapped in the list the same bytes, three the list's picture whatever their nodes are called, and backwards within one step of a half float; a driven Intensity as it moves and a Type driven through sun, point and spot, each frame the bytes of that Type stored; forty Lights (two steps) with and without a Range, the second word of a cell's mask read back; nine Lights in Points mode in one Render; a Render with no light, the ambient alone; a casting sun's block and a named row in one sum; a Surface and a primitive instance under one named Light, each by its own distance, and under a named Spot, where the instance has no cone.
- **Moved to the new plan**: `light-points.test.ts` (31) and `light-points.gpu.test.ts` (25): the pass ids, the header, the table's room, the limits. The test that switched a Type by writing one float into the Light's resolve pass behind the Render's back now drives the Type as the app's frames do.
- **Claims re-derived, not loosened**: `scene-pipeline.test.ts` (a light reaches the Render as a row; list order is the order of the rows of one run), `e20-gooeyball.test.ts` (two rows, the fill ahead of the key), `scene-preview.test.ts` (T1292: each of the tile's and the Render's text equals the generator call it must, and one light's shading is the same characters in both), `camera-wiring.gpu.test.ts` (a camera edit writes two passes: the lit draw and the grid's build).
- **B260's gate counts rows**: 15.2. Its eighteen digests did not move; what they pin is now the text with no light table.
- **§V1029's ledger**: `render.lights` left `NOT_YET_DATA` and is flat, with no pass, no member and no byte a Light. `render.lights/Lights in Points mode` is flat with two passes a Light, where it was 357 bytes of the gather's text a Light and refused past seven. The two casting debts stay, their smaller number up by the guard's 36 bytes (3,860 to 3,896; 3,835 to 3,871) and their larger unmoved. The positive control is the instances generator's blocks now.
- **49 mutations of the product, one at a time, 48 seen red.** Not red: the shadow matte's text unrolling a block for every Light (its uniform rows are then unused and its picture is the same: a cost in bytes that no picture shows).
- **Pins re-taken, each with its reason beside it**: the five example fingerprints of `light-points.test.ts`, six of the seven one-sheet programs of `grid-sheets.test.ts`, the five whole plans of `grid-uv.test.ts`.

### 15.11 Not checked, and found on the way

- **E13's one Light lights nothing.** Its Surfaces are unlit and glass and its other draws unlit beams and points: a Light listed by a Render that no draw can be lit by. Stored and inert.
- **The furnace Render is not the same picture run to run** on main: two renders of main's own tree differ in its sparks by up to 493 steps of a half float at frame 30 (and by none in other pairs of runs). The comparison of 15.9 happened to fall on agreeing runs.
- **A named Light with a Range that covers the picture costs more as a row than as a block**: 15.3.
- The inspector's rows (the Cone of a Spot in Single mode is live now; the reason a casting spot's is not); the Problems pane showing the two warnings; a browser; a second GPU.
- A named spot beside a pointset Light with no Range, both in the any-kind run: each kind is held alone, the two together were not rendered.
- The driven cases of the two warnings (T1646b).

## 16. T1623b slice 4 as built (2026-10-06): a Render's shadow maps are layers, each read through a 2D view

The fourth slice of the one light path (`docs/light-cost-investigation-2026-10-06.md`, 11.3). Before it every casting Light had a shadow target of its own, with a depth buffer of its own. Now a Render has two layered targets, one for its directional Lights' maps and one for its point Lights' cube atlases, a layer a Light and one depth buffer a kind. **What a lit draw binds and reads did not change**: a texture a casting Light, `shadowMap{s}`, which is now a view of that Light's one layer. The lit text is main's text, character for character; no picture moved and no cost moved.

That is not what the slice was briefed to build. It was briefed, and first built, with ONE `texture_2d_array` binding a kind and each block reading its layer at a literal index. That form is measured below, cost the lit draw 73 to 85 % more at four and eight casting Lights, and was ruled out (16.3).

### 16.1 What a Render emits now

- **Two resources of a new kind, `layers`**: `scratch:<render>:shadowMaps` (directional; twice the output) and `scratch:<render>:shadowCubes` (point; one and a half times, each layer the 3 x 2 atlas of cube faces it was), `r32float`, each present only when the Render has a casting Light of its kind.
- **A slot's layer is its place among the slots of its own kind**, in slot order (`shadowLayers`, in `scene.ts`: the one answer, asked by the sweeps and by the bindings). A sun, a lamp, a lamp, a sun, a lamp are layers 0 and 1 of the maps and 0, 1 and 2 of the cubes.
- **A sweep's passes name their layer** (`DrawPassDescriptor.layer`): the far plate that clears, and a draw a caster (a face). Their ids, their order, their shaders, their caster lists and their reach culling are what they were.
- **A lit draw's bindings**: `shadowMap{s}`, one a casting Light as before, each `{ resourceId: the array of its kind, layer }`. The shadow matte's draw binds the same.
- **Layers are allocated in steps**: 1, 2, 4, 8, then eights (`shadowLayerStep`). A third and a fourth casting sun are the same texture; a fifth is another. A spare layer costs its bytes and nothing else.
- **Memory.** A layer is four bytes a texel: at 1920 x 1080, 31.6 MiB a directional map (3840 x 2160) and 17.8 MiB a cube atlas (2880 x 1620). Each array has ONE depth buffer of a layer's size, where each Light had its own, so an array of a step is never more than the Lights' own targets were (`step(n) + 1 <= 2n` at every n):

  | Casting suns at 1920 x 1080 | Before: a target and a depth buffer a Light | Now: layers of a step and one depth buffer |
  |---|---|---|
  | 1 | 63.3 MiB | 63.3 MiB |
  | 2 | 126.6 | 94.9 |
  | 3 | 189.8 | 158.2 (a step of four) |
  | 4 | 253.1 | 158.2 |
  | 5 | 316.4 | 284.8 (a step of eight) |
  | 8 | 506.3 | 284.8 |

- **What bounds a Render's casting Lights is what bounded them**: the sixteen sampled textures a stage may bind, a texture a casting Light, refused by the compiler's own name (`compiler/binding-budget`). Sixteen casting Lights compile, seventeen do not. §V1029's two casting debts are the rows they were: a block of text and a binding a Light.
- **Untouched**: the Light Depth output's sweep and the projectors' occlusion sweeps (each still a target of its own: a projector's becomes a layer of the directional array in slice 6, and nothing in this slice needs it sooner), MSAA, the Depth output, the caster lists (T1598b), the per-frame skip of a draw that is provably empty.

### 16.2 What the backend gained

The brief named the `ring` as the starting point: a texture with layers, a view a layer to draw into, one `2d-array` view to bind. What a layered shadow target needed that a ring does not have, and the other way round:

| | A ring (T237, T321) | A layered target |
|---|---|---|
| Who writes a layer | one copy a frame, out of a single write target | a draw, straight into the layer it names |
| Which layer is which | the ring rotates; a uniform says where "now" is | the plan says; nothing rotates and no uniform is merged |
| Depth | none on the layers | one depth buffer shared by the layers |
| Bound as | the whole array, or a tap (a layer some frames back) | the whole array (`array`), or one layer by its index (`layer`) |

So it is a resource kind of its own, `layers`, and not a flag on `ring`: the two share two ideas and no mechanism.

- **`LayeredTargetResourceDescriptor`** `{ kind: "layers", id, size, format, layers, depth?, label? }`. Its structure key holds its layer count; the memory estimate counts every layer and one depth buffer; the device's `maxTextureArrayLayers` is checked by name before the texture is asked for.
- **`DrawPassDescriptor.layer`**. Required on a draw into a layered target and refused anywhere else. In the draw's key where it is set, so every other draw's key is the key it had.
- **The shared depth buffer has one rule, and the reader enforces it**: draws into different layers are different render passes, so a layer's draws test against what that layer's own passes left provided its FIRST pass clears. A plan whose layer opens with a pass that does not clear is refused by name.
- **Render-pass runs (T1604b)**: a run's identity gains its layer, so a run ends where the layer changes. A point Light's six faces stay one run; a Render's device pass count is what it was.
- **`TextureBindingDescriptor.layer`**: bind one layer as a plain `texture_2d`. Refused outside the target's layers, on a target that has none, and beside `array`, `tap` or `live`. In the pass's key where it is set.
- **In the vgpu backend** a layered target is one raw-device array texture, a `2d` view a layer and one `2d-array` view, each made once, and at most one depth texture (the same reach past vgpu as a ring's history: its `renderTarget` owns a texture of one layer). A layer is handed to vgpu's passes as a target: vgpu asks a target for a render pass descriptor, its formats, its sample count and its size, and gets them. It is carried across a structural recompile that leaves its key alone, destroyed when replaced, and cleared layer by layer at a document boundary.
- **The Pipeline panel** draws it in the texture lane with its layer count.

### 16.3 The form that was briefed, and why it is not what landed

Built first, complete, and on the branch as checkpoints 2 to 6: `shadowMaps` and `shadowCubes` each ONE `texture_2d_array` binding, a block reading `textureLoad(shadowMaps, texel, <layer>, 0)`. Two bindings in place of N, the cap of sixteen gone. Every shipped picture was the bytes it was. Then the measurement the brief asked for:

| Lit draw / reference (2560 x 1440, default Shadow Softness, a device pass a draw) | main | array at a literal layer | |
|---|---|---|---|
| 1 casting point Light | 0.255, 0.255 | 0.262, 0.244 | none |
| 2 | 0.476, 0.488 | 0.727, 0.714 | +50 % |
| 4 | 0.951, 0.958 | 1.609, 1.698 | +73 % |
| 8 | 2.049, 2.047 | 3.905, 3.861 | +90 % |
| 1 casting sun | 0.268, 0.262 | 0.302, 0.310 | +15 % |
| 2 | 0.488, 0.465 | 0.610, 0.622 | +29 % |
| 4 | 0.952, 0.930 | 1.310, 1.333 | +40 % |

The whole of it is the READ of a `texture_2d_array`, and none of it the storage: a scratch copy of the tree with the same two layered targets and each block reading a `texture_2d` view of its layer draws at main's cost, with main's text. The full tables (raw WebGPU and the engine's text; textures, array, views, atlas; by softness; the sweeps; an atlas's size wall) are in `docs/light-cost-investigation-2026-10-06.md`, section 15.

**Ruled (the lead, 2026-10-06): the views.** A slice whose gate is "no picture moves" does not move the lit draw by 50 to 90 %.

**An atlas was measured and rejected.** One plain texture a kind with a rectangle a Light reads at a texture's cost (within 5 % in the engine, the rectangle a literal or a uniform), which would make slice 5's rows free. Against it: inside the baseline's 8,192 texels a side an atlas holds ONE casting sun and TWO casting point Lights at a 4K output (six and ten at 1080p), and must refuse the rest; its point Lights' sweeps cost 29 % more at four and 2.6 times at eight without a scissor the backend does not have; and it was not byte identical in one measured case of fourteen. A storage that refuses at a size wall is not the storage of a path whose point is that counts do not matter.

### 16.4 Slice 5's first question

The property slice 5 is for, "the lit text is the same for any number of casting Lights", has to be had WITHOUT reading an array at one and a half to nearly two times. Two candidates, to be measured before anything is built:

1. **Layers as storage, a FIXED set of 2D view bindings a kind**, always declared (the unused ones bound to a spare layer), and a row's slot choosing among them by a `switch`. The text is fixed by a cap, and casting Lights are refused by name past it. To say: what the cap is against the sixteen-texture budget beside the material textures (T1658b), the environment, occlusion and the projectors; and what the `switch` costs.
2. **The array, if the taps can be written so that it reads at a texture's cost.** The rise is not linear in the reads: nothing at one read a Light, 7 to 10 % at nine, 73 to 85 % at 25, 84 % at 49. That is the shape of a threshold in the compiler and not of a price a read. A bounded look, half a day: the taps as one loop with a computed offset against unrolled, the layer hoisted into a `let`, a helper function a tap, rows of taps; and what Apple's compiler output says of the two forms if it can be read. If one form reads flat, the array comes back and the cap goes entirely.

Known already: on raw WebGPU the array's read costs 46 to 95 % more than a texture's at 25 reads and 34 % at nine, whatever the map's size or content; a nearest sampler in place of `textureLoad` costs the same; a layer read from a uniform costs a tenth more than a literal one.

### 16.5 Measured, as landed

Rule 12 throughout: a reference compute pass beside every frame, main's tree and this one loaded in one process and alternated, main first and last. Lit draw and sweeps over the reference, medians of each take; a PBR floor and a sheet over it; passes grouped into runs as the app draws them.

| Casting Lights | Lit draw: main | Lit draw: slice 4 | Sweeps: main | Sweeps: slice 4 |
|---|---|---|---|---|
| 1 point, 1920 wide | 0.149, 0.163, 0.140 | 0.146, 0.156 | 0.024 to 0.045 | 0.034, 0.038 |
| 2 point | 0.271, 0.286, 0.286 | 0.273, 0.283 | 0.070 to 0.083 | 0.082, 0.082 |
| 4 point | 0.553, 0.562, 0.569 | 0.543, 0.558 | 0.170 to 0.196 | 0.182, 0.170 |
| 8 point, 1280 wide | 0.586, 0.558, 0.569 | 0.562, 0.566 | 0.180 to 0.192 | 0.196, 0.207 |
| 1 sun, 1920 wide | 0.140, 0.146, 0.133 | 0.152, 0.140 | 0.023 to 0.040 | 0.023, 0.023 |
| 2 suns | 0.328, 0.271, 0.271 | 0.261, 0.265 | 0.065 to 0.089 | 0.065, 0.067 |
| 4 suns | 0.537, 0.558, 0.542 | 0.556, 0.545 | 0.157 to 0.170 | 0.176, 0.189 |

Every cell the same bytes as main, and the same lit text (51,872 characters at one point Light, 110,188 at eight). The machine was shared while this ran; a take differs from the next by more than the two trees differ.

**Whole frames** (the whole frame's GPU time over the reference, summed over 40 frames; main, slice 4, main, slice 4, main, slice 4, main):

| Document | main | slice 4 |
|---|---|---|
| The consumer's offline tier (five casting point Lights; 14 Lights) | 10.27, 9.74, 8.90, 8.84 | 9.70, 9.35, 8.87 |
| E79 Crucible (two casting Lights) | 0.735, 0.720, 0.709, 0.701 | 0.712, 0.716, 0.734 |

Neither moves: the offline tier's takes fall through the run in both trees, and each of slice 4's lies between its neighbours.

### 16.6 Every shipped Render's picture

Each of the 62 shipped Renders' own targets, frames 0 and 60, raw bytes, main (`9f337052`) against this slice, two takes; and a third take of the 27 Renders with a casting Light from the tree as it lands (main at `0fbe1348` merged), **27 of 27 the same bytes at both frames**, the furnace among them. The first two takes:

- **61 are the same bytes at both frames in at least one take, and 58 in both.**
- **The furnace** differs at frame 60 in both takes (293 and 627 channel values of 8.3 million) and at frame 0 in one. It is not the same picture run to run on main (B272), and by bytes it cannot be gated: rendered four times beside a second render of main's own tree, at frames 0, 30 and 60, MAIN DIFFERED FROM MAIN in eight of the twelve comparisons (by up to thousands of steps of a half float, in its sparks), and main against this slice was the same bytes in five. Its lit text is main's and its plan differs from main's only in the names this slice changes.
- **Three of on-nothing's Renders differed at frame 0 in ONE take each, by one step of a half float**: hands (4 values) and split's car shot (15), which have no casting Light, and mirror (26). Each was then rendered again beside a second render of main's own tree: in every repeat main against this slice was the same bytes, except the one repeat in which MAIN DIFFERED FROM MAIN by the same values (split's car shot, one of three; mirror, one of six, 28 values). So frame 0 of these Renders is not the same picture run to run on main, about one run in six, by one step. Found on the way; not this slice's.

### 16.7 Tests, and what was seen red

- **New**: `layered-target.test.ts` (13, the plan contract and the mock device) and `vgpu/layered-target.gpu.test.ts` (7, Dawn) over `layered-target.fixture.ts`; `shadow-layers.test.ts` (11, no GPU) and `vgpu/shadow-layers.gpu.test.ts` (5, Dawn) over `shadow-layers.fixture.ts`.
- **On Dawn**: a draw lands in the layer it names and the array is bound as that many layers; a layer bound as a plain 2D texture is the layer its binding names (bound out of order, and twice); a layer's draws are depth-tested against one another and every layer starts from a cleared depth; with a device pass a draw, a draw that does not clear finds its layer's colour and depth; a layered target of more layers than the device has is refused by name; a layer keeps its pixels from frame to frame and every layer is cleared at a document boundary; the layers are carried across a structural recompile and allocated anew when the count changes. Three casting suns, hard-edged and at Shadow Softness 1, each one's shadow where it throws it, of a box and of a plate off the middle; the same three in another order with the box drawn ahead of the floor; two casting lamps and a casting sun between them; sixteen casting suns.
- **The fixture's plate.** With the box alone the scene is its own mirror image and so are the maps of suns that mirror one another: every sun made to read layer 0 left the three suns' test green. The plate breaks the symmetry and each sun's shadow of it is probed. Found by the mutation run.
- **Claims re-derived, not loosened**: `scene-pipeline.test.ts` (a casting Light's map is a layer of the Render's array; its sweep names the layer; the lit draw binds `shadowMap0` at that layer and its text knows no array), `render-pass-runs.test.ts` (a run names its layer; the same runs and device pass counts).
- **Pins.** Unmoved: B260's eighteen digests, `scene-ao.test.ts`, the seven one-sheet programs of `grid-sheets.test.ts`, §V1029's ledger: every one a pin of TEXT. Re-taken, each with its reason beside it: the four example plans of `light-points.test.ts` and the three of `grid-uv.test.ts` that have a casting Light, which pin whole plans; a plan names a layer where it named a target.
- **50 mutations of the product, one at a time, 50 seen red.**

### 16.8 Where it departs from the brief, for the lead

- **A lit draw binds a texture a casting Light, not two arrays** (ruled; 16.3).
- **No refusal by memory and none at 256 layers.** Both were built for the array form, where nothing else bounded the casting Lights. With a binding a Light the compiler's sixteen refuses first, and an array of a step is never more memory than main allocated; a budget would only have refused documents main renders (eight casting suns at a 4K output are 1.1 GiB of layers here and 2 GiB of targets on main). The budget and its name belong to the slice that lifts the cap.
- **A new resource kind, not a ring with two flags** (16.2).

### 16.9 Not checked, and found on the way

- **`scene-mesh-instances.test.ts` was red on main since slice 3 landed** (two claims listed a lit draw's buffers and did not know the light table). Fixed, on main as `3cebb9dc`. It was found by reading the test tree for the old rule's statement; slice 3's own run had not named the file.
- **Frame 0 of three on-nothing Renders is not the same picture run to run on main** (16.6).
- **A device pass a draw (exact pass timing) inflates every sweep's span by an order of magnitude**, since each pass loads and stores its whole target. A sweep's figure taken in that mode says little of the app, and the lit draw's is unaffected.
- **Primitive instances reading a layer other than the first on Dawn**: the instances generator's lookup is the surface generator's own function and its text is pinned, but no Dawn test puts a casting Light's second layer on an instances draw.
- A browser; a second GPU; a device whose `maxTextureArrayLayers` is the floor of 256 (the refusal is tested against this device's own limit, whatever it reports).
- An unfiltered test run, by accident: a scratch script handed vitest an empty list of files, which is the whole suite. It ran for about ten minutes before it was stopped, and its result was not read. The script refuses an empty list now.

## 17. T1688b as built (2026-10-07): Shadow On, a casting light's shadow switched by a value

Asked by a consumer (sentinel-bot): its body light's shadow is wanted in the tunnel and wasted in three of the show's six turns, where nothing stands in the light's twelve metres. Cast Shadows is structure (the map, the sweeps, the block of lit text), so a place could not put the shadow out without a recompile.

### 17.1 What it is

- **Cast Shadows stays structure.** Beside it the Light has a VALUE, **Shadow On** (`shadowOn`, a boolean, default on, not compile-time). A cue, a preset or an expression turns it and nothing is rebuilt.
- **A switch and no amount.** TouchDesigner's Light COMP has Shadow Type (Off, Hard, Soft, Custom), a menu, and no strength; its strength is on the material (Phong MAT Shadow Strength). Notch's Light has Casts Shadows, a toggle. Both put a switch on the light. A fraction would need the lookup's text to change (a mix) and would keep the lookup's cost.
- **The mechanism is T1598b's, unchanged.** A light whose shadow is out reaches nothing: every caster draw of its sweeps stays in the plan and carries `skip`, and each sweep's far plate still clears. The map then says "nothing here" and never what it held when the shadow went out; the lit text, its bindings and its resources are the ones it has with the shadow on (§V1029: one text at 0 and at 1); the frame it comes back the sweeps draw the casters where they are. The Light Depth output's sweep follows, since it is that light's map as data.
- **A driven value is on unless it is 0** (the rule of every driven boolean). There is no half shadow.
- **What stays while it is out**: the lit pass's lookup (25 reads at Shadow Softness 2, of a map that holds nothing) and one clear a sweep.

### 17.2 Claims

- `shadow-switch.test.ts` (9, no GPU): out, every caster draw of that light's sweeps is skipped and its far plate still clears (a sun; a point light's six faces); it is that light's alone, in either order; the Light Depth output goes out with it. The plan with the shadow out is the plan with it on but for the flags: the same passes, text, targets, layers, bindings and resources, and the device is asked for no shader module and no pipeline going out or coming back. The parameter is a boolean that defaults on, is not compile-time, and is live only on a casting Light in Single mode; a revision that moves it is values-only, one that moves Cast Shadows is structure.
- `vgpu/shadow-switch.gpu.test.ts` (6, Dawn), whole frames byte for byte: out equals the same light with Cast Shadows off (a sun, a point light, a soft sun); the light beside it keeps its shadow; on, out, out, on over four frames with the caster moving, each frame equal to the document that was that way all along (the map is not stale); driven, 0.5 and -1 are on and 0 is out.
- 14 mutations of the product, 14 red (the worker's run, before parking).

### 17.3 The landing's ladder (main at `9a95def1` with this on top)

- The two files above and the five pin files (`material-textures`, `light-points`, `grid-uv`, `scene-light-guard`, `generated-text-growth`): green, no pin re-taken.
- The 27 catalogue walkers (460 tests), the fifteen test files that name the Light's shadow parameters (116), `test:gates`, `test:first-import`, `pnpm build`: green. One gate asked for a ledger row: `effective-schema-closure.test.ts` now names the new test's two reads of the Light's declared schema, with the reason.
- **The 27 shipped casting Renders**, frames 0 and 60 of each Render's own target, clean main against main with this: 0 channel values differ in all 27 (no control run was needed: there was nothing to explain).
- **A PBR surface** (not in the Dawn file, whose meshes are lambert): Shadow On off against Cast Shadows off, a sun and a point light on a Material · PBR floor and box: 0 of 36,864 half-floats differ in each; against the shadow on, 450 and 1,317 differ. The block and the row agree to the bit here.

### 17.4 What it is worth, on the consumer

sentinel-bot at 1280 × 720 with its pack of three out, headless on Dawn, the whole frame's GPU time by the reference-pass rule (B260): the document before (the body light always casting) and after (its Shadow On driven by the place: on in the tunnel, out in the fields, the dock and the temple), each held at a place by the panel's Place, 150 frames after 12 of warm-up, the two alternated (before, after, before, after, before, after, before), a fixed reference pass beside every frame (2.69 to 2.82 ms throughout).

| place | before, ms | after, ms | of the reference, before to after |
|---|---|---|---|
| the fields | 11.7 to 12.1 | 9.0 to 9.2 | 4.35 to 3.40, -21.8 % |
| the dock | 12.1 to 12.3 | 9.5 to 9.6 | 4.48 to 3.51, -21.7 % |
| the temple | 11.9 to 12.1 | 9.3 to 9.4 | 4.39 to 3.37, -23.3 % |
| the tunnel (the shadow stays on) | 13.6 to 13.7 | 13.6 to 13.6 | 4.85 to 4.86, +0.2 % |

About 2.6 ms a frame in each of the three places, and nothing in the tunnel. The picture: one frame of each place with the shadow on and out, whole-frame PSNR 61.8, 66.6 and 60.4 dB; looked at side by side, no difference found.

### 17.5 Not checked

- Primitive instances and a points geometry under a light whose shadow is out (the Dawn file's casters are file meshes).
- The app: a Shadow On toggled from the inspector or a cue, and the performance panel's sweep rows while it is out.
- GPU time in a browser; the figures above are Dawn's.

