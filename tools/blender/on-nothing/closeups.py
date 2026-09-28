"""Close-up props for the On Nothing look study (T1407b, closeups).

Two of the reference's close-up shots (docs/on-nothing-shotlist-2026-09-27.md):

- `pend.*` (the `pendant` shot, the reference's 1:37 macro): an iced script pendant on a Cuban
  link chain, in front of a dark knit chest and a grey-teal wall, standing at PEND (far from
  every other set, like the quad's void). The pavé is drawn by loom's closeup surface
  (src/projects/on-nothing/shots/closeups-surface.ts), which breaks every front face into
  faceted stones, so the mesh only carries WHICH faces are paved.
- `shoe.*` (the `sneaker` shot, the reference's 1:42): a white leather low-top, laces loose,
  standing on the black car's bonnet. The black car (`car4`) is MOVED for this shot by
  SNEAKER_CAR_SHIFT (loom translates the car's mesh by the same vector, read from the camera's
  extras), so the shoe is built where the moved car's bonnet will be.

Every face carries its own material class (see LIB). The shoe's frame (origin and axes) rides on
the `prop.shoe` marker, so loom's surface draws the panels, the stitching and the perforations
in the shoe's own coordinates without a texture.
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import util

# name: (base rgb, metallic, roughness, class code). Codes 50+ are the closeups' own classes.
LIB = {
    "cu_pave": ((0.96, 0.96, 0.98), 1.0, 0.03, 50),
    "cu_metal": ((0.93, 0.93, 0.95), 1.0, 0.07, 51),
    "cu_leather": ((0.80, 0.80, 0.78), 0.0, 0.42, 52),
    "cu_sole": ((0.82, 0.82, 0.80), 0.0, 0.62, 53),
    "cu_lace": ((0.84, 0.84, 0.82), 0.0, 0.85, 54),
    "cu_backdrop": ((0.30, 0.34, 0.34), 0.0, 0.92, 55),
    "cu_knit": ((0.02, 0.02, 0.022), 0.0, 0.9, 56),
    "cu_insole": ((0.05, 0.05, 0.05), 0.0, 0.9, 57),
    "cu_window": ((0.0, 0.0, 0.0), 0.0, 1.0, 58),
}

FONTS = [
    "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc",
    "/System/Library/Fonts/Supplemental/Zapfino.ttf",
    "/System/Library/Fonts/Supplemental/Apple Chancery.ttf",
]

# The pendant set: far out on +X (the quad's void is at -60), so nothing else is ever in frame.
PEND = Vector((60.0, 0.0, 1.3))
PENDANT_WIDTH = 0.105
# the macro's lens, from the pendant: off to its right and a little above, so the word runs away
# from the lens and the plane of focus cuts across it
PEND_EYE = Vector((0.25, -0.2, 0.05))

# The sneaker shot: the black car (car4, the escalade) moves forward so its bonnet sits beside
# the camera, which looks across it at the white car3's front three-quarter (build.py's CARS; a
# car's nose is at its `loc`, its body runs back along +Y). The shot draws neither car0 nor car2:
# the moved car stands where car2 is, and car0 would block the view.
SNEAKER_CAR = 4
SNEAKER_CAR_SHIFT = Vector((0.305, -3.16, 0.0))
SHOE_LENGTH = 0.29


def materials():
    mats = {}
    for name, (base, met, rough, code) in LIB.items():
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*base, 1.0)
        bsdf.inputs["Metallic"].default_value = met
        bsdf.inputs["Roughness"].default_value = rough
        m["loom_heat"] = code / 64.0
        m.diffuse_color = (*base, 1.0)
        mats[name] = m
    return mats


def _select_only(ob):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)


# ─────────────────────────────── the pendant ───────────────────────────────


def _script(coll, mats, text, width, centre):
    """The word in a copperplate script, fattened and bevelled into bubble letters, facing -Y."""
    curve = bpy.data.curves.new("pend.script", "FONT")
    curve.body = text
    for path in FONTS:
        if os.path.exists(path):
            try:
                curve.font = bpy.data.fonts.load(path)
                break
            except RuntimeError:
                continue
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = 1.0
    curve.resolution_u = 8
    ob = bpy.data.objects.new("pend.script", curve)
    coll.objects.link(ob)
    bpy.context.view_layer.update()
    s = width / max(ob.dimensions.x, 1e-6)
    # thickness and roundness in curve units (the object is scaled by s afterwards)
    curve.offset = 0.0012 / s
    curve.extrude = 0.0026 / s
    curve.bevel_depth = 0.0024 / s
    curve.bevel_resolution = 4
    ob.scale = (s, s, s)
    ob.rotation_euler = (math.pi / 2, 0, 0)
    ob.location = centre
    _select_only(ob)
    bpy.ops.object.convert(target="MESH")
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = ob.data
    me.materials.clear()
    me.materials.append(mats["cu_pave"])
    me.materials.append(mats["cu_metal"])
    # the paved face is what looks at the camera (and the bevel's shoulder); sides and back are polished
    for p in me.polygons:
        p.material_index = 0 if p.normal.y < -0.35 else 1
    me.shade_smooth()
    return ob


def _link(mb, centre, axis, across, length, width, thickness, seg=20, rseg=10):
    """One Cuban link: a flattened, elongated torus. `axis` along the chain, `across` its flat side."""
    a = Vector(axis).normalized()
    b = Vector(across).normalized()
    n = a.cross(b).normalized()
    b = n.cross(a).normalized()
    R_a, R_b = length / 2 - width / 2, width * 0.5
    verts = []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        c = Vector(centre) + a * (R_a * math.cos(t)) + b * (R_b * 0.55 * math.sin(t))
        radial = (a * math.cos(t) * R_b * 0.55 / max(R_a, 1e-6) + b * math.sin(t)).normalized()
        radial = (a * math.cos(t) + b * math.sin(t)).normalized()
        for j in range(rseg):
            s = 2 * math.pi * j / rseg
            verts.append(c + radial * (width * 0.32 * math.cos(s)) + n * (thickness * 0.5 * math.sin(s)))
    faces = []
    for i in range(seg):
        for j in range(rseg):
            i2, j2 = (i + 1) % seg, (j + 1) % rseg
            faces.append((i * rseg + j, i2 * rseg + j, i2 * rseg + j2, i * rseg + j2))
    base = len(mb.verts)
    mb.add(verts, faces, "cu_pave")
    # the link's inside and back faces are polished metal, its outer front face paved
    for k in range(len(faces)):
        f = faces[k]
        c = sum((verts[v] for v in f), Vector()) / 4
        if (c - Vector(centre)).dot(n) < thickness * 0.15:
            mb.fmats[len(mb.fmats) - len(faces) + k] = "cu_metal"
    return base


def _chain(mb, start, direction, links, pitch=0.0105, sag=0.0):
    """A strand of Cuban links from `start` along `direction` (bending by `sag` per link)."""
    d = Vector(direction).normalized()
    p = Vector(start)
    face = Vector((0, -1, 0))
    for k in range(links):
        across = face.cross(d).normalized()
        # alternate links turn 90° about the chain's axis, with the Cuban twist between them
        twist = (math.pi / 2 if k % 2 else 0.0) + 0.35
        rot = Matrix.Rotation(twist, 3, d)
        _link(mb, p + d * pitch * 0.5, d, rot @ across, pitch * 1.55, 0.0085, 0.0034)
        p = p + d * pitch
        d = (d + Vector((0, 0, sag))).normalized()


def pendant(ctx, mats):
    coll = ctx["coll"]
    script = _script(coll, mats, "Nothing", PENDANT_WIDTH, PEND)
    script.name = "pend.script"
    xs = [v.co.x for v in script.data.vertices]
    zs = [v.co.z for v in script.data.vertices]
    top = max(zs)
    # the bail sits on the highest stroke: find the x where the letters reach highest
    tall = max(script.data.vertices, key=lambda v: v.co.z).co
    bail_at = Vector((tall.x, PEND.y + 0.001, top + 0.006))
    mb = util.MB("pend.chain")
    mb.torus(bail_at, (1, 0, 0), 0.0055, 0.0016, 28, 10, "cu_metal")
    # the two strands of the necklace rise from the bail in a V, out of the top of frame
    _chain(mb, bail_at + Vector((-0.004, 0, 0.004)), (-0.42, 0.05, 1.0), 16, sag=0.012)
    _chain(mb, bail_at + Vector((0.004, 0, 0.004)), (0.42, 0.05, 1.0), 16, sag=0.012)
    chain = mb.to_object(mats, coll, smooth_deg=None)
    chain.name = "pend.chain"

    # the dark knit chest behind it: a rounded shoulder filling the left of the frame, its edge
    # rolling away just left of the pendant, so the grey-teal wall shows on the right
    view = Vector((-PEND_EYE.x, -PEND_EYE.y, 0)).normalized()
    left = Vector((-view.y, view.x, 0))
    back = util.MB("pend.chest")
    rings, seg, r = 24, 64, 0.13
    axis_at = PEND + view * 0.28 + left * 0.16
    verts, faces = [], []
    for i in range(rings + 1):
        z = -0.4 + 0.8 * i / rings
        for j in range(seg):
            a = 2 * math.pi * j / seg
            verts.append(axis_at + Vector((r * math.cos(a), r * math.sin(a) * 0.8, z)))
    for i in range(rings):
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((i * seg + j, i * seg + j2, (i + 1) * seg + j2, (i + 1) * seg + j))
    back.add(verts, faces, "cu_knit")
    ob = back.to_object(mats, coll, smooth_deg=None)
    util.recalc_outside(ob)
    wall = util.MB("pend.wall")
    wall.box(PEND + Vector((0.0, 1.6, 0.0)), (6.0, 0.05, 4.0), "cu_backdrop")
    wob = wall.to_object(mats, coll, smooth_deg=None)
    util.face_toward(wob, PEND)
    for o in (script, chain, ob, wob):
        o["loom_area"] = "pend"
    print(f"[closeups] pendant: {len(script.data.vertices):,} + {len(chain.data.vertices):,} vertices, x {min(xs) - PEND.x:+.3f}..{max(xs) - PEND.x:+.3f}", flush=True)
    return bail_at


# ─────────────────────────────── the sneaker ───────────────────────────────
# Shoe-local metres: x across (+x lateral, a right shoe), y heel (0) to toe (L), z up from the ground.

L = SHOE_LENGTH


def half_width(y):
    """The last's half-width at y: a round heel, a narrow waist, the ball, an elliptical toe."""
    if y <= 0.0 or y >= L:
        return 0.0
    if y < 0.036:
        return math.sqrt(max(0.036 ** 2 - (0.036 - y) ** 2, 0.0))
    if y < 0.20:
        t = (y - 0.036) / (0.20 - 0.036)
        waist = 0.036 - 0.004 * math.sin(math.pi * min(t / 0.55, 1.0))
        return waist + (0.047 - 0.036) * (t * t * (3 - 2 * t))
    t = (y - 0.20) / (L - 0.20)
    return 0.047 * math.sqrt(max(1.0 - t * t, 0.0)) ** 0.9


def centre_x(y):
    # the medial side runs straighter than the lateral: the centre line bows out a little
    return 0.005 * math.sin(math.pi * y / L)


def top_height(y):
    """Height of the closed 'last' the upper is cut from (the opening removes its roof)."""
    table = [(0.0, 0.076), (0.03, 0.084), (0.08, 0.092), (0.13, 0.096), (0.17, 0.091), (0.2, 0.078),
             (0.225, 0.062), (0.25, 0.051), (0.27, 0.044), (0.283, 0.039), (L, 0.034)]
    return _pchip(table, y)


def _pchip(table, x):
    """Monotone cubic interpolation through (x, y) keys: smooth, and never overshooting."""
    xs = [k[0] for k in table]
    ys = [k[1] for k in table]
    n = len(xs)
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else 2 / (1 / d[i - 1] + 1 / d[i]) for i in range(1, n - 1)] + [d[-1]]
    i = max(k for k in range(n - 1) if xs[k] <= x)
    h = xs[i + 1] - xs[i]
    t = (x - xs[i]) / h
    h00, h10, h01, h11 = 2 * t ** 3 - 3 * t ** 2 + 1, t ** 3 - 2 * t ** 2 + t, -2 * t ** 3 + 3 * t ** 2, t ** 3 - t ** 2
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]


def sole_bottom(y):
    """Toe spring and a rounded heel strike: how far the outsole lifts off the ground."""
    toe = max(0.0, (y - 0.225) / (L - 0.225)) ** 2 * 0.016
    heel = max(0.0, (0.03 - y) / 0.03) ** 2 * 0.004
    return toe + heel


SOLE_TOP = 0.031


def _stations(n):
    # dense at the rounded ends
    return [L * (1 - math.cos(math.pi * (i + 0.5) / n)) / 2 for i in range(n)]


def _sole(mb):
    """A cupsole: a sidewall lofted round the footprint, a rounded lower edge, a flat top."""
    ys = _stations(64)
    loop = [(centre_x(y) + half_width(y), y) for y in ys] + [(centre_x(y) - half_width(y), y) for y in reversed(ys)]
    n = len(loop)
    # (height above the sole's bottom as a share of its height, outward offset metres)
    levels = [(0.0, -0.004), (0.03, -0.0005), (0.12, 0.0022), (0.3, 0.0035), (0.55, 0.0038), (0.62, 0.0030),
              (0.66, 0.0038), (0.9, 0.0036), (1.0, 0.0022)]

    def outward(k):
        x0, y0 = loop[(k - 1) % n]
        x1, y1 = loop[(k + 1) % n]
        t = Vector((x1 - x0, y1 - y0, 0)).normalized()
        o = Vector((t.y, -t.x, 0))
        away = Vector((loop[k][0], loop[k][1] - L / 2, 0))
        return o if o.dot(away) >= 0 else -o

    outs = [outward(k) for k in range(n)]
    verts, uvs = [], []
    for h, off in levels:
        for k, (x, y) in enumerate(loop):
            zb = sole_bottom(y)
            z = zb + (SOLE_TOP - zb) * h
            p = Vector((x, y, z)) + outs[k] * off
            verts.append(p)
    faces = []
    for i in range(len(levels) - 1):
        for k in range(n):
            a, b = i * n + k, i * n + (k + 1) % n
            faces.append((a, b, b + n, a + n))
    base = mb.add(verts, faces, "cu_sole")
    # the bottom and the top: fans to a centre line
    bottom = [base + k for k in range(n)]
    top = [base + (len(levels) - 1) * n + k for k in range(n)]
    for ring, z_of in ((bottom, lambda y: sole_bottom(y) + 0.0005), (top, lambda y: SOLE_TOP)):
        c = []
        for y in ys:
            c.append(len(mb.verts))
            mb.verts.append(Vector((centre_x(y), y, z_of(y))))
        m = len(ys)
        for k in range(m - 1):
            # right side vertex k, k+1; left side mirrored index
            r0, r1 = ring[k], ring[k + 1]
            l0, l1 = ring[n - 1 - k], ring[n - 2 - k]
            mb.faces.append([r0, r1, c[k + 1], c[k]]); mb.fmats.append("cu_sole")
            mb.faces.append([c[k], c[k + 1], l1, l0]); mb.fmats.append("cu_sole")
    return len(levels)


def _smooth01(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def opening_half(y):
    """Half-width of the upper's opening in plan: the foot opening, narrowing into the laced throat."""
    if y <= 0.085:
        return half_width(y) * 0.86
    if y < 0.105:
        return half_width(0.085) * 0.86 + (0.013 - half_width(0.085) * 0.86) * _smooth01((y - 0.085) / 0.02)
    if y < 0.196:
        return 0.013 - 0.006 * ((y - 0.105) / 0.091) ** 2
    return 0.007 * (1 - _smooth01((y - 0.196) / 0.009))


def edge_height(y):
    """Height of the upper's top edge: the padded collar round the heel, the eyestays, the vamp."""
    collar = 0.074 - 0.012 * math.sin(math.pi * min(y / 0.1, 1.0)) ** 1.5 - 0.004 * min(y / 0.1, 1.0)
    eyestay = top_height(y) - 0.006
    if y < 0.1:
        return collar
    if y < 0.118:
        return collar + (eyestay - collar) * _smooth01((y - 0.1) / 0.018)
    if y < 0.196:
        return eyestay
    return eyestay + (top_height(y) - eyestay) * _smooth01((y - 0.196) / 0.009)


def _upper_shell(coll, mats):
    """The upper as walls: every point round the footprint rises from the sole in a rounded arc and
    turns in to the top edge (the collar, the eyestays), and over the toe the two sides' arcs meet
    on the centre line as the vamp. The opening is where the two sides do not meet, so its rim is
    the analytic top edge, not a cut."""
    ys = _stations(150)
    m = len(ys)
    rows = 40
    z0 = SOLE_TOP - 0.004
    ne = 2.6
    me = bpy.data.meshes.new("shoe.upper")
    bm = bmesh.new()
    grid = []
    # the perimeter: the lateral side heel to toe, then the medial side toe to heel
    loop = [(1, y) for y in ys] + [(-1, y) for y in reversed(ys)]
    for side, y in loop:
        cx = centre_x(y)
        x0 = cx + side * max(half_width(y) - 0.0012, 0.0)
        xt = cx + side * opening_half(y)
        zt = edge_height(y)
        col = []
        for r in range(rows + 1):
            phi = (math.pi / 2) * r / rows
            c, s_ = math.cos(phi), math.sin(phi)
            x = xt + (x0 - xt) * c ** (2 / ne)
            z = z0 + (zt - z0) * s_ ** (2 / ne)
            col.append(bm.verts.new((x, y, z)))
        grid.append(col)
    n = len(grid)
    for k in range(n):
        k2 = (k + 1) % n
        for r in range(rows):
            bm.faces.new((grid[k][r], grid[k2][r], grid[k2][r + 1], grid[k][r + 1]))
    # the two sides' top edges coincide over the toe (both at the centre line): weld them
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0004)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("shoe.upper", me)
    coll.objects.link(ob)
    me.materials.append(mats["cu_leather"])
    return ob


def _boundary_loops(ob):
    """The open edges of a mesh, chained into loops of vertex positions."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    edges = [e for e in bm.edges if e.is_boundary]
    adj = {}
    for e in edges:
        a, b = e.verts
        adj.setdefault(a.index, []).append(b.index)
        adj.setdefault(b.index, []).append(a.index)
    co = {v.index: v.co.copy() for v in bm.verts}
    bm.free()
    seen, loops = set(), []
    for start in adj:
        if start in seen:
            continue
        loop, prev, cur = [start], None, start
        seen.add(start)
        while True:
            nxt = [v for v in adj[cur] if v != prev and v not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        if len(loop) > 8:
            loops.append([co[i] for i in loop])
    return loops


def _tube(mb, points, radius, mat, closed=True, rseg=10, lift=None):
    """A tube along a polyline (the padded collar, a lace)."""
    pts = [Vector(p) for p in points]
    n = len(pts)
    if n < 2:
        return
    rings = []
    for k in range(n):
        a = pts[(k - 1) % n] if (closed or k > 0) else pts[k]
        b = pts[(k + 1) % n] if (closed or k < n - 1) else pts[k]
        t = (b - a).normalized()
        u = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        x = t.cross(u).normalized()
        y = t.cross(x).normalized()
        r = radius(k / max(n - 1, 1)) if callable(radius) else radius
        ring = []
        for j in range(rseg):
            s = 2 * math.pi * j / rseg
            ring.append(pts[k] + (x * math.cos(s) + y * math.sin(s)) * r)
        rings.append(ring)
    base = len(mb.verts)
    for ring in rings:
        mb.verts.extend(ring)
    last = n if closed else n - 1
    for k in range(last):
        k2 = (k + 1) % n
        for j in range(rseg):
            j2 = (j + 1) % rseg
            mb.faces.append([base + k * rseg + j, base + k * rseg + j2, base + k2 * rseg + j2, base + k2 * rseg + j])
            mb.fmats.append(mat)
    if not closed:
        for k, flip in ((0, True), (n - 1, False)):
            ring = [base + k * rseg + j for j in range(rseg)]
            mb.faces.append(list(reversed(ring)) if flip else ring)
            mb.fmats.append(mat)


def _resample(points, spacing, closed=True):
    pts = [Vector(p) for p in points]
    if closed:
        pts = pts + [pts[0]]
    out = [pts[0]]
    carry = 0.0
    for a, b in zip(pts, pts[1:]):
        seg = (b - a).length
        d = spacing - carry
        while d <= seg:
            out.append(a.lerp(b, d / seg))
            d += spacing
        carry = seg - (d - spacing)
    return out[:-1] if closed else out


def _smooth(points, passes=4, closed=True):
    pts = [Vector(p) for p in points]
    n = len(pts)
    for _ in range(passes):
        pts = [pts[k] * 0.5 + (pts[(k - 1) % n] + pts[(k + 1) % n]) * 0.25 if closed or 0 < k < n - 1 else pts[k] for k in range(n)]
    return pts


def sneaker(ctx, mats, place, area="shoe", held=False):
    """The shoe, built shoe-local then turned by `place` (a 4x4 Matrix) onto the bonnet. `held`
    (closeups2.py, T1407b closeups2): the loose lace ends hang below the sole instead of draping
    onto the paint, and the shoe's objects are named into `area`."""
    coll = ctx["coll"]
    upper = _upper_shell(coll, mats)
    loops = _boundary_loops(upper)

    parts = util.MB("shoe.parts")
    _sole(parts)
    # the padded collar round the foot opening and the throat: thick at the heel, thin at the eyestays
    for loop in loops:
        pts = _smooth(_resample(loop, 0.0015), 6)
        lifted, rad = [], []
        for p in pts:
            dx = centre_x(p.y) - p.x
            inward = Vector((1.0 if dx > 0 else -1.0, 0, 0))
            r = 0.0048 if p.y < 0.10 else 0.0022
            lifted.append(p + inward * r * 0.5 - Vector((0, 0, r * 0.3)))
            rad.append(r)
        rad = _smooth([Vector((r, 0, 0)) for r in rad], 8)
        _tube(parts, lifted, lambda t, rad=rad: rad[min(int(round(t * (len(rad) - 1))), len(rad) - 1)].x, "cu_leather", closed=True, rseg=12)

    # the tongue: a padded panel under the laces, standing up out of the collar at the back
    tongue_verts, tongue_faces = [], []
    ny, nx = 30, 14
    for i in range(ny + 1):
        y = 0.078 + (0.206 - 0.078) * i / ny
        for j in range(nx + 1):
            u = -1 + 2 * j / nx
            # a rounded free end: the outline closes in over its last 14 mm
            end = min(max((y - 0.078) / 0.014, 0.0), 1.0)
            half = (0.025 - 0.005 * (i / ny) ** 2) * math.sqrt(1 - (1 - end) ** 2) ** 0.8
            x = centre_x(y) + u * max(half, 0.004)
            z = top_height(y) - 0.0045 - 0.009 * u * u
            # its free end stands proud of the collar, the shoe's highest point, curling back
            rise = max(0.0, (0.122 - y) / 0.044) ** 1.4 * 0.022
            curl = max(0.0, (0.092 - y) / 0.014) ** 2 * 0.006
            tongue_verts.append(Vector((x, y - rise * 0.25 + curl, z + rise - curl * 0.3)))
    for i in range(ny):
        for j in range(nx):
            a = i * (nx + 1) + j
            tongue_faces.append((a, a + 1, a + nx + 2, a + nx + 1))
    tb = parts.add(tongue_verts, tongue_faces, "cu_leather")
    # tongue thickness: a copy below, and the rim between
    under = [v - Vector((0, 0, 0.004)) for v in tongue_verts]
    ub = parts.add(under, [tuple(reversed(f)) for f in tongue_faces], "cu_insole")
    rim = []
    ring = [(0, j) for j in range(nx + 1)] + [(i, nx) for i in range(1, ny + 1)] + [(ny, j) for j in range(nx - 1, -1, -1)] + [(i, 0) for i in range(ny - 1, 0, -1)]
    for k in range(len(ring)):
        i0, j0 = ring[k]
        i1, j1 = ring[(k + 1) % len(ring)]
        a0, a1 = i0 * (nx + 1) + j0, i1 * (nx + 1) + j1
        rim.append((tb + a0, ub + a0, ub + a1, tb + a1))
    for f in rim:
        parts.faces.append(list(f))
        parts.fmats.append("cu_leather")

    # six pairs of eyelets along the throat, and flat laces straight across (the loose ends hang)
    eyelets = []
    for k in range(6):
        y = 0.116 + k * 0.0152
        g = opening_half(y)
        pair = []
        for side in (-1, 1):
            x = centre_x(y) + side * (g + 0.0062)
            z = edge_height(y) - 0.0004
            parts.torus((x, y, z), (0, 0, 1), 0.0032, 0.0011, 16, 6, "cu_metal")
            pair.append(Vector((x, y, z)))
        eyelets.append(pair)
    for k, (l, r) in enumerate(eyelets):
        mid = (l + r) / 2 + Vector((0, 0, 0.0055))
        path = [l + Vector((0, 0, 0.001)), l.lerp(mid, 0.5) + Vector((0, 0, 0.0028)), mid, r.lerp(mid, 0.5) + Vector((0, 0, 0.0028)), r + Vector((0, 0, 0.001))]
        path = _resample(path, 0.002, closed=False) + [path[-1]]
        _flat_lace(parts, path, 0.0075, 0.0014)
    # the loose ends: round cords that leave the top eyelets outward, hang in a soft catenary
    # clear of the upper, touch down on the paint beside the shoe arriving level, and run on in a
    # lazy S (shoe-local z = 0 is the paint: seat() puts it there)
    cord = 0.0021
    for side, start, run in ((-1, eyelets[0][0], (-0.45, 0.89)), (1, eyelets[0][1], (0.55, -0.83))):
        a0 = start + Vector((0, 0, 0.002))
        if held:
            _hanging_lace(parts, a0, side, cord)
            continue
        touch = Vector((centre_x(start.y) + side * (half_width(start.y) + 0.065), start.y + 0.012 * side, cord))
        ground = Vector((run[0] * side * side, run[1], 0)).normalized()
        # a cubic from the eyelet (leaving outward and a little up) to the touchdown (arriving level)
        p1 = a0 + Vector((side * 0.04, 0.0, 0.012))
        p2 = touch - ground * 0.035 + Vector((0, 0, 0.018))
        pts = []
        for k in range(28):
            t = k / 27
            u = 1 - t
            pts.append(a0 * u ** 3 + p1 * 3 * u * u * t + p2 * 3 * u * t * t + touch * t ** 3)
        # on the paint: an S, the cord's own weight flattening it
        across = Vector((-ground.y, ground.x, 0))
        for k in range(1, 26):
            t = k / 25
            pts.append(touch + ground * (0.065 * t) + across * (0.012 * math.sin(t * math.pi * 1.6)) + Vector((0, 0, 0)))
        path = _smooth(_resample(pts, 0.002, closed=False), 3, closed=False)
        _tube(parts, path, cord, "cu_lace", closed=False, rseg=10)
        # a plastic aglet on the end
        tip = path[-1]
        _tube(parts, [tip, tip + (path[-1] - path[-3]).normalized() * 0.017], cord * 0.95, "cu_lace", closed=False, rseg=10)
    parts_ob = parts.to_object(mats, coll, smooth_deg=50)
    # UV for the parts too: along the shoe and up, so the sole's sidewall texture has its axes
    _planar_uv(parts_ob)
    # thickness on the upper leather, then place both on the bonnet
    _select_only(upper)
    mod = upper.modifiers.new("solid", "SOLIDIFY")
    mod.thickness = 0.0022
    mod.offset = -1
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mod = upper.modifiers.new("sub", "SUBSURF")
    mod.levels = 1
    bpy.ops.object.modifier_apply(modifier=mod.name)
    upper.data.shade_smooth()
    _select_only(parts_ob)
    for ob in (upper, parts_ob):
        ob.matrix_world = place @ ob.matrix_world
        _select_only(ob)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        ob["loom_area"] = area
        ob.name = area + ob.name[ob.name.index("."):]
    print(f"[closeups] sneaker: {len(upper.data.vertices):,} + {len(parts_ob.data.vertices):,} vertices", flush=True)


def _hanging_lace(mb, a0, side, cord):
    """A loose end hanging from its top eyelet (the shoe held up, sole down): out over the
    upper's side wall, then down past the sole under its own weight, an aglet on the end."""
    end = a0 + Vector((side * 0.066, 0.012 * side, -0.15))
    p1 = a0 + Vector((side * 0.05, 0.0, 0.014))
    p2 = end + Vector((-side * 0.004, 0.0, 0.09))
    pts = []
    for k in range(40):
        t = k / 39
        u = 1 - t
        pts.append(a0 * u ** 3 + p1 * 3 * u * u * t + p2 * 3 * u * t * t + end * t ** 3)
    path = _smooth(_resample(pts, 0.002, closed=False), 3, closed=False)
    _tube(mb, path, cord, "cu_lace", closed=False, rseg=10)
    tip = path[-1]
    _tube(mb, [tip, tip + (path[-1] - path[-3]).normalized() * 0.017], cord * 0.95, "cu_lace", closed=False, rseg=10)


def _flat_lace(mb, path, width, thickness):
    """A flat woven lace: a thin ribbon along `path`, its flat side up."""
    n = len(path)
    verts, faces = [], []
    for k in range(n):
        a = path[max(k - 1, 0)]
        b = path[min(k + 1, n - 1)]
        t = (b - a).normalized()
        side = t.cross(Vector((0, 0, 1)))
        if side.length < 1e-4:
            side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(t).normalized()
        for s, u in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            verts.append(path[k] + side * (s * width / 2) + up * (u * thickness / 2))
    for k in range(n - 1):
        for j in range(4):
            j2 = (j + 1) % 4
            faces.append((k * 4 + j, k * 4 + j2, (k + 1) * 4 + j2, (k + 1) * 4 + j))
    faces.append((3, 2, 1, 0))
    faces.append(tuple((n - 1) * 4 + j for j in range(4)))
    mb.add(verts, faces, "cu_lace")


def _planar_uv(ob):
    me = ob.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active.data
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv[li].uv = (co.y / L, co.z / 0.12)


def windows(ctx, mats):
    """A band of tall industrial windows on the warehouse's back wall (sets.py: y = 18, eaves at
    7 m), just proud of the brick: what the sneaker shot sees, soft, behind the white car."""
    mb = util.MB("shoe.windows")
    for k in range(9):
        x = -13.0 + k * 2.6
        mb.box((x, 17.8, 3.6), (2.1, 0.02, 3.4), "cu_window")
    ob = mb.to_object(mats, ctx["coll"], smooth_deg=None)
    util.face_toward(ob, (0, 0, 3))
    ob["loom_area"] = "shoe"


_TREES = {}


def cast(car_prefix, origin, direction):
    """The nearest hit of a ray on the named car's meshes (Blender world), or None."""
    dg = bpy.context.evaluated_depsgraph_get()
    best = None
    for ob in bpy.data.objects:
        if ob.type != "MESH" or not ob.name.startswith(car_prefix):
            continue
        inv = ob.matrix_world.inverted()
        d = (inv.to_3x3() @ direction).normalized()
        if ob.name not in _TREES:
            _TREES[ob.name] = BVHTree.FromObject(ob, dg)
        hit = _TREES[ob.name].ray_cast(inv @ origin, d, 5.0)
        if hit[0] is None:
            continue
        world = ob.matrix_world @ hit[0]
        if best is None or (world - origin).length < (best - origin).length:
            best = world
    return best


def seat(car_prefix, at, heading, sink=0.0015):
    """Where the shoe RESTS on the car at `at`: its sole's contact points (heel and ball, not the
    toe spring) cast down onto the paint, a plane fitted through what they hit, and the shoe set
    on that plane with its lowest contact `sink` below the surface — no gap, no float. Returns
    (placement matrix, up, forward, side)."""
    hit, normal = bonnet_point(car_prefix, at.x, at.y)
    up = normal.normalized() if normal.z > 0 else -normal.normalized()
    origin = hit
    contacts = [Vector((centre_x(y) + sx * 0.78 * half_width(y), y, sole_bottom(y)))
                for y in (0.02, 0.05, 0.09, 0.14, 0.19, 0.215) for sx in (-1, 1)]
    for _ in range(4):
        fwd = Vector((math.sin(heading), math.cos(heading), 0))
        fwd = (fwd - up * fwd.dot(up)).normalized()
        side = fwd.cross(up).normalized()
        rot = Matrix((side, fwd, up)).transposed()
        found = []
        for q in contacts:
            p = origin + rot @ q
            h = cast(car_prefix, p + up * 0.2, -up)
            if h is not None:
                found.append((q, p, h))
        if len(found) < 6:
            raise RuntimeError(f"closeups: the shoe at {tuple(round(c, 2) for c in at)} finds only {len(found)} contacts on {car_prefix}")
        # the plane through the hits (least squares z = a x + b y + c in the current frame)
        pts = [rot.transposed() @ (h - origin) for _, _, h in found]
        n = len(pts)
        sx = sum(p.x for p in pts); sy = sum(p.y for p in pts); sz = sum(p.z for p in pts)
        sxx = sum(p.x * p.x for p in pts); syy = sum(p.y * p.y for p in pts); sxy = sum(p.x * p.y for p in pts)
        sxz = sum(p.x * p.z for p in pts); syz = sum(p.y * p.z for p in pts)
        A = Matrix(((sxx, sxy, sx), (sxy, syy, sy), (sx, sy, n)))
        a, b, _c = A.inverted() @ Vector((sxz, syz, sz))
        up = (rot @ Vector((-a, -b, 1.0))).normalized()
        # rest the sole: the contact nearest the surface touches it, sunk `sink`
        gaps = [(p - h).dot(up) for _, p, h in found]
        origin = origin - up * (min(gaps) + sink)

    # A rigid sole on a curved bonnet RESTS on its highest supports and rocks toward where the
    # paint falls away: from the fitted plane, search roll and pitch for the pose whose contacts
    # sit lowest on average once the nearest one touches (the lowest centre of mass).
    def pose(u):
        f = Vector((math.sin(heading), math.cos(heading), 0))
        f = (f - u * f.dot(u)).normalized()
        sd = f.cross(u).normalized()
        return Matrix((sd, f, u)).transposed()

    def score(u):
        rot = pose(u)
        gaps = []
        for q in contacts:
            p = origin + rot @ q
            h = cast(car_prefix, p + u * 0.2, -u)
            if h is None:
                return None
            gaps.append((p - h).dot(u))
        low = min(gaps)
        return sum(g - low for g in gaps) / len(gaps), low

    best = (score(up), up)
    base_rot = pose(up)
    for i in range(-10, 11):
        for j in range(-10, 11):
            u = (Matrix.Rotation(math.radians(1.5 * i), 3, base_rot.col[1]) @ Matrix.Rotation(math.radians(1.5 * j), 3, base_rot.col[0]) @ up).normalized()
            sc = score(u)
            if sc is not None and (best[0] is None or sc[0] < best[0][0]):
                best = (sc, u)
    (_, low), up = best
    origin = origin - up * (low + sink)
    fwd = Vector((math.sin(heading), math.cos(heading), 0))
    fwd = (fwd - up * fwd.dot(up)).normalized()
    side = fwd.cross(up).normalized()
    rot = Matrix((side, fwd, up)).transposed()
    gaps = []
    for q in contacts:
        p = origin + rot @ q
        gaps.append((p - cast(car_prefix, p + up * 0.2, -up)).dot(up))
    print(f"[closeups] shoe seated: {len(found)} contacts, gaps {min(gaps) * 1000:+.1f}..{max(gaps) * 1000:+.1f} mm, tilt {math.degrees(math.acos(max(min(up.z, 1), -1))):.1f} deg", flush=True)
    return Matrix.Translation(origin) @ rot.to_4x4(), up, fwd, side


def bonnet_point(car_prefix, x, y):
    """Where a vertical ray at (x, y) meets the named car's body from above (Blender world)."""
    dg = bpy.context.evaluated_depsgraph_get()
    best = None
    for ob in bpy.data.objects:
        if ob.type != "MESH" or not ob.name.startswith(car_prefix):
            continue
        # the tree is in the object's own space: cast there, bring the hit back to the world
        tree = BVHTree.FromObject(ob, dg)
        inv = ob.matrix_world.inverted()
        hit = tree.ray_cast(inv @ Vector((x, y, 5.0)), (inv.to_3x3() @ Vector((0, 0, -1))).normalized(), 50.0)
        if hit[0] is None:
            continue
        world = ob.matrix_world @ hit[0]
        normal = (ob.matrix_world.to_3x3().inverted().transposed() @ hit[1]).normalized()
        if best is None or world.z > best[0].z:
            best = (world, normal)
    if best is None:
        raise RuntimeError(f"closeups: no {car_prefix} surface under ({x:.2f}, {y:.2f})")
    return best[0], best[1]


def build(ctx, cars):
    """Both props, the pendant's set, the two cameras and the stage of the sneaker shot's figure."""
    coll = ctx["coll"]
    mats = materials()
    pendant(ctx, mats)
    # the pendant's macro: 100 mm, 30 cm off, a little from the right and above
    util.camera(coll, "shot.pendant", PEND + PEND_EYE, PEND + Vector((0.0, 0.0, -0.006)), 100)

    car = cars[SNEAKER_CAR]
    # the shoe on the black car's bonnet (flat from 0.2 to 1.2 m behind the nose, 1.4 m up), 0.8 m
    # back from the nose, its toe toward the bonnet's edge on the white car's side; seated on the
    # paint where the car stands, then the whole set moved with the car
    at = Vector(car["loc"]) + Vector((-0.3, 0.8, 0.0))
    seated, up, fwd, side = seat(f"car{SNEAKER_CAR}.", at, math.radians(-40))
    place = Matrix.Translation(SNEAKER_CAR_SHIFT) @ seated
    sneaker(ctx, mats, place)
    shoe_at = place @ Vector((0, 0, 0))
    windows(ctx, mats)
    # the camera: 20 mm, over the moved car's bonnet near its nose, a hand above the paint, looking
    # diagonally across the bonnet's edge at the white car's front-right corner (its nose at
    # cars[3].loc): the edge runs from the frame's lower left to its right, as in the reference
    eye = shoe_at + Vector((-0.23, -0.65, 0.1))
    target = eye + Vector((-0.27, 0.963, 0.0)) * 4.0
    target.z = 1.22
    util.camera(coll, "shot.sneaker", eye, target, 20)
    # the shoe's own frame, for the surface's panels and stitching (glTF axes, as loom reads them)
    origin = place @ Vector((0, 0, 0))
    util.link_empty(coll, "prop.shoe", origin, None, props={
        "loom_x": util.gl(side), "loom_y": util.gl(fwd), "loom_z": util.gl(up)})
    # the figure stands back between the white car and the bonnet, facing the lens
    fig_at = Vector((0.2, 8.3, 0.0))
    face = (eye - fig_at)
    face.z = 0
    util.link_empty(coll, "stage.sneaker", fig_at, face.normalized(), props={
        "loom_dir": util.gl(face.normalized()), "loom_car": SNEAKER_CAR, "loom_car_shift": util.gl(SNEAKER_CAR_SHIFT)})
    util.link_empty(coll, "stage.pendant", PEND, (0, -1, 0), props={"loom_dir": util.gl(Vector((0, -1, 0)))})
