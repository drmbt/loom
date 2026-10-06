import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { MAX_KERNEL_SUBSTEPS } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import type { PointAttributeSchema } from "../../points/attributes.ts";
import { regionAccessorWgsl, regionStoreWgsl } from "../../points/packing.ts";
import { ROPE_DEFAULTS, ROPE_MAX_ITERATIONS, ROPE_MAX_STRAND_POINTS } from "../../points/rope.ts";
import { ropeStepWgsl } from "../shaders/rope.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readFlag, readNumber } from "./parameter-readers.ts";
import { attributeBinding, packedPointStorage } from "./point-storage.ts";
import { stripsOnEdge } from "./point-strips.ts";

/**
 * Rope (T1585b) — STRANDS THAT HANG, LAG AND WHIP.
 *
 * A rope in Loom is a strand: one strip of a pointset (`points/topology.ts`). This node
 * takes strips in and hands the same strips out with `position` simulated and `velocity`
 * published, so Curve Frames, Resample, Sweep and instancing take a simulated rope exactly
 * as they take an authored curve. It is Notch's Rope Deformer over line geometry, in its
 * vocabulary (Update Rate, Min and Max Update Steps, Rest Length Scale, Max Stretch,
 * Anchor First), and what TouchDesigner's staff answer "roll your own" to.
 * The design, with both products read and the method argued against its alternatives, is
 * `docs/rope-solver-design-2026-10-05.md`.
 *
 * ⚑ THE INCOMING STRIP DRIVES IT. Each strand starts on its incoming points, its segments
 * take the lengths they have there, and an anchored point is held to the incoming point of
 * its own slot every frame — so whatever animates the incoming strip (a kernel, a Curve, a
 * Line under a Transform) drags the rope, and the rope does not know what moved it. Inside
 * a frame the target moves in a straight line across the solver steps: a body at 9 m/s
 * would otherwise move its sockets 15 cm in the first step of every frame and nothing in
 * the rest, and a 60 Hz jolt would run down every rope.
 *
 * ⚑ A STRAND'S SEGMENTS ARE SOLVED TOGETHER, which is why this is a node and not a kernel
 * with a number turned up. Relaxing one segment at a time carries a correction one segment
 * per pass, and a 54-link strand then stretches by a third under the motion it is for. The
 * system those passes relax is tridiagonal on a chain, so one thread per strand solves it
 * exactly, in a walk along the strand (`nodes/shaders/rope.wgsl.ts`; the CPU reference and
 * test oracle is `points/rope.ts`).
 *
 * ⚑ TIME IS NOTCH'S. Update Rate with Min and Max Update Steps gives a step count for each
 * frame from that frame's own length, and the step is the frame's length divided by the
 * count. The node declares that as its `steps`, so the backend derives it for every frame
 * any host renders (§T1583b's loop region; `rateSubsteps`). No frame-mode branch exists
 * here (§V662), and the node reads the frame's delta and no clock: delta-driven (§V436).
 *
 * STATE (§V46): position and velocity (and tension) in one packed pair, stepped from run to
 * run; and, in a buffer of its own that only seeding and an anchor write, each segment's
 * measured length and where each anchor's target stood a frame ago. Seeded on the run that
 * finds its storage fresh (a load, a seek, a structural edit), so a backward seek replays
 * from the incoming pose (§V170).
 *
 * SLICE 1 of the design's plan: the strand and its time. One anchor (the first point); no
 * colliders, no bend, no mapped parameters yet.
 */

/** What the node steps and publishes, in the order its packed buffer lays it out. `tension` only when it is asked for. */
const STATE_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
];
const TENSION_ATTRIBUTE: PointAttributeSchema = { name: "tension", type: "f32", default: [0] };

/**
 * The attributes in a Rope's packed buffer for a given Tension switch — exported because a
 * reader of that buffer (a test, a probe) must slice it with the layout the node
 * allocated, never a second copy of the arithmetic (§V349).
 */
export function ropeAttributes(outputs: { readonly tension: boolean }): ReadonlyArray<PointAttributeSchema> {
  return outputs.tension ? [...STATE_ATTRIBUTES, TENSION_ATTRIBUTE] : STATE_ATTRIBUTES;
}

/** The scratch buffer a step works in: eight floats a point (`nodes/shaders/rope.wgsl.ts`). */
export const ROPE_SOLVE_KEY = "solve";
/**
 * What the solver keeps between frames and writes rarely, two vec4f a point: the target the
 * point's anchor had when the last frame ended (xyz) with the measured length of the
 * segment after the point (w), and how fast that target was moving then (xyz). Not in the
 * stepped pair, where every run would copy it.
 */
export const ROPE_KEPT_KEY = "kept";

const CODE = "node.points.rope";

/** The names the shader's accessors go by, per region. */
const ACCESSOR: Readonly<Record<string, string>> = {
  position: "Position",
  velocity: "Velocity",
  tension: "Tension",
};

export const pointRopeNode: NodeDefinition = {
  type: "pointRope",
  version: 1,
  title: "Rope",
  category: "points",
  description:
    "Simulates every strip of a pointset as a rope that keeps its length: it hangs, lags behind what moves it, and whips. Each strand starts on its incoming points and takes its segment lengths from them; Anchor First holds a strand's first point to the incoming point, so whatever animates the incoming strip drags the rope. Publishes position and velocity (and tension when asked). Update Rate with Min and Max Update Steps sets how many solver steps a frame runs; a strand whose anchor jumps further than Teleport Distance in one frame is moved whole (Carry) or put back on its incoming points (Reset). Put Curve Frames after it to instance or sweep along the rope.",
  tags: ["points", "rope", "chain", "cable", "tentacle", "strand", "hair", "physics", "simulation", "strips", "curve", "verlet", "xpbd"],
  inputs: [
    {
      id: "in",
      label: "Strands",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "A pointset whose edge claims strips: a Line, a Curve, a Resample, a Grid (its rows), or anything behind a Topology node set to Strips. Each strip is one rope. Its points are the pose the rope starts in, the lengths its segments keep, and the anchor's target every frame.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Strands",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "The same strips with position simulated (it replaces the incoming position) and velocity added, in metres a second; tension, in newtons in the segment after each point, when Tension is on. Capacity, the strips claim and every other attribute pass through untouched.",
    },
  ],
  parameters: {
    updateRate: {
      type: "number",
      label: "Update Rate",
      group: "Simulation",
      default: 240,
      min: 1,
      max: 3840,
      range: "bounded",
      unit: "hz",
      description:
        "Solver steps per second of the piece. At 240 on a 60 fps project a frame runs 4 steps; a frame that covers two project frames runs 8 at the same step size. Raise it for a rope that is pulled hard or has many short segments: a step has to be shorter than the time a wave takes to cross one segment.",
    },
    minSteps: {
      type: "number",
      label: "Min Update Steps",
      group: "Simulation",
      default: 1,
      min: 1,
      max: MAX_KERNEL_SUBSTEPS,
      range: "bounded",
      step: 1,
      description: "The fewest solver steps one frame runs, whatever its length. Set it equal to Max Update Steps for a fixed count.",
    },
    maxSteps: {
      type: "number",
      label: "Max Update Steps",
      group: "Simulation",
      default: 16,
      min: 1,
      max: MAX_KERNEL_SUBSTEPS,
      range: "bounded",
      step: 1,
      description:
        "The most solver steps one frame runs. A frame that would need more takes longer steps instead, so the rope stays with the timeline. Each step is one dispatch.",
    },
    iterations: {
      type: "number",
      label: "Iterations",
      group: "Simulation",
      default: ROPE_DEFAULTS.iterations,
      min: 1,
      max: ROPE_MAX_ITERATIONS,
      range: "bounded",
      step: 1,
      description:
        "The most times one solver step solves a strand's segments together. A step stops sooner, as soon as every segment is within 1/8192 of its length, so this is a ceiling for hard moments and costs nothing on calm ones.",
    },
    speed: {
      type: "number",
      label: "Simulation Speed",
      group: "Simulation",
      default: ROPE_DEFAULTS.speed,
      min: 0,
      max: 4,
      range: "floor",
      description: "Scales the time each step advances. 0 holds the rope still where it is.",
    },
    gravity: {
      type: "number",
      label: "Gravity",
      group: "Simulation",
      default: ROPE_DEFAULTS.gravity,
      min: -30,
      max: 30,
      range: "soft",
      description: "Metres a second squared toward −Y. 9.81 is a scene in metres; scale it with the scene, and set 0 for a rope adrift.",
    },
    damping: {
      type: "number",
      label: "Damping",
      group: "Simulation",
      default: ROPE_DEFAULTS.damping,
      min: 0,
      max: 20,
      range: "floor",
      description: "How fast a point's velocity falls away, per second: air at about 0.5, water at 1.5 and more. 0 swings for ever.",
    },
    mass: {
      type: "number",
      label: "Mass",
      group: "Simulation",
      default: ROPE_DEFAULTS.mass,
      min: 0.001,
      max: 100,
      range: "floor",
      description: "Kilograms per point. It scales the tension the rope reports and how much a Stretch gives; a rope of one mass moves the same whatever it weighs.",
    },
    restLengthScale: {
      type: "number",
      label: "Rest Length Scale",
      group: "Rope",
      default: ROPE_DEFAULTS.restLengthScale,
      min: 0,
      max: 4,
      range: "floor",
      description: "Multiplies the length every segment was measured at: below 1 the rope draws itself in, above 1 it pays out.",
    },
    stretch: {
      type: "number",
      label: "Stretch",
      group: "Rope",
      default: ROPE_DEFAULTS.stretch,
      min: 0,
      max: 1,
      range: "floor",
      description:
        "How much a segment gives: the fraction it lengthens per newton of tension. 0 is a rope that does not stretch; 0.001 on a one-kilogram point is a bungee. It means the same at any Update Rate.",
    },
    maxStretch: {
      type: "number",
      label: "Max Stretch",
      group: "Rope",
      default: ROPE_DEFAULTS.maxStretch,
      min: 0,
      max: 10,
      range: "floor",
      description:
        "The most a segment may be longer or shorter than its rest length at the end of a step, as a fraction: 0.02 is two percent. A guard for a step too coarse for what the rope is being put through; it moves points and adds no speed. Raise it to let a Stretch give more.",
    },
    anchorFirst: {
      type: "number",
      label: "Anchor First",
      group: "Anchors",
      default: ROPE_DEFAULTS.anchorFirst,
      min: 0,
      max: 1,
      range: "bounded",
      description:
        "How firmly the first point of each strand is held to its incoming point. 1 is the incoming point itself; 0 lets go; in between is a pull that tightens as it nears 1, so a weight that ramps moves the point without a jump.",
    },
    reset: {
      type: "boolean",
      label: "Reset",
      group: "Reset",
      default: false,
      description: "Holds the rope on its incoming points, at rest, for as long as it is on, and measures its segments again. A pulse on it is a restart.",
    },
    teleportDistance: {
      type: "number",
      label: "Teleport Distance",
      group: "Reset",
      default: ROPE_DEFAULTS.teleportDistance,
      min: 0,
      max: 1000,
      // Metres, and continuous: without a step the control derives one of 10 m and rounds to it.
      step: 0.1,
      range: "floor",
      description:
        "Metres. A strand whose anchored first point is asked to move further than this in one frame is teleported and not dragged there. 0 never teleports. Set it well above what the anchor travels in a frame: for a world that wraps every 960 m, 100.",
    },
    teleportMode: {
      type: "enum",
      label: "Teleport",
      group: "Reset",
      default: ROPE_DEFAULTS.teleportMode,
      options: [
        { value: "carry", label: "Carry" },
        { value: "reset", label: "Reset" },
      ],
      inactiveWhen: (values) => (readNumber(values, "teleportDistance", 0) > 0 ? null : "Teleport Distance is 0, so nothing teleports."),
      description:
        "What a teleport does. Carry moves every point of the strand by the jump and keeps its shape and its speed: for a world that wraps. Reset puts the strand back on its incoming points at rest: for a cut to another place.",
    },
    tensionOutput: {
      type: "boolean",
      label: "Tension",
      group: "Output",
      default: false,
      compileTime: true,
      description: "Publish tension (f32): the newtons in the segment after each point, 0 on a strand's last point. A hanging rope reads the weight below each point.",
    },
  },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  // The count follows the frame: clamp(round(delta × Update Rate), Min, Max). One run a step.
  steps: { substeps: { rate: "updateRate", min: "minSteps", max: "maxSteps" } },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters, parameterMaps } = readCompileInputs(context);
    const strands = inputs["in"];
    if (strands === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "in"')] };
    }
    const upstream = strands.pointset;
    const position = upstream?.pairs["position"];
    if (upstream === undefined || position === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the strands edge carries no resolved position pair (producer predates T296?).`,
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

    const claimed = stripsOnEdge(nodeId, "Rope", upstream);
    if ("refusal" in claimed) return claimed.refusal;
    const strips = claimed.strips;
    if (strips.closed) {
      return refuse(
        "the incoming strips are closed, and a rope has two ends: a loop's segments do not form a chain this solver can walk.",
        "Open the claim with a Topology node (Connectivity: Strips, Closed off) before the Rope.",
      );
    }
    if (strips.cols > ROPE_MAX_STRAND_POINTS) {
      return refuse(
        `each strand has ${strips.cols} points, and one walk solves at most ${ROPE_MAX_STRAND_POINTS}.`,
        `Resample to ${ROPE_MAX_STRAND_POINTS} points a strand or fewer, or split the strand into several.`,
      );
    }
    if (upstream.count !== undefined) {
      return refuse(
        "the incoming pointset carries a GPU live count, and a rope simulates a fixed set of points: the slots past the count are not part of any strand.",
        "Feed it a static producer; a strand shorter than its slots is padded with a `live` attribute, not counted.",
        "node.points.input",
      );
    }
    // §V288: a map this slice cannot honour refuses BY NAME rather than reading the static.
    const mapped = Object.keys(parameterMaps).sort();
    if (mapped.length > 0) {
      return refuse(
        `${mapped.join(", ")} ${mapped.length === 1 ? "is" : "are"} in map mode, and no Rope parameter reads an attribute yet.`,
        "Switch it back to Constant, or drive it through the value graph instead.",
        "node.parameter.map",
      );
    }

    const tension = parameters["tensionOutput"] === true;
    const owned = ropeAttributes({ tension });
    /* A name already on the edge is REPLACED when its type agrees and refused when it does
       not (Gather's rule): `velocity` as vec3f over an f32 `velocity` would be swizzled
       wrong by whoever mapped the old one. */
    for (const attribute of owned) {
      const existing = upstream.pairs[attribute.name];
      if (existing !== undefined && existing.type !== undefined && existing.type !== attribute.type) {
        return refuse(
          `publishing "${attribute.name}" as ${attribute.type} would change the type of the "${attribute.name}" (${existing.type}) these points already carry.`,
          "Rename the incoming attribute upstream.",
        );
      }
    }

    const capacity = upstream.capacity;
    const storage = packedPointStorage(nodeId, owned, capacity, "write");
    if (!storage.ok) return refuse(storage.errors.join(" "), undefined, "node.points.capacity");

    const regions = storage.layout.regions;
    const loadFunctions = regions
      .map((region) => regionAccessorWgsl(`load${ACCESSOR[region.name] as string}`, "state_in", region))
      .join("\n\n");
    const storeFunctions = regions
      .map((region) => regionStoreWgsl(`store${ACCESSOR[region.name] as string}`, "state_out", region))
      .join("\n\n");
    const solveId = scratchResourceId(nodeId, ROPE_SOLVE_KEY);
    const keptId = scratchResourceId(nodeId, ROPE_KEPT_KEY);
    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      /* Everything in the id changes the program's text (§V62b): the Tension switch decides
         which regions exist, and the capacity moves every region's offset. */
      id: `${nodeId}:rope:step:${tension ? "t" : ""}:${String(capacity)}`,
      shader: ropeStepWgsl({ loadFunctions, storeFunctions, tension }),
      entryPoint: "main",
      // One invocation per STRAND: each walks its own strand.
      workgroups: [Math.ceil(strips.rows / 64), 1, 1],
      buffers: [
        // The producer's region, WRITE half: this frame's incoming points, in plan order (§V168).
        attributeBinding("in_position", position),
        // The WHOLE packed buffer, both halves: the walk addresses regions by offset (T1076).
        { binding: "state_in", resourceId: storage.resourceId, half: "read" as const },
        { binding: "state_out", resourceId: storage.resourceId, half: "write" as const },
        { binding: "kept", resourceId: keptId },
        { binding: "scratch", resourceId: solveId },
      ],
      uniforms: {
        /* The backend's four, written for every run of the stepped dispatch
           (`dispatchStepUniforms`): reserved here because vgpu matches uniforms by name. */
        deltaSeconds: 0,
        substep: 0,
        substeps: 1,
        firstRun: 0,
        cols: strips.cols,
        rows: strips.rows,
        /* The Iterations parameter, under ANOTHER name on purpose. The backend writes a
           stepped dispatch's own `iterations` (runs per substep, 1 here) into any member of
           that name, so a block that called its Newton cap `iterations` read 1 whatever the
           parameter said — found by the sway test, which stood at two tolerances. */
        solves: Math.min(ROPE_MAX_ITERATIONS, Math.max(1, Math.round(readNumber(parameters, "iterations", ROPE_DEFAULTS.iterations)))),
        reset: readFlag(parameters, "reset", false),
        teleportMode: parameters["teleportMode"] === "reset" ? 1 : 0,
        speed: Math.max(0, readNumber(parameters, "speed", ROPE_DEFAULTS.speed)),
        gravity: readNumber(parameters, "gravity", ROPE_DEFAULTS.gravity),
        damping: Math.max(0, readNumber(parameters, "damping", ROPE_DEFAULTS.damping)),
        inverseMass: 1 / Math.max(0.001, readNumber(parameters, "mass", ROPE_DEFAULTS.mass)),
        restLengthScale: Math.max(0, readNumber(parameters, "restLengthScale", ROPE_DEFAULTS.restLengthScale)),
        stretch: Math.max(0, readNumber(parameters, "stretch", ROPE_DEFAULTS.stretch)),
        maxStretch: Math.max(0, readNumber(parameters, "maxStretch", ROPE_DEFAULTS.maxStretch)),
        anchorFirst: readNumber(parameters, "anchorFirst", ROPE_DEFAULTS.anchorFirst),
        teleportDistance: Math.max(0, readNumber(parameters, "teleportDistance", ROPE_DEFAULTS.teleportDistance)),
      },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [
        { key: ROPE_KEPT_KEY, kind: "buffer" as const, stride: 16, capacity: capacity * 2 },
        { key: ROPE_SOLVE_KEY, kind: "buffer" as const, stride: 4, capacity: capacity * 8 },
        storage.scratch,
      ],
      pointsets: {
        out: {
          /* §V197: everything the rope does not write passes by reference, so a frame's
             seed quaternion, a `live` flag and a material's fields reach what draws the
             rope. `position` is the rope's own from here on. */
          pairs: { ...upstream.pairs, ...storage.pairs },
          capacity,
          // Simulating moves no slot, so the strips claim survives.
          ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
        },
      },
    };
  },
};
