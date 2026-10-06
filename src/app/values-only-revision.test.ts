import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { bankOf } from "@domain/presets/bank-view.ts";
import { PRESETS_NODE_TYPE } from "@domain/presets/bank.ts";
import { CUE_LIST_NODE_TYPE } from "@domain/presets/cue-list.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ParameterSchema, ParameterSlot } from "@domain/types/parameters.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { HOST_SERVED_TYPES, RECALL_RECORD_KEYS, classifyRevision, hostServed } from "./classify-revision.ts";

/**
 * T1652b — WHAT A VALUES-ONLY REVISION IS, one test per kind of write.
 *
 * `classifyRevision` is the one definition every reader asks: the composition root does not
 * render for a revision it calls `values`, and the compile takes such a revision on the
 * values lane instead of compiling the document. So a wrong `values` is a picture, a
 * diagnostic or a pane that does not follow an edit — and each kind of write that must NOT
 * be one is a test here that names it.
 *
 * The documents of the first two groups come out of the real store through the real patch
 * command, so the structural sharing the function relies on is the store's own.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const actor = { actor: { kind: "human" as const, id: "tester" }, projectId: "p", capabilities: [] };

async function seeded() {
  const store = createGraphStore();
  const { bus } = createDomainBus({ store, registry });
  const apply = async (operations: GraphPatchOperation[]) => {
    const result = await bus.execute("graph.applyPatch", { baseRevision: store.view.getRevision(), operations, label: "edit" }, actor);
    expect(result.status, JSON.stringify(result.diagnostics).slice(0, 300)).toBe("applied");
    return result.output.createdIds;
  };
  const ids = await apply([
    { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 }, label: "solid_ground", parameters: { color: [0.1, 0.2, 0.3, 1] } },
    { op: "addNode", ref: "$level", type: "level", position: { x: 300, y: 0 }, label: "level_grade", parameters: { brightness: 1, opacity: 1 } },
    { op: "addNode", ref: "$blur", type: "blur", position: { x: 600, y: 0 }, label: "blur_soft", parameters: { size: 4, filter: "gaussian" } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 900, y: 0 }, label: "output_frame" },
    { op: "addNode", ref: "$slider", type: "slider", position: { x: 0, y: 300 }, label: "slider_gain", parameters: { caption: "Gain", channel: "gain", value: 0.5, min: 0, max: 2, step: 0, defaultValue: 0.5 } },
    { op: "addNode", ref: "$toggle", type: "toggle", position: { x: 0, y: 500 }, label: "toggle_arm", parameters: { caption: "Arm", channel: "arm", on: false, defaultOn: false } },
    { op: "addNode", ref: "$pad", type: "xyPad", position: { x: 0, y: 700 }, label: "xypad_aim", parameters: { caption: "Aim", channel: "aim", x: 0.5, y: 0.5, min: 0, max: 1, defaultX: 0.5, defaultY: 0.5 } },
    { op: "addNode", ref: "$text", type: "text", position: { x: 0, y: 900 }, label: "text_title", parameters: { text: "Loom", size: 96 } },
    { op: "addNode", ref: "$bank", type: PRESETS_NODE_TYPE, position: { x: 300, y: 300 }, label: "presets_looks" },
    { op: "connect", source: { nodeId: "$solid", portId: "out" }, target: { nodeId: "$level", portId: "input" } },
    { op: "connect", source: { nodeId: "$level", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
  ] as GraphPatchOperation[]);
  return {
    ids: ids as Record<string, NodeId>,
    graph: (): GraphDocument => store.view.getGraph(),
    /** The revision one patch makes, classified against the one before it. */
    async after(operations: GraphPatchOperation[]) {
      const previous = store.view.getGraph();
      await apply(operations);
      return classifyRevision(previous, store.view.getGraph(), registry);
    },
  };
}

describe("T1652b: a values-only revision — a static number, boolean or tuple moved, and nothing else", () => {
  it("a Slider's value: the owner's case", async () => {
    const { ids, after } = await seeded();
    expect(await after([{ op: "setParameters", nodeId: ids["$slider"] as NodeId, parameters: { value: 1.25 } }])).toEqual({
      kind: "values",
      written: [ids["$slider"]],
    });
  });

  it("a Toggle's state (a boolean) and an XY Pad's two numbers in one patch", async () => {
    const { ids, after } = await seeded();
    const kind = await after([
      { op: "setParameters", nodeId: ids["$toggle"] as NodeId, parameters: { on: true } },
      { op: "setParameters", nodeId: ids["$pad"] as NodeId, parameters: { x: 0.2, y: 0.9 } },
    ]);
    expect(kind).toEqual({ kind: "values", written: [ids["$toggle"], ids["$pad"]].sort() });
  });

  it("a colour (a tuple of numbers of the same length) and an ordinary knob", async () => {
    const { ids, after } = await seeded();
    expect((await after([{ op: "setParameters", nodeId: ids["$solid"] as NodeId, parameters: { color: [0.9, 0.2, 0.3, 1] } }])).kind).toBe("values");
    expect((await after([{ op: "setParameters", nodeId: ids["$level"] as NodeId, parameters: { brightness: 1.5 } }])).kind).toBe("values");
  });

  it("the static value retained under an expression: the mode and the expression are the same objects", async () => {
    const { ids, after } = await seeded();
    const level = ids["$level"] as NodeId;
    const expression = { kind: "expression" as const, source: "op('slider_gain').chan.gain" };
    await after([{ op: "setParameters", nodeId: level, parameters: { brightness: { mode: "expression", bindings: { expression, static: { kind: "static", value: 1 } } } } }]);
    // `setParameters` with a bare value over a slot moves the slot's retained static and keeps its mode.
    expect((await after([{ op: "setParameters", nodeId: level, parameters: { brightness: 1.75 } }])).kind).toBe("values");
  });

  it("a bank recording the recall it just made, beside the target's numbers: ONE values revision", async () => {
    const { ids, after } = await seeded();
    const kind = await after([
      { op: "setParameters", nodeId: ids["$level"] as NodeId, parameters: { brightness: 0.25, opacity: 0.5 } },
      { op: "setParameters", nodeId: ids["$solid"] as NodeId, parameters: { color: [1, 1, 1, 1] } },
      { op: "setParameters", nodeId: ids["$bank"] as NodeId, parameters: { current: "night" } },
    ]);
    expect(kind).toEqual({ kind: "values", written: [ids["$level"], ids["$solid"], ids["$bank"]].sort() });
  });

  it("names the keys a bank and a cue list write about themselves as the bank's own view names them", () => {
    const view = bankOf({ id: "b", type: PRESETS_NODE_TYPE, parameters: {} } as unknown as GraphNode, undefined);
    if (!view.ok) throw new Error("a presets node is a bank");
    expect(RECALL_RECORD_KEYS[PRESETS_NODE_TYPE]).toEqual([view.view.currentKey, view.view.morphsKey]);
    expect(RECALL_RECORD_KEYS[CUE_LIST_NODE_TYPE]).toEqual(["current", "standby"]);
  });
});

describe("T1652b: what is NOT values-only goes down the structural road, and says which rule sent it", () => {
  const structural = async (operations: (ids: Record<string, NodeId>) => GraphPatchOperation[], reason: RegExp) => {
    const { ids, after } = await seeded();
    const kind = await after(operations(ids));
    expect(kind.kind).toBe("structure");
    expect(kind.kind === "structure" ? kind.reason : "", JSON.stringify(kind)).toMatch(reason);
  };

  it("a MODE change", () =>
    structural(
      (ids) => [{ op: "setParameters", nodeId: ids["$level"] as NodeId, parameters: { brightness: { mode: "expression", bindings: { expression: { kind: "expression", source: "time" }, static: { kind: "static", value: 1 } } } } }],
      /went between a bare value and a slot|changed mode/,
    ));

  it("an EXPRESSION's source", async () => {
    const { ids, after } = await seeded();
    const level = ids["$level"] as NodeId;
    const slot = (source: string): ParameterSlot => ({ mode: "expression", bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: 1 } } });
    await after([{ op: "setParameters", nodeId: level, parameters: { brightness: slot("time") } }]);
    const kind = await after([{ op: "setParameters", nodeId: level, parameters: { brightness: slot("time * 2") } }]);
    expect(kind).toMatchObject({ kind: "structure", reason: expect.stringMatching(/changed its expression binding/) as unknown });
  });

  it("a WIRE", () =>
    structural((ids) => [{ op: "connect", source: { nodeId: ids["$level"] as NodeId, portId: "out" }, target: { nodeId: ids["$blur"] as NodeId, portId: "input" } }], /edges changed/));

  it("a NODE added", () => structural(() => [{ op: "addNode", ref: "$n", type: "solid", position: { x: 0, y: 1200 } }], /edges changed|added or removed/));

  it("a NAME", () => structural((ids) => [{ op: "setNodeLabel", nodeId: ids["$level"] as NodeId, label: "level_other" }], /changed its label/));

  it("a POSITION (a move is a revision, and it is not a value)", () =>
    structural((ids) => [{ op: "moveNodes", positions: { [ids["$level"] as NodeId]: { x: 10, y: 10 } } }], /changed its position/));

  it("a UI field", () => structural((ids) => [{ op: "setNodeUi", nodeId: ids["$level"] as NodeId, ui: { bypassed: true } }], /changed its ui/));

  it("a STRING: an enum", () =>
    structural((ids) => [{ op: "setParameters", nodeId: ids["$blur"] as NodeId, parameters: { filter: "box" } }], /"filter" holds something other than a number/));

  it("a STRING: a caption on the very control whose value is values-only", () =>
    structural((ids) => [{ op: "setParameters", nodeId: ids["$slider"] as NodeId, parameters: { caption: "Drive" } }], /"caption" holds something other than a number/));

  it("a control's stored DEFAULT: its schema follows it (parametersFor)", () =>
    structural((ids) => [{ op: "setParameters", nodeId: ids["$slider"] as NodeId, parameters: { defaultValue: 1.5 } }], /schema that follows the value written/));

  it("a node a HOST service reads: a Text's size is drawn by the page, not by the plan", () =>
    structural((ids) => [{ op: "setParameters", nodeId: ids["$text"] as NodeId, parameters: { size: 120 } }], /served by the host/));

  it("one structural write beside thirty values is a structural revision: the strongest wins", async () => {
    const { ids, after } = await seeded();
    const kind = await after([
      { op: "setParameters", nodeId: ids["$slider"] as NodeId, parameters: { value: 0.1 } },
      { op: "setParameters", nodeId: ids["$level"] as NodeId, parameters: { brightness: 0.2 } },
      { op: "setNodeUi", nodeId: ids["$blur"] as NodeId, ui: { bypassed: true } },
    ]);
    expect(kind.kind).toBe("structure");
  });

  it("no revision at all, and a revision that moved no node (a settings edit)", async () => {
    const { graph } = await seeded();
    const document = graph();
    expect(classifyRevision(document, document, registry)).toMatchObject({ kind: "structure" });
    expect(classifyRevision(document, { ...document, revision: document.revision + 1 }, registry)).toEqual({ kind: "structure", reason: "No node changed." });
  });
});

/**
 * The kinds that need a definition of a particular SHAPE. A registry of four hand-made
 * definitions, and two revisions built the way the store builds them (the untouched
 * nodes and bindings are the same objects).
 */
describe("T1652b: a value that changes structure INDIRECTLY is structural, by rule", () => {
  const number = (extra: Record<string, unknown> = {}) => ({ type: "number", label: "n", default: 0, ...extra });
  const definition = (type: string, parameters: Record<string, unknown>, extra: Partial<NodeDefinition> = {}): NodeDefinition =>
    ({ type, version: 1, title: type, category: "filter", inputs: [], outputs: [], parameters: parameters as unknown as ParameterSchema, compile: () => ({ passes: [] }), ...extra }) as unknown as NodeDefinition;

  const definitions: Record<string, NodeDefinition> = {
    plain: definition("plain", { amount: number(), count: number({ compileTime: true }) }),
    sized: definition("sized", { width: number(), height: number(), gain: number() }, { resolutionPolicy: { kind: "parameter", width: "width", height: "height" } as never }),
    // `detail` only applies while `amount` is above a half: the threshold another parameter reads.
    gated: definition("gated", {
      amount: number(),
      detail: number({ inactiveWhen: (values: Readonly<Record<string, unknown>>) => ((values["amount"] as number) > 0.5 ? null : "Amount is at or below a half.") }),
    }),
    // One more parameter appears while `rows` is above one: the schema follows a value.
    grown: definition("grown", { rows: number() }, { parametersFor: (stored) => ((stored["rows"] as number) > 1 ? ({ rows: number(), second: number() } as unknown as ParameterSchema) : ({ rows: number() } as unknown as ParameterSchema)) }),
    // The schema is built per call, equal each time: that is the same schema.
    rebuilt: definition("rebuilt", { amount: number() }, { parametersFor: () => ({ amount: number() }) as unknown as ParameterSchema }),
    chooses: definition("chooses", { amount: number() }, { requires: () => [] }),
    "component:looks@1": definition("component:looks@1", { amount: number() }),
  };
  const view = { get: (type: string) => definitions[type] } as unknown as NodeRegistryView;

  const revisions = (type: string, before: Record<string, unknown>, after: Record<string, unknown>) => {
    const other: GraphNode = { id: "other" as NodeId, type: "plain", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { amount: 0, count: 1 } };
    const node: GraphNode = { id: "n" as NodeId, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: before } as GraphNode;
    const previous: GraphDocument = { revision: 1, nodes: { n: node, other }, edges: {}, groups: {} };
    const next: GraphDocument = { ...previous, revision: 2, nodes: { ...previous.nodes, n: { ...node, parameters: { ...before, ...after } } as GraphNode } };
    return classifyRevision(previous, next, view);
  };

  it("an ordinary number on these hand-made definitions is values-only (the control for every case below)", () => {
    expect(revisions("plain", { amount: 0, count: 1 }, { amount: 0.4 })).toEqual({ kind: "values", written: ["n"] });
    expect(revisions("sized", { width: 64, height: 64, gain: 1 }, { gain: 2 }).kind).toBe("values");
    expect(revisions("gated", { amount: 0.6, detail: 0 }, { amount: 0.9 }).kind).toBe("values");
    expect(revisions("grown", { rows: 3 }, { rows: 4 }).kind).toBe("values");
    expect(revisions("rebuilt", { amount: 0 }, { amount: 1 }).kind).toBe("values");
  });

  it("a parameter stored for the FIRST time, or no longer stored (the key set moved)", () => {
    expect(revisions("plain", { count: 1 }, { amount: 0.4 })).toMatchObject({ kind: "structure", reason: expect.stringMatching(/stores a different set of parameters/) as unknown });
  });

  it("a key the definition declares compileTime", () => {
    expect(revisions("plain", { amount: 0, count: 1 }, { count: 2 })).toMatchObject({ kind: "structure", reason: expect.stringMatching(/"count" is structural/) as unknown });
  });

  it("a key a parameter resolution policy reads for the node's size", () => {
    expect(revisions("sized", { width: 64, height: 64, gain: 1 }, { width: 128 })).toMatchObject({ kind: "structure", reason: expect.stringMatching(/"width" is structural/) as unknown });
  });

  it("a number that crosses the threshold another parameter's inactiveWhen reads", () => {
    expect(revisions("gated", { amount: 0.6, detail: 0 }, { amount: 0.4 })).toMatchObject({ kind: "structure", reason: expect.stringMatching(/which of its parameters apply/) as unknown });
  });

  it("a number the node's own schema follows (parametersFor)", () => {
    expect(revisions("grown", { rows: 1 }, { rows: 2 })).toMatchObject({ kind: "structure", reason: expect.stringMatching(/schema that follows the value written/) as unknown });
  });

  it("any value of a node whose runtime requirements are chosen by a value", () => {
    expect(revisions("chooses", { amount: 0 }, { amount: 1 })).toMatchObject({ kind: "structure", reason: expect.stringMatching(/runtime requirements/) as unknown });
  });

  it("any value of a component instance, and of a type this build does not have", () => {
    expect(revisions("component:looks@1", { amount: 0 }, { amount: 1 })).toMatchObject({ kind: "structure", reason: expect.stringMatching(/component instance/) as unknown });
    expect(revisions("gone", { amount: 0 }, { amount: 1 })).toMatchObject({ kind: "structure", reason: expect.stringMatching(/does not have/) as unknown });
  });

  it("a map, a bind and a driven channel: any binding but the static one", () => {
    const slot = (bindings: Record<string, unknown>, mode = "static") => ({ mode, bindings: { static: { kind: "static", value: 0 }, ...bindings } });
    const map = { kind: "map", attribute: "age" };
    expect(revisions("plain", { amount: slot({ map }, "map"), count: 1 }, { amount: slot({ map: { kind: "map", attribute: "size" } }, "map") })).toMatchObject({
      kind: "structure",
      reason: expect.stringMatching(/changed its map binding/) as unknown,
    });
    expect(revisions("plain", { amount: slot({ bind: { kind: "bind", ref: "count" } }, "bind"), count: 1 }, { amount: slot({ bind: { kind: "bind", ref: "other" } }, "bind") }).kind).toBe("structure");
    // The same slot with only its static value moved is values-only: the map is the same object.
    expect(revisions("plain", { amount: slot({ map }, "map"), count: 1 }, { amount: { mode: "map", bindings: { static: { kind: "static", value: 3 }, map } } }).kind).toBe("values");
  });

  it("a MODE change alone: the same bindings, the same objects, another mode", () => {
    // What a mode switch in the inspector writes when the expression was already retained
    // under a Constant: nothing but `mode` differs, so no other rule can catch it.
    const bindings = { static: { kind: "static", value: 0.5 }, expression: { kind: "expression", source: "time" } };
    expect(revisions("plain", { amount: { mode: "static", bindings }, count: 1 }, { amount: { mode: "expression", bindings } })).toMatchObject({
      kind: "structure",
      reason: expect.stringMatching(/changed mode \(static to expression\)/) as unknown,
    });
  });

  it("a structured value (a ramp's stops), a null, a value that changes shape", () => {
    expect(revisions("plain", { amount: [{ position: 0 }], count: 1 }, { amount: [{ position: 1 }] }).kind).toBe("structure");
    expect(revisions("plain", { amount: 0, count: 1 }, { amount: null }).kind).toBe("structure");
    expect(revisions("plain", { amount: [0, 0, 0], count: 1 }, { amount: [0, 0, 0, 1] }).kind).toBe("structure");
    expect(revisions("plain", { amount: 0, count: 1 }, { amount: true }).kind).toBe("structure");
  });
});

/**
 * THE HOST-SERVED NAMES, held against the host services' own sources.
 *
 * A node type a host service keys on must be `hostServed`, or a value written on it would
 * skip the render that service hears a change by. Most are caught by a declaration (the
 * `input` and `output` shelves, a side effect, a requirement). The rest are NAMED in
 * `HOST_SERVED_TYPES`, and a name can be forgotten — so this reads the services' sources
 * for every registered node type they COMPARE A NODE'S TYPE WITH (`.type === "text"`: how
 * each of them picks the nodes it serves) and requires each to be host-served.
 */
describe("T1652b: every node type a host service names is host-served", () => {
  const HOST_SERVICES = [
    "use-media-sources.ts",
    "use-audio-input.ts",
    "use-mesh-sources.ts",
    "use-model-inference.ts",
    "use-native-inputs.ts",
    "use-native-outputs.ts",
    "use-screen-sources.ts",
    "use-vision-bridge.ts",
    "use-osc-bridge.ts",
    "camera-request.ts",
    "media-playback.ts",
    "inference-parameters.ts",
    "use-analyze-channels.ts",
  ];
  const types = new Map(allNodeDefinitions.map((definition) => [definition.type, definition]));

  it("derives a real list (the sources name node types, and the named set is used)", () => {
    const named = new Set<string>();
    for (const file of HOST_SERVICES) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      for (const match of source.matchAll(/\.type\s*[!=]==\s*["'`]([A-Za-z][A-Za-z0-9]*)["'`]/g)) {
        if (types.has(match[1] as string)) named.add(match[1] as string);
      }
    }
    expect([...named].sort()).toEqual(expect.arrayContaining(["audioFileIn", "movieFileIn", "text", "webcam"]));
    const unserved = [...named].filter((type) => hostServed(types.get(type) as NodeDefinition) === null).sort();
    expect(unserved, "a host service names these node types, and a value written on one would not reach it").toEqual([]);
    // And every hand-kept name is a real node type, so the set cannot rot into a list of nothing.
    for (const type of HOST_SERVED_TYPES) expect(types.has(type), type).toBe(true);
  });

  it("does not call a control or an ordinary filter host-served: those are the writes the lane exists for", () => {
    for (const type of ["slider", "toggle", "button", "xyPad", "level", "blur", "light", "camera", "pointKernel", "customWgsl"]) {
      expect(hostServed(types.get(type) as NodeDefinition), type).toBeNull();
    }
  });
});
