"""The white limbo of the reference's wide (1:44.55), T1407b cyc: area `cycwide`.

The big cyc (`sets.cyc`) has a 2.5 m cove: a figure standing on its floor throws a shadow that
lies along the curve and reads as a streak. In the reference's wide the far man stands close
in front of the wall and a low key from the camera's right throws his WHOLE silhouette up it,
head, shoulders and raised arm, displaced to his right. So the wide gets its own studio cyc,
with a tight cove (0.8 m, a real studio's) a little over a metre behind the far man's mark.
It sits at the origin like every set (a directional light's shadow volume is framed there)
and is drawn only in `cyc-wide`.
"""
import math

import util

# Blender metres (the figure faces -Y; loom's glTF z is -Y).
WALL_Y = 5.6          # the vertical wall's face
COVE = 0.8            # cove radius: the floor turns up into the wall over this
FRONT_Y = -8.0        # the floor's near edge, behind the camera
X0, X1 = -12.0, 14.0  # wide enough for the 24 mm frame
TOP = 7.0


def build(ctx):
    coll, mats = ctx["coll"], ctx["mats"]
    mb = util.MB("cycwide.shell")
    seg = 16
    yb = WALL_Y - COVE
    # the profile across y: the floor, the cove, the wall
    prof = [(FRONT_Y, 0.0), (-4.0, 0.0), (0.0, 0.0), (2.5, 0.0), (yb - 0.5, 0.0)]
    for k in range(seg + 1):
        t = (math.pi / 2) * k / seg
        prof.append((yb + COVE * math.sin(t), COVE - COVE * math.cos(t)))
    prof.append((WALL_Y, TOP))
    cols = 26
    verts, faces = [], []
    xs = [X0 + (X1 - X0) * i / cols for i in range(cols + 1)]
    for x in xs:
        for (y, z) in prof:
            verts.append((x, y, z))
    m = len(prof)
    for i in range(cols):
        for j in range(m - 1):
            a = i * m + j
            faces.append((a, a + 1, a + m + 1, a + m))
    mb.add(verts, faces, "cyc_white")
    obj = mb.to_object(mats, coll, smooth_deg=80.0, props={"loom_area": "cycwide"})
    util.face_toward(obj, (0.0, 0.0, 2.0))
    return obj
