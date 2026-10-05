# A curve family: curves as strips of a pointset (T1586b)

**Status, 2026-10-05: ruled and partly built.** Every decision in section 7.3 was ruled as recommended, and the consumer (shaderloom-f1) reviewed the design with no objection. Slices 1, 3 and 4 are built: Strips (`726cc203`), Curve Frames (`c8fd00ba`) and Resample (`dbb5c761`). Section 7.4 lists what changed from this design as they were built. Slices 2 and 5 to 8 are design only.

The row asks for a Curve node, a Resample node and a Curve Frames node, with instancing along a curve (T1581b), sweep (T1587b), a path follower (T1590b) and rope (T1585b) as consumers. The owner's standard for it (2026-10-05): consider how TouchDesigner and Notch do this, build the right general shape and not the first consumer's minimum, no brittle or unscalable shortcuts.

Read for this: `docs/td-notch-mechanisms-2026-10-05.md` (the reference survey), `docs/pop-gap-analysis.md`, `docs/point-kernel-substeps-assessment-2026-10-05.md`, `docs/mesh-instancing-design-2026-10-05.md`, the point engine (`src/points/**`, the point nodes under `src/nodes/definitions/`, `scene.ts`), `src/projects/sentinel-bot/**` at `24efa324`, and the official TouchDesigner and Notch pages listed in section 9. Neither program was run. Cost figures marked "derived" are arithmetic from figures already recorded in the repo, not measurements.

## 0. The design on one page

- **A curve is a strip: a run of consecutive slots of a pointset.** Every strip in one pointset has the same number of slots. Strip `j`, station `i` is slot `j × cols + i`. The pointset edge says so with a new topology claim, `strips:{cols}x{rows}` with an optional `:closed`. A grid's rows are strips too, so a rope and a cloth solve on the same layout, and `ctx.dim` (cols, rows, i, j) already describes it to a kernel.
- **Everything else about a curve is a per-point attribute** with a fixed name: `orient`, `tangent`, `normal`, `binormal`, `distance`, `curveU`, `curveLength`, `curvature`, `live`. Attributes pass through every existing node by reference, so nothing between a curve node and its consumer has to know about curves.
- **A strip shorter than its allocation is a fixed capacity with degenerate elements** (§V788): unused slots hold a copy of the nearest live end and `live` is 0 there. Sweeps, lines, frames and resampling see zero-length segments and need no count. Per-point draws cull on `live`.
- **Three nodes and one extension.** Topology gains a Strips claim. **Curve** turns control points into a strip (linear, Catmull-Rom, cardinal, B-spline, Bezier, and a constant-curvature arc of a given length). **Resample** places points by count, by distance or by curvature, with a range and an offset along the curve. **Curve Frames** is the one node that measures a strip: distance from start, curvature, and a twist-minimised frame with a seeded start, as a quaternion.
- **On the GPU**, Curve is one pass. Resample is a length scan and one pass per output point that binary-searches it. Curve Frames is a scan. A scan here is one invocation per strip walking its strip in order, which is exact, has one canonical float order, and is parallel across strips. Strips longer than one block take a three-pass blocked form.
- **Stateless.** No curve node keeps anything between frames or reads a clock, so seek, replay and offline rendering need no rule beyond the ones a kernel already obeys.
- **A CPU reader gets the curve from its definition, not from the GPU.** A Curve whose control points are authored on the node is evaluated by the same reference functions on the CPU, with no latency. A curve computed on the GPU reaches a follower one frame late through the Analyze seam, as a named follow-up.

## 1. How TouchDesigner and Notch do it

**The reference is `docs/td-notch-mechanisms-2026-10-05.md`** (shaderloom-f1, `fa759eab`): TouchDesigner §4 "Curves, chains, geometry along a curve", Notch §4 "Splines and geometry along a spline", and "What this means for Loom" item 4. Its facts are not repeated. This section adds what this session read on 2026-10-05.

### 1.1 TouchDesigner (POPs)

**What a line strip is.**

- POPs have five primitives: point, line, line strip ("1 or more points"), triangle, quad. "A vertex is an index into the points list." "In POPs a line strip is closed if its last vertex's point index is the same number as the first vertex's point index." (Learning About POPs)
- "There is no curve primitive, but linestrips can contain curve attributes and/or be linear- or spline-subdivided, smoothed and resampled". The control points carry "Weight, Tension, Interpolation Type, Bezier tangents In and Out, tangent continuity".
- Where strips break is said in three ways on the Line Break POP: a per-point flag ("the attribute will contain 1 for line breaks"), a per-point strip index ("points with same integer are part of one line strip"), and "Every N Points".
- The Topology POP exposes the buffers behind it: a "Line Strip Info" buffer, a "Line Strip Index per Vert" attribute, "Max Line Strips" and "Max Verts per Line Strip", the last "used by some downstream POPs for GPU memory allocation".
- Regular structure has its own name. "Dimension is the metadata that describes the structure of a point list in a POP, and is passed from POP to POP." The Trail POP: "If the number of points of the input is the same for all the slices, it adds one new Dimension". The Skin POP "takes any 2-dimensional (or more) arrangement of data (for example three line strips of 20 point each) and connects them together as a mesh".
- Counts live on the GPU. "The number of resulting points is only known on the GPU"; "the memory allocated is the maximum memory the POP could use"; downloading the count "causes a stall" unless delayed by a frame.

**Making and resampling.**

- Line POP and Line Divide POP: Linear, Cardinal (with Tension), BSpline, Cubic Bezier With Tangents, Cubic Bezier, Quadratic Bezier; a method per segment by attribute; in and out tangent attributes; "Clamped ... whether to duplicate the start and end control points"; divisions per strip, per segment, by distance or by curvature; `maxverts` allocated up front.
- Line Resample POP: Divisions per Line Strip, Distance between Points, By Curvature (Min Distance, Max Distance, Min Max Bias), Points as Keyframes (an attribute as the independent variable). Interpolation Linear or Cardinal. `lsmaxverts`: "Sets the number of vertices to be allocated. It should be bigger than the actual number of vertices created". `maxtries`: "Max number of iterations for binary search when linearly resampling", so the mechanism is a cumulative length and a search (*inference* from the parameter).
- Line Smooth POP (Gaussian or box, by edge distance or point steps, End Points Fixed).

**Measuring.**

- Line Metrics POP. Neighbour page: displacement, distance and direction to next and previous, Tangent, Curvature, Angle per Distance, and "Continuous Direction ... for co-incident points" with "Max Neighbors ... how far to look when points are in same position". Line Strip page: Distance from Start and from End, both also normalised, Line Strip Length. Index page: vertex index in strip, number of vertices in strip, strip index, each also normalised. Orientation page: Normal, Binormal, Quaternion, Rotation Matrix, Transform Matrix, and "Input Seed Orientation ... the initial orientation at each line-strip starting point, using either quaternions or transform matrices". How the frame is carried along the strip is not stated.
- POP Rotations: a rotation attribute is a quaternion, a 3×3, a 4×4 or a tangent-normal-binormal set, identified by a qualifier on the attribute. The Lookup Attribute POP interpolates "both transform matrices and quaternions" along a second input.

**Along a curve.**

- Sweep is CPU only (Sweep SOP): the cross-section is oriented by "the direction of the backbone line segment and the positive Z axis", with Angle Fix, Fix Flipping, a cumulative Twist and a non-cumulative Roll. There is no Sweep POP; the Extrude POP extrudes along a direction; the Line Thick POP page reads "has been removed".
- Path following is on every Object COMP: `pathsop` "names the SOP that functions as the path", `pos` runs 0 to 1 (by length or by knot is not stated), `pathorient` points "the positive Z axis of the Component ... down the path", `up` sets where +Y points, `bank` "rolls the Component based on the curvature of the path". The path is a SOP, which is CPU geometry. A POP reaches a SOP through POP to SOP, whose Download Type is "immediate (Slow)" or "nextframe (Fast)".
- The Curve POP is something else: a lookup curve in the XY plane.

### 1.2 Notch

- **Spline**: control points edited in the viewport, each with a position, a heading and pitch, a scale and a Tangent Mode (Auto, Aligned, Broken, Mirrored). Node level: `Looping`; `Twist Method`, "the method we use to resolve twisting along the spline resulting from interpolation" (the manual page does not list its options; the reference found Minimise Twist as the default in the release notes); `Spline Time Mode`, "Knots: Followers take the same amount of time to move between each control point" or "Length: ... normalised by the distance along the spline, so the follower will appear to move at a constant rate".
- **Spline From Nulls**: "the position of each Null used as the position of the control point; the rotation of the Null is used to control the tangent direction ... and the z scale controls the magnitude". "A transform array can also be connected." Nulls are scene transforms, animated on the CPU.
- **Every consumer reads the same spline time.**
  - Spline Cloner: Spline Offset, Spline Use Amount, Loop Spline Time, Rotation Mode (None, Align To Direction, Align To Tangent), Rotation - Use Bank, Scale Clones By Spline, Colour Clones, and a Spline Selection Mode for when "multiple splines are combined".
  - Spline Extruder: Num Spline Segments, Spline Time Min, Max and Offset "normalised by the splines length", Lock Subdivisions To Spline Time, Caps, Extrude Shape, Radius, Control Point Scaling Mode, Radial Rotation Offset, UV Mode, Minimise Self-Intersections. "A mesh can be used as input if it has the Object To Lines deformer."
  - Spline Follower: Spline Time, Rotation Follows Direction, Rotation Look Ahead Time, Use Matrix Rotations ("does not suffer from gimbal lock"), Fix Heading Flips.
  - Spline Deformer: maps a mesh's extent on one axis to a spline time range; "If the source provides multiple splines, the deformed geometry will be duplicated to each spline."
  - Rope Deformer: "each edge in the connected mesh will be treated as an independant piece of rope", "commonly used together with the Object to Lines node".
- **Line tools**: Object To Lines (per edge, border, single line by index or by edge), Lines To Mesh, Duplicate Splines, Simplify Spline, Spline Extend, Spread Lines, Connect With Lines, Revolve Spline, Node Trail.
- **Not found in the manual**: a resample-by-distance node (consumers take a count and a spline time), or a constant-curvature arc of a given length.

### 1.3 Where the two agree

1. **A curve is ordered points plus facts derived once and shared.** TouchDesigner derives them in Line Metrics and stores them as attributes. Notch resolves twist and time on the spline, and each consumer reads them.
2. **One parameter along the curve, read two ways**: by control point or by length. TouchDesigner picks at the resample; Notch picks on the spline.
3. **A maximum is allocated and the real count lives on the GPU.**
4. **Twist is resolved on the curve**, not by each consumer. TouchDesigner seeds it from an attribute at each strip's start.
5. **A CPU follower reads a CPU curve.** TouchDesigner's path is a SOP. Notch's spline is authored control points or Nulls. Both document a cost for coming back from the GPU (a stall or a frame).

### 1.4 Comparison

| Capability | TouchDesigner | Notch | Loom today | Loom proposed |
|---|---|---|---|---|
| What a curve is | a line strip primitive over points; curve attributes on control points | a spline node; lines are geometry | nothing; a kernel computes stations by hand | a strip of a pointset, claimed on the edge (2.2) |
| Many curves in one object | yes; break flag, strip index or every N points | "multiple splines combined"; one rope per edge | no | rows of one pointset, equal slot counts |
| Regular structure | Dimension metadata | not documented | `grid:` claim, `ctx.dim` | `strips:` claim; a grid's rows are strips |
| Open and closed | closed when last index equals first | Looping | grid `wrapU` | `:closed` on the claim |
| Control points to curve | Linear, Cardinal, BSpline, cubic and quadratic Bezier | Bezier with four tangent modes | none | Linear, Catmull-Rom, Cardinal, B-Spline, Bezier (3.2) |
| An arc of a given length | no | no | sentinel-bot's kernel, by hand | Curve basis Arc; forward arc chains (3.2) |
| Where control points come from | Line POP parameters, or any line strip | viewport editing, Nulls, a transform array, import | a kernel | any strips pointset; an authored table on the node |
| Resample | divisions, distance, curvature, keyframes | counts on the consumers | Laser Path's max-step planner only | Count, Distance, Curvature (3.3) |
| Allocation | max vertices per strip, count on GPU | not documented | capacity, or a prefix live count | max points per strip; `live` per point |
| Attributes on resample | carried; quaternions and matrices interpolate in Lookup Attribute | spline colour and scale | n/a | floats linear, integers from the segment start |
| Knots or length | resample method | Spline Time Mode | n/a | Resample: Even Length or Even Parameter |
| Range and slide along the curve | not on these pages | Spline Time Min, Max, Offset; Spline Use Amount | n/a | Resample range and offset |
| Tangent, curvature, distance | Line Metrics | internal | by hand | Curve Frames |
| Frame and twist | Line Metrics Orientation page; method not stated | Twist Method, Minimise Twist | by hand | Minimise Twist or Fixed Up; quaternion |
| Seeded start frame | Input Seed Orientation | not documented | by hand | Up vector, or an attribute at the strip's first point |
| Roll and twist | Sweep SOP Twist, Roll | the cloner's Use Bank, the extruder's Radial Rotation Offset | by hand | Roll (also per point), Twist |
| Instances along a curve | Copy POP or instancing on the strip's points | Spline Cloner | boxes on a kernel's points | Curve → Resample → Curve Frames → Geometry (5.1) |
| Sweep | CPU only | Spline Extruder | no | T1587b, reading these attributes (5.2) |
| CPU follower | `pathsop` on a SOP | Spline Follower | expressions over a closed-form path | T1590b over the Curve's CPU reference (5.3) |
| Rope | none | Rope Deformer on line geometry | none | T1585b on the same strips (5.4) |
| Deform a mesh along a curve | Lookup Attribute | Spline Deformer | no | follow-up, needs T1582b |
| Draw a curve as a line | Line MAT | Show Spline, line rendering | Beam mode with a kernel-written far end | Beam reads the strip (7.1, slice 5) |
| Smooth, simplify, reverse, join | Line Smooth; others by other POPs | Simplify Spline, Duplicate Splines | a kernel | follow-ups, named (7.2) |

## 2. The representation

### 2.1 What the engine has

- **A pointset edge** carries `pairs` (where each attribute lives), `capacity`, an optional `topology` string and an optional `count` buffer (`CompiledNodeDescription.pointsets`, `domain/types/node-definition.ts`).
- **Topology is a claim the producer makes about slot structure** (`points/topology.ts`): `points`, `grid:{cols}x{rows}` with wrap flags, or `mesh:{triangles}@{indexBuffer}`. One parser and one formatter. A string no consumer understands parses to `null` and is refused, never guessed.
- **`ctx.dim`** hands a kernel `cols`, `rows`, `i = index % cols`, `j = index / cols` as literals from the incoming grid claim (`points/codegen.ts`, T472). T1585b already words the rope as "cols = links, rows = strands".
- **Claims are kept honest.** Proximity publishes `points` for its links because "claiming a grid would let a mesh span them"; the box generator publishes `points` because six faces are not one sheet.
- **`count`** means the first N slots are live, for the whole pointset. Point Kernel and Point Ray refuse a counted input; Geometry draws one only as instances.
- **§V788**: a variable count can be a fixed capacity with degenerate elements. Proximity's absent links are zero-length.
- **Attributes pass by reference** through every node that does not write them (§V197), and a derived companion must travel with its source (§V883).
- **Scans exist.** Compaction and Laser Path run a deterministic prefix sum (a scan inside each 256-slot block, then one thread over the block totals), never atomics (§V74). Laser Path then gives each output slot a binary search over the scanned offsets (`laser-path.wgsl.ts`), which is the mechanism TouchDesigner's `maxtries` implies.

### 2.2 The decision

**R1. A curve is a strip, and strips are rows.** Strip `j` holds stations `0 … cols−1` in slots `j × cols … j × cols + cols − 1`. Every strip in a pointset has the same `cols`. This is U along the curve and V across curves, the same index a grid uses.

**R2. A new claim says it: `strips:{cols}x{rows}`, with `:closed` when each strip's last point connects to its first.**

- It claims connectivity along U only. Strips are not connected to each other, so a Surface geometry refuses a strips pointset by name, as it refuses `points` today.
- One function, `stripsOf(topology)`, answers "what strips does this edge carry": the claim's own for `strips`; `cols`, `rows` and `closed = wrapU` for a `grid`; nothing for `points` and `mesh`. Every curve node and the rope read strips through it, so nobody re-derives the rule.
- `ctx.dim` is supplied for a strips claim exactly as for a grid. No new kernel vocabulary.
- **Producers**: Curve, Resample, the Topology node (a new Strips connectivity, for a kernel's output), and the Line and Circle generators (`strips:{n}x1` each; they published `points` before slice 1 although their slots are in curve order). Curve Frames, Point Kernel, Range, Gather and Transform keep whatever claim came in, as they do now.
- A curve node wired to a `points` or `mesh` edge refuses by name and names the Topology node as the fix.

**R3. Everything else is a per-point attribute with a fixed name.**

| Attribute | Type | Written by | Meaning |
|---|---|---|---|
| `position` | vec3f | every producer | the point |
| `live` | f32 | Resample, when a strip can be shorter than its slots | 1 on a point of the strip, 0 on a padding slot. Absent means every slot is live |
| `distance` | f32 | Curve Frames | metres from the strip's first point, along its segments |
| `curveU` | f32 | Curve Frames | `distance ÷ curveLength`; 0 on a strip of no length |
| `curveLength` | f32 | Curve Frames | the strip's length, on every point of it; a closed strip includes its closing segment |
| `curvature` | f32 | Curve Frames | 1 ÷ radius of the circle through the point and its two neighbours; 0 at the ends of an open strip |
| `orient` | vec4f, quaternion | Curve Frames | the point's frame (R5) |
| `tangent`, `normal`, `binormal` | vec3f, direction | Curve Frames, optional | the same frame as vectors |

- A name already on the edge with the same type is replaced by a fresh pair; with another type the node refuses by name (Gather's rule).
- Names are fixed, not parameters. TouchDesigner gives each output a name field; eight name parameters on one node would bury the ones that matter. Renaming belongs to a schema node (the Attribute node in T866's gap list), which Loom does not have yet.

**R4. A strip shorter than its slots is padded with copies of its nearest live end, and `live` says which slots are padding** (§V788).

- The live points of a strip are one contiguous run. Slots before it hold a copy of its first point, slots after it a copy of its last, every attribute included.
- A consumer that follows the strip sees zero-length segments there. They add no length, turn no frame, and sweep to triangles of no area. Sweep, a line draw, Resample and Curve Frames therefore need no count at all.
- A consumer that treats each point alone (instances, lights) reads `live`: Geometry's Group `p.live > 0.5` culls today, and T1581b's resolve pass turns it into a zero record once per instance.
- A walker that needs a strip's real ends finds them from its neighbours' flags in constant time.
- **Why a flag per point and not a count per strip.** (a) An attribute passes through every existing node by reference; a new payload field would be dropped by each node that rebuilds the payload by hand. (b) Group and Map consume an attribute today with no engine change. (c) The first consumer needs padding at the *head* of a strip: sentinel-bot stows the rings nearest the socket when a tentacle has slack (`rig.ts`, `d < 0`). A count cannot say that; a flag can.
- **Why not the edge's `count`.** With more than one strip the live points are not a prefix of the pointset. And a counted edge is refused by Point Kernel, which would forbid Resample → kernel, the commonest chain in the family.

**R5. The frame convention agrees with T1581b.** `orient` is a unit quaternion (x, y, z, w), right-handed and active, as Geometry's Orient already reads it (T723). It carries the shape's axes to:

| Shape axis | Curve direction |
|---|---|
| +Z | `tangent`, toward the strip's end |
| +Y | `normal` |
| +X | `normal × tangent`, which is `−binormal` with `binormal = tangent × normal` |

- +Z is `forward`'s default in T1581b (D6) and what both products point down a path. +Y is the up that T1581b's Look At and Aim use.
- So the two routes T1581b names draw the same picture: `orient` mapped to Orient, or `tangent` mapped to Aim and `normal` to Up with Forward +Z. That equality is a test (section 6).
- A shape whose front is another axis uses Aim, Up and Geometry's `forward`. Curve Frames has no forward menu of its own.
- sentinel-bot's kit frame is (normal, binormal, tangent) on (X, Y, Z): the same +Z and a quarter turn about it. It sets Roll to 90 or re-exports.

**R6. Curve nodes work along U.** Following a grid's columns (the length of a Tube generator's output) is a named follow-up; TouchDesigner does it with the Dimension POP's reorder.

### 2.3 Alternatives, and why not

| Alternative | What it buys | Why not |
|---|---|---|
| Claim a `grid` for a bundle of curves | no new claim | false: it says neighbouring curves are joined, and Surface would skin a membrane between ten tentacles. The engine already refuses that kind of claim twice |
| A per-point curve id and parameter (TouchDesigner's strip index and info buffer) | strips of any length, any count, any order | every consumer must search for its strip's bounds, every scan becomes data-segmented, a resample must compact across strips, and a second buffer has to ride the edge. It is TouchDesigner's general primitive model, and TouchDesigner itself allocates a fixed maximum per strip for the GPU work (`lsmaxverts`). Kept as a follow-up claim for line soups (7.2) |
| An indexed line list, as `mesh:` does for triangles | arbitrary connectivity | no order along a curve without a traversal; right for a wireframe, wrong for a curve |
| A per-strip counts buffer named in the claim | the count stored once per strip | one more binding on every consumer, unreadable from a kernel or a Group predicate without new codegen, and it cannot express a padded head (R4) |
| A curve as a texture row | reuses texture feedback | a second data model beside pointsets, which T1585b's row rules out for rope |

### 2.4 Scale

- A pointset holds up to 1,000,000 points (`points.ts`) and one producer's attributes up to 128 MiB (`points/packing.ts`). 2,000 curves of 500 points fit.
- Strip bounds are multiplication, not data: one thread per strip, or per point, with no atomics and no search for "which strip am I in". Gather's docblock makes the same argument for its fixed link stride.
- Waste is the padding. Curves of very unequal length in one pointset waste the difference. Resample by Count removes it; a ragged claim is the follow-up for sets where that is not acceptable.
- Curve Frames adds 32 bytes a point (`orient` and four scalars), 80 with the vectors.

### 2.5 What rope and instancing need from it

- **Rope (T1585b)** needs a fixed number of links per strand, the neighbour of a link in constant time, anchors by station (first, second, last), a red/black split (`i & 1`), and its output to be the same kind of thing as its input. Strips give all of it. The rope reads `stripsOf`, so the same solver takes a `strips` claim (a rope) and later a `grid` claim (cloth, with the V edges as well). Notch's Rope Deformer has the same shape: a rope per edge of line geometry.
- **Instancing (T1581b)** needs one row per instance with a translate, an orientation and a way to skip. A strips pointset after Curve Frames is that: `position`, `orient` or `tangent` and `normal`, `live`, and `distance` as a named `Instance` field for the material (its D9).

### 2.6 One difference from the mesh-instancing design's note

Section 9 of that design says "Resample's live count is a counted draw". That holds only for a single strip with its padding at the tail. In general the live points are not a prefix (R4), so Resample publishes `live`, and:

- today the Group predicate culls per instance;
- in T1581b the resolve pass writes a zero record once per dead instance (its D8 and D13), and the vertex stage still runs for it;
- with T1581b's F1 (cull and compaction feeding the indirect arguments) dead instances cost nothing, for any number of strips. F1's flag pass reads the same zero record, so nothing here changes for it.

## 3. The nodes

All three are category "points" and none is stateful. A parameter marked ⓢ is structural (it changes a capacity or the program); the others are uniform writes (§V5). "Map" means the parameter takes a per-point attribute in Map mode, T1581b's D7 idiom; where a value and an attribute both exist, Roll adds and the others take the attribute alone.

### 3.1 Topology and the generators (extended)

- **Topology** gains Connectivity: Strips. It reads the existing `cols` (points per strip), `rows` (strips) and `wrapU` (closed), and refuses a claim that addresses more points than the edge carries, as it does for a grid. This is how a kernel's output becomes curves, and it is TouchDesigner's "Every N Points".
- **Line Points** and **Circle Points** each publish `strips:{count}x1`. The circle is an open strip: its generator runs the angle from 0 to a full turn inclusive, so its last point already sits on its first and the loop is closed in the data. A `:closed` claim on top would add a segment between two coincident points. A circle with one point per step and a closed claim is a change to where existing documents' points sit, so it is left as a finding (section 8).

### 3.2 Curve

Control points in, an interpolated strip out.

**Inputs**

- `in` (pointset, optional): the control strips. Each strip of the input is one curve's control points, in order. `:closed` on the input closes the curve.
- Unwired, the node reads its own authored table (below). This is Point Kernel's rule for its optional `in`.

**Output**: a strips pointset with the input's `rows` and, per span, `segments` points.

- Open: `(controls − 1) × segments + 1` points per strip. Closed: `controls × segments`. An unclamped B-Spline has two spans fewer.
- `position` follows the basis. Every other float attribute the control points carry is interpolated linearly along its span, so a radius or a colour never overshoots; integer attributes take the span's first control point.
- It publishes no tangent and no frame. Curve Frames is the one publisher of those (D4).

**Parameters**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `basis` ⓢ | enum | Catmull-Rom | Linear, Catmull-Rom, Cardinal, B-Spline, Bezier, Arc; Arc Chain in slice 8 |
| `segments` ⓢ | number | 16 | output points per span |
| `tension` | number | 0 | Cardinal only: 0 is Catmull-Rom's tangent, 1 a polyline |
| `clamped` ⓢ | boolean | on | B-Spline only: the curve reaches its end control points |
| `arcLength` | number, Map f32 | 1 | Arc only: the span's length |
| `arcLengthUnit` ⓢ | enum | Metres | Arc only: Metres, or Chords (1 is straight, 1.2 has a fifth of slack) |
| `bow` | vec3, Map vec3f | 0, −1, 0 | Arc only: the side the arc bulges to |
| `maxTurn` | number, degrees | 360 | Arc only: the most an arc may turn; slack beyond it is not deployed |
| `points` | list | a short line | authored control points, read only while `in` is unwired |
| `closed` ⓢ | boolean | off | authored table only; a wired input's claim decides otherwise |

**The bases**

- **Linear**: the polyline.
- **Catmull-Rom**: passes through every control point, centripetal knots, so unevenly spaced control points do not loop or overshoot.
- **Cardinal**: uniform knots with Tension, TouchDesigner's "Cardinal (Interpolating)".
- **B-Spline**: uniform cubic, approximating.
- **Bezier**: cubic, each control point carrying `handleIn` and `handleOut` (vec3f, relative to the point). This is Notch's per-point tangents and TouchDesigner's "Cubic Bezier With Tangents"; Notch's four tangent modes are editing behaviours over the same two vectors. A control set without the two attributes refuses by name.
- **Arc**: each span is one arc of constant curvature with a given length, from its first control point to its second, bulging toward `bow` (below).
- Ends of an open interpolating curve use a mirrored phantom point. All bases are evaluated per output point from at most four control points.

**Arc, exactly.** For a span from A to B with chord `c = |B − A|`, direction `ĉ`, requested length `ℓ` and `w` the unit part of `bow` perpendicular to `ĉ`:

```
L = min(ℓ, c ÷ sinc(maxTurn ÷ 2))          the length deployed
φ solves sinc(φ) = c ÷ L on [0, π]          the half turn; sinc only falls there, so φ is unique
κ = 2φ ÷ L                                  the curvature
t0 = ĉ·cos φ + w·sin φ                      the tangent at A
m0 = ĉ·sin φ − w·cos φ                      toward the centre
P(s) = A + t0·sin(κs) ÷ κ + m0·(1 − cos(κs)) ÷ κ        0 ≤ s ≤ L
```

- Output station `k` is at `s = k × L ÷ segments`. `P(L) = B` follows from the definition of φ.
- φ is found by a fixed number of bisection steps, so the pass has no data-dependent loop.
- With `ℓ ≤ c` the span is out of reach: the output is the straight segment of length `ℓ` from A toward B, and the end falls short. Length is kept, the target is not. A kernel that needs to know measures the gap.
- With `bow` along the chord or zero, `w` is the world axis least aligned with the chord, made perpendicular.
- **A bow direction that sweeps through the chord flips the arc to the other side in one frame**, because only the part of `bow` square to the chord picks the side. A bow kept off the chord gives an arc that moves continuously with its ends; the node's description says so, and a test holds it (section 6).
- Several spans are independent arcs: continuous in position, not in tangent. That is a cable through pegs with slack per span, or a festoon.
- This is sentinel-bot's holding tentacle (`rig.ts`): one arc from socket to claw, unique up to the bow's side, so it cannot jump between solutions. `maxTurn` is twice its `BOW_LIMIT`, which is a half turn.

**The authored table.** `points` is a list of control points, at most 64, each a position with an optional scale and roll, which become `scale` and `roll` attributes for a sweep or for Curve Frames. The cap is a uniform-table limit (one vec4 a point, as Ramp packs its stops), and 64 is what the consumer's review asked for: a closed 960 m tunnel as Catmull-Rom is one point per 15 m.

- It is uploaded as a capped uniform table, the way Ramp's stops are (`generators.ts`, `packStops`), so moving a control point is a uniform write and never a rebuild.
- It is one strip. Many curves come from a pointset.
- It is what makes a curve readable on the CPU (5.3). A wired control set has no CPU copy, so a CPU reader refuses a Curve whose input is wired, by name, until the measured curve (C2) exists; more than 64 authored points is the same case, since they have to be wired.
- The stored form in the first build is a JSON list, as Point Kernel's `attributes` is. A typed list parameter with a viewport editor, per-point handles and Notch's tangent modes is a follow-up row; the wired Bezier form covers handles until then.

**Arc Chain (the last slice of v1, D8).** Several arcs end to end, each with a length and a curvature, tangent-continuous by construction: the piecewise constant-curvature model of a continuum arm (Webster and Jones 2010).

- Each control point is a section: `arcLength` (f32) and `bend` (vec2f: curvature about the frame's X and Y, per metre). The first carries the start `position` and a start direction and up.
- A point at distance `d` composes the rotations of the sections before it, so it is one pass with a loop bounded by the section count (at most 16), and its length is exact because length is an input.
- The single Arc is the case of one section whose curvature comes from the solve above.
- sentinel-bot's trailing tentacle is two sections (neck and arm), and its blend between holding and trailing is a blend of these numbers. Without Arc Chain that state stays in its kernel.
- The inverse problem with several arcs (pass through given points with given lengths) has branches; the consumer's two-arc solve "jumped branches". It is not offered as a stock mode.

### 3.3 Resample

A strip in, the same curve out with its points placed by rule.

**Input**: a strips pointset. **Output**: a strips pointset with the same `rows` and `closed`, `cols` from the method, and **every attribute owned afresh** (slots move, so nothing can pass by reference). `live` is published by the Distance and Curvature methods, whose strips can be shorter than their slots.

**Parameters**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `method` ⓢ | enum | Count | Count, Distance, Curvature |
| `count` ⓢ | number | 64 | Count: points per strip |
| `spacing` ⓢ | enum | Even Length | Count: Even Length, or Even Parameter (even in the input's point index: Notch's Length and Knots) |
| `distance` | number | 0.1 | Distance: metres between points |
| `maxPoints` ⓢ | number | 256 | Distance and Curvature: slots allocated per strip |
| `anchor` ⓢ | enum | Start | Distance: which end the stations are measured from. With End the last point is always on the curve's end and padding collects at the head |
| `offset` | number | 0 | metres to slide every station along the curve |
| `rangeStart`, `rangeEnd` | number | 0, 1 | the part of the length used, as fractions |
| `minDistance`, `maxDistance`, `bias` | number | 0.02, 0.5, 0.5 | Curvature: TouchDesigner's three |

**Rules**

- **Count** places point `k` at `k ÷ (count − 1)` of the range (`k ÷ count` when closed). A count of 1 places its point at `rangeStart`. Every slot is live.
- **Distance** places station `k` at `offset + k × distance` from the anchor. A station beyond either end of the range is padding (R4). A station within 1/1024 of a spacing past an end counts as the end and lands on it, so an exact fit does not flicker on rounding.
- **Over budget, Distance never cuts the curve short.** If the range needs more than `maxPoints`, the spacing widens to the range's length `÷ (maxPoints − 1)` and the whole range is still covered. A curve that ends early is a hole in a tunnel; a coarser one is a visible, bounded degradation. An authored curve's count is computed on the CPU too, and the node warns at compile time. A measured warning for a GPU-computed curve needs the point-to-scalar reduce (follow-up).
- **Curvature** is Distance in a stretched measure: each input segment counts for its length times a density between `1 ÷ maxDistance` and `1 ÷ minDistance`, rising with the turning at its ends by `bias`. The same scan and search, over that measure.
- **Closed strips** include the closing segment, and stations wrap. The output keeps the closed claim, so its last point joins its first. To take an open piece of a closed curve, open the claim with a Topology node before the Resample, which is what that node is for.
- **`rangeStart`, `rangeEnd` and `offset`** are Notch's Spline Use Amount, Spline Time Min and Max, and Spline Offset. A curve that draws itself on is `rangeEnd` animated. This is the family's trim.
- **Attributes.** Float attributes interpolate linearly between the two input points around the station; integers take the earlier one, since a blend of two ids is not an id (Gather's rule). Nothing is renormalised, because the edge does not carry an attribute's qualifier (T287 declared them; no edge publishes them). So Resample runs before Curve Frames, which is the order of every chain in section 5. A resampled `orient` is a linear blend and is refused by nothing; the follow-up that puts qualifiers on the edge makes it a proper blend.
- **Position** interpolates linearly along the input's segments. TouchDesigner's Cardinal option for the resample is a follow-up; a Curve upstream already supplies a dense strip.

**One point per strip.** Count 1 with `rangeStart = rangeEnd = u` is the point of each strip at `u`, with every attribute. After Curve Frames that is "the frame at the tip of every tentacle" as a pointset of `rows` points: what a claw hub is instanced on.

### 3.4 Curve Frames

The one node that measures a strip.

**Input**: a strips pointset. **Output**: the same pointset by reference, plus the attributes it owns. The claim passes through.

**Parameters**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `method` ⓢ | enum | Minimise Twist | Minimise Twist carries the frame along the curve; Fixed Up keeps `normal` toward Up at every point |
| `seed` ⓢ | enum | Up | Minimise Twist: where the first frame comes from, Up or Orient Attribute |
| `up` | vec3, Map vec3f | 0, 1, 0 | the direction `normal` leans to: at the strip's first point (Minimise Twist) or at every point (Fixed Up) |
| `seedOrient` ⓢ | attribute name | `orient` | Seed: Orient Attribute. A quaternion read at each strip's first point |
| `roll` | number, degrees; Map f32 | 0 | a turn about the tangent, the same at every point; a mapped attribute adds per point |
| `twist` | number, degrees | 0 | a turn about the tangent that grows from 0 at the start to this at the end, by distance |
| `closeTwist` | boolean | on | closed strips: spread the mismatch after one lap along the strip, so the frame meets itself |
| `frame` ⓢ | boolean | on | publish `orient` |
| `vectors` ⓢ | boolean | off | publish `tangent`, `normal`, `binormal` |
| `metrics` ⓢ | boolean | on | publish `distance`, `curveU`, `curveLength`, `curvature` |

**What it computes**

- **Segments.** A strip is its points joined by straight segments. A segment of no length is skipped: it adds no distance and turns no frame. This is TouchDesigner's "Continuous Direction", and it is why padding is harmless.
- **`distance`** is the running sum of segment lengths from the first point.
- **`curvature`** is the curvature of the circle through a point and its two neighbours, `2·|a × b| ÷ (|a|·|b|·|a + b|)` for the two segments `a`, `b`. It is exact for points on an arc.
- **The frame is carried along the polyline itself.**
  - Each segment has a frame whose Z runs along it.
  - Crossing a point turns the frame by the smallest rotation that takes the incoming segment's direction to the outgoing one. A straight continuation turns nothing.
  - A point's own frame is the incoming segment's frame turned by half of that rotation, so its Z is the bisector of its two segments: the point's `tangent`. The first point of an open strip takes the first segment's frame and the last point the last segment's.
  - This is the discrete parallel transport of Bishop's frame, as Discrete Elastic Rods defines it on a polyline. It is exact for the polyline: a planar curve never twists, and the turn after a closed lap is the area its segment directions enclose on the unit sphere.
  - The double-reflection method (Wang et al. 2008) is the usual recommendation for a smooth curve sampled coarsely. It was not chosen because the node has only the polyline, and on a polyline the rule above is the exact answer with exact tests. Resample upstream is how a smooth curve gets dense enough.
- **Seed.** The first segment's frame has Z along the segment and Y from the seed: `up` made perpendicular to Z, or the Y axis of the `seedOrient` quaternion made perpendicular to Z. With the seed along the segment, Y is the world axis least aligned with it. TouchDesigner's Input Seed Orientation is the attribute form.
- **Fixed Up** sets Y from `up` at every point, with no carrying. It is the frame for a road, a tunnel or a camera path, where up stays up and a loop must not leave a roll behind. Where the tangent runs along `up`, the point keeps the previous point's Y. sentinel-bot's `pathFrame` is this method.
- **Closing.** On a closed strip the carried frame arrives back at the first point turned by some angle about the tangent. With `closeTwist` on, each point is turned back by that angle times its `curveU`, so the seam matches. Sweep needs this. Neither product documents how it treats the seam.
- **Roll and Twist** are applied last: `roll` (plus the mapped attribute) and `twist × curveU` about the tangent. They are TouchDesigner's Roll and Twist on the Sweep SOP, and Notch's Radial Rotation Offset and the bank its cloner follows.
- **A strip of no length** has no direction: its frame is the seed's and its metrics are zero. Nothing divides by a zero length.

### 3.5 Which curves keep their length

A tentacle, a cable or a spine has a fixed length. The consumer's finding (shaderloom-f1, `24efa324`): a cubic through the same control points "stretched the rings to twice their pitch".

| Curve | Its length | Stations by distance |
|---|---|---|
| Arc, Arc Chain | an input, exact | closed form, no scan; neighbouring stations are equal chords |
| Linear | the sum of the chords, exact | exact to the float sum |
| Catmull-Rom, Cardinal, B-Spline, Bezier | whatever the control points make it; it changes as they move | even after Resample, but the count or the pitch has to give |
| A rope's output (T1585b) | held by the solver, to its stretch limit | Curve Frames measures it |

- A body of fixed length is an Arc, an Arc Chain or a rope. A spline is for a path whose length is free.
- The polyline through `n` stations of an arc is shorter than the arc by a factor `sinc(turn ÷ (2(n − 1)))`: 0.02% for sentinel-bot's 54 rings at its tightest bow.

### 3.6 Small nodes

- **v1**: none beyond section 3.1. Trim is Resample's range. "Sample the tip" is Resample with a count of 1.
- **Follow-ups, named in 7.2**: Reverse, Smooth, Simplify, Join, Duplicate, a trim that keeps the input's own points, resample by an attribute (TouchDesigner's Points as Keyframes: the same search over any rising attribute, with no scan).

## 4. GPU strategy

### 4.1 Per node

"Short" is a strip of at most `BLOCK` = 1024 points; "long" is any longer one. Dispatch counts are per frame.

| Node | Short strips | Long strips | Scratch |
|---|---|---|---|
| Topology | no pass | no pass | none |
| Curve (every basis, Arc, Arc Chain) | 1 pass, one thread per output point | the same | none |
| Resample, Even Parameter | 1 pass, one thread per output point | the same | none |
| Resample, Even Length and Distance | 1 walk + 1 pass per output point | 3-pass scan + 1 pass | one f32 per input point; totals per strip |
| Resample, Curvature | the same, with the density folded into the walk | the same | the same |
| Curve Frames | 1 walk | 3-pass scan | long strips only: one quaternion and one f32 per point; totals per block and per strip |

### 4.2 The walk

Arc length is a running sum and a carried frame is a running product of rotations. Both depend on everything before a point.

- **One invocation per strip walks its strip in order.** It reads positions, accumulates distance, carries the frame and writes each point's results. Strips do not share slots, so invocations never write the same word. No atomics, no barriers.
- The walk runs twice inside the same invocation: once to find the strip's length and its closing angle, which `curveU`, Twist and the closing need at every point, and once to write.
- It is the definition, not an approximation of one: the order is left to right, the same on every device, and the CPU reference is the same loop.
- It is parallel across strips. Ten tentacles are ten threads; four thousand hairs are four thousand.

**The alternatives, and why the walk is first:**

| Strategy | Depth | Dispatches | Why not first |
|---|---|---|---|
| Walk per strip | `cols` steps | 1 | chosen for short strips |
| Log-step doubling over the whole pointset | log2(`cols`) | log2(`cols`), each a full pass with a swap | six to twelve submissions where one does; a tree order no CPU loop reproduces without mimicking it |
| Scan in workgroup memory, a workgroup per strip (compaction's own scan) | log2(`cols`) | 1 | strips of at most 256 only, a tree order, and unequal strips do not fit a fixed workgroup. It is the measured fallback (D5) |
| On the CPU | n/a | 0 | right for an authored curve read by a follower (5.3); a GPU-resident curve would need a readback every frame |
| Each point re-walks its strip in a kernel | `cols` | 1 | `cols²` loads per strip; the substeps assessment's alternative 4 |

### 4.3 Long strips

A strip longer than `BLOCK` is cut into blocks of `BLOCK` points, in three passes:

1. one invocation per block walks its block from a zero distance and an identity rotation, writes each point's local result, and writes the block's totals (its length; its composed rotation);
2. one invocation per strip walks its blocks' totals in order and writes each block's starting distance and rotation, the strip's length and its closing angle;
3. one thread per point adds its block's start to its local distance, composes its block's start rotation with its local one and the seed, and applies close, roll and twist.

- A step of the frame's walk is a rotation and rotations compose associatively, so cutting the product into blocks is exact up to rounding.
- For a strip of at most `BLOCK` points the block is the strip, passes 2 and 3 do not exist, and the result is the walk's, bit for bit. So short strips are a true prefix of the long form.
- `BLOCK` is fixed when the first walk ships. Changing it later would change the rounding of long strips.
- One strip of 1,000,000 points is 977 block walks of 1,024 steps and one walk of 977 totals.

### 4.4 Resample's search

Each output slot computes its own station (a multiplication, never an accumulated sum), binary-searches its strip's cumulative lengths for the segment that holds it, and interpolates. This is Laser Path's emit pass, with a strip's range as the search bounds.

- At most `ceil(log2(cols))` steps, a fixed loop bound.
- No scatter and no compaction: an output slot knows its strip and station by division.
- One generated pass interpolates the whole packed layout word by word, as compaction's scatter copies it.

### 4.5 Costs (measured for slices 3 and 4)

Dawn/Metal, best of 9 runs of 200 frames, each figure the difference from the same graph without the node, in ms per frame. A plain per-point kernel over the same points measured 0.05 ms at 100,000 and 0.16 ms at 1,000,000.

| Points | Strips × points per strip | Curve Frames, all eight attributes | Curve Frames, metrics only | Resample, Even Length | Resample, Even Parameter |
|---|---|---|---|---|---|
| 2,160 | 40 × 54 (sentinel-bot) | 0.06 | | 0.03 | 0.01 |
| 100,032 | 1,563 × 64 | 0.03 | | | |
| 100,000 | 400 × 250 | 0.21 | 0.03 | 0.05 | 0.01 |
| 100,352 | 98 × 1,024 | 1.21 | 0.45 | 0.08 | 0.01 |
| 1,000,000 | 4,000 × 250 | 0.84 | 0.20 | 0.23 | 0.16 |
| 999,424 | 976 × 1,024 | 1.26 | 0.57 | 0.35 | 0.14 |

- **The walk's cost follows the strip's length, not the number of strips.** Ninety-eight strips of 1,024 points cost what 976 of them do: strips run in parallel, and the price is the depth of one walk, about 0.6 µs a point for Curve Frames, twice over. A thousand short curves are free; one long curve is what costs, at most about 1.2 ms for a strip of one whole block.
- That is the measurement D5 asked for, and it kept the walk: the alternative buys depth, which only long strips need, and cannot hold a strip over 256 points.
- The length walk alone is one square root and one add a step: under 0.1 ms for a block of 1,024. Curve Frames' cost is its frame arithmetic, not the walk's shape.
- The figures at 2,160 points are at the submission floor and are noise-limited.
- Not measured: Curve, long strips (slice 6), and a chain's total.
- Memory: Resample owns every attribute of its output. Curve Frames owns 32 bytes a point (80 with the vectors). The scans' scratch is 4 bytes a point for Resample and 20 for long-strip frames.

### 4.6 Limits

- `rows × cols ≤ 1,000,000`, and the packed size bound, as for every pointset.
- Curve: at most 64 authored control points; any number wired. Arc Chain: at most 16 sections per strip.
- Storage bindings: Resample binds one buffer per upstream producer it reads attributes from, plus its scratch and its output, against the baseline of 8 per stage (§V588). A chain of by-reference attributes from many producers refuses by name, as a kernel does.
- Curve nodes run along U only (R6).

### 4.7 Determinism, seek and offline

- **No state.** Every curve node is a pure function of this frame's input pointset and parameters. None declares `stateful`, so there is nothing to reset on a seek and nothing that diverges if skipped (§V170, §V155). A simulated input upstream (a rope, a kernel with state) carries its own rule.
- **No clock.** None reads `ctx.time`, `ctx.absTime` or a frame index, so §V436's choice of clock does not arise. Motion arrives through the input or through driven parameters.
- **No randomness** and no atomics. Every loop has a fixed bound. Every order is a function of slot index (§V74's argument).
- **No frame-mode branch** in any GPU pass, so realtime, fixed-step and offline run the same passes (§V662). The one place a mode matters is the measured curve for a follower (5.3), which follows Analyze: fire and forget when realtime, awaited when `mode !== "realtime"`, so the lag is one frame every time (§V735) and its age is published (§V329).
- **Across devices**, `sqrt`, `length`, `acos` and the trigonometry are not bit-specified by WGSL, as for every float kernel in the engine. Tests use fixtures whose results are exact, or state the closed form (section 6).

## 5. Consumers

### 5.1 Instancing along a curve (T1581b)

```
curve (basis: catmull-rom, segments: 16)
  ─▶ resample (method: distance, distance: 0.25, maxPoints: 256, offset: <expression>)
  ─▶ curveFrames (method: minimise twist, up: 0, 1, 0)
  ─▶ geometry.points
meshFileIn (frame: object) ─▶ geometry.mesh

geometry: mode instances, shape mesh
  orient             = map(orient)                         or: aim = map(tangent), up = map(normal), forward +Z
  group              = p.live > 0.5
  instanceAttributes = along = distance                    a material's struct Instance { along: f32 }
```

- No special node. This is TouchDesigner's Copy POP on a line strip and Notch's Spline Cloner.
- Notch's cloner parameters are here by name: Spline Offset is `offset`, Spline Use Amount is the range, Spline Time Mode is `spacing`, Align To Tangent is `orient`, Use Bank is `roll`, Scale Clones By Spline is the control points' `scale` attribute mapped to Scale.
- Before T1581b lands the same chain draws boxes, which is what sentinel-bot does today.
- Lights along a curve (T1589b) take the same pointset.

### 5.2 Sweep (T1587b)

```
curve ─▶ resample (count) ─▶ curveFrames ─▶ sweep (profile: ring, 24 sides; radius; caps) ─▶ geometry (surface)
```

What Sweep reads, all of it already on the edge: the strips (`cols`, `rows`, `closed`), `position`, `orient`, `distance` or `curveU` for the texture coordinate along the length, and an optional per-point radius.

- Padding sweeps to rings of no length and triangles of no area. Sweep needs no count.
- A closed strip closes the tube along its length, and `closeTwist` makes the seam's profile meet itself.
- Twist and roll are Curve Frames' parameters, so Sweep has none of its own, and a sweep and the instances beside it agree.
- **For T1587b's design**: a sweep of several strips is several separate sheets, and one `grid:` claim would join each tube's end to the next tube's start. That row needs either a mesh claim with a generated index list (which also allows caps and hard-edged profiles) or a sheet-aware grid claim. Nothing in the strips representation changes either way.

### 5.3 A path follower on the value graph (T1590b)

**The problem.** A value node runs on the CPU every frame. A curve's points are in a GPU buffer. Reading them back every frame is the stall §V144 forbids.

**What the two products do.** Neither reads a GPU curve from a CPU follower for free. TouchDesigner's path is a SOP, CPU geometry; a POP has to be downloaded first, "immediate (Slow)" or "nextframe (Fast)". Notch's follower takes a Spline node, whose control points are authored or are Nulls on the CPU, and Notch documents latency for transforms that come from the GPU (the reference, Notch §2).

**The answer: a curve has a CPU definition whenever its control points are known to the CPU.**

- **`src/points/curve.ts`** (new, headless, no GPU) holds the reference functions: evaluate a basis, solve an arc, accumulate length in the walk's order, resample, carry a frame. They are the definition the GPU passes are tested against (as `compactReference` is for compaction), and the follower calls them.
- **A Curve with an authored table is readable by name.** The follower names the Curve node (a source reference, as a Geometry names its material), resolves that node's parameters through the one parameter read path, and evaluates the reference at its own position along the curve.
  - No latency, no readback, scrub-accurate, the same in every frame mode.
  - The same node feeds the GPU strip that a sweep or a set of instances is built on, so the camera and the tunnel cannot drift apart. sentinel-bot's `path.ts` keeps that property today by emitting one function in two languages.
- **A Curve whose control points are wired from the GPU** refuses the follower by name in v1, saying the control points are computed on the GPU and how to author them.
- **The measured curve is a named follow-up.** The curve's points are read back between frames through the seam Analyze uses. What arrives late is the curve's *shape*; the follower still evaluates at this frame's position. For a curve that does not move, late is exact. For one that moves, the lag is one frame and stated.

**What T1590b's node looks like from here** (its own design decides): `curve` (name), `position` (0 to 1, or metres), `timeMode` (Knots or Length, Notch's two), `lookAhead`, `bank`, and whether heading comes from Fixed Up or the carried frame. It publishes position, an aim and an up as channels, which a Camera's `eye` and `lookAt` or T1588b's transform read by expression. Normalising a tangent happens inside the node, which is the row's own point about `sqrt`.

### 5.4 Rope (T1585b)

```
(rest strips: a kernel, a Curve, a Line) ─▶ rope ─▶ curveFrames ─▶ geometry (instances) or sweep
```

- The rope reads its strands through `stripsOf`. Its links are stations, its anchors are stations 0, 1 and `cols − 1`, and its colour for a red/black pass is `i & 1` (a closed strand with an odd count needs a third colour at the seam, which is that row's concern).
- Its output keeps the claim, so Curve Frames, Resample, Sweep and instancing take a simulated rope exactly as they take an authored curve.
- Padding has zero rest length and stays collapsed.
- Rest lengths are the input's segment lengths; Notch's Rest Length Scale multiplies them.
- **A named limitation.** Curve Frames derives the frame each frame from the seed and the rope's current shape. A real rope carries twist as state. Until a solver does (follow-up), a swinging rope's rings can turn about its axis as its shape changes. Notch's rope is on line geometry with no twist either.

### 5.5 sentinel-bot's tentacles

**Today** one kernel (`jointKernel`, about 260 lines of WGSL) does three jobs for each of 63 stations of each tentacle.

- It decides: the robot's frame, the gait and the planted rung, the hold solve (`halfTurn`), the trailing bend, and the blend between holding and trailing.
- It places stations along arcs (`arcAt`, `along`, `turned`), and stows slack rings at the socket.
- It builds frames (`tangent`, `normal`, `binormal`, `quatFromFrame`), a ripple, and the claw's eight phalanges from the tentacle's end frame.

**What the family takes over, in the order the pieces land:**

1. **Frames** (slices 1, 3 and 4). The kernel writes positions for the rings and the hub only, 55 stations a strip. A Topology node claims `strips:55x{tentacles}`. Curve Frames writes `orient`, with Up mapped from the bend plane's direction at each strip's first point and Roll 90 for the kit's axes (R5). The kernel marks its stowed rings by writing `live` itself, under the same contract (R4). The hub is Resample with a count of 1 at the end of each strip: one point per tentacle carrying the end frame. `quatFromFrame` and the per-station frame arithmetic leave the kernel.
2. **Stations** (slice 8, Arc Chain). The holding arc and the trailing pair of arcs are each two sections' curvatures and a start frame, and the blend is a blend of those numbers. The kernel writes them once per tentacle. Curve places the curve; Resample by Distance (pitch 0.06, 54 slots, anchored at End) puts the rings on it and pads the stowed ones at the socket. `arcAt`, `along`, `turned` and the stow test leave the kernel.

**What it does not take over:**

- **The single Arc is not enough for this rig**, because its tentacles blend between holding and trailing and a blend needs both in one form. Arc serves a body that only holds, and cables. This is the argument for Arc Chain in v1 (D8).
- **The claw.** Each phalanx is the end frame composed with a hinge. With T1582b one kernel reads the hub pointset. Without it, each phalanx kind is a small kernel over the hub pointset with its own Geometry, which is T1581b's "K variants are K Geometry nodes over one points producer".
- **The decisions**: the gait, `halfTurn` (the kernel needs the curvature to blend it), the blend's weights, and the ripple, which becomes a small kernel after Curve Frames that moves each point along its `normal` and `binormal`.

## 6. Tests

On Dawn through the compiler and the backend, red-verified, with the wire-cut case where a wire or a mapped parameter is involved. Values are exact where the fixture allows it. Where a result is irrational the test states the closed form and compares at single precision, as `point-proximity.gpu.test.ts` does; no bands (§V147). Every GPU result is also compared with `curve.ts`.

**Strips**

- A kernel after a Topology node (Strips, 4 × 3) writes `f32(ctx.dim.i)` and `f32(ctx.dim.j)`: every slot reads back its station and strip. Line and Circle publish their claims; a Surface geometry refuses a strips edge by name.
- `stripsOf` (headless): the three kinds, a closed strip, a grid's rows.

**Curve**

- Linear through (0,0,0), (4,0,0), 4 segments: x is exactly 0, 1, 2, 3, 4.
- Catmull-Rom and Cardinal return every control point exactly at span starts; collinear, evenly spaced control points give exactly the line.
- B-Spline at a knot is `(P0 + 4·P1 + P2) ÷ 6`: (5, 1, 0) for (0,0,0), (6,0,0), (6,6,0). Bezier at the middle of a span is `(P0 + 3·C0 + 3·C1 + P1) ÷ 8`, exact for integer points.
- Arc: with `arcLength` equal to the chord the stations are exactly `k × chord ÷ segments` along it. With slack: the first and last stations are the control points; every neighbouring pair is the same distance apart; the summed distance is `L × sinc(φ ÷ segments)`; `curvature` from Curve Frames is `2φ ÷ L` at every interior point. Flip `bow` and the arc mirrors through the chord. Out of reach, the end is `arcLength` along the chord.
- Wire cut: with the control input cut, the authored table's curve appears and not the wired one.
- Arc continuity: with the bow kept off the chord, halving the step by which an end moves at least halves how far every station moves (the shape of `src/projects/sentinel-bot/rig.gpu.test.ts`). The control is a bow swept through the chord, which jumps.

**Curve Frames**

- A straight line along +X, Up +Y, with `vectors` on: `tangent` (1,0,0), `normal` (0,1,0), `binormal` (0,0,1), exactly; `distance` exactly `k × spacing`; `curveLength` exact; `curvature` exactly 0.
- A regular polygon in the XY plane, closed, Up +Z: `normal` is (0,0,1) at every point (no twist on a planar curve; exact in the reference's quaternion form, because every rotation's axis is the normal itself), the closing angle is 0, and `curvature` is the circumscribed circle's.
- The same polygon with Up in its plane: `normal` stays in the plane (z exactly 0) and perpendicular to `tangent`.
- A polyline along +X, +Y, +Z with unit segments: the frame on the last segment is the one two quarter turns give, by hand.
- A helix sampled at an even angle step `h`: relative to the helix's own principal normal the carried `normal` turns by `2·atan(cos β′ · tan(h ÷ 2))` at each point, where `β′` is the angle between the segments and the axis. This is the closed form of the discrete transport; its limit as `h → 0` is the textbook torsion times arc length.
- A closed, non-planar polygon with integer corners: the closing angle equals, up to whole turns, the area its segment directions enclose on the unit sphere (the spherical excess of that polygon), computed in the test. With `closeTwist` on, the frame after the last segment equals the first frame; with it off they differ by that angle.
- Seed: Orient Attribute reproduces the attribute's frame at the strip's first point when its Z is along the first segment; a second strip with another seed is unaffected. Roll 90 puts `normal` where `binormal` was; Twist 360 on a straight line brings the last point's `normal` back to the first's, and Twist 180 reverses it.
- Padding: a strip whose last three slots repeat its end has the end's frame and distance on all three, and the same `curveLength` as the strip without them.
- Fixed Up on a curve that passes through vertical keeps the previous `normal` there and has no NaN.
- Instancing equality (R5): an asymmetric shape instanced by `orient` covers the same pixels as by Aim = `tangent`, Up = `normal`, Forward +Z. Cut the Orient map and the shapes stand unturned. *Built so far: the Orient half (quads strung along +X face a camera on +X when mapped and are edge-on when cut). The equality with Aim and Up is owed when T1581b's slice D lands.*

**Resample**

- A straight line of length 4, Distance 0.5, `maxPoints` 16: positions exactly `k × 0.5` for k = 0…8; `live` 1 on 9 slots and 0 on 7; the padding sits exactly on (4,0,0).
- Anchor End, Distance 0.75 on the same line: the last slot is exactly on the end, live stations step back by 0.75, and the padding is at the head, on the first live station (0.25, 0, 0).
- Over budget: Distance 0.1 with `maxPoints` 5 gives five live points at exactly 0, 1, 2, 3, 4.
- Count 5, Even Length, on a polyline with segments of 1 and 3: x exactly 0, 1, 2, 3, 4. Even Parameter on the same input: exactly 0, 0.5, 1, 2.5, 4.
- A closed unit square, Distance 0.5: eight live points, on the corners and the edge midpoints.
- Range 0.25 to 0.75 with Count 3 on the length-4 line: exactly 1, 2, 3. `offset` 0.25 with Distance 0.5: every station moves by exactly 0.25.
- Attributes: an f32 that is 0 and 8 at the ends reads exactly `2 × x`; a u32 reads the earlier point's value.
- Two strips of different length in one pointset resample independently: each has its own `live` run.
- Count 1 with `rangeStart = rangeEnd = 1` after Curve Frames: one point per strip, bit-equal to the strip's last point in every attribute.

**Whole chain**

- Seek: frame N rendered directly equals frame N after frames 0 to N−1, byte for byte, for Curve → Resample → Curve Frames under an animated control point.
- A long strip (2,500 points, when slice 6 lands): every point's `distance` and `orient` equal the CPU reference run in the blocked order, and a strip of 1,024 points reads back byte for byte what it read before the slice.
- Headless definition tests for every refusal sentence: a `points` edge into each node, Bezier without handles, a mismatched attribute type, the binding budget, a follower on a wired Curve.
- The measurements of 4.5, reported.

## 7. Build plan

### 7.1 Slices

Each is shippable, and each is a prefix of the final design: the claim, the attribute names, the frame convention and the walk's order are fixed by the slice that introduces them and are not revisited.

| | Slice | Contents | What it unblocks |
|---|---|---|---|
| 1 | Strips | the `strips:` claim, `stripsOf`, `ctx.dim` on strips, Topology: Strips, Line and Circle claims; `src/points/curve.ts` begins | a kernel can address curves; T1585b can start against the real claim |
| 2 | Curve | Linear, Catmull-Rom, Cardinal, B-Spline, Bezier, Arc, from a wired control set | splines; cables and bodies that only hold |
| 3 | Curve Frames | metrics, Minimise Twist and Fixed Up, the seeds, roll, twist, closing; strips up to `BLOCK`; the measurement that fixes the scan (D5) | instancing along a curve with `orient` |
| 4 | Resample | Count (both spacings) and Distance, with anchor, offset, range and `live`; strips up to `BLOCK` | exact pitch, stowed rings, the tip pointset, lights along a tunnel; sentinel-bot step 1 (with slices 1 and 3) |
| 5 | Authored curves and drawing | the authored table and the CPU reference as the Curve's second reader; Beam mode takes a strip's next point as its far end when Endpoint is empty | T1590b; a curve visible as a line with no kernel |
| 6 | Long strips | the blocked scan for Curve Frames and Resample | one curve of 100k points and more |
| 7 | Resample by curvature | the density measure | fewer points on straights |
| 8 | Arc Chain | sections by length and curvature | sentinel-bot step 2; tails, stems, antennae |

- Slices 2, 3 and 4 depend only on slice 1.
- **Build order, from the consumer's review**: slices 1, 3 and 4 together first, because they are what removes the consumer's frame code (built); then slice 2; Arc Chain last.
- Slice 5's Beam change is in `scene.ts`, which T1581b and T1588b are editing, so it is scheduled after the mesh-instancing slices. It has a second consumer, a debug spine for a rig. Until then a five-line kernel writes each point's successor into an attribute and Beam draws it, with no engine change.

### 7.2 Accepted limitations, as follow-up rows

| | Row | Why it is not in v1 |
|---|---|---|
| C1 | Qualifiers ride the pointset edge; Resample then blends quaternions properly and renormalises directions | a change to the edge payload (T287's second half), wider than curves. TouchDesigner identifies rotation attributes the same way |
| C2 | A measured curve for a follower: a GPU-computed curve read back one frame late | needs the Analyze seam for point buffers; its own latency tests |
| C3 | A typed control-point list parameter and a curve editor in the viewer, with handles and Notch's tangent modes | a new parameter type and an editor surface |
| C4 | Curves from files: glTF line primitives, and a mesh's edge loops, decoded into strips | decoder work; needs a consumer |
| C5 | A ragged or indexed line claim for line soups and sets of very unequal curves | the general model TouchDesigner has; no consumer needs it yet |
| C6 | Reverse, Smooth, Simplify, a trim that keeps the input's points, resample by an attribute | each is one pass; none blocks a consumer |
| C7 | Join and Duplicate | need a Merge and a Copy node (T866's first hole; T1581b's F16) |
| C8 | Curve nodes along V (a transpose) | R6 |
| C9 | Deform a mesh along a curve, and look an attribute up along a curve | a kernel must read a second pointset, T1582b |
| C10 | Trails: a point history as strips, one per point | a stateful producer of the same claim; TouchDesigner's Trail POP adds a dimension the same way |
| C11 | Twist as rope state | T1585b's follow-up; 5.4 |
| C12 | Budget and length readouts as channels, and a measured over-budget warning | the point-to-scalar reduce (T866's second hole) |
| C13 | Resample: Cardinal interpolation of position; Curve: quadratic Bezier, a control-polygon Bezier layout, weights | TouchDesigner has them; a dense Curve upstream covers the first |
| C14 | The pointset tile draws strips as lines | preview only |
| C15 | Dead strip points cost nothing in an instanced draw | T1581b's F1 |

### 7.3 Decisions, as ruled

**All twelve were ruled as recommended on 2026-10-05.** Each is kept below with the alternative that was not taken. D5's measurement is in section 4.5: the walk stays, at a block of 1,024.

- **D1. The representation.** Recommended: fixed-stride strips with the claim `strips:{cols}x{rows}[:closed]`, and a grid's rows counting as strips (R1, R2). Alternative: a per-point curve id with an info buffer, as TouchDesigner's primitives.
- **D2. Variable length.** Recommended: padding copies plus a per-point `live` (R4), and no use of the edge's `count`. This differs from one sentence of the mesh-instancing design (2.6). Alternative: a per-strip counts buffer named in the claim.
- **D3. The frame convention.** Recommended: +Z along the tangent, +Y the normal, as T1581b's Forward and Up (R5). sentinel-bot's kit differs by a quarter turn about Z.
- **D4. One publisher.** Recommended: only Curve Frames writes tangents, frames and distances; Curve and Resample write none, and Resample runs before it. Alternative: Curve publishes analytic tangents and Resample its exact stations, at the price of two answers to "how far along is this point".
- **D5. The scan.** Recommended: the per-strip walk with `BLOCK` = 1024, and the blocked form for longer strips, with the order frozen in slice 3 after the measurement at 100k and 1M points. If the walk measures badly at high strip counts, the workgroup scan replaces it before anything depends on its bytes.
- **D6. Over budget.** Recommended: Resample by Distance widens its spacing and covers the whole curve. Alternative: cut the curve at `maxPoints`.
- **D7. The CPU reader.** Recommended: authored control points on the Curve node, uploaded as a capped uniform table and evaluated on the CPU by the same reference; a GPU-computed curve reaches a follower by a one-frame-late readback as a follow-up (5.3). Alternative: a separate CPU path node that the follower and a GPU producer both read.
- **D8. Arcs.** Recommended: Arc (one arc per span, with a length) in slice 2, and Arc Chain as slice 8 of v1, because the consumer's trailing state and blend need it and it is exact and scan-free. Alternative: Arc Chain as the first follow-up row.
- **D9. Frame transport.** Recommended: transport along the polyline (3.4), exact for the data the node has. Alternative: double reflection (Wang et al.), more accurate for a coarsely sampled smooth curve and without closed-form tests on a polyline.
- **D10. A `points` edge into a curve node.** Recommended: refused by name, with the Topology node as the fix. Alternative: read as one strip in slot order, as Laser Path reads its input.
- **D11. Names.** Node types `pointCurve`, `pointResample`, `pointCurveFrames` with titles Curve, Resample, Curve Frames; the attribute names of R3; the parameter keys of section 3. "Curve" is also the name of a 1D parameter type and of TouchDesigner's lookup-curve POP; "Spline" is Notch's word and wrong for an arc.
- **D12. Beam draws a strip** in this row (slice 5), in `scene.ts`. Alternative: leave drawing to the kernel idiom and the preview follow-up.

### 7.4 As built: what changed from this design in slices 1, 3 and 4

Names as built: node types `pointCurveFrames` (Curve Frames) and `pointResample` (Resample); attributes `orient`, `tangent`, `normal`, `binormal`, `distance`, `curveU`, `curveLength`, `curvature`, `live`; the claim `strips:{cols}x{rows}[:closed]`. All as designed.

**Slice 1**

- The Circle generator publishes an open strip, not a closed one (3.1).
- `src/points/curve.ts` begins with slice 3, not slice 1: slice 1 has nothing for it to define.

**Slice 3, Curve Frames**

- The frame is carried as two vectors (a direction and a normal) and re-squared at every point; the quaternion is made once per point. The design said "a running product of rotations". The vectors are what make a straight run and a planar curve exact to the bit. For slice 6 it means a block's total is still one composed rotation (4.3), applied to a walk that stays in vectors inside each block.
- A segment counts as having no length at a squared length of 1e-14 or less (1e-7 metres).
- An exact reversal (a curve doubling straight back) has no smallest rotation: the frame turns about its own normal, so the tangent swings round and the normal stays.
- A strip of no length takes the tangent +Z (or the seed quaternion's +Z) and the seeded normal: the identity quaternion for Up +Y.
- A mapped Roll attribute is in degrees, like the parameter. A mapped Up is read at each strip's first point under Minimise Twist and at every point under Fixed Up.
- Fixed Up ignores Close Twist: a frame that depends only on position already meets itself.
- The node passes a live count through, as Gather does.

**Slice 4, Resample**

- Padding repeats the nearest live *station*, which under an Offset or the End anchor is not the curve's own end (the design's anchor test said the curve's start).
- Count publishes no `live`, and no Resample carries its input's `live`: each decides which of its own slots are live.
- Even Parameter over an input that carries `live` is refused by name: it would count padding as points.
- A counted input is refused by name: the slots past a count are not padding.
- Offset is inactive under Even Parameter. On an open strip by Count, a station slid past an end waits at the end.
- A closed strip used whole ignores Anchor: its stations start from its first point and go round.
- The output always claims `strips`, also from a grid.
- The node's buffer is laid out as `position`, the other attributes by name, then `live`.
- The Method menu has Count and Distance; Curvature is appended in slice 7.
- The whole-chain seek test runs Resample → Curve Frames over a moving kernel, since the Curve node is slice 2.

**Owed**

- The instancing-equality test (`orient` against Aim and Up) needs T1581b's slice D.
- Kind words for T1593b's table: `frames` for `pointCurveFrames`, `resample` for `pointResample`, and `curve` for `pointCurve` when it lands.

## 8. Found on the way (not fixed, not in scope)

- Line Points and Circle Points published `points` although their slots are in curve order (fixed by slice 1).
- The Circle generator's last point repeats its first (the angle runs to a full turn inclusive), so a circle of N points has N − 1 distinct ones and draws its first point twice. One point per step and a closed claim would be the consistent form, as the Tube and the Torus already do on their wrapped axes; it moves the points of existing documents, so it needs a ruling.
- `docs/pop-gap-analysis.md` still says the Box generator is missing; `point-generators.ts` has shipped it since T1057.
- `quatFromFrame` is written out twice in `src/projects/sentinel-bot/rig.ts` (the joint kernel and the rib kernel). T1581b's F9, a quaternion module for kernels, is where it belongs.
- The Topology node's `cols` and `rows` labels read "Columns" and "Rows"; under Strips they mean points per strip and strips, which the descriptions will have to say.

## 9. Sources

The reference survey: `docs/td-notch-mechanisms-2026-10-05.md`. The neighbouring design: `docs/mesh-instancing-design-2026-10-05.md`.

TouchDesigner (Derivative), read here:

- Learning About POPs: https://docs.derivative.ca/Learning_About_POPs
- POPs, the operator list: https://docs.derivative.ca/Category:POPs
- Line POP: https://docs.derivative.ca/Line_POP
- Line Divide POP: https://docs.derivative.ca/Line_Divide_POP
- Line Resample POP: https://docs.derivative.ca/Line_Resample_POP
- Line Metrics POP: https://docs.derivative.ca/Line_Metrics_POP
- Line Break POP: https://docs.derivative.ca/Line_Break_POP
- Line Smooth POP: https://docs.derivative.ca/Line_Smooth_POP
- Line Thick POP: https://docs.derivative.ca/Line_Thick_POP
- Topology POP: https://docs.derivative.ca/Topology_POP
- Dimension POP: https://docs.derivative.ca/Dimension_POP
- Trail POP: https://docs.derivative.ca/Trail_POP
- Skin POP: https://docs.derivative.ca/Skin_POP
- Extrude POP: https://docs.derivative.ca/Extrude_POP
- Copy POP: https://docs.derivative.ca/Copy_POP
- Curve POP: https://docs.derivative.ca/Curve_POP
- Lookup Attribute POP: https://docs.derivative.ca/Lookup_Attribute_POP
- POP Rotations: https://docs.derivative.ca/POP_Rotations
- POP to SOP: https://docs.derivative.ca/POP_to_SOP
- Sweep SOP: https://docs.derivative.ca/Sweep_SOP
- Resample SOP: https://docs.derivative.ca/Resample_SOP
- Null COMP, the Xform page: https://docs.derivative.ca/Null_COMP

Notch (10bit FX), manual 2026.2, read here:

- Spline: https://manual.notch.one/2026.2/en/docs/reference/nodes/3d/spline/
- Spline From Nulls: https://manual.notch.one/2026.2/en/docs/reference/nodes/3d/spline-from-nulls/
- Spline Extruder: https://manual.notch.one/2026.2/en/docs/reference/nodes/3d/spline-extruder/
- Spline Cloner: https://manual.notch.one/2026.2/en/docs/reference/nodes/cloning/spline-cloner/
- Spline Follower: https://manual.notch.one/2026.2/en/docs/reference/nodes/modifiers/motion/spline-follower/
- Spline Deformer: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/splines-and-lines/spline-deformer/
- Object To Lines: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/splines-and-lines/object-to-lines/
- Duplicate Splines: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/splines-and-lines/duplicate-splines/
- Simplify Spline: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/splines-and-lines/simplify-spline/
- Spline Extend: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/splines-and-lines/spline-extend/
- Rope Deformer: https://manual.notch.one/2026.2/en/docs/reference/nodes/deformers/physics/rope-deformer/

Method references:

- Bishop, "There is more than one way to frame a curve", American Mathematical Monthly 82(3), 1975.
- Bergou, Wardetzky, Robinson, Audoly, Grinspun, "Discrete Elastic Rods", ACM Transactions on Graphics 27(3), 2008, doi 10.1145/1360612.1360662 (discrete parallel transport on a polyline).
- Wang, Jüttler, Zheng, Liu, "Computation of Rotation Minimizing Frames", ACM Transactions on Graphics 27(1), 2008, doi 10.1145/1330511.1330513 (double reflection).
- Webster, Jones, "Design and Kinematic Modeling of Constant Curvature Continuum Robots: A Review", International Journal of Robotics Research 29(13), 2010, doi 10.1177/0278364910368147.
