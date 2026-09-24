"""Vertex-colour grime (COLOR_0): a multiplier on base colour.

Soot falls off with distance from the furnace, fume soot collects high in the
roof, dust settles on up-facing surfaces, rust blooms low and on noise patches,
and steel near the shell gets a heat tint.
"""
import numpy as np

from layout import FURNACE_C


def _hash(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 1274126177 + seed * 2654435761) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h = h ^ (h >> 16)
    return (h & 0xFFFF) / 65535.0


def vnoise(P, scale, seed=0):
    """Vectorised trilinear value noise in [0,1]."""
    Q = P * scale
    i = np.floor(Q).astype(np.int64)
    f = Q - i
    f = f * f * (3 - 2 * f)
    out = np.zeros(len(P))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out += w * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out


def fbm(P, scale, seed=0, oct=3):
    a, s, tot, acc = 1.0, scale, 0.0, 0.0
    for o in range(oct):
        acc += a * vnoise(P, s, seed + o * 17)
        tot += a
        a *= 0.5
        s *= 2.13
    return acc / tot


def make(wear=1.0, soot=1.0, rust=0.35, dust=1.0, heat=0.0, seed=1):
    """Return grime(co, mesh) -> (n,4) linear RGBA multiplier."""
    fc = np.array(FURNACE_C)

    def grime(co, me):
        n = len(co)
        nrm = np.zeros(n * 3)
        me.vertices.foreach_get("normal", nrm)
        nrm = nrm.reshape(-1, 3)
        d = np.linalg.norm(co - fc, axis=1)
        z = co[:, 2]
        big = fbm(co, 0.18, seed, 3)
        small = fbm(co, 1.3, seed + 5, 2)
        c = np.ones((n, 3))
        # general mottling / wear
        mott = 1.0 - wear * (0.30 * big + 0.18 * small)
        c *= mott[:, None]
        # soot near the furnace and high in the roof
        s_f = np.exp(-np.maximum(d - 3.5, 0) / 11.0) * 0.55
        s_r = np.clip((z - 18.0) / 14.0, 0, 1) * 0.45
        s = soot * np.clip(s_f + s_r, 0, 0.8) * (0.6 + 0.8 * big)
        c *= (1.0 - np.clip(s, 0, 0.85))[:, None]
        # dust on up-facing surfaces (grey-brown, lightening dark paint slightly)
        up = np.clip(nrm[:, 2], 0, 1) ** 2
        dcol = np.array([0.95, 0.9, 0.82])
        k = dust * up * (0.35 + 0.4 * small)
        c = c * (1 - k[:, None] * 0.35) + (k[:, None] * 0.35) * dcol * mott[:, None]
        # rust bloom: low parts + noise patches
        low = np.clip(1.0 - z / 4.0, 0, 1)
        rpatch = np.clip((fbm(co, 0.55, seed + 11, 3) - 0.52) * 4.0, 0, 1)
        r = rust * np.clip(0.6 * low + rpatch, 0, 1)
        rc = np.array([1.0, 0.62, 0.40])
        c = c * (1 - r[:, None]) + c * rc * r[:, None]
        # heat tint near the shell (straw/brown -> dull blue)
        if heat > 0:
            hk = heat * np.exp(-np.maximum(d - 4.0, 0) / 2.5)
            hc = np.array([0.85, 0.78, 0.95])
            c = c * (1 - hk[:, None]) + c * hc * hk[:, None]
        c = np.clip(c, 0.05, 1.2)
        return np.concatenate([c, np.ones((n, 1))], axis=1)

    return grime
