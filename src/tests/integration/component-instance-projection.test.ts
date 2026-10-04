import { describe, expect, it } from "vitest";

import { flattenComponents } from "../../compiler/flatten.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { alice, contextFor } from "../../domain/commands/test-support.ts";
import {
  COMPONENT_OVERRIDES_STATE_KEY,
  PARENT_BINDINGS_STATE_KEY,
  componentNodeType,
  createComponentSystem,
  isComponentInstance,
  registerComponentCommands,
} from "../../domain/components/index.ts";
import { INTERNAL_CHANNEL_MASKS_KEY } from "../../domain/components/internal-channel-masks.ts";
import { INTERNAL_RESOLUTIONS_KEY } from "../../domain/components/internal-resolutions.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { rewriteNodeNameReferences } from "../../domain/graph/names.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { presetBankNode } from "../../domain/presets/test-support.ts";
import { loadProject } from "../../domain/project/index.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { ChannelMask, GraphDocument, GraphEdge, GraphNode } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import { listExamples, listStarterComponentFiles } from "../../examples/catalogue.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { analysisComponentDefinition } from "../fixtures/analysis-component.ts";
import { animatedComponentDefinition, twoInstanceDocument } from "../fixtures/animated-component.ts";

/**
 * T1553b — DETACHING AN INSTANCE GIVES THE GRAPH FLATTENING COMPILES FOR IT.
 *
 * B238, B239, B240 and T1545b were each "detach drops what flattening applies", found one
 * item at a time. Both now read one projection (`applyInstance`); this gate holds the two
 * readers to one answer over every document there is: for every ROOT instance of every
 * shipped example, every starter component file, every component definition any of them
 * ships (hosted once at its published defaults), the shared test fixtures, and the feature
 * corpus below (the B238/B239/B240/T1545b shapes, which no shipped document uses), the real
 * `component.detach` runs on a real bus, and the document is flattened before and after.
 * The two flat graphs must be the same graph — every node, every parameter, every edge —
 * once the differences detach makes BY DESIGN are normalized away. Those, and only those:
 *
 *  - IDS: the instance's internals flatten as `<instance>/<internal>/…`; detach mints new
 *    root ids for its copies (`DetachOutput.copies`). Before-side ids are mapped through it.
 *  - LABELS: both sides rename colliding labels (B41), against different claim orders —
 *    flattening claims root labels first and then each instance in id order, detach claims
 *    against the root it lands in, which then claims first. Every label on both sides is
 *    replaced by a token of its node's mapped id, and every reference rewritten with it
 *    (`rewriteNodeNameReferences`, the production rename), so `op('Blur_2')` on one side
 *    and `op('Blur')` on the other compare equal exactly when they name the same node.
 *  - POSITION and EDGE IDS: detach places copies at the instance and mints edge ids;
 *    neither reaches a compile. Edges compare as endpoints plus `order`.
 *  - `state.parentBindings` (§V81, legacy): flattening bakes the value and leaves the
 *    binding on the flat node; detach bakes it and drops the binding. The VALUE compares.
 *  - THE INSTANCE'S OWN PROCESSING CHANNELS: flattening adds a compiler-only boundary node
 *    per exposed picture output (`<instance>/$channels:<port>`); detach moves the mask onto
 *    the node behind the output (`carryInstanceChannelMask`), which compiles to the same
 *    pass. The boundary is folded back onto the node it reads before comparing.
 *  - A LOOK'S PAGE BANK: detach rewrites it on purpose (T1541b) and says so
 *    (`component.detach.pageBank`); that node's parameters are left out, nothing else.
 *
 * An instance detach WARNS about (it says the copies cannot be exact) is not compared; it
 * must be in `EXPECTED_INEXACT`, and that list is checked both ways, so a new warning on a
 * shipped document fails here by name. A muted or bypassed instance is not inlined by
 * flattening (T1032), so there is nothing to compare; those are counted, not hidden.
 */

const base = createNodeRegistry(allNodeDefinitions).view();
const ctx = contextFor(alice);

/** `<corpus entry> :: <instance id>` → the warning codes detach is expected to give. */
const EXPECTED_INEXACT: Readonly<Record<string, readonly string[]>> = {};

interface CorpusEntry {
  readonly name: string;
  readonly graph: GraphDocument;
  readonly definitions: readonly GraphComponentDefinition[];
}

function hostOnce(definition: GraphComponentDefinition): GraphDocument {
  return {
    revision: 1,
    groups: {},
    edges: {},
    nodes: {
      host: {
        id: "host",
        type: componentNodeType(definition.componentId, definition.version),
        definitionVersion: definition.version,
        position: { x: 0, y: 0 },
        parameters: {},
      },
    },
  };
}

function shippedCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const hosted = new Set<string>();
  for (const file of [...listExamples(), ...listStarterComponentFiles()]) {
    const system = createComponentSystem(base);
    const loaded = loadProject(file.text, { nodes: system.nodes });
    if (!loaded.ok) throw new Error(`${file.fileName} does not load: ${loaded.reason}`);
    if (loaded.components.length === 0) continue;
    entries.push({ name: file.fileName, graph: loaded.document.graph, definitions: loaded.components });
    for (const definition of loaded.components) {
      const key = `${definition.componentId}@${definition.version}`;
      if (hosted.has(key)) continue;
      hosted.add(key);
      entries.push({ name: `${file.fileName} → ${key} at its defaults`, graph: hostOnce(definition), definitions: loaded.components });
    }
  }
  return entries;
}

// ── the feature corpus: what B238/B239/B240/T1545b fixed, on real node types ──────────────

const leaf = (id: string, type: string, parameters: Record<string, unknown>, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type, label: id, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...extra }) as GraphNode;
const wire = (id: string, from: string, to: string, port = "input") => ({
  id,
  source: { nodeId: from, portId: "out" },
  target: { nodeId: to, portId: port },
});
const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): GraphDocument => ({
  revision: 1,
  groups: {},
  nodes: Object.fromEntries(nodes.map((each) => [each.id, each])),
  edges: Object.fromEntries(edges.map((each) => [each.id, each])),
});
const bind = (ref: string, retained: number) => ({ mode: "bind", bindings: { bind: { kind: "bind", ref }, static: { kind: "static", value: retained } } });
const number = (label: string) => ({ type: "number", label, default: 1, min: 0, max: 8, range: "floor" });
const RED: ChannelMask = { r: true, g: false, b: false, a: true };

/**
 * THE LOOK: Ramp → `grade` (← published `bright`, B238) → `trim` (reads `parent.gain`, a
 * knob published with NO targets, B240) → `legacy` (a legacy `state.parentBindings` on
 * `gain`, B239) → `tail` (← published `tailGain`, which the instance's own
 * `componentOverrides` beat). Every internal value differs from every page value.
 */
const look = {
  componentId: "t1553-look",
  version: 1,
  name: "Look",
  graph: graphOf(
    [
      leaf("src", "ramp", {}, { definitionVersion: 2 }),
      leaf("grade", "level", { brightness: 1 }),
      leaf("trim", "level", { brightness: bind("parent.gain", 1) }),
      leaf("legacy", "level", { brightness: 1 }, { state: { [PARENT_BINDINGS_STATE_KEY]: { brightness: "parent.gain" } } }),
      leaf("tail", "level", { brightness: 1 }),
    ],
    [wire("e0", "src", "grade"), wire("e1", "grade", "trim"), wire("e2", "trim", "legacy"), wire("e3", "legacy", "tail")],
  ),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "tail", portId: "out" }],
  parameters: [
    { key: "bright", definition: number("Bright"), targets: [{ nodeId: "grade", key: "brightness" }] },
    { key: "gain", definition: number("Gain"), targets: [] },
    { key: "tailGain", definition: number("Tail"), targets: [{ nodeId: "tail", key: "brightness" }] },
  ],
} as unknown as GraphComponentDefinition;

/** A look NESTED in another component, whose instance addresses the nested internals by path. */
const outer = {
  componentId: "t1553-outer",
  version: 1,
  name: "Outer",
  graph: graphOf(
    [
      leaf("inner", componentNodeType("t1553-look", 1), { bright: 0.75, gain: 0.5, tailGain: 2 }, {
        state: { [INTERNAL_RESOLUTIONS_KEY]: { trim: { mode: "fixed", width: 4, height: 4 } } },
      }),
      leaf("after", "level", { brightness: 1 }),
    ],
    [wire("e0", "inner", "after")],
  ),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "after", portId: "out" }],
  parameters: [
    { key: "outerBright", definition: number("Outer bright"), targets: [{ nodeId: "inner", key: "bright" }] },
    { key: "after", definition: number("After"), targets: [{ nodeId: "after", key: "brightness" }] },
  ],
} as unknown as GraphComponentDefinition;

/** A generator straight onto the exposed output: Processing Channels carry exactly (T1545b). */
const masked = {
  componentId: "t1553-mask",
  version: 1,
  name: "Mask",
  graph: graphOf([leaf("src", "ramp", {}, { definitionVersion: 2 })], []),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "src", portId: "out" }],
  parameters: [],
} as unknown as GraphComponentDefinition;

/**
 * A variadic port inside (§V131): two layers behind `stack`, declared in the order their
 * edge ids do NOT sort in — B155's shape, where an edge copy that drops `order` inverts them.
 */
const layered = {
  componentId: "t1553-layers",
  version: 1,
  name: "Layers",
  graph: graphOf(
    [
      leaf("front", "ramp", {}, { definitionVersion: 2 }),
      leaf("near", "level", { brightness: 0.5 }),
      leaf("far", "level", { brightness: 0.25 }),
      leaf("stack", "over", {}),
    ],
    [
      wire("e-front", "front", "stack", "in1"),
      wire("e-near", "front", "near"),
      wire("e-far", "front", "far"),
      { ...wire("z-near-first", "near", "stack", "in2"), order: 0 },
      { ...wire("a-far-second", "far", "stack", "in2"), order: 1 },
    ],
  ),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "stack", portId: "out" }],
  parameters: [],
} as unknown as GraphComponentDefinition;

/**
 * A look with a page bank (T1541b): detach rewrites the bank onto the copies, flattening
 * leaves it targeting `parent`. (A knob with no targets would make the rewrite inexact, so
 * this is not `look`.)
 */
const banked = {
  componentId: "t1553-bank",
  version: 1,
  name: "Banked",
  graph: graphOf(
    [
      leaf("src", "ramp", {}, { definitionVersion: 2 }),
      leaf("grade", "level", { brightness: 1 }),
      presetBankNode("looks", "looks", "parent", [{ name: "calm", values: { parent: { bright: 0.3 } } }]),
    ],
    [wire("e0", "src", "grade")],
  ),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
  parameters: [{ key: "bright", definition: number("Bright"), targets: [{ nodeId: "grade", key: "brightness" }] }],
} as unknown as GraphComponentDefinition;

function featureCorpus(): CorpusEntry[] {
  const expression = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.25 + time * 0.5" }, static: { kind: "static", value: 1 } } };
  const instance = (id: string, componentId: string, parameters: Record<string, unknown>, state?: Record<string, unknown>, extra: Partial<GraphNode> = {}): GraphNode =>
    leaf(id, componentNodeType(componentId, 1), parameters, { label: `${id}Look`, ...(state === undefined ? {} : { state }), ...extra });
  const out = leaf("out", "output", {}, { label: "out1" });
  return [
    {
      name: "feature: page values, overrides, resolution and channel-mask paths (B238, B239, B240)",
      definitions: [look],
      graph: graphOf(
        [
          instance("city", "t1553-look", { bright: 0.5, gain: 0.8, tailGain: 0.7 }, {
            [COMPONENT_OVERRIDES_STATE_KEY]: { "tail/brightness": 0.6 },
            [INTERNAL_RESOLUTIONS_KEY]: { grade: { mode: "fixed", width: 2, height: 2 } },
            [INTERNAL_CHANNEL_MASKS_KEY]: { trim: RED },
          }),
          instance("town", "t1553-look", { bright: expression, gain: 0.25, tailGain: 3 }),
          out,
        ],
        [wire("e9", "city", "out")],
      ),
    },
    {
      name: "feature: a nested look, addressed by path from the outer instance (B239)",
      definitions: [look, outer],
      graph: graphOf(
        [
          instance("shell", "t1553-outer", { outerBright: 0.4, after: 0.9 }, {
            [INTERNAL_RESOLUTIONS_KEY]: { "inner/grade": { mode: "fixed", width: 2, height: 2 }, "inner/trim": { mode: "fixed", width: 3, height: 3 } },
            [INTERNAL_CHANNEL_MASKS_KEY]: { "inner/legacy": RED },
          }),
          out,
        ],
        [wire("e9", "shell", "out")],
      ),
    },
    {
      name: "feature: the instance's own Processing Channels (T1545b)",
      definitions: [masked],
      graph: graphOf([instance("tinted", "t1553-mask", {}, undefined, { channelMask: RED }), out], [wire("e9", "tinted", "out")]),
    },
    {
      name: "feature: declared edge order on a variadic port inside (§V131, B155)",
      definitions: [layered],
      graph: graphOf([instance("deck", "t1553-layers", {}), out], [wire("e9", "deck", "out")]),
    },
    {
      name: "feature: a look's page bank (T1541b)",
      definitions: [banked],
      graph: graphOf([instance("staged", "t1553-bank", { bright: 0.6 }), out], [wire("e9", "staged", "out")]),
    },
  ];
}

function fixtureCorpus(): CorpusEntry[] {
  return [
    { name: "fixture: animated-component twoInstanceDocument", graph: twoInstanceDocument(), definitions: [animatedComponentDefinition()] },
    { name: "fixture: analysis-component at its defaults", graph: hostOnce(analysisComponentDefinition()), definitions: [analysisComponentDefinition()] },
  ];
}

// ── the comparison ────────────────────────────────────────────────────────────────────────

const BOUNDARY = "/$channels:";

/**
 * The instance's boundary passes (`<instance>/$channels:<port>`) folded onto the node each
 * reads, which takes the instance's mask: the shape detach writes (see the docblock).
 */
function foldChannelBoundaries(graph: GraphDocument, instanceId: NodeId, mask: ChannelMask | undefined): GraphDocument {
  const folded = structuredClone(graph) as GraphDocument;
  for (const boundaryId of Object.keys(folded.nodes).filter((id) => id.startsWith(`${instanceId}${BOUNDARY}`))) {
    if (mask === undefined) throw new Error(`${boundaryId} exists but ${instanceId} has no Processing Channels`);
    const processed = Object.values(folded.edges).find((edge) => edge.target.nodeId === boundaryId && edge.target.portId === "processed");
    if (processed === undefined) throw new Error(`${boundaryId} reads nothing`);
    const reader = folded.nodes[processed.source.nodeId] as GraphNode;
    folded.nodes[reader.id] = { ...reader, channelMask: mask };
    for (const [edgeId, edge] of Object.entries(folded.edges)) {
      if (edge.target.nodeId === boundaryId) delete folded.edges[edgeId];
      else if (edge.source.nodeId === boundaryId) folded.edges[edgeId] = { ...edge, source: { ...processed.source } };
    }
    delete folded.nodes[boundaryId];
  }
  return folded;
}

interface Normalized {
  readonly nodes: Record<string, unknown>;
  readonly edges: string[];
}

function normalize(graph: GraphDocument, mapId: (id: NodeId) => NodeId, skipParameters: ReadonlySet<NodeId>): Normalized {
  const work = structuredClone(graph) as GraphDocument;
  const mappedIds = Object.keys(work.nodes).map(mapId).sort();
  const token = (id: NodeId): string => `t1553n${mappedIds.indexOf(mapId(id))}`;
  const labelCount = new Map<string, number>();
  for (const node of Object.values(work.nodes)) {
    if (node.label !== undefined) labelCount.set(node.label, (labelCount.get(node.label) ?? 0) + 1);
  }
  for (const nodeId of Object.keys(work.nodes).sort()) {
    const node = work.nodes[nodeId] as GraphNode;
    // A duplicated root label (legacy documents) names no one node; it is left as written.
    if (node.label === undefined || labelCount.get(node.label) !== 1) continue;
    const next = token(nodeId);
    rewriteNodeNameReferences(work, node.label, next);
    (work.nodes[nodeId] as { label?: string }).label = next;
  }
  const nodes: Record<string, unknown> = {};
  for (const node of Object.values(work.nodes)) {
    const id = mapId(node.id);
    const { position: _position, ...rest } = node;
    void _position;
    const state = { ...node.state };
    delete state[PARENT_BINDINGS_STATE_KEY];
    const normalized: Record<string, unknown> = { ...rest, id };
    if (Object.keys(state).length === 0) delete normalized["state"];
    else normalized["state"] = state;
    if (skipParameters.has(node.id)) delete normalized["parameters"];
    nodes[id] = normalized;
  }
  const edges = Object.values(work.edges)
    .map((edge) => `${mapId(edge.source.nodeId)}.${edge.source.portId} -> ${mapId(edge.target.nodeId)}.${edge.target.portId}${edge.order === undefined ? "" : ` #${edge.order}`}`)
    .sort();
  return { nodes, edges };
}

interface Outcome {
  readonly warnings: readonly string[];
  readonly compared: boolean;
  /** Page banks detach rewrote (and the comparison therefore left out). */
  readonly pageBanks: number;
}

async function detachAndCompare(entry: CorpusEntry, instanceId: NodeId): Promise<Outcome> {
  const system = createComponentSystem(base);
  for (const definition of entry.definitions) system.components.register(definition);
  const components = system.components.view();
  const store = createGraphStore({ ids: createSequentialIdFactory("t1553"), now: () => "2026-10-04T00:00:00.000Z", initialGraph: entry.graph });
  const { bus } = createDomainBus({ store, registry: system.nodes });
  registerComponentCommands(bus, { components: system.components });

  const instance = entry.graph.nodes[instanceId] as GraphNode;
  const before = flattenComponents({ graph: entry.graph, registry: system.nodes, components });
  const result = await bus.execute("component.detach", { nodeId: instanceId }, ctx);
  expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  const warnings = result.diagnostics.filter((each: RuntimeDiagnostic) => each.severity !== "info").map((each) => each.code);
  if (warnings.length > 0) return { warnings, compared: false, pageBanks: 0 };

  const after = flattenComponents({ graph: store.view.getGraph(), registry: system.nodes, components });
  const copies = result.output.copies;
  expect(Object.keys(copies).length, `${entry.name}: detach of ${instanceId} copied nothing`).toBeGreaterThan(0);
  const prefix = `${instanceId}/`;
  const mapId = (id: NodeId): NodeId => {
    if (!id.startsWith(prefix)) return id;
    const rest = id.slice(prefix.length);
    const separator = rest.indexOf("/");
    const first = separator < 0 ? rest : rest.slice(0, separator);
    const copy = copies[first];
    return copy === undefined ? id : `${copy}${separator < 0 ? "" : rest.slice(separator)}`;
  };

  const pageBanks = new Set(result.diagnostics.filter((each) => each.code === "component.detach.pageBank").map((each) => each.nodeId as NodeId));
  const skipBefore = new Set(Object.keys(before.graph.nodes).filter((id) => pageBanks.has(mapId(id))));

  const left = normalize(foldChannelBoundaries(before.graph, instanceId, instance.channelMask), mapId, skipBefore);
  const right = normalize(after.graph, (id) => id, pageBanks);
  // The instance really was inlined on one side and really is gone on the other.
  expect(Object.keys(before.graph.nodes).some((id) => id.startsWith(prefix)), `${entry.name}: ${instanceId} did not flatten`).toBe(true);
  expect(store.view.getGraph().nodes[instanceId]).toBeUndefined();
  expect(Object.keys(right.nodes).sort(), `${entry.name} :: ${instanceId}: node sets`).toEqual(Object.keys(left.nodes).sort());
  for (const id of Object.keys(left.nodes).sort()) {
    expect(right.nodes[id], `${entry.name} :: ${instanceId}: node ${id}`).toEqual(left.nodes[id]);
  }
  expect(right.edges, `${entry.name} :: ${instanceId}: edges`).toEqual(left.edges);
  return { warnings: [], compared: true, pageBanks: pageBanks.size };
}

const corpus = [...shippedCorpus(), ...fixtureCorpus(), ...featureCorpus()];

describe("T1553b: detaching an instance yields the graph flattening compiles for it", () => {
  const cases = corpus.flatMap((entry) =>
    Object.keys(entry.graph.nodes)
      .sort()
      .filter((id) => isComponentInstance(entry.graph.nodes[id] as GraphNode))
      .map((instanceId) => ({ entry, instanceId })),
  );

  it("has instances to compare — the corpus derivation is not silently empty", () => {
    expect(corpus.filter((entry) => entry.name.endsWith(".loom.json")).length).toBeGreaterThan(20);
    expect(cases.length).toBeGreaterThan(40);
  });

  const inexact: Record<string, readonly string[]> = {};
  let skippedMuted = 0;
  let compared = 0;
  let pageBanks = 0;
  for (const { entry, instanceId } of cases) {
    it(`${entry.name} :: ${instanceId}`, async () => {
      const node = entry.graph.nodes[instanceId] as GraphNode;
      if (node.ui?.muted === true || node.ui?.bypassed === true) {
        skippedMuted += 1;
        return;
      }
      const outcome = await detachAndCompare(entry, instanceId);
      pageBanks += outcome.pageBanks;
      if (outcome.compared) compared += 1;
      else inexact[`${entry.name} :: ${instanceId}`] = [...new Set(outcome.warnings)].sort();
    });
  }

  it("compared every instance it did not name: the inexact list is exactly EXPECTED_INEXACT", () => {
    expect(inexact).toEqual(EXPECTED_INEXACT);
    // Nothing shipped is muted or bypassed today; if that changes, it is seen here.
    expect(skippedMuted).toBe(0);
    expect(compared).toBe(cases.length - Object.keys(EXPECTED_INEXACT).length);
    // The page-bank normalization is exercised, not dead code that could start hiding things.
    expect(pageBanks).toBeGreaterThan(0);
  });
});
