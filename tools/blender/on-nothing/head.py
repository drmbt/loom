"""The performer's head for close-ups (T1418b skin, beard and eyes; T1428b the brimmed cap).

loom samples no image textures on a mesh (the GLB decoder ignores them, and Material · WGSL has
no texture binding), so the head carries what a texture set would have given it in the two
channels loom does read per vertex, COLOR_0 and TEXCOORD_0:

- ALBEDO. MakeHuman's CC0 skin (`young_african_male`), toned to a mid-dark complexion (the reference
  performer's), is sampled at every face corner's UV and baked into COLOR_0 (rgb, linear). The
  head is ~2 mm between vertices, so the bake holds the lips, the lid lines, the brow and nose
  shading and the ear folds. The finer detail (pores, stubble) is drawn by the surface from the
  UV (surface-head.ts), where it is stable as the figure moves.
- HAIR DENSITY in COLOR_0's alpha, as 1 − density: a goatee joined to a moustache, a lighter
  stubble along the jaw, the brows. The surface grows short hairs there (class 36).
- EYES. MakeHuman's high-poly eyes, their CC0 brown iris baked into COLOR_0 the same way; the
  cornea shell (it maps to the texture's blue disc) is dropped, since loom draws nothing
  transparent. The surface draws a wet, glossy eye with a crisp iris and pupil (class 37).

The cap (T1428b) is a fitted six-panel cap with a curved bill and a white embroidered rosette
on the front panel: a crown that hugs the measured skull, as the beanie does. It is built into
the `fig` body beside the beanie, and loom's areas pick one: `fig` drops the cap (`!material:cap_*`),
`figcap` drops the beanie (scene-facts.ts).
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

MPFB_DATA = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
    "renders", "on-nothing", "assets", "blender-user", "extensions", ".user", "user_default", "mpfb", "data")
SKIN_TEXTURE = "skins/young_african_male/young_darkskinned_male_diffuse.png"
EYE_TEXTURE = "eyes/materials/brown_eye.png"
# The complexion: the baked skin is scaled per channel so the FACE's mean albedo lands here
# (linear): a mid-dark brown. MakeHuman's painted texture alone is far redder and darker
# (face mean 0.071, 0.03, 0.017), which the scene's lights, tuned for the old flat skin, lose.
FACE_MEAN = (0.27, 0.16, 0.105)

# name: (base rgb, metallic, roughness, class code). The class is surface.ts's (loom_heat = code / 64).
# Base colours of the two baked materials are white: their colour is COLOR_0.
LIB = {
    "skin_tex": ((1.0, 1.0, 1.0), 0.0, 0.5, 36),
    "eye": ((1.0, 1.0, 1.0), 0.0, 0.05, 37),
    # the cap: black cotton twill (cloth, class 31) and its white embroidery (class 31, white thread)
    "cap_black": ((0.02, 0.02, 0.021), 0.0, 0.85, 31),
    "cap_emblem": ((0.62, 0.62, 0.6), 0.0, 0.7, 31),
}


def materials(mats):
    """Add the head's materials to the scene's library (once)."""
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
    return mats


def _image(rel, texel=None):
    path = os.path.normpath(os.path.join(MPFB_DATA, rel))
    if not os.path.exists(path):
        raise RuntimeError(f"head: no CC0 texture at {path} (see README: the MPFB system assets)")
    img = bpy.data.images.load(path, check_existing=True)
    w, h = img.size
    px = np.empty(w * h * img.channels, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, img.channels)[:, :, :3]
    # 8-bit PNG pixels arrive as stored (sRGB): to linear
    px = np.where(px <= 0.04045, px / 12.92, ((px + 0.055) / 1.055) ** 2.4)
    if texel is not None:
        # prefilter to the vertex spacing: a point sample every ~2 mm of a 0.5 mm texture aliases into blotches
        k = max(1, int(round(texel)))
        h2, w2 = h // k, w // k
        px = px[:h2 * k, :w2 * k].reshape(h2, k, w2, k, 3).mean(axis=(1, 3))
    return px


def _local_mean(img, radius):
    """`img` box-blurred over (2 radius + 1) texels, the atlas's flat background left out of every mean."""
    bg = img[0, 0]
    mask = (np.abs(img - bg).sum(axis=2) > 0.01).astype(np.float64)

    def box(a):
        for axis in (0, 1):
            c = np.cumsum(np.pad(a, [(radius + 1, radius) if k == axis else (0, 0) for k in range(a.ndim)], mode="edge"), axis=axis)
            hi = np.take(c, np.arange(2 * radius + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, np.arange(0, c.shape[axis] - 2 * radius - 1), axis=axis)
            a = hi - lo
        return a
    weight = box(mask)
    out = box(img * mask[:, :, None]) / np.maximum(weight, 1e-6)[:, :, None]
    return np.where(weight[:, :, None] > 0, out, img)


def _sample(img, uv):
    """Bilinear lookup of `img` (h, w, 3) at uv (n, 2). Blender's image rows run bottom-up, as its v does."""
    h, w, _ = img.shape
    x = np.clip(uv[:, 0], 0, 1) * (w - 1)
    y = np.clip(uv[:, 1], 0, 1) * (h - 1)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy)
            + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)


def drop_cornea(eyes):
    """Delete the eyes' cornea shell: its faces map into the eye texture's blue disc (u > 0.86, v < 0.14)."""
    uv = eyes.data.uv_layers.active.data
    bm = bmesh.new()
    bm.from_mesh(eyes.data)
    layer = bm.loops.layers.uv.active
    shell = [f for f in bm.faces if all(l[layer].uv.x > 0.86 and l[layer].uv.y < 0.14 for l in f.loops)]
    bmesh.ops.delete(bm, geom=shell, context="FACES")
    bm.to_mesh(eyes.data)
    bm.free()
    del uv
    print(f"[head] eyes: dropped {len(shell)} cornea faces", flush=True)


def landmarks(body, cx, eye_z, face_y):
    """The centre-line profile of the face: nose tip, mouth line, chin, under-chin (Blender metres)."""
    tree = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
    prof = []
    for k in range(170):
        z = eye_z - 0.005 - k * 0.001
        h = tree.ray_cast(Vector((cx, face_y - 0.5, z)), Vector((0, 1, 0)), 1.0)
        prof.append((z, h[0].y if h[0] is not None else 9.0))

    def extreme(z_hi, z_lo, sign):
        cand = [(y * sign, z) for z, y in prof if z_lo <= z <= z_hi]
        return min(cand)[1]
    nose = extreme(eye_z - 0.02, eye_z - 0.065, 1)
    upper = extreme(nose - 0.012, nose - 0.03, 1)       # the upper lip's most forward point
    mouth = extreme(upper - 0.002, upper - 0.012, -1)   # the lips' parting: the dip between the lips
    chin = extreme(mouth - 0.02, mouth - 0.045, 1)      # the chin's most forward point
    y_chin = dict(prof)[chin]
    under = next((z for z, y in prof if z < chin and y > y_chin + 0.03), chin - 0.03)
    print(f"[head] face: nose {nose:.3f}  mouth {mouth:.3f}  chin {chin:.3f}  under-chin {under:.3f}", flush=True)
    return {"nose": nose, "upper": upper, "mouth": mouth, "chin": chin, "under": under}


def _smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def hair_density(p, cx, cy, eye_z, face_y, lm):
    """Facial hair per point (n, 3), 0..1: the reference's goatee and moustache, jaw stubble, brows."""
    x = np.abs(p[:, 0] - cx)
    y = p[:, 1]
    z = p[:, 2]
    front = _smooth(cy + 0.01, cy - 0.03, y)            # the front of the head, not the nape
    mouth, chin, under, nose, upper = lm["mouth"], lm["chin"], lm["under"], lm["nose"], lm["upper"]
    # moustache: the skin between the nose and the upper lip's red, as wide as the mouth,
    # its ends dropping past the corners of the mouth to meet the goatee
    lip_top = upper + 0.003
    corner = _smooth(0.016, 0.03, x)                     # 0 in the middle, 1 at the mouth's corners
    moust = _smooth(nose - 0.011, nose - 0.015, z) * _smooth(lip_top - 0.002 - 0.02 * corner, lip_top + 0.001 - 0.02 * corner, z)
    moust *= _smooth(0.036, 0.029, x) * (0.6 - 0.15 * corner)  # thin and sparse, as the reference's
    # goatee: under the lower lip to the under-chin, a little wider at the chin
    lip_bottom = mouth - 0.011
    width = 0.02 + 0.012 * _smooth(lip_bottom, chin, z)
    goat = _smooth(lip_bottom + 0.001, lip_bottom - 0.004, z) * _smooth(under - 0.014, under + 0.002, z) * _smooth(width + 0.007, width - 0.003, x)
    beard = np.maximum(moust, goat * 0.85) * _smooth(face_y + 0.07, face_y + 0.05, y)
    # light stubble on the jaw and under it, from the chin back towards the ears; the cheeks bare
    jaw = 0.24 * _smooth(mouth - 0.004, mouth - 0.016, z) * _smooth(under - 0.03, under - 0.012, z) * _smooth(cy + 0.03, cy + 0.0, y)
    # the brows: an arch over each eye, full at the head, thin at the tail
    bx = np.clip((x - 0.012) / 0.047, 0.0, 1.0)
    bz = eye_z + 0.019 + 0.006 * np.sin(np.pi * np.clip(bx * 0.8 + 0.15, 0, 1)) - 0.003 * bx
    half = 0.0045 - 0.003 * bx
    brow = _smooth(half + 0.0012, half - 0.0008, np.abs(z - bz)) * _smooth(0.009, 0.014, x) * _smooth(0.061, 0.055, x) * _smooth(face_y + 0.045, face_y + 0.03, y)
    return np.clip(np.maximum(np.maximum(beard, jaw * front), brow * 0.95), 0.0, 1.0)


# COLOR_0 alpha on a skin corner outside the head's UV island (see bake); the head's run 0.5..1
BODY_CODE = 0.25


def _uv_islands(me, polys):
    """Island id per polygon (-1 off `polys`): polygons joined where they share a vertex AND its UV."""
    parent = list(range(len(me.polygons)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    uv = me.uv_layers.active.data
    seen = {}
    for p in polys:
        poly = me.polygons[p]
        for li in poly.loop_indices:
            key = (me.loops[li].vertex_index, round(uv[li].uv.x, 5), round(uv[li].uv.y, 5))
            q = seen.setdefault(key, p)
            if q != p:
                ra, rb = find(p), find(q)
                if ra != rb:
                    parent[ra] = rb
    out = np.full(len(me.polygons), -1, dtype=np.int64)
    for p in polys:
        out[p] = find(p)
    return out


def bake(body, cx, cy, eye_z, face_y, lm):
    """COLOR_0 per face corner: the CC0 skin (skin_tex) and iris (eye) at the corner's UV, hair density in alpha."""
    me = body.data
    n_loops = len(me.loops)
    uv = np.empty(n_loops * 2, dtype=np.float32)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    loop_vert = np.empty(n_loops, dtype=np.int32)
    me.loops.foreach_get("vertex_index", loop_vert)
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3) @ np.array(body.matrix_world.to_3x3()).T + np.array(body.matrix_world.translation)
    mat_index = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("material_index", mat_index)
    loop_poly = np.empty(n_loops, dtype=np.int32)
    starts = np.empty(len(me.polygons), dtype=np.int32)
    totals = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_start", starts)
    me.polygons.foreach_get("loop_total", totals)
    loop_poly = np.repeat(np.arange(len(me.polygons)), totals)
    names = [m.name if m else "" for m in me.materials]
    loop_mat = np.array(names, dtype=object)[mat_index[loop_poly]]

    col = np.ones((n_loops, 4), dtype=np.float32)
    skin = loop_mat == "skin_tex"
    eye = loop_mat == "eye"
    if skin.any():
        # the head is ~2 mm between vertices, and the texture ~0.55 mm a texel (0.9 UV a metre, 2048 texels)
        tex = _image(SKIN_TEXTURE, texel=4)
        col[skin, :3] = _sample(tex, uv[skin])
        local = _sample(_local_mean(tex, 8), uv[skin])
        # T1418b round 2: ONE complexion over the whole body. MakeHuman paints each UV island in
        # its own tone (its hands island is pale beige, its torso lighter than its face), and one
        # face-set gain turned the hands white. Each island gets its own gain, so its mean lands
        # on FACE_MEAN; inside an island the painting is kept (palms lighter than the backs of
        # the hands, the lips, the nape's hairline). The head's island takes the FACE's gain,
        # so the dark scalp painting under the beanie does not brighten the face.
        island = _uv_islands(me, np.where(mat_index == names.index("skin_tex"))[0] if "skin_tex" in names else [])
        loop_island = island[loop_poly]
        face = skin & (co[loop_vert][:, 2] > lm["under"]) & (co[loop_vert][:, 1] < face_y + 0.04)
        head_id = np.bincount(loop_island[face]).argmax()
        face &= loop_island == head_id
        raw = col[face, :3].mean(axis=0)
        ids, counts = np.unique(loop_island[skin], return_counts=True)
        main = ids[np.argmax(np.where(ids == head_id, 0, counts))]   # the biggest island that is not the head's
        gains = {}
        for i, n in zip(ids, counts):
            if i == head_id:
                gains[i] = np.array(FACE_MEAN) / raw
            elif n >= 200:
                gains[i] = np.array(FACE_MEAN) / col[skin & (loop_island == i), :3].mean(axis=0)
        for i in ids:
            gains.setdefault(i, gains.get(main, np.array(FACE_MEAN) / raw))
        gain = np.stack([gains[i] for i in loop_island[skin]])
        # off the head, the island's LARGE-scale painting is flattened to a third of its contrast
        # (MakeHuman's palms and finger sides are near white against the backs of the hands);
        # the detail inside ~3 cm (knuckles, nail beds, creases) is kept, limited to 0.6..1.5x
        body_loops = loop_island[skin] != head_id
        detail = np.clip(col[skin, :3] / np.maximum(local, 1e-4), 0.6, 1.5)
        mean = np.array(FACE_MEAN) / gain                  # the island's raw mean
        flat = mean * (local / mean) ** 0.33 * detail
        col[skin, :3] = np.where(body_loops[:, None], flat, col[skin, :3])
        col[skin, :3] = np.clip(col[skin, :3] * gain, 0, 1)
        # alpha: the head's island carries 1 - density/2 (0.5..1: its hair); every other island
        # BODY_CODE x (1 - density) (0..0.25: surface-head.ts draws body pores at the body's UV
        # scale, no oil; the goatee runs on under the chin onto the neck's island).
        # Every triangle lies in one island, so the two codes never blend.
        dens = hair_density(co[loop_vert[skin]], cx, cy, eye_z, face_y, lm)
        head_loops = loop_island[skin] == head_id
        col[skin, 3] = np.where(head_loops, 1.0 - 0.5 * dens, BODY_CODE * (1.0 - dens))
        print(f"[head] skin bake: {skin.sum():,} corners in {len(ids)} islands (head {head_loops.sum():,}); "
              f"face mean rgb {raw.round(3)} -> {col[face, :3].mean(axis=0).round(3)}; body mean {col[skin & (loop_island != head_id), :3].mean(axis=0).round(3)}; "
              f"hair on {(dens > 0.5).sum():,}", flush=True)
        if os.environ.get("HEAD_DEBUG") == "uv":
            pts = co[loop_vert]
            for label, at in (("nose", (cx, face_y - 0.03, lm["nose"])), ("mouth", (cx, face_y, lm["mouth"])),
                              ("eyeL", (cx + 0.032, face_y + 0.01, eye_z)), ("eyeR", (cx - 0.032, face_y + 0.01, eye_z)),
                              ("browL", (cx + 0.035, face_y, eye_z + 0.022))):
                k = np.where(skin)[0][np.argmin(((pts[skin] - np.array(at)) ** 2).sum(axis=1))]
                print(f"[head] uv {label}: blender {uv[k].round(4)} gltf ({uv[k][0]:.4f}, {1 - uv[k][1]:.4f})", flush=True)
    if eye.any():
        if os.environ.get("HEAD_DEBUG") == "uv":
            e = np.where(eye)[0]
            front = e[np.argsort(co[loop_vert[e]][:, 1])[:40]]   # the eyes' most forward corners: the pupils
            print(f"[head] uv pupils (gltf): {np.unique(np.round(np.c_[uv[front][:, 0], 1 - uv[front][:, 1]], 3), axis=0)[:8]}", flush=True)
            r = np.linalg.norm(co[loop_vert[e]][:, [0, 2]] - co[loop_vert[front[0]]][[0, 2]], axis=1)
            print(f"[head] eye radius metres per uv: {np.median(r[r < 0.006] / np.maximum(np.linalg.norm(uv[e][r < 0.006] - uv[front[0]], axis=1), 1e-6)):.4f}", flush=True)
        col[eye, :3] = _sample(_image(EYE_TEXTURE), uv[eye])
    if os.environ.get("HEAD_DEBUG") == "hair":  # debug: the density as the albedo (body islands black)
        a = col[skin, 3:4]
        col[skin, :3] = np.where(a < 0.375, 1.0 - a * 4.0, (1.0 - a) * 2.0) * 0.8 + 0.02
        col[skin, 3] = BODY_CODE
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    attr.data.foreach_set("color", col.ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.active_color_index


def cap(mb, body, cx, cy, eye_z, brow_z):
    """A fitted six-panel cap, a curved bill and a white embroidered rosette on the front panel.

    The crown is the skull pushed out (rays cast inward at the head, as the beanie), raised a
    little at the front (a structured front) and at the crown; the band sits at the brow in
    front and over the ear tops. Panel seams are shallow grooves, the button sits on top.
    """
    tree = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
    band_front = brow_z + 0.004
    centre = Vector((cx, cy, band_front))
    rings, seg = 22, 96
    verts, faces = [], []
    grid = []
    for i in range(rings + 1):
        lat = (math.pi / 2) * i / rings
        row = []
        for j in range(seg):
            az = 2 * math.pi * j / seg                  # 0 at +x, -pi/2 at the front (-y)
            d = Vector((math.cos(lat) * math.cos(az), math.cos(lat) * math.sin(az), math.sin(lat))).normalized()
            back = max(0.0, math.sin(az))              # 1 at the back
            # the band drops over the ears and to the nape less than a beanie's
            drop = 0.045 * back ** 1.2 * (1.0 - i / rings) ** 2
            start = centre + d * 0.4 - Vector((0, 0, drop))
            h = tree.ray_cast(start, -d, 0.5)
            surface = h[0] if h[0] is not None else centre + d * 0.1
            front = max(0.0, -math.sin(az))
            # a structured front panel stands off the forehead; the crown sits a finger's width above the skull
            off = 0.006 + 0.012 * math.sin(lat) ** 2 + 0.01 * front ** 2 * math.sin(2 * lat) ** 1.5
            # the six seams: shallow grooves at +-30, +-90, +-150 degrees from the front
            rel = (az + math.pi / 2) % (math.pi / 3) - math.pi / 6
            groove = 0.0012 * math.exp(-(rel / 0.03) ** 2) * math.sin(lat) ** 0.3
            row.append(len(verts))
            verts.append(surface + d * (off - groove))
        grid.append(row)
    for i in range(rings):
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((grid[i][j], grid[i][j2], grid[i + 1][j2], grid[i + 1][j]))
    top = len(verts)
    ring_top = [verts[k] for k in grid[rings]]
    apex = sum(ring_top, Vector()) / seg
    verts.append(apex)
    for j in range(seg):
        faces.append((grid[rings][j], grid[rings][(j + 1) % seg], top))
    mb.add(verts, faces, "cap_black")
    # the button
    mb.add(*_dome(apex + Vector((0, 0, 0.001)), 0.009, 0.004), "cap_black")
    brim = [verts[k] for k in grid[0]]
    # a sweatband edge: the crown's lower rim turned in, so it has thickness from below
    inner = [p + (Vector((cx, cy, p.z)) - p).normalized() * 0.004 for p in brim]
    base = len(mb.verts)
    mb.verts.extend(brim + inner)
    for j in range(seg):
        j2 = (j + 1) % seg
        mb.faces.append([base + j2, base + j, base + seg + j, base + seg + j2])
        mb.fmats.append("cap_black")
    _bill(mb, brim, seg, cx, cy)
    _emblem(mb, verts, grid, rings, seg, cx, cy)


def _dome(c, r, h, seg=16, rings=4):
    verts, faces = [], []
    for i in range(rings + 1):
        t = (math.pi / 2) * i / rings
        for j in range(seg):
            a = 2 * math.pi * j / seg
            verts.append(c + Vector((r * math.cos(t) * math.cos(a), r * math.cos(t) * math.sin(a), h * math.sin(t))))
    for i in range(rings):
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((i * seg + j, i * seg + j2, (i + 1) * seg + j2, (i + 1) * seg + j))
    return verts, faces


def _bill(mb, brim, seg, cx, cy):
    """The bill: a D-shaped plate from the front of the band, 7.4 cm deep, pitched down, bent down at its sides, 4 mm thick."""
    # the front arc of the band, -65..+65 degrees about the front
    arc = []
    for j in range(seg):
        az = 2 * math.pi * j / seg
        rel = math.atan2(math.sin(az + math.pi / 2), math.cos(az + math.pi / 2))
        if abs(rel) <= math.radians(66):
            arc.append((rel, brim[j]))
    arc.sort(key=lambda t: t[0])
    span = math.radians(66)
    steps = 10
    top, bot = [], []
    for rel, p in arc:
        # a D-shaped bill: every point runs FORWARD (a little splayed), so the sides close onto the band
        radial = Vector((p.x - cx, p.y - cy, 0)).normalized()
        out = (Vector((0, -1, 0)) + radial * 0.25).normalized()
        u = rel / span                                  # -1..1 across the bill
        length = 0.074 * math.sqrt(max(0.0, 1.0 - u * u)) + 0.003
        rowt, rowb = [], []
        for k in range(steps + 1):
            s = k / steps
            # out and a little down (pitch), and the sides bent down (the pre-curve)
            q = p + out * (length * s) + Vector((0, 0, -0.012 * s - 0.022 * (u * u) * s ** 1.3))
            n = Vector((0, 0, 1))
            rowt.append(q + n * 0.002)
            rowb.append(q - n * 0.002)
        top.append(rowt)
        bot.append(rowb)
    base_t = len(mb.verts)
    for row in top:
        mb.verts.extend(row)
    base_b = len(mb.verts)
    for row in bot:
        mb.verts.extend(row)
    n_rows, n_cols = len(top), steps + 1
    for r in range(n_rows - 1):
        for k in range(steps):
            a, b = r * n_cols + k, (r + 1) * n_cols + k
            mb.faces.append([base_t + a, base_t + b, base_t + b + 1, base_t + a + 1]); mb.fmats.append("cap_black")
            mb.faces.append([base_b + a, base_b + a + 1, base_b + b + 1, base_b + b]); mb.fmats.append("cap_black")
    # the rounded edge: tip and both side ends closed
    for r in range(n_rows - 1):
        a, b = r * n_cols + steps, (r + 1) * n_cols + steps
        mb.faces.append([base_t + a, base_t + b, base_b + b, base_b + a]); mb.fmats.append("cap_black")
    for r in (0, n_rows - 1):
        for k in range(steps):
            a = r * n_cols + k
            f = [base_t + a, base_t + a + 1, base_b + a + 1, base_b + a]
            mb.faces.append(f if r == 0 else list(reversed(f))); mb.fmats.append("cap_black")


def _rosette():
    """A generic eight-petal rosette (not any maker's mark), as strips of quads in (u, v) in -1..1, v up.

    Four long petals on the axes and four short ones between, each split by a groove down its
    length and flared at the tip; a ring round an oval eye in the middle. Strips, not n-gons, so
    the raised embroidery follows the crown's curve instead of cutting into it."""
    strips = []
    for k in range(8):
        theta = k * math.pi / 4 + math.pi / 2
        reach, width = (1.0, 0.2) if k % 2 == 0 else (0.66, 0.14)
        axis = Vector((math.cos(theta), math.sin(theta)))
        across = Vector((-axis.y, axis.x))
        for side in (1, -1):
            inner, outer = [], []
            for i in range(15):
                t = 0.23 + 0.77 * i / 14
                along = t * reach
                lateral = width * math.sin(math.pi * min(t, 0.97)) ** 0.75 + 0.05 * max(0.0, (t - 0.78) / 0.22) ** 2
                inner.append(axis * along + across * (side * 0.022))
                outer.append(axis * along + across * (side * (0.022 + lateral * (1.0 - 0.8 * max(0.0, t - 0.93) / 0.07))))
            strips.append((inner, outer))
    ring_in, ring_out = [], []
    for i in range(33):
        a = 2 * math.pi * i / 32
        ring_in.append(Vector((0.1 * math.cos(a), 0.065 * math.sin(a))))
        ring_out.append(Vector((0.22 * math.cos(a), 0.22 * math.sin(a))))
    strips.append((ring_in, ring_out))
    return strips


def _emblem(mb, verts, grid, rings, seg, cx, cy):
    """The rosette, embroidered on the front panel: raised 1.5 mm, every point laid onto the crown."""
    size = 0.031   # half-width, metres
    # the panel's centre: the crown point straight ahead, a third of the way up
    j0 = int(round((-math.pi / 2) % (2 * math.pi) / (2 * math.pi) * seg)) % seg
    i0 = int(rings * 0.34)
    c = verts[grid[i0][j0]]
    up = (verts[grid[i0 + 1][j0]] - verts[grid[i0 - 1][j0]]).normalized()
    side = (verts[grid[i0][(j0 + 1) % seg]] - verts[grid[i0][j0 - 1]]).normalized()
    normal = side.cross(up).normalized()
    if normal.y > 0:
        normal = -normal
    up = normal.cross(side).normalized()
    tree = BVHTree.FromPolygons([tuple(v) for v in verts], _crown_faces(grid, rings, seg))

    def lay(uv):
        q = c + side * (uv.x * size) + up * (uv.y * size)
        h = tree.ray_cast(q + normal * 0.05, -normal, 0.1)
        return (h[0] if h[0] is not None else q) + (h[1] if h[1] is not None else normal) * 0.0015

    for inner, outer in _rosette():
        base = len(mb.verts)
        mb.verts.extend(lay(p) for p in inner)
        mb.verts.extend(lay(p) for p in outer)
        n = len(inner)
        for i in range(n - 1):
            f = [base + i, base + i + 1, base + n + i + 1, base + n + i]
            # wind every quad to face out of the crown
            a_, b_, d_ = mb.verts[f[0]], mb.verts[f[1]], mb.verts[f[3]]
            if (b_ - a_).cross(d_ - a_).dot(normal) < 0:
                f.reverse()
            mb.faces.append(f)
            mb.fmats.append("cap_emblem")


def _crown_faces(grid, rings, seg):
    return [(grid[i][j], grid[i][(j + 1) % seg], grid[i + 1][(j + 1) % seg], grid[i + 1][j]) for i in range(rings) for j in range(seg)]
