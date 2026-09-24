# Furnace music video: plan (2026-09-24)

The brief, from the owner: visuals for an industrial glitch / IDM track. The scene is a rough steel plant
built around an electric arc furnace, highly detailed and running: electrodes, ladles, a crane, a
conveyor. It must support many camera fly-throughs and framings. Lighting is intricate, part physical
and part not. It must glitch hard. Geometry is authored in Blender, through scripts or MCP, and imported
into loom. The whole piece is audio driven: we set boundaries, and the music (energy, build-ups, drops)
chooses within them. It is never keyframed to the track. The bar is "ready to publish". It ships as a
live tier and an offline tier from the same graph. There is no track yet; build against a stand-in clip.

Owner decisions (2026-09-24): GLB import (a real mesh subsystem); live AND offline tiers; engine
features land in the repo as SPEC rows; the scene is its own project, not a shipped example. Do not
copy the look of existing examples. Take mechanisms from them, and take the look from real-world
reference.

## What exists and what is missing

This comes from the capability survey, with file:line references in the session log.

- There is no mesh import of any format, and there are no index buffers. The `"gltf"` asset kind is a
  dead literal. The renderer draws triangles only from pointsets that carry a `grid:` topology, and it
  pulls vertices from storage buffers (`vertexCount = cells × 6`). There is no vertex-buffer path.
- The renderer does have PBR (GGX), shadows (directional, PCF), AO, IBL-lite and MSAA/SSAA. It has no
  emissive term, no point-light shadows and no volumetric light.
- The camera node has eye, lookAt, fov and roll, driven by expressions. There are no paths or stations.
- Audio gives 18 log bands, onsets, kick/snare/hat, tempo, beat phase and a whole-file offline
  analysis. There is no section, build-up or novelty detection.
- There are no stock post or glitch nodes beyond the basics. Bloom, DOF, haze and slice-glitch exist
  only as example WGSL.

## Architecture

### A. Mesh import is a POINTSET PRODUCER (the TD "File In POP")

`meshFileIn` loads a GLB and publishes its vertices as an ordinary pointset. Each vertex is a point
with these attributes:

| attribute  | type  | meaning                                                                        |
|------------|-------|--------------------------------------------------------------------------------|
| `position` | vec3f | world-space rest position (node transforms baked at load)                      |
| `normal`   | vec3f | world-space rest normal                                                        |
| `uv`       | vec2f | TEXCOORD_0                                                                     |
| `color`    | vec4f | material baseColor × COLOR_0                                                   |
| `surface`  | vec4f | roughness, metallic, emissive strength, part index                             |
| `emissive` | vec4f | emissive rgb (linear) × strength, alpha = heat mask (see §C)                   |

The connectivity is a new topology claim, `mesh:<triangles>`, whose index buffer the node owns.

Why a pointset and not a new "mesh" payload: everything downstream already works on pointsets.
- A `pointKernel` can deform the mesh: part animation, glitch displacement, explode, melt, jitter by
  audio. Its WGSL sees `p.position`, `p.normal` and `p.surface.w` (the part).
- `geometry` in points mode renders the same vertices as sparks or dust.
- `pointTopology` can drop the claim.

This is how TouchDesigner's File In POP works. The mesh is a pointset with a connectivity claim, the
same as the grid is today.

**Parts.** A Blender object with the custom property `loom_part = "<name>"` becomes a part. Its
vertices are stored in rest pose, and the part's pivot (the object origin) and axes are published.
Everything else is part 0, which is static. A part is animated by a kernel: it reads the part index
and applies a transform from its own `Params`. Those fields are drivable controls, so audio drives
them. There is no baked Blender animation. The music drives the machine.

**Compile-time sizes.** Compilation is pure and cannot read files. The node therefore carries a
compile-time `layout` parameter: vertex count, triangle count, part table, bounds and the file's
hash. The app writes it through the bus when a file is attached or loaded, and headless tests set it
directly. The bytes arrive at run time through a buffer source registered under the node's
`sourceId`, the same pattern §V135 uses for media (the plan never carries bytes). The backend uploads
them to both halves of the node's buffer pair, and again after any clear or reallocation. Until the
bytes arrive, the index buffer is zero and every triangle is degenerate, so the node draws nothing,
visibly and safely.

**The parser is ours, and it is small.** We control the exporter, so we accept exactly: glTF 2.0
binary, float32 positions/normals/uvs, u16/u32 indices, TRIANGLES mode, the PBR metallic-roughness
factors, `KHR_materials_emissive_strength`, `KHR_lights_punctual`, cameras and `extras`. Anything else
is refused by name: Draco, meshopt, sparse accessors, skins, morph targets. There is no dependency.

### B. Renderer: a mesh surface and per-vertex materials

- `geometry` surface mode accepts `mesh:` topology. The vertex stage reads `index[vertex_index]` and
  pulls that vertex's attributes. It uses the attribute normal, not a grid-derived one. The shadow and
  depth sweeps get the same path.
- The optional `surface` and `emissive` attribute maps work like the existing `color` map (T478): they
  multiply or override per vertex, so one draw carries a whole plant with many materials.
- The material gains an EMISSIVE term (an HDR additive radiance that is unlit and survives
  tonemapping into bloom).
- Point-light shadows are out of scope for the first cut. The furnace glow reads through emissive,
  bloom and haze, and the key and rim lights stay directional with shadows.

### C. Look: the render stack for the scene

These live in the scene project as custom WGSL first. Each one is promoted to a stock node only when
it proves itself.
- Molten metal: emissive driven by a heat mask (the `emissive.a` channel). A kernel or fragment
  flow-noise scrolls along the uv, and a crust of cooling slag goes dark at low heat.
- Volumetric light: a depth-aware scattering pass (froxel-lite) with the furnace mouth, the arc and
  the ladle pour as emitters. It also carries god rays through the roof louvres.
- Particles: sparks along ballistic paths with drag and bounce on the floor plane, embers, steam and
  smoke sheets.
- Heat haze: screen-space refraction masked by heat and depth.
- The arc: an electric discharge between the electrode tips and the melt. It is procedural beams whose
  flicker and branching are driven by transients.
- Post: bloom (a multi-scale energy-conserving chain), DOF, anamorphic flare, chromatic aberration,
  grain, halation, a filmic grade and the tone curve.
- A glitch layer that operates in 3D as well as on pixels: part displacement and vertex explode in the
  kernel, datamosh (a feedback plus motion-vector hold), pixel sort, block tear, depth-slice offsets and
  scanline shear. Each has an intensity channel that the director drives.

### D. Camera: shots come from Blender

Cameras exported in the GLB become named framings: the loader publishes each one's pose, fov and
name. A `cameraRig` (in the scene project first) moves between framings with drift, handheld noise,
dolly and orbit around a framing's target, and hard cuts or slow travel. It is chosen by the director,
not timed to the song.

### E. The director: "boundaries, not a script"

This is a value-graph layer that turns the feature track into scene state. The owner's direction
(2026-09-24) is to extend the existing `AudioAnalysis` starter component (T1230) instead of starting a
parallel analyser. It gets a third lane, `structure`, next to `levels` and `hits`. That lane is built
from generic, reusable value nodes (a windowed trend, an event rate, multi-channel novelty, a step
detector) that other graphs can also pull from. Detectors that need the spectrum bins, such as
flatness, stay on the source node's analysis engine, per §T821.
- Energy: loudness normalised over 30–60 s windows, which tracks arrangement-scale drift.
- Build-up: a sustained positive slope of energy plus rising high-band density and onset rate over
  4–16 bars.
- Drop: a large positive energy step after a build-up, or after a low-energy trough.
- Breakdown: a sustained low-energy stretch with low onset rate.
- Transient character: kick, snare, hat and glitch-y broadband clicks (spectral flux spikes) drive the
  arc, sparks and glitch.

The owner states boundaries: a shot pool per state, intensity ranges, which glitches are allowed in
which state, and the minimum shot length. The director picks within them, deterministically, off the
feature track and a seed, so an offline render reproduces.

### F. Live and offline tiers

One graph. A `quality` switch changes only the compile-time costs (SSAA factor, shadow map scale,
volumetric steps, particle count, mesh LOD). Live targets 60 fps at 1080p on an M-series GPU. Offline
runs at any frame cost through `export.renderRange` with the track muxed in.

## Blender side

`tools/blender/furnace/` holds bpy scripts, run headless:
`Blender --background --python tools/blender/furnace/build.py -- --out <glb>`. The plant is procedural
and seeded, so it rebuilds from the script and we never keep a hand-edited .blend. The generated GLB
is gitignored. The contract loom reads:
- `loom_part` custom properties on moving parts, with origins at the pivots;
- materials: principled BSDF factors, emission colour and strength, plus a `loom_heat` custom property
  that bakes into the heat mask;
- cameras named `shot.<name>` as the framings;
- empties named `emit.<name>`, which are emitter positions (the arc, the tap, the pour) that loom
  reads as points.

Plant inventory for the first cut:
- the EAF shell with a water-cooled panel roof, a swinging roof, three graphite electrodes on mast
  arms, the busbars and the transformer vault;
- the tapping spout and the ladle;
- an overhead crane on a runway;
- the ladle car on rails;
- slag pots;
- a conveyor for scrap buckets;
- a continuous caster strand with rollers;
- the building structure: columns, trusses, roof louvres, catwalks, stairs, handrails, pipes and
  cable trays.

It is detailed through instancing: bolts, rollers and grating.

## Phases and rows

1. **Mesh import** (engine): the GLB parser, the `meshFileIn` node, the `mesh:` topology, the
   external buffer upload, the mesh surface draw with its shadow and depth path, the per-vertex
   surface and emissive maps, and the emissive term. Dawn tests assert from rendered pixels, with a
   GLB built in the test.
2. **Blender plant v1**: the script, the contract, and a GLB loaded into loom through phase 1.
3. **Look**: molten metal, volumetric light, sparks, haze, the arc and the post stack. The scene
   project runs live.
4. **Camera rig** and the framings from Blender.
5. **Director**: section, build-up and drop detection, plus the boundary spec.
6. **Glitch layer**.
7. **Tiers and the offline render**, tuned on the real track once it arrives.

Every phase ends with rendered frames compared against the reference board, not against earlier
examples.

## Backlog: everything deferred is a SPEC row

The owner's rule (2026-09-24): nothing deferred lives only in a session. Every "not yet" from
building this piece is an open §T row. Close a row when it lands; add one the moment
something is deferred.

| Row | What |
|-----|------|
| T1356b | Mesh preview tile frames the mesh's bounds and draws it |
| T1357b | Glass on a mesh (pulpit windows) |
| T1358b | GLB image textures (baseColor, metallicRoughness, normal, emissive) |
| T1359b | GLB decode in a Worker |
| T1360b | Material · WGSL preview tile runs the code |
| T1361b | Material · WGSL on instances, points and beams |
| T1362b | Point-light shadows (the furnace's local lights leak without them) |
| T1363b | Part hierarchy (`loom_parent`) and marker extras (lamp colour, lumens) decoded |
| T1364b | GLB cameras and markers as live graph data (not baked at build time) |
| T1365b | Custom WGSL with more than one input (colour + depth without alpha packing) |
| T1366b | Mesh binding headroom: attribute packing, or a larger device binding |
| T1367b | A Mesh File In inside a component |
| T1368b | Emissive on the stock materials |
| T1369b | Glitch nodes: datamosh, pixel sort, lens flare, block tear, RGB split |
| T1370b | The director: the `structure` lane on AudioAnalysis |

The Blender side's open items (retopology, area prefixes, weak close-ups, lamp markers) are
tracked on T1354b.

### The renderer gap (owner review of v0, 2026-09-24)

The owner's verdict on v0: "far far from production look … not HDR enough … materials lacking
… PS1 level vibe rather than a super high end 2026 visualizer trying to compete with unreal
engine 5". The gap is techniques, not tuning:

| Row | What |
|-----|------|
| T1362b | Point-light shadows |
| T1371b | Render outputs a G-buffer (normal, material, motion vectors) |
| T1372b | Screen-space reflections |
| T1373b | GTAO + screen-space GI |
| T1374b | TAA + motion blur |
| T1375b | Shadowed froxel volumetrics |
| T1376b | Physically based bloom, AgX, bokeh DOF, lens effects |
| T1377b | Procedural surface detail modules for Material · WGSL |

Order: T1377b and the Blender bevel pass first (no engine change, biggest material win), then
T1362b, then T1371b and the post passes it unlocks.
