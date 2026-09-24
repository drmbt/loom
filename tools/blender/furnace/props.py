"""Clutter that sells scale and use: scrap piles in the scrap bay, a parked scrap bucket,
spare electrode racks, gas bottle cages, drums, floor slag crust, floor markings,
column floodlights, spare roof/ladle parts."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, rot_z, rot_x, rot_y, box, box_minmax, beam, ibeam, cyl, lathe, disk, torus,
                  sweep, rock, lump, handrail, bezier, profile_beam, angle_prof, channel_prof, TAU)
import layout as L


def scrap_pile(mb, c, radius, height, n, rng):
    cx, cy = c
    for k in range(n):
        a = rng.uniform(0, TAU)
        rr = radius * math.sqrt(rng.random())
        h = height * (1 - (rr / radius) ** 1.6) * rng.uniform(0.6, 1.0)
        p = v3(cx + rr * math.cos(a), cy + rr * math.sin(a), max(0.05, h))
        R = rot_z(rng.uniform(0, TAU)) @ rot_x(rng.uniform(-1.3, 1.3)) @ rot_y(rng.uniform(-1.0, 1.0))
        kind = rng.random()
        if kind < 0.35:
            box(mb, (rng.uniform(0.4, 1.8), rng.uniform(0.3, 1.2), rng.uniform(0.01, 0.04)), Xf(R, p), "scrap_mix")
        elif kind < 0.55:
            L_ = rng.uniform(0.8, 3.2)
            h = rng.uniform(0.12, 0.35)
            b = rng.uniform(0.08, 0.2)
            # section mix (angles, channels, I-beams) picked from L_ so the seeded stream is unchanged
            v = (L_ * 7.31) % 1.0
            p0, p1 = p - R[:, 0] * L_ / 2, p + R[:, 0] * L_ / 2
            if v < 0.4:
                profile_beam(mb, angle_prof(b, 0.012), p0, p1, "rust", up=R[:, 2])
            elif v < 0.7:
                profile_beam(mb, channel_prof(h, b * 0.6, 0.008, 0.012), p0, p1, "rust", up=R[:, 2])
            else:
                ibeam(mb, p0, p1, h, b, "rust", up=R[:, 2])
        elif kind < 0.7:
            L_ = rng.uniform(0.6, 2.5)
            cyl(mb, p - R[:, 0] * L_ / 2, p + R[:, 0] * L_ / 2, rng.uniform(0.03, 0.2), "scrap_mix", seg=8)
        elif kind < 0.82:
            L_ = rng.uniform(1.0, 2.5)
            sweep(mb, bezier(p, p + R[:, 0] * L_ * 0.3 + R[:, 2] * 0.4, p + R[:, 0] * L_ * 0.7 - R[:, 1] * 0.5,
                             p + R[:, 0] * L_, 6), rng.uniform(0.015, 0.04), "rust", seg=5)
        else:
            s = rng.uniform(0.15, 0.6)
            rock(mb, p, (s, s * rng.uniform(0.6, 1.2), s * rng.uniform(0.4, 0.9)), "scrap_mix", rng, seg=6, rings=3, rough=0.4)


def parked_bucket(mb, c, rng):
    x, y = c
    r = 2.35
    lathe(mb, [(r - 0.08, 1.2), (r, 1.2), (r, 5.2), (r - 0.08, 5.2)], Xf(None, (x, y, 0)), "steel_dark", seg=48, nz=0.04, seed=12)
    lathe(mb, [(0.0, 0.2), (1.6, 0.35), (r, 1.2)], Xf(None, (x, y, 0)), "steel_dark", seg=48, nz=0.03, seed=13)
    for z in (1.3, 2.6, 4.0, 5.1):
        torus(mb, Xf(None, (x, y, z)), r + 0.05, 0.11, "steel_dark", seg=48, rseg=6)
    for k in range(16):
        a = k * TAU / 16
        box(mb, (0.22, 0.06, 3.9), Xf(rot_z(a), (x + math.cos(a) * (r + 0.1), y + math.sin(a) * (r + 0.1), 3.2)), "steel_dark")
    # stand
    for k in range(3):
        a = k * TAU / 3
        box(mb, (0.5, 0.5, 1.4), Xf(rot_z(a), (x + math.cos(a) * 1.5, y + math.sin(a) * 1.5, 0.7)), "steel_dark")
    scrap_pile(mb, (x, y), r - 0.3, 0.6, 40, rng)


def electrode_rack(mb, c, rng):
    x, y, z = c
    # preparation stand with three strings standing upright
    box_minmax(mb, (x - 1.8, y - 0.8, z), (x + 1.8, y + 0.8, z + 0.3), "steel_painted_grey")
    for k in range(3):
        ex = x - 1.1 + k * 1.1
        cyl(mb, (ex, y, z + 0.3), (ex, y, z + 5.6 + 0.3 * k), L.ELEC_R, "graphite", seg=20)
        torus(mb, Xf(None, (ex, y, z + 2.9)), L.ELEC_R + 0.004, 0.012, "steel_dark", seg=20, rseg=4)
        cyl(mb, (ex, y, z + 5.6 + 0.3 * k), (ex, y, z + 5.85 + 0.3 * k), 0.12, "steel_worn", seg=10)
    for sd in (-1, 1):
        box_minmax(mb, (x - 1.8, y + sd * 0.7 - 0.05, z + 0.3), (x + 1.8, y + sd * 0.7 + 0.05, z + 2.2), "steel_painted_grey")
        box_minmax(mb, (x - 1.8, y + sd * 0.7 - 0.05, z + 2.1), (x + 1.8, y + sd * 0.7 + 0.05, z + 2.25), "steel_painted_yellow")


def electrode_stack(mb, c, rng):
    x, y = c
    for row in range(3):
        for k in range(5 - row):
            yy = y - 1.6 + k * 0.64 + row * 0.32
            zz = 0.35 + L.ELEC_R + row * 0.55
            cyl(mb, (x - 1.4, yy, zz), (x + 1.4, yy, zz), L.ELEC_R, "graphite", seg=20)
    for dx in (-1.0, 1.0):
        box_minmax(mb, (x + dx - 0.1, y - 2.0, 0), (x + dx + 0.1, y + 2.0, 0.35), "rust")


def gas_cage(mb, c):
    x, y = c
    for i in range(6):
        for j in range(2):
            px, py = x - 0.9 + i * 0.36, y - 0.2 + j * 0.4
            cyl(mb, (px, py, 0), (px, py, 1.45), 0.11, "steel_painted_blue" if (i + j) % 3 else "steel_painted_grey", seg=10)
            lathe(mb, [(0.11, 1.45), (0.04, 1.6), (0.0, 1.62)], Xf(None, (px, py, 0)), "steel_worn", seg=8)
    for z in (0.0, 1.5):
        box_minmax(mb, (x - 1.2, y - 0.5, z), (x + 1.2, y + 0.5, z + 0.05), "steel_galvanized")
    for dx in (-1.2, 1.2):
        for dy in (-0.5, 0.5):
            box_minmax(mb, (x + dx - 0.03, y + dy - 0.03, 0), (x + dx + 0.03, y + dy + 0.03, 1.55), "steel_galvanized")


def drums(mb, c, n, rng):
    x, y = c
    for k in range(n):
        px, py = x + (k % 4) * 0.62 + rng.uniform(-0.05, 0.05), y + (k // 4) * 0.62
        mat = ["steel_painted_blue", "steel_primer_red", "steel_painted_yellow", "rust"][rng.randrange(4)]
        cyl(mb, (px, py, 0), (px, py, 0.88), 0.29, mat, seg=14)
        for z in (0.29, 0.59):
            torus(mb, Xf(None, (px, py, z)), 0.295, 0.012, mat, seg=14, rseg=4)
    box_minmax(mb, (x - 0.4, y - 0.4, 0), (x + 2.2, y + 1.6, 0.12), "rust")


def floodlights(mb, fixtures):
    for x in L.COLS_X[1:-1:2]:
        for s in (-1, 1):
            y = s * (L.RAIL_Y - 0.7)
            z = 14.0
            box(mb, (0.5, 0.25, 0.4), Xf(rot_x(s * 0.5), (x + 0.6, y, z)), "steel_dark")
            box(mb, (0.42, 0.02, 0.32), Xf(rot_x(s * 0.5), (x + 0.6, y - s * 0.13, z - 0.06)), "lamp")
            aim = rot_x(s * 0.5) @ v3(0, -s, 0)
            fixtures.append(("props", "flood", tuple(v3(x + 0.6, y - s * 0.15, z - 0.06)), tuple(aim), None))


def floor_markings(mb):
    # yellow walkway lines along the hall + hatched zones around the ladle rails
    for y in (-12.2, 12.2):
        for x0 in np.arange(L.HX0 + 2, L.HX1 - 2, 3.0):
            if -16 < x0 < 13 and y < 0:
                continue
            box_minmax(mb, (x0, y - 0.06, 0.012), (x0 + 2.4, y + 0.06, 0.016), "steel_painted_yellow")
    for x in np.arange(L.CAR_RAILS_X[0] + 12.0, L.CAR_RAILS_X[1], 1.2):
        for s in (-1, 1):
            box(mb, (0.12, 0.8, 0.004), Xf(rot_z(0.6), (x, s * 2.9, 0.014)), "steel_painted_yellow")


def slag_crust(mb, rng):
    # frozen spills and dark crust around the tap area, slag pit, under the ladle path
    for k in range(160):
        a = rng.uniform(0, TAU)
        r = rng.uniform(4.5, 14.0) ** 1.0
        p = v3(4.8 + math.cos(a) * r * 0.7 + 3.0, math.sin(a) * r * 0.35, 0.0)
        if abs(p[1]) < 2.3 and p[0] > 1.0:
            p[1] += math.copysign(2.4, p[1] if p[1] != 0 else 1)
        s = rng.uniform(0.1, 0.6)
        rock(mb, p, (s, s * rng.uniform(0.5, 1.4), s * 0.18), "slag_cold", rng, seg=6, rings=2, rough=0.35)
    for k in range(60):
        p = v3(rng.uniform(-14, -6), rng.uniform(-5, 5), 0.0)
        s = rng.uniform(0.2, 0.9)
        rock(mb, p, (s, s * rng.uniform(0.5, 1.4), s * 0.2), "slag_cold", rng, seg=6, rings=2, rough=0.35)


def build(ctx):
    rng = ctx["rng"]
    mb = MB("props_scrap")
    for c, r, h, n in (((-52.0, 6.0), 6.5, 3.2, 1300), ((-40.0, 10.0), 5.0, 2.4, 850), ((-50.0, -3.5), 4.0, 2.0, 500),
                       ((-30.0, 11.5), 3.5, 1.6, 350), ((-44.0, 1.0), 3.0, 1.2, 250)):
        scrap_pile(mb, c, r, h, n, rng)
    # scrap bay bunker walls (concrete blocks)
    for y in np.arange(-8.0, 15.0, 1.6):
        box_minmax(mb, (-58.5, y, 0), (-57.0, y + 1.55, 3.0), "concrete")
    for x in np.arange(-57.0, -33.0, 1.6):
        box_minmax(mb, (x, -8.5, 0), (x + 1.55, -7.0, 1.6), "concrete")
    parked_bucket(mb, (-34.0, 2.5), rng)
    mb2 = MB("props_misc")
    electrode_rack(mb2, (9.0, 7.0, L.DECK_Z), rng)
    electrode_stack(mb2, (15.0, 13.0), rng)
    electrode_stack(mb2, (18.5, 13.0), rng)
    gas_cage(mb2, (-19.0, -15.6))
    gas_cage(mb2, (12.5, -15.6))
    drums(mb2, (-24.0, 13.8), 8, rng)
    drums(mb2, (52.0, 14.0), 6, rng)
    floodlights(mb2, ctx.setdefault("fixtures", []))
    floor_markings(mb2)
    slag_crust(mb2, rng)
    return [mb, mb2]
