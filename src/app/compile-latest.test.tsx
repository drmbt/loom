// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { useFrameLoop } from "./use-frame-loop.ts";

/**
 * §B235 — THE FRAME LOOP NEVER HAS TWO COMPILES IN FLIGHT, AND THE NEWEST PLAN WINS.
 *
 * `backend.compile` carries resources from the program it holds, so two compiles in
 * flight at once destroy each other's objects (the Dawn repro is
 * `src/tests/headless/compile-overlap.gpu.test.ts`). The frame loop queues them. What a
 * queue must not cost: a burst of structural edits inside one long compile must not
 * replay every intermediate plan on the GPU (only the newest is worth building), and a
 * compile that fails must not wedge the queue behind it.
 *
 * Driven through `useFrameLoop` with a backend whose compiles settle only when the test
 * says so, and plans that are structurally distinct (no values-only handover applies).
 */

afterEach(cleanup);

interface Pending {
  readonly plan: CompiledGraph;
  land(): void;
  fail(message: string): void;
}

function heldBackend() {
  const pending: Pending[] = [];
  const handed: CompiledGraph[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  let installed: CompiledGraph | null = null;
  const backend = {
    status: { initialized: true, disposed: false, halted: false, stale: false },
    compile: (plan: CompiledGraph) => {
      handed.push(plan);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      return new Promise<CompiledExecutionPlan>((resolve, reject) => {
        pending.push({
          plan,
          land: () => {
            inFlight -= 1;
            installed = plan;
            resolve({ id: `plan-${String(handed.length)}`, logical: plan } as unknown as CompiledExecutionPlan);
          },
          fail: (message) => {
            inFlight -= 1;
            reject(new Error(message));
          },
        });
      });
    },
    render() {},
    loop: () => ({ stop() {} }),
    onDiagnostic: () => () => {},
    updateUniforms() {},
    resetTemporalHistory() {},
    setCookPolicy() {},
  } as unknown as LoomBackend;
  return {
    backend,
    handed,
    /** The oldest compile the backend is still working on. */
    next(): Pending {
      const first = pending.shift();
      if (first === undefined) throw new Error("no compile is in flight");
      return first;
    },
    waiting: () => pending.length,
    mostInFlight: () => mostInFlight,
    installed: () => installed,
  };
}

const plan = (name: string): CompiledGraph =>
  ({
    ok: true,
    signature: name,
    passes: [{ kind: "effect", id: `${name}#${name}:fill`, shader: `// ${name}`, target: "t", uniformBinding: "params", uniforms: {} }],
    resources: [],
    outputs: [],
    diagnostics: [],
    feedback: [],
    pruned: [],
    resourceSignatures: [],
    passSignatures: [],
    sources: [],
  }) as unknown as CompiledGraph;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(backend: LoomBackend, first: CompiledGraph) {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const hook = renderHook(
    ({ compiled }: { compiled: CompiledGraph }) =>
      useFrameLoop({ bus: runtime.bus, backend, compiled, settings: runtime.settings }),
    { initialProps: { compiled: first } },
  );
  return { runtime, hook };
}

describe("§B235 — compiles queued per backend, newest wins", () => {
  it("three structural edits inside one compile: the backend builds the first and the last, one at a time", async () => {
    const gpu = heldBackend();
    const [a, b, c, d] = [plan("a"), plan("b"), plan("c"), plan("d")];
    const { runtime, hook } = mount(gpu.backend, a);
    await settle();
    gpu.next().land();
    await settle();
    expect(hook.result.current.installedPlan).toBe(a);

    // b starts; c and d arrive while it is still building.
    hook.rerender({ compiled: b });
    await settle();
    hook.rerender({ compiled: c });
    await settle();
    hook.rerender({ compiled: d });
    await settle();
    expect(gpu.handed).toEqual([a, b]);
    expect(gpu.waiting()).toBe(1);
    // The backend still holds a; nothing newer is announced before it lands.
    expect(hook.result.current.installedPlan).toBe(a);

    gpu.next().land();
    await settle();
    // b landed but is already stale: it is not announced, and c is never built.
    expect(hook.result.current.installedPlan).toBe(a);
    expect(gpu.handed).toEqual([a, b, d]);

    gpu.next().land();
    await settle();
    expect(hook.result.current.installedPlan).toBe(d);
    expect(gpu.installed()).toBe(d);
    expect(gpu.mostInFlight()).toBe(1);
    expect(hook.result.current.diagnostics).toEqual([]);
    runtime.dispose();
  });

  it("a compile that fails does not hold up the one behind it, and only the newest one's failure is reported", async () => {
    const gpu = heldBackend();
    const [a, b, c] = [plan("a"), plan("b"), plan("c")];
    const { runtime, hook } = mount(gpu.backend, a);
    await settle();
    gpu.next().land();
    await settle();

    hook.rerender({ compiled: b });
    await settle();
    hook.rerender({ compiled: c });
    await settle();
    gpu.next().fail("b is broken");
    await settle();
    // b was superseded before it failed: its failure is no longer the document's.
    expect(hook.result.current.diagnostics).toEqual([]);
    expect(gpu.handed).toEqual([a, b, c]);

    gpu.next().fail("c is broken");
    await settle();
    expect(hook.result.current.diagnostics.map((entry) => entry.message)).toEqual([
      "The backend rejected the compiled plan: c is broken",
    ]);
    // §V9: the plan the backend still holds is the last one that landed.
    expect(hook.result.current.installedPlan).toBe(a);

    // And the queue is not wedged by two failures in a row.
    const fixed = plan("fixed");
    hook.rerender({ compiled: fixed });
    await settle();
    gpu.next().land();
    await settle();
    expect(hook.result.current.installedPlan).toBe(fixed);
    expect(gpu.mostInFlight()).toBe(1);
    runtime.dispose();
  });
});
