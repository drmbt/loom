import type { NodeId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { CompileEdge, ResolvedOutput } from "./types.ts";
import type { ResolvedNode } from "./validate.ts";
import { MAX_KERNEL_STEPS, MAX_KERNEL_SUBSTEPS, MAX_SUBSTEPS } from "../runtime/backend/plan.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import { swapPassId } from "./resources.ts";

/**
 * SUBSTEPS — N iterations of a feedback loop per DISPLAYED frame (T387).
 *
 * ## What is actually being iterated
 *
 * A feedback loop is a cycle the compiler has already split: the pair's read half carries
 * last frame, the nodes in the cycle compute the next state, the Feedback node writes the
 * write half, and a swap makes it readable. That whole sequence — read, compute, write,
 * swap — is ONE iteration, and the only thing standing between one iteration and fifty is
 * the number of times the encoder walks it. No new resource, no new pipeline, no new pass:
 * the passes below are the ones a single-step plan already emitted, delimited so the
 * backend knows to encode them again (`expandLoops`).
 *
 * ## Which passes belong to the loop, and why it is a graph question
 *
 * The body is every node on a CURRENT-FRAME path from a consumer of the Feedback node's
 * output back into the Feedback node itself. That definition is what keeps the animated
 * noise driving a spatially-varying feed/kill map OUTSIDE the loop: the noise feeds the
 * cycle but the cycle does not feed the noise, so it is computed once per displayed frame
 * and read fifty times, which is both correct and what anyone would want.
 *
 * The traversal forward from the Feedback node deliberately follows CURRENT-FRAME edges
 * only after the first hop. A second feedback loop downstream is behind its own temporal
 * boundary, and iterating it as part of this one would step a state that is not ours.
 *
 * ## Why the passes are REORDERED
 *
 * Topological order does not put a loop's passes next to each other. E2's is `kernel`,
 * `out:present`, `feedback`, `swap` — the Output's blit sits in the middle, because
 * nothing until now cared. A contiguous region is what a begin/end marker pair can
 * delimit, so the plan is repartitioned into three groups whose relative order inside each
 * group is untouched: everything that FEEDS the loop, the loop, and everything else.
 * "Everything else" is where the Output lands, which is also where it belongs — it then
 * presents the last substep rather than the first.
 *
 * ## What it refuses (§V288)
 *
 * A second ping-pong swap or ring rotation sitting inside the span the reorder would move
 * across is a hazard this module will not paper over: the swap would end up on the wrong
 * side of passes that bind it, which shows up as a plausible picture reading a half-frame
 * behind rather than as a crash. Such a graph keeps its single-step plan and gets a
 * diagnostic that names the loop and the parameter.
 */

/** One feedback loop that asked for more than one iteration per frame. */
export interface SubstepLoop {
  /** The ping-pong pair's resource id — the loop's identity in the plan. */
  readonly loopId: string;
  /** The Feedback node closing the loop; the node a diagnostic names. */
  readonly nodeId: NodeId;
  /** Iterations per displayed frame, >= 2 (a loop of 1 is not emitted at all). */
  readonly count: number;
  /** Every node whose passes are inside the region. Includes the Feedback node. */
  readonly bodyNodes: ReadonlySet<NodeId>;
  /** The pair's swap, which closes each iteration. */
  readonly swapPassId: string;
}

export interface SubstepPlanInput {
  readonly temporalOutputs: ReadonlyArray<ResolvedOutput>;
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  readonly currentFrameEdges: ReadonlyArray<CompileEdge>;
  readonly temporalEdges: ReadonlyArray<CompileEdge>;
}

export interface SubstepPlan {
  readonly loops: ReadonlyArray<SubstepLoop>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

/**
 * Reads every temporal output's declared substep count and works out its loop body.
 *
 * A node that does not DECLARE a substeps parameter (`TemporalDefinition.substeps`) is
 * structurally incapable of asking for one — there is no naming convention to remember and
 * no key to guess.
 */
/**
 * The iteration count a resolved substeps VALUE asks for.
 *
 * T425: the region is emitted even at ONE iteration, whenever the loop is real.
 * T387 skipped count <= 1 — harmless when the count was structural — but the count
 * is a per-frame VALUE now, and a region that appears only above 1 would make
 * "substeps driven from 1 to 3" a STRUCTURAL change the animator must refuse
 * (§V5). The markers cost nothing at count 1: the encoder expands the body once,
 * exactly the un-marked order.
 *
 * The ceiling is already enforced where a user meets it: the manifest declares
 * `max: MAX_SUBSTEPS`, so an over-range value is REFUSED by name at parameter
 * resolution ("Parameter \"substeps\" is 296, above its maximum 256") and the loop
 * falls back to one step per frame. This clamp is a contract guard, not a second
 * opinion — `readExecutionPlan` refuses a count above the ceiling, and refusing the
 * WHOLE PLAN over a number the user has already been told about would turn one loud
 * parameter error into a black frame.
 *
 * Exported for the per-frame values-only path (T1182), which re-derives a loop-begin
 * marker's count from the re-resolved value through THIS function, so the spliced count
 * and the full compile's cannot disagree about rounding or the ceiling.
 */
export function substepCount(raw: unknown): number {
  const requested = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 1;
  return Math.min(Math.max(1, requested), MAX_SUBSTEPS);
}

export function planSubstepLoops(input: SubstepPlanInput): SubstepPlan {
  const diagnostics: RuntimeDiagnostic[] = [];
  const loops: SubstepLoop[] = [];

  for (const output of input.temporalOutputs) {
    const resolved = input.nodes.get(output.nodeId);
    if (resolved === undefined) continue;
    const key = resolved.definition.temporal?.substeps;
    if (key === undefined) continue;

    const count = substepCount(resolved.parameters[key]);

    const bodyNodes = loopBody(output.nodeId, output.portId, input);
    // A Feedback node whose output nothing consumes is a one-node "loop": iterating it
    // would re-copy the same input N times, which costs N times as much and changes
    // nothing. Say so rather than charging for it.
    if (bodyNodes.size < 2) {
      // No loop to iterate: at an ASKED count above one that is a warning; at the
      // default single step it is simply a Feedback nobody reads back — no region.
      if (count <= 1) continue;
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.substepsRefused,
          `Node "${output.nodeId}" asked for ${count} substeps, but nothing reads its output back into it: there is no loop to iterate.`,
          {
            nodeId: output.nodeId,
            suggestion: `Wire the loop (the Feedback's "source" naming a node that reads this output), or set "${key}" back to 1.`,
          },
        ),
      );
      continue;
    }

    loops.push({
      loopId: output.resourceId,
      nodeId: output.nodeId,
      count,
      bodyNodes,
      swapPassId: swapPassId(output.resourceId),
    });
  }

  return { loops, diagnostics };
}

/**
 * Nodes on a current-frame path from a consumer of `(nodeId, portId)` back into `nodeId`.
 *
 * The first hop crosses the temporal boundary (that IS the loop's back edge); every hop
 * after it is current-frame, so a second feedback loop downstream stays out.
 */
function loopBody(nodeId: NodeId, portId: string, input: SubstepPlanInput): ReadonlySet<NodeId> {
  const forwardOf = new Map<NodeId, NodeId[]>();
  const backwardOf = new Map<NodeId, NodeId[]>();
  const link = (map: Map<NodeId, NodeId[]>, from: NodeId, to: NodeId): void => {
    const list = map.get(from);
    if (list === undefined) map.set(from, [to]);
    else list.push(to);
  };
  for (const edge of input.currentFrameEdges) {
    link(forwardOf, edge.source.nodeId, edge.target.nodeId);
    link(backwardOf, edge.target.nodeId, edge.source.nodeId);
  }

  const seeds: NodeId[] = [];
  for (const edge of input.temporalEdges) {
    if (edge.source.nodeId === nodeId && edge.source.portId === portId) seeds.push(edge.target.nodeId);
  }

  const forward = closure(seeds, forwardOf);
  const backward = closure(backwardOf.get(nodeId) ?? [], backwardOf);

  const body = new Set<NodeId>([nodeId]);
  for (const candidate of forward) if (backward.has(candidate)) body.add(candidate);
  return body;
}

function closure(seeds: ReadonlyArray<NodeId>, edges: ReadonlyMap<NodeId, ReadonlyArray<NodeId>>): Set<NodeId> {
  const seen = new Set<NodeId>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const next = stack.pop() as NodeId;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const onward of edges.get(next) ?? []) stack.push(onward);
  }
  return seen;
}

/** A pass as the compiler holds it before `readExecutionPlan` narrows it. */
type RawPass = Record<string, unknown>;

/**
 * Repartitions `passes` so each loop's body is contiguous, wrapped in begin/end markers.
 *
 * Returns the input unchanged when there is nothing to do, and refuses (with a diagnostic
 * naming the loop) rather than reordering across a swap it does not own.
 */
export function applySubstepLoops(
  passes: ReadonlyArray<RawPass>,
  loops: ReadonlyArray<SubstepLoop>,
  ancestorsOf: (bodyNodes: ReadonlySet<NodeId>) => ReadonlySet<NodeId>,
  diagnostics: RuntimeDiagnostic[],
): ReadonlyArray<RawPass> {
  if (loops.length === 0) return passes;

  /** A pass, or an already-wrapped loop region, kept together by later partitions. */
  interface Entry {
    readonly passes: ReadonlyArray<RawPass>;
    readonly nodeIds: ReadonlySet<NodeId>;
  }
  let entries: Entry[] = passes.map((pass) => ({
    passes: [pass],
    nodeIds: typeof pass["nodeId"] === "string" ? new Set([pass["nodeId"] as NodeId]) : new Set<NodeId>(),
  }));

  for (const loop of loops) {
    const inBody = (entry: Entry): boolean => {
      for (const id of entry.nodeIds) if (loop.bodyNodes.has(id)) return true;
      return entry.passes.some((pass) => pass["id"] === loop.swapPassId);
    };
    const bodyIndices = new Set(entries.flatMap((entry, index) => (inBody(entry) ? [index] : [])));
    if (bodyIndices.size === 0) continue;

    // §V288: a swap or rotation we do not own, sitting inside the span the reorder
    // crosses, would land on the wrong side of the passes that bind it — IF anything
    // being moved binds it. T425 refined the original blanket refusal: the repartition
    // moves non-body entries wholesale into `before`/`after` with their mutual order
    // preserved, so a foreign temporal resource whose ENTIRE lifecycle (swap and every
    // pass binding it) lives among the non-body entries cannot be re-ordered against
    // itself — an RGB-delay cache chain downstream of the loop's colour output is the
    // case. The refusal remains for a swap whose resource the BODY (or an ancestor,
    // which moves to `before`) actually binds: iterating across it would read a
    // mid-rotation half.
    const ordered = [...bodyIndices];
    const first = ordered[0] as number;
    const last = ordered[ordered.length - 1] as number;
    const movedNodeBindsResource = (resourceId: unknown): boolean => {
      if (typeof resourceId !== "string") return true; // unknown shape: stay conservative
      const binds = (pass: RawPass): boolean => {
        if (pass["target"] === resourceId || pass["resourceId"] === resourceId) return true;
        const textures = pass["textures"];
        if (Array.isArray(textures) && textures.some((t) => (t as RawPass)["resourceId"] === resourceId)) return true;
        const buffers = pass["buffers"];
        if (Array.isArray(buffers) && buffers.some((b) => (b as RawPass)["resourceId"] === resourceId)) return true;
        return false;
      };
      const ancestors = ancestorsOf(loop.bodyNodes);
      return entries.some((entry, index) => {
        const moved =
          bodyIndices.has(index) || [...entry.nodeIds].some((id) => ancestors.has(id));
        if (!moved) return false;
        return entry.passes.some((pass) => pass["kind"] !== "swap" && binds(pass));
      });
    };
    const trapped = entries.slice(first, last + 1).find(
      (entry, offset) =>
        !bodyIndices.has(first + offset) &&
        entry.passes.some(
          (pass) =>
            pass["kind"] === "swap" &&
            pass["id"] !== loop.swapPassId &&
            movedNodeBindsResource(pass["resourceId"]),
        ),
    );
    if (trapped !== undefined) {
      // T425 emits regions at count 1 too — but a loop that CANNOT reorder (a foreign
      // swap trapped in its span) gets no region, and at one step that is not worth a
      // warning: the user asked for nothing and loses nothing. Driving substeps on
      // such a loop later surfaces as the animator's structural-drift warning, which
      // names the real constraint.
      if (loop.count <= 1) continue;
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.substepsRefused,
          `Node "${loop.nodeId}" asked for ${loop.count} substeps, but another temporal pair swaps inside the loop; it runs one step per frame.`,
          {
            nodeId: loop.nodeId,
            suggestion:
              "Move the other feedback or cache out of this loop, or set Substeps back to 1 (§V22 places every swap after its last consumer).",
          },
        ),
      );
      continue;
    }

    const ancestors = ancestorsOf(loop.bodyNodes);
    const isAncestor = (entry: Entry): boolean => {
      for (const id of entry.nodeIds) if (ancestors.has(id)) return true;
      return false;
    };

    const before: Entry[] = [];
    const body: Entry[] = [];
    const after: Entry[] = [];
    entries.forEach((entry, index) => {
      if (bodyIndices.has(index)) body.push(entry);
      else if (isAncestor(entry)) before.push(entry);
      else after.push(entry);
    });

    const region: Entry = {
      passes: [
        { kind: "loop", id: `${loop.loopId}#loop:begin`, edge: "begin", loopId: loop.loopId, count: loop.count, nodeId: loop.nodeId },
        ...body.flatMap((entry) => [...entry.passes]),
        { kind: "loop", id: `${loop.loopId}#loop:end`, edge: "end", loopId: loop.loopId, nodeId: loop.nodeId },
      ],
      nodeIds: new Set(body.flatMap((entry) => [...entry.nodeIds])),
    };
    entries = [...before, region, ...after];
  }

  return entries.flatMap((entry) => [...entry.passes]);
}

/**
 * KERNEL STEPS (T1583b) — a point kernel run several times per displayed frame.
 *
 * ## Why this is not the loop planning above
 *
 * A feedback loop is a CYCLE of nodes found on the graph, and iterating it means moving
 * its passes together and repeating all of them, swap included. A kernel reads last frame
 * out of its own buffer pair and writes this frame into the other half, with no cycle on
 * the graph at all: the "loop" is one dispatch. So there is nothing to find and nothing to
 * reorder — the dispatch is wrapped where it stands.
 *
 * The same begin/end markers carry the count, because everything a count needs already
 * hangs off them: the encoder expands the region against a live value, the per-frame
 * compile re-derives that value, the animator pushes it, and the GPU timer sums the runs
 * back onto the pass. What differs is on the `begin`: `steps.pair` tells the encoder to
 * swap the pair BETWEEN runs (`KernelStepsDescriptor` says why the swap is not a pass).
 *
 * ## Two counts
 *
 * `substeps` divides the frame's time, `iterations` repeats inside a substep, and the
 * region runs substeps × iterations times. Notch's Physics Root and TouchDesigner's Flex
 * Solver both expose that pair; TouchDesigner's GLSL POP `Passes` is the second one alone.
 *
 * ## What it refuses, by name (§V288)
 *
 *  - a kernel that reads NONE of its own pair. Wired as a processor whose whole schema the
 *    incoming point set provides, every attribute is re-read from upstream each run, so N
 *    runs write the same result N times. It gets no region and, asked for more than one
 *    step, a warning. (A processor that keeps even one attribute of its own steps: that is
 *    a solver with its own state over an animated input.)
 *  - a kernel inside a region a feedback loop iterates. Regions do not nest
 *    (`loopStructureDiagnostics`), so the kernel keeps one run per pass of that loop.
 *
 * Neither refusal depends on the count, so the region's existence never changes when a
 * count does (§V358).
 */

/** What a kernel's two step parameters resolve to. */
export interface KernelStepCounts {
  readonly substeps: number;
  readonly iterations: number;
  /** Dispatches per displayed frame: substeps × iterations, at most `MAX_KERNEL_STEPS`. */
  readonly count: number;
  /** The iterations ASKED for, present only when the dispatch ceiling lowered them. */
  readonly askedIterations?: number;
}

/**
 * The counts two resolved parameter VALUES ask for.
 *
 * Exported for the per-frame values-only path, like `substepCount` above, so the count it
 * splices and the full compile's cannot disagree about rounding or the ceiling.
 *
 * When the product is over the ceiling it is ITERATIONS that give way. Substeps set the
 * time step, and a step that silently grew is the instability the parameter was raised to
 * prevent; fewer iterations is a less converged frame.
 */
export function kernelStepCounts(rawSubsteps: unknown, rawIterations: unknown): KernelStepCounts {
  const whole = (raw: unknown, max: number): number => {
    const asked = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 1;
    return Math.min(Math.max(1, asked), max);
  };
  const substeps = whole(rawSubsteps, MAX_KERNEL_SUBSTEPS);
  const asked = whole(rawIterations, MAX_KERNEL_STEPS);
  const iterations = Math.min(asked, Math.floor(MAX_KERNEL_STEPS / substeps));
  return {
    substeps,
    iterations,
    count: substeps * iterations,
    ...(iterations === asked ? {} : { askedIterations: asked }),
  };
}

export interface KernelStepsInput {
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  /** Every `bufferPair` resource id in the plan. */
  readonly pairs: ReadonlySet<string>;
  /**
   * Can this stored parameter change between frames — an expression, a bind, a preset
   * morph? Such a count arrives inside the frame, so its slots are prepared to the
   * parameter's ceiling up front (`KernelStepsDescriptor.prepare`).
   */
  readonly moves: (nodeId: NodeId, key: string) => boolean;
}

/**
 * Wraps the dispatch of every node that declares `steps` in a loop region, in place.
 *
 * Runs after `applySubstepLoops`, so a feedback loop's region already exists and a kernel
 * inside one is seen to be inside it.
 */
export function applyKernelSteps(
  passes: ReadonlyArray<RawPass>,
  input: KernelStepsInput,
  diagnostics: RuntimeDiagnostic[],
): ReadonlyArray<RawPass> {
  const dispatchesOf = new Map<NodeId, number>();
  for (const pass of passes) {
    if (pass["kind"] !== "dispatch" || typeof pass["nodeId"] !== "string") continue;
    const nodeId = pass["nodeId"] as NodeId;
    if (input.nodes.get(nodeId)?.definition.steps === undefined) continue;
    dispatchesOf.set(nodeId, (dispatchesOf.get(nodeId) ?? 0) + 1);
  }
  if (dispatchesOf.size === 0) return passes;

  const out: RawPass[] = [];
  /** The feedback loop region the walk is inside, if any. */
  let enclosing: RawPass | undefined;
  for (const pass of passes) {
    if (pass["kind"] === "loop") enclosing = pass["edge"] === "begin" ? pass : undefined;
    const nodeId =
      pass["kind"] === "dispatch" && typeof pass["nodeId"] === "string" ? (pass["nodeId"] as NodeId) : undefined;
    const resolved = nodeId === undefined ? undefined : input.nodes.get(nodeId);
    const declared = resolved?.definition.steps;
    if (nodeId === undefined || resolved === undefined || declared === undefined) {
      out.push(pass);
      continue;
    }

    const counts = kernelStepCounts(resolved.parameters[declared.substeps], resolved.parameters[declared.iterations]);
    const refuse = (why: string, suggestion: string): void => {
      out.push(pass);
      // At one step nothing was asked for and nothing is lost.
      if (counts.count <= 1) return;
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.substepsRefused,
          `Node "${nodeId}" asked for ${counts.count} steps per frame ("${declared.substeps}" ${counts.substeps} × "${declared.iterations}" ${counts.iterations}), but ${why} It runs one step per frame.`,
          { nodeId, suggestion },
        ),
      );
    };
    const backToOne = `set "${declared.substeps}" and "${declared.iterations}" back to 1`;

    const emitted = dispatchesOf.get(nodeId) ?? 0;
    if (emitted !== 1) {
      refuse(
        `it emitted ${emitted} dispatch passes, and kernel steps repeat exactly one.`,
        `This is a fault in the node's definition; ${backToOne}.`,
      );
      continue;
    }
    const pair = steppedPair(pass, input.pairs);
    if (pair === undefined) {
      refuse(
        "every attribute in its schema is read from the incoming point set, so each pass would start from the same values and write the same result.",
        `Declare an attribute the incoming point set does not provide, so the kernel has state of its own to carry from step to step, or ${backToOne}.`,
      );
      continue;
    }
    if (enclosing !== undefined) {
      const owner = typeof enclosing["nodeId"] === "string" ? `"${enclosing["nodeId"] as string}"` : "another node";
      refuse(
        `it sits inside the feedback loop that ${owner} iterates, and one loop region cannot run inside another.`,
        `Iterate one of the two: this kernel's steps, or that loop's Substeps. Or ${backToOne}.`,
      );
      continue;
    }

    if (counts.askedIterations !== undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.substepsRefused,
          `Node "${nodeId}" asked for "${declared.substeps}" ${counts.substeps} × "${declared.iterations}" ${counts.askedIterations} = ${counts.substeps * counts.askedIterations} steps per frame, above the ceiling of ${MAX_KERNEL_STEPS}; it runs ${counts.iterations} iterations per substep.`,
          {
            nodeId,
            suggestion: `Lower "${declared.iterations}" to ${counts.iterations}, or lower "${declared.substeps}".`,
          },
        ),
      );
    }
    const substepCeiling = input.moves(nodeId, declared.substeps) ? MAX_KERNEL_SUBSTEPS : counts.substeps;
    const iterationCeiling = input.moves(nodeId, declared.iterations) ? MAX_KERNEL_STEPS : counts.iterations;
    out.push(
      {
        kind: "loop",
        id: `${pair}#loop:begin`,
        edge: "begin",
        loopId: pair,
        count: counts.count,
        nodeId,
        steps: {
          pair,
          iterations: counts.iterations,
          prepare: Math.min(MAX_KERNEL_STEPS, substepCeiling * iterationCeiling),
        },
      },
      pass,
      { kind: "loop", id: `${pair}#loop:end`, edge: "end", loopId: pair, nodeId },
    );
  }
  return out;
}

/**
 * The one buffer pair a dispatch both reads (its read half) and writes (its write half) —
 * the state that carries from run to run. `undefined` when there is not exactly one.
 */
function steppedPair(pass: RawPass, pairs: ReadonlySet<string>): string | undefined {
  const buffers = Array.isArray(pass["buffers"]) ? (pass["buffers"] as ReadonlyArray<RawPass>) : [];
  const halvesOf = new Map<string, Set<string>>();
  for (const binding of buffers) {
    const resourceId = binding["resourceId"];
    if (typeof resourceId !== "string" || !pairs.has(resourceId)) continue;
    const halves = halvesOf.get(resourceId) ?? new Set<string>();
    halves.add(binding["half"] === "write" ? "write" : "read");
    halvesOf.set(resourceId, halves);
  }
  const both = [...halvesOf].filter(([, halves]) => halves.has("read") && halves.has("write"));
  return both.length === 1 ? (both[0] as [string, Set<string>])[0] : undefined;
}
