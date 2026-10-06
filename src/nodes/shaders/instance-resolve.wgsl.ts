import { generatedOnce, wgsl } from "../../runtime/backend/wgsl.ts";
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
 * ## Only the instances that are drawn are drawn (F1)
 *
 * An instance may not be drawn at all: its Group predicate says no, or its slot is beyond a
 * counted pointset's live count. The first build wrote such an instance a ZERO matrix. That
 * removed its pixels and none of its work: every pass still ran the whole mesh's vertex
 * stage for it, and a 152,490-vertex hull that kept 1 of 631 points cost 56 ms a pass
 * instead of 1.
 *
 * So a geometry that CAN leave instances out (`compact`: it has a Group, or its points are
 * counted) compacts here. Besides the records the pass writes
 *
 *     visible[k]  the slot of the k-th accepted instance, in slot order
 *     drawArgs    (vertexCount, accepted count, 0, 0): the indirect arguments of every draw
 *
 * and a draw runs `accepted count` instances, reading its record at `visible[drawn]`. A
 * rejected instance is in no draw of any pass. The records stay indexed by the POINT'S
 * SLOT, so a material's `instanceId` and its `struct Instance` fields name the same point
 * every frame whatever is rejected around it.
 *
 * ONE dispatch of ONE workgroup does all of it, deterministically and without atomics. Each
 * of its 256 invocations owns a contiguous run of slots: it resolves them and counts the
 * ones it accepts, the invocations meet at a `workgroupBarrier()`, and each then knows how
 * many were accepted before its run and writes its own into `visible` from there. The runs
 * are disjoint and in slot order, so the list is too. Measured (M3 Max, Dawn on Metal):
 * 0.07 to 0.13 ms at 4,000 slots, 0.66 ms at 100,000, 2.6 ms at a million, where a kernel
 * over the same slots at the GPU's full width is 0.07, 0.07 and 0.26. Under roughly 100,000
 * slots that is less than the three further dispatches the lifecycle's scan and scatter
 * would cost; above it, that scan is the better tool (docs, section 13).
 *
 * A geometry that draws EVERY point does none of this: its draws take a literal count and
 * the pass is the plain one below, a slot an invocation at the GPU's full width. That is
 * not a detail. An INDIRECT draw costs about 0.05 ms of GPU each on this machine (0.12
 * without `indirect-first-instance`), and a Render draws a geometry in up to fifteen passes;
 * paid by thirteen geometries that leave nothing out, it was 7 to 18 ms a frame for nothing.
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
  /**
   * F1: the slots of the accepted instances, dense, in slot order: one u32 a slot. Present
   * exactly when the geometry compacts (it has a Group, or its points are counted).
   */
  readonly visible?: number;
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
  /** The Group predicate: an instance it rejects is in no draw. */
  readonly group?: { readonly expression: string; readonly binds: ReadonlyArray<{ readonly attribute: string; readonly read: PackedRead }> };
  /**
   * The material's `struct Instance` fields this geometry bound (D9): each is COPIED from
   * its point attribute (or one channel of it) into the record's region of that name, so the
   * fragment stage reads it at the instance's slot and no draw binds the points.
   */
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly read: PackedRead; readonly channel?: string }>;
  /** The points are COUNTED: a slot at or beyond the live count (`liveCount[0]`) is in no draw. */
  readonly counted?: boolean;
  /** Needs `visible` when it has a `group` or is `counted`: that is what compacting means. */
  readonly record: InstanceRecordOffsets;
  /**
   * T1689b: the geometry has a SHADOW MESH and compacts: the pass writes a second set of
   * indirect arguments, the same count with the shadow mesh's vertices
   * (`params.shadowVertexCount`), into `shadowDrawArgs`, bound after the sources.
   */
  readonly shadowArgs?: boolean;
}

/** F1: does a resolve with these options leave instances out, and so compact and count? */
export function resolveCompacts(options: Pick<InstanceResolveOptions, "group" | "counted">): boolean {
  return options.group !== undefined || options.counted === true;
}

/** The record buffer's binding name in the resolve pass, and the prefix of its sources. */
export const RESOLVE_RECORDS_BINDING = "records";
export const RESOLVE_SOURCE_PREFIX = "source";
/** T1689b: the shadow mesh's indirect arguments, when the pass writes them. */
export const RESOLVE_SHADOW_ARGS_BINDING = "shadowDrawArgs";
/** F1: the indirect arguments the pass writes, and a counted pointset's live count. */
export const RESOLVE_ARGS_BINDING = "drawArgs";
export const RESOLVE_LIVE_BINDING = "liveCount";
/** F1: the invocations of the one workgroup. The WebGPU baseline allows no more per workgroup. */
export const RESOLVE_LANES = 256;
/** The plain pass's workgroup: one slot an invocation. */
export const RESOLVE_PLAIN_WORKGROUP = 64;

/** How many workgroups a resolve pass over `capacity` slots dispatches. */
export function resolveWorkgroups(compact: boolean, capacity: number): readonly [number, number, number] {
  return compact ? [1, 1, 1] : [Math.ceil(capacity / RESOLVE_PLAIN_WORKGROUP), 1, 1];
}

export const instanceResolveWgsl = generatedOnce("instanceResolveWgsl", buildInstanceResolveWgsl);
function buildInstanceResolveWgsl(options: InstanceResolveOptions): EmittedWgsl {
  const visible = resolveCompacts(options) ? options.record.visible : undefined;
  /* T1689b: a second set of arguments only where there are arguments at all. */
  const shadowArgs = options.shadowArgs === true && visible !== undefined;
  /* A Group or a live count with nowhere to list what it accepts would be dropped in silence. */
  if (resolveCompacts(options) && visible === undefined) {
    throw new Error("instanceResolveWgsl: a compacting resolve (group or counted) needs record.visible.");
  }
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
    ...(visible === undefined ? [] : [regionStoreWgsl("storeVisible", RESOLVE_RECORDS_BINDING, { type: "u32", offset: visible, stride: 4 })]),
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
  /* Is this slot's instance drawn? Asked twice a slot (count, then place), so it only reads. */
  const accepted = `fn accepted(slot: u32) -> bool {
${options.counted === true ? `  if (slot >= ${RESOLVE_LIVE_BINDING}[0]) {\n    return false;\n  }\n` : ""}${
    group === undefined
      ? "  return true;"
      : `  var gp: GroupPoint;
${group.binds.map((bind) => `  gp.${bind.attribute} = group_${bind.attribute}(slot);`).join("\n")}
  return groupMatch(gp);`
  }
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
  /* The plain pass: every slot is an instance, one invocation each, at the GPU's full width. */
  const plain = `@compute @workgroup_size(${RESOLVE_PLAIN_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < params.count) {
    resolve(gid.x);
  }
}`;
  /* The compacting pass: see the header. */
  const compacting = `${accepted}
/* How many instances each invocation accepted: written by its owner, read after the barrier. */
var<workgroup> acceptedBy: array<u32, ${RESOLVE_LANES}>;

@compute @workgroup_size(${RESOLVE_LANES})
fn main(@builtin(local_invocation_index) lane: u32) {
  /* This invocation's run of slots: [first, last). */
  let share = (params.count + ${RESOLVE_LANES - 1}u) / ${RESOLVE_LANES}u;
  let first = min(lane * share, params.count);
  let last = min(first + share, params.count);
  var kept = 0u;
  for (var slot = first; slot < last; slot++) {
    if (accepted(slot)) {
      resolve(slot);
      kept++;
    }
  }
  acceptedBy[lane] = kept;
  workgroupBarrier();
  var at = 0u;
  for (var before = 0u; before < lane; before++) {
    at += acceptedBy[before];
  }
  for (var slot = first; slot < last; slot++) {
    if (accepted(slot)) {
      storeVisible(at, slot);
      at++;
    }
  }
  /* The last invocation has summed every run: its cursor is the count of the whole set. */
  if (lane == ${RESOLVE_LANES - 1}u) {
    ${RESOLVE_ARGS_BINDING}[0] = params.vertexCount;
    ${RESOLVE_ARGS_BINDING}[1] = at;
    ${RESOLVE_ARGS_BINDING}[2] = 0u;
    ${RESOLVE_ARGS_BINDING}[3] = 0u;${
      shadowArgs
        ? `
    ${RESOLVE_SHADOW_ARGS_BINDING}[0] = params.shadowVertexCount;
    ${RESOLVE_SHADOW_ARGS_BINDING}[1] = at;
    ${RESOLVE_SHADOW_ARGS_BINDING}[2] = 0u;
    ${RESOLVE_SHADOW_ARGS_BINDING}[3] = 0u;`
        : ""
    }
  }
}`;
  return wgsl`struct ResolveParams {
  object0: vec4f,           // the object matrix, as the three rows of its 3x4
  object1: vec4f,
  object2: vec4f,
  translate: vec4f,         // xyz: Translate's own value, added to every instance
  scale: vec4f,             // x: Size's own value, multiplied into every instance
  count: u32,               // slots to resolve
  vertexCount: u32,         // the shape's vertices: the first of the indirect arguments
${shadowArgs ? "  shadowVertexCount: u32,   // the shadow mesh's vertices: the first of ITS indirect arguments\n" : ""}};

@group(0) @binding(0) var<uniform> params: ResolveParams;
@group(0) @binding(1) var<storage, read_write> ${RESOLVE_RECORDS_BINDING}: array<u32>;
${visible === undefined ? "" : `@group(0) @binding(2) var<storage, read_write> ${RESOLVE_ARGS_BINDING}: array<u32>;\n`}${options.counted === true ? `@group(0) @binding(3) var<storage, read> ${RESOLVE_LIVE_BINDING}: array<u32>;\n` : ""}${packedBindingsWgsl(RESOLVE_SOURCE_PREFIX, options.groups, 4)}${shadowArgs ? `@group(0) @binding(${4 + options.groups}) var<storage, read_write> ${RESOLVE_SHADOW_ARGS_BINDING}: array<u32>;\n` : ""}
${accessors}
${groupDeclarations}${turn}
/* One row of Object · Instance: the object's row against the instance's three axes and its place. */
fn recordRow(object: vec4f, cx: vec3f, cy: vec3f, cz: vec3f, place: vec3f) -> vec4f {
  return vec4f(dot(object.xyz, cx), dot(object.xyz, cy), dot(object.xyz, cz), dot(object.xyz, place) + object.w);
}

${visible === undefined ? plain : compacting}

/* The record of one accepted instance. */
fn resolve(slot: u32) {
  /* Instance = T(place) · R(orient) · S(size): scale, then turn, then translate. */
  let size = ${size};
${axes}
  let place = translateAt(slot) + params.translate.xyz;
  storeM0(slot, recordRow(params.object0, cx, cy, cz, place));
  storeM1(slot, recordRow(params.object1, cx, cy, cz, place));
  storeM2(slot, recordRow(params.object2, cx, cy, cz, place));${options.record.tint === undefined ? "" : `\n  storeTint(slot, ${options.tint === undefined ? "vec4f(1.0)" : "tintAt(slot)"});`}${copyFields}
}`;
}
