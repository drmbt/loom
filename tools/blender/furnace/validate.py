"""Re-import the GLB in a fresh Blender and check the loom contract survived.

  Blender --background --factory-startup --python tools/blender/furnace/validate.py -- <path.glb>
Exits non-zero on any failure.
"""
import json
import struct
import sys

import bpy

REQUIRED_PARTS = ["electrode_1", "electrode_2", "electrode_3", "furnace_roof", "furnace_shell", "crane_bridge",
                  "crane_trolley", "crane_hook", "ladle", "ladle_car", "conveyor_belt", "scrap_bucket", "slag_pot",
                  "caster_rollers_1", "lance_carriage"]
REQUIRED_EMIT = ["emit.arc_1", "emit.arc_2", "emit.arc_3", "emit.tap_stream", "emit.ladle_lip", "emit.slag_door",
                 "emit.fume_duct_mouth", "emit.louvre_shaft_01", "emit.lance_tip"]
AREAS = ["hall", "furnace", "crane", "ladle", "caster", "conveyor", "pipes", "catwalk", "pulpit", "props"]
LAMP_AREAS = ["hall", "props", "catwalk", "crane", "pulpit", "furnace"]      # every one must carry fixtures
REQUIRED_MATERIALS = ["glass_pulpit", "steel_chequer"]
NODE_BUDGET = 1_100_000        # one loom meshFileIn node: ~1.5 M vertices max; keep each area well under
TOTAL_BUDGET = 1_300_000       # the plant as a whole (reported, not fatal: see README "Vertex budget")


def gltf_checks(j, errors, warnings):
    """Names, markers, materials and the vertex budget, read straight from the glTF JSON."""
    nodes = j.get("nodes", [])
    mats = [m.get("name") for m in j.get("materials", [])]
    for m in REQUIRED_MATERIALS:
        if m not in mats:
            errors.append(f"missing material {m}")
    per_area, verts, tris = {}, 0, 0
    used_mats = set()
    for nd in nodes:
        if "mesh" not in nd:
            continue
        name = nd.get("name", "")
        area = name.split(".", 1)[0]
        if "." not in name or area not in AREAS:
            errors.append(f"mesh node {name!r} has no area prefix ({', '.join(a + '.' for a in AREAS)})")
        v = t = 0
        for p in j["meshes"][nd["mesh"]]["primitives"]:
            v += j["accessors"][p["attributes"]["POSITION"]]["count"]
            t += j["accessors"][p["indices"]]["count"] // 3
            if "material" in p:
                used_mats.add(mats[p["material"]])
        a = per_area.setdefault(area, [0, 0])
        a[0] += v
        a[1] += t
        verts += v
        tris += t
    for m in REQUIRED_MATERIALS:
        if m in mats and m not in used_mats:
            errors.append(f"material {m} is not used by any primitive")
    for area, (v, t) in per_area.items():
        if v > NODE_BUDGET:
            errors.append(f"area {area} has {v:,} vertices (> {NODE_BUDGET:,}: it cannot be one loom node)")
    if verts > TOTAL_BUDGET:
        warnings.append(f"total {verts:,} vertices is over the {TOTAL_BUDGET:,} budget")
    lamps = [nd for nd in nodes if nd.get("name", "").startswith("lamp.")]
    louvres = [nd for nd in nodes if nd.get("name", "").startswith("louvre.")]
    for nd in lamps + louvres:
        if "mesh" in nd or nd.get("children"):
            errors.append(f"marker {nd['name']} must be a meshless, childless node")
    for nd in lamps:
        ex = nd.get("extras") or {}
        parts = nd["name"].split(".")
        if len(parts) != 3 or parts[1] not in AREAS:
            errors.append(f"lamp marker {nd['name']} is not lamp.<area>.<nn>")
        col = ex.get("loom_light_color")
        if not (isinstance(col, list) and len(col) == 3 and all(isinstance(c, (int, float)) for c in col)):
            errors.append(f"{nd['name']}: loom_light_color must be [r, g, b]")
        if not (isinstance(ex.get("loom_light_lumens"), (int, float)) and ex["loom_light_lumens"] > 0):
            errors.append(f"{nd['name']}: loom_light_lumens must be > 0")
    lamp_areas = {nd["name"].split(".")[1] for nd in lamps if nd["name"].count(".") == 2}
    for a in LAMP_AREAS:
        if a not in lamp_areas:
            errors.append(f"no lamp.{a}.* markers")
    if len(louvres) < 20:
        errors.append(f"only {len(louvres)} louvre.* markers")
    for nd in louvres:
        ex = nd.get("extras") or {}
        for k in ("loom_opening", "loom_shaft_dir", "loom_opening_normal", "loom_opening_size"):
            if k not in ex:
                errors.append(f"{nd['name']}: missing {k}")
    return per_area, verts, tris, lamps, louvres


def glb_json(path):
    with open(path, "rb") as f:
        d = f.read()
    assert d[:4] == b"glTF", "not a GLB"
    n = struct.unpack("<I", d[12:16])[0]
    return json.loads(d[20:20 + n]), len(d)


def main():
    path = sys.argv[sys.argv.index("--") + 1]
    errors = []
    j, size = glb_json(path)
    used = set(j.get("extensionsUsed", []))
    for bad in ("KHR_draco_mesh_compression", "EXT_meshopt_compression"):
        if bad in used:
            errors.append(f"forbidden extension {bad}")
    if j.get("animations"):
        errors.append("animations present")
    if j.get("skins"):
        errors.append("skins present")
    for m in j.get("meshes", []):
        for p in m["primitives"]:
            if p.get("targets"):
                errors.append(f"morph targets on {m['name']}")
            if p.get("mode", 4) != 4:
                errors.append(f"non-triangle primitive on {m['name']}")
            for att in ("POSITION", "NORMAL", "TEXCOORD_0", "COLOR_0"):
                if att not in p["attributes"]:
                    errors.append(f"{m['name']}: missing {att}")
            if "sparse" in j["accessors"][p["attributes"]["POSITION"]]:
                errors.append("sparse accessor")
    tris = 0
    for m in j.get("meshes", []):
        for p in m["primitives"]:
            tris += j["accessors"][p["indices"]]["count"] // 3
    hot = {m["name"]: m.get("extras", {}).get("loom_heat") for m in j.get("materials", [])}
    warnings = []
    per_area, verts, tris_v, lamps, louvres = gltf_checks(j, errors, warnings)

    # re-import through Blender's importer
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    objs = {o.name: o for o in bpy.data.objects}
    parts = {o.get("loom_part"): o for o in objs.values() if o.get("loom_part")}
    for p in REQUIRED_PARTS:
        if p not in parts:
            errors.append(f"missing part {p}")
    for e in REQUIRED_EMIT:
        if e not in objs:
            errors.append(f"missing empty {e}")
    cams = sorted(o.name for o in objs.values() if o.type == "CAMERA" and o.name.startswith("shot."))
    if len(cams) < 12:
        errors.append(f"only {len(cams)} shot cameras")
    emits = sorted(o.name for o in objs.values() if o.name.startswith("emit."))
    lights = sorted(o.name for o in objs.values() if o.type == "LIGHT")
    for name, o in parts.items():
        if o.type != "MESH":
            errors.append(f"part {name} is not a mesh")
    lc = parts.get("lance_carriage")
    if lc is not None and len(lc.get("loom_axis", [])) != 3:
        errors.append("lance_carriage: loom_axis must be a glTF-space [x, y, z] direction")
    print("=" * 60)
    print(f"GLB {path}: {size / 1e6:.1f} MB, {tris} triangles, {len(j['meshes'])} meshes, {len(j['materials'])} materials")
    print(f"parts ({len(parts)}):", ", ".join(sorted(parts)))
    for name in sorted(parts):
        o = parts[name]
        print(f"   {name:22s} origin(glTF->Blender Z-up) {tuple(round(v, 3) for v in o.matrix_world.translation)}"
              f"  parent={o.get('loom_parent', '')!r}")
    print(f"cameras ({len(cams)}):", ", ".join(cams))
    print(f"emitters ({len(emits)}):", ", ".join(emits))
    print(f"lights ({len(lights)}):", ", ".join(lights))
    print("hot materials:", {k: v for k, v in hot.items() if v is not None})
    print(f"vertices {verts:,}  triangles {tris_v:,}  ratio {verts / max(tris_v, 1):.3f}  (loom expands every node)")
    for a, (v, t) in sorted(per_area.items(), key=lambda kv: -kv[1][0]):
        print(f"   area {a + '.*':12s} {v:9,d} verts {t:9,d} tris")
    by_area = {}
    for nd in lamps:
        by_area[nd["name"].split(".")[1]] = by_area.get(nd["name"].split(".")[1], 0) + 1
    print(f"lamp markers ({len(lamps)}):", ", ".join(f"{a} {n}" for a, n in sorted(by_area.items())))
    kinds = {}
    for nd in louvres:
        k = (nd.get("extras") or {}).get("loom_opening", "?")
        kinds[k] = kinds.get(k, 0) + 1
    print(f"louvre markers ({len(louvres)}):", ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())))
    for w in warnings:
        print("WARNING:", w)
    if errors:
        print("VALIDATION FAILED:")
        for e in errors:
            print("  -", e)
        sys.exit(1)
    print("VALIDATION OK")


main()
