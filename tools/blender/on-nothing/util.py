"""Mesh building helpers for the On Nothing scene (T1400b)."""
import math

import bpy
from mathutils import Matrix, Vector


class MB:
    """Accumulates vertices and faces with a material per face, then becomes one object."""

    def __init__(self, name):
        self.name = name
        self.verts = []
        self.faces = []
        self.fmats = []

    def add(self, verts, faces, mat):
        base = len(self.verts)
        self.verts.extend(Vector(v) for v in verts)
        for f in faces:
            self.faces.append([base + i for i in f])
            self.fmats.append(mat)
        return base

    def box(self, center, size, mat, rot=None):
        """Axis box (optionally rotated by `rot`, a 3x3 Matrix) centred at `center`."""
        sx, sy, sz = (s / 2 for s in size)
        corners = [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
                   (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]
        c = Vector(center)
        verts = [c + ((rot @ Vector(p)) if rot is not None else Vector(p)) for p in corners]
        faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        return self.add(verts, faces, mat)

    def beam(self, a, b, w, h, mat, up=(0, 0, 1)):
        """A rectangular bar from a to b, w wide, h tall (h along `up` projected off the axis)."""
        a, b = Vector(a), Vector(b)
        axis = (b - a)
        length = axis.length
        d = axis.normalized()
        u = Vector(up)
        if abs(d.dot(u)) > 0.95:
            u = Vector((1, 0, 0))
        side = d.cross(u).normalized()
        upv = side.cross(d).normalized()
        rot = Matrix((side, d, upv)).transposed()
        return self.box((a + b) / 2, (w, length, h), mat, rot)

    def cylinder(self, a, b, r, seg, mat, caps=True, r2=None):
        a, b = Vector(a), Vector(b)
        d = (b - a).normalized()
        u = Vector((0, 0, 1)) if abs(d.z) < 0.95 else Vector((1, 0, 0))
        x = d.cross(u).normalized()
        y = d.cross(x).normalized()
        r2 = r if r2 is None else r2
        verts = []
        for k in range(seg):
            t = 2 * math.pi * k / seg
            off = x * math.cos(t) + y * math.sin(t)
            verts.append(a + off * r)
        for k in range(seg):
            t = 2 * math.pi * k / seg
            off = x * math.cos(t) + y * math.sin(t)
            verts.append(b + off * r2)
        faces = [(k, (k + 1) % seg, seg + (k + 1) % seg, seg + k) for k in range(seg)]
        if caps:
            faces.append(tuple(reversed(range(seg))))
            faces.append(tuple(range(seg, 2 * seg)))
        return self.add(verts, faces, mat)

    def torus(self, center, axis, major, minor, seg, rseg, mat, scale_minor_axis=1.0):
        c = Vector(center)
        d = Vector(axis).normalized()
        u = Vector((0, 0, 1)) if abs(d.z) < 0.95 else Vector((1, 0, 0))
        x = d.cross(u).normalized()
        y = d.cross(x).normalized()
        verts = []
        for i in range(seg):
            t = 2 * math.pi * i / seg
            radial = x * math.cos(t) + y * math.sin(t)
            for j in range(rseg):
                s = 2 * math.pi * j / rseg
                verts.append(c + radial * (major + minor * math.cos(s)) + d * (minor * math.sin(s) * scale_minor_axis))
        faces = []
        for i in range(seg):
            for j in range(rseg):
                i2, j2 = (i + 1) % seg, (j + 1) % rseg
                faces.append((i * rseg + j, i2 * rseg + j, i2 * rseg + j2, i * rseg + j2))
        return self.add(verts, faces, mat)

    def to_object(self, mats, coll, smooth_deg=40.0, subsurf=0, bevel=0.0, props=None, location=None, yaw=0.0):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        me.validate()
        names = []
        for m in self.fmats:
            if m not in names:
                names.append(m)
        for n in names:
            me.materials.append(mats[n])
        idx = {n: i for i, n in enumerate(names)}
        me.polygons.foreach_set("material_index", [idx[m] for m in self.fmats])
        me.update()
        ob = bpy.data.objects.new(self.name, me)
        coll.objects.link(ob)
        finish(ob, smooth_deg=smooth_deg, subsurf=subsurf, bevel=bevel)
        if location is not None:
            ob.location = location
        ob.rotation_euler = (0, 0, yaw)
        for k, v in (props or {}).items():
            ob[k] = v
        return ob


def finish(ob, smooth_deg=40.0, subsurf=0, bevel=0.0):
    """Bevel, subdivide and shade by angle, all APPLIED so the GLB carries the result."""
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    if bevel > 0:
        mod = ob.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(40)
        mod.harden_normals = False
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if subsurf > 0:
        mod = ob.modifiers.new("subsurf", "SUBSURF")
        mod.levels = subsurf
        mod.render_levels = subsurf
        bpy.ops.object.modifier_apply(modifier=mod.name)
    me = ob.data
    me.shade_smooth()
    if smooth_deg is not None:
        me.set_sharp_from_angle(angle=math.radians(smooth_deg))


def link_empty(coll, name, loc, direction=None, props=None):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = "SINGLE_ARROW"
    ob.location = loc
    if direction is not None:
        ob.rotation_mode = "QUATERNION"
        ob.rotation_quaternion = Vector(direction).normalized().to_track_quat("-Z", "Y")
    for k, v in (props or {}).items():
        ob[k] = v
    coll.objects.link(ob)
    return ob


def gl(v):
    """Blender (x, y, z) -> glTF (x, z, -y): extras vectors are written in the exported space."""
    return [round(float(v[0]), 5), round(float(v[2]), 5), round(float(-v[1]), 5)]


def camera(coll, name, loc, target, lens, roll=0.0, props=None):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.sensor_width = 36.0
    cd.sensor_fit = "HORIZONTAL"
    cd.clip_start = 0.05
    cd.clip_end = 300.0
    ob = bpy.data.objects.new(name, cd)
    ob.location = loc
    q = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y")
    ob.rotation_mode = "QUATERNION"
    if roll:
        from mathutils import Quaternion
        q = q @ Quaternion((0, 0, 1), math.radians(roll))
    ob.rotation_quaternion = q
    ob["loom_target"] = gl(target)
    for k, v in (props or {}).items():
        ob[k] = v
    coll.objects.link(ob)
    return ob


def face_toward(ob, point):
    """Flip every face whose normal points away from `point` (for sets seen from inside)."""
    import bmesh
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    p = Vector(point)
    flip = [f for f in bm.faces if f.normal.dot(p - f.calc_center_median()) < 0]
    bmesh.ops.reverse_faces(bm, faces=flip)
    bm.to_mesh(me)
    bm.free()
    me.update()


def recalc_outside(ob):
    """Consistent outward normals on closed pieces."""
    import bmesh
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
