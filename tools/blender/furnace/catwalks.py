"""Stairs, cage ladders, the mast-top platform, the ladle-bay pipe bridge/catwalk and
runway access. Grating everywhere is real open bar geometry."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, frame, rot_z, box, box_minmax, beam, ibeam, cyl, sweep, handrail, grating,
                  strip_bars, profile_beam, channel_prof, pipe_run, flood, TAU)
import layout as L


def stair(mb, base, direction, rise, width=1.0, angle=40.0, mat="steel_painted_yellow"):
    """Straight stair from base (bottom nosing centre) climbing `rise` along horizontal `direction`."""
    b = v3(base)
    d = norm(v3(direction[0], direction[1], 0.0))
    s = np.cross(v3(0, 0, 1), d)
    run = rise / math.tan(math.radians(angle))
    top = b + d * run + v3(0, 0, rise)
    for sd in (-1, 1):
        profile_beam(mb, channel_prof(0.25, 0.08, 0.008, 0.012), b + s * sd * width / 2 - v3(0, 0, 0.2),
                     top + s * sd * width / 2 - v3(0, 0, 0.2), "steel_painted_grey", up=(0, 0, 1),
                     roll=(math.pi / 2 if sd > 0 else -math.pi / 2))
        # sloped handrail + posts
        rail = [b + s * sd * (width / 2 + 0.05) + v3(0, 0, 0.95), top + s * sd * (width / 2 + 0.05) + v3(0, 0, 0.95)]
        sweep(mb, rail, 0.022, mat, seg=8)
        sweep(mb, [p - v3(0, 0, 0.45) for p in rail], 0.018, mat, seg=6)
        n = max(2, int(run / 1.4))
        for k in range(n + 1):
            p = b + (top - b) * (k / n) + s * sd * (width / 2 + 0.05)
            cyl(mb, p, p + v3(0, 0, 0.95), 0.024, mat, seg=6)
    steps = int(round(rise / 0.2))
    for k in range(1, steps + 1):
        p = b + d * (run * k / steps) + v3(0, 0, rise * k / steps)
        c = p - d * 0.13
        # tread = small grating panel: frame + bars
        beam(mb, c + d * 0.13 - s * width / 2, c + d * 0.13 + s * width / 2, 0.05, 0.03, "steel_worn")
        for q in range(6):
            off = -0.12 + q * 0.05
            beam(mb, c + d * off - s * width / 2, c + d * off + s * width / 2, 0.005, 0.03, "grating", caps=False)
    return top


def cage_ladder(mb, base, h, facing=(1, 0), mat="steel_painted_yellow"):
    b = v3(base)
    f = norm(v3(facing[0], facing[1], 0))
    s = np.cross(v3(0, 0, 1), f)
    for sd in (-1, 1):
        cyl(mb, b + s * sd * 0.22, b + s * sd * 0.22 + v3(0, 0, h + 1.0), 0.025, mat, seg=6)
    for z in np.arange(0.3, h, 0.3):
        cyl(mb, b - s * 0.22 + v3(0, 0, z), b + s * 0.22 + v3(0, 0, z), 0.014, mat, seg=5)
    for z in np.arange(2.4, h + 1.0, 0.9):
        pts = [b + s * 0.35 + v3(0, 0, z)] + [b + f * 0.35 + (s * math.cos(t) + f * math.sin(t)) * 0.35 + v3(0, 0, z)
                                                for t in np.linspace(0, math.pi, 7)] + [b - s * 0.35 + v3(0, 0, z)]
        sweep(mb, pts, 0.015, mat, seg=5)
    for t in np.linspace(0, math.pi, 5):
        p = b + f * 0.35 + (s * math.cos(t) + f * math.sin(t)) * 0.35
        cyl(mb, p + v3(0, 0, 2.4), p + v3(0, 0, h + 0.9), 0.012, mat, seg=4)


def build(ctx):
    mb = MB("catwalks")
    z = L.DECK_Z
    # floor -> operating deck (pulpit side), with landing
    top = stair(mb, (-23.0, -11.0, 0.0), (1, 0), z / 2)
    grating(mb, (top[0], -11.6), (top[0] + 1.6, -9.4), top[2], along="x")
    handrail(mb, [(top[0], -11.6, top[2]), (top[0] + 1.6, -11.6, top[2]), (top[0] + 1.6, -9.4, top[2])], mat="steel_painted_yellow")
    for dx in (0.1, 1.5):
        for dy in (-11.5, -9.5):
            box_minmax(mb, (top[0] + dx - 0.06, dy - 0.06, 0), (top[0] + dx + 0.06, dy + 0.06, top[2]), "steel_painted_grey")
    stair(mb, (top[0] + 1.6, -10.0, top[2]), (1, 0), z / 2)
    # floor -> deck on the tap side
    stair(mb, (20.0, 9.8, 0.0), (-1, 0), z, width=1.1)
    # tilting platform -> mast-top platform: ladder, platform grating + handrail on the guides
    cage_ladder(mb, (-4.4, 8.3, 7.25), 14.6 - 7.25, facing=(-1, 0))
    x0, x1, y0, y1 = -3.4, 3.4, 5.4, 8.1
    grating(mb, (x0, y0), (x1, y1), 14.75, along="x")
    handrail(mb, [(x0, y0, 14.75), (x0, y1, 14.75), (x1, y1, 14.75), (x1, y0, 14.75)], mat="steel_painted_yellow")
    # ladle bay: pipe bridge with a walkway crossing the hall at z=11 (the through-grating layer)
    xb = 24.0
    zc = 11.0
    grating(mb, (xb - 0.7, -L.HY + 0.5), (xb + 0.7, L.HY - 0.5), zc, along="y")
    for sd in (-1, 1):
        handrail(mb, [(xb + sd * 0.7, -L.HY + 0.5, zc), (xb + sd * 0.7, L.HY - 0.5, zc)], mat="steel_painted_yellow")
        ibeam(mb, (xb + sd * 0.75, -L.HY + 0.4, zc - 0.25), (xb + sd * 0.75, L.HY - 0.4, zc - 0.25), 0.45, 0.2, "steel_painted_grey")
        # truss web under the bridge
        for y in np.arange(-L.HY + 0.5, L.HY - 1.0, 2.0):
            beam(mb, (xb + sd * 0.75, y, zc - 0.5), (xb + sd * 0.75, y + 2.0, zc - 2.0), 0.08, 0.08, "steel_painted_grey")
            beam(mb, (xb + sd * 0.75, y + 2.0, zc - 2.0), (xb + sd * 0.75, y + 2.0, zc - 0.5), 0.08, 0.08, "steel_painted_grey")
        beam(mb, (xb + sd * 0.75, -L.HY + 0.5, zc - 2.0), (xb + sd * 0.75, L.HY - 0.5, zc - 2.0), 0.14, 0.14, "steel_painted_grey")
    for y in (-L.HY + 0.5, -5.0, 5.0, L.HY - 0.5):
        for sd in (-1, 1):
            if abs(y) < 6 and abs(y) > 1:
                ibeam(mb, (xb + sd * 0.75, y, 0.0), (xb + sd * 0.75, y, zc - 2.0), 0.35, 0.3, "steel_painted_grey", up=(1, 0, 0))
    # pipes carried under the bridge
    for k, (mat, r) in enumerate((("pipe_green", 0.18), ("steel_primer_red", 0.18), ("steel_painted_yellow", 0.1), ("steel_galvanized", 0.14))):
        y0p = -L.HY + 0.5
        pipe_run(mb, [(xb - 0.45 + k * 0.3, y0p, zc - 1.7), (xb - 0.45 + k * 0.3, L.HY - 0.5, zc - 1.7)], r, mat, seg=10, flange_every=6.0)
    stair(mb, (xb + 1.5, -L.HY + 1.2, 0.0), (1, 0), zc / 2, width=0.9)
    # floodlights clamped to the catwalk handrails: ladle-bay bridge (aimed at the car rails / turret) and mast platform
    fx = ctx.setdefault("fixtures", [])
    for y, tgt in ((-9.0, (30.0, -6.0, 12.0)), (-3.0, (16.0, 0.0, 1.0)), (4.0, (16.0, 0.0, 1.0)), (10.0, (30.0, 9.0, 3.0))):
        c = v3(xb + 0.85, y, zc + 1.25)
        flood(mb, c, v3(tgt) - c, fx, "catwalk", mount=(xb + 0.72, y, zc + 1.1))
    for x in (-3.3, 3.3):
        c = v3(x, 5.5, 14.75 + 1.3)
        flood(mb, c, v3(0.0, 0.0, 12.6) - c, fx, "catwalk", mount=(x, 5.45, 14.75 + 1.1))
    # runway access ladders on two columns
    for x in (-36.0, 36.0):
        cage_ladder(mb, (x + 0.8, -L.HY + 0.9, 0.0), 23.8, facing=(0, 1))
    return [(mb, dict())]
