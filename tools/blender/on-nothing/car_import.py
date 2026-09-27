"""Import a detailed third-party car model for the On Nothing scene (T1407b).

The procedural cars (cars.py) read as boxes in a close-up. This brings in a real model instead:

1. import (glb/gltf/fbx/obj/blend), apply every transform and modifier, drop cameras/lights;
2. normalise: ground at z = 0, centred on x, the FRONT at y = 0 facing -Y, scaled to a length;
3. map each material onto one of ours by its name (paint, chrome, glass, tyre, light lens,
   emitter, black trim, interior), with a report of what went where;
4. bake the model's base-colour textures into a COLOR_0 attribute (loom decodes factors and
   COLOR_0 only until GLB textures land, T1358b), so badges, tyre lettering and lamp internals
   keep their pattern;
5. find the headlight emitters (front, high, lamp-class faces) left and right for the markers.

Each import becomes `car.<n>_body` (one joined object, positioned and yawed like a procedural
car), so the rest of the pipeline cannot tell the difference.
"""
import math
import os
import re

import bpy
from mathutils import Matrix, Vector

# name pattern -> our material; first match wins (lower-cased material AND object names)
CLASSES = [
    (r"head.?light.*(glass|lens|cover)|lamp.*(glass|lens|cover)|light.?glass|lens", "glass_car"),
    (r"(head.?light|drl|day.?time|led|light.?bulb|emissi|glow|bulb|beam|projector)", "headlight"),
    (r"(tail.?light|rear.?light|brake|stop.?light|red.?light)", "taillight"),
    (r"(indicator|turn.?signal|blinker|amber|orange)", "drl"),
    (r"(chrome|metal.?shiny|polish|silver.?trim|mirror.?chrome|exhaust|grill.?chrome)", "chrome"),
    (r"(glass|window|windshield|windscreen)", "glass_car"),
    (r"(tyre|tire|rubber|sidewall)", "tyre"),
    (r"(rim|wheel|alloy|spoke)", "chrome"),
    (r"(caliper|brake.?disc|disc|rotor)", "headlight_body"),
    (r"(interior|seat|leather|dash|steering|carpet|fabric)", "plastic_black"),
    (r"(grill|grille|mesh|plastic|black|trim|matte.?black|bumper.?black)", "plastic_black"),
    (r"(paint|body|carpaint|car.?paint|exterior|shell)", None),  # the car's paint (per variant)
]


def classify(name, paint):
    n = name.lower()
    for pattern, ours in CLASSES:
        if re.search(pattern, n):
            return ours if ours is not None else paint
    return None


def import_any(path):
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = list(src.objects)
        for o in dst.objects:
            if o is not None:
                bpy.context.scene.collection.objects.link(o)
    else:
        raise RuntimeError(f"car_import: unsupported format {ext}")
    return [o for o in bpy.data.objects if o not in before]


def bake_texture_colour(ob):
    """COLOR_0 from the base-colour texture of each material (sampled at the vertices' UVs)."""
    me = ob.data
    if not me.uv_layers:
        return False
    images = []
    for mat in me.materials:
        img = None
        if mat is not None and mat.use_nodes:
            bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf is not None and bsdf.inputs["Base Color"].is_linked:
                src = bsdf.inputs["Base Color"].links[0].from_node
                # follow one mix / multiply hop if needed
                for _ in range(3):
                    if src.type == "TEX_IMAGE":
                        break
                    linked = [i for i in src.inputs if i.is_linked]
                    if not linked:
                        break
                    src = linked[0].links[0].from_node
                if src.type == "TEX_IMAGE" and src.image is not None:
                    img = src.image
        images.append(img)
    if not any(images):
        return False
    pixels = {}
    for img in images:
        if img is not None and img.name not in pixels:
            w, h = img.size
            if w == 0 or h == 0:
                continue
            pixels[img.name] = (w, h, list(img.pixels[:]))
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    uv = me.uv_layers.active.data
    for poly in me.polygons:
        img = images[poly.material_index] if poly.material_index < len(images) else None
        for li in poly.loop_indices:
            if img is None or img.name not in pixels:
                attr.data[li].color = (1, 1, 1, 1)
                continue
            w, h, px = pixels[img.name]
            u, v = uv[li].uv
            x = int((u % 1.0) * (w - 1))
            y = int((v % 1.0) * (h - 1))
            o = (y * w + x) * 4
            attr.data[li].color = (px[o], px[o + 1], px[o + 2], 1.0)
    me.color_attributes.active_color = attr
    return True


def _base(name):
    return name.split(".")[0] if name else ""


def import_car(ctx, path, n, loc, yaw, paint, length=5.2, front_axis="-Y", report=None, model=None):
    """Bring in one car; returns (body object, [left headlight point, right headlight point]) car-local."""
    coll, mats = ctx["coll"], ctx["mats"]
    model = model or {}
    objs = import_any(path)
    for o in list(objs):
        if o.type in ("CAMERA", "LIGHT", "ARMATURE") or any(_base(o.name) == d for d in model.get("drop_objects", [])):
            bpy.data.objects.remove(o, do_unlink=True)
            objs.remove(o)
    meshes = [o for o in objs if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"car_import: {path} has no meshes")
    bpy.context.view_layer.update()
    for o in meshes:
        for x in bpy.context.selected_objects:
            x.select_set(False)
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        if o.data.shape_keys is not None:
            bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        for mod in list(o.modifiers):
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except RuntimeError:
                o.modifiers.remove(mod)
        world = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = world
        if o.data.users > 1:
            o.data = o.data.copy()
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bake_texture_colour(o)
    for o in [o for o in objs if o.type == "EMPTY"]:
        bpy.data.objects.remove(o, do_unlink=True)
    # join
    for x in bpy.context.selected_objects:
        x.select_set(False)
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    car = meshes[0]
    car.name = f"car{n}.body"
    me = car.data
    # the join UNIONS every part's UV layer (231 on the GLS, each exported as its own TEXCOORD:
    # 640 MB). Texture colour is already baked into COLOR_0, so no UV layer is needed at all.
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    # drop interiors and anything the model config names, before measuring
    drop = model.get("drop", [])
    if drop:
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(me)
        doomed = [f for f in bm.faces if f.material_index < len(me.materials) and me.materials[f.material_index] is not None
                  and any(_base(me.materials[f.material_index].name).startswith(d) for d in drop)]
        bmesh.ops.delete(bm, geom=doomed, context="FACES")
        bm.to_mesh(me)
        bm.free()
    # orientation: turn so the front faces -Y
    turn = {"-Y": 0.0, "+Y": math.pi, "+X": -math.pi / 2, "-X": math.pi / 2}[front_axis]
    me.transform(Matrix.Rotation(turn, 4, "Z"))
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    # the long axis is the car's length: if it lies along X the file faces +-X; turn it to Y
    if max(xs) - min(xs) > max(ys) - min(ys):
        me.transform(Matrix.Rotation(math.pi / 2, 4, "Z"))
        xs, ys = [v.co.x for v in me.vertices], [v.co.y for v in me.vertices]
    s = length / max(max(ys) - min(ys), 1e-6)
    me.transform(Matrix.Scale(s, 4))
    me.transform(Matrix.Translation((-(min(xs) + max(xs)) / 2 * s, -min(ys) * s, -min(zs) * s)))
    me.update()
    if os.environ.get("ON_NOTHING_LAMP_DEBUG"):
        import collections
        for end, test in (("front(y small)", lambda c: c.y < 0.35), ("rear(y large)", lambda c: c.y > length - 0.35)):
            cnt = collections.Counter()
            for poly in me.polygons:
                c = poly.center
                if test(c) and 0.55 < c.z < 1.05 and abs(c.x) > 0.35:
                    mat = me.materials[poly.material_index]
                    cnt[_base(mat.name) if mat else "-"] += 1
            print(f"[lampdebug] {os.path.basename(path)} {end}: {cnt.most_common(14)}", flush=True)
    # materials: the model's map, then the regex classes, then black trim
    explicit = model.get("materials", {})
    moved = {}
    for i, mat in enumerate(me.materials):
        name = _base(mat.name) if mat is not None else ""
        ours = explicit.get(name)
        if ours is None:
            ours = classify(name, "PAINT") or "plastic_black"
        if ours == "PAINT":
            ours = paint
        moved.setdefault(ours, []).append(name)
        me.materials[i] = mats[ours]
    if report is not None:
        report.append((os.path.basename(path), {k: len(v) for k, v in moved.items()}))
    # collapse the slots: FBX from Unity carries thousands, now pointing at a handful of ours,
    # and the exporter writes a primitive (with its own vertex arrays) per slot — 640 MB
    unique = []
    for m in me.materials:
        if m not in unique:
            unique.append(m)
    remap = [unique.index(m) for m in me.materials]
    indices = [0] * len(me.polygons)
    me.polygons.foreach_get("material_index", indices)
    indices = [remap[i] if i < len(remap) else 0 for i in indices]
    me.materials.clear()
    for m in unique:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", indices)
    me.update()
    # LAMP PODS by position, for files whose lamp internals carry no light-ish material name:
    # faces of the named materials inside the pod box become emissive headlight elements.
    pods = model.get("lamp_pods")
    if pods is not None:
        if "headlight" not in [m.name for m in me.materials if m is not None]:
            me.materials.append(mats["headlight"])
        lamp_slot = [m.name if m is not None else "" for m in me.materials].index("headlight")
        source = {i for i, m in enumerate(me.materials) if m is not None and m.name in pods["from"]}
        count = 0
        for poly in me.polygons:
            c = poly.center
            if poly.material_index in source and c.y < pods["depth"] and pods["z"][0] < c.z < pods["z"][1] and abs(c.x) > pods["x_min"]:
                poly.material_index = lamp_slot
                count += 1
        if report is not None:
            report.append(("lamp pod faces", count))
    # which way is front? the lamps: headlight faces sit at the front; if they are at the far
    # end, the file faced +Y — turn it round.
    lamp_names = ("headlight", "drl")
    ys_lamp = [p.center.y for p in me.polygons if me.materials[p.material_index] is not None and me.materials[p.material_index].name in lamp_names]
    if not model.get("no_flip") and ys_lamp and sum(ys_lamp) / len(ys_lamp) > length / 2:
        me.transform(Matrix.Translation((0, -length, 0)) @ Matrix.Rotation(math.pi, 4, "Z"))
        me.transform(Matrix.Translation((0, 0, 0)))
        me.update()
        ys = [v.co.y for v in me.vertices]
        me.transform(Matrix.Translation((0, -min(ys), 0)))
        me.update()
    # Lamp COVERS: loom draws mesh glass opaque (T1357b), so a headlight's clear cover would
    # hide the lamp it covers. Glass low at the front (below the windscreen) is lamp cover: cut it.
    import bmesh
    glass = {i for i, m in enumerate(me.materials) if m is not None and m.name == "glass_car"}
    bm = bmesh.new()
    bm.from_mesh(me)
    covers = [f for f in bm.faces if f.material_index in glass and f.calc_center_median().y < 0.75 and f.calc_center_median().z < 1.12]
    bmesh.ops.delete(bm, geom=covers, context="FACES")
    bm.to_mesh(me)
    bm.free()
    if report is not None:
        report.append(("covers cut", len(covers)))
    if model.get("decimate", 1.0) < 1.0:
        mod = car.modifiers.new("decimate", "DECIMATE")
        mod.ratio = model["decimate"]
        bpy.ops.object.modifier_apply(modifier=mod.name)
    # headlight points: lamp-class faces in the front 15 % of the car, above the wheels
    lamp_index = {i for i, m in enumerate(me.materials) if m is not None and m.name in lamp_names}
    left, right = [], []
    for poly in me.polygons:
        if poly.material_index in lamp_index and poly.center.y < 0.15 * length and poly.center.z > 0.5:
            (left if poly.center.x > 0 else right).append(poly.center.copy())
    heads = []
    for group, sx in ((left, 1), (right, -1)):
        heads.append(sum(group, Vector()) / len(group) + Vector((0, -0.03, 0)) if group else Vector((sx * 0.7, -0.05, 0.9)))
    car.location = loc
    car.rotation_euler = (0, 0, yaw)
    car["loom_area"] = f"car{n}"
    me.shade_smooth()
    try:
        me.set_sharp_from_angle(angle=math.radians(35))
    except Exception:
        pass
    return car, heads
