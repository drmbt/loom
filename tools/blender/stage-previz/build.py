"""Stage previz generator (Blender 5.x, headless). Builds the stage as one GLB for Loom.

  Blender --background --factory-startup --python tools/blender/stage-previz/build.py -- \
      --out <path.glb> [--blend <path.blend>] [--preview <png dir>]

Every exported mesh object is named `<area>.<name>`, one Mesh File In per area in Loom:

  stage.*    deck, riser, stairs, trusses, fixtures, FOH truss and towers, house floor  (lit)
  grid.*     the upstage vertical members and LED batten housings, in front of the curtain
  curtain.*  the upstage drape: the projection canvas, tied back at both ends
  kabuki.*   the midstage sheer (Loom flies it out with a slider)
  led.*      LED faces: four battens, three riser strips, the deck inserts  (Loom: unlit)
  talent.*   two dancers and a vocalist, for scale and for shadows in the beams

Markers (meshless nodes) carry what Loom needs in their extras, in glTF space (Y up):
  proj.SR / proj.SL / proj.DS   lens position; loom_look_at, loom_throw_ratio, loom_aspect
  canvas.US                     loom_canvas = [x0, x1, y0, y1, z] of the flat curtain; loom_deck_top
Cameras: shot.<name> from layout.CAMERAS.
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import layout as L  # noqa: E402

Z = Vector((0.0, 0.0, 1.0))
X = Vector((1.0, 0.0, 0.0))


def gltf(p):
    """Blender (x, y, z) -> glTF (x, z, -y)."""
    return [round(p[0], 5), round(p[2], 5), round(-p[1], 5)]


def smoothstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


# ---- mesh building -----------------------------------------------------------------------

class MB:
    """Accumulates one object's vertices and faces, with a material name and smooth flag per face."""

    def __init__(self):
        self.v, self.f, self.m, self.s = [], [], [], []

    def add(self, verts, faces, mat, smooth):
        base = len(self.v)
        self.v.extend(tuple(p) for p in verts)
        for face in faces:
            self.f.append([base + i for i in face])
            self.m.append(mat)
            self.s.append(smooth)

    def box(self, c, size, mat, axes=(X, Vector((0, 1, 0)), Z), skip=()):
        c = Vector(c)
        h = [s * 0.5 for s in size]
        a0, a1, a2 = axes
        verts = []
        for sx in (0, 1):
            for sy in (0, 1):
                for sz in (0, 1):
                    verts.append(c + (2 * sx - 1) * h[0] * a0 + (2 * sy - 1) * h[1] * a1 + (2 * sz - 1) * h[2] * a2)
        idx = lambda sx, sy, sz: sx * 4 + sy * 2 + sz  # noqa: E731
        faces = {
            "-x": [idx(0, 0, 0), idx(0, 0, 1), idx(0, 1, 1), idx(0, 1, 0)],
            "+x": [idx(1, 0, 0), idx(1, 1, 0), idx(1, 1, 1), idx(1, 0, 1)],
            "-y": [idx(0, 0, 0), idx(1, 0, 0), idx(1, 0, 1), idx(0, 0, 1)],
            "+y": [idx(0, 1, 0), idx(0, 1, 1), idx(1, 1, 1), idx(1, 1, 0)],
            "-z": [idx(0, 0, 0), idx(0, 1, 0), idx(1, 1, 0), idx(1, 0, 0)],
            "+z": [idx(0, 0, 1), idx(1, 0, 1), idx(1, 1, 1), idx(0, 1, 1)],
        }
        self.add(verts, [f for k, f in faces.items() if k not in skip], mat, False)

    def span(self, lo, hi, mat, skip=()):
        """Axis-aligned box from corner lo to corner hi."""
        c = [(a + b) * 0.5 for a, b in zip(lo, hi)]
        self.box(c, [abs(b - a) for a, b in zip(lo, hi)], mat, skip=skip)

    def cylinder(self, p0, p1, r, mat, seg=12, caps=True, smooth=True):
        p0, p1 = Vector(p0), Vector(p1)
        a = p1 - p0
        if a.length < 1e-6:
            return
        a.normalize()
        u = a.cross(Z if abs(a.z) < 0.95 else X).normalized()
        v = a.cross(u)
        u, v = v, u  # (u, v, a) right-handed
        ring = [math.cos(2 * math.pi * k / seg) * u + math.sin(2 * math.pi * k / seg) * v for k in range(seg)]
        verts = [p0 + r * d for d in ring] + [p1 + r * d for d in ring]
        sides = [[k, (k + 1) % seg, seg + (k + 1) % seg, seg + k] for k in range(seg)]
        self.add(verts, sides, mat, smooth)
        if caps:
            self.add(verts, [list(range(seg - 1, -1, -1)), list(range(seg, 2 * seg))], mat, False)

    def sphere(self, c, r, mat, seg=12, rings=8):
        c = Vector(c)
        verts = [c + Vector((0, 0, r))]
        for j in range(1, rings):
            phi = math.pi * j / rings
            for k in range(seg):
                th = 2 * math.pi * k / seg
                verts.append(c + r * Vector((math.sin(phi) * math.cos(th), math.sin(phi) * math.sin(th), math.cos(phi))))
        verts.append(c - Vector((0, 0, r)))
        last = len(verts) - 1
        faces = [[0, 1 + k, 1 + (k + 1) % seg] for k in range(seg)]
        for j in range(rings - 2):
            a, b = 1 + j * seg, 1 + (j + 1) * seg
            faces += [[a + k, b + k, b + (k + 1) % seg, a + (k + 1) % seg] for k in range(seg)]
        a = 1 + (rings - 2) * seg
        faces += [[a + k, last, a + (k + 1) % seg] for k in range(seg)]
        self.add(verts, faces, mat, True)

    def grid(self, points, nu, nv, mat):
        """A smooth quad sheet from a row-major (nu x nv) list of points."""
        faces = []
        for i in range(nu - 1):
            for j in range(nv - 1):
                a = i * nv + j
                faces.append([a, a + 1, a + nv + 1, a + nv])
        self.add(points, faces, mat, True)

    def box_truss(self, p0, p1, w, mat, chord=0.024, lace=0.011, pitch=0.5):
        p0, p1 = Vector(p0), Vector(p1)
        a = (p1 - p0)
        length = a.length
        a.normalize()
        s = a.cross(Z if abs(a.z) < 0.95 else X).normalized()
        t = a.cross(s)
        offsets = [(s + t) * (w / 2), (-s + t) * (w / 2), (-s - t) * (w / 2), (s - t) * (w / 2)]
        for o in offsets:
            self.cylinder(p0 + o, p1 + o, chord, mat, seg=8, caps=False)
        n = max(1, int(length / pitch))
        step = length / n
        for k in range(4):
            oa, ob = offsets[k], offsets[(k + 1) % 4]
            for i in range(n):
                q0 = p0 + a * (i * step) + (oa if i % 2 == 0 else ob)
                q1 = p0 + a * ((i + 1) * step) + (ob if i % 2 == 0 else oa)
                self.cylinder(q0, q1, lace, mat, seg=5, caps=False)
            for end in (p0, p1):
                self.cylinder(end + oa, end + ob, lace, mat, seg=5, caps=False)


def to_object(name, mb, mats, coll, props=None):
    if not mb.v:
        return None
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in mb.v], [], mb.f)
    names = sorted(set(mb.m))
    for n in names:
        me.materials.append(mats[n])
    me.polygons.foreach_set("material_index", [names.index(n) for n in mb.m])
    me.polygons.foreach_set("use_smooth", mb.s)
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    ob["loom_area"] = name.split(".", 1)[0]
    for k, val in (props or {}).items():
        ob[k] = val
    return ob


# ---- materials ---------------------------------------------------------------------------

MATERIALS = {
    # name: (base rgb, metallic, roughness, emission rgb, emission strength)
    "deck_black": ((0.018, 0.018, 0.02), 0.0, 0.3, None, 0),
    "deck_skirt": ((0.30, 0.30, 0.31), 0.0, 0.75, None, 0),
    "trim": ((0.55, 0.56, 0.58), 1.0, 0.35, None, 0),
    "riser_black": ((0.02, 0.02, 0.02), 0.0, 0.55, None, 0),
    "stair_steel": ((0.025, 0.025, 0.027), 0.5, 0.5, None, 0),
    "truss_black": ((0.035, 0.035, 0.037), 0.6, 0.45, None, 0),
    "fixture_black": ((0.02, 0.02, 0.022), 0.0, 0.4, None, 0),
    "lens_glass": ((0.02, 0.03, 0.04), 0.0, 0.05, None, 0),
    "curtain_white": ((0.80, 0.79, 0.76), 0.0, 0.92, None, 0),
    "kabuki_white": ((0.84, 0.83, 0.81), 0.0, 0.92, None, 0),
    "house_floor": ((0.04, 0.04, 0.045), 0.0, 0.85, None, 0),
    "talent": ((0.35, 0.33, 0.31), 0.0, 0.7, None, 0),
    # LED faces carry their colour as BASE colour and no emission: Loom draws them unlit
    # (output = base x the LED level slider), and an emissive term would add on top of the
    # slider, so the LEDs could never be dimmed to off.
    "led": ((1.0, 0.96, 0.9), 0.0, 0.5, None, 0),
    "floor_led": ((0.55, 0.55, 0.55), 0.0, 0.5, None, 0),
}


def build_materials():
    mats = {}
    for name, (base, metal, rough, emit, strength) in MATERIALS.items():
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*base, 1.0)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rough
        if emit is not None:
            bsdf.inputs["Emission Color"].default_value = (*emit, 1.0)
            bsdf.inputs["Emission Strength"].default_value = strength
        m.diffuse_color = (*base, 1.0)
        mats[name] = m
    return mats


# ---- the pieces --------------------------------------------------------------------------

def drape(mb, mat, half, flat_half, y_pipe, z_top, tie, pleat, seed, step=0.05, rows=60):
    """A pleated curtain on a pipe, its ends past flat_half tied back to pool at tie=(|x|, y)."""
    amp, wavelength = pleat
    z_floor = L.DECK_H
    height = z_top - z_floor
    nu = int(round(2 * half / step)) + 1
    points = []
    for i in range(nu):
        x = -half + 2 * half * i / (nu - 1)
        ax, sgn = abs(x), (1.0 if x >= 0 else -1.0)
        e = smoothstep(flat_half, half, ax)
        phase = 2 * math.pi * x / wavelength + 0.7 * math.sin(1.37 * x + seed) + 0.35 * math.sin(3.1 * x + 2 * seed)
        x_tied = sgn * (tie[0] - (half - ax) * 0.22)
        length = height * (1.0 + 0.12 * e) - 0.012 * (1.0 - e)
        for j in range(rows):
            v = j / (rows - 1)
            w = e * v ** 1.35
            s = v * length
            px = x + (x_tied - x) * w
            py = y_pipe + (tie[1] - y_pipe) * w
            pz = z_top - min(s, height)
            if s > height:  # pooled on the deck, pushed further along the pull
                excess = s - height
                d = Vector((x_tied - x, tie[1] - y_pipe, 0.0))
                d = d.normalized() if d.length > 1e-6 else Vector((sgn, 0.0, 0.0))
                px += d.x * excess
                py += d.y * excess
                pz = z_floor + 0.015 + 0.05 * excess * (0.5 + 0.5 * math.sin(phase * 0.5))
            a = amp * (0.55 + 0.45 * v) * (1.0 + 1.8 * w)
            py += a * math.sin(phase)
            points.append((px, py, pz))
    mb.grid(points, nu, rows, mat)


def fixture(mb, lens, aim, body=(0.62, 0.75, 0.3)):
    """A projector in a rigging cage, lens at `lens`, throwing toward `aim`."""
    lens, aim = Vector(lens), Vector(aim)
    f = (aim - lens).normalized()
    r = f.cross(Z if abs(f.z) < 0.99 else X).normalized()
    u = r.cross(f)
    w, ln, h = body
    centre = lens - f * (0.12 + ln / 2)
    mb.box(centre, (w, ln, h), "fixture_black", axes=(r, f, u))
    mb.cylinder(lens - f * 0.14, lens, 0.085, "lens_glass", seg=16)
    for sr in (-1, 1):
        for su in (-1, 1):
            o = r * sr * (w / 2 + 0.035) + u * su * (h / 2 + 0.035)
            mb.cylinder(centre + o - f * (ln / 2 + 0.03), centre + o + f * (ln / 2 + 0.03), 0.014, "truss_black", seg=6, caps=False)
    for sf in (-1, 1):
        ring = [centre + f * sf * (ln / 2 + 0.03) + r * sr * (w / 2 + 0.035) + u * su * (h / 2 + 0.035)
                for sr, su in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        for k in range(4):
            mb.cylinder(ring[k], ring[(k + 1) % 4], 0.014, "truss_black", seg=6, caps=False)
    return centre, u, h


def hang(mb, centre, u, h, truss_bottom):
    top = centre + u * (h / 2 + 0.035)
    if truss_bottom > top.z + 0.02:
        mb.cylinder(top, Vector((top.x, top.y, truss_bottom)), 0.024, "truss_black", seg=8, caps=False)
        mb.box((top.x, top.y, truss_bottom - 0.03), (0.08, 0.12, 0.06), "truss_black")


def mannequin(mb, base):
    x, y, z = base
    for sx in (-1, 1):
        mb.cylinder((x + 0.1 * sx, y, z), (x + 0.11 * sx, y, z + 0.88), 0.07, "talent", seg=10)
        mb.cylinder((x + 0.22 * sx, y, z + 1.42), (x + 0.34 * sx, y + 0.02, z + 0.86), 0.045, "talent", seg=8)
    mb.cylinder((x, y, z + 0.84), (x, y, z + 1.46), 0.17, "talent", seg=14)
    mb.cylinder((x, y, z + 1.46), (x, y, z + 1.52), 0.05, "talent", seg=8)
    mb.sphere((x, y, z + 1.63), 0.11, "talent")


def build_stage(mats, coll):
    objs = []
    d0, d1 = L.DECK_Y0, L.DECK_Y0 + L.DECK_D
    hw = L.DECK_W / 2
    H = L.DECK_H

    # house floor
    mb = MB()
    mb.add([(-25, L.HOUSE[0], 0), (25, L.HOUSE[0], 0), (25, L.HOUSE[1], 0), (-25, L.HOUSE[1], 0)], [[0, 1, 2, 3]], "house_floor", False)
    objs.append(to_object("stage.house_floor", mb, mats, coll))

    # deck: black top sheet, grey skirt with panel seams, alu edge trim
    mb = MB()
    mb.span((-hw, d0, H - L.DECK_TOP_T), (hw, d1, H), "deck_black")
    mb.span((-hw + 0.03, d0 + 0.03, 0.0), (hw - 0.03, d1 - 0.03, H - L.DECK_TOP_T), "deck_skirt", skip=("-z",))
    t = 0.035
    mb.span((-hw - t, d0 - t, H - 0.11), (hw + t, d0 + 0.01, H + 0.012), "trim")
    mb.span((-hw - t, d1 - 0.01, H - 0.11), (hw + t, d1 + t, H + 0.012), "trim")
    mb.span((-hw - t, d0, H - 0.11), (-hw + 0.01, d1, H + 0.012), "trim")
    mb.span((hw - 0.01, d0, H - 0.11), (hw + t, d1, H + 0.012), "trim")
    for k in range(1, 8):
        x = -hw + k * L.DECK_W / 8
        mb.span((x - 0.012, d0 + 0.015, 0.0), (x + 0.012, d0 + 0.03, H - 0.11), "deck_black")
    for k in range(1, 5):
        y = d0 + k * L.DECK_D / 5
        mb.span((-hw + 0.015, y - 0.012, 0.0), (-hw + 0.03, y + 0.012, H - 0.11), "deck_black")
        mb.span((hw - 0.03, y - 0.012, 0.0), (hw - 0.015, y + 0.012, H - 0.11), "deck_black")
    objs.append(to_object("stage.deck", mb, mats, coll))

    # riser + side stairs + handrails
    mb = MB()
    ry0, ry1 = L.RISER_Y
    top = H + L.RISER_H
    mb.span((-L.RISER_X, ry0, H), (L.RISER_X, ry1, top), "riser_black", skip=("-z",))
    rise = L.RISER_H / L.STAIR_STEPS
    sy0, sy1 = L.STAIR_Y
    for sgn in (-1, 1):
        for k in range(L.STAIR_STEPS - 1):
            outer = L.RISER_X + (L.STAIR_STEPS - 1 - k) * L.STAIR_GOING
            xs = sorted((sgn * L.RISER_X, sgn * outer))
            mb.span((xs[0], sy0, H), (xs[1], sy1, H + (k + 1) * rise), "stair_steel", skip=("-z",))
        foot = L.RISER_X + (L.STAIR_STEPS - 1) * L.STAIR_GOING
        for y in (sy0 + 0.04, sy1 - 0.04):
            p_low = Vector((sgn * (foot - 0.1), y, H + rise))
            p_high = Vector((sgn * (L.RISER_X - 0.05), y, top))
            for zoff in (0.95, 0.5):
                mb.cylinder(p_low + Vector((0, 0, zoff)), p_high + Vector((0, 0, zoff)), 0.022, "stair_steel", seg=8)
            for p in (p_low, p_high):
                mb.cylinder(p, p + Vector((0, 0, 0.98)), 0.025, "stair_steel", seg=8)
    objs.append(to_object("stage.riser", mb, mats, coll))

    # the flown frame: US and DS (kabuki) trusses, side trusses, corner blocks, motors, curtain pipes
    mb = MB()
    tz, tw, tx = L.TRUSS_Z, L.TRUSS_W, L.TRUSS_X
    for y in (L.TRUSS_US_Y, L.TRUSS_DS_Y):
        mb.box_truss((-tx + tw / 2, y, tz), (tx - tw / 2, y, tz), tw, "truss_black")
    for x in (-tx, tx):
        mb.box_truss((x, L.TRUSS_DS_Y + tw / 2, tz), (x, L.TRUSS_US_Y - tw / 2, tz), tw, "truss_black")
        for y in (L.TRUSS_US_Y, L.TRUSS_DS_Y):
            mb.box((x, y, tz), (tw + 0.04, tw + 0.04, tw + 0.04), "truss_black")
            mb.box((x, y, tz + tw / 2 + 0.25), (0.32, 0.42, 0.42), "fixture_black")
            mb.cylinder((x, y, tz + tw / 2 + 0.46), (x, y, 17.0), 0.012, "truss_black", seg=5, caps=False)
    for y, z, half, top_of in ((L.CURTAIN_Y, L.CURTAIN_TOP, L.CURTAIN_X + 0.2, L.TRUSS_US_Y),
                               (L.KABUKI_Y, L.KABUKI_TOP, L.KABUKI_X + 0.2, L.TRUSS_DS_Y)):
        mb.cylinder((-half, y, z), (half, y, z), 0.024, "truss_black", seg=8)
        for x in (-half + 0.6, -half / 3, half / 3, half - 0.6):
            mb.cylinder((x, y, z), (x, top_of, tz - tw / 2), 0.012, "truss_black", seg=5, caps=False)
    objs.append(to_object("stage.frame", mb, mats, coll))

    # FOH truss on two ground-support towers, a short span in the follow-spot position
    mb = MB()
    fy, fz, fh = L.FOH_Y, L.FOH_Z, L.FOH_HALF
    mb.box_truss((-fh, fy, fz), (fh, fy, fz), tw, "truss_black")
    for x in (-fh - tw / 2 - 0.02, fh + tw / 2 + 0.02):
        mb.box_truss((x, fy, 0.05), (x, fy, fz + tw / 2), tw, "truss_black")
        mb.box((x, fy, fz), (tw + 0.04, tw + 0.04, tw + 0.04), "truss_black")
        mb.box((x, fy, 0.015), (1.3, 1.3, 0.03), "truss_black")
    objs.append(to_object("stage.foh", mb, mats, coll))

    # projectors
    mb = MB()
    for name, lens, aim, _ in L.projectors():
        centre, u, h = fixture(mb, lens, aim)
        hang(mb, centre, u, h, (L.FOH_Z if name == "DS" else L.TRUSS_Z) - tw / 2)
    objs.append(to_object("stage.projectors", mb, mats, coll))

    # pedestals with floor fixtures, the IMAG camera on its tripod
    mb = MB()
    for x in L.PEDESTALS_X:
        y = L.PEDESTAL_Y
        mb.span((x - 0.35, y - 0.35, 0.0), (x + 0.35, y + 0.35, 1.0), "deck_skirt", skip=("-z",))
        mb.box((x, y, 1.06), (0.42, 0.32, 0.12), "fixture_black")
        for sx in (-1, 1):
            mb.box((x + sx * 0.19, y, 1.28), (0.04, 0.12, 0.34), "fixture_black")
        mb.cylinder((x, y - 0.12, 1.36), (x, y + 0.2, 1.52), 0.13, "fixture_black", seg=14)
    tx_, ty_ = L.TRIPOD
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.4
        mb.cylinder((tx_, ty_, 1.42), (tx_ + 0.62 * math.cos(a), ty_ + 0.62 * math.sin(a), 0.0), 0.018, "truss_black", seg=6)
    mb.box((tx_, ty_, 1.55), (0.22, 0.42, 0.24), "fixture_black")
    mb.cylinder((tx_, ty_ + 0.2, 1.57), (tx_, ty_ + 0.42, 1.57), 0.07, "lens_glass", seg=14)
    objs.append(to_object("stage.house_rig", mb, mats, coll))

    # upstage grid: slim vertical trusses and LED batten housings, in front of the curtain
    mb = MB()
    for x in L.GRID_X:
        mb.box_truss((x, L.GRID_Y + 0.08, H), (x, L.GRID_Y + 0.08, L.TRUSS_Z - tw / 2), 0.2, "truss_black", chord=0.016, lace=0.008)
    for z in L.GRID_BATTEN_Z:
        mb.span((-L.GRID_BATTEN_X, L.GRID_Y - 0.04, z - 0.045), (L.GRID_BATTEN_X, L.GRID_Y + 0.04, z + 0.045), "fixture_black")
    objs.append(to_object("grid.structure", mb, mats, coll))

    # LED faces (unlit in Loom): battens, riser strips, deck inserts
    mb = MB()
    for z in L.GRID_BATTEN_Z:
        mb.span((-L.GRID_BATTEN_X + 0.05, L.GRID_Y - 0.052, z - 0.024), (L.GRID_BATTEN_X - 0.05, L.GRID_Y - 0.04, z + 0.024), "led")
    for z in L.RISER_LED_Z:
        mb.span((-L.RISER_X + 0.1, ry0 - 0.02, H + z - 0.022), (L.RISER_X - 0.1, ry0 - 0.002, H + z + 0.022), "led")
    import random
    rng = random.Random(11)
    placed = []
    while len(placed) < 22:
        x, y = rng.uniform(-6.6, 6.6), rng.uniform(d0 + 0.8, 0.6)
        if all(abs(x - px) > 1.1 or abs(y - py) > 0.6 for px, py in placed):
            placed.append((x, y))
            mb.span((x - 0.26, y - 0.12, H - 0.01), (x + 0.26, y + 0.12, H + 0.006), "floor_led", skip=("-z",))
    objs.append(to_object("led.faces", mb, mats, coll))

    # the drapes
    mb = MB()
    drape(mb, "curtain_white", L.CURTAIN_X, L.CURTAIN_FLAT_X, L.CURTAIN_Y, L.CURTAIN_TOP, L.CURTAIN_TIE, L.CURTAIN_PLEAT, seed=1.3)
    objs.append(to_object("curtain.upstage", mb, mats, coll))
    mb = MB()
    drape(mb, "kabuki_white", L.KABUKI_X, L.KABUKI_FLAT_X, L.KABUKI_Y, L.KABUKI_TOP, L.KABUKI_TIE, L.KABUKI_PLEAT, seed=4.1)
    objs.append(to_object("kabuki.sheer", mb, mats, coll, {"loom_top": L.KABUKI_TOP}))

    # talent
    mb = MB()
    for base in L.TALENT:
        mannequin(mb, base)
    objs.append(to_object("talent.figures", mb, mats, coll))
    return [o for o in objs if o is not None]


def build_markers(coll):
    for name, lens, aim, throw in L.projectors():
        ob = bpy.data.objects.new(f"proj.{name}", None)
        ob.empty_display_type = "CONE"
        ob.empty_display_size = 0.5
        ob.location = lens
        ob.rotation_euler = (Vector(aim) - Vector(lens)).to_track_quat("-Z", "Y").to_euler()
        ob["loom_look_at"] = gltf(aim)
        ob["loom_throw_ratio"] = round(throw, 4)
        ob["loom_aspect"] = round(L.PROJ_ASPECT, 4)
        coll.objects.link(ob)
    x0, x1, z0, z1 = L.canvas()
    ob = bpy.data.objects.new("canvas.US", None)
    ob.location = (0.0, L.CURTAIN_Y, 0.5 * (z0 + z1))
    ob["loom_canvas"] = [x0, x1, z0, z1, -L.CURTAIN_Y]  # glTF: x range, y range, z of the plane
    ob["loom_deck_top"] = L.DECK_H
    coll.objects.link(ob)


def build_cameras(coll):
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    for name, eye, target, lens in L.CAMERAS:
        cam = bpy.data.cameras.new(f"shot.{name}")
        cam.lens = lens
        cam.sensor_width = 36.0
        cam.sensor_fit = "HORIZONTAL"
        cam.clip_start, cam.clip_end = 0.1, 200.0
        ob = bpy.data.objects.new(f"shot.{name}", cam)
        ob.location = eye
        ob.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()
        coll.objects.link(ob)


def glb_stats(path):
    import json
    import struct
    with open(path, "rb") as fh:
        data = fh.read()
    n = struct.unpack("<I", data[12:16])[0]
    j = json.loads(data[20:20 + n])
    areas = {}
    for nd in j["nodes"]:
        if "mesh" not in nd:
            continue
        v = t = 0
        for p in j["meshes"][nd["mesh"]]["primitives"]:
            v += j["accessors"][p["attributes"]["POSITION"]]["count"]
            t += j["accessors"][p["indices"]]["count"] // 3
        ar = areas.setdefault(nd["name"].split(".", 1)[0], [0, 0])
        ar[0] += v
        ar[1] += t
    return areas


def preview(out_dir, objs):
    """Quick EEVEE stills of the geometry under work lights. Never exported."""
    scene = bpy.context.scene
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    world = bpy.data.worlds.new("preview")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.01, 0.01, 0.012, 1)
    scene.world = world
    lights = []
    for name, loc, energy in (("key", (-10, -14, 16), 5000), ("fill", (12, -10, 10), 2500), ("back", (0, 12, 14), 2000)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy, ld.size = energy, 6.0
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 4)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo)
        lights.append(lo)
    os.makedirs(out_dir, exist_ok=True)
    for ob in scene.objects:
        if ob.type == "CAMERA":
            scene.camera = ob
            scene.render.filepath = os.path.join(out_dir, ob.name.replace("shot.", "") + ".png")
            bpy.ops.render.render(write_still=True)
            print(f"[preview] {scene.render.filepath}", flush=True)
    for lo in lights:
        bpy.data.objects.remove(lo)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--blend", default=None)
    ap.add_argument("--preview", default=None)
    a = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    mats = build_materials()
    coll = scene.collection
    objs = build_stage(mats, coll)
    build_markers(coll)
    build_cameras(coll)
    for name, lens, aim, throw in L.projectors():
        print(f"[proj] {name}: lens {tuple(round(c, 2) for c in lens)} aim {tuple(round(c, 2) for c in aim)} "
              f"throw {math.dist(lens, aim):.2f} m, ratio {throw:.3f}, image width {math.dist(lens, aim) / throw:.2f} m")

    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB",
        export_draco_mesh_compression_enable=False,
        export_apply=True, export_yup=True, export_extras=True,
        export_cameras=True, export_lights=False,
        export_normals=True, export_texcoords=False, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_materials="EXPORT", export_image_format="NONE",
        use_selection=False, use_visible=False,
    )
    print(f"[export] {out}  {os.path.getsize(out) / 1e6:.2f} MB")
    for area, (v, t) in sorted(glb_stats(out).items()):
        print(f"  area {area:8s} {v:8,d} verts {t:8,d} tris")
    if a.blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.blend))
        print(f"[blend] {a.blend}")
    if a.preview:
        preview(a.preview, objs)


main()
