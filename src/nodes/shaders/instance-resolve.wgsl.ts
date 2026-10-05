import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { ATTRIBUTE_STRIDES, type PointAttributeType } from "../../points/attributes.ts";
import { regionAccessorWgsl, regionStoreWgsl } from "../../points/packing.ts";

/**
 * T1581b — MESH INSTANCING, the half that runs ONCE PER INSTANCE
 * (docs/mesh-instancing-design-2026-10-05.md, D5 and D8).
 *
 * A geometry in Instances mode with Shape: Mesh draws its mesh in many passes — the lit
 * draw, up to three G-buffer layers, a sweep per casting light (six for a point light), the
 * AO prepass, the Depth output. Every one of them needs each instance's transform, and
 * a ring of 716 triangles runs its vertex stage 2,148 times. So the transform is NOT
 * evaluated there. This compute pass reads the mapped point attributes once a frame,
 * builds
 *
 *     record_i = Object · Instance_i
 *     Instance_i = T(position_i + translate) · R(orient_i) · S(scale · scale_i)
 *
 * and writes it as the three rows of a 3×4 matrix per slot. Every draw then reads three
 * vec4f and does one affine transform per vertex. That makes this function the ONE place
 * the instance chain is written down: the lit generator, the depth generator and whatever
 * draws these instances next all read what it wrote.
 *
 * An instance that is NOT drawn (its Group predicate says no) gets a ZERO matrix: every
 * vertex lands on one point, the triangles have no area and no pass rasterises them
 * (§V219's collapse, decided once per instance instead of once per vertex per pass).
 *
 * ## Addressing: whole buffers, read by offset
 *
 * Point storage is packed (T1076): every attribute of one producer is a region of one
 * buffer. This pass — and the draws that read the records — bind each distinct buffer ONCE,
 * whole, as `array<u32>`, and read attributes through `regionAccessorWgsl`, the point
 * kernels' own accessor. A draw's binding count is then the number of PRODUCERS it reads,
 * whatever is mapped, against the baseline of eight storage buffers a stage (§V588).
 */

/** One attribute read out of a packed buffer that is bound whole: which binding, where, what. */
export interface PackedRead {
  /** Index of the bound buffer (`<prefix><group>` in the generated text). */
  readonly group: number;
  /** Byte offset of the attribute's region inside that buffer. */
  readonly offset: number;
  readonly type: PointAttributeType;
}

/** `fn <name>(slot: u32) -> <type>` reading one region of `<prefix><group>`. */
export function packedAccessorWgsl(fnName: string, prefix: string, read: PackedRead): string {
  return regionAccessorWgsl(fnName, `${prefix}${read.group}`, { type: read.type, offset: read.offset, stride: ATTRIBUTE_STRIDES[read.type] });
}

/** `@group(0) @binding(base + g) var<storage, read> <prefix><g>: array<u32>;` for g in 0..groups-1. */
export function packedBindingsWgsl(prefix: string, groups: number, baseBinding: number): string {
  return Array.from({ length: groups }, (_, group) => `@group(0) @binding(${baseBinding + group}) var<storage, read> ${prefix}${group}: array<u32>;\n`).join("");
}

/** Byte offsets of the record's regions inside the record buffer (see `instanceRecordAttributes`). */
export interface InstanceRecordOffsets {
  readonly m0: number;
  readonly m1: number;
  readonly m2: number;
  /** Present when Tint is mapped: the instance's own tint. */
  readonly tint?: number;
  /** The material's `struct Instance` fields the geometry bound, by field name (D9). */
  readonly fields?: Readonly<Record<string, { readonly offset: number; readonly type: PointAttributeType }>>;
}

export interface InstanceResolveOptions {
  /** How many source buffers are bound, as `source0..`. */
  readonly groups: number;
  /** Where each instance is: a vec3f attribute (`position` unless Translate is mapped). */
  readonly translate: PackedRead;
  /** A unit quaternion per instance (x, y, z, w). Absent: no turn. */
  readonly orient?: PackedRead;
  /** A per-instance size factor: an f32, or one channel of a float vector. */
  readonly scale?: PackedRead & { readonly channel?: string };
  /** A per-instance tint, copied into the record. */
  readonly tint?: PackedRead;
  /** The Group predicate: an instance it rejects is written as the zero record. */
  readonly group?: { readonly expression: string; readonly binds: ReadonlyArray<{ readonly attribute: string; readonly read: PackedRead }> };
  /**
   * The material's `struct Instance` fields this geometry bound (D9): each is COPIED from
   * its point attribute (or one channel of it) into the record's region of that name, so the
   * fragment stage reads it at the instance's slot and no draw binds the points.
   */
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly read: PackedRead; readonly channel?: string }>;
  readonly record: InstanceRecordOffsets;
}

/** The record buffer's binding name in the resolve pass, and the prefix of its sources. */
export const RESOLVE_RECORDS_BINDING = "records";
export const RESOLVE_SOURCE_PREFIX = "source";

export function instanceResolveWgsl(options: InstanceResolveOptions): EmittedWgsl {
  const row = (offset: number, name: string): string => regionStoreWgsl(name, RESOLVE_RECORDS_BINDING, { type: "vec4f", offset, stride: 16 });
  /* A bound field with no region in the record has nowhere to go: the two lists are built
     from one binding (the Geometry's), so this only drops what a caller mis-assembled. */
  const fields = (options.fields ?? []).flatMap((field) => {
    const stored = options.record.fields?.[field.name];
    return stored === undefined ? [] : [{ ...field, stored }];
  });
  const accessors = [
    packedAccessorWgsl("translateAt", RESOLVE_SOURCE_PREFIX, options.translate),
    ...(options.orient === undefined ? [] : [packedAccessorWgsl("orientAt", RESOLVE_SOURCE_PREFIX, options.orient)]),
    ...(options.scale === undefined ? [] : [packedAccessorWgsl("scaleAt", RESOLVE_SOURCE_PREFIX, options.scale)]),
    ...(options.tint === undefined ? [] : [packedAccessorWgsl("tintAt", RESOLVE_SOURCE_PREFIX, options.tint)]),
    ...(options.group?.binds ?? []).map((bind) => packedAccessorWgsl(`group_${bind.attribute}`, RESOLVE_SOURCE_PREFIX, bind.read)),
    row(options.record.m0, "storeM0"),
    row(options.record.m1, "storeM1"),
    row(options.record.m2, "storeM2"),
    ...(options.record.tint === undefined ? [] : [row(options.record.tint, "storeTint")]),
    ...fields.flatMap((field, index) => [
      packedAccessorWgsl(`fieldAt${index}`, RESOLVE_SOURCE_PREFIX, field.read),
      regionStoreWgsl(`storeField${index}`, RESOLVE_RECORDS_BINDING, { type: field.stored.type, offset: field.stored.offset, stride: ATTRIBUTE_STRIDES[field.stored.type] }),
    ]),
  ].join("\n\n");
  const copyFields = fields.map((field, index) => `\n  storeField${index}(slot, fieldAt${index}(slot)${field.channel === undefined ? "" : `.${field.channel}`});`).join("");
  const group = options.group;
  const groupDeclarations =
    group === undefined
      ? ""
      : `
struct GroupPoint {
${group.binds.map((bind) => `  ${bind.attribute}: ${bind.read.type},`).join("\n")}
};

fn groupMatch(p: GroupPoint) -> bool {
  return (${group.expression});
}
`;
  const zeroTint = options.record.tint === undefined ? "" : "\n    storeTint(slot, vec4f(0.0));";
  const groupGate =
    group === undefined
      ? ""
      : `  var gp: GroupPoint;
${group.binds.map((bind) => `  gp.${bind.attribute} = group_${bind.attribute}(slot);`).join("\n")}
  if (!groupMatch(gp)) {
    /* Not drawn: the zero matrix puts every vertex on one point — no area, no fragments. */
    storeM0(slot, vec4f(0.0));
    storeM1(slot, vec4f(0.0));
    storeM2(slot, vec4f(0.0));${zeroTint}
    return;
  }
`;
  const scale = options.scale;
  const size = scale === undefined ? "params.scale.x" : `params.scale.x * scaleAt(slot)${scale.channel === undefined ? "" : `.${scale.channel}`}`;
  /* Without an orientation the axes are the sized basis itself: no arithmetic to round. */
  const axes =
    options.orient === undefined
      ? `  let cx = vec3f(size, 0.0, 0.0);
  let cy = vec3f(0.0, size, 0.0);
  let cz = vec3f(0.0, 0.0, size);`
      : `  let q = orientAt(slot);
  let cx = turn(q, vec3f(size, 0.0, 0.0));
  let cy = turn(q, vec3f(0.0, size, 0.0));
  let cz = turn(q, vec3f(0.0, 0.0, size));`;
  /**
   * A vector turned by a UNIT quaternion, Rodrigues form — the arithmetic the primitives'
   * generator has turned by since T723 (`qrot`), right-handed and active:
   * (0, 0, sin45, cos45) is +90° about +Z and carries +X to +Y.
   */
  const turn =
    options.orient === undefined
      ? ""
      : `
fn turn(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
`;
  return wgsl`struct ResolveParams {
  object0: vec4f,           // the object matrix, as the three rows of its 3x4
  object1: vec4f,
  object2: vec4f,
  translate: vec4f,         // xyz: Translate's own value, added to every instance
  scale: vec4f,             // x: Size's own value, multiplied into every instance
  count: u32,               // slots to resolve
};

@group(0) @binding(0) var<uniform> params: ResolveParams;
@group(0) @binding(1) var<storage, read_write> ${RESOLVE_RECORDS_BINDING}: array<u32>;
${packedBindingsWgsl(RESOLVE_SOURCE_PREFIX, options.groups, 2)}
${accessors}
${groupDeclarations}${turn}
/* One row of Object · Instance: the object's row against the instance's three axes and its place. */
fn recordRow(object: vec4f, cx: vec3f, cy: vec3f, cz: vec3f, place: vec3f) -> vec4f {
  return vec4f(dot(object.xyz, cx), dot(object.xyz, cy), dot(object.xyz, cz), dot(object.xyz, place) + object.w);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.count) {
    return;
  }
${groupGate}  /* Instance = T(place) · R(orient) · S(size): scale, then turn, then translate. */
  let size = ${size};
${axes}
  let place = translateAt(slot) + params.translate.xyz;
  storeM0(slot, recordRow(params.object0, cx, cy, cz, place));
  storeM1(slot, recordRow(params.object1, cx, cy, cz, place));
  storeM2(slot, recordRow(params.object2, cx, cy, cz, place));${options.record.tint === undefined ? "" : `\n  storeTint(slot, ${options.tint === undefined ? "vec4f(1.0)" : "tintAt(slot)"});`}${copyFields}
}`;
}
