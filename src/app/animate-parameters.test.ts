import { describe, expect, it } from "vitest";

import { createUniformAnimator } from "./animate-parameters.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { UniformValues } from "@runtime/backend/plan.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";

/**
 * The per-frame push, on its own (T259, §V163, §V5).
 *
 * `parameter-animation.test.ts` proves the picture moves; this proves the two things a
 * pixel test cannot see. That only CHANGED blocks are written — a graph where one of many
 * passes animates must cost one buffer write per frame, not one per pass — and that a
 * per-frame plan which is NOT a values-only variation is refused rather than pushed,
 * because writing it would be a recompile at frame rate wearing another name (§V5).
 */

function plan(passes: ReadonlyArray<{ id: string; uniforms?: UniformValues }>): CompiledGraph {
  return {
    passes: passes.map((pass) => ({
      kind: "effect",
      id: pass.id,
      shader: "",
      target: "t",
      ...(pass.uniforms === undefined ? {} : { uniforms: pass.uniforms }),
    })),
    resources: [],
    // What `isUniformOnlyChange` compares. Same signatures = same structure.
    resourceSignatures: [{ id: "t", signature: "t@1" }],
    passSignatures: passes.map((pass) => ({ id: pass.id, signature: `${pass.id}@1` })),
    // The whole-plan signature is what `isUniformOnlyChange` compares, and uniform VALUES
    // are excluded from it by construction (§V5) — so it is derived from structure here.
    signature: passes.map((pass) => pass.id).join("|"),
  } as unknown as CompiledGraph;
}

function recordingBackend() {
  const writes: Array<{ passId: string; values: UniformValues }> = [];
  const backend = {
    updateUniforms(update: { passId: string; values: UniformValues }) {
      writes.push({ passId: update.passId, values: update.values });
    },
  } as unknown as LoomBackend;
  return { backend, writes };
}

describe("the per-frame uniform push", () => {
  it("writes only the blocks whose values actually moved", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([
      { id: "a", uniforms: { level: 0 } },
      { id: "b", uniforms: { level: 5 } },
    ]);

    expect(
      animator.push(backend, base, plan([
        { id: "a", uniforms: { level: 1 } },
        { id: "b", uniforms: { level: 5 } },
      ])),
    ).toBe(1);
    expect(writes.map((write) => write.passId)).toEqual(["a"]);

    // Same values again: nothing to write. An animated parameter that is momentarily
    // still costs nothing.
    expect(
      animator.push(backend, base, plan([
        { id: "a", uniforms: { level: 1 } },
        { id: "b", uniforms: { level: 5 } },
      ])),
    ).toBe(0);
    expect(writes).toHaveLength(1);
  });

  it("compares vectors by value, not by identity", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([{ id: "a", uniforms: { color: [1, 0, 0] } }]);

    expect(animator.push(backend, base, plan([{ id: "a", uniforms: { color: [1, 0, 0] } }]))).toBe(0);
    expect(animator.push(backend, base, plan([{ id: "a", uniforms: { color: [1, 0, 1] } }]))).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it("refuses a plan that is not a values-only variation, and touches nothing", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([{ id: "a", uniforms: { level: 0 } }]);
    // A second pass is STRUCTURE. The correct answer is to refuse, not to recompile.
    const structural = plan([
      { id: "a", uniforms: { level: 1 } },
      { id: "extra", uniforms: { level: 1 } },
    ]);

    expect(animator.push(backend, base, structural)).toBeNull();
    expect(writes).toEqual([]);
  });

  it("forgets what it pushed when the structural plan is replaced", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([{ id: "a", uniforms: { level: 0 } }]);

    animator.push(backend, base, plan([{ id: "a", uniforms: { level: 1 } }]));
    animator.reset();
    // Without the reset this would compare against the last push and write nothing —
    // and the new program's buffers would keep the previous program's values.
    expect(animator.push(backend, base, plan([{ id: "a", uniforms: { level: 1 } }]))).toBe(1);
    expect(writes).toHaveLength(2);
  });
});

describe("a driven substeps parameter animates like a uniform (T425)", () => {
  const loopPlan = (count: number): CompiledGraph =>
    ({
      passes: [
        { kind: "loop", id: "state#loop:begin", edge: "begin", loopId: "state", count },
        { kind: "effect", id: "kernel", shader: "", target: "t", uniforms: { level: 1 } },
        { kind: "loop", id: "state#loop:end", edge: "end", loopId: "state" },
      ],
      resources: [],
      resourceSignatures: [{ id: "t", signature: "t@1" }],
      // T425: the count is OUT of the structure key, so two counts share one signature.
      passSignatures: [
        { id: "state#loop:begin", signature: "loop-begin@1" },
        { id: "kernel", signature: "kernel@1" },
        { id: "state#loop:end", signature: "loop-end@1" },
      ],
      signature: "loop-plan@1",
    }) as unknown as CompiledGraph;

  it("pushes the loop count as a one-value block when it moves, and only then", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = loopPlan(1);

    expect(animator.push(backend, base, loopPlan(1))).toBe(0);
    expect(animator.push(backend, base, loopPlan(12))).toBe(1);
    expect(writes).toEqual([{ passId: "state#loop:begin", values: { count: 12 } }]);
    // Unchanged again: nothing rewritten.
    expect(animator.push(backend, base, loopPlan(12))).toBe(0);
  });

  /*
   * T1583b: a kernel region has TWO values, and the second cannot be read off the first —
   * 12 runs is 12 substeps, or 4 substeps of 3 iterations, and they divide the frame's
   * time differently. So `iterations` rides in the same block, and a change to it alone
   * (the count standing still) is still a push.
   */
  it("pushes a kernel region's iterations beside its count, and when it alone moves", () => {
    const kernelPlan = (count: number, iterations: number): CompiledGraph => {
      const base = loopPlan(count);
      return {
        ...base,
        passes: base.passes.map((pass) =>
          pass.kind === "loop" && pass.edge === "begin"
            ? { ...pass, steps: { pair: "state", iterations, prepare: 256 } }
            : pass,
        ),
      } as unknown as CompiledGraph;
    };
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = kernelPlan(1, 1);

    expect(animator.push(backend, base, kernelPlan(12, 3))).toBe(1);
    expect(animator.push(backend, base, kernelPlan(12, 4))).toBe(1);
    expect(animator.push(backend, base, kernelPlan(12, 4))).toBe(0);
    expect(writes).toEqual([
      { passId: "state#loop:begin", values: { count: 12, iterations: 3 } },
      { passId: "state#loop:begin", values: { count: 12, iterations: 4 } },
    ]);
  });

  /*
   * T1585b: a region whose count follows the frame carries the RATE and its two clamps, and
   * the backend turns them into every frame's own count. So a driven Update Rate has to
   * arrive as those three numbers — the count beside it is only what one frame asked for —
   * and a clamp that moves while the count stands still is still a push: Max Update Steps
   * going from 16 to 2 changes nothing on a frame of four steps and everything on the next
   * long one.
   */
  it("pushes a rate region's rate and clamps beside its count, and when a clamp alone moves", () => {
    const ratePlan = (count: number, perSecond: number, max: number): CompiledGraph => {
      const base = loopPlan(count);
      return {
        ...base,
        passes: base.passes.map((pass) =>
          pass.kind === "loop" && pass.edge === "begin"
            ? { ...pass, steps: { pair: "state", iterations: 1, prepare: 16, rate: { perSecond, min: 1, max } } }
            : pass,
        ),
      } as unknown as CompiledGraph;
    };
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = ratePlan(4, 240, 16);

    expect(animator.push(backend, base, ratePlan(4, 240, 16))).toBe(0);
    expect(animator.push(backend, base, ratePlan(8, 480, 16))).toBe(1);
    expect(animator.push(backend, base, ratePlan(8, 480, 12))).toBe(1);
    expect(animator.push(backend, base, ratePlan(8, 480, 12))).toBe(0);
    expect(writes).toEqual([
      { passId: "state#loop:begin", values: { count: 8, iterations: 1, rate: 480, minSteps: 1, maxSteps: 16 } },
      { passId: "state#loop:begin", values: { count: 8, iterations: 1, rate: 480, minSteps: 1, maxSteps: 12 } },
    ]);
  });
});


/*
 * T1598b: a draw's `skip` is its other per-frame value — whether a light reaches the caster
 * this frame. It is outside the structure key, so the frame that flips it is values-only,
 * and if the animator did not push it the backend would go on skipping a caster that had
 * moved into the light: a shadow that never appears, with every gate green.
 */
describe("a draw that enters or leaves its light's reach is pushed like a uniform (T1598b)", () => {
  const sweep = (skipped: ReadonlyArray<string>, level = 1): CompiledGraph =>
    ({
      passes: ["near", "far"].map((id) => ({
        kind: "draw",
        id,
        shader: "",
        target: "map",
        topology: "triangle-list",
        instances: 1,
        uniforms: { level },
        ...(skipped.includes(id) ? { skip: true } : {}),
      })),
      resources: [],
      resourceSignatures: [{ id: "map", signature: "map@1" }],
      passSignatures: [
        { id: "near", signature: "near@1" },
        { id: "far", signature: "far@1" },
      ],
      signature: "sweep@1",
    }) as unknown as CompiledGraph;

  function skipRecorder() {
    const calls: Array<{ passId: string; values: UniformValues; skip?: boolean }> = [];
    const backend = {
      updateUniforms(update: { passId: string; values: UniformValues; skip?: boolean }) {
        calls.push({ passId: update.passId, values: update.values, ...(update.skip === undefined ? {} : { skip: update.skip }) });
      },
    } as unknown as LoomBackend;
    return { backend, calls };
  }

  it("pushes the flip, each way, once, and writes no block for it", () => {
    const { backend, calls } = skipRecorder();
    const animator = createUniformAnimator();
    const base = sweep(["far"]);

    // The base already skips `far`: the first frame that agrees pushes nothing.
    expect(animator.push(backend, base, sweep(["far"]))).toBe(0);
    expect(calls).toEqual([]);

    // The light moves: `far` comes into reach, `near` leaves it. No uniform block moved.
    expect(animator.push(backend, base, sweep(["near"]))).toBe(0);
    expect(calls).toEqual([
      { passId: "near", values: {}, skip: true },
      { passId: "far", values: {}, skip: false },
    ]);

    // Standing still costs nothing.
    expect(animator.push(backend, base, sweep(["near"]))).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("starts from the plan again after a reset", () => {
    const { backend, calls } = skipRecorder();
    const animator = createUniformAnimator();
    const base = sweep(["far"]);
    animator.push(backend, base, sweep([]));
    expect(calls).toEqual([{ passId: "far", values: {}, skip: false }]);

    // A new structural plan is installed with its own flags; what was pushed is forgotten.
    animator.reset();
    animator.push(backend, base, sweep(["far"]));
    expect(calls).toHaveLength(1);
  });
});

/**
 * T1652b — a plan REBASED on a value (`rebaseOnValues`) is pushed pass by pass.
 *
 * The rebase hands back the plan before it with the passes a written value could reach
 * re-emitted, and every other pass the SAME OBJECT. `push` would compare each block of
 * that plan with what was pushed last — and for a pass that animates, what was pushed last
 * is the last FRAME's value while the plan carries the frameless one it was compiled with.
 * So one moved slider rewrote every animating pass of the document with a value the next
 * frame wrote over again. `pushRebased` looks at the passes that are other objects, and
 * leaves on the device what the device has for the rest.
 */
describe("a rebased plan's push (T1652b)", () => {
  /** `next` with the pass `moved` re-emitted and every other pass the base's own object. */
  const rebased = (base: CompiledGraph, moved: string, uniforms: UniformValues): CompiledGraph =>
    ({ ...base, passes: base.passes.map((pass) => (pass.id === moved ? { ...pass, uniforms } : pass)) }) as CompiledGraph;

  it("writes the pass a value reached, and does not restate a pass a frame has since animated", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([
      { id: "reader", uniforms: { level: 0.5 } },
      { id: "animated", uniforms: { phase: 0 } },
      { id: "still", uniforms: { level: 2 } },
    ]);
    // A frame: the animated pass is now at its frame value on the device.
    animator.push(backend, base, plan([
      { id: "reader", uniforms: { level: 0.5 } },
      { id: "animated", uniforms: { phase: 0.75 } },
      { id: "still", uniforms: { level: 2 } },
    ]));
    writes.length = 0;

    // A value: the rebased plan still carries `phase: 0` for the pass it did not touch.
    const next = rebased(base, "reader", { level: 0.9 });
    expect(animator.pushRebased(backend, base, next)).toBe(1);
    expect(writes).toEqual([{ passId: "reader", values: { level: 0.9 } }]);

    // The next frame diffs against what is REALLY on the device: `phase` did not go back to 0.
    writes.length = 0;
    animator.push(backend, next, plan([
      { id: "reader", uniforms: { level: 0.9 } },
      { id: "animated", uniforms: { phase: 0.75 } },
      { id: "still", uniforms: { level: 2 } },
    ]));
    expect(writes).toEqual([]);
  });

  it("writes nothing when the re-emitted pass says what the device already has", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([{ id: "reader", uniforms: { level: 0.5 } }]);
    expect(animator.pushRebased(backend, base, rebased(base, "reader", { level: 0.5 }))).toBe(0);
    expect(writes).toEqual([]);
  });

  it("refuses a plan that is not a values-only variation, and touches nothing", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([{ id: "a", uniforms: { level: 0 } }]);
    expect(animator.pushRebased(backend, base, plan([{ id: "a", uniforms: { level: 1 } }, { id: "b", uniforms: { level: 1 } }]))).toBeNull();
    expect(writes).toEqual([]);
  });
});
