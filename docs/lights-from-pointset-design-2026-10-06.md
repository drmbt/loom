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
| `node.scene.lightSources` | Render | more than seven pointset Lights (3.9) |
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
  - More than seven pointset Lights in one Render: a compile error (`node.scene.lightSources`).
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
