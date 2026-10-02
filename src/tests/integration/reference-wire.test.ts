import { beforeEach, describe, expect, it } from "vitest";
import { compileGraph } from "@compiler/index.ts";
import type { ActiveSink } from "@compiler/index.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { documentLiveness } from "@domain/graph/liveness.ts";
import { parameterDependencies } from "@domain/graph/parameter-dependencies.ts";
import { SOURCE_REFERENCE_PARAMETERS } from "@domain/graph/source-references.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { DEFAULT_PROJECT_SETTINGS } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * B233 — a Layer's picture and a Window Out's input take a WIRE as well as a NAME.
 *
 * ## The bug
 *
 * The owner ruled both "by wire OR by name" (ruling 11, §T1391b), and both were declared
 * source-reference inputs, which `connect` refused outright (`port.sourceReference`) and
 * the canvas drew no socket for. So the wire half of the ruling existed only in documents
 * written by hand: they compiled headless, and the app could neither make nor draw them.
 *
 * ## The rule, and what holds it
 *
 * An input declared `wire: true` accepts a wire. WHEN BOTH A WIRE AND A NAME ARE PRESENT
 * THE WIRE WINS and the name is DORMANT: it stays in the parameter, it resolves to no
 * edge, it is no dependency, and disconnecting the wire returns the input to it. Every
 * other reference input keeps refusing wires (§V285: a Feedback's loop is a name so
 * `edges` stays a DAG; §V372: scene assembly flows by name).
 *
 * "Dormant" is asserted on what each reader of a name reports, because the failure this
 * rule invites is the §V109 shape — the compiler ignoring a name the dependency walk
 * still follows, so a look nothing shows keeps cooking, or keeps its dashed line.
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const WIRING_CODES = new Set([
  "compiler/input-missing",
  "compiler/source-reference-missing",
  "compiler/source-reference-ambiguous",
]);

const actor = { kind: "human", id: "tester" } as const;
const context: InvocationContext = { actor, projectId: "project-1", capabilities: [] };

let bus: LoomBus;
let registry: NodeRegistryView;

beforeEach(() => {
  registry = createNodeRegistry(allNodeDefinitions).view();
  bus = createDomainBus({ registry }).bus;
});

async function apply(operations: GraphPatchOperation[]) {
  return bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations }, context);
}

interface Stack {
  readonly base: string;
  readonly city: string;
  readonly citySrc: string;
  readonly smoke: string;
  readonly smokeSrc: string;
  readonly layer: string;
  readonly out: string;
}

/**
 * base → layer.below → out, and two looks (`city`, `smoke`), each a solid through a Flip
 * so a look is a CHAIN with a pass per node. Both looks are always in the document, so
 * "which one cooks" is a claim about the plan and never about what exists.
 */
async function stack(picture = ""): Promise<Stack> {
  const built = await apply([
    { op: "addNode", ref: "$base", type: "solid", position: { x: 0, y: 0 }, label: "base" },
    { op: "addNode", ref: "$citySrc", type: "solid", position: { x: 0, y: 200 } },
    { op: "addNode", ref: "$city", type: "flip", position: { x: 200, y: 200 }, label: "city" },
    { op: "addNode", ref: "$smokeSrc", type: "solid", position: { x: 0, y: 400 } },
    { op: "addNode", ref: "$smoke", type: "flip", position: { x: 200, y: 400 }, label: "smoke" },
    { op: "addNode", ref: "$layer", type: "layer", position: { x: 400, y: 0 }, parameters: { picture } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 600, y: 0 } },
    { op: "connect", source: { nodeId: "$citySrc", portId: "out" }, target: { nodeId: "$city", portId: "input" } },
    { op: "connect", source: { nodeId: "$smokeSrc", portId: "out" }, target: { nodeId: "$smoke", portId: "input" } },
    { op: "connect", source: { nodeId: "$base", portId: "out" }, target: { nodeId: "$layer", portId: "below" } },
    { op: "connect", source: { nodeId: "$layer", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
  ]);
  expect(built.status).toBe("applied");
  const id = (ref: string) => built.output.createdIds[ref] as string;
  return {
    base: id("$base"),
    city: id("$city"),
    citySrc: id("$citySrc"),
    smoke: id("$smoke"),
    smokeSrc: id("$smokeSrc"),
    layer: id("$layer"),
    out: id("$out"),
  };
}

const compile = (sinks?: ActiveSink[]) =>
  compileGraph({
    graph: bus.store.getGraph(),
    registry,
    settings: DEFAULT_PROJECT_SETTINGS,
    capabilities: CAPABILITIES,
    ...(sinks === undefined ? {} : { sinks }),
  });

/** Every node that owns at least one pass in the plan. */
const cooked = (plan: ReturnType<typeof compile>): Set<string> =>
  new Set(plan.passes.flatMap((pass) => ("nodeId" in pass && typeof pass.nodeId === "string" ? [pass.nodeId] : [])));

const errors = (plan: ReturnType<typeof compile>) => plan.diagnostics.filter((entry) => entry.severity === "error");

const edgeInto = (nodeId: string, portId: string) =>
  Object.values(bus.store.getGraph().edges).find(
    (edge) => edge.target.nodeId === nodeId && edge.target.portId === portId,
  );

describe("B233 — a wire into a Layer's picture, through the bus", () => {
  it("`connect` applies, the wired look cooks, and a bypassed layer still prunes it", async () => {
    const ids = await stack();
    const connected = await apply([
      { op: "connect", source: { nodeId: ids.city, portId: "out" }, target: { nodeId: ids.layer, portId: "picture" } },
    ]);
    expect(connected.diagnostics).toEqual([]);
    expect(connected.status).toBe("applied");
    expect(edgeInto(ids.layer, "picture")?.source.nodeId).toBe(ids.city);

    const on = compile();
    expect(errors(on)).toEqual([]);
    for (const nodeId of [ids.citySrc, ids.city, ids.layer]) expect(cooked(on).has(nodeId), nodeId).toBe(true);
    expect(cooked(on).has(ids.smoke)).toBe(false);

    // Off is bypass, and bypass costs nothing — by wire exactly as by name (T1498b).
    expect((await apply([{ op: "setNodeUi", nodeId: ids.layer, ui: { bypassed: true } }])).status).toBe("applied");
    const off = compile();
    expect(errors(off)).toEqual([]);
    for (const nodeId of [ids.citySrc, ids.city, ids.layer]) expect(cooked(off).has(nodeId), nodeId).toBe(false);
    expect(cooked(off).has(ids.base)).toBe(true);
  });

  it("a wire AND a name: the wire wins, the name is dormant everywhere, and disconnecting returns to it", async () => {
    const ids = await stack("smoke");

    // Premise: by name alone, the NAMED look is the one in the plan and on the canvas.
    const named = compile();
    expect(errors(named)).toEqual([]);
    expect(cooked(named).has(ids.smoke)).toBe(true);
    expect(cooked(named).has(ids.city)).toBe(false);
    expect(parameterDependencies(bus.store.getGraph()).get(ids.layer)?.map((entry) => entry.to)).toEqual([ids.smoke]);

    const connected = await apply([
      { op: "connect", ref: "$wire", source: { nodeId: ids.city, portId: "out" }, target: { nodeId: ids.layer, portId: "picture" } },
    ]);
    expect(connected.status).toBe("applied");
    const wire = connected.output.createdIds["$wire"] as string;
    // The name is NOT rewritten by the connect: it is what the input returns to.
    expect(bus.store.getGraph().nodes[ids.layer]?.parameters["picture"]).toBe("smoke");

    const both = compile();
    // No "one link, one truth" refusal: on a wire-taking input both is a stated state.
    expect(errors(both)).toEqual([]);
    for (const nodeId of [ids.citySrc, ids.city, ids.layer]) expect(cooked(both).has(nodeId), nodeId).toBe(true);
    // DORMANT, in the plan: the named look has no pass. A name that still cooked would be
    // a look the performer cannot see costing a frame's worth of GPU.
    for (const nodeId of [ids.smokeSrc, ids.smoke]) expect(cooked(both).has(nodeId), nodeId).toBe(false);
    // DORMANT, on the canvas: no dashed line to a node the layer does not show (§V154's
    // walk and the picture must agree).
    expect(parameterDependencies(bus.store.getGraph()).get(ids.layer)).toBeUndefined();
    // DORMANT, for liveness: nothing reaches the named look any more.
    const liveness = documentLiveness(bus.store.getGraph(), registry);
    expect(liveness.dead).toEqual([ids.smokeSrc, ids.smoke].sort());
    // And the bus's own validator answers as the compiler does (§V109).
    const validated = await bus.execute("project.validate", {}, context);
    expect(validated.output.diagnostics.filter((entry) => WIRING_CODES.has(entry.code))).toEqual([]);

    // Disconnect: the name was never lost, so the input is the named look again.
    expect((await apply([{ op: "disconnect", edgeIds: [wire] }])).status).toBe("applied");
    const back = compile();
    expect(errors(back)).toEqual([]);
    for (const nodeId of [ids.smokeSrc, ids.smoke, ids.layer]) expect(cooked(back).has(nodeId), nodeId).toBe(true);
    for (const nodeId of [ids.citySrc, ids.city]) expect(cooked(back).has(nodeId), nodeId).toBe(false);
    expect(parameterDependencies(bus.store.getGraph()).get(ids.layer)?.map((entry) => entry.to)).toEqual([ids.smoke]);
  });

  it("a dormant name that matches no node is not an error while the wire is there", async () => {
    // The legitimate case a "names must resolve" check would swallow: the performer wires
    // a look over a name whose node they have since deleted. The wire is the picture.
    const ids = await stack("ghost");
    expect(errors(compile()).map((entry) => entry.code)).toContain("compiler/source-reference-missing");
    await apply([
      { op: "connect", source: { nodeId: ids.city, portId: "out" }, target: { nodeId: ids.layer, portId: "picture" } },
    ]);
    expect(errors(compile())).toEqual([]);
  });
});

describe("B233 — a wire into a Window Out's input, through the bus", () => {
  /** The two looks and a Window Out, and nothing else — so only the window reaches a look. */
  async function windowed(source = "") {
    const built = await apply([
      { op: "addNode", ref: "$citySrc", type: "solid", position: { x: 0, y: 200 } },
      { op: "addNode", ref: "$city", type: "flip", position: { x: 200, y: 200 }, label: "city" },
      { op: "addNode", ref: "$smokeSrc", type: "solid", position: { x: 0, y: 400 } },
      { op: "addNode", ref: "$smoke", type: "flip", position: { x: 200, y: 400 }, label: "smoke" },
      { op: "addNode", ref: "$win", type: "window", position: { x: 600, y: 300 }, parameters: { source } },
      { op: "connect", source: { nodeId: "$citySrc", portId: "out" }, target: { nodeId: "$city", portId: "input" } },
      { op: "connect", source: { nodeId: "$smokeSrc", portId: "out" }, target: { nodeId: "$smoke", portId: "input" } },
    ]);
    expect(built.status).toBe("applied");
    const id = (ref: string) => built.output.createdIds[ref] as string;
    const ids = { city: id("$city"), citySrc: id("$citySrc"), smoke: id("$smoke"), smokeSrc: id("$smokeSrc") };
    const win = id("$win");
    // The app names a Window Out as a sink only while its window is open (§T1391b).
    return { ids, win, open: [{ nodeId: win, kind: "output" }] satisfies ActiveSink[] };
  }

  it("`connect` applies and the open window shows the wired node", async () => {
    const { ids, win, open } = await windowed();
    const connected = await apply([
      { op: "connect", source: { nodeId: ids.city, portId: "out" }, target: { nodeId: win, portId: "input" } },
    ]);
    expect(connected.diagnostics).toEqual([]);
    expect(connected.status).toBe("applied");

    const shown = compile(open);
    expect(errors(shown)).toEqual([]);
    for (const nodeId of [ids.citySrc, ids.city, win]) expect(cooked(shown).has(nodeId), nodeId).toBe(true);
  });

  it("a wire AND a Source name: the wire wins, and disconnecting returns to the name", async () => {
    const { ids, win, open } = await windowed("smoke");
    expect(cooked(compile(open)).has(ids.smoke)).toBe(true);

    const connected = await apply([
      { op: "connect", ref: "$wire", source: { nodeId: ids.city, portId: "out" }, target: { nodeId: win, portId: "input" } },
    ]);
    expect(connected.status).toBe("applied");
    const both = compile(open);
    expect(errors(both)).toEqual([]);
    expect(cooked(both).has(ids.city)).toBe(true);
    expect(cooked(both).has(ids.smoke)).toBe(false);
    expect(parameterDependencies(bus.store.getGraph()).get(win)).toBeUndefined();

    await apply([{ op: "disconnect", edgeIds: [connected.output.createdIds["$wire"] as string] }]);
    const back = compile(open);
    expect(errors(back)).toEqual([]);
    expect(cooked(back).has(ids.smoke)).toBe(true);
    expect(cooked(back).has(ids.city)).toBe(false);
  });
});

describe("B233 — every OTHER reference input still refuses a wire (§V285, §V372)", () => {
  it("names exactly the two inputs that take one", () => {
    // The opt-in is the whole blast radius. A third entry here is a decision about a
    // loop or a scene's assembly, and it has to be made on purpose.
    const wired = Object.entries(SOURCE_REFERENCE_PARAMETERS).flatMap(([type, specs]) =>
      specs.filter((spec) => spec.wire === true).map((spec) => `${type}.${spec.input}`),
    );
    expect(wired.sort()).toEqual(["layer.picture", "window.input"]);
  });

  it("`connect` into each of them is refused by name, and the document is untouched", async () => {
    const refused = Object.entries(SOURCE_REFERENCE_PARAMETERS).flatMap(([type, specs]) =>
      specs.filter((spec) => spec.wire !== true).map((spec) => ({ type, input: spec.input })),
    );
    // Non-vacuity: Feedback's loop and the Render's camera are in the set under test.
    expect(refused.map((entry) => `${entry.type}.${entry.input}`)).toEqual(
      expect.arrayContaining(["feedback.in", "render.camera", "geometry.material"]),
    );
    for (const { type, input } of refused) {
      const built = await apply([
        { op: "addNode", ref: "$src", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$subject", type, position: { x: 300, y: 0 } },
      ]);
      expect(built.status, type).toBe("applied");
      const edges = Object.keys(bus.store.getGraph().edges).length;
      const result = await apply([
        {
          op: "connect",
          source: { nodeId: built.output.createdIds["$src"] as string, portId: "out" },
          target: { nodeId: built.output.createdIds["$subject"] as string, portId: input },
        },
      ]);
      expect(result.status, `${type}.${input}`).toBe("rejected");
      expect(result.diagnostics.map((entry) => entry.code), `${type}.${input}`).toContain("port.sourceReference");
      expect(Object.keys(bus.store.getGraph().edges).length).toBe(edges);
    }
  });
});
