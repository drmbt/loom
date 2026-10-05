import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import { codeParametersLast } from "../../domain/parameters/code.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import {
  ATTRIBUTE_STRIDES,
  COMPONENT_COUNTS,
  POINT_ATTRIBUTE_TYPES,
  type PointAttributeSchema,
  type PointAttributeType,
} from "../../points/attributes.ts";
import {
  ARC_CHAIN_SECTIONS,
  CURVE_BASES,
  CURVE_TABLE_LIMIT,
  curvePointCount,
  curveSpans,
  parseCurveTable,
  type CurveBasis,
  type CurveOptions,
  type CurveTablePoint,
  type Vec3,
} from "../../points/curve.ts";
import { formatTopology } from "../../points/topology.ts";
import { curveWgsl, type CurveCarriedAttribute, type CurveShaderOptions } from "../shaders/curve.wgsl.ts";
import { readCompileInputs } from "./compile-context.ts";
import { readNumber, readVector, type Params } from "./parameter-readers.ts";
import { packedPointStorage } from "./point-storage.ts";
import { stripsOnEdge } from "./point-strips.ts";
import { resolveScalarMap } from "./points.ts";

/**
 * Curve (T1586b) — CONTROL POINTS IN, AN INTERPOLATED STRIP OUT.
 *
 * A handful of control points becomes a curve of `Segments` points per span. It is
 * TouchDesigner's Line POP and Line Divide POP, and Notch's Spline
 * (`docs/curve-family-design-2026-10-05.md`, section 3.2). What comes out is a strip like
 * any other: Resample places points on it by distance, Curve Frames measures it, and a
 * Geometry draws things along it.
 *
 * ⚑ THE CONTROL POINTS COME FROM ONE OF TWO PLACES. Wire a pointset to `Control` and each
 * of its strips is one curve's control points, in slot order — a kernel's output behind a
 * Topology node, a Line, another Curve. Leave it unwired and the node reads its own table
 * (`Points`). This is Point Kernel's rule for its optional input.
 *
 * ⚑ THE TABLE IS WHAT A CPU READER CAN FOLLOW (the design's D7). A camera riding a path
 * runs on the CPU every frame, and a curve's points are in a GPU buffer; reading them back
 * each frame is the stall §V144 forbids. A curve authored on this node is different: its
 * control points are parameters, so `authoredCurve` below hands a CPU reader the very
 * points and options this node compiles from, and `points/curve.ts` evaluates them with no
 * latency. The same node feeds the GPU strip a tunnel is swept along, so the camera and
 * the tunnel cannot drift apart. A WIRED control set has no CPU copy; a CPU reader refuses
 * it by name until a measured curve exists (§T1586b C2).
 *
 * ⚑ WHICH CURVES KEEP THEIR LENGTH (section 3.5). A spline's length is whatever its control
 * points make it, and it changes as they move: a cubic through a tentacle's joints
 * stretched its rings to twice their pitch (the consumer's finding, §T1561b). The ARC is
 * the basis for a body of fixed length: one arc of constant curvature per span, whose
 * length is an INPUT. For a given length and chord there is exactly one such arc up to the
 * side it bows to, so it has no second solution to jump to. Linear keeps the sum of its
 * chords. The others are for paths whose length is free.
 *
 * ⚑ THE ARC CHAIN IS THE BODY THAT CHANGES POSE (slice 8). Several arcs end to end, each
 * with a length and a bend, each leaving the way the one before it arrived. Here a control
 * point is not a point to pass through: it is a SECTION, and only the first one's position
 * is read, as where the chain starts. Its length is the sum of its sections', whatever
 * shape it takes, and it is a plain function of its numbers with no solve in it — so
 * blending two poses is blending their lengths and bends, and nothing can jump. That is
 * what a tentacle that both holds and trails needs, and what one Arc cannot give it.
 *
 * ⚑ IT PUBLISHES NO TANGENT AND NO FRAME (D4): Curve Frames is the one node that measures a
 * strip. Every float attribute the control points carry is interpolated LINEARLY along its
 * span — a radius or a colour must not overshoot the way a position's basis can — and an
 * integer one holds the control point at its span's start (and the last one's where an open
 * strip ends on it, so a point on a control point always carries that control point's own).
 *
 * STATELESS and clock-free: one thread per output point, each from at most four control
 * points (`nodes/shaders/curve.wgsl.ts`), so there is nothing to reset on a seek (§V170).
 */

const CODE = "node.points.curve";
const MAX_POINTS = 1_000_000;
const DEGREES_TO_RADIANS = Math.PI / 180;

const BASIS_OPTIONS: ReadonlyArray<{ readonly value: CurveBasis; readonly label: string }> = [
  { value: "linear", label: "Linear" },
  { value: "catmullRom", label: "Catmull-Rom" },
  { value: "cardinal", label: "Cardinal" },
  { value: "bspline", label: "B-Spline" },
  { value: "bezier", label: "Bezier" },
  { value: "arc", label: "Arc" },
  { value: "arcChain", label: "Arc Chain" },
];

/** A gentle S: a default that reads as a curve the moment the node is placed. */
const DEFAULT_POINTS = "[[-1, 0, 0], [-0.35, 0.5, 0], [0.35, -0.5, 0], [1, 0, 0]]";

const HANDLE_IN = "handleIn";
const HANDLE_OUT = "handleOut";

/** What a table publishes beside position: each control point's scale and roll, blended along its span. */
const TABLE_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "roll", type: "f32", default: [0] },
  { name: "scale", type: "f32", default: [1] },
];

/**
 * The attributes a Curve owns, in the order its packed buffer lays them out. Exported
 * because a reader of the buffer must slice it with the layout the node allocated, never a
 * second copy of the arithmetic (§V349).
 *
 * From a table (`carried` undefined): position, roll, scale. From a wired control set:
 * position, then everything else the control points carry, by name — except a Bezier's two
 * handles, which describe the control polygon and mean nothing on the curve.
 */
export function curveAttributes(
  carried: ReadonlyArray<{ readonly name: string; readonly type: PointAttributeType }> | undefined,
  basis: CurveBasis,
): ReadonlyArray<PointAttributeSchema> {
  if (carried === undefined) return TABLE_ATTRIBUTES;
  const others = carried
    .filter((attribute) => attribute.name !== "position")
    .filter((attribute) => !(basis === "bezier" && (attribute.name === HANDLE_IN || attribute.name === HANDLE_OUT)))
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    ...others.map((attribute) => ({ name: attribute.name, type: attribute.type, default: Array<number>(COMPONENT_COUNTS[attribute.type]).fill(0) })),
  ];
}

const basisOf = (parameters: Readonly<Record<string, unknown>>): CurveBasis =>
  (CURVE_BASES as ReadonlyArray<string>).includes(parameters["basis"] as string) ? (parameters["basis"] as CurveBasis) : "catmullRom";

/** The curve's shape as its parameters state it — the one reading the node and a CPU reader share. */
function curveOptionsOf(parameters: Params, closed: boolean): CurveOptions {
  const bow = readVector(parameters, "bow", [0, -1, 0]);
  const bend = readVector(parameters, "bend", [0, 0]);
  return {
    closed,
    basis: basisOf(parameters),
    segments: Math.max(1, Math.round(readNumber(parameters, "segments", 16))),
    tension: Math.min(1, Math.max(0, readNumber(parameters, "tension", 0))),
    clamped: parameters["clamped"] !== false,
    arcLength: Math.max(0, readNumber(parameters, "arcLength", 1)),
    arcLengthUnit: parameters["arcLengthUnit"] === "chords" ? "chords" : "metres",
    bow: [bow[0] as number, bow[1] as number, bow[2] as number],
    bend: [bend[0] as number, bend[1] as number],
    maxTurn: Math.min(360, Math.max(0, readNumber(parameters, "maxTurn", 360))) * DEGREES_TO_RADIANS,
  };
}

/**
 * T1586b D7 — A CURVE AUTHORED ON THE NODE, AS A CPU READER NEEDS IT: its control points and
 * its options, from the node's resolved parameters. `evaluateCurve(points.map(p => p.position),
 * options)` is then the strip this node writes on the GPU, to f32 rounding — the Dawn tests
 * hold that.
 *
 * It answers for the table only. Whether the node's control input is wired is a fact about
 * the graph, not about its parameters, so the caller checks that first: a wired Curve is
 * computed on the GPU and has no CPU copy.
 */
export function authoredCurve(
  parameters: Params,
): { readonly points: ReadonlyArray<CurveTablePoint>; readonly options: CurveOptions } | { readonly error: string } {
  const table = parseCurveTable(parameters["points"] ?? DEFAULT_POINTS);
  if ("error" in table) return table;
  const options = curveOptionsOf(parameters, parameters["closed"] === true);
  if (options.basis === "bezier") {
    return { error: "the table holds no Bezier handles; wire control points that carry handleIn and handleOut, or pick another basis" };
  }
  if (options.basis === "arcChain") {
    return {
      error:
        "an Arc Chain is made of sections, and the table holds control points; wire a pointset with one point per section and map Arc Length and Bend from it, or pick another basis",
    };
  }
  return { points: table.points, options };
}

const notBasis = (basis: CurveBasis | ReadonlyArray<CurveBasis>, why: string) => (values: Readonly<Record<string, unknown>>): string | null =>
  (typeof basis === "string" ? [basis] : basis).includes(basisOf(values)) ? null : why;

export const pointCurveNode: NodeDefinition = {
  type: "pointCurve",
  version: 1,
  title: "Curve",
  category: "points",
  description:
    "Turns control points into a curve: Segments points per span, as a strip. Wire a pointset to Control (each of its strips is one curve's control points), or leave it unwired and type the points into the node. Linear joins them with straight segments. Catmull-Rom, Cardinal, B-Spline and Bezier are splines, whose length is whatever the points make it. Arc is one arc of constant curvature per span with a GIVEN length, bowing to the Bow side — for a tentacle, a cable or a spine, which must not stretch; a bow direction that sweeps through the chord flips the arc's side in one frame. Arc Chain is several such arcs end to end, each control point a section with its own Arc Length and Bend, leaving the first control point along its Start Frame — a body that changes pose without stretching, with nothing to solve and so nothing to jump. Follow it with Resample and Curve Frames.",
  tags: ["points", "curve", "spline", "strips", "bezier", "catmull-rom", "b-spline", "arc", "line", "path", "interpolate"],
  inputs: [
    {
      id: "in",
      label: "Control",
      optional: true,
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "Optional control points: a pointset whose edge claims strips (a Line, a kernel behind a Topology node set to Strips). Each strip is one curve. Unwired, the node reads its own Points table.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "One strip per control strip, Segments points per span and one more to end an open strip. Every float attribute the control points carry is interpolated linearly along its span (an integer holds the control point at its span's start); a table publishes scale and roll. No tangents or frames: Curve Frames measures those.",
    },
  ],
  parameters: codeParametersLast({
    basis: {
      type: "enum",
      label: "Basis",
      default: "catmullRom",
      compileTime: true,
      // §V831: APPEND only.
      options: [...BASIS_OPTIONS],
      description:
        "Linear: straight spans. Catmull-Rom: a smooth curve THROUGH every control point (centripetal, so uneven spacing does not loop). Cardinal: the same with a Tension. B-Spline: smoother still, passing near its control points rather than through them. Bezier: through every point, shaped by each point's handleIn and handleOut attributes. Arc: one arc of constant curvature per span with a given length. Arc Chain: arcs end to end, one per control point, each with its own length and bend; only the first control point's position is read, as the start.",
    },
    segments: {
      type: "number",
      label: "Segments",
      default: 16,
      min: 1,
      max: 1024,
      range: "bounded",
      step: 1,
      compileTime: true,
      description: "Output points per span (from one control point to the next; per section of an Arc Chain). Changing it reallocates.",
    },
    tension: {
      type: "number",
      label: "Tension",
      default: 0,
      min: 0,
      max: 1,
      range: "bounded",
      step: 0.01,
      inactiveWhen: notBasis("cardinal", "Only the Cardinal basis has a tension."),
      description: "0 is Catmull-Rom's tangent; 1 flattens every tangent, so the curve runs straight from point to point.",
    },
    clamped: {
      type: "boolean",
      label: "Clamped",
      default: true,
      compileTime: true,
      inactiveWhen: notBasis("bspline", "Only a B-Spline can stop short of its end control points."),
      description:
        "On, an open B-Spline reaches its first and last control points (the ends are mirrored). Off, it is the plain uniform spline: it needs four control points and has two spans fewer.",
    },
    arcLength: {
      type: "number",
      label: "Arc Length",
      default: 1,
      min: 0,
      range: "floor",
      step: 0.01,
      inactiveWhen: notBasis(["arc", "arcChain"], "Only the Arc and the Arc Chain have a length to keep."),
      description:
        "Arc: the length of each span's arc. Longer than the span's chord, the arc bows; equal or shorter, it is a straight line of that length toward the next control point and stops short of it. Arc Chain: the length of each section, in metres. In Map mode an f32 attribute (or one channel of a float vector) gives each span or section its own, read at its control point.",
    },
    arcLengthUnit: {
      type: "enum",
      label: "Length In",
      default: "metres",
      options: [
        { value: "metres", label: "Metres" },
        { value: "chords", label: "Chords" },
      ],
      inactiveWhen: notBasis("arc", "Only the Arc measures its length against a chord; an Arc Chain's sections are in metres."),
      description:
        "Metres: the arc's own length, kept as the ends move — a body. Chords: a multiple of the span's chord (1 is straight, 1.2 has a fifth of slack) — a festoon that keeps its droop as the ends move.",
    },
    bow: {
      type: "vector",
      size: 3,
      label: "Bow",
      default: [0, -1, 0],
      inactiveWhen: notBasis("arc", "Only an arc bows."),
      description:
        "The side each arc bulges to: only the part of this direction square to the chord counts. Keep it off the chord and the arc moves continuously with its ends; a bow that sweeps through the chord flips the arc to the other side in one frame. In Map mode a vec3f attribute gives each span its own, read at its first control point.",
    },
    maxTurn: {
      type: "number",
      label: "Max Turn",
      default: 360,
      min: 0,
      max: 360,
      range: "bounded",
      unit: "degrees",
      inactiveWhen: notBasis("arc", "Only an arc turns."),
      description:
        "The most one arc may turn. Slack that would bow it further is not laid out: the arc is shorter than asked and still ends on its control point. Past 180 a bow swells beyond its own ends.",
    },
    bend: {
      type: "vector",
      size: 2,
      label: "Bend",
      default: [0, 0],
      inactiveWhen: notBasis("arcChain", "Only an Arc Chain's sections bend by a number; an Arc's bend comes from its length."),
      description:
        "Arc Chain: how sharply each section curls, as its turn per metre about the chain's own X and about its Y — the chain leaves along its Z. The size is the curvature (1 is a circle of radius 1 metre; 0, 0 is straight). About +Y curls toward the frame's +X, about +X toward its −Y. In Map mode a vec2f attribute gives each section its own.",
    },
    startOrient: {
      type: "string",
      label: "Start Frame",
      default: "",
      compileTime: true,
      inactiveWhen: notBasis("arcChain", "Only an Arc Chain starts from a frame; the other bases follow their control points."),
      description:
        "Arc Chain: the name of a vec4f quaternion attribute, read at each strip's first control point: the chain leaves along its +Z, with its +X and +Y as the axes the first section bends about — a socket's own orientation. Empty: the chain leaves along +Z, with +Y up. The same attribute can seed Curve Frames afterwards.",
    },
    closed: {
      type: "boolean",
      label: "Closed",
      default: false,
      compileTime: true,
      description:
        "Table only: the last control point joins the first. A wired control set says so itself, on its edge (a Topology node's Wrap U).",
    },
    points: {
      type: "code",
      language: "json",
      label: "Points",
      default: DEFAULT_POINTS,
      compileTime: true,
      description: `The node's own control points, read while Control is unwired: a JSON list, one entry per point — [x, y, z], [x, y, z, scale] or [x, y, z, scale, roll]. Scale (default 1) and roll (degrees, default 0) are published as attributes for a sweep or for Curve Frames. Up to ${CURVE_TABLE_LIMIT} points; wire a pointset for more. A curve typed here is one a camera or a rigid object can follow on the value graph.`,
    },
  }),
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters, parameterMaps } = readCompileInputs(context);
    const refuse = (message: string, suggestion?: string, code = CODE): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        { severity: "error", code, message: `Node "${nodeId}": ${message}`, nodeId, ...(suggestion === undefined ? {} : { suggestion }) },
      ],
    });

    const basis = basisOf(parameters);
    const upstream = inputs["in"]?.pointset;
    const wired = inputs["in"] !== undefined;
    if (wired && upstream === undefined) {
      return refuse("the control edge carries no resolved pointset payload (producer predates T296?).", undefined, "node.points.edge");
    }

    // §V288: a map this node cannot honour refuses BY NAME rather than reading the static.
    const mappable = !wired ? [] : basis === "arc" ? ["arcLength", "bow"] : basis === "arcChain" ? ["arcLength", "bend"] : [];
    const unhonoured = Object.keys(parameterMaps).filter((key) => !mappable.includes(key)).sort();
    if (unhonoured.length > 0) {
      const why = !wired
        ? "there is no control pointset wired to map from"
        : basis === "arc"
          ? 'an Arc maps only "arcLength" and "bow"'
          : basis === "arcChain"
            ? 'an Arc Chain maps only "arcLength" and "bend"'
            : 'only the Arc ("arcLength" and "bow") and the Arc Chain ("arcLength" and "bend") map anything';
      return refuse(
        `${unhonoured.join(", ")} ${unhonoured.length === 1 ? "is" : "are"} in map mode, but ${why}.`,
        "Switch it back to Constant, or drive it through the value graph instead.",
        "node.parameter.map",
      );
    }

    /* ── Where the control points are, and how many ── */
    let colsIn: number;
    let rows: number;
    let closed: boolean;
    let table: ReadonlyArray<CurveTablePoint> | undefined;
    if (upstream !== undefined) {
      const claimed = stripsOnEdge(nodeId, "Curve", upstream);
      if ("refusal" in claimed) return claimed.refusal;
      if (upstream.count !== undefined) {
        return refuse(
          "the control pointset carries a GPU live count, and a strip's slots are fixed — the slots past the count are not control points.",
          "Wire a static producer, or a kernel behind a Topology node set to Strips.",
        );
      }
      if (upstream.pairs["live"] !== undefined) {
        /* Padding repeats a strip's end point. As CONTROL points those repeats are real: a
           spline would be pulled onto them and the spans between them come out stacked. */
        return refuse(
          "the control pointset carries live: some of its slots are padding, which a curve would read as repeated control points.",
          "Resample it by Count first, so every slot is a point.",
        );
      }
      colsIn = claimed.strips.cols;
      rows = claimed.strips.rows;
      closed = claimed.strips.closed;
      if (basis === "arcChain") {
        /* A chain runs forward from a start: it has an end, and nothing brings that end
           back to the start. A closed claim is one this basis cannot honour (§V288). */
        if (closed) {
          return refuse(
            "the control strips are closed, and an Arc Chain runs forward from its first section to its last: nothing brings its end back to its start.",
            "Open the claim (a Topology node's Wrap U), or pick a basis that passes through its control points.",
          );
        }
        if (colsIn > ARC_CHAIN_SECTIONS) {
          return refuse(
            `each control strip has ${colsIn} points, and an Arc Chain takes one SECTION per control point, at most ${ARC_CHAIN_SECTIONS}: every point of the chain composes the sections before its own.`,
            `Use ${ARC_CHAIN_SECTIONS} sections or fewer per strip; Segments, not sections, is what makes the chain smooth.`,
          );
        }
      }
    } else {
      const authored = authoredCurve(parameters);
      if ("error" in authored) return refuse(`${authored.error}.`);
      table = authored.points;
      colsIn = table.length;
      rows = 1;
      closed = authored.options.closed;
    }

    const options = curveOptionsOf(parameters, closed);
    const spans = curveSpans(colsIn, options);
    const unclamped = basis === "bspline" && options.clamped === false && !closed;
    if (unclamped && colsIn < 4) {
      return refuse(
        `an unclamped B-Spline needs four control points to make one span, and ${upstream === undefined ? "the table holds" : "each strip has"} ${colsIn}.`,
        "Turn Clamped on, or give it more control points.",
      );
    }
    const colsOut = curvePointCount(colsIn, options);
    const capacity = colsOut * rows;
    if (capacity > MAX_POINTS) {
      return refuse(
        `${rows} strips of ${colsOut} points are ${capacity} points, over the ${MAX_POINTS} a pointset holds.`,
        "Lower Segments.",
        "node.points.capacity",
      );
    }

    /* ── The uniform block, as ONE list the shader's struct and the pass's record both read ── */
    const members: Array<{ name: string; type: string; value: number | readonly number[] }> = [
      { name: "colsIn", type: "u32", value: colsIn },
      { name: "rows", type: "u32", value: rows },
      { name: "closed", type: "u32", value: closed ? 1 : 0 },
      { name: "colsOut", type: "u32", value: colsOut },
      { name: "segments", type: "u32", value: options.segments },
      { name: "spans", type: "u32", value: spans },
    ];
    if (basis === "cardinal") members.push({ name: "tension", type: "f32", value: options.tension ?? 0 });
    if (basis === "arc") {
      members.push(
        { name: "arcLength", type: "f32", value: options.arcLength as number },
        { name: "arcChords", type: "u32", value: options.arcLengthUnit === "chords" ? 1 : 0 },
        { name: "maxHalfTurn", type: "f32", value: Math.min(Math.PI, (options.maxTurn ?? 2 * Math.PI) / 2) },
        { name: "bow", type: "vec3f", value: options.bow as Vec3 },
      );
    }
    if (basis === "arcChain") {
      members.push(
        { name: "arcLength", type: "f32", value: options.arcLength as number },
        { name: "bend", type: "vec2f", value: options.bend as readonly [number, number] },
      );
    }

    let source: CurveShaderOptions["source"];
    let schema: ReadonlyArray<PointAttributeSchema>;
    const groups: Array<{ readonly resourceId: string; readonly half: "read" | "write" }> = [];
    let storage: ReturnType<typeof packedPointStorage>;

    if (upstream === undefined) {
      const rowsOfTable = table as ReadonlyArray<CurveTablePoint>;
      /* One vec4 a control point (x, y, z, scale) and its roll four to a member — flat
         lists, which is what a plan's uniform values are (Ramp's stops, `packStops`). */
      rowsOfTable.forEach((point, index) => members.push({ name: `c${index}`, type: "vec4f", value: [...point.position, point.scale] }));
      for (let group = 0; group * 4 < rowsOfTable.length; group += 1) {
        members.push({ name: `r${group}`, type: "vec4f", value: [0, 1, 2, 3].map((offset) => rowsOfTable[group * 4 + offset]?.roll ?? 0) });
      }
      schema = curveAttributes(undefined, basis);
      storage = packedPointStorage(nodeId, schema, capacity, "write");
      if (!storage.ok) return refuse(storage.errors.join(" "), undefined, "node.points.capacity");
      source = {
        kind: "table",
        count: rowsOfTable.length,
        scaleOutWord: (storage.layout.byName.get("scale")?.offset ?? 0) / 4,
        rollOutWord: (storage.layout.byName.get("roll")?.offset ?? 0) / 4,
      };
    } else {
      const available = Object.keys(upstream.pairs).sort();
      const carried: Array<{ name: string; type: PointAttributeType; ref: PointsetAttributeRef }> = [];
      for (const name of available) {
        const ref = upstream.pairs[name] as PointsetAttributeRef;
        if (ref.type === undefined || !(POINT_ATTRIBUTE_TYPES as ReadonlyArray<string>).includes(ref.type)) {
          return refuse(
            `the control attribute "${name}" is ${ref.type === undefined ? "untyped" : `typed "${ref.type}"`}, so it cannot be interpolated; a Curve owns every attribute of its output.`,
            "The producer predates typed pairs.",
          );
        }
        carried.push({ name, type: ref.type as PointAttributeType, ref });
      }
      const byName = new Map(carried.map((entry) => [entry.name, entry]));
      const position = byName.get("position");
      if (position === undefined || position.type !== "vec3f") {
        return refuse(`the control pointset's position is ${position?.type ?? "missing"}, not vec3f.`, undefined, "node.points.edge");
      }
      const groupOf = (ref: PointsetAttributeRef): number => {
        const found = groups.findIndex((group) => group.resourceId === ref.buffer && group.half === ref.half);
        if (found >= 0) return found;
        groups.push({ resourceId: ref.buffer, half: ref.half });
        return groups.length - 1;
      };
      const regionOf = (ref: PointsetAttributeRef): { group: number; word: number } => ({ group: groupOf(ref), word: ref.offset / 4 });
      const positionRegion = regionOf(position.ref);

      let handles: { handleIn: { group: number; word: number }; handleOut: { group: number; word: number } } | undefined;
      if (basis === "bezier") {
        const handleIn = byName.get(HANDLE_IN);
        const handleOut = byName.get(HANDLE_OUT);
        if (handleIn?.type !== "vec3f" || handleOut?.type !== "vec3f") {
          return refuse(
            `a Bezier curve reads each control point's two handles, the vec3f attributes "${HANDLE_IN}" and "${HANDLE_OUT}" (relative to the point), and the control pointset carries ${
              handleIn === undefined && handleOut === undefined ? "neither" : "not both as vec3f"
            }.`,
            `It provides: ${available.join(", ")}. Write the two in a kernel, or pick Catmull-Rom, which needs none.`,
          );
        }
        handles = { handleIn: regionOf(handleIn.ref), handleOut: regionOf(handleOut.ref) };
      }

      let arcLengthRegion: (CurveShaderOptions["source"] & { kind: "wired" })["arcLength"];
      let bowRegion: { group: number; word: number } | undefined;
      let bendRegion: { group: number; word: number } | undefined;
      let startRegion: { group: number; word: number } | undefined;
      if (basis === "arcChain") {
        const bendBinding = parameterMaps["bend"];
        if (bendBinding !== undefined) {
          const bendAttribute = byName.get(bendBinding.attribute);
          if (bendBinding.channel !== undefined) {
            return refuse(`bend maps both turns at once; a channel belongs on a component ("bend.x"), not the head.`, undefined, "node.parameter.map");
          }
          if (bendAttribute === undefined || bendAttribute.type !== "vec2f") {
            return refuse(
              bendAttribute === undefined
                ? `bend maps attribute "${bendBinding.attribute}", which the control pointset does not carry.`
                : `bend needs a vec2f attribute (the turn per metre about X and about Y); "${bendBinding.attribute}" is ${bendAttribute.type}.`,
              `It provides: ${available.join(", ")}.`,
              "node.parameter.map",
            );
          }
          bendRegion = regionOf(bendAttribute.ref);
        }
        /* The start frame, by name — a constant quaternion would mean nothing here, and a
           name that is not on the edge is refused rather than read as "no frame" (§V288). */
        const startName = typeof parameters["startOrient"] === "string" ? parameters["startOrient"].trim() : "";
        if (startName !== "") {
          const startAttribute = byName.get(startName);
          if (startAttribute === undefined || startAttribute.type !== "vec4f") {
            return refuse(
              startAttribute === undefined
                ? `the Start Frame reads attribute "${startName}", which the control pointset does not carry.`
                : `the Start Frame reads "${startName}", which is ${startAttribute.type}; a frame is a vec4f quaternion.`,
              `It provides: ${available.join(", ")}. Clear Start Frame to leave along +Z.`,
            );
          }
          startRegion = regionOf(startAttribute.ref);
        }
      }
      if (basis === "arc" || basis === "arcChain") {
        const resolvedLength = resolveScalarMap(nodeId, parameterMaps["arcLength"], upstream, "in", "arcLength");
        if ("refusal" in resolvedLength) return resolvedLength.refusal;
        if (resolvedLength.map !== undefined) {
          const map = resolvedLength.map;
          arcLengthRegion = {
            ...regionOf(map),
            strideWords: ATTRIBUTE_STRIDES[map.type as PointAttributeType] / 4,
            component: map.channel === undefined ? 0 : ["x", "y", "z", "w"].indexOf(map.channel),
          };
        }
        const bowBinding = basis === "arc" ? parameterMaps["bow"] : undefined;
        if (bowBinding !== undefined) {
          const bowAttribute = byName.get(bowBinding.attribute);
          if (bowBinding.channel !== undefined) {
            return refuse(`bow maps the whole direction; a channel belongs on a component ("bow.x"), not the head.`, undefined, "node.parameter.map");
          }
          if (bowAttribute === undefined || bowAttribute.type !== "vec3f") {
            return refuse(
              bowAttribute === undefined
                ? `bow maps attribute "${bowBinding.attribute}", which the control pointset does not carry.`
                : `bow needs a vec3f attribute; "${bowBinding.attribute}" is ${bowAttribute.type}.`,
              `It provides: ${available.join(", ")}.`,
              "node.parameter.map",
            );
          }
          bowRegion = regionOf(bowAttribute.ref);
        }
      }

      schema = curveAttributes(carried, basis);
      storage = packedPointStorage(nodeId, schema, capacity, "write");
      if (!storage.ok) return refuse(storage.errors.join(" "), undefined, "node.points.capacity");
      const attributes: CurveCarriedAttribute[] = [];
      for (const region of storage.layout.regions) {
        if (region.name === "position") continue; // the basis writes it
        const entry = byName.get(region.name) as (typeof carried)[number];
        attributes.push({
          group: groupOf(entry.ref),
          inWord: entry.ref.offset / 4,
          outWord: region.offset / 4,
          strideWords: ATTRIBUTE_STRIDES[entry.type] / 4,
          components: COMPONENT_COUNTS[entry.type],
          blend: entry.type !== "u32" && entry.type !== "vec4u",
        });
      }
      source = {
        kind: "wired",
        groups: groups.length,
        position: positionRegion,
        attributes,
        ...(handles === undefined ? {} : handles),
        ...(arcLengthRegion === undefined ? {} : { arcLength: arcLengthRegion }),
        ...(bowRegion === undefined ? {} : { bow: bowRegion }),
        ...(bendRegion === undefined ? {} : { bend: bendRegion }),
        ...(startRegion === undefined ? {} : { startOrient: startRegion }),
      };
    }

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      /* The shader text already differs wherever the program does (the basis, the source,
         every offset); the id says the same things a person would want to read in a plan. */
      id: `${nodeId}:curve:${basis}${unclamped ? ":unclamped" : ""}:${upstream === undefined ? "table" : "wired"}:${colsOut}x${rows}`,
      shader: curveWgsl({
        basis,
        unclamped,
        members: members.map(({ name, type }) => ({ name, type })),
        positionOutWord: (storage.layout.byName.get("position")?.offset ?? 0) / 4,
        source,
      }),
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / 64), 1, 1],
      buffers: [
        ...groups.map((group, index) => ({ binding: `pk_${index}`, resourceId: group.resourceId, half: group.half })),
        // The WHOLE packed buffer: every region is written by offset (T1076).
        { binding: "out_points", resourceId: storage.resourceId, half: "write" as const },
      ],
      uniforms: Object.fromEntries(members.map((member) => [member.name, member.value])),
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [storage.scratch],
      pointsets: {
        out: {
          // Every pair is this node's own: a curve has more points than its control strip.
          pairs: storage.pairs,
          capacity,
          topology: formatTopology({ kind: "strips", cols: colsOut, rows, closed }),
        },
      },
    };
  },
};
