"""YEAT STRONG FEST stage previz: the video walls as one GLB for Loom.

    B=/Applications/Blender.app/Contents/MacOS/Blender
    $B --background --factory-startup --python tools/blender/yeat-strong-fest/build.py -- \
       --out public/media/yeat-strong-fest/stage.glb [--blend renders/yeat-strong-fest/stage.blend]

Same conventions as `tools/blender/stage-previz/`: metres, Blender Z up, audience at -Y, +X is
STAGE LEFT (the audience's right). glTF / Loom space is (x, z, -y), so Loom's +Z points at the
audience.

What it builds (names are what Loom's Mesh File In `select` matches):

- `led.main`: the upstage MAIN WALL, 15 x 18 tiles (2520 x 1512 px in the pixel map).
- `led.imag_SR`, `led.imag_SL`: the two IMAG screens, 4 x 12 tiles each (672 x 1008 px). Both
  show the ONE IMAG region of the pixel map, so they carry identical uvs.
- `set.frames`: a black box behind each screen, so a screen reads as solid from the side.
- `stage.deck`, `stage.floor`: the stage deck and the house floor, for context only.

Each screen's uvs ARE its place in the 3840 x 2160 pixel map, so the whole map is one texture and
every screen samples its own region of it: in glTF uv space (0,0 at the map's top left, v down),
u = x / 3840 and v = y / 2160 at the region's corners. `led.main` spans 0..2520/3840 by
0..1512/2160; both `led.imag_*` span 2524..3196/3840 by 0..1008/2160. No crop lives in the
network; it maps the feed straight onto the walls.
"""
import argparse
import os
import sys

import bpy

# ---- the pixel map (3840 x 2160 canvas) ------------------------------------------------------
CANVAS_PX = (3840, 2160)
TILE_PX = (168, 84)
MAIN_TILES = (15, 18)    # columns, rows: 2520 x 1512 at TL 0,0
MAIN_AT = (0, 0)
IMAG_TILES = (4, 12)     # 672 x 1008 at TL 2524,0
IMAG_AT = (2524, 0)

# ---- physical size: ASSUMED -------------------------------------------------------------------
# The pixel map gives pixels, not metres. A 168 x 84 px tile read as a 1000 x 500 mm cabinet
# (5.95 mm pitch) puts the main wall at 15 x 9 m and each IMAG at 4 x 6 m, which matches the
# Depence render's proportions (IMAG width ~0.27 of the main wall's, height ~0.67, tops level).
# Change TILE_M when the LED spec arrives and rebuild.
TILE_M = (1.0, 0.5)

DECK = (20.0, 12.0, 1.8)          # width, depth, height of the stage deck (estimate)
DECK_FRONT_Y = -6.0               # downstage edge
MAIN_BOTTOM = DECK[2] + 0.3       # main wall's bottom edge, just above the deck
MAIN_Y = DECK_FRONT_Y + DECK[1] - 0.4   # the main wall's face, at the deck's upstage edge
IMAG_CENTRE_X = 16.5              # each IMAG's centre off centre line (read off the render)
IMAG_Y = MAIN_Y - 3.0             # the IMAGs a little downstage of the main wall (estimate)
FRAME_DEPTH = 0.15                # the black backing behind each screen
FLOOR = (70.0, 50.0)


def size(tiles):
    return tiles[0] * TILE_M[0], tiles[1] * TILE_M[1]


def material(name, rgba):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = 0.6
    return m


def mesh_object(name, verts, faces, mat, uvs=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    if uvs is not None:
        layer = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            for loop, vi in zip(poly.loop_indices, poly.vertices):
                layer.data[loop].uv = uvs[vi]
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def box(x0, x1, y0, y1, z0, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def merge(parts):
    verts, faces = [], []
    for v, f in parts:
        base = len(verts)
        verts += v
        faces += [tuple(i + base for i in face) for face in f]
    return verts, faces


def map_uvs(at, tiles):
    """The region's corners in the pixel map, as Blender uvs: bottom left, bottom right, top right, top left."""
    u0, u1 = at[0] / CANVAS_PX[0], (at[0] + tiles[0] * TILE_PX[0]) / CANVAS_PX[0]
    top, bottom = at[1] / CANVAS_PX[1], (at[1] + tiles[1] * TILE_PX[1]) / CANVAS_PX[1]
    # Blender's uv v runs up and the glTF exporter writes 1 - v, so a pixel row y (from the top)
    # is Blender v = 1 - y / height, and glTF v = y / height.
    return [(u0, 1 - bottom), (u1, 1 - bottom), (u1, 1 - top), (u0, 1 - top)]


def screen(name, cx, y, bottom, w, h, mat, uvs):
    """A quad facing the audience (-Y), its uvs its region of the pixel map."""
    x0, x1, z0, z1 = cx - w / 2, cx + w / 2, bottom, bottom + h
    verts = [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)]
    mesh_object(name, verts, [(0, 1, 2, 3)], mat, uvs)
    return box(x0 - 0.05, x1 + 0.05, y + 0.01, y + 0.01 + FRAME_DEPTH, z0 - 0.05, z1 + 0.05)


def build():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    white = material("led", (1, 1, 1, 1))
    black = material("frame", (0.02, 0.02, 0.02, 1))
    grey = material("deck", (0.25, 0.25, 0.25, 1))

    mw, mh = size(MAIN_TILES)
    iw, ih = size(IMAG_TILES)
    imag_bottom = MAIN_BOTTOM + mh - ih   # tops level with the main wall's
    frames = [
        screen("led.main", 0.0, MAIN_Y, MAIN_BOTTOM, mw, mh, white, map_uvs(MAIN_AT, MAIN_TILES)),
        screen("led.imag_SR", -IMAG_CENTRE_X, IMAG_Y, imag_bottom, iw, ih, white, map_uvs(IMAG_AT, IMAG_TILES)),
        screen("led.imag_SL", IMAG_CENTRE_X, IMAG_Y, imag_bottom, iw, ih, white, map_uvs(IMAG_AT, IMAG_TILES)),
    ]
    # Legs under the flown IMAGs and the main wall's frame down to the deck, so nothing floats.
    for cx, y, bottom, top_floor in ((-IMAG_CENTRE_X, IMAG_Y, imag_bottom, 0.0),
                                     (IMAG_CENTRE_X, IMAG_Y, imag_bottom, 0.0)):
        for dx in (-iw / 2 + 0.2, iw / 2 - 0.2):
            frames.append(box(cx + dx - 0.15, cx + dx + 0.15, y + 0.05, y + 0.35, top_floor, bottom))
    frames.append(box(-mw / 2 - 0.05, mw / 2 + 0.05, MAIN_Y + 0.01, MAIN_Y + 0.3, DECK[2], MAIN_BOTTOM))
    v, f = merge(frames)
    mesh_object("set.frames", v, f, black)

    v, f = box(-DECK[0] / 2, DECK[0] / 2, DECK_FRONT_Y, DECK_FRONT_Y + DECK[1], 0.0, DECK[2])
    mesh_object("stage.deck", v, f, grey)
    v = [(-FLOOR[0] / 2, -FLOOR[1] / 2 - 10, 0), (FLOOR[0] / 2, -FLOOR[1] / 2 - 10, 0),
         (FLOOR[0] / 2, FLOOR[1] / 2 - 10, 0), (-FLOOR[0] / 2, FLOOR[1] / 2 - 10, 0)]
    mesh_object("stage.floor", v, [(0, 1, 2, 3)], grey)

    print(f"[layout] main wall {mw:.2f} x {mh:.2f} m, bottom {MAIN_BOTTOM:.2f} m, face y {MAIN_Y:.2f}")
    print(f"[layout] IMAG {iw:.2f} x {ih:.2f} m at x ±{IMAG_CENTRE_X}, bottom {imag_bottom:.2f} m, face y {IMAG_Y:.2f}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--blend")
    args = ap.parse_args(argv)
    build()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    if args.blend:
        os.makedirs(os.path.dirname(os.path.abspath(args.blend)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend))
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(args.out), export_format="GLB",
        export_apply=True, export_yup=True, export_extras=True,
        export_cameras=False, export_lights=False,
        export_normals=True, export_texcoords=True, export_tangents=False,
        export_animations=False, export_skins=False, export_morph=False,
        export_materials="EXPORT", export_image_format="NONE",
        use_selection=False, use_visible=False,
    )
    print(f"[export] {args.out}  {os.path.getsize(args.out)} bytes")


main()
