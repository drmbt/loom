import { generatedOnce, wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { regionAccessorWgsl, regionStoreWgsl } from "../../points/packing.ts";
import { packedAccessorWgsl, packedBindingsWgsl, type PackedRead } from "./instance-resolve.wgsl.ts";

/**
 * T1589b, T1623b — A RENDER'S LIGHT TABLE, the shader half
 * (docs/lights-from-pointset-design-2026-10-06.md, sections 2.4, 3.9, 13, 14 and 15).
 *
 * The lights a Render shades by are not unrolled into its lit shader, a block each: they are
 * ROWS OF DATA in a table the Render owns. A Light in Points mode is one row at every point
 * of a pointset; a Light in Single mode that does not cast is one row (T1623b slice 3). The
 * rows with a range are culled on the GPU:
 *
 *   light:lights:resolve       one invocation a point: a Light in Points mode's values and
 *                              its mapped attributes become one RECORD a slot (this file, first)
 *   render:lights:header       the table's header, written as values (the buffer-values seam)
 *   render:lights:named        the Render's named Lights, a record each, written as values
 *                              into a buffer of the Render's own
 *   render:lights:gather:<i>   one pass a SET (the named rows, then each pointset Light's):
 *                              its records copied into ONE table, so a lit draw binds one buffer
 *   render:lights:grid         one invocation a CELL of a grid over the view (tiles on screen
 *                              by slices in depth): it walks the rows with a range and keeps,
 *                              as one bit each, the lights whose range touches its box
 *   render:scene:<i>           the lit fragment walks the rows that reach every pixel, then
 *                              finds its cell and walks the set bits
 *
 * This table is where every light of the app is going (T1623b, the cure for B260,
 * docs/light-cost-investigation-2026-10-06.md section 11): a casting light as a row with a
 * shadow slot (slices 4 and 5), a projector as a row (slice 6). So nothing here is a side
 * path, and three rules hold from the first slice:
 *
 * ## No text here holds a count of lights
 *
 * The lit text is ONE string whatever the table holds: three lamps, three hundred and a
 * thousand are the same module. So are the resolve's and the grid build's. Every loop takes
 * its bound from the table's header or from a uniform value, never from a literal: a count
 * in the text is a text per count, and it invites a compiler to unroll the loop into the
 * straight chain of sums B260 measured. No loop here runs over a fixed-size array.
 *
 * ## The record: four rows, 64 bytes
 *
 *   place  vec4f   xyz: where the light stands, world. w: its range; 0 is unlimited (in
 *                  every cell); below 0 the slot is OFF (in none): a dead slot of a counted
 *                  pointset, a light with no intensity, a mapped range that came out at
 *                  nothing.
 *   color  vec4f   rgb: colour times intensity, linear. w: the falloff law (1 inverse square).
 *   aim    vec4f   xyz: the way the light travels: a directional light's Direction, a spot's
 *                  axis. A SPOT's is a unit vector (its cone is measured against it). A
 *                  directional row's may be of any length: its reader normalises it, and a
 *                  named Light's is written as authored (`namedLightRecord` says why).
 *                  w: the cosine of a spot's OUTER half-angle, where its light reaches zero;
 *                  −2 for a row with no cone (a cosine no direction is under).
 *   cone   vec4f   x: the cosine of the cone's INNER half-angle, inside which the light is
 *                  whole; −1 for a row with no cone.
 *                  y: the KIND: 0 directional, 1 point, 2 spot. A VALUE, never text:
 *                     changing a Light's Type writes a float and compiles nothing.
 *                  z: the SHADOW SLOT, 0 for none. Nothing writes another yet (T1622b, T1623b).
 *                  w: the SOURCE NUMBER: which Light of the Render's Lights the row came
 *                     from, counted from 0 in list order. Written by the gather; read by
 *                     nothing yet (the lists, Lit Only and Lit Exclude, will test it).
 *
 * ## The table: a header, the records row by row, the cells
 *
 *   words 0..7     the HEADER (`LIGHT_TABLE_HEADER`): [0] the rows a region holds (the
 *                  table's capacity), [1] words a cell (one bit a row), [2] where the cells
 *                  start, as a word index, [3] how many rows reach every pixel: the first
 *                  ones; [4] how many rows are live this frame, [5] where the always-walked
 *                  rows of any kind end, [6] where the point rows after them end, [7] spare.
 *                  Written by the CPU every frame as values; read by the gather, the grid
 *                  build and every lit fragment. This is where the loops get their bounds.
 *   then           every record's `place`, then every `color`, every `aim`, every `cone`:
 *                  four words a row, a region of the table's capacity each
 *   then           the cells: `words` words each, cell after cell
 *
 * The table keeps each ROW of the records together, and a Light's own buffer keeps each
 * RECORD together. A Light's buffer is written once and copied once, so its layout is the
 * plain one. The table is read by the build, which wants nothing but every light's `place`,
 * and by every lit fragment, most of whose reads are the `place` of a light its cell holds
 * and its own position is out of range of: one row in four. Measured on Dawn, the two
 * layouts alternated in one process, 1,024 lights none of which reaches the floor (the build
 * and the walk, nothing shaded): 0.43 to 0.46 of the reference row by row against 0.51 to
 * 0.56 record by record, the build alone 0.26 to 0.33 against 0.46 ms. With every light in
 * reach of every pixel the two cost the same. Where a row's region starts follows from the
 * header's row count, so it is in no text.
 *
 * The rows a CPU writes (the named Lights, through the buffer-values seam) are written
 * WHOLE, 64 bytes each, into a buffer laid out as a Light's own is, and gathered like any
 * set: the table's own layout is then one writer's concern, the gather's.
 *
 * Two views of the one buffer. The passes that WRITE it see words (`array<u32>`): the build's
 * invocations each own one cell's words, and a write of one component of a four-word element
 * may be a read and a write of the whole element, which two invocations would race on. The
 * lit draw only reads, and sees four-word elements (`array<vec4u>`): the header is element 0,
 * a row of a record is one element, a cell's word a component of one. One load a row in place
 * of four. Measured the same way (the lit text patched back and forth in one process, the
 * pictures byte for byte the same): 0.58 of the reference against 0.67 at 64 lights that all
 * reach every pixel, 2.30 against 2.60 to 2.73 at 256, 0.43 against 0.52 with 1,024 lights and
 * nothing shaded. So the header and each region start at a multiple of four words, and the
 * buffer's length is one.
 *
 * ## A cell is a bitmask, and that is the design
 *
 * A list of lights per cell has a length, and a cell past its length drops lights with
 * nothing to say so short of reading the GPU back (measured: the far end of a tunnel put 248
 * lights of 1,024 in one cell, where a list of 64 keeps 64). A bitmask has one bit per row
 * of the table, so the only limit is the table's capacity, known at compile and refused by
 * name there. One invocation owns one cell's words and writes nothing else: no atomics, no
 * order to depend on (§V45).
 *
 * ## Culling is exact
 *
 * A light with a Range gives exactly nothing at and beyond it (the window in
 * `POINT_FALLOFF_WGSL` is clamped to zero), so a light left out of a cell its sphere does
 * not touch would have added `+0.0`. The cell's box is GROWN a little (`LIGHT_CELL_MARGIN`)
 * so that rounding between the two spellings of a slice boundary, the build's `pow` and the
 * fragment's `log`, can only put a light in one cell more, never lose it from the one it
 * lights. `light-points.gpu.test.ts` holds it: the picture through the grid is the picture
 * through one cell, byte for byte.
 *
 * ## Rows a grid cannot leave out
 *
 * A directional light, and a point or spot light with no Range, reach every pixel. They are
 * the FIRST rows of the table (`always` of them), no cell holds them, and the lit draw walks
 * them with loops of their own (`lightTableWalkWgsl`). Which rows those are is a VALUE of the
 * frame (a Type, a Range), so the Render orders its rows every frame and says where each run
 * ends in the header: a Light that gains a Range moves in the table and compiles nothing.
 */

/** A record's four rows, in order: 16 bytes each, 64 a record. */
const RECORD_ROWS = ["place", "color", "aim", "cone"] as const;
type RecordRow = (typeof RECORD_ROWS)[number];
/** Bytes a record. */
export const LIGHT_RECORD_BYTES = RECORD_ROWS.length * 16;
/** Words of the table's header, in front of its records. */
export const LIGHT_TABLE_HEADER_WORDS = 8;

/**
 * The header's words, in order: what `lightTableHeader` writes and every reader indexes.
 * `regionRows` is the table's CAPACITY in rows (a region of each record row is that long);
 * `rows` is how many are live this frame, `always` how many of those, the first ones, reach
 * every pixel. The last three words are spare.
 */
export const LIGHT_TABLE_HEADER = { regionRows: 0, words: 1, cells: 2, always: 3, rows: 4, general: 5, points: 6 } as const;
/** The header as the eight whole numbers a `write` pass carries. */
export function lightTableHeader(values: {
  readonly regionRows: number;
  readonly words: number;
  readonly cells: number;
  readonly always: number;
  readonly rows: number;
  readonly general: number;
  readonly points: number;
}): number[] {
  return [values.regionRows, values.words, values.cells, values.always, values.rows, values.general, values.points, 0];
}
/** Rows a turn of a loop of the lit walk that is written for one kind: see `lightTableWalkWgsl`. */
export const LIGHT_ROWS_A_TURN = 2;

/** The binding names the passes and the lit draw use. */
export const LIGHT_RECORDS_BINDING = "lightRecords";
export const LIGHT_TABLE_BINDING = "lightTable";
/** The one set of records a gather pass copies from. */
export const LIGHT_SET_BINDING = "lightSet";
export const LIGHT_SOURCE_PREFIX = "lightSource";
export const LIGHT_LIVE_BINDING = "liveCount";
/** The lit draw's binding number for the table: clear of the mesh rows (100–104), the frame block (120) and the instance buffers (130…). */
export const LIGHT_TABLE_BINDING_NUMBER = 150;
/** One slot an invocation (the resolve, the gather); one cell an invocation (the grid). */
export const LIGHT_WORKGROUP = 64;
/** How much a cell's box is grown, as a share of a depth and of the picture: see "Culling is exact". */
export const LIGHT_CELL_MARGIN = 1e-4;

/** One row of every record of a LIGHT'S OWN buffer: record after record, 64 bytes each. */
const rowOf = (row: RecordRow) => ({ type: "vec4f" as const, offset: RECORD_ROWS.indexOf(row) * 16, stride: LIGHT_RECORD_BYTES });
/** A row's name as the tail of a function's: `storePlace`, `lightRecordCone`. */
const titled = (row: RecordRow): string => `${row.charAt(0).toUpperCase()}${row.slice(1)}`;

/**
 * Where a row of a TABLE's record is, as a word index (see "The table"): region after
 * region behind the header, each `rows` rows long. `rows` is the expression for the table's
 * row count: its header's first word, or the gather's own value while the gather is the pass
 * writing that header.
 */
function tableWordWgsl(row: RecordRow, rows: string): string {
  const region = RECORD_ROWS.indexOf(row);
  return region === 0 ? `${LIGHT_TABLE_HEADER_WORDS}u + slot * 4u` : `${LIGHT_TABLE_HEADER_WORDS}u + (${rows} * ${region}u + slot) * 4u`;
}
/** The words a table of `rows` rows holds before its cells: what the header's third word says. */
export const lightTableCellsAt = (rows: number): number => LIGHT_TABLE_HEADER_WORDS + rows * RECORD_ROWS.length * 4;
/** Where one row's region starts in a table of `rows` rows, as a word index: for a reader on the CPU. */
export const lightTableRowAt = (row: RecordRow, rows: number): number => LIGHT_TABLE_HEADER_WORDS + rows * RECORD_ROWS.indexOf(row) * 4;

/** A row read through the WORD view (the build). */
const tableReadWgsl = (name: string, row: RecordRow): string => `fn ${name}(slot: u32) -> vec4f {
  let o = ${tableWordWgsl(row, `${LIGHT_TABLE_BINDING}[0]`)};
  return bitcast<vec4f>(vec4u(${LIGHT_TABLE_BINDING}[o], ${LIGHT_TABLE_BINDING}[o + 1u], ${LIGHT_TABLE_BINDING}[o + 2u], ${LIGHT_TABLE_BINDING}[o + 3u]));
}`;
/** A row read through the ELEMENT view (the lit draw): the header is element 0, then a region a row. */
function tableElementReadWgsl(name: string, row: RecordRow): string {
  const region = RECORD_ROWS.indexOf(row);
  const header = LIGHT_TABLE_HEADER_WORDS / 4;
  const at = region === 0 ? `${header}u + slot` : `${header}u + ${LIGHT_TABLE_BINDING}[0].x * ${region}u + slot`;
  /* `[0].x` is the header's first word: the rows a region holds. */
  return `fn ${name}(slot: u32) -> vec4f {
  return bitcast<vec4f>(${LIGHT_TABLE_BINDING}[${at}]);
}`;
}
const tableStoreWgsl = (name: string, row: RecordRow, rows: string): string => `fn ${name}(slot: u32, value: vec4f) {
  let o = ${tableWordWgsl(row, rows)};
  let w = bitcast<vec4u>(value);
  ${LIGHT_TABLE_BINDING}[o] = w[0];
  ${LIGHT_TABLE_BINDING}[o + 1u] = w[1];
  ${LIGHT_TABLE_BINDING}[o + 2u] = w[2];
  ${LIGHT_TABLE_BINDING}[o + 3u] = w[3];
}`;

/* ------------------------------------------------------------------------------------ */
/* 1. the Light's resolve                                                                */
/* ------------------------------------------------------------------------------------ */

export interface LightResolveOptions {
  /** How many source buffers are bound, as `lightSource0..`. */
  readonly groups: number;
  /** Where each light stands: the points' `position`, or the vec3f attribute Position maps. */
  readonly place: PackedRead;
  /** A per-point colour (vec4f, linear): it MULTIPLIES the Light's Color. */
  readonly color?: PackedRead;
  /** A per-point factor on the Light's Intensity: an f32, or one channel of a float vector. */
  readonly intensity?: PackedRead & { readonly channel?: string };
  /** A per-point factor on the Light's Range, the same way. A point light it brings to nothing is off. */
  readonly range?: PackedRead & { readonly channel?: string };
  /** A per-point way to travel (vec3f, world): it stands in place of the Light's Direction. */
  readonly direction?: PackedRead;
  /** A per-point unit quaternion (vec4f): it turns the direction, in place of the Light's Orient. */
  readonly orient?: PackedRead;
  /** A per-point factor on the Light's Cone. A spot it brings to nothing is off. */
  readonly cone?: PackedRead & { readonly channel?: string };
  /** The points are COUNTED: a slot at or beyond the live count (`liveCount[0]`) is off. */
  readonly counted?: boolean;
}

/**
 * The two cosines written for a row with NO CONE (a point light, a directional one, a spot
 * of every direction): the lit walk tests every row's cone, and these leave all of the
 * light, exactly: `(cosine − outer) ÷ (inner − outer)` is 1 or more for every cosine there is.
 */
export const LIGHT_NO_CONE = { outer: -2, inner: -1 } as const;
/** A Cone of this many degrees or more is every direction: the row has no cone. */
export const LIGHT_CONE_EVERYWHERE = 359;

/**
 * One record a slot, from the Light's values and the points' attributes. The one place a
 * pointset light's mapping is written down: a mapped number or colour MULTIPLIES the value
 * on the node (T721's rule); a mapped place, direction or turn stands in its place.
 *
 * What is structural is which attributes are mapped and whether the points are counted. The
 * Light's Type is a VALUE (`shape.z`): a set of lamps, a set of spots and a set of suns are
 * one text, and so is every Cone.
 *
 * THE AIM of a row is `R(orient) · direction`, a unit vector: the Light's Direction (or the
 * mapped vec3f) turned by its Orient (or the mapped quaternion). With Direction (0, −1, 0)
 * and the `orient` of Curve Frames, each lamp of a path shines along its own frame's down.
 *
 * THE CONE of a spot is two cosines: of half the Cone, where its light reaches zero, and of
 * `(1 − Cone Softness)` of that, inside which it is whole (T1589b design, 3.2).
 */
export const lightResolveWgsl = generatedOnce("lightResolveWgsl", buildLightResolveWgsl);
function buildLightResolveWgsl(options: LightResolveOptions): EmittedWgsl {
  const channel = (read: { readonly channel?: string } | undefined): string => (read?.channel === undefined ? "" : `.${read.channel}`);
  const accessors = [
    packedAccessorWgsl("placeAt", LIGHT_SOURCE_PREFIX, options.place),
    ...(options.color === undefined ? [] : [packedAccessorWgsl("colorAt", LIGHT_SOURCE_PREFIX, options.color)]),
    ...(options.intensity === undefined ? [] : [packedAccessorWgsl("intensityAt", LIGHT_SOURCE_PREFIX, options.intensity)]),
    ...(options.range === undefined ? [] : [packedAccessorWgsl("rangeAt", LIGHT_SOURCE_PREFIX, options.range)]),
    ...(options.direction === undefined ? [] : [packedAccessorWgsl("directionAt", LIGHT_SOURCE_PREFIX, options.direction)]),
    ...(options.orient === undefined ? [] : [packedAccessorWgsl("orientAt", LIGHT_SOURCE_PREFIX, options.orient)]),
    ...(options.cone === undefined ? [] : [packedAccessorWgsl("coneAt", LIGHT_SOURCE_PREFIX, options.cone)]),
    ...RECORD_ROWS.map((row) => regionStoreWgsl(`store${titled(row)}`, LIGHT_RECORDS_BINDING, rowOf(row))),
  ].join("\n\n");
  const tone = options.color === undefined ? "params.color.rgb" : "params.color.rgb * colorAt(slot).rgb";
  const intensity = options.intensity === undefined ? "params.color.a" : `params.color.a * intensityAt(slot)${channel(options.intensity)}`;
  const range = options.range === undefined ? "params.shape.x" : `params.shape.x * rangeAt(slot)${channel(options.range)}`;
  const cone = options.cone === undefined ? "params.cone.x" : `params.cone.x * coneAt(slot)${channel(options.cone)}`;
  /* What switches a row off. A mapped range of nothing is a placed light that is off, not one
     that reaches everywhere: a dead slot's attribute is zeros, and the Light's own Range of
     0 keeps its meaning, unlimited. A light that travels needs a way to travel, and a spot
     a cone: a direction or a cone of nothing lights nothing, and is not walked. */
  const lit = [
    "intensity > 0.0",
    ...(options.range === undefined ? [] : ["(range > 0.0 || !placed)"]),
    "(wayLength > 0.0 || !travels)",
    "(coneDegrees > 0.0 || !spot)",
    ...(options.counted === true ? [`slot < ${LIGHT_LIVE_BINDING}[0]`] : []),
  ].join(" && ");
  return wgsl`struct LightResolveParams {
  color: vec4f,             // rgb: the Light's Color, linear. a: its Intensity
  shape: vec4f,             // x: its Range (0 unlimited). y: the falloff law (1 inverse square). z: its Type (0 directional, 1 point, 2 spot)
  aim: vec4f,               // xyz: its Direction
  orient: vec4f,            // its Orient: a unit quaternion that turns Direction
  cone: vec4f,              // x: its Cone, the full angle in degrees. y: its Cone Softness
  count: u32,               // slots to resolve
};

@group(0) @binding(0) var<uniform> params: LightResolveParams;
@group(0) @binding(1) var<storage, read_write> ${LIGHT_RECORDS_BINDING}: array<u32>;
${options.counted === true ? `@group(0) @binding(2) var<storage, read> ${LIGHT_LIVE_BINDING}: array<u32>;\n` : ""}${packedBindingsWgsl(LIGHT_SOURCE_PREFIX, options.groups, 3)}
${accessors}

/* A vector turned by a unit quaternion: right-handed and active, as a Geometry's Orient (T723). */
fn lightTurned(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

@compute @workgroup_size(${LIGHT_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.count) {
    return;
  }
  /* A point light and a spot stand at a place and have a range. A directional light and a
     spot travel one way. */
  let kind = params.shape.z;
  let placed = kind > 0.5;
  let spot = kind > 1.5;
  let travels = !placed || spot;
  let intensity = ${intensity};
  let range = ${range};
  let turn = ${options.orient === undefined ? "params.orient" : "orientAt(slot)"};
  /* A quaternion of nothing (a dead slot's) turns nothing. */
  let way = lightTurned(turn / max(length(turn), 1.0e-6), ${options.direction === undefined ? "params.aim.xyz" : "directionAt(slot)"});
  let wayLength = length(way);
  let coneDegrees = ${cone};
  /* No cone: a row that is not a spot, and a Cone so wide that it is every direction. */
  let every = !spot || coneDegrees >= ${LIGHT_CONE_EVERYWHERE}.0;
  let half = radians(coneDegrees) * 0.5;
  let outer = select(cos(half), ${LIGHT_NO_CONE.outer}.0, every);
  let inner = select(cos(half * (1.0 - clamp(params.cone.y, 0.0, 1.0))), ${LIGHT_NO_CONE.inner}.0, every);
  /* w: the range, 0 unlimited, below 0 off. A directional light reaches everywhere. */
  storePlace(slot, vec4f(placeAt(slot), select(-1.0, select(0.0, max(range, 0.0), placed), ${lit})));
  storeColor(slot, vec4f(${tone} * max(intensity, 0.0), params.shape.y));
  storeAim(slot, vec4f(way / max(wayLength, 1.0e-6), outer));
  /* The cone's inner cosine; the kind; no shadow slot; the source number is the gather's to write. */
  storeCone(slot, vec4f(inner, kind, 0.0, 0.0));
}`;
}

/* ------------------------------------------------------------------------------------ */
/* 2. the Render's gather                                                                */
/* ------------------------------------------------------------------------------------ */

/**
 * ONE SET of records copied into the Render's table: a pointset Light's, or the Render's own
 * named Lights'. A lit draw may bind ONE more buffer (a fully attributed mesh Surface is at
 * seven of the eight a stage is guaranteed, §V588), so the table is what it binds, whatever
 * the Lights are.
 *
 * ONE TEXT for every set of every Render (T1628b): a pass a set, each binding the table and
 * its own records. So a Render gathers as many sets as it lists, and the only limit left is
 * the table's rows. Where a set's rows go in the table and how many it has are VALUES: a set
 * moves in the table from one frame to the next when what it holds starts or stops reaching
 * every pixel (see "Rows a grid cannot leave out").
 *
 * THE SOURCE NUMBER of a row is the set's own (`source.z`) added to the record's: a pointset
 * Light's records carry 0 and take their Light's number here; a Render's named rows carry
 * each its own Light's number, and their set adds 0.
 */
export const lightGatherWgsl = generatedOnce("lightGatherWgsl", buildLightGatherWgsl);
function buildLightGatherWgsl(): EmittedWgsl {
  const accessors = [
    ...RECORD_ROWS.map((row) => regionAccessorWgsl(`set${titled(row)}`, LIGHT_SET_BINDING, rowOf(row))),
    ...RECORD_ROWS.map((row) => tableStoreWgsl(`store${titled(row)}`, row, `${LIGHT_TABLE_BINDING}[${LIGHT_TABLE_HEADER.regionRows}]`)),
  ].join("\n\n");
  return wgsl`struct LightGatherParams {
  source: vec4f,            // x: the table row its records go to. y: how many of them. z: added to each row's source number
};

@group(0) @binding(0) var<uniform> params: LightGatherParams;
@group(0) @binding(1) var<storage, read_write> ${LIGHT_TABLE_BINDING}: array<u32>;
@group(0) @binding(2) var<storage, read> ${LIGHT_SET_BINDING}: array<u32>;

${accessors}

@compute @workgroup_size(${LIGHT_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= u32(params.source.y)) {
    return;
  }
  let row = u32(params.source.x) + slot;
  storePlace(row, setPlace(slot));
  storeColor(row, setColor(slot));
  storeAim(row, setAim(slot));
  let cone = setCone(slot);
  storeCone(row, vec4f(cone.xyz, cone.w + params.source.z));
}`;
}

/* ------------------------------------------------------------------------------------ */
/* 3. the grid: which lights each cell holds                                             */
/* ------------------------------------------------------------------------------------ */

/**
 * Which depth slice a distance in front of the camera falls in, shared VERBATIM by the build
 * and by the lit fragment (§V349): the two must name the same cell for the same place.
 * `span` is the camera's (near, far). Slices are exponential for a perspective camera (each
 * as deep, seen from the eye, as the one before it) and equal for an orthographic one.
 */
export const LIGHT_SLICE_WGSL = `fn lightSliceOf(depth: f32, span: vec2f, slices: f32, orthographic: bool) -> u32 {
  let along = select(log(max(depth, span.x) / span.x) / log(span.y / span.x), (depth - span.x) / (span.y - span.x), orthographic);
  return min(u32(clamp(along, 0.0, 1.0) * slices), u32(slices) - 1u);
}
`;

/**
 * The grid's build. One invocation a cell: its box in view space, then every light of the
 * table against it. ONE text, whatever the table holds: how many rows there are, how many
 * words a cell has and where the cells start are read from the table's header.
 *
 * A light's place in view space is read off the SAME view-projection the draws use (its x
 * and y rows, scaled back by the lens's half-extents) and its depth off the same row the
 * fragment reads (`depthRow`), so the grid cannot disagree with the picture about where a
 * light is, whatever the camera's roll. The tiles are tiles of the picture: column `cx` of
 * `tiles.x` is NDC x from `−1 + 2·cx/tiles.x`, row `cy` counted from the TOP as framebuffer
 * rows are.
 *
 * The grid's own dimensions are VALUES (`grid`), not text: the node passes its constants,
 * and a test may pass one cell and get the picture every light of the view is walked for.
 */
export const lightGridWgsl = generatedOnce("lightGridWgsl", buildLightGridWgsl);
function buildLightGridWgsl(): EmittedWgsl {
  return wgsl`struct LightGridParams {
  viewProjection: mat4x4f,
  depthRow: vec4f,          // dot(depthRow, vec4f(world, 1)) is the distance in front of the camera
  lens: vec4f,              // xy: the view's half-extents at distance 1 (orthographic: of the box). z: near. w: far
  grid: vec4f,              // tiles across, tiles down, depth slices. w: 1 orthographic
};

@group(0) @binding(0) var<uniform> params: LightGridParams;
@group(0) @binding(1) var<storage, read_write> ${LIGHT_TABLE_BINDING}: array<u32>;

${tableReadWgsl("lightPlaceAt", "place")}

${LIGHT_SLICE_WGSL}
/* The distance in front of the camera at which a slice starts. */
fn lightSliceDepth(slice: f32, span: vec2f, slices: f32, orthographic: bool) -> f32 {
  let along = slice / slices;
  return select(span.x * pow(span.y / span.x, along), span.x + (span.y - span.x) * along, orthographic);
}

@compute @workgroup_size(${LIGHT_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let tiles = vec3u(params.grid.xyz);
  let cell = gid.x;
  if (cell >= tiles.x * tiles.y * tiles.z) {
    return;
  }
  let cx = cell % tiles.x;
  let cy = (cell / tiles.x) % tiles.y;
  let cz = cell / (tiles.x * tiles.y);
  let orthographic = params.grid.w > 0.5;
  let span = params.lens.zw;
  /* The cell's box, grown: see LIGHT_CELL_MARGIN. */
  let d0 = lightSliceDepth(f32(cz), span, params.grid.z, orthographic);
  let d1 = lightSliceDepth(f32(cz + 1u), span, params.grid.z, orthographic);
  let pad0 = select(d0, span.y - span.x, orthographic) * ${LIGHT_CELL_MARGIN};
  let pad1 = select(d1, span.y - span.x, orthographic) * ${LIGHT_CELL_MARGIN};
  let z0 = d0 - pad0;
  let z1 = d1 + pad1;
  let x0 = (-1.0 + 2.0 * f32(cx) / params.grid.x - ${LIGHT_CELL_MARGIN}) * params.lens.x;
  let x1 = (-1.0 + 2.0 * f32(cx + 1u) / params.grid.x + ${LIGHT_CELL_MARGIN}) * params.lens.x;
  let y1 = (1.0 - 2.0 * f32(cy) / params.grid.y + ${LIGHT_CELL_MARGIN}) * params.lens.y;
  let y0 = (1.0 - 2.0 * f32(cy + 1u) / params.grid.y - ${LIGHT_CELL_MARGIN}) * params.lens.y;
  /* A perspective tile widens with distance; an orthographic one does not. */
  let w0 = select(z0, 1.0, orthographic);
  let w1 = select(z1, 1.0, orthographic);
  let low = vec3f(min(x0 * w0, x0 * w1), min(y0 * w0, y0 * w1), z0);
  let high = vec3f(max(x1 * w0, x1 * w1), max(y1 * w0, y1 * w1), z1);
  /* Every bound is read from the table: this text holds no count of lights. The rows that
     reach every pixel are the first ones, and no cell holds them: the lit draw walks them
     with a loop of their own. */
  let words = ${LIGHT_TABLE_BINDING}[${LIGHT_TABLE_HEADER.words}];
  let cells = ${LIGHT_TABLE_BINDING}[${LIGHT_TABLE_HEADER.cells}];
  let always = ${LIGHT_TABLE_BINDING}[${LIGHT_TABLE_HEADER.always}];
  let rows = ${LIGHT_TABLE_BINDING}[${LIGHT_TABLE_HEADER.rows}];
  for (var word = 0u; word < words; word++) {
    var bits = 0u;
    let first = word * 32u;
    let last = min(first + 32u, rows);
    for (var slot = max(first, always); slot < last; slot++) {
      let place = lightPlaceAt(slot);
      /* Off: in no cell. */
      if (place.w < 0.0) {
        continue;
      }
      /* A row with no range past the always-walked ones is in every cell: none should be
         there (the Render puts them first), and one that is still lights, as the placed
         light the walk takes every row of a cell for. */
      if (place.w > 0.0) {
        let world = vec4f(place.xyz, 1.0);
        let clip = params.viewProjection * world;
        let view = vec3f(clip.x * params.lens.x, clip.y * params.lens.y, dot(params.depthRow, world));
        let away = view - clamp(view, low, high);
        if (dot(away, away) > place.w * place.w) {
          continue;
        }
      }
      bits |= 1u << (slot - first);
    }
    ${LIGHT_TABLE_BINDING}[cells + cell * words + word] = bits;
  }
}`;
}

/* ------------------------------------------------------------------------------------ */
/* 4. the lit draw's half                                                                */
/* ------------------------------------------------------------------------------------ */

/** The uniform rows a lit draw carries for the grid, in the scene's params block. */
export const LIGHT_GRID_FIELDS_WGSL = `  lightGrid: vec4f,         // T1589b: tiles across, tiles down, depth slices. w: 1 orthographic
  lightLens: vec4f,         // the scene surface's width and height in pixels, the camera's near and far
  lightDepth: vec4f,        // dot(lightDepth, vec4f(world, 1)) is the distance in front of the camera
`;

/**
 * The table's binding, its record accessors and the slice function, at module scope of a lit
 * draw. One string, whatever the table holds. The lit draw reads the table by ELEMENTS of
 * four words (see "Two views of the one buffer").
 */
export function lightGridDeclarationsWgsl(): string {
  return `@group(0) @binding(${LIGHT_TABLE_BINDING_NUMBER}) var<storage, read> ${LIGHT_TABLE_BINDING}: array<vec4u>;
${RECORD_ROWS.map((row) => tableElementReadWgsl(`lightRecord${titled(row)}`, row)).join("\n")}
${LIGHT_SLICE_WGSL}`;
}

/**
 * THE WALK, in the fragment stage: `block` once for every row of the table that lights this
 * fragment. ONE string, whatever the table holds: every bound is read from its header.
 *
 *  - THE ROWS THAT REACH EVERY PIXEL, the first `always` rows, in three runs (below).
 *  - THE ROWS WITH A RANGE: the set bits of this pixel's cell, each left at once when its
 *    range does not hold the fragment. Skipped whole when the table has none.
 *
 * `block` is the lit generator's OWN light block, handed the three rows it reads as
 * expressions: there is one emitter of a light's shading, and a block of a casting Light
 * and a row of the table differ only in where their rows come from. A row's colour already
 * carries its intensity, so the block's intensity slot is free and carries what a spot's
 * cone leaves of the light: its `lightMeta` is (kind, share, law, range), the share 1 for a
 * row with no cone. Its vector is where it stands, or for a directional row the way it
 * travels.
 *
 * A SPOT's share is a smoothstep on the cosine between the way it shines and the way to
 * the fragment: 0 at the cone's outer cosine, 1 from its inner one. Written out, since
 * `smoothstep` with equal edges (a Cone Softness of 0) has no defined value. A fragment the
 * cone leaves nothing for is left before the row's colour is read. A spot is in every cell
 * its RANGE sphere touches: the build does not know its cone (T1625b).
 *
 * ## The rows with a range are placed lights: their kind is not asked
 *
 * A directional light has no range, so the Render stands every one of them among the
 * always-walked rows, by the Light's own values, every frame it compiles. A row found
 * through a cell is therefore a point light or a spot: its vector is its place, and the
 * turn does not test its kind. Measured 2026-10-06 beside the turn that did (the same
 * method as below, lights with a Range that all reach every pixel, three takes, the same
 * pictures): 2.25, 2.19 and 2.54 of the reference against 2.41, 2.43 and 2.91 at 64 lights,
 * and 9.13, 8.70 and 8.70 against 9.77, 9.59 and 9.31 at 256. A directional row written
 * past the always-walked ones by some other hand would be shaded as a light at its place:
 * nothing in the app writes one there.
 *
 * ## Every row's cone is tested, where rows of more than one kind are walked
 *
 * The rows found through the grid, and the first run of the always-walked rows (a pointset's
 * rows that reach every pixel, a named spot with a cone and no Range), are walked by ONE
 * shape of turn whether the row has a cone or not: it is tested, and a row with no cone holds two
 * cosines that leave all of its light (`LIGHT_NO_CONE`: no direction's cosine is under −2),
 * so its share is exactly 1 and its picture the one it had. The walk that tested only the
 * rows that are spots was measured beside this one (T1589b slice 2; alternated in one
 * process, a reference pass beside every frame, the same pictures): a point row costs the
 * same either way (0.67 and 0.69 of the reference against 0.68 and 0.65, at 64 lights that
 * all reach every pixel), and a spot of Cone 30 costs 0.27 to 0.29 here against 0.43 to 0.44
 * there. A second branch on the kind is what cost.
 *
 * ## The named point lights and the named suns: a loop each, TWO ROWS A TURN
 *
 * MEASURED, NOT REASONED (2026-10-06; Apple GPU under Metal through Dawn; the lit draw alone
 * of a PBR floor filling 7680 x 4320, a fixed reference pass beside every frame, every form
 * alternated with main's unrolled blocks in one process, two takes, the pictures the same to
 * one half-float step). A Render's named Lights were unrolled blocks before T1623b, and
 * nearly every shipped Render has one to nine of them with no Range, so a row there has to
 * cost what a block cost. Over blocks, at 1, 2, 4, 8 and 9 lights (one or two suns, the rest
 * point lights with no Range):
 *
 *   one loop for every row, kind and cone tested (the shape above)   +42 +50 +62 +62 +56 %
 *   the same with the three reads' addresses hoisted by hand         no gain
 *   the same with a branch on the kind around the aim and the cone   +43 to +50 % (the
 *                                                                    compiler flattens it)
 *   a loop a kind, one row a turn, an off test                       +16 +15 +17 +17 +13 %
 *   a loop a kind, one row a turn, no off test                       +18 to +20 % at 1,
 *                                                                    +8 to +16 % at 4, +2 % at 8
 *   a loop a kind, TWO rows a turn, no off test                      +0 to +4 % at 1, equal
 *                                                                    at 4 and 8, −7 % at 9
 *   three and four rows a turn                                       the same as two
 *   the first eight rows at literal row numbers, no loop             +5 +2 −4 −4 %; 31 KB of
 *                                                                    text against 22
 *
 * So the kind test, the cone and the off test are what a row paid over a block, and they go
 * where the CPU can sort the rows: a named Light's kind and whether it is off are values the
 * Render has, so it orders its named rows by kind and leaves the off ones out of these runs.
 * A point row reads its place and its colour; a sun its aim and its colour.
 *
 * WHY TWO ROWS A TURN COSTS LESS THAN ONE IS NOT KNOWN. The work a row is the same, and it
 * was measured twice. Do not "simplify" the loops to one row a turn without measuring the
 * same way. The second row of a turn stands under a test of the loop's bound, so each turn
 * holds one light's sums in the open and one under a test: B260's chain (more than eight
 * lights' sums in one straight line) cannot form at any count.
 *
 * As built, with the any-kind loop ahead of the two and the header's second row read: +12
 * +14 +7 +3 −2 % at 1, 2, 4, 8 and 9, and −8, −16 and −25 % at 16, 32 and 64 against blocks
 * each under B260's guard. What is left at 1 and 2 is in the two loops themselves (the
 * any-kind loop and the ranged half taken out of the text: 0.364 of the reference against
 * 0.373, and 0.335 for one block).
 *
 * THE ORDER OF THE SUMS is the table's: rows of any kind, point lights, suns, then the cell's
 * bits by row number; within each the Render's list order. It differs from the order the
 * blocks summed in (the list's), so a picture may move by the last bit of a half float where
 * three or more lights meet.
 */
export function lightTableWalkWgsl(block: (rows: { readonly meta: string; readonly color: string; readonly vector: string }) => string): string {
  const indented = (text: string, indent: string): string =>
    text
      .split("\n")
      .map((line) => (line === "" ? line : `${indent}${line}`))
      .join("\n");
  /* A row of ANY kind, shaded, at an indent: the block comes with two spaces of its own. */
  const ofAnyKind = block({ meta: "vec4f(lightCone.y, lightShare, lightTone.w, lightPlace.w)", color: "lightTone", vector: "lightAt" });
  /* A row found through a cell is a PLACED light (see "The rows with a range"): its kind is not asked. */
  const placed = block({ meta: "vec4f(1.0, lightShare, lightTone.w, lightPlace.w)", color: "lightTone", vector: "lightPlace" });
  const row = (slot: string, ranged: boolean, indent: string): string => {
    const lines = [
      `let lightPlace = lightRecordPlace(${slot});`,
      ...(ranged
        ? []
        : [
            "/* A slot that is off: a dead point of a counted set. */",
            "if (lightPlace.w < 0.0) {",
            "  continue;",
            "}",
          ]),
      "let lightReach = lightPlace.xyz - input.world;",
      ...(ranged ? ["if (lightPlace.w > 0.0 && dot(lightReach, lightReach) >= lightPlace.w * lightPlace.w) {", "  continue;", "}"] : []),
      `let lightCone = lightRecordCone(${slot});`,
      `let lightAim = lightRecordAim(${slot});`,
      ...(ranged ? [] : ["var lightAt = lightPlace;", "if (lightCone.y < 0.5) {", "  lightAt = lightAim;", "}"]),
      "let lightOff = dot(-lightReach / max(length(lightReach), 1.0e-6), lightAim.xyz);",
      "let lightFade = clamp((lightOff - lightAim.w) / max(lightCone.x - lightAim.w, 1.0e-6), 0.0, 1.0);",
      "let lightShare = lightFade * lightFade * (3.0 - 2.0 * lightFade);",
      "if (lightShare <= 0.0) {",
      "  continue;",
      "}",
      `let lightTone = lightRecordColor(${slot});`,
    ];
    return `${lines.map((line) => `${indent}${line}`).join("\n")}\n${indented(ranged ? placed : ofAnyKind, indent.slice(2))}`;
  };
  /* The rows of ONE kind, from `first` up to `last`, `LIGHT_ROWS_A_TURN` of them a turn. */
  const ofOneKind = (first: string, last: string, reads: readonly string[], rows: { readonly meta: string; readonly color: string; readonly vector: string }): string => {
    const body = indented(block(rows), "      ");
    const turn = (at: number): string => {
      const lines = [`let lightRow = lightBase${at === 0 ? "" : ` + ${at}u`};`, ...reads].map((line) => `        ${line}`).join("\n");
      return `${at === 0 ? "      {" : `      if (lightBase + ${at}u < ${last}) {`}\n${lines}\n${body}      }\n`;
    };
    return `    for (var lightBase = ${first}; lightBase < ${last}; lightBase += ${LIGHT_ROWS_A_TURN}u) {\n${Array.from({ length: LIGHT_ROWS_A_TURN }, (_, at) => turn(at)).join("")}    }\n`;
  };
  return `  {
    /* The header: x the rows a region holds, y the words of a cell, z where the cells start (a word index), w the rows that reach every pixel. */
    let lightHeader = ${LIGHT_TABLE_BINDING}[0];
    /* And: x the rows that are live, y where the always-walked rows of any kind end, z where the point rows after them end. */
    let lightParts = ${LIGHT_TABLE_BINDING}[1];
    /* Rows of any kind that reach every pixel: a pointset's, a spot with no Range. */
    for (var lightRow = 0u; lightRow < lightParts.y; lightRow++) {
${row("lightRow", false, "      ")}    }
    /* The point lights with no Range. */
${ofOneKind("lightParts.y", "lightParts.z", ["let lightPlace = lightRecordPlace(lightRow);", "let lightTone = lightRecordColor(lightRow);"], { meta: "vec4f(1.0, 1.0, lightTone.w, 0.0)", color: "lightTone", vector: "lightPlace" })}    /* The directional lights. */
${ofOneKind("lightParts.z", "lightHeader.w", ["let lightAim = lightRecordAim(lightRow);", "let lightTone = lightRecordColor(lightRow);"], { meta: "vec4f(0.0, 1.0, 0.0, 0.0)", color: "lightTone", vector: "lightAim" })}    /* The rows with a range, when the table has any. */
    if (lightParts.x > lightHeader.w) {
      let lightTile = min(vec2u(input.position.xy * params.lightGrid.xy / params.lightLens.xy), vec2u(params.lightGrid.xy) - vec2u(1u));
      let lightSlice = lightSliceOf(dot(params.lightDepth, vec4f(input.world, 1.0)), params.lightLens.zw, params.lightGrid.z, params.lightGrid.w > 0.5);
      let lightWords = lightHeader.y;
      let lightCell = lightHeader.z + (lightTile.x + u32(params.lightGrid.x) * (lightTile.y + u32(params.lightGrid.y) * lightSlice)) * lightWords;
      for (var lightWord = 0u; lightWord < lightWords; lightWord++) {
        let lightWordAt = lightCell + lightWord;
        var lightBits = ${LIGHT_TABLE_BINDING}[lightWordAt >> 2u][lightWordAt & 3u];
        while (lightBits != 0u) {
          let lightSlot = lightWord * 32u + countTrailingZeros(lightBits);
          lightBits &= lightBits - 1u;
${row("lightSlot", true, "          ")}        }
      }
    }
  }
`;
}
