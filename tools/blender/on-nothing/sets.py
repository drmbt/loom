"""The two worlds of the On Nothing scene (T1400b): the industrial void and the white limbo.

- `wh.*`: a dark warehouse around the origin — concrete floor, brick walls, steel columns,
  pitched roof trusses with purlins and roof sheet. Nothing else lights it: the columns of
  light in the reference are the streak filter over the cars' headlights.
- `cyc.*`: a white infinity cyc at the origin (drawn only in its own shot): floor, a coved back wall and a coved left wall.

The silhouette shot needs no set: it is the figure in black at x = -60 (see build.py's stages).
"""
import math

from mathutils import Vector

import util

W, D, H = 40.0, 36.0, 7.0      # warehouse width (x), depth (y), eave height
# At the origin like the warehouse (never drawn in the same shot): a directional light's
# shadow volume is framed around the world origin, so the cyc must sit there to get shadows.
CYC_X = 0.0


def warehouse(ctx):
    coll, mats = ctx["coll"], ctx["mats"]
    fl = util.MB("wh.floor")
    n = 12
    verts, faces = [], []
    for i in range(n + 1):
        for j in range(n + 1):
            verts.append((-W / 2 + W * i / n, -D / 2 + D * j / n, 0.0))
    for i in range(n):
        for j in range(n):
            a = i * (n + 1) + j
            faces.append((a, a + n + 1, a + n + 2, a + 1))
    fl.add(verts, faces, "concrete")
    util.face_toward(fl.to_object(mats, coll, smooth_deg=None, props={"loom_area": "wh"}), (0, 0, 3))

    walls = util.MB("wh.walls")
    walls.box((0, D / 2, H / 2 + 1), (W, 0.3, H + 2), "brick_dark")
    walls.box((0, -D / 2, H / 2 + 1), (W, 0.3, H + 2), "brick_dark")
    walls.box((W / 2, 0, H / 2 + 1), (0.3, D, H + 2), "brick_dark")
    walls.box((-W / 2, 0, H / 2 + 1), (0.3, D, H + 2), "brick_dark")
    util.face_toward(walls.to_object(mats, coll, smooth_deg=30, props={"loom_area": "wh"}), (0, 0, 3))

    steel = util.MB("wh.steel")
    for x in (-13.5, 13.5):
        for y in range(-15, 16, 5):
            steel.box((x, y, H / 2), (0.3, 0.3, H), "steel_truss")
            steel.box((x, y, H / 2), (0.06, 0.28, H), "steel_truss")
    ridge = H + 2.2
    for y in range(-15, 16, 5):
        pts = []
        for k in range(21):
            x = -W / 2 + W * k / 20
            pts.append((x, H + 2.2 * (1 - abs(x) / (W / 2))))
        for (x0, t0), (x1, t1) in zip(pts, pts[1:]):
            steel.beam((x0, y, H), (x1, y, H), 0.12, 0.14, "steel_truss")
            steel.beam((x0, y, t0), (x1, y, t1), 0.12, 0.14, "steel_truss")
        for k, (x, t) in enumerate(pts):
            steel.beam((x, y, H), (x, y, t), 0.07, 0.07, "steel_truss", up=(1, 0, 0))
            if k + 1 < len(pts):
                x1, t1 = pts[k + 1]
                a, b = ((x, H), (x1, t1)) if k % 2 == 0 else ((x, t), (x1, H))
                steel.beam((a[0], y, a[1]), (b[0], y, b[1]), 0.06, 0.06, "steel_truss")
    for k in range(-9, 10):
        x = 2.0 * k
        z = H + 2.2 * (1 - abs(x) / (W / 2)) + 0.12
        steel.beam((x, -D / 2, z), (x, D / 2, z), 0.08, 0.12, "steel_truss")
    steel.to_object(mats, coll, smooth_deg=30, props={"loom_area": "wh"})

    roof = util.MB("wh.roof")
    z0, z1 = H + 0.3, ridge + 0.3
    roof.add([(-W / 2, -D / 2, z0), (0, -D / 2, z1), (0, D / 2, z1), (-W / 2, D / 2, z0)], [(0, 3, 2, 1)], "roof_sheet")
    roof.add([(0, -D / 2, z1), (W / 2, -D / 2, z0), (W / 2, D / 2, z0), (0, D / 2, z1)], [(0, 3, 2, 1)], "roof_sheet")
    util.face_toward(roof.to_object(mats, coll, smooth_deg=None, props={"loom_area": "wh"}), (0, 0, 3))

    # No LED tubes: the first cut read the reference's light columns as floor tubes; they are
    # the streak filter smearing the headlights (owner, 2026-09-27: "its all just cars").
    markers = []
    return markers


def cyc(ctx):
    coll, mats = ctx["coll"], ctx["mats"]
    mb = util.MB("cyc.shell")
    x0, x1 = CYC_X - 10, CYC_X + 18
    yf, yb, r, top = -12.0, 5.0, 2.5, 9.0
    xl = CYC_X - 6.0     # the left wall's inner face, before its cove
    seg = 12
    # profile across y: floor then the back cove then the wall
    prof = [(yf, 0.0)]
    for k in range(seg + 1):
        t = (math.pi / 2) * k / seg
        prof.append((yb + r * math.sin(t), r - r * math.cos(t)))
    prof.append((yb + r, top))
    # the back floor+cove+wall, from the left cove's end to x1
    cols = 10
    verts, faces = [], []
    xs = [xl + r + (x1 - xl - r) * i / cols for i in range(cols + 1)]
    for x in xs:
        for (y, z) in prof:
            verts.append((x, y, z))
    m = len(prof)
    for i in range(cols):
        for j in range(m - 1):
            a = i * m + j
            faces.append((a, a + 1, a + m + 1, a + m))
    mb.add(verts, faces, "cyc_white")
    # the left cove: the same profile turned to run along y, meeting the back at a corner cone
    lp = [(xl + r - r * math.sin((math.pi / 2) * k / seg), r - r * math.cos((math.pi / 2) * k / seg)) for k in range(seg + 1)]
    lp.append((xl, top))
    rows = 10
    verts, faces = [], []
    ys = [yf + (yb - yf) * i / rows for i in range(rows + 1)]
    for y in ys:
        for (x, z) in lp:
            verts.append((x, y, z))
    m2 = len(lp)
    for i in range(rows):
        for j in range(m2 - 1):
            a = i * m2 + j
            faces.append((a, a + m2, a + m2 + 1, a + 1))
    mb.add(verts, faces, "cyc_white")
    # the corner: a quarter sphere joining the two coves
    cx, cy = xl + r, yb
    verts, faces = [], []
    for i in range(seg + 1):
        a = (math.pi / 2) * i / seg           # around z: 0 = toward -x, pi/2 = toward +y
        for j in range(seg + 1):
            b = (math.pi / 2) * j / seg       # 0 = floor, pi/2 = wall
            rr = r * math.sin(b)
            verts.append((cx - rr * math.cos(a), cy + rr * math.sin(a), r - r * math.cos(b)))
    for i in range(seg):
        for j in range(seg):
            q = i * (seg + 1) + j
            faces.append((q, q + 1, q + seg + 2, q + seg + 1))
    mb.add(verts, faces, "cyc_white")
    # the left and back walls above the coves, and the floor under the corner
    mb.add([(xl, yb, r), (xl, yb + r, r), (xl, yb + r, top), (xl, yb, top)], [(0, 3, 2, 1)], "cyc_white")
    mb.add([(xl, yb + r, r), (xl + r, yb + r, r), (xl + r, yb + r, top), (xl, yb + r, top)], [(0, 1, 2, 3)], "cyc_white")
    obj = mb.to_object(mats, coll, smooth_deg=None, props={"loom_area": "cyc"})
    util.face_toward(obj, (CYC_X + 2.0, -4.0, 1.5))
    return obj
