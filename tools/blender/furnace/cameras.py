"""shot.* cameras, emit.* empties, light.* punctual lights."""
import math

import bpy
from mathutils import Vector

import layout as L

SENSOR = 36.0

# name: (location, target, focal mm, roll deg)
SHOTS = {
    "establish_wide":     ((-56.0, 13.5, 21.0), (0.0, -2.0, 9.0), 20, 0),
    "hero_low_furnace":   ((-12.5, -7.5, 6.75), (0.0, 0.5, 13.5), 16, 0),
    "electrode_closeup":  ((-4.2, -5.0, 19.2), (0.2, 0.8, 16.8), 40, 0),
    "crane_eye":          ((L.CRANE_X - 1.4, L.TROLLEY_Y + 2.0, 23.2), (0.0, 0.0, 12.0), 20, 0),
    "ladle_pour":         ((L.CAR_X + 5.0, -6.5, 7.6), (L.CAR_X - 0.5, 0.0, 4.4), 30, 0),
    "through_grating":    ((24.6, 3.0, 10.2), (18.0, -2.0, 26.0), 14, 0),
    "pipe_corridor":      ((27.0, -12.0, 3.2), (-20.0, -14.8, 6.5), 24, 0),
    "pulpit_window":      ((-0.6, -11.4, 8.15), (0.0, 0.0, 12.5), 24, 0),
    "over_shoulder_ladle": ((L.CAST_X - 8.0, L.CAST_Y - 7.0, 15.0), (L.CAST_X, L.CAST_Y, 16.0), 26, 0),
    "top_down":           ((0.6, 0.4, 28.0), (0.6, 0.4, 0.0), 24, 90),
    "caster_strand":      ((L.CAST_X + 20.0, L.CAST_Y + 4.5, 3.4), (L.CAST_X + 4.0, L.CAST_Y, 6.0), 24, 0),
    "conveyor_climb":     ((-51.0, -7.0, 2.4), (-20.0, -11.0, 14.0), 26, 0),
    "cable_festoon":      ((-8.6, 8.9, 13.0), (2.0, 9.3, 14.6), 22, 0),
    "scrap_bay":          ((-32.0, 11.0, 7.5), (-11.0, -2.0, 17.0), 22, 0),
    "slag_door":          ((-10.5, -2.0, 9.2), (-3.9, 0.0, 8.9), 45, 0),
    "ladle_furnace":      ((23.5, 2.5, 6.5), (30.0, 9.0, 5.5), 24, 0),
    "under_deck":         ((11.5, 1.2, 1.8), (-2.0, 0.0, 4.0), 18, 0),
}


def cam(coll, name, loc, target, lens, roll=0.0):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.sensor_width = SENSOR
    cd.sensor_fit = "HORIZONTAL"
    cd.clip_start = 0.05
    cd.clip_end = 600.0
    ob = bpy.data.objects.new(name, cd)
    ob.location = loc
    d = Vector(target) - Vector(loc)
    q = d.to_track_quat("-Z", "Y")
    ob.rotation_mode = "QUATERNION"
    if roll:
        from mathutils import Quaternion
        q = q @ Quaternion((0, 0, 1), math.radians(roll))
    ob.rotation_quaternion = q
    ob["loom_target"] = list(target)
    coll.objects.link(ob)
    return ob


def empty(coll, name, loc, parent=None, follow=None, size=0.3):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = "PLAIN_AXES"
    ob.empty_display_size = size
    ob.location = loc
    coll.objects.link(ob)
    if parent is not None:
        bpy.context.view_layer.update()
        ob.parent = parent
        ob.location = Vector(loc) - parent.matrix_world.translation
    if follow:
        ob["loom_follow"] = follow
    return ob


def light(coll, name, kind, loc, watts, color, target=None, radius=0.5, spot_deg=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = watts
    ld.color = color
    ld.shadow_soft_size = radius
    if kind == "SPOT":
        ld.spot_size = math.radians(spot_deg or 60)
        ld.spot_blend = 0.5
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    if target:
        d = Vector(target) - Vector(loc)
        ob.rotation_mode = "QUATERNION"
        ob.rotation_quaternion = d.to_track_quat("-Z", "Y")
    coll.objects.link(ob)
    return ob


def build(ctx):
    coll = ctx["coll"]
    objs = ctx["objects"]
    scene = bpy.context.scene
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    for name, (loc, tgt, lens, roll) in SHOTS.items():
        cam(coll, "shot." + name, loc, tgt, lens, roll)

    def part(n):
        return objs.get(n)

    # arcs at the electrode tips (follow the electrode parts)
    for i, (x, y) in enumerate(L.ELEC_XY):
        n = f"electrode_{i + 1}"
        empty(coll, f"emit.arc_{i + 1}", (x, y, L.TIP_Z), parent=part(n), follow=n)
    empty(coll, "emit.bath", (0.0, 0.0, L.BATH_Z), parent=part("furnace_shell"), follow="furnace_shell")
    for k, v in ctx.get("emitters", {}).items():
        loc, follow = v
        empty(coll, "emit." + k, loc, parent=part(follow) if follow else None, follow=follow)
    # roof louvre light shafts (cold daylight), alternating sides along the monitor
    for k, x in enumerate(range(-54, 55, 12)):
        s = -1 if k % 2 else 1
        empty(coll, f"emit.louvre_shaft_{k + 1:02d}", (float(x), s * 3.9, L.MONITOR_Z - 1.6))

    # reference lights (loom may ignore)
    light(coll, "light.furnace_glow", "POINT", (0.0, 0.0, L.ROOF_RING_Z + 0.8), 6000, (1.0, 0.45, 0.15), radius=3.0)
    light(coll, "light.arc", "POINT", (0.0, 0.0, L.TIP_Z + 1.0), 4000, (0.85, 0.85, 1.0), radius=0.4)
    light(coll, "light.slag_door", "POINT", (-L.SHELL_R - 1.2, 0.0, 9.2), 2500, (1.0, 0.4, 0.1), radius=0.6)
    light(coll, "light.tap", "POINT", (L.EBT_XY[0] + 0.3, 0.0, 4.4), 2000, (1.0, 0.5, 0.15), radius=0.5)
    light(coll, "light.tundish", "POINT", (L.CAST_X, L.CAST_Y, L.CAST_FLOOR_Z + 2.2), 2500, (1.0, 0.5, 0.18), radius=0.8)
    for k, x in enumerate((-36.0, -12.0, 12.0, 36.0)):
        light(coll, f"light.high_bay_{k + 1}", "SPOT", (x, 0.0, L.TRUSS_Z - 0.8), 3000, (0.75, 0.82, 1.0),
              target=(x, 0.0, 0.0), spot_deg=100)
