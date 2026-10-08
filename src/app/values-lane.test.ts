import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compileGraphRetaining, flattenComponents, prepareFrameCompiler, rebaseOnValues } from "@compiler/index.ts";
import type { CompileGraphResult, CompileRequest, FlattenedGraph } from "@compiler/index.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { graphChannelResolver } from "@domain/channels/graph-channels.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createComponentSystem } from "@domain/components/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { NO_MORPHS } from "@domain/presets/morph-index.ts";
import { loadProject } from "@domain/project/index.ts";
import { frameFromClock, ZERO_FRAME } from "@domain/types/frame.ts";
import type { EvaluationFrame } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { TIER_B_CAPABILITIES } from "@/examples/runner.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { generatedTextCounts } from "@runtime/backend/wgsl.ts";
import { edge, graph as graphOf, named, settings as projectSettings } from "@/examples/documents/builders.ts";
import { classifyRevision } from "./classify-revision.ts";

/**
 * T1652b — WHAT IS DRAWN FROM THE LANE'S PLAN IS WHAT IS DRAWN FROM THE FULL COMPILE'S, OR
 * THE LANE REFUSES.
 *
 * The app sends a values-only revision (`classifyRevision`) through `rebaseOnValues`
 * instead of `compileGraphRetaining`. The claim is not that the lane is fast. It is:
 *
 *  1. THE FRAME. The per-frame compile over the lane's result returns, pass for pass, what
 *     it returns over the full compile of that revision, at frame zero and at a later
 *     frame. That is the plan a frame is drawn from, and it is the whole claim for anything
 *     read through an expression: such a parameter is resolved at every frame, so the lane
 *     leaves it to the frame (`rebaseOnValues`, "what reads through an EXPRESSION").
 *  2. THE REST, BYTE FOR BYTE. Every pass the frame does NOT rewrite is, in the lane's own
 *     plan, the full compile's pass: where no expression is involved the lane is the full
 *     compile.
 *  3. It builds no shader text on the way, and what the written node SAYS is the full
 *     compile's.
 *
 * Derived, not listed: EVERY stored value the classifier calls movable, on every node of
 * each document, is moved in turn, each revision built on the one before it (so a rebase
 * over a rebase is covered, which is what a drag is). The documents are three shipped
 * examples and a 200-node chain with a control read by an expression.
 */

const baseRegistry = createNodeRegistry(allNodeDefinitions).view();

interface Opened {
  readonly graph: GraphDocument;
  readonly settings: ProjectSettings;
  readonly registry: NodeRegistryView;
  readonly components: ReturnType<ReturnType<typeof createComponentSystem>["components"]["view"]>;
}

/** One shipped example, by file name: three named documents, not a walk of the set. */
function openExample(fileName: string): Opened {
  const text = readFileSync(new URL(`../../examples/${fileName}`, import.meta.url), "utf8");
  const system = createComponentSystem(baseRegistry);
  const loaded = loadProject(text, { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`${fileName} does not load`);
  for (const definition of loaded.components) system.components.register(definition);
  return { graph: loaded.document.graph, settings: loaded.document.settings, registry: system.nodes, components: system.components.view() };
}

/** One noise, a chain of `count` levels, an output; a Slider on a Panel; every tenth level reads the slider. */
async function openChain(count: number): Promise<Opened> {
  const system = createComponentSystem(baseRegistry);
  const store = createGraphStore();
  const { bus } = createDomainBus({ store, registry: system.nodes });
  const operations: GraphPatchOperation[] = [
    { op: "addNode", ref: "$src", type: "noise", position: { x: 0, y: 0 }, label: "noise_src" },
    { op: "addNode", ref: "$slider", type: "slider", position: { x: 0, y: 300 }, label: "slider_gain", parameters: { caption: "Gain", channel: "gain", value: 0.5, min: 0, max: 1, step: 0, defaultValue: 0.5 } },
    {
      op: "addNode",
      ref: "$panel",
      type: "panel",
      position: { x: 0, y: 600 },
      label: "panel_desk",
      parameters: { title: "Desk", board: serializePanelBoard({ columns: 8, items: [{ member: "slider_gain", rect: { x: 0, y: 0, w: 8, h: 1 } }] }) },
    },
    { op: "connect", source: { nodeId: "$slider", portId: "out" }, target: { nodeId: "$panel", portId: "controls" } },
  ] as GraphPatchOperation[];
  let previous = "$src";
  for (let index = 0; index < count; index += 1) {
    const ref = `$level${String(index)}`;
    const reads = index % 10 === 0;
    operations.push({
      op: "addNode",
      ref,
      type: "level",
      position: { x: (index + 1) * 300, y: 0 },
      label: `level_n${String(index)}`,
      parameters: reads
        ? { brightness: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('slider_gain').chan.gain" }, static: { kind: "static", value: 1 } } }, contrast: 1 }
        : { brightness: 1, contrast: 1 },
    } as GraphPatchOperation);
    operations.push({ op: "connect", source: { nodeId: previous, portId: "out" }, target: { nodeId: ref, portId: "input" } } as GraphPatchOperation);
    previous = ref;
  }
  operations.push({ op: "addNode", ref: "$out", type: "output", position: { x: (count + 2) * 300, y: 0 }, label: "output_frame" } as GraphPatchOperation);
  operations.push({ op: "connect", source: { nodeId: previous, portId: "out" }, target: { nodeId: "$out", portId: "input" } } as GraphPatchOperation);
  const result = await bus.execute(
    "graph.applyPatch",
    { baseRevision: store.view.getRevision(), operations, label: "chain" },
    { actor: { kind: "system", id: "t1652b" }, projectId: "t1652b", capabilities: [] },
  );
  if (result.status !== "applied") throw new Error(`the chain did not apply: ${JSON.stringify(result.diagnostics).slice(0, 400)}`);
  return { graph: store.view.getGraph(), settings: store.view.getSettings(), registry: system.nodes, components: system.components.view() };
}

/**
 * The compile request the app builds, with the app's two live readers: the flattening of
 * the revision in hand, and ONE channel resolver that answers a frameless read from a
 * zero-frame value graph of that flattening (`use-value-graph.ts`, `use-graph-compile.ts`).
 */
function harness(opened: Opened) {
  let flattened: FlattenedGraph = flattenComponents({ graph: opened.graph, registry: opened.registry, components: opened.components });
  let zero: { flattened: FlattenedGraph; resolver: ChannelResolver } | null = null;
  const channels: ChannelResolver = (channel, context) => {
    if (zero === null || zero.flattened !== flattened) {
      const session = createValueGraphSession(opened.registry);
      const evaluated = session.evaluate(flattened.graph, ZERO_FRAME, {
        pointer: { x: 0, y: 0, buttons: 0 },
        flattening: { morphs: NO_MORPHS, instanceChannels: flattened.instanceChannels, instancePages: flattened.instancePages },
      });
      zero = { flattened, resolver: evaluated.resolver };
    }
    return zero.resolver(channel, context) ?? graphChannelResolver(flattened.graph, opened.registry, flattened.morphs)(channel, context);
  };
  const requestFor = (graph: GraphDocument): CompileRequest => {
    flattened = flattenComponents({ graph, registry: opened.registry, components: opened.components });
    return {
      graph,
      settings: opened.settings,
      registry: opened.registry,
      capabilities: TIER_B_CAPABILITIES,
      components: opened.components,
      flattened,
      resolution: { channels },
    };
  };
  return { requestFor };
}

/** The stored literal a values-only revision may move, moved a little; undefined for anything else. */
function nudged(stored: unknown): unknown {
  const literal = isParameterSlot(stored) ? (stored.bindings.static?.kind === "static" ? stored.bindings.static.value : undefined) : stored;
  let next: unknown;
  if (typeof literal === "number") next = literal === 0 ? 0.125 : literal * 1.0625 + 0.03125;
  else if (typeof literal === "boolean") next = !literal;
  else if (Array.isArray(literal) && literal.length > 0 && literal.every((entry) => typeof entry === "number")) next = literal.map((entry) => entry + 0.0625);
  else return undefined;
  return isParameterSlot(stored) ? { ...stored, bindings: { ...stored.bindings, static: { kind: "static", value: next } } } : next;
}

/** The next revision as the store would hand it over: every untouched node the same object. */
function withStored(graph: GraphDocument, nodeId: NodeId, key: string, stored: unknown): GraphDocument {
  const node = graph.nodes[nodeId] as GraphNode;
  return {
    ...graph,
    revision: graph.revision + 1,
    nodes: { ...graph.nodes, [nodeId]: { ...node, parameters: { ...node.parameters, [key]: stored } } as GraphNode },
  };
}

/** Frame zero and a later one: a plan is drawn at a frame, and the claim is about what is drawn. */
const FRAMES: readonly EvaluationFrame[] = [
  ZERO_FRAME,
  frameFromClock({ timeSeconds: 1.25, deltaSeconds: 1 / 60, frameIndex: 75, mode: "offline", randomSeed: 0, fps: 60 }),
];

/** The per-frame compile over one result, at each of `FRAMES` (null where it compiles in full instead). */
function framesOver(request: CompileRequest, result: CompileGraphResult) {
  const compiler = prepareFrameCompiler(request, result);
  return {
    uniformOnly: compiler.uniformOnly,
    plans: FRAMES.map((frame) => (compiler.uniformOnly ? compiler.compileFrame({ ...(request.resolution ?? {}), frame }) : null)),
  };
}

/** What a compile says about one node. */
const saidAbout = (result: CompileGraphResult, nodeId: NodeId) => result.compiled.diagnostics.filter((entry) => entry.nodeId === nodeId);

const DOCUMENTS: ReadonlyArray<{ readonly name: string; readonly open: () => Opened | Promise<Opened> }> = [
  { name: "E13", open: () => openExample("E13-Prism.loom.json") },
  { name: "E79", open: () => openExample("E79-Crucible.loom.json") },
  { name: "E81", open: () => openExample("E81-Phone-Desk.loom.json") },
  { name: "a 200-node chain", open: () => openChain(200) },
];

describe("T1652b: the frame drawn from the lane's plan is the frame drawn from the full compile's", () => {
  for (const document of DOCUMENTS) {
    it(`${document.name}: every movable stored value, each on top of the last`, async () => {
      const opened = await document.open();
      const { requestFor } = harness(opened);
      let graph = opened.graph;
      let held: CompileGraphResult = compileGraphRetaining(requestFor(graph));
      expect(held.compiled.ok, `${document.name} compiles`).toBe(true);

      let taken = 0;
      let moved = 0;
      let broke = 0;
      /** Passes a frame rewrites, summed over the walk: where claim 1 is the only claim. */
      let frameOwned = 0;
      const refused = new Map<string, number>();
      const refusedByClassifier = new Map<string, number>();
      for (const nodeId of Object.keys(graph.nodes).sort() as NodeId[]) {
        for (const key of Object.keys((graph.nodes[nodeId] as GraphNode).parameters).sort()) {
          const stored = nudged((graph.nodes[nodeId] as GraphNode).parameters[key]);
          if (stored === undefined) continue;
          const next = withStored(graph, nodeId, key, stored);
          const kind = classifyRevision(graph, next, opened.registry);
          if (kind.kind !== "values") {
            const rule = kind.reason.replace(/"[^"]*"/g, "…");
            refusedByClassifier.set(rule, (refusedByClassifier.get(rule) ?? 0) + 1);
            // A structural move is not this test's subject and is not kept: the walk goes on from the document as it was.
            continue;
          }
          expect(kind.written).toEqual([nodeId]);
          const request = requestFor(next);
          const before = generatedTextCounts();
          const rebased = rebaseOnValues(held, request, kind.written);
          const after = generatedTextCounts();
          const full = compileGraphRetaining(request);
          // A nudge that breaks the plan (a count pushed out of its range) is not kept either.
          if (!full.compiled.ok) {
            expect(typeof rebased, `${document.name} ${nodeId}.${key}: a revision whose plan has errors is never spliced`).toBe("string");
            broke += 1;
            continue;
          }
          if (typeof rebased === "string") {
            const rule = rebased.replace(/"[^"]*"/g, "…");
            refused.set(rule, (refused.get(rule) ?? 0) + 1);
            held = full;
          } else {
            const where = `${document.name} ${nodeId}.${key}`;
            // No shader text is built: no generator runs, no template is assembled.
            expect({ generated: after.generated - before.generated, built: after.built - before.built }, where).toEqual({ generated: 0, built: 0 });
            expect(rebased.compiled.signature, where).toBe(full.compiled.signature);
            expect(rebased.compiled.resources, where).toEqual(full.compiled.resources);
            expect(saidAbout(rebased, nodeId), where).toEqual(saidAbout(full, nodeId));
            const drawn = framesOver(request, rebased);
            const wanted = framesOver(request, full);
            expect(drawn.uniformOnly, where).toBe(wanted.uniformOnly);
            for (let at = 0; at < FRAMES.length; at += 1) {
              // 1. The frame drawn from the lane's plan is the frame drawn from the full compile's.
              expect(drawn.plans[at]?.passes, `${where} at frame ${String(FRAMES[at]?.frameIndex)}`).toEqual(wanted.plans[at]?.passes);
            }
            // 2. What no frame rewrites is the full compile's, in the lane's own plan.
            const framed = wanted.plans[1];
            for (let index = 0; index < full.compiled.passes.length; index += 1) {
              if (framed !== null && framed !== undefined && framed.passes[index] !== full.compiled.passes[index]) {
                frameOwned += 1;
                continue;
              }
              expect(rebased.compiled.passes[index], `${where} pass ${String(index)}`).toEqual(full.compiled.passes[index]);
            }
            if (JSON.stringify(rebased.compiled.passes) !== JSON.stringify(held.compiled.passes)) moved += 1;
            taken += 1;
            held = rebased;
          }
          graph = next;
        }
      }
      const summary = `lane ${String(taken)} (passes moved in ${String(moved)}, frame-owned passes met ${String(frameOwned)}), broke the plan ${String(broke)}, lane refused ${JSON.stringify([...refused])}, classifier refused ${JSON.stringify([...refusedByClassifier])}`;
      // Not vacuous: the lane was taken, and what it returned was a DIFFERENT plan from the one before it.
      expect(taken, summary).toBeGreaterThan(0);
      expect(moved, summary).toBeGreaterThan(0);
      // A payload's consumer (a Render under a light) is the lane's to re-run: a written light
      // whose Render was not known to read it would be refused, and compiled in full, every time.
      expect([...refused.keys()].filter((rule) => rule.includes("re-ran through a scene payload")), summary).toEqual([]);
    });
  }

  it("a control read through its channel by twenty expressions: the lane re-runs none of them, and the next frame carries the value to all twenty", async () => {
    const opened = await openChain(200);
    const { requestFor } = harness(opened);
    const slider = Object.values(opened.graph.nodes).find((node) => node.label === "slider_gain") as GraphNode;
    const base = compileGraphRetaining(requestFor(opened.graph));
    const next = withStored(opened.graph, slider.id, "value", 0.875);
    const kind = classifyRevision(opened.graph, next, opened.registry);
    expect(kind).toEqual({ kind: "values", written: [slider.id] });
    const request = requestFor(next);
    const rebased = rebaseOnValues(base, request, [slider.id]);
    if (typeof rebased === "string") throw new Error(rebased);
    // The lane wrote no pass: the readers have expressions, and an expression is the frame's.
    const byLane = rebased.compiled.passes.filter((pass, index) => pass !== base.compiled.passes[index]);
    expect(byLane.length).toBe(0);
    // The frame over the lane's result: exactly the twenty levels that read the slider, each at 0.875.
    const frame = prepareFrameCompiler(request, rebased).compileFrame({ ...(request.resolution ?? {}), frame: FRAMES[1] as EvaluationFrame });
    if (frame === null) throw new Error("the frame did not compile over the lane's plan");
    const byFrame = frame.passes.filter((pass, index) => pass !== base.compiled.passes[index]);
    expect(byFrame.length).toBe(20);
    expect(new Set(byFrame.map((pass) => (pass as { nodeId?: string }).nodeId)).size).toBe(20);
    for (const pass of byFrame) expect(JSON.stringify((pass as { uniforms?: unknown }).uniforms)).toContain("0.875");
    // And it is the frame the full compile of that revision gives.
    const full = compileGraphRetaining(request);
    expect(frame.passes).toEqual(prepareFrameCompiler(request, full).compileFrame({ ...(request.resolution ?? {}), frame: FRAMES[1] as EvaluationFrame })?.passes);
    // The base the frames splice over is this revision's: they read the document that holds 0.875.
    expect(rebased.retained?.request).toBe(request);
    expect(rebased.retained?.graph.nodes[slider.id]).toBe(next.nodes[slider.id]);
  });
});

/**
 * T1655b — THE LANE DOES NOT CARRY A TILE'S OWN VALUES, SO IT DOES NOT TAKE A WRITE THAT NEEDS THEM.
 *
 * A camera, light, material, geometry or projector previews as a stock scene whose draw
 * passes and uniform values are on the node's ROW (`ResolvedOutput.synthesis`), not in
 * `passes`. The lane splices passes and keeps the base's rows, so a write ON such a node
 * while its tile is on screen would leave the tile drawing the value before. That was the
 * camera gizmo's failure in the app before the lane existed (the drag wrote the pose, the
 * tile stood still), and the lane must not bring it back by being faster.
 */
describe("T1655b: a write on a node whose own stock-scene tile is watched is compiled in full", () => {
  const open = (nodes: GraphNode[], wires: ReadonlyArray<readonly [string, string, string]> = []): Opened => {
    const system = createComponentSystem(baseRegistry);
    return {
      graph: graphOf(nodes, wires.map(([from, to, port], index) => edge(`e${String(index)}`, [from, "out"], [to, port]))),
      settings: projectSettings({ outputResolution: { width: 64, height: 64 } }),
      registry: system.nodes,
      components: system.components.view(),
    };
  };
  const watching = (request: CompileRequest, ...nodeIds: string[]): CompileRequest => ({
    ...request,
    sinks: nodeIds.map((nodeId) => ({ nodeId: nodeId as NodeId, portId: "out", kind: "preview" as const })),
  });
  const matrixOf = (result: CompileGraphResult, nodeId: string): unknown =>
    result.compiled.outputs.find((output) => output.nodeId === nodeId)?.synthesis?.passes.find((pass) => pass.uniforms?.["viewProjection"] !== undefined)
      ?.uniforms?.["viewProjection"];

  it("a camera nothing renders through: Eye is written, and the lane hands the revision back with the reason", () => {
    const opened = open([named("free", "camera", [0, 0], { eye: [0, 0.5, 3] })]);
    const { requestFor } = harness(opened);
    const base = compileGraphRetaining(watching(requestFor(opened.graph), "camera_free"));
    const next = withStored(opened.graph, "camera_free" as NodeId, "eye", [2, 0.5, 3]);
    // The premise: it IS a values-only revision, so without the refusal the lane takes it.
    expect(classifyRevision(opened.graph, next, opened.registry)).toEqual({ kind: "values", written: ["camera_free"] });
    const request = watching(requestFor(next), "camera_free");
    const rebased = rebaseOnValues(base, request, ["camera_free" as NodeId]);
    expect(rebased).toBe(`"camera_free" is drawn on its own preview tile, whose values are on its row and not in a pass.`);
    // What the refusal protects: the full compile it is sent to has the tile's new matrix, and the base does not.
    expect(matrixOf(compileGraphRetaining(request), "camera_free")).not.toEqual(matrixOf(base, "camera_free"));
  });

  it("the same write with nobody watching the camera rides the lane", () => {
    // The legitimate case the refusal could swallow: no tile, no row, nothing to go stale.
    const opened = open([named("free", "camera", [0, 0], { eye: [0, 0.5, 3] }), named("src", "noise", [400, 0])]);
    const { requestFor } = harness(opened);
    const base = compileGraphRetaining(watching(requestFor(opened.graph), "noise_src"));
    const next = withStored(opened.graph, "camera_free" as NodeId, "eye", [2, 0.5, 3]);
    const rebased = rebaseOnValues(base, watching(requestFor(next), "noise_src"), ["camera_free" as NodeId]);
    expect(typeof rebased).toBe("object");
  });

  it("⚑ a camera with ONE Render rides the lane too: its tile is the Render's own picture, which IS a pass", () => {
    // The owner's case, and the one that must stay fast: dragging the camera that frames the
    // shot. Its row is borrowed from the Render (T546), so there is no synthesis to go stale,
    // and the lane's spliced Render pass carries the new matrix exactly as the full compile's does.
    const opened = open(
      [
        named("source", "pointGrid", [0, 0], { cols: 4, rows: 4 }),
        named("boxes", "geometry", [400, 0], { mode: "instances" }),
        named("key", "light", [800, 0]),
        named("shot", "camera", [0, 400], { eye: [0, 0.5, 3] }),
        named("shot", "render", [400, 400]),
      ],
      [
        ["grid_source", "geometry_boxes", "points"],
        ["geometry_boxes", "render_shot", "scenes"],
        ["camera_shot", "render_shot", "camera"],
        ["light_key", "render_shot", "lights"],
      ],
    );
    const { requestFor } = harness(opened);
    const base = compileGraphRetaining(watching(requestFor(opened.graph), "camera_shot", "render_shot"));
    expect(base.compiled.outputs.find((output) => output.nodeId === "camera_shot")?.synthesis).toBeUndefined();
    const next = withStored(opened.graph, "camera_shot" as NodeId, "eye", [2, 0.5, 3]);
    const request = watching(requestFor(next), "camera_shot", "render_shot");
    const rebased = rebaseOnValues(base, request, ["camera_shot" as NodeId]);
    if (typeof rebased === "string") throw new Error(rebased);
    expect(rebased.compiled.passes).toEqual(compileGraphRetaining(request).compiled.passes);
    expect(rebased.compiled.passes).not.toEqual(base.compiled.passes);
  });
});
