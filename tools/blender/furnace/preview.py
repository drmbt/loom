"""EEVEE preview stills for the shot.* cameras (dark, moody, hot emission)."""
import math
import os

import bpy
from mathutils import Vector


def setup(scene, quick=False):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    ee = scene.eevee
    ee.taa_render_samples = 16 if quick else 48
    try:
        ee.use_raytracing = True
        ee.ray_tracing_options.resolution_scale = "2"
    except Exception:
        pass
    ee.use_shadows = True
    try:
        ee.shadow_pool_size = "1024"
    except Exception:
        pass
    try:
        ee.volumetric_tile_size = "8"
        ee.volumetric_samples = 48
        ee.volumetric_end = 160.0
        ee.use_volumetric_shadows = True
    except Exception:
        pass
    scene.view_settings.view_transform = "AgX"
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    scene.view_settings.exposure = 0.0
    # world: near-black with a faint cold ambient + hall-wide haze
    w = bpy.data.worlds.new("preview_world")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    bg.inputs[0].default_value = (0.03, 0.034, 0.042, 1)
    bg.inputs[1].default_value = 1.0
    out = nt.nodes["World Output"]
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    vol.inputs["Density"].default_value = 0.004
    vol.inputs["Color"].default_value = (0.8, 0.75, 0.7, 1)
    vol.inputs["Anisotropy"].default_value = 0.35
    nt.links.new(vol.outputs[0], out.inputs["Volume"])
    _lights(scene)
    _compositor(scene)
    # preview-only: see through the pulpit / cab glazing (the exported material stays an opaque factor set)
    g = bpy.data.materials.get("glass_pulpit")
    if g is not None:
        b = g.node_tree.nodes["Principled BSDF"]
        b.inputs["Alpha"].default_value = 0.12
        try:
            g.surface_render_method = "BLENDED"
        except Exception:
            pass


def _light(scene, name, kind, loc, energy, color, size=1.0, rot=None, spot=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    ld.color = color
    if kind == "AREA":
        ld.size = size
    if kind == "POINT" or kind == "SPOT":
        ld.shadow_soft_size = size
    if spot:
        ld.spot_size = spot
        ld.spot_blend = 0.6
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    if rot:
        ob.rotation_euler = rot
    ob["preview_only"] = True
    scene.collection.objects.link(ob)
    return ob


def _lights(scene):
    from layout import BATH_Z, EBT_XY, CAST_X, CAST_Y, CAST_FLOOR_Z
    # light.* reference lights from cameras.py also render; these add fill only
    _light(scene, "pv_strand", "AREA", (CAST_X + 8, CAST_Y, 3.0), 3000, (1.0, 0.4, 0.12), size=6.0)
    # cold daylight through the monitor louvres (sun, gives shafts in the haze)
    from layout import SUN_EULER_DEG
    sun = _light(scene, "pv_sun", "SUN", (0, 0, 50), 1.5, (0.75, 0.82, 1.0),
                 rot=tuple(math.radians(a) for a in SUN_EULER_DEG))
    sun.data.angle = math.radians(1.5)
    # high-bay fill (cool), weak
    for x in (-48, -24, 0, 24, 48):
        _light(scene, f"pv_bay_{x}", "AREA", (x, 0, 28.5), 4000, (0.72, 0.8, 1.0), size=10.0)


def _compositor(scene):
    # bloom via the glare node (5.x compositor node group)
    try:
        ng = bpy.data.node_groups.new("preview_comp", "CompositorNodeTree")
        scene.compositing_node_group = ng
        rl = ng.nodes.new("CompositorNodeRLayers")
        gl = ng.nodes.new("CompositorNodeGlare")
        out = ng.nodes.new("NodeGroupOutput")
        ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        gl.inputs["Type"].default_value = "Bloom"
        gl.inputs["Quality"].default_value = "High"
        for key, val in (("Threshold", 1.2), ("Strength", 0.35), ("Size", 0.7)):
            if key in gl.inputs:
                try:
                    gl.inputs[key].default_value = val
                except Exception:
                    pass
        ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
        ng.links.new(gl.outputs["Image"], out.inputs[0])
        scene.render.use_compositing = True
    except Exception as e:  # compositor API drift: previews still render without bloom
        print("preview: no bloom:", e)


def render(scene, outdir, names=None, quick=False):
    os.makedirs(outdir, exist_ok=True)
    cams = sorted([o for o in scene.objects if o.type == "CAMERA" and o.name.startswith("shot.")], key=lambda o: o.name)
    done = []
    for c in cams:
        short = c.name[5:]
        if names and short not in names:
            continue
        scene.camera = c
        scene.render.filepath = os.path.join(outdir, f"{short}.png")
        bpy.ops.render.render(write_still=True)
        done.append(scene.render.filepath)
        print("preview:", scene.render.filepath, flush=True)
    return done
