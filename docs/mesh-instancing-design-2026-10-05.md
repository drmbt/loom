# Mesh instancing and the object transform: one transform chain for scene geometry (T1581b, T1588b)

**Status, 2026-10-05: the design is ruled (section 10, all as recommended) and in build.** Slice A (the object transform on surfaces) and slice B (a mesh at every point: the consumer's first slice) are built. Section 13 records what was built, where it differs from the text above it, and the measured frame.

Two rows are designed together because they are one chain: T1581b draws a mesh at every point of a pointset, T1588b gives a scene geometry a transform of its own, and the final position is `object × instance × shape-local`.

## 1. The ask

- **T1581b.** Geometry mode "instances" draws a quad, a box or an octahedron at every point, with one scalar scale, an orient quaternion and a tint. Material · WGSL is refused on it (T1361b) and it writes no normal, albedo or shadow-matte output. Wanted: any mesh as the instance shape, a full per-instance transform, Material · WGSL, and the G-buffer and shadow citizenship of surface geometry.
- **T1588b.** `geometry` refuses a non-identity orient, and a rigid hull is moved by a point kernel that rewrites every vertex each frame (sentinel-bot's body: 87,751 vertices per robot per frame). Wanted: translate, rotate, scale and pivot with the order stated, a look-at target and a parent, as the draw's model matrix in every pass.
- **The owner's directive (relayed 2026-10-05).** Design to the standard of TouchDesigner and Notch, not to the first consumer's minimum. No brittle, non-scalable or cobbled-together path. General attribute mapping, not one hard-wired "free vec4f". Scale target 100k+ small instances.
- **The consumer (sentinel-bot, shaderloom-f1).** 2,000–4,000 instances of one ring per draw. Their kit decodes to 159,464 vertices / 212,790 triangles, 24 parts, 46 markers; one ring is 1,250 vertices / 716 triangles. Their inputs: what frame the shape is in (`decodeGlb` bakes node world transforms into the vertices); a shape index per instance with kill through the same channel; rotate-to-vector as a convenience beside the quaternion; a thin first slice, marked as such only if it is a true prefix (section 7).

## 2. Survey: how the engine draws today

All of this is `src/nodes/definitions/scene.ts` (the Geometry and Render nodes) and `src/nodes/shaders/scene-render.wgsl.ts` (the generators), unless another file is named.

### 2.1 Surface geometry

- **No vertex buffers and no index buffers anywhere.** Every draw is vertex-pulled: `draw(vertexCount, instanceCount)` with the vertex stage reading storage buffers by `vertex_index` (`DrawPassDescriptor` in `runtime/backend/plan.ts` has `vertexCount`, `instances` and `buffers`, nothing else).
- **One generator, `sceneSurfaceModule`,** with two vertex chunks that share one `VertexOut` and one fragment stage:
  - grid (`surfaceMeshWgsl`): the vertex index is the grid connectivity, normals are central differences;
  - indexed mesh (`meshVertexWgsl`, T1353b): `index = meshIndices[vertex]`, then `positions[index]`, `meshNormals[index]`, and optionally `meshUvs`, `meshSurface`, `meshEmissive`, and the file's `color` through `pointColors`.
- **A mesh is a pointset.** Mesh File In publishes one point per vertex, 88 bytes a row (`points/mesh.ts`: position, normal, uv, color, surface, emissive), packed as regions of one buffer (`points/packing.ts`, T1076), and the triangles ride the edge as a topology claim, `mesh:<triangles>@<index buffer id>`. A kernel between the file and the Geometry keeps the claim.
- **Each attribute is its own storage binding** on these draws (`attributeBinding` binds one region as `array<vec3f>` and so on). A fully attributed mesh surface binds seven storage buffers: positions, colour, indices, normals, uvs, surface, emissive.
- **There is no model matrix.** Positions are world positions. The vertex stage multiplies by `viewProjection` and nothing else, in every generator.

### 2.2 Instances today

- A second generator, `sceneInstancesWgsl`, builds quad, box or octahedron from the vertex index (`INSTANCE_SHAPES_WGSL`). All three draw 36 vertices and collapse the tail (§V219). It also serves the two billboard modes (points, beam).
- Per instance it reads `positions[instance]` and, when mapped, `pointScales`, `pointOrients`, `pointColors`, and it evaluates them again for every vertex in every pass. It has no uv (texture maps are refused on it by name), no hook for a custom surface, and no G-buffer variant.
- It has its own depth generator (`shadowInstancesWgsl`) and its own glass generator (`glassInstancesWgsl`). This is the "parallel copy" shape the directive rules out for meshes.

### 2.3 The passes a Render emits per geometry

- **`emitDepthSweep`** is one parameterised depth-only sweep of every geometry. It runs per casting directional light (one pass), per casting point light (six cube faces into a 3×2 atlas, made from the directional text by `cubeShadowVariant`), per occluding projector, for the AO prepass, for the Depth output and for the Light Depth output. It picks `shadowSurfaceWgsl`, `shadowMeshWgsl` or `shadowInstancesWgsl` by geometry kind.
- **The lit pass** is one draw per geometry.
- **The G-buffer layers** (Normal, Albedo, Shadow matte: T1371b, T1380b, T1414b) are one more pass each per surface geometry, made by spreading the lit pass and swapping the shader for the same generator with `gbuffer: "normal" | "albedo" | "shadow"`. There is no multiple-render-target pass; `DrawPassDescriptor.target` is one target.
- Unlit and glass geometries do not cast; a Shadow Only geometry is in the light sweeps and nothing else; an additive surface (T1411b) draws last, writes no depth and no G-buffer.
- **A Geometry node emits no pass today.** It publishes a scene payload (values) and the Render does all the drawing. The compiler reads a node's `passes`, `scratch` and `scene` independently (`compiler/compile.ts`), so nothing forbids a Geometry from emitting one.

### 2.4 Material · WGSL

- `material-wgsl.ts` reflects the author's `struct Params` into controls and hands the Render `code`, `paramsDeclaration`, `fields`, `uniforms` and a source map.
- `sceneSurfaceModule` places the code, fills a generator-declared `SurfaceIn` per fragment (world, normal, uv, tint, attr, emissive, eye, albedo, roughness, metallic, absTime, footprint, curvature), calls `surface(s, p)` and lights the result. `Params` fields ride the pass uniform block as `m_<name>`.
- Every name the generator declares is reserved (`SURFACE_RESERVED_NAMES`, read off an all-features generator run).
- Only the surface generator has this hook. That is the whole reason T1355b refused instances.

### 2.5 Map mode: how a per-point attribute reaches a draw

- A parameter in Map mode stores `{ kind: "map", attribute, channel?, port? }` (T286). It has no CPU value; the compile context hands the node `parameterMaps`, and the node generates a shader that reads `attribute[index]` (§V287).
- Geometry honours a map on `tint` (a vec4f, T478), `scale` (an f32 or one channel of a float vector, T721) and `orient` (a vec4f quaternion, T723), resolved by `resolveColorMap` and `resolveScalarMap` in `points.ts`. A map on anything else refuses by name (§V288).
- The three do not compose alike: a mapped tint replaces the authored tint, a mapped scale multiplies the authored Scale, and an authored Orient other than identity refuses because the draw has no uniform for it.
- A map resolves against the node's first pointset input; `port` names another one and becomes required when a node has more than one (§V306). Nothing enforces "required" yet, because no node had two.
- The node also has the other idiom for "which attribute": Beam's `endpoint` is a string naming a vec3f attribute, used where a constant value would mean nothing.

### 2.6 Live counts and the Group predicate

- A counted pointset (a producer that spawns and kills) keeps its live points in a prefix: compaction is a deterministic prefix-sum scan and scatter (`points/lifecycle.ts`), never atomics (§V45, §V47).
- `countedDrawSupport` turns the GPU-resident live count into indirect draw arguments with one small dispatch, and the draw becomes `instances: { indirect }`. No CPU readback. One args buffer per geometry is shared by its shadow, lit and glass draws.
- The Group predicate (T642) is a vertex-stage gate: an excluded instance still runs every vertex, the predicate is evaluated again for each one, and each lands on a single clip-space point (§V219). That is 36 invocations per excluded primitive. For a 716-triangle mesh it would be 2,148.

### 2.7 Budgets

- Eight storage buffers per shader stage is the WebGPU baseline (§V588). The compiler counts `pass.buffers.length` against it before any device exists and refuses by name (`compiler/bindings.ts`, T328).
- Kernels do not pay per attribute: they bind a producer's whole packed buffer as `array<u32>` and read regions by offset through generated accessors (`regionAccessorWgsl`). T1076 measured that equal in speed to typed arrays.

### 2.8 Mesh File In and the shape's frame

- `decodeGlb` (`domain/mesh/glb.ts`) transforms every primitive into world space by its node's world matrix and concatenates the selection into one vertex list. That is right for a set (a furnace, a street) and wrong for an instance shape: an object the file places at (10, 0, 5) is instanced 10 metres off every point.
- A node with `extras.loom_part` becomes a part: its vertices carry the part index in `surface.w`, and the decoder records the part's pivot (the node's world origin) and world rotation. Neither reaches the GPU or the node's parameters; the `Parts` parameter is `index:name` only.
- The Transform node (`point-transform.ts`) moves `position` only. It leaves `normal` alone, so it cannot re-frame or turn a lit mesh.

### 2.9 What the engine does not have

- A model matrix, a parent, or a look-at on any geometry (T1588b).
- Indexed draws. A 716-triangle ring with 1,250 vertices runs the vertex stage 2,148 times per instance, not 1,250.
- Multiple render targets in one pass.
- Motion vectors or previous-frame transforms for any geometry. T1371b is open on exactly that; Camera Blur works from the camera's own path (T1421b).
- Frustum culling, level of detail, or a compute cull for any draw.
- Picking of a rendered object or instance.

### 2.10 Measured: one vertex-pulled mesh pass

A scratch probe (not committed) rendered one mesh surface through the existing path on Dawn (Apple M3 Max, Metal), with triangles under a pixel so the frame is vertex-bound. Each figure is the difference between a 42-frame and a 2-frame offline render, both ending in a readback, divided by 40.

| Mesh | Vertex invocations per pass | 1 pass (colour) | 2 passes (+ shadow) | 5 passes (+ depth, normal, albedo) |
|---|---|---|---|---|
| 124k triangles | 0.37 M | 1.5 ms | 1.3 ms | 1.5 ms |
| 1.0 M triangles | 3.0 M | 1.3 ms | 1.6 ms | 2.6 ms |
| 2.4 M triangles | 7.2 M | 1.6 ms | 3.1 ms | 4.8 ms |

- About 1.4 ms of every figure is the harness's own per-frame cost; the slope is roughly **0.1 ms per million vertex invocations per pass** on this GPU.
- These are wall-clock figures of the surface path, not GPU timer queries and not an instanced path. They bound the order of magnitude and nothing finer.
- Extrapolated by that slope: the consumer's 4,000 rings are 8.6 M invocations per pass, so colour + depth + normal + albedo + one directional shadow is about 43 M, in the region of 4–5 ms on this machine. A casting point light adds six passes. 100,000 rings are 215 M per pass, about 20 ms a pass, which is not real time on any path that vertex-processes every instance. 100,000 instances of a 100-triangle mesh are 30 M per pass, about 3 ms a pass.

## 3. How TouchDesigner and Notch do it

**The reference is `docs/td-notch-mechanisms-2026-10-05.md`** (shaderloom-f1, `fa759eab`): TouchDesigner §1 (mesh instancing) and §2 (transform hierarchy), Notch §1 (cloning) and §2 (hierarchy), and "What this means for Loom". Its facts are not repeated here. This section adds what this session read beyond it, says where the two readings differ, and gives the comparison. Neither program was run; URLs are in section 12.

### 3.1 Read here, beyond the reference

TouchDesigner:

- **Pivot, defined.** The Xform page: "the point about which a Component scales and rotates". The Instance page gives a per-instance pivot and says only that Rotate to Vector's default order "will be applied before all other transform operations (except the pivot offset)"; it prints no formula for the pivot itself.
- **Rotate to Vector's three placements, as formulas**: Default `T * R * S * (RotToVector) * Position`; Pre-Rot `T * (RotToVector * R) * S * Position`; Post-Rot `T * (R * RotToVector) * S * Position`.
- **Object against instance**: Instance Order is `worldXform * instanceXForm * Position` (the default) or `instanceXForm * worldXForm * Position`.
- **Colour against the shape's own**: "If the SOP doesn't have a 'Cd' attribute, then it will behave as if its 'Cd' is (1, 1, 1, 1)."
- **Custom attributes are capped by the device**: "Different GPUs will have a different number of maximum custom attributes supported."
- **Instance id in a fragment**: `TDInstanceID()` is vertex-stage only; "you will need to pass it onwards to the pixel shader through an out/in", declared `flat`.
- **POPs and the count**: for a POP whose point count is known only on the GPU, "the memory allocated is the maximum memory the POP could use."
- **Copy POP template attributes** combine onto the copies by Copy, Multiply, Add or Subtract, per attribute.
- **Picking is a render**: "The Render Pick DAT and CHOP do their work with a render operation, so they need to interact with the shader"; the instance id "will always be 0 if instancing is off."
- **Performance guidance, as far as it is written down** (Derivative's curriculum): "Instancing with TOPs is a supercharged workflow that unlocks working with hundreds of thousands of instances", and "DATs are the least efficient approach to instancing". It is about where the instance data lives.

Notch:

- **The clone buffers, from the Custom Shader Effector's example**, are those the reference lists plus a per-clone parent transform (`float4x4`). The kill sentinel is `0xFFFFFFFF` in the clone index. The effector function "is run once per frame, per clone", and "the effectors that are placed at the top left of the node graph will be processed first".
- **The Particle Cloner** "creates clones at positions defined by a particle system" and "clones are attached to individual active particles and flow its transforms until the particle dies". It has Rotation Affects Clones, Scale Affects Clones, Colour Clones, and a Rotation Mode of Face Motion Direction or Spin.
- **The Mesh Cloner** clones onto another mesh's vertices, polygon centres, edge centres, surface or UV map, with Rotation Mode None, Object or Align To Normals.
- **The cloned object keeps its own transform.** The legacy Cloner has "Rotation Affects Positions - The rotation of the child object affects the position of the clones" and the same for scale.
- **Custom shaders** in 2026.2 are for effectors, particle affectors and deformers. A material that reads a per-clone custom value is not documented, which agrees with the reference.

### 3.2 Where the two readings differ

- **`TD_SHADOW_MAP_RENDER`.** The reference cites it on the Light COMP page. This session's fetch of the Light COMP page and of Write a GLSL Material on 2026-10-05 did not find that string. What both pages do say is that enabling shadows renders "the scene in a depth-only pass to create a shadow map" over the light's Shadow Casters, and that "Projection mapping and shadowing mapping are handled for you in the TDLighting() functions". Either way, no sentence treats an instanced COMP differently.
- **Cloner count.** The cloning index lists fifteen nodes; the reference's fourteen leaves out Cloner (Legacy).
- **Culling.** This session found no statement about culling. The reference found Notch's: culling is per mesh. Neither found per-instance culling in either product.
- No other disagreement. In particular both readings find no quaternion input on the Geometry COMP's Instance pages (the reference adds the staff post and the 2026.20000 promise), and no geometry variant per instance in TouchDesigner.

### 3.3 Comparison

"Ref" is the reference document; a URL-less cell is from it.

| Capability | TouchDesigner | Notch | Loom today | Loom proposed |
|---|---|---|---|---|
| Object transform | Xform page on every object: SRT orders, pivot | every node: position, heading/pitch/bank, scale | none on a geometry | Translate, Rotate, Scale, Pivot (D6) |
| Parent | `parentxformsrc`, Blend COMP | parent pin, per-channel inheritance | none | Parent, by name (D6) |
| Look-at | `lookat`, `forwarddir`, up | Target Node (z axis) | cameras and projectors only | Look At + Forward (D6) |
| Instance shape | the COMP's own SOPs/POPs | any child node, meshes and more | quad, box, octahedron | any pointset with mesh topology; grid surfaces follow |
| Shape's frame | the COMP's object space | the child's own transform, kept | n/a | chosen at Mesh File In (D4) |
| Instance source | CHOP, TOP, SOP, DAT, POP | cloner kinds; particles; a mesh; an array | a pointset, GPU-resident | the same |
| Count | manual, or the source's length | Num Clones | capacity, or the GPU live count | the same |
| Skip an instance | Active channel | kill (index sentinel), Kill Box | Group predicate (vertex gate) | Group, and the shape index's kill, both resolved once per instance |
| Translate | any channels | cloner + effectors | `position` only | any vec3f attribute |
| Rotate | Euler + rotate-to-vector + up; no quaternion | Euler; face motion, spin, target | quaternion attribute | quaternion, and aim + up |
| Scale | per axis | per axis + uniform | uniform × f32 attribute | uniform × f32, and per axis × vec3f |
| Pivot per instance | yes | not documented | no | yes |
| Transform order | six orders | not documented | fixed | fixed and stated (D5) |
| Colour | replace, multiply, add, subtract | tint | multiply | multiply, over the mesh's own colour |
| UV per instance | replace or transform | UV scale, offset, crop | none | UV scale and offset |
| Texture per instance | texture index into a list | tile sheet through UV deltas | none | follow-up |
| Shape per instance | not confirmed | object index, effector-writable | no | a shape index channel now; several shapes on one node in a follow-up (D13) |
| Custom attributes in a material | numbered vec4 slots, GLSL MAT only | not documented | none | named, declared by the material (D9) |
| Instance id in a material | `TDInstanceID()` | clone index | none | `s.instanceId` |
| Object-local position in a material | the vertex attribute before `TDDeform` | n/a | none | `s.local`, `s.localNormal` |
| Custom material on instances | GLSL MAT | not documented | refused (T1361b) | Material · WGSL, same hook as surfaces |
| Shadows cast and received | depth-only pass over the casters | not on the pages read | yes, for primitives | yes, through the mesh depth generator |
| Normal, albedo, shadow-matte outputs | multiple render targets, by the author | n/a | surface geometry only | yes |
| Culling, LOD | per instance: not confirmed | per mesh | none | follow-ups, named |
| Picking an instance | Render Pick returns the id | n/a | none | follow-up |
| Motion vectors | not documented | n/a | none for any geometry (T1371b) | rides T1371b |

## 4. Design

### D1. Instancing now; a copy node is a different thing, and Loom wants both

This row is the Geometry COMP's instancing and Notch's cloner: one shape stored once and drawn N times. TouchDesigner's own advice between its two mechanisms is "Instance where possible, but if you want to do anything with data after a copy, like deform it, use Copy POP." A copy makes N × V real vertices (4,000 rings × 1,250 vertices × 88 bytes is 440 MB, over the 128 MiB one storage binding may carry), so it cannot be how rings are drawn. It is still wanted, for the case that sentence names: a Copy node that stamps a pointset at each point of another and hands kernels the result. It stays its own candidate (`docs/catalogue-survey-td-pops-notch-2026-08-30.md` §7) and should take the same transform statement (D5) and the same targets (D7), as the Copy POP's Template page mirrors the Instance page.

### D2. The node: Geometry, Instances mode, Shape: Mesh

- Geometry stays the one node that binds points and a material into a renderable. Instances mode gains a fourth Shape, **Mesh**, and Geometry gains a second pointset input, **`mesh`** (label "Shape Mesh"), read only for that shape.
- `points` stays what it is in every per-point mode: the instance source. It stays the first pointset input, so every Map on the node keeps resolving against it (§V306) and no stored document changes meaning.
- **Rejected: a new Instancer node.** It would need Material, Material Overrides, Tint, Shadow Only, Blend, Group and now the Transform again, and two nodes that bind a material drift.
- **Rejected: TouchDesigner's literal shape** (a Surface geometry with an Instancing switch and a second `instances` input). It is the same draw. But Loom already has an Instances mode, in which `points` is the instance source and on which Map, Group and the live count are defined. The literal form would be a second place to instance, and every per-instance Map on it would have to name `port: "instances"` (§V306).
- Quad, box and octahedron keep their generator and their bytes in this row. Moving them onto the mesh path is follow-up F5.

### D3. The instance source is a pointset on the GPU

- No CPU readback at any point. An uncounted set draws `capacity` instances. A counted set draws indirectly off its live count through the existing `countedDrawSupport`, with `vertexCount = triangles × 3` in the args dispatch; the one args buffer serves every pass of that geometry.
- There is no manual count and no first-instance offset on the Geometry. A subset is made upstream (a Range, a kernel that kills) or by the Group predicate.
- This is the model both products converge on (reference, "What this means for Loom" 1): a pointset is the per-instance row buffer, and a chain of point kernels is the effector stack.

### D4. The shape's frame is chosen where the file is decoded

- **Mesh File In gains `Frame`: World (default), Object or Part.** Three named frames and no guessing:
  - **World** is today's decode, byte for byte.
  - **Object** expresses the selection in the frame of the lowest common ancestor node of the selected objects. One selected object is its own frame, so its vertices are its authored mesh data exactly, wherever the file placed it.
  - **Part** expresses it in the frame of the `loom_part` node that encloses the whole selection: the origin is the part pivot and the axes are the part's. A selection that lies in no part, or in more than one, refuses and NAMES the parts and loose objects it found (a glob such as `part:mand_*` reaches this, and the fix is to pick one).
  - Positions take the inverse of the frame node's world matrix, normals its inverse transpose.
  - The loader writes a measured, read-only `Frame Origin` (the frame node's name and world position) beside Vertices and Parts, so the frame in use is visible and the file's placement is not lost. It is also the number an object Pivot or Translate (D6) wants.
  - Object with no common node (several root-level objects) is the file's world, and says so in a warning naming the objects.
  - Object or Part on a skinned selection refuses by name in this row: the joint table and the pose table are in world space (follow-up F13).
- **Why at the decode and not on the instancer.** The node's world matrix exists only at decode. Undoing it at draw time would mean publishing it on the edge and applying an inverse in the instancer, and then a kernel between the file and the Geometry would see world-space vertices that are about to be un-placed. Decoded in its own frame, every consumer sees the same points.
- **Why World stays the default.** Every existing document reads a set, and a set is placed. This is the one place the design asks the author for a choice; the `mesh` port's description and the Mesh File In's description both name it.
- **Why not one "Local".** A ring object inside a tentacle part has two honest local frames, its own and the part's. Picking by how Select was spelled would make the frame depend on syntax.
- **What the others do.** TouchDesigner instances the COMP's geometry in the COMP's object space and composes the COMP's own world transform by Instance Order. Notch clones the child node with its own transform. Both keep "the shape" and "where the file put it" apart; Mesh File In flattens them, so the choice has to be made there.

### D5. One transform chain, stated once

```
world   = Object · Instance_i · v                        v = the vertex in the shape's own frame

Object     = Parent · T(translate) · T(pivot) · R(look at) · R(rotate) · S(object scale) · T(−pivot)
Instance_i = T(position_i + offset) · T(p_i) · R(aim_i, up_i) · R(orient_i) · S(s_i) · T(−p_i)

s_i     = Scale · scale_i · (Scale XYZ ∘ scaleXYZ_i)     per axis, along the shape's own axes
normal  = normalize(sign(det M) · cofactor(M) · n)       M = the 3×3 of Object · Instance_i
```

- A surface geometry is the chain without the instance: `world = Object · v`.
- **Both levels are scale, then turn, then translate**: the order TouchDesigner lists first and writes as `T * R * S * Position`, its Copy POP's first, and the Transform node's. `R(rotate)` is Euler degrees applied X then Y then Z, as the Transform node does and as TouchDesigner's first-listed rotate order (`R = Rz * Ry * Rx`).
- **The turn convention, stated once for the whole chain: every turn is right-handed about its axis.** A positive turn about +Z carries +X toward +Y, about +X carries +Y toward +Z, about +Y carries +Z toward +X. Rotate's Euler angles, the `orient` quaternion ((0, 0, sin 45°, cos 45°) is +90° about +Z) and a frame a kernel builds on the GPU all turn this way. `object-transform.gpu.test.ts` pins it on Dawn against cubes the file places on the axis each turn should reach.
- **Rotate is applied after Look At, in the object's own frame**: `R(look at) · R(rotate)` turns the vertex by Rotate first, so a Rotate about Z banks an object about its own forward axis wherever Look At points it.
- **The object is outside the instances**: TouchDesigner's default Instance Order (`worldXform * instanceXForm * Position`). Moving the object moves the whole cloud rigidly.
- **Pivot has TouchDesigner's meaning at both levels**: the fixed point of that level's scale and turn. With unit scale and no turn it changes nothing.
- **Instance rotation is a unit quaternion** (T723's reasoning stands; the reference agrees Loom is ahead here), **and aim plus up is the convenience**: `R(aim, up)` turns the shape's Forward axis onto a direction with its up toward a second one. It is applied after the quaternion (`aim · orient`), TouchDesigner's Pre-Rot placement, so with both in use the quaternion is a turn in the shape's own frame and aim places the result.
- **Scale is always inside the turn**, so a non-uniform size never shears a turned shape. That is why TouchDesigner's Default placement of rotate-to-vector (scale after it) is not offered.
- **No order menu.** TouchDesigner needs one because channels are hard to pre-compose. Here the instance source is written by a kernel, which can write any other order as a different position and orient.
- **Normals** take the direction of the inverse transpose of the final 3×3: its cofactor (nothing is divided, and a scale of zero on one axis still has an answer) times the sign of its determinant (a mirrored object keeps its normals on the side they were authored on). Non-uniform scales are lit for the shape they have, at both levels.
- With every value neutral the arithmetic is exact: a row of the identity matrix returns its component unchanged and adds zeros. Existing pictures are unchanged bit for bit, which the existing exact tests prove.

### D6. The object transform (T1588b)

**Parameters, on Geometry, group "Transform"**, all values (a moving object is a uniform write, never a rebuild, §V5):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `translate` | vec3 | 0, 0, 0 | |
| `rotate` | vec3, degrees | 0, 0, 0 | X then Y then Z |
| `objectScale` (label "Scale") | vec3 | 1, 1, 1 | per axis |
| `pivot` | vec3 | 0, 0, 0 | in the object's own frame |
| `lookAt` | name | "" | a node with a position: a Null, a geometry, a camera, a light |
| `forward` | enum ±X ±Y ±Z | +Z | which axis of the shape is its front; shared with instance Aim |
| `parent` | name | "" | a Null or a geometry |

- **Look At** turns the object so its Forward axis points at the named node, up toward world +Y; Rotate then turns it further in its own frame.
- **Parent** is by name, like every other piece of scene assembly (§V372). The compiler synthesises the edge; a parent cycle is a cycle of edges and refuses by name. A new **Null** node (a transform and nothing else) is what a rig's joints and a tunnel module's anchor are; it publishes a new payload kind, so `SCENE_PAYLOAD_KINDS` and its preview sweep grow by one. Inheritance is whole (no per-channel toggles).
- **One place the passes get their matrix.** The Geometry node composes `objectMatrix = Parent · local` on the CPU and publishes it in its payload. Nothing downstream composes again:
  - a surface draw takes it as two uniforms, `model` and `modelNormal` (the cofactor, computed on the CPU), from one helper used by the lit draw, every depth sweep and the glass draw; the G-buffer layers inherit it by spreading the lit pass, as they inherit everything else;
  - an instanced draw takes nothing: the resolve pass (D8) has already multiplied it in.
- **`model` is always present on a Render's surface draws**, not only when the transform is non-identity. Presence that depended on the values would recompile the shader the frame an object starts to move. This changes the generated text of every surface draw and no pixel (D5's last point).
- `s.local` and `s.localNormal` (D10) are the vertex before `Object`, so procedural detail sticks to a moving hull as well as to an instance.
- **Per-point primitives, Points and Beam** take the object transform in a later slice (section 7); until then the Transform is inactive and ignored on them. It is not a refusal: section 13 says why.
- **Authored Orient stays refused** (T723). Its sentence now points at Rotate and Forward, which do its job with numbers a person can type.

### D7. Instance mapping: every target is named

Each target is a Geometry parameter. Constant is a value. Map names any attribute of the `points` input of the right type.

| Target | Key | Constant | Map accepts | Mapped and authored |
|---|---|---|---|---|
| Translate | `instanceTranslate` (new, vec3, 0) | an offset for every instance | vec3f | attribute + value; unmapped reads `position` |
| Orient | `orient` (vec4, identity) | identity only | vec4f unit quaternion | — |
| Aim | `aim` (new, vec3, 0 = off) | one direction for all | vec3f | the attribute |
| Up | `up` (new, vec3, 0, 1, 0) | the up reference for Aim | vec3f | the attribute |
| Scale | `scale` (number) | uniform size | f32, or one channel of a float vector | value × attribute |
| Scale XYZ | `scaleXYZ` (new, vec3, 1) | per-axis size | vec3f | value ∘ attribute |
| Pivot | `instancePivot` (new, vec3, 0) | shape-local point | vec3f | value + attribute |
| UV | `uvTransform` (new, vec4: scale, offset; 1, 1, 0, 0) | for every instance | vec4f | the attribute |
| Tint | `tint` (colour) | per object | vec4f | the attribute (T478); always × the mesh's own `color` |
| Shape | `shapeAttribute` (new, attribute name) with `shapeIndex` (new, number, 0) | — | f32 or u32 | D13 |
| Active | `group` | a WGSL predicate over `p.<attribute>` | any attributes | — |
| Custom | the material's `struct Instance` (D9) | the field's `@default` | any | — |

- **One rule where both a value and an attribute exist: they compose, and the default is the neutral element.** Scale and Scale XYZ multiply, Translate and Pivot add. Tint keeps T478's rule (the map replaces the authored tint) because documents depend on it. Aim, Up and UV have no sensible composition and the attribute stands alone.
- A Map naming an attribute the points do not carry, or of the wrong type, refuses by name and lists what the pointset provides (the existing resolvers).
- A Map with `port: "mesh"` refuses by name: per-instance values live on `points`. The resolvers' sentence "the only pointset input is …" is corrected, since it stops being true.
- The new targets apply to the Mesh shape only in this row and say so (`inactiveWhen`, the Geometry node's existing way of marking a parameter that does not apply, §V146); a Map on one of them with another shape refuses by name. Follow-up F5 lifts that.
- `shapeAttribute` is a name and not a Map because it has no constant counterpart, the reason `endpoint` is one.

### D8. Resolve once per instance, draw many times

- **A compute pass resolves each instance once per frame.** It reads every mapped attribute, evaluates the Group predicate and the shape index, builds `Object · Instance_i` and writes one record per slot. Every draw of that geometry (lit, three G-buffer layers, every shadow and depth sweep, later glass) reads the record and does one affine transform per vertex.
- **Why.** The primitives' generator re-reads and re-evaluates the per-instance values for every vertex in every pass. For a 2,148-invocation shape in five to ten passes that is ten to twenty thousand evaluations per instance per frame of a transform that is the same each time. Resolved once, the chain is also written in exactly one WGSL function, which is what "one transform chain, one statement of order" means in code. TouchDesigner hands its shaders the same thing: `TDInstanceMat()` is the whole instance transform.
- **The record is an internal pointset** in the packed layout every producer uses (`packedPointStorage`, T1076), read through the kernels' accessors (`regionAccessorWgsl`):

  | Region | Type | Content |
  |---|---|---|
  | `m0`, `m1`, `m2` | vec4f × 3 | the rows of the 3×4 world matrix, `Object · Instance_i` |
  | `tint` | vec4f | white when unmapped |
  | `uv` | vec4f | scale and offset |
  | the material's `Instance` fields | as declared | D9 |

  80 bytes an instance plus the fields: 8 MB at 100,000.
- **The layout grows without rework.** Regions are independent, so a later region (a `meta` with the shape index, the source slot and an LOD band for F1 and F2; last frame's matrix for F7) moves nothing that exists and changes no existing accessor.
- **An instance that is not drawn gets a zero matrix.** Every vertex lands on one point, the triangles have no area and no pass rasterises them: §V219's collapse, decided once per instance instead of once per vertex. Group, the shape index's kill and (later) a failed cull all write it.
- **The Geometry node owns the pass and the buffer** and publishes the buffer on its payload (id, layout, capacity, count), so two Renders naming one geometry resolve it once, and the tile reads the same records. If the compiler turns out not to place a pass on a scene-payload node (2.3 says it should), the Render emits it per geometry from the same generator.
- **A draw then binds few buffers, whatever is mapped**: the shape's vertices, the shape's indices and the records. The raw `points` buffers are bound by the resolve pass only.
- A surface geometry has no resolve pass and no record: its one matrix is a uniform (D6).

### D9. Custom attributes are named, and the material declares them

- A Material · WGSL may declare **`struct Instance { … }`** beside `struct Params`, reflected by the same reflector, with the same `// @default` annotation:

  ```wgsl
  struct Instance {
    heat: f32,     // @default 0
    phase: vec4f,  // @default 0
  };
  fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
    var o = surfaceDefaults(s);
    o.emissive += vec3f(1.0, 0.4, 0.1) * s.instance.heat;
    return o;
  }
  ```

- On a mesh-instance draw each field is bound **by name** to an attribute of the `points` input with the same name and type. Geometry's new **`instanceAttributes`** text renames or picks a channel, one `field = attribute` or `field = attribute.channel` per line, in the idiom `materialOverrides` already uses. A field that finds no attribute takes its declared `@default`. A field with no attribute and no declared default, a type mismatch, or a line naming a field the material does not declare, refuses by name: a misspelt attribute must not draw as a plausible zero.
- On any other draw (a surface, a preview) every field is its default, so one material works on both.
- **How it is read.** The resolve pass copies the bound attributes into the record. The vertex stage passes the instance slot to the fragment stage as one flat `u32`, and the fragment stage fills `s.instance` from the record at that slot. The field count is then not limited by inter-stage variables (16 at the baseline, nine of them in use), and a field costs nothing per vertex.
- **Why not TouchDesigner's numbered vec4 slots.** They couple two nodes by index. TouchDesigner's own newer path for geometry attributes is by name (`TDAttrib_<name>`), and Loom's attributes have had names and types on the edge since T296.
- A stock material ignores instance attributes, as TouchDesigner's PBR MAT does.

### D10. What a Material · WGSL sees

`SurfaceIn` gains four members, present on every draw so that one material compiles everywhere:

| Member | On a mesh instance | On a surface |
|---|---|---|
| `local: vec3f` | the vertex in the shape's own frame | the vertex before the object transform |
| `localNormal: vec3f` | the mesh normal in that frame (triplanar detail needs it) | the normal before the object transform |
| `instanceId: u32` | the instance's slot | 0 |
| `instance: Instance` | D9 | defaults |

`world`, `normal`, `uv` (after the instance's UV transform), `tint` (mesh colour × instance tint), `attr` (the mesh's surface row), `emissive` and the rest are as on a mesh surface. This changes the generated text of every Material · WGSL draw (two more struct members were added the same way in T1377b) and no pixel of any of them.

### D11. One generator path

- **The vertex stage becomes fetch, then place.** Fetch is the grid chunk or the mesh chunk that exist. Place is one of: the `model` uniform (a surface), or the record (an instance). `VertexOut` gains `local`, `localNormal` and the flat slot. The fragment stage (lighting, shadows received, environment, AO, projectors, maps, the custom surface, the three G-buffer writes) is the one that exists, untouched apart from D10.
- **The depth sweeps are the surface and mesh depth generators** (`shadowSurfaceWgsl`, `shadowMeshWgsl`) with the same place step, and the point-light cube variant is still made from their text by `cubeShadowVariant`.
- **No third generator.** `sceneInstancesWgsl`, `shadowInstancesWgsl` and `glassInstancesWgsl` are not extended.
- **Bindings are per producer on an instanced draw.** It binds each buffer once, whole, as `array<u32>`, and reads through accessors: the shape's vertices, its indices, the records. Per-attribute bindings would be seven for the mesh before the records.
- **The instance slot goes through one function**, `instanceSlot(instance_index)`, the identity in this row. The compute cull (F1) replaces its body with a lookup; nothing else in the generator knows.
- **The non-instanced mesh surface keeps its per-attribute bindings in this row.** Moving it onto the same accessors is follow-up F6: one spelling for every mesh draw and four free bindings on each.

### D12. Citizenship

A mesh-instance geometry takes the surface branch of the Render's loops, so each of these is the surface's own code:

- lit by every model (unlit, lambert, phong, pbr) and by Material · WGSL;
- casts into every depth sweep: directional and point shadows, projector occlusion, the AO prepass, the Depth and Light Depth outputs;
- receives shadows, AO, projectors and the environment;
- writes Normal, Albedo and the Shadow matte;
- texture maps work, by the mesh's own uv (primitives still refuse them);
- Shadow Only keeps the sweeps and drops the camera draws;
- Blend: Additive follows T1411b (drawn last, no depth, no G-buffer, alpha 0);
- unlit does not cast (T666).

Glass on a mesh instance refuses by name in this row (F11).

### D13. Live count, Group, and the shape index

- **Live count**: D3.
- **Group**: the existing predicate and resolver, evaluated in the resolve pass. An excluded instance is in no draw of any pass, so it casts no shadow. (First built as a zero record; F1 compacts instead, section 13.)
- **Shape index, in this row as a channel.** `shapeAttribute` names an attribute holding each instance's shape number; `shapeIndex` is this geometry's own number. An instance is drawn when the two are equal. Any other value is not drawn, so **a negative number is the kill**, Notch's one channel for variant and kill. K variants are K Geometry nodes over one points producer, each with its mesh and its number: a kernel that writes the attribute chooses, per instance and per frame, which shape appears or that none does.
- **Several shapes on one Geometry is follow-up F2**, with the compute cull: one resolve, one compacted index list per shape, one indirect draw per shape, and LOD as a shape index taken from distance. The cheap version, one draw sized for the largest shape with shorter ones collapsed, defeats LOD, which is the main reason to want it.
- **What is fixed now so F2 is not a rework**: the attribute pick (`shapeAttribute`), the kill convention, the record as independent regions (D8), and the slot indirection (D11). F2 adds a `meta` region, the lists and the draws.
- **The cost until F1**: an instance that is not drawn still ran its vertices. This line said that was nothing at the consumer's size; it was 56 ms a pass for one big mesh keeping 1 point of 631. F1 is built (section 13).

### D14. Scale: what this design does, and what it leaves

- **Per instance, the work is done once** (D8). Per vertex it is one record read and one affine transform, in every pass.
- **Every live instance is still drawn in every pass.** No culling beyond clipping, no level of detail. By the section 2.10 figures that is comfortable for thousands of 700-triangle instances and for 100k instances of small meshes on a GPU of the class measured, and it is not a plan for 100k rings.
- **Indirect draws** are in from the start for counted sets (D3). Every later reduction of the instance count writes the same args buffer.
- **Left to named rows, in the order that pays:**
  - **F1, compute cull and compaction.** Per view, a dispatch flags each resolved instance (a sphere-in-frustum test on the record; the kill is already there), the existing deterministic scan and scatter (`points/lifecycle.ts`) compacts the surviving slots into an index list, the args dispatch takes the surviving count, and `instanceSlot` reads the list. It needs the shape's bounding radius, which the loader measures and the edge carries. The camera and each light are separate views; whether lights cull or only filter is that row's decision.
  - **F2, several shapes per geometry and LOD** (D13).
  - **F3, indexed draws.** With the mesh's index list bound as a real index buffer, `vertex_index` is the mesh index and the vertex stage runs once per vertex reused: 1,250 instead of 2,148 for the ring. It changes the plan IR and the backend for every mesh draw, so it is measured first.
  - **F4, the G-buffer in one pass.** Normal, albedo and the matte as multiple render targets is three passes fewer per geometry, for surfaces as much as for instances.
- **Why not F1 now.** It is additive (passes between the resolve and the draw, and one function body), it changes no node or parameter, and it wants its own measurements.

### D15. Motion vectors

The engine has none for any geometry (T1371b is open). When that row lands, an object needs last frame's `objectMatrix`, which is a retained CPU value, and an instance needs last frame's record. For an uncounted set that is the record buffer kept as a pair, read at the same slot. For a counted set slots move under compaction (§V73), so the producer has to carry an id-to-slot map or previous-frame attributes. Recorded as F7 and tied to T1371b; nothing here blocks either answer.

### D16. Preview tile and picking

- The Geometry tile draws mesh instances through the same generator and the same records, as it uses the Render's own builders for every other mode. The tile does not apply the object transform: it frames the object, not its place in the scene.
- Picking is F8: an id layer (geometry index and instance slot) beside Normal and Albedo is the natural form. TouchDesigner picks the same way, with a render that writes ids.

### D17. Refusals, all by name (§V288)

- Shape: Mesh with nothing wired to `mesh`, or with an edge that carries no mesh topology or no vec3f `normal`.
- A Map on a new instance target with another shape or mode; a Map with `port: "mesh"`; `shapeAttribute` naming an attribute the points do not carry.
- `instanceAttributes` naming a field the material does not declare, an attribute the points do not carry, or a mismatched type; an `Instance` field with no attribute and no declared default.
- A non-identity authored Orient (as today, with the new pointer to Rotate and Forward).
- `parent` or `lookAt` naming a node that publishes no transform or position.
- Glass on a mesh instance (F11).
- More than eight storage bindings on a pass (the existing budget diagnostic).
- Frame: Object or Part on a skinned selection (F13); Frame: Part on a selection in no part or in several.

## 5. What a consumer targets

**Wiring**

```
meshFileIn (select: "ring", frame: object) ──▶ geometry.mesh
pointKernel (position, orient, …)          ──▶ geometry.points
materialWgsl                    (by name)  ──▶ geometry.material
null "hub"                      (by name)  ──▶ geometry.parent
geometry                        (by name)  ──▶ render.scenes
```

**Geometry, group "Transform" (any mode once all slices land)**: `translate`, `rotate`, `objectScale`, `pivot`, `lookAt`, `forward`, `parent` (D6).

**Geometry, Instances mode, Shape: Mesh**

| Key | Type | Default | Map mode accepts, or note |
|---|---|---|---|
| `mode` | enum | `surface` | set `instances` |
| `shape` | enum | `box` | set `mesh` |
| `instanceTranslate` | vec3 | 0, 0, 0 | vec3f; unmapped reads `position` |
| `orient` | vec4 | 0, 0, 0, 1 | vec4f unit quaternion (x, y, z, w); Map only |
| `aim` | vec3 | 0, 0, 0 | vec3f |
| `up` | vec3 | 0, 1, 0 | vec3f |
| `scale` | number | 0.05 (see O3) | f32, or a vector attribute with a channel |
| `scaleXYZ` | vec3 | 1, 1, 1 | vec3f |
| `instancePivot` | vec3 | 0, 0, 0 | vec3f |
| `uvTransform` | vec4 | 1, 1, 0, 0 | vec4f |
| `tint` | colour | 1, 1, 1, 1 | vec4f |
| `shapeAttribute`, `shapeIndex` | name, number | "", 0 | D13 |
| `group` | string | "" | a predicate, e.g. `p.alive > 0.5` |
| `instanceAttributes` | text | "" | `field = attribute[.channel]` per line |
| `material`, `materialOverrides`, `shadowOnly`, `blend` | as today | | |

A Map is the stored envelope every other mapped parameter uses: `{ mode: "map", bindings: { static: { kind: "static", value }, map: { kind: "map", attribute, channel? } } }`.

**Mesh File In**: `frame` (enum `world` | `object` | `part`, default `world`); measured `frameOrigin`.

**Material · WGSL**: `s.local`, `s.localNormal`, `s.instanceId`, `s.instance.<field>` with `struct Instance`.

## 6. The generators and the pass plan

The resolve pass, in outline (one function holds the chain):

```wgsl
fn resolveInstance(slot: u32) {
  if (!groupMatch(slot) || !shapeMatch(slot)) { writeZero(slot); return; }
  let turn  = mat3FromAim(aimAt(slot), upAt(slot), FORWARD) * mat3FromQuat(orientAt(slot));
  let size  = params.scale.xyz * params.scale.w * scaleAt(slot) * scaleXYZAt(slot);
  let pivot = params.instancePivot.xyz + pivotAt(slot);
  let place = translateAt(slot) + params.instanceTranslate.xyz;
  // Instance = T(place) · T(pivot) · turn · S(size) · T(−pivot);  record = params.object · Instance
  writeRecord(slot, params.object * affine(place, pivot, turn, size), tintAt(slot), uvAt(slot) /*, Instance fields */);
}
```

The instanced mesh vertex stage, in outline:

```wgsl
fn instanceSlot(i: u32) -> u32 { return i; }

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) drawn: u32) -> VertexOut {
  let slot  = instanceSlot(drawn);
  let index = meshIndices[vertex];
  let local = meshPositionAt(index);
  let a = recordM0(slot); let b = recordM1(slot); let c = recordM2(slot);
  let world  = vec3f(dot(a, vec4f(local, 1.0)), dot(b, vec4f(local, 1.0)), dot(c, vec4f(local, 1.0)));
  let n      = meshNormalAt(index);
  let normal = normalize(vec3f(dot(cross(b.xyz, c.xyz), n), dot(cross(c.xyz, a.xyz), n), dot(cross(a.xyz, b.xyz), n)));
  …
}
```

Per frame, in the phases the engine already has:

1. the Geometry's resolve dispatch, once, however many Renders name it;
2. the args dispatch, once per Render, when the points are counted;
3. one depth draw in every sweep the Render runs (per casting light, six per point light, per occluding projector, AO, Depth, Light Depth);
4. the lit draw;
5. one draw per enabled G-buffer layer.

Every draw is `vertexCount = triangles × 3`, `instances = capacity` or the indirect args.

## 7. Build order and slices

**The object transform goes first, as its own slice.** It is the smaller change: no new draw path, no new buffer, two uniforms. It builds the place step in the surface and depth generators under the exact GPU tests that exist, which must pass unchanged with the transform at identity. It gives the resolve pass its `Object` input, so the instance chain is complete from its first commit instead of being reopened later in every sweep. And the consumer needs it on its own: it replaces the per-vertex hull kernel. Building it together with instancing would put two new things under one set of new tests; building it after would touch the resolve and every sweep twice.

| | Row | Slice |
|---|---|---|
| A | T1588b | Translate, Rotate, Scale, Pivot on surface geometry (grid and mesh): `model` in the lit draw, every depth sweep, the G-buffer layers and glass; `s.local`, `s.localNormal` |
| B | T1581b | **Slice 1.** Shape: Mesh and the `mesh` input; Mesh File In's Frame; the resolve pass with Translate, Orient and Scale from named attributes and the object matrix; the lit pass for every model and Material · WGSL (`instanceId`); every depth sweep; the G-buffer layers; the live count |
| C | T1588b | Look At, Forward, Parent, the Null node |
| D | T1581b | Scale XYZ, instance Pivot, Aim and Up, UV, Tint over the mesh colour; texture maps; the preview tile; Shadow Only, Additive, the glass refusal |
| E | T1581b | Custom attributes (`struct Instance`, `instanceAttributes`) |
| F | T1581b | Group, the shape index and its kill |
| G | T1588b | The object transform on per-point primitives, Points and Beam |

**Slice 1 (B) is the consumer's thin slice, and it is a true prefix on four conditions that are part of it**, not extras:

1. it resolves once and draws from the record (D8). A slice that evaluated the transform per vertex would be replaced whole, not extended;
2. the record is read through accessors and the slot through `instanceSlot`, and position is the Translate target, not a hard-wired `position`;
3. the mesh instance takes the surface branch of the Render's loops (D12), not a branch beside the primitives;
4. slice A is in, so `Object` is an input of the resolve pass from the start.

The G-buffer layers and the live count are in slice 1 although the consumer listed neither, because on the surface branch they are emitted by the loop that already exists; leaving them out would take code and a refusal. They cost one exact test each. Nothing later reworks slice 1: each later target is one more attribute read in `resolveInstance`, custom attributes are more regions and a fragment read, Group and the shape index are the zero record, F1 is one function body.

Slices A and B are most of the work. None of it is sized by measurement.

**Tests, each on Dawn, exact or derived, red-verified, with the wire-cut case (§V147):**

- A: a surface moved, turned about a pivot and scaled per axis covers the expected pixels; its Normal output reads the turned normal as an exact byte; its shadow moves with it in a directional and a point light; every existing surface test passes unchanged.
- N instances of a small asymmetric mesh at known transforms cover the expected pixels; cut the Translate map and they stack.
- A turned asymmetric mesh lands where the quaternion says, and an inverted turn swaps two measured positions (§V683's shape, as `scene-orient.gpu.test.ts`); the same picture from Aim with the matching direction.
- Object × instance: a turned object carries its instances round its pivot; the picture equals the instances pre-transformed by hand.
- Scale XYZ changes the extent on one axis only; instance Pivot moves a turned instance and not an unturned one.
- The Normal output reads the turned normal as an exact byte; Albedo reads the mesh colour × tint; the matte reads 1 under an occluding instance.
- A shadow falls where an instance occludes a floor, from a directional and from a point light, and is gone when the instance is grouped out or its shape index is negative.
- A Material · WGSL painting by `s.local` gives the same picture on a moved and turned instance as on the unmoved one; painting by `s.world` does not.
- `s.instance.<field>` reaches the material from a named attribute; cut the attribute and the default shows.
- Two Geometry nodes over one pointset, each with its shape and its `shapeIndex`, draw disjoint instances that together are all of them.
- A counted set with K live of N draws K.
- Frame: Object on a displaced, rotated fixture node renders exactly as the same node authored at identity, and World does not; Frame: Part puts the part pivot on the instance.
- Headless definition tests for every refusal sentence in D17 and every `inactiveWhen`.
- One measured frame at 4,000 × 716 triangles, colour + G-buffer + one shadow map, reported.

## 8. Accepted limitations, as follow-up rows

| | Row | Why it is not in these two |
|---|---|---|
| F1 | Compute cull and compaction for instanced draws, feeding the indirect args | additive; needs the shape's bounds on the edge; own measurements. **Moved to the front after the first consumer's numbers (section 13, "What the first consumer measured")**; its compaction half needs no bounds |
| F2 | Several shapes on one Geometry by the shape index; LOD by distance | bucketed form of F1 |
| F3 | Indexed draws for mesh topology (surfaces and instances) | plan IR and backend change for all mesh draws |
| F4 | Normal, albedo and matte in one multiple-render-target pass | not specific to instances |
| F5 | Quad, box and octahedron as built-in meshes on the mesh-instance path; retires the solid branch of `sceneInstancesWgsl` and the instance depth and glass generators; finishes T1361b for solid instances | changes shipped shader text; pixel equality to prove |
| F6 | Non-instanced mesh surfaces onto per-producer accessors | changes shader text under existing tests |
| F7 | Previous-frame object and instance transforms for motion vectors | T1371b is not built |
| F8 | An id output (geometry, instance) for picking | no picking exists |
| F9 | A `// @use quat` module (look-at, from-to, multiply, slerp) for kernels that write `orient` | **built** after slice B (section 13); it was a convenience, and Aim (slice D) still covers the common case without a kernel |
| F10 | Grid-topology surfaces as the instance shape | the grid fetch under the same place step; small |
| F11 | Glass on mesh instances | `glassMeshWgsl` shares the mesh vertex chunk; own tests |
| F12 | Per-instance texture selection (a texture index or an array layer) | Material · WGSL has no texture inputs yet; a tile sheet through `uvTransform` works now |
| F13 | Frame: Object or Part for a skinned selection | joint and pose tables are world-space |
| F14 | A per-instance vertex hook (deform each instance differently) | Material · WGSL is fragment-only; a kernel on the shape deforms all alike |
| F15 | Points and Beam under Material · WGSL (the rest of T1361b) | billboards have no shape frame; a different `SurfaceIn` reading |
| F16 | A Copy node: a pointset stamped at each point of another, as real points (D1) | a producer, not a draw |
| F17 | A parent that is a point of another pointset (Notch's Parent To Vertex) | needs a second pointset read, T1582b |

Not planned unless asked: a transform-order menu (D5), colour modes other than multiply, per-channel parent inheritance.

## 9. Neighbours

- **T1586b, curves.** Made easier, and nothing here has to change for it. Curve Frames' quaternion maps onto `orient`, or its tangent and normal onto `aim` and `up`; distance from start is an `Instance` field; Resample's live count is a counted draw. A spline cloner is Curve → Resample → Geometry.
- **T1587b, sweep.** Unaffected. A sweep produces a grid-topology surface, which draws through the existing grid path, takes the object transform from slice A, and can be an instance shape once F10 lands.
- **T1589b, lights from a pointset.** The resolve step is the shape that row needs: mapped attributes of a pointset turned once a frame into compact records a Render consumes. The mapping idiom (D7), the packed records and the cull (F1) carry over. The record buffer is published on the geometry's payload, so "a lamp on every ring" can place lights by the instancer's own records instead of resolving the chain a second time. Nothing in the record layout is spent on lights now.
- **T1582b, a kernel reads a second pointset.** Not needed by anything here. It is what F17 waits for.
- **T1585b, rope.** A rope's links are instances along its points; nothing more is needed than T1586b's frames.

## 10. Open decisions

Each has a recommendation; the build starts from whatever is ruled.

- **O1. Node shape.** Recommended: Geometry, Instances mode, Shape: Mesh, a `mesh` input (D2). Alternative: TouchDesigner's literal form, instancing switched on for a Surface geometry with a second `instances` input.
- **O2. The shape's frame.** Recommended: `Frame` on Mesh File In with World, Object and Part, default World (D4). Alternatives: default Object; or the frame published on the edge and undone in the instancer.
- **O3. Scale's default on a mesh.** `scale` is one parameter with a default of 0.05, right for primitives and a trap for a mesh (5% of the file's size; TouchDesigner's is 1). Recommended: the effective default is 1 while Shape is Mesh, through `parametersFor`, if a default that depends on another parameter is acceptable to the inspector, presets and the schema guardrails; that has not been checked. Otherwise: keep 0.05 and say it in the Shape and Scale descriptions.
- **O4. Resolve once, draw from records (D8).** Recommended. Alternative: evaluate the chain per vertex in each draw, as the primitives do; fewer moving parts, and the chain then lives in every generator.
- **O5. Who owns the resolve pass.** Recommended: the Geometry node. Fallback if the compiler objects: the Render, per geometry.
- **O6. `model` always present on a Render's surface draws (D6).** Recommended, for §V5. It changes the text of every surface shader and no pixel. Alternative: present only when the Transform is not identity, at the cost of a recompile when an object starts moving.
- **O7. Authored Orient stays refused**, and Rotate plus Forward do its job (D6). Alternative: let it be a per-object turn inside each instance.
- **O8. Custom attributes.** Recommended: the material's `struct Instance`, bound by name, copied into the record (D9). Alternative: numbered vec4 slots on the Geometry, as TouchDesigner.
- **O9. `SurfaceIn` grows on every draw** (D10), so one material works on surfaces and instances. Alternative: the members exist only on instanced draws, and a material that reads them fails to compile on a surface.
- **O10. The shape index is a channel now and several shapes on one node later (D13).**
- **O11. The names.** `objectScale`, `instanceTranslate`, `instancePivot`, `scaleXYZ`, `aim`, `up`, `forward`, `uvTransform`, `shapeAttribute`, `shapeIndex`, `instanceAttributes`, `frame`. Two rows are labelled "Scale" (the object's, per axis, in the Transform group; the existing size, a number); relabelling the existing one "Size" would be clearer and touches every place that names it.
- **O12. Parent and Look At by name, with a Null node (D6).**
- **O13. The object transform on per-point primitives, Points and Beam** in slice G, refused by name until then. Alternative: in slice A, which changes the legacy generator's text.
- **O14. Mesh surfaces onto the new accessors (F6)** later, not in slice 1.
- **O15. Additive mesh instances** follow the additive surface (T1411b). Alternative: the per-point additive of T917 (in list order, alpha kept).
- **O16. The build order** of section 7.

## 11. Found on the way (not fixed, not in scope)

- The Geometry preview tile draws nothing but the backdrop for a mesh-topology Surface: the T532 branch in `compiler/compile.ts` handles grids only.
- The Transform node moves `position` and leaves `normal`, so a mesh turned by it is lit by its old normals.

## 12. Sources

The reference survey: `docs/td-notch-mechanisms-2026-10-05.md`.

TouchDesigner (Derivative), read here:

- Geometry COMP, Xform and Instance pages: https://docs.derivative.ca/Geometry_COMP
- Write a GLSL Material: https://docs.derivative.ca/Write_a_GLSL_Material
- Learning About POPs: https://docs.derivative.ca/Learning_About_POPs
- Copy POP: https://docs.derivative.ca/Copy_POP
- POP Rotations: https://docs.derivative.ca/POP_Rotations
- Render Pick CHOP: https://docs.derivative.ca/Render_Pick_CHOP
- Light COMP: https://docs.derivative.ca/Light_COMP
- Render TOP: https://docs.derivative.ca/Render_TOP
- Curriculum, Instancing with TOPs: https://learn.derivative.ca/courses/200-intermediate/lessons/201-converting-data-types-and-instancing/topic/instancing-with-tops/
- Curriculum, Instancing with DATs: https://learn.derivative.ca/courses/200-intermediate/lessons/201-converting-data-types-and-instancing/topic/instancing-with-dats/

Notch (10bit FX), read here:

- Cloners: https://manual.notch.one/2026.2/en/docs/learning/working-in-3d/cloners/
- Cloning nodes: https://manual.notch.one/2026.2/en/docs/reference/nodes/cloning/
- Particle Cloner: https://manual.notch.one/2026.2/en/docs/reference/nodes/cloning/particle-cloner/
- Mesh Cloner: https://manual.notch.one/2026.2/en/docs/reference/nodes/cloning/mesh-cloner/
- Cloner (Legacy): https://manual.notch.one/2026.2/en/docs/reference/nodes/cloning/cloner-legacy/
- Custom Shader Effector: https://manual.notch.one/2026.2/en/docs/reference/nodes/cloning/effectors/custom-shader-effector/
- Working With Custom Shaders: https://manual.notch.one/2026.2/en/docs/workflows/working-with-custom-shaders/

## 13. As built

Where the build differs from, or adds to, the sections above. The rulings on section 10 were all as recommended, with O3 (a mesh instance's scale defaults to 1) and O11 (the existing `scale` is labelled "Size") made specific.

### Slice A — the object transform on surfaces (T1588b)

- **Parameters on Geometry, group "Transform"**: `translate`, `rotate` (degrees, X then Y then Z), `objectScale` (label "Scale") and `pivot`. All values. The existing `scale` keeps its key and is labelled "Size".
- **The matrix is composed in `domain/geometry/transform.ts`** (`objectMatrix`, `normalMatrix`) and carried as `GeometryPayload.objectMatrix`. The Render hands it to each surface draw as `model`, and to the draws that shade as `modelNormal` too, from one helper; the depth sweeps take `model` alone.
- **The normal matrix is normalised on the CPU** (divided by its longest column), so an object scaled to a thousandth does not hand the fragment stage a normal it would treat as zero. Not in the design text.
- **`SurfaceIn` gained `local`, `localNormal` and `instanceId`** in this slice (`instanceId` is 0 on a surface). `localNormal` is the shape's own normal, not turned toward the viewer. The two inter-stage members exist only on a draw that wears a Material · WGSL.
- **Primitive instances, points and beams ignore the Transform until slice G.** The four rows are inactive there and say "Ignored here". Slice A first refused a non-identity Transform by name; the lead ruled against it, and the refusal is gone. It was decided by a value, and a value never decides the plan's structure (§V453): an object whose Translate was driven left the values-only frame path on the frame it left the identity, and the full compile then refused. `scene-transform.test.ts` holds a driven Transform on each of the three modes on the fast path, equal to the untransformed plan.
- **The preview tile draws by the identity**, as D16 says, and now draws a mesh-topology Surface at all (B247).
- **Look At, Forward, Parent and the Null node are slice C**, not built.

### Slice B — a mesh at every point (T1581b, slice 1)

**What a consumer wires and sets**

```
meshFileIn (select: "ring", frame: object) ──▶ geometry.mesh      "Shape Mesh"
pointKernel (position, orient, size, …)    ──▶ geometry.points
geometry { mode: "instances", shape: "mesh" }      (by name)      ──▶ render.scenes
```

| Geometry key | Constant | Map mode |
|---|---|---|
| `shape` | `"mesh"` | — |
| `instanceTranslate` (vec3, 0) | an offset added to every instance's place | a vec3f attribute is the place, instead of `position`; the value still adds |
| `orient` (identity) | identity only (T723's refusal stands) | a vec4f unit quaternion (x, y, z, w) |
| `scale` (label "Size"; **1** on a mesh instance) | the instance's scale | an f32, or one channel of a float vector, multiplies it |
| `tint` | per object | a vec4f, multiplied with the mesh's own `color` |
| `group` | a predicate over `p.<attribute>`; an instance it rejects is not drawn in any pass | — |
| `translate`, `rotate`, `objectScale`, `pivot` | the object transform, outside the instances | — |

Mesh File In: `frame` (`world` | `object` | `part`), and the measured `frameOrigin` (`name@x,y,z`, empty under World). Material · WGSL: `s.local`, `s.localNormal`, `s.instanceId`.

**Built as designed**

- **Resolve once, draw many (D8).** `instanceResolveWgsl` (`nodes/shaders/instance-resolve.wgsl.ts`) is the one place the instance chain is written. The Geometry node emits it as its own dispatch pass (`<node>:instances:resolve`) and owns the record buffer (`scratch:<node>:instanceRecords`); the compiler placed a pass on a scene-payload node with no change, so the fallback of O5 was not needed. Two Renders naming one geometry share the one pass.
- **One generator path (D11).** `sceneSurfaceModule` and `shadowMeshWgsl` take an `instanced` option; the primitives' three generators are byte-identical to before both slices (compared declaration by declaration against the base commit).
- **Bindings per producer.** A draw binds `packed0…` (each buffer whole, read through `regionAccessorWgsl`) and `meshIndices`: three storage buffers for a file and a points producer whatever is mapped, four when a kernel reshapes the mesh.
- **Citizenship (D12).** The mesh instance takes the surface branch of the Render: lit by every model, the Normal, Albedo and Shadow layers, every depth sweep, shadows cast and received from directional and point lights, a Material · WGSL.
- **Live count (D3)** through the existing indirect arguments, with the mesh's vertex count.
- **The frame (D4)** in `decodeGlb` (`MeshFrame`), with the Part refusal naming the parts it found.

**Where the build differs from the text above**

- **Group is in this slice** (the consumer draws four shapes off one pointset; each Geometry draws only what its predicate keeps). It is the zero record of D8, decided once per instance in the resolve pass.
- **Tint is in this slice**, over the mesh's own colour. The record holds a `tint` region only when Tint is mapped.
- **The record is `m0`, `m1`, `m2` (+ `tint`).** The `uv` region arrives with its target in slice D. The object matrix reaches the resolve pass as three vec4 rows.
- **An instanced draw declares no `model` uniform at all**, in its lit block or its depth block; the record is the only placement. The normal is the cofactor of the record's rows times the sign of their determinant, made unit in the vertex stage.
- **The Shape Mesh port requires `position` of its edge and nothing more**, as `points` does. A kernel between the file and the port declares no more than that, so the triangles and the normal are checked by the Geometry, with a sentence each.
- **O3 landed through `parametersFor`**: a Geometry stored with `mode: instances, shape: mesh` carries a schema whose `scale` defaults to 1, and every reader gets it through the one funnel (`effective-schema-closure.test.ts` passes unchanged). The parameter block is hoisted to `GEOMETRY_PARAMETERS` for it, which is why that block shows as moved in the diff.
- **A Map that names `port: "mesh"` refuses in the Geometry**, before the shared resolvers, whose sentence was left as it is.
- **Instance Translate's constant value on a primitive is inactive, not refused**; only its Map refuses there. The T1182 gate (`frame-compile.test.ts`, §V453: a parameter that is not compile-time never changes the plan's structure) fails a refusal that depends on a value. The object Transform on primitives, points and beams was the same kind of refusal and passed that gate only because the gate's fixture is a Surface; it is now ignored too (slice A, above).
- **Reserved names** cover the functions an instanced draw declares (`instanceSlot`, `recordM0…`, `meshPositionAt…`). Binding variables (`packed0`) are not reserved, as `positions` never was: `declaredNames` reads `fn` and `struct` only.

**Open, and a gate is red on it.** The Shape Mesh socket makes every Geometry node one port row (16 px) taller. In E13 Prism the Geometries `shaft` and `fan` then stand 20 px apart where the §V389 layout gate wants 36 (`examples/layout.test.ts`, the one failure of 176). It is not fixed in this slice because each way out is a decision: (a) move `shaft` 16 px up in E13's source and regenerate E13, which changes that one shipped file's bytes; (b) a socket that is shown only while it applies (Shape: Mesh), which no input has today and which touches the node box, the canvas and connect; (c) name the shape as the material is named, with no socket, which puts pointset data on a name where §V372 says a wire.

**Reached by the surface branch but not yet under a test of their own**: texture maps on a mesh instance (by the mesh's uv), Shadow Only, Blend: Additive, ambient occlusion, projectors, the environment, MSAA and SSAA. Glass on mesh instances refuses by name.

**Not built (their slices)**: Look At, Forward, Parent, Null (C); Scale XYZ, instance Pivot, Aim and Up, UV, the preview tile, which shows the backdrop alone for a mesh instance (D); the shape index and its kill (F); the object transform on primitives, points and beams (G).

### What the first consumer measured, and the order it changes

The consumer's own figures, from its first scene on slice B (reported by the lead, not measured here):

- **A rejected instance still costs the whole mesh.** All pieces drawn off one 631-point pointset with a Group each: a 152,490-vertex hull with 630 of 631 instances rejected was 400 ms a frame, and 5 ms once each piece had a pointset of its own. D13 said this cost was "nothing at the consumer's size"; that was wrong for a large mesh behind a predicate that keeps few. The zero record removes the pixels and none of the vertex work.
- **A point light's cube shadow** redraws every caster six times; one such light cost about 15 fps at 1280×720 in the app (T1598b).
- **Piece count costs as much as triangles.** Eight small instanced Geometries (3,440 triangles × 10 instances in all) were worth about 5 fps with shadows on while the GPU figure did not move: per-Geometry pass and submit overhead.

So the order after slice E is performance first: F1's compaction, T1598b, and a profile of what one more instanced Geometry costs per frame; then D, C, F and G. Until F1 landed, the Group parameter's description said the cost where the choice is made; F1 removed the cost and the sentence.

### F1 — compaction (T1581b, built)

**What it does.** A geometry that can leave an instance out lists the slots it draws and counts them, in its resolve pass, and every draw of it in every Render runs that many instances. A rejected instance, and a dead slot of a counted pointset, is in no draw of any pass.

**As planned**

- **Nothing in the record moved.** `m0`, `m1`, `m2`, `tint` and the `field_<name>` regions are indexed by the point's slot. `s.instanceId` and slice E's fields are the point's slot whatever is rejected around it (pinned on Dawn: with the middle of three points rejected the two drawn read ids 0 and 2).
- **One region more, `visible`** (a u32 a slot, in the record buffer): the accepted slots, dense, in slot order. A draw binds no buffer more.
- **One function body**: `instanceSlot(drawn)` reads `visible[drawn]`.
- **The count is in an indirect buffer the Geometry owns** (`scratch:<node>:instanceArgs`: vertex count, accepted count, 0, 0). A counted pointset's live count is one more reason to reject, and the per-Render arguments dispatch that slice B used for counted mesh instances is gone.
- **No pass more per Geometry.** One dispatch of one workgroup: each of 256 invocations resolves and counts its run of slots, they meet at a `workgroupBarrier()`, each sums the counts before its own and writes its slots into `visible` from there. Deterministic, no atomics.
- **A rejected slot's record is not written.**

**Where the build differs from the plan**

- **Only a geometry that CAN leave an instance out compacts**: one with a Group, or over a counted pointset. A geometry that draws every point keeps the plain resolve (a slot an invocation, at the GPU's full width) and a literal instance count. The plan had every mesh-instance draw indirect. Measured, an indirect draw is not free: a render pass holding one costs about 0.05 ms of GPU more than the same draw with a literal count on this machine, and a Render draws a geometry in up to fifteen passes. With all 150 mesh-instance draws of the consumer's hinged document indirect, its GPU frame went from 11.1 to 18.5 ms.
- **The device asks for `indirect-first-instance`** when the adapter offers it. Without it Dawn validates indirect arguments on the GPU, a compute pass ahead of every render pass that holds an indirect draw: the same document was 29 ms. The Node host now drops optional features one at a time when refused, so a device without this one keeps its timestamp queries; that fallback has not run on a device that refuses.
- **An indirect draw had to become a pass of its frame first** (the backend, `encode`). It used to be handed to vgpu's `Draw.draw()`, which builds its own command buffer, clears the target and submits at once. A counted geometry in a Render erased the backdrop and every geometry before it when rendered headless, and in the app ran ahead of the frame's passes and was erased by them. It now encodes through the frame's pass like a literal draw. `indirect-draw-order.gpu.test.ts` holds both paths and both draw orders. This was a bug before F1, for counted primitives too.

**The single-dispatch scan, measured** (M3 Max, Dawn on Metal; the timer's step is 0.066 ms)

| Slots | Resolve pass, compacting | A point kernel over the same slots |
|---|---|---|
| 4,000 | 0.07 to 0.13 ms | under 0.07 ms |
| 20,000 | 0.5 ms | under 0.07 ms |
| 100,000 | 0.66 ms | 0.07 ms |
| 1,000,000 | 2.6 ms | 0.26 ms |

- One workgroup is 256 invocations wide where a kernel is the GPU wide, so the walk grows with the slots. The alternative, the lifecycle's scan and scatter (`points/lifecycle.ts`), is three dispatches more per Geometry at about 0.07 ms of GPU each plus their CPU cost (the profile: a pass is what is expensive). The two are about equal near 100,000 slots; under that the single dispatch is cheaper, above it the scan is.
- **Kept: the single dispatch.** A geometry over more than about 100,000 points that also rejects would be better served by the scan; that is a follow-up, chosen by capacity, which is structural.

**The gate case, measured** (the consumer's hull, 152,490 vertices and 206,990 triangles, one pointset of 631 points, a Group keeping 1; 1280×720; GPU per render, clean runs)

| | Before F1 | After | One-point pointset, after |
|---|---|---|---|
| no shadows (2 draws) | 56.0 ms | 0.93 ms | 1.02 ms |
| one point-light shadow (9 draws) | 306 ms | 3.2 ms | 2.0 to 3.2 ms |

**What a Group costs now.** Not the rejected instances: an indirect draw in each pass. A Group that rejects nothing is worth removing. The consumer's documents carry one on every instanced Geometry (`p.kind > -0.5`, from when the pieces shared a pointset) although each kernel now writes exactly its points; with them the hinged document's GPU frame is 18.5 ms and the rigid one's 9.2, against 11.1 and 8.5 with those Groups gone.

**Per-view lists** (a camera frustum cull, a light's range) are further `visible_<view>` regions and counts, as planned. Each such list is an indirect draw in the passes that read it, which is the cost to weigh there. T1598b built the two coarser cuts first, per geometry rather than per instance: the Light's caster lists, and skipping a geometry whose CPU bound a point light cannot reach. A per-light list for instances is still open; see `docs/shadow-casters-design-2026-10-05.md`.

### Slice E — custom instance attributes (T1581b, built)

**What a consumer writes**

```wgsl
// Material · WGSL
struct Instance {
  tentacle: f32, // @default 0
  ring: u32,     // @default 0
  glow: f32,     // @default 0  How hot this ring is.
};
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.emissive += vec3f(1.0, 0.4, 0.1) * s.instance.glow;
  return o;
}
```

The points' kernel writes attributes named `tentacle`, `ring` and `glow` of those types, and nothing else is needed: each field takes the attribute of its own name. Geometry's `instanceAttributes` text is for the other cases, one per line or `;`: `glow = heat` binds another attribute, `glow = pick.z` takes one channel (x y z w or r g b a) of a float vector into an f32 field.

**Built as designed (D9)**

- Bound by name and type; a field nothing binds reads its `// @default`.
- Refused by name, each with what the two sides have (`node.scene.instanceAttribute`): a line that is not `field = attribute`, a line naming a field the material does not declare, an attribute the points do not carry, a type that does not match, a channel that cannot be taken, and a field with neither an attribute nor a declared default. Every fault is said at once.
- The resolve pass copies each bound attribute into a region of the record; the fragment stage reads it at the flat slot the vertex stage already passes. A draw binds no buffer more (§V588), and a depth sweep reads no field.

**Where the build differs from D9 and D10**

- **`s.instance` exists when the source declares `struct Instance`, and not otherwise.** D10 put the member on every draw. A material that declares no such struct has nothing to read, and its generated text is what it was.
- **The struct stays where the author wrote it.** `struct Params` is hoisted because the uniform block is built from it; `struct Instance` is only named by `SurfaceIn`, and a module-scope declaration is in scope for the whole module.
- **Field types are the point attribute types**: f32, vec2f, vec3f, vec4f, u32, vec4u. Another type refuses at the material, by name. There is no i32 because no attribute is one.
- **An attribute of the field's name in another type refuses.** It does not fall back to the default: the author meant that attribute.
- **Only bound fields are in the record.** A field on its default is a constant in the shader text, so the record is as wide as what the points actually feed.
- **A field with no declared default is zero on a draw with no instances** (a Surface wearing the same material). The refusal for a missing default is the mesh-instance draw's, where a value was expected and none arrived.
- **Instance Attributes is inactive and ignored on any other geometry.** It is structural (`compileTime`): which attributes a draw reads is its bindings.
- **The Geometry's preview tile runs no Material · WGSL**, as before this slice; nothing there reads a field.

### The `quat` module, and `// @use` in a kernel (F9, built)

- **`// @use quat`** (`nodes/shaders/shared-modules.ts`) declares `quatAxisAngle(axis, angle)`, `quatMul(a, b)`, `quatRotate(q, v)`, `quatFromFrame(x, y, z)`, `quatLookAt(forward, up)`, `quatFromTo(a, b)` and `quatSlerp(a, b, t)`. The convention is D5's, stated once there: a unit quaternion is a `vec4f` (x, y, z, w), a turn is right-handed and active (a quarter turn about +Z carries +X to +Y), and `quatMul(a, b)` turns by `b` first, then by `a`. `quatLookAt` turns +Z onto `forward` and +Y as near to `up` as it can be; `up` is a hint and need not be unit or square to `forward`.
- **Two inputs have no single answer, and the module picks one that is finite.** `quatLookAt` with `up` along `forward` picks a roll; `quatFromTo` between opposite directions picks a half turn about an axis square to them. The tests pin that the instance is drawn whole and that the determined axis is right, and say in a comment that the rest is the module's choice.
- **A Point Kernel did not resolve `// @use` before this.** Only Custom WGSL and Material · WGSL called `resolveSharedModules`; in a kernel the line was a comment, and the first call into the module failed at the device. What it took: `kernelSharedModules` in `nodes/definitions/points.ts` (the one resolver, the same two refusals by name: a module that does not exist, and a name the text and a module both declare, code `node.points.module`), the module text pasted in front of the kernel body, and `kernelSourceMap` moved down by that text so a device error still reads the author's line. Point Kernel and Point Kernel · Advanced both call it. `points/codegen.ts` was not touched.
- **The Spawn Hook asks for itself.** It is a module of its own, so a hook that turns its newborns writes its own `// @use quat`; it is not handed what the kernel asked for. A Group predicate is an expression and has no line to ask on.
- **No shipped document changes.** No kernel, hook or group in `examples/**` or `projects/**` carries a `// @use` line (112 documents scanned), so every generated kernel is byte for byte what it was.
- **Only `quat` is claimed for kernels.** The other modules resolve by the same path and declare no name a generated kernel module declares, but `grid`, `surface-detail` and `light-depth` were written for fragment shaders and were not run in a kernel.

### Measured (slice B, GPU timestamp queries)

Apple M3 Max, Dawn on Metal, 1920×1080, `rgba16float`. 4,000 instances of a 716-triangle ring (2.86 M triangles per pass), every instance turned by a quaternion that changes each frame, over a floor, one light. The figure is the device's own frame extent from timestamp queries (`backend.onGpuTimings`), the median of 40 frames after 8 warm-up frames. Scratch probe, not committed.

| Passes | Mesh passes | GPU frame |
|---|---|---|
| colour, no shadow | 1 | 2.9 ms |
| colour + Depth + Normal + Albedo + one directional shadow | 5 | 7.1 ms |
| colour + one point-light shadow (six faces) | 7 | 9.1 ms |
| colour + Depth + Normal + Albedo + one point-light shadow | 10 | 12.5 ms |

- The lit instanced draw is about 2.7 to 3.1 ms; a G-buffer layer 1.7 to 2.4 ms; a depth sweep 0.9 to 2.6 ms. The resolve pass does not register (under the timer's 0.07 ms step).
- **The point-light case is over the 6 ms line the lead set, so F1 (cull and compaction) moves up.** Each of the six faces sweeps all 4,000 instances and sees about a sixth of them; a per-view cull is what that costs.
- The consumer's own load (630 instances a robot, 3 to 5 robots, about 3,150 instances and 2.3 M triangles per pass) is 0.79 of this one; by proportion about 7 ms and 10 ms for the two point-light rows. Not measured at that count.
- This is one machine, one layout and one resolution. It is not a browser measurement.

### Measured again after slice E

The same probe, the same machine, the same day as slice E landed. Three materials on the 4,000 rings: the stock default (the rows above, re-taken), a Material · WGSL that glows from constants, and the same material reading three f32 `struct Instance` fields (`tentacle`, `ring`, `glow`) that a kernel writes per point. Median of 40 frames; the WGSL rows were taken twice.

| Passes | Stock, slice B | Stock, re-taken | Material · WGSL | + three instance fields |
|---|---|---|---|---|
| colour, no shadow | 2.9 ms | 2.9 ms | 3.0 ms (4.1) | 3.2 ms (4.7) |
| colour + Depth + Normal + Albedo + one directional shadow | 7.1 ms | 7.2 ms | 7.2 ms (7.3) | 7.3 ms (7.3) |
| colour + one point-light shadow | 9.1 ms | 9.1 ms | 9.0 ms (9.2) | 9.2 ms (9.2) |
| colour + Depth + Normal + Albedo + one point-light shadow | 12.5 ms | 12.3 ms | 12.3 ms (12.6) | 12.6 ms (12.8) |

- In brackets is the other of the two runs. The colour-only WGSL rows of the first run had frames between 3.1 and 8.2 ms on a machine other sessions were using; the second run's were between 2.8 and 3.6 ms. The other rows agree to 0.3 ms between runs.
- **Three custom fields cost about 0.1 to 0.2 ms on the lit draw and nothing measurable elsewhere.** The record is 12 bytes an instance wider; the resolve pass still does not register; the depth sweeps do not read the fields.
- The frame is still over the 6 ms line with a point-light shadow, for the reason slice B gave: six sweeps of every instance.
