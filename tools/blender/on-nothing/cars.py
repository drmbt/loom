"""SUV-class cars for the On Nothing scene (T1400b): no brand, the reference's proportions.

A body is a LOFT of cross-sections along the car (front at local y = 0, facing -Y), subdivided
twice, so the clear coat carries long unbroken highlights. The underbody rises over each axle,
which cuts the wheel arches without a boolean. Grille, lamps, wheels and mirrors are separate
hard-surface pieces in the same object.

Each car exports as `car.<n>_body` (paint, glass, trim) and `car.<n>_parts` (chrome, lamps,
wheels); its two headlights become `lamp.head.<n>l` / `lamp.head.<n>r` markers.
"""
import math

from mathutils import Matrix, Vector

import util

AXLES = (0.95, 4.15)
WHEEL_R = 0.43
ARCH_R = 0.50


def lerp_table(table, y):
    if y <= table[0][0]:
        return table[0][1]
    for (y0, v0), (y1, v1) in zip(table, table[1:]):
        if y <= y1:
            t = (y - y0) / max(y1 - y0, 1e-9)
            t = t * t * (3 - 2 * t)
            return v0 + (v1 - v0) * t
    return table[-1][1]


def body_tables(v):
    h = v.get("height", 1.0)
    return {
        "zr": [(0.0, 1.02), (0.1, 1.1), (0.5, 1.15), (1.5, 1.2), (1.65, 1.24), (2.45, 1.8 * h), (2.8, 1.85 * h),
               (4.6, 1.84 * h), (5.0, 1.77 * h), (5.15, 1.62 * h), (5.2, 1.5)],
        "zbelt": [(0.0, 0.98), (0.5, 1.1), (1.65, 1.19), (4.9, 1.24), (5.2, 1.16)],
        "wb": [(0.0, 0.93), (0.05, 0.97), (0.3, 0.99), (4.8, 0.99), (5.1, 0.95), (5.2, 0.88)],
        "wc": [(0.0, 0.8), (1.5, 0.86), (1.65, 0.88), (2.45, 0.8), (4.8, 0.78), (5.2, 0.72)],
    }


def zb_at(y):
    zb = 0.32
    for a in AXLES:
        d = y - a
        if abs(d) < ARCH_R:
            zb = max(zb, 0.43 + math.sqrt(ARCH_R * ARCH_R - d * d))
    return zb


def ring(y, t):
    zb = zb_at(y)
    zr = lerp_table(t["zr"], y)
    zbelt = min(lerp_table(t["zbelt"], y), zr - 0.02)
    wb = lerp_table(t["wb"], y)
    wc = min(lerp_table(t["wc"], y), wb - 0.08)
    z6 = max(zr - 0.12, zbelt + 0.025)
    half = [
        (wb * 0.75, zb),
        (wb, zb + min(0.1, 0.4 * (zbelt - zb))),
        (wb + 0.015, zb + 0.45 * (zbelt - zb)),
        (wb - 0.01, zbelt),
        (wb - 0.06, zbelt + 0.012),
        (wc, z6),
        (wc - 0.12, zr),
    ]
    pts = [(0.0, zb)] + half + [(0.0, zr)] + [(-x, z) for (x, z) in reversed(half)]
    return [Vector((x, y, z)) for (x, z) in pts]


def stations():
    ys = set(round(i * 0.1, 3) for i in range(53))
    for a in AXLES:
        for k in range(-12, 13):
            ys.add(round(a + k * 0.045, 3))
    ys.update((0.03, 0.06, 1.65, 2.45, 4.95, 5.15))
    return sorted(y for y in ys if 0.0 <= y <= 5.2)


def body(mb, v):
    t = body_tables(v)
    ys = stations()
    rings = [ring(y, t) for y in ys]
    n = len(rings[0])
    paint = v["paint"]
    base = len(mb.verts)
    for r in rings:
        mb.verts.extend(r)
    for i in range(len(rings) - 1):
        y0, y1 = ys[i], ys[i + 1]
        ym = (y0 + y1) / 2
        for k in range(n):
            k2 = (k + 1) % n
            a, b = base + i * n + k, base + i * n + k2
            c, d = base + (i + 1) * n + k2, base + (i + 1) * n + k
            mb.faces.append([a, d, c, b])
            # segment k joins ring points k and k + 1: 0 underbody, 5 / 10 the side glass,
            # 7 / 8 the top (windscreen and rear window at the cabin's ends).
            seg = k if k < n // 2 else n - 1 - k
            if seg == 0:
                mat = "plastic_black"
            elif seg == 5 and 1.75 < ym < 4.85:
                mat = "glass_car"
            elif seg in (6, 7) and (1.7 < ym < 2.4 or 4.97 < ym < 5.14):
                mat = "glass_car"
            elif seg == 1 and zb_at(ym) > 0.4:
                mat = "plastic_black"
            else:
                mat = paint
            mb.fmats.append(mat)
    # Caps: an inset ring then an n-gon, so the subdivision keeps the nose flat, not pinched.
    for end, sign in ((0, -1), (len(rings) - 1, 1)):
        r = rings[end]
        c = sum(r, Vector()) / n
        inset = [c + (p - c) * 0.86 + Vector((0, sign * 0.03, 0)) for p in r]
        start = len(mb.verts)
        mb.verts.extend(inset)
        ring0 = base + end * n
        for k in range(n):
            k2 = (k + 1) % n
            f = [ring0 + k, ring0 + k2, start + k2, start + k]
            mb.faces.append(f if sign > 0 else list(reversed(f)))
            mb.fmats.append(paint)
        cap = [start + k for k in range(n)]
        mb.faces.append(cap if sign > 0 else list(reversed(cap)))
        mb.fmats.append(paint)


def grille(mb, v):
    y = -0.045
    w, h, zc = 0.98, 0.46, 0.745
    # frame
    mb.box((0, y, zc + h / 2), (w + 0.05, 0.035, 0.03), "chrome")
    mb.box((0, y, zc - h / 2), (w + 0.05, 0.035, 0.03), "chrome")
    mb.box((w / 2, y, zc), (0.03, 0.035, h + 0.02), "chrome")
    mb.box((-w / 2, y, zc), (0.03, 0.035, h + 0.02), "chrome")
    mb.box((0, y + 0.02, zc), (w, 0.01, h), "plastic_black")
    if v["grille"] == "bars":
        count = 27
        for i in range(count):
            x = -w / 2 + w * (i + 0.5) / count
            mb.box((x, y - 0.004, zc), (0.013, 0.028, h - 0.01), "chrome")
    else:
        for i in range(7):
            z = zc - h / 2 + h * (i + 0.5) / 7
            mb.box((0, y - 0.004, z), (w - 0.01, 0.028, 0.018), "chrome")
    # lower intake and its chrome lip
    mb.box((0, -0.035, 0.44), (1.2, 0.02, 0.14), "plastic_black")
    mb.box((0, -0.05, 0.36), (1.25, 0.03, 0.02), "chrome")


def lamps(mb, v):
    heads = []
    for sx in (1, -1):
        x = sx * 0.72
        mb.box((x, -0.028, 0.9), (0.36, 0.012, 0.1), "headlight_body")
        mb.box((x, -0.037, 0.905), (0.29, 0.008, 0.052), "headlight")
        mb.box((x, -0.037, 0.862), (0.32, 0.008, 0.012), "drl")
        # fog lamp
        mb.box((sx * 0.64, -0.04, 0.47), (0.13, 0.01, 0.035), "drl")
        heads.append(Vector((x, -0.05, 0.905)))
    # tail lights
    for sx in (1, -1):
        mb.box((sx * 0.78, 5.235, 1.02), (0.3, 0.01, 0.06), "taillight")
    return heads


def wheel(mb, a, side, at_origin=False):
    """One wheel at its hub; `at_origin` builds it about (0, 0, 0) for a wheel that is its own part."""
    c = Vector((0.0, 0.0, 0.0)) if at_origin else Vector((side * 0.87, a, WHEEL_R))
    ax = Vector((1, 0, 0))
    mb.torus(c, ax, 0.33, 0.1, 40, 10, "tyre", scale_minor_axis=1.3)
    face = c + ax * side * 0.1
    mb.cylinder(face - ax * side * 0.05, face, 0.3, 40, "chrome")
    mb.cylinder(face, face + ax * side * 0.012, 0.29, 40, "headlight_body")
    # turbine spokes, radial blades in the wheel face
    for k in range(22):
        t = 2 * math.pi * k / 22
        d = Vector((0, math.cos(t), math.sin(t)))
        p0 = face + ax * side * 0.018 + d * 0.07
        p1 = face + ax * side * 0.018 + d * 0.28
        mb.beam(p0, p1, 0.022, 0.016, "chrome", up=tuple(ax))
    mb.cylinder(face + ax * side * 0.012, face + ax * side * 0.04, 0.065, 20, "chrome")


def mirrors(mb, v):
    for sx in (1, -1):
        mb.box((sx * 1.05, 1.62, 1.2), (0.16, 0.1, 0.12), v["paint"])


def build(ctx, variants):
    coll, mats = ctx["coll"], ctx["mats"]
    heads_all = []
    for n, v in enumerate(variants):
        loc = Vector(v["loc"])
        yaw = math.radians(v["yaw"])
        bm = util.MB(f"car.{n}_body")
        body(bm, v)
        mirrors(bm, v)
        moving = bool(v.get("moving"))
        # A car that drives is a rig: its body is the part `car<n>` (pivot at the car's origin),
        # its trim rides on it, and each wheel is its own part turning about its hub.
        body_props = {"loom_area": "car", **({"loom_part": f"car{n}", "loom_parent": ""} if moving else {})}
        body_ob = bm.to_object(mats, coll, smooth_deg=None, subsurf=2, location=loc, yaw=yaw, props=body_props)
        pm = util.MB(f"car.{n}_parts")
        grille(pm, v)
        heads = lamps(pm, v)
        if not moving:
            for a in AXLES:
                wheel(pm, a, 1)
                wheel(pm, a, -1)
        if v.get("ornament"):
            pm.cylinder((0, 0.16, 1.02), (0, 0.16, 1.1), 0.012, 12, "chrome")
            pm.torus((0, 0.16, 1.14), (0, 1, 0), 0.035, 0.006, 24, 6, "chrome")
        trim_props = {"loom_area": "car", **({"loom_part": f"car{n}_trim", "loom_parent": f"car{n}"} if moving else {})}
        trim_ob = pm.to_object(mats, coll, smooth_deg=35, location=loc, yaw=yaw, props=trim_props)
        if moving:
            import bpy
            rot0 = Matrix.Rotation(yaw, 3, "Z")
            children = [trim_ob]
            for a in AXLES:
                for side in (1, -1):
                    tag = f"{'f' if a < 2 else 'r'}{'r' if side > 0 else 'l'}"
                    wm = util.MB(f"car.{n}_wheel_{tag}")
                    wheel(wm, a, side, at_origin=True)
                    hub = loc + rot0 @ Vector((side * 0.87, a, WHEEL_R))
                    children.append(wm.to_object(mats, coll, smooth_deg=35, location=hub, yaw=yaw,
                                                 props={"loom_area": "car", "loom_part": f"car{n}_wheel_{tag}", "loom_parent": f"car{n}"}))
            bpy.context.view_layer.update()
            for child in children:
                world = child.matrix_world.copy()
                child.parent = body_ob
                child.matrix_world = world
        rot = Matrix.Rotation(yaw, 3, "Z")
        fwd = rot @ Vector((0, -1, 0))
        for side, h in zip("lr", heads):
            heads_all.append((f"lamp.head.{n}{side}", loc + rot @ h, fwd))
    return heads_all
