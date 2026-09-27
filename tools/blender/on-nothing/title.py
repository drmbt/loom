"""The chrome title for the On Nothing scene (T1400b; laid out from the reference, T1407b title).

The reference's script is a flourished copperplate whose capitals stand three times the
lowercase's x-height. Measured in its frame 20 against the grille (1032 x 359 px), as shares of
the grille: the line spans 0.90 of its width from 0.024 in, the capitals rise from 0.632 of its
height (the baseline, from the top) to 0.033 below its top, the x-height is 0.33 of the cap
height, and the artist's name sits on 0.883 of the height, 0.064 of it tall, 0.02 of the width
left of centre. The title sets itself by those shares inside the car's MEASURED opening
(title_opening.opening), so it fits whatever grille it stands in.

No system script has capitals that tall, so the line is set in pieces — "O", "n", "N",
"othing" — the capitals scaled up against the lowercase, each piece placed after the one before
with the overlap the reference shows. Under it, the artist's name in wide-spaced chrome
capitals. Both are extruded and bevelled into round chrome and stand in front of the car's own\ngrille; the car itself is not touched.
"""
import os

import bpy

import title_opening

SCRIPT_FONTS = [
    "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc",
    "/System/Library/Fonts/Supplemental/Apple Chancery.ttf",
]
CAPS_FONTS = [
    "/System/Library/Fonts/Supplemental/Copperplate.ttc",
    "/System/Library/Fonts/Supplemental/Didot.ttc",
]

# Shares of the grille opening, measured from the reference (see the module docstring).
LINE_IN, LINE_SPAN = 0.1, 0.78
BASELINE_DOWN, CAP_SHARE, X_SHARE = 0.66, 0.55, 0.33
SUB = "YEAT"
SUB_DOWN, SUB_SHARE, SUB_LEFT = 0.883, 0.064, 0.02
FRONT_Y = -0.03        # the strokes' centre plane, this far in front of the grille's most forward point


def _font(paths):
    for path in paths:
        if os.path.exists(path):
            try:
                font = bpy.data.fonts.load(path)
                print(f"[title] font {path}", flush=True)
                return font
            except RuntimeError:
                continue
    return None


def _text(coll, name, body, font, size, extrude, bevel, spacing=1.0):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    if font is not None:
        cu.font = font
    cu.align_x = "LEFT"
    cu.size = size
    cu.space_character = spacing
    cu.extrude = extrude
    cu.bevel_depth = bevel
    # fine curves: the script is shot from a metre, so every facet reads as a jaggy on its chrome
    cu.bevel_resolution = 8
    cu.resolution_u = 28
    ob = bpy.data.objects.new(name, cu)
    coll.objects.link(ob)
    return ob


def _bounds(ob):
    """(x0, x1, y0, y1) of a text mesh still lying flat (its glyphs' up is +Y)."""
    bpy.context.view_layer.update()
    co = [ob.matrix_world @ v.co for v in ob.data.vertices]
    return min(c.x for c in co), max(c.x for c in co), min(c.y for c in co), max(c.y for c in co)


def _mesh(ob):
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.view_layer.objects.active


def _measure(coll, font, glyphs):
    """Height of `glyphs` above the baseline at size 1 (the caps, or the x-height)."""
    probe = _mesh(_text(coll, "title.probe", glyphs, font, 1.0, 0.0, 0.0))
    _x0, _x1, _y0, y1 = _bounds(probe)
    bpy.data.objects.remove(probe, do_unlink=True)
    return y1


def build(ctx, text, **_ignored):
    coll, mats = ctx["coll"], ctx["mats"]
    car = bpy.data.objects.get("car0.body")
    if car is None:
        raise RuntimeError("title: no car0.body to set the title in front of")
    # The layout's frame: the car's own grille opening, measured (the car is not touched).
    lip = title_opening.opening(car)
    top_z = title_opening.span_at(lip, 0.0)[1]
    bottom_z = title_opening.span_at(lip, 0.0)[0]
    height = top_z - bottom_z
    left_x = min(p[0] for p in lip)
    width = max(p[0] for p in lip) - left_x
    cap_height = CAP_SHARE * height
    x_height = X_SHARE * cap_height
    line_left = left_x + LINE_IN * width
    line_width = LINE_SPAN * width
    baseline = top_z - BASELINE_DOWN * height
    sub_height = SUB_SHARE * height
    sub_baseline = top_z - SUB_DOWN * height
    sub_centre_x = -SUB_LEFT * width
    # The script stands just clear of the grille's most forward point behind it.
    front_y = title_opening.front_y(car, line_left, line_left + line_width, bottom_z, top_z) + FRONT_Y
    script = _font(SCRIPT_FONTS)
    # Lay the script flat (x across, z = the text's y), then stand it up at the end.
    cap_size = cap_height / max(_measure(coll, script, "ON"), 1e-6)
    low_size = x_height / max(_measure(coll, script, "nocm"), 1e-6)
    words = text.split(" ", 1) if " " in text else [text, ""]
    pieces = [(words[0][:1], cap_size), (words[0][1:], low_size), (words[1][:1], cap_size), (words[1][1:], low_size)]
    # How far each piece tucks under the one before, as a share of the previous piece's width
    # (the reference's n sits inside the O's tail; the N's right stroke runs into the o).
    tuck = [0.0, 0.34, 0.06, 0.3]
    parts = []
    cursor = 0.0
    for k, (body, size) in enumerate(pieces):
        if body == "":
            continue
        ob = _text(coll, f"title.piece{k}", body, script, size, 0.0055 * size / cap_size + 0.002, 0.0095)
        ob = _mesh(ob)
        x0, x1, _z0, _z1 = _bounds(ob)
        if parts:
            px0, px1 = parts[-1][1]
            cursor = px1 - tuck[k] * (px1 - px0)
        ob.location.x += cursor - x0
        bpy.context.view_layer.update()
        parts.append((ob, (cursor, cursor + (x1 - x0))))
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for ob, _span in parts:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = parts[0][0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = "title.script"
    x0, x1, _z0, _z1 = _bounds(ob)
    s = line_width / max(x1 - x0, 1e-6)
    line_scale = s
    # The measured widths are what the reference shows; scale the whole line to them, and
    # stand it up facing -Y with its baseline on BASELINE.
    ob.scale = (s, s, s)
    ob.location = (line_left - x0 * s, front_y, baseline)
    ob.rotation_euler = (1.5707963, 0, 0)
    bpy.context.view_layer.update()
    ob = _mesh(ob)
    ob.data.materials.clear()
    ob.data.materials.append(mats["chrome"])
    ob.data.shade_smooth()
    ob["loom_area"] = "title"

    caps = _font(CAPS_FONTS)
    sub = _text(coll, "title.sub", SUB, caps, 1.0, 0.14, 0.05, spacing=1.8)
    sub = _mesh(sub)
    x0, x1, _y0, y1 = _bounds(sub)
    s = sub_height / max(y1, 1e-6)
    sub.scale = (s, s, s)
    sub.location = (sub_centre_x - (x0 + x1) / 2 * s, front_y + 0.01, sub_baseline)
    sub.rotation_euler = (1.5707963, 0, 0)
    sub = _mesh(sub)
    sub.data.materials.clear()
    sub.data.materials.append(mats["chrome"])
    sub.data.shade_smooth()
    sub["loom_area"] = "title"
    print(f"[title] script {line_width:.2f} m wide, caps {cap_size:.3f} / lowercase {low_size:.3f} (size), line scale {line_scale:.3f}", flush=True)
    return ob
