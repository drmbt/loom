"""Pipe racks (cooling water supply/return, gas, oxygen, air, steam), cable trays, valves,
drops, and the furnace cooling-water feed with flexible hoses onto the tilting shell."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, frame, rot_z, rot_x, box, box_minmax, beam, ibeam, cyl, lathe, torus, sweep,
                  bezier, catenary, hexbolt, flange, pipe_run, profile_beam, channel_prof, angle_prof, TAU)
import layout as L

RACK_Y = -L.HY + 2.2          # rack centre line along the -Y wall
PIPES_LOW = [(-0.75, 0.36, "pipe_green"), (0.0, 0.33, "steel_primer_red"), (0.72, 0.28, "steel_painted_grey")]
PIPES_MID = [(-0.9, 0.16, "steel_painted_yellow"), (-0.45, 0.13, "steel_painted_blue"), (0.0, 0.2, "steel_galvanized"),
             (0.45, 0.11, "steel_painted_blue"), (0.85, 0.14, "pipe_green")]
Z_LOW, Z_MID, Z_TRAY = 5.0, 7.0, 9.1


def valve(mb, c, axis, r, mat="steel_painted_grey", wheel_up=(0, 0, 1)):
    c, ax = v3(c), norm(v3(axis))
    up = norm(v3(wheel_up))
    flange(mb, c - ax * r * 1.2, ax, r, "steel_dark", seg=12)
    flange(mb, c + ax * r * 1.2, ax, r, "steel_dark", seg=12)
    cyl(mb, c - ax * r * 1.1, c + ax * r * 1.1, r * 1.35, mat, seg=16)
    cyl(mb, c, c + up * r * 3.2, r * 0.55, mat, seg=12)
    cyl(mb, c + up * r * 3.2, c + up * r * 4.2, r * 0.12, "steel_worn", seg=6)
    torus(mb, Xf(frame(up), c + up * r * 4.0), r * 1.2, r * 0.08, "hose_red", seg=16, rseg=4)
    for k in range(3):
        a = k * TAU / 3
        F = frame(up)
        d = F[:, 0] * math.cos(a) + F[:, 1] * math.sin(a)
        cyl(mb, c + up * r * 4.0, c + up * r * 4.0 + d * r * 1.15, r * 0.05, "hose_red", seg=4)


def rack(ctx):
    rng = ctx["rng"]
    mb = MB("pipe_rack")
    x0, x1 = L.HX0 + 1.0, L.HX1 - 1.0
    # T-bents every 6 m
    for x in np.arange(x0 + 1.0, x1, 6.0):
        ibeam(mb, (x, RACK_Y + 1.25, 0.3), (x, RACK_Y + 1.25, Z_TRAY + 0.9), 0.3, 0.25, "steel_painted_grey", up=(0, 1, 0))
        box_minmax(mb, (x - 0.4, RACK_Y + 0.85, 0), (x + 0.4, RACK_Y + 1.65, 0.3), "concrete")
        for z in (Z_LOW - 0.45, Z_MID - 0.3, Z_TRAY - 0.12):
            profile_beam(mb, channel_prof(0.2, 0.075, 0.007, 0.011), (x, RACK_Y + 1.35, z), (x, -L.HY + 0.3, z),
                         "steel_painted_grey", up=(0, 0, 1), roll=math.pi / 2)
            beam(mb, (x, RACK_Y + 1.2, z - 0.8), (x, RACK_Y - 0.9, z - 0.05), 0.08, 0.08, "steel_painted_grey")
    # pipes (long straight runs, flanged every 6 m, with a couple of expansion loops)
    for dy, r, mat in PIPES_LOW:
        y = RACK_Y + dy * 1.1
        pipe_run(mb, [(x0, y, Z_LOW + r - 0.35), (x1, y, Z_LOW + r - 0.35)], r, mat, seg=18, flange_every=6.0)
    for dy, r, mat in PIPES_MID:
        y = RACK_Y + dy
        z = Z_MID - 0.19 + r
        pts = [(x0, y, z)]
        for xl in (-30.0, 30.0):
            pts += [(xl - 3.0, y, z), (xl - 3.0, y, z + 2.2 + dy), (xl + 3.0, y, z + 2.2 + dy), (xl + 3.0, y, z)]
        pts.append((x1, y, z))
        pipe_run(mb, pts, r, mat, seg=12, flange_every=6.0, bend=0.6)
    # valves on the big lines
    for x in (-42.0, -18.0, 6.0, 30.0):
        dy, r, mat = PIPES_LOW[rng.randrange(3)]
        valve(mb, (x, RACK_Y + dy * 1.1, Z_LOW + r - 0.35), (1, 0, 0), r, mat="steel_painted_grey")
    # cable trays (ladder type) with bundled cables
    for dy in (-0.6, 0.3):
        y = RACK_Y + dy
        for sd in (-0.25, 0.25):
            beam(mb, (x0, y + sd, Z_TRAY), (x1, y + sd, Z_TRAY), 0.012, 0.12, "steel_galvanized")
        for x in np.arange(x0, x1, 0.3):
            beam(mb, (x, y - 0.25, Z_TRAY - 0.05), (x, y + 0.25, Z_TRAY - 0.05), 0.03, 0.012, "steel_galvanized", caps=False)
        for k in range(5):
            cyl(mb, (x0, y - 0.18 + k * 0.09, Z_TRAY - 0.0), (x1, y - 0.18 + k * 0.09, Z_TRAY - 0.0), 0.035, "cable_rubber", seg=6, caps=False)
    # drops to the floor at intervals (pipe spools + hydrant valves)
    for x in (-50.0, -26.0, 22.0, 46.0):
        dy, r, mat = PIPES_MID[rng.randrange(5)]
        y = RACK_Y + dy
        pipe_run(mb, [(x, y, Z_MID - 0.19 + r), (x, y, Z_MID - 0.19 + r - 0.01), (x + 0.001, y + 1.8, Z_MID - 0.3), (x, y + 1.8, 1.2)],
                 r, mat, seg=10, flange_every=2.5, bend=0.4)
        valve(mb, (x, y + 1.8, 1.4), (0, 0, 1), r, wheel_up=(0, 1, 0))
    return mb


def trays_north(ctx):
    mb = MB("pipe_trays_north")
    y = L.HY - 1.2
    for xa, xb in ((L.HX0 + 1, -8.0), (8.0, L.HX1 - 1)):
        for z in (10.2, 11.0):
            for sd in (-0.3, 0.3):
                beam(mb, (xa, y + sd, z), (xb, y + sd, z), 0.012, 0.1, "steel_galvanized")
            for x in np.arange(xa, xb, 0.3):
                beam(mb, (x, y - 0.3, z - 0.04), (x, y + 0.3, z - 0.04), 0.03, 0.012, "steel_galvanized", caps=False)
            for k in range(6):
                cyl(mb, (xa, y - 0.22 + k * 0.09, z), (xb, y - 0.22 + k * 0.09, z), 0.032, "cable_rubber", seg=6, caps=False)
        for x in np.arange(xa, xb, 3.0):
            beam(mb, (x, L.HY - 0.4, 11.4), (x, y - 0.45, 11.4), 0.08, 0.08, "steel_painted_grey")
            beam(mb, (x, y - 0.4, 11.4), (x, y - 0.4, 10.1), 0.06, 0.06, "steel_painted_grey")
    # big water return pipe along +Y wall at 4.5 m (behind the vault it rises over)
    y2 = L.HY - 0.9
    pipe_run(mb, [(L.HX0 + 1, y2, 4.5), (-9.0, y2, 4.5), (-8.0, y2, 19.6), (8.0, y2, 19.6), (9.0, y2, 4.5), (L.HX1 - 1, y2, 4.5)],
             0.3, "steel_primer_red", seg=16, flange_every=6.0, bend=0.9)
    for x in np.arange(L.HX0 + 3, L.HX1, 6.0):
        if -10 < x < 10:
            continue
        box_minmax(mb, (x - 0.1, y2 - 0.35, 0.0), (x + 0.1, y2 + 0.35, 4.15), "steel_painted_grey")
    return mb


def furnace_feed(ctx):
    """Cooling water from the rack to a manifold at the furnace, then flexible hoses to the ring mains."""
    mb = MB("pipe_furnace_feed")
    xm, ym = -5.6, -6.6
    for k, (mat, dy) in enumerate((("pipe_green", -0.4), ("steel_primer_red", 0.4))):
        x = -3.0 + dy
        y_rack = RACK_Y + PIPES_LOW[k][0] * 1.1
        z_rack = Z_LOW + PIPES_LOW[k][1] - 0.35
        pipe_run(mb, [(x, y_rack, z_rack), (x, y_rack + 1.0, z_rack), (x, -8.0, z_rack), (x, -8.0, 4.0),
                      (xm + dy, ym - 0.6, 4.0), (xm + dy, ym - 0.6, 7.4)], 0.26, mat, seg=16, flange_every=3.0, bend=0.7)
    # manifold on the deck with valves
    box_minmax(mb, (xm - 1.1, ym - 1.1, L.DECK_Z), (xm + 1.1, ym + 0.2, L.DECK_Z + 0.15), "steel_dark")
    for dy, mat in ((-0.4, "pipe_green"), (0.4, "steel_primer_red")):
        cyl(mb, (xm + dy, ym - 0.6, 7.4), (xm + dy, ym - 0.6, 8.4), 0.26, mat, seg=16)
        cyl(mb, (xm + dy - 0.0, ym - 0.6 - 0.0, 8.4), (xm + dy, ym + 0.1, 8.4), 0.26, mat, seg=16)
        valve(mb, (xm + dy, ym - 0.6, 7.7), (0, 0, 1), 0.18, wheel_up=(0, -1, 0))
    # flexible hoses (sagging) from the manifold to the shell ring mains (tilting)
    for k in range(4):
        a = -2.35 + k * 0.12
        p1 = v3((L.SHELL_R + 0.62) * math.cos(a), (L.SHELL_R + 0.62) * math.sin(a), 8.95 + (0.3 if k % 2 else 0.0))
        p0 = v3(xm + (-0.4 if k < 2 else 0.4), ym + 0.15, 8.4)
        pts = catenary(p0, p1, 1.4 + 0.15 * k, 18)
        sweep(mb, pts, 0.11, "cable_rubber", seg=10)
        for q in (0.0, 1.0):
            pp = p0 if q == 0 else p1
            torus(mb, Xf(frame(norm(pts[1] - pts[0]) if q == 0 else norm(pts[-1] - pts[-2])), pp), 0.14, 0.04, "steel_worn", seg=12, rseg=4)
    return mb


def build(ctx):
    return [(rack(ctx), dict()), trays_north(ctx), furnace_feed(ctx)]
