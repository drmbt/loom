"""Close-ups, part two, and the end cards (T1407b closeups2).

Props for the rows that extend closeups.py's two shots (docs/on-nothing-shotlist-2026-09-27.md),
and the type for the end cards:

- `jewel.*` (the `pendant` shot's take 2, row 48): a second "Nothing" pendant lying on a black
  tee, its chain rising up the chest, the forearm hanging at the right and a far bright floor
  seen between them. It stands at JEWEL, away from every other set.
- `shoeh.*` (the `sneaker` shot's takes 1-3, rows 5-7): the same white low-top built with its
  loose lace ends HANGING (the shoe held up, sole down) instead of draped on the paint. It is built
  at HELD in the shoe's own axes; loom turns and moves it into the figure's hand, and the
  `prop.shoeh` marker carries its frame so the surface draws the panels in the shoe's own frame.
- `card.*` (the `cards` shot, rows 108-109): the end title "COCOON" and the credit block, flat
  type facing a 100 mm lens 5.333 m off, so ONE MILLIMETRE IS ONE PIXEL of the 1920 x 818 frame
  (a 36 mm sensor at 100 mm spans 0.36 x the distance: 1.92 m). Every glyph box is placed on the
  reference frame's measured pixels. The credit block copies the reference's layout (roles, line
  pitch, the small-caps face) with NEUTRAL PLACEHOLDER handles in place of real people's names.
"""
import math
import os

import bpy
from mathutils import Vector

import closeups
import util

# the pendant on the tee (row 48), beside the pendant set (closeups.PEND is x = 60, y = 0)
JEWEL = Vector((60.0, 12.0, 1.3))
# the held shoe's own origin (loom moves it into the hand)
HELD = Vector((60.0, -10.0, 0.0))
# the end cards' plates: the title, and 10 m above it the credits
CARD = Vector((120.0, 0.0, 0.0))
CREDITS = CARD + Vector((0.0, 0.0, 10.0))
CARD_LENS = 100.0
CARD_D = 1.92 / 0.36  # the distance at which a 100 mm lens spans 1.92 m: 1 mm = 1 px

ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf"
COPPERPLATE = "/System/Library/Fonts/Supplemental/Copperplate.ttc"

# name: (base rgb, metallic, roughness, class code); 60 is the cards' type (cards.ts draws it)
LIB2 = {
    "cu_cardtype": ((1.0, 1.0, 1.0), 0.0, 1.0, 60),
}

# COCOON, measured on the reference's first frame of row 108: each glyph's pixel box
# (x0, x1 inclusive), all on the band y 385-411 (27 px tall, 66-71 px wide: a grotesque
# stretched 2.5 times, which is why its verticals are thick and its horizontals thin)
COCOON = [("C", 369, 434), ("O", 585, 655), ("C", 806, 871), ("O", 1022, 1092), ("O", 1243, 1313), ("N", 1466, 1529)]
COCOON_Y = (385, 411)

# the credit block, row 109: ten lines, cap tops at these pixel rows, left edge x = 1099,
# capitals 18 px tall in a small-caps face. Roles as the reference's; the handles are placeholders.
CREDIT_LINES = [
    "Directed by: @director",
    "Produced by: @producer_one @producer_two",
    "DP: @cinematographer @camera_two",
    "Gaffer: @gaffer",
    "Edit: @editor_one @editor_two @director",
    "CRT: @crt_studio",
    "Title: @title_design",
    "Car Coordinator: @picture_cars",
    "BTS: @bts_archive",
    "Color: @colorist @camera_two",
]
CREDIT_TOPS = [140, 197, 254, 310, 367, 424, 481, 537, 594, 651]
CREDIT_LEFT = 1099
CREDIT_CAP = 18


def materials():
    mats = {}
    for name, (base, met, rough, code) in LIB2.items():
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


def _px(plate, x, y):
    """The plate's world point at the frame pixel (x, y) (continuous: pixel i spans i..i+1)."""
    return plate + Vector(((x - 960.0) / 1000.0, 0.0, (409.0 - y) / 1000.0))


def _text(coll, mat, body, font, name):
    """A flat text mesh facing -Y (the card camera), origin on the baseline at the left."""
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = body
    if not os.path.exists(font):
        raise RuntimeError(f"closeups2: no font at {font}")
    curve.font = bpy.data.fonts.load(font, check_existing=True)
    curve.align_x = "LEFT"
    curve.align_y = "BOTTOM_BASELINE"
    curve.size = 1.0
    curve.resolution_u = 6
    ob = bpy.data.objects.new(name, curve)
    coll.objects.link(ob)
    ob.rotation_euler = (math.pi / 2, 0, 0)
    closeups._select_only(ob)
    bpy.ops.object.convert(target="MESH")
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    ob.name = name
    return ob


def _fit(ob, x0, x1, z0, z1):
    """Scale and move a mesh so its bounding box spans x0..x1 and z0..z1 (world)."""
    xs = [v.co.x for v in ob.data.vertices]
    zs = [v.co.z for v in ob.data.vertices]
    sx = (x1 - x0) / (max(xs) - min(xs))
    sz = (z1 - z0) / (max(zs) - min(zs))
    ax, az = min(xs), min(zs)
    for v in ob.data.vertices:
        v.co.x = x0 + (v.co.x - ax) * sx
        v.co.z = z0 + (v.co.z - az) * sz
    ob.data.update()


def cards(ctx, mats):
    coll = ctx["coll"]
    mat = mats["cu_cardtype"]
    # COCOON: each glyph fitted to its measured box
    for k, (glyph, x0, x1) in enumerate(COCOON):
        ob = _text(coll, mat, glyph, ARIAL, f"card.cocoon{k}")
        a = _px(CARD, x0, COCOON_Y[1] + 1)
        b = _px(CARD, x1 + 1, COCOON_Y[0])
        _fit(ob, a.x, b.x, a.z, b.z)
        for v in ob.data.vertices:
            v.co.y = CARD.y
        ob["loom_area"] = "card"
    # the credit block: one probe capital sets the size (its height is the cap height)
    probe = _text(coll, mat, "D", COPPERPLATE, "card.probe")
    cap = max(v.co.z for v in probe.data.vertices) - min(v.co.z for v in probe.data.vertices)
    bpy.data.objects.remove(probe, do_unlink=True)
    scale = (CREDIT_CAP / 1000.0) / cap
    for k, (line, top) in enumerate(zip(CREDIT_LINES, CREDIT_TOPS)):
        ob = _text(coll, mat, line, COPPERPLATE, f"card.credit{k}")
        left = min(v.co.x for v in ob.data.vertices)
        base = _px(CREDITS, CREDIT_LEFT, top + CREDIT_CAP)
        for v in ob.data.vertices:
            v.co = Vector((base.x + (v.co.x - left) * scale, CREDITS.y, base.z + v.co.z * scale))
        ob.data.update()
        ob["loom_area"] = "card"
    util.camera(coll, "shot.cocoon", CARD + Vector((0.0, -CARD_D, 0.0)), CARD, CARD_LENS)
    util.camera(coll, "shot.credits", CREDITS + Vector((0.0, -CARD_D, 0.0)), CREDITS, CARD_LENS)
    print(f"[closeups2] cards: cap scale {scale:.4f}", flush=True)


def jewel_tee(ctx, mats):
    """Row 48: the pendant lying on the black tee, the chain rising up the chest."""
    coll = ctx["coll"]
    script = closeups._script(coll, mats, "Nothing", closeups.PENDANT_WIDTH, JEWEL)
    script.name = "jewel.script"
    top = max(v.co.z for v in script.data.vertices)
    tall = max(script.data.vertices, key=lambda v: v.co.z).co
    bail_at = Vector((tall.x, JEWEL.y + 0.001, top + 0.006))
    mb = util.MB("jewel.chain")
    mb.torus(bail_at, (1, 0, 0), 0.0055, 0.0016, 28, 10, "cu_metal")
    # the necklace's two strands up the chest, lying on the tee (a little behind the pendant's face)
    closeups._chain(mb, bail_at + Vector((-0.004, 0.003, 0.004)), (-0.36, 0.0, 1.0), 20, sag=0.004)
    closeups._chain(mb, bail_at + Vector((0.004, 0.003, 0.004)), (0.36, 0.0, 1.0), 20, sag=0.004)
    chain = mb.to_object(mats, coll, smooth_deg=None)
    # the chest under the tee: an elliptic column whose front sits just behind the pendant's back
    chest = util.MB("jewel.chest")
    rings, seg, rx, ry = 24, 72, 0.15, 0.1
    axis_at = JEWEL + Vector((-0.03, 0.007 + ry, 0.0))
    verts, faces = [], []
    for i in range(rings + 1):
        z = -0.45 + 0.9 * i / rings
        for j in range(seg):
            a = 2 * math.pi * j / seg
            verts.append(axis_at + Vector((rx * math.cos(a), ry * math.sin(a), z)))
    for i in range(rings):
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append((i * seg + j, i * seg + j2, (i + 1) * seg + j2, (i + 1) * seg + j))
    chest.add(verts, faces, "cu_knit")
    # the forearm hanging at the right, past the chest's edge (dark: out of the key)
    chest.cylinder(JEWEL + Vector((0.2, 0.08, -0.4)), JEWEL + Vector((0.17, 0.09, 0.35)), 0.04, 32, "cu_knit")
    cob = chest.to_object(mats, coll, smooth_deg=None)
    util.recalc_outside(cob)
    # the bright floor far behind, seen between the chest and the arm
    floor = util.MB("jewel.floor")
    floor.box(JEWEL + Vector((0.4, 2.2, -1.3)), (4.0, 3.0, 0.05), "cu_backdrop")
    fob = floor.to_object(mats, coll, smooth_deg=None)
    for o in (script, chain, cob, fob):
        o["loom_area"] = "jewel"
    # 85 mm, 45 cm off, a little right and above: the frame spans ~19 cm of the chest
    util.camera(coll, "shot.jewel", JEWEL + Vector((0.035, -0.43, 0.11)), JEWEL + Vector((0.004, 0.0, 0.006)), 85)
    util.link_empty(coll, "stage.jewel", JEWEL, (0, -1, 0), props={"loom_dir": util.gl(Vector((0, -1, 0)))})


def held_shoe(ctx, mats):
    """Rows 5-7: the low-top in its own axes at HELD, laces hanging; loom puts it in the hand."""
    from mathutils import Matrix
    place = Matrix.Translation(HELD)
    closeups.sneaker(ctx, mats, place, area="shoeh", held=True)
    util.link_empty(ctx["coll"], "prop.shoeh", HELD, None, props={
        "loom_x": util.gl(Vector((1, 0, 0))), "loom_y": util.gl(Vector((0, 1, 0))), "loom_z": util.gl(Vector((0, 0, 1)))})


def build(ctx, cars):
    del cars
    # closeups.build made the close-ups' materials; reuse them
    mats = {name: bpy.data.materials[name] for name in closeups.LIB}
    mats.update(materials())
    jewel_tee(ctx, mats)
    held_shoe(ctx, mats)
    cards(ctx, mats)
