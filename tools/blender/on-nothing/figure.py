"""The figure for the On Nothing scene (T1400b): a mannequin read mostly as silhouette and rim.

One smooth mesh (a skin-modifier skeleton, subdivided, applied) with its accessories joined in:
a beanie, sunglasses, a heavy chain with a slab pendant, a bracelet. It stands at the origin
facing -Y (glTF +Z) in an A-pose; loom places and poses it.

SKINNING (T1401b). The figure exports as a real glTF skin: the body is bound to the armature
`fig.rig` (the 19 bones of BONES) by an Armature modifier, and the exporter writes JOINTS_0 /
WEIGHTS_0 (four influences) and the bones as joint nodes. loom decodes the skin into a joint
table (name, parent, rest head) and per-vertex joints/weights; `src/projects/on-nothing/
skin-kernel.ts` poses it. The weights come from Blender's bone-heat weighting (the mannequin) or
from MPFB's own weights folded onto BONES (the human); a vertex neither reaches takes its
nearest bone, so nothing is left unskinned.
"""
import math

import bmesh
import bpy
from mathutils import Vector

import util

# index, name, parent, head, tail (Blender metres, the figure faces -Y)
BONES = [
    (0, "pelvis", -1, (0, 0, 0.95), (0, 0, 1.05)),
    (1, "spine", 0, (0, 0, 1.05), (0, 0, 1.25)),
    (2, "chest", 1, (0, 0, 1.25), (0, 0, 1.44)),
    (3, "neck", 2, (0, 0, 1.44), (0, 0, 1.54)),
    (4, "head", 3, (0, 0, 1.54), (0, 0, 1.75)),
]
_side = [
    ("shoulder", 2, (0.03, 0, 1.4), (0.17, 0, 1.42)),
    ("upperarm", None, (0.18, 0, 1.41), (0.36, 0, 1.19)),
    ("forearm", None, (0.36, 0, 1.19), (0.53, -0.02, 0.99)),
    ("hand", None, (0.53, -0.02, 0.99), (0.6, -0.03, 0.89)),
]
_leg = [
    ("thigh", 0, (0.115, 0, 0.93), (0.125, 0, 0.5)),
    ("shin", None, (0.125, 0, 0.5), (0.13, 0.02, 0.09)),
    ("foot", None, (0.13, 0.02, 0.09), (0.13, -0.14, 0.04)),
]


def _add_chain(chain, suffix, sx):
    first = len(BONES)
    for k, (name, parent, head, tail) in enumerate(chain):
        p = parent if parent is not None else first + k - 1
        BONES.append((len(BONES), f"{name}.{suffix}", p, (sx * head[0], head[1], head[2]), (sx * tail[0], tail[1], tail[2])))


_add_chain(_side, "L", 1)
_add_chain(_side, "R", -1)
_add_chain(_leg, "L", 1)
_add_chain(_leg, "R", -1)

# skin skeleton: name -> (position, radius x, radius y), then edges
_SK = {
    "pelvis": ((0, 0, 0.95), 0.155, 0.11),
    "waist": ((0, 0, 1.08), 0.14, 0.1),
    "chest": ((0, 0, 1.28), 0.175, 0.115),
    "upchest": ((0, 0, 1.4), 0.168, 0.105),
    "neck": ((0, 0.005, 1.49), 0.055, 0.055),
    "chin": ((0, -0.015, 1.55), 0.058, 0.066),
    "head": ((0, 0, 1.62), 0.084, 0.1),
    "headtop": ((0, 0.005, 1.7), 0.07, 0.08),
    "nose": ((0, -0.098, 1.6), 0.014, 0.016),
}
_EDGES = [("pelvis", "waist"), ("waist", "chest"), ("chest", "upchest"), ("upchest", "neck"), ("neck", "chin"),
          ("chin", "head"), ("head", "headtop"), ("head", "nose")]
_ARM = [("sh", (0.17, 0, 1.41), 0.07), ("ua", (0.265, 0, 1.3), 0.062), ("ub", (0.285, 0, 1.278), 0.045),
        ("el", (0.36, 0, 1.19), 0.04), ("fa", (0.45, -0.01, 1.09), 0.037), ("wr", (0.53, -0.02, 0.99), 0.027),
        ("hd", (0.565, -0.025, 0.94), 0.04), ("fg", (0.6, -0.03, 0.885), 0.032)]
_LEG = [("hip", (0.115, 0, 0.9), 0.105, 0.115), ("th", (0.12, 0, 0.7), 0.106, 0.116), ("kn", (0.125, 0, 0.5), 0.1, 0.11),
        ("hem", (0.125, 0.01, 0.36), 0.098, 0.106), ("cf", (0.127, 0.012, 0.33), 0.055, 0.06),
        ("cf2", (0.128, 0.015, 0.22), 0.05, 0.055), ("ank", (0.13, 0.02, 0.1), 0.045, 0.05),
        ("ball", (0.13, -0.07, 0.05), 0.055, 0.045), ("toe", (0.13, -0.15, 0.048), 0.048, 0.04)]
for side, sx in (("L", 1), ("R", -1)):
    prev = "upchest"
    for name, (x, y, z), r in _ARM:
        key = f"{name}.{side}"
        _SK[key] = ((sx * x, y, z), r, r * (0.55 if name in ("hd", "fg") else 1.0))
        _EDGES.append((prev, key))
        prev = key
    prev = "pelvis"
    for name, (x, y, z), rx, ry in _LEG:
        key = f"{name}.{side}"
        _SK[key] = ((sx * x, y, z), rx, ry)
        _EDGES.append((prev, key))
        prev = key


def _skin_body(coll):
    names = list(_SK.keys())
    me = bpy.data.meshes.new("fig.body")
    me.from_pydata([_SK[n][0] for n in names], [(names.index(a), names.index(b)) for a, b in _EDGES], [])
    ob = bpy.data.objects.new("fig.body", me)
    coll.objects.link(ob)
    skin = ob.modifiers.new("skin", "SKIN")
    skin.use_smooth_shade = True
    skin.branch_smoothing = 0.6
    layer = me.skin_vertices[0].data
    for i, n in enumerate(names):
        layer[i].radius = (_SK[n][1], _SK[n][2])
        layer[i].use_root = n == "pelvis"
    sub = ob.modifiers.new("subsurf", "SUBSURF")
    sub.levels = 2
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier="skin")
    bpy.ops.object.modifier_apply(modifier="subsurf")
    return ob


def _armature(coll, name="fig.rig"):
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    coll.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    made = {}
    for idx, name, parent, head, tail in BONES:
        b = arm.edit_bones.new(name)
        b.head, b.tail = head, tail
        if parent >= 0:
            b.parent = made[parent]
            b.use_connect = False
        made[idx] = b
    bpy.ops.object.mode_set(mode="OBJECT")
    return ob


def _accessory(coll, mats, name, mb_fn, bone):
    mb = util.MB(name)
    mb_fn(mb)
    ob = mb.to_object(mats, coll, smooth_deg=45)
    vg = ob.vertex_groups.new(name=bone)
    vg.add(list(range(len(ob.data.vertices))), 1.0, "REPLACE")
    return ob


def _beanie(mb):
    c = Vector((0, 0.008, 1.655))
    rx, ry, rz = 0.1, 0.112, 0.13
    rings, seg = 9, 32
    verts, faces = [], []
    for i in range(rings + 1):
        t = (math.pi / 2) * i / rings
        for j in range(seg):
            s = 2 * math.pi * j / seg
            verts.append(c + Vector((rx * math.cos(t) * math.cos(s), ry * math.cos(t) * math.sin(s), rz * math.sin(t))))
    for i in range(rings):
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((i * seg + j, i * seg + j2, (i + 1) * seg + j2, (i + 1) * seg + j))
    mb.add(verts, faces, "cloth_black")
    mb.torus(c + Vector((0, 0, 0.005)), (0, 0, 1), 0.1, 0.02, 32, 8, "cloth_black")


def _glasses(mb):
    for sx in (1, -1):
        mb.box((sx * 0.036, -0.1, 1.622), (0.064, 0.012, 0.042), "lens_black")
        mb.beam((sx * 0.07, -0.1, 1.632), (sx * 0.086, 0.01, 1.63), 0.008, 0.012, "jewel")
    mb.box((0, -0.102, 1.63), (0.02, 0.008, 0.008), "jewel")


def _chain(mb):
    n = 30
    pts = []
    for k in range(n):
        s = 2 * math.pi * k / n
        f = (1 - math.cos(s)) / 2
        pts.append(Vector((0.118 * math.sin(s), 0.055 - 0.215 * f, 1.47 - 0.19 * f ** 1.4)))
    for k in range(n):
        a, b = pts[k], pts[(k + 1) % n]
        d = (b - a).normalized()
        # links alternate flat and upright
        up = Vector((0, 0, 1)) if k % 2 else d.cross(Vector((0, 0, 1))).normalized()
        axis = d.cross(up).normalized() if k % 2 else up
        mb.torus((a + b) / 2, axis, 0.017, 0.0065, 16, 6, "jewel")
    front = pts[n // 2]
    mb.box(front + Vector((0, -0.012, -0.05)), (0.085, 0.014, 0.06), "jewel")


def _bracelet(mb):
    mb.torus((0.525, -0.018, 1.0), (0.72, -0.05, -0.69), 0.036, 0.009, 24, 6, "jewel")


def _assign_materials(ob, bone_of_vertex):
    names = ["cloth_black", "skin", "denim_black", "shoe_black"]
    me = ob.data
    for n in names:
        if me.materials.find(n) < 0:
            me.materials.append(bpy.data.materials[n])
    index = {n: me.materials.find(n) for n in names}
    for poly in me.polygons:
        c = poly.center
        bones = [BONES[bone_of_vertex[v]][1].split(".")[0] for v in poly.vertices]
        b = max(set(bones), key=bones.count)
        if b in ("head", "neck"):
            m = "skin"
        elif b in ("forearm", "hand"):
            m = "skin"
        elif b == "upperarm":
            m = "cloth_black" if c.z > 1.285 else "skin"
        elif b in ("thigh",):
            m = "denim_black"
        elif b == "shin":
            m = "denim_black" if c.z > 0.345 else ("shoe_black" if c.z < 0.115 else "skin")
        elif b == "foot":
            m = "shoe_black"
        else:
            m = "cloth_black"
        poly.material_index = index[m]


def build(ctx):
    coll, mats = ctx["coll"], ctx["mats"]
    body = _skin_body(coll)
    rig = _armature(coll)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    # the strongest bone per body vertex, for the materials
    by_name = {b[1]: b[0] for b in BONES}
    gname = {g.index: g.name for g in body.vertex_groups}
    strongest = []
    for v in body.data.vertices:
        gs = sorted(((g.weight, gname[g.group]) for g in v.groups if g.weight > 0), reverse=True)
        strongest.append(by_name[gs[0][1]] if gs else _nearest_bone(v.co))
    _assign_materials(body, strongest)
    parts = [
        _accessory(coll, mats, "fig.beanie", _beanie, "head"),
        _accessory(coll, mats, "fig.glasses", _glasses, "head"),
        _accessory(coll, mats, "fig.chain", _chain, "chest"),
        _accessory(coll, mats, "fig.bracelet", _bracelet, "forearm.L"),
    ]
    # detach from the rig (keeping the groups) to join the accessories, then bind again
    for mod in list(body.modifiers):
        body.modifiers.remove(mod)
    body.parent = None
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in parts:
        o.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    _bind(body, rig)
    body["loom_area"] = "fig"
    return body


def _nearest_bone(co):
    best, bi = 1e9, 0
    for idx, _, _, head, tail in BONES:
        a, b = Vector(head), Vector(tail)
        ab = b - a
        t = max(0.0, min(1.0, (co - a).dot(ab) / max(ab.length_squared, 1e-9)))
        d = (co - (a + ab * t)).length
        if d < best:
            best, bi = d, idx
    return bi


def _bind(ob, rig):
    """Skin `ob` to `rig`: only BONES' groups, every vertex weighted, an Armature modifier.

    The glTF exporter turns this into the skin (JOINTS_0/WEIGHTS_0, top four influences,
    normalised). A vertex with no weight would stay behind when its limb turns and tear the
    surface, so it takes its nearest bone at full weight.
    """
    known = {b[1] for b in BONES}
    for g in list(ob.vertex_groups):
        if g.name not in known:
            ob.vertex_groups.remove(g)
    groups = {b[1]: (ob.vertex_groups.get(b[1]) or ob.vertex_groups.new(name=b[1])) for b in BONES}
    by_index = {g.index: g.name for g in ob.vertex_groups}
    unweighted = 0
    for v in ob.data.vertices:
        if not any(g.weight > 1e-4 and by_index.get(g.group) in known for g in v.groups):
            unweighted += 1
            groups[BONES[_nearest_bone(v.co)][1]].add([v.index], 1.0, "REPLACE")
    if unweighted:
        print(f"[figure] {unweighted} vertices had no weight; nearest bone used", flush=True)
    ob.parent = rig
    ob.matrix_parent_inverse = rig.matrix_world.inverted()
    mod = ob.modifiers.new("rig", "ARMATURE")
    mod.object = rig


# ── The MPFB (MakeHuman) human: a CC0 body in place of the mannequin ─────────────────────────

# our bone <- the MPFB game_engine bones whose weights it takes (first one sets head and tail)
MPFB_MAP = {
    "pelvis": ["pelvis", "Root"], "spine": ["spine_01", "spine_02"], "chest": ["spine_03"],
    "neck": ["neck_01"], "head": ["head"],
}
for _s, _m in (("L", "l"), ("R", "r")):
    MPFB_MAP.update({
        f"shoulder.{_s}": [f"clavicle_{_m}"], f"upperarm.{_s}": [f"upperarm_{_m}"],
        f"forearm.{_s}": [f"lowerarm_{_m}"],
        f"hand.{_s}": [f"hand_{_m}"] + [f"{f}_{i:02d}_{_m}" for f in ("thumb", "index", "middle", "ring", "pinky") for i in (1, 2, 3)],
        f"thigh.{_s}": [f"thigh_{_m}"], f"shin.{_s}": [f"calf_{_m}"], f"foot.{_s}": [f"foot_{_m}", f"ball_{_m}"],
    })
MPFB_MATERIALS = {"body": "skin", "casualsuit": "cloth_black", "shoes": "shoe_black", "high-poly": "lens_black"}
MPFB_DROP = ("eyelashes", "eyebrow", "short02")


def _measure(ob, zlo, zhi, xmax=None):
    pts = [ob.matrix_world @ v.co for v in ob.data.vertices]
    sel = [p for p in pts if zlo <= p.z <= zhi and (xmax is None or abs(p.x) <= xmax)]
    if not sel:
        raise RuntimeError(f"figure: nothing on {ob.name} between z {zlo} and {zhi}")
    return (min(p.x for p in sel), max(p.x for p in sel), min(p.y for p in sel), max(p.y for p in sel), min(p.z for p in sel), max(p.z for p in sel))


def build_mpfb(ctx, blend_path, prefix="fig", bare=False):
    """Append the MPFB human, bake it to rest, fold its bones onto BONES, join, accessorise.

    `bare`: shirtless (the reference's tableau, 0:16): the suit's shirt is cut away above the
    waist and the body under it is KEPT (MPFB's delete-under-clothes mask would leave a hole).
    """
    waist = 1.0
    coll, mats = ctx["coll"], ctx["mats"]
    with bpy.data.libraries.load(blend_path) as (src, dst):
        dst.objects = list(src.objects)
    rig = None
    meshes = []
    for o in dst.objects:
        if o is None:
            continue
        coll.objects.link(o)
        if o.type == "ARMATURE":
            rig = o
        elif o.type == "MESH":
            meshes.append(o)
    if rig is None:
        raise RuntimeError("figure: the MPFB file has no armature")
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    arm_bones = {b.name: (rig.matrix_world @ b.head_local, rig.matrix_world @ b.tail_local) for b in rig.data.bones}
    # our bone table from the MPFB rest heads and tails
    BONES.clear()
    order = ["pelvis", "spine", "chest", "neck", "head",
             "shoulder.L", "upperarm.L", "forearm.L", "hand.L", "shoulder.R", "upperarm.R", "forearm.R", "hand.R",
             "thigh.L", "shin.L", "foot.L", "thigh.R", "shin.R", "foot.R"]
    parent = {"pelvis": None, "spine": "pelvis", "chest": "spine", "neck": "chest", "head": "neck"}
    for s in ("L", "R"):
        parent.update({f"shoulder.{s}": "chest", f"upperarm.{s}": f"shoulder.{s}", f"forearm.{s}": f"upperarm.{s}", f"hand.{s}": f"forearm.{s}",
                       f"thigh.{s}": "pelvis", f"shin.{s}": f"thigh.{s}", f"foot.{s}": f"shin.{s}"})
    for i, name in enumerate(order):
        head, tail = arm_bones[MPFB_MAP[name][0]]
        # the foot bone ends at the toes, past the ball
        if name.startswith("foot."):
            tail = arm_bones[MPFB_MAP[name][1]][1]
        BONES.append((i, name, order.index(parent[name]) if parent[name] else -1, tuple(head), tuple(tail)))
    to_ours = {mp: ours for ours, mps in MPFB_MAP.items() for mp in mps}
    keep = []
    for o in meshes:
        if any(tag in o.name for tag in MPFB_DROP):
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        bpy.context.view_layer.objects.active = o
        for x in bpy.context.selected_objects:
            x.select_set(False)
        o.select_set(True)
        if o.data.shape_keys is not None:
            bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        if bare and o.name.endswith(".body"):
            # keep the torso and arms the suit's mask would delete: take them out of its group
            for mod in o.modifiers:
                if mod.type == "MASK" and "casualsuit" in mod.name and mod.vertex_group in o.vertex_groups:
                    group = o.vertex_groups[mod.vertex_group]
                    upper = [v.index for v in o.data.vertices if (o.matrix_world @ v.co).z > waist - 0.02]
                    group.remove(upper)
        for mod in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        if bare and "casualsuit" in o.name:
            import bmesh
            bm = bmesh.new()
            bm.from_mesh(o.data)
            shirt = [f for f in bm.faces if (o.matrix_world @ f.calc_center_median()).z > waist]
            bmesh.ops.delete(bm, geom=shirt, context="FACES")
            bm.to_mesh(o.data)
            bm.free()
        o.parent = None
        # fold the MPFB groups onto ours: sum per vertex, drop helper groups
        names = {g.index: g.name for g in o.vertex_groups}
        folded = [{} for _ in o.data.vertices]
        for v in o.data.vertices:
            for g in v.groups:
                ours = to_ours.get(names[g.group])
                if ours is not None and g.weight > 0:
                    folded[v.index][ours] = folded[v.index].get(ours, 0.0) + g.weight
        o.vertex_groups.clear()
        groups = {}
        for i, w in enumerate(folded):
            for name, weight in w.items():
                if name not in groups:
                    groups[name] = o.vertex_groups.new(name=name)
                groups[name].add([i], min(weight, 1.0), "REPLACE")
        # our materials in place of MPFB's
        for slot in range(len(o.data.materials)):
            src_name = o.data.materials[slot].name if o.data.materials[slot] else ""
            ours = next((m for tag, m in MPFB_MATERIALS.items() if tag in src_name), "cloth_black")
            o.data.materials[slot] = mats[ours]
        sub = o.modifiers.new("subsurf", "SUBSURF")
        sub.levels = 1
        bpy.ops.object.modifier_apply(modifier="subsurf")
        o.data.shade_smooth()
        keep.append(o)
    bpy.data.objects.remove(rig, do_unlink=True)
    body = next(o for o in keep if o.name.endswith(".body"))
    suit = next(o for o in keep if "casualsuit" in o.name)
    eyes = next((o for o in keep if "high-poly" in o.name), None)

    # measurements for the accessories
    head_top = _measure(body, 1.6, 2.1)
    hx0, hx1, hy0, hy1, _, htop = head_top
    brow_z = htop - 0.115
    # the neck COLUMN, above the trapezius (a lower band takes the shoulders in and widens the loop)
    neck = _measure(body, 1.555, 1.585, xmax=0.1)
    chest = _measure(body if bare else suit, 1.27, 1.31, xmax=0.05)
    if eyes is not None:
        ex0, ex1, ey0, _, ez0, ez1 = _measure(eyes, 0.0, 3.0)
    else:
        ex0, ex1, ey0, ez0, ez1 = -0.06, 0.06, hy0 + 0.01, brow_z - 0.02, brow_z
    eye_z = (ez0 + ez1) / 2
    eye_x = (ex1 - ex0) / 4 + 0.004
    # a beanie sits on the forehead ABOVE the brows (eyes are ~0.12 m under the crown, so a brim
    # measured down from the crown landed on the eyes)
    brow_z = eye_z + 0.032
    print(f"[figure] head top {htop:.3f}  eyes z {eye_z:.3f} x±{eye_x:.3f} front y {ey0:.3f}  beanie brim {brow_z:.3f}", flush=True)
    cx, cy = (hx0 + hx1) / 2, (hy0 + hy1) / 2
    rx, ry = (hx1 - hx0) / 2 + 0.012, (hy1 - hy0) / 2 + 0.012

    def beanie(mb):
        # A knit beanie HUGS the skull: every point of it is the head's own surface pushed out
        # a few millimetres (rays cast inward at the skull), so it has the head's shape, not a
        # dome's. The crown is lifted slightly (a little slouch) and a thin cuff is rolled at the brow.
        from mathutils.bvhtree import BVHTree
        tree = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
        centre = Vector((cx, cy, brow_z))
        rings, seg = 16, 64
        verts, faces = [], []
        for i in range(rings + 1):
            lat = (math.pi / 2) * i / rings          # 0 at the brow line, pi/2 at the crown
            for j in range(seg):
                az = 2 * math.pi * j / seg
                d = Vector((math.cos(lat) * math.cos(az), math.cos(lat) * math.sin(az), math.sin(lat))).normalized()
                # the brim runs lower at the back (over the ear tops, onto the nape)
                drop = 0.07 * max(0.0, math.sin(az)) ** 1.5 * (1.0 - i / rings) ** 2
                start = centre + d * 0.4 - Vector((0, 0, drop))
                h = tree.ray_cast(start, -d, 0.5)
                surface = h[0] if h[0] is not None else centre + d * 0.1
                # thin knit, a touch of slouch at the crown
                off = 0.007 + 0.012 * max(0.0, math.sin(lat)) ** 3
                verts.append(surface + d * off)
        for i in range(rings):
            for j in range(seg):
                j2 = (j + 1) % seg
                faces.append((i * seg + j, i * seg + j2, (i + 1) * seg + j2, (i + 1) * seg + j))
        top = len(verts)
        verts.append(sum(verts[-seg:], Vector()) / seg)
        for j in range(seg):
            faces.append((rings * seg + j, rings * seg + (j + 1) % seg, top))
        mb.add(verts, faces, "knit_black")
        # the cuff: a ribbed band 4 cm tall, 5 mm proud of the knit, rolled at its top edge
        brow = verts[:seg]
        ring_up = [verts[3 * seg + j] for j in range(seg)]
        cverts, cfaces = [], []
        for r_, ring in enumerate((brow, ring_up)):
            for j, q in enumerate(ring):
                out = Vector((q.x - cx, q.y - cy, 0)).normalized()
                rib = 0.0015 if j % 2 == 0 else 0.0
                cverts.append(q + out * (0.005 + rib) + Vector((0, 0, -0.004 if r_ == 0 else 0)))
        for j in range(seg):
            j2 = (j + 1) % seg
            cfaces.append((j, j2, seg + j2, seg + j))
        mb.add(cverts, cfaces, "knit_black")

    def glasses(mb):
        # Wraparound sunglasses: two superellipse lenses turned to follow the face, a rim
        # round each, a bridge, and temples running back over the ears.
        fy = ey0 - 0.014
        a_, b_, nexp = 0.026, 0.018, 3.2
        outline = []
        for k in range(28):
            t = 2 * math.pi * k / 28
            ct, st = math.cos(t), math.sin(t)
            outline.append((a_ * math.copysign(abs(ct) ** (2 / nexp), ct), b_ * math.copysign(abs(st) ** (2 / nexp), st)))
        for sx in (1, -1):
            centre = Vector((cx + sx * (eye_x + 0.002), fy, eye_z - 0.002))
            wrap = math.radians(14) * sx

            def place(u, v, depth=0.0):
                # lens plane: x across, z up; turned about the vertical by `wrap`, bowed back at its outer edge
                x = u * math.cos(wrap)
                y = u * math.sin(wrap) * sx * sx + depth + 0.12 * u * u
                return centre + Vector((x, y if sx > 0 else u * math.sin(wrap) + depth + 0.12 * u * u, v))

            front = [place(u, v) for u, v in outline]
            back = [place(u, v, 0.003) for u, v in outline]
            base = len(mb.verts)
            mb.verts.extend(front + back + [place(0, 0), place(0, 0, 0.003)])
            n = len(outline)
            cf, cb = base + 2 * n, base + 2 * n + 1
            for k in range(n):
                k2 = (k + 1) % n
                mb.faces.append([cf, base + k2, base + k]); mb.fmats.append("lens_black")
                mb.faces.append([cb, base + n + k, base + n + k2]); mb.fmats.append("lens_black")
            rim = [place(u * 1.05, v * 1.06, -0.001) for u, v in outline]
            for k in range(n):
                mb.beam(rim[k], rim[(k + 1) % n], 0.0028, 0.0028, "paint_black", up=(0, -1, 0))
            hinge = place(a_ * 1.08, b_ * 0.6, -0.001)
            # temples: thin, black, along the side of the head to the top of the ear, then down behind it
            ear = Vector((cx + sx * (rx - 0.006), cy + 0.01, eye_z + 0.004))
            mb.beam(hinge, ear, 0.0025, 0.006, "paint_black")
            mb.beam(ear, ear + Vector((0, 0.025, -0.02)), 0.0025, 0.005, "paint_black")
        mb.beam(Vector((cx + eye_x - a_ + 0.003, fy - 0.001, eye_z + 0.012)), Vector((cx - eye_x + a_ - 0.003, fy - 0.001, eye_z + 0.012)), 0.005, 0.005, "paint_black", up=(0, -1, 0))

    nx0, nx1, ny0, ny1, _, _ = neck
    _, _, front, _, _, _ = chest

    # The chain LIES ON the body: a Cuban link, snug at the back of the neck, draped over the
    # trapezius and resting on the shirt at mid-chest. Its path is found by casting rays at the
    # shirt and body from outside and sitting each link just proud of what they hit.
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    surfaces = [BVHTree.FromObject(o, dg) for o in (suit, body)]

    def hit(start, direction):
        """Nearest shirt-or-body surface along a ray, or None."""
        best = None
        for tree in surfaces:
            h = tree.ray_cast(start, direction, 1.0)
            if h[0] is not None and (best is None or (h[0] - start).length < (best - start).length):
                best = h[0]
        return best

    def chain(mb):
        # Top view: a loop hugging the neck. Behind and beside the neck the chain RESTS on the
        # trapezius (found by a ray straight down); in front it HANGS down the chest (found by a
        # ray from the front), narrowing to its lowest point like a real necklace.
        half_n = 60
        cxn, cyn = (nx0 + nx1) / 2, (ny0 + ny1) / 2
        a_ = (nx1 - nx0) / 2 + 0.022
        back_y = ny1 + 0.03  # behind the nape, resting on the trapezius, not sunk into the neck
        half = []
        collar_z = None
        for k in range(half_n + 1):
            s_ = math.pi * k / half_n                # one side, nape (0) to the lowest point (pi)
            t = (1 - math.cos(s_)) / 2
            side = math.sin(s_)
            if t < 0.5:
                y = back_y + (ny0 - 0.01 - back_y) * (t / 0.5)
                p = Vector((cxn + a_ * side, y, 1.545))  # below the jaw: a ray from higher lands on the head
                h = hit(p, Vector((0, 0, -1)))
                # a ray that slips between the neck and the collar lands far down the body:
                # the chain rests on the trapezius, so only a hit in that band counts
                if h is None or not (1.40 < h.z < 1.545):
                    h = Vector((p.x, y, half[-1].z - 0.01 if half else 1.49))
                q = h + Vector((0, 0, 0.01))
                collar_z = q.z
            else:
                # a U, not a V: the sides fall and swing in together, the bottom rounds off
                u = (t - 0.5) / 0.5
                z0 = collar_z if collar_z is not None else 1.46
                z = z0 + (1.345 - z0) * math.sin(u * math.pi / 2)
                x = cxn + (a_ + 0.012) * side * math.cos(u * math.pi / 2) ** 0.6
                h = hit(Vector((x, -0.6, z)), Vector((0, 1, 0)))
                if h is not None and h.y < front - 0.03:
                    h = None  # an arm or a hand in front of the chest, not the chest
                # a miss keeps the chain at its previous point's depth
                q = (h + Vector((0, -0.006, 0))) if h is not None else Vector((x, half[-1].y if half else front, z))
            half.append(q)
        # the other side is the mirror image about the neck's centre line
        mirror = [Vector((2 * cxn - q.x, q.y, q.z)) for q in reversed(half[1:-1])]
        guide = half + mirror
        n = len(guide)
        # relax the kink where the resting part meets the hanging part: a few smoothing passes
        # around the closed loop, then back out to the surface clearance it had
        for _ in range(6):
            guide = [guide[k] * 0.5 + (guide[k - 1] + guide[(k + 1) % n]) * 0.25 for k in range(n)]
        # resample to even spacing, then alternate the links flat and upright
        lengths = [0.0]
        for k in range(1, n + 1):
            lengths.append(lengths[-1] + (guide[k % n] - guide[k - 1]).length)
        total = lengths[-1]
        pitch = 0.0125
        links = int(total / pitch)
        j = 0
        for i in range(links):
            d_ = i * total / links
            while lengths[j + 1] < d_:
                j += 1
            f = (d_ - lengths[j]) / max(lengths[j + 1] - lengths[j], 1e-9)
            p = guide[j].lerp(guide[(j + 1) % n], f)
            tangent = (guide[(j + 1) % n] - guide[j]).normalized()
            outward = (p - Vector((cxn, cyn, p.z - 0.05))).normalized()
            normal = tangent.cross(outward).normalized() if i % 2 else outward
            mb.torus(p, normal, 0.0085, 0.0036, 14, 6, "jewel")
        low = guide[n // 2]
        mb.box(low + Vector((0, -0.006, -0.024)), (0.032, 0.006, 0.036), "jewel")

    wrist_h, wrist_t = arm_bones["lowerarm_l"][1], arm_bones["hand_l"][1]
    along = (wrist_t - wrist_h).normalized()

    def bracelet(mb):
        mb.torus(wrist_h - along * 0.03, along, 0.038, 0.009, 24, 6, "jewel")

    parts = [
        _accessory(coll, mats, f"{prefix}.beanie", beanie, "head"),
        _accessory(coll, mats, f"{prefix}.glasses", glasses, "head"),
        _accessory(coll, mats, f"{prefix}.chain", chain, "chest"),
        _accessory(coll, mats, f"{prefix}.bracelet", bracelet, "forearm.L"),
    ]
    for x in bpy.context.selected_objects:
        x.select_set(False)
    for o in keep + parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = f"{prefix}.body"
    body.data.name = f"{prefix}.body"
    _bind(body, _armature(coll, f"{prefix}.rig"))
    body["loom_area"] = prefix
    print(f"[figure] MPFB human: {len(body.data.vertices):,} vertices", flush=True)
    return body
