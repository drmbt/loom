import { describe, expect, it } from "vitest";

import { createUniformAnimator } from "../app/animate-parameters.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { ProjectSettings } from "../domain/types/graph.ts";
import type { ParameterSlot, ParameterValue } from "../domain/types/parameters.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import type { LoomBackend } from "../runtime/backend/index.ts";
import type { BufferWritePassDescriptor } from "../runtime/backend/plan.ts";
import { generatedTextCounts } from "../runtime/backend/wgsl.ts";
import { tableProbeGraph, tableProbeNode, tableProbeRows } from "./buffer-write.fixture.ts";
import { compileGraph } from "./compile.ts";
import { prepareFrameCompiler } from "./frame-compile.ts";
import { isUniformOnlyChange } from "./recompile.ts";
import type { CompileRequest, CompiledGraph } from "./types.ts";

/**
 * T1623b slice 2 — A NODE'S TABLE OF ROWS STAYS A VALUE ALL THE WAY THROUGH THE COMPILER.
 *
 * The seam is for a node: a Render's named Lights, a Ramp's stops. The backend half is held
 * by `runtime/backend/**\/buffer-write*.test.ts`. This is the other half, the one "built,
 * tested, never wired" would miss: that a node definition can emit the pass at all, and that
 * a row whose value is DRIVEN costs what a driven uniform costs.
 *
 *  - the compiler carries a node's `write` pass into the plan, under the node's own id;
 *  - a driven row keeps the document on the values-only frame path: no full compile, no
 *    generator run, no template text built (the witness `generated-text.test.ts` uses);
 *  - the frame's rows are the ones a full compile at that frame carries;
 *  - the uniform animator pushes them, and pushes nothing on a frame where they did not move;
 *  - rows that outgrow the table are refused by the node's name, at compile.
 *
 * What a shader reads from the table is `buffer-write.gpu.test.ts`'s, on Dawn.
 */

const registry = createNodeRegistry([...allNodeDefinitions, tableProbeNode]).view();

const settings: ProjectSettings = {
  outputResolution: { width: 16, height: 16 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 20,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const frameAt = (frameIndex: number): FrameEvaluationInput => ({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 });

const expressionSlot = (source: string, retained: ParameterValue): ParameterSlot => ({
  mode: "expression",
  bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: retained } },
});

const requestFor = (parameters: Parameters<typeof tableProbeGraph>[0] = {}): CompileRequest => ({ graph: tableProbeGraph(parameters), settings, registry, capabilities: TIER_B_CAPABILITIES });

const rowsPass = (plan: CompiledGraph): BufferWritePassDescriptor => {
  const pass = plan.passes.find((entry) => entry.kind === "write");
  if (pass === undefined || pass.kind !== "write") throw new Error("the plan carries no write pass");
  return pass;
};

const errorsOf = (plan: CompiledGraph): Array<[string | undefined, string]> =>
  plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => [diagnostic.nodeId, diagnostic.message]);

describe("T1623b: a node's table of rows, through the compiler", () => {
  it("carries the node's write pass into the plan, naming the node and its own scratch buffer", () => {
    const plan = compileGraph(requestFor({ gain: 2 }));
    expect(errorsOf(plan)).toEqual([]);
    expect(rowsPass(plan)).toEqual({
      kind: "write",
      id: "probe_table#rows",
      nodeId: "probe_table",
      resourceId: "scratch:probe_table:table",
      offset: 16,
      row: ["f32", "f32", "f32", "f32"],
      capacity: 4,
      countOffset: 0,
      values: { rows: [2, 0.25, 0.5, 1, 4, 0.5, 0.5, 1], count: 2 },
    });
    /* The table is the node's own buffer, sized by its Capacity, and the draw reads it. */
    expect(plan.resources.find((resource) => resource.id === "scratch:probe_table:table")).toMatchObject({ kind: "buffer", stride: 4, capacity: 20, usage: "storage" });
    const show = plan.passes.find((pass) => pass.id === "probe_table#show");
    expect(show?.kind === "draw" ? show.buffers : undefined).toEqual([{ binding: "table", resourceId: "scratch:probe_table:table" }]);
  });

  it("keeps a driven row on the values-only frame path: no full compile, no generator run, no text built", () => {
    /* Gain 1 before frame 30 and 8 from it on; Rows 2 before frame 60 and 4 from it on. */
    const request = requestFor({ gain: expressionSlot("1 + 7 * (frame >= 30)", 1), rows: expressionSlot("2 + 2 * (frame >= 60)", 2) });
    const prepared = prepareFrameCompiler(request);
    expect(prepared.reason).toBeNull();
    expect(prepared.uniformOnly).toBe(true);
    expect(errorsOf(prepared.base)).toEqual([]);

    const seen: number[][] = [];
    for (const [frameIndex, gain, rows] of [[1, 1, 2], [45, 8, 2], [90, 8, 4]] as const) {
      const resolution = { frame: frameAt(frameIndex) };
      const before = generatedTextCounts();
      const spliced = prepared.compileFrame(resolution);
      const after = generatedTextCounts();
      expect(spliced, `frame ${frameIndex}: ${prepared.reason ?? ""}`).not.toBeNull();
      if (spliced === null) continue;
      /* The witness: a frame that only moved rows generated and built nothing. */
      expect([frameIndex, after.generated - before.generated, after.built - before.built]).toEqual([frameIndex, 0, 0]);
      /* Values and nothing else: the same structure, and the rows a full compile carries. */
      expect(isUniformOnlyChange(prepared.base, spliced)).toBe(true);
      expect(rowsPass(spliced).values).toEqual({ rows: tableProbeRows(gain, rows), count: rows });
      expect(spliced.passes).toEqual(compileGraph({ ...request, resolution }).passes);
      seen.push([...rowsPass(spliced).values.rows]);
    }
    /* Not vacuous: the three frames carried three different tables, one of them longer. */
    expect(new Set(seen.map((rows) => rows.join())).size).toBe(3);
    expect(seen.map((rows) => rows.length)).toEqual([8, 8, 16]);
  });

  it("is pushed by the uniform animator when a row moves, and not when none does", () => {
    const request = requestFor({ gain: expressionSlot("1 + 7 * (frame >= 30)", 1) });
    const prepared = prepareFrameCompiler(request);
    const pushes: Array<{ passId: string; values: unknown }> = [];
    const backend = { updateUniforms: (update: { passId: string; values: unknown }) => void pushes.push(update) } as unknown as LoomBackend;
    const animator = createUniformAnimator();
    const at = (frameIndex: number): CompiledGraph => {
      const spliced = prepared.compileFrame({ frame: frameAt(frameIndex) });
      if (spliced === null) throw new Error(prepared.reason ?? "the frame fell off the values-only path");
      return spliced;
    };

    expect(animator.push(backend, prepared.base, at(1))).toBe(0);
    expect(animator.push(backend, prepared.base, at(2))).toBe(0);
    expect(pushes).toEqual([]);
    expect(animator.push(backend, prepared.base, at(31))).toBe(1);
    expect(pushes).toEqual([{ passId: "probe_table#rows", values: { rows: tableProbeRows(8, 2), count: 2 } }]);
    expect(animator.push(backend, prepared.base, at(32))).toBe(0);
    expect(pushes).toHaveLength(1);
  });

  it("treats where the rows go as structure: a driven Capacity is refused the fast path by name", () => {
    const prepared = prepareFrameCompiler(requestFor({ capacity: expressionSlot("4 + 4 * (frame >= 30)", 4) }));
    expect(prepared.uniformOnly).toBe(false);
    expect(prepared.reason).toMatch(/Node "probe_table" \(tableProbe\) animates "capacity"/);
    /* And two capacities are two structures, where two row counts are one. */
    expect(isUniformOnlyChange(compileGraph(requestFor({ capacity: 4 })), compileGraph(requestFor({ capacity: 8 })))).toBe(false);
    expect(isUniformOnlyChange(compileGraph(requestFor({ rows: 1 })), compileGraph(requestFor({ rows: 4 })))).toBe(true);
  });

  it("refuses rows that outgrow the table by the node's name, and takes exactly the capacity", () => {
    expect(errorsOf(compileGraph(requestFor({ rows: 4 })))).toEqual([]);
    expect(errorsOf(compileGraph(requestFor({ rows: 5 })))).toEqual([
      ["probe_table", 'Buffer values "probe_table#rows" for "scratch:probe_table:table": 5 rows do not fit its capacity of 4.'],
    ]);
  });
});
