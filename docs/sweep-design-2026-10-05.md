# Sweep: a profile along a curve, as a lit surface (T1587b)

**Status, 2026-10-05: a design, with decisions to rule in section 8.3. No product code.** It follows `docs/curve-family-design-2026-10-05.md` (T1586b, whose slices 1 to 4 and 6 to 8 are built) and reads `docs/mesh-instancing-design-2026-10-05.md` (T1581b) and `docs/geometry-cost-profile-2026-10-05.md`.

The row asks for a profile (ring, square, strip, custom) swept along a curve into surface geometry that the Render lights, shadows and writes to its G-buffer: radial segments, radius, per-point scale, caps, twist. Its consumers are the sentinel tunnel's bore, cables, and a tentacle's skin. The owner's standard is the curve row's: consider how TouchDesigner and Notch do it, build the general shape, no brittle or unscalable shortcuts.

Read for this: the two designs above, the reference survey (`docs/td-notch-mechanisms-2026-10-05.md`), the Render's surface generators (`src/nodes/shaders/scene-render.wgsl.ts`, `scene.ts`, read only), `src/points/topology.ts`, `src/projects/sentinel-bot/tunnel.ts`, and the TouchDesigner and Notch pages in section 10, fetched on 2026-10-05. Neither program was run. Section 2.3 is measured; a cost marked "derived" is arithmetic from measured figures.

## 0. The design on one page

- **A sweep is a pointset.** One compute pass writes a ring of points at every point of a curve, and publishes them with a grid claim: columns round the profile, rows along the curve. The Render's Surface path draws a grid today, so the sweep is lit, shadowed, G-buffered and Material · WGSL-shaded with no new draw.
- **A kernel can stand between the sweep and the Geometry.** A grid's normals are worked out from its points on every draw, so a kernel that pushes the wall in and out (the tunnel's ribs, pipes and deck) is lit correctly without knowing what a normal is. A mesh's normals are an attribute and would go stale. This decides the representation.
- **One Geometry for many tubes.** A Geometry costs about 0.3 ms of device time however small it is: seven draws with one point light casting, fifteen in the consumer's document (section 2.3: forty tubes as forty Geometries take 12.6 ms, as one 0.7 ms). So the sweep of several strips is one pointset and one draw. A grid claim holds one sheet, so the claim gains a third number: `grid:{cols}x{rows}x{sheets}`. That is a change of a few lines in each of the Render's three grid vertex chunks.
- **The sweep reads the curve family's attributes and adds none to it.** It takes `orient` from Curve Frames, so twist, roll and the closing of a loop are that node's and a sweep and the instances beside it agree. It takes `distance` and `curveU` for the texture coordinate along its length. Padding sweeps to rings of no length and triangles of no area.
- **Hard edges and caps are repeated columns and rows.** A corner that should be sharp is two columns in one place; a cap is the end ring repeated and then drawn in to its centre. The grid's normal rule then gives each face its own normal. No index list.
- **Two slices matter.** Slice 1 is the node for one strip, which draws through today's Render untouched: the tunnel's bore. Slice 2 is the sheet in the claim and the Render, which is cables and the tentacle's skin, and waits for the shadow work in `scene.ts`.

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
- **Grid** (`surfaceMeshWgsl`): the claim is `grid:{cols}x{rows}` with `wrapU`, `wrapV`. Six vertices a cell; the vertex index is the connectivity. The normal is the cross product of central differences of the positions, taken in the vertex stage on every draw. The texture coordinate is the grid coordinate. A `color` attribute tints. It binds the positions, and the colours if any.
- **Mesh** (`meshVertexWgsl`): the claim is `mesh:{triangles}@{index buffer}`. The vertex stage reads the index, then `position`, then a `normal` attribute, which is required, and `uv`, `surface`, `emissive` and `color` if present. Each is its own storage binding: seven for a full mesh. The fragment stage turns a mesh's normal to face the viewer; a grid's normal is used as it stands, so a grid is lit on one side.
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

Three changes, each small, all in the Render's grid chunks and `points/topology.ts`. They are slice 2.

**Sheets.** `grid:{cols}x{rows}x{sheets}`, with the wrap flags after it as now. A claim without the third number is one sheet, so no shipped claim changes.

- Slot = `(sheet × rows + row) × cols + col`. `rows` is the rows of ONE sheet.
- A wrap is per sheet: `wrapU` closes each sheet round its columns, `wrapV` along its rows.
- **The shader needs no new uniform.** The vertex count the plan passes is `sheets × cells × 6`. In the vertex stage the sheet is `(quad ÷ cellsU) ÷ cellsV` and the row is the remainder, where today the row is `quad ÷ cellsU` alone. The neighbours for the normal are clamped or wrapped inside the sheet, as today inside the grid.
- Readers: the three grid vertex chunks (`surfaceMeshWgsl`, `shadowSurfaceWgsl`, and Render Surface's own), the three places that size a grid draw (the Render in `scene.ts`, the preview tile in `compile.ts`, and `render-surface.ts`), `parseTopology`, `formatTopology`, `gridCellCounts`, `gridPointCount`, the Topology node (a Sheets parameter), and `stripsOf`, for which every row of every sheet is a strip.
- A kernel's `ctx.dim` gains `sheet` and `sheets` beside `i`, `j`, `cols`, `rows`.

**A grid reads a `uv` attribute when its points carry one**, as a mesh does. Without one the texture coordinate is the grid coordinate, as now.

- On a wrapped axis the corner past the seam reads the first column again, whose coordinate is back at the start. So it continues it: `u₀ + ⌈u_last − u₀⌉`. For a coordinate that goes once round that is `u₀ + 1`; for one that goes round `N` whole times it is `u₀ + N`. The sweep only ever writes coordinates with a whole period on a wrapped axis (4.6), so the rule has nothing to guess.
- The alternative is the textbook one: repeat the seam column, so the claim is not wrapped and both ends of the seam have their own coordinate, and tell the grid that the first and last columns are one place so its normal is still smooth across it. That needs a second kind of closure in the claim, and a kernel that moves the two seam columns differently opens a crack. It is decision D2.

**The grid coordinate reaches 1 on a wrapped axis.** Today `u = gx ÷ (cols − 1)`, which on a wrapped axis ends at `cols ÷ (cols − 1)`: a texture goes round a Tube or a Torus slightly more than once (section 9). It becomes `gx ÷ cells`. This moves the texture on shipped wrapped grids by up to one column's share, so it is listed as its own decision (D9) and can be left out.

### 3.4 What the claim does not need

- **No count.** A strip shorter than its slots repeats its end point (§V788), Curve Frames gives the repeats the end's frame, and so the sweep's rings there are one ring many times: cells of no area. A cap at that end sits on the last real ring.
- **No normal attribute for the draw.** The sweep publishes its own `normal` for kernels (4.3); the grid path does not read it.
- **Nothing per pass.** The claim and the points are all a depth sweep needs.

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
| `facing` ⓢ | enum | Outward | which way the surface's normal points: Inward for a tunnel seen from inside |
| `uvAlong` ⓢ | enum | Stretch | the coordinate along the path: Stretch (0 to 1 over each strip), Metres (distance ÷ `uvLength`), Points (one per ring) |
| `uvLength` | number | 1 | Metres: metres of curve to one tile |

- **Ring** is `sides` points on a circle of `radius`. **Square** is four flat sides, flats up, half-width `radius`. **Strip** is a flat ribbon along the frame's X, `2 × radius` wide, lit on its +Y side. **Custom** is the Profile input, scaled by `radius`.
- **There is no twist or roll here.** Curve Frames has Roll, Twist and Close Twist, and the sweep reads the frame they made. A sweep and the instances along the same curve therefore agree, and Notch's Radial Rotation Offset is Curve Frames' Roll.
- **The mapped radius multiplies** the authored one, as a Geometry's mapped Scale does. A Curve's table publishes `scale` per control point; mapped onto `radius` it is Notch's Control Point Scaling Mode: Radius. A taper, a fade at the ends (Notch's Fade Scale) or a hall in a tunnel is an attribute a kernel writes on the path.
- **Part of a path** (Notch's Spline Time Min, Max and Offset) is Resample's Range and Offset upstream. Resample by Distance keeps its stations at fixed distances while the range moves, which is Lock Subdivisions To Spline Time.

### 4.3 What it publishes

- `position`.
- `normal` (vec3f): the profile's outward normal in the ring's plane. It is for a kernel that pushes the surface in or out. It is not the lit normal, which the grid works out from the points, and it does not lean with a taper.
- `uv` (vec2f): round the profile from 0, and along the path by `uvAlong`.
- **Every attribute the path point carries**, copied to each vertex of its ring, except the frame's own (`orient`, `tangent`, `normal`, `binormal`). So a `color` on the path tints the tube (TouchDesigner's carried colours, Notch's Use Spline Colours), and `distance`, `curveU` and any attribute of the author's reach a kernel or a material. What the path carries is what is paid for: a tube of 256 sides copies each attribute 256 times.
- The claim: `grid:{columns}x{rows}` for one strip, `grid:{columns}x{rows}x{strips}` for several, with `wrapU` when the profile is closed and `wrapV` when the path is.

### 4.4 Columns, rows, and hard edges

- **Columns** go round the profile from the frame's +X toward its +Y. With rows running along the tangent, the grid's normal then points outward. Inward reverses the columns.
- **A corner that should be sharp is two columns in one place.** The grid's normal at a point is the cross product of the differences to its neighbours across and along. For the first of two coincident columns the neighbour ahead is in the same place, so its difference across is the side behind it; for the second it is the side ahead. Each gets its own side's normal, and the cell between them has no area. So Square is eight columns, a Ring with Smooth off is `2 × sides`, and a custom profile is sharp where it repeats a point.
- **Rows** are the path's points in order, with cap rows before and after (4.5).

### 4.5 Caps

- A cap is two more rows at an end: the end ring again, and then that ring drawn in to the path point.
- The repeated ring gets the cap's flat normal by the same rule as a hard edge, and the tube's last ring keeps its own.
- The centre row has no normal of its own (its points coincide); the fragment stage already guards a normal of no length, and every pixel of the cap takes the rim's normal by interpolation.
- The cap's `uv` runs from the rim's coordinate inward: polar, not planar.
- **A cap is a fan to the path point.** That is right for a profile every point of which can see the origin: Ring, Square, Strip, and any convex outline round its centre. For a C-shaped profile the fan folds over itself. Such caps are a follow-up that needs real triangles (C3).

### 4.6 Texture coordinates

- **Around**: the share of the way round the profile at that column, by its sides: once round a closed profile and 0 to 1 across an open one. Two columns in one place share it. Tiling is the material's UV scale.
- **Along**:
  - **Stretch**: `curveU`, 0 at the strip's start and 1 at its end, by distance.
  - **Metres**: `distance ÷ uvLength`, so a pattern keeps its size whatever the spacing of the rings. On a closed path the number of tiles is rounded to a whole number per strip, so the pattern meets itself at the seam; the tile is then within half a tile of the length asked for.
  - **Points**: the row number over the rows. It needs no attribute.
- Stretch and Metres read `curveU`, `distance` and `curveLength` from the path, which Curve Frames publishes with Metrics on. Without them the node refuses by name and says which switch to turn on. It does not fall back to Points.
- Before slice 2 the Render shows the grid coordinate (which is Points) whatever the node writes; the `uv` attribute is there for a kernel.

### 4.7 Refusals, all by name

- The Path edge claims no strips; or carries a GPU live count.
- The path carries no `orient`, or one that is not a vec4f: "put a Curve Frames before the Sweep".
- `uvAlong` needs an attribute the path does not carry.
- Profile is Custom and nothing is wired, the edge claims no strips, or the strip has fewer than two points.
- The sweep would hold more than 1,000,000 vertices: the count, and which of Sides and the path's points to lower.
- Several strips before slice 2: a grid claim holds one sheet until the Render reads the third number.
- A parameter in Map mode other than `radius`; a `radius` map that is not an f32.
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
| The sweep pass | under 0.1 ms for 200,000 vertices; about 0.2 to 0.4 ms for a million | derived: the Curve node writes a million points in 0.07 to 0.17 ms, and a sweep writes about three times the bytes a vertex |
| Drawing it, one point shadow | 1.17 ms at 196,608 vertices; 5.0 ms at a million | measured (2.3) |
| A vertex, per pass | 0.1 ms per million invocations; six invocations a cell | measured (2.3) |
| One more Geometry | 0.31 ms of device time with one point shadow | measured (2.3) |
| Memory | 16 bytes a vertex for position, 16 for `normal`, 8 for `uv`, and each carried attribute's own size | the packed layout |

- **A long sweep is cheap and a many-Geometry sweep is not.** That is the reason for sheets.
- A million vertices is the pointset ceiling: 256 sides by 3,906 rings, or 16 sides by 62,500.
- The Curve Frames before a sweep costs more than the sweep: 0.6 to 0.8 ms for one strip of 1,024 points with all its attributes (measured in the curve design, section 4.5).

### 5.3 What it leaves

- **Every vertex is drawn in every pass.** There is no culling and no level of detail, as for every Surface. Fewer sides at a distance is a follow-up (C6).
- **Indexed draws** (the mesh-instancing design's F3) would cut a grid's six invocations a cell to about one a vertex. They are that row's, and a grid would gain as a mesh does.
- **One render pass per target** (T1604b) cuts what a Geometry costs. It does not remove the reason for sheets: forty Geometries are still forty lit draws and forty times every depth draw.

## 6. Consumers

### 6.1 The sentinel tunnel's bore

**Today** (`src/projects/sentinel-bot/tunnel.ts`): one grid of 256 columns by 768 rows, a window of 115 m that rides with the robots. A kernel does everything for each vertex: the path's frame at the row's distance (`pathFrame`, which is the tunnel's centre line written once in WGSL and once in TypeScript), the ring, and then the relief: plates, nine pipe runs, a rib every 1.6 m, the flat deck, and the swell of a hall every 96 m. It writes `tint` as four numbers for the material: what the wall is here, a plate's own random, the angle round, the distance along. The seam is two columns in one place under the deck, with an unwrapped claim.

**With the family:**

```
curve (the centre line, typed into the node) ─▶ resample (Distance 0.15, a Range that rides with the robots)
  ─▶ curveFrames (Fixed Up) ─▶ sweep (Ring, 256 sides, Inward, Metres) ─▶ kernel (the relief) ─▶ geometry (Surface)
```

- **The kernel keeps the relief and loses the path.** It reads `p.uv` (the angle round and the metres along), `p.normal` (which way is out) and `ctx.dim`, moves the vertex along the normal, and writes `tint` as now. The halls are a `radius` mapped from an attribute a kernel writes on the path, or stay in the relief.
- **The centre line is authored once**, as a Curve. The camera rides the same node on the CPU (T1590b), so the tunnel and the camera cannot drift apart, which `path.ts` holds today by writing one function in two languages.
- **The wall stands still while the window slides.** The bore kernel lays its rows at whole multiples of the row spacing. Here that is Resample's Range Start driven in steps: `floor(travel ÷ 0.15) × 0.15 ÷ length`, with the length the authored curve's own, which its CPU reference gives. The stations then stay at fixed distances and the window moves a whole row at a time.
- **A gap in the curve family, found here.** The tunnel is a loop, and a window that rides round a closed curve has to cross its seam. Resample's Range runs from 0 to 1 and does not wrap. Until it does (C10), the centre line is typed in as an open curve whose last 115 m repeat its first, and the travel wraps where the two agree.
- **The seam** is a wrapped claim, so the normal is smooth across it. Today's has a crease under the deck, where two columns each take a one-sided difference.
- **Cost.** The draw is the same 196,608 vertices as today. The family adds the frames for a 768-point strip (about 0.6 ms, where `pathFrame` is a closed form and free), the resample and the sweep pass (under 0.2 ms together).
- **It needs slice 1 only.**

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
- **It needs slice 2**, and slice 3 for the cap.

### 6.4 What falls out

- **A lathe** is a sweep along a Circle with a Custom profile. Notch has Revolve Spline for it.
- **A ribbon** is Strip along any strip: a trail, a banner, a road.
- **A pipe run on the tunnel's wall** is a sweep of its own along an offset of the centre line, instead of relief.

## 7. Tests

On Dawn through the compiler and the backend; exact where the fixture's numbers are, a closed form or the CPU reference otherwise (§V147); red-verified; a wire cut wherever a wire or a mapped parameter is involved.

**The points** (read back)

- A Square along three points on +Z with the identity frame: the eight columns of each ring at exactly `(±r, ±r, z)`, corners doubled.
- A Ring of 4 against its closed form; a Ring of 16 against the reference.
- `(½, ½, ½, ½)` as the frame turns the ring into the YZ plane: a corner that was at `(r, r, z)` is at `(z', r, r)` by hand.
- Radius mapped: each ring at its own radius; cut the map and all take the node's.
- Carried attributes: a `color` and a u32 on the path, read at every vertex of the ring.
- `uv`: Stretch is 0 and 1 at the ends; Metres on a line with points 0.5 m apart and a tile of 2 is `0.25 × row`; a closed path's Metres is a whole number at the seam.
- Padding: a path with three repeated end points sweeps to four identical rings.
- The reference on two unlike strips, every profile, open and closed.

**The picture** (pixels)

- A tube lit from one side, seen from outside: the lit side is brighter by the cosine it should be. Inward and the same picture from inside is lit; Outward from inside is dark. That pins the normal's side to a fact.
- A Square under a light along one face's normal: that face reads one level across its whole width and its neighbour another. Smooth shading would give a ramp. The control is a Ring of 4 with Smooth on.
- A capped tube seen end on: the cap covers the disc it should, in pixels, and is lit as a flat face.
- **Two strips, one draw: the pixels between two parallel tubes are the background's, exactly.** Without sheets the grid joins one tube's end to the next one's start and a band crosses the gap. This is slice 2's test, red before it.
- A kernel between the sweep and the Geometry that pushes every other ring in: the grooves are lit as grooves. With a mesh claim they would not be; the test is the reason for decision D1.
- A Material · WGSL that writes `uv` as colour: a pixel at a known place reads a known coordinate, and across a wrapped seam the coordinate runs on and does not run back.
- The sweep casts a shadow and receives one, and is in the Normal and Depth outputs: one assertion each, because it is a Surface and those are the Surface's own.

**The node** (headless)

- Every refusal sentence of 4.7.
- The claim strings; the column and row counts for every profile, Smooth and Caps.
- Every pass sets exactly the uniforms its shader declares.
- Seek: frame N rendered directly equals frame N after the frames before it.

**The claim** (slice 2)

- `parseTopology` and `formatTopology` round-trip the third number; a claim without it parses as one sheet and formats as before, so no shipped document's bytes change.
- Every shipped example that draws a grid Surface reads back the pixels it read before.
- A kernel's `ctx.dim.sheet` on a sweep of three strips.

## 8. Build plan

### 8.1 Slices

| | Slice | Contents | What it unblocks | Touches the Render |
|---|---|---|---|---|
| 1 | Sweep, one strip | the node; Ring, Square, Strip; `sides`, `smooth`, `radius` and its map, `facing`; the carried attributes; `normal` and `uv` published; a plain `grid:` claim; `src/points/sweep.ts` | the tunnel's bore | no |
| 2 | Sheets | `grid:CxRxS` in the claim, the three grid chunks, the draw's size, the Topology node, `ctx.dim`; the grid reads `uv`; several strips | cables; the tentacle's skin; any set of tubes as one Geometry | yes: after the shadow work in `scene.ts` |
| 3 | Caps and the custom profile | the cap rows; the Profile input | closed ends; rails, gutters, any outline | no |

- Slice 1 depends on nothing unbuilt. Slice 3 depends on slice 1 only.
- Slice 2 is the one that edits `scene-render.wgsl.ts`, `scene.ts` and `render-surface.ts`. It can be built by whoever holds those files, from section 3.3.
- T1589b (lights from a pointset) is ruled to be built with this row. The two share a consumer and no code: a lamp on every rib is that row's, the rib is this one's.

### 8.2 Accepted limitations, as follow-up rows

| | Row | Why it is not in v1 |
|---|---|---|
| C1 | A mitre at sharp corners: the ring widened in the bend's plane so the tube keeps its radius through a corner; and pushing vertices apart where the tube is tighter than its radius (Notch's Minimise Self-Intersections) | needs the turn at each point, which is the neighbours' business; Resample by Curvature puts points in the bends meanwhile |
| C2 | A profile scaled in X and Y separately per point (Notch's XY mode), and a thick strip | a vec2 map; no consumer yet |
| C3 | Caps of outlines that are not star-shaped, and planar cap UVs | real triangles: a mesh claim for the caps alone |
| C4 | A profile that changes along the path (TouchDesigner's Cycle Type; a morph between two profiles) | a profile per row; the column counts must agree |
| C5 | A ribbon lit on both sides | the grid path uses its normal as it stands; the mesh path's turn-to-viewer is the model |
| C6 | Fewer sides and rings at a distance | the same absence as for every Surface |
| C7 | A sweep as the shape of mesh instances | the mesh-instancing design's F10 |
| C8 | The unskinned form: the profile placed at each point and not joined (TouchDesigner's Skin: Off) | it is instancing a strip, which needs a line draw |
| C9 | Motion vectors for a sweep | T1371b is not built for any geometry |
| C10 | Resample: a Range that wraps on a closed strip, so a window can ride round a loop | a change to the curve row's Resample, not to the sweep; the tunnel works round it (6.1) |

### 8.3 Decisions to rule

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

- On a wrapped grid the texture coordinate ends at `cols ÷ (cols − 1)`, not at 1 (`surfaceMeshWgsl`: `gx ÷ max(cols − 1, 1)` with `gx` running to `cols`). A texture does not go exactly once round a Tube or a Torus. D9.
- The bore's seam is two columns in one place with an unwrapped claim, so each takes a one-sided difference and the normal has a crease there. It is under the deck and does not show.
- A grid Surface is lit on one side and a mesh Surface is turned to face the viewer (B227). Nothing says so where a person chooses between them.
- The Topology node's Columns and Rows stopped at 4,096 each. Fixed in T1586b's slice 6.
- Resample's Range cannot cross the seam of a closed strip (C10).

## 10. Sources

Repository: `docs/curve-family-design-2026-10-05.md`, `docs/mesh-instancing-design-2026-10-05.md`, `docs/geometry-cost-profile-2026-10-05.md`, `docs/td-notch-mechanisms-2026-10-05.md`; `src/nodes/shaders/scene-render.wgsl.ts`, `src/nodes/definitions/scene.ts`, `src/points/topology.ts`, `src/projects/sentinel-bot/tunnel.ts`.

TouchDesigner (Derivative), fetched 2026-10-05:

- Sweep SOP: https://docs.derivative.ca/Sweep_SOP
- Extrude POP: https://docs.derivative.ca/Extrude_POP
- Line Resample POP: https://docs.derivative.ca/Line_Resample_POP
- The POP list and the Line Thick POP's removal are as read by the reference survey (its section on lines).

Notch, fetched 2026-10-05 (page updated 16 Sep 2026):

- Spline Extruder: https://manual.notch.one/2026.2/en/docs/reference/nodes/3d/spline-extruder/
