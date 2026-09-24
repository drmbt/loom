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
                  "caster_rollers_1"]
REQUIRED_EMIT = ["emit.arc_1", "emit.arc_2", "emit.arc_3", "emit.tap_stream", "emit.ladle_lip", "emit.slag_door",
                 "emit.fume_duct_mouth", "emit.louvre_shaft_01"]


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
    if errors:
        print("VALIDATION FAILED:")
        for e in errors:
            print("  -", e)
        sys.exit(1)
    print("VALIDATION OK")


main()
