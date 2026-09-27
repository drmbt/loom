"""The figure for the On Nothing scene (T1400b): a mannequin read mostly as silhouette and rim.

One smooth mesh (a skin-modifier skeleton, subdivided, applied) with its accessories joined in:
a beanie, sunglasses, a heavy chain with a slab pendant, a bracelet. It stands at the origin
facing -Y (glTF +Z) in an A-pose; loom places and poses it.

SKINNING. glTF skins are refused by loom's decoder on purpose, so the figure is skinned in loom:
each vertex carries its two strongest bones and the first one's weight in TEXCOORD_0,
u = boneA * 32 + boneB and v = weight of boneA (written 1 - w here; the exporter flips v). The
weights come from Blender's bone-heat weighting against a matching armature, which is deleted
before export. Each bone exports as a marker `bone.<nn>.<name>` at its head, with its index,
parent index and tail in `extras`.
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


def _armature(coll):
    arm = bpy.data.armatures.new("fig.rig")
    ob = bpy.data.objects.new("fig.rig", arm)
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
    # detach from the rig, keep the groups, delete the rig
    for mod in list(body.modifiers):
        body.modifiers.remove(mod)
    body.parent = None
    bpy.data.objects.remove(rig, do_unlink=True)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in parts:
        o.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    _encode_weights(body)
    body.vertex_groups.clear()
    body["loom_area"] = "fig"
    for idx, name, parent, head, tail in BONES:
        util.link_empty(coll, f"bone.{idx:02d}.{name}", head, props={
            "loom_bone_index": idx, "loom_bone_parent": parent, "loom_bone_tail": util.gl(tail)})
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


def _encode_weights(ob):
    me = ob.data
    by_name = {b[1]: b[0] for b in BONES}
    gname = {g.index: g.name for g in ob.vertex_groups}
    code = []
    unweighted = 0
    for v in me.vertices:
        gs = sorted(((g.weight, by_name[gname[g.group]]) for g in v.groups if g.weight > 1e-4 and gname[g.group] in by_name), reverse=True)
        if not gs:
            unweighted += 1
            gs = [(1.0, _nearest_bone(v.co))]
        if len(gs) == 1:
            gs.append((0.0, gs[0][1]))
        (wa, a), (wb, b) = gs[0], gs[1]
        w = wa / max(wa + wb, 1e-6)
        code.append((a * 32 + b, w))
    if unweighted:
        print(f"[figure] {unweighted} vertices had no heat weight; nearest bone used", flush=True)
    uv = me.uv_layers.new(name="UVMap") if not me.uv_layers else me.uv_layers[0]
    me.uv_layers.active = uv
    for loop in me.loops:
        u, w = code[loop.vertex_index]
        uv.data[loop.index].uv = (float(u), 1.0 - w)


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


def build_mpfb(ctx, blend_path):
    """Append the MPFB human, bake it to rest, fold its bones onto BONES, join, accessorise."""
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
        for mod in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
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
    neck = _measure(body, 1.5, 1.54)
    chest = _measure(suit, 1.27, 1.31, xmax=0.05)
    if eyes is not None:
        ex0, ex1, ey0, _, ez0, ez1 = _measure(eyes, 0.0, 3.0)
    else:
        ex0, ex1, ey0, ez0, ez1 = -0.06, 0.06, hy0 + 0.01, brow_z - 0.02, brow_z
    eye_z = (ez0 + ez1) / 2
    eye_x = (ex1 - ex0) / 4 + 0.004
    cx, cy = (hx0 + hx1) / 2, (hy0 + hy1) / 2
    rx, ry = (hx1 - hx0) / 2 + 0.012, (hy1 - hy0) / 2 + 0.012

    def beanie(mb):
        c = Vector((cx, cy + 0.006, brow_z + 0.03))
        rz = htop - c.z + 0.03
        rings, seg = 10, 36
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
        mb.torus(c + Vector((0, 0, 0.012)), (0, 0, 1), (rx + ry) / 2, 0.021, 36, 8, "cloth_black")

    def glasses(mb):
        fy = ey0 - 0.014
        for sx in (1, -1):
            mb.box((cx + sx * eye_x, fy, eye_z), (0.058, 0.01, 0.04), "lens_black")
            mb.beam((cx + sx * (eye_x + 0.032), fy, eye_z + 0.012), (cx + sx * (rx - 0.004), cy + 0.02, eye_z + 0.02), 0.007, 0.011, "jewel")
        mb.box((cx, fy - 0.002, eye_z + 0.012), (2 * eye_x - 0.056, 0.008, 0.008), "jewel")

    nx0, nx1, ny0, ny1, _, _ = neck
    _, _, front, _, _, _ = chest

    def chain(mb):
        n = 34
        pts = []
        for k in range(n):
            s = 2 * math.pi * k / n
            t = (1 - math.cos(s)) / 2
            half = (nx1 - nx0) / 2 + 0.025 + 0.035 * t
            pts.append(Vector((half * math.sin(s), (ny1 + 0.008) + (front - 0.012 - ny1 - 0.008) * t, 1.52 - (1.52 - 1.27) * t ** 1.4)))
        for k in range(n):
            a, b = pts[k], pts[(k + 1) % n]
            d = (b - a).normalized()
            up = Vector((0, 0, 1)) if k % 2 else d.cross(Vector((0, 0, 1))).normalized()
            axis = d.cross(up).normalized() if k % 2 else up
            mb.torus((a + b) / 2, axis, 0.017, 0.0068, 16, 6, "jewel")
        low = pts[n // 2]
        mb.box(low + Vector((0, -0.012, -0.05)), (0.09, 0.014, 0.065), "jewel")

    wrist_h, wrist_t = arm_bones["lowerarm_l"][1], arm_bones["hand_l"][1]
    along = (wrist_t - wrist_h).normalized()

    def bracelet(mb):
        mb.torus(wrist_h - along * 0.03, along, 0.038, 0.009, 24, 6, "jewel")

    parts = [
        _accessory(coll, mats, "fig.beanie", beanie, "head"),
        _accessory(coll, mats, "fig.glasses", glasses, "head"),
        _accessory(coll, mats, "fig.chain", chain, "chest"),
        _accessory(coll, mats, "fig.bracelet", bracelet, "forearm.L"),
    ]
    for x in bpy.context.selected_objects:
        x.select_set(False)
    for o in keep + parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = "fig.body"
    body.data.name = "fig.body"
    _encode_weights(body)
    body.vertex_groups.clear()
    body["loom_area"] = "fig"
    for idx, name, parent_i, head, tail in BONES:
        util.link_empty(coll, f"bone.{idx:02d}.{name}", head, props={
            "loom_bone_index": idx, "loom_bone_parent": parent_i, "loom_bone_tail": util.gl(tail)})
    print(f"[figure] MPFB human: {len(body.data.vertices):,} vertices", flush=True)
    return body
