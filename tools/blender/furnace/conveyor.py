"""Inclined alloy/scrap belt conveyor from the scrap bay up to a day bunker over the
furnace deck: troughed idlers, truss gallery, trestles, head drive, bunker and chute.
The belt surfaces are one part (conveyor_belt) whose TEXCOORD_0.u runs along travel (metres)."""
import math

import numpy as np

from util import (MB, Xf, v3, norm, frame, rot_z, rot_x, rot_y, box, box_minmax, beam, ibeam, cyl, lathe, disk,
                  torus, sweep, sweep_profile, bezier, hexbolt, prism, handrail, pipe_run, strip_bars, profile_beam,
                  angle_prof, rock, TAU)
import layout as L

A = v3(L.CONV_A)
B = v3(L.CONV_B)
T = norm(B - A)
S = norm(np.cross(v3(0, 0, 1), T))       # side (+Y)
U = np.cross(T, S)                          # belt normal (up-ish)
LEN = float(np.linalg.norm(B - A))

TROUGH = [(-0.62, 0.26), (-0.33, 0.0), (0.33, 0.0), (0.62, 0.26), (0.62, 0.275), (0.33, 0.015), (-0.33, 0.015), (-0.62, 0.275)]


def at(s, side=0.0, up=0.0):
    return A + T * s + S * side + U * up


def belt(ctx):
    mb = MB("conveyor_belt")
    n = 60
    top = [at(LEN * k / n, 0, 0.18) for k in range(n + 1)]
    sweep_profile(mb, top, TROUGH, "rubber_belt", up=(0, 0, 1), uv_len=True)
    # return run (flat) under the idlers; u continues after the carrying run
    ret = [at(LEN * (1 - k / n), 0, -0.55) for k in range(n + 1)]
    flat = [(-0.6, 0.0), (0.6, 0.0), (0.6, 0.014), (-0.6, 0.014)]
    base = mb.nv
    sweep_profile(mb, ret, flat, "rubber_belt", up=(0, 0, 1), uv_len=True)
    # offset return-run u by LEN + pulley wrap so the scroll is continuous around the loop
    mb.UV[-1][:, 0] += LEN + 0.6
    # material lumps riding on the belt (scroll with the texture only; kept sparse)
    return mb


def structure(ctx):
    rng = ctx["rng"]
    mb = MB("conveyor_structure")
    # troughed idler stations
    for s in np.arange(0.8, LEN - 0.6, 1.2):
        c = at(s, 0, 0.1)
        cyl(mb, c - S * 0.33, c + S * 0.33, 0.065, "steel_galvanized", seg=10)
        for sd in (-1, 1):
            p0 = c + S * sd * 0.36
            p1 = c + S * sd * 0.66 + U * 0.18
            cyl(mb, p0, p1, 0.065, "steel_galvanized", seg=10)
        # idler frame (angle) under
        beam(mb, c - S * 0.8 - U * 0.1, c + S * 0.8 - U * 0.1, 0.06, 0.06, "steel_dark", up=U)
        for sd in (-1, 1):
            beam(mb, c + S * sd * 0.78 - U * 0.1, c + S * sd * 0.72 + U * 0.3, 0.05, 0.05, "steel_dark", up=T)
    for s in np.arange(1.5, LEN - 1, 3.0):
        c = at(s, 0, -0.62)
        cyl(mb, c - S * 0.68, c + S * 0.68, 0.06, "steel_galvanized", seg=10)
    # stringers + side trusses (gallery)
    for sd in (-1, 1):
        for up in (-0.15, -0.85, 0.9):
            profile_beam(mb, [(0, -0.1), (0.08, -0.1), (0.08, 0.1), (0, 0.1)], at(0, sd * 0.95, up), at(LEN, sd * 0.95, up),
                         "steel_painted_grey", up=U)
        for s in np.arange(0.0, LEN, 1.6):
            beam(mb, at(s, sd * 0.95, -0.85), at(s, sd * 0.95, 0.9), 0.07, 0.07, "steel_painted_grey", up=T)
            beam(mb, at(s, sd * 0.95, -0.85), at(s + 1.6, sd * 0.95, 0.9), 0.06, 0.06, "steel_painted_grey", up=T)
    # walkway on +S side with grating and handrail (stair treads: cleats across)
    w0 = at(0, 1.55, -0.85)
    w1 = at(LEN, 1.55, -0.85)
    strip_bars(mb, w0, w1, S, 0.9, 0, "grating", pitch=0.05)
    for s in np.arange(0.3, LEN, 0.4):
        beam(mb, at(s, 1.1, -0.83), at(s, 2.0, -0.83), 0.03, 0.03, "grating", up=U)
    handrail(mb, [at(0, 2.0, -0.85), at(LEN, 2.0, -0.85)], mat="steel_painted_yellow", post=1.8)
    # roof sheeting over the gallery (half-covered, some panels missing)
    for s in np.arange(0.0, LEN - 1.5, 3.0):
        if rng.random() < 0.25:
            continue
        a = at(s, -1.2, 1.45)
        b = at(s + 2.9, -1.2, 1.45)
        beam(mb, (a + b) / 2 - T * 1.45, (a + b) / 2 + T * 1.45, 0.02, 2.6, "roof_sheet", up=-S * 0.25 + U, caps=True)
    # trestles every ~7 m
    for s in np.arange(4.0, LEN - 2.0, 7.0):
        top = at(s, 0, -0.9)
        for sd in (-1, 1):
            foot = v3(top[0], top[1] + sd * 1.8, 0.0)
            ibeam(mb, foot, top + S * sd * 1.0, 0.35, 0.3, "steel_painted_grey", up=(1, 0, 0))
            box_minmax(mb, (foot[0] - 0.5, foot[1] - 0.5, 0), (foot[0] + 0.5, foot[1] + 0.5, 0.3), "concrete")
        beam(mb, top - S * 1.1, top + S * 1.1, 0.35, 0.35, "steel_painted_grey")
        for z in np.arange(1.5, top[2] - 1.0, 3.0):
            t0 = z / top[2]
            beam(mb, v3(top[0], top[1] - 1.8 + 0.8 * t0, z), v3(top[0], top[1] + 1.8 - 0.8 * t0, z), 0.12, 0.12, "steel_painted_grey")
    # tail: pulley, take-up, loading hopper with scrap
    tail = at(-0.3, 0, -0.18)
    cyl(mb, tail - S * 0.75, tail + S * 0.75, 0.42, "steel_dark", seg=20)
    box_minmax(mb, (A[0] - 1.2, A[1] - 1.1, 0), (A[0] + 0.2, A[1] + 1.1, A[2] - 0.2), "steel_painted_grey")
    hp = at(2.5, 0, 1.3)
    lathe(mb, [(0.5, -0.9), (1.6, 0.6), (1.55, 0.62), (0.45, -0.88)], Xf(None, hp), "steel_worn", seg=4)
    # head: pulley, drive, discharge hood into the bunker
    head = at(LEN + 0.3, 0, -0.18)
    cyl(mb, head - S * 0.8, head + S * 0.8, 0.5, "steel_dark", seg=24)
    box_minmax(mb, (B[0] - 0.4, B[1] + 0.9, B[2] - 0.9), (B[0] + 0.8, B[1] + 1.9, B[2] + 0.3), "steel_painted_blue")
    cyl(mb, (B[0] + 0.2, B[1] + 1.9, B[2] - 0.3), (B[0] + 0.2, B[1] + 3.1, B[2] - 0.3), 0.36, "steel_painted_blue", seg=16)
    hood0 = head + T * 0.5
    box_minmax(mb, (hood0[0] - 0.3, B[1] - 1.0, B[2] - 1.5), (hood0[0] + 1.4, B[1] + 0.9, B[2] + 1.2), "steel_painted_grey")
    # head platform
    box_minmax(mb, (B[0] - 2.0, B[1] - 1.4, B[2] - 1.6), (B[0] + 2.2, B[1] + 2.4, B[2] - 1.5), "steel_chequer")
    handrail(mb, [(B[0] - 2.0, B[1] + 2.4, B[2] - 1.5), (B[0] + 2.2, B[1] + 2.4, B[2] - 1.5), (B[0] + 2.2, B[1] - 1.4, B[2] - 1.5)],
             mat="steel_painted_yellow")
    for dx in (-1.9, 2.1):
        for dy in (-1.3, 2.3):
            ibeam(mb, (B[0] + dx, B[1] + dy, 0.0), (B[0] + dx, B[1] + dy, B[2] - 1.6), 0.3, 0.3, "steel_painted_grey", up=(1, 0, 0))
    # transfer chute head -> bunker
    bx, by = L.BUNKER
    sweep_profile(mb, [hood0 + v3(0.5, 0, -1.5), v3(bx - 0.6, by - 0.8, 20.9)], [(-0.4, -0.3), (0.4, -0.3), (0.4, 0.3), (-0.4, 0.3)],
                  "steel_worn", up=(0, 0, 1), uv_len=False)
    # day bunker on legs from the deck, weigh hopper and chute to the roof 5th hole
    lathe(mb, [(0.35, 16.6), (1.5, 18.0), (1.5, 21.2), (0.0, 21.3)], Xf(rot_z(math.pi / 4), (bx, by, 0)), "steel_painted_grey", seg=4)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        p = v3(bx + 1.5 * math.cos(a) / math.cos(math.pi / 4) * 0.72, by + 1.5 * math.sin(a) / math.cos(math.pi / 4) * 0.72, 0)
        ibeam(mb, (p[0], p[1], L.DECK_Z), (p[0], p[1], 18.0), 0.3, 0.3, "steel_painted_grey", up=(1, 0, 0))
    box(mb, (1.0, 1.0, 0.9), Xf(None, (bx, by, 16.1)), "steel_painted_blue")
    fifth = v3(-1.25 * 1.35, -1.25 * 0.9, 14.5)
    sweep(mb, [v3(bx, by, 15.6), v3(bx, by, 15.2), fifth + v3(0, 0, 0.9), fifth], 0.22, "steel_worn", seg=12, bend=0.5)
    cyl(mb, fifth + v3(0, 0, 0.3), fifth + v3(0, 0, -0.1), 0.3, "panel_cooled", seg=12)
    return mb


def build(ctx):
    items = [(belt(ctx), dict(pivot=tuple(A), props={
        "loom_part": "conveyor_belt", "loom_parent": "",
        "loom_motion": "belt travel = scroll TEXCOORD_0.u (metres; carrying run 0..L, return run L+0.6..2L+0.6)"}))]
    items.append((structure(ctx), dict()))
    ctx.setdefault("emitters", {}).update({
        "conveyor_head": (tuple(B + v3(0.8, 0, -1.0)), None),
        "conveyor_tail": (tuple(A + v3(0, 0, 1.0)), None),
    })
    return items
