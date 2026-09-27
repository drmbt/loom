"""The CABIN car for the in-car shots (T1407b incar): one real model with its interior KEPT.

The scene's cars (car_import.py) drop their interiors and fold every material into a handful of
ours, which is right for a car seen from outside across a room. The in-car rows of the reference
(docs/on-nothing-shotlist-2026-09-27.md rows 36, 45, 84, 91) look INTO a car: seats, the
dashboard, the steering wheel, the door panels' cyan ambient LED strips, through glass.

This imports the GLS once more, through car_import's optional CABIN mode, into its own area
`cabin` (and its panes into `cabinglass`), so the other shots' areas and look are untouched (the
GLB grows by the cabin alone). What the mode does differently:

- nothing of the interior is dropped (only the engine and stray lettering);
- every face of an interior part (seats, dash, door panels, wheel, stalks) wears a material of
  its own class (60-64 below): the exterior map would paint a khaki dash white;
- the driver's door is its own rig part (`cabin_door`, pivot on its front hinge, the body the
  rig's root `cabin`), so a shot swings it open or leaves it shut; its window is wound DOWN;
- EVERY pane is split off into `cabinglass`: loom draws the panes in their own Render and lays
  them over the frame (reflection and tint over what is behind), so the glass is seen through;
- the cabin's own facts ride on the `stage.cabin` marker, measured from the parts: where the
  car stands and faces, each front seat's cushion and back, the steering wheel's hub, the door's
  hinge (glTF metres, world).

UV layers and material slots are collapsed exactly as for the other cars (the 640 MB lesson in
car_import.py); the body is one joined object, the door a second.
"""
import math
import os
import re

import bpy
from mathutils import Matrix, Vector

import util

AREA = "cabin"
MODEL = "gls600"
# Where the cabin car stands: in the warehouse, left of the car row, its nose toward the lens
# side of the room (Blender metres; the car's nose is at LOC, the body runs back along +Y).
LOC = Vector((-7.5, 3.0, 0.0))
YAW_DEG = 0.0
PAINT = "paint_white"
# The driver's door (front left, +X in the file: a left-hand-drive car): its window is wound down
# (metres in the file's units, before the length scale). Loom swings the door itself.
WINDOW_DOWN = 0.46
DOOR = re.compile(r"^gls_door(glass|panel)?_FL")
DOOR_TAG = 100

# name: (base rgb, metallic, roughness, emission rgb or None, emission strength, class code).
# Classes 60+ are the cabin's own (the surface's default branch shades them from these factors).
LIB = {
    "cabin_leather": ((0.035, 0.032, 0.03), 0.0, 0.48, None, 0, 60),
    "cabin_trim": ((0.018, 0.018, 0.019), 0.0, 0.32, None, 0, 61),
    "cabin_metal": ((0.55, 0.55, 0.57), 1.0, 0.22, None, 0, 62),
    # the ambient strips: a thin cyan line of light along the dash and the door panels
    "cabin_led": ((0.2, 0.85, 1.0), 0.0, 0.3, (0.18, 0.92, 1.0), 40.0, 63),
    "cabin_screen": ((0.004, 0.005, 0.006), 0.0, 0.05, None, 0, 64),
}

# Which of the file's parts are interior (their faces take the cabin's classes).
INTERIOR = re.compile(r"^gls_(int|dash|seat|seats|doorpanel|steer|signalstalk|screen|brakepedal|gaspedal)")
# The file's interior materials onto the cabin's (the `int__` prefix marks an interior part's face).
MATERIALS = {
    "int__gls_interior": "cabin_leather", "int__gls_interior1": "cabin_leather", "int__gls_leather_black": "cabin_leather",
    "int__gls_leather_brown": "cabin_leather", "int__gls_leather_niz": "cabin_leather", "int__gls_seatbelt": "cabin_trim",
    "int__gls_kaki": "cabin_trim", "int__gls_torpedka1": "cabin_trim", "int__gls_din": "cabin_trim", "int__gls_carbonn": "cabin_trim",
    "int__gls_wood_black": "cabin_trim", "int__gls_wood_black1": "cabin_trim", "int__gls_black_chrome": "cabin_trim",
    "int__gls_ras": "cabin_metal", "int__wheel_42b": "cabin_metal", "int__wheel_42a": "cabin_metal",
    "int__gls_rgblentaa": "cabin_led", "int__gls_ras_on": "cabin_led",
    "int__gls_dvd": "cabin_screen", "int__gls_gauges_screen": "cabin_screen", "int__gls_gps_screen": "cabin_screen",
    "int__etk800_interior": "cabin_trim", "int__vehicle_basic": "cabin_trim", "int__vehicle_paint1": "cabin_trim",
}
# the exterior map still names these (the drop list of the scene's GLS keeps them out there)
DROP = ["gavril_v8", "etk800_lettering", "Interior"]

# What `stage.cabin` reports, by part: vertex tags written before the join (see prepare).
PROBES = ["gls_seat_FL", "gls_seat_FR", "gls_steer_amg", "gls_windshield", "gls_dash_brown"]


def _base(name):
    return name.split(".")[0] if name else ""


def materials(mats):
    for name, (base, met, rough, ecol, estr, code) in LIB.items():
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*base, 1.0)
        bsdf.inputs["Metallic"].default_value = met
        bsdf.inputs["Roughness"].default_value = rough
        if ecol is not None and estr > 0:
            bsdf.inputs["Emission Color"].default_value = (*ecol, 1.0)
            bsdf.inputs["Emission Strength"].default_value = estr
        m["loom_heat"] = code / 64.0
        m.diffuse_color = (*base, 1.0)
        mats[name] = m


def prepare(meshes, report):
    """Before the join (file coordinates, transforms applied): retag the interior's materials,
    wind the driver's window down, and tag the probed parts' and the door's vertices."""
    placeholders = {}
    door_parts = 0
    for o in meshes:
        base = _base(o.name)
        if INTERIOR.match(base):
            for slot in o.material_slots:
                name = "int__" + _base(slot.material.name if slot.material else "")
                if name not in placeholders:
                    placeholders[name] = bpy.data.materials.new(name)
                slot.material = placeholders[name]
        tag = PROBES.index(base) + 1 if base in PROBES else 0
        if DOOR.match(base):
            if base.startswith("gls_doorglass"):
                o.data.transform(Matrix.Translation((0, 0, -WINDOW_DOWN)))
            tag = DOOR_TAG
            door_parts += 1
        attr = o.data.attributes.new("cabin_part", "INT", "POINT")
        attr.data.foreach_set("value", [tag] * len(o.data.vertices))
    report["door parts"] = door_parts


def measure(car, report):
    """After the import normalised the car (car-local: nose at y = 0, +X its left): each probed
    part's box, then the tag is removed so nothing of it reaches the GLB."""
    me = car.data
    tags = [0] * len(me.vertices)
    me.attributes["cabin_part"].data.foreach_get("value", tags)
    boxes = {}
    for v, tag in zip(me.vertices, tags):
        if tag == 0:
            continue
        lo, hi = boxes.setdefault("door" if tag == DOOR_TAG else PROBES[tag - 1], [v.co.copy(), v.co.copy()])
        for i in range(3):
            lo[i] = min(lo[i], v.co[i])
            hi[i] = max(hi[i], v.co[i])
    report["boxes"] = boxes
    # the front seats' cushion: its top surface along the seat's middle, front half
    seats = {}
    for side in ("FL", "FR"):
        lo, hi = boxes[f"gls_seat_{side}"]
        cx = (lo.x + hi.x) / 2
        profile = []
        for v, tag in zip(me.vertices, tags):
            if tag == PROBES.index(f"gls_seat_{side}") + 1 and abs(v.co.x - cx) < 0.08:
                profile.append(v.co.copy())
        # cushion: the highest points in the front 45 % of the seat's depth; backrest: the
        # frontmost points above the cushion by 0.3 m
        depth = hi.y - lo.y
        cushion = [p for p in profile if p.y < lo.y + 0.45 * depth]
        top = max(p.z for p in cushion)
        mid = [p for p in cushion if p.z > top - 0.03]
        cushion_at = Vector((cx, sum(p.y for p in mid) / len(mid), top))
        back = [p for p in profile if p.z > top + 0.3 and p.z < top + 0.4]
        back_y = min(p.y for p in back) if back else cushion_at.y + 0.3
        seats[side] = (cushion_at, back_y)
    report["seats"] = seats
    # the door: split off into its own object, its origin on the hinge (its front edge, just
    # inside the skin), so loom can swing it
    lo, hi = boxes["door"]
    hinge = Vector((hi.x - 0.06, lo.y + 0.05, 0.0))
    for x in bpy.context.selected_objects:
        x.select_set(False)
    car.select_set(True)
    bpy.context.view_layer.objects.active = car
    # (a clean selection first: the import leaves every vertex selected, and edit mode would flush it)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for poly in me.polygons:
        poly.select = all(tags[i] == DOOR_TAG for i in poly.vertices)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    door = next(o for o in bpy.context.selected_objects if o is not car)
    door.name = f"{AREA}.door"
    door.data.transform(Matrix.Translation(-hinge))
    for ob in (car, door):
        ob.data.attributes.remove(ob.data.attributes["cabin_part"])
    return boxes, seats, door, hinge


def build(ctx):
    """Import the cabin car; returns nothing (its facts ride on `stage.cabin`)."""
    import car_import
    import car_models
    coll, mats = ctx["coll"], ctx["mats"]
    materials(mats)
    model = car_models.MODELS[MODEL]
    yaw = math.radians(YAW_DEG)
    report = {}
    state = {}
    cabin = {
        "area": AREA,
        "materials": MATERIALS,
        "drop": DROP,
        "prepare": lambda meshes: prepare(meshes, report),
        "measure": lambda car: state.update(zip(("boxes", "seats", "door", "hinge"), measure(car, report))),
    }
    car_ob, _heads = car_import.import_car(ctx, os.path.join(car_models.ASSETS, model["path"]), 0, LOC, yaw, PAINT,
                                           length=model["length"], model=model, cabin=cabin, report=[])
    boxes, seats, door, hinge = state["boxes"], state["seats"], state["door"], state["hinge"]
    rot = Matrix.Rotation(yaw, 3, "Z")

    def world(p):
        return LOC + rot @ Vector(p)

    # the rig: the body is its root, the door a part pivoting on its hinge (car-rig.ts's contract)
    door.location = world(hinge)
    door.rotation_euler = (0, 0, yaw)
    door["loom_area"] = AREA
    door["loom_part"] = f"{AREA}_door"
    door["loom_parent"] = AREA
    car_ob["loom_part"] = AREA
    car_ob["loom_parent"] = ""
    bpy.context.view_layer.update()
    kept = door.matrix_world.copy()
    door.parent = car_ob
    door.matrix_world = kept

    wheel_lo, wheel_hi = boxes["gls_steer_amg"]
    door_lo, door_hi = boxes["door"]
    shield_lo, shield_hi = boxes["gls_windshield"]
    dash_lo, dash_hi = boxes["gls_dash_brown"]
    props = {
        "loom_dir": util.gl(rot @ Vector((0, -1, 0))),
        "loom_wheel": util.gl(world((wheel_lo + wheel_hi) / 2)),
        "loom_windshield": util.gl(world((shield_lo + shield_hi) / 2)),
        "loom_dash_top": util.gl(world(Vector(((dash_lo.x + dash_hi.x) / 2, (dash_lo.y + dash_hi.y) / 2, dash_hi.z)))),
        "loom_door_box": util.gl(world(door_lo)) + util.gl(world(door_hi)),
        "loom_door_hinge": util.gl(world(hinge)),
    }
    for side, (cushion, back_y) in seats.items():
        props[f"loom_seat_{side.lower()}"] = util.gl(world(cushion))
        props[f"loom_back_{side.lower()}"] = util.gl(world(Vector((cushion.x, back_y, cushion.z))))
    util.link_empty(coll, "stage.cabin", LOC, rot @ Vector((0, -1, 0)), props=props)
    print(f"[cabin] {MODEL}: door parts {report.get('door parts')}, seats "
          + ", ".join(f"{k} cushion {tuple(round(c, 3) for c in v[0])} back y {v[1]:.3f}" for k, v in seats.items()), flush=True)
    for name, (lo, hi) in boxes.items():
        print(f"[cabin]   {name}: {tuple(round(c, 3) for c in lo)} .. {tuple(round(c, 3) for c in hi)}", flush=True)
    return car_ob
