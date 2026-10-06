import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { BufferBindingDescriptor, DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import type { PointAttributeSchema } from "../../points/attributes.ts";
import { STRIP_WALK_BLOCK } from "../../points/curve.ts";
import { regionAccessorWgsl, regionStoreWgsl } from "../../points/packing.ts";
import { curveFramesWgsl, type CurveFramesShaderOptions } from "../shaders/curve-frames.wgsl.ts";
import {
  curveFramesBlockWgsl,
  curveFramesBlocks,
  curveFramesChainFoldWgsl,
  curveFramesChainWgsl,
  curveFramesFoldWgsl,
  curveFramesWalkWords,
  curveFramesWriteWgsl,
  type CurveFramesBlockedPass,
} from "../shaders/curve-frames-blocked.wgsl.ts";
import {
  CURVE_FRAMES_ENDS_VECTORS,
  curveFramesEndsFindWgsl,
  curveFramesEndsWriteGroups,
  curveFramesEndsWriteWgsl,
  type CurveFramesEndsOptions,
  type CurveFramesEndsPass,
} from "../shaders/curve-frames-ends.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readFlag, readNumber, readVector } from "./parameter-readers.ts";
import { attributeBinding, packedPointStorage } from "./point-storage.ts";
import { stripsOnEdge } from "./point-strips.ts";
import { resolveScalarMap } from "./points.ts";

/**
 * Curve Frames (T1586b) — THE ONE NODE THAT MEASURES A STRIP.
 *
 * A curve in Loom is a strip of a pointset (`points/topology.ts`): points in slot order,
 * joined by straight segments. This node walks each strip and publishes what every
 * consumer of a curve wants and none should derive for itself: how far along each point is,
 * how sharply the curve turns there, and a frame — a tangent, a normal and a binormal, and
 * the same three as one quaternion. It is TouchDesigner's Line Metrics POP and the twist
 * resolution Notch does on its Spline (`docs/curve-family-design-2026-10-05.md`, section 1).
 *
 * ⚑ ONE PUBLISHER (the design's D4). Curve and Resample publish no tangent, no frame and no
 * distance; this node does, from the positions it is handed. Two nodes that each knew "how
 * far along is this point" would be two answers to one question, drifting the first time
 * either was tuned. So a chain is Curve → Resample → Curve Frames, in that order.
 *
 * ⚑ THE FRAME CONVENTION IS THE INSTANCER'S (§T1581b). `orient` carries a shape's +Z onto
 * the tangent and its +Y onto the normal, so mapping it onto a Geometry's Orient turns
 * every instance down the curve — and mapping `tangent` onto Aim and `normal` onto Up, with
 * Forward +Z, draws the same picture.
 *
 * ⚑ THE FRAME IS CARRIED ALONG THE POLYLINE ITSELF (D9). Crossing a point turns the frame
 * by the smallest rotation that takes the incoming segment's direction to the outgoing
 * one, and nothing else turns it — so a straight run does not turn it at all and a planar
 * curve never twists. That is exact for the data this node has (the points), which is why
 * its tests can assert values rather than bands. A smooth curve gets dense enough upstream,
 * at the Resample.
 *
 * ⚑ PADDING NEEDS NO COUNT (§V788). A strip shorter than its slots repeats its nearest live
 * point; a segment of no length adds no distance and turns no frame; so the repeats take
 * the frame and the distance of the point they repeat, and this node never reads `live`.
 *
 * It is STATELESS and reads no clock: a pure function of this frame's positions and
 * parameters, so there is nothing to reset on a seek and nothing to diverge (§V170). The
 * walk — one invocation per strip, in order, strips in parallel — is described where it is
 * written, `nodes/shaders/curve-frames.wgsl.ts`.
 *
 * ⚑ A STRIP OF ANY LENGTH (slice 6). One walk is right up to `STRIP_WALK_BLOCK` points; its
 * cost is its depth. A longer strip is cut into blocks that are walked at once, with one
 * pass per strip between two passes per block to hand each block the state it starts from
 * (`nodes/shaders/curve-frames-blocked.wgsl.ts`). A strip that fits one block is walked by
 * the program it always was, so no curve that shipped reads back a different byte.
 *
 * ⚑ THE TWO ENDS OF AN OPEN STRIP ARE EXTRAPOLATED (§T1587b C13). An end point has one segment, and
 * that segment's direction is the curve's half a segment further on: the first ring of a
 * swept tunnel stood 2.7 mm off where every ring inside it was within 0.11. Extrapolate Ends
 * takes each end's tangent from its two nearest segments instead, the slope at the end of
 * the parabola through their three points — Houdini's Extrapolate End Tangents. It is a pass
 * of its own AFTER the walk (`nodes/shaders/curve-frames-ends.wgsl.ts`), which rewrites the
 * first and the last run of coincident points and nothing else, so every interior value is
 * the walk's to the bit, on or off. Off, an end keeps its segment's frame: the thing to
 * choose for a path of straight legs whose corner is next to its end.
 */

/** What the node may publish, in the order its packed buffer lays them out. */
const FRAME_ATTRIBUTE: PointAttributeSchema = { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] };
const VECTOR_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "tangent", type: "vec3f", qualifier: "direction", default: [0, 0, 1] },
  { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
  { name: "binormal", type: "vec3f", qualifier: "direction", default: [-1, 0, 0] },
];
const METRIC_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "distance", type: "f32", default: [0] },
  { name: "curveU", type: "f32", default: [0] },
  { name: "curveLength", type: "f32", default: [0] },
  { name: "curvature", type: "f32", default: [0] },
];

/**
 * The attributes Curve Frames owns for a given set of switches — exported because a reader
 * of its buffer (a test, a probe) must slice it with the layout the node allocated, never a
 * second copy of the arithmetic (§V349).
 */
export function curveFramesAttributes(outputs: {
  readonly frame: boolean;
  readonly vectors: boolean;
  readonly metrics: boolean;
}): ReadonlyArray<PointAttributeSchema> {
  return [
    ...(outputs.frame ? [FRAME_ATTRIBUTE] : []),
    ...(outputs.vectors ? VECTOR_ATTRIBUTES : []),
    ...(outputs.metrics ? METRIC_ATTRIBUTES : []),
  ];
}

/** What each published attribute is called inside the walk's `writeRun`. */
const STORED_VALUE: Readonly<Record<string, string>> = {
  orient: "orient",
  tangent: "tangent",
  normal: "normal",
  binormal: "binormal",
  distance: "travelled",
  curveU: "u",
  curveLength: "total",
  curvature: "bend",
};

const DEGREES_TO_RADIANS = Math.PI / 180;
const CODE = "node.points.curveFrames";

const fixedUp = (values: Readonly<Record<string, unknown>>): boolean => values["method"] === "fixedUp";

export const pointCurveFramesNode: NodeDefinition = {
  type: "pointCurveFrames",
  version: 1,
  title: "Curve Frames",
  category: "points",
  description:
    "Measures every strip of a pointset as a curve and publishes the result per point: distance from the start, curvature, and a frame — as a quaternion (orient: +Z down the curve, +Y the normal) and optionally as tangent, normal and binormal. Minimise Twist carries the frame along the curve from a seed; Fixed Up keeps the normal toward Up. An open strip's two ends are aimed by their two nearest segments (Extrapolate Ends), so the first and last ring of a tube sit square to the curve. Map orient onto a Geometry's Orient to instance along a curve. Put it after a Resample, not before.",
  tags: ["points", "curve", "strips", "frames", "tangent", "normal", "orient", "twist", "distance", "line", "spline"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "A pointset whose edge claims strips: a Line, a Circle, a Grid (its rows), a Resample, or anything behind a Topology node set to Strips. Each strip is followed in slot order.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "The incoming pointset with the measured attributes added: orient (vec4f quaternion), distance, curveU (distance ÷ length), curveLength and curvature (all f32), and tangent, normal, binormal (vec3f) when Vectors is on. Capacity, the strips claim and every other attribute pass through untouched.",
    },
  ],
  parameters: {
    method: {
      type: "enum",
      label: "Method",
      default: "minimiseTwist",
      compileTime: true,
      options: [
        { value: "minimiseTwist", label: "Minimise Twist" },
        { value: "fixedUp", label: "Fixed Up" },
      ],
      description:
        "Minimise Twist carries the frame from the strip's first point along the curve, turning it only as much as the curve turns: no twist on a planar curve, and no flip where the curve passes through vertical. Fixed Up leans every normal toward Up instead, so up stays up and a loop leaves no roll behind — the frame for a road, a tunnel or a camera path.",
    },
    seed: {
      type: "enum",
      label: "Seed",
      default: "up",
      compileTime: true,
      options: [
        { value: "up", label: "Up" },
        { value: "orient", label: "Orient Attribute" },
      ],
      inactiveWhen: (values) => (fixedUp(values) ? "Fixed Up reads Up at every point and has no start frame to seed." : null),
      description:
        "Where the first frame of each strip comes from. Up: the normal leans toward the Up direction. Orient Attribute: the normal is the +Y of a quaternion read at the strip's first point — a socket's own orientation, so a tentacle leaves its socket the way the socket faces.",
    },
    up: {
      type: "vector",
      size: 3,
      label: "Up",
      default: [0, 1, 0],
      description:
        "The direction the normal leans to: at each strip's first point under Minimise Twist, at every point under Fixed Up. In Map mode a vec3f attribute gives it per strip (read at the strip's first point) or per point (Fixed Up). Where it runs along the curve it cannot decide: the first frame then takes a world axis, and a Fixed Up point keeps the normal of the point before it.",
    },
    seedOrient: {
      type: "string",
      label: "Seed Attribute",
      default: "orient",
      compileTime: true,
      inactiveWhen: (values) =>
        fixedUp(values)
          ? "Fixed Up has no start frame to seed."
          : values["seed"] === "orient"
            ? null
            : "Only the Orient Attribute seed reads an attribute.",
      description: "The vec4f quaternion attribute read at each strip's first point when Seed is Orient Attribute.",
    },
    roll: {
      type: "number",
      label: "Roll",
      default: 0,
      min: -180,
      max: 180,
      range: "cyclic",
      unit: "degrees",
      description:
        "Turns every frame about its tangent by this many degrees: positive swings the normal toward the binormal. In Map mode an f32 attribute (or one channel of a float vector), in degrees, ADDS to this per point — a bank that varies along the curve.",
    },
    twist: {
      type: "number",
      label: "Twist",
      default: 0,
      min: -720,
      max: 720,
      range: "soft",
      unit: "degrees",
      description:
        "A turn about the tangent that grows along the strip by distance, from 0 at its first point to this many degrees at its end. 360 is one full turn of the frame over the strip's length.",
    },
    closeTwist: {
      type: "boolean",
      label: "Close Twist",
      default: true,
      inactiveWhen: (values) => (fixedUp(values) ? "A Fixed Up frame depends only on where a point is, so a closed strip already meets itself." : null),
      description:
        "Closed strips: after one lap a carried frame comes back turned about the tangent by some angle. On, that angle is spread along the strip by distance, so the frame meets itself at the seam — what a sweep needs. Off, the seam shows the raw mismatch.",
    },
    extrapolateEnds: {
      type: "boolean",
      label: "Extrapolate Ends",
      default: true,
      compileTime: true,
      inactiveWhen: (values) => (values["frame"] === false && values["vectors"] !== true ? "Only a frame has ends to aim: turn Frame or Vectors on." : null),
      description:
        "Open strips: aims the frame at each end by the end's two nearest segments, as the curve through their three points leaves it, in place of the end segment's own direction — which is the curve's half a segment further on. The first and last ring of a swept tube then sit square to the curve. Off, an end keeps its segment's frame: for a path of straight legs with a corner next to its end. Every other point is the same either way, and so is a closed strip, a straight end, and a strip of two points.",
    },
    frame: {
      type: "boolean",
      label: "Frame",
      default: true,
      compileTime: true,
      description: "Publish orient: the frame as a unit quaternion (x, y, z, w), ready for a Geometry's Orient in Map mode.",
    },
    vectors: {
      type: "boolean",
      label: "Vectors",
      default: false,
      compileTime: true,
      description:
        "Publish tangent, normal and binormal (vec3f) as well — for a kernel that moves points along them, or a Geometry's Aim and Up. binormal is tangent × normal.",
    },
    metrics: {
      type: "boolean",
      label: "Metrics",
      default: true,
      compileTime: true,
      description:
        "Publish distance (from the strip's first point, along its segments), curveU (distance ÷ length), curveLength (the strip's length, on every point of it) and curvature (1 ÷ the radius of the circle through a point and its two neighbours).",
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

    const claimed = stripsOnEdge(nodeId, "Curve Frames", upstream);
    if ("refusal" in claimed) return claimed.refusal;
    const strips = claimed.strips;

    // §V288: a map this node cannot honour refuses BY NAME rather than reading the static.
    const unhonoured = Object.keys(parameterMaps).filter((key) => key !== "up" && key !== "roll").sort();
    if (unhonoured.length > 0) {
      return refuse(
        `${unhonoured.join(", ")} ${unhonoured.length === 1 ? "is" : "are"} in map mode, but Curve Frames maps only "up" and "roll".`,
        "Switch it back to Constant, or drive it through the value graph instead.",
        "node.parameter.map",
      );
    }

    const method = parameters["method"] === "fixedUp" ? "fixedUp" : "minimiseTwist";
    const seedFromOrient = method === "minimiseTwist" && parameters["seed"] === "orient";
    const outputs = {
      frame: parameters["frame"] !== false,
      vectors: parameters["vectors"] === true,
      metrics: parameters["metrics"] !== false,
    };
    const owned = curveFramesAttributes(outputs);
    if (owned.length === 0) {
      return refuse(
        "Frame, Vectors and Metrics are all off, so there is nothing to publish.",
        "Turn one of them on, or remove the node.",
      );
    }
    const available = Object.keys(upstream.pairs).sort();

    /* The seed quaternion, by name — the reason `endpoint` is a name on a Geometry: a
       constant value would mean nothing here. */
    let seedPair: PointsetAttributeRef | undefined;
    if (seedFromOrient) {
      const name = typeof parameters["seedOrient"] === "string" ? parameters["seedOrient"].trim() : "orient";
      const carried = upstream.pairs[name];
      if (carried === undefined || carried.type !== "vec4f") {
        return refuse(
          carried === undefined
            ? `the seed reads attribute "${name}", which the incoming pointset does not carry.`
            : `the seed reads "${name}", which is ${carried.type ?? "untyped"}; a start frame is a vec4f quaternion.`,
          available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
        );
      }
      seedPair = carried;
    }

    /* `up` in Map mode: one vec3f attribute drives the whole direction. */
    let upPair: PointsetAttributeRef | undefined;
    const upBinding = parameterMaps["up"];
    if (upBinding !== undefined && !seedFromOrient) {
      const carried = upstream.pairs[upBinding.attribute];
      if (upBinding.channel !== undefined) {
        return refuse(`up maps the whole direction; a channel belongs on a component ("up.x"), not the head.`, undefined, "node.parameter.map");
      }
      if (carried === undefined || carried.type !== "vec3f") {
        return refuse(
          carried === undefined
            ? `up maps attribute "${upBinding.attribute}", which the incoming pointset does not carry.`
            : `up needs a vec3f attribute; "${upBinding.attribute}" is ${carried.type ?? "untyped"}.`,
          available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
          "node.parameter.map",
        );
      }
      upPair = carried;
    }
    const resolvedRoll = resolveScalarMap(nodeId, parameterMaps["roll"], upstream, "points", "roll");
    if ("refusal" in resolvedRoll) return resolvedRoll.refusal;
    const rollMap = resolvedRoll.map;

    /* A name already on the edge is REPLACED when its type agrees and refused when it does
       not (Gather's rule): publishing `distance` as f32 over a vec3f `distance` would be
       swizzled wrong by whoever mapped the old one. */
    for (const attribute of owned) {
      const existing = upstream.pairs[attribute.name];
      if (existing !== undefined && existing.type !== undefined && existing.type !== attribute.type) {
        return refuse(
          `publishing "${attribute.name}" as ${attribute.type} would change the type of the "${attribute.name}" (${existing.type}) these points already carry.`,
          "Rename the incoming attribute upstream, or turn off the switch that publishes it.",
        );
      }
    }

    const capacity = upstream.capacity;
    const storage = packedPointStorage(nodeId, owned, capacity, "write");
    if (!storage.ok) return refuse(storage.errors.join(" "), undefined, "node.points.capacity");

    const storeFunctions = storage.layout.regions
      .map((region) => regionStoreWgsl(`store_${region.name}`, "out_points", region))
      .join("\n\n");
    const storeStatements = storage.layout.regions
      .map((region) => `    store_${region.name}(slot, ${STORED_VALUE[region.name] as string});`)
      .join("\n");
    const rollShape =
      rollMap === undefined
        ? undefined
        : { type: rollMap.type as string, component: rollMap.channel === undefined ? "" : `.${rollMap.channel}` };

    const shaderOptions: CurveFramesShaderOptions = {
      method,
      upMapped: upPair !== undefined,
      seedOrient: seedPair !== undefined,
      ...(rollShape === undefined ? {} : { rollMap: rollShape }),
      storeFunctions,
      storeStatements,
    };
    /* Everything here changes the program's text or its bindings (§V62b): the method and
       the seed pick the walk, the maps bind a buffer each, the switches decide which
       regions exist, and the capacity moves every region's offset. */
    const programId = (stage: string): string =>
      [
        `${nodeId}:${stage}:${method}`,
        seedPair === undefined ? "" : "seed",
        upPair === undefined ? "" : "up",
        rollShape === undefined ? "" : `roll:${rollShape.type}${rollShape.component}`,
        `${outputs.frame ? "f" : ""}${outputs.vectors ? "v" : ""}${outputs.metrics ? "m" : ""}`,
        String(capacity),
      ]
        .filter((part) => part !== "")
        .join(":");
    const positionBinding = attributeBinding("in_position", position);

    /* ── Extrapolate Ends (§T1587b C13): the passes after the walk that re-aim an open strip's two
       end runs. They exist only where there is an end and a frame to aim: an open strip of
       three points or more, with Frame or Vectors on. ── */
    const frameRegions = ["orient", "tangent", "normal", "binormal"].flatMap((name) => {
      const region = storage.layout.byName.get(name);
      return region === undefined ? [] : [region];
    });
    const extrapolates = parameters["extrapolateEnds"] !== false && !strips.closed && strips.cols >= 3 && frameRegions.length > 0;
    const normalRegion = storage.layout.byName.get("normal");
    const read = normalRegion ?? frameRegions[0];
    const endsOptions: CurveFramesEndsOptions | undefined =
      !extrapolates || read === undefined
        ? undefined
        : {
            method,
            upMapped: method === "fixedUp" && upPair !== undefined,
            /* What the walk wrote at a slot: its normal, or the +Y of its quaternion where
               only the quaternion is published. */
            loadNormal:
              normalRegion !== undefined
                ? `${regionAccessorWgsl("load_normal", "out_points", normalRegion)}\n\nfn oldNormal(slot: u32) -> vec3f {\n  return load_normal(slot);\n}`
                : `${regionAccessorWgsl("load_orient", "out_points", read)}\n\nfn oldNormal(slot: u32) -> vec3f {\n  return qrot(load_orient(slot), vec3f(0.0, 1.0, 0.0));\n}`,
            storeFunctions: frameRegions.map((region) => regionStoreWgsl(`store_${region.name}`, "out_points", region)).join("\n\n"),
            storeStatements: frameRegions.map((region) => `  store_${region.name}(slot, ${region.name});`).join("\n"),
          };
    const endsUp = endsOptions?.upMapped === true && upPair !== undefined ? [attributeBinding("in_up", upPair)] : [];
    const endsBinding = { binding: "ends", resourceId: scratchResourceId(nodeId, "ends") };
    const endsScratch = endsOptions === undefined ? [] : [{ key: "ends", kind: "buffer" as const, stride: 16, capacity: strips.rows * CURVE_FRAMES_ENDS_VECTORS }];
    /* FIND per strip, then WRITE per chunk of slots: a run of any length is rewritten by many
       threads at once. `blocked` is a strip longer than one block, whose FIND reads the walk's
       summaries (`walk`) to step over whole blocks of padding. */
    const endsPasses = (blocked: { readonly walk: BufferBindingDescriptor; readonly values: Readonly<Record<string, number | readonly number[]>> } | undefined): DispatchPassDescriptor[] =>
      endsOptions === undefined
        ? []
        : [
            endsStage(
              "ends:find",
              curveFramesEndsFindWgsl(blocked !== undefined),
              [Math.ceil(strips.rows / 64), 1, 1],
              [positionBinding, ...(blocked === undefined ? [] : [blocked.walk]), endsBinding],
              blocked?.values ?? uniformValues,
            ),
            endsStage("ends:write", curveFramesEndsWriteWgsl(endsOptions), [curveFramesEndsWriteGroups(capacity), 1, 1], [...endsUp, endsBinding, outBinding], uniformValues),
          ];
    const endsStage = (
      name: string,
      emitted: CurveFramesEndsPass,
      workgroups: [number, number, number],
      buffers: ReadonlyArray<BufferBindingDescriptor>,
      values: Readonly<Record<string, number | readonly number[]>>,
    ): DispatchPassDescriptor => ({
      kind: "dispatch",
      id: programId(`frames:${name}`),
      shader: emitted.shader,
      entryPoint: "main",
      workgroups,
      buffers,
      // The same list the shader's struct was written from: declared and set, both or neither.
      uniforms: Object.fromEntries(emitted.uniforms.map((member) => [member, values[member] as number | readonly number[]])),
      uniformBinding: "params",
      nodeId,
    });
    /* The strip's lean: at most one of the two, since a seed quaternion replaces Up. */
    const leanBindings = [
      ...(upPair === undefined ? [] : [attributeBinding("in_up", upPair)]),
      ...(seedPair === undefined ? [] : [attributeBinding("in_seed", seedPair)]),
    ];
    const rollBindings = rollMap === undefined ? [] : [attributeBinding("in_roll", rollMap)];
    // The WHOLE packed buffer: the walk writes every region by offset (T1076).
    const outBinding = { binding: "out_points", resourceId: storage.resourceId, half: "write" as const };
    const uniformValues = {
      up: readVector(parameters, "up", [0, 1, 0]),
      cols: strips.cols,
      rows: strips.rows,
      closed: strips.closed ? 1 : 0,
      closeTwist: readFlag(parameters, "closeTwist", true),
      // Authored in degrees, because that is what a person types (the Transform node's rule).
      roll: readNumber(parameters, "roll", 0) * DEGREES_TO_RADIANS,
      twist: readNumber(parameters, "twist", 0) * DEGREES_TO_RADIANS,
    };
    const pointsets = {
      out: {
        /* §V883/§V197: the source republished by reference with the measurements on top,
           so whoever reads a frame is reading the points it was measured over. */
        pairs: { ...upstream.pairs, ...storage.pairs },
        capacity,
        // Measuring moves no slot, so the claim and a live count survive.
        ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
        ...(upstream.count === undefined ? {} : { count: upstream.count }),
      },
    };

    if (strips.cols > STRIP_WALK_BLOCK) {
      /* ── A strip longer than one block: many walks at once (the design's section 4.3) ──
         A walk's cost is its depth, so a strip is cut into blocks of STRIP_WALK_BLOCK
         points: every block is summarised on its own, one pass per strip folds the
         summaries into the state each block is entered with, and every block is walked
         again from that state and writes its points. Fixed Up hands a second thing from
         point to point (the normal a point takes where its tangent runs along Up) and has
         a summary and a fold of its own for it. The passes are in
         `nodes/shaders/curve-frames-blocked.wgsl.ts`. */
      const blocks = curveFramesBlocks(strips.cols);
      const walkId = scratchResourceId(nodeId, "walk");
      const walkBinding = { binding: "walk", resourceId: walkId };
      const blockedValues = { ...uniformValues, blocks };
      const perBlock: [number, number, number] = [Math.ceil((strips.rows * blocks) / 64), 1, 1];
      const perStrip: [number, number, number] = [Math.ceil(strips.rows / 64), 1, 1];
      const stage = (
        name: string,
        emitted: CurveFramesBlockedPass,
        workgroups: [number, number, number],
        buffers: ReadonlyArray<BufferBindingDescriptor>,
      ): DispatchPassDescriptor => ({
        kind: "dispatch",
        id: programId(`frames:${name}`),
        shader: emitted.shader,
        entryPoint: "main",
        workgroups,
        buffers,
        // The same list the shader's struct was written from: declared and set, both or neither.
        uniforms: Object.fromEntries(emitted.uniforms.map((member) => [member, blockedValues[member]])),
        uniformBinding: "params",
        nodeId,
      });
      return {
        passes: [
          stage("block", curveFramesBlockWgsl(shaderOptions), perBlock, [positionBinding, ...leanBindings, walkBinding]),
          stage("fold", curveFramesFoldWgsl(shaderOptions), perStrip, [...leanBindings, walkBinding]),
          ...(method === "fixedUp"
            ? [
                stage("chain", curveFramesChainWgsl(shaderOptions), perBlock, [positionBinding, ...leanBindings, walkBinding]),
                stage("chainFold", curveFramesChainFoldWgsl(), perStrip, [walkBinding]),
              ]
            : []),
          stage("write", curveFramesWriteWgsl(shaderOptions), perBlock, [positionBinding, ...leanBindings, ...rollBindings, walkBinding, outBinding]),
          ...endsPasses({ walk: walkBinding, values: blockedValues }),
        ],
        scratch: [{ key: "walk", kind: "buffer" as const, stride: 4, capacity: curveFramesWalkWords(strips.rows, blocks) }, ...endsScratch, storage.scratch],
        pointsets,
      };
    }

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: programId("frames"),
      shader: curveFramesWgsl(shaderOptions),
      entryPoint: "main",
      // One invocation per STRIP: each walks its own strip, in order.
      workgroups: [Math.ceil(strips.rows / 64), 1, 1],
      buffers: [positionBinding, ...leanBindings, ...rollBindings, outBinding],
      uniforms: uniformValues,
      uniformBinding: "params",
      nodeId,
    };

    return { passes: [pass, ...endsPasses(undefined)], scratch: [...endsScratch, storage.scratch], pointsets };
  },
};
