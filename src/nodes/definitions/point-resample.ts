import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { BufferBindingDescriptor, DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import {
  ATTRIBUTE_STRIDES,
  COMPONENT_COUNTS,
  POINT_ATTRIBUTE_TYPES,
  type PointAttributeSchema,
  type PointAttributeType,
} from "../../points/attributes.ts";
import { STRIP_WALK_BLOCK } from "../../points/curve.ts";
import { formatTopology } from "../../points/topology.ts";
import {
  resampleBlockAddWgsl,
  resampleBlockFoldWgsl,
  resampleBlockLengthsWgsl,
  resampleEmitWgsl,
  resampleLengthsWgsl,
  type ResampleCarriedAttribute,
} from "../shaders/curve-resample.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { attributeBinding, packedPointStorage } from "./point-storage.ts";
import { stripsOnEdge } from "./point-strips.ts";

/**
 * Resample (T1586b) — THE SAME CURVE, ITS POINTS PLACED BY RULE.
 *
 * A strip in, a strip out: by COUNT (so many points, evenly), or by DISTANCE (a point every
 * so many metres, into a fixed allocation). It is TouchDesigner's Line Resample POP, and
 * its Offset and Range are Notch's Spline Offset and Spline Use Amount — so a cloner along
 * a spline is Curve → Resample → Curve Frames → Geometry, with no cloner node
 * (`docs/curve-family-design-2026-10-05.md`, sections 3.3 and 5.1).
 *
 * ⚑ A STRIP SHORTER THAN ITS SLOTS IS A FIXED CAPACITY WITH DEGENERATE ELEMENTS (§V788, the
 * design's D2). By Distance the number of stations follows the curve's length, which is
 * only known on the GPU. The node does not publish a count: it allocates Max Points per
 * strip, fills the unused slots with copies of the nearest live station — every attribute
 * included — and publishes `live` (1 on a point of the strip, 0 on padding). Anything that
 * follows a strip then sees segments of no length and needs nothing more: a sweep draws
 * triangles of no area, Curve Frames turns no frame. Anything that treats each point alone
 * reads `live`: a Geometry's Group is `p.live > 0.5`. The edge's `count` cannot say this —
 * with more than one strip the live points are not a prefix of the pointset.
 *
 * ⚑ OVER BUDGET, THE CURVE IS NEVER CUT SHORT (D6). If a strip needs more stations than
 * Max Points, the spacing widens until the whole range fits. A curve that ends early is a
 * hole in a tunnel; a coarser one is a visible, bounded degradation.
 *
 * ⚑ IT PUBLISHES NO DISTANCE AND NO FRAME (D4). Curve Frames is the one node that measures
 * a strip, so Resample runs BEFORE it. The lengths this node walks are its own scratch.
 *
 * ⚑ EVERY ATTRIBUTE IS OWNED AFRESH. Slots move, so nothing can pass by reference: float
 * attributes are interpolated linearly between the two input points around a station and
 * integer ones take the earlier point's. Nothing is renormalised — the edge does not say
 * which vec4f is a quaternion (T287 declared qualifiers; no edge carries them) — which is
 * the other reason frames are measured after a resample and not before.
 *
 * STATELESS and clock-free, like the rest of the family: nothing to reset on a seek (§V170).
 * The passes are described where they are written, `nodes/shaders/curve-resample.wgsl.ts`:
 * a length walk and an emit, and for an input strip longer than one block the walk is three
 * lighter passes that many blocks run at once (slice 6).
 */

const CODE = "node.points.resample";
/** The engine's pointset ceiling, as every producer's Capacity states it. */
const MAX_POINTS = 1_000_000;

const LIVE_ATTRIBUTE: PointAttributeSchema = { name: "live", type: "f32", default: [1] };

/**
 * The attributes a Resample owns, in the order its packed buffer lays them out: `position`
 * first, the rest of what the input carries by name, and `live` last when the method can
 * leave a strip shorter than its slots. Exported because a reader of the buffer must slice
 * it with the layout the node allocated, never a second copy of the arithmetic (§V349).
 *
 * The input's own `live` is never carried: this node decides which of ITS slots are live.
 */
export function resampleAttributes(
  carried: ReadonlyArray<{ readonly name: string; readonly type: PointAttributeType }>,
  publishesLive: boolean,
): ReadonlyArray<PointAttributeSchema> {
  const others = carried
    .filter((attribute) => attribute.name !== "position" && attribute.name !== LIVE_ATTRIBUTE.name)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    ...others.map((attribute) => ({ name: attribute.name, type: attribute.type, default: Array<number>(COMPONENT_COUNTS[attribute.type]).fill(0) })),
    ...(publishesLive ? [LIVE_ATTRIBUTE] : []),
  ];
}

const byDistance = (values: Readonly<Record<string, unknown>>): boolean => values["method"] === "distance";
const byParameter = (values: Readonly<Record<string, unknown>>): boolean => !byDistance(values) && values["spacing"] === "parameter";

export const pointResampleNode: NodeDefinition = {
  type: "pointResample",
  version: 1,
  title: "Resample",
  category: "points",
  description:
    "Places new points along every strip of a pointset: by Count (so many, at Even Length along the curve or at Even Parameter, the same number between each pair of the input's own points) or by Distance (one every so many metres, into Max Points slots per strip). Offset slides them along the curve and Range uses part of it — that is the trim. By Distance a strip can be shorter than its slots: the spare slots repeat the nearest point and the live attribute is 0 there, so draw instances with Group p.live > 0.5. Every attribute is interpolated. Put Curve Frames after it.",
  tags: ["points", "curve", "strips", "resample", "spacing", "distance", "trim", "line", "spline", "cloner"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "A pointset whose edge claims strips: a Line, a Circle, a Grid (its rows), another Resample, or anything behind a Topology node set to Strips.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "The same strips with their points re-placed: Count points per strip, or Max Points slots per strip by Distance. Every attribute of the input is carried, interpolated between the two points around each new one (integers take the earlier point). By Distance it adds live (f32): 1 on a point of the strip, 0 on a spare slot.",
    },
  ],
  parameters: {
    method: {
      type: "enum",
      label: "Method",
      default: "count",
      compileTime: true,
      // §V831: APPEND only — Curvature (§T1586b slice 7) takes the next row.
      options: [
        { value: "count", label: "Count" },
        { value: "distance", label: "Distance" },
      ],
      description:
        "Count: a fixed number of points per strip, all of them live. Distance: a point every Distance metres; how many depends on the curve's length, so the strip is allocated Max Points slots and the live attribute marks the ones in use.",
    },
    count: {
      type: "number",
      label: "Count",
      default: 64,
      min: 1,
      max: MAX_POINTS,
      range: "bounded",
      step: 1,
      compileTime: true,
      inactiveWhen: (values) => (byDistance(values) ? "By Distance the number of points follows the curve's length." : null),
      description: "Points per strip. One point sits on the start of the Range.",
    },
    spacing: {
      type: "enum",
      label: "Spacing",
      default: "length",
      compileTime: true,
      options: [
        { value: "length", label: "Even Length" },
        { value: "parameter", label: "Even Parameter" },
      ],
      inactiveWhen: (values) => (byDistance(values) ? "By Distance the points are a fixed length apart." : null),
      description:
        "Even Length: the points are the same distance apart along the curve, so something riding them moves at a steady speed. Even Parameter: the same number of new points between each pair of the input's points, however far apart those are — Notch's Length and Knots.",
    },
    distance: {
      type: "number",
      label: "Distance",
      default: 0.1,
      min: 0,
      range: "floor",
      step: 0.01,
      inactiveWhen: (values) => (byDistance(values) ? null : "Only the Distance method reads a spacing in metres."),
      description:
        "Metres between points, along the curve. If a strip would need more than Max Points, the spacing widens until the whole Range fits: the curve is never cut short.",
    },
    maxPoints: {
      type: "number",
      label: "Max Points",
      default: 256,
      min: 2,
      max: MAX_POINTS,
      range: "bounded",
      step: 1,
      compileTime: true,
      inactiveWhen: (values) => (byDistance(values) ? null : "Count already says how many slots a strip has."),
      description: "Slots allocated per strip. Changing it reallocates.",
    },
    anchor: {
      type: "enum",
      label: "Anchor",
      default: "start",
      compileTime: true,
      options: [
        { value: "start", label: "Start" },
        { value: "end", label: "End" },
      ],
      inactiveWhen: (values) => (byDistance(values) ? null : "Count spans the Range from end to end."),
      description:
        "Which end the points are measured from. Start: the first slot is on the start of the Range and spare slots collect at the tail. End: the LAST slot is on the end of the Range and spare slots collect at the head — a tentacle whose tip must reach its target while its slack is stowed at the root. A closed strip used whole has no ends, and its points start from its first one.",
    },
    offset: {
      type: "number",
      label: "Offset",
      default: 0,
      min: -10,
      max: 10,
      range: "soft",
      step: 0.01,
      inactiveWhen: (values) => (byParameter(values) ? "Even Parameter has no length to slide along." : null),
      description:
        "Metres to slide every point along the curve. On an open strip a point that slides past an end of the Range stops being live (Distance) or waits at the end (Count); on a closed strip used whole the points go round.",
    },
    rangeStart: {
      type: "number",
      label: "Range Start",
      default: 0,
      min: 0,
      max: 1,
      range: "bounded",
      step: 0.01,
      description: "Where the used part of each strip begins, as a share of its length (of its points, under Even Parameter).",
    },
    rangeEnd: {
      type: "number",
      label: "Range End",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      step: 0.01,
      description: "Where the used part ends. Animate it from 0 to 1 and the curve draws itself on.",
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters, parameterMaps } = readCompileInputs(context);
    const points = inputs["points"];
    if (points === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "points"')] };
    }
    const upstream = points.pointset;
    const position = upstream?.pairs["position"];
    if (upstream === undefined || position === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points edge carries no resolved position pair (producer predates T296?).`,
            nodeId,
          },
        ],
      };
    }
    const refuse = (message: string, suggestion?: string, code = CODE): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        { severity: "error", code, message: `Node "${nodeId}": ${message}`, nodeId, ...(suggestion === undefined ? {} : { suggestion }) },
      ],
    });

    const claimed = stripsOnEdge(nodeId, "Resample", upstream);
    if ("refusal" in claimed) return claimed.refusal;
    const strips = claimed.strips;

    const mapped = Object.keys(parameterMaps).sort();
    if (mapped.length > 0) {
      return refuse(
        `${mapped.join(", ")} ${mapped.length === 1 ? "is" : "are"} in map mode, but a Resample places points by rule and maps nothing.`,
        "Switch it back to Constant, or drive it through the value graph instead.",
        "node.parameter.map",
      );
    }
    /* A counted edge says "the first N slots are live", for the whole pointset. A strip's
       slots are fixed, and the dead tail of a counted set is not padding (§V788): resampling
       it would walk whatever the dead slots last held. */
    if (upstream.count !== undefined) {
      return refuse(
        "the incoming pointset carries a GPU live count, and a strip's slots are fixed — the slots past the count are not padding, so a walk along the strip would read them as curve.",
        "Resample a static producer, or a kernel behind a Topology node set to Strips.",
      );
    }

    const method = parameters["method"] === "distance" ? "distance" : "count";
    const spacing = method === "count" && parameters["spacing"] === "parameter" ? "parameter" : "length";
    const anchor = method === "distance" && parameters["anchor"] === "end" ? "end" : "start";
    const walksLength = !(method === "count" && spacing === "parameter");
    if (!walksLength && upstream.pairs[LIVE_ATTRIBUTE.name] !== undefined) {
      /* Even in the input's POINTS — and some of those points are padding. The stations
         would land on the repeats and come out stacked, every one of them flagged live. */
      return refuse(
        "Even Parameter spaces the new points by the input's own points, and this input carries live: some of its slots are padding, which would be counted as points.",
        "Use Even Length, which passes over padding because it has no length.",
      );
    }

    const available = Object.keys(upstream.pairs).sort();
    const carried: Array<{ name: string; type: PointAttributeType; ref: PointsetAttributeRef }> = [];
    for (const name of available) {
      if (name === LIVE_ATTRIBUTE.name) continue;
      const ref = upstream.pairs[name] as PointsetAttributeRef;
      if (ref.type === undefined || !(POINT_ATTRIBUTE_TYPES as ReadonlyArray<string>).includes(ref.type)) {
        return refuse(
          `the incoming attribute "${name}" is ${ref.type === undefined ? "untyped" : `typed "${ref.type}"`}, so it cannot be interpolated; a Resample owns every attribute of its output.`,
          "The producer predates typed pairs.",
        );
      }
      carried.push({ name, type: ref.type as PointAttributeType, ref });
    }
    if (position.type !== "vec3f") return refuse(`the incoming position is ${position.type ?? "untyped"}, not vec3f.`);

    const colsOut = Math.max(method === "count" ? 1 : 2, Math.round(readNumber(parameters, method === "count" ? "count" : "maxPoints", method === "count" ? 64 : 256)));
    const capacity = colsOut * strips.rows;
    if (capacity > MAX_POINTS) {
      return refuse(
        `${strips.rows} strips of ${colsOut} points are ${capacity} points, over the ${MAX_POINTS} a pointset holds.`,
        `Lower ${method === "count" ? "Count" : "Max Points"} to ${Math.floor(MAX_POINTS / strips.rows)} or fewer.`,
        "node.points.capacity",
      );
    }
    const publishesLive = method === "distance";
    const schema = resampleAttributes(carried, publishesLive);
    const storage = packedPointStorage(nodeId, schema, capacity, "write");
    if (!storage.ok) return refuse(storage.errors.join(" "), undefined, "node.points.capacity");

    /* One binding per upstream BUFFER, whole, read by offset (T1076): attributes that came
       by reference from several producers are several buffers, and the stage has eight. */
    const groups: Array<{ readonly resourceId: string; readonly half: "read" | "write" }> = [];
    const groupOf = (ref: PointsetAttributeRef): number => {
      const found = groups.findIndex((group) => group.resourceId === ref.buffer && group.half === ref.half);
      if (found >= 0) return found;
      groups.push({ resourceId: ref.buffer, half: ref.half });
      return groups.length - 1;
    };
    const byName = new Map(carried.map((entry) => [entry.name, entry]));
    const attributes: ResampleCarriedAttribute[] = [];
    for (const region of storage.layout.regions) {
      const source = byName.get(region.name);
      if (source === undefined) continue; // `live`: written by this node, not carried.
      attributes.push({
        group: groupOf(source.ref),
        inWord: source.ref.offset / 4,
        outWord: region.offset / 4,
        strideWords: ATTRIBUTE_STRIDES[source.type] / 4,
        components: COMPONENT_COUNTS[source.type],
        blend: source.type !== "u32" && source.type !== "vec4u",
      });
    }
    const liveRegion = storage.layout.byName.get(LIVE_ATTRIBUTE.name);

    const cumulativeId = scratchResourceId(nodeId, "cumulative");
    const totalsId = scratchResourceId(nodeId, "totals");
    const lengthBindings: BufferBindingDescriptor[] = walksLength
      ? [
          { binding: "cumulative", resourceId: cumulativeId },
          { binding: "totals", resourceId: totalsId },
        ]
      : [];
    const closed = strips.closed ? 1 : 0;

    const lengths: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:resample:lengths`,
      shader: resampleLengthsWgsl(),
      entryPoint: "main",
      // One invocation per STRIP: each walks its own strip, in order.
      workgroups: [Math.ceil(strips.rows / 64), 1, 1],
      buffers: [attributeBinding("in_position", position), ...lengthBindings],
      uniforms: { cols: strips.cols, rows: strips.rows, closed },
      uniformBinding: "params",
      nodeId,
    };
    const emit: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:resample:emit:${method}:${spacing}:${anchor}:${colsOut}x${strips.rows}`,
      shader: resampleEmitWgsl({
        method,
        spacing,
        anchor,
        groups: groups.length,
        attributes,
        ...(liveRegion === undefined ? {} : { liveWord: liveRegion.offset / 4 }),
      }),
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / 64), 1, 1],
      buffers: [
        ...groups.map((group, index) => ({ binding: `pk_${index}`, resourceId: group.resourceId, half: group.half })),
        ...lengthBindings,
        // The WHOLE packed buffer: every region is written by offset (T1076).
        { binding: "out_points", resourceId: storage.resourceId, half: "write" as const },
      ],
      uniforms: {
        colsIn: strips.cols,
        rows: strips.rows,
        closed,
        colsOut,
        distance: Math.max(0, readNumber(parameters, "distance", 0.1)),
        offset: readNumber(parameters, "offset", 0),
        rangeStart: Math.min(1, Math.max(0, readNumber(parameters, "rangeStart", 0))),
        rangeEnd: Math.min(1, Math.max(0, readNumber(parameters, "rangeEnd", 1))),
      },
      uniformBinding: "params",
      nodeId,
    };

    /* ── A strip longer than one block: its lengths by many walks at once ──
       A walk's cost is its depth, so past STRIP_WALK_BLOCK points the one walk becomes
       three passes: every block sums itself, one pass per strip turns the sums into each
       block's start, and every point adds its block's start (the design's section 4.3).
       The emit pass reads the same two buffers either way and does not know. */
    const blocks = Math.ceil(strips.cols / STRIP_WALK_BLOCK);
    const blocked = walksLength && strips.cols > STRIP_WALK_BLOCK;
    const startsBinding: BufferBindingDescriptor = { binding: "blockStarts", resourceId: scratchResourceId(nodeId, "blockStarts") };
    const blockedLengths: DispatchPassDescriptor[] = blocked
      ? [
          {
            kind: "dispatch",
            id: `${nodeId}:resample:lengths:block`,
            shader: resampleBlockLengthsWgsl(),
            entryPoint: "main",
            // One invocation per BLOCK.
            workgroups: [Math.ceil((strips.rows * blocks) / 64), 1, 1],
            buffers: [attributeBinding("in_position", position), { binding: "cumulative", resourceId: cumulativeId }, startsBinding],
            uniforms: { cols: strips.cols, rows: strips.rows, closed, blocks },
            uniformBinding: "params",
            nodeId,
          },
          {
            kind: "dispatch",
            id: `${nodeId}:resample:lengths:fold`,
            shader: resampleBlockFoldWgsl(),
            entryPoint: "main",
            workgroups: [Math.ceil(strips.rows / 64), 1, 1],
            buffers: [startsBinding, { binding: "totals", resourceId: totalsId }],
            uniforms: { rows: strips.rows, blocks },
            uniformBinding: "params",
            nodeId,
          },
          {
            kind: "dispatch",
            id: `${nodeId}:resample:lengths:add`,
            shader: resampleBlockAddWgsl(),
            entryPoint: "main",
            // One thread per input POINT.
            workgroups: [Math.ceil((strips.cols * strips.rows) / 64), 1, 1],
            buffers: [startsBinding, { binding: "cumulative", resourceId: cumulativeId }],
            uniforms: { cols: strips.cols, rows: strips.rows, blocks },
            uniformBinding: "params",
            nodeId,
          },
        ]
      : [];

    return {
      passes: !walksLength ? [emit] : blocked ? [...blockedLengths, emit] : [lengths, emit],
      scratch: [
        ...(walksLength
          ? ([
              { key: "cumulative", kind: "buffer" as const, stride: 4, capacity: upstream.capacity },
              { key: "totals", kind: "buffer" as const, stride: 4, capacity: strips.rows },
            ] as const)
          : []),
        ...(blocked ? [{ key: "blockStarts", kind: "buffer" as const, stride: 4, capacity: strips.rows * blocks }] : []),
        storage.scratch,
      ],
      pointsets: {
        out: {
          // Every pair is this node's own: slots moved, so nothing passes by reference.
          pairs: storage.pairs,
          capacity,
          // Strips, whatever came in: a grid's rows resampled are still curves, and the
          // sheet between them is no longer this node's to promise.
          topology: formatTopology({ kind: "strips", cols: colsOut, rows: strips.rows, closed: strips.closed }),
        },
      },
    };
  },
};
