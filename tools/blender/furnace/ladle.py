"""Teeming ladle on a transfer car (parts), car rails, slag pot (part) in the slag pit,
and a spare ladle on a preheating stand (static)."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, frame, rot_z, rot_x, rot_y, box, box_minmax, beam, ibeam, cyl, lathe, disk,
                  torus, sweep, bezier, catenary, hexbolt, bolt_circle, prism, handrail, pipe_run, weld, TAU)
import layout as L

CAR_DECK = 1.15
LADLE_BOT = 1.4
LADLE_H = 4.25
TRUN_Z = LADLE_BOT + LADLE_H * 0.64


def ladle_body(mb, c, rng, hot=True, seed=0.0, lip_dir=(1, 0)):
    """Ladle centred at c=(x,y,bottom z). Returns (trunnion z, lip point)."""
    x, y, z0 = c
    rb, rt = 1.72, 1.98
    H = LADLE_H
    X = Xf(None, (x, y, 0))
    # outer shell (dented), bottom
    lathe(mb, [(0.0, z0), (rb - 0.1, z0), (rb, z0 + 0.1), (rt, z0 + H - 0.05), (rt - 0.05, z0 + H)], X, "steel_heat",
          seg=64, nz=0.03, nfreq=1.0, seed=seed)
    # top rim flange + refractory lining visible at top + molten surface
    lathe(mb, [(rt - 0.05, z0 + H - 0.02), (rt + 0.16, z0 + H - 0.02), (rt + 0.16, z0 + H + 0.1), (rt - 0.35, z0 + H + 0.1)], X,
          "steel_dark", seg=64)
    lathe(mb, [(rt - 0.35, z0 + H + 0.1), (rt - 0.38, z0 + H - 0.6)], X, "refractory" if not hot else "refractory_hot", seg=48)
    if hot:
        lathe(mb, [(rt - 0.38, z0 + H - 0.6), (0.0, z0 + H - 0.6)], X, "molten_steel", seg=48)
        # No slag discs on the melt: flat 10-sided islands floating 5 mm above it read as holes.
        # loom's melt material draws the slag rafts, moving, with glowing cracks.
        for k in range(14):
            rng.uniform(0, TAU), rng.uniform(0.2, rt - 0.7), rng.uniform(0.18, 0.5), rng.uniform(0, 3), rng.uniform(0.5, 1.0), rng.random()
    else:
        lathe(mb, [(rt - 0.38, z0 + H - 0.6), (0.0, z0 + H - 0.6)], X, "slag_cold", seg=32)
    # reinforcing bands + vertical ribs
    for f in (0.12, 0.38, 0.86):
        z = z0 + H * f
        r = rb + (rt - rb) * f
        lathe(mb, [(r, z - 0.12), (r + 0.12, z - 0.1), (r + 0.12, z + 0.1), (r, z + 0.12)], X, "steel_heat", seg=64)
    from mathutils import Vector, noise
    for k in range(24):
        a = k * TAU / 24
        box(mb, (0.12, 0.04, H - 0.4), Xf(rot_z(a) @ rot_y(-0.06), (x + math.cos(a) * (rb + rt) / 2 + math.cos(a) * 0.05,
                                                                    y + math.sin(a) * (rb + rt) / 2 + math.sin(a) * 0.05, z0 + H / 2)), "steel_heat")
        # fillet welds at the rib root, following the dented cone (util.lathe noise: nz 0.03, nfreq 1.0)
        for sd in (-1, 1):
            aw = a + sd * 0.028 / rb
            pts = []
            for zz in np.linspace(z0 + 0.35, z0 + H - 0.35, 7):
                rr = rb + (rt - rb) * (zz - z0 - 0.1) / (H - 0.15)
                px, py = rr * math.cos(aw), rr * math.sin(aw)
                nn = noise.noise(Vector((px + seed, py, zz))) + 0.5 * noise.noise(Vector((px * 2.7, py * 2.7 + seed, zz * 2.7)))
                rr += 0.03 * nn + 0.004
                pts.append(v3(x + rr * math.cos(aw), y + rr * math.sin(aw), zz))
            weld(mb, pts, "steel_heat", r=0.01)
    # trunnion belt + trunnions (axis Y)
    tz = z0 + H * 0.64
    rtz = rb + (rt - rb) * 0.64
    lathe(mb, [(rtz, tz - 0.45), (rtz + 0.18, tz - 0.4), (rtz + 0.18, tz + 0.4), (rtz, tz + 0.45)], X, "steel_dark", seg=64)
    for s in (-1, 1):
        cyl(mb, (x, y + s * (rtz + 0.1), tz), (x, y + s * (rtz + 0.75), tz), 0.34, "steel_worn", seg=24)
        cyl(mb, (x, y + s * (rtz + 0.3), tz), (x, y + s * (rtz + 0.4), tz), 0.55, "steel_dark", seg=24)
        box_minmax(mb, (x - 0.55, y + s * rtz - 0.2, tz - 0.8), (x + 0.55, y + s * rtz + 0.2 * s + 0.0 * s, tz + 0.8), "steel_dark")
    # pouring lip / spout
    lx, ly = lip_dir
    lip = v3(x + lx * (rt + 0.35), y + ly * (rt + 0.35), z0 + H + 0.05)
    beam(mb, v3(x + lx * (rt - 0.2), y + ly * (rt - 0.2), z0 + H - 0.05), lip, 0.7, 0.28, "steel_dark",
         up=(0, 0, 1))
    # tipping lug near the bottom (opposite the lip) + slide gate + gas purge hose
    box(mb, (0.5, 0.6, 0.6), Xf(None, (x - lx * (rb + 0.25), y - ly * (rb + 0.25), z0 + 0.5)), "steel_dark")
    box_minmax(mb, (x + 0.4, y - 0.4, z0 - 0.25), (x + 1.2, y + 0.4, z0 + 0.02), "steel_dark")
    cyl(mb, (x + 0.8, y, z0 - 0.25), (x + 0.8, y, z0 - 0.45), 0.12, "steel_dark", seg=12)
    sweep(mb, bezier((x - 0.9, y + 0.3, z0 - 0.05), (x - 1.6, y + 0.9, z0 + 0.3), (x - rb - 0.2, y + 0.6, z0 + 1.5),
                     (x - rb - 0.1, y + 0.35, tz - 0.5), 12), 0.03, "hose_red", seg=6)
    # slag/steel splashes frozen on the outer shell under the lip
    for k in range(16):
        t = rng.random()
        a = math.atan2(ly, lx) + rng.uniform(-0.35, 0.35)
        zz = z0 + H - 0.1 - t * 1.4
        rr = rb + (rt - rb) * ((zz - z0) / H) + 0.04
        box(mb, (rng.uniform(0.08, 0.2), rng.uniform(0.1, 0.35), rng.uniform(0.2, 0.6)),
            Xf(rot_z(a), (x + math.cos(a) * rr, y + math.sin(a) * rr, zz)), "slag_cold")
    return tz, lip


def rails(ctx):
    mb = MB("ladle_rails")
    x0, x1 = L.CAR_RAILS_X
    rail = [(-0.075, 0), (0.075, 0), (0.075, 0.02), (0.02, 0.04), (0.02, 0.12), (0.04, 0.13), (0.04, 0.17),
            (-0.04, 0.17), (-0.04, 0.13), (-0.02, 0.12), (-0.02, 0.04), (-0.075, 0.02)]
    Rm = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], dtype=float)
    for s in (-1, 1):
        y = L.CAR_RAIL_Y + s * L.CAR_GAUGE / 2
        box_minmax(mb, (x0, y - 0.35, -0.02), (x1, y + 0.35, 0.02), "steel_dark")
        prism(mb, rail, x1 - x0, Xf(Rm, (x0, y, 0.02)), "steel_worn")
        for xx in np.arange(x0 + 0.3, x1, 0.75):
            for sd in (-1, 1):
                box(mb, (0.1, 0.08, 0.04), Xf(None, (xx, y + sd * 0.1, 0.04)), "steel_dark")
    # end stops
    for xx in (x0, x1):
        for s in (-1, 1):
            box(mb, (0.6, 0.6, 0.8), Xf(None, (xx, s * L.CAR_GAUGE / 2, 0.4)), "steel_painted_yellow")
    # cable trench cover between the rails
    box_minmax(mb, (x0, -0.5, -0.01), (x1, 0.5, 0.015), "steel_dark")
    for xx in np.arange(x0, x1, 1.5):
        box_minmax(mb, (xx - 0.01, -0.5, 0.015), (xx + 0.01, 0.5, 0.02), "steel_worn")
    return mb


def car(ctx):
    mb = MB("ladle_car")
    X = L.CAR_X
    g = L.CAR_GAUGE / 2
    # frame
    box_minmax(mb, (X - 2.9, -2.3, 0.75), (X + 2.9, 2.3, CAR_DECK), "steel_painted_grey")
    for s in (-1, 1):
        box_minmax(mb, (X - 3.1, s * g - 0.35, 0.45), (X + 3.1, s * g + 0.35, 1.0), "steel_painted_grey")
        for bx in (-2.2, 2.2):
            cyl(mb, (X + bx, s * g - 0.12, 0.47), (X + bx, s * g + 0.12, 0.47), 0.45, "steel_dark", seg=24)
            cyl(mb, (X + bx, s * g - 0.5, 0.47), (X + bx, s * g + 0.5, 0.47), 0.12, "steel_worn", seg=12)
            box(mb, (0.7, 0.3, 0.3), Xf(None, (X + bx, s * (g + 0.45), 0.5)), "steel_dark")
    # trunnion stands (the ladle sits in them)
    tz = TRUN_Z
    for s in (-1, 1):
        yy = s * 2.72
        box_minmax(mb, (X - 0.7, yy - 0.3, CAR_DECK), (X + 0.7, yy + 0.3, tz - 0.36), "steel_painted_grey")
        box_minmax(mb, (X - 0.8, yy - 0.34, tz - 0.5), (X + 0.8, yy + 0.34, tz - 0.3), "steel_dark")
        for bx in (-0.5, 0.5):
            beam(mb, (X + bx * 3.0, yy * 0.8, CAR_DECK), (X + bx * 0.9, yy, tz - 0.8), 0.22, 0.22, "steel_painted_grey")
    # heat shield + bumpers + hazard stripes + drive + cable reel
    box_minmax(mb, (X + 2.9, -2.2, CAR_DECK), (X + 3.0, 2.2, CAR_DECK + 1.8), "steel_heat")
    for bx in (-3.2, 3.2):
        for s in (-1, 1):
            cyl(mb, (X + bx, s * 1.6, 0.8), (X + bx + math.copysign(0.45, bx), s * 1.6, 0.8), 0.18, "steel_dark", seg=12)
        for k in range(5):
            box(mb, (0.04, 0.35, 0.3), Xf(rot_x(0.7), (X + math.copysign(3.12, bx), -1.6 + k * 0.8, 0.9)), "paint_black")
    box(mb, (1.2, 0.8, 0.7), Xf(None, (X - 2.2, 1.6, CAR_DECK + 0.35)), "steel_painted_blue")
    cyl(mb, (X - 3.4, -1.0, 1.4), (X - 3.4, 1.0, 1.4), 0.9, "steel_painted_yellow", seg=28)
    cyl(mb, (X - 3.4, -0.6, 1.4), (X - 3.4, 0.6, 1.4), 0.95, "cable_rubber", seg=28)
    box_minmax(mb, (X - 3.3, -1.1, 0.5), (X - 2.9, 1.1, 1.9), "steel_painted_grey")
    # spilled/frozen slag on the car deck
    rng = ctx["rng"]
    for k in range(18):
        p = v3(X + rng.uniform(-2.6, 2.6), rng.uniform(-2.0, 2.0), CAR_DECK + 0.03)
        s = rng.uniform(0.1, 0.4)
        box(mb, (s, s * rng.uniform(0.6, 1.4), rng.uniform(0.03, 0.12)), Xf(rot_z(rng.uniform(0, 3)), p), "slag_cold")
    return mb


def ladle(ctx):
    mb = MB("ladle")
    tz, lip = ladle_body(mb, (L.CAR_X, 0.0, LADLE_BOT), ctx["rng"], hot=True, seed=3.3)
    return mb, tz, lip


def slag_pot(ctx):
    rng = ctx["rng"]
    mb = MB("slag_pot")
    x, y, z0 = -8.3, 0.0, 0.55
    H = 2.7
    X = Xf(None, (x, y, 0))
    lathe(mb, [(0.0, z0), (1.15, z0), (1.3, z0 + 0.2), (2.0, z0 + H - 0.1), (2.08, z0 + H), (1.82, z0 + H)], X, "steel_dark",
          seg=48, nz=0.03, seed=9.1)
    for f in (0.25, 0.55, 0.85):
        z = z0 + H * f
        r = 1.3 + 0.7 * f
        lathe(mb, [(r, z - 0.1), (r + 0.14, z - 0.08), (r + 0.14, z + 0.08), (r, z + 0.1)], X, "steel_dark", seg=48)
    lathe(mb, [(1.82, z0 + H), (1.8, z0 + H - 0.35), (0.0, z0 + H - 0.35)], X, "slag_hot", seg=40)
    # trunnions (axis Y) at 75% height
    tz = z0 + H * 0.72
    for s in (-1, 1):
        cyl(mb, (x, s * 1.75, tz), (x, s * 2.25, tz), 0.26, "steel_worn", seg=16)
    # frozen dribbles down the side
    for k in range(22):
        a = rng.uniform(0, TAU)
        t = rng.random()
        zz = z0 + H - 0.05 - t * 1.8
        rr = 1.3 + 0.7 * ((zz - z0) / H) + 0.05
        box(mb, (0.1, rng.uniform(0.12, 0.3), rng.uniform(0.3, 0.9)), Xf(rot_z(a), (x + math.cos(a) * rr, y + math.sin(a) * rr, zz)),
            "slag_cold" if rng.random() < 0.7 else "slag_hot")
    # pot stand (static would be nicer, but it tips with the pot here: kept tiny)
    return mb, (x, y, tz)


def pot_stand(ctx):
    mb = MB("slag_pot_stand")
    x = -8.3
    for s in (-1, 1):
        box_minmax(mb, (x - 0.6, s * 2.0 - 0.3, 0.0), (x + 0.6, s * 2.0 + 0.3, 2.3), "steel_dark")
        box_minmax(mb, (x - 0.7, s * 2.0 - 0.35, 2.3), (x + 0.7, s * 2.0 + 0.35, 2.45), "steel_worn")
    box_minmax(mb, (x - 1.4, -1.4, 0.0), (x + 1.4, 1.4, 0.55), "steel_dark")
    return mb


def spare_ladle(ctx):
    """Cold ladle under a preheater hood at the ladle bay wall."""
    mb = MB("ladle_preheat")
    x, y = 48.5, 11.0
    ladle_body(mb, (x, y, 0.0), ctx["rng"], hot=False, seed=5.5, lip_dir=(-1, 0))
    # preheater: swing arm + lid with burner glowing underneath
    z = LADLE_H + 0.15
    lathe(mb, [(0.0, z + 0.5), (2.3, z + 0.2), (2.3, z), (0.0, z)][::-1], Xf(None, (x, y, 0)), "steel_heat", seg=40)
    lathe(mb, [(2.0, z - 0.02), (0.0, z - 0.02)], Xf(None, (x, y, 0)), "refractory_hot", seg=32)
    cyl(mb, (x, y, z + 0.4), (x, y, z + 1.6), 0.35, "steel_painted_grey", seg=16)
    cyl(mb, (x + 4.2, y + 2.6, 0), (x + 4.2, y + 2.6, z + 2.6), 0.45, "steel_painted_grey", seg=20)
    beam(mb, (x + 4.2, y + 2.6, z + 2.0), (x, y, z + 1.8), 0.5, 0.7, "steel_painted_grey", chamfer=0.04)
    pipe_run(mb, [(x, y, z + 1.6), (x, y, z + 2.4), (x + 4.2, y + 2.6, z + 2.8), (x + 4.2, y + 4.6, z + 2.8),
                  (x + 4.2, y + 4.6, 0.3)], 0.12, "pipe_green", seg=10, flange_every=3.0)
    return mb


def ladle_furnace(ctx):
    """Ladle furnace station (static): hot ladle on its car, water-cooled roof on a lift frame,
    three smaller electrodes on masts, fume duct, alloy chute and wire feeder."""
    rng = ctx["rng"]
    mb = MB("ladle_furnace")
    x, y = 30.0, 9.0
    # car + ladle
    box_minmax(mb, (x - 2.8, y - 2.4, 0.4), (x + 2.8, y + 2.4, 1.1), "steel_painted_grey")
    for sx in (-2.0, 2.0):
        for sy in (-1.8, 1.8):
            cyl(mb, (x + sx - 0.12, y + sy, 0.45), (x + sx + 0.12, y + sy, 0.45), 0.42, "steel_dark", seg=20)
    for sx in (-1, 1):
        box_minmax(mb, (x - 2.9, y + sx * 1.8 - 0.1, -0.02), (x + 2.9, y + sx * 1.8 + 0.1, 0.04), "steel_worn")
    ladle_body(mb, (x, y, 1.35), rng, hot=True, seed=8.8, lip_dir=(0, -1))
    ztop = 1.35 + LADLE_H + 0.1
    # roof (cone of cooling coils) just above the ladle rim, glowing gap
    zr = ztop + 0.35
    lathe(mb, [(2.35, zr), (2.45, zr + 0.3), (0.9, zr + 1.0), (0.0, zr + 1.05)], Xf(None, (x, y, 0)), "steel_dark", seg=48)
    for k in range(9):
        t = (k + 0.5) / 9
        torus(mb, Xf(None, (x, y, zr + 0.35 + 0.65 * t)), 2.35 - 1.4 * t, 0.055, "panel_cooled", seg=40, rseg=5)
    lathe(mb, [(2.0, zr - 0.02), (2.3, zr - 0.02), (2.3, zr + 0.001), (2.0, zr + 0.001)], Xf(None, (x, y, 0)), "refractory_hot", seg=40)
    torus(mb, Xf(None, (x, y, zr + 0.25)), 2.55, 0.1, "pipe_green", seg=40, rseg=6)
    # lift frame (portal) around the roof
    for sx in (-1, 1):
        for sy in (-1, 1):
            ibeam(mb, (x + sx * 3.3, y + sy * 3.0, 0.0), (x + sx * 3.3, y + sy * 3.0, 11.5), 0.5, 0.4, "steel_painted_blue", up=(1, 0, 0))
        ibeam(mb, (x + sx * 3.3, y - 3.2, 11.3), (x + sx * 3.3, y + 3.2, 11.3), 0.6, 0.35, "steel_painted_blue")
        cyl(mb, (x + sx * 2.6, y, zr + 0.4), (x + sx * 2.6, y, 11.0), 0.14, "steel_worn", seg=10)
        cyl(mb, (x + sx * 2.6, y, 9.0), (x + sx * 2.6, y, 11.0), 0.22, "steel_painted_yellow", seg=12)
    for sy in (-1, 1):
        ibeam(mb, (x - 3.5, y + sy * 3.0, 11.3), (x + 3.5, y + sy * 3.0, 11.3), 0.6, 0.35, "steel_painted_blue")
    box_minmax(mb, (x - 2.8, y - 0.35, zr + 0.3), (x + 2.8, y + 0.35, zr + 0.55), "steel_painted_blue")
    # electrodes + arms + masts on +Y
    er = 0.225
    for k in range(3):
        a = math.radians(90 + 120 * k)
        ex, ey = x + 0.45 * math.cos(a), y + 0.45 * math.sin(a)
        mx = x - 1.5 + k * 1.5
        my = y + 4.8
        lathe(mb, [(0.0, ztop - 0.3), (er * 0.8, ztop - 0.25), (er, zr + 1.0)], Xf(None, (ex, ey, 0)), "graphite_hot", seg=16)
        cyl(mb, (ex, ey, zr + 1.0), (ex, ey, 10.4), er, "graphite", seg=16)
        cyl(mb, (ex, ey, 8.2), (ex, ey, 9.0), er + 0.18, "copper_busbar", seg=16)
        beam(mb, (mx, my, 8.6), (ex, ey, 8.6), 0.4, 0.55, "copper_busbar", chamfer=0.04)
        box_minmax(mb, (mx - 0.3, my - 0.3, 0.0), (mx + 0.3, my + 0.3, 8.3), "steel_painted_grey")
        for q in range(2):
            sweep(mb, catenary((mx + (q - 0.5) * 0.3, my + 0.4, 8.6), (mx + (q - 0.5) * 0.3, L.HY - 1.0, 7.5), 2.2, 14), 0.06,
                  "cable_rubber", seg=8)
    # fume duct off the roof
    sweep(mb, [(x + 1.2, y - 1.0, zr + 1.0), (x + 1.2, y - 1.0, 9.0), (x + 1.2, y - 5.0, 9.0), (x + 1.2, y - 5.0, 21.5)],
          0.55, "steel_heat", seg=20, bend=1.0, caps=False)
    # wire feeder + alloy chute
    box_minmax(mb, (x - 4.8, y - 1.0, 0.0), (x - 3.8, y + 1.0, 1.6), "steel_painted_blue")
    for q in range(3):
        sweep(mb, bezier((x - 3.8, y - 0.4 + q * 0.4, 1.3), (x - 2.5, y - 0.4 + q * 0.4, 4.0), (x - 1.2, y, 7.6),
                         (x - 0.8, y - 0.3 + q * 0.3, zr + 1.0), 10), 0.03, "steel_worn", seg=6)
    sweep(mb, [(x - 0.9, y + 0.9, 11.0), (x - 0.9, y + 0.9, zr + 1.2)], 0.18, "steel_worn", seg=10)
    return mb


def build(ctx):
    items = [rails(ctx)]
    items.append((car(ctx), dict(pivot=(L.CAR_X, 0.0, 0.0),
                                 props={"loom_part": "ladle_car", "loom_parent": "", "loom_motion": "translate_x (rail travel, x 4.9..34)"})))
    lmb, tz, lip = ladle(ctx)
    items.append((lmb, dict(pivot=(L.CAR_X, 0.0, tz), parent="ladle_car",
                            props={"loom_part": "ladle", "loom_parent": "ladle_car",
                                   "loom_motion": "rotate_y about the trunnions (pour; + tips the lip at +X down)"})))
    smb, piv = slag_pot(ctx)
    items.append((smb, dict(pivot=piv,
                            props={"loom_part": "slag_pot", "loom_parent": "", "loom_motion": "rotate_y about the trunnions (dump)"})))
    items.append(pot_stand(ctx))
    items.append((spare_ladle(ctx), dict()))
    items.append((ladle_furnace(ctx), dict()))
    ctx.setdefault("emitters", {}).update({
        "ladle_lip": (tuple(lip), "ladle"),
        "ladle_surface": ((L.CAR_X, 0.0, LADLE_BOT + LADLE_H - 0.55), "ladle"),
        "slag_pot_surface": ((-8.3, 0.0, 0.55 + 2.7 - 0.3), "slag_pot"),
    })
    return items
