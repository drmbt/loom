import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { MAX_KERNEL_SUBSTEPS } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import type { PointAttributeSchema, PointAttributeType } from "../../points/attributes.ts";
import { ATTRIBUTE_STRIDES } from "../../points/attributes.ts";
import { MAX_KERNEL_STORAGE_BINDINGS } from "../../points/codegen.ts";
import { regionAccessorWgsl, regionStoreWgsl } from "../../points/packing.ts";
import { ROPE_DEFAULTS, ROPE_MAX_ITERATIONS, ROPE_MAX_STRAND_POINTS } from "../../points/rope.ts";
import { ropeScratchFloats, ropeStepWgsl } from "../shaders/rope.wgsl.ts";
import type { RopeScalarRegion } from "../shaders/rope.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readFlag, readNumber } from "./parameter-readers.ts";
import { packedPointStorage } from "./point-storage.ts";
import { stripsOnEdge } from "./point-strips.ts";
import { resolveScalarMap } from "./points.ts";
import type { ScalarMap } from "./points.ts";

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
 * run; and, in a buffer of its own that only seeding and a station write, each segment's
 * measured length and where each station's target stood a frame ago — kept whatever the
 * station's weight is, so that a weight rising from nothing finds a target already followed. Seeded on the run that
 * finds its storage fresh (a load, a seek, a structural edit), so a backward seek replays
 * from the incoming pose (§V170).
 *
 * ⚑ ANCHORS (slice 2). Three stations of a strand may be held — its first point, its
 * second and its last — each by a weight that is a number or, in Map mode, an attribute
 * read at that strand's own station: a weight per strand, which is "this claw lets go and
 * that one holds". A Pin Attribute is a weight on every point. Hard, a weight of 1 is the
 * incoming point itself and anything less is a spring that stiffens toward it; Soft, 1 is
 * still a spring. Two anchors further apart than the rope can reach: the earlier holds, and
 * the later falls short (the Curve node's Arc, in the same words). The reach is what the
 * rope can be in a solver step (B276): its own length with no Stretch, more with one and at
 * a higher Update Rate, never past Max Stretch.
 *
 * ⚑ BEND LIMIT (slice 4). With it on, no joint turns tighter than a circle of Min Bend
 * Radius: rigid rings instanced along the rope do not pass through each other. It is a
 * limit and not a spring, and it is IN the solve — a row per joint beside the row per
 * segment, one banded system — because the case it is for is a rope at rest, whose loop
 * closes under its own weight in every step. Its rows are COMPLIANT (the design's D30), so
 * a step has an answer where the limit cannot be met, and LENGTH COMES BEFORE BEND: a step
 * that cannot keep the rope's length with the limit in it is solved again without it. It is
 * another program, so the switch is structure, and with it off the step is the tridiagonal
 * one, with none of the limit's text.
 *
 * ⚑ WHERE THE LIMIT CANNOT BE MET IT GIVES (slice 4b, the design's D41). A joint that gives
 * more than a yield for longer than a wait, or pushes at all on a strand whose step could
 * not be finished, has its limit opened, and the opening is kept from step to step: a strand
 * between two held ends with less slack than a turn of the radius needs comes to rest
 * there, where it used to be thrown. The opening closes when the pose lets it.
 *
 * ⚑ LETTING GO IS SPEEDLESS (slice 4b, the design's D38). In the step a segment that two
 * hard pins held comes free it takes its own length, in positions only, as the Max Stretch
 * guard and Teleport Carry move points: a strand held longer than itself is not thrown.
 *
 * SLICES 1, 2, 4 AND 4B of the design's plan: the strand, its time, its anchors and its bend
 * limit. No colliders yet, and no Bend Stiffness: the spring under the limit is its own
 * slice, and so is a softness for the limit that an author sets.
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

/**
 * The scratch buffer a step works in: eight floats a point, twenty with Bend Limit on
 * (`nodes/shaders/rope.wgsl.ts`). Two of them are read by the NEXT step and so outlive the
 * one that wrote them: a point's inverse mass (nothing: it was a hard pin), and with Bend
 * Limit on its joint's clock.
 */
export const ROPE_SOLVE_KEY = "solve";
/**
 * What the solver keeps between frames and writes rarely, two vec4f a point: the target the
 * point's anchor had when the last frame ended (xyz) with the measured length of the
 * segment after the point (w), and how fast that target was moving then (xyz, the strand's
 * first point only) with what the limit of the joint at the point is let out by, in radians
 * (w, Bend Limit on). Not in the stepped pair, where every run would copy it.
 */
export const ROPE_KEPT_KEY = "kept";

const CODE = "node.points.rope";

/** The three weights that take Map mode: each is read at its own station of each strand. */
const STATIONS = ["anchorFirst", "anchorSecond", "anchorLast"] as const;

/** The step's own buffers beside what it reads upstream: both halves of the pair, kept, scratch. */
const OWN_BINDINGS = 4;

/** The names the shader's accessors go by, per region. */
const ACCESSOR: Readonly<Record<string, string>> = {
  position: "Position",
  velocity: "Velocity",
  tension: "Tension",
};

const ROPE_PARAMETERS: ParameterSchema = {
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
      "The most times one solver step solves a strand's segments together. A step stops sooner, as soon as every segment is within 1/8192 of its length, so this is a ceiling for hard moments and costs nothing on calm ones. With Bend Limit on it defaults to 8: a turn held to its limit while the rope moves takes more of them, and they are what the limit costs. Measured: at rest a step with the limit on is 1.5 to 1.9 times one without; with a held end swept at 4 m/s, 2.4 to 2.7 times on strands of 55 points and 3.4 on strands of 250.",
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
  segmentLength: {
    type: "number",
    label: "Segment Length",
    group: "Rope",
    default: ROPE_DEFAULTS.segmentLength,
    min: 0,
    max: 10,
    step: 0.001,
    range: "floor",
    description:
      "Metres between a point and the next, for every segment. 0 measures each segment of the incoming strip when the rope is seeded, which is right when the incoming strip is laid out at the rope's own spacing. Give the number when it is not: when the strip's last point is already where a claw should go, or the strip is a straight line shorter than the rope. A strip shorter than its rope between two held ends is pushed out to the low side of the line between them; lying exactly along gravity it has no low side, and stays straight and short.",
  },
  restLengthScale: {
    type: "number",
    label: "Rest Length Scale",
    group: "Rope",
    default: ROPE_DEFAULTS.restLengthScale,
    min: 0,
    max: 4,
    range: "floor",
    description:
      "Multiplies every segment's rest length, measured or given: below 1 the rope draws itself in, above 1 it pays out. Raised on a rope held at both ends, the slack goes to the low side of the line between them; a rope lying exactly along gravity has no low side, and stays straight and short.",
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
      "The most a segment may be longer or shorter than its rest length at the end of a step, as a fraction: 0.02 is two percent. A guard for a step too coarse for what the rope is being put through; it moves points and adds no speed. Raise it to let a Stretch give more. It is also the most a held point may ask a segment to reach (see Anchor Last).",
  },
  bendLimit: {
    type: "boolean",
    label: "Bend Limit",
    group: "Rope",
    default: false,
    compileTime: true,
    description:
      "The rope does not bend tighter than Min Bend Radius: a limit, not a spring. For rings or links instanced along it that must not pass through each other. It is solved together with the segments' lengths, so it holds on a rope at rest: to 1.0001 of the limit on a strand of 55 points and to 1.03 on one of 250 at Update Rate 240. In motion it is exceeded: see Min Bend Radius for by how much. It costs: see Iterations. WHERE IT CANNOT BE MET IT GIVES, and the rope comes to rest. Between two held ends with less slack than a turn of this radius takes, the joints that cannot hold let out, by as much as the pose needs and no more: a claw far out with its socket facing away puts two joints at 90° where 23° is asked. Length and the held points come first. The limit is the limit again when the slack is back. A pose handed in with a fold far past the limit may open into a loop with a full turn in it; hand in one the rope could lie in.",
  },
  minBendRadius: {
    type: "number",
    label: "Min Bend Radius",
    group: "Rope",
    default: ROPE_DEFAULTS.minBendRadius,
    min: 0.001,
    max: 100,
    step: 0.001,
    range: "floor",
    inactiveWhen: (values) => (values["bendLimit"] === true ? null : "Bend Limit is off."),
    description:
      "Metres: the radius of the tightest curve the rope makes while Bend Limit is on. A joint between two segments of mean length l may turn at most 2·asin(l ÷ 2R): 23° for 60 mm segments at 0.15 m. A radius and not an angle, so a rope resampled to twice the points is asked for the same curve. ALLOW A MARGIN FOR MOTION. In fast motion the limit is exceeded, by an amount that varies from run to run (a whipped rope is chaotic): with a held end swept at 4 m/s, by 1 to 15 % at Update Rate 240 and under 1 % at 960; at 8 m/s by 2 to 15 % at 960, and at 240, where a step cannot carry that sweep and the limit lets out, by 25 to 50 % and in a bad sweep by twice. A JOINT THAT STANDS MORE THAN 0.22° PAST ITS LIMIT FOR 1/32 S HAS IT LET OUT, whatever loads it. A strand too fine for its step is loaded so by its own weight: 1,024 points on 3.2 m hold a radius of 0.096 m at Update Rate 960 where 0.15 is asked. Raise Update Rate or use fewer points.",
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
      "How firmly the first point of each strand is held to its incoming point. 1 is the incoming point itself; 0 lets go; in between is a pull that tightens as it nears 1, so a weight that ramps moves the point without a jump. In Map mode an f32 attribute (or one channel of a float vector) is the weight, read at each strand's first point: a weight per strand. A weight within a millionth of 1 is 1, here and on every anchor, so one that is computed and lands a rounding short still holds. For letting go, see Anchor Mode.",
  },
  anchorSecond: {
    type: "number",
    label: "Anchor Second",
    group: "Anchors",
    default: ROPE_DEFAULTS.anchorSecond,
    min: 0,
    max: 1,
    range: "bounded",
    description:
      "The same for the second point of each strand. Held with the first, it fixes the direction the strand leaves in: put the incoming second point one segment along the way a socket faces. With both at 1 both are their incoming points exactly, and the first segment is as long as they are apart, whatever Segment Length says. In Map mode the attribute is read at each strand's second point; a weight within a millionth of 1 is 1.",
  },
  anchorLast: {
    type: "number",
    label: "Anchor Last",
    group: "Anchors",
    default: ROPE_DEFAULTS.anchorLast,
    min: 0,
    max: 1,
    range: "bounded",
    description:
      "The same for the last point of each strand: a rope held at both ends hangs between them. In Map mode the attribute is read at each strand's last point, so one strand can hold while its neighbour lets go; a weight within a millionth of 1 is 1. A target further from an earlier held point than the rope between them can REACH is not reached: the rope keeps its length and its end stands short of the target (40 mm short of one 3.10 m off on 3.06 m of rope). A rope with no Stretch reaches its own length. One with a Stretch reaches further, up to Max Stretch, and further at a higher Update Rate: it is what a solver step can pull the rope to, not what the rope could bear. (That is for a target with rope to solve between it and the held point before it. A held point that directly follows a held point is always its incoming point.)",
  },
  anchorMode: {
    type: "enum",
    label: "Anchor Mode",
    group: "Anchors",
    default: ROPE_DEFAULTS.anchorMode,
    // §V831: APPEND only.
    options: [
      { value: "hard", label: "Hard" },
      { value: "soft", label: "Soft" },
    ],
    description:
      "What a weight means. Hard: 1 is the incoming point itself, and a weight below 1 is a spring that stiffens without limit as it nears 1, so 0.3 to 0.5 follows a wandering target with a lag and a ramp to 1 lands on it. Soft: a weight of 1 is a spring of Anchor Strength, which lags a moving target and never pins. LETTING GO of a rope that held points were holding longer than itself: in the step a weight leaves 1 it takes its own length back, in its points' positions and not in their speed. Its far end moves by the whole over-length in that frame, which is seen (half a metre on a 3 m rope held 16 % long), and then it hangs and swings as a rope let go at its own length does. Cut or ramp, it is not thrown. A weight under 1 holds no segment long: it is a pull, and the rope keeps its length under it.",
  },
  anchorStrength: {
    type: "number",
    label: "Anchor Strength",
    group: "Anchors",
    default: ROPE_DEFAULTS.anchorStrength,
    min: 0.05,
    max: 30,
    range: "floor",
    unit: "hz",
    description:
      "How fast a soft or partly weighted anchor draws its strand in: the frequency, in hertz, the whole strand would swing at on that spring at a Hard weight of 0.5 or a Soft weight of 1. Under gravity the held point then rests g ÷ (2π × strength)² below its target: 62 mm at 2 Hz, 16 mm at 4. A point held at weight 1 under Hard does not read it.",
  },
  anchorDamping: {
    type: "number",
    label: "Anchor Damping",
    group: "Anchors",
    default: ROPE_DEFAULTS.anchorDamping,
    min: 0,
    max: 4,
    range: "floor",
    description: "The damping ratio of that pull. 1 arrives at the target without springing past it; less overshoots and rings; 0 is a bare spring.",
  },
  pinAttribute: {
    type: "string",
    label: "Pin Attribute",
    group: "Anchors",
    default: "",
    compileTime: true,
    description:
      "The name of an f32 attribute that is a weight on EVERY point, 0 to 1: a cable clipped along its length. A point takes the larger of this and its Anchor weight. Under Hard a weight of 1 (or within a millionth of it) is a hold, as an Anchor's is: the point is its incoming point of the same frame, exactly, wherever on the strand it is. A strand held at every point IS the incoming strip, whatever its lengths: a strip longer than the rope is followed long (to let go of one, see Anchor Mode). Below 1 a weight is a pull sized for the point's own mass, where an Anchor's is sized for the strand's. It costs a step about twice: every point then follows its incoming point, every frame. Empty reads none.",
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
};

/**
 * The schema of a Rope whose Bend Limit is on: Iterations defaults to 8. Holding a turn to
 * its limit while the strand moves takes more Newton steps than holding a length (measured
 * on Dawn: the consumer's loop swept at 4 m/s is 1.17 times its limit at four and 1.01 at
 * eight; at 8 m/s with four, a step cannot keep the rope's length and is solved without the
 * limit).
 * Hoisted, because `parametersFor` hands it out on every read.
 */
const ROPE_PARAMETERS_LIMITED: ParameterSchema = {
  ...ROPE_PARAMETERS,
  iterations: { ...(ROPE_PARAMETERS["iterations"] as ParameterSchema[string]), default: ROPE_MAX_ITERATIONS } as ParameterSchema[string],
};

export const pointRopeNode: NodeDefinition = {
  type: "pointRope",
  version: 1,
  title: "Rope",
  category: "points",
  description:
    "Simulates every strip of a pointset as a rope that keeps its length: it hangs, lags behind what moves it, and whips. Each strand starts on its incoming points and takes its segment lengths from them. Anchor First, Anchor Second and Anchor Last hold a strand's first, second and last point to the incoming point of the same slot, so whatever animates the incoming strip drags the rope; each is a weight from 0 to 1, and in Map mode an attribute gives it per strand. Hard, a weight of 1 is the incoming point itself and less is a pull toward it; Soft, it is always a spring. Two anchors further apart than the rope is long: the earlier one holds. Publishes position and velocity (and tension when asked). Update Rate with Min and Max Update Steps sets how many solver steps a frame runs; a strand whose first point jumps further than Teleport Distance in one frame is moved whole (Carry) or put back on its incoming points (Reset). Put Curve Frames after it to instance or sweep along the rope.",
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
  parameters: ROPE_PARAMETERS,
  /** Iterations defaults to 8 while Bend Limit is on. */
  parametersFor(stored) {
    return stored["bendLimit"] === true ? ROPE_PARAMETERS_LIMITED : ROPE_PARAMETERS;
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
    // §V288: a map this node cannot honour refuses BY NAME rather than reading the static.
    const unhonoured = Object.keys(parameterMaps).filter((key) => !(STATIONS as ReadonlyArray<string>).includes(key)).sort();
    if (unhonoured.length > 0) {
      return refuse(
        `${unhonoured.join(", ")} ${unhonoured.length === 1 ? "is" : "are"} in map mode, and a Rope maps only Anchor First, Anchor Second and Anchor Last.`,
        "Switch it back to Constant, or drive it through the value graph instead.",
        "node.parameter.map",
      );
    }
    const stationMaps: Partial<Record<(typeof STATIONS)[number], ScalarMap>> = {};
    for (const key of STATIONS) {
      const resolved = resolveScalarMap(nodeId, parameterMaps[key], upstream, "in", key);
      if ("refusal" in resolved) return resolved.refusal;
      if (resolved.map !== undefined) stationMaps[key] = resolved.map;
    }
    const pinName = typeof parameters["pinAttribute"] === "string" ? parameters["pinAttribute"].trim() : "";
    let pinPair: PointsetAttributeRef | undefined;
    if (pinName !== "") {
      const carried = upstream.pairs[pinName];
      if (carried === undefined || carried.type !== "f32") {
        return refuse(
          carried === undefined
            ? `Pin Attribute names "${pinName}", which the incoming pointset does not carry.`
            : `Pin Attribute names "${pinName}", which is ${carried.type ?? "untyped"}; a pin weight is an f32.`,
          `It provides: ${Object.keys(upstream.pairs).sort().join(", ")}.`,
          "node.parameter.map",
        );
      }
      pinPair = carried;
    }

    const tension = parameters["tensionOutput"] === true;
    const bend = parameters["bendLimit"] === true;
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

    /* One binding per upstream BUFFER, whole, read by offset (T1076): the incoming points
       first, then whatever a mapped weight or the pin attribute reads. A weight the same
       kernel wrote beside its positions is the same buffer and costs no binding. */
    const groups: Array<{ readonly resourceId: string; readonly half: "read" | "write" }> = [];
    const groupOf = (ref: PointsetAttributeRef): number => {
      const found = groups.findIndex((group) => group.resourceId === ref.buffer && group.half === ref.half);
      if (found >= 0) return found;
      groups.push({ resourceId: ref.buffer, half: ref.half });
      return groups.length - 1;
    };
    const scalarRegion = (ref: PointsetAttributeRef, type: string, channel: string | undefined): RopeScalarRegion => ({
      group: groupOf(ref),
      word: ref.offset / 4,
      strideWords: ATTRIBUTE_STRIDES[type as PointAttributeType] / 4,
      component: channel === undefined ? 0 : ["x", "y", "z", "w"].indexOf(channel),
    });
    const positionRegion = { group: groupOf(position), word: position.offset / 4 };
    const stationRegions: Partial<Record<(typeof STATIONS)[number], RopeScalarRegion>> = {};
    for (const key of STATIONS) {
      const map = stationMaps[key];
      if (map !== undefined) stationRegions[key] = scalarRegion(map, map.type, map.channel);
    }
    const pinRegion = pinPair === undefined ? undefined : scalarRegion(pinPair, "f32", undefined);
    /* §V588: a stage binds eight storage buffers, and four of them are this step's own. */
    if (groups.length + OWN_BINDINGS > MAX_KERNEL_STORAGE_BINDINGS) {
      return refuse(
        `the incoming points and the attributes its weights read come from ${groups.length} producers, and a pass binds ${MAX_KERNEL_STORAGE_BINDINGS} buffers with this node's own ${OWN_BINDINGS} (§V588).`,
        "Gather the weights onto the strands in one kernel before the Rope, so they come from one producer.",
      );
    }

    /* The uniform block, as ONE list the shader's struct and the pass's record both read.
       The first four are the backend's, written for every run of the stepped dispatch
       (`dispatchStepUniforms`): reserved here because vgpu matches uniforms by name. */
    const members: Array<{ name: string; type: "f32" | "u32"; value: number }> = [
      { name: "deltaSeconds", type: "f32", value: 0 },
      { name: "substep", type: "u32", value: 0 },
      { name: "substeps", type: "u32", value: 1 },
      { name: "firstRun", type: "u32", value: 0 },
      { name: "cols", type: "u32", value: strips.cols },
      { name: "rows", type: "u32", value: strips.rows },
      /* The Iterations parameter, under ANOTHER name on purpose. The backend writes a
         stepped dispatch's own `iterations` (runs per substep, 1 here) into any member of
         that name, so a block that called its Newton cap `iterations` read 1 whatever the
         parameter said — found by the sway test, which stood at two tolerances. */
      { name: "solves", type: "u32", value: Math.min(ROPE_MAX_ITERATIONS, Math.max(1, Math.round(readNumber(parameters, "iterations", bend ? ROPE_MAX_ITERATIONS : ROPE_DEFAULTS.iterations)))) },
      { name: "reset", type: "u32", value: readFlag(parameters, "reset", false) },
      { name: "teleportMode", type: "u32", value: parameters["teleportMode"] === "reset" ? 1 : 0 },
      // A flag, not structure (§V453): Hard and Soft are one program.
      { name: "anchorMode", type: "u32", value: parameters["anchorMode"] === "soft" ? 1 : 0 },
      { name: "speed", type: "f32", value: Math.max(0, readNumber(parameters, "speed", ROPE_DEFAULTS.speed)) },
      { name: "gravity", type: "f32", value: readNumber(parameters, "gravity", ROPE_DEFAULTS.gravity) },
      { name: "damping", type: "f32", value: Math.max(0, readNumber(parameters, "damping", ROPE_DEFAULTS.damping)) },
      { name: "inverseMass", type: "f32", value: 1 / Math.max(0.001, readNumber(parameters, "mass", ROPE_DEFAULTS.mass)) },
      { name: "segmentLength", type: "f32", value: Math.max(0, readNumber(parameters, "segmentLength", ROPE_DEFAULTS.segmentLength)) },
      { name: "restLengthScale", type: "f32", value: Math.max(0, readNumber(parameters, "restLengthScale", ROPE_DEFAULTS.restLengthScale)) },
      { name: "stretch", type: "f32", value: Math.max(0, readNumber(parameters, "stretch", ROPE_DEFAULTS.stretch)) },
      { name: "maxStretch", type: "f32", value: Math.max(0, readNumber(parameters, "maxStretch", ROPE_DEFAULTS.maxStretch)) },
      { name: "anchorFirst", type: "f32", value: readNumber(parameters, "anchorFirst", ROPE_DEFAULTS.anchorFirst) },
      { name: "anchorSecond", type: "f32", value: readNumber(parameters, "anchorSecond", ROPE_DEFAULTS.anchorSecond) },
      { name: "anchorLast", type: "f32", value: readNumber(parameters, "anchorLast", ROPE_DEFAULTS.anchorLast) },
      { name: "anchorStrength", type: "f32", value: Math.max(0, readNumber(parameters, "anchorStrength", ROPE_DEFAULTS.anchorStrength)) },
      { name: "anchorDamping", type: "f32", value: Math.max(0, readNumber(parameters, "anchorDamping", ROPE_DEFAULTS.anchorDamping)) },
      { name: "teleportDistance", type: "f32", value: Math.max(0, readNumber(parameters, "teleportDistance", ROPE_DEFAULTS.teleportDistance)) },
    ];
    // Only a Rope with Bend Limit on has the member: without it the block is the one it always was.
    if (bend) members.push({ name: "minBendRadius", type: "f32", value: Math.max(0.001, readNumber(parameters, "minBendRadius", ROPE_DEFAULTS.minBendRadius)) });

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      /* What a person would want to read of what the program's text depends on: the Tension
         switch decides which regions exist, a mapped station (f, s, l) and a pin attribute
         (p) each read a buffer, Bend Limit (b) is another solve, and the capacity moves every
         region's offset. */
      id: [
        `${nodeId}:rope:step`,
        `${tension ? "t" : ""}${stationRegions.anchorFirst === undefined ? "" : "f"}${stationRegions.anchorSecond === undefined ? "" : "s"}${stationRegions.anchorLast === undefined ? "" : "l"}${pinRegion === undefined ? "" : "p"}${bend ? "b" : ""}`,
        String(capacity),
      ].join(":"),
      shader: ropeStepWgsl({
        loadFunctions,
        storeFunctions,
        tension,
        members: members.map(({ name, type }) => ({ name, type })),
        groups: groups.length,
        position: positionRegion,
        ...stationRegions,
        ...(pinRegion === undefined ? {} : { pin: pinRegion }),
        ...(bend ? { bend: true } : {}),
      }),
      entryPoint: "main",
      // One invocation per STRAND: each walks its own strand.
      workgroups: [Math.ceil(strips.rows / 64), 1, 1],
      buffers: [
        // Each producer's buffer at the half its edge names: this frame's values, in plan order (§V168).
        ...groups.map((group, index) => ({ binding: `pk_${index}`, resourceId: group.resourceId, half: group.half })),
        // The WHOLE packed buffer, both halves: the walk addresses regions by offset (T1076).
        { binding: "state_in", resourceId: storage.resourceId, half: "read" as const },
        { binding: "state_out", resourceId: storage.resourceId, half: "write" as const },
        { binding: "kept", resourceId: keptId },
        { binding: "scratch", resourceId: solveId },
      ],
      uniforms: Object.fromEntries(members.map((member) => [member.name, member.value])),
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [
        { key: ROPE_KEPT_KEY, kind: "buffer" as const, stride: 16, capacity: capacity * 2 },
        { key: ROPE_SOLVE_KEY, kind: "buffer" as const, stride: 4, capacity: capacity * ropeScratchFloats(bend) },
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
