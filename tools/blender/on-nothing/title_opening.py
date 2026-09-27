"""Where car 0's grille opening is, so the title can set itself inside it (T1407b, title).

Read-only: nothing here changes the car. The title stands in front of the GLS's own grille
(its bars and surround are fitted to the body), and needs to know the opening's outline and how
far forward the grille reaches:

- `opening()` casts rays from the camera side, swept out from the grille's centre in every
  direction, and keeps the OUTERMOST hit on the grille's surround (the black-chrome ring in the
  grille plane): the lip. The outline is Fourier-smoothed so bolt heads and the badge tab do not
  dent it. The lower intake's mesh, the same black chrome, lies below Z_FLOOR and is ignored.
- `front_y()` is the front-most point of the car inside a box, so the script clears it.

Blender frame: car 0 at the origin, its nose at y ≈ 0 facing -Y, z up.
"""
import math

import bpy
from mathutils import Vector

CENTRE = (0.0, 0.85)   # a point inside the opening, (x, z)
RING_MATS = {"headlight_body", "plastic_black", "chrome"}  # what the grille's surround is made of
Z_FLOOR = 0.685        # the grille's bottom edge sits at ~0.70; the mesh intake under it is not grille
HARMONICS = 6          # Fourier terms kept in the lip's outline


def _cast(car, x, z):
    """(y, material) where a ray from the front at (x, z) meets car 0, or None."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    inv = car.matrix_world.inverted()
    direction = (inv.to_3x3() @ Vector((0, 1, 0))).normalized()
    hit, loc, _n, index = car.ray_cast(inv @ Vector((x, -1.0, z)), direction, depsgraph=depsgraph)
    if not hit:
        return None
    me = car.data
    mat = me.materials[me.polygons[index].material_index]
    return (car.matrix_world @ loc).y, (mat.name.split(".")[0] if mat is not None else "")


def _front(car, x, z, spread=0.008):
    """The front-most of a small cluster of rays: a gap between grille bars sees deep into the
    car, but its neighbours land on the bars."""
    hits = [_cast(car, x + dx, z + dz) for dx in (-spread, 0.0, spread) for dz in (-spread, 0.0, spread)]
    hits = [h for h in hits if h is not None]
    return min(hits, key=lambda h: h[0]) if hits else None


def opening(car, step_deg=3):
    """The opening's lip as (x, z) points, counter-clockwise from the right, smoothed."""
    cx, cz = CENTRE
    ring = []
    for k in range(0, 360, step_deg):
        a = math.radians(k)
        dx, dz = math.cos(a) * 0.62, math.sin(a) * 0.22
        last = None
        for i in range(30, 170):
            r = i / 100
            x, z = cx + dx * r, cz + dz * r
            if z < Z_FLOOR:
                break
            h = _front(car, x, z)
            if h is not None and h[1] in RING_MATS and h[0] < 0.1:
                last = r
        if last is not None:
            ring.append((a, last + 0.005))  # angle and radius in the march's ellipse units
    n = len(ring)
    coef = []
    for h in range(HARMONICS + 1):
        a = sum(r * math.cos(h * t) for t, r in ring) * 2 / n
        b = sum(r * math.sin(h * t) for t, r in ring) * 2 / n
        coef.append((a / 2 if h == 0 else a, b))
    lip = []
    for t, _r in ring:
        r = sum(a * math.cos(h * t) + b * math.sin(h * t) for h, (a, b) in enumerate(coef))
        lip.append((cx + math.cos(t) * r * 0.62, cz + math.sin(t) * r * 0.22))
    xs = [p[0] for p in lip]
    zs = [p[1] for p in lip]
    print(f"[title] grille opening: {n} lip points, x {min(xs):.3f}..{max(xs):.3f}, z {min(zs):.3f}..{max(zs):.3f}", flush=True)
    return lip


def span_at(ring, x):
    """The (bottom, top) z where the vertical line at x crosses the closed ring, or None."""
    zs = []
    n = len(ring)
    for k in range(n):
        (xa, za), (xb, zb) = ring[k], ring[(k + 1) % n]
        if (xa - x) * (xb - x) <= 0 and xa != xb:
            zs.append(za + (zb - za) * (x - xa) / (xb - xa))
    return (min(zs), max(zs)) if len(zs) >= 2 else None


def front_y(car, x0, x1, z0, z1, steps=24):
    """The front-most y of car 0 over the box [x0, x1] × [z0, z1]."""
    ys = []
    for i in range(steps + 1):
        for j in range(steps // 3 + 1):
            h = _cast(car, x0 + (x1 - x0) * i / steps, z0 + (z1 - z0) * j / (steps // 3))
            if h is not None and h[0] < 0.3:
                ys.append(h[0])
    return min(ys) if ys else 0.0
