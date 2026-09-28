"""The iced Cuban link (T1407b closeups2): the figure's neck chain, heavy and white.

The reference's chain is a heavy iced Cuban: wide, thick oval links, each lying almost flat
against the chest with its neighbours turned a little the other way, the top faces paved and
reading as separate bright links. figure.build_mpfb found the chain's path on the body (the guide
loop); `cuban()` lays the links along it. The links carry the scene's `jewel` class, which loom's
surface draws as ice (surface.ts `jewel`).
"""
import math

from mathutils import Matrix, Vector

# link size, metres: the reference's links read about a thumb wide on the chest
LENGTH = 0.027      # along the chain
WIDTH = 0.021       # across it
BAR = 0.0072        # the link's bar, in its own plane
THICK = 0.0068      # the link's depth off the chest
PITCH = 0.0165      # link to link (the links overlap, as a Cuban's do)
TWIST = 0.42        # radians: alternate links turned either way about the chain


def _superellipse(c, e):
    """cos-like with a squarer profile (e < 1): the bar's cross-section reads flat on top."""
    return math.copysign(abs(c) ** e, c)


def _link(mb, centre, along, face, mat, seg=22, rseg=10):
    """One Cuban link: an oval ring in the plane normal to `face`, its long axis along `along`,
    its bar a rounded box in section (flat on the top face, where the ice sits)."""
    a = Vector(along).normalized()
    n = Vector(face).normalized()
    b = n.cross(a).normalized()
    a = b.cross(n).normalized()
    ra, rb = LENGTH / 2 - BAR / 2, WIDTH / 2 - BAR / 2
    verts = []
    for i in range(seg):
        t = 2 * math.pi * i / seg
        c = Vector(centre) + a * (ra * math.cos(t)) + b * (rb * math.sin(t))
        # the ring's outward direction in its plane (the ellipse's normal)
        radial = (a * (math.cos(t) / ra) + b * (math.sin(t) / rb)).normalized()
        for j in range(rseg):
            s = 2 * math.pi * j / rseg
            verts.append(c + radial * (BAR / 2 * _superellipse(math.cos(s), 0.55)) + n * (THICK / 2 * _superellipse(math.sin(s), 0.55)))
    faces = []
    for i in range(seg):
        for j in range(rseg):
            i2, j2 = (i + 1) % seg, (j + 1) % rseg
            faces.append((i * rseg + j, i2 * rseg + j, i2 * rseg + j2, i * rseg + j2))
    mb.add(verts, faces, mat)


def cuban(mb, guide, axis_x, axis_y, mat="jewel"):
    """Lay Cuban links along the closed `guide` loop (evenly spaced), each lying flat against the
    body: its face looks away from the body's vertical axis at (axis_x, axis_y), and alternate
    links are turned ±TWIST about the chain."""
    n = len(guide)
    lengths = [0.0]
    for k in range(1, n + 1):
        lengths.append(lengths[-1] + (guide[k % n] - guide[k - 1]).length)
    total = lengths[-1]
    links = max(int(total / PITCH), 3)
    links -= links % 2  # an even count, so the alternation closes round the loop
    j = 0
    for i in range(links):
        d = i * total / links
        while lengths[j + 1] < d:
            j += 1
        f = (d - lengths[j]) / max(lengths[j + 1] - lengths[j], 1e-9)
        p = guide[j].lerp(guide[(j + 1) % n], f)
        tangent = (guide[(j + 1) % n] - guide[j]).normalized()
        outward = Vector((p.x - axis_x, p.y - axis_y, 0.0))
        if outward.length < 1e-6:
            outward = Vector((0, -1, 0))
        outward.normalize()
        # lying on the body: the face is the outward direction made square to the chain
        face = (outward - tangent * outward.dot(tangent)).normalized()
        face = Matrix.Rotation(TWIST if i % 2 else -TWIST, 3, tangent) @ face
        # sit the link on its back face, not through the body
        _link(mb, p + face * (THICK * 0.35), tangent, face, mat)
