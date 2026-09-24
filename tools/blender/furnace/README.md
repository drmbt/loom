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

- A build takes about 15 s, plus about 2 s per preview still (EEVEE, 1280×720, bloom). `--quick` renders with 16 samples instead of 48.
- `--only` builds a subset of modules while you iterate.
- `validate.py` reimports the GLB in a fresh Blender and checks the parts, `extras`, cameras, emitters, lights and hot materials. It also refuses Draco, meshopt, sparse accessors, skins, morph targets, animations and any mode other than TRIANGLES. It exits non-zero on any failure.

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

| part | pivot (Blender x, y, z) | motion (Blender axes → glTF) | parent | tris |
|---|---|---|---|---|
| furnace_shell | (0, 0, 10.8), the rocker curvature centre | rotate about Y (tilt; +angle tips the EBT at +X down; ≈15–20° to tap) → glTF rotate about −Z | – | 170,674 |
| furnace_roof | (4.4, 5.9, 12.56), the swing column axis | translate Z (lift ~0.5 m) then rotate about Z (swing ~70°) → glTF +Y, then about Y | furnace_shell | 67,688 |
| electrode_1/2/3 | electrode tip (x_i, y_i, 9.45) | translate Z (−0.6…+3.5 m). Includes the mast column, the current-conducting arm, the clamp and the graphite string | furnace_shell | 7,680 / 7,408 / 7,680 |
| crane_bridge | (−10.5, 0, 24.0) | translate X (runway travel) → glTF X | – | 53,104 |
| crane_trolley | (−10.5, −4.2, 26.65) | translate Y (along the bridge) → glTF −Z | crane_bridge | 24,844 |
| crane_ropes | (−10.5, −4.2, 28.45), the drum line | scale Z about the pivot so the bottom follows the hook → glTF scale Y | crane_trolley | 96 |
| crane_hook | (−10.5, −4.2, 21.0) | translate Z (hoist) → glTF Y | crane_trolley | 1,920 |
| scrap_bucket | bail pin (−10.5, −4.2, 19.55) | small swing about X or Y at the pin | crane_hook | 13,564 |
| scrap_bucket_jaw_1/2 | hinge (−8.25 / −12.75, −4.2, 14.45) | rotate about Y at the hinge (clamshell opens outward) | scrap_bucket | 616 each |
| crane2_bridge / trolley / ropes / hook | (27, 0, 24) / (27, 2.5, 26.65) / (27, 2.5, 28.45) / (27, 2.5, 19.5) | same axes as crane_*. The hook carries the ladle lifting beam with C-hooks | chain as for crane_* | 53,104 / 24,844 / 96 / 3,968 |
| ladle_car | (16, 0, 0) | translate X on the rails (x 4.9 … 34; 4.9 puts the ladle under the EBT) | – | 3,952 |
| ladle | trunnion axis (16, 0, 4.12) | rotate about Y (pour; +angle tips the lip at +X down) | ladle_car | 7,818 |
| slag_pot | trunnions (−8.3, 0, 2.49) | rotate about Y (dump) | – | 3,480 |
| ladle_turret | (38, −0.4, 12.0) | rotate about Z (swap ladles; includes the casting ladle) | – | 14,590 |
| caster_rollers_1…5 | segment centre on the strand arc | roller spin = scroll TEXCOORD_0.v (circumference). Roller axes are Blender Y (glTF −Z) | – | 1,280 / 1,120 / 1,120 / 800 / 800 |
| caster_strand | (38, −6, 11.0), the top of the bow | withdrawal = scroll TEXCOORD_0.u (metres along the strand) | – | 356 |
| conveyor_belt | tail (−46, −11, 1.6) | belt travel = scroll TEXCOORD_0.u. The carrying run is u 0…L; the return run is u L+0.6…2L+0.6, L ≈ 40.9 m | – | 1,456 |

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

The remaining materials, all non-emissive: steel_painted_yellow, steel_painted_grey, steel_primer_red,
steel_painted_blue, paint_black, steel_dark, steel_worn, steel_galvanized, grating, rust, roof_sheet, concrete,
steel_heat, panel_cooled, refractory, graphite, copper_busbar, cable_rubber, hose_red, pipe_green, slag_cold,
scrap_mix, rubber_belt, glass_pulpit. That makes 33 materials in total.

## Cameras, emitters, lights

- **Cameras.** There are 17 `shot.*` cameras. Each has a real focal length on a 36 mm sensor (16–45 mm) and carries `loom_target` (the look-at point in Blender coordinates) in its extras:
  establish_wide, hero_low_furnace, electrode_closeup, crane_eye, ladle_pour, through_grating, pipe_corridor,
  pulpit_window, over_shoulder_ladle, top_down, caster_strand, conveyor_climb, cable_festoon, scrap_bay,
  slag_door, under_deck, ladle_furnace.
- **Emitters.** There are 34 `emit.*` empties. An emitter that rides a part is parented to it and carries `loom_follow = <part>`. They are:
  - arc_1..3, bath
  - tap_stream, spark_tap
  - slag_door, spark_slag_door, slag_fall
  - spark_roof_gap, furnace_mouth
  - fume_duct_mouth, fume_duct_exit
  - ladle_lip, ladle_surface
  - slag_pot_surface
  - scrap_bucket_drop
  - tundish_pour, caster_mould, caster_torch, spark_torch, caster_steam
  - conveyor_head, conveyor_tail
  - louvre_shaft_01..10
- **Lights.** There are 9 `light.*` lights (KHR_lights_punctual): furnace_glow, arc, slag_door, tap, tundish, and high_bay_1..4.

## Export facts loom's parser should expect

- Blender 5.1's exporter writes **COLOR_0 as float32 VEC3**, not VEC4.
- Indices are u16 or u32.
- All materials are `doubleSided: true`.
- Positions, normals and UVs are float32.
- There are no textures. UVs are box-projected in metres (×0.5) except on the belt, the strand and the rollers, which use the scroll UVs described above.
- The flat hall, deck and vault surfaces are subdivided to edges of 1–3 m, so both the grime and loom's vertex kernels have resolution to work with.
- The current build (seed 7) has **1,574,424 triangles** in a **96.5 MB** GLB, across 55 mesh nodes.
