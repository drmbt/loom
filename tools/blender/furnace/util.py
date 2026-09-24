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
    """Accumulates world-space geometry, per-face material names, optional UVs.

    Faces may belong to a SOFT group (one id per primitive call): edges between two faces of the
    same soft group stay smooth up to SOFT_LIMIT_DEG (a 6-sided bolt head or an 8-sided rail
    shades round), every other edge is split only above the object's sharp angle. That is the
    retopo contract: vertices split only at real creases."""

    def __init__(self, name):
        self.name = name
        self.V = []          # list of (n,3)
        self.UV = []         # list of (n,2) or None
        self.groups = {}     # k -> list of (faces (m,k) global idx, mat idx (m,), soft id (m,), prim id (m,), solid (m,))
        self.nv = 0
        self.mats = []
        self._mi = {}
        self.tris = 0
        self.nsoft = 0
        self.nprim = 0       # one id per add() call: caps / fans appended right after belong to it
        self.solid = False   # the current primitive is a closed solid (it may occlude, and be occluded)
        self.tags = []       # PROFILE only: (caller tag, vertex count) per add()

    def mi(self, name):
        if name not in self._mi:
            self._mi[name] = len(self.mats)
            self.mats.append(name)
        return self._mi[name]

    def soft_id(self, soft):
        if not soft:
            return 0
        self.nsoft += 1
        return self.nsoft

    def faces(self, F, mat, soft=0, ovr=None):
        """Append faces (m,k) that index vertices ALREADY in the builder (global indices); they join the
        primitive of the last add(). ovr: optional (m,k,3) per-corner normals (zero rows = no override)."""
        F = np.asarray(F, dtype=np.int64)
        if F.size == 0:
            return
        if F.ndim == 1:
            F = F[None, :]
            if ovr is not None:
                ovr = np.asarray(ovr)[None]
        k = F.shape[1]
        m = self.mi(mat)
        n = len(F)
        self.groups.setdefault(k, []).append((F, np.full(n, m, dtype=np.int32), np.full(n, soft, dtype=np.int32),
                                              np.full(n, self.nprim, dtype=np.int32), np.full(n, self.solid, dtype=bool),
                                              None if ovr is None else np.asarray(ovr, dtype=np.float32)))
        self.tris += n * (k - 2)

    def add(self, V, faces, mat, uv=None, soft=False, solid=False, ovr=None):
        V = np.asarray(V, dtype=np.float64)
        if len(V) == 0:
            return 0
        self.nprim += 1
        self.solid = bool(solid)
        base = self.nv
        sid = self.soft_id(bool(soft)) if isinstance(soft, bool) or soft is None else int(soft)   # bool: new group; int: join group
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
            self.faces(F + base, mat, sid, ovr=ovr if len(fl) == 1 else None)
        self.V.append(V)
        self.UV.append(None if uv is None else np.asarray(uv, dtype=np.float64))
        self.nv += len(V)
        if PROFILE:
            self.tags.append((_caller_tag(), len(V)))
        return sid

    def merge(self, other):
        base = self.nv
        remap = np.array([self.mi(n) for n in other.mats], dtype=np.int32) if other.mats else None
        for k, lst in other.groups.items():
            for F, M, S, P, Q, O in lst:
                self.groups.setdefault(k, []).append((F + base, remap[M], np.where(S > 0, S + self.nsoft, 0).astype(np.int32),
                                                      P + self.nprim, Q, O))
        self.nsoft += other.nsoft
        self.nprim += other.nprim
        self.V.extend(other.V)
        self.UV.extend(other.UV)
        self.tags.extend(other.tags)
        self.nv += other.nv
        self.tris += other.tris


SOFT_LIMIT_DEG = 95.0
PROFILE = bool(__import__("os").environ.get("FURNACE_PROFILE"))
PROFILE_OUT = {}     # object name -> {tag: split vertices}


def _caller_tag():
    """'module.function/primitive' of the geometry call that created these vertices (diagnostics only)."""
    import inspect
    prim, outer = None, None
    for fr in inspect.stack()[2:12]:
        mod = __import__("os").path.basename(fr.filename)[:-3]
        if mod == "util":
            if fr.function not in ("add", "prism", "lathe", "faces"):
                prim = fr.function
        else:
            outer = f"{mod}.{fr.function}"
            break
    return f"{outer}/{prim or 'add'}"
CULLED = {}          # object name -> faces deleted as never visible (build stats)


def seg_for(r, seg):
    """Radius-adaptive cap on circumferential segments (soft shading carries the roundness)."""
    lim = 6 if r < 0.02 else 8 if r < 0.05 else 12 if r < 0.12 else 16 if r < 0.3 else 24 if r < 0.6 else 999
    return int(max(3, min(seg, lim)))


# -------------------------------------------------------------------- primitives

def _ccw(P):
    P = np.asarray(P, dtype=np.float64)
    a = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
    return P if a >= 0 else P[::-1]


def prism(mb, prof, length, xf, mat, caps=True, z0=0.0, soft=False, cap0=True, cap1=True):
    """Extrude closed 2D polygon (local XY) along local Z from z0 to z0+length.
    soft: the side faces shade as one smooth surface (round bars, bolt heads).
    cap0/cap1: drop the start/end cap when it sits against another solid (never visible)."""
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
    so, co = (None, None) if soft else _thin_normals(P, length, xf.R)
    mb.add(xf.apply(V), F, mat, soft=soft, solid=caps, ovr=so)
    if caps:
        # caps share verts with sides -> separate faces on the same verts
        base = mb.nv - 2 * n
        if cap0:
            mb.faces(np.arange(n - 1, -1, -1) + base, mat, ovr=None if co is None else co[0][::-1])
        if cap1:
            mb.faces(np.arange(n, 2 * n) + base, mat, ovr=None if co is None else co[1])


THIN = 0.035        # a face narrower than this (and < 0.4 x its wide neighbour) is a sliver: it must not split vertices


def _thin_normals(P, length, R):
    """Hardened normals for slivers of a prism (thin plates, flat bars, flange tips, thin slabs).
    Returns (side overrides (n,4,3), (cap0 corner overrides (n,3), cap1 (n,3)) or None). Zero = keep computed normal.
    - thin profile (plate, flat bar): every vertex takes the normal of the wide side face it belongs to, caps too;
    - short prism (slab extruded a few mm/cm): side loops take the cap normal of their ring;
    - otherwise each narrow side face (flange tip) borrows its wide neighbours' normals."""
    n = len(P)
    E = np.roll(P, -1, axis=0) - P
    w = np.linalg.norm(E, axis=1)
    if w.max() < 1e-9:
        return None, None
    nl = np.stack([E[:, 1], -E[:, 0], np.zeros(n)], axis=1) / np.maximum(w, 1e-12)[:, None]   # outward (CCW profile)
    nw = nl @ np.asarray(R).T
    nw /= np.maximum(np.linalg.norm(nw, axis=1), 1e-12)[:, None]
    zb, zt = norm(np.asarray(R) @ v3(0, 0, -1)), norm(np.asarray(R) @ v3(0, 0, 1))
    wmax = w.max()
    narrow = (w <= THIN) & (w <= 0.4 * wmax)
    side = np.zeros((n, 4, 3), dtype=np.float32)       # face k corners: (k bottom, k+1 bottom, k+1 top, k top)
    caps = None
    prev, nxt = np.roll(np.arange(n), 1), np.roll(np.arange(n), -1)
    if length <= THIN and length <= 0.4 * wmax:        # slab: sides are slivers of the caps
        side[:, 0] = side[:, 1] = zb
        side[:, 2] = side[:, 3] = zt
        return side, None
    if n == 4 and narrow.sum() == 2 and not narrow[0] == narrow[1]:
        # plate / flat bar: vertex j belongs to exactly one wide face
        wide_of = np.where(narrow[prev], np.arange(n), prev)          # face index (k) that is wide at vertex j
        vn = nw[wide_of]
        for k in range(n):
            side[k, 0] = side[k, 3] = vn[k]
            side[k, 1] = side[k, 2] = vn[(k + 1) % n]
        return side, (vn.astype(np.float32), vn.astype(np.float32))
    if not narrow.any():
        return None, None
    for k in np.nonzero(narrow)[0]:
        a, b = prev[k], nxt[k]
        if narrow[a] or narrow[b]:
            continue
        side[k, 0] = side[k, 3] = nw[a]
        side[k, 1] = side[k, 2] = nw[b]
    if not side.any():
        return None, None
    return side, None


def box(mb, size, xf, mat, caps=True, cap0=True, cap1=True):
    """Axis box centred at xf origin, size (sx, sy, sz). cap0 = the local -Z face."""
    sx, sy, sz = size
    prof = [(-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2)]
    prism(mb, prof, sz, xf, mat, caps=caps, z0=-sz / 2, cap0=cap0, cap1=cap1)


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


def cyl(mb, p0, p1, r, mat, seg=16, caps=True, up=(0, 0, 1), cap0=True, cap1=True):
    """Round bar / cylinder: soft sides (vertices split only at the cap rims), radius-capped segments."""
    p0, p1 = v3(p0), v3(p1)
    d = p1 - p0
    L = np.linalg.norm(d)
    if L < 1e-6:
        return
    prism(mb, circle(r, seg_for(r, seg)), L, Xf(frame(d, up), p0), mat, caps=caps, soft=True, cap0=cap0, cap1=cap1)


def rod(mb, p0, p1, r, mat, sides=4):
    """Thin round rod without caps (grating cross bars, lacing): a soft diamond section."""
    p0, p1 = v3(p0), v3(p1)
    d = p1 - p0
    L = np.linalg.norm(d)
    if L < 1e-6:
        return
    prism(mb, circle(r, sides, math.pi / sides), L, Xf(frame(d), p0), mat, caps=False, soft=True)


def lathe(mb, prof, xf, mat, seg=32, arc=None, nz=0.0, nfreq=0.6, seed=0.0, pole_eps=1e-5, soft=False):
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
    closed = full and (prof[0] == prof[-1] or (prof[0][0] < pole_eps and prof[-1][0] < pole_eps))
    sid = mb.add(V, F[0], mat, soft=soft, solid=closed)
    if len(F) == 2:
        mb.faces(F[1] + base, mat, sid)


def disk(mb, c, r, mat, seg=32, normal=(0, 0, 1), r_in=0.0):
    """Flat disk/annulus facing `normal`."""
    R = frame(normal)
    if r_in > 0:
        lathe(mb, [(r_in, 0), (r, 0)][::-1], Xf(R, c), mat, seg=seg)
    else:
        lathe(mb, [(r, 0), (0, 0)], Xf(R, c), mat, seg=seg)


def torus(mb, xf, R, r, mat, seg=32, rseg=8, arc=None):
    """Ring / bent tube: one soft surface (round in section at any rseg)."""
    rseg = seg_for(r, rseg)
    prof = [(R + r * math.cos(t), r * math.sin(t)) for t in np.linspace(-math.pi, math.pi, rseg + 1)[:-1]]
    # ring profile is closed: revolve polygon, close by repeating first point
    prof = prof + [prof[0]]
    # CCW in (r,z): param t increasing from -pi goes bottom->outer->top->inner (CCW) good
    lathe(mb, prof, xf, mat, seg=seg, arc=arc, soft=True)


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
    """Tube of radius r along polyline pts (optionally filleted with radius bend). Soft skin."""
    seg = seg_for(r, seg)
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
    mb.add(V, F, mat, uv=UV if uv_len else None, soft=True, solid=caps)
    if caps:
        # ring order is CCW about T: start cap (normal -T) reversed, end cap forward
        mb.faces(np.arange(seg)[::-1] + base, mat)
        mb.faces(np.arange(seg) + base + (n - 1) * seg, mat)


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


def hexbolt(mb, p, n, d, mat, h=None, washer=False):
    """Hex bolt head on surface point p with normal n, optionally on a washer."""
    h = h or d * 0.65
    p, n = v3(p), norm(v3(n))
    R = frame(n)
    if washer:
        # 4 mm washer, 12-gon: its rim is a sliver, so both rings take the cap normals (12 + 12 vertices)
        t = max(0.003, d * 0.1)
        prism(mb, circle(d * 1.45, 12), t, Xf(R, p), "steel_worn", cap0=False)
        p = p + n * t
    # soft hex flanks, no bearing face (it sits on the plate): 18 vertices instead of 36
    prism(mb, circle(d * 0.95, 6, math.pi / 6), h, Xf(R, p), mat, soft=True, cap0=False)


def bolt_circle(mb, c, normal, R, count, d, mat, a0=0.0, washer=False):
    c, nrm = v3(c), norm(v3(normal))
    F = frame(nrm)
    for k in range(count):
        a = a0 + k * TAU / count
        p = c + F[:, 0] * math.cos(a) * R + F[:, 1] * math.sin(a) * R
        hexbolt(mb, p, nrm, d, mat, washer=washer)


def weld(mb, pts, mat, r=0.008):
    """Fillet weld bead along a polyline: a soft 5-sided tube (10 vertices per station), no end caps."""
    sweep(mb, pts, r, mat, seg=5, caps=False)


def weld_ring(mb, c, R_, mat, seg=64, r=0.008, normal=(0, 0, 1)):
    """Circumferential weld bead (a thin soft torus)."""
    torus(mb, Xf(frame(normal), c), R_, r, mat, seg=seg, rseg=4)


def flange(mb, c, axis, r_pipe, mat, bolt_mat="steel_dark", thick=None, seg=24, bolts=None):
    """Pipe flange pair (two plates) + bolt heads, centred at c along axis."""
    c, ax = v3(c), norm(v3(axis))
    ro = r_pipe * 1.55 + 0.03
    t = thick or max(0.02, r_pipe * 0.18)
    cyl(mb, c - ax * t, c + ax * t, ro, mat, seg=seg)
    nb = bolts or max(4, int(round(r_pipe * 40 / 4)) * 4)
    nb = min(nb, 24)
    d = max(0.012, r_pipe * 0.09)
    bolt_circle(mb, c + ax * t, ax, (r_pipe + ro) / 2 + 0.01, nb, d, bolt_mat, washer=d >= 0.03)
    bolt_circle(mb, c - ax * t, -ax, (r_pipe + ro) / 2 + 0.01, nb, d, bolt_mat, washer=d >= 0.03)


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
            box(mb, (0.05, 0.05, h), Xf(None, p + v3(0, 0, h / 2)), mat, cap0=False)
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
            rod(mb, (x, y0, z - 0.004), (x, y1, z - 0.004), 0.0056, mat)
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
        rod(mb, (x0, y, z - 0.004), (x1, y, z - 0.004), 0.0056, mat)


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
        rod(mb, p - wd * width / 2 - v3(0, 0, 0.004), p + wd * width / 2 - v3(0, 0, 0.004), 0.0056, mat)


# ------------------------------------------------------------------- finalizing

def tri_count(ob):
    me = ob.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def _edge_faces(me):
    """(edges with exactly two faces) -> (edge idx, face0, face1); plus per-edge face count."""
    ne, npoly = len(me.edges), len(me.polygons)
    le = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("edge_index", le)
    lt = np.zeros(npoly, dtype=np.int64)
    me.polygons.foreach_get("loop_total", lt)
    lp = np.repeat(np.arange(npoly), lt)
    order = np.argsort(le, kind="stable")
    le, lp = le[order], lp[order]
    cnt = np.bincount(le, minlength=ne)
    first = np.zeros(ne, dtype=np.int64)
    first[1:] = np.cumsum(cnt)[:-1]
    two = np.nonzero(cnt == 2)[0]
    return two, lp[first[two]], lp[first[two] + 1], cnt


def _cull(me, keep_mask):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    dead = [f for f, k in zip(bm.faces, keep_mask) if not k]
    if dead:
        bmesh.ops.delete(bm, geom=dead, context="FACES_ONLY")
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()
    return len(dead)


def floor_hidden_faces(me, pv):
    """Faces nobody can see: facing down while resting on / buried in the hall floor (z <= 0.03),
    and anything entirely below the floor surface."""
    npoly = len(me.polygons)
    pn = np.zeros(npoly * 3)
    me.polygons.foreach_get("normal", pn)
    pn = pn.reshape(-1, 3)
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3) + pv
    lt = np.zeros(npoly, dtype=np.int64)
    me.polygons.foreach_get("loop_total", lt)
    li = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", li)
    z = co[li, 2]
    lp = np.repeat(np.arange(npoly), lt)
    zmax = np.full(npoly, -1e9)
    np.maximum.at(zmax, lp, z)
    down = (pn[:, 2] < -0.95) & (zmax < 0.03)
    below = zmax < -0.04
    return ~(down | below)


def _profile(me, mb, name):
    li = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", li)
    cn = np.zeros(len(me.loops) * 3)
    me.corner_normals.foreach_get("vector", cn)
    key = np.concatenate([li[:, None].astype(np.float64), np.round(cn.reshape(-1, 3), 3)], axis=1)
    u = np.unique(key, axis=0)
    per_v = np.bincount(u[:, 0].astype(np.int64), minlength=len(me.vertices))
    tagv = np.empty(mb.nv, dtype=object)
    off = 0
    for t, n in mb.tags:
        tagv[off:off + n] = t
        off += n
    out = {}
    for t in set(x for x, _ in mb.tags):
        out[t] = int(per_v[tagv == t].sum())
    PROFILE_OUT[name] = out


NO_BEVEL = {"grating", "glass_pulpit", "lamp", "screen_glow", "sky_opening"}   # fine bars / panes: chamfers buy nothing
HIDDEN_PASS = not bool(__import__("os").environ.get("FURNACE_NO_HIDDEN"))
CONTACT_EPS = 0.004


def occluded_faces(me):
    """Keep-mask that drops faces of closed solids which nobody can see: every sample (centroid + three inset
    corners) either touches the face of another closed solid of the same object head-on (contact, < 4 mm) or
    lies inside one (the first surface along the normal is that solid's back face). Open sheets and tubes never
    occlude and are never dropped."""
    from mathutils.bvhtree import BVHTree
    npoly = len(me.polygons)
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    lt = np.zeros(npoly, dtype=np.int64)
    ls = np.zeros(npoly, dtype=np.int64)
    me.polygons.foreach_get("loop_total", lt)
    me.polygons.foreach_get("loop_start", ls)
    li = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", li)
    pn = np.zeros(npoly * 3)
    me.polygons.foreach_get("normal", pn)
    pn = pn.reshape(-1, 3)
    pc = np.zeros(npoly * 3)
    me.polygons.foreach_get("center", pc)
    pc = pc.reshape(-1, 3)
    prim = np.zeros(npoly, dtype=np.int32)
    me.attributes["prim"].data.foreach_get("value", prim)
    solid = np.zeros(npoly, dtype=bool)
    me.attributes["solid"].data.foreach_get("value", solid)
    polys = [li[a:a + n].tolist() for a, n in zip(ls, lt)]
    bvh = BVHTree.FromPolygons([tuple(v) for v in co], polys, all_triangles=False, epsilon=0.0)
    keep = np.ones(npoly, dtype=bool)
    V = Vector

    def covered(p, n, f):
        hit = bvh.ray_cast(V(p + n * 1e-4), V(n), 400.0)
        g = hit[2]
        if g is None or not solid[g] or prim[g] == prim[f]:
            return False
        d = hit[1].dot(V(n))
        return (hit[3] < CONTACT_EPS and d < -0.3) or d > 0.3

    for f in np.nonzero(solid)[0]:
        n = pn[f]
        if not covered(pc[f], n, f):
            continue
        cs = co[li[ls[f]:ls[f] + lt[f]]]
        idx = np.linspace(0, len(cs), 4, endpoint=False).astype(int)[:3] if len(cs) > 3 else range(len(cs))
        if all(covered(pc[f] + (cs[i] - pc[f]) * 0.85, n, f) for i in idx):
            keep[f] = False
    return keep


BEVEL_K = 0.06              # chamfer width = K x the part size (smallest extent of its primitive's bounding box) ...
BEVEL_MIN, BEVEL_MAX = 0.005, 0.06   # ... clamped to 5-60 mm (5-20 mm on small parts, 20-60 mm on large steel)
BEVEL_SEG2 = 0.02           # chamfers this wide or wider get 2 segments (a rounded arris), narrower ones 1
BEVEL_RIM = 0.12            # round rims (cylinder / lathe edges next to a smooth surface) only from this radius up


def _bevel(ob, me, mb, two, f0, f1, ang, pn, soft, thin_face, scale, name):
    """Chamfer every convex hard crease (> 50 deg) with a width scaled to the part and hardened normals, so the
    flats stay flat and the chamfer catches the light (the weighted-normals look). Slivers (hardened thin faces)
    already shade as rounded arrises and are left alone; concave roots are left sharp. Applied here, so the
    exported mesh carries the chamfers."""
    npoly = len(me.polygons)
    area = np.zeros(npoly)
    me.polygons.foreach_get("area", area)
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    ev = np.zeros(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", ev)
    ev = ev.reshape(-1, 2)
    elen = np.linalg.norm(co[ev[:, 0]] - co[ev[:, 1]], axis=1)
    le = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("edge_index", le)
    lt = np.zeros(npoly, dtype=np.int64)
    me.polygons.foreach_get("loop_total", lt)
    perim = np.bincount(np.repeat(np.arange(npoly), lt), weights=elen[le], minlength=npoly)
    size = 2.0 * area / np.maximum(perim, 1e-9)
    pc = np.zeros(npoly * 3)
    me.polygons.foreach_get("center", pc)
    pc = pc.reshape(-1, 3)
    convex = np.sum(pn[f0] * (pc[f1] - pc[f0]), axis=1) < -1e-6
    mi = np.zeros(npoly, dtype=np.int32)
    me.polygons.foreach_get("material_index", mi)
    nob = np.array([mb.mats[k] in NO_BEVEL for k in range(len(mb.mats))] or [False])
    elig = (ang > math.radians(50.0)) & convex & ~(thin_face[f0] | thin_face[f1]) & ~(nob[mi[f0]] | nob[mi[f1]])
    s0, s1 = size[f0], size[f1]
    soft0, soft1 = soft[f0] > 0, soft[f1] > 0
    # the part's size = the smallest extent of its primitive's bounding box (a 1 m box, a 0.3 m flange ring ...)
    prim = np.zeros(npoly, dtype=np.int64)
    me.attributes["prim"].data.foreach_get("value", prim)
    li = np.zeros(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", li)
    lp = prim[np.repeat(np.arange(npoly), lt)]
    np_ = int(prim.max()) + 1 if npoly else 1
    lo = np.full((np_, 3), 1e9)
    hi = np.full((np_, 3), -1e9)
    np.minimum.at(lo, lp, co[li])
    np.maximum.at(hi, lp, co[li])
    ext = (hi - lo).min(axis=1)
    part = np.minimum(ext[prim[f0]], ext[prim[f1]])
    # next to a smooth (soft) surface: only big round parts (the flat cap's size ~ radius) get a rim chamfer
    cap = np.where(soft0 & ~soft1, s1, np.where(soft1 & ~soft0, s0, np.minimum(s0, s1)))
    elig &= ~(soft0 | soft1) | (cap >= BEVEL_RIM)
    width = np.clip(BEVEL_K * part * scale, BEVEL_MIN, BEVEL_MAX)
    width = np.minimum(width, 0.3 * elen[two])                   # never eat a short edge
    w1 = np.zeros(len(me.edges), dtype=np.float32)
    w2 = np.zeros(len(me.edges), dtype=np.float32)
    big = width >= BEVEL_SEG2
    w1[two[elig & ~big]] = (width[elig & ~big] / BEVEL_MAX)
    w2[two[elig & big]] = (width[elig & big] / BEVEL_MAX)
    if not (w1.any() or w2.any()):
        return me
    for an, w in (("bw1", w1), ("bw2", w2)):
        at = me.attributes.new(an, "FLOAT", "EDGE")
        at.data.foreach_set("value", w)
    mods = []
    for an, segs in (("bw2", 2), ("bw1", 1)):
        mod = ob.modifiers.new("bevel_" + an, "BEVEL")
        mod.width = BEVEL_MAX
        mod.segments = segs
        mod.profile = 0.5
        mod.limit_method = "WEIGHT"
        mod.edge_weight = an
        mod.use_clamp_overlap = True
        mod.harden_normals = True
        mod.miter_outer = "MITER_ARC"
        mods.append(mod)
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    for mod in mods:
        ob.modifiers.remove(mod)
    old = ob.data
    ob.data = me2
    bpy.data.meshes.remove(old)
    me2.name = name
    return me2


def to_object(mb, materials, collection, pivot=None, props=None, parent=None, grime=None, bevel=0.0,
              sharp_deg=38.0, uv_scale=0.5, max_edge=0.0, name=None, cull=True):
    """Create a Blender object from a builder. Object origin = pivot (world).

    Vertex budget rules applied here (see README "Retopo"):
      - normals split only at hard creases: > sharp_deg between ordinary faces, > SOFT_LIMIT_DEG inside a
        soft group (round bars, tubes, bolt flanks);
      - bevel (if any) runs on the hard edges only, with hardened normals, and is APPLIED here, so the
        chamfers cost triangles but no extra vertices;
      - UVs are box-projected by the CORNER normal (not the face normal), so a UV seam never splits a vertex
        that the normals did not already split;
      - faces resting face-down on the floor, or buried under it, are deleted."""
    if mb.nv == 0:
        return None
    V = np.concatenate(mb.V)
    pv = v3(pivot) if pivot is not None else v3(0, 0, 0)
    me = bpy.data.meshes.new(name or mb.name)
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", (V - pv).astype(np.float32).ravel())
    Fs, Ms, Ss, Ps, Qs, Os, sizes = [], [], [], [], [], [], []
    for k, lst in mb.groups.items():
        F = np.concatenate([g[0] for g in lst])
        Fs.append(F.ravel())
        Ms.append(np.concatenate([g[1] for g in lst]))
        Ss.append(np.concatenate([g[2] for g in lst]))
        Ps.append(np.concatenate([g[3] for g in lst]))
        Qs.append(np.concatenate([g[4] for g in lst]))
        Os.append(np.concatenate([g[5].reshape(-1, 3) if g[5] is not None else np.zeros((g[0].size, 3), np.float32)
                                  for g in lst]))
        sizes.append(np.full(len(F), k, dtype=np.int64))
    loops = np.concatenate(Fs)
    mats = np.concatenate(Ms)
    softs = np.concatenate(Ss)
    prims = np.concatenate(Ps)
    solids = np.concatenate(Qs)
    ovrs = np.concatenate(Os)
    sizes = np.concatenate(sizes)
    starts = np.zeros(len(sizes), dtype=np.int64)
    starts[1:] = np.cumsum(sizes)[:-1]
    me.loops.add(len(loops))
    me.loops.foreach_set("vertex_index", loops.astype(np.int32))
    me.polygons.add(len(sizes))
    me.polygons.foreach_set("loop_start", starts.astype(np.int32))
    me.update(calc_edges=True)
    for mname in mb.mats:
        me.materials.append(materials[mname])
    me.polygons.foreach_set("material_index", mats.astype(np.int32))
    sa = me.attributes.new("soft", "INT", "FACE")
    sa.data.foreach_set("value", softs.astype(np.int32))
    pa = me.attributes.new("prim", "INT", "FACE")
    pa.data.foreach_set("value", prims.astype(np.int32))
    qa = me.attributes.new("solid", "BOOLEAN", "FACE")
    qa.data.foreach_set("value", solids.astype(bool))
    has_ovr = bool(np.any(ovrs))
    if has_ovr:
        oa = me.attributes.new("ovr", "FLOAT_VECTOR", "CORNER")
        oa.data.foreach_set("vector", ovrs.astype(np.float32).ravel())
    me.update()
    me.validate(clean_customdata=False)
    has_explicit = any(U is not None for U in mb.UV)
    if max_edge > 0 and not has_explicit and not PROFILE:
        # densify big flat surfaces so loom's vertex kernels have something to deform
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
    culled = 0
    if cull and not has_explicit and not PROFILE:
        keep = floor_hidden_faces(me, pv)
        if HIDDEN_PASS:
            keep &= occluded_faces(me)
        culled = _cull(me, keep)
    # ---- shading: smooth everywhere, sharp only at real creases
    me.shade_smooth()
    two, f0, f1, cnt = _edge_faces(me)
    pn = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get("normal", pn)
    pn = pn.reshape(-1, 3)
    soft = np.zeros(len(me.polygons), dtype=np.int32)
    me.attributes["soft"].data.foreach_get("value", soft)
    ang = np.arccos(np.clip(np.sum(pn[f0] * pn[f1], axis=1), -1.0, 1.0))
    same_soft = (soft[f0] == soft[f1]) & (soft[f0] > 0)
    lim = np.where(same_soft, math.radians(SOFT_LIMIT_DEG), math.radians(sharp_deg))
    sharp = np.zeros(len(me.edges), dtype=bool)
    sharp[two] = ang > lim
    sharp[cnt > 2] = True
    se = me.attributes.get("sharp_edge") or me.attributes.new("sharp_edge", "BOOLEAN", "EDGE")
    se.data.foreach_set("value", sharp)
    thin_face = np.zeros(len(me.polygons), dtype=bool)
    if "ovr" in me.attributes:
        # hardened sliver normals: override the computed corner normals where a primitive asked for it
        nl = len(me.loops)
        ov = np.zeros(nl * 3, dtype=np.float32)
        me.attributes["ovr"].data.foreach_get("vector", ov)
        ov = ov.reshape(-1, 3).astype(np.float64)
        ln = np.linalg.norm(ov, axis=1)
        use = ln > 0.5
        cn = np.zeros(nl * 3)
        me.corner_normals.foreach_get("vector", cn)
        cn = cn.reshape(-1, 3)
        cn[use] = ov[use] / ln[use, None]
        me.normals_split_custom_set([tuple(v) for v in cn])
        lt_ = np.zeros(len(me.polygons), dtype=np.int64)
        me.polygons.foreach_get("loop_total", lt_)
        np.logical_or.at(thin_face, np.repeat(np.arange(len(me.polygons)), lt_), use)
        me.attributes.remove(me.attributes["ovr"])
    if PROFILE:
        _profile(me, mb, name or mb.name)
    ob = bpy.data.objects.new(name or mb.name, me)
    ob.location = Vector(pv)
    collection.objects.link(ob)
    if bevel and not has_explicit:
        me = _bevel(ob, me, mb, two, f0, f1, ang, pn, soft, thin_face, float(bevel), name or mb.name)
    for an in ("soft", "prim", "solid"):
        if an in me.attributes:
            me.attributes.remove(me.attributes[an])
    for an in ("bw1", "bw2"):
        if an in me.attributes:
            me.attributes.remove(me.attributes[an])
    V = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", V)
    V = V.reshape(-1, 3) + pv
    # ---- UVs: explicit per-vertex where provided, else box projection chosen by the corner normal
    uvl = me.uv_layers.new(name="UVMap")
    nl = len(me.loops)
    li = np.zeros(nl, dtype=np.int32)
    me.loops.foreach_get("vertex_index", li)
    cn = np.zeros(nl * 3)
    me.corner_normals.foreach_get("vector", cn)
    n = np.abs(cn.reshape(-1, 3))
    P = V[li]
    ax = np.argmax(n, axis=1)
    uv = np.where(ax[:, None] == 2, P[:, [0, 1]], np.where(ax[:, None] == 0, P[:, [1, 2]], P[:, [0, 2]])) * uv_scale
    if has_explicit:
        explicit = np.zeros(len(V), dtype=bool)
        UVv = np.zeros((len(V), 2))
        off = 0
        for Vi, U in zip(mb.V, mb.UV):
            if U is not None:
                explicit[off:off + len(Vi)] = True
                UVv[off:off + len(Vi)] = U
            off += len(Vi)
        e = explicit[li]
        uv[e] = UVv[li[e]]
    uvl.data.foreach_set("uv", uv.astype(np.float32).ravel())
    # vertex colour (broad variation only; loom does fine grime in shaders)
    if grime is not None:
        col = grime(V, me)
        ca = me.color_attributes.new("grime", "FLOAT_COLOR", "POINT")
        ca.data.foreach_set("color", col.astype(np.float32).ravel())
        me.color_attributes.active_color = ca
        me.color_attributes.render_color_index = 0
    if parent is not None:
        # parts carry identity rotation: the child's local translation is its offset from the parent pivot
        bpy.context.view_layer.update()
        ob.parent = parent
        ob.location = Vector(pv) - parent.matrix_world.translation
    if props:
        for k, v in props.items():
            ob[k] = v
    CULLED[ob.name] = culled
    return ob


def flood(mb, c, aim, fixtures, area, follow=None, mount=None):
    """Small floodlight: yoke bracket, housing, lamp glass facing `aim`; records a lamp.* fixture."""
    c, aim = v3(c), norm(v3(aim))
    R = frame(aim)
    box(mb, (0.42, 0.34, 0.22), Xf(R, c - aim * 0.02), "steel_dark")
    box(mb, (0.36, 0.28, 0.012), Xf(R, c + aim * 0.095), "lamp")
    for k in range(3):                                          # cooling fins on the back
        box(mb, (0.4, 0.02, 0.06), Xf(R, c - aim * 0.16 + R[:, 1] * (-0.1 + 0.1 * k)), "steel_dark")
    if mount is not None:
        sweep(mb, [c - aim * 0.13, v3(mount)], 0.02, "steel_dark", seg=6)
    fixtures.append((area, "flood", tuple(c + aim * 0.11), tuple(aim), follow))


class Rng(random.Random):
    def jit(self, a):
        return self.uniform(-a, a)


def lump(mb, c, size, mat, rng, seg=10, rings=6, rough=0.3, crack=0.0, flat=0.35, R=None, glow_mat=None, freq=1.4):
    """Slag / clinker lump: a soft-shaded noisy spheroid with a flattened underside.
    crack > 0 cuts crust fissures (narrow grooves along a noise zero-set); with glow_mat the faces inside the
    fissures take that material, so a hot lump reads as dark crust with glowing seams. Vertices: seg*rings+2."""
    from grime import fbm
    # rng draws match v1's rock() exactly (2 for the orientation, 1 seed), so every seeded layout after a lump is unchanged
    Rm = R if R is not None else rot_z(rng.uniform(0, TAU)) @ rot_x(rng.uniform(-0.25, 0.25))
    rng = random.Random(rng.uniform(0, 100))
    th = np.linspace(0.0, math.pi, rings + 2)[1:-1]
    ph = np.arange(seg) * TAU / seg + rng.uniform(0, TAU)
    st, ct = np.sin(th)[:, None], np.cos(th)[:, None]
    ring = np.stack([st * np.cos(ph)[None, :], st * np.sin(ph)[None, :], -ct * np.ones((1, seg))], axis=2).reshape(-1, 3)
    U = np.concatenate([[(0.0, 0.0, -1.0)], ring, [(0.0, 0.0, 1.0)]])
    off = np.array([rng.uniform(0, 60), rng.uniform(0, 60), rng.uniform(0, 60)])
    sd = rng.randrange(1 << 16)
    n = (fbm(U * freq + off, 1.0, sd, 3) - 0.5) * 2.0
    n2 = (fbm(U * freq * 3.1 + off * 0.7, 1.0, sd + 3, 2) - 0.5) * 2.0
    d = 1.0 + rough * (n + 0.45 * n2)
    groove = np.zeros(len(U))
    if crack > 0:
        cr = fbm(U * freq * 1.3 + off * 1.3, 1.0, sd + 7, 2)
        groove = np.exp(-((cr - 0.5) / 0.06) ** 2)
        d = d - crack * groove
    P = U * d[:, None]
    P[:, 2] = np.maximum(P[:, 2], -flat)
    P = (P * np.asarray(size, dtype=np.float64)) @ Rm.T + v3(c)
    rows = [np.array([0])] + [1 + k * seg + np.arange(seg) for k in range(rings)] + [np.array([1 + rings * seg])]
    j0 = np.arange(seg)
    j1 = (j0 + 1) % seg
    quads = np.concatenate([np.stack([rows[k][j0], rows[k][j1], rows[k + 1][j1], rows[k + 1][j0]], axis=1)
                            for k in range(1, rings)]) if rings > 1 else np.zeros((0, 4), np.int64)
    tris = np.concatenate([np.stack([np.zeros(seg, np.int64), rows[1][j1], rows[1][j0]], axis=1),
                           np.stack([rows[rings][j0], rows[rings][j1], np.full(seg, rows[-1][0])], axis=1)])
    base = mb.nv
    if glow_mat is not None and crack > 0:
        gq = groove[quads].mean(axis=1) > 0.22
        gt = groove[tris].mean(axis=1) > 0.22
        sid = mb.add(P, quads[~gq], mat, soft=True, solid=True)
        mb.faces(quads[gq] + base, glow_mat, sid)
        mb.faces(tris[~gt] + base, mat, sid)
        mb.faces(tris[gt] + base, glow_mat, sid)
    else:
        sid = mb.add(P, quads, mat, soft=True, solid=True)
        mb.faces(tris + base, mat, sid)


def rock(mb, c, size, mat, rng, seg=7, rings=4, rough=0.28, R=None):
    """Irregular lump (slag, scrap clinker): soft noisy spheroid (see lump)."""
    lump(mb, c, size, mat, rng, seg=max(8, seg + 1), rings=max(4, rings + 1), rough=min(rough, 0.3), R=R)


def loft(mb, prof0, z0, prof1, z1, xf, mat, cap0=True, cap1=True):
    """Ruled solid between two closed profiles with the same point count (local XY at local z0 / z1)."""
    P0, P1 = _ccw(prof0), _ccw(prof1)
    n = len(P0)
    V = np.zeros((2 * n, 3))
    V[:n, :2], V[n:, :2] = P0, P1
    V[:n, 2], V[n:, 2] = z0, z1
    i = np.arange(n)
    j = (i + 1) % n
    mb.add(xf.apply(V), np.stack([i, j, j + n, i + n], axis=1), mat, solid=cap0 or cap1)
    base = mb.nv - 2 * n
    if cap0:
        mb.faces(np.arange(n - 1, -1, -1) + base, mat)
    if cap1:
        mb.faces(np.arange(n, 2 * n) + base, mat)


def sweep_profile(mb, pts, prof, mat, up=(0, 0, 1), uv_len=True, caps=True, soft=False):
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
    mb.add(V, F, mat, uv=UV if uv_len else None, soft=soft, solid=caps)
    if caps:
        mb.faces(np.arange(m)[::-1] + base, mat)
        mb.faces(np.arange(m) + base + (n - 1) * m, mat)
