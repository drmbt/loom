import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import {
  ATTRIBUTE_STRIDES,
  COMPONENT_COUNTS,
  POINT_ATTRIBUTE_TYPES,
  type PointAttributeSchema,
  type PointAttributeType,
} from "../../points/attributes.ts";
import { MAX_KERNEL_STORAGE_BINDINGS } from "../../points/codegen.ts";
import {
  SWEEP_CAPS,
  SWEEP_PROFILES,
  SWEEP_RING_MIN_SIDES,
  SWEEP_UV_ALONG,
  sweepCapRows,
  sweepColumnCount,
  type SweepCaps,
  type SweepProfile,
  type SweepUvAlong,
} from "../../points/sweep.ts";
import { formatTopology } from "../../points/topology.ts";
import { sweepWgsl, type SweepCarriedAttribute, type SweepRegion, type SweepShaderOptions } from "../shaders/sweep.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { packedPointStorage } from "./point-storage.ts";
import { stripsOnEdge } from "./point-strips.ts";
import { resolveScalarMap } from "./points.ts";

/**
 * Sweep (T1587b) — A PROFILE CARRIED ALONG A CURVE INTO A SURFACE.
 *
 * A ring, a square, a flat strip or an outline of the author's own is placed at every point
 * of a path and the copies are joined into a sheet: a tube, a tunnel, a cable, a ribbon, a
 * rail. It is TouchDesigner's Sweep SOP (which has no GPU twin) and Notch's Spline Extruder
 * (`docs/sweep-design-2026-10-05.md`, section 1).
 *
 * ⚑ WHAT COMES OUT IS A GRID, AND THE RENDER LIGHTS IT FROM ITS POINTS (the design's D1).
 * Columns go round the profile and rows along the path, on a `grid:` claim, so a Geometry
 * in Surface mode draws it with the path it already has: lit, shadowed and in the G-buffer.
 * That path works its normal out from the positions, so a kernel AFTER the sweep is free to
 * write `position` — push a relief in, clamp a deck to a level plane — and the surface is
 * lit by the shape it ends up with. A mesh claim would carry a normal attribute the kernel
 * would have to keep right by hand.
 *
 * ⚑ HARD EDGES AND CAPS ARE REPEATED COLUMNS AND ROWS, never an index list. Two columns in
 * one place take one-sided differences, so each gets its own side's normal: a Square is
 * eight columns, a Ring with Smooth off is two a side. A cap is the end ring again and then
 * that ring drawn in to the path point (`points/sweep.ts`, rules 3 and 4).
 *
 * ⚑ THE FRAME IS CURVE FRAMES' (D5). The path must carry `orient`; this node has no twist
 * or roll of its own, so a sweep and the instances along the same curve agree by
 * construction. A taper is a mapped Radius; a part of a path is Resample's Range upstream.
 *
 * ⚑ `normal` IS PUBLISHED FOR A KERNEL, NOT FOR THE LIGHT (D4): the outline's own normal in
 * the ring's plane, on the side Facing names, so "push the wall in" is one line. `uv` is the
 * way round and the way along. Every other attribute of the path point is copied to each
 * vertex of its ring, except the frame's own.
 *
 * ⚑ SEVERAL STRIPS ARE SEVERAL SHEETS (slice 2). Ten strands from a rope, a run of pipes
 * from one kernel: each strip of the path is swept into a sheet of its own, and the claim
 * says how many, `grid:{columns}x{rows}x{strips}`. A Geometry draws them all in ONE draw
 * and joins none to the next. Rows, caps and both wraps are one sheet's; a strip shorter
 * than its slots repeats its end, so its padding is rings of no area and draws nothing.
 * One strip is the plain claim and the program it always was.
 *
 * STATELESS and clock-free: one thread per vertex, each from one path point and one profile
 * point (`nodes/shaders/sweep.wgsl.ts`), so there is nothing to reset on a seek (§V170).
 */

const CODE = "node.points.sweep";
/** The engine's pointset ceiling, as every producer's Capacity states it. */
const MAX_POINTS = 1_000_000;

const PROFILE_OPTIONS: ReadonlyArray<{ readonly value: SweepProfile; readonly label: string }> = [
  { value: "ring", label: "Ring" },
  { value: "square", label: "Square" },
  { value: "strip", label: "Strip" },
  { value: "custom", label: "Custom" },
];
const CAPS_OPTIONS: ReadonlyArray<{ readonly value: SweepCaps; readonly label: string }> = [
  { value: "none", label: "None" },
  { value: "start", label: "Start" },
  { value: "end", label: "End" },
  { value: "both", label: "Both" },
];
const UV_OPTIONS: ReadonlyArray<{ readonly value: SweepUvAlong; readonly label: string }> = [
  { value: "stretch", label: "Stretch" },
  { value: "metres", label: "Metres" },
  { value: "points", label: "Points" },
];

/** What the sweep makes for itself, ahead of what it carries. */
const OWN_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 0, 1] },
  { name: "uv", type: "vec2f", default: [0, 0] },
];
/** The path attributes a ring does not copy: its own three, and the frame it was placed by. */
const NOT_CARRIED: ReadonlySet<string> = new Set(["position", "normal", "uv", "orient", "tangent", "binormal"]);

/**
 * The attributes a Sweep owns, in the order its packed buffer lays them out: position,
 * normal and uv, then everything else the path carries, by name. Exported because a reader
 * of the buffer must slice it with the layout the node allocated, never a second copy of
 * the arithmetic (§V349).
 */
export function sweepAttributes(
  carried: ReadonlyArray<{ readonly name: string; readonly type: PointAttributeType }>,
): ReadonlyArray<PointAttributeSchema> {
  const others = carried
    .filter((attribute) => !NOT_CARRIED.has(attribute.name))
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    ...OWN_ATTRIBUTES,
    ...others.map((attribute) => ({ name: attribute.name, type: attribute.type, default: Array<number>(COMPONENT_COUNTS[attribute.type]).fill(0) })),
  ];
}

const profileOf = (values: Readonly<Record<string, unknown>>): SweepProfile =>
  (SWEEP_PROFILES as ReadonlyArray<string>).includes(values["profile"] as string) ? (values["profile"] as SweepProfile) : "ring";
const capsOf = (values: Readonly<Record<string, unknown>>): SweepCaps =>
  (SWEEP_CAPS as ReadonlyArray<string>).includes(values["caps"] as string) ? (values["caps"] as SweepCaps) : "none";
const uvAlongOf = (values: Readonly<Record<string, unknown>>): SweepUvAlong =>
  (SWEEP_UV_ALONG as ReadonlyArray<string>).includes(values["uvAlong"] as string) ? (values["uvAlong"] as SweepUvAlong) : "stretch";

/** What each coordinate along reads from the path, beyond its points. */
function metricsRead(uvAlong: SweepUvAlong, capped: boolean, pathClosed: boolean): ReadonlyArray<"distance" | "curveU" | "curveLength"> {
  if (uvAlong === "points") return [];
  if (uvAlong === "stretch") return capped ? ["curveU", "curveLength"] : ["curveU"];
  return pathClosed ? ["distance", "curveLength"] : ["distance"];
}

export const pointSweepNode: NodeDefinition = {
  type: "pointSweep",
  version: 1,
  title: "Sweep",
  category: "points",
  description:
    "Carries a profile along a curve and joins the copies into a surface: a tube, a tunnel, a cable, a ribbon, a rail. Path is strips that carry orient, so put a Curve Frames before it; the profile sits in each frame's X and Y, and each strip is swept into a tube of its own. Profile is a Ring (Sides round), a Square, a flat Strip, or Custom, the first strip of the Profile input. Radius is its half-width, and in Map mode an attribute of the path multiplies it per point: a taper. Caps close the ends. The output is a grid, columns round the profile and rows along the path, so a Geometry in Surface mode draws it lit and shadowed. Each vertex has a normal for a kernel to push along, a uv (round the profile, and along the path as Stretch, Metres or Points), and every attribute of its path point. A kernel after the sweep may move the vertices: the surface is lit by the shape it ends up with. Several strips make several sheets in one grid, which a Geometry draws in one draw.",
  tags: ["points", "curve", "sweep", "extrude", "tube", "tunnel", "cable", "ribbon", "pipe", "surface", "grid", "strips", "profile", "spline"],
  inputs: [
    {
      id: "points",
      label: "Path",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "The strips to sweep along, each into a sheet of its own, carrying orient (a vec4f quaternion: +Z down the curve, +Y its normal): a Curve Frames, usually after a Resample. Closed strips make loops.",
    },
    {
      id: "profile",
      label: "Profile",
      optional: true,
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "Read when Profile is Custom: a pointset whose edge claims strips. Its first strip is the outline, each point's x and y in the frame's X and Y, going from +X toward +Y for a surface that faces away from the path. A closed strip closes the outline.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "A grid: columns round the profile, rows along the path (a cap adds two rows at its end), one sheet per strip of the path. position, normal (vec3f: the outline's own normal in the ring's plane, the end's on a cap, on the side Facing names), uv (vec2f: the texture coordinate a Surface's material reads) and every attribute of the path point except its frame, copied to each vertex of its ring. A kernel's ctx.dim reads one sheet's columns and rows, and ctx.dim.sheet says which sheet.",
    },
  ],
  parameters: {
    profile: {
      type: "enum",
      label: "Profile",
      default: "ring",
      compileTime: true,
      // §V831: APPEND only.
      options: [...PROFILE_OPTIONS],
      description:
        "Ring: Sides points on a circle. Square: four flat sides, a flat up. Strip: a flat ribbon across the frame's X, lit on its +Y side. Custom: the outline wired to Profile.",
    },
    sides: {
      type: "number",
      label: "Sides",
      default: 16,
      min: 1,
      max: 1024,
      range: "bounded",
      step: 1,
      compileTime: true,
      inactiveWhen: (values) =>
        profileOf(values) === "square" ? "A Square has four sides." : profileOf(values) === "custom" ? "A Custom profile has the sides its points make." : null,
      description: `Ring: sides round, at least ${SWEEP_RING_MIN_SIDES}. Strip: segments across. Changing it reallocates.`,
    },
    smooth: {
      type: "boolean",
      label: "Smooth",
      default: true,
      compileTime: true,
      inactiveWhen: (values) =>
        profileOf(values) === "square" ? "A Square's sides are always flat." : profileOf(values) === "strip" ? "A Strip is one flat side." : null,
      description:
        "Ring and Custom. On: one normal a corner, so a few sides read as a round tube; a Custom outline is sharp only where it repeats a point. Off: every side flat, at two columns a side.",
    },
    radius: {
      type: "number",
      label: "Radius",
      default: 0.1,
      min: 0,
      range: "floor",
      step: 0.01,
      description:
        "The profile's half-width, metres: a Ring's radius, half a Square's or a Strip's width, and what multiplies a Custom outline's own x and y (1 keeps its size). In Map mode an f32 attribute of the path (or one channel of a float vector) MULTIPLIES it per point: a taper, a swelling, a hall in a tunnel. A map that goes to nothing at both ends closes the tube into a spindle, with no cap rows.",
    },
    caps: {
      type: "enum",
      label: "Caps",
      default: "none",
      compileTime: true,
      // §V831: APPEND only.
      options: [...CAPS_OPTIONS],
      description:
        "Closes an end with a flat face: the end ring drawn in to the path point. It is a fan, so it suits an outline that can see the path point from all round (a Ring, a Square, any convex outline). A closed path has no ends and gets none.",
    },
    facing: {
      type: "enum",
      label: "Facing",
      default: "outward",
      compileTime: true,
      options: [
        { value: "outward", label: "Outward" },
        { value: "inward", label: "Inward" },
      ],
      description:
        "Which way the surface's normal points: away from the path, or toward it for a tunnel seen from inside. It decides the normal attribute, the Render's Normal output and what a material's normal starts from; a surface is lit on both sides either way.",
    },
    uvAlong: {
      type: "enum",
      label: "UV Along",
      default: "stretch",
      compileTime: true,
      // §V831: APPEND only.
      options: [...UV_OPTIONS],
      description:
        "uv.y, the coordinate along the path. Stretch: 0 at the path's start, 1 at its end, by distance. Metres: distance ÷ Tile Length, so a pattern keeps its size whatever the spacing of the rings. Points: the row over the rows. Stretch and Metres read Curve Frames' Metrics.",
    },
    uvLength: {
      type: "number",
      label: "Tile Length",
      default: 1,
      min: 0,
      range: "floor",
      step: 0.01,
      inactiveWhen: (values) => (uvAlongOf(values) === "metres" ? null : "Only Metres reads a tile length."),
      description:
        "Metres: metres of curve to one tile of uv.y. On a closed path the number of tiles is rounded to a whole number, so the pattern meets itself at the seam.",
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters, parameterMaps } = readCompileInputs(context);
    const path = inputs["points"];
    if (path === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "points"')] };
    }
    const upstream = path.pointset;
    const position = upstream?.pairs["position"];
    const refuse = (message: string, suggestion?: string, code = CODE): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        { severity: "error", code, message: `Node "${nodeId}": ${message}`, nodeId, ...(suggestion === undefined ? {} : { suggestion }) },
      ],
    });
    if (upstream === undefined || position === undefined) {
      return refuse("the path edge carries no resolved position pair (producer predates T296?).", undefined, "node.points.edge");
    }
    if (position.type !== "vec3f") return refuse(`the path's position is ${position.type ?? "untyped"}, not vec3f.`, undefined, "node.points.edge");

    const claimed = stripsOnEdge(nodeId, "Sweep", upstream);
    if ("refusal" in claimed) return claimed.refusal;
    const strips = claimed.strips;
    if (upstream.count !== undefined) {
      return refuse(
        "the path carries a GPU live count, and a strip's slots are fixed — the slots past the count are not padding, so they would be swept as curve.",
        "Sweep a static producer, or a kernel behind a Topology node set to Strips.",
      );
    }
    if (strips.cols < 2) {
      return refuse(
        `${strips.rows === 1 ? "the path has" : "each strip of the path has"} one point, and a sweep needs two to have a length.`,
        "Give the path more points: a Resample by Count.",
      );
    }
    /* Slice 2: a strip is a sheet. Rows, caps and wraps below are ONE sheet's. */
    const sheets = strips.rows;

    // §V288: a map this node cannot honour refuses BY NAME rather than reading the static.
    const unhonoured = Object.keys(parameterMaps).filter((key) => key !== "radius").sort();
    if (unhonoured.length > 0) {
      return refuse(
        `${unhonoured.join(", ")} ${unhonoured.length === 1 ? "is" : "are"} in map mode, but a Sweep maps only "radius".`,
        "Switch it back to Constant, or drive it through the value graph instead.",
        "node.parameter.map",
      );
    }
    /* §V306: this node has two pointset inputs, and a Map reads ONE of them — the path,
       where the per-ring values are. A map that names the profile is refused with the
       reason, not resolved against the wrong pointset. */
    if (parameterMaps["radius"]?.port === "profile") {
      return refuse(
        'radius maps port "profile", but a Map reads a value per ring and those are on the Path input; Profile is the outline every ring is made from.',
        "Map an attribute of the path.",
        "node.parameter.map",
      );
    }

    const available = Object.keys(upstream.pairs).sort();
    const orient = upstream.pairs["orient"];
    if (orient === undefined || orient.type !== "vec4f") {
      return refuse(
        orient === undefined
          ? 'the path carries no "orient", the frame the profile is placed in at each point.'
          : `the path's "orient" is ${orient.type ?? "untyped"}; a frame is a vec4f quaternion.`,
        `Put a Curve Frames before the Sweep with Frame on. The path provides: ${available.join(", ")}.`,
      );
    }

    const profile = profileOf(parameters);
    const sides = Math.round(readNumber(parameters, "sides", 16));
    const smooth = parameters["smooth"] !== false;
    const inward = parameters["facing"] === "inward";
    const pathClosed = strips.closed;
    const capRows = sweepCapRows(capsOf(parameters), pathClosed);
    const capped = capRows.start + capRows.end > 0;
    const uvAlong = uvAlongOf(parameters);

    /* One binding per upstream BUFFER, whole, read by offset (T1076): a path that came
       through a Resample, a kernel and a Curve Frames is three of them. */
    const groups: Array<{ readonly resourceId: string; readonly half: "read" | "write" }> = [];
    const groupOf = (ref: PointsetAttributeRef): number => {
      const found = groups.findIndex((group) => group.resourceId === ref.buffer && group.half === ref.half);
      if (found >= 0) return found;
      groups.push({ resourceId: ref.buffer, half: ref.half });
      return groups.length - 1;
    };
    const regionOf = (ref: PointsetAttributeRef): SweepRegion => ({ group: groupOf(ref), word: ref.offset / 4 });
    // The path's points first, then its frame: the order a plan reads in.
    const positionRegion = regionOf(position);
    const orientRegion = regionOf(orient);

    /* ── The outline: how many points, whether it closes, whether its sides are flat ── */
    let outline: { readonly points: number; readonly closed: boolean; readonly flat: boolean };
    let outlineRegion: SweepRegion | undefined;
    if (profile === "custom") {
      const wired = inputs["profile"]?.pointset;
      if (wired === undefined) {
        return refuse(
          "Profile is Custom and nothing is wired to the Profile input.",
          "Wire a pointset whose edge claims strips (a Curve, a Circle, a kernel behind a Topology node), or pick Ring, Square or Strip.",
        );
      }
      const outlineClaim = stripsOnEdge(nodeId, "A Sweep's Profile", wired);
      if ("refusal" in outlineClaim) return outlineClaim.refusal;
      const outlinePosition = wired.pairs["position"];
      if (outlinePosition === undefined || outlinePosition.type !== "vec3f") {
        return refuse(`the Profile's position is ${outlinePosition?.type ?? "missing"}, not vec3f.`, undefined, "node.points.edge");
      }
      if (wired.count !== undefined) {
        return refuse(
          "the Profile carries a GPU live count, and an outline's points are fixed slots.",
          "Wire a static producer, or a kernel behind a Topology node set to Strips.",
        );
      }
      if (outlineClaim.strips.cols < 2) {
        return refuse("the Profile's strip has one point, and an outline needs two to have a side.", "Give the Profile more points.");
      }
      outline = { points: outlineClaim.strips.cols, closed: outlineClaim.strips.closed, flat: !smooth };
      outlineRegion = regionOf(outlinePosition);
    } else if (profile === "square") {
      outline = { points: 4, closed: true, flat: true };
    } else if (profile === "strip") {
      outline = { points: Math.max(1, sides) + 1, closed: false, flat: false };
    } else {
      outline = { points: Math.max(SWEEP_RING_MIN_SIDES, sides), closed: true, flat: !smooth };
    }

    const cols = sweepColumnCount({ points: { length: outline.points }, closed: outline.closed, flat: outline.flat });
    const rows = capRows.start + strips.cols + capRows.end;
    const capacity = cols * rows * sheets;
    if (capacity > MAX_POINTS) {
      return refuse(
        `${cols} columns round the profile by ${rows} rows along the path${sheets === 1 ? "" : `, for each of ${sheets} strips,`} are ${capacity} vertices, over the ${MAX_POINTS} a pointset holds.`,
        `Lower ${profile === "custom" ? "the Profile's point count" : "Sides"}, or the path's points (a Resample with a wider Distance).`,
        "node.points.capacity",
      );
    }

    /* ── What the coordinate along reads: Curve Frames' metrics, refused by name without them ── */
    const metrics: Partial<Record<"distance" | "curveU" | "curveLength", SweepRegion>> = {};
    for (const name of metricsRead(uvAlong, capped, pathClosed)) {
      const carriedMetric = upstream.pairs[name];
      if (carriedMetric === undefined || carriedMetric.type !== "f32") {
        return refuse(
          carriedMetric === undefined
            ? `UV Along is ${uvAlong === "stretch" ? "Stretch" : "Metres"}, which reads the path's "${name}", and the path does not carry it.`
            : `UV Along is ${uvAlong === "stretch" ? "Stretch" : "Metres"}, which reads the path's "${name}" as an f32; it is ${carriedMetric.type ?? "untyped"}.`,
          `Turn Metrics on on the Curve Frames before the Sweep, or set UV Along to Points. The path provides: ${available.join(", ")}.`,
        );
      }
      metrics[name] = regionOf(carriedMetric);
    }

    const resolvedRadius = resolveScalarMap(nodeId, parameterMaps["radius"], upstream, "points", "radius");
    if ("refusal" in resolvedRadius) return resolvedRadius.refusal;
    const radiusMap = resolvedRadius.map;

    /* ── What each ring copies from its path point ── */
    const carried: Array<{ name: string; type: PointAttributeType; ref: PointsetAttributeRef }> = [];
    for (const name of available) {
      if (NOT_CARRIED.has(name)) continue;
      const ref = upstream.pairs[name] as PointsetAttributeRef;
      if (ref.type === undefined || !(POINT_ATTRIBUTE_TYPES as ReadonlyArray<string>).includes(ref.type)) {
        return refuse(
          `the path attribute "${name}" is ${ref.type === undefined ? "untyped" : `typed "${ref.type}"`}, so it cannot be copied; a Sweep owns every attribute of its output.`,
          "The producer predates typed pairs.",
        );
      }
      carried.push({ name, type: ref.type as PointAttributeType, ref });
    }
    const schema = sweepAttributes(carried);
    const storage = packedPointStorage(nodeId, schema, capacity, "write");
    if (!storage.ok) return refuse(storage.errors.join(" "), undefined, "node.points.capacity");
    const wordOf = (name: string): number => (storage.layout.byName.get(name)?.offset ?? 0) / 4;

    const byName = new Map(carried.map((entry) => [entry.name, entry]));
    const copied: SweepCarriedAttribute[] = [];
    for (const region of storage.layout.regions) {
      const source = byName.get(region.name);
      if (source === undefined) continue; // position, normal, uv: made here.
      copied.push({
        group: groupOf(source.ref),
        inWord: source.ref.offset / 4,
        outWord: region.offset / 4,
        strideWords: ATTRIBUTE_STRIDES[source.type] / 4,
        components: COMPONENT_COUNTS[source.type],
      });
    }
    const radiusRegion =
      radiusMap === undefined
        ? undefined
        : {
            ...regionOf(radiusMap),
            strideWords: ATTRIBUTE_STRIDES[radiusMap.type as PointAttributeType] / 4,
            component: radiusMap.channel === undefined ? 0 : ["x", "y", "z", "w"].indexOf(radiusMap.channel),
          };

    /* §V588: a stage binds eight storage buffers, and this node's own is one of them. */
    if (groups.length + 1 > MAX_KERNEL_STORAGE_BINDINGS) {
      return refuse(
        `the path's attributes and the profile come from ${groups.length} producers, and a pass binds ${MAX_KERNEL_STORAGE_BINDINGS} buffers with this node's own (§V588).`,
        "Gather the path's attributes in one kernel before the Sweep, so they come from one producer.",
      );
    }

    /* ── The uniform block, as ONE list the shader's struct and the pass's record both read ── */
    const members: Array<{ name: string; type: string; value: number }> = [
      { name: "cols", type: "u32", value: cols },
      { name: "rows", type: "u32", value: rows },
      { name: "pathPoints", type: "u32", value: strips.cols },
      { name: "profilePoints", type: "u32", value: outline.points },
      { name: "startRows", type: "u32", value: capRows.start },
      { name: "radius", type: "f32", value: Math.max(0, readNumber(parameters, "radius", 0.1)) },
    ];
    if (uvAlong === "metres") members.push({ name: "uvLength", type: "f32", value: Math.max(readNumber(parameters, "uvLength", 1), 1e-6) });
    // Only a path of several strips has the member: one strip's block is the one it always was.
    if (sheets > 1) members.push({ name: "sheets", type: "u32", value: sheets });

    const shaderOptions: SweepShaderOptions = {
      profile,
      flat: outline.flat,
      profileClosed: outline.closed,
      inward,
      pathClosed,
      capped,
      sheets: sheets > 1,
      uvAlong,
      members: members.map(({ name, type }) => ({ name, type })),
      groups: groups.length,
      position: positionRegion,
      orient: orientRegion,
      ...(radiusRegion === undefined ? {} : { radius: radiusRegion }),
      ...metrics,
      ...(outlineRegion === undefined ? {} : { outline: outlineRegion }),
      carried: copied,
      out: { position: wordOf("position"), normal: wordOf("normal"), uv: wordOf("uv") },
    };

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      /* The shader text already differs wherever the program does (the profile, the
         facing, every offset); the id says the same things a person would want to read. */
      id: [
        `${nodeId}:sweep:${profile}`,
        outline.flat ? "flat" : "",
        inward ? "inward" : "",
        uvAlong,
        capped ? `caps${capRows.start}${capRows.end}` : "",
        radiusMap === undefined ? "" : "radius",
        `${cols}x${rows}${sheets === 1 ? "" : `x${sheets}`}`,
      ]
        .filter((part) => part !== "")
        .join(":"),
      shader: sweepWgsl(shaderOptions),
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
          // Every pair is this node's own: a sweep has a ring of vertices for each path point.
          pairs: storage.pairs,
          capacity,
          topology: formatTopology({ kind: "grid", cols, rows, wrapU: outline.closed, wrapV: pathClosed, ...(sheets > 1 ? { sheets } : {}) }),
        },
      },
    };
  },
};
