# Sweep: a profile along a curve, as a lit surface (T1587b)

**Status, 2026-10-06: slices 1, 2 and 3 are built (1 and 3 in `90fb1558`, with the worked check in `bd2b364e`; 2, sheets, as section 11.3 says; 2b, a grid's texture coordinate with B255 and Map Extend, as section 11.4 says).** The decisions of section 8.3 are ruled, all as recommended, with D9 moved out to its own bug row (B255). The node is `src/nodes/definitions/point-sweep.ts`, its pass `src/nodes/shaders/sweep.wgsl.ts`, its CPU reference `src/points/sweep.ts`. Sections 4, 5.2, 6.1, 7 and 9 say what was built and measured; where building it showed the design wrong, the text is corrected in place and section 11 lists the corrections. The worked check against the consumer's bore is section 11.2, what slice 2 built and measured is section 11.3, and slice 2b is section 11.4.

It follows `docs/curve-family-design-2026-10-05.md` (T1586b, whose slices 1 to 4 and 6 to 8 are built) and reads `docs/mesh-instancing-design-2026-10-05.md` (T1581b) and `docs/geometry-cost-profile-2026-10-05.md`.

The row asks for a profile (ring, square, strip, custom) swept along a curve into surface geometry that the Render lights, shadows and writes to its G-buffer: radial segments, radius, per-point scale, caps, twist. Its consumers are the sentinel tunnel's bore, cables, and a tentacle's skin. The owner's standard is the curve row's: consider how TouchDesigner and Notch do it, build the general shape, no brittle or unscalable shortcuts.

Read for this: the two designs above, the reference survey (`docs/td-notch-mechanisms-2026-10-05.md`), the Render's surface generators (`src/nodes/shaders/scene-render.wgsl.ts`, `scene.ts`, read only), `src/points/topology.ts`, `src/projects/sentinel-bot/tunnel.ts`, and the TouchDesigner and Notch pages in section 10, fetched on 2026-10-05. Neither program was run. Section 2.3 is measured; a cost marked "derived" is arithmetic from measured figures.

## 0. The design on one page

- **A sweep is a pointset.** One compute pass writes a ring of points at every point of a curve, and publishes them with a grid claim: columns round the profile, rows along the curve. The Render's Surface path draws a grid today, so the sweep is lit, shadowed, G-buffered and Material · WGSL-shaded with no new draw.
- **A kernel can stand between the sweep and the Geometry.** A grid's normals are worked out from its points on every draw, so a kernel that pushes the wall in and out (the tunnel's ribs, pipes and deck) is lit correctly without knowing what a normal is. A mesh's normals are an attribute and would go stale. This decides the representation.
- **One Geometry for many tubes.** A Geometry costs about 0.3 ms of device time however small it is: seven draws with one point light casting, fifteen in the consumer's document (section 2.3: forty tubes as forty Geometries take 12.6 ms, as one 0.7 ms). (Those figures are from before T1604b, which made a node's consecutive draws into one target one device pass; section 3.5 says what is left of the argument.) So the sweep of several strips is one pointset and one draw. A grid claim holds one sheet, so the claim gains a third number: `grid:{cols}x{rows}x{sheets}`. That is a change of a few lines in each of the Render's three grid vertex chunks.
- **The sweep reads the curve family's attributes and adds none to it.** It takes `orient` from Curve Frames, so twist, roll and the closing of a loop are that node's and a sweep and the instances beside it agree. It takes `distance` and `curveU` for the texture coordinate along its length. Padding sweeps to rings of no length and triangles of no area.
- **Hard edges and caps are repeated columns and rows.** A corner that should be sharp is two columns in one place; a cap is the end ring repeated and then drawn in to its centre. The grid's normal rule then gives each face its own normal. No index list.
- **Two slices matter.** Slice 1 is the node for one strip, which draws through today's Render untouched: the tunnel's bore. Slice 2 is the sheet in the claim and the Render, which is cables and the tentacle's skin (built 2026-10-06, section 11.3).

## 1. How TouchDesigner and Notch do it

### 1.1 TouchDesigner

- **Sweep SOP** (CPU geometry). "The Sweep SOP sweeps primitives in the Cross-section input along Backbone Source primitive(s), creating ribbon and tube-like shapes." Three inputs: cross-section, backbone, reference.
  - "The orientation of the cross section is based on the direction of the backbone line segment and the positive Z axis." Angle Fix "attempts to fix buckling twists that may occur when sweeping"; Fix Flipping does so "by fixing flipped normals". Aim at Reference Points uses the third input "in conjunction with the backbone to control the orientation of the elements along the sweep".
  - Scale "scales the cross sections globally". Twist is "cumulative rotation of the cross sections around the backbone"; Roll is "non-cumulative ... All cross sections get the same rotation".
  - Skin Output: Off, On, or "On with Auto Close", which "closes the skinned mesh if the path curve which it follows is also closed". With it off the SOP leaves the placed cross-sections unjoined.
  - Cycle Type places all cross-section primitives at each point, one at a time, or cycles them.
  - Remove Coincident Points on Path: "any points right on top of one another will be ignored".
  - "If the backbone primitive(s) have point colors or texture coordinates, they will be maintained and applied to the cross section primitives."
  - Its page lists no caps parameter; TouchDesigner caps geometry with a separate SOP.
- **There is no Sweep POP.** The reference survey read the POP list: the Line Thick POP "has been removed", and the Extrude POP is not a sweep. It "gives apparent 'thickness' to line strips, triangles or quads", along Normal, X, Y or Z, with a Distance and an Inset, and its page sends the result to a Normal POP for shading. It takes no path.
- So on the GPU, by the survey's reading, what is left is a Copy POP onto a line-strip template, or the Line MAT, which is flat and has "no affect from scene lighting". A lit, skinned tube from a GPU curve is not a stock operator.

### 1.2 Notch

- **Spline Extruder.** "This node generates a mesh from an input spline, by extruding a shape along the spline ... the extruded mesh will dynamically update to match. Useful for making tubes and tunnels, as well as wires and ribbon effects."
  - It "outputs geometry which can be modified with Deformer nodes, or used as a mesh source". The sweep is a mesh that the rest of the graph treats as one.
  - Extrude Shape: Square; Ring ("the num radial segments parameter controls the number of segments in the ring"); 2D Strip ("a flat strip which is single-sided"); Thickened Strip; Star. Num Radial Segments; Radius.
  - Num Spline Segments. Spline Time Min, Max and Offset, "normalised by the splines length", which "can form a slice which moves along the spline". Lock Subdivisions To Spline Time: "the subdivisions along the spline will be treated as locked in place ... Useful for maintaining consistent polygon density".
  - Caps: None, Single, Double.
  - Control Point Scaling Mode: None, Radius ("using the length of the control point's xy scaling") or XY.
  - Radial Rotation Offset. Use Spline Colours. UV Mode ("controls how the generated geometrys uvs are generated along the spline"; the page lists no options).
  - Fade Alpha and Fade Scale over a Fade Front Duration and a Fade Back Duration.
  - Minimise Self-Intersections "attempts to avoid the self-intersections that occur at tight corners in the spline by pushing the vertices away from the intersecting planes".
  - Input: Spline Sources, plural. "The Duplicate Spline deformer can also be used to easily draw multiple splines."
- Beside it: Lines To Mesh (Edges Radius, Edge Segments), a trail renderer with extruded geometry, and the Spline Deformer, which bends an existing mesh along a spline.

### 1.3 Where the two agree, and where they differ

- A sweep is a cross-section placed by a frame at every point of a path and skinned between neighbours.
- The result is ordinary mesh geometry, which later operators deform.
- A closed path closes the skin.
- **They differ on whose the frame is.** TouchDesigner's sweep derives it itself, from the segment and +Z, and carries two fixes for the twists that gives. Notch's spline resolves twist itself ("Twist Method") and the extruder only adds a rotation offset. This design is Notch's way round: the frame is the curve's.
- **They differ on scale.** TouchDesigner's is one number for the whole sweep; Notch's follows the control points.

### 1.4 Comparison

| | TouchDesigner | Notch | Loom today | This design |
|---|---|---|---|---|
| Where it runs | CPU (Sweep SOP); nothing on POPs | GPU, regenerated when its inputs change (the survey's reading) | a kernel bending a grid by hand (`tunnel.ts`) | one compute pass a frame |
| Profile | any primitives, a second input | Square, Ring, 2D Strip, Thickened Strip, Star | whatever the kernel writes | Ring, Square, Strip, Custom (a strip on a second input) |
| Radial segments | the cross-section's own points | Num Radial Segments | the grid's columns | `sides` |
| Radius and scale | Scale, global | Radius; control point scale as Radius or XY | by hand | `radius`, and a per-point attribute in Map mode |
| Frame and twist | from the segment and +Z; Angle Fix, Fix Flipping, a reference input; Twist, Roll | the spline's Twist Method; Radial Rotation Offset | by hand | Curve Frames' `orient`; its Roll, Twist and Close Twist |
| Caps | a separate SOP | None, Single, Double | no | None, Start, End, Both |
| Closed path | Skin: On with Auto Close | follows the spline | by hand | the path's closed claim |
| Part of the path | upstream | Spline Time Min, Max, Offset; Lock Subdivisions | by hand | Resample's Range and Offset upstream |
| Texture coordinates | carried from the backbone | UV Mode | the grid coordinate | around; along as Stretch, Metres or Points |
| Colours | carried from the backbone | Use Spline Colours | by hand | every attribute of the path point is carried |
| Tight corners | Angle Fix | Minimise Self-Intersections | no | resample more densely (Resample by Curvature); a mitre is a follow-up |
| Several paths | one skin per backbone, groups | Spline Sources, Duplicate Spline | one grid | one sheet per strip, one draw |
| What comes out | SOP geometry | a mesh deformers can modify | a grid pointset | a grid pointset a kernel can modify |

## 2. What the engine draws today

Read from `scene.ts`, `scene-render.wgsl.ts` and `points/topology.ts`; section 2 of the mesh-instancing design has the full survey.

### 2.1 A Surface geometry

- Every draw is vertex-pulled: `draw(vertexCount)`, with the vertex stage reading storage buffers by `vertex_index`. There are no vertex buffers and no index buffers.
- A Surface geometry takes a pointset whose edge claims a **grid** or a **mesh**. Anything else is refused ("carries neither an analytic grid nor a mesh topology").
- **Grid** (`surfaceMeshWgsl`): the claim is `grid:{cols}x{rows}` with `wrapU`, `wrapV`. Six vertices a cell; the vertex index is the connectivity. The normal is the cross product of central differences of the positions, taken in the vertex stage on every draw. The texture coordinate is the grid coordinate. A vec4f attribute tints it when the Geometry's Tint is mapped to one. It binds the positions, and the colours if any.
- **Mesh** (`meshVertexWgsl`): the claim is `mesh:{triangles}@{index buffer}`. The vertex stage reads the index, then `position`, then a `normal` attribute, which is required, and `uv`, `surface`, `emissive` and `color` if present. Each is its own storage binding: seven for a full mesh. The fragment stage turns a mesh's normal to face the viewer and lights the side that faces the light; a grid's normal is used as it stands and the surface is lit on both sides (`abs(N · L)`).
- **The depth sweeps** (shadows, the AO prepass, the Depth outputs) use `shadowSurfaceWgsl` for a grid, which reads the positions and nothing else, and `shadowMeshWgsl` for a mesh, which reads the index and then the position.
- There is a third copy of the grid chunk in the older Render Surface node (`render-surface.wgsl.ts`).

### 2.2 What a Geometry costs

From the cost profile (measured in the consumer's document, before its fixes): one more instanced Geometry is fifteen draws when two point lights cast shadows: the lit draw, the Normal layer, the Depth sweep and twelve cube faces. It measured about 1.2 ms of CPU and 0.3 ms of GPU per added Geometry: "The triangles are not the cost." Its P1 (built) cut the compile's share; its P2 (one render pass per target, T1604b) is designed and not built.

### 2.3 Measured for this design

A scratch script (not in the repository) drew Tube Points through a Surface Geometry and a Render, far from the camera on a 64-pixel output so that the frame is bound by vertices and passes, not by pixels. Dawn on Metal, Apple M3 Max, best of 9 runs of 100 frames, each run ended by a readback. The figure is the wall time of a frame on the device: encoding, submission and the GPU. It does not include the app's per-frame compile.

| Scene | Vertices | No shadows | One directional shadow | One point shadow (six faces) |
|---|---|---|---|---|
| a 4 × 4 grid, one Geometry | 16 | 0.25 ms | 0.38 | 0.58 |
| the bore's size, 256 × 768, one Geometry | 196,608 | 0.33 | 0.48 | 1.17 |
| 256 × 3,906, one Geometry | 999,936 | 0.95 | 1.58 | 5.00 |
| 16 × 2,200, one Geometry | 35,200 | 0.26 | 0.42 | 0.67 |
| 16 × 55, **forty Geometries** | 35,200 | 1.76 | 3.95 | 12.65 |

- **The same 35,200 vertices cost 0.67 ms as one Geometry and 12.65 ms as forty**, with one point light casting. That is 0.31 ms of device time per added Geometry, before the app's compile is counted. The cost profile's 0.33 ms is GPU time alone under two point lights, so the two are near and are not the same quantity.
- **A vertex costs about 0.1 ms per million invocations per pass** on the grid path: a million vertices are six million invocations a pass, and the seven draws a Geometry has under one point light (the lit draw and six faces, counted in the plan) take 4.4 ms more than the 4 × 4 grid's. The mesh-instancing design measured the same slope on the mesh path.
- So the size of a sweep is nearly free up to some hundred thousand vertices, and the number of Geometries is not.

## 3. The representation

### 3.1 The three candidates

**A. A mesh claim.** The sweep writes vertices with `position`, `normal` and `uv`, and an index list, and claims `mesh:N@indices`.

- It needs no change in the Render.
- It can express any triangles: caps of any outline, profiles that change along the path.
- Its normals are an attribute. A kernel after the sweep that moves a vertex cannot repair them: a kernel reads its own point, not its neighbours.
- Every vertex of every pass reads an index and then its attributes: two reads in each depth pass where a grid does one.
- It stores about 64 bytes a vertex (16 position, 16 normal, 8 uv, and 24 of indices for the quad that goes with it), all of them read by the draw. A grid's draw reads 16; this design's sweep stores 40, because it publishes a `normal` and a `uv` for kernels and materials.
- The index list has to be produced by a pass or an upload, and it is larger than the positions.

**B. A grid claim, with sheets.** The sweep writes positions (and attributes for kernels and materials), and claims a grid: columns round the profile, rows along the path, one sheet per strip.

- One strip is the claim the Render draws today.
- The normal follows the points, whatever moved them.
- Hard edges and caps are repeated columns and rows (section 4.4).
- Several strips need the claim to say where one sheet ends. That is a change in the Render's grid chunks (3.3).
- It cannot express a cap that is not a fan (4.5), nor a profile whose point count changes along the path.

**C. Strips of rings, swept in the vertex stage.** The Geometry reads the curve's points and a profile and builds each vertex when it draws it. Nothing is stored per vertex.

- The vertex stage would build a frame and a ring point for the vertex and its four neighbours (for the normal), six times a cell, in every pass. The mesh-instancing design's D8 exists because the primitives' generator did this, and replaced it with "resolve once per instance, draw many times".
- There are no points for a kernel to move. The tunnel's relief would have to become a material trick or part of the draw.
- It is a third fetch chunk in a generator that D11 keeps to two, with a depth variant and a glass variant of its own.

### 3.2 The decision: B

**A sweep is a pointset with a grid claim, one sheet per strip.**

1. **The tunnel is a displaced sweep.** Today's bore kernel builds the ring and then moves each vertex in or out for plates, pipes, ribs and the deck, and the grid's normal rule lights the result. With B that kernel keeps only the relief and still needs no normal. With A it would light a ribbed wall as a smooth pipe.
2. **It is the cheaper draw**, in reads and in bytes, in exactly the passes there are most of (the depth sweeps).
3. **One strip works now**, with no change to files another worker is in.
4. **It is what the engine already said.** The mesh-instancing design's section 9: "A sweep produces a grid-topology surface, which draws through the existing grid path, takes the object transform from slice A, and can be an instance shape once F10 lands."
5. **C repeats the work D8 removed** and gives a kernel nothing to hold.

What B gives up is named as follow-ups (8.2): caps of outlines that are not star-shaped, and profiles that change their point count.

### 3.3 The grid claim, extended

Three changes, each small, all in the Render's grid chunks and `points/topology.ts`. The first, sheets, is slice 2 and is built (11.3); the other two are slice 2b.

**Sheets.** `grid:{cols}x{rows}x{sheets}`, with the wrap flags after it as now. A claim without the third number is one sheet, so no shipped claim changes.

- Slot = `(sheet × rows + row) × cols + col`. `rows` is the rows of ONE sheet.
- A wrap is per sheet: `wrapU` closes each sheet round its columns, `wrapV` along its rows.
- **The draw is ONE draw, vertex-pulled as every grid is.** The plan passes `sheets × cells × 6` vertices; in the vertex stage the sheet is the vertex's cell ÷ a sheet's cells, and the row and column are the remainder. No cell joins two sheets, so there are no join triangles, degenerate or otherwise. The neighbours for the normal are clamped or wrapped inside the sheet. No new uniform: the shader has `cols`, `rows` and the wrap flags.
  - Not an indexed draw with restarts: the grid path has no index buffer, which is its point (2.1).
  - Not an instanced grid (one instance a sheet): it is the same single draw call and the same vertex work, with the sheet read from `instance_index` in place of one integer division. It would give a grid draw a second meaning for `instances`, which a mesh draw uses for mesh instances.
- **The sheeted text is a VARIANT, emitted only for a claim of more than one sheet** (changed 2026-10-06; the first draft changed the grid chunks for every grid). Two shader programs can round one expression differently (found in the curve row's slice 6), so a one-sheet grid keeps the program it has, to the byte, and every shipped grid keeps its picture by construction. A test pins the one-sheet programs by their text.
- Readers: the two grid vertex chunks of the Render (`surfaceMeshWgsl`, which the lit draw, the G-buffer layers and glass share, and `shadowSurfaceWgsl`, which every depth sweep shares) and Render Surface's own; the places that size a grid draw (the Render's lit, depth and glass draws in `scene.ts`, the preview tile in `compile.ts`, `render-surface.ts`), all through one `gridVertexCount`; `parseTopology`, `formatTopology`, `gridCellCounts`, `gridPointCount`; the Topology node (a Sheets parameter); and `stripsOf`, for which every row of every sheet is a strip.
- **A kernel's `ctx.dim` describes ONE sheet**: `cols`, `rows`, `i` and `j` are the sheet's, so a kernel written for one tube runs the same on each of ten. It gains `sheet` and `sheets`. A kernel over a one-sheet edge that names neither keeps its text.

**Slice 2b (built 2026-10-06, section 11.4): a grid reading a `uv` attribute.** It was in slice 2; it moved out to be done with B255.

- It changes what a grid's texture coordinate IS wherever a pointset carries a `uv`, and B255 changes the same expression (`gx ÷ cells` on a wrapped axis). Both move textures on grids that draw today and need the same list of affected documents; done together they are one change to one line of each chunk and one set of re-derived pixel claims.
- As built it is read only where a coordinate is read: a map is wired to the material, or a Material · WGSL's source names `.uv`. Everywhere else the program is the one the grid has without a `uv`, so a sweep whose material patterns by world position pays nothing.
- The rule is D2's, made symmetric. On a wrapped axis the corner past the seam reads the first column again, whose coordinate is back at the start, so the grid carries it on by whole turns: `u₀ + sign(d) × ⌈|d|⌉` with `d = u_last − u₀`. For a coordinate that rises that is the ruled `u₀ + ⌈u_last − u₀⌉`: once round arrives at `u₀ + 1`, `N` whole times at `u₀ + N`. For one that falls (a mirrored coordinate from a kernel) it carries down, where the first form would have run the whole map backwards across the seam cell. The sweep only ever writes coordinates with a whole period on a wrapped axis (4.6), so the rule has nothing to guess.
- The alternative was the textbook one: repeat the seam column, so the claim is not wrapped and both ends of the seam have their own coordinate, and tell the grid that the first and last columns are one place so its normal is still smooth across it. That needs a second kind of closure in the claim, and a kernel that moves the two seam columns differently opens a crack.

**The grid coordinate reaches 1 on a wrapped axis (B255, fixed 2026-10-06 in `3a9ea829`).** It was `u = gx ÷ (cols − 1)`, which on a wrapped axis ended at `cols ÷ (cols − 1)`: the map was squeezed into all but the last cell and the seam cell showed its last texel from side to side. It is `gx ÷ cells`. An axis that does not wrap has the value it had, to the bit.

### 3.4 What the claim does not need

- **No count.** A strip shorter than its slots repeats its end point (§V788), Curve Frames gives the repeats the end's frame, and so the sweep's rings there are one ring many times: cells of no area. A cap at that end sits on the last real ring.
- **No normal attribute for the draw.** The sweep publishes its own `normal` for kernels (4.3); the grid path does not read it.
- **Nothing per pass.** The claim and the points are all a depth sweep needs.

### 3.5 Slice 2 against the Render as it is (2026-10-06)

Re-read after T1604b (one device pass per run of a node's draws) and T1598b (shadow caster lists, reach).

- **Runs (T1604b).** A sheeted geometry is still one draw in each pass that draws it, with more vertices. It adds no plan pass and moves none, so every run is the run it was (`renderPassRuns`).
- **What is left of "one Geometry for many tubes".** Section 2.3's 0.31 ms per added Geometry was mostly per device pass, and N Geometries into one single-sampled target were expected to be ONE device pass of N draws. Measured, they are not in the last target a Render draws: each Geometry's pointset is swapped after its last reader, between two Geometries' draws, and a swap ends a run (11.3). So N Geometries still cost a device pass each there, N draws' encoding and uniforms in every pass, and N chains before them. Measured for the consumer's shape in section 11.3: ten Geometries are 1.56 ms a frame more than one of ten sheets.
- **The reason that does not depend on cost.** Several strips arrive in ONE pointset: ten strands from a rope node, a pipe run from one kernel. A Geometry draws a pointset, so without sheets there is nothing to wire: the strips could not be split into ten Geometries without ten nodes that each select one.
- **Shadow caster lists (T1598b).** A list names a Geometry. A sheeted sweep is one Geometry, so it is named, kept or excluded whole, as any other. Nothing changes.
- **Reach.** A bound exists only where it is known without reading the GPU, and a sweep's points are placed on the GPU: it publishes none and is always drawn, which is the safe direction. Unchanged.
- **The preview tile and Render Surface** draw a grid with their own sizing; both take the sheet count through the same function.

## 4. The node

`pointSweep`, title **Sweep**, category points, kind `sweep`. Stateless; no clock.

### 4.1 Ports

- `points` (labelled **Path**): a pointset whose edge claims strips, carrying `position` and `orient` (a vec4f quaternion, +Z along the curve and +Y its normal: Curve Frames). Each strip becomes one sheet.
- `profile` (optional, labelled **Profile**): a pointset whose edge claims strips. Its first strip is the cross-section: each point's x and y, in the frame's X and Y. A closed claim closes the profile. Read when Profile is Custom.
- `out`: the swept pointset.

### 4.2 Parameters

A parameter marked ⓢ is structural. "Map" is Map mode on the Path input.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `profile` ⓢ | enum | Ring | Ring, Square, Strip, Custom |
| `sides` ⓢ | number | 16 | Ring: sides round. Strip: segments across |
| `smooth` ⓢ | boolean | on | Ring and Custom: on, one normal a corner (a round tube from few sides); off, every side flat |
| `radius` | number, Map f32 | 0.1 | the profile's half-width, metres. A mapped attribute multiplies it per path point |
| `caps` ⓢ | enum | None | None, Start, End, Both. A closed path has none |
| `facing` ⓢ | enum | Outward | which way the surface's normal points: Inward for a tunnel seen from inside. It decides the `normal` attribute, the Render's Normal output and what a material's normal starts from. It does not decide which side is lit: a grid Surface is lit on both (section 11.1) |
| `uvAlong` ⓢ | enum | Stretch | the coordinate along the path: Stretch (0 to 1 over each strip), Metres (distance ÷ `uvLength`), Points (the row over the rows) |
| `uvLength` | number | 1 | Metres: metres of curve to one tile |

- **Ring** is `sides` points on a circle of `radius`, at least three, the first on the frame's +X. **Square** is four flat sides, flats up, half-width `radius`; its first side is the +X face. **Strip** is a flat ribbon along the frame's X, `2 × radius` wide, from +X to −X so that its normal is +Y. **Custom** is the Profile input, its x and y multiplied by `radius` (1 keeps its size).
- **There is no twist or roll here.** Curve Frames has Roll, Twist and Close Twist, and the sweep reads the frame they made. A sweep and the instances along the same curve therefore agree, and Notch's Radial Rotation Offset is Curve Frames' Roll.
- **The mapped radius multiplies** the authored one, as a Geometry's mapped Scale does. A Curve's table publishes `scale` per control point; mapped onto `radius` it is Notch's Control Point Scaling Mode: Radius. A taper, a fade at the ends (Notch's Fade Scale) or a hall in a tunnel is an attribute a kernel writes on the path.
- **Part of a path** (Notch's Spline Time Min, Max and Offset) is Resample's Range and Offset upstream. Resample by Distance keeps its stations at fixed distances while the range moves, which is Lock Subdivisions To Spline Time.

### 4.3 What it publishes

- `position`.
- `normal` (vec3f): the profile's own normal in the ring's plane, on the side `facing` names; on a cap's two rows, the end's. It is for a kernel that pushes the surface in or out. It is not the lit normal, which the grid works out from the points, and it does not lean with a taper.
- `uv` (vec2f): round the profile from 0, and along the path by `uvAlong`.
- **Every attribute the path point carries**, copied to each vertex of its ring, except the frame's own (`orient`, `tangent`, `normal`, `binormal`). So a colour on the path reaches every vertex, and tints the tube when the Geometry's Tint is mapped to it (TouchDesigner's carried colours, Notch's Use Spline Colours), and `distance`, `curveU` and any attribute of the author's reach a kernel or a material. What the path carries is what is paid for: a tube of 256 sides copies each attribute 256 times.
- The claim: `grid:{columns}x{rows}` for one strip, `grid:{columns}x{rows}x{strips}` for several, with `wrapU` when the profile is closed and `wrapV` when the path is.

### 4.4 Columns, rows, and hard edges

- **Columns** go round the profile from the frame's +X toward its +Y. With rows running along the tangent, the grid's normal then points outward. **Inward walks the same outline the other way from its first point**: a closed smooth outline starts on the same point and goes round backwards, any other is its column list reversed. The way round (`uv.x`) still rises with the column, so a pattern reads the right way from the side the surface faces.
- **A corner that should be sharp is two columns in one place.** The grid's normal at a point is the cross product of the differences to its neighbours across and along. For the first of two coincident columns the neighbour ahead is in the same place, so its difference across is the side behind it; for the second it is the side ahead. Each gets its own side's normal, and the cell between them has no area. So Square is eight columns, a Ring with Smooth off is `2 × sides`, and a custom profile is sharp where it repeats a point.
- **Rows** are the path's points in order, with cap rows before and after (4.5).

### 4.5 Caps

- A cap is two more rows at an end: the end ring again, and then that ring drawn in to the path point.
- The repeated ring gets the cap's flat normal by the same rule as a hard edge, and the tube's last ring keeps its own.
- The centre row has no normal of its own (its points coincide); the fragment stage already guards a normal of no length, and every pixel of the cap takes the rim's normal by interpolation.
- The cap's `uv` is polar, not planar: the way round is the rim's, and the coordinate along carries on over the edge at the same rate, so the centre is one radius further than the rim (in metres, or as a share of the length under Stretch). The radius is the cap's own end's on a tapered path.
- **A cap is a fan to the path point.** That is right for a profile every point of which can see the origin: Ring, Square, Strip, and any convex outline round its centre. For a C-shaped profile the fan folds over itself. Such caps are a follow-up that needs real triangles (C3).

### 4.6 Texture coordinates

- **Around**: the share of the way round the profile at that column, by its sides (not by their lengths: follow-up C11): once round a closed profile and 0 to 1 across an open one. Two columns in one place share it; the last column of a flat-sided closed outline is at 1, where it closes. Tiling is the material's Map Extend (11.4): there is no UV scale on a material, and the first draft of this line said there was.
- **Along**:
  - **Stretch**: `curveU`, 0 at the strip's start and 1 at its end, by distance.
  - **Metres**: `distance ÷ uvLength`, so a pattern keeps its size whatever the spacing of the rings. On a closed path the number of tiles is rounded to a whole number per strip, so the pattern meets itself at the seam; the tile is then within half a tile of the length asked for.
  - **Points**: the row number over the rows, a cap's rows included (over the rows less one on an open path, so the last row is 1). It needs no attribute.
- Each mode reads only what it uses, from what Curve Frames publishes with Metrics on: Stretch reads `curveU`, and `curveLength` when an end is capped; Metres reads `distance`, and `curveLength` on a closed path. Without one of them the node refuses by name and says which switch to turn on. It does not fall back to Points.
- Since slice 2b the Render hands this `uv` to the Geometry's material where it reads a coordinate (a map, or a Material · WGSL that names `s.uv`). A stock map tiles along a Metres coordinate when the material's Map Extend V is Repeat; with Hold, the default, it shows one tile and then its edge.

### 4.7 Refusals, all by name

- The Path edge claims no strips; or carries a GPU live count; or its strips have one point each.
- The path carries no `orient`, or one that is not a vec4f: "put a Curve Frames before the Sweep".
- A path attribute with no type on the edge: the sweep owns every attribute of its output and cannot copy what it cannot size.
- `uvAlong` needs an attribute the path does not carry.
- Profile is Custom and nothing is wired, the edge claims no strips, or the strip has fewer than two points.
- The sweep would hold more than 1,000,000 vertices, every strip's counted: the count, and which of Sides and the path's points to lower.
- A parameter in Map mode other than `radius`; a `radius` map that is not an f32 or one channel of a float vector; a `radius` map that names the Profile input (a Map reads the path, §V306).
- More upstream buffers than a stage binds (§V588).

Caps on a closed path are not a refusal: a loop has no ends, so there is nothing to cap.

## 5. GPU strategy and costs

### 5.1 The pass

**One dispatch, one thread per vertex.** A thread works out its sheet, row and column from its slot, reads its path point (position, orient, radius and whatever is carried) and its profile point (a closed form for Ring, Square and Strip; a read for Custom), turns the profile point by the quaternion, and writes. No walk and no scan: nothing about a vertex depends on another, which is the Curve node's shape.

- The node owns one packed buffer and writes its regions by offset (T1076).
- It binds one buffer per upstream producer, the profile's, and its own.
- `src/points/sweep.ts` is the CPU reference, as `curve.ts` is for the curve nodes: the oracle of the Dawn tests.

### 5.2 Costs

| | Figure | Basis |
|---|---|---|
| The sweep pass | 0.02 to 0.06 ms for 199,936 vertices; 0.22 to 0.46 ms for 999,936 | measured, 2026-10-06 (the table below) |
| Drawing it, one point shadow | 1.17 ms at 196,608 vertices; 5.0 ms at a million | measured (2.3) |
| A vertex, per pass | 0.1 ms per million invocations; six invocations a cell | measured (2.3) |
| One more Geometry | 0.31 ms of device time with one point shadow | measured (2.3) |
| Memory | 16 bytes a vertex for position, 16 for `normal`, 8 for `uv`, and each carried attribute's own size | the packed layout |

**The sweep pass, measured.** Dawn on Metal, best of 9 runs of 200 frames, over the same graph without the node; a Ring; ms a frame. What a vertex is written from decides the cost: 40 bytes of its own, and every attribute the path carries copied on top.

| Vertices | Sides × rings | Path with a frame only (40 bytes a vertex) | With Curve Frames' metrics (56 bytes) | And a colour and a width (76 bytes) |
|---|---|---|---|---|
| 199,936 | 64 × 3,124 | 0.02 | 0.04 | 0.06 |
| 999,936 | 256 × 3,906 | 0.22 | 0.36 | 0.46 |

Flat sides, a mapped radius and the coordinate along make no difference the measurement resolves (runs of one graph differ by 0.05 ms). The derived figure this replaces was "under 0.1 ms and 0.2 to 0.4 ms": it held.

- **A long sweep is cheap and a many-Geometry sweep is not.** That is the reason for sheets. Ten strips of 54 points and 12 sides (6,480 vertices) are 0.016 ms, and one strip of them is 0.019: at this size the cost is the pass, not the vertices (11.3).
- A million vertices is the pointset ceiling: 256 sides by 3,906 rings, or 16 sides by 62,500.
- The Curve Frames before a sweep costs more than the sweep: 0.6 to 0.8 ms for one strip of 1,024 points with all its attributes (measured in the curve design, section 4.5).

### 5.3 What it leaves

- **Every vertex is drawn in every pass.** There is no culling and no level of detail, as for every Surface. Fewer sides at a distance is a follow-up (C6).
- **Indexed draws** (the mesh-instancing design's F3) would cut a grid's six invocations a cell to about one a vertex. They are that row's, and a grid would gain as a mesh does.
- **One render pass per target** (T1604b) cuts what a Geometry costs. It does not remove the reason for sheets: forty Geometries are still forty lit draws and forty times every depth draw.

## 6. Consumers

### 6.1 The sentinel tunnel's bore

**Today** (`src/projects/sentinel-bot/tunnel.ts`): one grid of 256 columns by 768 rows, a window of 115 m that rides with the robots. Its rows are 0.15 m of z apart, and z is the centre line's own parameter, not the distance along it. A kernel does everything for each vertex: the path's frame at the row's z (`pathFrame`, which is the tunnel's centre line written once in WGSL and once in TypeScript), the ring, and then the relief: plates, nine pipe runs, a rib every 1.6 m, the flat deck, and the swell of a hall every 96 m. It writes `tint` as four numbers for the material: what the wall is here, a plate's own random, the angle round, the distance along. The seam is two columns in one place under the deck, with an unwrapped claim.

**With the family** (corrected by the worked check, section 11.2; the first draft of this section took the tunnel for a closed loop with its centre line typed into a Curve, and both were wrong):

```
kernel (the centre line by its formula: a control point every 1.2 m of z) ─▶ topology (Strips)
  ─▶ curve (Catmull-Rom, 8 segments: a point a row) ─▶ resample (Count 768, Even Parameter: the window)
  ─▶ kernel (the hall's radius; z, for the relief) ─▶ curveFrames (Fixed Up, Roll −90)
  ─▶ sweep (Ring, 255 sides, radius mapped) ─▶ kernel (the relief, the deck) ─▶ geometry (Surface)
```

Or with no spline at all, since the centre line is a formula a kernel can evaluate where the rows are:

```
kernel (the window's 768 points on the centre line) ─▶ topology (Strips) ─▶ curveFrames (Fixed Up, Roll −90)
  ─▶ sweep ─▶ kernel (the relief, the deck) ─▶ geometry (Surface)
```

- **The tunnel is not a loop.** Its centre line is `(X(z), Y(z), z)`: endless, and periodic in z every 960 m. The travel wraps there, 960 m back down z, where the tunnel is the same. One period is 1,058.26 m of curve, because the line wanders.
- **The kernel after the sweep keeps the relief and loses the frame.** It reads `p.uv` (the way round), `p.normal` (which way is out) and whatever the path carried, and may write `position` any way it likes: the deck is a clamp to a level plane, not a move along the normal, and the surface is lit by the normal of the shape it ends up with (tested: section 7).
- **The centre line cannot be typed into the Curve.** The table holds 64 control points; over a period and a window's length they would be 17 m apart, and the spline decimetres off the line. The control points are wired, from a kernel that evaluates the formula. A camera cannot ride a wired Curve on the CPU (T1590b reads the table), so the camera keeps its own expression of the same formula for now: follow-up C12.
- **How close the spline has to be.** A ring of radius R turns an error in the curve's direction into R times as much at the wall. Control points every 2.4, 1.2 and 0.6 m of z leave the wall 11.2, 2.3 and 0.4 mm from the bore's (section 11.2). The second chain above has no spline and is within 0.11 mm.
- **The wall stands still while the window slides, and the rows a period on are the same rows.** Take the rows at the curve's own points: Resample by Count, Even Parameter, with a Range from point `i` to point `i + 767` and `i = floor(travel ÷ row)`. Eight segments on a control point every 1.2 m put a point every 0.15 m of z to within a millimetre, as the bore's rows are, and a period is then 6,400 rows because the control points say so (measured: rows within 0.14 mm of themselves a period on).
- **Resample by Distance does not do that by itself.** Its rows start at the Range's start, a row of Distance apart along the curve. A period is 7,055.05 rows of 0.15 m, so a Range stepped in rows of 0.15 m lands 7.4 mm off a period later. A Distance of the period ÷ 7,055 makes them agree. And its rows are even along the curve, not in z: between 0.113 and 0.150 m of z apart here.
- **What the relief counts by.** The bore keys its bays and its lamps on z: a bay every 1.6 m and 600 to a period, a lamp station every 12.8 m and 75 to a period. A ring carries its path point's attributes, so the kernel on the path writes z as an attribute and the relief reads it, exactly as today. `uv`'s Metres is distance along the curve, of which a period is 1,058.26 m: those hashes do not divide it.
- **The repeated part must repeat one control point further than it is used.** The last span of an open spline is shaped by its end, so the copy differs there (1.3 mm at this spacing). And its x and y should come from the point's index within its period, so they are the first part's to the bit; only z is 960 m on.
- **The seam.** A Ring of 255 sides on a wrapped claim, so the normal is smooth across it. The bore today is 256 columns with the seam's two in one place and an unwrapped claim, which leaves a crease under the deck; a Custom outline of those 256 points reproduces that exactly, if it is ever wanted.
- **Cost.** The draw is the same 196,608 vertices as today. The family adds the frames for a 768-point strip (about 0.6 ms, where `pathFrame` is a closed form and free), the resample and the sweep pass (under 0.1 ms: section 5.2).
- **It needs slice 1 only**, with the deck as a second Geometry (the consumer's review confirmed one strip for the bore).

### 6.2 Cables

```
kernel (pegs: two points a cable) ─▶ topology (Strips) ─▶ curve (Arc, Length In: Chords 1.1)
  ─▶ curveFrames ─▶ sweep (Ring, 6 sides, radius 0.015) ─▶ geometry (Surface)
```

- The Arc keeps each cable's slack as its ends move, and a Resample is not needed: the Arc's stations are even already.
- 200 cables of 33 points and 6 sides are 39,600 vertices: one Geometry, about 0.7 ms with a point shadow by the measurement at 35,200. As 200 Geometries they would be 62 ms.
- **It needs slice 2.** A cable that sags under a load is the rope row's (T1585b); the sweep takes its strips the same way.

### 6.3 A tentacle's skin

```
kernel (two sections a tentacle: a length, a bend, the socket's frame) ─▶ topology (Strips) ─▶ curve (Arc Chain)
  ─▶ resample (Distance 0.06, anchored at End) ─▶ curveFrames (Seed: Orient Attribute)
  ─▶ sweep (Ring, 16 sides, radius mapped, Caps: End) ─▶ geometry (Surface)
```

- This is the curve design's step 2 for sentinel-bot with a skin on it. The rings and claws stay instances along the same strips, by the same `orient`, so the skin and the rings agree in twist.
- The radius tapers by an attribute on the sections: the Arc Chain blends a float toward the next section's.
- Slack stowed at the socket is padding: `live` is 0 there and the rings of the sweep coincide.
- Forty tentacles of 55 rings and 16 sides are 35,200 vertices: the measured case. One Geometry at 0.67 ms, not forty at 12.65.
- It needed slice 2, and slice 3 for the cap. Both are built.

### 6.4 What falls out

- **A lathe** is a sweep along a Circle with a Custom profile. Notch has Revolve Spline for it.
- **A ribbon** is Strip along any strip: a trail, a banner, a road.
- **A pipe run on the tunnel's wall** is a sweep of its own along an offset of the centre line, instead of relief.

## 7. Tests

As built for slices 1 and 3. On Dawn through the compiler and the backend; exact where the fixture's numbers are, the CPU reference or a derived bound otherwise (§V147); seventeen mutations of the pass, the reference and the node were each seen red and restored by edit.

**The vertices** (`point-sweep.gpu.test.ts`, 29 tests, read back)

- A Square along three points with the identity frame: the eight columns of each ring at exactly `(±r, ±r, z)`, corners doubled, each side its own exact normal, the way round in quarters.
- A frame of halves `(½, ½, ½, ½)` turns the axes into each other: the corner `(r, r, 0)` lands on `(0, r, r)` exactly.
- **A Ring along a straight path is the Tube generator's points to the bit**, through a measured frame (Curve Frames measures a +Z line as the identity), and the cylinder in closed form.
- A planar arc: every ring square to the measured tangent, a radius out, its normal out of the plane; the tangent at inner points is the circle's own.
- The reference on a path that leaves its plane: ten cases across every profile, smooth and flat, both facings, every cap, every coordinate along, open and closed, a mapped radius.
- Radius mapped: each ring at its own radius; cut the map and all take the node's.
- The coordinate along: Metres is `0.25 × row` at half a metre and a tile of two; Stretch does not change with the path's length; Points reads nothing from the path; a closed path holds a whole number of tiles.
- Carried attributes: a colour, a u32 and Curve Frames' own `distance`, at every vertex of the ring.
- Padding: a path that repeats its end repeats its last ring, and an End cap sits on it.
- Caps: the two rows an end, their normals, one end only, the coordinate along carried on a radius past the edge, a cap's radius its own end's on a taper.
- Facing: Inward is the columns reversed, the normals turned and the way round still rising; an inward Ring starts on the same point.

**The pictures** (`point-sweep-render.gpu.test.ts`, 8 tests, pixels through the Render)

- **A Ring along a straight path draws the Tube's picture to the byte**: lit, the Normal and Depth outputs, with a shadow cast and received.
- **A kernel after the sweep that writes `position`**: a tube clamped to a level plane (the consumer's deck, a move that is not along the normal) reads that plane's normal, `(0, −1, 0)`, on every pixel of the flattened part. Without the kernel the same pixels read the round tube's normals. This is the test of decision D1.
- A Square's face reads its own normal across its whole width; the same four corners as a smooth outline shade round; with Smooth off they are the Square again, byte for byte.
- Facing: a Strip reads +Y outward and −Y inward in the Normal output, and the two are lit alike.
- A cap covers exactly the outline's pixels at the end's depth, each with the end's normal; without it nothing is at that depth.

**The node** (`point-sweep.test.ts`, 26 tests) and **the reference** (`src/points/sweep.test.ts`, 20 tests, numbers worked out by hand)

- The claim strings and the column and row counts for every profile, Smooth and Caps; the pass's bindings; exactly the uniforms its shader declares, in every shape of the program; every refusal sentence of 4.7; which parameters apply.

**The worked check** (`point-sweep-bore.gpu.test.ts`, 4 tests): section 11.2.

**Slice 2, as built** (section 11.3 has the counts)

- `point-sweep-sheets.gpu.test.ts`, on Dawn: N straight strips with a Ring are N Tube generators, their vertices to the bit and their lit, Normal and Depth pictures byte for byte with a shadow cast and received; a sweep of N strips is N sweeps of one, word for word and byte for byte, caps and padding included; the pixels between two parallel tubes are the background's in every output; taking one strip away changes that strip's pixels and no others; closed strips (two tori, wrapped both ways); a Tint mapped to a path attribute colours each sheet by its own strip; glass; bent strips against the CPU reference; `ctx.dim` a sheet at a time and the deck clamp on two sheets; a grid of sheets from a Topology node, in the Render and in Render Surface; a grid of sheets as the path.
- `scene-preview.gpu.test.ts`: the preview tile draws two sheets as it draws each alone, and nothing joins them.
- `grid-sheets.test.ts`: the one-sheet programs of the Render, the tile and Render Surface, pinned by their text as recorded before the variant existed; every draw of a sheeted grid is `sheets × cells × 6` vertices in the passes a one-sheet grid has; the device passes.
- `point-sweep.test.ts`: the one-strip sweep programs pinned the same way; the claims, uniforms and refusals for several strips.
- `topology.test.ts`, `point-topology.test.ts`, `codegen.test.ts`: the third number round-trips and a claim without it formats as before; the Sheets parameter; `ctx.dim.sheet` and `sheets`, and a kernel that names neither keeps its text.
- Every shipped grid keeps its picture by construction (its program is the text it was), which the pins hold; no shipped example was re-rendered for this slice.
- A material reading `uv` on a sweep is slice 2b: `grid-uv.gpu.test.ts` and `grid-uv.test.ts` (11.4).

## 8. Build plan

### 8.1 Slices

| | Slice | Contents | What it unblocks | Touches the Render |
|---|---|---|---|---|
| 1 | Sweep, one strip | the node; Ring, Square, Strip; `sides`, `smooth`, `radius` and its map, `facing`; the carried attributes; `normal` and `uv` published; a plain `grid:` claim; `src/points/sweep.ts` | the tunnel's bore | no |
| 2 | Sheets | `grid:CxRxS` in the claim, a sheeted variant of the grid chunks, the draw's size, the Topology node, `ctx.dim`; several strips | cables; the tentacle's skin; pipes; any set of tubes as one Geometry | yes |
| 2b | A grid's texture coordinate | the grid reads a `uv` attribute (D2); the wrapped-axis coordinate (B255) | a texture that keeps its size along a swept tube | yes, and shipped Tube and Torus grids |
| 3 | Caps and the custom profile | the cap rows; the Profile input | closed ends; rails, gutters, any outline | no |

- **Slices 1, 2, 2b and 3 are built** (2026-10-06). 2b is three commits: B255 (`3a9ea829`), the `uv` read (`fcf60408`) and Map Extend (`bd58f7f8`); section 11.4.
- The consumer's review asked for slice 2 sooner than this plan assumed: pipes a claw can take hold of are several tubes in one Geometry.
- Slice 2 is the one that edited `scene-render.wgsl.ts`, `scene.ts`, `compile.ts` and `render-surface.ts` (11.3).
- T1589b (lights from a pointset) is ruled to be built with this row. The two share a consumer and no code: a lamp on every rib is that row's, the rib is this one's.

### 8.2 Accepted limitations, as follow-up rows

| | Row | Why it is not in v1 |
|---|---|---|
| C1 | A mitre at sharp corners: the ring widened in the bend's plane so the tube keeps its radius through a corner; and pushing vertices apart where the tube is tighter than its radius (Notch's Minimise Self-Intersections) | needs the turn at each point, which is the neighbours' business; Resample by Curvature puts points in the bends meanwhile |
| C2 | A profile scaled in X and Y separately per point (Notch's XY mode), and a thick strip | a vec2 map; no consumer yet |
| C3 | Caps of outlines that are not star-shaped, and planar cap UVs | real triangles: a mesh claim for the caps alone |
| C4 | A profile that changes along the path (TouchDesigner's Cycle Type; a morph between two profiles) | a profile per row; the column counts must agree |
| C5 | ~~A ribbon lit on both sides~~ | not needed: a grid Surface is already lit on both sides (section 11.1) |
| C6 | Fewer sides and rings at a distance | the same absence as for every Surface |
| C7 | A sweep as the shape of mesh instances | the mesh-instancing design's F10 |
| C8 | The unskinned form: the profile placed at each point and not joined (TouchDesigner's Skin: Off) | it is instancing a strip, which needs a line draw |
| C9 | Motion vectors for a sweep | T1371b is not built for any geometry |
| C10 | Resample: a Range that wraps on a closed strip, so a window can ride round a loop | a change to the curve row's Resample, not to the sweep. The tunnel turned out not to need it: it is periodic, not a loop (6.1) |
| C11 | The way round a Custom outline by its sides' lengths, not their count | a walk over the outline for every vertex, or the outline's own `curveU`; uneven outlines stretch a texture meanwhile |
| C12 | A typed centre line longer than 64 control points, or a CPU reader of a formula path | the tunnel's line needs about 900; today the camera and the wall each evaluate the formula (T1590b) |
| C13 | ~~The tangent at a strip's two ends~~ | **built 2026-10-06** (`f917677e`): Curve Frames' Extrapolate Ends, on by default. The bore's first ring went from 2.7 mm to 0.014 mm and its last from 0.7 mm to 0.040 mm, with every ring between them unchanged to the bit (11.2; `docs/curve-family-design-2026-10-05.md`, 3.4) |
| C14 | A port that can say "one strip with a frame" | the catalogue's minimal graph names the Sweep to feed it one (`test-support.ts`): a port's `requires` is matched against what the producer's port declares, and Curve Frames declares no `orient` |

### 8.3 Decisions, as ruled

All ruled as recommended on 2026-10-05. D9 is its own bug row, B255, and its own commit: it moves textures on shipped Tube and Torus grids.

- **D1. The representation.** Recommended: a grid claim with sheets (3.2). Alternatives: a mesh claim (no Render change, any triangles, but a kernel after it cannot be lit); a sweep in the vertex stage.
- **D2. A closed axis and its texture coordinate.** Recommended: the wrapped claim that exists, and a `uv` attribute that the grid continues past the seam by `⌈u_last − u₀⌉` (3.3). Alternative: a repeated seam column and a second kind of closure in the claim, which is the textbook form and can crack under a careless kernel.
- **D3. Order.** Recommended: slice 1 now, slice 2 when `scene.ts` is free, and no mesh-claim form in between for several strips. Alternative: a mesh claim as an interim for cables and the skin, built and then retired.
- **D4. Normals.** Recommended: the grid's own rule is the only lit normal, hard edges are doubled columns, and the sweep's `normal` attribute is for kernels. Alternative: the grid path honours a `normal` attribute, which gives exact normals on a tapering tube and breaks the tunnel's relief.
- **D5. Twist.** Recommended: none on the Sweep; Curve Frames owns the frame.
- **D6. The mapped radius multiplies** the authored one (Geometry's rule for Scale). Alternative: it replaces it (the Curve's rule for Arc Length).
- **D7. What is carried.** Recommended: every attribute of the path point but the frame's. Alternative: a list the author writes, which saves memory on a tube of many sides.
- **D8. Names.** Type `pointSweep`, title Sweep, kind `sweep`; ports `points` (Path) and `profile`; the parameter keys of 4.2; the attributes `normal` and `uv`; the claim `grid:{cols}x{rows}x{sheets}`.
- **D9. The grid coordinate on a wrapped axis** becomes `gx ÷ cells` (3.3). It corrects a texture that goes round a Tube 1/(cols − 1) too far, and moves it on shipped documents by that much. Recommended: yes, in slice 2, with the examples that show it listed first. Alternative: leave it; a sweep carries its own `uv`.
- **D10. Square** as its own profile, beside a Ring of four with Smooth off. Recommended: yes; it is the one a person looks for, and its flats are up where a Ring of four stands on a corner.

## 9. Found on the way (not fixed, not in scope)

- ~~On a wrapped grid the texture coordinate ends at `cols ÷ (cols − 1)`, not at 1.~~ B255, fixed in `3a9ea829` (11.4).
- **A map held at its edge is addressed `uv × (size − 1)`, truncated** (`mapLoad`, the T262 bridge's precedent). A coordinate of exactly 1 reads the last texel and nothing else does: across 0 to 1 the map's first `size − 1` texels are spread over the surface and its last column and row are one texel short of showing. Not changed: it would move every mapped picture by up to a texel. Map Extend's Repeat and Mirror address `floor(fold × size)`, all `size` texels a tile, so the oddity is Hold's alone. Row text for a follow-up, not a fix here.
- **Under multisampling a fragment's texture coordinate leaves the surface's own range at every open edge** (found by slice 2b's first attempt at tiling, on E75). A partly covered pixel is shaded once, at its centre, which lies outside the triangle. A map's clamp absorbs it. Anything that gives a coordinate outside 0..1 a meaning of its own has to be asked for, which is why Map Extend is a parameter.
- The bore's seam is two columns in one place with an unwrapped claim, so each takes a one-sided difference and the normal has a crease there. It is under the deck and does not show.
- A grid Surface is lit on BOTH sides (`abs(N · L)`, T301's rule) and a mesh Surface on one, with its normal turned to face the viewer (B227). Nothing says so where a person chooses between them. The first draft of this document had the grid lit on one side; section 11.1.
- The fragment stage stands +Z in for a normal shorter than 1e-6, and tests the length before normalising. A grid's normal is the cross product of two differences, each across two cells, so a grid whose cells are finer than about half a millimetre each way reads +Z everywhere. Read from `scene-render.wgsl.ts`, not tested. A cable a millimetre thick would meet it.
- A frame measured from points far from the origin carries their rounding as an angle. At 1,000 m a float holds 0.06 mm; across a 0.15 m chord that is 0.0004 rad, and a 5 m ring makes it up to 2 mm at the wall (measured between the tunnel's first part and its repeat: 0.8 mm). The bore's kernel has a closed form for its tangent and does not have this.
- The Topology node's Columns and Rows stopped at 4,096 each. Fixed in T1586b's slice 6.
- Resample's Range cannot cross the seam of a closed strip (C10).
- **A swap between two Geometries' draws ends the run (found in slice 2, T1604b's ground).** A pointset's buffer swap is placed after its last reader. In the last target a Render draws, that reader is the Geometry's own draw, so with N Geometries the plan reads draw, swap, draw, swap: N device passes where the rule expects one. Ten swept Geometries under one casting point light are 11 device render passes, the shadow cube one run of 61 draws and the lit target ten runs of one; with the Normal and Depth outputs on it is the Normal layer, drawn last, that is cut into ten (14 passes). Moving the swaps after the node's last draw would make them 2 and 5. Not changed here.
- A strip all of whose points are one point (a stowed strand, `live` 0) has rings of no length, so its tube draws nothing, but with Caps on its two caps are still two discs of the radius at that point. Read from the pass, not tested. A consumer that stows strands maps the radius to 0 there, or leaves Caps off.

## 10. Sources

Repository: `docs/curve-family-design-2026-10-05.md`, `docs/mesh-instancing-design-2026-10-05.md`, `docs/geometry-cost-profile-2026-10-05.md`, `docs/td-notch-mechanisms-2026-10-05.md`; `src/nodes/shaders/scene-render.wgsl.ts`, `src/nodes/definitions/scene.ts`, `src/points/topology.ts`, `src/projects/sentinel-bot/tunnel.ts`.

TouchDesigner (Derivative), fetched 2026-10-05:

- Sweep SOP: https://docs.derivative.ca/Sweep_SOP
- Extrude POP: https://docs.derivative.ca/Extrude_POP
- Line Resample POP: https://docs.derivative.ca/Line_Resample_POP
- The POP list and the Line Thick POP's removal are as read by the reference survey (its section on lines).

Notch, fetched 2026-10-05 (page updated 16 Sep 2026):

- Spline Extruder: https://manual.notch.one/2026.2/en/docs/reference/nodes/3d/spline-extruder/

## 11. What building it showed (2026-10-06)

### 11.1 Where the design was wrong, and what it is now

| The design said | What is true | Where it is corrected |
|---|---|---|
| A grid Surface is lit on one side, so Facing decides whether a tunnel is lit from inside | A grid Surface's lambert is `abs(N · L)`: lit on both sides. Facing decides the `normal` attribute, the Render's Normal output and what a material's normal starts from | 2.1, 4.2, 7, 8.2 (C5), 9 |
| A test would show "Outward from inside is dark" | It cannot be dark. The test that pins the normal's side reads the Normal output: +Y outward, −Y inward, and the two lit alike | 7 |
| A `color` attribute on the path tints the tube | It reaches every vertex, and tints when the Geometry's Tint is mapped to it. A grid has no default tint attribute; a mesh has | 2.1, 4.3 |
| Inward reverses the columns | It walks the same outline the other way from its first point, and the way round still rises with the column | 4.4 |
| The tunnel is a loop, so a window that rides it has to cross a seam (C10) | It is endless and periodic in z. C10 is still a gap in Resample, and not this consumer's | 6.1 |
| The tunnel's centre line is typed into a Curve, and the camera rides the same node | The table holds 64 points and the line needs about 900. The control points are wired from the formula | 6.1, C12 |
| Resample by Distance, its Range stepped in rows, keeps the wall still | Only if the period is a whole number of rows. Rows at the curve's own points are, by construction | 6.1 |
| The sweep pass costs "under 0.1 ms, 0.2 to 0.4 ms for a million" (derived) | Measured: 0.02 to 0.06 ms and 0.22 to 0.46 ms, by what the path carries | 5.2 |
| The sheeted grid changes the grid chunks for every grid (first draft of 3.3) | It is a variant only a claim of more than one sheet emits, so a one-sheet grid's program is the text it was | 3.3, 11.3 |
| After T1604b, N Geometries into one single-sampled target are one device pass (3.5) | Not in the last target a Render draws: a swap stands between two Geometries' draws there. Ten Geometries are 11 device passes, one of ten sheets is 2 | 3.5, 9, 11.3 |
| A grid reads the sweep's `uv` in slice 2 | Moved to slice 2b with B255: both change one expression and move textures on the same shipped grids | 3.3, 8.1 |
| Past a wrapped seam the coordinate is `u₀ + ⌈u_last − u₀⌉` (D2) | Carried by whole turns in the direction it goes, `sign(d) × ⌈|d|⌉`: the same for a rising coordinate, and right for a falling one | 3.3, 11.4 |
| A grid that carries a `uv` reads it | Only where a coordinate is read (a map, or a Material · WGSL naming `.uv`): elsewhere it would be a binding and a read for nothing | 3.3, 11.4 |
| "Tiling is the material's UV scale" (4.6) | A material has no UV scale. Tiling is its Map Extend, an axis at a time | 4.6, 11.4 |
| A stock map can repeat whatever leaves 0..1 and keep its old read inside (first build of 2b's third commit) | It moved E75: under MSAA an open edge's coordinate leaves 0..1. Tiling is a parameter of the sampling | 9, 11.4 |

### 11.2 The worked check: the consumer's bore from the stock nodes

`src/nodes/definitions/point-sweep-bore.gpu.test.ts` builds the sentinel tunnel's bore from the stock nodes and holds it against the project's kernel-bent grid, with the relief off and the deck out of the way. That grid is FROZEN in `point-sweep-bore.fixture.ts` (`c52c636a`) as it stood at `src/projects/sentinel-bot/tunnel.ts` 14b66ed2 and `path.ts` 1bc118e6 (2026-10-05): the test imports nothing from the project, so it is a fact about a fixed input and a later change to the project's bore neither reddens it nor is covered by it. Dawn on Metal. Every figure has a bound in the test derived from what explains it.

**On the bore's own rows.** The path's 768 points come from the project's formula at the bore's rows; Curve Frames (Fixed Up) and a Sweep lay the wall. Against the project's kernel, vertex for vertex, all 196,608:

| | Worst difference | What explains it |
|---|---|---|
| The 766 inner rings | 0.11 mm | rounding: the frame's tangent is measured from points a float holds to 0.004 mm, across a 0.15 m chord, and a hall's 5 m radius multiplies the angle |
| The first ring | 0.014 mm | aimed by its two nearest segments (Curve Frames' Extrapolate Ends, C13). On its one chord, with the switch off: 2.7 mm, off the end's own tangent by half the turn across the chord |
| The last ring | 0.040 mm | the same. On its one chord: 0.7 mm |

A Custom outline of the bore's 256 columns (the seam's two in one place) and a Ring of 255 with the frame rolled a quarter turn give the same figures.

**Through a Curve and a Resample.** Control points on the formula, a Catmull-Rom of 8 segments, rows at the curve's own points, a kernel for the hall's radius, Curve Frames, Sweep. Each vertex against the bore's own vertex at that row's z and that column's angle, and against the bore's wall:

| Control points every | Centre line off by | Vertex off by | Off the wall by |
|---|---|---|---|
| 2.4 m | 0.82 mm | 11.2 mm | 4.6 mm |
| 1.2 m (the test's) | 0.12 mm | 2.3 mm | 0.9 mm |
| 0.6 m | 0.07 mm | 0.4 mm | 0.15 mm |

- What explains it is the spline's DIRECTION, not its position. A Catmull-Rom's tangent at a control point is the chord across two spans, off the curve's own by `h² f‴ ÷ 6` (0.9 mrad at 1.2 m here; measured 0.45), and a ring of radius R turns an angle into R times as much. Halving the spacing quarters it.
- A vertex is further from the bore's vertex than from the bore's wall: a turned ring slides its rim along the wall, and leaves it only where the wall flares into a hall.
- The first and the third row are measured with the same chain at another spacing, outside the test.

**The repeated part.** One period is 960 m of z and 1,058.257 m of curve.

| | Rows a period on, against the first part's | The wall |
|---|---|---|
| Rows at the curve's own points | 0.14 mm | 1.1 mm, at an end ring: an aimed end counts the rounding twice (0.8 mm before C13) |
| Rows by Distance, the Range started a period on | 0.23 mm | 0.9 mm |
| Rows by Distance, the Range stepped in rows of 0.15 m | 7.4 mm off: a period is 7,055.05 rows | not built |

- The first two are what a float holds near 1,000 m (0.06 to 0.12 mm), seen through the frame for the wall.
- So the answer to "does Resample by Distance give the repeated part the same rows": yes when its Range starts a period further on, to a quarter of a millimetre; no when the Range is stepped in rows from a fixed start, unless Distance divides the period.

### 11.3 Slice 2 as built: several strips, a sheet each (2026-10-06)

**The claim.** `grid:{cols}x{rows}x{sheets}`, the wrap flags after it. `cols`, `rows`, both wraps and the caps are ONE sheet's; slot = `(sheet × rows + row) × cols + col`; one sheet is written without the third number, so every claim that shipped is the string it was. A Sweep over a path of four strips of five points with a Ring of twelve claims `grid:12x5x4:wrapU`, and `grid:12x9x4:wrapU` with both caps.

**One emitter, two programs.** Each generator takes a `sheets` flag and has one branch for it; a claim of one sheet goes through the same function and gets the text it always had.

- `src/points/topology.ts`: `gridSheets`; `gridPointCount` counts every sheet; `gridCellCounts` is one sheet's; **`gridVertexCount` is the one size of a grid draw** (`cells × 6 × sheets`), read by the Render's lit, G-buffer, depth and glass draws, the preview tile and Render Surface; `stripsOf` gives a grid `rows × sheets` strips; `kernelDimOf` is what `ctx.dim` reads.
- The Sweep (`point-sweep.ts`, `sweep.wgsl.ts`): N strips make N sheets. A thread's sheet is `slot ÷ (cols × rows)`, its row the remainder, and its path point is its own strip's (`point + sheet × pathPoints`). So caps are per sheet and padding is per strip with no code of their own. The variant has one more uniform, `sheets`.
- The Render (`scene-render.wgsl.ts`): the two grid chunks, `surfaceMeshWgsl` (the lit draw, the G-buffer layers, glass, Material · WGSL) and `shadowSurfaceWgsl` (a directional shadow, the six faces of a point light, the Depth output). The variant declares a module-scope private `gridSheet`, sets it at the top of the vertex stage (`quad ÷ a sheet's cells`, the cell being the remainder), and `gridPosition` and the Tint read add `gridSheet × rows` to the row. `gridPosition` keeps its two arguments, so the five calls that make a vertex and its normal are the lines they were, and a normal's neighbours are clamped or wrapped inside the sheet.
- `scene.ts`, the preview tile in `compile.ts` and `render-surface.ts` pass the flag when the claim has more than one sheet and take the vertex count from `gridVertexCount`. Nothing else in the Render changed: no pass is added or moved, the bindings are the same, and a caster list names a sheeted Geometry as it names any other.
- The Topology node has a **Sheets** parameter (Grid only). A kernel's `ctx.dim` gains `sheet` and `sheets`; `cols`, `rows`, `i` and `j` are one sheet's. The two members exist where the edge has more than one sheet or the kernel names them.

**The draw.** One vertex-pulled draw in every pass that draws the Geometry, `sheets × cells × 6` vertices, no index buffer, no join triangles. The instanced alternative was not built (ruled).

**Does the variant round as the one-sheet program does?** In every case tested, yes: no bit and no byte moved.

- Three coaxial strips with radii 0.25, 0.5 and 0.75 against three Tube generators: 240 vertices equal to the bit; lit, Normal and Depth equal byte for byte, with a directional shadow cast on a floor and received.
- Three parallel strips 1.2 m apart (a number a float does not hold) against three sweeps of one strip: position, normal and uv equal word for word, both caps included; the three outputs byte for byte.
- Two closed strips (tori, wrapped both ways) against two sweeps of one: the same, with shadows; and in Render Surface.
- The one-sheet programs are pinned by fingerprints recorded from main before the variant existed: nine of the Render, the tile and Render Surface, eight of the Sweep.

**Measured: the consumer's shape.** Ten strips of 54 points, 12 sides: 6,480 vertices, 38,160 drawn in each pass. Apple M3 Max, Dawn on Metal, headless, 512 × 512; best of 9 runs of 200 frames, the two graphs alternated three times; wall time of a frame in ms. The chain is kernel, Topology, Curve Frames, Sweep, Geometry.

| | 1 Geometry of 10 sheets | 10 Geometries, a chain each | Difference |
|---|---|---|---|
| One casting point light | 0.291 | 1.849 | 1.557 |
| Two casting point lights, Normal and Depth outputs on | 0.422 | 2.342 | 1.920 |
| One casting point light, MSAA 4x | 0.344 | 1.972 | 1.628 |

The draw side alone, the same tubes written by one kernel pass a pointset (no Curve Frames, no Sweep):

| | 1 Geometry of 10 sheets | 10 Geometries | Difference |
|---|---|---|---|
| One casting point light | 0.203 | 0.816 | 0.613 |
| Two casting point lights, Normal and Depth outputs on | 0.341 | 1.243 | 0.903 |
| One casting point light, MSAA 4x | 0.262 | 0.867 | 0.605 |

What each frame is made of. Both draw the same vertices: 267,132 with one light, 572,430 with two and the outputs.

| | Plan passes | Dispatches | The Render's draws | Device render passes |
|---|---|---|---|---|
| 1 Geometry of 10 sheets, one point light | 20 | 5 | 9 | 2 |
| 10 Geometries, one point light | 173 | 50 | 72 | 11 |
| 1 Geometry of 10 sheets, two lights and the outputs | 31 | 5 | 20 | 5 |
| 10 Geometries, two lights and the outputs | 256 | 50 | 155 | 14 |
| 1 Geometry of 10 sheets, MSAA 4x | 20 | 5 | 9 | 3 |
| 10 Geometries, MSAA 4x | 173 | 50 | 72 | 12 |

- **The sweep pass** for the ten strips is 0.016 ms (the chain without it 0.225, with it 0.240); for one strip of 648 vertices it is 0.019. Both are the cost of a pass, at the edge of what the measurement resolves.
- **One more Geometry is 0.07 ms** with one casting point light (seven draws, a device pass, and its pointset's one kernel pass and swap), and 0.10 ms with fifteen draws. Section 2.3's 0.31 ms was measured before T1604b, in another document and as device time, so the two are not one measurement.
- **One more strand as its own chain is another 0.10 ms**: a Curve Frames and a Sweep of its own. Sheets save both: 1.56 ms a frame for ten strands with one light, 1.92 ms in the consumer's shape of lights and outputs.
- **The device passes.** A sheeted Geometry adds none: 2, 5 and 3 are what one grid Geometry has. Ten Geometries have nine more in each case, all in the last target the Render draws, each ended by a pointset's swap (section 9). The shadow cube is one run of 61 draws, as T1604b means it to be. On the multisampled target the rule already keeps a pass per draw, and the nine are the same nine.

**Tests, with counts.**

| File | Tests | What |
|---|---|---|
| `point-sweep-sheets.gpu.test.ts` (new, Dawn) | 21 | the acceptance above; a casting point light; background between sheets; one strip taken away; caps per sheet; padding; a Tint per strand; glass; bent strips against the reference; `ctx.dim` and the deck clamp; the Topology node's sheets in the Render and in Render Surface; a grid of sheets as the path |
| `scene-preview.gpu.test.ts` (Dawn) | 1 added, 9 in the file | the preview tile |
| `grid-sheets.test.ts` (new) | 17 | nine one-sheet pins; every draw's size, pass ids and bindings; the refusal that counts every sheet; the device passes |
| `point-sweep.test.ts` | 38 in the file | eight one-strip pins; claims, uniforms, pass id and refusals for several strips |
| `topology.test.ts`, `point-topology.test.ts`, `codegen.test.ts` | 105 in the three | the claim's grammar and helpers; the Sheets parameter; `ctx.dim.sheet` and `sheets` |

Red-verified by mutation, applied and restored by edit: 24 mutants, one line each (the sheet dropped from the lit position, the depth position, the Tint read and Render Surface; the cell not folded into its sheet; a sheet's cells counted without `wrapV` in each of the three chunks; the sweep reading strip 0 for every sheet, not folding its row, writing one sheet; the variant left off the lit draw, the material options, the depth sweep, glass and the tile; `gridVertexCount`, `stripsOf` and `kernelDimOf` forgetting the sheets; `ctx.dim.j` and `.sheet`; the Topology node dropping Sheets; the kernel handed one sheet; the sweep's capacity one sheet's). Each fails at least one Dawn test. Four of them passed every Dawn test at first (a sheet's cells under `wrapV` in the lit chunk and in the depth chunk; `stripsOf`; the tile), and the tori, the grid-as-path and the tile tests were written for them. The Render Surface test of the tori was written with its own mutant.

**Not checked.**

- No shipped example was re-rendered: none claims more than one sheet, and a one-sheet grid's program is pinned to the text it was.
- The instanced alternative (one instance a sheet) was not built or measured, as ruled.
- A material does not see the sweep's `uv` until slice 2b; the grid coordinate it sees restarts in every sheet.
- SSAA, a projector, an environment and ambient occlusion on a sheeted grid. They are options of the fragment stage and share the one vertex chunk the tests draw; none was compiled or drawn with a sheeted grid. MSAA was drawn in the measurement and not asserted.
- The figures are wall time headless on one machine that other sessions share; the differences are many times the 0.05 ms between runs of one graph, the sweep pass's 0.016 ms is not.
- The caps of a strip whose points are all one point, and the fragment stage's guard for cells under half a millimetre (section 9), are read from the code, not tested.

### 11.4 Slice 2b as built: a grid's texture coordinate (2026-10-06, T1618b with B255)

Three commits: B255 (`3a9ea829`), the `uv` read (`fcf60408`), Map Extend (`bd58f7f8`).

**The list first.** Every shipped document (74 examples, 12 components, 26 project documents) was compiled through the loader and read off its plan: each Render draw's grid uniform, its bound maps, its material's source, and the pairs each Geometry is handed.

| | Documents |
|---|---|
| A wrapped grid Surface that reads the coordinate (B255 moves the picture) | E20 Gooeyball: 64 × 64 wrapped round, albedo and roughness maps. The only one |
| Wrapped grid Surfaces that do not read it (text moves, picture does not) | E13 Prism, E33 Obol, E63 Skin, sentinel-bot's towers and pods |
| Open grid Surfaces that wear a stock map (text moves, value does not) | E25 Stage, E34 Lidar, E75 Resonance, E76 Verdant Lotus, on-nothing's sleep-like-a-baby and sleep-like-a-baby-2 |
| A grid pointset carrying `uv` into a Surface | sentinel-bot's towers and pods only (from a Sweep). Their Material · WGSL does not name `s.uv` and they bind no map |

- Two things first said about this list were wrong and are corrected here: "the only mapped Surface in the corpus is E20" (it is the only WRAPPED one; six documents wear a stock map on an open grid), and "nothing shipped reads a map outside 0..1" (E75 does, at its open edges under MSAA).
- Checked by rendering, raw bytes at frames 0 and 60, before and after each commit. B255: E20 moves, 5,842 of 36,864 pixels at frame 0 (5,507 at frame 60), largest step 0.031 linear (0.037), mean 0.005; E13, E25, E28, E33, E34, E63, E75, E76, E79, both on-nothing documents and sentinel-bot are byte-identical. The `uv` read: E13, E20, E25, E28, E33, E63, E79 and sentinel-bot rendered, byte-identical (the mapped open grids carry no `uv`, so they cannot take the variant; not rendered for this commit). Map Extend: E20, E25, E34, E75, E76 and both on-nothing documents rendered, byte-identical.
- E20 has no exact pixel claim to re-derive. Its thumbnail was regenerated and its look baseline re-measured (motion 0.01149 to 0.0116, range and f0max unchanged). Its albedo now sits on the bulge the same noise raised: the kernel displaces by `u = i ÷ cols` and the map is read there too.

**B255.** One line of the lit grid chunk: an axis divides by its cells (`select(points − 1, points, wrapped)`). The wrap flags are uniforms, so there is one text and the line is in every lit grid program.

**The `uv` read.** `GRID_UV_WGSL` in `scene-render.wgsl.ts`, a variant of the lit grid chunk; `SURFACE_UV_REFERENCE` in `scene.ts` decides whether a Material · WGSL reads it; the attribute is bound at a mesh's `uv` slot (a draw is a grid or a mesh). The seam rule is in 3.3. On a grid of several sheets a vertex reads its own sheet's rows.

**Map Extend, and what the two references offer.**

| | TouchDesigner | Notch | Here |
|---|---|---|---|
| Where it is said | on each map of a MAT, in its Texture Sampling Parameters | on the material: "Controls how textures used by the material are wrapped" | on the material |
| An axis at a time | Extend U, Extend V, Extend W | Texture Wrap Mode U, Texture Wrap Mode V | Map Extend U, Map Extend V |
| The choices | Hold, Zero, Repeat, Mirror | Repeat, Clamp, Border With Black, Mirror | Hold, Repeat, Mirror |
| Beside it | Filter, Anisotropic Filter, which texture coordinate layer, per map | UV Scale and UV Offset, per material, and a second pair for the diffuse map | nothing yet |

Sources: https://docs.derivative.ca/Phong_MAT and https://docs.derivative.ca/PBR_MAT (each map's Extend U, V and W with the four choices; neither page names a default); https://manual.notch.one/2026.1/en/docs/reference/nodes/materials/material/ (Texture Wrap Mode U and V, quoted above, and the UV Scale and Offset rows). Read 2026-10-06.

- **One pair a material, not one a map.** The references disagree (TouchDesigner a map, Notch a material), so a pair per map is not the norm, and one a material is the simpler. A pair per map is a follow-up row.
- **An axis at a time**, which both references do and the first sketch of this parameter did not. The reason is the finding below: a ribbon tiles along its length and has open edges across, so it wants Repeat along and Hold across.
- **Mirror is in**: both have it, and it is one more fold. Zero (TouchDesigner) and Border With Black (Notch) are not: a third address rule and a colour, with no consumer.
- **One function for a stock material and a custom one.** The two folds are the shared module `extend` (`extendRepeat`, `extendMirror`, `shared-modules.ts`). The stock text pastes it; a Material · WGSL or a Custom WGSL gets the same two with `// @use extend`.
- **Not built, as rows:** a UV scale and offset on a material (both references have one; today the tile's size is the Sweep's Tile Length or the author's `uv`); Extend per map; Zero.

**Why it is a parameter: E75.** The third commit was first built as "a map repeats whatever leaves 0..1 and is read as it was inside". It moved E75 Resonance: 571 of 36,864 pixels at frame 0, largest step 0.17 linear.

| Variant of the read, E75 rendered each time | E75 |
|---|---|
| The repeat, behind a function | moved |
| The same function, clamping as before | byte-identical: it is not the recompile |
| A band of 1e-5 either side of 0..1 kept clamped | moved, the same bytes: it is not a rounding at the edge |
| Not-a-number kept on the old path | moved: it is not that either |

- E75's Render is MSAA 4x and its mapped grids have open edges in frame. A partly covered pixel is shaded once, at its centre, which lies outside the triangle: there the coordinate has left 0..1 by a real amount, on a surface whose own coordinate never does. The clamp absorbed that. A repeat puts the map's far edge there.
- So a fragment cannot tell a coordinate that tiles from an open edge, and tiling has to be said: by the material, an axis at a time, with Hold the read it always was.
- Kept as a fixture: one cell whose edge stops 0.45 of a pixel into a picture column, under 4x MSAA. Hold reads the edge's own texel on the partly covered pixel; Repeat reads texel 0 there. That is the price of a tiled axis on an open edge under MSAA, and the parameter's description says so.

**The pins, before and after.** Each new value is what its test printed (`restamp`: run, read expected and received, replace), with the reason beside it in the file.

| Gate | Pin | Before B255 | After B255 |
|---|---|---|---|
| `grid-sheets.test.ts` | a lit grid, the default material | 17aa8172c9cd86ab | 6e32ecb742e37480 |
| | a Phong tube under a casting sun, every output | 084b26c7e1c920d6 | fd223a6f35a231d2 |
| | a PBR grid under a casting point light | 3c4d939cf8e327d2 | 05abd9496c1331d9 |
| | a tinted grid | baf033f83810f42d | 4e06f58f7127b692 |
| | an unlit grid | 27985030733ae1ad | 98a49e35dd3384ce |
| | a glass grid | efbe423f4bad37c6 | 16a7d3a060b02efd |
| | a Material · WGSL on a wrapped tube | 23412397756ed469 | 6f3f36f5829aa22d |
| | the preview tile | 1889b8f93f6f1f82 | 7c55c8dc5023cecd |
| | Render Surface | d63733260d66381a | not moved: no coordinate |
| `light-points.test.ts` | E13 Prism | 359501820ee04eb2 | b0ae17f85a00fa66 |
| | E33 Obol | 3bbe8f637a87f0ca | 5a7d8127aa370b62 |
| | E28 Sundial | ead2f43368e32c56 | 9cd4c3c06215a84f |
| | E69 Burnish | 9277401191f84901 | 962a4048645d64ce |
| | E79 Crucible | e81ee4bea6dbf553 | 6bd605b4e59f4207 |
| `scene-light-guard.test.ts` | surface: lambert grid | 2717505ab16a6316 | 42e77db29fe97b61 |
| | surface: pbr Material WGSL | 5ba3e4b2fe94caa0 | dd94c30cf125247d |
| | surface: pbr grid | 326c14a7a3a7a8d8 | 3862a064f9cad6eb |
| | surface: pbr grid, additive | 6eaba590ca5564d9 | 919ec18941e4d41b |
| | surface: pbr grid, many projectors | 2c0992f1f780d0a3 | 434bfacef3d74cb1 |
| | surface: phong grid | 33ea50e380739696 | c2608dcc7fcfca2d |

- The other twelve digests of `scene-light-guard.test.ts` (mesh and instance cases) and V1029's sizes (`generated-text-growth.test.ts`) did not move, and V1029 asked for no ledger row: the `uv` variant and the two Map Extend enums are a text per feature, not a text that grows with a count.
- All of them were run again on the tree merged with main at `b585a458` (the spots landing, `25416b6d`, included): none moves.
- The `uv` read and Map Extend moved none of them. The second is held by five pins of its own, taken at `fcf60408` before the parameter existed, of the whole plan of each example that wears a stock map: E20 524da1380e9f7f65, E25 3ea3923714e496b7, E34 c73ed3113401e002, E75 b48273dc56455b40, E76 a05741c9165a6c6f (`grid-uv.test.ts`).

**Tests.** A white unlit material wears a RULER, a map whose texel (x, y) holds (x, y): each pixel then shows the texel that was read there, and the cameras are orthographic, so the expected texel is derived from where the pixel is on the surface.

| File | Tests | What |
|---|---|---|
| `grid-uv.gpu.test.ts` (new, Dawn) | 22 | B255: the four faces of a wrapped prism, the seam face, the unwrapped control, the other axis (4). The `uv` read: the points' own against the grid's and another name; the Albedo layer; a rising, a falling and a three-turn coordinate at the seam; the row seam; a Material · WGSL's `s.uv`; a Sweep by its length; a swept Ring's seam; two sheets (10). Map Extend: Repeat and Hold on a Sweep by its length; Mirror; an axis at a time and below 0; the Albedo layer; `// @use extend`; the open edge under MSAA with Hold and with Repeat (8) |
| `grid-uv.test.ts` (new) | 14 | which draws bind the `uv` and that the rest are the text they were (5); Hold is the text it was, nine texts for the nine pairs, one paste of the module, the parameter's shape (4); the five mapped example pins (5) |

Red-verified by mutation, applied and restored by edit: 4 for B255 (main's expression on each axis, and two wrong fixes), 14 for the `uv` read, 12 for Map Extend, one of them the rule that moved E75. Each fails a test.

**Not checked.**

- A mesh Surface with a stock map under Map Extend: the read is the same text, and no test draws one. No shipped mesh binds a stock map.
- Map Extend under SSAA, and Repeat on a wrapped axis under MSAA (there is no open edge there, so no far-edge hairline is expected; not drawn).
- A `uv` that does not make a whole number of turns round a wrapped axis: the seam cell then stretches whatever is left over. Stated, not tested.
- The preview tile of a Geometry draws its base colour only: it shows neither a map nor the points' `uv`.
- The references' defaults for Extend were not found on the pages read.

