"""Building: floor, stepped crane columns, runway girders + rails, roof trusses,
purlins, sheeting, roof monitor with louvres, wall cladding, girts, bracing, lamps."""
import math

import numpy as np

from util import (MB, Xf, v3, box, box_minmax, beam, ibeam, cyl, lathe, disk, hexbolt, prism, sweep,
                  profile_beam, channel_prof, angle_prof, handrail, grating, strip_bars, frame, rot_z)
from layout import (HX0, HX1, HY, BAY, COLS_X, RAIL_Z, RAIL_Y, TRUSS_Z, EAVE_Z, RIDGE_Z, MONITOR_Z)

GIRDER_H = 2.4
GIRDER_TOP = RAIL_Z - 0.17
CRANE_LEG_Y = RAIL_Y        # crane leg under the rail
ROOF_LEG_Y = HY - 0.35


def ribbon(mb, pts2, z0, z1, mat, axis="x", flip=False):
    """Open corrugated sheet: profile polyline in (u, w) extruded along Z (walls)."""
    P = np.asarray(pts2, dtype=float)
    n = len(P)
    V = np.zeros((2 * n, 3))
    if axis == "x":      # profile u along X, w offsets along Y
        V[:n, 0] = P[:, 0]; V[:n, 1] = P[:, 1]
    else:                # profile u along Y, w offsets along X
        V[:n, 1] = P[:, 0]; V[:n, 0] = P[:, 1]
    V[n:, :2] = V[:n, :2]
    V[:n, 2] = z0
    V[n:, 2] = z1
    i = np.arange(n - 1)
    F = np.stack([i, i + 1, i + 1 + n, i + n], axis=1)
    if flip:
        F = F[:, ::-1]
    mb.add(V, F, mat)


def trapezoid_profile(u0, u1, pitch=0.25, depth=0.04, w0=0.0):
    pts = []
    u = u0
    while u < u1 - 1e-6:
        pts += [(u, w0), (u + pitch * 0.18, w0 + depth), (u + pitch * 0.45, w0 + depth), (u + pitch * 0.63, w0)]
        u += pitch
    pts.append((u1, w0))
    return pts


def sheet_sloped(mb, x0, x1, a, b, mat, pitch=0.28, depth=0.045):
    """Trapezoidal roof sheet between eave line a and ridge line b (points (y, z)), ribs run down-slope,
    profile repeats along X."""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    L = np.linalg.norm(d)
    nrm = np.array([0.0, -d[1], d[0]]) / L        # (x, y, z) normal of slope in YZ
    if nrm[2] < 0:
        nrm = -nrm
    prof = trapezoid_profile(x0, x1, pitch, depth)
    n = len(prof)
    V = np.zeros((2 * n, 3))
    for k, (u, w) in enumerate(prof):
        base = np.array([u, a[0], a[1]]) + nrm * w
        V[k] = base
        V[k + n] = base + np.array([0, d[0], d[1]])
    i = np.arange(n - 1)
    F = np.stack([i, i + n, i + 1 + n, i + 1], axis=1)
    if nrm[1] * (b[0] - a[0]) < 0:
        F = F[:, ::-1]
    mb.add(V, F, mat)


def top_chord_z(y):
    return TRUSS_Z + 1.3 + (RIDGE_Z - TRUSS_Z - 1.3) * (1 - abs(y) / HY)


def build_floor(rng):
    mb = MB("hall_floor")
    # slab tiles with tiny settlement offsets
    tx = 6.0
    ty = HY * 2 / 6
    for i in range(int((HX1 - HX0) / tx)):
        for j in range(6):
            x0 = HX0 + i * tx
            y0 = -HY + j * ty
            dz = rng.uniform(-0.012, 0.012)
            box_minmax(mb, (x0 + 0.012, y0 + 0.012, -0.4), (x0 + tx - 0.012, y0 + ty - 0.012, dz), "concrete")
    # joint filler under tiles
    box_minmax(mb, (HX0, -HY, -0.45), (HX1, HY, -0.03), "slag_cold")
    # lower walls (concrete) all round
    t = 0.35
    box_minmax(mb, (HX0 - t, HY, 0), (HX1 + t, HY + t, 3.0), "concrete")
    box_minmax(mb, (HX0 - t, -HY - t, 0), (HX1 + t, -HY, 3.0), "concrete")
    box_minmax(mb, (HX0 - t, -HY, 0), (HX0, HY, 3.0), "concrete")
    box_minmax(mb, (HX1, -HY, 0), (HX1 + t, HY, 3.0), "concrete")
    # outer apron beyond walls (so gable openings don't show void)
    box_minmax(mb, (HX0 - 40, -HY - 40, -0.6), (HX1 + 40, HY + 40, -0.45), "concrete")
    return mb


def column(mb, X, side, rng):
    s = side
    ry = s * ROOF_LEG_Y
    cy = s * CRANE_LEG_Y
    # plinths
    box_minmax(mb, (X - 0.9, min(ry, cy) - 0.8, 0), (X + 0.9, max(ry, cy) + 0.8, 0.45), "concrete")
    # legs
    ibeam(mb, (X, ry, 0.5), (X, ry, EAVE_Z + 0.6), 0.9, 0.5, "steel_painted_grey", up=(0, 1, 0), tw=0.018, tf=0.03)
    top_c = GIRDER_TOP - GIRDER_H - 0.9
    ibeam(mb, (X, cy, 0.5), (X, cy, top_c), 1.0, 0.6, "steel_painted_grey", up=(0, 1, 0), tw=0.02, tf=0.035)
    # base plates + anchor bolts
    for yy, w in ((ry, 0.9), (cy, 1.0)):
        box(mb, (0.9, w + 0.3, 0.05), Xf(None, (X, yy, 0.475)), "steel_dark")
        for dx in (-0.35, 0.35):
            for dy in (-(w + 0.3) / 2 + 0.08, (w + 0.3) / 2 - 0.08):
                hexbolt(mb, (X + dx, yy + dy, 0.5), (0, 0, 1), 0.035, "steel_dark", h=0.05)
                cyl(mb, (X + dx, yy + dy, 0.5), (X + dx, yy + dy, 0.62), 0.016, "steel_dark", seg=6)
    # cap / crane bracket: deep box on crane leg + stiffeners
    box_minmax(mb, (X - 0.35, min(ry, cy) - 0.1, top_c), (X + 0.35, max(ry, cy) + 0.1, top_c + 0.9), "steel_painted_grey")
    for dx in (-0.36, 0.36):
        for k in range(3):
            yy = cy + (ry - cy) * (k + 0.5) / 3
            box(mb, (0.02, 0.02, 0.85), Xf(None, (X + dx, yy, top_c + 0.45)), "steel_dark")
    # lacing between legs (both flange planes)
    zz = np.arange(1.2, top_c - 0.4, 1.7)
    for dx in (-0.26, 0.26):
        for k in range(len(zz) - 1):
            a = (X + dx, cy - s * 0.5, zz[k]) if k % 2 == 0 else (X + dx, ry + s * 0.45, zz[k])
            b = (X + dx, ry + s * 0.45, zz[k + 1]) if k % 2 == 0 else (X + dx, cy - s * 0.5, zz[k + 1])
            profile_beam(mb, angle_prof(0.1, 0.01), a, b, "steel_painted_grey", up=(1, 0, 0))
        for z in zz[::2]:
            beam(mb, (X + dx, cy - s * 0.5, z), (X + dx, ry + s * 0.45, z), 0.08, 0.08, "steel_painted_grey")
    # upper-leg knee brace to eave
    return top_c


def runway(mb, side):
    s = side
    y = s * RAIL_Y
    top = GIRDER_TOP
    for k in range(len(COLS_X) - 1):
        x0, x1 = COLS_X[k], COLS_X[k + 1]
        ibeam(mb, (x0 + 0.02, y, top - GIRDER_H / 2), (x1 - 0.02, y, top - GIRDER_H / 2), GIRDER_H, 0.75,
              "steel_painted_grey", tw=0.018, tf=0.045)
        # web stiffeners
        for xs in np.arange(x0 + 0.75, x1 - 0.5, 1.5):
            for sd in (-1, 1):
                box(mb, (0.022, 0.34, GIRDER_H - 0.1), Xf(None, (xs, y + sd * 0.19, top - GIRDER_H / 2)), "steel_painted_grey")
        # end bearing stiffeners
        for xe in (x0 + 0.15, x1 - 0.15):
            box(mb, (0.04, 0.72, GIRDER_H - 0.1), Xf(None, (xe, y, top - GIRDER_H / 2)), "steel_painted_grey")
    # crane rail (continuous) + clips
    rail = [(-0.1, 0), (0.1, 0), (0.1, 0.025), (0.03, 0.05), (0.03, 0.13), (0.06, 0.14), (0.06, 0.17),
            (-0.06, 0.17), (-0.06, 0.14), (-0.03, 0.13), (-0.03, 0.05), (-0.1, 0.025)]
    # rail profile in (y,z): build prism along X
    R = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], dtype=float)   # local x->Y, y->Z, z->X
    prism(mb, rail, HX1 - HX0, Xf(R, (HX0, y, top)), "steel_worn")
    for xc in np.arange(HX0 + 0.4, HX1, 0.8):
        for sd in (-1, 1):
            box(mb, (0.12, 0.09, 0.04), Xf(None, (xc, y + sd * 0.13, top + 0.045)), "steel_dark")
    # surge plate / walkway to wall
    wy0, wy1 = (y + s * 0.45, s * (HY - 0.45))
    lo, hi = min(wy0, wy1), max(wy0, wy1)
    strip_bars(mb, (HX0, (lo + hi) / 2, top), (HX1, (lo + hi) / 2, top), (0, 1, 0), hi - lo, top, "grating", pitch=0.05)
    handrail(mb, [(HX0 + 0.3, s * (HY - 0.6), top), (HX1 - 0.3, s * (HY - 0.6), top)], mat="steel_painted_yellow", post=2.0)
    # crane conductor rails on the inner face of the girder
    for q in range(4):
        zq = top - 0.5 - q * 0.16
        beam(mb, (HX0, y - s * 0.62, zq), (HX1, y - s * 0.62, zq), 0.03, 0.05, "copper_busbar")
    for xc in np.arange(HX0 + 1.0, HX1, 3.0):
        beam(mb, (xc, y - s * 0.4, top - 0.45), (xc, y - s * 0.7, top - 0.45), 0.06, 0.06, "steel_dark")
        box(mb, (0.06, 0.06, 0.55), Xf(None, (xc, y - s * 0.66, top - 0.72)), "steel_dark")


def truss(mb, X, rng):
    n = 16
    ys = np.linspace(-ROOF_LEG_Y, ROOF_LEG_Y, n + 1)
    bot = [(X, y, TRUSS_Z) for y in ys]
    topc = [(X, y, top_chord_z(y)) for y in ys]
    mat = "steel_painted_grey"
    # chords (T/I)
    for k in range(n):
        ibeam(mb, bot[k], bot[k + 1], 0.32, 0.3, mat, up=(0, 0, 1))
        ibeam(mb, topc[k], topc[k + 1], 0.36, 0.32, mat, up=(0, 0, 1))
    # verticals + diagonals (Pratt toward the centre)
    for k in range(n + 1):
        ibeam(mb, (X, ys[k], TRUSS_Z + 0.16), (X, ys[k], top_chord_z(ys[k]) - 0.18), 0.16, 0.16, mat, up=(0, 1, 0))
    for k in range(n):
        if ys[k] < 0:
            a, b = bot[k + 1], topc[k]
        else:
            a, b = bot[k], topc[k + 1]
        for dx in (-0.06, 0.06):
            profile_beam(mb, angle_prof(0.12, 0.012), v3(a) + v3(dx, 0, 0.16), v3(b) + v3(dx, 0, -0.18), mat,
                         up=(1, 0, 0), roll=0.0 if dx < 0 else math.pi / 2)
    # gussets + bolts at panel points
    for k in range(n + 1):
        for p, zoff in ((bot[k], 0.35), (topc[k], -0.4)):
            c = v3(p) + v3(0, 0, zoff)
            box(mb, (0.018, 0.7, 0.55), Xf(None, c), "steel_painted_grey")
            for by in (-0.2, 0.0, 0.2):
                for bz in (-0.12, 0.12):
                    for sd in (-1, 1):
                        hexbolt(mb, c + v3(sd * 0.009, by, bz), (sd, 0, 0), 0.022, "steel_dark", h=0.018)
    # bearing on roof legs
    for s in (-1, 1):
        box(mb, (0.6, 0.9, 0.5), Xf(None, (X, s * ROOF_LEG_Y, TRUSS_Z + 0.4)), "steel_painted_grey")
    # monitor posts + monitor truss
    for s in (-1, 1):
        y = s * 3.6
        zb = top_chord_z(y)
        ibeam(mb, (X, y, zb), (X, y, MONITOR_Z), 0.22, 0.2, mat, up=(0, 1, 0))
    ibeam(mb, (X, -3.8, MONITOR_Z - 0.6), (X, 0, MONITOR_Z + 0.2), 0.25, 0.2, mat)
    ibeam(mb, (X, 0, MONITOR_Z + 0.2), (X, 3.8, MONITOR_Z - 0.6), 0.25, 0.2, mat)
    ibeam(mb, (X, -3.6, MONITOR_Z - 0.9), (X, 3.6, MONITOR_Z - 0.9), 0.2, 0.18, mat)
    return bot, topc, ys


def roof(mb, trusses_ys, rng):
    ys = trusses_ys
    mat = "steel_painted_grey"
    # purlins along the whole hall at every top-chord panel point
    for y in ys:
        z = top_chord_z(y) + 0.18
        if abs(y) < 3.4:
            continue
        profile_beam(mb, channel_prof(0.24, 0.08, 0.008, 0.012), (HX0, y, z + 0.12), (HX1, y, z + 0.12), mat,
                     up=(0, 0, 1), roll=-math.pi / 2)
    # sheeting on both slopes (eave -> monitor side)
    for s in (-1, 1):
        a = (s * (HY + 0.4), top_chord_z(HY) + 0.42 - 0.1)
        b = (s * 3.6, top_chord_z(3.6) + 0.42)
        sheet_sloped(mb, HX0, HX1, a, b, "roof_sheet")
    # monitor roof
    for s in (-1, 1):
        sheet_sloped(mb, HX0, HX1, (s * 4.1, MONITOR_Z - 0.55), (0.0, MONITOR_Z + 0.45), "roof_sheet")
    # monitor louvres (slats) + sky behind -> light shafts
    for s in (-1, 1):
        y = s * 3.75
        z0 = top_chord_z(3.6) + 0.5
        z1 = MONITOR_Z - 0.75
        nz = int((z1 - z0) / 0.24)
        for k in range(nz):
            z = z0 + 0.12 + k * (z1 - z0) / nz
            beam(mb, (HX0, y, z), (HX1, y, z), 0.26, 0.012, "roof_sheet", up=(0, -s * 0.6, 1.0), caps=False)
        # sky plane just outside the louvres
        ribbon(mb, [(HX0, s * 4.05), (HX1, s * 4.05)], z0, z1, "sky_opening", axis="x", flip=(s > 0))
        # louvre frame mullions
        for x in np.arange(HX0, HX1 + 0.1, 3.0):
            box(mb, (0.08, 0.1, z1 - z0), Xf(None, (x, y, (z0 + z1) / 2)), mat)
    # bottom-chord longitudinal ties + X bracing in the roof plane (end bays)
    for y in (-10.6, -4.25, 4.25, 10.6):
        beam(mb, (HX0, y, TRUSS_Z), (HX1, y, TRUSS_Z), 0.1, 0.1, mat)
    for x0 in (COLS_X[0], COLS_X[4], COLS_X[-2]):
        x1 = x0 + BAY
        for s in (-1, 1):
            ya, yb = s * 4.25, s * ROOF_LEG_Y
            cyl(mb, (x0, ya, top_chord_z(ya) + 0.25), (x1, yb, top_chord_z(yb) + 0.25), 0.025, "steel_dark", seg=6)
            cyl(mb, (x0, yb, top_chord_z(yb) + 0.25), (x1, ya, top_chord_z(ya) + 0.25), 0.025, "steel_dark", seg=6)


def walls(mb, rng):
    mat = "roof_sheet"
    z0, z1 = 3.0, EAVE_Z + 1.4
    win0, win1 = 16.0, 18.4
    for s in (-1, 1):
        y = s * (HY + 0.28)
        # skip random damaged panels (holes) -> sky behind
        xs = np.arange(HX0, HX1, 6.0)
        for x in xs:
            prof = trapezoid_profile(x, x + 6.0, 0.25, 0.04)
            prof = [(u, y + s * w) for u, w in prof]
            ribbon(mb, prof, z0, win0, mat, axis="x", flip=(s < 0))
            if rng.random() < 0.12:
                # a missing sheet high up
                ribbon(mb, prof, win1, z1 - 4.0, mat, axis="x", flip=(s < 0))
                ribbon(mb, [(x, y + s * 0.3), (x + 6.0, y + s * 0.3)], z1 - 4.0, z1, "sky_opening", axis="x", flip=(s > 0))
            else:
                ribbon(mb, prof, win1, z1, mat, axis="x", flip=(s < 0))
        # window band: dirty translucent panels (emissive dim) + mullions
        ribbon(mb, [(HX0, y + s * 0.02), (HX1, y + s * 0.02)], win0, win1, "sky_opening", axis="x", flip=(s > 0))
        for x in np.arange(HX0, HX1 + 0.01, 1.5):
            box(mb, (0.06, 0.12, win1 - win0), Xf(None, (x, y - s * 0.05, (win0 + win1) / 2)), "steel_dark")
        beam(mb, (HX0, y - s * 0.05, win0), (HX1, y - s * 0.05, win0), 0.14, 0.14, "steel_dark")
        beam(mb, (HX0, y - s * 0.05, win1), (HX1, y - s * 0.05, win1), 0.14, 0.14, "steel_dark")
        # girts
        for z in (6.0, 10.0, 13.5, 21.0, 25.0, 28.5):
            profile_beam(mb, channel_prof(0.26, 0.09, 0.008, 0.012), (HX0, y - s * 0.2, z), (HX1, y - s * 0.2, z),
                         "steel_painted_grey", up=(0, 0, 1), roll=(math.pi / 2 if s > 0 else -math.pi / 2))
        # wall X-bracing in a few bays
        for x0 in (COLS_X[1], COLS_X[5], COLS_X[8]):
            yy = s * (ROOF_LEG_Y + 0.1)
            cyl(mb, (x0, yy, 1.0), (x0 + BAY, yy, 20.0), 0.03, "steel_dark", seg=6)
            cyl(mb, (x0 + BAY, yy, 1.0), (x0, yy, 20.0), 0.03, "steel_dark", seg=6)
    # gable ends with big doors (sky beyond)
    for gx, s in ((HX0 - 0.28, -1), (HX1 + 0.28, 1)):
        door_y = (-6.0, 6.0) if s > 0 else (-12.0, -3.0)
        door_z = 14.0 if s > 0 else 9.0
        ys = np.arange(-HY, HY, 6.0)
        for y in ys:
            y1 = min(y + 6.0, HY)
            ztop = min(top_chord_z(y), top_chord_z(y1)) + 0.4
            prof = trapezoid_profile(y, y1, 0.25, 0.04)
            prof = [(u, gx + s * w) for u, w in prof]
            if y + 6.0 <= door_y[0] + 1e-6 or y >= door_y[1] - 1e-6:
                ribbon(mb, prof, 3.0, ztop, mat, axis="y", flip=(s > 0))
            else:
                ribbon(mb, prof, door_z, ztop, mat, axis="y", flip=(s > 0))
        # door opening: sky
        ribbon(mb, [(door_y[0], gx + s * 6), (door_y[1], gx + s * 6)], -0.5, door_z + 2, "sky_opening", axis="y", flip=(s < 0))
        # gable columns + door lintel
        for y in np.arange(-HY + 6.0, HY - 1, 6.0):
            ibeam(mb, (gx - s * 0.4, y, 0.3), (gx - s * 0.4, y, top_chord_z(y)), 0.5, 0.3, "steel_painted_grey", up=(1, 0, 0))
        ibeam(mb, (gx - s * 0.4, door_y[0], door_z), (gx - s * 0.4, door_y[1], door_z), 0.9, 0.35, "steel_painted_grey")
        # lower wall door cut: fill concrete wall is continuous; carve by overdraw is not possible -> leave


def eave_and_bracing(mb):
    for s in (-1, 1):
        y = s * ROOF_LEG_Y
        ibeam(mb, (HX0, y, EAVE_Z + 0.1), (HX1, y, EAVE_Z + 0.1), 0.5, 0.25, "steel_painted_grey")
        ibeam(mb, (HX0, y, 11.5), (HX1, y, 11.5), 0.4, 0.22, "steel_painted_grey")


def lamps(mb):
    for X in COLS_X[1:-1]:
        for y in (-11.0, -5.0, 5.0, 11.0):
            for xo in (-6.0,):
                x = X + xo
                z = TRUSS_Z - 0.2
                cyl(mb, (x, y, z), (x, y, z + 0.5), 0.02, "steel_dark", seg=6)
                lathe(mb, [(0.0, 0.5), (0.12, 0.5), (0.14, 0.35), (0.36, 0.05), (0.38, 0.0), (0.33, 0.0), (0.0, 0.26)][::-1],
                      Xf(None, (x, y, z - 0.55)), "steel_galvanized", seg=16)
                disk(mb, (x, y, z - 0.54), 0.32, "lamp", seg=16, normal=(0, 0, -1))
                box(mb, (0.3, 0.2, 0.25), Xf(None, (x, y, z - 0.02)), "steel_galvanized")


def build(ctx):
    """Returns a list of MeshBuilders."""
    rng = ctx["rng"]
    floor = build_floor(rng)
    struct = MB("hall_columns")
    for X in COLS_X:
        for s in (-1, 1):
            column(struct, X, s, rng)
    run = MB("hall_runway")
    for s in (-1, 1):
        runway(run, s)
    tr = MB("hall_trusses")
    ys = None
    for X in COLS_X:
        _, _, ys = truss(tr, X, rng)
    rf = MB("hall_roof")
    roof(rf, ys, rng)
    eave_and_bracing(struct)
    wl = MB("hall_walls")
    walls(wl, rng)
    lp = MB("hall_lamps")
    lamps(lp)
    return [floor, struct, run, tr, rf, wl, lp]
