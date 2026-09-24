"""Single-strand slab caster: casting floor, ladle turret (part) with a casting ladle,
tundish on its car, mould, bow-type strand with roller segments (parts), withdrawal
straightener, runout table, torch cutting machine, hot strand and cut slabs."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, frame, rot_z, rot_x, rot_y, box, box_minmax, beam, ibeam, cyl, lathe, disk,
                  torus, sweep, sweep_profile, bezier, hexbolt, bolt_circle, prism, handrail, pipe_run, grating, rock, TAU)
import layout as L
from ladle import ladle_body, LADLE_H

X0, Y0 = L.CAST_X, L.CAST_Y
RC = L.CAST_R
CZ = L.CAST_ARC_Z                 # arc centre z
CX = X0 + RC                      # arc centre x
PASS_Z = CZ - RC                  # horizontal pass line (bottom of arc)
SLAB_T, SLAB_W = 0.25, 1.6
RUN_X1 = L.HX1 - 1.5


def arc_pt(a, r=RC):
    """a=0: leaving the mould (vertical, x=X0); a=pi/2: horizontal at the bottom."""
    return v3(CX - r * math.cos(a), Y0, CZ - r * math.sin(a))


def strand_path():
    pts = [v3(X0, Y0, L.CAST_FLOOR_Z - 0.2)]
    for a in np.linspace(0, math.pi / 2, 40):
        pts.append(arc_pt(a))
    pts.append(v3(RUN_X1 - 6.5, Y0, PASS_Z))
    return pts


def floor_platform(ctx):
    mb = MB("caster_floor")
    z = L.CAST_FLOOR_Z
    x0, x1, y0, y1 = 30.0, 46.0, -14.0, 3.5
    ox0, ox1, oy0, oy1 = X0 - 1.4, X0 + 1.4, Y0 - 1.4, Y0 + 1.4
    for a, b in (((x0, y0), (x1, oy0)), ((x0, oy1), (x1, y1)), ((x0, oy0), (ox0, oy1)), ((ox1, oy0), (x1, oy1))):
        box_minmax(mb, (a[0], a[1], z - 0.25), (b[0], b[1], z), "concrete")
    for xx in np.arange(x0 + 0.3, x1, 3.0):
        ibeam(mb, (xx, y0, z - 0.7), (xx, y1, z - 0.7), 0.9, 0.35, "steel_painted_grey")
    for x in (30.6, 34.5, 42.0, 45.4):
        for y in (-13.4, -9.5, 2.9):
            if abs(x - X0) < 4 and abs(y - Y0) < 4:
                continue
            box_minmax(mb, (x - 0.55, y - 0.55, 0), (x + 0.55, y + 0.55, z - 1.15), "concrete")
    # the bow runs under the +X half: columns only where they do not hit the strand
    handrail(mb, [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), (x0, y0, z)], mat="steel_painted_yellow")
    handrail(mb, [(ox0, oy0, z), (ox1, oy0, z), (ox1, oy1, z), (ox0, oy1, z)], mat="steel_painted_yellow", post=1.0)
    # tundish car rails across the floor (along Y) + preheat station hood
    for sx in (-1.3, 1.3):
        box_minmax(mb, (X0 + sx - 0.06, y0 + 1, z), (X0 + sx + 0.06, y1 - 1, z + 0.14), "steel_worn")
    return mb


def turret(ctx):
    rng = ctx["rng"]
    mb = MB("ladle_turret")
    tx, ty = L.TURRET_XY
    z = L.CAST_FLOOR_Z
    lathe(mb, [(0.0, z), (2.2, z), (2.2, z + 0.5), (1.4, z + 0.8), (1.25, z + 4.3), (1.6, z + 4.5), (1.6, z + 5.0), (0.0, z + 5.0)],
          Xf(None, (tx, ty, 0)), "steel_painted_grey", seg=40)
    bolt_circle(mb, (tx, ty, z + 0.5), (0, 0, 1), 1.9, 24, 0.05, "steel_dark")
    # two fork arms (+Y empty, -Y holding the casting ladle)
    ladle_c = (X0, Y0, z + 2.6)
    tz, lip = ladle_body(mb, ladle_c, rng, hot=True, seed=6.6, lip_dir=(-1, 0))
    # slewing ring bolts, arm lift cylinders, access ladder, hose loop
    bolt_circle(mb, (tx, ty, z + 4.5), (0, 0, 1), 1.45, 32, 0.04, "steel_dark")
    for sy in (-1, 1):
        cyl(mb, (tx, ty + sy * 1.3, z + 3.0), (tx, ty + sy * 3.2, z + 4.9), 0.16, "steel_painted_yellow", seg=12)
    for k in range(int(4.3 / 0.3)):
        cyl(mb, (tx + 1.35, ty - 0.22, z + 0.8 + k * 0.3), (tx + 1.35, ty + 0.22, z + 0.8 + k * 0.3), 0.014, "steel_painted_yellow", seg=5)
    for sd in (-0.22, 0.22):
        cyl(mb, (tx + 1.35, ty + sd, z + 0.6), (tx + 1.35, ty + sd, z + 5.2), 0.022, "steel_painted_yellow", seg=6)
    sweep(mb, bezier((tx - 1.2, ty, z + 4.9), (tx - 2.5, ty + 0.5, z + 5.8), (tx - 3.5, ty + 1.5, z + 3.0),
                     (tx - 3.6, ty + 2.0, z + 0.05), 12), 0.07, "cable_rubber", seg=8)
    for sy in (-1, 1):
        cy = ty + sy * 5.6
        for sx in (-1, 1):
            a = v3(tx + sx * 0.9, ty + sy * 1.2, z + 4.7)
            b = v3(tx + sx * 2.5, cy, tz + 0.2)
            beam(mb, a, b, 0.5, 0.9, "steel_painted_yellow", chamfer=0.05)
            box(mb, (0.8, 0.9, 0.5), Xf(None, b + v3(0, 0, -0.1)), "steel_dark")
        beam(mb, v3(tx - 2.5, cy, tz + 0.7), v3(tx + 2.5, cy, tz + 0.7), 0.5, 0.6, "steel_painted_yellow", chamfer=0.04)
    # ladle shroud + manipulator
    cyl(mb, (X0 + 0.8, Y0, ladle_c[2] - 0.45), (X0 + 0.8, Y0, z + 1.55), 0.11, "refractory", seg=12)
    beam(mb, (X0 + 0.8, Y0, z + 1.9), (X0 + 3.4, Y0 + 1.8, z + 1.2), 0.18, 0.25, "steel_painted_yellow")
    return mb, (X0 + 0.8, Y0, z + 1.5)


def tundish(ctx):
    mb = MB("caster_tundish")
    z = L.CAST_FLOOR_Z
    # car
    box_minmax(mb, (X0 - 3.5, Y0 - 1.6, z + 0.35), (X0 + 3.5, Y0 + 1.6, z + 0.75), "steel_painted_blue")
    for sx in (-1.3, 1.3):
        for yy in (-1.3, 1.3):
            cyl(mb, (X0 + sx - 0.1, Y0 + yy, z + 0.3), (X0 + sx + 0.1, Y0 + yy, z + 0.3), 0.28, "steel_dark", seg=16)
    # trough body (trapezoid section extruded along X)
    Rm = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], dtype=float)
    prof = [(-0.55, 0.0), (0.55, 0.0), (0.9, 1.3), (-0.9, 1.3)]
    prism(mb, prof, 5.4, Xf(Rm, (X0 - 2.7, Y0, z + 0.75)), "steel_heat")
    for xx in np.linspace(X0 - 2.5, X0 + 2.5, 8):
        prism(mb, [(-0.6, 0.0), (0.6, 0.0), (0.97, 1.35), (-0.97, 1.35)], 0.08, Xf(Rm, (xx, Y0, z + 0.72)), "steel_heat")
    # lid segments with inspection holes glowing
    for k in range(4):
        xx = X0 - 2.0 + k * 1.33
        box(mb, (1.2, 2.0, 0.18), Xf(None, (xx, Y0, z + 2.14)), "refractory")
    lathe(mb, [(0.22, z + 2.24), (0.0, z + 2.24)], Xf(None, (X0 + 0.8, Y0, 0)), "molten_steel", seg=16)
    lathe(mb, [(0.18, z + 2.24), (0.0, z + 2.24)], Xf(None, (X0 - 1.5, Y0, 0)), "molten_steel", seg=16)
    # car detail: legs with lift cylinders, wheel bogies, hazard stripes, hose festoon
    for sx in (-3.2, 3.2):
        for sy in (-1.45, 1.45):
            box_minmax(mb, (X0 + sx - 0.25, Y0 + sy - 0.2, z + 0.05), (X0 + sx + 0.25, Y0 + sy + 0.2, z + 0.75), "steel_painted_blue")
            cyl(mb, (X0 + sx, Y0 + sy, z + 0.75), (X0 + sx, Y0 + sy, z + 1.35), 0.12, "steel_worn", seg=10)
            cyl(mb, (X0 + sx, Y0 + sy, z + 1.35), (X0 + sx, Y0 + sy, z + 1.9), 0.17, "steel_painted_yellow", seg=12)
    for k in range(9):
        box(mb, (0.3, 0.03, 0.12), Xf(rot_y(0.7), (X0 - 3.2 + k * 0.8, Y0 - 1.61, z + 0.55)), "paint_black")
    sweep(mb, bezier((X0 - 3.5, Y0 + 1.6, z + 0.6), (X0 - 4.6, Y0 + 2.2, z + 0.4), (X0 - 4.8, Y0 + 3.5, z + 0.2),
                     (X0 - 4.6, Y0 + 4.5, z + 0.05), 10), 0.05, "cable_rubber", seg=8)
    # tundish rim crust + lid lifting lugs + overflow spout + temperature lance arm
    rng = ctx["rng"]
    for k in range(26):
        rock(mb, (X0 - 2.6 + rng.random() * 5.2, Y0 + rng.choice((-0.93, 0.93)), z + 2.05), (0.12, 0.2, 0.08), "slag_cold", rng, seg=5, rings=2)
    for k in range(4):
        xx = X0 - 2.0 + k * 1.33
        for sy in (-0.6, 0.6):
            torus(mb, Xf(rot_x(math.pi / 2), (xx, Y0 + sy, z + 2.35)), 0.1, 0.025, "steel_dark", seg=10, rseg=4)
    box_minmax(mb, (X0 + 2.7, Y0 - 0.3, z + 1.7), (X0 + 3.3, Y0 + 0.3, z + 1.95), "steel_heat")
    cyl(mb, (X0 - 1.5, Y0 - 3.5, z), (X0 - 1.5, Y0 - 3.5, z + 3.2), 0.18, "steel_painted_grey", seg=12)
    beam(mb, (X0 - 1.5, Y0 - 3.5, z + 3.1), (X0 - 1.5, Y0 - 0.6, z + 3.1), 0.2, 0.25, "steel_painted_grey")
    cyl(mb, (X0 - 1.5, Y0 - 0.6, z + 3.1), (X0 - 1.5, Y0 - 0.6, z + 2.1), 0.05, "copper_busbar", seg=8)
    # stopper rod mechanism over the mould
    cyl(mb, (X0, Y0, z + 2.2), (X0, Y0, z + 3.6), 0.09, "refractory", seg=10)
    box_minmax(mb, (X0 - 0.1, Y0 - 0.1, z + 3.4), (X0 + 1.4, Y0 + 0.1, z + 3.65), "steel_dark")
    box_minmax(mb, (X0 + 1.2, Y0 - 0.25, z + 2.2), (X0 + 1.5, Y0 + 0.25, z + 3.7), "steel_dark")
    # submerged entry nozzle down into the mould
    cyl(mb, (X0, Y0, z + 0.75), (X0, Y0, z - 0.8), 0.08, "refractory", seg=10)
    return mb


def mould(ctx):
    mb = MB("caster_mould")
    zt = L.CAST_FLOOR_Z - 0.1
    box_minmax(mb, (X0 - 0.45, Y0 - 1.25, zt - 1.0), (X0 + 0.45, Y0 + 1.25, zt), "copper_busbar")
    box_minmax(mb, (X0 - 0.14, Y0 - 0.82, zt - 0.02), (X0 + 0.14, Y0 + 0.82, zt + 0.001), "molten_steel")
    box_minmax(mb, (X0 - 0.9, Y0 - 1.6, zt - 1.35), (X0 + 0.9, Y0 + 1.6, zt - 0.95), "steel_painted_blue")
    for sy in (-1, 1):
        box_minmax(mb, (X0 - 0.6, Y0 + sy * 1.6 - 0.15, zt - 2.4), (X0 + 0.6, Y0 + sy * 1.6 + 0.15, zt - 1.3), "steel_painted_blue")
        cyl(mb, (X0 - 1.2, Y0 + sy * 1.2, zt - 2.6), (X0 - 1.2, Y0 + sy * 1.2, zt - 1.3), 0.14, "steel_painted_yellow", seg=12)
        pipe_run(mb, [(X0 - 0.5, Y0 + sy * 1.3, zt - 0.5), (X0 - 1.6, Y0 + sy * 1.3, zt - 0.5), (X0 - 1.6, Y0 + sy * 1.3, 0.3)],
                 0.08, "pipe_green", seg=10, flange_every=3.0)
    return mb


def roller(mb, c, r, length, mat="steel_worn"):
    """Roller with axis along Y; UV v runs round the circumference (scroll v to spin)."""
    c = v3(c)
    sweep(mb, [c - v3(0, length / 2, 0), c + v3(0, length / 2, 0)], r, mat, seg=14, caps=True, uv_len=True)
    cyl(mb, c - v3(0, length / 2 + 0.2, 0), c + v3(0, length / 2 + 0.2, 0), r * 0.45, "steel_dark", seg=8)


def segments(ctx):
    """Roller pairs along the bow, grouped into 5 segment parts."""
    out = []
    bounds = [0.0, 0.3, 0.62, 0.95, 1.25, math.pi / 2]
    for sidx in range(5):
        mb = MB(f"caster_rollers_{sidx + 1}")
        a0, a1 = bounds[sidx], bounds[sidx + 1]
        n = int((a1 - a0) * RC / (0.34 + 0.05 * sidx))
        rr = 0.1 + 0.018 * sidx
        for k in range(n):
            a = a0 + (a1 - a0) * (k + 0.5) / n
            for r in (RC - SLAB_T / 2 - rr, RC + SLAB_T / 2 + rr):
                roller(mb, arc_pt(a, r), rr, 1.9)
        mid = (a0 + a1) / 2
        out.append((mb, dict(pivot=tuple(arc_pt(mid)),
                             props={"loom_part": f"caster_rollers_{sidx + 1}", "loom_parent": "",
                                    "loom_motion": "roller spin = scroll TEXCOORD_0.v (circumference); rollers axis along glTF -Z"})))
    return out


def frames(ctx):
    mb = MB("caster_frames")
    bounds = [0.0, 0.3, 0.62, 0.95, 1.25, math.pi / 2]
    for sidx in range(5):
        a0, a1 = bounds[sidx], bounds[sidx + 1]
        for sy in (-1, 1):
            y = Y0 + sy * 1.25
            # heavy side plate following the arc (ribbon thickness 0.12)
            pts_in = [arc_pt(a, RC - 0.75) for a in np.linspace(a0 + 0.01, a1 - 0.01, 8)]
            pts_out = [arc_pt(a, RC + 0.75) for a in np.linspace(a0 + 0.01, a1 - 0.01, 8)]
            P = [(p[0], p[2]) for p in pts_in] + [(p[0], p[2]) for p in pts_out[::-1]]
            Rm = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)
            prism(mb, P, 0.12, Xf(Rm, (0, y + 0.06, 0)), "steel_painted_blue")
            # clamping cylinders across the segment
            for a in np.linspace(a0 + 0.05, a1 - 0.05, 2):
                p0 = arc_pt(a, RC - 0.9)
                p1 = arc_pt(a, RC + 0.9)
                cyl(mb, p0 + v3(0, sy * 1.45, 0), p1 + v3(0, sy * 1.45, 0), 0.13, "steel_painted_yellow", seg=12)
                cyl(mb, p0 + v3(0, sy * 1.45, 0), p0 + v3(0, sy * 1.45, 0) + (p1 - p0) * 0.3, 0.17, "steel_painted_yellow", seg=12)
        # spray headers along the inside + outside radius
        for r in (RC - 0.55, RC + 0.55):
            pts = [arc_pt(a, r) + v3(0, 0.95, 0) for a in np.linspace(a0, a1, 6)]
            sweep(mb, pts, 0.05, "pipe_green", seg=8)
    # support frame (A-frame towers) from the floor to the bow
    for a in (0.45, 1.05):
        p = arc_pt(a, RC + 1.0)
        for sy in (-1, 1):
            ibeam(mb, (p[0] + 0.5, Y0 + sy * 2.0, 0.0), (p[0], Y0 + sy * 1.5, p[2]), 0.5, 0.4, "steel_painted_grey", up=(1, 0, 0))
        beam(mb, (p[0], Y0 - 2.0, p[2]), (p[0], Y0 + 2.0, p[2]), 0.5, 0.5, "steel_painted_grey")
    # withdrawal straightener stands at the bottom of the bow
    for k in range(4):
        x = CX - 0.4 + k * 1.3
        for sy in (-1, 1):
            box_minmax(mb, (x - 0.35, Y0 + sy * 1.4 - 0.25, 0.0), (x + 0.35, Y0 + sy * 1.4 + 0.25, PASS_Z + 1.2), "steel_painted_blue")
        roller(mb, (x, Y0, PASS_Z - SLAB_T / 2 - 0.22), 0.22, 2.2)
        roller(mb, (x, Y0, PASS_Z + SLAB_T / 2 + 0.22), 0.22, 2.2)
        box_minmax(mb, (x - 0.5, Y0 - 1.6, PASS_Z + 1.2), (x + 0.5, Y0 + 1.6, PASS_Z + 1.5), "steel_painted_blue")
        cyl(mb, (x, Y0 + 1.7, PASS_Z + 0.3), (x, Y0 + 2.8, PASS_Z + 0.3), 0.35, "steel_painted_blue", seg=16)
        box(mb, (0.8, 0.9, 0.8), Xf(None, (x, Y0 + 3.3, PASS_Z + 0.3)), "steel_painted_blue")
    return mb


def runout(ctx):
    mb = MB("caster_runout")
    rng = ctx["rng"]
    xs = np.arange(CX + 5.0, RUN_X1, 0.9)
    for x in xs:
        roller(mb, (x, Y0, PASS_Z - SLAB_T / 2 - 0.15), 0.15, 2.0, mat="steel_dark")
    for sy in (-1, 1):
        box_minmax(mb, (xs[0] - 0.5, Y0 + sy * 1.2 - 0.1, 0.0), (RUN_X1, Y0 + sy * 1.2 + 0.1, PASS_Z - 0.15), "steel_painted_grey")
        for x in np.arange(xs[0], RUN_X1, 2.7):
            box_minmax(mb, (x - 0.15, Y0 + sy * 1.2 - 0.3, 0.0), (x + 0.15, Y0 + sy * 1.2 + 0.3, PASS_Z - 0.3), "steel_painted_grey")
    # torch cutting machine: gantry over the strand
    tx = CX + 9.0
    for sy in (-1, 1):
        box_minmax(mb, (tx - 1.5, Y0 + sy * 2.2 - 0.25, 0.0), (tx + 1.5, Y0 + sy * 2.2 + 0.25, 0.25), "steel_worn")
        box_minmax(mb, (tx - 0.4, Y0 + sy * 2.2 - 0.3, 0.25), (tx + 0.4, Y0 + sy * 2.2 + 0.3, PASS_Z + 2.4), "steel_painted_yellow")
    box_minmax(mb, (tx - 0.5, Y0 - 2.5, PASS_Z + 2.4), (tx + 0.5, Y0 + 2.5, PASS_Z + 3.0), "steel_painted_yellow")
    for yy in (-0.5, 0.4):
        box_minmax(mb, (tx - 0.3, Y0 + yy - 0.2, PASS_Z + 0.5), (tx + 0.3, Y0 + yy + 0.2, PASS_Z + 2.4), "steel_dark")
        cyl(mb, (tx, Y0 + yy, PASS_Z + 0.5), (tx, Y0 + yy, PASS_Z + SLAB_T / 2 + 0.08), 0.04, "copper_busbar", seg=8)
    for k in range(3):
        sweep(mb, bezier((tx, Y0 + 2.5, PASS_Z + 2.8), (tx + 0.8, Y0 + 3.5, PASS_Z + 3.4), (tx + 2.0, Y0 + 4.0, 1.5),
                         (tx + 2.5 + k * 0.3, Y0 + 4.2, 0.05), 12), 0.04, ["hose_red", "pipe_green", "cable_rubber"][k], seg=6)
    # scale / slag debris under the runout
    for k in range(40):
        rock(mb, (rng.uniform(CX, RUN_X1), Y0 + rng.uniform(-1.8, 1.8), 0.02), (rng.uniform(0.05, 0.25),) * 2 + (0.05,),
             "slag_cold", rng, seg=5, rings=2)
    return mb, (tx, Y0, PASS_Z + SLAB_T / 2)


def strand(ctx):
    mb = MB("caster_strand")
    prof = [(-SLAB_W / 2, -SLAB_T / 2), (SLAB_W / 2, -SLAB_T / 2), (SLAB_W / 2, SLAB_T / 2), (-SLAB_W / 2, SLAB_T / 2)]
    sweep_profile(mb, strand_path(), prof, "strand_hot", up=(0, 1, 0), uv_len=True)
    # cut slabs further down the runout (cooler, darker)
    for k in range(2):
        x0 = RUN_X1 - 6.0 + k * 3.2
        box_minmax(mb, (x0, Y0 - SLAB_W / 2, PASS_Z - SLAB_T / 2), (x0 + 2.9, Y0 + SLAB_W / 2, PASS_Z + SLAB_T / 2),
                   "strand_hot" if k == 0 else "steel_heat")
    return mb


def build(ctx):
    items = [(floor_platform(ctx), dict(bevel=0.0))]
    tmb, pour = turret(ctx)
    items.append((tmb, dict(pivot=(L.TURRET_XY[0], L.TURRET_XY[1], L.CAST_FLOOR_Z), bevel=0.01,
                            props={"loom_part": "ladle_turret", "loom_parent": "", "loom_motion": "rotate_z (swap ladles, 180 deg)"})))
    items.append((tundish(ctx), dict(bevel=0.01)))
    items.append((mould(ctx), dict(bevel=0.008)))
    items += segments(ctx)
    items.append((frames(ctx), dict(bevel=0.01)))
    rmb, torch = runout(ctx)
    items.append((rmb, dict(bevel=0.008)))
    items.append((strand(ctx), dict(pivot=(X0, Y0, CZ), props={"loom_part": "caster_strand", "loom_parent": "",
                                           "loom_motion": "withdrawal = scroll TEXCOORD_0.u (metres along the strand)"})))
    ctx.setdefault("emitters", {}).update({
        "tundish_pour": (tuple(pour), "ladle_turret"),
        "caster_mould": ((X0, Y0, L.CAST_FLOOR_Z - 0.1), None),
        "caster_torch": (tuple(torch), None),
        "spark_torch": ((torch[0], torch[1], torch[2] - SLAB_T), None),
        "caster_steam": (tuple(arc_pt(0.8, RC)), None),
    })
    return items
