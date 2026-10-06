import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compileGraphRetaining, flattenComponents, rebaseOnValues } from "@compiler/index.ts";
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
import { ZERO_FRAME } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { TIER_B_CAPABILITIES } from "@/examples/runner.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { generatedTextCounts } from "@runtime/backend/wgsl.ts";
import { classifyRevision } from "./classify-revision.ts";

/**
 * T1652b — THE VALUES LANE IS THE FULL COMPILE AT THAT REVISION, OR IT REFUSES.
 *
 * The app sends a values-only revision (`classifyRevision`) through `rebaseOnValues`
 * instead of `compileGraphRetaining`. The claim is not that the lane is fast. It is that
 * whatever it returns is, pass for pass and diagnostic for diagnostic, what the full
 * compile of that revision returns, and that it builds no shader text on the way.
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
        flattening: { morphs: NO_MORPHS, instanceChannels: flattened.instanceChannels },
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

const DOCUMENTS: ReadonlyArray<{ readonly name: string; readonly open: () => Opened | Promise<Opened> }> = [
  { name: "E13", open: () => openExample("E13-Prism.loom.json") },
  { name: "E79", open: () => openExample("E79-Crucible.loom.json") },
  { name: "E81", open: () => openExample("E81-Phone-Desk.loom.json") },
  { name: "a 200-node chain", open: () => openChain(200) },
];

describe("T1652b: a value through the lane is the full compile of that revision", () => {
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
            expect(rebased.compiled.passes, where).toEqual(full.compiled.passes);
            expect(rebased.compiled.diagnostics, where).toEqual(full.compiled.diagnostics);
            expect(rebased.compiled.resources, where).toEqual(full.compiled.resources);
            if (JSON.stringify(rebased.compiled.passes) !== JSON.stringify(held.compiled.passes)) moved += 1;
            taken += 1;
            held = rebased;
          }
          graph = next;
        }
      }
      const summary = `lane ${String(taken)} (passes moved in ${String(moved)}), broke the plan ${String(broke)}, lane refused ${JSON.stringify([...refused])}, classifier refused ${JSON.stringify([...refusedByClassifier])}`;
      // Not vacuous: the lane was taken, and what it returned was a DIFFERENT plan from the one before it.
      expect(taken, summary).toBeGreaterThan(0);
      expect(moved, summary).toBeGreaterThan(0);
    });
  }

  it("a control read by an expression in another node: the reader's uniform moves, and nothing else is compiled", async () => {
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
    const full = compileGraphRetaining(request);
    expect(rebased.compiled.passes).toEqual(full.compiled.passes);
    // The twenty levels that read the slider are the only passes that are new objects.
    const changed = rebased.compiled.passes.filter((pass, index) => pass !== base.compiled.passes[index]);
    expect(changed.length).toBe(20);
    expect(new Set(changed.map((pass) => (pass as { nodeId?: string }).nodeId)).size).toBe(20);
    // And the base they were spliced over is this revision's: the frames after it read 0.875.
    expect(rebased.retained?.request).toBe(request);
    expect(rebased.retained?.graph.nodes[slider.id]).toBe(next.nodes[slider.id]);
  });
});
