"""Rig an imported car so it can drive (T1407b, the wheel shot).

car_import.py joins a real model into one object, `car<n>.body`. A car that DRIVES needs its
four wheels as their own parts, each pivoting at its hub, so loom's car rig
(src/projects/on-nothing/car-rig.ts) can move the body and roll each wheel about its axle.

1. The TYRES are the faces of our `tyre` material; they split into four clusters by side
   (x) and axle (y). Each cluster's bounding box gives the hub (its centre) and the radius
   (half its height).
2. A wheel is every connected ISLAND of the body mesh that lies wholly inside that tyre's
   cylinder (radius + 2 %, the tyre's width + 4 cm either side): tyre, rim, cap, bolts, disc.
   The body, the arch liners and the bumpers extend beyond the cylinder, so they stay.
3. Each wheel is separated into `car<n>.wheel_<fl|fr|rl|rr>`, its origin moved to the hub,
   tagged `loom_part` / `loom_parent`, and parented to the body, which becomes the rig's root
   part `car<n>` — the same contract cars.py's procedural `moving` path writes (README,
   "Cars").
4. Each wheel wears a DISC COVER, as the reference's Rolls-Royce does: a dished satin-silver
   disc (`disc_satin`: grey, half metal, the matte clear-coat class, so it reads brushed
   rather than white or mirror) over the rim face with five slots and a chrome centre cap. The model's own turbine rim
   reads as dark gaps at the wheel shot's grazing angle; the reference's reads as one bright
   brushed face with a few dark slots.
5. Lamp faces in the car's rear half (lit as `headlight` by a model that names every lamp
   "light") become tail lights: the wheel shot's lens stands by the rear corner.

The hub height is the wheel's rolling radius (the ground is z = 0): loom reads it back from
each wheel part's pivot.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

# The disc cover: its radius against the tyre's, the slots' radial span (of the disc), count
# and angular width, and how far the dish bulges out at the centre (m).
DISC = 0.74
SLOT_SPAN = (0.52, 0.8)
SLOTS = 5
SLOT_WIDTH = math.radians(13)
DISH = 0.03
CAP = 0.07


def _satin():
    """The disc's satin silver: made here (mats.py holds the shared library), in its convention."""
    m = bpy.data.materials.get("disc_satin")
    if m is not None:
        return m
    m = bpy.data.materials.new("disc_satin")
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    base = (0.46, 0.48, 0.49)
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.55
    bsdf.inputs["Roughness"].default_value = 0.4
    m["loom_heat"] = 12 / 64.0  # the matte clear coat (surface.ts class 12)
    m.diffuse_color = (*base, 1.0)
    return m


def _disc(bm, mats, x_face, out, radius):
    """A dished, slotted disc in the plane x = x_face (wheel-local, hub at the origin), facing `out` (±1)."""
    silver = mats.index("disc_satin")
    chrome = mats.index("chrome")
    rings = [CAP] + [CAP + (radius - CAP) * k / 10 for k in range(1, 11)]
    steps = 90

    def at(r, a):
        dish = DISH * (1 - (r / radius) ** 2)
        return bm.verts.new((x_face + out * dish, r * math.cos(a), r * math.sin(a)))

    grid = [[at(r, 2 * math.pi * j / steps) for j in range(steps)] for r in rings]
    centre = bm.verts.new((x_face + out * DISH, 0.0, 0.0))
    for j in range(steps):
        f = bm.faces.new((centre, grid[0][j], grid[0][(j + 1) % steps]) if out > 0 else (centre, grid[0][(j + 1) % steps], grid[0][j]))
        f.material_index = chrome
    for i in range(len(rings) - 1):
        rm = (rings[i] + rings[i + 1]) / 2 / radius
        for j in range(steps):
            am = 2 * math.pi * (j + 0.5) / steps
            phase = (am % (2 * math.pi / SLOTS)) - math.pi / SLOTS
            if SLOT_SPAN[0] < rm < SLOT_SPAN[1] and abs(phase) < SLOT_WIDTH / 2:
                continue
            quad = (grid[i][j], grid[i + 1][j], grid[i + 1][(j + 1) % steps], grid[i][(j + 1) % steps])
            f = bm.faces.new(quad if out > 0 else tuple(reversed(quad)))
            f.material_index = silver


def _islands(bm):
    """Face islands of a bmesh (connected through shared edges), as lists of faces."""
    seen = set()
    islands = []
    for face in bm.faces:
        if face.index in seen:
            continue
        stack = [face]
        seen.add(face.index)
        island = []
        while stack:
            f = stack.pop()
            island.append(f)
            for edge in f.edges:
                for g in edge.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        islands.append(island)
    return islands


def rig(car, n, report=None):
    """Split `car` (a car_import body, car-local mesh) into a body part and four wheel parts."""
    # car_import sets the body's location and yaw last; its world matrix must be current
    # before the wheels are placed by it.
    bpy.context.view_layer.update()
    me = car.data
    names = [m.name if m is not None else "" for m in me.materials]
    if "tyre" not in names:
        raise RuntimeError(f"wheel_rig: car{n} has no tyre material; map its tyres in car_models.py")
    tyre = names.index("tyre")
    length = max(v.co.y for v in me.vertices)
    clusters = {}
    for poly in me.polygons:
        if poly.material_index != tyre:
            continue
        c = poly.center
        key = ("f" if c.y < length / 2 else "r") + ("r" if c.x < 0 else "l")
        clusters.setdefault(key, []).append(poly)
    if sorted(clusters) != ["fl", "fr", "rl", "rr"]:
        raise RuntimeError(f"wheel_rig: car{n} tyres cluster into {sorted(clusters)}, not four wheels")
    wheels = {}
    faces_x = {}
    for key, polys in clusters.items():
        pts = [me.vertices[i].co for p in polys for i in p.vertices]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        hub = (lo + hi) / 2
        radius = (hi.z - lo.z) / 2
        wheels[key] = (hub, radius, lo.x - 0.04, hi.x + 0.04)
    # Rear lamps named like headlights become tail lights.
    if "taillight" not in names:
        me.materials.append(bpy.data.materials["taillight"])
        names.append("taillight")
    lamp_slots = {names.index(k) for k in ("headlight", "drl") if k in names}
    rear_lamps = 0
    for poly in me.polygons:
        if poly.material_index in lamp_slots and poly.center.y > length / 2:
            poly.material_index = names.index("taillight")
            rear_lamps += 1

    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    owner = {}
    for island in _islands(bm):
        verts = {v for f in island for v in f.verts}
        for key, (hub, radius, x0, x1) in wheels.items():
            r2 = (radius * 1.02) ** 2
            if all(x0 <= v.co.x <= x1 and (v.co.y - hub.y) ** 2 + (v.co.z - hub.z) ** 2 <= r2 for v in verts):
                for f in island:
                    owner[f.index] = key
                break
    # Each wheel becomes its own object: copy the body, keep that wheel's faces only.
    parts = []
    for key, (hub, radius, _, _) in sorted(wheels.items()):
        mine = [f for f in bm.faces if owner.get(f.index) == key]
        if not mine:
            raise RuntimeError(f"wheel_rig: car{n} wheel {key} took no faces")
        wb = bm.copy()
        wb.faces.ensure_lookup_table()
        bmesh.ops.delete(wb, geom=[f for f in wb.faces if owner.get(f.index) != key], context="FACES")
        wme = bpy.data.meshes.new(f"car{n}.wheel_{key}")
        wb.to_mesh(wme)
        wb.free()
        for m in me.materials:
            wme.materials.append(m)
        for extra in ("disc_satin", "chrome"):
            if extra not in [m.name for m in wme.materials if m is not None]:
                wme.materials.append(_satin() if extra == "disc_satin" else bpy.data.materials[extra])
        wme.transform(Matrix.Translation(-hub))
        db = bmesh.new()
        db.from_mesh(wme)
        out = 1 if hub.x > 0 else -1
        # The cover sits just proud of the wheel's outermost point inside its radius: the
        # model's rim spokes stand beyond the tyre wall and would show through otherwise.
        face_x = max(out * v.co.x for v in db.verts if v.co.y ** 2 + v.co.z ** 2 < (radius * DISC) ** 2) * out
        _disc(db, [m.name if m is not None else "" for m in wme.materials], face_x + out * 0.004, out, radius * DISC)
        db.to_mesh(wme)
        db.free()
        wme.shade_smooth()
        ob = bpy.data.objects.new(f"car{n}.wheel_{key}", wme)
        car.users_collection[0].objects.link(ob)
        ob.matrix_world = car.matrix_world @ Matrix.Translation(hub)
        ob["loom_area"] = f"car{n}"
        ob["loom_part"] = f"car{n}_wheel_{key}"
        ob["loom_parent"] = f"car{n}"
        parts.append((ob, key, hub, radius, len(mine)))
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index in owner], context="FACES")
    bm.to_mesh(me)
    bm.free()
    me.update()
    # Carry the model's split normals: the separated wheels were cut from a smooth-shaded mesh.
    for ob, *_ in parts:
        try:
            ob.data.set_sharp_from_angle(angle=0.61)
        except Exception:
            pass
    car["loom_part"] = f"car{n}"
    car["loom_parent"] = ""
    bpy.context.view_layer.update()
    for ob, *_ in parts:
        world = ob.matrix_world.copy()
        ob.parent = car
        ob.matrix_world = world
    if report is not None:
        report.append(("rear lamps to tail lights", rear_lamps))
        for _, key, hub, radius, faces in parts:
            report.append((f"wheel {key}", f"hub ({hub.x:.3f}, {hub.y:.3f}, {hub.z:.3f}) r {radius:.3f} m, {faces} faces"))
    return parts
