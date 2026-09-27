"""The mirror shot's hands and rings (T1407b mirror, the reference's 1:23).

The loom rig folds the fingers into the hand bone, so a hand cannot curl in loom. The mirror
shot is a close-up of a hand, so this module builds a THIRD copy of the MPFB body, `fighand`,
with a finger pose BAKED into its rest shape (build_mpfb's `pre_pose` hook): the left hand a
loose, half-closed hand with the thumb up, the right hand relaxed. The body is otherwise the
clothed `fig`, same rig, same joint table, so loom's skin kernel poses its arms as usual.

It wears the reference's ring: a black, mirror-polished square pyramid (the black-glass class:
dark facets, bright rims at the grazing edges) set point-up in a pavé frame, on the
left middle finger, and a pavé band on the left ring finger. Both are skinned to hand.L.
"""
import math

from mathutils import Euler, Matrix, Vector

import figure
import util

# MPFB finger bones: local X curls a finger toward the palm (measured: +50/60/40 makes a fist).
# A loose hand: the index least curled, the pinky most; the thumb lifted away from the palm.
LEFT_FINGERS = {
    "index": (42, 38, 16), "middle": (62, 50, 25), "ring": (70, 55, 28), "pinky": (76, 58, 30),
}
RIGHT_FINGERS = {
    "index": (18, 24, 14), "middle": (22, 30, 18), "ring": (26, 34, 20), "pinky": (30, 38, 22),
}
# the thumb swung out from the fist (local z opens it, measured) and held straight: up at the seam
THUMB_LEFT = {"thumb_01_l": (0, 0, 35), "thumb_02_l": (-5, 0, 0), "thumb_03_l": (0, 0, 0)}

# the pyramid ring (metres)
BAND_R = 0.0102      # inner radius of the band on the proximal phalanx
STONE = 0.021        # side of the square stone (the reference's reads 0.3 of the hand's width)
STONE_H = 0.010      # the pyramid's height above its girdle
FRAME = 0.0028       # width of the pavé frame round the stone


def _pose(rig):
    """Reset every pose bone, then curl the fingers (degrees, XYZ Euler, bone-local)."""
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0.0, 0.0, 0.0)
        pb.location = (0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)
    for side, table in (("l", LEFT_FINGERS), ("r", RIGHT_FINGERS)):
        for finger, angles in table.items():
            for i, deg in enumerate(angles, start=1):
                rig.pose.bones[f"{finger}_{i:02d}_{side}"].rotation_euler = Euler((math.radians(deg), 0.0, 0.0), "XYZ")
    for name, (x, y, z) in THUMB_LEFT.items():
        rig.pose.bones[name].rotation_euler = Euler((math.radians(x), math.radians(y), math.radians(z)), "XYZ")


def _posed_bone(rig, name):
    """World head, tail and the bone's 3x3 (columns: local x, y along the bone, z) after posing."""
    rig.data.pose_position = "POSE"
    import bpy
    bpy.context.view_layer.update()
    pb = rig.pose.bones[name]
    mw = rig.matrix_world
    return mw @ pb.head, mw @ pb.tail, (mw.to_3x3() @ pb.matrix.to_3x3()).normalized()


def _pyramid_ring(mb, head, tail, frame, pave_mat="jewel", stone_mat="glass_car"):
    along = (tail - head).normalized()
    # MPFB's finger bones curl toward local +z (the palm), so the back of the finger is -z
    back = -frame.col[2].normalized()
    side = along.cross(back).normalized()
    centre = head + (tail - head) * 0.42
    # the band, a little thicker on the top where it meets the setting
    mb.torus(centre, along, BAND_R + 0.0016, 0.0016, 28, 8, pave_mat)
    top = centre + back * (BAND_R + 0.0045)
    # the setting: a square turned 45 degrees to the finger, as the reference's (a diamond to the lens)
    rot = Matrix.Rotation(math.radians(45), 3, back)
    u = (rot @ along).normalized()
    v = (rot @ side).normalized()
    h = STONE / 2
    # gallery under the stone
    mb.box(centre + back * (BAND_R + 0.0022), (0.009, 0.009, 0.004), pave_mat,
           Matrix((side, along, back)).transposed())
    # the pavé frame: four bars, each set with a row of small round stones
    corners = [top + u * sx * (h + FRAME / 2) + v * sy * (h + FRAME / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    for k in range(4):
        a, b = corners[k], corners[(k + 1) % 4]
        mb.beam(a, b, FRAME, 0.0026, pave_mat, up=tuple(back))
        for s in range(9):
            p = a.lerp(b, (s + 0.5) / 9) + back * 0.0014
            mb.torus(p, back, 0.0009, 0.0006, 8, 4, pave_mat)
    # the stone: a square pyramid, girdle at the frame's top, apex out from the finger
    g = [top + back * 0.0012 + u * sx * h + v * sy * h for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    apex = top + back * (0.0012 + STONE_H)
    verts = g + [apex]
    faces = [(3, 2, 1, 0)]  # the girdle plane, facing the finger
    for k in range(4):
        faces.append((k, (k + 1) % 4, 4))
    # wind outward: the base's normal must face the finger (-back)
    n = (g[1] - g[0]).cross(g[2] - g[0])
    if n.dot(back) < 0:
        faces = [tuple(reversed(f)) for f in faces]
    mb.add(verts, faces, stone_mat)


def _pave_band(mb, head, tail, frame, mat="jewel"):
    along = (tail - head).normalized()
    centre = head + (tail - head) * 0.4
    mb.torus(centre, along, BAND_R + 0.0008, 0.0017, 28, 6, mat, scale_minor_axis=1.4)
    back = -frame.col[2].normalized()
    side = along.cross(back).normalized()
    for k in range(-5, 6):
        a = math.radians(k * 14)
        radial = back * math.cos(a) + side * math.sin(a)
        mb.torus(centre + radial * (BAND_R + 0.0028), radial, 0.0011, 0.0006, 8, 4, mat)


def build(ctx, blend_path, prefix="fighand"):
    placed = {}

    def pre_pose(rig):
        _pose(rig)
        placed["middle"] = _posed_bone(rig, "middle_01_l")
        placed["ring"] = _posed_bone(rig, "ring_01_l")

    def extra_parts(coll, mats):
        def ring(mb):
            _pyramid_ring(mb, *placed["middle"])

        def band(mb):
            _pave_band(mb, *placed["ring"])

        return [
            figure._accessory(coll, mats, f"{prefix}.pyramid", ring, "hand.L"),
            figure._accessory(coll, mats, f"{prefix}.pave", band, "hand.L"),
        ]

    return figure.build_mpfb(ctx, blend_path, prefix=prefix, pre_pose=pre_pose, extra_parts=extra_parts)
