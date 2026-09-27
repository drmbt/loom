"""On Nothing scene generator (T1400b, Blender 5.1, headless).

  Blender --background --factory-startup --python tools/blender/on-nothing/build.py -- \
      --out <path.glb> [--title "On Nothing"] [--preview <png dir>] [--blend <path>]

Builds the warehouse, five cars, the figure, the white cyc and the chrome title, the shot
cameras, the light / stage markers and the figure's skin (T1401b), and exports one GLB for loom.
See README.md.
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import cars  # noqa: E402
import figure  # noqa: E402
import mats as materials  # noqa: E402
import sets  # noqa: E402
import title  # noqa: E402
import util  # noqa: E402

# The reference's frame: 2.35:1. The exporter derives each camera's vertical fov from this.
RES = (1920, 818)

CARS = [
    dict(loc=(0.0, 0.0, 0.0), yaw=0, paint="paint_matte", grille="bars", ornament=True),
    dict(loc=(-3.3, 1.5, 0.0), yaw=11, paint="paint_white", grille="slats"),
    dict(loc=(3.3, 1.5, 0.0), yaw=-11, paint="paint_silver", grille="bars", moving=True),
    dict(loc=(-6.7, 0.3, 0.0), yaw=21, paint="paint_white", grille="bars", height=1.03),
    dict(loc=(6.7, 0.3, 0.0), yaw=-21, paint="paint_white", grille="slats", height=0.97),
]

# where the figure stands (and faces) in each shot; loom places it there
STAGES = {
    "tableau": ((0.0, -3.0, 0.0), (0, -1, 0)),
    "title": ((1.4, -2.4, 0.0), (0, -1, 0)),
    "quad": ((-60.0, 0.0, 0.0), (1, 0, 0)),
    "cyc": ((0.5, -0.6, 0.0), (1, 0, 0)),
}

# name: (location, target, focal mm)
SHOTS = {
    "tableau": ((0.0, -7.4, 0.92), (0.0, 0.0, 1.12), 24),
    "title": ((0.0, -1.3, 0.8), (0.0, 0.0, 0.74), 18),
    "quad": ((-60.0, -2.7, 1.42), (-60.0, 0.0, 1.36), 40),
    "cyc": ((-1.1, -6.8, 1.25), (0.4, 0.0, 0.8), 32),
}
# shots framed in a car's own frame: name -> (car index, eye, target, focal mm), car-local metres
CAR_SHOTS = {
    "wheel": (2, (1.45, -0.55, 0.3), (0.9, 2.2, 0.45), 18),
}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="On Nothing")
    ap.add_argument("--preview", default=None)
    ap.add_argument("--blend", default=None)
    ap.add_argument("--human", default=None, help="an MPFB human .blend (CC0) in place of the mannequin")
    return ap.parse_args(argv)


def lamp(coll, name, loc, direction, color, lumens, cone, kind):
    util.link_empty(coll, name, loc, direction, props={
        "loom_light_kind": kind, "loom_light_color": list(color), "loom_light_lumens": float(lumens),
        "loom_light_cone_deg": float(cone), "loom_light_dir": util.gl(Vector(direction).normalized())})


def glb_stats(path):
    import struct
    with open(path, "rb") as f:
        d = f.read()
    n = struct.unpack("<I", d[12:16])[0]
    j = json.loads(d[20:20 + n])
    areas = {}
    for nd in j["nodes"]:
        if "mesh" not in nd:
            continue
        v = sum(j["accessors"][p["attributes"]["POSITION"]]["count"] for p in j["meshes"][nd["mesh"]]["primitives"])
        t = sum(j["accessors"][p["indices"]]["count"] // 3 for p in j["meshes"][nd["mesh"]]["primitives"])
        a = areas.setdefault(nd.get("name", "?").split(".", 1)[0], [0, 0])
        a[0] += v
        a[1] += t
    return areas


def main():
    a = parse()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    mats = materials.build()
    coll = scene.collection
    ctx = {"coll": coll, "mats": mats}

    tube_markers = sets.warehouse(ctx)
    sets.cyc(ctx)
    heads = cars.build(ctx, CARS)
    title.build(ctx, a.title)
    if a.human:
        figure.build_mpfb(ctx, os.path.abspath(a.human))
    else:
        figure.build(ctx)

    for name, pos, fwd in heads:
        # low beams dip a little; the headlight is a hard, cool LED
        d = (fwd + Vector((0, 0, -0.06))).normalized()
        lamp(coll, name, pos, d, (0.93, 0.96, 1.0), 2600, 55, "head")
    for name, pos in tube_markers:
        lamp(coll, name, pos, (0, 0, -1), (0.9, 0.95, 1.0), 900, 360, "tube")
    lamp(coll, "lamp.back.quad", (-60.0, 2.6, 1.55), (0, -1, -0.05), (0.3, 0.8, 0.85), 9000, 80, "back")
    lamp(coll, "lamp.key.cyc", (4.5, -6.5, 7.5), (-0.62, 0.72, -0.42), (1.0, 0.98, 0.95), 1, 360, "key")
    for name, (pos, facing) in STAGES.items():
        util.link_empty(coll, f"stage.{name}", pos, facing, props={"loom_dir": util.gl(Vector(facing).normalized())})
    for name, (loc, target, lens) in SHOTS.items():
        util.camera(coll, f"shot.{name}", loc, target, lens)
    for name, (n, eye, target, lens) in CAR_SHOTS.items():
        car = CARS[n]
        rot = Matrix.Rotation(math.radians(car["yaw"]), 3, "Z")
        base = Vector(car["loc"])
        fwd = rot @ Vector((0, -1, 0))
        util.camera(coll, f"shot.{name}", base + rot @ Vector(eye), base + rot @ Vector(target), lens,
                    props={"loom_car": n, "loom_car_forward": util.gl(fwd)})

    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB",
        export_draco_mesh_compression_enable=False, export_use_gltfpack=False,
        export_apply=True, export_yup=True, export_extras=True,
        export_cameras=True, export_lights=False,
        export_vertex_color="NONE", export_all_vertex_colors=False,
        export_normals=True, export_texcoords=True, export_tangents=False,
        export_animations=False, export_skins=True, export_influence_nb=4, export_all_influences=False,
        export_leaf_bone=False, export_rest_position_armature=True, export_morph=False,
        export_materials="EXPORT", export_image_format="NONE",
        use_selection=False, use_visible=False,
    )
    print(f"[export] {out}  {os.path.getsize(out) / 1e6:.1f} MB")
    for area, (v, t) in sorted(glb_stats(out).items()):
        print(f"  area {area:8s} {v:9,d} verts {t:9,d} tris")
    if a.blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.blend))
    if a.preview:
        preview(scene, a.preview)


def preview(scene, outdir):
    """Workbench stills from every shot camera: a geometry check, not the look."""
    os.makedirs(outdir, exist_ok=True)
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_cavity = True
    scene.display.render_aa = "8"
    scene.render.resolution_percentage = 50
    # debug framings, preview only (never exported: the GLB is already written)
    util.camera(scene.collection, "dbg.car34", (4.2, -4.6, 1.7), (0.0, 1.8, 0.8), 30)
    util.camera(scene.collection, "dbg.carside", (-9.0, 2.6, 1.0), (0.0, 2.6, 0.9), 35)
    util.camera(scene.collection, "dbg.nose", (1.6, -2.0, 1.0), (0.4, 0.0, 0.8), 35)
    util.camera(scene.collection, "dbg.fig", (-2.0, -3.2, 1.1), (0.0, 0.0, 0.95), 35)
    util.camera(scene.collection, "dbg.chest", (0.35, -1.1, 1.45), (0.0, 0.0, 1.38), 50)
    for ob in scene.objects:
        if ob.type == "CAMERA" and (ob.name.startswith("shot.") or ob.name.startswith("dbg.")):
            scene.camera = ob
            scene.render.filepath = os.path.join(outdir, f"{ob.name}.png")
            bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
