"""The electric arc furnace: tilting shell (part), swinging water-cooled roof (part),
three electrode columns on mast arms (parts), plus the static operating deck,
rocker foundation, transformer vault, flexible cables and the fixed fume duct."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, frame, rot_z, rot_x, box, box_minmax, beam, ibeam, cyl, lathe, disk, torus,
                  sweep, catenary, bezier, hexbolt, bolt_circle, flange, prism, profile_beam, angle_prof,
                  chamfer_rect, pipe_run, handrail, grating, strip_bars, circle, rock, lump, sweep_profile, weld, TAU)
import layout as L

R = L.SHELL_R
D2R = math.pi / 180.0


def pol(r, a, z):
    return v3(r * math.cos(a), r * math.sin(a), z)


def dented_r(a, z, r=R, nz=0.02, nfreq=1.1, seed=2.1):
    """Radius of a dented lathe surface (util.lathe's noise) at angle a, height z."""
    from mathutils import Vector, noise
    x, y = r * math.cos(a), r * math.sin(a)
    n = noise.noise(Vector((x * nfreq + seed, y * nfreq, z * nfreq)))
    n += 0.5 * noise.noise(Vector((x * nfreq * 2.7, y * nfreq * 2.7 + seed, z * nfreq * 2.7)))
    return r + nz * n


# --------------------------------------------------------------------- shell

def shell(ctx):
    rng = ctx["rng"]
    mb = MB("furnace_shell")
    zb = L.SHELL_BASE_Z
    # bottom dish (ellipsoidal), dented
    prof = [(R * math.sin(t), zb - (zb - L.DISH_Z) * math.cos(t)) for t in np.linspace(0, math.pi / 2, 10)]
    lathe(mb, prof, Xf(), "steel_heat", seg=96, nz=0.025, nfreq=0.9, seed=1.3)
    # joint flanges (dish / lower shell) + wedge clamps
    lathe(mb, [(R, zb - 0.14), (R + 0.3, zb - 0.14), (R + 0.3, zb - 0.02), (R + 0.02, zb - 0.02)], Xf(), "steel_dark", seg=96)
    lathe(mb, [(R, zb + 0.02), (R + 0.3, zb + 0.02), (R + 0.3, zb + 0.14), (R + 0.02, zb + 0.14)], Xf(), "steel_dark", seg=96)
    for k in range(36):
        a = k * TAU / 36 + 0.05
        c = pol(R + 0.2, a, zb)
        box(mb, (0.22, 0.14, 0.42), Xf(rot_z(a), c), "steel_dark")
        hexbolt(mb, pol(R + 0.31, a, zb + 0.1), (math.cos(a), math.sin(a), 0), 0.04, "steel_worn", washer=True)
    # lower shell (refractory zone) with vertical rib stiffeners + ring stiffener
    z1 = 9.3
    lathe(mb, [(R, zb), (R, z1)], Xf(), "steel_heat", seg=96, nz=0.02, nfreq=1.1, seed=2.1)
    for k in range(48):
        a = k * TAU / 48
        if abs(((a / D2R) + 360) % 360 - 180) < 14:   # slag door zone
            continue
        # rib roots sink 6 cm into the dented plate so no dent lifts them off; fillet welds follow the dents
        box(mb, (0.28, 0.03, z1 - zb - 0.1), Xf(rot_z(a), pol(R + 0.08, a, (zb + z1) / 2)), "steel_heat")
        for sd in (-1, 1):
            aw = a + sd * 0.022 / R
            weld(mb, [pol(dented_r(aw, zz) + 0.003, aw, zz) for zz in np.linspace(zb + 0.1, z1 - 0.1, 7)], "steel_heat", r=0.009)
    lathe(mb, [(R, 8.62), (R + 0.24, 8.62), (R + 0.24, 8.7), (R, 8.7)], Xf(), "steel_heat", seg=96)
    # upper shell: water-cooled cage + pipe-coil panels
    zt = L.SHELL_TOP_Z
    lathe(mb, [(R - 0.04, z1), (R - 0.04, zt)], Xf(), "steel_dark", seg=96)
    npan = 12
    gap = 2.2 * D2R
    for p in range(npan):
        a0 = p * TAU / npan + gap / 2 - math.pi / npan
        a1 = (p + 1) * TAU / npan - gap / 2 - math.pi / npan
        mid = (a0 + a1) / 2
        door = abs(math.atan2(math.sin(mid - math.pi), math.cos(mid - math.pi))) < 0.3
        zs = np.arange(z1 + 0.12, zt - 0.08, 0.128)
        for i, z in enumerate(zs):
            if door and z < 10.35:
                continue
            torus(mb, Xf(None, (0, 0, z)), R + 0.065, 0.058, "panel_cooled", seg=14, rseg=6, arc=(a0, a1))
        # headers at panel edges
        for a in (a0 - 0.012, a1 + 0.012):
            zlo = 10.3 if door else z1 + 0.05
            cyl(mb, pol(R + 0.08, a, zlo), pol(R + 0.08, a, zt - 0.02), 0.085, "panel_cooled", seg=10)
            for zz in (zlo + 0.25, zt - 0.3):
                flange(mb, pol(R + 0.08, a, zz), (0, 0, 1), 0.085, "steel_dark", seg=10, bolts=4)
        # hoses from panel headers to the ring main (droop)
        for j, a in enumerate((a0 + 0.02, a1 - 0.02)):
            p0 = pol(R + 0.1, a, (10.35 if door else z1) + 0.05)
            p3 = pol(R + 0.62, a + (0.06 if j else -0.06), 8.95)
            p1 = p0 + v3(0, 0, -0.6)
            p2 = p3 + v3(0, 0, 0.5) + v3(math.cos(a), math.sin(a), 0) * 0.4
            sweep(mb, bezier(p0, p1, p2, p3, 10), 0.045, "cable_rubber", seg=8)
            cyl(mb, p0 + v3(0, 0, 0.06), p0 + v3(0, 0, -0.1), 0.06, "steel_worn", seg=8)
    # ring mains (supply + return) around the shell
    torus(mb, Xf(None, (0, 0, 8.95)), R + 0.62, 0.14, "pipe_green", seg=72, rseg=10, arc=(-2.9, 2.9))
    torus(mb, Xf(None, (0, 0, 9.25)), R + 0.62, 0.12, "steel_primer_red", seg=72, rseg=10, arc=(-2.9, 2.9))
    for k in range(16):
        a = -2.8 + k * 5.6 / 15
        box(mb, (0.45, 0.08, 0.6), Xf(rot_z(a), pol(R + 0.42, a, 9.05)), "steel_dark")
    # top flange / sand seal ring
    lathe(mb, [(R - 0.1, zt), (R + 0.42, zt), (R + 0.42, zt + 0.12), (R - 0.1, zt + 0.12)], Xf(), "steel_heat", seg=96)
    for k in range(24):
        a = k * TAU / 24
        box(mb, (0.36, 0.05, 0.4), Xf(rot_z(a), pol(R + 0.24, a, zt - 0.2)), "steel_heat")
    # glowing seam between shell and roof (visible gap)
    lathe(mb, [(R - 0.12, zt + 0.121), (R + 0.05, zt + 0.121), (R + 0.05, zt + 0.16), (R - 0.12, zt + 0.16)], Xf(),
          "refractory_hot", seg=64)
    # inside: refractory wall (hot) + bath + slag islands
    Ri = R - 0.45
    lathe(mb, [(Ri, zt + 0.1), (Ri, L.BATH_Z)], Xf(), "refractory_hot", seg=64)
    lathe(mb, [(Ri + 0.001, L.BATH_Z), (0.0, L.BATH_Z)], Xf(), "molten_steel", seg=64)
    for k in range(26):
        a = rng.uniform(0, TAU)
        r = rng.uniform(1.0, Ri - 0.3)
        s = rng.uniform(0.25, 0.7)
        lathe(mb, [(0, L.BATH_Z + 0.005), (s, L.BATH_Z + 0.01), (s * 0.7, L.BATH_Z + 0.05), (0, L.BATH_Z + 0.06)],
              Xf(rot_z(rng.uniform(0, 3)) @ np.diag([1, rng.uniform(0.5, 1), 1]), pol(r, a, 0)), "slag_hot", seg=10)
    # --- slag door: water-cooled frame tunnel, door panel, glow, spill
    sd = slag_door(mb, rng)
    # --- EBT bay
    ebt(mb, rng)
    # --- cradle, rockers, tilting platform
    cradle(mb, rng)
    # --- mast guides + roof swing column base (on the tilting platform)
    mast_guides(mb)
    return mb


def slag_door(mb, rng):
    x = -R
    zs, zt = 8.85, 10.25
    w = 1.5
    # tunnel frame (box around opening), sticking out 0.9 m
    for yy in (-w / 2 - 0.18, w / 2 + 0.18):
        box_minmax(mb, (x - 0.95, yy - 0.18, zs - 0.35), (x + 0.2, yy + 0.18, zt + 0.35), "panel_cooled")
    box_minmax(mb, (x - 0.95, -w / 2 - 0.36, zt), (x + 0.2, w / 2 + 0.36, zt + 0.4), "panel_cooled")
    box_minmax(mb, (x - 1.1, -w / 2 - 0.4, zs - 0.45), (x + 0.15, w / 2 + 0.4, zs), "steel_heat")
    # water-cooled coils on the frame faces
    for k in range(6):
        z = zs - 0.2 + k * 0.2
        for sy in (-1, 1):
            cyl(mb, (x - 0.97, sy * (w / 2 + 0.18) - 0.12, z), (x - 0.97, sy * (w / 2 + 0.18) + 0.12, z), 0.05, "panel_cooled", seg=8)
    # door panel raised (partly open) with guide rails + hydraulic cylinder
    box_minmax(mb, (x - 1.05, -w / 2 - 0.05, zt - 0.35 + 0.55), (x - 0.9, w / 2 + 0.05, zt + 0.9 + 0.55), "panel_cooled")
    for sy in (-1, 1):
        box_minmax(mb, (x - 1.12, sy * (w / 2 + 0.05) - 0.06, zs), (x - 1.0, sy * (w / 2 + 0.05) + 0.06, zt + 2.2), "steel_dark")
    cyl(mb, (x - 1.2, 0, zt + 1.5), (x - 1.2, 0, zt + 3.3), 0.13, "steel_painted_yellow", seg=12)
    cyl(mb, (x - 1.2, 0, zt + 1.0), (x - 1.2, 0, zt + 1.6), 0.06, "steel_worn", seg=10)
    # glow inside the opening
    # recessed glow: dark crusted jambs, hot slag foam at the sill, the bath glow deep inside
    box_minmax(mb, (x + 0.35, -w / 2, zs), (x + 0.6, w / 2, zt + 0.25), "refractory_hot")
    for sy in (-1, 1):
        box_minmax(mb, (x - 0.95, sy * (w / 2) - (0.08 if sy > 0 else 0.0), zs), (x + 0.35, sy * (w / 2) + (0.0 if sy > 0 else 0.08), zt + 0.25),
                   "slag_cold")
    box_minmax(mb, (x - 0.95, -w / 2, zt + 0.17), (x + 0.35, w / 2, zt + 0.25), "slag_cold")
    box_minmax(mb, (x - 0.9, -w / 2 + 0.05, zs - 0.01), (x + 0.35, w / 2 - 0.05, zs + 0.08), "slag_hot")
    # foaming slag at the sill and the spill over the apron: cracked crust, the hot ones with glowing fissures
    # No crust lumps and no spill sheet: static blobs and a flat glowing ribbon read as props in
    # a close-up. The RNG draws the lumps made are consumed unchanged, so every seeded layout
    # after this one stays put.
    # (lump() draws three from the outer rng: its turn, its tilt, its own seed.)
    for k in range(10):
        rng.random(); rng.uniform(0, 1); rng.random(); rng.uniform(0, 1); rng.uniform(0, 1); rng.uniform(0, 1)
    for k in range(40):
        rng.random(); rng.uniform(0, 1); rng.uniform(0, 1); rng.random(); rng.uniform(0, 1); rng.uniform(0, 1); rng.uniform(0, 1)


def ebt(mb, rng):
    ex = L.EBT_XY[0]
    z0, z1 = 7.35, 9.85
    # nose-shaped bay in plan, joined to the shell
    pts = [(R - 0.6, -1.3), (ex - 0.1, -1.05)] + [(ex - 0.1 + 0.95 * math.cos(a), 0.95 * math.sin(a))
                                                    for a in np.linspace(-math.pi / 2 + 0.3, math.pi / 2 - 0.3, 9)] + \
          [(ex - 0.1, 1.05), (R - 0.6, 1.3)]
    prism(mb, pts, z1 - z0, Xf(None, (0, 0, z0)), "steel_heat")
    # stiffeners on the bay
    for a in np.linspace(-1.1, 1.1, 7):
        box(mb, (0.26, 0.03, z1 - z0 - 0.2), Xf(rot_z(a), (ex - 0.1 + 1.02 * math.cos(a), 1.02 * math.sin(a), (z0 + z1) / 2)), "steel_heat")
        for sd in (-1, 1):
            aw = a + sd * 0.023 / 0.95
            c = v3(ex - 0.1 + 0.955 * math.cos(aw), 0.955 * math.sin(aw), 0)
            weld(mb, [c + v3(0, 0, z0 + 0.12), c + v3(0, 0, z1 - 0.12)], "steel_heat", r=0.009)
    # sloped bottom into the dish
    lathe(mb, [(0.0, z0 - 0.35), (0.7, z0 - 0.35), (1.05, z0)], Xf(None, (ex - 0.1, 0, 0)), "steel_heat", seg=16)
    # tap hole nozzle + slide gate block
    cyl(mb, (ex, 0, z0 - 0.35), (ex, 0, z0 - 0.75), 0.32, "steel_dark", seg=16)
    cyl(mb, (ex, 0, z0 - 0.75), (ex, 0, z0 - 0.82), 0.16, "refractory_hot", seg=16)
    box_minmax(mb, (ex - 0.2, -0.75, z0 - 0.7), (ex + 0.9, 0.75, z0 - 0.4), "steel_dark")
    cyl(mb, (ex + 0.9, 0.3, z0 - 0.55), (ex + 2.0, 0.3, z0 - 0.55), 0.08, "steel_painted_yellow", seg=10)
    # tap-hole cover on top with hinge + cylinder
    cyl(mb, (ex, 0, z1), (ex, 0, z1 + 0.18), 0.55, "panel_cooled", seg=24)
    box_minmax(mb, (ex - 0.1, -0.45, z1 + 0.18), (ex + 0.8, 0.45, z1 + 0.3), "steel_dark")
    cyl(mb, (ex + 0.7, -0.5, z1 + 0.35), (ex + 0.7, 0.5, z1 + 0.35), 0.09, "steel_worn", seg=10)
    cyl(mb, (ex + 0.8, 0, z1 + 0.35), (ex + 1.5, 0, z1 - 0.6), 0.09, "steel_painted_yellow", seg=10)
    box_minmax(mb, (ex - 0.2, -1.1, z1), (ex + 0.1, 1.1, z1 + 0.3), "steel_heat")


def cradle(mb, rng):
    cz = L.TILT_PIVOT[2]
    rr = L.ROCKER_R
    # rockers: curved-bottom plate girders in XZ at y = +-ROCKER_Y
    for s in (-1, 1):
        y = s * L.ROCKER_Y
        ang = np.linspace(-0.62, 0.62, 25)
        bot = [(math.sin(a) * rr, cz - math.cos(a) * rr) for a in ang]
        top_z = 7.05
        prof = [(bot[0][0], top_z)] + bot + [(bot[-1][0], top_z)]
        # web plate: prism in XZ plane of thickness 0.1 along Y
        Rm = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)  # local y->Z, local z->-Y
        P = [(p[0], p[1]) for p in prof]
        prism(mb, P, 0.1, Xf(Rm, (0, y + 0.05, 0)), "steel_dark")
        # curved bottom flange (rolling tread) + teeth
        for k in range(len(ang) - 1):
            a0, a1 = ang[k], ang[k + 1]
            p0 = v3(math.sin(a0) * rr, y, cz - math.cos(a0) * rr)
            p1 = v3(math.sin(a1) * rr, y, cz - math.cos(a1) * rr)
            beam(mb, p0, p1, 0.08, 0.5, "steel_worn", up=(0, 1, 0), caps=False)
        for a in np.linspace(-0.6, 0.6, 22):
            p = v3(math.sin(a) * (rr - 0.02), y + s * 0.34, cz - math.cos(a) * (rr - 0.02))
            box(mb, (0.12, 0.18, 0.1), Xf(np.array([[math.cos(a), 0, -math.sin(a)], [0, 1, 0], [math.sin(a), 0, math.cos(a)]]), p), "steel_worn")
        # web stiffeners
        for xx in np.linspace(-3.0, 3.0, 9):
            zb = cz - math.sqrt(max(rr * rr - xx * xx, 0))
            box_minmax(mb, (xx - 0.02, y - 0.3, zb + 0.08), (xx + 0.02, y + 0.3, top_z), "steel_dark")
        # top chord of the cradle
        box_minmax(mb, (bot[0][0], y - 0.4, top_z - 0.05), (bot[-1][0], y + 0.4, top_z + 0.15), "steel_dark")
    # cross girders + tilting platform frame (carries masts at +Y)
    for x in (-3.2, -1.2, 1.2, 3.2):
        ibeam(mb, (x, -L.ROCKER_Y - 0.4, 6.8), (x, 8.6, 6.8), 0.7, 0.4, "steel_dark")
    for y in (-3.6, 3.6, 5.6, 7.9):
        ibeam(mb, (-4.6, y, 6.8), (4.6, y, 6.8), 0.7, 0.4, "steel_dark")
    # platform plate at +Y (mast area) with checker-ish plating
    box_minmax(mb, (-4.6, 4.9, 7.15), (5.8, 8.6, 7.25), "steel_chequer")
    handrail(mb, [(-4.5, 8.5, 7.25), (5.7, 8.5, 7.25), (5.7, 5.0, 7.25)], mat="steel_painted_yellow")
    # tilt cylinder clevises
    for s in (-1, 1):
        box_minmax(mb, (-4.8, s * 4.3 - 0.3, 6.2), (-4.1, s * 4.3 + 0.3, 6.9), "steel_dark")


def mast_guides(mb):
    for i, (mx, my) in enumerate(L.MAST_XY):
        z0, z1 = 7.25, 14.6
        w = 1.45
        cs = [(-w / 2, -w / 2), (w / 2, -w / 2), (w / 2, w / 2), (-w / 2, w / 2)]
        for cx, cy in cs:
            ibeam(mb, (mx + cx, my + cy, z0), (mx + cx, my + cy, z1), 0.34, 0.3, "steel_painted_grey", up=(0, 1, 0))
        # side cover plates (+-X faces) with stiffener ribs, open toward the furnace for the rollers
        for sx in (-1, 1):
            box_minmax(mb, (mx + sx * w / 2 - 0.02, my - w / 2 + 0.15, z0 + 0.2), (mx + sx * w / 2 + 0.02, my + w / 2 - 0.15, z1 - 0.3),
                       "steel_painted_grey")
            for z in np.arange(z0 + 0.8, z1 - 0.3, 0.9):
                box_minmax(mb, (mx + sx * (w / 2 + 0.02), my - w / 2 + 0.15, z - 0.02), (mx + sx * (w / 2 + 0.12), my + w / 2 - 0.15, z + 0.02),
                           "steel_painted_grey")
        for z in (z0 + 0.4, 10.2, z1 - 0.15):
            for k in range(4):
                a_, b_ = cs[k], cs[(k + 1) % 4]
                beam(mb, (mx + a_[0], my + a_[1], z), (mx + b_[0], my + b_[1], z), 0.3, 0.3, "steel_painted_grey")
        # diagonal bracing on the back face
        for z in (z0 + 0.4, 10.2):
            beam(mb, (mx - w / 2, my + w / 2, z), (mx + w / 2, my + w / 2, z + 2.5), 0.12, 0.12, "steel_painted_grey")
        # roller boxes at top and mid
        for z in (z1 - 0.45, 10.2):
            for cx, cy in cs:
                box(mb, (0.36, 0.36, 0.55), Xf(None, (mx + cx * 0.72, my + cy * 0.72, z)), "steel_dark")
                cyl(mb, (mx + cx * 0.5 - 0.13, my + cy * 0.5, z), (mx + cx * 0.5 + 0.13, my + cy * 0.5, z), 0.15, "steel_worn", seg=14)
                hexbolt(mb, (mx + cx * 0.72, my + cy * 0.72, z + 0.275), (0, 0, 1), 0.04, "steel_worn")
        # hydraulic cylinder beside the guide + hoses
        cyl(mb, (mx - w / 2 - 0.35, my + 0.2, z0), (mx - w / 2 - 0.35, my + 0.2, z0 + 5.5), 0.18, "steel_painted_yellow", seg=14)
        cyl(mb, (mx - w / 2 - 0.35, my + 0.2, z0 + 5.5), (mx - w / 2 - 0.35, my + 0.2, z0 + 6.4), 0.09, "steel_worn", seg=10)
        for q in range(2):
            sweep(mb, bezier((mx - w / 2 - 0.35, my + 0.38 + q * 0.1, z0 + 5.0 - q * 3.5), (mx - w / 2 - 0.1, my + 1.3, z0 + 4.0 - q * 2.5),
                             (mx - 0.3 + q * 0.2, my + 1.6, z0 + 1.0), (mx - 0.3 + q * 0.2, my + 1.4, z0 + 0.05), 10), 0.035,
                  "cable_rubber", seg=6)
    # roof swing column base (fixed to tilting platform)
    px, py = L.ROOF_SWING_PIVOT
    cyl(mb, (px, py, 7.25), (px, py, 12.9), 0.75, "steel_painted_grey", seg=32)
    lathe(mb, [(0.75, 7.25), (1.4, 7.25), (1.4, 7.45), (0.75, 7.6)], Xf(None, (px, py, 0)), "steel_dark", seg=32)
    for k in range(8):
        a = k * TAU / 8
        box(mb, (0.6, 0.05, 1.2), Xf(rot_z(a), (px + math.cos(a) * 1.05, py + math.sin(a) * 1.05, 7.95)), "steel_painted_grey")
    bolt_circle(mb, (px, py, 7.45), (0, 0, 1), 1.2, 16, 0.04, "steel_dark", washer=True)


# ---------------------------------------------------------------------- roof

def roof(ctx):
    rng = ctx["rng"]
    mb = MB("furnace_roof")
    z0 = L.ROOF_RING_Z + 0.16
    # roof ring (box section)
    lathe(mb, [(R - 0.2, z0), (R + 0.38, z0), (R + 0.38, z0 + 0.35), (R - 0.2, z0 + 0.35)], Xf(), "panel_cooled", seg=96)
    # cone of pipe coils from r=R+0.2 down to the delta
    rin, zin = 1.45, z0 + 1.25
    rout, zout = R + 0.15, z0 + 0.35
    slant = math.hypot(rout - rin, zin - zout)
    n = int(slant / 0.13)
    nsec = 6
    for sct in range(nsec):
        a0 = sct * TAU / nsec + 0.025
        a1 = (sct + 1) * TAU / nsec - 0.025
        for k in range(n):
            t = (k + 0.5) / n
            r = rout + (rin - rout) * t
            z = zout + (zin - zout) * t
            torus(mb, Xf(None, (0, 0, z)), r, 0.058, "panel_cooled", seg=max(6, int(r * 5)), rseg=6, arc=(a0, a1))
        # radial headers between sectors
        a = (sct + 1) * TAU / nsec
        p0 = pol(rout + 0.1, a, zout + 0.05)
        p1 = pol(rin, a, zin + 0.05)
        cyl(mb, p0, p1, 0.1, "panel_cooled", seg=10)
        flange(mb, p0 + (p1 - p0) * 0.15, p1 - p0, 0.1, "steel_dark", seg=10, bolts=6)
        # hose jumpers from ring main to headers
        pm = pol(R + 0.5, a + 0.12, z0 + 0.7)
        sweep(mb, bezier(p0 + v3(0, 0, 0.1), p0 + v3(0, 0, 0.7), pm + v3(0, 0, 0.6), pm, 10), 0.05, "cable_rubber", seg=8)
    # cone backing (under pipes, dark)
    lathe(mb, [(rout, zout - 0.04), (rin, zin - 0.04)], Xf(), "steel_dark", seg=64)
    # roof ring mains
    torus(mb, Xf(None, (0, 0, z0 + 0.7)), R + 0.5, 0.13, "pipe_green", seg=64, rseg=8)
    torus(mb, Xf(None, (0, 0, z0 + 0.45)), R + 0.55, 0.11, "steel_primer_red", seg=64, rseg=8)
    for k in range(12):
        a = k * TAU / 12
        box(mb, (0.3, 0.06, 0.5), Xf(rot_z(a), pol(R + 0.42, a, z0 + 0.55)), "steel_dark")
    # delta (refractory precast) + electrode ports
    lathe(mb, [(rin + 0.05, zin - 0.05), (rin - 0.05, zin + 0.35), (0.0, zin + 0.42)], Xf(), "refractory", seg=48, nz=0.01)
    torus(mb, Xf(None, (0, 0, zin)), rin + 0.03, 0.09, "panel_cooled", seg=48, rseg=8)
    for (ex, ey) in L.ELEC_XY:
        lathe(mb, [(L.ELEC_R + 0.14, zin + 0.40), (L.ELEC_R + 0.01, zin + 0.41)], Xf(None, (ex, ey, 0)), "refractory_hot", seg=24)
        torus(mb, Xf(None, (ex, ey, zin + 0.52)), L.ELEC_R + 0.2, 0.08, "copper_busbar", seg=24, rseg=8)
        lathe(mb, [(L.ELEC_R + 0.12, zin + 0.4), (L.ELEC_R + 0.3, zin + 0.42), (L.ELEC_R + 0.3, zin + 0.5), (L.ELEC_R + 0.12, zin + 0.5)],
              Xf(None, (ex, ey, 0)), "panel_cooled", seg=24)
    # fourth hole collar + water-cooled elbow
    fx, fy = L.FOURTH_HOLE
    zc = zout + (zin - zout) * ((rout - math.hypot(fx, fy)) / (rout - rin))
    cyl(mb, (fx, fy, zc - 0.2), (fx, fy, zc + 0.55), 1.0, "panel_cooled", seg=32)
    torus(mb, Xf(None, (fx, fy, zc + 0.55)), 1.0, 0.09, "panel_cooled", seg=32, rseg=6)
    duct_end_x = -6.6
    elbow = [(fx, fy, zc + 0.5), (fx, fy, 15.6), (fx - 1.0, fy, 16.4), (duct_end_x, fy * 0.3, 16.4)]
    sweep(mb, elbow, 0.92, "panel_cooled", seg=28, bend=1.6, nseg=10, caps=False)
    # coil rings along the elbow
    from util import fillet_path
    pts = fillet_path(elbow, 1.6, 10)
    acc = 0.0
    last = None
    for i in range(len(pts) - 1):
        a, b = v3(pts[i]), v3(pts[i + 1])
        L_ = np.linalg.norm(b - a)
        d = norm(b - a)
        s = 0.0
        while s < L_:
            if acc + s > 0.3 and (last is None or acc + s - last > 0.22):
                torus(mb, Xf(frame(d), a + d * s), 0.97, 0.05, "panel_cooled", seg=24, rseg=5)
                last = acc + s
            s += 0.05
        acc += L_
    # elbow end sleeve
    cyl(mb, (duct_end_x + 0.3, fy * 0.3, 16.4), (duct_end_x - 0.05, fy * 0.3, 16.4), 1.08, "steel_heat", seg=28)
    # swing column head + gantry arms + hangers
    px, py = L.ROOF_SWING_PIVOT
    cyl(mb, (px, py, 12.9), (px, py, 15.2), 0.95, "steel_painted_grey", seg=32)
    lathe(mb, [(0.0, 15.2), (1.2, 15.2), (1.2, 15.75), (0.0, 15.75)], Xf(None, (px, py, 0)), "steel_painted_grey", seg=32)
    bolt_circle(mb, (px, py, 15.75), (0, 0, 1), 1.05, 20, 0.045, "steel_dark", washer=True)
    hang = [pol(R + 0.1, 160 * D2R, z0 + 0.35), pol(R + 0.1, 290 * D2R, z0 + 0.35), pol(R + 0.1, 45 * D2R, z0 + 0.35)]
    col = v3(px, py, 15.45)
    for h in hang[:2]:
        tip = v3(h[0], h[1], 15.45)
        beam(mb, col, tip, 0.65, 0.95, "steel_painted_yellow", chamfer=0.06)
        # stiffener ribs on the arm sides
        d = norm(tip - col)
        side = np.cross(v3(0, 0, 1), d)
        Lg = np.linalg.norm(tip - col)
        for s in np.arange(1.4, Lg - 0.2, 1.1):
            for sd in (-1, 1):
                box(mb, (0.03, 0.03, 0.85), Xf(frame(d), col + d * s + side * sd * 0.335), "steel_painted_yellow")
    beam(mb, v3(hang[0][0], hang[0][1], 15.45), v3(hang[1][0], hang[1][1], 15.45), 0.4, 0.6, "steel_painted_yellow", chamfer=0.04)
    for h in hang:
        top = v3(h[0], h[1], 15.0 if h is not hang[2] else 15.2)
        cyl(mb, h + v3(0, 0, 0.15), top, 0.06, "steel_worn", seg=8)
        box(mb, (0.4, 0.25, 0.4), Xf(None, h + v3(0, 0, 0.2)), "steel_dark")
        # turnbuckle
        cyl(mb, (h + top) / 2 - v3(0, 0, 0.25), (h + top) / 2 + v3(0, 0, 0.25), 0.1, "steel_dark", seg=8)
    beam(mb, col, v3(hang[2][0], hang[2][1], 15.45), 0.5, 0.6, "steel_painted_yellow", chamfer=0.05)
    return mb, z0


# ----------------------------------------------------------------- electrodes

def electrode(ctx, i):
    ex, ey = L.ELEC_XY[i]
    mx, my = L.MAST_XY[i]
    mb = MB(f"electrode_{i + 1}")
    az = L.ARM_Z
    # graphite string: tip (hot, eroded), warm zone above the delta, cold top with joints
    tip = L.TIP_Z
    rr = L.ELEC_R
    lathe(mb, [(0.0, tip), (rr * 0.7, tip + 0.03), (rr * 0.88, tip + 0.18), (rr * 0.93, tip + 0.9),
               (rr * 0.97, 13.0), (rr, 14.6)], Xf(None, (ex, ey, 0)), "graphite_hot", seg=24)
    lathe(mb, [(rr, 14.6), (rr, 15.6)], Xf(None, (ex, ey, 0)), "graphite_warm", seg=24)
    top = az + 2.3
    lathe(mb, [(rr, 15.6), (rr, top - 0.05), (rr - 0.04, top), (0.0, top)], Xf(None, (ex, ey, 0)), "graphite", seg=24)
    for zj in (12.2, 15.0, 17.8 + 0.4 * i):
        if zj < top - 0.2:
            torus(mb, Xf(None, (ex, ey, zj)), rr + 0.004, 0.012, "steel_dark", seg=24, rseg=4)
    # clamp head (steel + copper contact pads) on the electrode
    ch0, ch1 = az - 0.65, az + 0.45
    lathe(mb, [(rr + 0.02, ch0), (rr + 0.28, ch0), (rr + 0.3, ch0 + 0.1), (rr + 0.3, ch1 - 0.1), (rr + 0.28, ch1), (rr + 0.02, ch1)],
          Xf(None, (ex, ey, 0)), "copper_busbar", seg=24)
    torus(mb, Xf(None, (ex, ey, ch1 - 0.12)), rr + 0.33, 0.05, "hose_red", seg=24, rseg=6)
    # arm: current-conducting box arm from mast to clamp
    d = norm(v3(ex - mx, ey - my, 0))
    e = v3(ex, ey, az)
    m = v3(mx, my, az)
    rear = m - d * 1.35
    front = e - d * (rr + 0.25)
    beam(mb, rear, front, 0.56, 0.78, "copper_busbar", chamfer=0.05)
    side = np.cross(v3(0, 0, 1), d)
    # side insulation / wear plates + bolts along arm
    La = np.linalg.norm(front - rear)
    for s in np.arange(0.4, La - 0.3, 0.55):
        for sd in (-1, 1):
            p = rear + d * s + side * sd * 0.285
            hexbolt(mb, p + v3(0, 0, 0.22), side * sd, 0.03, "steel_dark")
            hexbolt(mb, p - v3(0, 0, 0.22), side * sd, 0.03, "steel_dark")
    # clamp spring housing on top of arm near the electrode
    cyl(mb, front - d * 0.6 + v3(0, 0, 0.39), front - d * 0.6 + v3(0, 0, 0.95), 0.2, "steel_painted_grey", seg=16)
    cyl(mb, front - d * 0.6 + v3(0, 0, 0.95), front - d * 0.6 + v3(0, 0, 1.02), 0.24, "steel_dark", seg=16)
    beam(mb, front - d * 0.6 + v3(0, 0, 0.7), e + v3(0, 0, 0.35), 0.18, 0.18, "steel_dark")
    # water pipes along the top of the arm
    for sd in (-0.14, 0.14):
        pipe_run(mb, [rear + v3(0, 0, 0.44) + side * sd, front + v3(0, 0, 0.44) + side * sd - d * 0.2,
                      front + v3(0, 0, 0.1) + side * sd + d * 0.05], 0.035, "steel_worn", bend=0.1, seg=8, flange_every=0)
    # cable terminal block at the rear end
    box(mb, (0.9, 0.65, 0.9), Xf(frame(d, (0, 0, 1)), rear - d * 0.1), "copper_busbar")
    for k in range(4):
        off = side * (-0.33 + k * 0.22)
        cyl(mb, rear - d * 0.35 + off - v3(0, 0, 0.3), rear - d * 0.35 + off - v3(0, 0, 0.75), 0.085, "copper_busbar", seg=10)
    # insulated joint arm/mast
    box(mb, (0.95, 0.95, 0.12), Xf(None, m + v3(0, 0, -0.45)), "paint_black")
    # mast column (moves with the arm) down into the guide
    box_minmax(mb, (mx - 0.42, my - 0.42, 9.6), (mx + 0.42, my + 0.42, az - 0.4), "steel_painted_grey")
    for z in np.arange(10.0, az - 0.6, 0.9):
        for sd in (-1, 1):
            box(mb, (0.86, 0.05, 0.04), Xf(None, (mx, my + sd * 0.42, z)), "steel_dark")
    box_minmax(mb, (mx - 0.5, my - 0.5, az - 0.42), (mx + 0.5, my + 0.5, az - 0.38), "steel_dark")
    return mb


# --------------------------------------------------------- static surroundings

RX = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], dtype=float)   # local x -> Y, y -> Z, z (extrusion) -> X


def rocker_pier(mb, y, s, rng):
    """Concrete rocker pier: stepped footing, chamfered shaft with form-tie holes and pour joints, an irregular grout
    pad, a sole plate held by anchor bolts (washer, nut, stud), the embedded rocker rail between keeper bars with
    clamp plates, the tooth rack the rocker teeth engage, and buffer stops at both ends."""
    zt = L.ROCKER_RAIL_Z - 0.3                                  # pier top (grout underside)
    # footing steps out on the outboard side only (the ladle-car rails pass 0.1 m inboard)
    foot = [(-0.9 * s, 0.0), (1.3 * s, 0.0), (1.3 * s, 0.5), (1.18 * s, 0.62), (-0.9 * s, 0.62)]
    prism(mb, foot, 10.8, Xf(RX, (-5.4, y, 0.0)), "concrete")
    shaft = [(-0.8, 0.62), (0.8, 0.62), (0.8, zt - 0.07), (0.73, zt), (-0.73, zt), (-0.8, zt - 0.07)]
    prism(mb, shaft, 9.2, Xf(RX, (-4.6, y, 0.0)), "concrete")
    for sd in (-1, 1):                                          # both long faces
        yf = y + sd * 0.803
        for zj in (1.95, 3.25, 4.45):                           # pour joints
            box_minmax(mb, (-4.6, yf - 0.004, zj - 0.012), (4.6, yf + 0.004, zj + 0.012), "slag_cold")
        for xx in np.arange(-4.05, 4.1, 0.9):                   # form-tie cones
            for zz in (1.3, 2.6, 3.85):
                disk(mb, (xx, yf + sd * 0.002, zz), 0.024, "slag_cold", seg=8, normal=(0, sd, 0))
    # grout pad with a ragged edge
    pts = []
    for (x0, y0), (x1, y1) in (((-4.55, -0.6), (4.55, -0.6)), ((4.55, -0.6), (4.55, 0.6)), ((4.55, 0.6), (-4.55, 0.6)),
                               ((-4.55, 0.6), (-4.55, -0.6))):
        n = max(2, int(math.hypot(x1 - x0, y1 - y0) / 0.35))
        nx, ny = (y1 - y0), -(x1 - x0)
        ln = math.hypot(nx, ny)
        for k in range(n):
            t = k / n
            j = 0.015 + 0.02 * (math.sin(k * 2.3 + x0) * 0.5 + 0.5)
            pts.append((x0 + (x1 - x0) * t + nx / ln * j, y0 + (y1 - y0) * t + ny / ln * j))
    prism(mb, [(px, py) for px, py in pts], 0.05, Xf(None, (0, y, zt)), "concrete", cap0=False)
    zp = zt + 0.05
    box_minmax(mb, (-4.4, y - 0.5, zp), (4.4, y + 0.5, zp + 0.08), "steel_dark")                 # sole plate
    zp += 0.08
    for xx in np.arange(-4.1, 4.15, 0.82):                      # anchor bolts both sides
        for sd in (-1, 1):
            c = v3(xx, y + sd * 0.42, zp)
            cyl(mb, c, c + v3(0, 0, 0.012), 0.055, "steel_worn", seg=12, cap0=False)
            hexbolt(mb, c + v3(0, 0, 0.012), (0, 0, 1), 0.042, "steel_dark", h=0.045)
            cyl(mb, c + v3(0, 0, 0.05), c + v3(0, 0, 0.12), 0.022, "steel_worn", seg=8, cap0=False)
    # rail: flat rolling bar with chamfered head, keeper bars and clamp plates
    rail = [(-0.25, 0.0), (0.25, 0.0), (0.25, L.ROCKER_RAIL_Z - zp - 0.025), (0.225, L.ROCKER_RAIL_Z - zp),
            (-0.225, L.ROCKER_RAIL_Z - zp), (-0.25, L.ROCKER_RAIL_Z - zp - 0.025)]
    prism(mb, rail, 8.8, Xf(RX, (-4.4, y, zp)), "steel_worn")
    for sd in (-1, 1):
        box_minmax(mb, (-4.4, y + sd * 0.25 - (0.05 if sd < 0 else 0), zp), (4.4, y + sd * 0.25 + (0.05 if sd > 0 else 0), zp + 0.07),
                   "steel_dark")
        for xx in np.arange(-4.05, 4.1, 0.7):
            box_minmax(mb, (xx - 0.07, y + sd * 0.19 - 0.06, zp + 0.07), (xx + 0.07, y + sd * 0.19 + 0.06, zp + 0.095), "steel_dark")
            hexbolt(mb, (xx, y + sd * 0.2, zp + 0.095), (0, 0, 1), 0.028, "steel_worn")
    # tooth rack outboard of the rail (the rocker's teeth run at y + s*0.34)
    yr = y + s * 0.34
    box_minmax(mb, (-4.4, yr - 0.09, zp), (4.4, yr + 0.09, zp + 0.08), "steel_dark")
    tooth = [(-0.065, 0.0), (0.065, 0.0), (0.03, 0.1), (-0.03, 0.1)]
    Ry = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=float)   # profile in XZ, extruded along -Y
    for xx in np.arange(-4.2, 4.3, 0.28):
        prism(mb, tooth, 0.16, Xf(Ry, (xx, yr + 0.08, zp + 0.08)), "steel_worn", cap0=True)
    # buffer stops at the rail ends
    for sx in (-1, 1):
        box_minmax(mb, (sx * 4.4 - (0.3 if sx > 0 else 0.0), y - 0.45, zp), (sx * 4.4 + (0.0 if sx > 0 else 0.3), y + 0.45, zp + 0.55),
                   "steel_painted_yellow")
        box_minmax(mb, (sx * 4.1 - (0.1 if sx > 0 else 0.0), y - 0.25, zp + 0.18), (sx * 4.1 + (0.0 if sx > 0 else 0.1), y + 0.25, zp + 0.45),
                   "rubber_belt")


LANCE_TIP = v3(-3.85, 0.3, 9.35)       # lance nozzles, reaching INTO the slag door opening (past the frame, above the sill)
LANCE_HEAD = v3(-9.2, 2.2, L.DECK_Z + 2.3)


def lance_axes():
    d = norm(LANCE_TIP - (LANCE_HEAD + v3(0, 0, 0.45)))      # lances run 0.45 m above the boom pivot line
    side = norm(np.cross(v3(0, 0, 1), d))
    return d, side, np.cross(d, side)


def lance_manipulator(ctx):
    """Slag-door oxygen lance manipulator: base frame and slewing ring on the deck, column, luffing yoke and cylinder,
    box boom with carriage rails, supply pipes and hose loops (static); the carriage with two water-cooled lances
    is the part `lance_carriage` (it slides along the boom)."""
    z = L.DECK_Z
    bx, by = LANCE_HEAD[0], LANCE_HEAD[1]
    d, side, upv = lance_axes()
    head = LANCE_HEAD
    st = MB("furnace_lance")
    box_minmax(st, (bx - 0.8, by - 0.8, z), (bx + 0.8, by + 0.8, z + 0.28), "steel_painted_blue")
    for sx in (-0.68, 0.68):
        for sy in (-0.68, 0.68):
            hexbolt(st, (bx + sx, by + sy, z + 0.28), (0, 0, 1), 0.04, "steel_dark", washer=True)
    cyl(st, (bx, by, z + 0.28), (bx, by, z + 0.42), 0.64, "steel_dark", seg=32)
    bolt_circle(st, (bx, by, z + 0.42), (0, 0, 1), 0.56, 16, 0.028, "steel_worn")
    cyl(st, (bx, by, z + 0.42), (bx, by, head[2] - 0.35), 0.4, "steel_painted_blue", seg=24)
    for k in range(6):                                         # column ribs
        a = k * TAU / 6 + 0.3
        box(st, (0.2, 0.03, 0.9), Xf(rot_z(a), (bx + math.cos(a) * 0.5, by + math.sin(a) * 0.5, z + 0.9)), "steel_painted_blue", cap0=False)
    box(st, (0.42, 0.36, 0.36), Xf(None, (bx + 0.62, by - 0.2, z + 0.62)), "steel_painted_blue")        # slew drive
    cyl(st, (bx + 0.62, by - 0.2, z + 0.8), (bx + 0.62, by - 0.2, z + 1.3), 0.14, "steel_painted_grey", seg=16, cap0=False)
    # head yoke: turntable + two cheek plates around the boom + pivot pin
    cyl(st, (bx, by, head[2] - 0.35), (bx, by, head[2] - 0.22), 0.52, "steel_dark", seg=24)
    for sd in (-1, 1):
        c = head + side * sd * 0.3 - v3(0, 0, 0.05)
        Rk = np.stack([side, norm(np.cross(v3(0, 0, 1), side)), v3(0, 0, 1)], axis=1)
        box(st, (0.06, 0.62, 0.72), Xf(Rk, c), "steel_painted_blue")
    cyl(st, head - side * 0.42, head + side * 0.42, 0.085, "steel_worn", seg=16)
    # boom (box girder) along the lance axis, carriage rails on top, side stiffeners, counterweight
    b0, b1 = head - d * 1.7, LANCE_TIP - d * 1.35 - upv * 0.45
    beam(st, b0, b1, 0.4, 0.46, "steel_painted_blue", up=upv, chamfer=0.035)
    Lb = float(np.linalg.norm(b1 - b0))
    for sd in (-1, 1):
        beam(st, b0 + upv * 0.255 + side * sd * 0.14, b1 + upv * 0.255 + side * sd * 0.14, 0.05, 0.05, "steel_worn", up=upv)
        for t in np.arange(0.5, Lb - 0.2, 0.75):
            box(st, (0.02, 0.4, 0.03), Xf(frame(d, upv) @ rot_x(math.pi / 2), b0 + d * t + side * sd * 0.205), "steel_painted_blue")
    box(st, (0.55, 0.6, 0.7), Xf(frame(d, upv), b0 - d * 0.1 - upv * 0.05), "steel_dark")
    # luffing cylinder: column bracket -> boom underside
    c0 = v3(bx, by, z + 1.05) - v3(d[0], d[1], 0) * 0.42
    c1 = head + d * 1.25 - upv * 0.24
    box(st, (0.3, 0.3, 0.25), Xf(None, c0), "steel_dark")
    dc = norm(c1 - c0)
    Lc = float(np.linalg.norm(c1 - c0))
    cyl(st, c0, c0 + dc * Lc * 0.62, 0.1, "steel_painted_yellow", seg=16)
    cyl(st, c0 + dc * Lc * 0.6, c1, 0.045, "steel_worn", seg=12)
    box(st, (0.22, 0.2, 0.16), Xf(frame(d, upv), c1 + upv * 0.03), "steel_dark")
    # supply: water in/out + oxygen up the column rear to a manifold, hose loops to the carriage chain
    rear = v3(bx, by, 0) - v3(d[0], d[1], 0) * 0.55
    for k, (mat, off) in enumerate((("pipe_green", -0.16), ("steel_primer_red", 0.0), ("steel_painted_blue", 0.16))):
        p0 = v3(rear[0] + side[0] * off, rear[1] + side[1] * off, z + 0.05)
        pipe_run(st, [p0, p0 + v3(0, 0, 1.55)], 0.04, mat, seg=10, flange_every=0.9)
    man = v3(rear[0], rear[1], z + 1.7)
    box(st, (0.5, 0.25, 0.22), Xf(rot_z(math.atan2(side[1], side[0])), man), "steel_dark")
    # energy chain lower run lies on the boom top (static half; the upper run rides the carriage)
    ch0 = b0 + d * 0.4 + upv * 0.3
    beam(st, ch0, ch0 + d * 2.2, 0.16, 0.08, "paint_black", up=upv)
    for k, (mat, off) in enumerate((("hose_red", -0.06), ("cable_rubber", 0.06))):
        p0 = man + side * off + v3(0, 0, 0.12)
        p3 = ch0 + side * off + upv * 0.06
        sweep(st, bezier(p0, p0 + v3(0, 0, 0.9), p3 - d * 0.9 + v3(0, 0, 0.5), p3, 12), 0.035, mat, seg=8)
    # ---- carriage part: trolley, lance clamps, two water-cooled lances, swivel heads, energy-chain upper run
    car = MB("lance_carriage")
    cc = head + d * 0.5 + upv * 0.45
    Rc = frame(d, upv)
    box(car, (0.46, 0.34, 0.75), Xf(Rc, cc), "steel_painted_grey")
    for sd in (-1, 1):
        for t in (-0.26, 0.26):
            w = cc + d * t + side * sd * 0.14 - upv * 0.17
            cyl(car, w - side * sd * 0.03, w + side * sd * 0.05, 0.055, "steel_dark", seg=12)
    for t in (-0.2, 0.3):                                       # clamp blocks
        box(car, (0.4, 0.1, 0.14), Xf(Rc, cc + d * t + upv * 0.2), "steel_dark")
        for sd in (-1, 1):
            hexbolt(car, cc + d * t + upv * 0.27 + side * sd * 0.15, upv, 0.03, "steel_worn")
    for sd in (-1, 1):
        a = cc + upv * 0.2 + side * sd * 0.09 - d * 0.55
        tip = LANCE_TIP + side * sd * 0.09
        cyl(car, a, tip - d * 0.9, 0.06, "steel_worn", seg=16)
        cyl(car, tip - d * 0.9, tip - d * 0.18, 0.06, "steel_heat", seg=16, cap0=False)
        cyl(car, tip - d * 0.18, tip, 0.068, "copper_busbar", seg=16, cap0=False, cap1=False)
        lathe(car, [(0.068, 0.0), (0.05, 0.04), (0.0, 0.045)], Xf(frame(d), tip), "graphite_warm", seg=16)
        L_ = float(np.linalg.norm(tip - a))
        for t in np.arange(0.9, L_ - 1.0, 1.6):                  # couplings
            cyl(car, a + d * t, a + d * (t + 0.12), 0.078, "steel_dark", seg=16)
        # swivel head with O2 + water in/out couplings at the back
        box(car, (0.16, 0.16, 0.22), Xf(Rc, a - d * 0.1), "steel_dark")
        for q, mat in enumerate(("hose_red", "cable_rubber", "cable_rubber")):
            h0 = a - d * 0.2 + upv * (0.02 + 0.05 * q) + side * sd * 0.03
            h3 = cc - d * 0.9 + upv * 0.1 + side * (sd * 0.05)
            sweep(car, bezier(h0, h0 - d * 0.35 + upv * 0.1, h3 + upv * 0.35, h3, 8), 0.022, mat, seg=8)
    # energy chain upper run + 180-degree loop back down to the static lower run
    loop_c = cc - d * 0.95 - upv * 0.05
    pts = [cc - d * 0.45 + upv * 0.08, loop_c + upv * 0.13]
    for a_ in np.linspace(0.0, math.pi, 7)[1:]:
        pts.append(loop_c - d * math.sin(a_) * 0.13 + upv * math.cos(a_) * 0.13)
    sweep_profile(car, pts, [(-0.08, -0.04), (0.08, -0.04), (0.08, 0.04), (-0.08, 0.04)], "paint_black", up=side, uv_len=False)
    return st, car, cc


def deck(ctx):
    rng = ctx["rng"]
    mb = MB("furnace_deck")
    z = L.DECK_Z
    t = 0.3
    # deck slabs (steel plate on beams), leaving the furnace pit, tap tunnel and slag pit
    slabs = [
        (-15.0, -13.0, 12.0, -5.6),     # pulpit side
        (-15.0, -5.6, -10.4, 11.0),     # slag side outer
        (-10.4, 2.8, -6.3, 11.0),       # slag side, beside pit
        (-10.4, -5.6, -6.3, -2.8),
        (6.3, -5.6, 12.0, -2.2),        # tap side (tunnel below)
        (6.3, 2.2, 12.0, 11.0),
        (-6.3, 9.8, 6.3, 11.0),         # strip at the vault
    ]
    for x0, y0, x1, y1 in slabs:
        box_minmax(mb, (x0, y0, z - 0.03), (x1, y1, z), "steel_chequer")
        # plate seams: raised weld beads (thin strips)
        for xx in np.arange(x0 + 2.0, x1, 2.0):
            box_minmax(mb, (xx - 0.01, y0, z), (xx + 0.01, y1, z + 0.006), "steel_worn")
        # beams below
        for xx in np.arange(x0 + 0.1, x1, 2.0):
            ibeam(mb, (xx, y0, z - 0.33), (xx, y1, z - 0.33), 0.6, 0.3, "steel_painted_grey")
        for yy in (y0 + 0.15, y1 - 0.15):
            ibeam(mb, (x0, yy, z - 0.45), (x1, yy, z - 0.45), 0.8, 0.35, "steel_painted_grey")
    # tap tunnel bridge over the ladle rails (grating deck)
    grating(mb, (6.3, -2.2), (12.0, 2.2), z, along="x")
    # concrete support columns
    for x in (-14.4, -10.0, -6.8, 6.8, 11.4):
        for y in (-12.4, -6.0, 3.4, 10.4):
            if (6.0 < x < 12.0) and abs(y) < 2.5:
                continue
            box_minmax(mb, (x - 0.5, y - 0.5, 0), (x + 0.5, y + 0.5, z - 0.8), "concrete")
            box_minmax(mb, (x - 0.6, y - 0.6, z - 0.8), (x + 0.6, y + 0.6, z - 0.6), "steel_dark")
    for y in (-2.6, 2.6):
        for x in (7.0, 11.4):
            box_minmax(mb, (x - 0.45, y - 0.45, 0), (x + 0.45, y + 0.45, z - 0.8), "concrete")
    # handrails around openings and outer edges
    hr = [
        [(-6.3, -5.6), (-6.3, -2.8), (-10.4, -2.8), (-10.4, 2.8), (-6.3, 2.8), (-6.3, 9.8)],
        [(6.3, -5.6), (6.3, -2.2)], [(6.3, 2.2), (6.3, 9.8)],
        [(-6.3, -5.6), (6.3, -5.6)],
        [(-15.0, -13.0), (12.0, -13.0), (12.0, 11.0)],
    ]
    for pl in hr:
        handrail(mb, [(x, y, z) for x, y in pl], mat="steel_painted_yellow")
    # rocker foundation piers + rocker rails with rack
    for s in (-1, 1):
        y = s * L.ROCKER_Y
        rocker_pier(mb, y, s, rng)
        # tilt cylinders from floor pedestal to cradle
        box_minmax(mb, (-6.4, s * 4.3 - 0.5, 0), (-5.2, s * 4.3 + 0.5, 1.6), "concrete")
        cyl(mb, (-5.8, s * 4.3, 1.6), (-4.8, s * 4.3, 4.7), 0.3, "steel_painted_yellow", seg=16)
        cyl(mb, (-4.8, s * 4.3, 4.7), (-4.45, s * 4.3, 6.3), 0.15, "steel_worn", seg=12)
    # SLAG TROUGH under the door: a steel U-channel with crusted rims and cross ribs, a molten
    # stream running down it (loom flows slag_hot downhill and surges it on the beat), falling
    # off the lip into the slag pot below. (The RNG draws of the lumps this replaced are consumed.)
    for k in range(30):
        rng.random(); rng.uniform(0, 1); rng.uniform(0, 1); rng.uniform(0, 1); rng.uniform(0, 1); rng.uniform(0, 1)
    top, lip = v3(-5.15, 0.0, 8.3), v3(-7.9, 0.0, 4.4)
    run = [top + (lip - top) * (k / 16.0) for k in range(17)]
    fall_dir = norm(lip - top)
    plate_up = norm(np.cross(np.cross(fall_dir, v3(0, 0, 1)), fall_dir))
    channel = [(-0.95, 0.42), (-0.95, 0.0), (0.95, 0.0), (0.95, 0.42), (0.85, 0.42), (0.85, 0.1), (-0.85, 0.1), (-0.85, 0.42)]
    sweep_profile(mb, run, channel, "steel_heat", up=tuple(plate_up), uv_len=True)
    for side in (-1, 1):
        rim = [q + v3(0, side * 0.9, 0) + plate_up * 0.44 for q in run]
        sweep_profile(mb, rim, [(-0.08, -0.03), (0.08, -0.03), (0.08, 0.05), (-0.08, 0.05)], "slag_cold", up=tuple(plate_up), uv_len=True)
    stream = [(-0.72, 0.12), (-0.4, 0.2), (0.4, 0.2), (0.72, 0.12), (0.72, 0.13), (-0.72, 0.13)]
    sweep_profile(mb, run, stream, "slag_hot", up=tuple(plate_up), uv_len=True)
    # the fall off the lip into the pot: a narrowing ribbon of slag
    fall = [lip + fall_dir * 0.25 + v3(-0.05 * k * k, 0, -0.3 * k) for k in range(5)]
    sweep_profile(mb, fall, [(-0.35, -0.05), (0.35, -0.05), (0.2, 0.05), (-0.2, 0.05)], "slag_hot", up=(1, 0, 0), uv_len=True)
    for k in range(1, 8):
        c = top + (lip - top) * (k / 8.0) - plate_up * 0.05
        beam(mb, c + v3(0, -1.05, 0), c + v3(0, 1.05, 0), 0.14, 0.2, "steel_dark", up=tuple(plate_up))
    for side in (-1, 1):
        for t in (0.3, 0.7):
            c = top + (lip - top) * t + v3(0, side * 0.9, 0)
            beam(mb, c - plate_up * 0.1, v3(c[0], c[1], 0.0), 0.22, 0.22, "steel_painted_grey")
    # slag pit walls + floor crust
    box_minmax(mb, (-10.4, -2.8, 0), (-10.1, 2.8, 3.0), "concrete")
    for k in range(60):
        p = v3(rng.uniform(-10, -6.4), rng.uniform(-2.6, 2.6), 0.02)
        s = rng.uniform(0.2, 0.8)
        lump(mb, p, (s, s * rng.uniform(0.5, 1.5), rng.uniform(0.05, 0.3)), "slag_cold", rng, seg=10, rings=5, rough=0.3, crack=0.08)
    return mb


def vault(ctx):
    rng = ctx["rng"]
    mb = MB("furnace_vault")
    x0, x1, y0, y1 = L.VAULT
    z0, z1 = L.DECK_Z, 18.6
    # walls (front wall with cable penetration openings), roof slab
    box_minmax(mb, (x0, y0, z0), (x0 + 0.4, y1, z1), "concrete")
    box_minmax(mb, (x1 - 0.4, y0, z0), (x1, y1, z1), "concrete")
    box_minmax(mb, (x0, y0, z1 - 0.4), (x1, y1, z1), "concrete")
    fy = y0
    open_z0, open_z1 = 13.6, 15.4
    box_minmax(mb, (x0, fy, z0), (x1, fy + 0.4, open_z0), "concrete")
    box_minmax(mb, (x0, fy, open_z1), (x1, fy + 0.4, z1), "concrete")
    posts = [x0, -3.6, -1.25, 1.25, 3.6, x1]
    for k in range(len(posts) - 1):
        if k in (0, 4):
            box_minmax(mb, (posts[k], fy, open_z0), (posts[k + 1], fy + 0.4, open_z1), "concrete")
    for xp in (-1.25, 1.25):
        box_minmax(mb, (xp - 0.2, fy, open_z0), (xp + 0.2, fy + 0.4, open_z1), "concrete")
    # dark interior + transformer tank silhouette visible through openings
    box_minmax(mb, (x0 + 0.4, fy + 0.4, z0), (x1 - 0.4, y1, z1 - 0.4), "paint_black")
    # cable terminal plates on the opening with busbar stubs
    for i, (mx, my) in enumerate(L.MAST_XY):
        cxp = [-2.5, 0.0, 2.5][i]
        box_minmax(mb, (cxp - 1.0, fy - 0.12, open_z0 + 0.1), (cxp + 1.0, fy + 0.05, open_z1 - 0.1), "steel_dark")
        for k in range(4):
            xx = cxp - 0.66 + k * 0.44
            cyl(mb, (xx, fy + 0.1, 14.5), (xx, fy - 0.55, 14.5), 0.07, "copper_busbar", seg=10)
            box(mb, (0.2, 0.3, 0.24), Xf(None, (xx, fy - 0.6, 14.5)), "copper_busbar")
            for bz in (-0.08, 0.08):
                hexbolt(mb, (xx + 0.1, fy - 0.6, 14.5 + bz), (1, 0, 0), 0.025, "steel_dark")
    # ventilation louvre grilles
    for xc in (-5.2, 5.2):
        for zc in (8.4, 11.2):
            box_minmax(mb, (xc - 0.9, fy - 0.05, zc - 0.9), (xc + 0.9, fy + 0.02, zc + 0.9), "steel_dark")
            for k in range(9):
                beam(mb, (xc - 0.85, fy - 0.1, zc - 0.8 + k * 0.2), (xc + 0.85, fy - 0.1, zc - 0.8 + k * 0.2), 0.16, 0.02,
                     "steel_galvanized", up=(0, -1, 1.2))
    # steel door + frame
    box_minmax(mb, (-0.8 - 3.0, fy - 0.08, z0), (0.8 - 3.0, fy, z0 + 2.3), "steel_painted_grey")
    box_minmax(mb, (-0.95 - 3.0, fy - 0.12, z0 + 2.3), (0.95 - 3.0, fy, z0 + 2.45), "steel_dark")
    # pilasters, formwork joints, cable-hole steel frames, conduits and lamps on the face
    for xp in (x0 + 0.2, -4.9, 4.9, x1 - 0.2):
        box_minmax(mb, (xp - 0.35, fy - 0.35, z0), (xp + 0.35, fy + 0.05, z1), "concrete")
    for zj in np.arange(z0 + 1.2, z1, 1.2):
        box_minmax(mb, (x0, fy - 0.01, zj - 0.012), (x1, fy + 0.01, zj + 0.012), "slag_cold")
    for xj in np.arange(x0 + 1.4, x1, 2.4):
        box_minmax(mb, (xj - 0.012, fy - 0.01, z0), (xj + 0.012, fy + 0.01, z1), "slag_cold")
    box_minmax(mb, (-3.6 - 0.1, fy - 0.15, open_z0 - 0.15), (3.6 + 0.1, fy + 0.02, open_z0), "steel_dark")
    box_minmax(mb, (-3.6 - 0.1, fy - 0.15, open_z1), (3.6 + 0.1, fy + 0.02, open_z1 + 0.15), "steel_dark")
    for xc in (-6.3, -5.9, 5.6, 6.0, 6.4):
        cyl(mb, (xc, fy - 0.12, z0 + 0.2), (xc, fy - 0.12, z1 - 0.3), 0.04, "steel_galvanized", seg=6)
        for zc in np.arange(z0 + 1.0, z1, 1.5):
            box(mb, (0.12, 0.06, 0.05), Xf(None, (xc, fy - 0.08, zc)), "steel_dark")
    for xc in (-4.9, 4.9):
        box(mb, (0.5, 0.35, 0.3), Xf(None, (xc, fy - 0.5, 16.8)), "steel_dark")
        box(mb, (0.42, 0.02, 0.22), Xf(rot_x(0.5), (xc, fy - 0.68, 16.72)), "lamp")
        ctx.setdefault("fixtures", []).append(("furnace", "wall_pack", (xc, fy - 0.7, 16.71), tuple(rot_x(0.5) @ v3(0, -1, 0)), None))
    # hazard board + fire hose cabinet
    box_minmax(mb, (1.6, fy - 0.06, z0 + 1.2), (2.6, fy, z0 + 2.2), "steel_primer_red")
    box_minmax(mb, (-6.2, fy - 0.1, z0 + 0.9), (-5.3, fy, z0 + 1.9), "steel_painted_yellow")
    # transformer oil coolers on the roof (finned radiators)
    for xc in (-4.5, -1.5, 1.5, 4.5):
        for k in range(14):
            box_minmax(mb, (xc - 1.0, 12.4 + k * 0.2, z1), (xc + 1.0, 12.4 + k * 0.2 + 0.03, z1 + 2.4), "steel_painted_grey")
        cyl(mb, (xc - 1.1, 12.3, z1 + 2.5), (xc - 1.1, 15.3, z1 + 2.5), 0.1, "steel_painted_grey", seg=10)
        cyl(mb, (xc - 1.1, 12.3, z1 + 0.2), (xc - 1.1, 15.3, z1 + 0.2), 0.1, "steel_painted_grey", seg=10)
        cyl(mb, (xc + 1.1, 15.4, z1), (xc + 1.1, 15.4, z1 + 3.2), 0.18, "steel_painted_grey", seg=12)
    return mb


def cables(ctx):
    mb = MB("furnace_cables")
    y0 = L.VAULT[2]
    for i, (mx, my) in enumerate(L.MAST_XY):
        ex, ey = L.ELEC_XY[i]
        d = norm(v3(ex - mx, ey - my, 0))
        rear = v3(mx, my, L.ARM_Z) - d * 1.35
        side = np.cross(v3(0, 0, 1), d)
        cxp = [-2.5, 0.0, 2.5][i]
        for k in range(4):
            xx = cxp - 0.66 + k * 0.44
            p0 = v3(xx, y0 - 0.7, 14.5)
            p1 = rear - d * 0.35 + side * (-0.33 + k * 0.22) - v3(0, 0, 0.8)
            sag = 3.6 + 0.12 * k + 0.2 * i
            pts = [p0 + v3(0, -0.3, 0)] + catenary(p0 + v3(0, -0.6, -0.2), p1 + v3(0, 0, -0.3), sag, 22) + [p1]
            sweep(mb, pts, 0.075, "cable_rubber", seg=12, bend=0.3, nseg=4)
            # hose clamp bands along each cable
            for q in (0.2, 0.5, 0.8):
                c = catenary(p0 + v3(0, -0.6, -0.2), p1 + v3(0, 0, -0.3), sag, 22)[int(q * 22)]
                torus(mb, Xf(frame(v3(0, 1, 0)), c), 0.08, 0.02, "steel_worn", seg=10, rseg=4)
        # spreader bar holding the four cables at mid loop
        mid = (v3(cxp, y0 - 0.7, 14.5) + rear) / 2 - v3(0, 0, 3.2 + 0.2 * i)
        beam(mb, mid - v3(0.9, 0, 0), mid + v3(0.9, 0, 0), 0.12, 0.2, "steel_dark")
    return mb


def fume_duct(ctx):
    mb = MB("furnace_duct")
    fy = L.FOURTH_HOLE[1] * 0.3
    x0 = -6.95
    pts = [(x0, fy, 16.4), (-13.5, fy, 16.4), (-13.5, L.HY + 6.0, 16.4)]
    sweep(mb, pts, 1.15, "steel_heat", seg=32, bend=2.2, nseg=10, caps=False)
    # combustion gap sleeve + water-cooled ribs + flanges
    cyl(mb, (x0, fy, 16.4), (x0 - 1.2, fy, 16.4), 1.28, "panel_cooled", seg=32)
    for x in np.arange(x0 - 1.6, -12.2, 0.55):
        torus(mb, Xf(frame(v3(1, 0, 0)), (x, fy, 16.4)), 1.18, 0.05, "panel_cooled", seg=28, rseg=5)
    for yy in np.arange(3.0, L.HY, 3.0):
        flange(mb, (-13.5, yy, 16.4), (0, 1, 0), 1.15, "steel_dark", seg=32, bolts=24)
    for x in (-9.5,):
        flange(mb, (x, fy, 16.4), (1, 0, 0), 1.15, "steel_dark", seg=32, bolts=24)
    # hangers to the trusses / supports
    # duct support bents (portal frames from the floor / deck)
    for x, y, z0 in ((-11.3, fy, 0.0), (-13.5, 6.5, 0.0), (-13.5, 13.0, 0.0)):
        horiz = abs(y - fy) < 0.1
        for sd in (-1, 1):
            p = (x, y + sd * 1.6, 0.0) if horiz else (x + sd * 1.6, y, 0.0)
            ibeam(mb, p, (p[0], p[1], 15.2), 0.4, 0.3, "steel_painted_grey", up=(1, 0, 0))
        a = (x, y - 1.8, 15.25) if horiz else (x - 1.8, y, 15.25)
        b = (x, y + 1.8, 15.25) if horiz else (x + 1.8, y, 15.25)
        ibeam(mb, a, b, 0.5, 0.35, "steel_painted_grey")
        for sd in (-0.7, 0.7):
            c = (x, y + sd, 15.5) if horiz else (x + sd, y, 15.5)
            box(mb, (0.5, 0.5, 0.5), Xf(None, c), "steel_dark")
    # canopy hood above the furnace (pyramidal, ribbed) + its duct through the roof
    hz0, hz1 = L.TRUSS_Z - 0.6, L.TRUSS_Z + 3.2
    lo = 9.0
    hi = 1.6
    corners0 = [(-lo, -lo), (lo, -lo), (lo, lo), (-lo, lo)]
    corners1 = [(-hi, -hi), (hi, -hi), (hi, hi), (-hi, hi)]
    for k in range(4):
        a0, a1 = corners0[k], corners0[(k + 1) % 4]
        b0, b1 = corners1[k], corners1[(k + 1) % 4]
        V = np.array([(a0[0], a0[1], hz0), (a1[0], a1[1], hz0), (b1[0], b1[1], hz1), (b0[0], b0[1], hz1)])
        mb.add(V, [[3, 2, 1, 0]], "steel_heat")
        for t in np.linspace(0.1, 0.9, 7):
            pa = V[0] + (V[1] - V[0]) * t
            pb = V[3] + (V[2] - V[3]) * t
            beam(mb, pa, pb, 0.08, 0.2, "steel_dark")
    cyl(mb, (0, 0, hz1), (0, 0, 40.5), 1.6, "steel_heat", seg=32)
    for z in np.arange(hz1 + 1.0, 40.0, 2.5):
        flange(mb, (0, 0, z), (0, 0, 1), 1.6, "steel_dark", seg=32, bolts=16)
    # hood skirt edge
    for k in range(4):
        a0, a1 = corners0[k], corners0[(k + 1) % 4]
        beam(mb, (a0[0], a0[1], hz0), (a1[0], a1[1], hz0), 0.25, 0.4, "steel_dark")
    return mb


def build(ctx):
    items = []
    sh = shell(ctx)
    items.append((sh, dict(pivot=L.TILT_PIVOT,
                           props={"loom_part": "furnace_shell", "loom_parent": "",
                                  "loom_motion": "rotate_y (tilt; + tilts the EBT/tap side down)"})))
    rf, z0 = roof(ctx)
    px, py = L.ROOF_SWING_PIVOT
    items.append((rf, dict(pivot=(px, py, L.ROOF_RING_Z + 0.16), parent="furnace_shell",
                           props={"loom_part": "furnace_roof", "loom_parent": "furnace_shell",
                                  "loom_motion": "translate_z (lift ~0.5 m) then rotate_z (swing ~70 deg)"})))
    for i in range(3):
        ex, ey = L.ELEC_XY[i]
        el = electrode(ctx, i)
        items.append((el, dict(pivot=(ex, ey, L.TIP_Z), parent="furnace_shell",
                               props={"loom_part": f"electrode_{i + 1}", "loom_parent": "furnace_shell",
                                      "loom_motion": "translate_z (regulation, ~ -0.6..+3.5 m)"})))
    items.append((deck(ctx), dict()))
    lst, lcar, lcc = lance_manipulator(ctx)
    items.append((lst, dict()))
    ld, _, _ = lance_axes()
    items.append((lcar, dict(pivot=tuple(lcc),
                             props={"loom_part": "lance_carriage", "loom_parent": "",
                                    "loom_motion": "translate along loom_axis (the boom): 0 = lances in the slag door, "
                                                   "-2.4 m = retracted clear of the door",
                                    "loom_axis": [float(ld[0]), float(ld[2]), float(-ld[1])]})))
    items.append((vault(ctx), dict()))
    items.append(cables(ctx))
    items.append((fume_duct(ctx), dict()))
    ctx.setdefault("emitters", {}).update({
        "tap_stream": ((L.EBT_XY[0], 0.0, 6.5), "furnace_shell"),
        "slag_door": ((-L.SHELL_R - 1.0, 0.0, 8.95), "furnace_shell"),
        "spark_slag_door": ((-L.SHELL_R - 1.1, 0.0, 9.3), "furnace_shell"),
        "spark_tap": ((L.EBT_XY[0], 0.0, 6.3), "furnace_shell"),
        "spark_roof_gap": ((L.SHELL_R, 0.0, L.ROOF_RING_Z + 0.15), "furnace_shell"),
        "furnace_mouth": ((0.0, 0.0, L.ROOF_RING_Z + 0.15), "furnace_shell"),
        "fume_duct_mouth": ((-6.8, L.FOURTH_HOLE[1] * 0.3, 16.4), None),
        "fume_duct_exit": ((-13.5, L.HY + 0.5, 16.4), None),
        "slag_fall": ((-8.4, 0.0, 3.8), None),
        "lance_tip": (tuple(LANCE_TIP), "lance_carriage"),
    })
    return items
