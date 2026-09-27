"""The white-limbo wardrobe (T1407b cyc): what the reference's walker wears, on the MPFB human.

The reference's cyc shots (1:17, 1:45) are all about the silhouette on white: wide, straight,
cropped black trousers ending at mid-calf (the hem ~30 cm wide, ~0.34 m off the floor), black
crew socks from the hem to the shoe, chunky black low sneakers, and a plain folded beanie.
MPFB's casual suit has slim full-length trousers and slim shoes, so `figure.build_mpfb`
builds a third body, area `figcyc`, and calls in here twice:

- `pre_apply(o)`: before the MPFB masks are applied, the body's shins are taken out of the
  suit's delete-under-clothes group, so the legs under the cropped trousers still exist;
- `post_apply(keep, bones, mats)`: the trousers are cut at the hem and blown out into wide
  straight tubes round each leg's axis (the bones' rest line), given a hem thickness, the
  shins below the hem are dressed as socks, the shoes are made chunky.

Weights ride along untouched: a widened trouser vertex keeps its thigh/shin weights, so the
wide legs swing with the stride in loom's skin kernel.
"""
import bmesh
import bpy
from mathutils import Vector

# Blender metres, the figure standing at the origin facing -Y.
HEM = 0.34            # the trousers' hem height
SOCK_TOP = HEM + 0.03
WIDE = 0.13           # trouser leg radius from the knee down
THIGH = 0.12          # at the top of the thigh


def _smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def pre_apply(o):
    """Keep the shins the suit's mask would delete (the trousers will not cover them)."""
    if not o.name.endswith(".body"):
        return
    for mod in o.modifiers:
        if mod.type == "MASK" and "casualsuit" in mod.name and mod.vertex_group in o.vertex_groups:
            group = o.vertex_groups[mod.vertex_group]
            shins = [v.index for v in o.data.vertices if (o.matrix_world @ v.co).z < SOCK_TOP + 0.02]
            group.remove(shins)


def _leg_axis(bones, side):
    """The rest line of one leg: hip, knee, ankle (x, y at a height z)."""
    m = "l" if side > 0 else "r"
    hip = bones[f"thigh_{m}"][0]
    knee = bones[f"calf_{m}"][0]
    ankle = bones[f"foot_{m}"][0]
    pts = sorted([hip, knee, ankle], key=lambda p: p.z)

    def at(z):
        if z <= pts[0].z:
            return pts[0]
        for a, b in zip(pts, pts[1:]):
            if z <= b.z:
                t = (z - a.z) / max(b.z - a.z, 1e-6)
                return a.lerp(b, t)
        return pts[-1]
    return at


def post_apply(keep, bones, mats):
    body = next(o for o in keep if o.name.endswith(".body"))
    suit = next(o for o in keep if "casualsuit" in o.name)
    shoes = next((o for o in keep if "shoes" in o.name), None)

    # ── the trousers: cut at the hem, blown out into wide straight legs ──
    bm = bmesh.new()
    bm.from_mesh(suit.data)
    mw = suit.matrix_world
    low = [f for f in bm.faces if (mw @ f.calc_center_median()).z < HEM]
    bmesh.ops.delete(bm, geom=low, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    axes = {1: _leg_axis(bones, 1), -1: _leg_axis(bones, -1)}
    inv = mw.inverted()
    for v in bm.verts:
        p = mw @ v.co
        if p.z > 0.98:
            continue
        side = 1 if p.x >= 0 else -1
        c = axes[side](p.z)
        r = Vector((p.x - c.x, p.y - c.y))
        length = r.length
        if length < 1e-5:
            continue
        # from the hip down: the thigh's own shape at the top, a straight wide tube by the knee
        target = THIGH + (WIDE - THIGH) * _smooth(0.85, 0.55, p.z)
        w = _smooth(0.98, 0.8, p.z)
        # the crotch stays where it is; the outside and front/back swell most
        new = length + (max(target, length) - length) * w
        q = Vector((c.x, c.y)) + r * (new / length)
        v.co = inv @ Vector((q.x, q.y, p.z))
    bm.to_mesh(suit.data)
    bm.free()
    # a hem with thickness: the open tube's edge would show the sock through it
    bpy.context.view_layer.objects.active = suit
    for x in bpy.context.selected_objects:
        x.select_set(False)
    suit.select_set(True)
    sol = suit.modifiers.new("hem", "SOLIDIFY")
    sol.thickness = 0.01
    sol.offset = -1.0
    sol.use_rim = True
    bpy.ops.object.modifier_apply(modifier="hem")

    # ── socks: the shins below the hem ──
    if "cloth_black" not in [m.name for m in body.data.materials if m]:
        body.data.materials.append(mats["cloth_black"])
    sock = [m.name for m in body.data.materials].index("cloth_black")
    bw = body.matrix_world
    for poly in body.data.polygons:
        if (bw @ poly.center).z < SOCK_TOP:
            poly.material_index = sock

    # ── chunky sneakers: wider, taller, a touch longer, about each shoe's own footprint ──
    if shoes is not None:
        sw = shoes.matrix_world
        sinv = sw.inverted()
        for side in (1, -1):
            vs = [v for v in shoes.data.vertices if (sw @ v.co).x * side > 0]
            if not vs:
                continue
            ps = [sw @ v.co for v in vs]
            cx = sum(p.x for p in ps) / len(ps)
            cy = sum(p.y for p in ps) / len(ps)
            for v, p in zip(vs, ps):
                q = Vector((cx + (p.x - cx) * 1.24, cy + (p.y - cy) * 1.08, p.z * 1.4))
                v.co = sinv @ q
