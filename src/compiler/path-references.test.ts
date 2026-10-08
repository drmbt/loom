import { describe, expect, it } from "vitest";

import { componentNodeType, createComponentSystem } from "../domain/components/index.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { ComponentId } from "../domain/types/ids.ts";
import type { ParameterSlot } from "../domain/types/parameters.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { flattenComponents } from "./flatten.ts";
import { synthesizeSourceReferenceEdges } from "./source-reference-edges.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { createCompilerTestRegistry, testNode } from "./test-support.ts";

/**
 * VN35 — PATHS NAME ONE COPY OF A COMPONENT'S NODE (proposal 01 §2.2, §4 stage 1).
 *
 * B41 makes every label of the flattening unique by renumbering the copies inside the
 * second and later instances, so a bare name from outside reaches the FIRST copy and no
 * other. These tests follow what a reference actually binds: the edge the synthesis makes
 * from it, whose source is the flattened id of the node it reached.
 */

const base = createCompilerTestRegistry(allNodeDefinitions).view();

const expressionSlot = (source: string, retained: number): ParameterSlot => ({
  mode: "expression",
  bindings: { static: { kind: "static", value: retained }, expression: { kind: "expression", source } },
});

const graphOf = (nodes: GraphNode[]): GraphDocument => ({
  revision: 1,
  nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  edges: {},
  groups: {},
});

const instance = (id: string, componentId: ComponentId, label: string): GraphNode =>
  testNode(id, componentNodeType(componentId, 1), { label });

/** One projector, named `projector_beam` in its definition. */
const projector: GraphComponentDefinition = {
  componentId: "projector",
  version: 1,
  name: "Projector",
  graph: graphOf([testNode("beam", "projector", { label: "projector_beam", parameters: { brightness: 1 } })]),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "beam", portId: "out" }],
  parameters: [],
};

/** A rig holding a Projector instance and a Render naming it by a path, and the stage camera from outside. */
const rig: GraphComponentDefinition = {
  componentId: "rig",
  version: 1,
  name: "Rig",
  graph: graphOf([
    instance("lamp", "projector", "projector_lamp"),
    testNode("shot", "render", {
      label: "render_rig",
      parameters: { scenes: "", lights: "", camera: "../camera_stage", projectors: "projector_lamp/projector_beam" },
    }),
  ]),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "shot", portId: "out" }],
  parameters: [],
};

function flatten(definitions: GraphComponentDefinition[], nodes: GraphNode[]) {
  const system = createComponentSystem(base, definitions);
  const flattened = flattenComponents({ graph: graphOf(nodes), registry: system.nodes, components: system.components.view() });
  const synthesized = synthesizeSourceReferenceEdges(flattened.graph, system.nodes);
  /** The flattened ids the names feeding a node's input bound, in list order. */
  const bound = (nodeId: string, input: string): string[] =>
    Object.values(synthesized.graph.edges)
      .filter((edge) => edge.id.startsWith("ref:") && edge.target.nodeId === nodeId && edge.target.portId === input)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((edge) => edge.source.nodeId);
  return { flattened, synthesized, bound };
}

const threeProjectors = (projectors: string): GraphNode[] => [
  instance("left", "projector", "projector_left"),
  instance("mid", "projector", "projector_mid"),
  instance("right", "projector", "projector_right"),
  testNode("cam", "camera", { label: "camera_stage" }),
  testNode("shot", "render", { label: "render_stage", parameters: { scenes: "", lights: "", camera: "camera_stage", projectors } }),
];

describe("a path names one copy of a component's node (VN35)", () => {
  it("resolves a single source path whose target label contains spaces", () => {
    const cameraRig: GraphComponentDefinition = {
      ...projector, componentId: "cameraRig", name: "Camera Rig",
      graph: graphOf([testNode("cam", "camera", { label: "Camera One" })]),
      outputs: [{ externalId: "out", label: "Out", nodeId: "cam", portId: "out" }],
    };
    const { bound, synthesized } = flatten([cameraRig], [
      instance("a", "cameraRig", "rig_a"),
      testNode("shot", "render", { label: "render_stage", parameters: { scenes: "", lights: "", camera: "rig_a/Camera One" } }),
    ]);
    expect(synthesized.diagnostics).toEqual([]);
    expect(bound("shot", "camera")).toEqual(["a/cam"]);
  });

  it("resolves published expressions in the scope where the instance page was authored", () => {
    const reader: GraphComponentDefinition = {
      componentId: "reader", version: 1, name: "Reader",
      graph: graphOf([testNode("value", "constant", { label: "constant_value" })]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "value", portId: "out" }],
      parameters: [{ key: "gain", definition: { type: "number", label: "Gain", default: 0 }, targets: [{ nodeId: "value", key: "value" }] }],
    };
    const { flattened } = flatten([projector, reader], [
      ...threeProjectors(""),
      { ...instance("reader", "reader", "reader_a"), parameters: { gain: expressionSlot("op('projector_right/projector_beam').par.brightness", 0) } },
    ]);
    const slot = flattened.graph.nodes["reader/value"]!.parameters.value as ParameterSlot;
    expect(slot.bindings.expression).toEqual({ kind: "expression", source: `op('${flattened.graph.nodes["right/beam"]!.label}').par.brightness` });
  });

  it("keeps a nested instance's own published expression in its enclosing definition's scope", () => {
    const reader: GraphComponentDefinition = {
      componentId: "reader", version: 1, name: "Reader",
      graph: graphOf([testNode("value", "constant", { label: "constant_value" })]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "value", portId: "out" }],
      parameters: [{ key: "gain", definition: { type: "number", label: "Gain", default: 0 }, targets: [{ nodeId: "value", key: "value" }] }],
    };
    const outer: GraphComponentDefinition = {
      componentId: "outer", version: 1, name: "Outer",
      graph: graphOf([
        instance("lamp", "projector", "projector_local"),
        { ...instance("reader", "reader", "reader_inner"), parameters: { gain: expressionSlot("op('projector_local/projector_beam').par.brightness", 0) } },
      ]), inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "reader", portId: "out" }], parameters: [],
    };
    const { flattened } = flatten([projector, reader, outer], [instance("a", "outer", "outer_a"), instance("b", "outer", "outer_b")]);
    for (const copy of ["a", "b"]) {
      const slot = flattened.graph.nodes[`${copy}/reader/value`]!.parameters.value as ParameterSlot;
      expect(slot.bindings.expression).toEqual({ kind: "expression", source: `op('${flattened.graph.nodes[`${copy}/lamp/beam`]!.label}').par.brightness` });
    }
  });

  it("keeps a parent-bound source path in its root authoring scope", () => {
    const cameraRig: GraphComponentDefinition = {
      ...projector, componentId: "cameraRig", name: "Camera Rig",
      graph: graphOf([testNode("cam", "camera", { label: "camera_stage" })]),
      outputs: [{ externalId: "out", label: "Out", nodeId: "cam", portId: "out" }],
    };
    const reader: GraphComponentDefinition = {
      componentId: "reader", version: 1, name: "Reader",
      graph: graphOf([testNode("shot", "render", { label: "render_reader", parameters: { scenes: "", lights: "", camera: {
        mode: "bind", bindings: { static: { kind: "static", value: "" }, bind: { kind: "bind", ref: "parent.camera" } },
      } } })]), inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "shot", portId: "out" }],
      parameters: [{ key: "camera", definition: { type: "string", label: "Camera", default: "" }, targets: [] }],
    };
    const { synthesized, bound } = flatten([cameraRig, reader], [
      instance("camera", "cameraRig", "rig_b"),
      { ...instance("reader", "reader", "reader_a"), parameters: { camera: "rig_b/camera_stage" } },
    ]);
    expect(synthesized.diagnostics).toEqual([]);
    expect(bound("reader/shot", "camera")).toEqual(["camera/cam"]);
  });

  it("binds three projectors in three instances, one each, in list order", () => {
    const { bound, synthesized } = flatten(
      [projector],
      threeProjectors("projector_left/projector_beam projector_mid/projector_beam projector_right/projector_beam"),
    );
    expect(synthesized.diagnostics).toEqual([]);
    expect(bound("shot", "projectors")).toEqual(["left/beam", "mid/beam", "right/beam"]);
  });

  it("the bare name, the old way, binds the first copy alone and now says so", () => {
    const { bound, flattened } = flatten([projector], threeProjectors("projector_beam"));
    // The bug, as it always was: three copies, one bind, and it is the first.
    expect(bound("shot", "projectors")).toEqual(["left/beam"]);
    const crossing = flattened.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.referenceCrossScope);
    expect(crossing).toHaveLength(1);
    expect(crossing[0]).toMatchObject({ severity: "warning", nodeId: "shot" });
    expect(crossing[0]?.message).toContain("3 nodes in the document are named \"projector_beam\"");
    expect(crossing[0]?.suggestion).toContain("\"projector_left/projector_beam\"");
  });

  it("resolves inside a component, and climbs out of it with ../, per instance", () => {
    const { bound, synthesized, flattened } = flatten(
      [projector, rig],
      [
        instance("a", "rig", "rig_a"),
        instance("b", "rig", "rig_b"),
        testNode("cam", "camera", { label: "camera_stage" }),
      ],
    );
    expect(synthesized.diagnostics).toEqual([]);
    expect(flattened.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.referenceCrossScope)).toEqual([]);
    // Each rig's Render binds its OWN projector — B41 renumbered the second copy's names,
    // and the path is read in the names the definition wrote.
    expect(bound("a/shot", "projectors")).toEqual(["a/lamp/beam"]);
    expect(bound("b/shot", "projectors")).toEqual(["b/lamp/beam"]);
    expect(bound("a/shot", "camera")).toEqual(["cam"]);
    expect(bound("b/shot", "camera")).toEqual(["cam"]);
  });

  it("rewrites op('instance/node') to the copy it names", () => {
    const { flattened } = flatten([projector], [
      ...threeProjectors(""),
      testNode("reader", "constant", {
        label: "constant_reader",
        parameters: { value: expressionSlot("op('projector_right/projector_beam').par.brightness * 2", 0) },
      }),
    ]);
    const source = (flattened.graph.nodes["reader"]?.parameters["value"] as { bindings: { expression: { source: string } } }).bindings
      .expression.source;
    const label = flattened.graph.nodes["right/beam"]?.label;
    expect(label).not.toBe("projector_beam"); // the third copy was renumbered
    expect(source).toBe(`op('${label}').par.brightness * 2`);
  });

  it("leaves a path that reaches nothing as written, and the synthesis refuses it by name", () => {
    for (const written of ["projector_left/nope", "camera_stage/projector_beam", "../camera_stage", "/projector_left/projector_beam", "projector_left"]) {
      const { synthesized, flattened } = flatten([projector], threeProjectors(written));
      expect(flattened.graph.nodes["shot"]?.parameters["projectors"]).toBe(written);
      const missing = synthesized.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.sourceReferenceMissing);
      expect(missing, written).toHaveLength(1);
      if (written.includes("/")) expect(missing[0]?.message).toContain("a path that reaches no node");
    }
  });

  it("does not warn when a component reads OUTWARD by a bare name — that is lexical scope", () => {
    const outward: GraphComponentDefinition = {
      ...rig,
      componentId: "outward",
      graph: graphOf([
        instance("lamp", "projector", "projector_lamp"),
        testNode("shot", "render", {
          label: "render_rig",
          parameters: { scenes: "", lights: "", camera: "camera_stage", projectors: "projector_lamp/projector_beam" },
        }),
      ]),
    };
    const { flattened, bound } = flatten([projector, outward], [instance("a", "outward", "rig_a"), testNode("cam", "camera", { label: "camera_stage" })]);
    expect(bound("a/shot", "camera")).toEqual(["cam"]);
    expect(flattened.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.referenceCrossScope)).toEqual([]);
  });
});
