"""Control pulpit on the operating deck facing the furnace: steel-panel cabin, raked
front windows (open frames, so the inside camera sees out), consoles with glowing screens,
AC units, beacon, and a heat-shield mesh frame."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, rot_z, rot_x, box, box_minmax, beam, cyl, lathe, handrail, sweep, disk, TAU)
import layout as L

PX0, PX1 = -3.8, 3.2
PY0, PY1 = -12.8, -9.0
Z0 = L.DECK_Z + 0.45
H = 3.3


def build(ctx):
    mb = MB("pulpit")
    z1 = Z0 + H
    # raised plinth
    box_minmax(mb, (PX0 - 0.2, PY0 - 0.2, L.DECK_Z), (PX1 + 0.2, PY1 + 0.3, Z0), "steel_chequer")
    # back and side walls (ribbed panels)
    t = 0.08
    box_minmax(mb, (PX0, PY0, Z0), (PX1, PY0 + t, z1), "steel_painted_grey")
    for x in np.arange(PX0 + 0.4, PX1, 0.6):
        box_minmax(mb, (x - 0.02, PY0 - 0.05, Z0), (x + 0.02, PY0, z1), "steel_painted_grey")
    for xs in (PX0, PX1 - t):
        box_minmax(mb, (xs, PY0, Z0), (xs + t, PY1, Z0 + 1.0), "steel_painted_grey")
        box_minmax(mb, (xs, PY0, z1 - 0.5), (xs + t, PY1, z1), "steel_painted_grey")
        box_minmax(mb, (xs, PY0, Z0 + 1.0), (xs + t, PY0 + 0.9, z1 - 0.5), "steel_painted_grey")
        box_minmax(mb, (xs + 0.03, PY0 + 0.9, Z0 + 1.0), (xs + t - 0.03, PY1 - 0.2, z1 - 0.5), "glass_pulpit")
    # front: sill wall, raked window frames (no panes), header
    box_minmax(mb, (PX0, PY1 - t, Z0), (PX1, PY1, Z0 + 0.95), "steel_painted_grey")
    box_minmax(mb, (PX0, PY1 - 0.1, z1 - 0.45), (PX1, PY1 + 0.45, z1), "steel_painted_grey")
    mull = np.linspace(PX0 + 0.05, PX1 - 0.05, 6)
    for x in mull:
        beam(mb, (x, PY1 - 0.05, Z0 + 0.95), (x, PY1 + 0.4, z1 - 0.45), 0.08, 0.1, "paint_black")
    # glazing: one thin pane per bay in the raked plane (material glass_pulpit, so loom can select it on its own)
    d = v3(0.0, 0.45, (z1 - 0.45) - (Z0 + 0.95))
    n = norm(np.cross(d, v3(1.0, 0.0, 0.0)))
    for x0, x1 in zip(mull[:-1], mull[1:]):
        xc = (x0 + x1) / 2
        beam(mb, v3(xc, PY1 - 0.05, Z0 + 0.95) + norm(d) * 0.05 + n * 0.01, v3(xc, PY1 + 0.4, z1 - 0.45) - norm(d) * 0.05 + n * 0.01,
             x1 - x0 - 0.075, 0.012, "glass_pulpit", up=n)
    # door vision panel
    box_minmax(mb, (PX1 + 0.02, PY0 + 1.45, Z0 + 1.2), (PX1 + 0.035, PY0 + 1.95, Z0 + 1.8), "glass_pulpit")
    beam(mb, (PX0, PY1 - 0.05, Z0 + 0.95), (PX1, PY1 - 0.05, Z0 + 0.95), 0.1, 0.1, "paint_black")
    beam(mb, (PX0, PY1 + 0.4, z1 - 0.45), (PX1, PY1 + 0.4, z1 - 0.45), 0.1, 0.1, "paint_black")
    # heat-shield mesh frame hinged above the windows (propped open)
    for x in np.linspace(PX0, PX1, 12):
        beam(mb, (x, PY1 + 0.5, z1 - 0.05), (x, PY1 + 1.6, z1 + 0.35), 0.015, 0.015, "steel_dark")
    beam(mb, (PX0, PY1 + 1.6, z1 + 0.35), (PX1, PY1 + 1.6, z1 + 0.35), 0.06, 0.06, "steel_dark")
    # roof, AC units, beacon, railing
    box_minmax(mb, (PX0 - 0.1, PY0 - 0.1, z1), (PX1 + 0.1, PY1 + 0.5, z1 + 0.15), "steel_dark")
    for x in (PX0 + 1.0, PX1 - 1.4):
        box_minmax(mb, (x - 0.6, PY0 + 0.3, z1 + 0.15), (x + 0.6, PY0 + 1.2, z1 + 1.05), "steel_galvanized")
        disk(mb, (x, PY0 + 0.75, z1 + 1.06), 0.35, "steel_dark", seg=16)
    cyl(mb, (PX1 - 0.3, PY1 + 0.2, z1 + 0.15), (PX1 - 0.3, PY1 + 0.2, z1 + 0.45), 0.1, "steel_painted_yellow", seg=10)
    lathe(mb, [(0.0, z1 + 0.45), (0.12, z1 + 0.45), (0.12, z1 + 0.65), (0.0, z1 + 0.7)], Xf(None, (PX1 - 0.3, PY1 + 0.2, 0)),
          "lamp", seg=12)
    handrail(mb, [(PX0, PY0, z1 + 0.15), (PX0, PY1 + 0.4, z1 + 0.15), (PX1, PY1 + 0.4, z1 + 0.15), (PX1, PY0, z1 + 0.15)],
             mat="steel_painted_yellow", toe=False)
    # interior: floor, consoles with screens, chairs, ceiling lights
    box_minmax(mb, (PX0 + t, PY0 + t, Z0), (PX1 - t, PY1 - t, Z0 + 0.03), "paint_black")
    for k in range(3):
        cx = PX0 + 1.0 + k * 2.2
        box_minmax(mb, (cx - 0.95, PY1 - 1.05, Z0), (cx + 0.95, PY1 - 0.35, Z0 + 0.78), "steel_painted_grey")
        beam(mb, (cx - 0.95, PY1 - 0.7, Z0 + 0.82), (cx + 0.95, PY1 - 0.5, Z0 + 0.95), 0.4, 0.06, "steel_painted_grey", up=(0, -1, 2))
        for j in range(3):
            sx = cx - 0.6 + j * 0.6
            box(mb, (0.52, 0.06, 0.34), Xf(rot_x(-0.25), (sx, PY1 - 1.0, Z0 + 1.2)), "paint_black")
            box(mb, (0.46, 0.02, 0.28), Xf(rot_x(-0.25), (sx, PY1 - 1.035, Z0 + 1.2)), "screen_glow")
        cyl(mb, (cx, PY1 - 1.8, Z0), (cx, PY1 - 1.8, Z0 + 0.45), 0.04, "steel_dark", seg=6)
        box(mb, (0.5, 0.5, 0.08), Xf(None, (cx, PY1 - 1.8, Z0 + 0.5)), "cable_rubber")
        box(mb, (0.5, 0.08, 0.55), Xf(None, (cx, PY1 - 2.05, Z0 + 0.8)), "cable_rubber")
    fx = ctx.setdefault("fixtures", [])
    for x in (PX0 + 1.5, PX1 - 1.5):
        box_minmax(mb, (x - 0.6, PY0 + 1.6, z1 - 0.06), (x + 0.6, PY0 + 1.8, z1 - 0.02), "lamp")
        fx.append(("pulpit", "panel", (x, PY0 + 1.7, z1 - 0.07), (0.0, 0.0, -1.0), None))
    fx.append(("pulpit", "beacon", (PX1 - 0.3, PY1 + 0.2, z1 + 0.58), (0.0, 0.0, 1.0), None))
    # cabinet row at the back wall
    for k in range(5):
        x = PX0 + 0.7 + k * 1.3
        box_minmax(mb, (x - 0.6, PY0 + t, Z0), (x + 0.6, PY0 + 0.7, Z0 + 2.1), "steel_painted_grey")
        for j in range(4):
            box(mb, (0.05, 0.02, 0.05), Xf(None, (x - 0.4 + j * 0.1, PY0 + 0.71, Z0 + 1.7)), "screen_glow")
    # door + steps
    box_minmax(mb, (PX1 - 0.02, PY0 + 1.2, Z0), (PX1 + 0.02, PY0 + 2.2, Z0 + 2.1), "steel_painted_blue")
    for k in range(2):
        box_minmax(mb, (PX1 + 0.1 + k * 0.28, PY0 + 1.1, L.DECK_Z), (PX1 + 0.38 + k * 0.28, PY0 + 2.3, Z0 - k * 0.22), "steel_worn")
    return [(mb, dict())]
