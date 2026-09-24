# Furnace melt shop generator (Blender side of the furnace music video)

Procedural, seeded bpy generator for a heavily used electric arc furnace melt shop, exported as one GLB
that loom's `meshFileIn` imports. See `docs/furnace-mv-plan-2026-09-24.md` ("Blender side").
Nothing here is hand-edited in Blender. The GLB is rebuilt from the scripts, and generated files are gitignored.

## Run

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B --background --factory-startup --python tools/blender/furnace/build.py -- --out <path.glb> [--seed 7] \
   [--preview <png dir>] [--shots hero_low_furnace,crane_eye] [--quick] [--only hall,furnace] [--blend <path.blend>]
$B --background --factory-startup --python tools/blender/furnace/validate.py -- <path.glb>
```

- A build takes about 15 s, plus a few seconds per preview still (EEVEE, 1280×720, bloom). `--quick` renders with 16 samples instead of 48.
- The build prints the GLB's vertex and triangle counts per area, as loom's decoder will expand them, and writes them to `<out>.stats.json`.
- `FURNACE_PROFILE=1` prints which primitive calls own the split vertices (for retopo work). `FURNACE_NO_HIDDEN=1` turns the hidden-face pass off.
- `--only` builds a subset of modules while you iterate.
- `validate.py` reimports the GLB in a fresh Blender and checks the parts, `extras`, cameras, emitters, lights and hot materials. It also refuses Draco, meshopt, sparse accessors, skins, morph targets, animations and any mode other than TRIANGLES. It checks that every mesh node carries an area prefix, that no area exceeds 1.1 M vertices (one loom node), the `lamp.*` and `louvre.*` markers and their extras, and the `glass_pulpit` and `steel_chequer` materials. It prints the vertex budget per area and warns when the total exceeds 1.3 M. It exits non-zero on any failure.

Modules: `build.py` (the orchestrator, export and stats), `util.py` (the numpy mesh builder and primitives),
`materials.py`, `grime.py` (vertex colours), `layout.py` (all plant coordinates), `hall.py`, `furnace.py`,
`crane.py`, `ladle.py`, `caster.py`, `conveyor.py`, `pipes.py`, `catwalks.py`, `pulpit.py`, `props.py`,
`cameras.py` (shots, emitters and lights), and `preview.py` (preview lighting only; it is never exported).

## Coordinates

Everything is authored in real metres in Blender (Z up) and exported +Y up. The mapping is **glTF (x, y, z) = Blender (x, z, −y)**.
The hall is 120 m (X, the crane runway) by 34 m (Y) and 30 m to the eaves (37 m at the roof monitor). The furnace sits at the origin.

- Tapping (EBT) faces +X.
- The slag door faces −X.
- The masts and transformer vault are on +Y.
- The control pulpit is on −Y.
- The scrap bay is at −X. The ladle bay, ladle furnace and caster are at +X.
- The operating deck is at Blender z = 6.2 m.

## PARTS

A moving object carries `loom_part`. Its origin is the physical pivot and it has **identity rotation**, so its axes are the
world axes. Each part object also carries `loom_parent` (the part it rides on, or "") and `loom_motion` (text).
In the glTF the parts are nested nodes that follow `loom_parent`, so the loader must compose world transforms. Every
object without `loom_part` is static (part 0).

| part | object | pivot (Blender x, y, z) | motion (Blender axes → glTF) | parent | verts / tris |
|---|---|---|---|---|---|
| furnace_shell | furnace.shell | (0, 0, 10.8), the rocker curvature centre | rotate about Y (tilt; +angle tips the EBT at +X down; ≈15–20° to tap) → glTF rotate about −Z | – | 79,639 / 107,262 |
| furnace_roof | furnace.roof | (4.4, 5.9, 12.56), the swing column axis | translate Z (lift ~0.5 m) then rotate about Z (swing ~70°) → glTF +Y, then about Y | furnace_shell | 28,450 / 41,821 |
| electrode_1/2/3 | furnace.electrode_1/2/3 | electrode tip (x_i, y_i, 9.45) | translate Z (−0.6…+3.5 m). Includes the mast column, the current-conducting arm, the clamp and the graphite string | furnace_shell | ≈3,300 / 4,300 each |
| lance_carriage (new) | furnace.lance_carriage | (−8.81, 2.02, 9.02), the carriage centre on the boom | translate along `loom_axis` (the boom axis, given in glTF space in the node's extras): 0 = lances in the slag door, −2.4 m = retracted | – | 1,690 / 1,994 |
| crane_bridge | crane.bridge | (−10.5, 0, 24.0) | translate X (runway travel) → glTF X | – | 27,110 / 32,462 |
| crane_trolley | crane.trolley | (−10.5, −4.2, 26.65) | translate Y (along the bridge) → glTF −Z | crane_bridge | 10,725 / 15,854 |
| crane_ropes | crane.ropes | (−10.5, −4.2, 28.45), the drum line | scale Z about the pivot so the bottom follows the hook → glTF scale Y | crane_trolley | 96 / 96 |
| crane_hook | crane.hook | (−10.5, −4.2, 21.0) | translate Z (hoist) → glTF Y | crane_trolley | 1,457 / 1,762 |
| scrap_bucket | crane.scrap_bucket | bail pin (−10.5, −4.2, 19.55) | small swing about X or Y at the pin. Carries the jaw cylinder barrels | crane_hook | 9,209 / 10,868 |
| scrap_bucket_jaw_1/2 | crane.scrap_bucket_jaw_1/2 | hinge (−8.25 / −12.75, −4.2, 14.45) | rotate about Y at the hinge (clamshell opens outward). Carries the cylinder rods and lever lugs; the rods slide ~0.25 m inside the barrels | scrap_bucket | 688 / 892 each |
| crane2_bridge / trolley / ropes / hook | crane.crane2_* | (27, 0, 24) / (27, 2.5, 26.65) / (27, 2.5, 28.45) / (27, 2.5, 19.5) | same axes as crane_*. The hook carries the ladle lifting beam with C-hooks | chain as for crane_* | 27,110 / 10,725 / 96 / 2,539 verts |
| ladle_car | ladle.car | (16, 0, 0) | translate X on the rails (x 4.9 … 34; 4.9 puts the ladle under the EBT) | – | 2,771 / 3,704 |
| ladle | ladle.ladle | trunnion axis (16, 0, 4.12) | rotate about Y (pour; +angle tips the lip at +X down) | ladle_car | 8,489 / 10,884 |
| slag_pot | ladle.slag_pot | trunnions (−8.3, 0, 2.49) | rotate about Y (dump) | – | 2,990 / 3,706 |
| ladle_turret | caster.ladle_turret | (38, −0.4, 12.0) | rotate about Z (swap ladles; includes the casting ladle) | – | 12,581 / 14,966 |
| caster_rollers_1…5 | caster.rollers_1…5 | segment centre on the strand arc | roller spin = scroll TEXCOORD_0.v (circumference). Roller axes are Blender Y (glTF −Z) | – | 880–1,280 each |
| caster_strand | caster.strand | (38, −6, 11.0), the top of the bow | withdrawal = scroll TEXCOORD_0.u (metres along the strand) | – | 392 / 356 |
| conveyor_belt | conveyor.belt | tail (−46, −11, 1.6) | belt travel = scroll TEXCOORD_0.u. The carrying run is u 0…L; the return run is u L+0.6…2L+0.6, L ≈ 40.9 m | – | 1,488 / 1,456 |

Pivots and motions are unchanged from v1; `lance_carriage` is the only new part. The parts together hold about 245 k vertices.

## Materials

All materials are Principled BSDF factors: base colour, metallic, roughness, and emission colour + strength, which
exports as `KHR_materials_emissive_strength`. The base colour factor is multiplied by COLOR_0 (`grime`).
`loom_heat` is in material `extras`.

The hot materials:

| material | loom_heat |
|---|---|
| molten_steel | 1.0 |
| graphite_hot | 0.85 (electrode tips) |
| slag_hot | 0.7 |
| strand_hot | 0.6 (caster strand) |
| refractory_hot | 0.55 (furnace interior, roof seam, ladle lining) |
| graphite_warm | 0.35 (electrode just above the delta) |

These are emissive but not hot (they have no `loom_heat`): `lamp`, `sky_opening` (louvre and window daylight panels) and `screen_glow`.

Two materials exist so loom can treat them on their own:

- `glass_pulpit`: all glazing (pulpit front panes, side windows, the door vision panel, the crane cabs). The panes are thin boxes (12 mm). Select them into their own node with `material:glass_pulpit` and exclude them elsewhere with `!material:glass_pulpit`. In the GLB it is an opaque factor set; only `preview.py` makes it see-through.
- `steel_chequer`: walkway floor plate (the operating deck, the tilting platform, the trolley decks, the conveyor head platform, the pulpit plinth). The raised lozenge relief is too dense for geometry (about 0.5 M lozenges), so loom should draw it procedurally on this material.

The remaining materials, all non-emissive: steel_painted_yellow, steel_painted_grey, steel_primer_red,
steel_painted_blue, paint_black, steel_dark, steel_worn, steel_galvanized, grating, steel_chequer, rust, roof_sheet,
concrete, steel_heat, panel_cooled, refractory, graphite, copper_busbar, cable_rubber, hose_red, pipe_green, slag_cold,
scrap_mix, rubber_belt, glass_pulpit. That makes 34 materials in total.

## Cameras, emitters, lights

- **Cameras.** There are 17 `shot.*` cameras. Each has a real focal length on a 36 mm sensor (16–45 mm) and carries `loom_target` (the look-at point in Blender coordinates) in its extras:
  establish_wide, hero_low_furnace, electrode_closeup, crane_eye, ladle_pour, through_grating, pipe_corridor,
  pulpit_window, over_shoulder_ladle, top_down, caster_strand, conveyor_climb, cable_festoon, scrap_bay,
  slag_door, under_deck, ladle_furnace.
- **Emitters.** There are 35 `emit.*` empties. An emitter that rides a part is parented to it and carries `loom_follow = <part>`. They are:
  - arc_1..3, bath
  - tap_stream, spark_tap
  - slag_door, spark_slag_door, slag_fall
  - lance_tip (new, follows lance_carriage)
  - spark_roof_gap, furnace_mouth
  - fume_duct_mouth, fume_duct_exit
  - ladle_lip, ladle_surface
  - slag_pot_surface
  - scrap_bucket_drop
  - tundish_pour, caster_mould, caster_torch, spark_torch, caster_steam
  - conveyor_head, conveyor_tail
  - louvre_shaft_01..10
- **Lights.** There are 9 `light.*` lights (KHR_lights_punctual): furnace_glow, arc, slag_door, tap, tundish, and high_bay_1..4. They are reference lights; the lighting rig should come from the markers below.

## Lighting-rig markers

Markers are meshless, childless nodes, so loom's decoder returns each one as a marker: a world position plus a direction, which is the node's −Z. All vector extras on these markers are in **glTF space** (Y up).

**`lamp.<area>.<nn>`** is placed at every real light fixture, on the emitting face, with −Z along the beam. There are 65:

| area | n | fixtures |
|---|---|---|
| hall | 36 | 400 W metal-halide high-bays under the trusses, aimed straight down |
| props | 10 | column floodlights at 14 m, aimed down and in |
| catwalk | 6 | floodlights on the ladle-bay bridge (aimed at the car rails and the turret) and on the mast-top platform (aimed at the furnace roof) |
| crane | 8 | floodlights under both girders of both cranes. They carry `loom_follow` and are parented to the bridge part, so they travel with it |
| pulpit | 3 | two ceiling panels and the amber roof beacon |
| furnace | 2 | the wall packs on the transformer vault face |

Extras: `loom_light_kind` (high_bay, flood, wall_pack, panel, beacon), `loom_light_color` [r, g, b] linear, `loom_light_lumens`, `loom_light_cone_deg` (full angle), and `loom_light_dir` (glTF). The photometrics are in `layout.FIXTURES`. The colours match the `lamp` material's emission, except the panels and the beacon.

**`louvre.<nn>`** marks a daylight opening. There are 53. The node's −Z is the direction of the light shaft through the opening:

- monitor_louvre: 20, one per 12 m bay on each side of the roof monitor
- window_band: 20, one per bay on each long wall
- wall_gap: 11, missing wall sheets high up (placed by the seed)
- gable_door: 2, the big gable doors

Extras:

- `loom_opening`: the kind, from the list above.
- `loom_opening_size`: [width, height] in metres.
- `loom_opening_normal`: points into the hall (glTF).
- `loom_sunlit`: true when the sun shines in through this opening.
- `loom_shaft_dir`: glTF. It is the sun direction (`layout.SUN_EULER_DEG`, the same sun the previews use) for sunlit openings, and a steep inward skylight direction for the others.
- `loom_light_color`: warm sun or cold sky.

## Areas: splitting the plant across loom nodes

Every exported mesh object is named `<area>.<name>`, and it carries `loom_area` in its extras. Part objects follow the same rule (for example `crane.bridge` has `loom_part = crane_bridge`). Part names did not change.

| area | vertices | triangles | contents |
|---|---|---|---|
| `hall.*` | 424,704 | 381,756 | floor, apron, columns, runway, trusses, roof, walls, high-bay lamps |
| `furnace.*` | 232,375 | 328,029 | shell, roof, electrodes, lance manipulator and carriage, deck and rocker piers, vault, cables, fume duct |
| `props.*` | 169,278 | 188,401 | scrap piles, scrap bay walls, parked bucket, electrode racks, bottles, drums, floods, slag crust |
| `pipes.*` | 137,612 | 142,168 | pipe rack, north cable trays and return main, furnace cooling feed |
| `crane.*` | 90,443 | 114,480 | both cranes (all parts), scrap bucket and jaws, lifting beam |
| `caster.*` | 50,807 | 62,644 | casting floor, turret and casting ladle, tundish and car, mould, segments, rollers, runout, strand |
| `ladle.*` | 48,114 | 58,754 | ladle car, teeming ladle, rails, slag pot and stand, spare ladle, ladle furnace |
| `catwalk.*` | 31,545 | 31,950 | stairs, cage ladders, mast platform, ladle-bay bridge |
| `conveyor.*` | 25,469 | 24,372 | belt part, gallery, trestles, head, bunker |
| `pulpit.*` | 6,513 | 9,262 | control pulpit |
| **total** | **1,216,860** | **1,341,816** | 58 mesh nodes, 58.1 MB GLB |

One loom `meshFileIn` node holds about 1.5 M vertices at most (88 bytes per vertex in a 128 MiB binding). Split the plant with `select` globs. Three nodes, each under about 430 k vertices:

```
A  hall.*                                                     425 k
B  furnace.* crane.* ladle.* caster.*                         421 k   (every moving part except the belt)
C  props.* pipes.* catwalk.* conveyor.* pulpit.*              370 k
```

Two nodes also fit: `hall.* props.*` (594 k) and `!hall.* !props.*` (623 k). To give the glazing its own node, add `!material:glass_pulpit` to the node that holds `pulpit.*` and `crane.*`, and make a fourth node with `material:glass_pulpit`. `part:*` / `!part:*` split moving from static (245 k / 972 k).

## Vertex budget and retopo rules

In v1, the GLB expanded to **2,087,987 vertices for 1,574,424 triangles** (ratio 1.33). This build has **1,216,860 vertices for 1,341,816 triangles** (ratio 0.91), and it adds chamfers everywhere, weld beads, washers and the new machinery. The rules live in `util.py` and apply to every object:

- **Split normals only at real creases.** Faces are smooth-shaded. An edge is split when it bends more than 38°. Faces from one round primitive (a cylinder side, a tube, a torus, a lump, a hex bolt's flanks) form a *soft group*, and they split only above 95°. An 8-sided rail or a 6-sided bolt head therefore shades round, and the segment count can drop without the part turning faceted.
- **Radius-adaptive segments** (`util.seg_for`): 6 below r = 2 cm, 8 below 5 cm, 12 below 12 cm, 16 below 30 cm, 24 below 60 cm, and the caller's count above that.
- **Hardened slivers** (`util._thin_normals`). On plates, flat bars, flange tips and thin slabs, every vertex takes the normal of the wide face it belongs to, through custom split normals. The sliver faces then shade as a rounded arris, and they cost no extra vertices. A plate costs 8 vertices instead of 24, and an I-beam 56 instead of 72.
- **UVs follow the normals.** The box projection picks its axis per corner from the corner normal, not the face normal. A UV seam therefore never splits a vertex that the normals kept whole. The cost is a stretched strip where the projection axis flips on smooth curved surfaces; there are no textures.
- **Hidden faces are deleted.** This removes faces lying face-down on the floor or buried under it, bolt and washer bearing faces, and faces of closed solids that sit fully inside, or in full contact with, another closed solid of the same object (`util.occluded_faces`, a ray test from the centroid and three inset corners). Open sheets and open tubes never occlude and are never deleted. A vertex kernel that explodes solids apart will show these missing contact faces.
- **Less densification.** The walls went from 3.0 m to 6.5 m edges and the roof from 2.5 m to 7.0 m, which alone saved about 200 k vertices; fine grime is shader-side now. The floor (0.9 m), the vault face, the deck and the caster floor keep their v1 densities for vertex kernels.
- **Cheaper small parts.** Truss gusset bolts went from 6 to 3 a face (they are sub-pixel from every shot). Scrap-pile sections are a mix of angles, channels and I-beams, chosen from the seeded length, so the random stream is unchanged. Slag lumps are soft noisy spheroids (`util.lump`) instead of faceted rocks.
- **Not used:** merge-by-distance (the primitives are separate solids; welding them would break the crease rules), limited dissolve (the only coplanar splits are the deliberate densification), and mesh instancing (loom's decoder expands every node, so shared mesh data saves file size but not loom vertices).

## Chamfers (bevels) and weighted normals

Every convex hard crease (> 50°) on every non-scroll object gets a chamfer with **hardened normals**: the flats stay flat and the chamfer catches the light, which is the weighted-normals look. The chamfer is applied at build time, so the GLB carries it (`util._bevel`).

- **Width.** 6 % of the part's size, where the size is the smallest extent of its primitive's bounding box. It is clamped to 5–60 mm, so it lands at 5–20 mm on small parts and 20–60 mm on large steel, and it never exceeds 30 % of the edge.
- **Segments.** Chamfers of 20 mm or more get 2 segments (a rounded arris). Narrower ones get 1.
- **Not chamfered:**
  - concave roots
  - slivers, which already shade rounded
  - the facets of soft round parts
  - grating, glass, lamp and screen faces
- **Rims.** A cylinder or lathe rim next to a smooth surface is chamfered only from a radius of 12 cm up: flanges, drums, wheels, trunnions and the clamp rings. Below that, a rim chamfer would double the part's vertices for a sub-pixel highlight.

Surface relief:

- **Welds.** Fillet weld beads (soft 5-sided tubes that follow the dented plate) sit on the shell rib roots, the EBT bay stiffeners, the ladle ribs of all four ladles, and the crane girder web-to-flange seams.
- **Washers.** Bolt heads on flanges with pipe radius ≥ 0.33 m, on the column anchors, on the swing-column and turret bolt circles, and on the lance base sit on 12-gon washers.
- **Chequer plate** is material-only (`steel_chequer`, see Materials).

## Export facts loom's parser should expect

- Blender 5.1's exporter writes **COLOR_0 as float32 VEC3**, not VEC4. COLOR_0 is broad variation only; fine grime belongs to loom's shaders.
- Indices are u16 or u32.
- All materials are `doubleSided: true`.
- Positions, normals and UVs are float32. Normals include the custom split normals described above.
- There are no textures. UVs are box-projected in metres (×0.5) except on the belt, the strand and the rollers, which use the scroll UVs described above.
- The current build (seed 7) has **1,216,860 vertices / 1,341,816 triangles** in a **58.1 MB** GLB, across 58 mesh nodes.
