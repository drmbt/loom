"""Stage previz generator (Blender 5.x, headless). Builds the stage as one GLB for Loom.

  Blender --background --factory-startup --python tools/blender/stage-previz/build.py -- \
      --out <path.glb> [--blend <path.blend>] [--preview <png dir>]

Every exported mesh object is named `<area>.<name>`, one Mesh File In per area in Loom:

  stage.*    deck, riser, stairs, the flown frame, projector hangers, house rig, house floor  (lit)
  grid.*     the upstage light towers and LED batten housings, BEHIND the scrim
  curtain.*  the upstage drape: the projection canvas, tied back at both ends
  kabuki.*   the midstage sheer (Loom flies it out with a slider)
  led.*      LED faces: four battens and three riser strips  (Loom: unlit)
  deck.*     the deck's walking surface and its seams (Loom: its own material, the Deck tone fader)
  talent.*   two dancers and a vocalist, for scale and for shadows in the beams
  rig.*      the three projector bodies and the DS 4' truss, each a PART (loom_part) that
             Loom's rig kernel tilts or slides with the projector controls

Markers (meshless nodes) carry what Loom needs in their extras, in glTF space (Y up):
  proj.SR / proj.SL / proj.DS   lens position; loom_look_at, loom_throw_ratio, loom_aspect, loom_keystone_h;
                                DS also loom_pivot, loom_lens_offset, loom_tilt_deg, loom_curtain_z
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
        self.v, self.f, self.m, self.s, self.uv = [], [], [], [], []

    def add(self, verts, faces, mat, smooth, uv=None):
        base = len(self.v)
        self.v.extend(tuple(p) for p in verts)
        for face in faces:
            self.f.append([base + i for i in face])
            self.m.append(mat)
            self.s.append(smooth)
            self.uv.append(uv)

    def emitter(self, corners, mat, texel):
        """One quad whose every corner reads the same FX-feed texel (column, row): Loom's unlit
        material samples its albedo map at the surface uv, so the quad shows exactly that texel.
        `corners` go counter-clockwise seen from the side that faces the viewer."""
        w, h = L.FX_SIZE
        col, row = texel
        # texel centres, in the uv Loom's textureLoad reads (index = floor(uv · (size − 1)));
        # glTF v runs DOWN the image and the exporter writes v = 1 − Blender's v
        uv = ((col + 0.5) / (w - 1), 1.0 - (row + 0.5) / (h - 1))
        self.add(corners, [[0, 1, 2, 3]], mat, False, uv=uv)

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

    def prism(self, profile, x0, x1, mat):
        """A flat-shaded solid: a CLOCKWISE (y, z) profile (y right, z up) extruded from x0 to x1."""
        n = len(profile)
        verts = [(x0, y, z) for y, z in profile] + [(x1, y, z) for y, z in profile]
        faces = [list(range(n)), list(range(2 * n - 1, n - 1, -1))]
        faces += [[n + i, n + (i + 1) % n, (i + 1) % n, i] for i in range(n)]
        self.add(verts, faces, mat, False)

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


def to_object(name, mb, mats, coll, props=None, pivot=None):
    """One object from a builder. A `pivot` becomes the object's origin (vertices stay where
    they are in the world): a Loom PART's pivot is its node origin, identity rotation."""
    if not mb.v:
        return None
    me = bpy.data.meshes.new(name)
    origin = Vector(pivot) if pivot is not None else Vector((0.0, 0.0, 0.0))
    me.from_pydata([tuple(Vector(v) - origin) for v in mb.v], [], mb.f)
    names = sorted(set(mb.m))
    for n in names:
        me.materials.append(mats[n])
    me.polygons.foreach_set("material_index", [names.index(n) for n in mb.m])
    me.polygons.foreach_set("use_smooth", mb.s)
    if any(uv is not None for uv in mb.uv):
        layer = me.uv_layers.new(name="UVMap")
        for poly, uv in zip(me.polygons, mb.uv):
            for loop in range(poly.loop_start, poly.loop_start + poly.loop_total):
                layer.data[loop].uv = uv if uv is not None else (0.0, 0.0)
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    ob.location = origin
    coll.objects.link(ob)
    ob["loom_area"] = name.split(".", 1)[0]
    for k, val in (props or {}).items():
        ob[k] = val
    return ob


# ---- materials ---------------------------------------------------------------------------

MATERIALS = {
    # name: (base rgb, metallic, roughness, emission rgb, emission strength)
    "deck_black": ((0.018, 0.018, 0.02), 0.0, 0.3, None, 0),
    # The deck's walking surface: a satin mid-grey, so a projection on it reads. Loom scales it
    # with the Deck tone fader (its material colour multiplies this base).
    "deck_floor": ((0.5, 0.5, 0.52), 0.0, 0.6, None, 0),
    "deck_skirt": ((0.30, 0.30, 0.31), 0.0, 0.75, None, 0),
    "deck_seam": ((0.075, 0.075, 0.08), 0.0, 0.6, None, 0),
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
    # The grated (blowthrough) decks' walking surface: the deck grey, a touch darker.
    "grate": ((0.42, 0.42, 0.44), 0.0, 0.65, None, 0),
    # Pixel-line pixels and strobe windows: WHITE base and no emission. Loom draws them unlit,
    # their colour the FX feed's texel at their uv times the level slider; any other base would
    # tint the content, and an emissive term would keep them from dimming to off.
    "emitter": ((1.0, 1.0, 1.0), 0.0, 0.5, None, 0),
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


def catmull(points, t):
    """A point at t in [0, 1] along the uniform Catmull-Rom curve through `points` (Vectors)."""
    n = len(points) - 1
    k = min(int(t * n), n - 1)
    u = t * n - k
    p0, p1, p2, p3 = points[max(k - 1, 0)], points[k], points[k + 1], points[min(k + 2, n)]
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)


def scrim(mb, mat, seed, step=0.05, rows=110):
    """The upstage scrim (layout revision 2): a straight fall across its middle, flush behind the
    riser to the house deck; beyond CURTAIN_FLAT_X each side gathered out along the scrim's line,
    down the stair's offstage side and round its foot, where it pools: the front elevation and
    the top plan.

    Each column of cloth runs from the pipe either straight down (the middle) or along a curve
    through its side's swag (the ends), blended across the swag by how far out along the pipe it
    hangs; gathered cloth heaps off its own line by an amount that varies column to column.
    """
    amp, wavelength = L.CURTAIN_PLEAT
    half, flat = L.CURTAIN_X, L.CURTAIN_FLAT_X
    y_pipe, z_top, z_floor = L.CURTAIN_Y, L.CURTAIN_TOP, L.DECK_H
    near, far = L.CURTAIN_POOL_NEAR, L.CURTAIN_POOL_FAR

    def at(xyz, sgn):
        x, y, z = xyz
        return Vector((sgn * x, L.DECK_Y0 + y, L.DECK_H + z))

    nu = int(round(2 * half / step)) + 1
    points = []
    for i in range(nu):
        x = -half + 2 * half * i / (nu - 1)
        ax, sgn = abs(x), (1.0 if x >= 0 else -1.0)
        e = smoothstep(flat, half, ax)              # 0 on the straight fall, 1 at the pipe's end
        w = smoothstep(0.0, 1.0, min(1.0, e * 1.6))  # how far into the swag this column is drawn
        phase = 2 * math.pi * x / wavelength + 0.7 * math.sin(1.37 * x + seed) + 0.35 * math.sin(3.1 * x + 2 * seed)
        pool = (near[0] + (far[0] - near[0]) * e, near[1] + (far[1] - near[1]) * e, 0.0)
        on_grate = pool[0] <= L.STAGE_W / 2 / L.FT and pool[1] <= (L.DS_STRIP[1] - L.DECK_Y0) / L.FT
        foot = at(pool, sgn)
        foot.z = (L.GRATE_TOP if on_grate else L.DECK_H) + 0.04
        route = [Vector((x, y_pipe, z_top)), at(L.CURTAIN_SWAG_OUT, sgn), at(L.CURTAIN_GATHER, sgn), foot]
        heap = L.CURTAIN_BUNCH * (0.5 + 0.5 * math.sin(2.3 * phase + seed)) * w
        for j in range(rows):
            v = j / (rows - 1)
            straight = Vector((x, y_pipe, z_top - v * (z_top - z_floor)))
            swag = catmull(route, v)
            # gathered cloth heaps off its line, most where it is gathered, and spreads where it pools
            bulge = heap * math.sin(math.pi * min(1.0, v * 1.15))
            swag += Vector((sgn * bulge * math.cos(phase), bulge * math.sin(1.7 * phase), 0.4 * bulge * math.sin(phase)))
            # and crumples: folds that wander down the column, deepest in the gather and the pool
            crush = 0.11 * w * (0.4 + 0.6 * math.sin(math.pi * v) + 0.6 * v * v)
            swag += Vector((crush * math.sin(5.1 * v * math.pi + 1.9 * phase), crush * math.sin(3.7 * v * math.pi + 2.6 * phase + seed), 0.5 * crush * math.cos(6.3 * v * math.pi + phase)))
            p = straight.lerp(swag, w)
            a = amp * (0.55 + 0.45 * v)
            p.y += a * math.sin(phase)
            points.append((p.x, p.y, max(p.z, z_floor + 0.02)))
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
    d0, d1 = L.DECK_Y0, L.DECK_Y1
    hw = L.DECK_W / 2
    sw = L.STAGE_W / 2
    H = L.DECK_H

    # house floor
    mb = MB()
    mb.add([(-25, L.HOUSE[0], 0), (25, L.HOUSE[0], 0), (25, L.HOUSE[1], 0), (-25, L.HOUSE[1], 0)], [[0, 1, 2, 3]], "house_floor", False)
    objs.append(to_object("stage.house_floor", mb, mats, coll))

    # deck: black top sheet, grey skirt with panel seams, alu edge trim
    # the walking surface and its 4' x 8' seams are their own area (`deck.*`), so Loom gives the
    # floor its own material; the skirt, trim and skirt seams stay with the stage
    floor = MB()
    floor.span((-hw, d0, H - L.DECK_TOP_T), (hw, d1, H), "deck_floor")
    mb = MB()
    mb.span((-hw + 0.03, d0 + 0.03, 0.0), (hw - 0.03, d1 - 0.03, H - L.DECK_TOP_T), "deck_skirt", skip=("-z",))
    t = 0.035
    mb.span((-hw - t, d0 - t, H - 0.11), (hw + t, d0 + 0.01, H + 0.012), "trim")
    mb.span((-hw - t, d1 - 0.01, H - 0.11), (hw + t, d1 + t, H + 0.012), "trim")
    mb.span((-hw - t, d0, H - 0.11), (-hw + 0.01, d1, H + 0.012), "trim")
    mb.span((hw - 0.01, d0, H - 0.11), (hw + t, d1, H + 0.012), "trim")
    # one skirt panel and one top seam per 4' x 8' deck: the stage's scale, readable on the set
    pw, pd = L.DECK_PANEL
    for k in range(1, L.DECK_COLS):
        x = -hw + k * pw
        mb.span((x - 0.012, d0 + 0.015, 0.0), (x + 0.012, d0 + 0.03, H - 0.11), "deck_black")
        floor.span((x - 0.008, d0 + 0.01, H - 0.001), (x + 0.008, d1 - 0.01, H + 0.002), "deck_seam", skip=("-z",))
    for k in range(1, L.DECK_ROWS):
        y = d0 + k * pd
        mb.span((-hw + 0.015, y - 0.012, 0.0), (-hw + 0.03, y + 0.012, H - 0.11), "deck_black")
        mb.span((hw - 0.03, y - 0.012, 0.0), (hw - 0.015, y + 0.012, H - 0.11), "deck_black")
        floor.span((-hw + 0.01, y - 0.008, H - 0.001), (hw - 0.01, y + 0.008, H + 0.002), "deck_seam", skip=("-z",))
    objs.append(to_object("stage.deck", mb, mats, coll))
    objs.append(to_object("deck.floor", floor, mats, coll))

    # the grated (blowthrough) decks: the stage's downstage 48' x 16' and the riser's top, each a
    # fascia round a 1'6" cavity (the strobes sit in it) under a grated top. The tops are floor
    # (`deck.*`, Loom's Deck tone), with the 4' x 8' seams and a 1' grating pitch drawn on them.
    def grated_top(floor, x0, x1, y0, y1, z):
        floor.span((x0, y0, z - 0.03), (x1, y1, z), "grate")
        for k in range(1, int(round((x1 - x0) / L.FT))):
            x = x0 + k * L.FT
            seam = abs(((x - x0) / pw) - round((x - x0) / pw)) < 1e-6
            floor.span((x - (0.008 if seam else 0.004), y0 + 0.01, z - 0.001), (x + (0.008 if seam else 0.004), y1 - 0.01, z + 0.002), "deck_seam", skip=("-z",))
        for k in range(1, int(round((y1 - y0) / L.FT))):
            y = y0 + k * L.FT
            seam = abs(((y - y0) / pd) - round((y - y0) / pd)) < 1e-6
            floor.span((x0 + 0.01, y - (0.008 if seam else 0.004), z - 0.001), (x1 - 0.01, y + (0.008 if seam else 0.004), z + 0.002), "deck_seam", skip=("-z",))

    def fascia(mb, x0, x1, y0, y1, z0, z1):
        t = 0.04
        mb.span((x0, y0, z0), (x1, y0 + t, z1), "deck_black")
        mb.span((x0, y1 - t, z0), (x1, y1, z1), "deck_black")
        mb.span((x0, y0, z0), (x0 + t, y1, z1), "deck_black")
        mb.span((x1 - t, y0, z0), (x1, y1, z1), "deck_black")

    grates = MB()
    frame = MB()
    sy0, sy1 = L.DS_STRIP
    fascia(frame, -sw, sw, sy0, sy1, H, L.GRATE_TOP - 0.03)
    grated_top(grates, -sw, sw, sy0, sy1, L.GRATE_TOP)

    # riser + a stair at each end, facing DOWNSTAGE: one deck wide, beside the riser's face,
    # climbing upstage from its front line, from the stage grate to a landing at the riser top;
    # a handrail on the open (offstage) side. Each stair is one sawtooth profile extruded across
    # its width, standing on the house deck.
    mb = MB()
    ry0, ry1 = L.RISER_Y
    top = L.RISER_TOP
    mb.span((-L.RISER_X, ry0, H), (L.RISER_X, ry1, L.RISER_DECK), "riser_black", skip=("-z",))
    fascia(frame, -L.RISER_X, L.RISER_X, ry0, ry1, L.RISER_DECK, top - 0.03)
    grated_top(grates, -L.RISER_X, L.RISER_X, ry0, ry1, top)
    rise = (top - L.GRATE_TOP) / L.STAIR_STEPS
    going = L.STAIR_GOING
    landing = ry0 + (L.STAIR_STEPS - 1) * going
    profile = [(ry0, H)]
    for k in range(1, L.STAIR_STEPS):
        y = ry0 + (k - 1) * going
        profile += [(y, L.GRATE_TOP + k * rise), (y + going, L.GRATE_TOP + k * rise)]
    profile += [(landing, top), (ry1, top), (ry1, H)]
    for sgn in (-1, 1):
        xs = sorted((sgn * L.RISER_X, sgn * (L.RISER_X + L.STAIR_W)))
        mb.prism(profile, xs[0], xs[1], "stair_steel")
        x = sgn * (L.RISER_X + L.STAIR_W - 0.04)
        foot = Vector((x, ry0 + 0.12, L.GRATE_TOP + rise))
        head = Vector((x, landing, top))
        end = Vector((x, ry1 - 0.05, top))
        for zoff in (0.95, 0.5):
            lift = Vector((0, 0, zoff))
            mb.cylinder(foot + lift, head + lift, 0.022, "stair_steel", seg=8)
            mb.cylinder(head + lift, end + lift, 0.022, "stair_steel", seg=8)
        for p in (foot, head, end):
            mb.cylinder(p, p + Vector((0, 0, 0.98)), 0.025, "stair_steel", seg=8)
    objs.append(to_object("stage.riser", mb, mats, coll))
    objs.append(to_object("stage.grate_frames", frame, mats, coll))
    objs.append(to_object("deck.grates", grates, mats, coll))

    # strobes (GLP JDC Burst 1) in the grates' cavities, and the light each throws up through its
    # grate: a window on the grated top that shows the FX feed's bottom half at the strobe's
    # place in plan (`strobe.*`, unlit in Loom).
    bodies = MB()
    windows = MB()
    bl, bw, bh = L.STROBE_BODY
    wl, ww = L.STROBE_WINDOW
    for _, (x, y), floor_z, top_z in L.strobes():
        bodies.box((x, y, floor_z + bh / 2), (bl, bw, bh), "fixture_black")
        bodies.box((x, y, floor_z + bh + 0.004), (wl, ww, 0.008), "lens_glass")
        z = top_z + 0.004
        windows.emitter([(x - wl / 2, y - ww / 2, z), (x + wl / 2, y - ww / 2, z), (x + wl / 2, y + ww / 2, z), (x - wl / 2, y + ww / 2, z)],
                        "emitter", L.fx_texel_strobe(x, y))
    objs.append(to_object("stage.strobes", bodies, mats, coll))
    objs.append(to_object("strobe.windows", windows, mats, coll))

    # the flown frame (layout revision 2): the scrim's truss and the front truss, 50' each across
    # the stage at one trim, a motor over each end and the third points between; the scrim's
    # pipe on brackets off its truss's downstage face; the kabuki's pipe on its own chains
    mb = MB()
    tz, tw, tx = L.TRUSS_Z, L.TRUSS_W, L.TRUSS_X
    for y in (L.TRUSS_US_Y, L.TRUSS_DS_Y):
        mb.box_truss((-tx, y, tz), (tx, y, tz), tw, "truss_black")
        for x in (-tx + 0.3, -tx / 3, tx / 3, tx - 0.3):
            mb.box((x, y, tz + tw / 2 + 0.25), (0.32, 0.42, 0.42), "fixture_black")
            mb.cylinder((x, y, tz + tw / 2 + 0.46), (x, y, 17.0), 0.012, "truss_black", seg=5, caps=False)
    half = L.CURTAIN_X + 0.2
    mb.cylinder((-half, L.CURTAIN_Y, L.CURTAIN_TOP), (half, L.CURTAIN_Y, L.CURTAIN_TOP), 0.024, "truss_black", seg=8)
    for x in (-half + 0.6, -half / 3, half / 3, half - 0.6):
        mb.cylinder((x, L.CURTAIN_Y, L.CURTAIN_TOP), (x, L.TRUSS_US_Y - tw / 2, L.CURTAIN_TOP), 0.012, "truss_black", seg=5, caps=False)
    half = L.KABUKI_X + 0.2
    mb.cylinder((-half, L.KABUKI_Y, L.KABUKI_TOP), (half, L.KABUKI_Y, L.KABUKI_TOP), 0.024, "truss_black", seg=8)
    for x in (-half + 0.6, -half / 3, half / 3, half - 0.6):
        mb.cylinder((x, L.KABUKI_Y, L.KABUKI_TOP), (x, L.KABUKI_Y, 17.0), 0.008, "truss_black", seg=5, caps=False)
    objs.append(to_object("stage.frame", mb, mats, coll))

    # projectors: each body is a Loom PART in the `rig` area, so the tilt controls turn it.
    # The side bodies pivot about their lens; their hang pipes stay with the static stage.
    hangers = MB()
    for name, lens, aim, _, _ in L.projectors():
        if name == "DS":
            continue
        body = MB()
        centre, u, h = fixture(body, lens, aim)
        hang(hangers, centre, u, h, L.TRUSS_Z - tw / 2)
        objs.append(to_object(f"rig.proj_{name}", body, mats, coll, {"loom_part": f"proj_{name}"}, pivot=lens))
    objs.append(to_object("stage.projector_hangers", hangers, mats, coll))
    # The DS body is built LEVEL (zero tilt), facing the scrim; its pivot is the clamp, and Loom
    # tilts it about that clamp. Its 4' truss, hanger and motor chains are one more part,
    # which Loom only slides in z.
    body = MB()
    lens0 = L.ds_lens(0.0)
    fixture(body, lens0, (lens0[0], lens0[1] + 1.0, lens0[2]))
    # the drop: clamp to cage top, so it tilts with the body
    body.cylinder(L.DS_CLAMP, (L.DS_CLAMP[0], L.DS_CLAMP[1], lens0[2] + 0.15 + 0.035), 0.024, "truss_black", seg=8, caps=False)
    objs.append(to_object("rig.proj_DS", body, mats, coll, {"loom_part": "proj_DS"}, pivot=L.DS_CLAMP))
    rig = MB()
    cx, cy, cz = L.DS_CLAMP
    half = L.DS_TRUSS_HALF
    rig.box_truss((-half, cy, L.TRUSS_Z), (half, cy, L.TRUSS_Z), tw, "truss_black")
    for x in (-half, half):
        rig.box((x, cy, L.TRUSS_Z), (0.06, tw + 0.02, tw + 0.02), "truss_black")
        rig.cylinder((x, cy, L.TRUSS_Z + tw / 2), (x, cy, 17.0), 0.012, "truss_black", seg=5, caps=False)
    rig.cylinder((cx, cy, L.TRUSS_Z - tw / 2), (cx, cy, cz), 0.024, "truss_black", seg=8, caps=False)
    rig.box((cx, cy, L.TRUSS_Z - tw / 2 - 0.03), (0.08, 0.12, 0.06), "truss_black")
    rig.box((cx, cy, cz), (0.16, 0.1, 0.05), "truss_black")
    objs.append(to_object("rig.ds_truss", rig, mats, coll, {"loom_part": "ds_truss"}, pivot=L.DS_CLAMP))

    # pedestals with floor fixtures, the IMAG camera on its tripod
    mb = MB()
    for x in L.PEDESTALS_X:
        y = L.PEDESTAL_Y
        top = L.PEDESTAL_TOP
        mb.span((x - 0.21, y - 0.21, 0.0), (x + 0.21, y + 0.21, top), "deck_skirt", skip=("-z",))
        mb.box((x, y, top + 0.06), (0.42, 0.32, 0.12), "fixture_black")
        for sx in (-1, 1):
            mb.box((x + sx * 0.19, y, top + 0.28), (0.04, 0.12, 0.34), "fixture_black")
        mb.cylinder((x, y - 0.12, top + 0.36), (x, y + 0.2, top + 0.52), 0.13, "fixture_black", seg=14)
    tx_, ty_ = L.TRIPOD
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.4
        mb.cylinder((tx_, ty_, 1.42), (tx_ + 0.62 * math.cos(a), ty_ + 0.62 * math.sin(a), 0.0), 0.018, "truss_black", seg=6)
    mb.box((tx_, ty_, 1.55), (0.22, 0.42, 0.24), "fixture_black")
    mb.cylinder((tx_, ty_ + 0.2, 1.57), (tx_, ty_ + 0.42, 1.57), 0.07, "lens_glass", seg=14)
    objs.append(to_object("stage.house_rig", mb, mats, coll))

    # pixel lines (ACME Pixel Line IP): four rows on hung 12" box trusses behind the scrim, three on
    # a pipe rack in front of the riser. Housings and rigging are `grid.*`; each bar's face is
    # PIXELS_PER_BAR quads, each showing the FX feed's top half at its own place across the
    # stage and up it (`led.*`, unlit in Loom).
    mb = MB()
    pixels = MB()
    depth, height = L.PIXEL_BAR_SECTION
    half_row = L.PIXEL_ROW_W / 2
    for z in L.PIXEL_TRUSS_Z:
        zc = H + z
        mb.box_truss((-half_row - 0.15, L.GRID_Y, zc), (half_row + 0.15, L.GRID_Y, zc), L.PIXEL_TRUSS, "truss_black", chord=0.019, lace=0.009)
        for x in (-half_row + 0.6, 0.0, half_row - 0.6):
            mb.cylinder((x, L.GRID_Y, zc + L.PIXEL_TRUSS / 2), (x, L.GRID_Y, 17.0), 0.008, "truss_black", seg=5, caps=False)
    rack_top = H + max(L.PIXEL_RACK_Z) + 0.25
    post_y = L.PIXEL_RACK_Y + depth / 2 + 0.03
    for x in L.PIXEL_RACK_POSTS:
        mb.span((x - 0.305, post_y - 0.305, L.GRATE_TOP), (x + 0.305, post_y + 0.305, L.GRATE_TOP + 0.012), "trim", skip=("-z",))
        mb.cylinder((x, post_y, L.GRATE_TOP), (x, post_y, rack_top), 0.024, "trim", seg=10)
    for z in L.PIXEL_RACK_Z:
        mb.cylinder((-half_row - 0.1, post_y, H + z), (half_row + 0.1, post_y, H + z), 0.024, "trim", seg=10)
    n = L.PIXELS_PER_BAR
    for _, _, x0, x1, zc, y in L.pixel_bars():
        mb.span((x0, y - depth / 2, zc - height / 2), (x1, y + depth / 2, zc + height / 2), "fixture_black")
        face = y - depth / 2 - 0.002
        lo, hi = x0 + 0.01, x1 - 0.01
        for k in range(n):
            a = lo + (hi - lo) * k / n
            b = lo + (hi - lo) * (k + 1) / n
            pixels.emitter([(a, face, zc - 0.018), (b, face, zc - 0.018), (b, face, zc + 0.018), (a, face, zc + 0.018)],
                           "emitter", L.fx_texel_bar((a + b) / 2, zc))
    objs.append(to_object("grid.pixel_lines", mb, mats, coll))
    objs.append(to_object("led.pixels", pixels, mats, coll))

    # the drapes
    mb = MB()
    scrim(mb, "curtain_white", seed=1.3)
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
    for name, lens, aim, throw, keystone in L.projectors():
        ob = bpy.data.objects.new(f"proj.{name}", None)
        ob.empty_display_type = "CONE"
        ob.empty_display_size = 0.5
        ob.location = lens
        ob.rotation_euler = (Vector(aim) - Vector(lens)).to_track_quat("-Z", "Y").to_euler()
        ob["loom_look_at"] = gltf(aim)
        ob["loom_throw_ratio"] = round(throw, 4)
        ob["loom_aspect"] = round(L.PROJ_ASPECT, 4)
        ob["loom_keystone_h"] = round(keystone, 4)
        if name == "DS":
            # How the DS lens rides its clamp: Loom recomputes the lens from these as the
            # truss slides and the body tilts (all glTF, metres and degrees).
            ob["loom_pivot"] = gltf(L.DS_CLAMP)
            ob["loom_lens_offset"] = [round(L.DS_LENS_FORWARD, 5), round(L.DS_LENS_DROP, 5)]
            ob["loom_tilt_deg"] = round(L.ds_rest_tilt(), 4)
            ob["loom_curtain_z"] = round(-L.CURTAIN_Y, 5)
        coll.objects.link(ob)
    x0, x1, z0, z1 = L.canvas()
    ob = bpy.data.objects.new("canvas.US", None)
    ob.location = (0.0, L.CURTAIN_Y, 0.5 * (z0 + z1))
    ob["loom_canvas"] = [x0, x1, z0, z1, -L.CURTAIN_Y]  # glTF: x range, y range, z of the plane
    ob["loom_deck_top"] = L.GRATE_TOP  # the floor the side projectors throw on: the grated stage deck
    coll.objects.link(ob)


def write_fx_map(folder):
    """The FX feed's pixel map, from the same layout the GLB's uvs come from: a 1920 x 1080 PNG
    template (Loom's grid test for the feed; a reference layer in Resolume), an SVG of it with
    every fixture labelled, and a CSV of every pixel's and strobe's texel."""
    import colorsys
    import numpy as np
    w, h = L.FX_SIZE
    img = np.zeros((h, w, 4), dtype=np.float32)
    img[..., 3] = 1.0
    img[: h // 2, ::64, :3] = 0.07                      # top: a line every foot across (64 px)
    img[h // 2:, ::40, :3] = 0.07                       # bottom: a line every foot across (40 px)
    img[h // 2 - 1: h // 2 + 1, :, :3] = 0.35           # the halves
    rows_csv = ["id,fixture,kind,x_m,y_m,z_m,col,row"]
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" font-family="Helvetica" font-size="11">',
           f'<rect width="{w}" height="{h}" fill="#000"/>',
           f'<line x1="0" y1="{h // 2}" x2="{w}" y2="{h // 2}" stroke="#666"/>',
           '<text x="8" y="16" fill="#aaa" font-size="14">TOP HALF: ACME Pixel Line IP x 63, front elevation (64 px/ft across; one texel row per bar row)</text>',
           f'<text x="8" y="{h // 2 + 18}" fill="#aaa" font-size="14">BOTTOM HALF: GLP JDC Burst 1 x 38, plan, downstage at the bottom (40 px/ft across, 22.5 px/ft deep)</text>']
    n = L.PIXELS_PER_BAR
    for bar_id, r, x0, x1, z, y in L.pixel_bars():
        bar_index = int(bar_id.split(".")[1])
        rgb = colorsys.hsv_to_rgb(r / 7.0, 0.85, 1.0 if bar_index % 2 else 0.55)
        lo, hi = x0 + 0.01, x1 - 0.01
        for k in range(n):
            a = lo + (hi - lo) * k / n
            b = lo + (hi - lo) * (k + 1) / n
            col, row = L.fx_texel_bar((a + b) / 2, z)
            c0, _ = L.fx_texel_bar(a, z)
            c1, _ = L.fx_texel_bar(b, z)
            # the sample row, padded a pixel each way, in full colour; a dim margin a row past it
            pad = L.FX_ZONE_PAD
            first, last = k == 0, k == n - 1
            x0z, x1z = c0 - (pad if first else 0), max(c1, c0 + 1) + (pad if last else 0)
            img[max(row - pad - 2, 0): row + pad + 3, x0z: x1z, :3] = [v * 0.45 for v in rgb]
            img[max(row - pad, 0): row + pad + 1, x0z: x1z, :3] = rgb
            rows_csv.append(f"{bar_id}:{k + 1:02d},ACME Pixel Line IP,pixel,{(a + b) / 2:.4f},{y:.4f},{z:.4f},{col},{row}")
        c0, row = L.fx_texel_bar(lo, z)
        c1, _ = L.fx_texel_bar(hi, z)
        hexc = "#%02x%02x%02x" % tuple(int(v * 255) for v in rgb)
        zh = L.FX_ZONE_PAD
        svg.append(f'<rect x="{c0 - zh}" y="{row - zh}" width="{c1 - c0 + 2 * zh}" height="{2 * zh + 1}" fill="{hexc}"/>')
        svg.append(f'<text x="{c0 + 2}" y="{row - zh - 4}" fill="{hexc}">{bar_id}</text>')
    bl, bw, _ = L.STROBE_BODY
    half_w = int(bl / L.FT * 40 / 2) + L.FX_ZONE_PAD
    half_h = int(bw / L.FT * 22.5 / 2) + L.FX_ZONE_PAD
    for i, (sid, (x, y), _, z) in enumerate(L.strobes()):
        if sid.startswith("S"):
            k = int(sid[1:]) - 1
            rgb = colorsys.hsv_to_rgb((k % 6) / 6.0, 0.8, 1.0 - 0.12 * (k // 6))
        else:
            rgb = (1.0, 0.92, 0.75)
        col, row = L.fx_texel_strobe(x, y)
        img[row - half_h: row + half_h + 1, col - half_w: col + half_w + 1, :3] = rgb
        rows_csv.append(f"{sid},GLP JDC Burst 1,strobe,{x:.4f},{y:.4f},{z:.4f},{col},{row}")
        hexc = "#%02x%02x%02x" % tuple(int(v * 255) for v in rgb)
        svg.append(f'<rect x="{col - half_w}" y="{row - half_h}" width="{2 * half_w + 1}" height="{2 * half_h + 1}" fill="{hexc}"/>')
        svg.append(f'<text x="{col - half_w}" y="{row - half_h - 3}" fill="#ddd">{sid} ({col},{row})</text>')
    svg.append("</svg>")
    os.makedirs(folder, exist_ok=True)
    image = bpy.data.images.new("fx-pixel-map", w, h, alpha=True)
    image.pixels.foreach_set(np.ascontiguousarray(img[::-1]).ravel())   # Blender rows run bottom-up
    image.filepath_raw = os.path.join(folder, "fx-pixel-map.png")
    image.file_format = "PNG"
    image.save()
    with open(os.path.join(folder, "fx-pixel-map.svg"), "w") as fh:
        fh.write("\n".join(svg))
    with open(os.path.join(folder, "fx-pixel-map.csv"), "w") as fh:
        fh.write("\n".join(rows_csv) + "\n")
    print(f"[fxmap] {folder}/fx-pixel-map.{{png,svg,csv}}: {len(rows_csv) - 1} texels "
          f"({len(L.pixel_bars())} bars x {L.PIXELS_PER_BAR} px, {len(L.strobes())} strobes)")


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
    ap.add_argument("--fxmap", default=None, help="folder for fx-pixel-map.{png,svg,csv}")
    a = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    mats = build_materials()
    coll = scene.collection
    objs = build_stage(mats, coll)
    build_markers(coll)
    build_cameras(coll)
    for name, lens, aim, throw, keystone in L.projectors():
        print(f"[proj] {name}: lens {tuple(round(c, 2) for c in lens)} aim {tuple(round(c, 2) for c in aim)} "
              f"throw {math.dist(lens, aim):.2f} m, ratio {throw:.3f}, keystone H {keystone:.2f}°")
    reach = L.STAGE_W / 2 + L.PROJ_SIDE_NEAR
    print(f"[proj] sides: crossed, keystoned square, each {reach / L.FT:.1f}' x {(L.DS_STRIP[1] - L.DS_STRIP[0]) / L.FT:.0f}' on the deck, "
          f"far edge on the far deck edge, near edge {(L.STAGE_W / 2 - L.PROJ_SIDE_NEAR) / L.FT:.1f}' in from its own; "
          f"overlap in the middle {2 * L.PROJ_SIDE_NEAR / L.FT:.1f}'")

    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB",
        export_draco_mesh_compression_enable=False,
        export_apply=True, export_yup=True, export_extras=True,
        export_cameras=True, export_lights=False,
        export_normals=True, export_texcoords=True, export_tangents=False,
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
    if a.fxmap:
        write_fx_map(os.path.abspath(a.fxmap))
    if a.preview:
        preview(a.preview, objs)


main()
