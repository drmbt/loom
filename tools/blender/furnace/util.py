"""Mesh-building core for the furnace plant.

Everything is built in world space (Blender: Z up, metres) into a MeshBuilder,
then turned into ONE Blender object per builder. Primitives are plain numpy so a
few million triangles build in seconds without bpy.ops.

Winding convention (outward normals): lathe profiles run counter-clockwise in
the (r, z) half plane (bottom -> outer -> top -> inner); prism profiles are made
CCW automatically; sweeps use a right-handed (n, b, t) frame.
"""
import math
import random

import numpy as np
import bpy
from mathutils import Matrix, Vector, noise

TAU = math.tau


# --------------------------------------------------------------------------- math

def v3(*a):
    if len(a) == 1:
        a = a[0]
    return np.array(a, dtype=np.float64)


def norm(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def frame(d, up=(0.0, 0.0, 1.0)):
    """3x3 rotation whose local Z is d; local X is horizontal-ish (perp to up)."""
    d = norm(v3(d))
    u = v3(up)
    if abs(np.dot(d, norm(u))) > 0.999:
        u = v3(1, 0, 0) if abs(d[0]) < 0.9 else v3(0, 1, 0)
    x = norm(np.cross(u, d))
    y = np.cross(d, x)
    return np.stack([x, y, d], axis=1)


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


class Xf:
    """Affine transform: p' = R @ p + t."""

    __slots__ = ("R", "t")

    def __init__(self, R=None, t=(0, 0, 0)):
        self.R = np.eye(3) if R is None else np.asarray(R, dtype=np.float64)
        self.t = v3(t)

    def apply(self, P):
        return P @ self.R.T + self.t

    def __matmul__(self, o):
        return Xf(self.R @ o.R, self.R @ o.t + self.t)


def at(t, R=None):
    return Xf(R, t)


# ----------------------------------------------------------------------- builder

class MB:
    """Accumulates world-space geometry, per-face material names, optional UVs."""

    def __init__(self, name):
        self.name = name
        self.V = []          # list of (n,3)
        self.UV = []         # list of (n,2) or None
        self.groups = {}     # k -> list of (faces (m,k) global idx, mat idx (m,))
        self.nv = 0
        self.mats = []
        self._mi = {}
        self.tris = 0

    def mi(self, name):
        if name not in self._mi:
            self._mi[name] = len(self.mats)
            self.mats.append(name)
        return self._mi[name]

    def add(self, V, faces, mat, uv=None):
        V = np.asarray(V, dtype=np.float64)
        if len(V) == 0:
            return
        base = self.nv
        m = self.mi(mat)
        if isinstance(faces, np.ndarray):
            fl = [faces]
        else:
            by = {}
            for f in faces:
                by.setdefault(len(f), []).append(f)
            fl = [np.asarray(v, dtype=np.int64) for v in by.values()]
        for F in fl:
            if F.size == 0:
                continue
            k = F.shape[1]
            self.groups.setdefault(k, []).append((F + base, np.full(len(F), m, dtype=np.int32)))
            self.tris += len(F) * (k - 2)
        self.V.append(V)
        self.UV.append(None if uv is None else np.asarray(uv, dtype=np.float64))
        self.nv += len(V)

    def merge(self, other):
        base = self.nv
        remap = np.array([self.mi(n) for n in other.mats], dtype=np.int32) if other.mats else None
        for k, lst in other.groups.items():
            for F, M in lst:
                self.groups.setdefault(k, []).append((F + base, remap[M]))
        self.V.extend(other.V)
        self.UV.extend(other.UV)
        self.nv += other.nv
        self.tris += other.tris


# -------------------------------------------------------------------- primitives

def _ccw(P):
    P = np.asarray(P, dtype=np.float64)
    a = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
    return P if a >= 0 else P[::-1]


def prism(mb, prof, length, xf, mat, caps=True, z0=0.0):
    """Extrude closed 2D polygon (local XY) along local Z from z0 to z0+length."""
    P = _ccw(prof)
    n = len(P)
    V = np.zeros((2 * n, 3))
    V[:n, :2] = P
    V[n:, :2] = P
    V[:n, 2] = z0
    V[n:, 2] = z0 + length
    i = np.arange(n)
    j = (i + 1) % n
    F = np.stack([i, j, j + n, i + n], axis=1)
    faces = [F]
    mb.add(xf.apply(V), F, mat)
    if caps:
        mb_caps = [list(range(n - 1, -1, -1)), list(range(n, 2 * n))]
        # caps share verts with sides -> add as separate faces on same verts
        base = mb.nv - 2 * n
        m = mb.mi(mat)
        for c in mb_caps:
            arr = np.array([c], dtype=np.int64) + base
            mb.groups.setdefault(len(c), []).append((arr, np.array([m], dtype=np.int32)))
            mb.tris += len(c) - 2


def box(mb, size, xf, mat, caps=True):
    """Axis box centred at xf origin, size (sx, sy, sz)."""
    sx, sy, sz = size
    prof = [(-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2)]
    prism(mb, prof, sz, xf, mat, caps=caps, z0=-sz / 2)


def boxc(mb, c, size, mat, R=None):
    box(mb, size, Xf(R, c), mat)


def box_minmax(mb, lo, hi, mat):
    lo, hi = v3(lo), v3(hi)
    box(mb, hi - lo, Xf(None, (lo + hi) / 2), mat)


def chamfer_rect(w, h, c):
    x, y = w / 2, h / 2
    c = min(c, x * 0.45, y * 0.45)
    return [(-x + c, -y), (x - c, -y), (x, -y + c), (x, y - c), (x - c, y), (-x + c, y), (-x, y - c), (-x, -y + c)]


def beam(mb, p0, p1, w, h, mat, up=(0, 0, 1), chamfer=0.0, caps=True, roll=0.0):
    """Rectangular (optionally chamfered) bar from p0 to p1; w along local X, h along local Y."""
    p0, p1 = v3(p0), v3(p1)
    d = p1 - p0
    L = np.linalg.norm(d)
    if L < 1e-6:
        return
    R = frame(d, up)
    if roll:
        R = R @ rot_z(roll)
    prof = chamfer_rect(w, h, chamfer) if chamfer > 0 else [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    prism(mb, prof, L, Xf(R, p0), mat, caps=caps)


def circle(r, seg, a0=0.0):
    a = a0 + np.arange(seg) * TAU / seg
    return np.stack([np.cos(a) * r, np.sin(a) * r], axis=1)


def cyl(mb, p0, p1, r, mat, seg=16, caps=True, up=(0, 0, 1)):
    p0, p1 = v3(p0), v3(p1)
    d = p1 - p0
    L = np.linalg.norm(d)
    if L < 1e-6:
        return
    prism(mb, circle(r, seg), L, Xf(frame(d, up), p0), mat, caps=caps)


def lathe(mb, prof, xf, mat, seg=32, arc=None, nz=0.0, nfreq=0.6, seed=0.0, pole_eps=1e-5):
    """Revolve (r, z) profile about local Z. prof CCW in the (r,z) half plane => outward normals.
    arc=(a0,a1) makes an open sweep. nz = radial noise amplitude (dents)."""
    prof = [(float(r), float(z)) for r, z in prof]
    full = arc is None
    if full:
        a = np.arange(seg) * TAU / seg
        ncol = seg
    else:
        a = np.linspace(arc[0], arc[1], seg + 1)
        ncol = seg + 1
    ca, sa = np.cos(a), np.sin(a)
    rows = []
    V = []
    idx = 0
    for r, z in prof:
        if r < pole_eps:
            V.append(np.array([[0.0, 0.0, z]]))
            rows.append(np.array([idx]))
            idx += 1
        else:
            ring = np.stack([ca * r, sa * r, np.full(ncol, z)], axis=1)
            V.append(ring)
            rows.append(np.arange(idx, idx + ncol))
            idx += ncol
    V = np.concatenate(V)
    if nz > 0:
        # radial dents via Blender noise
        for k in range(len(V)):
            x, y, z = V[k]
            rr = math.hypot(x, y)
            if rr < pole_eps:
                continue
            n = noise.noise(Vector((x * nfreq + seed, y * nfreq, z * nfreq)))
            n += 0.5 * noise.noise(Vector((x * nfreq * 2.7, y * nfreq * 2.7 + seed, z * nfreq * 2.7)))
            f = 1.0 + nz * n / rr
            V[k, 0] *= f
            V[k, 1] *= f
    faces_q, faces_t = [], []
    cols = np.arange(seg) if full else np.arange(seg)
    for i in range(len(rows) - 1):
        A, B = rows[i], rows[i + 1]
        j0 = cols
        j1 = (cols + 1) % ncol if full else cols + 1
        if len(A) == 1 and len(B) == 1:
            continue
        if len(A) == 1:
            faces_t.append(np.stack([np.full(len(j0), A[0]), B[j1], B[j0]], axis=1))
        elif len(B) == 1:
            faces_t.append(np.stack([A[j0], A[j1], np.full(len(j0), B[0])], axis=1))
        else:
            faces_q.append(np.stack([A[j0], A[j1], B[j1], B[j0]], axis=1))
    V = xf.apply(V)
    F = []
    if faces_q:
        F.append(np.concatenate(faces_q))
    if faces_t:
        F.append(np.concatenate(faces_t))
    base = mb.nv
    mb.add(V, F[0], mat)
    if len(F) == 2:
        m = mb.mi(mat)
        mb.groups.setdefault(3, []).append((F[1] + base, np.full(len(F[1]), m, dtype=np.int32)))
        mb.tris += len(F[1])


def disk(mb, c, r, mat, seg=32, normal=(0, 0, 1), r_in=0.0):
    """Flat disk/annulus facing `normal`."""
    R = frame(normal)
    if r_in > 0:
        lathe(mb, [(r_in, 0), (r, 0)][::-1], Xf(R, c), mat, seg=seg)
    else:
        lathe(mb, [(r, 0), (0, 0)], Xf(R, c), mat, seg=seg)


def torus(mb, xf, R, r, mat, seg=32, rseg=8, arc=None):
    prof = [(R + r * math.cos(t), r * math.sin(t)) for t in np.linspace(-math.pi, math.pi, rseg + 1)[:-1]]
    # ring profile is closed: revolve polygon, close by repeating first point
    prof = prof + [prof[0]]
    # CCW in (r,z): param t increasing from -pi goes bottom->outer->top->inner (CCW) good
    lathe(mb, prof, xf, mat, seg=seg, arc=arc)


def fillet_path(pts, rad, nseg=6):
    """Round the corners of a polyline with arcs of radius rad."""
    pts = [v3(p) for p in pts]
    if len(pts) < 3 or rad <= 0:
        return pts
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = pts[i - 1], pts[i], pts[i + 1]
        d0 = norm(a - b)
        d1 = norm(c - b)
        cosang = np.clip(np.dot(d0, d1), -1, 1)
        ang = math.acos(cosang)
        if ang > math.pi - 1e-3 or ang < 1e-3:
            out.append(b)
            continue
        t = rad / math.tan(ang / 2)
        t = min(t, np.linalg.norm(a - b) * 0.49, np.linalg.norm(c - b) * 0.49)
        r_eff = t * math.tan(ang / 2)
        p0 = b + d0 * t
        p1 = b + d1 * t
        bis = norm(d0 + d1)
        ctr = b + bis * (r_eff / math.sin(ang / 2))
        v0 = p0 - ctr
        v1 = p1 - ctr
        for k in range(nseg + 1):
            s = k / nseg
            # slerp between v0 and v1
            om = math.acos(np.clip(np.dot(norm(v0), norm(v1)), -1, 1))
            if om < 1e-6:
                out.append(p0)
                continue
            w = (math.sin((1 - s) * om) * v0 + math.sin(s * om) * v1) / math.sin(om)
            out.append(ctr + w)
    out.append(pts[-1])
    return out


def sweep(mb, pts, r, mat, seg=12, caps=True, bend=None, nseg=6, closed=False, uv_len=False):
    """Tube of radius r along polyline pts (optionally filleted with radius bend)."""
    if bend:
        pts = fillet_path(pts, bend, nseg)
    P = np.array([v3(p) for p in pts])
    # drop duplicates
    keep = [0]
    for i in range(1, len(P)):
        if np.linalg.norm(P[i] - P[keep[-1]]) > 1e-5:
            keep.append(i)
    P = P[keep]
    n = len(P)
    if n < 2:
        return
    T = np.zeros_like(P)
    for i in range(n):
        if i == 0:
            T[i] = norm(P[1] - P[0])
        elif i == n - 1:
            T[i] = norm(P[-1] - P[-2])
        else:
            T[i] = norm(norm(P[i + 1] - P[i]) + norm(P[i] - P[i - 1]))
    # parallel transport
    Rf = frame(T[0])
    N = Rf[:, 0]
    rings = []
    scale = np.ones(n)
    for i in range(n):
        if i > 0:
            t0, t1 = T[i - 1], T[i]
            ax = np.cross(t0, t1)
            s = np.linalg.norm(ax)
            if s > 1e-9:
                ang = math.atan2(s, np.dot(t0, t1))
                ax = ax / s
                # Rodrigues
                N = N * math.cos(ang) + np.cross(ax, N) * math.sin(ang) + ax * np.dot(ax, N) * (1 - math.cos(ang))
            N = norm(N - T[i] * np.dot(N, T[i]))
        if 0 < i < n - 1:
            # miter scale in corner
            c = np.dot(norm(P[i + 1] - P[i]), norm(P[i] - P[i - 1]))
            scale[i] = 1.0 / max(math.sqrt((1 + c) / 2), 0.3)
        B = np.cross(T[i], N)
        rings.append((N, B))
    a = np.arange(seg) * TAU / seg
    ca, sa = np.cos(a), np.sin(a)
    V = np.zeros((n * seg, 3))
    UV = np.zeros((n * seg, 2))
    acc = 0.0
    for i in range(n):
        N, B = rings[i]
        if i > 0:
            acc += np.linalg.norm(P[i] - P[i - 1])
        # scale only in the bend plane (approximate: isotropic fine for small bends)
        V[i * seg:(i + 1) * seg] = P[i] + r * (np.outer(ca, N) + np.outer(sa, B))
        UV[i * seg:(i + 1) * seg, 0] = acc
        UV[i * seg:(i + 1) * seg, 1] = a / TAU
    i = np.arange(n - 1)[:, None]
    j = np.arange(seg)[None, :]
    j1 = (j + 1) % seg
    F = np.stack([(i * seg + j), (i * seg + j1), ((i + 1) * seg + j1), ((i + 1) * seg + j)], axis=2).reshape(-1, 4)
    # (N,B,T) is right-handed, so (i,j),(i,j+1),(i+1,j+1),(i+1,j) faces outward
    base = mb.nv
    mb.add(V, F, mat, uv=UV if uv_len else None)
    if caps:
        m = mb.mi(mat)
        # ring order is CCW about T: start cap (normal -T) reversed, end cap forward
        mb.groups.setdefault(seg, []).append((np.arange(seg)[::-1][None, :] + base, np.array([m], dtype=np.int32)))
        mb.groups.setdefault(seg, []).append((np.arange(seg)[None, :] + base + (n - 1) * seg, np.array([m], dtype=np.int32)))
        mb.tris += 2 * (seg - 2)


def catenary(p0, p1, sag, n=16):
    p0, p1 = v3(p0), v3(p1)
    out = []
    for k in range(n + 1):
        t = k / n
        p = p0 + (p1 - p0) * t
        p = p.copy()
        p[2] -= sag * 4 * t * (1 - t)
        out.append(p)
    return out


def bezier(p0, p1, p2, p3, n=16):
    p0, p1, p2, p3 = map(v3, (p0, p1, p2, p3))
    out = []
    for k in range(n + 1):
        t = k / n
        u = 1 - t
        out.append(u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3)
    return out


# ------------------------------------------------------------- structural shapes

def ibeam_prof(h, b, tw, tf):
    x, y = b / 2, h / 2
    w = tw / 2
    return [(-x, -y), (x, -y), (x, -y + tf), (w, -y + tf), (w, y - tf), (x, y - tf), (x, y), (-x, y),
            (-x, y - tf), (-w, y - tf), (-w, -y + tf), (-x, -y + tf)]


def channel_prof(h, b, tw, tf):
    y = h / 2
    return [(0, -y), (b, -y), (b, -y + tf), (tw, -y + tf), (tw, y - tf), (b, y - tf), (b, y), (0, y)]


def angle_prof(a, t):
    return [(0, 0), (a, 0), (a, t), (t, t), (t, a), (0, a)]


def profile_beam(mb, prof, p0, p1, mat, up=(0, 0, 1), roll=0.0, caps=True):
    p0, p1 = v3(p0), v3(p1)
    d = p1 - p0
    L = np.linalg.norm(d)
    if L < 1e-6:
        return
    R = frame(d, up)
    if roll:
        R = R @ rot_z(roll)
    prism(mb, prof, L, Xf(R, p0), mat, caps=caps)


def ibeam(mb, p0, p1, h, b, mat, tw=None, tf=None, up=(0, 0, 1), roll=0.0):
    """I-section; web along local Y (the `up` side). For a horizontal beam with up=Z the web is vertical."""
    tw = tw or max(0.008, h * 0.04)
    tf = tf or max(0.012, h * 0.06)
    profile_beam(mb, ibeam_prof(h, b, tw, tf), p0, p1, mat, up=up, roll=roll)


def hexbolt(mb, p, n, d, mat, h=None):
    """Hex bolt head + washer on surface point p with normal n."""
    h = h or d * 0.65
    p, n = v3(p), norm(v3(n))
    R = frame(n)
    prism(mb, circle(d * 0.95, 6, math.pi / 6), h, Xf(R, p), mat)


def bolt_circle(mb, c, normal, R, count, d, mat, a0=0.0):
    c, nrm = v3(c), norm(v3(normal))
    F = frame(nrm)
    for k in range(count):
        a = a0 + k * TAU / count
        p = c + F[:, 0] * math.cos(a) * R + F[:, 1] * math.sin(a) * R
        hexbolt(mb, p, nrm, d, mat)


def flange(mb, c, axis, r_pipe, mat, bolt_mat="steel_dark", thick=None, seg=24, bolts=None):
    """Pipe flange pair (two plates) + bolt heads, centred at c along axis."""
    c, ax = v3(c), norm(v3(axis))
    ro = r_pipe * 1.55 + 0.03
    t = thick or max(0.02, r_pipe * 0.18)
    cyl(mb, c - ax * t, c + ax * t, ro, mat, seg=seg)
    nb = bolts or max(4, int(round(r_pipe * 40 / 4)) * 4)
    nb = min(nb, 24)
    bolt_circle(mb, c + ax * t, ax, (r_pipe + ro) / 2 + 0.01, nb, max(0.012, r_pipe * 0.09), bolt_mat)
    bolt_circle(mb, c - ax * t, -ax, (r_pipe + ro) / 2 + 0.01, nb, max(0.012, r_pipe * 0.09), bolt_mat)


def pipe_run(mb, pts, r, mat, bend=None, seg=16, flange_every=6.0, flange_mat=None, caps=False, supports=None):
    """Pipe along polyline with long-radius bends and flanges every ~flange_every metres on straights."""
    bend = bend if bend is not None else r * 3.0
    sweep(mb, pts, r, mat, seg=seg, bend=bend, caps=caps, nseg=6)
    if flange_every:
        P = [v3(p) for p in pts]
        for i in range(len(P) - 1):
            a, b = P[i], P[i + 1]
            L = np.linalg.norm(b - a)
            usable = L - 2 * bend
            if usable < 0.6:
                continue
            k = max(1, int(usable // flange_every))
            d = norm(b - a)
            for q in range(k):
                s = bend + usable * (q + 0.5) / k
                flange(mb, a + d * s, d, r, flange_mat or mat, seg=seg)


def handrail(mb, pts, mat="steel_painted_yellow", h=1.1, post=1.6, toe=True, knee=True, r=0.022, toe_mat=None):
    """Industrial handrail along polyline (on deck level): posts, top rail, knee rail, toe board."""
    P = [v3(p) for p in pts]
    top = [p + v3(0, 0, h) for p in P]
    sweep(mb, top, r, mat, seg=8, caps=True)
    if knee:
        sweep(mb, [p + v3(0, 0, h * 0.5) for p in P], r * 0.85, mat, seg=6, caps=True)
    for i in range(len(P) - 1):
        a, b = P[i], P[i + 1]
        L = np.linalg.norm(b - a)
        n = max(1, int(math.ceil(L / post)))
        d = b - a
        for k in range(n + (1 if i == len(P) - 2 else 0)):
            p = a + d * (k / n)
            box(mb, (0.05, 0.05, h), Xf(None, p + v3(0, 0, h / 2)), mat)
        if toe:
            dd = norm(d)
            side = np.cross(v3(0, 0, 1), dd)
            beam(mb, a + v3(0, 0, 0.05), b + v3(0, 0, 0.05), 0.1, 0.008, toe_mat or mat, up=side)


def grating(mb, lo, hi, z, mat="grating", pitch=0.04, cross=0.1, bar_h=0.03, along="x", frame_mat="steel_dark"):
    """Open steel grating panel between lo=(x0,y0) and hi=(x1,y1), top at z.
    Bearing bars are long thin strips along `along` (cheap), cross rods perpendicular."""
    x0, y0 = lo
    x1, y1 = hi
    if along == "x":
        n = int((y1 - y0) / pitch)
        for k in range(n + 1):
            y = y0 + (y1 - y0) * k / max(n, 1)
            beam(mb, (x0, y, z - bar_h / 2), (x1, y, z - bar_h / 2), 0.005, bar_h, mat, caps=False)
        m = int((x1 - x0) / cross)
        for k in range(m + 1):
            x = x0 + (x1 - x0) * k / max(m, 1)
            beam(mb, (x, y0, z - 0.004), (x, y1, z - 0.004), 0.008, 0.008, mat, caps=False)
    else:
        grating_y(mb, lo, hi, z, mat, pitch, cross, bar_h)
    for a, b in (((x0, y0), (x1, y0)), ((x0, y1), (x1, y1)), ((x0, y0), (x0, y1)), ((x1, y0), (x1, y1))):
        beam(mb, (a[0], a[1], z - bar_h / 2), (b[0], b[1], z - bar_h / 2), 0.006, bar_h + 0.01, frame_mat, caps=False)


def grating_y(mb, lo, hi, z, mat, pitch, cross, bar_h):
    x0, y0 = lo
    x1, y1 = hi
    n = int((x1 - x0) / pitch)
    for k in range(n + 1):
        x = x0 + (x1 - x0) * k / max(n, 1)
        beam(mb, (x, y0, z - bar_h / 2), (x, y1, z - bar_h / 2), 0.005, bar_h, mat, caps=False)
    m = int((y1 - y0) / cross)
    for k in range(m + 1):
        y = y0 + (y1 - y0) * k / max(m, 1)
        beam(mb, (x0, y, z - 0.004), (x1, y, z - 0.004), 0.008, 0.008, mat, caps=False)


def strip_bars(mb, a, b, width_dir, width, z_top, mat, pitch=0.035, bar_h=0.03):
    """Grating for an arbitrary straight run a->b (points at deck height)."""
    a, b = v3(a), v3(b)
    wd = norm(v3(width_dir))
    n = int(width / pitch)
    for k in range(n + 1):
        off = wd * (-width / 2 + width * k / max(n, 1))
        beam(mb, a + off - v3(0, 0, bar_h / 2), b + off - v3(0, 0, bar_h / 2), 0.005, bar_h, mat, caps=False, up=v3(0, 0, 1))
    L = np.linalg.norm(b - a)
    d = norm(b - a)
    m = int(L / 0.1)
    for k in range(m + 1):
        p = a + d * (L * k / max(m, 1))
        beam(mb, p - wd * width / 2 - v3(0, 0, 0.004), p + wd * width / 2 - v3(0, 0, 0.004), 0.008, 0.008, mat, caps=False)


# ------------------------------------------------------------------- finalizing

def tri_count(ob):
    me = ob.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def to_object(mb, materials, collection, pivot=None, props=None, parent=None, grime=None, bevel=0.0,
              sharp_deg=38.0, uv_scale=0.5, max_edge=0.0):
    """Create a Blender object from a builder. Object origin = pivot (world)."""
    if mb.nv == 0:
        return None
    V = np.concatenate(mb.V)
    pv = v3(pivot) if pivot is not None else v3(0, 0, 0)
    me = bpy.data.meshes.new(mb.name)
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", (V - pv).astype(np.float32).ravel())
    Fs, Ms, sizes = [], [], []
    for k, lst in mb.groups.items():
        F = np.concatenate([f for f, _ in lst])
        M = np.concatenate([m for _, m in lst])
        Fs.append(F.ravel())
        Ms.append(M)
        sizes.append(np.full(len(F), k, dtype=np.int64))
    loops = np.concatenate(Fs)
    mats = np.concatenate(Ms)
    sizes = np.concatenate(sizes)
    starts = np.zeros(len(sizes), dtype=np.int64)
    starts[1:] = np.cumsum(sizes)[:-1]
    me.loops.add(len(loops))
    me.loops.foreach_set("vertex_index", loops.astype(np.int32))
    me.polygons.add(len(sizes))
    me.polygons.foreach_set("loop_start", starts.astype(np.int32))
    me.update(calc_edges=True)
    for name in mb.mats:
        me.materials.append(materials[name])
    me.polygons.foreach_set("material_index", mats.astype(np.int32))
    me.update()
    me.validate(clean_customdata=False)
    has_explicit = any(U is not None for U in mb.UV)
    if max_edge > 0 and not has_explicit:
        # densify big flat surfaces so per-vertex grime and loom's vertex kernels have something to work with
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(me)
        for _ in range(6):
            long_edges = [e for e in bm.edges if e.calc_length() > max_edge]
            if not long_edges:
                break
            bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True)
        bm.to_mesh(me)
        bm.free()
        me.update()
    V = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", V)
    V = V.reshape(-1, 3) + pv
    # smooth + sharp by angle
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(sharp_deg))
    # UVs: explicit per-vertex where provided, else box projection per face corner
    uvl = me.uv_layers.new(name="UVMap")
    nl = len(me.loops)
    li = np.zeros(nl, dtype=np.int32)
    me.loops.foreach_get("vertex_index", li)
    co = (V).astype(np.float64)
    pn = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get("normal", pn)
    pn = pn.reshape(-1, 3)
    ls = np.zeros(len(me.polygons), dtype=np.int32)
    lt = np.zeros(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    poly_of_loop = np.repeat(np.arange(len(me.polygons)), lt)
    n = np.abs(pn[poly_of_loop])
    P = co[li]
    ax = np.argmax(n, axis=1)
    uv = np.where(ax[:, None] == 2, P[:, [0, 1]], np.where(ax[:, None] == 0, P[:, [1, 2]], P[:, [0, 2]])) * uv_scale
    explicit = np.zeros(len(V), dtype=bool)
    UVv = np.zeros((len(V), 2))
    off = 0
    for Vi, U in zip(mb.V, mb.UV):
        if U is not None:
            explicit[off:off + len(Vi)] = True
            UVv[off:off + len(Vi)] = U
        off += len(Vi)
    if explicit.any():
        e = explicit[li]
        uv[e] = UVv[li[e]]
    uvl.data.foreach_set("uv", uv.astype(np.float32).ravel())
    # vertex colour (grime)
    if grime is not None:
        col = grime(co, me)
        ca = me.color_attributes.new("grime", "FLOAT_COLOR", "POINT")
        ca.data.foreach_set("color", col.astype(np.float32).ravel())
        me.color_attributes.active_color = ca
        me.color_attributes.render_color_index = 0
    ob = bpy.data.objects.new(mb.name, me)
    ob.location = Vector(pv)
    collection.objects.link(ob)
    if parent is not None:
        # parts carry identity rotation: the child's local translation is its offset from the parent pivot
        bpy.context.view_layer.update()
        ob.parent = parent
        ob.location = Vector(pv) - parent.matrix_world.translation
    if props:
        for k, v in props.items():
            ob[k] = v
    if bevel > 0:
        mod = ob.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(50)
        mod.use_clamp_overlap = True
        mod.harden_normals = False
    return ob


class Rng(random.Random):
    def jit(self, a):
        return self.uniform(-a, a)


def rock(mb, c, size, mat, rng, seg=7, rings=4, rough=0.28, R=None):
    """Irregular lump (slag, scrap clinker): noisy squashed sphere."""
    prof = [(math.sin(t), -math.cos(t)) for t in np.linspace(0, math.pi, rings + 2)]
    prof[0] = (0.0, prof[0][1])
    prof[-1] = (0.0, prof[-1][1])
    Rm = R if R is not None else rot_z(rng.uniform(0, TAU)) @ rot_x(rng.uniform(-0.4, 0.4))
    S = np.diag(size)
    lathe(mb, prof, Xf(Rm @ S, c), mat, seg=seg, nz=rough, nfreq=1.7, seed=rng.uniform(0, 100))


def sweep_profile(mb, pts, prof, mat, up=(0, 0, 1), uv_len=True, caps=True):
    """Extrude a closed 2D profile (x along side axis, y along 'up' axis) along a polyline.
    Frame per point: T tangent, S = up x T (side), U = T x S. UV u = arc length, v = profile perimeter."""
    P = np.array([v3(p) for p in pts])
    n = len(P)
    prof = _ccw(prof)
    m = len(prof)
    upv = norm(v3(up))
    V = np.zeros((n * m, 3))
    UV = np.zeros((n * m, 2))
    per = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(np.vstack([prof, prof[:1]]), axis=0), axis=1))])[:m]
    acc = 0.0
    for i in range(n):
        if i == 0:
            T = norm(P[1] - P[0])
        elif i == n - 1:
            T = norm(P[-1] - P[-2])
        else:
            T = norm(norm(P[i + 1] - P[i]) + norm(P[i] - P[i - 1]))
        S = np.cross(upv, T)
        if np.linalg.norm(S) < 1e-6:
            S = np.cross(v3(1, 0, 0), T)
        S = norm(S)
        U = np.cross(T, S)
        if i > 0:
            acc += np.linalg.norm(P[i] - P[i - 1])
        # local profile x -> -S? keep (x->S, y->U); (S,U,T) right-handed since S x U = T
        V[i * m:(i + 1) * m] = P[i] + np.outer(prof[:, 0], S) + np.outer(prof[:, 1], U)
        UV[i * m:(i + 1) * m, 0] = acc
        UV[i * m:(i + 1) * m, 1] = per
    i = np.arange(n - 1)[:, None]
    j = np.arange(m)[None, :]
    j1 = (j + 1) % m
    F = np.stack([(i * m + j), (i * m + j1), ((i + 1) * m + j1), ((i + 1) * m + j)], axis=2).reshape(-1, 4)
    base = mb.nv
    mb.add(V, F, mat, uv=UV if uv_len else None)
    if caps:
        k = mb.mi(mat)
        mb.groups.setdefault(m, []).append((np.arange(m)[::-1][None, :] + base, np.array([k], dtype=np.int32)))
        mb.groups.setdefault(m, []).append((np.arange(m)[None, :] + base + (n - 1) * m, np.array([k], dtype=np.int32)))
        mb.tris += 2 * (m - 2)
