"""The chrome title script for the On Nothing scene (T1400b): a text in a copperplate script,
extruded and bevelled into round chrome tubing, standing just in front of car 0's grille.
"""
import os

import bpy

FONTS = [
    "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc",
    "/System/Library/Fonts/Supplemental/Zapfino.ttf",
    "/System/Library/Fonts/Supplemental/Apple Chancery.ttf",
]


def build(ctx, text, width=0.98, center=(0.0, -0.05, 0.9)):
    coll, mats = ctx["coll"], ctx["mats"]
    curve = bpy.data.curves.new("title.script", "FONT")
    curve.body = text
    for path in FONTS:
        if os.path.exists(path):
            try:
                curve.font = bpy.data.fonts.load(path)
                print(f"[title] font {path}", flush=True)
                break
            except RuntimeError:
                continue
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = 0.3
    curve.extrude = 0.006
    curve.bevel_depth = 0.0085
    curve.bevel_resolution = 3
    curve.resolution_u = 6
    ob = bpy.data.objects.new("title.script", curve)
    coll.objects.link(ob)
    bpy.context.view_layer.update()
    # scale to the grille's width, stand it up facing -Y
    dims = ob.dimensions
    s = width / max(dims.x, 1e-6)
    ob.scale = (s, s, s)
    ob.rotation_euler = (1.5707963, 0, 0)
    ob.location = center
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    ob = bpy.context.view_layer.objects.active
    ob.data.materials.clear()
    ob.data.materials.append(mats["chrome"])
    ob.data.shade_smooth()
    ob["loom_area"] = "title"
    return ob
