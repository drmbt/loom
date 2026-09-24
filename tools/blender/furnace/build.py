"""Furnace melt shop generator (Blender 5.1, headless).

  Blender --background --factory-startup --python tools/blender/furnace/build.py -- \
      --out <path.glb> [--seed N] [--preview <png dir>] [--shots a,b] [--only mod,mod] [--quick] [--blend <path>]
"""
import argparse
import importlib
import json
import math
import os
import sys
import time

import bpy

sys.dont_write_bytecode = True   # keep the source dir clean
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import util  # noqa: E402
import materials  # noqa: E402
import grime  # noqa: E402

MODULES = ["hall", "furnace", "crane", "ladle", "caster", "conveyor", "pipes", "catwalks", "pulpit", "props"]
# every exported object is named "<area>.<name>" so loom can split the plant with globs (`hall.*`, `!hall.*`)
AREA = {"hall": "hall", "furnace": "furnace", "crane": "crane", "ladle": "ladle", "caster": "caster",
        "conveyor": "conveyor", "pipes": "pipes", "catwalks": "catwalk", "pulpit": "pulpit", "props": "props"}


def area_name(area, name):
    for pre in (area + "_", area.rstrip("s") + "_"):
        if name.startswith(pre) and len(name) > len(pre):
            return f"{area}.{name[len(pre):]}"
    return f"{area}.{name}"

# per-builder grime settings (prefix match on builder name); default otherwise
GRIME = [
    ("hall_floor", dict(wear=1.3, soot=1.0, rust=0.1, dust=0.3)),
    ("hall_roof", dict(wear=1.0, soot=1.4, rust=0.5, dust=0.2)),
    ("hall_walls", dict(wear=1.1, soot=1.0, rust=0.6)),
    ("hall_", dict(wear=1.0, soot=1.2, rust=0.35)),
    ("caster_floor", dict(wear=1.0, soot=0.8, rust=0.0)),
    ("furnace_vault", dict(wear=1.2, soot=1.4, rust=0.05)),
    ("furnace_", dict(wear=1.3, soot=1.4, rust=0.25, heat=0.8)),
    ("electrode", dict(wear=1.0, soot=1.2, rust=0.1, heat=0.5)),
    ("ladle", dict(wear=1.4, soot=1.2, rust=0.4, heat=0.4)),
    ("slag", dict(wear=1.5, soot=1.4, rust=0.6)),
    ("crane", dict(wear=0.9, soot=0.9, rust=0.2)),
    ("scrap", dict(wear=1.5, soot=0.8, rust=0.9)),
    ("pipe", dict(wear=1.0, soot=0.9, rust=0.5)),
    ("caster", dict(wear=1.1, soot=0.8, rust=0.4)),
]


# big flat surfaces get subdivided to this max edge length (m) for loom's vertex kernels (fine grime is shader-side,
# so the cladding only needs rows every few metres: walls 3.0 -> 6.5 and roof 2.5 -> 7.0 saved ~200k vertices)
DENSIFY = {"hall_floor": 0.9, "hall_walls": 6.5, "hall_roof": 7.0, "furnace_vault": 0.9, "furnace_deck": 1.2,
           "caster_floor": 1.0, "pulpit": 0.9, "furnace_duct": 1.5}


def glb_stats(path):
    """Vertex/triangle counts as loom's decoder expands them (per node, per area)."""
    import struct
    with open(path, "rb") as f:
        d = f.read()
    n = struct.unpack("<I", d[12:16])[0]
    j = json.loads(d[20:20 + n])
    nodes, areas, static = {}, {}, [0, 0]
    for nd in j["nodes"]:
        if "mesh" not in nd:
            continue
        v = t = 0
        for p in j["meshes"][nd["mesh"]]["primitives"]:
            v += j["accessors"][p["attributes"]["POSITION"]]["count"]
            t += j["accessors"][p["indices"]]["count"] // 3
        name = nd.get("name", "?")
        nodes[name] = (v, t)
        ar = areas.setdefault(name.split(".", 1)[0], [0, 0])
        ar[0] += v
        ar[1] += t
        if not (nd.get("extras") or {}).get("loom_part"):
            static[0] += v
            static[1] += t
    V = sum(v for v, _ in nodes.values())
    T = sum(t for _, t in nodes.values())
    return {"vertices": V, "triangles": T, "ratio": V / max(T, 1), "nodes": nodes, "areas": areas, "static": static}


def grime_for(name, seed):
    for pre, kw in GRIME:
        if name.startswith(pre):
            return grime.make(seed=seed, **kw)
    return grime.make(seed=seed)


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--preview", default=None)
    ap.add_argument("--shots", default=None)
    ap.add_argument("--only", default=None)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--blend", default=None)
    ap.add_argument("--no-export", action="store_true")
    return ap.parse_args(argv)


def main():
    a = parse()
    t0 = time.time()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    mats = materials.build()
    coll = scene.collection
    rng = util.Rng(a.seed)
    only = set(a.only.split(",")) if a.only else None

    ctx = {"objects": {}, "rng": rng, "seed": a.seed, "mats": mats, "coll": coll}
    stats = []
    for modname in MODULES:
        if only and modname not in only:
            continue
        mod = importlib.import_module(modname)
        t = time.time()
        items = mod.build(ctx)
        for it in items:
            # item: MB or (MB, dict(pivot=, props=, parent=, bevel=))
            if isinstance(it, tuple):
                mb, kw = it
            else:
                mb, kw = it, {}
            parent = kw.get("parent")
            if isinstance(parent, str):
                parent = ctx["objects"].get(parent)
            ob = util.to_object(mb, mats, coll, pivot=kw.get("pivot"), props=kw.get("props"), parent=parent,
                                grime=grime_for(mb.name, a.seed), bevel=kw.get("bevel", 1.0),
                                max_edge=kw.get("max_edge", DENSIFY.get(mb.name, 0.0)),
                                sharp_deg=kw.get("sharp_deg", 38.0), name=area_name(AREA[modname], mb.name))
            if ob is None:
                continue
            ctx["objects"][mb.name] = ob
            ob["loom_area"] = AREA[modname]
            stats.append((ob.name, mb.tris, (ob.get("loom_part") or "")))
        print(f"[build] {modname}: {time.time() - t:.1f}s", flush=True)

    import cameras
    cameras.build(ctx)

    # stats: evaluated triangles (after bevel modifiers)
    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    rows = []
    for ob in coll.objects:
        if ob.type != "MESH":
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        n = len(me.loop_triangles)
        ev.to_mesh_clear()
        total += n
        rows.append((ob.name, n, ob.get("loom_part", "")))
    rows.sort(key=lambda r: -r[1])
    print("[stats] triangles per object:")
    for name, n, part in rows:
        print(f"  {name:32s} {n:9d}  {('part=' + part) if part else ''}")
    print(f"[stats] TOTAL triangles: {total}")
    print(f"[stats] objects: {len(rows)} meshes, materials: {len([m for m in bpy.data.materials if m.users])}")

    if not a.no_export:
        out = os.path.abspath(a.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=out, export_format="GLB",
            export_draco_mesh_compression_enable=False, export_use_gltfpack=False,
            export_apply=True, export_yup=True, export_extras=True,
            export_cameras=True, export_lights=True,
            export_vertex_color="ACTIVE", export_all_vertex_colors=False,
            export_normals=True, export_texcoords=True, export_tangents=False,
            export_animations=False, export_skins=False, export_morph=False,
            export_materials="EXPORT", export_image_format="NONE",
            use_selection=False, use_visible=False,
        )
        sz = os.path.getsize(out)
        print(f"[export] {out}  {sz / 1e6:.1f} MB")
        gs = glb_stats(out)
        print(f"[stats] GLB vertices {gs['vertices']:,}  triangles {gs['triangles']:,}  ratio {gs['ratio']:.3f}")
        for ar, (v, t) in sorted(gs["areas"].items(), key=lambda kv: -kv[1][0]):
            print(f"  area {ar:10s} {v:9,d} verts {t:9,d} tris")
        print(f"  static {gs['static'][0]:,} verts;  parts {gs['vertices'] - gs['static'][0]:,} verts")
        with open(os.path.splitext(out)[0] + ".stats.json", "w") as f:
            json.dump({"total_triangles": total, "objects": rows, "bytes": sz, "glb": gs,
                       "culled_faces": util.CULLED}, f, indent=1)

    if util.PROFILE:
        rows_p = []
        for obn, d in util.PROFILE_OUT.items():
            for t, n in d.items():
                rows_p.append((n, obn, t))
        rows_p.sort(reverse=True)
        print("[profile] split vertices by object / caller / primitive (pre-bevel, pre-densify):")
        for n, obn, t in rows_p[:80]:
            print(f"  {n:8d}  {obn:28s} {t}")
    if a.blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.blend))

    if a.preview:
        import preview
        preview.setup(scene, quick=a.quick)
        preview.render(scene, a.preview, names=a.shots.split(",") if a.shots else None, quick=a.quick)
    print(f"[build] done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
