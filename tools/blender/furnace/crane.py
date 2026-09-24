"""Overhead charging crane: bridge (part), trolley (part), rope falls (part, scaled),
hook block (part), clamshell scrap bucket (part) with two jaws (parts)."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, frame, rot_z, rot_x, rot_y, box, box_minmax, beam, ibeam, cyl, lathe, disk,
                  torus, sweep, hexbolt, bolt_circle, prism, handrail, strip_bars, TAU)
import layout as L

GIRDER_DX = 2.7           # girders at CRANE_X +/- GIRDER_DX
G_TOP = 26.5              # girder top / trolley rail base
T_RAIL = G_TOP + 0.15


def fishbelly_girder(mb, x, rng):
    """Box girder spanning Y, deep at midspan, shallow over the end trucks."""
    ys = np.linspace(-L.RAIL_Y - 0.6, L.RAIL_Y + 0.6, 25)
    w = 1.05
    bots = []
    for y in ys:
        t = abs(y) / (L.RAIL_Y + 0.6)
        depth = 1.5 if t > 0.86 else 1.5 + (2.9 - 1.5) * min(1.0, (0.86 - t) / 0.3)
        bots.append(G_TOP - depth)
    # side plates as two ribbons + top/bottom flanges
    for sx in (-w / 2, w / 2):
        V = []
        for y, zb in zip(ys, bots):
            V.append((x + sx, y, zb))
            V.append((x + sx, y, G_TOP))
        V = np.array(V)
        n = len(ys)
        F = [[2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1] if sx > 0 else [2 * i + 1, 2 * i + 3, 2 * i + 2, 2 * i]
             for i in range(n - 1)]
        mb.add(V, F, "steel_painted_yellow")
    box_minmax(mb, (x - w / 2 - 0.08, ys[0], G_TOP - 0.04), (x + w / 2 + 0.08, ys[-1], G_TOP + 0.04), "steel_painted_yellow")
    for k in range(len(ys) - 1):
        beam(mb, (x, ys[k], bots[k] + 0.02), (x, ys[k + 1], bots[k + 1] + 0.02), w + 0.12, 0.04, "steel_painted_yellow",
             up=(0, 0, 1), caps=False)
    # outside stiffener ribs (diaphragm lines) + splice plates
    for k in range(1, len(ys) - 1):
        for sx in (-1, 1):
            box_minmax(mb, (x + sx * (w / 2) - 0.02, ys[k] - 0.02, bots[k] + 0.05), (x + sx * (w / 2) + 0.02, ys[k] + 0.02, G_TOP - 0.05),
                       "steel_painted_yellow")
    for y in (-5.0, 5.0):
        for sx in (-1, 1):
            box_minmax(mb, (x + sx * (w / 2 + 0.01) - 0.015, y - 0.4, G_TOP - 2.6), (x + sx * (w / 2 + 0.01) + 0.015, y + 0.4, G_TOP - 0.1),
                       "steel_painted_yellow")
            for zz in np.arange(G_TOP - 2.4, G_TOP - 0.2, 0.3):
                for yy in (y - 0.3, y - 0.1, y + 0.1, y + 0.3):
                    hexbolt(mb, (x + sx * (w / 2 + 0.025), yy, zz), (sx, 0, 0), 0.025, "steel_dark", h=0.02)
    # trolley rail on top
    beam(mb, (x, ys[0] + 0.3, G_TOP + 0.075), (x, ys[-1] - 0.3, G_TOP + 0.075), 0.12, 0.15, "steel_worn")
    for y in np.arange(ys[0] + 0.5, ys[-1], 0.7):
        for sx in (-1, 1):
            box(mb, (0.08, 0.1, 0.04), Xf(None, (x + sx * 0.11, y, G_TOP + 0.06)), "steel_dark")


def bridge(ctx, X=L.CRANE_X, name="crane_bridge"):
    rng = ctx["rng"]
    mb = MB(name)
    for sx in (-1, 1):
        fishbelly_girder(mb, X + sx * GIRDER_DX, rng)
    # end trucks (saddles) on the runway rails with wheel bogies + buffers
    for sy in (-1, 1):
        y = sy * L.RAIL_Y
        box_minmax(mb, (X - 5.4, y - 0.55, L.RAIL_Z + 0.55), (X + 5.4, y + 0.55, L.RAIL_Z + 1.55), "steel_painted_yellow")
        box_minmax(mb, (X - 5.5, y - 0.6, L.RAIL_Z + 1.5), (X + 5.5, y + 0.6, L.RAIL_Z + 1.6), "steel_painted_yellow")
        for bx in (-4.0, -2.6, 2.6, 4.0):
            cyl(mb, (X + bx, y - 0.38, L.RAIL_Z + 0.45), (X + bx, y + 0.38, L.RAIL_Z + 0.45), 0.44, "steel_dark", seg=24)
            cyl(mb, (X + bx, y - 0.62, L.RAIL_Z + 0.45), (X + bx, y + 0.62, L.RAIL_Z + 0.45), 0.13, "steel_worn", seg=12)
            box(mb, (0.9, 0.3, 0.5), Xf(None, (X + bx, y + sy * 0.75, L.RAIL_Z + 0.6)), "steel_dark")
        for bx in (-5.6, 5.6):
            cyl(mb, (X + bx, y, L.RAIL_Z + 0.95), (X + bx + math.copysign(0.7, bx), y, L.RAIL_Z + 0.95), 0.25, "steel_dark", seg=16)
            cyl(mb, (X + bx + math.copysign(0.7, bx), y, L.RAIL_Z + 0.95), (X + bx + math.copysign(0.85, bx), y, L.RAIL_Z + 0.95),
                0.32, "rubber_belt", seg=16)
        # long-travel drive units (motor + gearbox) on the inner side
        for bx in (-3.3, 3.3):
            box(mb, (0.9, 0.7, 0.8), Xf(None, (X + bx, y - sy * 0.95, L.RAIL_Z + 1.1)), "steel_painted_blue")
            cyl(mb, (X + bx, y - sy * 1.3, L.RAIL_Z + 1.2), (X + bx, y - sy * 2.2, L.RAIL_Z + 1.2), 0.3, "steel_painted_blue", seg=16)
        # hazard stripes on the buffers ends
        for bx in (-5.45, 5.45):
            for k in range(4):
                box(mb, (0.03, 1.2, 0.18), Xf(rot_x(0.6), (X + bx + math.copysign(0.03, bx), y, L.RAIL_Z + 0.75 + k * 0.23)),
                    "paint_black")
    # end ties / diagonal bracing between girders near the trucks
    for sy in (-1, 1):
        for yy in (sy * (L.RAIL_Y - 1.4), sy * (L.RAIL_Y - 4.0)):
            beam(mb, (X - GIRDER_DX + 0.5, yy, G_TOP - 0.7), (X + GIRDER_DX - 0.5, yy, G_TOP - 0.7), 0.35, 0.8, "steel_painted_yellow")
        beam(mb, (X - GIRDER_DX + 0.5, sy * (L.RAIL_Y - 1.4), G_TOP - 0.7), (X + GIRDER_DX - 0.5, sy * (L.RAIL_Y - 4.0), G_TOP - 0.7),
             0.2, 0.3, "steel_painted_yellow")
    # walkways outboard of both girders
    for sx in (-1, 1):
        xw = X + sx * (GIRDER_DX + 1.25)
        strip_bars(mb, (xw, -L.RAIL_Y + 1.0, G_TOP - 1.3), (xw, L.RAIL_Y - 1.0, G_TOP - 1.3), (1, 0, 0), 1.4, G_TOP - 1.3,
                   "grating", pitch=0.05)
        handrail(mb, [(xw + sx * 0.7, -L.RAIL_Y + 1.0, G_TOP - 1.3), (xw + sx * 0.7, L.RAIL_Y - 1.0, G_TOP - 1.3)],
                 mat="steel_painted_yellow", post=1.8)
        for y in np.arange(-L.RAIL_Y + 1.5, L.RAIL_Y - 1.0, 2.4):
            beam(mb, (X + sx * (GIRDER_DX + 0.5), y, G_TOP - 1.36), (xw + sx * 0.7, y, G_TOP - 1.36), 0.12, 0.16, "steel_painted_yellow")
            beam(mb, (X + sx * (GIRDER_DX + 0.5), y, G_TOP - 0.3), (xw + sx * 0.7, y, G_TOP - 1.36), 0.08, 0.08, "steel_painted_yellow")
        # control panels / resistor cabinets along the walkway
        for y in (-9.0, -6.5, 7.0):
            box(mb, (0.7, 1.8, 1.9), Xf(None, (xw, y, G_TOP - 1.3 + 0.95)), "steel_painted_grey")
            for k in range(6):
                box(mb, (0.72, 1.5, 0.02), Xf(None, (xw, y, G_TOP - 1.3 + 0.35 + k * 0.25)), "steel_dark")
    # operator cab under the -Y end of a girder
    cx, cy, cz = X + GIRDER_DX, -L.RAIL_Y + 3.4, G_TOP - 4.4
    box_minmax(mb, (cx - 1.1, cy - 1.3, cz), (cx + 1.1, cy + 1.3, cz + 2.4), "steel_painted_yellow")
    box_minmax(mb, (cx - 1.12, cy - 1.0, cz + 0.9), (cx + 1.12, cy + 1.0, cz + 2.1), "glass_pulpit")
    box_minmax(mb, (cx - 0.8, cy - 1.32, cz + 0.9), (cx + 0.8, cy + 1.32, cz + 2.1), "glass_pulpit")
    for yy in (cy - 0.33, cy + 0.33):
        box(mb, (2.26, 0.06, 1.2), Xf(None, (cx, yy, cz + 1.5)), "steel_painted_yellow")
    for k in range(4):
        cyl(mb, (cx + (-0.9 if k < 2 else 0.9), cy + (-1.1 if k % 2 else 1.1), cz + 2.4),
            (cx + (-0.4 if k < 2 else 0.4), cy + (-1.1 if k % 2 else 1.1), G_TOP - 1.4), 0.07, "steel_painted_yellow", seg=8)
    box(mb, (1.6, 0.9, 0.7), Xf(None, (cx, cy, cz + 2.75)), "steel_painted_grey")
    return mb


def trolley(ctx, X=L.CRANE_X, Y=L.TROLLEY_Y, name="crane_trolley"):
    mb = MB(name)
    z0 = T_RAIL + 0.3
    # frame: two side girders over the bridge rails + cross girders
    for sx in (-1, 1):
        box_minmax(mb, (X + sx * GIRDER_DX - 0.35, Y - 3.0, z0), (X + sx * GIRDER_DX + 0.35, Y + 3.0, z0 + 0.8), "steel_painted_yellow")
        for sy in (-2.3, 2.3):
            cyl(mb, (X + sx * GIRDER_DX - 0.3, Y + sy, T_RAIL + 0.32), (X + sx * GIRDER_DX + 0.3, Y + sy, T_RAIL + 0.32), 0.32,
                "steel_dark", seg=20)
    for sy in (-2.8, -0.9, 0.9, 2.8):
        box_minmax(mb, (X - GIRDER_DX, Y + sy - 0.3, z0 + 0.05), (X + GIRDER_DX, Y + sy + 0.3, z0 + 0.75), "steel_painted_yellow")
    box_minmax(mb, (X - GIRDER_DX - 0.3, Y - 3.0, z0 + 0.8), (X + GIRDER_DX + 0.3, Y + 3.0, z0 + 0.84), "steel_dark")
    # main hoist: two grooved drums (axes along X), gearbox, motors, brakes
    for sy in (-1.6, 1.6):
        dc = v3(X, Y + sy, z0 + 1.5)
        cyl(mb, dc - v3(1.6, 0, 0), dc + v3(1.6, 0, 0), 0.72, "steel_dark", seg=32)
        for k in range(28):
            xx = -1.5 + k * 3.0 / 27
            torus(mb, Xf(frame(v3(1, 0, 0)), dc + v3(xx, 0, 0)), 0.74, 0.028, "steel_worn", seg=24, rseg=4)
        for xx in (-1.75, 1.75):
            cyl(mb, dc + v3(xx - 0.12, 0, 0), dc + v3(xx + 0.12, 0, 0), 0.8, "steel_painted_yellow", seg=32)
            box_minmax(mb, (X + xx - 0.2, Y + sy - 0.5, z0 + 0.84), (X + xx + 0.2, Y + sy + 0.5, z0 + 1.7), "steel_painted_yellow")
    box_minmax(mb, (X + 1.95, Y - 1.1, z0 + 0.84), (X + 3.0, Y + 1.1, z0 + 2.3), "steel_painted_blue")
    for sy in (-0.7, 0.7):
        cyl(mb, (X + 3.0, Y + sy, z0 + 1.6), (X + 4.3, Y + sy, z0 + 1.6), 0.42, "steel_painted_blue", seg=20)
        for k in range(10):
            box(mb, (1.1, 0.02, 0.92), Xf(rot_x(k * math.pi / 10), (X + 3.65, Y + sy, z0 + 1.6)), "steel_painted_blue")
        cyl(mb, (X + 4.3, Y + sy, z0 + 1.6), (X + 4.6, Y + sy, z0 + 1.6), 0.36, "steel_painted_grey", seg=20)
    # aux hoist
    cyl(mb, (X - 2.1, Y - 2.6, z0 + 1.2), (X - 0.9, Y - 2.6, z0 + 1.2), 0.35, "steel_dark", seg=20)
    box(mb, (0.8, 0.7, 0.8), Xf(None, (X - 2.6, Y - 2.6, z0 + 1.25)), "steel_painted_blue")
    # handrail round the trolley deck
    handrail(mb, [(X - GIRDER_DX - 0.3, Y - 3.0, z0 + 0.84), (X + GIRDER_DX + 0.3, Y - 3.0, z0 + 0.84),
                  (X + GIRDER_DX + 0.3, Y + 3.0, z0 + 0.84), (X - GIRDER_DX - 0.3, Y + 3.0, z0 + 0.84),
                  (X - GIRDER_DX - 0.3, Y - 3.0, z0 + 0.84)], mat="steel_painted_yellow", h=1.0, post=1.5)
    # equalizer sheaves under the frame
    for sy in (-0.5, 0.5):
        cyl(mb, (X - 0.15, Y + sy, z0 - 0.1), (X + 0.15, Y + sy, z0 - 0.1), 0.5, "steel_dark", seg=24)
    return mb


def ropes(ctx, X=L.CRANE_X, Y=L.TROLLEY_Y, Z=L.HOOK_Z, name="crane_ropes"):
    mb = MB(name)
    top = T_RAIL + 0.3 + 1.5
    hb = Z + 1.2
    for sy in (-1, 1):
        for k in range(4):
            xd = -1.2 + k * 0.8
            xs = -0.66 + k * 0.44
            cyl(mb, (X + xd, Y + sy * 0.88, top), (X + xs, Y + sy * 0.6, hb), 0.03, "steel_worn", seg=6, caps=False)
    return mb


def hook(ctx, X=L.CRANE_X, Y=L.TROLLEY_Y, Z=L.HOOK_Z, name="crane_hook"):
    mb = MB(name)
    # sheave block
    box_minmax(mb, (X - 1.1, Y - 0.55, Z + 0.4), (X + 1.1, Y + 0.55, Z + 1.35), "steel_painted_yellow")
    for k in range(4):
        xx = -0.66 + k * 0.44
        cyl(mb, (X + xx - 0.09, Y, Z + 1.2), (X + xx + 0.09, Y, Z + 1.2), 0.62, "steel_dark", seg=24)
    for sx in (-1, 1):
        box_minmax(mb, (X + sx * 1.1 - 0.06, Y - 0.62, Z + 0.3), (X + sx * 1.1 + 0.06, Y + 0.62, Z + 1.9), "steel_painted_yellow")
        cyl(mb, (X + sx * 1.18, Y, Z + 1.2), (X + sx * 1.26, Y, Z + 1.2), 0.18, "steel_dark", seg=16)
    # hazard stripes
    for k in range(6):
        box(mb, (0.16, 1.12, 0.05), Xf(rot_y(0.7), (X - 0.9 + k * 0.36, Y, Z + 0.95)), "paint_black")
    # crosshead + laminated hook (C shape)
    box_minmax(mb, (X - 0.7, Y - 0.35, Z + 0.1), (X + 0.7, Y + 0.35, Z + 0.4), "steel_dark")
    cyl(mb, (X, Y, Z + 0.1), (X, Y, Z - 0.4), 0.2, "steel_worn", seg=16)
    c = (X, Y, Z - 1.05)
    pts = [(X, Y, Z - 0.4), (X - 0.4, Y, Z - 0.8)] + \
          [(c[0] + 0.5 * math.cos(t), Y, c[2] + 0.5 * math.sin(t)) for t in np.linspace(math.pi, 2 * math.pi + 0.8, 14)]
    sweep(mb, pts, 0.17, "steel_dark", seg=10, caps=True)
    # the bucket bail pin rests in the hook
    return mb


def bucket(ctx):
    rng = ctx["rng"]
    X, Y = L.CRANE_X, L.TROLLEY_Y
    pin = v3(X, Y, L.HOOK_Z - 1.45)
    top = pin[2] - 1.3
    zb = top - 4.0
    r = 2.35
    mb = MB("scrap_bucket")
    # shell with dents, heavy rings, vertical ribs
    lathe(mb, [(r - 0.08, zb + 0.2), (r, zb + 0.2), (r, top), (r - 0.08, top)], Xf(None, (X, Y, 0)), "steel_dark",
          seg=64, nz=0.04, nfreq=0.9, seed=4.2)
    for z in (zb + 0.25, zb + 1.6, zb + 3.0, top - 0.1):
        torus(mb, Xf(None, (X, Y, z)), r + 0.05, 0.11, "steel_dark", seg=64, rseg=6)
    for k in range(20):
        a = k * TAU / 20
        box(mb, (0.24, 0.06, top - zb - 0.4), Xf(rot_z(a), (X + math.cos(a) * (r + 0.1), Y + math.sin(a) * (r + 0.1), (top + zb) / 2 + 0.1)),
            "steel_dark")
    # trunnion bosses + bail (U yoke over the top to the hook pin)
    for sy in (-1, 1):
        c = v3(X, Y + sy * (r + 0.1), top - 1.4)
        cyl(mb, c, c + v3(0, sy * 0.35, 0), 0.32, "steel_worn", seg=20)
        beam(mb, c + v3(0, sy * 0.3, 0), pin + v3(0, sy * 0.6, 0), 0.3, 0.42, "steel_dark", up=(1, 0, 0))
        box(mb, (0.5, 0.2, 0.5), Xf(None, c + v3(0, sy * 0.4, 0)), "steel_dark")
    cyl(mb, pin - v3(0, 0.7, 0), pin + v3(0, 0.7, 0), 0.16, "steel_worn", seg=16)
    # heaped scrap on top (plates, beams, bent bars) - sticks out of the rim
    for k in range(70):
        a = rng.uniform(0, TAU)
        rr = math.sqrt(rng.random()) * (r - 0.35)
        p = v3(X + math.cos(a) * rr, Y + math.sin(a) * rr, top - 0.3 + rng.uniform(0, 0.9) * (1 - rr / r))
        R = rot_z(rng.uniform(0, TAU)) @ rot_x(rng.uniform(-1.2, 1.2)) @ rot_y(rng.uniform(-0.8, 0.8))
        kind = rng.random()
        if kind < 0.45:
            box(mb, (rng.uniform(0.3, 1.2), rng.uniform(0.2, 0.8), 0.03), Xf(R, p), "scrap_mix")
        elif kind < 0.75:
            ibeam(mb, p - R[:, 0] * 0.7, p + R[:, 0] * 0.7, 0.2, 0.12, "rust", up=R[:, 2])
        else:
            cyl(mb, p - R[:, 0] * 0.6, p + R[:, 0] * 0.6, rng.uniform(0.03, 0.15), "scrap_mix", seg=8)
    return mb, zb, r, pin


def jaws(ctx, zb, r):
    X, Y = L.CRANE_X, L.TROLLEY_Y
    out = []
    for j, sx in enumerate((1, -1)):
        mb = MB(f"scrap_bucket_jaw_{j + 1}")
        # half-dome bottom (arc lathe) split by the plane x = X
        arc = (-math.pi / 2, math.pi / 2) if sx > 0 else (math.pi / 2, 3 * math.pi / 2)
        prof = [(0.0, zb - 1.05), (0.9, zb - 0.95), (1.7, zb - 0.62), (2.2, zb - 0.15), (r, zb + 0.2)]
        lathe(mb, prof, Xf(None, (X, Y, 0)), "steel_dark", seg=24, arc=arc, nz=0.03, seed=7.0 + j)
        # split-plane closing plate + lip
        box_minmax(mb, (X + sx * 0.04 - 0.04, Y - r, zb - 1.05), (X + sx * 0.04 + 0.04, Y + r, zb + 0.2), "steel_dark")
        for yy in np.linspace(-1.8, 1.8, 5):
            box(mb, (0.08, 0.06, 0.9), Xf(rot_y(sx * 0.5), (X + sx * 1.3, Y + yy, zb - 0.55)), "steel_dark")
        # hinge lugs at the rim
        hinge = v3(X + sx * (r - 0.1), Y, zb + 0.2)
        for yy in (-1.2, 1.2):
            cyl(mb, hinge + v3(0, yy - 0.2, 0), hinge + v3(0, yy + 0.2, 0), 0.16, "steel_worn", seg=12)
        out.append((mb, dict(pivot=tuple(hinge), parent="scrap_bucket", bevel=0.008,
                             props={"loom_part": f"scrap_bucket_jaw_{j + 1}", "loom_parent": "scrap_bucket",
                                    "loom_motion": "rotate_y about the hinge (opens %s)" % ("+x outward" if sx > 0 else "-x outward")})))
    return out


def lifting_beam(ctx, X, Y, Z):
    """Ladle-crane hook block with a lifting beam and two laminated C-hooks (spread for trunnions)."""
    mb = hook(ctx, X, Y, Z, "crane2_hook")
    box_minmax(mb, (X - 0.5, Y - 3.2, Z - 1.5), (X + 0.5, Y + 3.2, Z - 0.6), "steel_painted_yellow")
    for k in range(9):
        box(mb, (0.03, 0.3, 0.8), Xf(None, (X + 0.52, Y - 3.0 + k * 0.75, Z - 1.05)), "paint_black" if k % 2 else "steel_painted_yellow")
    for sy in (-1, 1):
        y = Y + sy * 2.9
        box_minmax(mb, (X - 0.35, y - 0.18, Z - 4.0), (X + 0.35, y + 0.18, Z - 1.5), "steel_dark")
        # C-hook jaw opening inward
        pts = [(X, y, Z - 3.9), (X, y - sy * 0.55, Z - 4.3), (X, y - sy * 0.9, Z - 3.9), (X, y - sy * 0.9, Z - 3.5)]
        sweep(mb, pts, 0.16, "steel_dark", seg=8, bend=0.25, caps=True)
        for zz in np.arange(Z - 3.8, Z - 1.6, 0.35):
            hexbolt(mb, (X + 0.35, y, zz), (1, 0, 0), 0.04, "steel_worn")
    return mb


def build(ctx):
    X, Y = L.CRANE_X, L.TROLLEY_Y
    items = [
        (bridge(ctx), dict(pivot=(X, 0.0, L.RAIL_Z), bevel=0.012,
                           props={"loom_part": "crane_bridge", "loom_parent": "", "loom_motion": "translate_x (runway travel)"})),
        (trolley(ctx), dict(pivot=(X, Y, T_RAIL), parent="crane_bridge", bevel=0.01,
                            props={"loom_part": "crane_trolley", "loom_parent": "crane_bridge",
                                   "loom_motion": "translate_y (along the bridge)"})),
        (ropes(ctx), dict(pivot=(X, Y, T_RAIL + 1.8), parent="crane_trolley",
                          props={"loom_part": "crane_ropes", "loom_parent": "crane_trolley",
                                 "loom_motion": "scale_z about the pivot so the lower ends follow crane_hook"})),
        (hook(ctx), dict(pivot=(X, Y, L.HOOK_Z), parent="crane_trolley", bevel=0.01,
                         props={"loom_part": "crane_hook", "loom_parent": "crane_trolley", "loom_motion": "translate_z (hoist)"})),
    ]
    bmb, zb, r, pin = bucket(ctx)
    items.append((bmb, dict(pivot=tuple(pin), parent="crane_hook", bevel=0.01,
                            props={"loom_part": "scrap_bucket", "loom_parent": "crane_hook",
                                   "loom_motion": "rotate_x/rotate_y small swing about the bail pin"})))
    items += jaws(ctx, zb, r)
    # second (ladle) crane parked over the ladle bay, carrying a ladle lifting beam
    X2, Y2, Z2 = 27.0, 2.5, 19.5
    items += [
        (bridge(ctx, X2, "crane2_bridge"), dict(pivot=(X2, 0.0, L.RAIL_Z), bevel=0.012,
                                               props={"loom_part": "crane2_bridge", "loom_parent": "", "loom_motion": "translate_x"})),
        (trolley(ctx, X2, Y2, "crane2_trolley"), dict(pivot=(X2, Y2, T_RAIL), parent="crane2_bridge", bevel=0.01,
                                                      props={"loom_part": "crane2_trolley", "loom_parent": "crane2_bridge",
                                                             "loom_motion": "translate_y"})),
        (ropes(ctx, X2, Y2, Z2, "crane2_ropes"), dict(pivot=(X2, Y2, T_RAIL + 1.8), parent="crane2_trolley",
                                                      props={"loom_part": "crane2_ropes", "loom_parent": "crane2_trolley",
                                                             "loom_motion": "scale_z about the pivot so the lower ends follow crane2_hook"})),
        (lifting_beam(ctx, X2, Y2, Z2), dict(pivot=(X2, Y2, Z2), parent="crane2_trolley", bevel=0.01,
                                             props={"loom_part": "crane2_hook", "loom_parent": "crane2_trolley",
                                                    "loom_motion": "translate_z (hoist)"})),
    ]
    ctx.setdefault("emitters", {}).update({
        "scrap_bucket_drop": ((X, Y, zb - 1.0), "scrap_bucket"),
    })
    return items
