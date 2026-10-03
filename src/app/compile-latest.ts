import type { CompiledExecutionPlan, LogicalExecutionPlan, RenderBackend } from "@domain/types/backend.ts";

/**
 * §B235 — ONE STRUCTURAL COMPILE AT A TIME PER BACKEND, AND THE NEWEST WAITING ONE WINS.
 *
 * `backend.compile` is not re-entrant. A structural compile diffs the plan against the
 * program the backend holds and CARRIES every unchanged resource over (§V22, T143), then
 * awaits the device's verdict on what it built before installing. Two compiles started
 * inside one compile's duration both carry from the same retained program; the first to
 * install releases what IT dropped, which includes objects the second carried, and the
 * second throws `Buffer is destroyed` (vgpu's VGPU-BUFFER-DISPOSED) in `flushUniforms` —
 * after it has already become the installed program. `useFrameLoop` never awaited the
 * previous compile, so two structural revisions inside one compile reached exactly that:
 * a layer switched off and straight back on, a cue followed by an undo.
 *
 * So the calls are queued per backend: a compile starts only once the one before it has
 * settled (landed or failed). A request still WAITING when a newer one arrives never
 * starts — it resolves `null`, and the newer one builds against whatever the in-flight
 * compile installed. The in-flight one is never interrupted: it finishes, and the caller's
 * own supersession rule (the frame loop's generation guard) decides whether it is
 * announced.
 *
 * Keyed on the backend, not on the caller, so two callers sharing a backend could not
 * overlap through this either. Today `useFrameLoop` is the only product caller that can
 * issue a compile while another is in flight: `src/mcp/serve.ts` owns its own backend
 * and already chains its compiles, and every other caller is a test harness that awaits
 * each one.
 */
interface Queue {
  /** Settles when the newest scheduled compile has settled; never rejects. */
  tail: Promise<unknown>;
  /** Incremented per request; a waiting request runs only while it is still the newest. */
  newest: number;
}

const queues = new WeakMap<Pick<RenderBackend, "compile">, Queue>();

/**
 * `backend.compile(plan)`, after every compile already scheduled on `backend` settles.
 * Resolves `null` when a newer request arrived before this one could start (it was
 * never sent to the backend); rejects with whatever `backend.compile` rejected with.
 */
export function compileLatest(
  backend: Pick<RenderBackend, "compile">,
  plan: LogicalExecutionPlan,
): Promise<CompiledExecutionPlan | null> {
  let queue = queues.get(backend);
  if (queue === undefined) {
    queue = { tail: Promise.resolve(), newest: 0 };
    queues.set(backend, queue);
  }
  const owner = queue;
  const ticket = (owner.newest += 1);
  const run = owner.tail.then(() => (ticket === owner.newest ? backend.compile(plan) : null));
  owner.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
