import { absFrameIndexOf, absTimeSecondsOf, wallDeltaSecondsOf, wallSecondsOf } from "../../domain/types/frame.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { FrameInputs } from "../../domain/types/backend.ts";
import type { UniformValues } from "./plan.ts";
import { wgsl } from "./wgsl.ts";

/**
 * The per-frame uniform block every pass may bind (§T16).
 *
 * Every value here originates in `FrameEvaluationInput`, which the transport supplies.
 * Nothing in the runtime reads `Date.now`, `performance.now` or rAF to fill it (§V44, §V49).
 */
export interface SharedUniformValues extends Record<string, unknown> {
  /** TIMELINE seconds — `frameIndex / fps` (T271). Uniform by construction. */
  time: number;
  /** The step belonging to `time`, and never the other clock's (§V172). */
  deltaTime: number;
  frameIndex: number;
  randomSeed: number;
  /** WALL seconds, for anything that must match the outside world (T271). */
  wallTime: number;
  /** The step belonging to `wallTime`. */
  wallDelta: number;
  /**
   * T468: the ABSOLUTE clock — `absFrameIndex / fps`, the one that keeps growing across
   * timeline laps (T461). The same number expressions read as `abstime`, so a shader and
   * an expression driven by it cannot disagree about how long the show has run. Never a
   * wall reading: a frame count at the timeline's rate, deterministic under replay.
   */
  absTime: number;
  /**
   * The frame count behind `absTime`, as f32 (the block is f32 throughout, matching the
   * `frameIndex` above it).
   *
   * B119 — THE ASYMMETRY, stated on both sides rather than resolved. A POINT KERNEL's
   * `ctx.absFrame` is `u32`, because a kernel's `PointCtx` carries `frameIndex` as u32 and
   * a member that disagreed with its own neighbour would be the odd one out there. So the
   * same name is f32 here and u32 there, each locally right and mutually inconsistent, and
   * identical-looking arithmetic compiles in one and fails in the other with Dawn's "no
   * matching overload" — which names nothing. It is NOT unified because unifying means
   * changing a struct member's TYPE: every saved project doing integer work on
   * `ctx.absFrame` would stop compiling, and the kernel's u32 would then be the member that
   * disagrees with its neighbour instead. The counterpart note is at the kernel's own
   * declaration in `src/points/codegen.ts`, in the comment the generated WGSL carries.
   * `absTime` is f32 on both sides and always has been.
   */
  absFrame: number;
  resolution: readonly [number, number];
  /** x, y, buttons, unused. Packed as vec4f so the block stays 16-byte aligned. */
  pointer: readonly [number, number, number, number];
}

/** WGSL declaration matching {@link SharedUniformValues}. Node shaders include this verbatim. */
// Eight f32 (32 bytes) then a vec2f at offset 32 (align 8) and a vec4f at 48 (align 16).
// The abs pair slots in after the wall pair: every shader includes this text verbatim, so
// all of them regenerate together and no shader can hold the old layout (V380: NAMED
// members, never an array — uniform arrays defeat the writer's reflection).
export const SHARED_UNIFORMS_WGSL = wgsl`struct SharedFrame {
  time: f32,
  deltaTime: f32,
  frameIndex: f32,
  randomSeed: f32,
  wallTime: f32,
  wallDelta: f32,
  absTime: f32,
  absFrame: f32,
  resolution: vec2f,
  pointer: vec4f,
};`;

export function initialSharedUniforms(): SharedUniformValues {
  return {
    time: 0,
    deltaTime: 0,
    frameIndex: 0,
    randomSeed: 0,
    wallTime: 0,
    wallDelta: 0,
    absTime: 0,
    absFrame: 0,
    resolution: [1, 1],
    pointer: [0, 0, 0, 0],
  };
}

export function sharedUniformsFromFrame(inputs: FrameInputs): SharedUniformValues {
  const { frame, pointer, resolution } = inputs;
  return {
    time: frame.timeSeconds,
    deltaTime: frame.deltaSeconds,
    frameIndex: frame.frameIndex,
    randomSeed: frame.randomSeed,
    wallTime: wallSecondsOf(frame),
    wallDelta: wallDeltaSecondsOf(frame),
    absTime: absTimeSecondsOf(frame),
    absFrame: absFrameIndexOf(frame),
    resolution: [resolution[0], resolution[1]],
    pointer: [pointer.x, pointer.y, pointer.buttons, 0],
  };
}

/**
 * The per-frame values every DISPATCH pass's own uniform block receives (T172, T489).
 *
 * A compute pass does not bind the shared block above — it binds its own `KernelFrame`,
 * generated per kernel — so the frame fields have to be written into it by name, and this
 * is the one place that decides which fields those are. It lives here, beside the block it
 * mirrors, rather than inline in the backend, because §V437's whole lesson is that a clock
 * reaching one surface and not the next is what happens when two places each answer "which
 * numbers is a frame" separately. One answer, gated in `loop-continuity.test.ts`.
 *
 * The pointer and the ABSOLUTE pair are read off the shared values rather than re-derived
 * from the frame, so a point kernel and a fragment shader cannot come to disagree about
 * where the cursor is or how long the show has run (§V182).
 *
 * The backend selects only fields present in the dispatch pass's initial uniform values.
 * Optional frame members are declared there by the kernel emitter. vgpu validates unknown
 * fields, so this candidate bag must never be broadcast to a smaller KernelFrame layout.
 */
export function dispatchFrameUniforms(
  frame: FrameEvaluationInput,
  shared: SharedUniformValues,
): UniformValues {
  return {
    // T271/§V172: the TIMELINE pair, which wraps at a lap...
    timeSeconds: frame.timeSeconds,
    deltaSeconds: frame.deltaSeconds,
    frameIndex: frame.frameIndex,
    pointer: shared.pointer,
    // ...and T461/T489's absolute pair, which does not. `ctx.absTime`/`ctx.absFrame`.
    absTimeSeconds: shared.absTime,
    absFrameIndex: shared.absFrame,
  };
}

/** One run of a stepped dispatch (T1583b): which it is, and how the frame is divided. */
export interface DispatchStep {
  /** 0-based, in `[0, substeps × iterations)`. */
  readonly run: number;
  readonly substeps: number;
  readonly iterations: number;
}

/**
 * What ONE RUN of a stepped dispatch reads differently from the frame's values (T1583b).
 *
 * A kernel the plan steps several times per frame runs the same pass object N times, and
 * these are the only numbers that tell one run from another. Beside
 * `dispatchFrameUniforms` for its reason: one answer to "what is a run", and the backend
 * selects from this candidate bag only the members the pass declared, exactly as it does
 * from that one.
 *
 *  - `deltaSeconds` is the frame's step over the SUBSTEP count, for every run. Iterations
 *    do not divide it: they repeat inside a substep at the same step.
 *  - `substep` / `iteration` count within the frame and within the substep.
 *  - `firstRun` is the frame's on run 0 and 0 after it: storage that run 0 wrote is not
 *    fresh, and a kernel that seeds on it would re-seed N times per frame.
 *  - `seed` is folded with the run (`stepSeed`), absent when the pass carries none.
 */
export function dispatchStepUniforms(
  step: DispatchStep,
  frame: { readonly deltaSeconds: number; readonly firstRun: boolean; readonly seed?: number },
): UniformValues {
  return {
    deltaSeconds: frame.deltaSeconds / step.substeps,
    substep: Math.floor(step.run / step.iterations),
    substeps: step.substeps,
    iteration: step.run % step.iterations,
    iterations: step.iterations,
    firstRun: frame.firstRun && step.run === 0 ? 1 : 0,
    ...(frame.seed === undefined ? {} : { seed: stepSeed(frame.seed, step.run) }),
  };
}

/**
 * The seed run `run` of a stepped kernel hashes with (T1583b, §V73).
 *
 * A kernel's random draw is `hash(seed ^ pointId, frameIndex, salt)`, and every run of one
 * frame shares all three — so without this each run would repeat the first one's draws.
 * The run cannot go into the generated text: a kernel that names no step member generates
 * the WGSL it always did (§V309). It goes into the VALUE the text already reads.
 *
 * It is XORed into the seed with its bits REVERSED, so run 1 sets bit 31, run 2 bit 30, and
 * the 256 runs a frame may hold occupy the top eight bits. The seed meets the point id by
 * XOR, so (point, run) pairs are distinct hash inputs for every point id below 2^24 — far
 * above the largest point set (one million) — and two runs can never trade streams with
 * each other or with another point. Run 0 leaves the seed untouched, which is what keeps a
 * kernel run once per frame on exactly the stream it has always had.
 *
 * `pointHashReference` (`src/points/rng.ts`) mirrors it on the CPU.
 */
export function stepSeed(seed: number, run: number): number {
  let reversed = 0;
  for (let bit = 0; bit < 32; bit += 1) reversed |= ((run >>> bit) & 1) << (31 - bit);
  return (seed ^ reversed) >>> 0;
}
