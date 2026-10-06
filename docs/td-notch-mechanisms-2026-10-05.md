# How TouchDesigner and Notch do it: instancing, hierarchy, skeletons, curves, rope, environments, lights

**Date:** 2026-10-05. **Why:** the owner's standing rule for engine features (2026-10-05): "really consider how
this stuff works in Notch and TD and make sure we are not inventing brittle or non scalable unperformant hacks".
**Driving scene:** sentinel-bot (T1561b): robots with 10 tentacles of 54 identical rings and a hinged claw, climbing
an endless tunnel, many small lights. **Consumers of this file:** T1581b (mesh instancing), T1582b (kernel reads a
second pointset), T1584b (stock skinning), T1585b (rope), and the rows proposed in the last section.

Two read-only surveys of the official documentation produced the facts below. Every claim carries its URL.
"Not confirmed" and "not in manual" mean the survey found no statement; they are not proof of absence.
Anything marked *inference* is the surveyor's reading, not a documented fact.

## TouchDesigner (build 2025.33230)

URL shorthand: **D/** = https://docs.derivative.ca/ , **F/** = https://forum.derivative.ca/t/ . "[staff]" marks a post by
a Derivative staff account.

### 1. Mesh instancing

Geometry COMP, pages Instance / Instance 2 / Instance 3 (D/Geometry_COMP):

- Count: `instancing`, `instancecountmode` (Manual + `numinstances` | Instance OP(s) Length), `instanceop` (default
  instance OP), `instancefirstrow`.
- Each attribute has its own source OP plus channel pickers: translate `instancetop` + `instancetx/ty/tz`; rotate
  `instancerop` + `instancerx/ry/rz` (Euler); scale `instancesop`; pivot `instancepop`; `instanceactive` (zero = skipped).
- Order: `instxord` (6 SRT orders), `instrord` (6 rotate orders), `instanceorder` (Instance then World | World then Instance).
- Rotate to Vector: `instancerottoop` + x/y/z, `instancerottoforward` (±X/Y/Z), rotate up `instancerotupop`,
  `instancerottoorder` (Default | Pre-Rot | Post-Rot, each with its matrix formula).
- Texture coordinate `instancetexcoordop` U/V/W with `instancetexmode` Replace | Transform. Colour `instancecolorop`
  R/G/B/A with `instancecolormode` Replace | Multiply | Add | Subtract.
- `instancetexs` (many TOPs, mixed resolutions) + `instancetexindex`; a 2D array or 3D texture is selected by W instead.
- Custom: a sequence `instance0customop` + `instance0customx/y/z/w`.
- Sources: TOP (RGBA), CHOP (channels), SOP (attributes), DAT (columns). POPs: "Geometry Instancing is done in the same
  way as SOPs/CHOPs/DATs, where POP attributes can be used on the Instancing pages" (D/Learning_About_POPs). A default
  P/rot/scale/Color mapping for POPs is not confirmed: every parameter is an explicit pick.
- **No quaternion or matrix instance input.** [staff] "not possible out of the box" (workaround: Transform CHOP to
  Euler); matrices via a POP attribute or a CHOP transform-set are promised for 2026.20000
  (F/instancing-with-transform-matrix-attribute/936448).
- GLSL MAT (D/Write_a_GLSL_Material): `TDInstanceID()` (never `gl_InstanceID`), `TDInstanceMat()`, `TDInstanceMat3()`,
  `TDInstanceDeform()`, `TDInstanceTexCoord()`, `TDInstanceColor()`, `TDInstanceCustomAttrib0..3()`,
  `TDInstanceTextureIndex()`, `TDInstanceTexture()`. Custom attributes are "ignored in other materials such as the PBR
  MAT". Per-vertex POP attributes are declared on the MAT's Attributes page and read as `TDAttrib_Name()` ([staff]
  F/custom-attributes-in-mat-shader-confusion/556016).
- Skinned and instanced: `TDDeform()` "will internally call TDSkinnedDeform() and TDInstanceDeform()", result in world
  space. Bone data comes from one `skelrootpath` per MAT ([staff] F/accessing-pcaptdata-in-vertex-shader/263049), so a
  per-instance pose is not built in (*inference*).
- A geometry variant per instance: not confirmed as a feature.
- Picking: `instanceid` on D/Render_Pick_CHOP and D/Render_Pick_DAT. Shadows: Light COMP `shadowcasters` lists Geometry
  COMPs; GLSL MATs get `TD_SHADOW_MAP_RENDER` (D/Light_COMP). Per-instance frustum culling: not confirmed.

Data model: "hardware instances", one per sample, row, pixel or point; a TRS matrix built in `instxord`, composed with
the COMP's world transform. POP to CHOP "causes GPU to CPU to GPU copies" (D/Learning_About_POPs).

Limits: instance textures "on Windows at most 16384... on macOS at most 128". No instance-count limit is stated.

**Copy POP** (D/Copy_POP) makes real geometry on the GPU: one copy per template point. Its Template page names
attributes explicitly: `transformattr` (matrix), `translateattr`, `rotateattr` ("Euler angles or quaternions"),
`scaleattrib`, `pivotattr`, `vecattr` + `upattr`; it outputs `CopyId` and `TemplateId`. "Instance where possible, but
if you want to do anything with data after a copy, like deform it, use Copy POP."

### 2. Transform hierarchy and constraints

- The Xform page is on every Object COMP (D/Null_COMP): `xord`, `rord` (SRT = `T * R * S * Position`; xyz =
  `Rz * Ry * Rx`), `t/r/s/p/scale`; `parentxformsrc` (hierarchy | specify | worldorigin) + `parentobject`; `lookat`,
  `forwarddir`, `lookup` (off | on | quat | roll); path following `pathsop`, `pos` (0 to 1), `pathorient`, `up`, `bank`,
  `roll`; `xformmatrixop` (a 4x4 from a CHOP or DAT). Pre-Xform: `preXForm * xform * Position`.
- D/Blend_COMP: `parenttype` Blend (up to 4 parents, `blendw1-4`) | Sequence | Constrain.
- D/Object_CHOP: target against reference; `compute` Transform (Euler) | Transform (Quaternion) | 4x4 Matrix | 3x3
  Matrix | Measurements. D/Transform_CHOP: Euler, quaternion and matrix formats.
- Bones are Object COMPs; "each bone attaches to the end, not the origin, of the parent bone" (D/Bone_COMP).
- Following a point of another geometry: no constraint operator was found.

### 3. Skeletal deformation and IK

- Import: D/FBX_COMP (`pops` default On, Play page `animation`, `playmode`, `speed`, `cue`, `trim`); D/USD_COMP;
  D/glTF_In_COMP (added in 2025.33070): a skinned mesh gets a Skin Deform POP, animation an Import Select CHOP.
- Data (D/Deforming_Geometry_(Skinning)): POP attributes `BoneIndices[]`, `BoneWeights[]`, `BonePaths`,
  `BoneBindPoses`. Bone matrix = `WorldTransform * BindPose`, the world transform read from the bone COMP each frame.
- Where: Deform SOP is CPU. The MAT Deform page skins in the vertex shader, "very fast (practically free)".
  D/Skin_Deform_POP outputs deformed geometry.
- Limits: "most GPUs can only handle... between 50 and 200 bones in a single pass" survives on D/Skin_Deform_POP,
  flagged "needs to be updated". Weights per vertex follow the attribute array size.
- IK (D/Inverse_Kin_CHOP): `solvertype` none | rest | capture | inverse | constraint | **curve**; `boneroot`,
  `boneend`, `endaffector`, `twistaffector`, `iktwist`, `ikdampen`, `curve`. Follow Curve is "useful for... tails and
  spines". Solutions are "guaranteed to be continuous only for a given set of rest angles". Iteration count and
  chain-length limits are not documented.
- Blending: D/Clip_Blender_CHOP (Pro only), D/Blend_CHOP (quaternion mode). A recipe for layering a clip with
  procedural motion: not confirmed.

### 4. Curves, chains, geometry along a curve

- "There is no curve primitive, but linestrips can contain curve attributes" (D/Learning_About_POPs). D/Line_POP:
  `interpmethod` Linear | Cardinal | BSpline | Cubic Bezier With Tangents | Cubic Bezier | Quadratic Bezier.
- Equal arc length: D/Line_Resample_POP `resamplemethod` Divisions per Line Strip | Distance between Points | By
  Curvature | Points as Keyframes; `lsmaxverts`, `maxtries`.
- Frames: D/Line_Metrics_POP outputs Tangent, Curvature, Distance from Start, and (Orientation page, added
  2025.33070) Normal, Binormal, `quaternion`, `rotmat`, `transformmat`; `useinputorient` seeds the frame at each strip
  start. The frame algorithm is not stated.
- D/Sweep_SOP (CPU): `angle` (Angle Fix), `noflip` (Fix Flipping), `twist` cumulative, `roll` non-cumulative, `skin`.
- **There is no Sweep POP**, and D/Line_Thick_POP reads "This POP has been removed". What is left is a Copy POP onto a
  line-strip template, or D/Line_MAT (flat, "no affect from scene lighting").
- D/Lookup_Attribute_POP interpolates quaternions and transform matrices along a lookup curve.
- Trail: D/Trail_POP (`length`, `inc`, `attrmatch`, `surftype`, `orientationattrs`, `maxls`).

### 5. Rope, chain and tentacle dynamics

- Bullet (D/Bullet_Solver_COMP): "all bodies are rigid"; no substep or iteration parameter. D/Constraint_COMP: `type`
  p2p | hinge | slider. Poor below 10 cm.
- Flex (D/Nvidia_Flex_Solver_COMP): Windows only; "Actor COMP currently only supports fluid substances and static
  shapes", so no ropes, cloth or shape matching. "The last Nvidia cards that support Flex are the Nvidia RTX 40 series."
- POPs: D/Feedback_POP ("delayed by one cook cycle"), D/Particle_POP, D/Neighbor_POP (spatial hash). No constraint or
  spring POP, and no iterations or substeps on any of these pages. A user-built verlet soft body exists
  (F/volume-constraint-soft-body/553728).

### 6. Procedural environment in the same lit scene

- A tunnel has no official guidance. A tutorial Derivative hosts instances pieces oriented to a path with the camera
  along it (https://derivative.ca/community-post/tutorial/looping-noise-part-2-infinite-tunnel-zoom/62086).
- Depth pieces: D/Depth_TOP, Render TOP `numcolorbufs`, `depthformat`, `drawdepthonly` (D/Render_TOP),
  D/Render_Select_TOP, D/Render_Pass_TOP (reuses the prior depth and colour buffers). Camera matrices: Object CHOP 4x4,
  Camera COMP `.projection()`.
- Writing depth from a raymarch shader inside a Render TOP: not confirmed. The third-party RayTK composites with
  `Use Render Depth` (https://t3kt.github.io/raytk/reference/operators/output/raymarchRender3D).
- What a raymarched pass loses is not documented; `uTDLights[]` and the shadow functions are documented for MATs only,
  so a GLSL TOP gets neither (*inference*).

### 7. Many lights and reflections

- D/Light_COMP: `lighttype` point | cone | distant; `shadowtype` off | hard2d | soft2d | custom.
- Forward only: `TD_NUM_LIGHTS` is a compile-time define; shaders recompile per light count and are cached
  (D/Write_a_GLSL_Material).
- "You can use 100s of lights in your scene, as long as only a limited number of lights affect each individual object
  (using the Light Mask parameter)" (D/Phong_MAT_Shader_Resource_Usage). [staff] the light mask is "the only way" to cull.
- Deferred or clustered: none in the docs.
- D/Environment_Light_COMP (`envlightmap`, prefilter). Screen-space reflections: not confirmed. D/SSAO_TOP, D/Bloom_TOP.
- Fog: Camera COMP `fog` Linear | Exponential | Squared Exponential (D/Camera_COMP).

### 8. Camera rigs

- The Camera COMP has the shared Xform page (`lookat`, `lookup`, `pathsop`, `pos`, `bank`). D/Camera_Blend_COMP blends
  transforms and view settings of up to four cameras, with `shortrot`. Keyframes: D/Animation_COMP.

### 9. Control surface

- D/Custom_Parameters; D/Binding (the bind master holds the value); D/Bind_CHOP; D/Parameter_COMP; D/Widgets.
- D/MIDI_Device_Mapper_Dialog: "There is no auto-learn currently".
- Presets: the Palette Presets COMP "was dropped in Build 2022.29530". A current official preset or cue system: not confirmed.

## Notch (manual 2026.2)

URL shorthand: **M/** = https://manual.notch.one/2026.2/en/docs/ , **N/** = `M/reference/nodes/` , **L/** =
`M/learning/` , **W1** = https://manual.notch.one/2026.1/en/docs/whats-new/everything/ , **R1** =
https://manual.notch.one/2026.1/en/docs/whats-new/release-notes/1-0-0/ , **W2** = `M/whats-new/everything/`.
65 of the manual's 929 pages (all under `/reference/nodes/wip/`) return HTTP 401 and were not read.

### 1. Cloning

- Nodes: Grid, Radial, Linear, Random, Iterative, Mesh, Volume, Spline, Particle, Procedural, Image and Array Cloner,
  Paint Clones, Cloner Cache [N/cloning/].
- Common: `Node Spawn Mode` {All | Iterate | Random}, `Num Clones`, `Clone Scale`, the `UV Clone Deltas` group
  (per-clone UV scale, offset, crop), input `Effectors` [N/cloning/mesh-cloner/].
- Spline Cloner: `Spline Offset`, `Spline Use Amount`, `Spline Time Mode` {Knots | Length}, `Rotation Mode` {None |
  Align To Direction | Align To Tangent}, `Rotation - Use Bank`, `Scale Clones By Spline` [N/cloning/spline-cloner/].
- Array Cloner: one clone per `Transform Array` element, with rotations, scales and colours from the array
  [N/cloning/array-cloner/]. The array comes from Nulls, a Particle Root or JavaScript.
- Effectors (16): Plain, Randomise, Turbulence, Sine, Ripple, Target, Spring, Smoothing, Sound, Image, Colour Ramp,
  Quantise, Kill Box, Rigid Body, Continuous, Custom Shader [N/cloning/]. Each has `Blend Amount`, `Space`, a `Falloff`
  group (`Falloff Mode` {Off | Spherical | Cylindrical | Planar | Procedural | Cubic}, inner and outer range, easing),
  `Index-Based Weighting`, and per-channel `Position/Rotation/Scale/Object Index Apply Mode` {Add | Multiply | Replace}
  [N/cloning/effectors/plain-effector/].
- Model: a cloner clones its **child nodes**: 3D objects, **lights**, field, procedural and particle systems, other
  cloners; a Null groups a subtree into one clone [L/working-in-3d/cloners/]. Clones are "rendered using hardware
  instancing on the GPU", which "requires each mesh to be an identical copy" [N/cloning/].
- Per-clone state is GPU buffers: index, **object index** (which child), position, Euler rotation, scale, colour, UV
  scale, UV offset. An effector runs once per frame per clone, and killing a clone is an index write
  [N/cloning/effectors/custom-shader-effector/]. Effectors stack in graph order and are time independent except Rigid
  Body and Spring [N/cloning/].
- No per-clone material parameter is documented beyond tint, UV scale/offset and child choice.
- Limits: no instance cap is stated; the only number is "stability with 100,000+ rigid body clones" [W1]. Cloner Cache
  bakes transforms and colour only. Combine Geometry merges clones into one deformable mesh [N/3d/combine-geometry/].

### 2. Hierarchy and constraints

- The parent pin gives transform inheritance, with `Parent Transform` toggles per channel. Every node has three
  standard inputs: `Transform Modifiers`, `Target Node` ("always direct the z axis towards the input") and `Local
  Transform Override` [N/cloning/array-cloner/].
- Smoothing Null: `Adaption Rate`, `Shortest Rotation Arc` [N/3d/smoothing-null/].
- Parent To Vertex attaches children to a vertex, particle or blob; on particles it needs `Deterministic`
  [N/modifiers/motion/parent-to-vertex/].
- Spline Follower: `Spline Time`, `Rotation Follows Direction`, `Rotation Look Ahead Time`, `Use Matrix Rotations`
  (avoids gimbal lock), `Fix Heading Flips` [N/modifiers/motion/spline-follower/].
- Imported bones are real sub-nodes and "other nodes from outside of the imported scene may be connected to them"
  [N/3d/3d-scene/].
- GPU-sourced transforms carry latency (`Low Latency (Slower)`) [N/interactive/array-sources/transform-array/].

### 3. Skeletal animation and IK

- 3D Scene imports FBX, C4D, LWO and Alembic and builds bone sub-nodes; `Animation Set`, `Playback Speed`, `Loop Mode`
  [N/3d/3d-scene/]. 3D Object: `Skin + Skeletal Animation`, input `Skeleton Root` [N/3d/3d-object/].
- Bone: rest position and angles, `Rest Length`, `Heading/Pitch/Bank Limits` ("when used as part of an IK rig"), input
  `World Rotation Controller` [N/3d/other/bone/].
- Not in manual: any IK solver node, clip blending, retargeting, glTF or USD import, bone-count limits.
- Guidance: baking many rigid parts into "a skin + bone animation" can beat separate meshes
  [L/working-in-3d/preparing-assets-for-real-time/].

### 4. Splines and geometry along a spline

- Spline: per-point position, rotation, scale, `Tangent Mode`; node-level `Twist Method`, `Looping`, `Spline Time
  Mode` [N/3d/spline/]. "Minimise Twist" is the default [R1].
- Spline From Nulls: Null position is the control point, rotation the tangent, z scale the magnitude; it also accepts
  a transform array [N/3d/spline-from-nulls/].
- **Spline Extruder ("useful for making tubes and tunnels")** [N/3d/spline-extruder/]: `Num Spline Segments`, `Spline
  Time Min/Max/Offset`, `Caps`, `Extrude Shape` {Square | Ring | 2D Strip | Thickened Strip | Star}, `Num Radial
  Segments`, `Radius`, `Control Point Scaling Mode`, `Radial Rotation Offset`, `Minimise Self-Intersections`.
- Spline Deformer bends a mesh along a spline [N/deformers/splines-and-lines/spline-deformer/]. Also Object To Lines,
  Lines To Mesh (`Edges Radius`, `Edge Segments`), Trail Renderer with extruded geometry.
- Model: points, lines and splines are first-class geometry; generation runs on GPU and only on change [W1].

### 5. Rope and chain dynamics

- **Rope Deformer** treats each edge of line geometry as a rope [N/deformers/physics/rope-deformer/]. Stepping: `Frame
  Rate Mode` {Free | Fixed}, `Update Frame Rate`, `Min/Max Update Steps`. Rope: `Spring Model` {Stiff | Flexible},
  `Stretch Mode`, `Max Stretch`, `Stiffness`, `Bend Springs`, `Self Collisions`, `Collision Thickness`. Anchors:
  `Anchor 1st/2nd/Last Vertices`, `Anchor Mode` {Hard | Soft Weightmap | Soft Constant}. Inputs: `Collision Nodes`,
  `Force Affectors`.
- Rigid bodies: Physics Root (`Update Frame Rate`, `Min/Max Update Steps`), Rigid Body (`Dynamics Mode` {Static |
  Kinematic | Dynamic | …}) [N/physics/]. Fixed mode caps at 20 internal iterations per frame [W2].
- Not in manual: hinge, joint or chain constraints between rigid bodies; any tentacle or cable recipe.

### 6. Procedural environments

- Procedural Root "generates shader code" from its subtree; `CSG Mode` is applied in graph order; Repeat makes
  "potentially infinite" copies [L/working-in-3d/procedurals/, N/procedurals/cloning/repeat/].
- Procedural Raytracer ray-marches with inputs `Material`, `Affecting Lights`, `Excluded Lights`; Procedural Meshing
  voxelises to triangles that are textured, deformable and cast shadows [N/procedurals/render-nodes/].
- Renderers take "fields, procedurals and particles" directly, "allowing … all of them to shadow each other" [W1].
  The same SDF feeds falloffs, the Procedural Cloner, particle collision and Rigid Body Procedural.
- Tunnel guidance: cut the mesh into chunks, because culling is per mesh
  [L/working-in-3d/preparing-assets-for-real-time/].

### 7. Lights and reflections

- Light: `Falloff Mode` {legacy radii | Inv-Squared Distance (Physical)}, `Attenuation Distance`, `Scattering
  Intensity`, `Casts Shadows`; inputs `Affected Nodes`, `Excluded Nodes` [N/lighting/light/]. Material:
  `Emissiveness`, `Emissive Lights Scene` [N/materials/material/].
- The shadow, reflection and occlusion method is a **renderer** enum: Standard Renderer `Reflections` {Off | Screen
  Space}, Hybrid Renderer `Reflections` {Raytraced | Off}, `Emissives` {Raytraced | No Shadows | Off}
  [N/rendering/standard-renderer/, N/rendering/hybrid-renderer/].
- Scale: "Lights are generated and culled on the GPU, allowing them to be cloned" [W1]; the renderer architecture
  claims "thousands of lights" [L/lighting-and-renderers/nura-rendering-architecture/]. No numeric cap is published.
  Each shadow map re-renders the scene.

### 8. Camera

- Camera: field of view, clip planes, `Camera Priority`, `Motion Blur Amount`, focus properties; input `Target Node`
  [N/cameras/camera/]. Orbit Camera adds `Camera Distance`. The highest priority camera wins.
- Not in manual: a camera-shake node or dolly helper.

### 9. Control surface

- Expose To Block: `Exposed Name`, `Group`, `Unique ID`, `Slider Min/Max`, `Scope` [N/exposed-nodes/expose-to-block/].
- Modifiers connect to a property pin and combine by `Operation` {Add | Subtract | Multiply | Replace}
  [N/modifiers/sound-modifier/]. Sound Modifier: `Frequency Band`, `Attack`, `Decay`, `Spikiness`, `Smoothness`.
- **State Machine with State and Event nodes; only one state is active** [N/logic/state-machine/].

## What this means for Loom

This section is shaderloom-f1's reading of the two surveys against Loom as it stands today. It proposes; the lead rules.

**Where the two products agree, and Loom should match.**

1. **An instance is a row of per-instance data, and anything that computes rows is an instance source.** TD picks a
   source and a channel per attribute; Notch keeps flat GPU buffers per clone and runs an ordered stack of per-clone
   kernels (effectors) over them. Loom already has both halves of that data model: a pointset is the row buffer and a
   chain of point kernels is the effector stack. What it lacks is the draw (T1581b). The mapping should be general
   (any attribute to translate, orient, scale, pivot, tint, uv transform, and named custom values the material reads)
   with the transform order written down, as TD writes it.
2. **A variant per instance is one more channel.** Notch's `Object Index` picks which child a clone draws, and an
   effector may write it; killing a clone is the same write. That gives claws, tunnel-module variety and culling
   through one mechanism. TD has no documented equivalent. T1581b should carry a shape index.
3. **Lights are instance data too.** Notch clones lights and culls them on the GPU; TD stays forward and leans on a
   per-object light mask. A scene with a lamp every few metres of tunnel needs the Notch shape: lights from a pointset,
   in a deferred or clustered path inside the Render. The furnace's project-code lamp pass (T1402b) is the prototype.
4. **Curves are point topology with frames resolved once.** TD: line strips with attributes, Line Resample by distance,
   Line Metrics writing a seeded quaternion. Notch: a spline whose twist is minimised on the spline itself, and every
   consumer (cloner, extruder, follower, deformer) shares the same spline time in knots or length. Loom has no line
   family at all (docs/pop-gap-analysis.md). The sentinel's joint kernel computes a curve, its arc-length stations and
   its transport frames by hand; with a curve family the kernel shrinks to the gait (where the claw goes) and the rest
   is stock.
5. **A rigid object has a transform; it is not a kernel over its vertices.** Both products put a transform, a look-at
   and a parent on every 3D object. Loom's `geometry` refuses a non-identity orient and the working idiom is a point
   kernel that rewrites every vertex each frame (the furnace rig, the sentinel body). That is a workaround.
6. **A tunnel is geometry in the lit scene.** Notch documents the Spline Extruder as the tube-and-tunnel tool and lets
   procedurals share lights and shadows only because its renderers take them natively; TD documents no way for a
   raymarched pass to receive scene lights. So the sentinel tunnel is an extruded bore plus instanced modules inside
   the Render, not a raymarched pass composited by depth.

**Where Loom is already ahead, and should stay there.** Quaternion instance orientation (TD has none until
2026.20000). Kernel substeps (T1583b; no TD POP has an iteration control). A rope solver (T1585b; TD ships none, Notch
ships one as a deformer on line geometry with fixed-rate steps and soft anchors, which is the shape to copy).

**Gaps in both products, which are openings.** No documented IK in Notch; TD's is CPU channels onto bone objects. No
sweep on the GPU in TD. Neither blends a clip with procedural motion out of the box.

## Rows proposed from this survey

For the lead to number, merge or drop.

- **Curve family.** Curves as line-strip point topology: a Curve node (control points to an interpolated strip:
  cubic Bezier, cardinal, B-spline), Resample (by distance, by count, by curvature; a pre-allocated maximum and a live
  count), and Curve Frames (tangent, normal, binormal, a quaternion, distance from start; a seeded start frame; twist
  minimised). Consumers: instancing along a curve (T1581b), sweep, a path follower.
- **Sweep / extrude along a curve.** A profile (ring, square, strip, custom) swept into a lit surface with G-buffer
  writes: radial segments, radius, per-point scale, caps, twist. Notch's Spline Extruder; TD has it on the CPU only.
- **Object transform on scene geometry.** Translate, rotate, scale and pivot with the order stated, a look-at target
  and a parent, applied as the draw's model matrix. Replaces the per-vertex rigid kernel idiom.
- **Lights from a pointset.** Position, colour, intensity, range and cone from point attributes; a deferred or
  clustered many-light path inside the Render; include and exclude lists; shadows for a chosen few. Cite T1402b.
- **Shape index and light instancing in T1581b.** Inputs to that design, not new rows.
- **Path follower on the value graph.** A CPU reader of a path for cameras and rigid objects: position, heading with a
  look-ahead, bank, heading-flip protection (Notch's Spline Follower, TD's `pathsop`/`pos`/`bank`). The expression
  grammar has no `sqrt`, so even normalising a tangent is awkward today.
- **State machine on the value graph.** States and events, one state active (Notch). The furnace director built one
  from Select, Count and Expression nodes; robot behaviour (cruise, perch, gesture) needs the same thing.
