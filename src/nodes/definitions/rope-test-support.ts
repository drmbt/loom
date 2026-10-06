import { compileGraph } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/index.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { frameFromClock } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import { kernelParamUniformKey } from "../../points/codegen.ts";
import type { RopeParameters, RopeState } from "../../points/rope.ts";
import { ROPE_DEFAULTS, advanceRope, createRopeState } from "../../points/rope.ts";
import { rateSubsteps } from "../../runtime/backend/plan.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import type { VgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { CURVE_TEST_REGISTRY, curveEdge, curveGraph, curveNode } from "./curve-test-support.ts";
import { ROPE_KEPT_KEY, ropeAttributes } from "./point-rope.ts";
import { pointStorageId } from "./point-storage.ts";
import { pointRegionSlice } from "./test-support.ts";

/**
 * T1585b — what the Rope's Dawn tests share: a strand whose incoming points are AUTHORED
 * EXACTLY and can be moved from the test, run through the real compiler and a real device
 * frame by frame, and read back region by region — with the CPU reference
 * (`src/points/rope.ts`) stepped beside it on the same numbers.
 *
 * A rope is driven by what is upstream of it, so the fixture's one moving part is the
 * anchor kernel's `shift`: a vec3f the test pushes exactly as the app's animator would
 * (`backend.updateUniforms`), added to every incoming point. The pose itself is a formula
 * of the station `i` and the strand `j`, given twice — as WGSL for the device and as a
 * function for the reference — in numbers small enough to be exact in both.
 *
 * Node names are `kind_role` (§T1593b), and an id is its name.
 */

export const ROPE = "rope_strand";
export const ANCHOR = "kernel_anchor";

/** The fixture's clock: 64 frames a second, so a frame's step and every whole division of it are exact in f32. */
export const ROPE_FPS = 64;
export const ROPE_FRAME = 1 / ROPE_FPS;

const SIZE = 16;
const SETTINGS = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;
const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
} as never;

type Vec3 = readonly [number, number, number];

/** Where station `i` of strand `j` is before the shift: the same formula for the device and for the reference. */
export interface RopePose {
  /** A WGSL expression of `i` and `j` (both u32), of type vec3f. */
  readonly wgsl: string;
  readonly at: (i: number, j: number) => Vec3;
}

/** A strand hanging straight down from the origin, `rest` between its points; strands a unit apart along X. */
export const hanging = (rest: number): RopePose => ({
  wgsl: `vec3f(f32(j), -f32(i) * ${String(rest)}, 0.0)`,
  at: (i, j) => [j, -i * rest, 0],
});

/** A strand laid level along +X from the origin; strands a unit apart along Z. */
export const level = (rest: number): RopePose => ({
  wgsl: `vec3f(f32(i) * ${String(rest)}, 0.0, f32(j))`,
  at: (i, j) => [i * rest, 0, j],
});

/** How many directions `sweptArc` lays its strands along: a whole turn, and exactly an axis every `SWEEP_DIRECTIONS / 4`. */
export const SWEEP_DIRECTIONS = 128;
/** The furthest a point of a `sweptArc` strand moves from one direction to the next, in metres. */
export const SWEEP_STEP = Math.hypot(0.5, 0.25) * (Math.SQRT2 / (SWEEP_DIRECTIONS / 4));

/**
 * A SLACK ARC LAID IN EVERY DIRECTION, one strand a direction: seventeen points whose two
 * ends are a chord of half a metre apart (at an axis; a little less between) with a quarter
 * of a metre of bow. Strand `j`'s chord points along step `j` of a walk round a diamond —
 * (1, 0) → (0, 1) → (−1, 0) → (0, −1) and back, in 32 steps a side — so the chord passes
 * through every direction of the sweep's plane and is EXACTLY on an axis at four of them,
 * in numbers that are floats on the device and here alike. No trigonometry, so no last
 * place for a device to differ in.
 *
 * `bow` says where the slack goes: `"turning"` with the chord in the XY plane (through
 * gravity's axis), `"across"` along X while the chord sweeps YZ, or `"down"` along gravity
 * while the chord sweeps XZ.
 */
export function sweptArc(bow: "turning" | "across" | "down"): RopePose {
  const side = SWEEP_DIRECTIONS / 4;
  const k = `(f32(j % ${side}u) / ${side}.0)`;
  const q = `((j / ${side}u) % 4u)`;
  // WGSL's select(whenFalse, whenTrue, condition).
  const along = `select(select(select(vec2f(${k}, ${k} - 1.0), vec2f(${k} - 1.0, -${k}), ${q} == 2u), vec2f(-${k}, 1.0 - ${k}), ${q} == 1u), vec2f(1.0 - ${k}, ${k}), ${q} == 0u)`;
  const a = "(f32(i) / 32.0)";
  const b = "(f32(i) * (16.0 - f32(i)) / 256.0)";
  const alongAt = (j: number): readonly [number, number] => {
    const step = (j % side) / side;
    const quarter = Math.floor(j / side) % 4;
    return ([[1 - step, step], [-step, 1 - step], [step - 1, -step], [step, step - 1]] as const)[quarter] as readonly [number, number];
  };
  const reach = (i: number): readonly [number, number] => [i / 32, (i * (16 - i)) / 256];
  switch (bow) {
    case "turning":
      return {
        wgsl: `(vec3f(${along}, 0.0) * ${a} + vec3f(-(${along}).y, (${along}).x, 0.0) * ${b})`,
        at: (i, j) => {
          const [x, y] = alongAt(j);
          const [far, out] = reach(i);
          return [x * far - y * out, y * far + x * out, 0];
        },
      };
    case "across":
      return {
        wgsl: `(vec3f(0.0, ${along}) * ${a} + vec3f(1.0, 0.0, 0.0) * ${b})`,
        at: (i, j) => {
          const [y, z] = alongAt(j);
          const [far, out] = reach(i);
          return [out, y * far, z * far];
        },
      };
    case "down":
      return {
        wgsl: `(vec3f((${along}).x, 0.0, (${along}).y) * ${a} + vec3f(0.0, -1.0, 0.0) * ${b})`,
        at: (i, j) => {
          const [x, z] = alongAt(j);
          const [far, out] = reach(i);
          return [x * far, -out, z * far];
        },
      };
  }
}

export interface RopeFixture {
  readonly cols: number;
  readonly rows?: number;
  readonly pose: RopePose;
  /** The Rope node's stored parameters. */
  readonly rope?: Readonly<Record<string, unknown>>;
}

export function ropeGraph(fixture: RopeFixture): GraphDocument {
  const rows = fixture.rows ?? 1;
  const count = fixture.cols * rows;
  const kernel = `struct Params {
  shift: vec3f, // @default 0  Added to every point: the test moves the strand's incoming pose with it.
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let i = ctx.index % ${fixture.cols}u;
  let j = ctx.index / ${fixture.cols}u;
  q.position = ${fixture.pose.wgsl} + ctx.params.shift;
  return q;
}`;
  return curveGraph(
    [
      curveNode(ANCHOR, "pointKernel", {
        capacity: count,
        seed: 7,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel,
      }),
      curveNode("topology_strand", "pointTopology", { connectivity: "strips", cols: fixture.cols, rows }),
      curveNode(ROPE, "pointRope", { ...(fixture.rope ?? {}) }),
      curveNode("points_probe", "renderPoints", { count, sizePixels: 1 }),
      curveNode("output_probe", "output"),
    ],
    [
      curveEdge([ANCHOR, "out"], ["topology_strand", "points"]),
      curveEdge(["topology_strand", "out"], [ROPE, "in"]),
      curveEdge([ROPE, "out"], ["points_probe", "points"]),
      curveEdge(["points_probe", "out"], ["output_probe", "input"]),
    ],
  );
}

export const compileRope = (fixture: RopeFixture): CompiledGraph =>
  compileGraph({ graph: ropeGraph(fixture), settings: SETTINGS, registry: CURVE_TEST_REGISTRY, capabilities: CAPABILITIES });

/** What one rendered frame is, as a test asks for it. */
export interface RopeFrame {
  /** The frame's step; one project frame unless said. */
  readonly delta?: number;
  readonly mode?: "realtime" | "fixed-step" | "offline";
}

export interface RopeRead {
  /** Four floats a point. */
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  /** One float a point; empty when the node does not publish it. */
  readonly tension: Float32Array;
  /** Every byte a run steps and publishes, and every byte the solver keeps: the whole state. */
  readonly bytes: Uint8Array;
}

export interface RopeSession {
  readonly plan: CompiledGraph;
  readonly backend: VgpuBackend;
  readonly reported: RuntimeDiagnostic[];
  /** Render the next frame. The first is frame 0, which seeds. */
  render(frame?: RopeFrame): void;
  /** Move every incoming point by this, from the next frame on. */
  shift(by: Vec3): void;
  /** Push uniform values onto the Rope's step, as the animator does for a driven parameter. */
  push(values: Readonly<Record<string, number>>): void;
  /** Push values onto the Rope's region: `rate`, `minSteps`, `maxSteps`. */
  pushSteps(values: Readonly<Record<string, number>>): void;
  /** Forget all temporal state, as a seek does (§V170). The next render is frame 0 again. */
  seek(): void;
  read(): Promise<RopeRead>;
}

/**
 * Compile a rope fixture, open a device and hand the test a session. Nothing is rendered
 * until the test says so. Required, never skipped: a skipped device test is a green tick on
 * every machine without a GPU.
 */
export async function onRope<T>(fixture: RopeFixture, body: (session: RopeSession) => Promise<T>): Promise<T> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const plan = compileRope(fixture);
  const refused = plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message);
  if (refused.length > 0) throw new Error(`the graph did not compile: ${refused.join(" | ")}`);
  const step = plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === ROPE);
  const begin = plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin" && pass.nodeId === ROPE);
  const anchor = plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === ANCHOR);
  if (step === undefined || begin === undefined || anchor === undefined) throw new Error("the plan is missing the rope's step, its region or the anchor kernel");
  const tension = fixture.rope?.["tensionOutput"] === true;
  const attributes = ropeAttributes({ tension });
  const capacity = fixture.cols * (fixture.rows ?? 1);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const reported: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((entry) => {
    reported.push(entry);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    let frameIndex = 0;
    let time = 0;
    return await body({
      plan,
      backend,
      reported,
      render: (frame = {}) => {
        const delta = frame.delta ?? ROPE_FRAME;
        backend.render(compiled, {
          // §V437: a frame is made by its constructor, so every clock it carries agrees.
          frame: frameFromClock({ timeSeconds: time, deltaSeconds: frameIndex === 0 ? 0 : delta, frameIndex, mode: frame.mode ?? "offline", randomSeed: 7, fps: ROPE_FPS }),
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [SIZE, SIZE],
        });
        const errors = reported.filter((entry) => entry.severity === "error").map((entry) => `${entry.code}: ${entry.message}`);
        if (errors.length > 0) throw new Error(`the device refused the frame: ${errors.join(" | ")}`);
        frameIndex += 1;
        time += delta;
      },
      shift: (by) => {
        backend.updateUniforms({ passId: anchor.id, values: { [kernelParamUniformKey("shift")]: [by[0], by[1], by[2]] } });
      },
      push: (values) => {
        backend.updateUniforms({ passId: step.id, values });
      },
      pushSteps: (values) => {
        backend.updateUniforms({ passId: begin.id, values });
      },
      seek: () => {
        backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
        frameIndex = 0;
        time = 0;
      },
      read: async () => {
        const packed = await backend.readBuffer(pointStorageId(ROPE));
        const kept = await backend.readBuffer(scratchResourceId(ROPE, ROPE_KEPT_KEY));
        const region = (name: string): Float32Array => new Float32Array(pointRegionSlice(packed, attributes, capacity, name).floats);
        const bytes = new Uint8Array(packed.byteLength + kept.byteLength);
        bytes.set(new Uint8Array(packed), 0);
        bytes.set(new Uint8Array(kept), packed.byteLength);
        return { position: region("position"), velocity: region("velocity"), tension: tension ? region("tension") : new Float32Array(0), bytes };
      },
    });
  } finally {
    backend.dispose();
  }
}

/**
 * The CPU reference stepped the way a session is: the same pose, the same shifts, the same
 * frames, and the step count the backend derives for each frame (`rateSubsteps`).
 */
export interface RopeTwin {
  readonly state: RopeState;
  parameters: RopeParameters;
  render(frame?: RopeFrame): void;
  shift(by: Vec3): void;
}

export function ropeTwin(fixture: RopeFixture): RopeTwin {
  const rows = fixture.rows ?? 1;
  const stored = fixture.rope ?? {};
  const number = (key: string, fallback: number): number => (typeof stored[key] === "number" ? (stored[key] as number) : fallback);
  const parameters: RopeParameters = {
    iterations: number("iterations", ROPE_DEFAULTS.iterations),
    speed: number("speed", ROPE_DEFAULTS.speed),
    gravity: number("gravity", ROPE_DEFAULTS.gravity),
    damping: number("damping", ROPE_DEFAULTS.damping),
    mass: number("mass", ROPE_DEFAULTS.mass),
    restLengthScale: number("restLengthScale", ROPE_DEFAULTS.restLengthScale),
    stretch: number("stretch", ROPE_DEFAULTS.stretch),
    maxStretch: number("maxStretch", ROPE_DEFAULTS.maxStretch),
    anchorFirst: number("anchorFirst", ROPE_DEFAULTS.anchorFirst),
    reset: stored["reset"] === true,
    teleportDistance: number("teleportDistance", ROPE_DEFAULTS.teleportDistance),
    teleportMode: stored["teleportMode"] === "reset" ? "reset" : "carry",
  };
  const rate = { perSecond: number("updateRate", 240), min: number("minSteps", 1), max: number("maxSteps", 16) };
  const state = createRopeState(fixture.cols, rows);
  let shift: Vec3 = [0, 0, 0];
  let frameIndex = 0;
  const incoming = (): Float32Array => {
    const out = new Float32Array(fixture.cols * rows * 4);
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < fixture.cols; i += 1) {
        const at = fixture.pose.at(i, j);
        const slot = (j * fixture.cols + i) * 4;
        // The device adds two f32 vectors: round the pose, then the sum.
        out[slot] = Math.fround(Math.fround(at[0]) + Math.fround(shift[0]));
        out[slot + 1] = Math.fround(Math.fround(at[1]) + Math.fround(shift[1]));
        out[slot + 2] = Math.fround(Math.fround(at[2]) + Math.fround(shift[2]));
      }
    }
    return out;
  };
  const twin: RopeTwin = {
    state,
    parameters,
    render: (frame = {}) => {
      const delta = frameIndex === 0 ? 0 : (frame.delta ?? ROPE_FRAME);
      advanceRope(state, incoming(), twin.parameters, { deltaSeconds: delta, substeps: rateSubsteps(delta, rate), firstRun: frameIndex === 0 });
      frameIndex += 1;
    },
    shift: (by) => {
      shift = by;
    },
  };
  return twin;
}

/** Component `axis` of point `index` in a four-floats-a-point region. */
export const component = (region: Float32Array, index: number, axis: 0 | 1 | 2): number => region[index * 4 + axis] as number;

/** The length of the segment after point `index`. */
export function segmentLength(position: Float32Array, index: number): number {
  const dx = component(position, index + 1, 0) - component(position, index, 0);
  const dy = component(position, index + 1, 1) - component(position, index, 1);
  const dz = component(position, index + 1, 2) - component(position, index, 2);
  return Math.hypot(dx, dy, dz);
}
