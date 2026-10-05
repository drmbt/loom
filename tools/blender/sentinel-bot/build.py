"""T1561b — cut the reference sentinel FBX into the KIT loom's `meshFileIn` imports.

  Blender --background --factory-startup --python tools/blender/sentinel-bot/build.py -- \
      --fbx <Export-FBX_Sentinel_Final_EO_1.fbx> --out <sentinel.glb> [--preview <png dir>]
      [--mandible-ratio 0.35] [--body-ratio 1.0] [--samples 40]

The FBX is a rigged, baked performance: 10 armatures of 66 joints, 540 ring meshes that are
identical in bone space, claws, a body with four articulated front arms. Loom's sentinel is
PROCEDURAL (its tentacles grab a tunnel that does not exist until run time) and INSTANCED
(one ring drawn at every joint, §T1581b), so the kit holds each piece ONCE, in the frame of
the joint that carries it, plus the mechanism the bake shows: where every joint sits on its
parent, which axis it hinges about, and how far the performance ever turns it.

Frames are right-handed, in glTF axes, metres:
  robot   origin at the body centre, +Z forward (the eyes), +Y up, +X = up × forward.
  joint   origin at the joint, +Z along the bone toward the tip.

What is written:
  body, eyes, lamp           robot frame, no `loom_part`.
  mand_<k>_<level>           front arm k, link `level` (0 = shoulder), robot frame at the
                             reference pose, origin at its joint, `loom_parent` its carrier.
  ring                       one tentacle ring, joint frame.
  hub                        the claw's cone, joint frame.
  phalanx_<f>_<p>            claw finger f (0–3), link p (0 = knuckle), its own joint frame.
  socket.<t>                 marker: where tentacle t leaves the body.
  eye.<i>                    marker: an eye lens (centre; extras radius).
  kit.info                   marker: counts and lengths.
Every hinged node (mand_*, phalanx_*) carries extras: `loom_joint` (its origin in the
parent's frame), `loom_rest` (its rest orientation there, quaternion x y z w), `loom_axis`
(the hinge, parent frame), `loom_range` (radians, min and max the bake reaches) and
`loom_fit` (how far from a pure hinge the bake strays, radians and metres).

Materials are reduced to ROLES, written as `loom_heat` tenths (loom flattens it to `surface.z`):
0 shell, 0.2 chrome, 0.4 brass, 0.6 red paint, 0.8 ring core, 1.0 eye lens. The look is the
loom material's; the file only says which surface is which.
"""
import bpy, sys, os, json, math, struct, collections
from mathutils import Matrix, Vector, Quaternion

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def flag(name, default=None):
    return argv[argv.index(f"--{name}") + 1] if f"--{name}" in argv else default
FBX, OUT, PREVIEW = flag("fbx"), flag("out"), flag("preview")
MAND_RATIO, BODY_RATIO, SAMPLES = float(flag("mandible-ratio", 0.35)), float(flag("body-ratio", 1.0)), int(flag("samples", 40))
if FBX is None or OUT is None:
    raise SystemExit("usage: build.py -- --fbx <sentinel.fbx> --out <sentinel.glb> [--preview dir]")

ROLES = {  # role: (loom_heat, base rgb, metallic, roughness, emission strength)
    "shell": (0.0, (0.02, 0.02, 0.024), 0.0, 0.22, 0.0),
    "chrome": (0.2, (0.75, 0.76, 0.78), 1.0, 0.2, 0.0),
    "brass": (0.4, (0.55, 0.42, 0.2), 1.0, 0.32, 0.0),
    "redpaint": (0.6, (0.35, 0.02, 0.02), 0.6, 0.4, 0.0),
    "core": (0.8, (0.5, 0.02, 0.01), 0.0, 0.5, 2.0),
    "eye": (1.0, (1.0, 0.05, 0.02), 0.0, 0.1, 8.0),
}
def role_of(material_name):
    n = material_name.lower()
    if n.startswith("led_red"): return "core"
    if n.startswith("led_"): return "eye"
    if "aluminum" in n: return "chrome"
    if "brass" in n or "bronze" in n: return "brass"
    if "metallic_red" in n: return "redpaint"
    return "shell"

bpy.ops.wm.read_factory_settings(use_empty=True)
# The legacy importer fails on this file (KeyError: Armature.001 in link_hierarchy); the new one reads it.
bpy.ops.wm.fbx_import(filepath=FBX)
scene = bpy.context.scene
REFERENCE_FRAME = int(scene.frame_start) if scene.frame_start > 1 else 2
scene.frame_set(REFERENCE_FRAME)
bpy.context.view_layer.update()

role_materials = {}
for role, (heat, rgb, metallic, roughness, emission) in ROLES.items():
    m = bpy.data.materials.new(role)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
    bsdf.inputs["Emission Strength"].default_value = emission
    m["loom_heat"] = float(heat)
    role_materials[role] = m

objects = list(bpy.data.objects)
armatures = sorted((o for o in objects if o.type == "ARMATURE"), key=lambda o: o.name)
body = bpy.data.objects["Sentinel_1"]

# glTF axes ← Blender axes, and back: glTF (x, y, z) = Blender (x, z, −y).
B2G = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0))).to_4x4()
G2B = B2G.inverted()
# Joint frame ← bone space (bone y runs along the bone): (x, y, z) = bone (z, x, y).
AXIS = Matrix(((0, 0, 1), (1, 0, 0), (0, 1, 0))).to_4x4()

root_of = lambda arm: next(b for b in arm.data.bones if b.parent is None)
def chain_of(arm):
    """The tentacle's bones root → hub (the bone carrying the four finger stubs), with each head's distance from the root."""
    out, bone, distance = [], root_of(arm), 0.0
    while True:
        out.append((bone, distance))
        if len(bone.children) != 1: return out
        distance += bone.length
        bone = bone.children[0]

def dominant(ob):
    weight = collections.Counter()
    for v in ob.data.vertices:
        for g in v.groups: weight[ob.vertex_groups[g.group].name] += g.weight
    return max(weight, key=weight.get)

# ── Sample the bake: every hinged thing's pose on its parent, across the performance. ──
frames = sorted({REFERENCE_FRAME, *(round(scene.frame_start + (scene.frame_end - scene.frame_start) * i / max(1, SAMPLES - 1)) for i in range(SAMPLES))})
frames.remove(REFERENCE_FRAME); frames.insert(0, REFERENCE_FRAME)
chains = {arm.name: chain_of(arm) for arm in armatures}
fingers = {}  # arm → [(knuckle bone, tip bone)] in name order of the stubs
for arm in armatures:
    hub = chains[arm.name][-1][0]
    fingers[arm.name] = [(stub.children[0], stub.children[0].children[0]) for stub in sorted(hub.children, key=lambda b: b.name)]
mandible_roots = [o for o in body.children if o.name.startswith("garra")]
def links_of(root):
    out, at = [], root
    while at is not None:
        out.append(at)
        at = next((c for c in at.children), None)
    return out
mandibles = [links_of(root) for root in mandible_roots]

poses = collections.defaultdict(list)   # key → [child-in-parent 4×4 per sampled frame]
world_at_reference = {}
for frame in frames:
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    if frame == REFERENCE_FRAME:
        world_at_reference = {o.name: o.matrix_world.copy() for o in objects}
        pose_at_reference = {arm.name: {pb.name: pb.matrix.copy() for pb in arm.pose.bones} for arm in armatures}
    for t, arm in enumerate(armatures):
        pose = arm.pose.bones
        hub = chains[arm.name][-1][0]
        for f, (knuckle, tip) in enumerate(fingers[arm.name]):
            m_hub, m_knuckle, m_tip = pose[hub.name].matrix, pose[knuckle.name].matrix, pose[tip.name].matrix
            poses[("phalanx", f, 0, t)].append(AXIS @ m_hub.inverted() @ m_knuckle @ AXIS.inverted())
            poses[("phalanx", f, 1, t)].append(AXIS @ m_knuckle.inverted() @ m_tip @ AXIS.inverted())
    for k, links in enumerate(mandibles):
        for level, link in enumerate(links):
            parent = body if level == 0 else links[level - 1]
            poses[("mand", k, level)].append(parent.matrix_world.inverted() @ link.matrix_world)
scene.frame_set(REFERENCE_FRAME)
bpy.context.view_layer.update()
WORLD = world_at_reference

def fit_hinge(samples, reference):
    """A hinge through `samples` (child-in-parent 4×4s) measured from `reference`: axis in the
    parent frame, the signed angles, and how far the samples stray from a pure hinge."""
    r0 = reference.to_3x3().normalized()
    deltas = [(s.to_3x3().normalized() @ r0.transposed()).to_quaternion() for s in samples]
    axis = Vector((0, 0, 0))
    for q in deltas:
        if q.angle < math.radians(1.5): continue
        a = Vector(q.axis) * (1 if q.angle <= math.pi else -1)
        if axis.length > 0 and a.dot(axis) < 0: a = -a
        axis += a * min(q.angle, 2 * math.pi - q.angle)
    if axis.length == 0: return Vector((1, 0, 0)), [0.0], 0.0, 0.0   # never turns in the bake
    axis.normalize()
    angles, stray = [], 0.0
    for q in deltas:
        twist = Vector((q.x, q.y, q.z)).dot(axis)
        angle = 2 * math.atan2(twist, q.w)
        angle = (angle + math.pi) % (2 * math.pi) - math.pi
        angles.append(angle)
        stray = max(stray, (q @ Quaternion(axis, angle).inverted()).angle % (2 * math.pi))
    slide = max((s.translation - reference.translation).length for s in samples)
    return axis, angles, min(stray, 2 * math.pi - stray), slide

# ── The robot's frame. Every tentacle root points the same way at rest: straight back. ──
a0 = armatures[0]
back = (WORLD[a0.name].to_3x3() @ (root_of(a0).tail_local - root_of(a0).head_local)).normalized()
forward = -back
up = (Vector((0, 0, 1)) - forward * forward.z).normalized()
right = up.cross(forward)
corners = [WORLD[body.name] @ Vector(c) for c in body.bound_box]
centre = sum(corners, Vector()) / 8
ROBOT = Matrix((right, up, forward)).to_4x4() @ Matrix.Translation(-centre)   # glTF robot frame ← world

kit, info, worst = [], {}, collections.Counter()

def bake(ob, frame_from_world, name):
    """A copy of the mesh with its vertices in `frame` (glTF axes), written in the Blender axes that export to them."""
    mesh = ob.data.copy()
    mesh.name = name
    mesh.transform(G2B @ frame_from_world @ WORLD[ob.name])
    for layer in list(mesh.uv_layers): mesh.uv_layers.remove(layer)  # no image textures in loom: uv only splits vertices
    for index, material in enumerate(mesh.materials):
        mesh.materials[index] = role_materials[role_of(material.name if material else "")]
    return mesh

def place(name, data, at=None, props=None, parent=None):
    """An object at `at` (glTF axes, in its parent's frame), unrotated."""
    ob = bpy.data.objects.new(name, data)
    scene.collection.objects.link(ob)
    if parent is not None: ob.parent = parent
    if at is not None: ob.location = G2B @ Vector(at)
    for key, value in (props or {}).items(): ob[key] = value
    kit.append(ob)
    return ob

def in_frame(ob, frame_from_world):
    return [frame_from_world @ (WORLD[ob.name] @ v.co) for v in ob.data.vertices]

def hinge_props(joint, rest, axis, angles, stray, slide):
    q = rest.to_quaternion()
    return {"loom_joint": list(joint), "loom_rest": [q.x, q.y, q.z, q.w], "loom_axis": list(axis),
            "loom_range": [min(angles), max(angles)], "loom_fit": [stray, slide]}

# ── Tentacles: one ring, one hub, the phalanges; proved identical across all ten. ──
reference, meshes, sockets = {}, {}, []
for t, arm in enumerate(armatures):
    chain = chains[arm.name]
    index_of = {bone.name: i for i, (bone, _) in enumerate(chain)}
    bone_frame = lambda bone: AXIS @ (WORLD[arm.name] @ bone.matrix_local).inverted()
    sockets.append(ROBOT @ (WORLD[arm.name] @ arm.pose.bones[chain[0][0].name].head))
    children = [o for o in arm.children if o.type == "MESH"]
    stations = []
    for ring in sorted((o for o in children if o.name.startswith("Aro_")), key=lambda o: o.name):
        at = index_of[dominant(ring)]
        if "ring" not in reference:
            reference["ring"] = in_frame(ring, bone_frame(chain[at][0]))
            meshes["ring"] = bake(ring, bone_frame(chain[at][0]), "ring")
        # A ring that straddles two bones may weigh onto the neighbour: its station is whichever bone makes it THE ring.
        error, distance = min((max((p - q).length for p, q in zip(in_frame(ring, bone_frame(chain[i][0])), reference["ring"])), chain[i][1]) for i in range(max(0, at - 1), min(len(chain), at + 2)))
        worst["ring"] = max(worst["ring"], error)
        stations.append(distance)
    stations.sort()
    pitches = [b - a for a, b in zip(stations, stations[1:])]
    if t == 0:
        info.update(tentacles=len(armatures), ring_count=len(stations), ring_start=round(stations[0], 5), ring_pitch=round(sum(pitches) / len(pitches), 5), hub_distance=round(chain[-1][1], 5))
    worst["pitch"] = max(worst["pitch"], max(abs(p - info["ring_pitch"]) for p in pitches), abs(stations[0] - info["ring_start"]))

    hub_bone = chain[-1][0]
    hub = next(o for o in children if o.name.startswith("Garra_Cylinder"))
    if "hub" not in reference:
        reference["hub"] = in_frame(hub, bone_frame(hub_bone))
        meshes["hub"] = bake(hub, bone_frame(hub_bone), "hub")
    worst["hub"] = max(worst["hub"], max((p - q).length for p, q in zip(in_frame(hub, bone_frame(hub_bone)), reference["hub"])))
    owner = {}
    for f, (knuckle, tip) in enumerate(fingers[arm.name]): owner[knuckle.name], owner[tip.name] = (f, 0, knuckle), (f, 1, tip)
    for piece in sorted((o for o in children if o.name.startswith("Garra_Cube")), key=lambda o: o.name):
        f, p, bone = owner[dominant(piece)]
        key = f"phalanx_{f}_{p}"
        if key not in reference:
            reference[key] = in_frame(piece, bone_frame(bone))
            meshes[key] = bake(piece, bone_frame(bone), key)
        worst["phalanx"] = max(worst["phalanx"], max((a - b).length for a, b in zip(in_frame(piece, bone_frame(bone)), reference[key])))

place("ring", meshes["ring"])
hub_object = place("hub", meshes["hub"])
finger_count = len(fingers[a0.name])
claw_range = [0.0, 0.0]
for f in range(finger_count):
    carrier = hub_object
    for p in range(2):
        rest = poses[("phalanx", f, p, 0)][0]
        samples = [s for t in range(len(armatures)) for s in poses[("phalanx", f, p, t)]]
        axis, angles, stray, slide = fit_hinge(samples, rest)
        worst["phalanx hinge stray (rad)"] = max(worst["phalanx hinge stray (rad)"], stray)
        worst["phalanx joint slide"] = max(worst["phalanx joint slide"], slide)
        if p == 0: claw_range = [min(claw_range[0], min(angles)), max(claw_range[1], max(angles))]
        # Blender holds it posed at rest on its carrier, so a preview of the kit shows the claw assembled.
        carrier = place(f"phalanx_{f}_{p}", meshes[f"phalanx_{f}_{p}"], props=hinge_props(rest.translation, rest, axis, angles, stray, slide), parent=carrier)
        carrier.matrix_local = G2B @ rest @ B2G
info.update(fingers=finger_count)

# ── Body, eyes, front arms (the robot's own frame, at the reference pose) ──
mandible_members = {link.name for links in mandibles for link in links}
for piece in [body, *body.children]:
    if piece.type != "MESH" or piece.name in mandible_members: continue
    role = {"eye": "eyes"}.get(role_of(piece.material_slots[0].material.name), "body") if len(piece.data.polygons) > 2000 or piece.name == "Sentinel_1" else "lamp"
    ob = place(f"{role}.{piece.name}", bake(piece, ROBOT, f"{role}.{piece.name}"))
    if BODY_RATIO < 1 and len(ob.data.polygons) > 20000: ob.modifiers.new("decimate", "DECIMATE").ratio = BODY_RATIO
for k, links in enumerate(sorted(mandibles, key=lambda links: (ROBOT @ WORLD[links[0].name].translation).x)):
    source = mandibles.index(links)
    for level, link in enumerate(links):
        pivot = ROBOT @ WORLD[link.name].translation
        parent_world = WORLD[body.name] if level == 0 else WORLD[links[level - 1].name]
        robot_from_parent = ROBOT @ parent_world
        axis, angles, stray, slide = fit_hinge(poses[("mand", source, level)], poses[("mand", source, level)][0])
        worst["mandible hinge stray (rad)"] = max(worst["mandible hinge stray (rad)"], stray)
        worst["mandible joint slide"] = max(worst["mandible joint slide"], slide)
        if link.type != "MESH": continue
        # Unrotated in the robot frame (the furnace rig's convention): the hinge axis is given there too.
        axis_robot = (robot_from_parent.to_3x3().normalized() @ axis).normalized()
        ob = place(f"mand_{k}_{level}", bake(link, Matrix.Translation(-pivot) @ ROBOT, f"mand_{k}_{level}"), at=pivot,
                   props={"loom_part": f"mand_{k}_{level}", "loom_parent": f"mand_{k}_{level - 1}" if level > 0 else "", "loom_axis": list(axis_robot), "loom_range": [min(angles), max(angles)], "loom_fit": [stray, slide]})
        if MAND_RATIO < 1 and len(ob.data.polygons) > 1500: ob.modifiers.new("decimate", "DECIMATE").ratio = MAND_RATIO
info.update(mandibles=len(mandibles), mandible_links=len(mandibles[0]))

# ── Eyes: one marker per lens (a connected island of the eye mesh). ──
eye_objects = [ob for ob in kit if ob.name.startswith("eyes.")]
eyes = []
for ob in eye_objects:
    mesh = ob.data
    parent = list(range(len(mesh.vertices)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for edge in mesh.edges:
        a, b = find(edge.vertices[0]), find(edge.vertices[1])
        if a != b: parent[a] = b
    islands = collections.defaultdict(list)
    for v in mesh.vertices: islands[find(v.index)].append(B2G @ v.co)
    for pts in islands.values():
        c = sum(pts, Vector()) / len(pts)
        eyes.append((max((p - c).length for p in pts), c))
# Lenses and their bezels are separate islands at one place: keep the largest island at each place.
eyes.sort(key=lambda e: -e[0])
lenses = []
for radius, c in eyes:
    if radius < 0.012 or any((c - other).length < max(radius, r) for r, other in lenses): continue
    lenses.append((radius, c))
for i, (radius, c) in enumerate(lenses): place(f"eye.{i}", None, at=c, props={"loom_radius": radius})
info.update(eyes=len(lenses))

for t, position in enumerate(sockets): place(f"socket.{t}", None, at=position)
info.update(claw_open=round(claw_range[0], 4), claw_closed=round(claw_range[1], 4))
place("kit.info", None, props={f"loom_{key}": value for key, value in info.items()})

for ob in objects: bpy.data.objects.remove(ob, do_unlink=True)
bpy.context.view_layer.update()

print("KIT info", json.dumps(info))
print("KIT worst deviations (metres unless said):", {k: round(v, 6) for k, v in worst.items()})
bad = {k: v for k, v in worst.items() if k in ("ring", "pitch", "hub", "phalanx") and v > 1e-4}
if bad: raise SystemExit(f"the FBX's copies are not identical in their joint frames: {bad}")
body_pts = [B2G @ v.co for ob in kit if ob.name == "body.Sentinel_1" for v in ob.data.vertices]
print("KIT body bounds (x, y up, z forward):", [round(min(p[i] for p in body_pts), 3) for i in range(3)], [round(max(p[i] for p in body_pts), 3) for i in range(3)])
print("KIT sockets:", [tuple(round(c, 3) for c in s) for s in sockets])
print("KIT eyes:", [(round(r, 3), tuple(round(x, 3) for x in c)) for r, c in lenses])
for ob in kit:
    if "loom_axis" in ob: print("KIT hinge", ob.name, "axis", [round(x, 3) for x in ob["loom_axis"]], "range°", [round(math.degrees(x), 1) for x in ob["loom_range"]], "fit", [round(x, 4) for x in ob["loom_fit"]])

if PREVIEW is not None:
    os.makedirs(PREVIEW, exist_ok=True)
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light, shading.color_type, shading.show_cavity = "STUDIO", "MATERIAL", True
    scene.render.resolution_x, scene.render.resolution_y = 1200, 900
    world = bpy.data.worlds.new("preview"); world.color = (0.3, 0.3, 0.33); scene.world = world
    camera = bpy.data.objects.new("preview", bpy.data.cameras.new("preview"))
    scene.collection.objects.link(camera); scene.camera = camera
    camera.data.clip_start = 0.01
    # Blender axes: the robot faces −Y, +Z up. The ring and the claw sit at the origin, inside the body: hide the body for those.
    shots = (("front", (0, -3.2, 0.4), (0, 0, 0), None), ("side", (3.2, 0, 0.3), (0, 0, 0), None), ("top", (0, -0.01, 3.4), (0, 0, 0), None),
             ("below", (0.6, -1.4, -1.6), (0, 0, -0.2), None), ("ring", (0.2, 0.18, 0.14), (0, -0.03, 0), "ring"), ("claw", (0.5, 0.45, 0.3), (0, -0.1, 0), "claw"))
    for name, offset, target, only in shots:
        for ob in kit:
            if ob.type != "MESH": continue
            family = "ring" if ob.name == "ring" else "claw" if ob.name == "hub" or ob.name.startswith("phalanx") else "robot"
            ob.hide_render = (family != only) if only is not None else (family != "robot")
        camera.location = Vector(target) + Vector(offset)
        camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f"kit-{name}.png")
        bpy.ops.render.render(write_still=True)
    for ob in kit: ob.hide_render = False
    bpy.data.objects.remove(camera, do_unlink=True)

# The phalanges were posed on the hub for the preview; the file holds each in its OWN joint
# frame (where it sits and how it hinges are its extras), so an instancer places it unposed.
for ob in kit:
    if ob.name.startswith("phalanx_"):
        ob.parent = None
        ob.matrix_world = Matrix.Identity(4)
bpy.context.view_layer.update()

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB",
    export_draco_mesh_compression_enable=False, export_use_gltfpack=False,
    export_apply=True, export_yup=True, export_extras=True,
    export_cameras=False, export_lights=False,
    export_normals=True, export_texcoords=False, export_tangents=False,
    export_animations=False, export_skins=False, export_morph=False,
    export_materials="EXPORT", export_image_format="NONE",
)

with open(OUT, "rb") as handle: data = handle.read()
length = struct.unpack_from("<I", data, 12)[0]
gltf = json.loads(data[20:20 + length])
per, tris = collections.Counter(), collections.Counter()
for node in gltf["nodes"]:
    if "mesh" not in node: continue
    family = node["name"].split("_")[0].split(".")[0]
    for primitive in gltf["meshes"][node["mesh"]]["primitives"]:
        per[family] += gltf["accessors"][primitive["attributes"]["POSITION"]]["count"]
        tris[family] += gltf["accessors"][primitive["indices"]]["count"] // 3
print("KIT vertices:", dict(per), "total", sum(per.values()))
print("KIT triangles:", dict(tris), "total", sum(tris.values()))
print(f"KIT wrote {OUT} ({len(data) / 1e6:.1f} MB), {len(gltf['nodes'])} nodes, {len(gltf['meshes'])} meshes")
