import { isUniformOnlyChange } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { planSkippedDraws } from "@runtime/backend/plan.ts";
import type { UniformValue, UniformValues } from "@runtime/backend/plan.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";

/**
 * Pushing animated parameter VALUES, every frame, without recompiling (T259, §V163, §V5).
 *
 * ## The gap this closes
 *
 * An LFO in the document drives a parameter by name, deterministically, from the frame
 * input — and the resolver was the only thing that knew. Nothing re-resolved per frame, so
 * the number moved and the picture did not. A correct resolver is not the feature; the
 * feature is the push.
 *
 * ## Why it cannot be a recompile
 *
 * §V5: dragging a slider must not rebuild a pipeline, and an animated parameter is a
 * slider being dragged sixty times a second. So the per-frame plan is compiled with the
 * SAME graph, topology and resources — only `resolution` (the frame, and the channel
 * resolver) differs — and the only thing that can therefore differ in the result is pass
 * uniform VALUES. `isUniformOnlyChange` is asserted rather than assumed: if a frame ever
 * produces a structurally different plan, this refuses to touch the GPU and says so,
 * because silently recompiling at frame rate is exactly what §V5 forbids.
 *
 * ## Why it is stateful
 *
 * Only CHANGED blocks are written. A graph where one of forty passes animates must cost
 * one `writeBuffer` per frame, not forty — and a parameter that is animated but momentarily
 * still costs nothing at all.
 */

export interface UniformAnimator {
  /**
   * Writes the uniform blocks that changed since the last push.
   *
   * Returns the number of blocks written, or `null` when `next` is not a values-only
   * variation of `base` — which is a bug in the caller's gating, never something to
   * recover from by recompiling.
   */
  push(backend: LoomBackend, base: CompiledGraph, next: CompiledGraph): number | null;
  /** Forget what was pushed. Call when the structural plan is replaced. */
  reset(): void;
}

function sameValue(a: UniformValue | undefined, b: UniformValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }
  return false;
}

function sameBlock(a: UniformValues | undefined, b: UniformValues | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every((key) => sameValue(a[key], b[key]));
}

/** Every pass that carries a uniform block, by id. Swap passes carry none. */
function blocksOf(plan: CompiledGraph): Map<string, UniformValues> {
  const blocks = new Map<string, UniformValues>();
  for (const pass of plan.passes) {
    // T425: a loop-begin's count is its one animatable value — surfaced as a block so
    // a driven substeps parameter diffs and pushes exactly like a uniform (§V5).
    // T1583b: a kernel region has a second one, how many of those runs are one substep.
    // T1585b: and a rate-driven one three more — the rate and its two clamps, which the
    // backend turns into each frame's own count.
    if (pass.kind === "loop") {
      if (pass.edge === "begin") {
        const rate = pass.steps?.rate;
        blocks.set(pass.id, {
          count: pass.count ?? 1,
          ...(pass.steps === undefined ? {} : { iterations: pass.steps.iterations }),
          ...(rate === undefined ? {} : { rate: rate.perSecond, minSteps: rate.min, maxSteps: rate.max }),
        });
      }
      continue;
    }
    // T1623b: a table of rows written into a region of a buffer diffs and pushes as a block.
    if (pass.kind === "write") {
      blocks.set(pass.id, pass.values);
      continue;
    }
    const uniforms = "uniforms" in pass ? pass.uniforms : undefined;
    if (uniforms !== undefined) blocks.set(pass.id, uniforms);
  }
  return blocks;
}

export function createUniformAnimator(): UniformAnimator {
  let pushed: Map<string, UniformValues> | null = null;
  /** T1598b: the draws the backend was last told to skip — a pass's other per-frame value. */
  let skipped: Set<string> | null = null;

  return {
    push(backend, base, next) {
      if (!isUniformOnlyChange(base, next)) return null;

      const blocks = blocksOf(next);
      // The first push of a plan compares against the STRUCTURAL plan's own values, so a
      // frame whose values happen to equal the compile-time ones writes nothing.
      const previous = pushed ?? blocksOf(base);

      let written = 0;
      for (const [passId, values] of blocks) {
        if (sameBlock(previous.get(passId), values)) continue;
        backend.updateUniforms({ passId, values });
        written += 1;
      }
      pushed = blocks;

      // T1598b: a draw that entered or left its light's reach. Pushed on the flip only, and
      // not counted as a block: it writes no buffer.
      const skips = planSkippedDraws(next.passes);
      const before = skipped ?? planSkippedDraws(base.passes);
      for (const passId of skips) {
        if (!before.has(passId)) backend.updateUniforms({ passId, values: {}, skip: true });
      }
      for (const passId of before) {
        if (!skips.has(passId)) backend.updateUniforms({ passId, values: {}, skip: false });
      }
      skipped = skips;
      return written;
    },
    reset() {
      pushed = null;
      skipped = null;
    },
  };
}
