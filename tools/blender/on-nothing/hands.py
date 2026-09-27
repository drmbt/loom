"""The figure's FINGERS and the hands' ice (T1419b, T1407b hands).

T1419b — FINGER BONES. `figure.build_mpfb` folded MPFB's fifteen finger bones per hand into the
hand bone, so no hand pose was possible in loom. `fingers()` (one hook call in build_mpfb, after
the 19-bone table is built and before the MPFB weights are folded onto it) takes the hand's
weights back to `hand_x` alone and gives every finger joint its own bone: `thumb1.L`..`pinky3.L`
and the right hand's, each parented to the joint before it and the first to the hand, heads and
tails at MPFB's rest joints. The skin kernel (src/projects/on-nothing/skin-kernel.ts) poses them:
the chain pelvis → … → hand → three phalanges is ten bones deep.

T1407b (hands) — THE ICE. The reference's close-ups of the hands (docs/on-nothing-shotlist-
2026-09-27.md rows 3, 12, 18, 47, 57, 59, 62, 74) show big iced rings on several fingers of
both hands and an iced watch on a Cuban bracelet. `jewels()` builds them on the clothed `fig`
body only (the other figure copies keep their own jewellery), each skinned to the bone it rides:
a ring to its finger's first phalanx, the watch and its bracelet to the forearm. Faces that
carry stones are `hand_pave` (class 50: loom's close-up surface sets faceted stones on them,
shots/closeups-surface.ts), polished metal is `hand_metal` (class 51) and the dial is
`hand_dial` (class 60: the surface's defaults, a black glossy face). A ring's inner radius is
MEASURED from the body's own finger at that joint, so the band sits on the skin.
"""
import math

from mathutils import Matrix, Vector

import util

FINGERS = ("thumb", "index", "middle", "ring", "pinky")

# name: (base rgb, metallic, roughness, class code) — the close-up surface's classes (50, 51) and a dial
LIB = {
    "hand_pave": ((0.96, 0.96, 0.98), 1.0, 0.03, 50),
    "hand_metal": ((0.93, 0.93, 0.95), 1.0, 0.07, 51),
    "hand_dial": ((0.012, 0.013, 0.015), 0.0, 0.12, 60),
}

# which ring on which finger (our bone names): the reference wears big iced tops on the index
# and middle, a pavé band or two, and a long plate ring (row 74)
RINGS = {
    "index1.L": "cluster",
    "ring1.L": "band",
    "middle1.R": "cluster",
    "ring1.R": "plate",
    "pinky1.R": "band",
}


def fingers(bones, mpfb_map, arm_bones):
    """Append the finger bones to `bones` (figure.BONES) and route MPFB's finger weights to them."""
    index = {b[1]: b[0] for b in bones}
    for side, s in (("L", "l"), ("R", "r")):
        mpfb_map[f"hand.{side}"] = [f"hand_{s}"]
        for finger in FINGERS:
            for k in (1, 2, 3):
                ours, theirs = f"{finger}{k}.{side}", f"{finger}_{k:02d}_{s}"
                mpfb_map[ours] = [theirs]
                parent = f"hand.{side}" if k == 1 else f"{finger}{k - 1}.{side}"
                head, tail = arm_bones[theirs]
                index[ours] = len(bones)
                bones.append((len(bones), ours, index[parent], tuple(head), tuple(tail)))


def _materials(mats):
    import bpy
    for name, (base, met, rough, code) in LIB.items():
        if name in mats:
            continue
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*base, 1.0)
        bsdf.inputs["Metallic"].default_value = met
        bsdf.inputs["Roughness"].default_value = rough
        m["loom_heat"] = code / 64.0
        m.diffuse_color = (*base, 1.0)
        mats[name] = m


def palm_normal(arm_bones, s):
    """The way the palm faces at rest (unit): across the knuckles × along the hand, turned to the midline."""
    across = arm_bones[f"index_01_{s}"][0] - arm_bones[f"pinky_01_{s}"][0]
    along = (arm_bones[f"middle_01_{s}"][1] - arm_bones[f"middle_01_{s}"][0]).normalized()
    n = along.cross(across).normalized()
    side = 1.0 if arm_bones[f"hand_{s}"][0].x > 0 else -1.0
    # in the rest A-pose the palms face the thighs: toward the midline
    return n if n.x * side < 0 else -n


def _around(body, group, head, tail, t):
    """The body's finger round the bone at fraction t: (centre, radius).

    The bone does not run down the finger's middle, so the section's centre is the mean of its
    vertices and the radius their median distance from it (the skin, not the bone, carries the ring)."""
    g = body.vertex_groups.get(group)
    if g is None:
        raise RuntimeError(f"hands: the body has no group {group}")
    axis = tail - head
    length = axis.length
    d = axis / length
    section = []
    for v in body.data.vertices:
        if not any(e.group == g.index and e.weight > 0.5 for e in v.groups):
            continue
        p = body.matrix_world @ v.co
        if abs((p - head).dot(d) / length - t) < 0.12:
            section.append(p - d * (p - head).dot(d))
    if len(section) < 6:
        raise RuntimeError(f"hands: too few vertices round {group} to measure it ({len(section)})")
    centre = sum(section, Vector()) / len(section)
    radii = sorted((p - centre).length for p in section)
    return centre + d * (length * t), radii[len(radii) // 2]


def _extent(body, group, centre, along, back, across):
    """Half extents of the limb's cross-section at `centre` (⟂ `along`), toward `back` and `across`."""
    g = body.vertex_groups.get(group)
    hb, ha = 0.0, 0.0
    for v in body.data.vertices:
        if not any(e.group == g.index and e.weight > 0.3 for e in v.groups):
            continue
        q = body.matrix_world @ v.co - centre
        if abs(q.dot(along)) > 0.006:
            continue
        hb = max(hb, abs(q.dot(back)))
        ha = max(ha, abs(q.dot(across)))
    if hb == 0.0:
        raise RuntimeError(f"hands: no section of {group} at {tuple(centre)}")
    return hb, ha


def _pave_studs(mb, a, b, normal, count, r):
    """A row of small domed stones from a to b (class 50 faces are faceted by loom anyway)."""
    for k in range(count):
        p = a.lerp(b, (k + 0.5) / count)
        mb.torus(p + normal * r * 0.3, normal, r * 0.55, r * 0.45, 10, 5, "hand_pave")


def _ring(mb, kind, centre, along, back, inner):
    back = (back - along * back.dot(along)).normalized()
    side = along.cross(back).normalized()
    if kind == "band":
        # an eternity band: a flattened pavé torus, all stones
        mb.torus(centre, along, inner + 0.0019, 0.0019, 36, 8, "hand_pave", scale_minor_axis=1.35)
        return
    # a polished shank under a big iced top
    mb.torus(centre, along, inner + 0.0014, 0.0014, 32, 6, "hand_metal", scale_minor_axis=1.4)
    rot = Matrix((side, along, back)).transposed()
    if kind == "cluster":
        # a big square iced top: a paved plate on a polished gallery, stones round its rim
        w, l, h = 0.019, 0.018, 0.005
        top = centre + back * (inner + 0.0022 + h / 2)
        mb.box(top - back * 0.0012, (w * 0.86, l * 0.86, h * 0.8), "hand_metal", rot)
        mb.box(top, (w, l, h * 0.55), "hand_pave", rot)
        # a raised centre cluster
        mb.box(top + back * h * 0.45, (w * 0.55, l * 0.55, h * 0.5), "hand_pave", rot)
        corners = [top + back * h * 0.3 + side * sx * w / 2 + along * sy * l / 2 for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        for k in range(4):
            _pave_studs(mb, corners[k], corners[(k + 1) % 4], back, 7, 0.0013)
    else:
        # the plate: a long bar across the back of the fingers, iced face, polished edge
        w, l, h = 0.034, 0.012, 0.0045
        top = centre + back * (inner + 0.0022 + h / 2)
        mb.box(top - back * 0.001, (w, l, h * 0.8), "hand_metal", rot)
        mb.box(top + back * h * 0.2, (w * 0.96, l * 0.86, h * 0.6), "hand_pave", rot)
        for sy in (-1, 1):
            a = top + back * h * 0.5 + along * sy * l * 0.47 - side * w * 0.47
            _pave_studs(mb, a, a + side * w * 0.94, back, 14, 0.0011)


def _watch(mb, centre, along, back, across, hb, ha):
    """An iced watch at the back of the wrist, its links round the wrist's own section."""
    face = centre + back * (hb + 0.004)
    r = 0.021
    # case: a short cylinder along `back`, a paved bezel, a black dial under a crystal
    mb.cylinder(face - back * 0.0055, face + back * 0.004, r, 40, "hand_metal")
    mb.torus(face + back * 0.0045, back, r - 0.0028, 0.0028, 40, 8, "hand_pave")
    mb.cylinder(face + back * 0.0036, face + back * 0.0047, r - 0.0052, 40, "hand_dial")
    # iced hour markers on the dial
    for k in range(12):
        a = 2 * math.pi * k / 12
        p = face + back * 0.005 + (across * math.cos(a) + along * math.sin(a)) * (r - 0.0085)
        mb.torus(p, back, 0.0008, 0.0006, 8, 4, "hand_pave")
    # the crown on the thumb side
    mb.cylinder(face + across * r, face + across * (r + 0.0035), 0.0022, 12, "hand_metal")
    # the bracelet: three-row links round the wrist ellipse, paved outer faces
    _links(mb, centre, along, back, across, hb + 0.0035, ha + 0.0035, 0.018, 34, skip=0.36)


def _links(mb, centre, along, back, across, rb, ra, width, count, skip=0.0):
    """Flat links round an ellipse (half axes rb toward `back`, ra across), `width` along the arm.

    `skip`: leave out the arc (radians either side of `back`) the watch case covers."""
    for k in range(count):
        a0 = 2 * math.pi * k / count
        a1 = 2 * math.pi * (k + 0.82) / count
        if skip and (abs(math.atan2(math.sin(a0), math.cos(a0))) < skip or abs(math.atan2(math.sin(a1), math.cos(a1))) < skip):
            continue
        p0 = centre + back * rb * math.cos(a0) + across * ra * math.sin(a0)
        p1 = centre + back * rb * math.cos(a1) + across * ra * math.sin(a1)
        out = (back * math.cos((a0 + a1) / 2) / rb + across * math.sin((a0 + a1) / 2) / ra).normalized()
        mb.beam(p0, p1, width, 0.004, "hand_metal", up=tuple(out))
        # the paved top of the link
        mb.beam(p0 + out * 0.0022, p1 + out * 0.0022, width * 0.8, 0.0012, "hand_pave", up=tuple(out))


def _cuban(mb, centre, along, back, across, hb, ha):
    """A heavy iced Cuban bracelet: alternate flat and upright oval links round the wrist."""
    count = 22
    rb, ra = hb + 0.007, ha + 0.007
    for k in range(count):
        a = 2 * math.pi * k / count
        p = centre + back * rb * math.cos(a) + across * ra * math.sin(a)
        tangent = (-back * rb * math.sin(a) + across * ra * math.cos(a)).normalized()
        out = (back * math.cos(a) / rb + across * math.sin(a) / ra).normalized()
        axis = out if k % 2 == 0 else tangent.cross(out).normalized()
        mb.torus(p, axis, 0.0075, 0.0034, 16, 6, "hand_pave" if k % 2 == 0 else "hand_metal", scale_minor_axis=1.2)


def jewels(coll, mats, arm_bones, prefix, body):
    """The rings and the watch, as accessories for figure.build_mpfb to join and skin (fig only)."""
    if prefix != "fig":
        return []
    import figure
    _materials(mats)
    parts = []
    backs = {s: -palm_normal(arm_bones, s) for s in ("l", "r")}
    for bone, kind in RINGS.items():
        finger, side = bone[:-3], bone[-1]
        s = side.lower()
        head, tail = arm_bones[f"{finger}_01_{s}"]
        centre, radius = _around(body, bone, head, tail, 0.45)
        inner = radius + 0.0004

        def build(mb, kind=kind, centre=centre, along=(tail - head).normalized(), s=s, inner=inner):
            _ring(mb, kind, centre, along, backs[s], inner)

        parts.append(figure._accessory(coll, mats, f"{prefix}.ring_{finger}{side}", build, bone))
        print(f"[hands] {kind} ring on {bone}: inner radius {inner * 1000:.1f} mm", flush=True)
    for side, s in (("R", "r"),):
        wrist, hand_tail = arm_bones[f"lowerarm_{s}"][1], arm_bones[f"hand_{s}"][1]
        elbow = arm_bones[f"lowerarm_{s}"][0]
        along = (wrist - elbow).normalized()
        back = backs[s] - along * backs[s].dot(along)
        back.normalize()
        across = along.cross(back).normalized()
        watch_at = wrist - along * 0.028
        hb, ha = _extent(body, f"forearm.{side}", watch_at, along, back, across)

        def watch(mb, c=watch_at, along=along, back=back, across=across, hb=hb, ha=ha):
            _watch(mb, c, along, back, across, hb, ha)

        cuban_at = wrist - along * 0.058
        cb, ca = _extent(body, f"forearm.{side}", cuban_at, along, back, across)

        def cuban(mb, c=cuban_at, along=along, back=back, across=across, hb=cb, ha=ca):
            _cuban(mb, c, along, back, across, hb, ha)

        parts.append(figure._accessory(coll, mats, f"{prefix}.watch{side}", watch, f"forearm.{side}"))
        parts.append(figure._accessory(coll, mats, f"{prefix}.cuban{side}", cuban, f"forearm.{side}"))
        print(f"[hands] watch on forearm.{side}: wrist section {2 * hb * 1000:.0f} x {2 * ha * 1000:.0f} mm", flush=True)
    _pistol(coll, mats, arm_bones, backs["r"])
    return parts


def _pistol(coll, mats, arm_bones, back):
    """A generic, blocky handgun in the right hand (rows 16, 17, 18): its OWN area, `figgun`.

    It is not joined into the body (every shot that draws `fig` would carry it): it is its own
    object bound to its own copy of the rig (`figgun.rig`, the same bone table in the same order,
    so the skin kernel's indices hold), weighted wholly to hand.R. It is placed at REST where a
    closed hand holds it: the grip across the palm, the slide over the web of the thumb, the
    barrel along the hand; the curled fingers (curlR ~1.3) close round the grip."""
    import figure
    wrist, knuckle = arm_bones["hand_r"][0], arm_bones["middle_01_r"][0]
    along = (knuckle - wrist).normalized()
    palm = -back
    across = (arm_bones["index_01_r"][0] - arm_bones["pinky_01_r"][0])
    across = (across - along * across.dot(along) - palm * across.dot(palm)).normalized()
    # the grip's centre: in the palm, a grip's half-thickness off its skin
    centre = wrist.lerp(knuckle, 0.55) + palm * 0.028
    rot = Matrix((palm, along, across)).transposed()  # box axes: x = palm normal, y = along, z = across

    def gun(mb):
        # grip: down from the index side toward the pinky side, raked back 15 degrees
        rake = Matrix.Rotation(math.radians(-15), 3, palm)
        grip_rot = (rake @ rot)
        mb.box(centre - across * 0.012, (0.029, 0.048, 0.11), "gun_black", grip_rot)
        # slide and frame: along the hand, over the web of the thumb, past the knuckles
        top = centre + across * 0.055
        mb.box(top + along * 0.045, (0.024, 0.19, 0.03), "gun_black", rot)
        mb.box(top + along * 0.05 - across * 0.02, (0.022, 0.15, 0.014), "gun_black", rot)
        # the muzzle's bore, a dark ring at the front
        mb.cylinder(top + along * 0.139, top + along * 0.141, 0.0055, 16, "gun_steel")
        # trigger guard: a bar under the frame in front of the grip
        mb.box(top + along * 0.05 - across * 0.046, (0.012, 0.055, 0.005), "gun_black", rot)
        mb.box(top + along * 0.076 - across * 0.035, (0.012, 0.005, 0.025), "gun_black", rot)
        # rear sight and serrations catch a little light
        mb.box(top + across * 0.017 - along * 0.045, (0.02, 0.006, 0.005), "gun_steel", rot)

    if "gun_black" not in mats:
        import bpy
        for name, (base, rough) in {"gun_black": ((0.025, 0.025, 0.027), 0.45), "gun_steel": ((0.35, 0.35, 0.36), 0.3)}.items():
            m = bpy.data.materials.new(name)
            m.use_nodes = True
            bsdf = m.node_tree.nodes["Principled BSDF"]
            bsdf.inputs["Base Color"].default_value = (*base, 1.0)
            bsdf.inputs["Metallic"].default_value = 0.6
            bsdf.inputs["Roughness"].default_value = rough
            m["loom_heat"] = 61 / 64.0
            m.diffuse_color = (*base, 1.0)
            mats[name] = m
    ob = figure._accessory(coll, mats, "figgun.pistol", gun, "hand.R")
    figure._bind(ob, figure._armature(coll, "figgun.rig"))
    ob["loom_area"] = "figgun"
