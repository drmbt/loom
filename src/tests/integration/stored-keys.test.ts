import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/types.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { componentNodeType, createComponentSystem } from "../../domain/components/index.ts";
import { diagnosticClass } from "../../domain/diagnostics/classes.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { presetBankNode, presetSession } from "../../domain/presets/test-support.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { HAZE, HAZE_SHADER, LAMP, NEVER_EFFECTIVE_REGISTRY, hazeFile, lampFile, openedFile } from "../fixtures/never-effective.ts";

/**
 * §T1641b slice 2 — ONE ANSWER TO "DOES THIS NODE DECLARE THIS STORED KEY", AT THE WRITE AND
 * AT REST.
 *
 * The bus has always refused a key the node does not declare (`parameter.unknown`, an
 * error, with the keys it knows). A document built by code never meets the bus, and the
 * compile said the same thing under another code (`compiler/parameter-unknown`), at another
 * severity (a warning), in other words, and without the keys: §B264's light stayed red for a
 * day behind it. There is one function now (`undeclaredParameter` in
 * `domain/parameters/validate.ts`): the bus refuses the write with it, and the compile
 * reports what is already stored with it, as an error that leaves the plan usable.
 *
 * The pixels are in `../headless/never-effective.gpu.test.ts`. This file is both doors'
 * half, and the cases the rule could swallow: a look instance's own preset state, a node a
 * newer build saved, a part of a vector, and a key a shader edit left behind, which is
 * reported, never dropped, and removed by a command that undo takes back.
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const RED: StoredParameter = [1, 0, 0, 1];
const held = (value: number, retained: number): StoredParameter => expressionSlot(`${value} + abstime * 0`, retained);
/** §B264's three slots. */
const WRITTEN_XYZ = { eyeColor: RED, "eyeColor.x": held(0, 1), "eyeColor.y": held(1, 0), "eyeColor.z": held(0, 0) };

/** The rule nothing in the WGSL shows, as `params-reflection.ts` states it. */
const RULE =
  "Its parameters are the fields of the struct Params its code declares: a vec3f or vec4f whose name contains colour, color, tint, rgb, albedo or emissi is a colour, with parts r, g, b, a; any other vector has parts x, y, z, w.";

function compiledFile(text: string): CompiledGraph {
  const { graph, settings } = openedFile(text);
  return compileGraph({ graph, settings, registry: NEVER_EFFECTIVE_REGISTRY, capabilities: CAPABILITIES });
}

const about = (plan: CompiledGraph, nodeId: string): readonly RuntimeDiagnostic[] => plan.diagnostics.filter((entry) => entry.nodeId === nodeId);
const verdicts = (found: readonly RuntimeDiagnostic[]) => found.map((entry) => [entry.severity, entry.code, diagnosticClass(entry.code)]);

/** A bus over a document, as a session holds one: every write below goes through it. */
function session(initial?: GraphDocument) {
  const store = createGraphStore({
    ids: createSequentialIdFactory("k"),
    now: () => "2026-10-06T00:00:00.000Z",
    ...(initial === undefined ? {} : { initialGraph: initial }),
  });
  const { bus } = createDomainBus({ store, registry: NEVER_EFFECTIVE_REGISTRY });
  const context = { actor: { kind: "agent" as const, id: "t1641b" }, projectId: "p", capabilities: [] };
  return {
    bus,
    context,
    graph: () => store.view.getGraph(),
    patch: (operations: GraphPatchOperation[]) =>
      bus.execute("graph.applyPatch", { baseRevision: store.view.getRevision(), operations }, context),
    compiled: () =>
      compileGraph({ graph: store.view.getGraph(), settings: openedFile(lampFile(1)).settings, registry: NEVER_EFFECTIVE_REGISTRY, capabilities: CAPABILITIES }),
  };
}

describe("§B264 — a slot under a key the node does not declare, at rest and at the write", () => {
  it("at rest: an error on the node for each key, with the parts a colour has, the one that was meant and the rule; the plan is whole", () => {
    const sound = compiledFile(hazeFile({ eyeColor: RED }));
    const broken = compiledFile(hazeFile(WRITTEN_XYZ));
    const found = about(broken, HAZE);
    expect(verdicts(found)).toEqual([
      ["error", "parameter.unknown", "never"],
      ["error", "parameter.unknown", "never"],
      ["error", "parameter.unknown", "never"],
    ]);
    expect(found[0]?.message).toBe(
      `Node "${HAZE}" stores a value under "eyeColor.x", which nothing reads: "eyeColor" is a colour, and its parts are r, g, b, a.`,
    );
    expect(found[0]?.suggestion).toBe(`Write "eyeColor.r". ${RULE} Or remove the stored value: parameter.removeUndeclared (in a patch: removeParameters).`);
    expect(found[1]?.suggestion).toContain('Write "eyeColor.g".');
    expect(found[2]?.suggestion).toContain('Write "eyeColor.b".');
    // `local`: every pass the sound document has, and the colour as stored.
    expect(broken.ok).toBe(true);
    expect(broken.passes.map((pass) => pass.id)).toEqual(sound.passes.map((pass) => pass.id));
  });

  it("at the write: the bus refuses the same key with the same finding", async () => {
    const live = session();
    await live.patch([{ op: "addNode", ref: "haze", type: "customWgsl", position: { x: 0, y: 0 }, label: HAZE, parameters: { source: HAZE_SHADER } }]);
    const refused = await live.patch([{ op: "setParameters", nodeId: "haze", parameters: { "eyeColor.x": held(0, 1) } }]);
    expect(refused.status).toBe("rejected");
    const [finding] = refused.diagnostics ?? [];
    expect([finding?.severity, finding?.code]).toEqual(["error", "parameter.unknown"]);
    expect(finding?.message).toBe('Unknown parameter "eyeColor.x": "eyeColor" is a colour, and its parts are r, g, b, a.');
    // One function: what to write instead is word for word what the compile says of it.
    expect(finding?.suggestion).toBe(`Write "eyeColor.r". ${RULE}`);
    expect(live.graph().nodes["haze"]?.parameters["eyeColor.x"]).toBeUndefined();
  });

  it("names the nearest declared key, and every declared key with the parts it has", () => {
    const misspelt = about(compiledFile(lampFile(0.5, [], { gamma: 2 })), LAMP);
    expect(verdicts(misspelt)).toEqual([["error", "parameter.unknown", "never"]]);
    expect(misspelt[0]?.message).toBe(`Node "${LAMP}" stores a value under "gamma", which "level" does not declare: nothing reads it.`);
    expect(misspelt[0]?.suggestion).toBe(
      'Nearest: "gamma1". Declared: blacklevel, brightness, contrast, gamma1, invert, opacity, whitelevel. Or remove the stored value: parameter.removeUndeclared (in a patch: removeParameters).',
    );
    const [colour] = about(compiledFile(hazeFile({ eyeColr: RED })), HAZE);
    expect(colour?.suggestion).toContain('Nearest: "eyeColor".');
    expect(colour?.suggestion).toContain("eyeColor (.r .g .b .a), eyesAt (.x .y .z)");
  });
});

describe("what the rule must leave alone", () => {
  it("the parts a compound has: r, g, b of a colour and x, y, z of a vector are declared keys", () => {
    const plan = compiledFile(hazeFile({ eyeColor: RED, "eyeColor.g": held(1, 0), "eyesAt.x": held(0.5, 0) }));
    expect(about(plan, HAZE)).toEqual([]);
  });

  it("a look instance's own preset state: a recall on an instance leaves nothing the compile calls undeclared", async () => {
    // A definition with a page bank gives each instance `presetCurrent` and `presetMorphs`
    // (its manifest declares them, and the write gate accepts them). Flattening read the
    // instance against its PUBLISHED parameters only, so every compile after a recall said
    // the instance carried two keys its type does not declare. One stored key, two schemas,
    // two answers: the rule's own case in small, and an error under it.
    const node = (id: string, type: string, label: string, parameters: Record<string, StoredParameter>): GraphNode => ({
      id,
      type,
      label,
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters,
    });
    const look = {
      componentId: "page",
      version: 1,
      name: "Page",
      graph: {
        revision: 1,
        groups: {},
        nodes: {
          src: node("src", "solid", "src", { color: [1, 1, 1, 1] }),
          grade: node("grade", "level", "grade", { brightness: 1 }),
          looks: presetBankNode("looks", "looks", "parent", [{ name: "up", values: { parent: { bright: 0.8 } } }]),
        },
        edges: { e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "grade", portId: "input" } } },
      },
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
      parameters: [
        { key: "bright", definition: { type: "number", label: "Bright", default: 1, min: 0, max: 8, range: "floor" }, targets: [{ nodeId: "grade", key: "brightness" }] },
      ],
    } as unknown as GraphComponentDefinition;
    const system = createComponentSystem(NEVER_EFFECTIVE_REGISTRY, [look]);
    const document: GraphDocument = {
      revision: 1,
      groups: {},
      nodes: {
        a: node("a", componentNodeType("page", 1), "page_city", { bright: 0.2 }),
        out: node("out", "output", "output_out", {}),
      },
      edges: { e1: { id: "e1", source: { nodeId: "a", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
    };
    const recalling = presetSession(document, system.nodes, system.components);
    await recalling.recall("a", "up");
    const after = recalling.graph();
    // The recall wrote the instance's own state beside the value.
    expect(after.nodes["a"]?.parameters).toMatchObject({ bright: 0.8, presetCurrent: "up" });

    const plan = compileGraph({
      graph: after,
      settings: openedFile(lampFile(1)).settings,
      registry: system.nodes,
      capabilities: CAPABILITIES,
      components: system.components.view(),
    });
    expect(plan.diagnostics.filter((entry) => entry.severity !== "info")).toEqual([]);
    expect(plan.ok).toBe(true);

    // And it is still a real check: a key the instance's manifest does NOT declare is said.
    const typo = { ...after, nodes: { ...after.nodes, a: { ...after.nodes["a"]!, parameters: { ...after.nodes["a"]!.parameters, brigt: 1 } } } };
    const said = compileGraph({ graph: typo, settings: openedFile(lampFile(1)).settings, registry: system.nodes, capabilities: CAPABILITIES, components: system.components.view() });
    expect(verdicts(said.diagnostics.filter((entry) => entry.severity === "error"))).toEqual([["error", "parameter.unknown", "never"]]);
    expect(said.diagnostics.find((entry) => entry.code === "parameter.unknown")?.suggestion).toContain('Nearest: "bright".');
  });

  it("a node saved against ANOTHER version of its definition: a key this build does not know is that version's, not a key of nothing", () => {
    const { graph, settings } = openedFile(lampFile(0.5, [], { futureKnob: 2 }));
    const lamp = graph.nodes[LAMP]!;
    const compileWith = (definitionVersion: number) =>
      compileGraph({
        graph: { ...graph, nodes: { ...graph.nodes, [LAMP]: { ...lamp, definitionVersion } } },
        settings,
        registry: NEVER_EFFECTIVE_REGISTRY,
        capabilities: CAPABILITIES,
      });
    // Saved by this build's version: the key is declared by nothing, anywhere.
    expect(verdicts(about(compileWith(lamp.definitionVersion), LAMP))).toEqual([["error", "parameter.unknown", "never"]]);
    // Saved by a later build, or by an earlier one whose migration has not run (only a
    // document that skipped `loadProject` is ever in that state): the version is what is
    // said, and nothing of class never. "Remove it" would lose what the migration reads.
    for (const other of [lamp.definitionVersion + 1, lamp.definitionVersion - 1]) {
      const found = about(compileWith(other), LAMP);
      expect(found.map((entry) => entry.code)).toEqual(["compiler/definition-version"]);
      expect(found.map((entry) => diagnosticClass(entry.code))).not.toContain("never");
    }
  });
});

describe("a key a shader edit leaves behind", () => {
  /** The haze with a driven `eyesAt.x`, then its shader edited so `eyesAt` is gone. */
  const WITHOUT_EYES_AT = HAZE_SHADER.replace("  eyesAt: vec3f,\n", "").replace(" + params.eyesAt", "");

  async function orphaned() {
    const live = session(openedFile(hazeFile({ eyeColor: RED, eyesAt: [0.5, 0, 0], "eyesAt.x": held(0.25, 0) })).graph);
    expect(about(live.compiled(), HAZE)).toEqual([]);
    const edited = await live.patch([{ op: "setShaderSource", nodeId: HAZE, source: WITHOUT_EYES_AT }]);
    return { live, edited };
  }

  it("is never dropped and never silent: the edit applies, the values stay stored, and the compile says so as an error", async () => {
    const { live, edited } = await orphaned();
    // The edit is not refused: dropping a field is a legitimate edit to something else.
    expect(edited.status).toBe("applied");
    expect(Object.keys(live.graph().nodes[HAZE]?.parameters ?? {}).sort()).toEqual(["eyeColor", "eyesAt", "eyesAt.x", "source"]);
    const found = about(live.compiled(), HAZE);
    expect(verdicts(found)).toEqual([
      ["error", "parameter.unknown", "never"],
      ["error", "parameter.unknown", "never"],
    ]);
    expect(found.map((entry) => entry.message)).toEqual([
      `Node "${HAZE}" stores a value under "eyesAt", which "customWgsl" does not declare: nothing reads it.`,
      `Node "${HAZE}" stores a value under "eyesAt.x", which "customWgsl" does not declare: nothing reads it.`,
    ]);
    expect(found[0]?.suggestion).toContain("Or remove the stored value: parameter.removeUndeclared (in a patch: removeParameters).");
    expect(live.compiled().ok).toBe(true);
  });

  it("is removed by a command, in one step that undo takes back", async () => {
    const { live } = await orphaned();
    const removed = await live.bus.execute("parameter.removeUndeclared", { nodeId: HAZE }, live.context);
    expect(removed.status).toBe("applied");
    expect(removed.output.removed).toEqual(["eyesAt", "eyesAt.x"]);
    expect(Object.keys(live.graph().nodes[HAZE]?.parameters ?? {}).sort()).toEqual(["eyeColor", "source"]);
    expect(about(live.compiled(), HAZE)).toEqual([]);

    await live.bus.execute("graph.undo", {}, live.context);
    expect(live.graph().nodes[HAZE]?.parameters["eyesAt.x"]).toEqual(held(0.25, 0));
    expect(about(live.compiled(), HAZE).map((entry) => entry.code)).toEqual(["parameter.unknown", "parameter.unknown"]);
  });

  it("removes only what the node does not declare: a declared key is refused by name, and so is a node with nothing to remove", async () => {
    const { live } = await orphaned();
    const declared = await live.bus.execute("parameter.removeUndeclared", { nodeId: HAZE, keys: ["eyeColor"] }, live.context);
    expect(declared.status).toBe("rejected");
    expect(declared.diagnostics?.map((entry) => entry.code)).toEqual(["parameter.remove.declared"]);
    expect(live.graph().nodes[HAZE]?.parameters["eyeColor"]).toEqual(RED);

    const one = await live.bus.execute("parameter.removeUndeclared", { nodeId: HAZE, keys: ["eyesAt.x"] }, live.context);
    expect([one.status, one.output.removed]).toEqual(["applied", ["eyesAt.x"]]);
    await live.bus.execute("parameter.removeUndeclared", { nodeId: HAZE }, live.context);
    const nothing = await live.bus.execute("parameter.removeUndeclared", { nodeId: HAZE }, live.context);
    expect(nothing.status).toBe("rejected");
    expect(nothing.diagnostics?.map((entry) => entry.code)).toEqual(["parameter.remove.none"]);
  });
});

describe("§B266 — an expression on a code parameter", () => {
  const asExpression: StoredParameter = {
    mode: "expression",
    bindings: { static: { kind: "static", value: HAZE_SHADER }, expression: { kind: "expression", source: "time" } },
  };

  it("is refused where it is written: no expression can drive a parameter of that type", async () => {
    const live = session();
    await live.patch([{ op: "addNode", ref: "haze", type: "customWgsl", position: { x: 0, y: 0 }, label: HAZE, parameters: { source: HAZE_SHADER } }]);
    const refused = await live.patch([{ op: "setParameters", nodeId: "haze", parameters: { source: asExpression } }]);
    expect(refused.status).toBe("rejected");
    expect((refused.diagnostics ?? []).map((entry) => [entry.severity, entry.code])).toEqual([["error", "parameter.expression.type"]]);
    expect(refused.diagnostics?.[0]?.message).toContain('a "code" parameter cannot take an expression');
    expect(live.graph().nodes["haze"]?.parameters["source"]).toBe(HAZE_SHADER);
  });

  it("at rest, in a file built by code: one error on the code parameter, and the node keeps the controls its text declares", () => {
    // The reflection read the stored source raw: a slot is not a string, so the schema fell
    // back to the DEFAULT shader's, and every control the real text declares read as a key
    // of nothing. Under the rule that would be one true error buried under false ones.
    const plan = compiledFile(hazeFile({ eyeColor: RED, "eyesAt.x": held(0.5, 0), source: asExpression }));
    expect(verdicts(about(plan, HAZE))).toEqual([["error", "parameter.expression.type", "never"]]);
    expect(plan.ok).toBe(true);
  });
});
