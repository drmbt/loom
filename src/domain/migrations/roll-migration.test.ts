import { describe, expect, it } from "vitest";

import { flattenComponents } from "../../compiler/flatten.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createComponentSystem } from "../components/index.ts";
import { cameraPayloadMatrix, transformPoint } from "../geometry/camera.ts";
import { NO_FLATTENING, parameterReadOptions } from "../parameters/node-references.ts";
import { resolveParameters } from "../parameters/resolve.ts";
import { loadProject } from "../project/load.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ParameterSlot } from "../types/parameters.ts";
import { SCHEMA_VERSION } from "../types/schemas.ts";

/**
 * 4 → 5 (§T1433b): camera roll turns right-handed, and a saved document frames what it framed.
 *
 * Before schema 5, +90 of roll put the world's up on the screen's LEFT; the engine now turns
 * the other way (Blender, three.js), and the migration negates every stored roll. The claims
 * go through the REAL load path (`loadProject`: parse, the document ladder, component install,
 * node migrations, the driven upgrade) and are asserted where the value is consumed — the view
 * a camera projects through, the number a parameter resolves to, the roll a flattened
 * component instance hands its internal camera:
 *  - a static roll frames the same picture (world up still lands screen-left at a v4 +90);
 *  - an expression roll is WRAPPED, `-(expr)` (the choice for slots: exact, and it keeps the
 *    author's text), and resolves to the negated value;
 *  - an expression READING a camera's roll, `op('came1').par.roll`, still reads what it read;
 *  - a Projector's roll turns with the Camera's;
 *  - a component's internal camera, its published roll parameter's default, an instance's
 *    value for it and an instance override of the internal roll are all negated, so the
 *    flattened camera carries exactly the negated roll.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const node = (id: string, type: string, label: string, parameters: Record<string, unknown>, state?: Record<string, unknown>) => ({
  id,
  type,
  label,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  ...(state === undefined ? {} : { state }),
});

const expression = (source: string, retained: number) => ({
  mode: "expression",
  bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: retained } },
});

const RIG = {
  componentId: "rig",
  name: "Rig",
  version: 1,
  inputs: [],
  outputs: [],
  graph: { revision: 1, nodes: { cam: node("cam", "camera", "rigcam1", { eye: [0, 0, 3], lookAt: [0, 0, 0], roll: 20 }) }, edges: {}, groups: {} },
  parameters: [{ key: "tilt", definition: { type: "number", label: "Tilt", default: 5 }, targets: [{ nodeId: "cam", key: "roll" }] }],
};

function v4(): string {
  return JSON.stringify({
    schemaVersion: 4,
    projectId: "roll-v4",
    name: "A v4 project with rolls",
    graph: {
      revision: 1,
      nodes: {
        camS: node("camS", "camera", "cams1", { eye: [0, 0, 3], lookAt: [0, 0, 0], roll: 90 }),
        camE: node("camE", "camera", "came1", { eye: [0, 0, 3], lookAt: [0, 0, 0], roll: expression("30 + 0 * time", 30) }),
        reader: node("reader", "blur", "reader1", { size: expression("op('came1').par.roll / 10", 1) }),
        proj: node("proj", "projector", "proj1", { roll: -15 }),
        rigA: node("rigA", "component:rig@1", "riga1", { tilt: 9 }),
        rigB: node("rigB", "component:rig@1", "rigb1", {}, { componentOverrides: { "cam/roll": 11 } }),
      },
      edges: {},
      groups: {},
    },
    settings: {
      outputResolution: { width: 64, height: 64 },
      workingFormat: "rgba16float",
      randomSeed: 1,
      previewLongEdge: 64,
      previewFps: 30,
      limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
    },
    assets: [],
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    componentLibrary: { schemaVersion: 1, components: [RIG] },
  });
}

function load() {
  const system = createComponentSystem(registry);
  const loaded = loadProject(v4(), { nodes: system.nodes, components: system.components });
  if (!loaded.ok) throw new Error(loaded.reason);
  expect(loaded.document.schemaVersion).toBe(SCHEMA_VERSION);
  expect(SCHEMA_VERSION).toBe(5);
  return { document: loaded.document, system };
}

const nodeOf = (graph: GraphDocument, id: string): GraphNode => graph.nodes[id]!;
const cameraDefinition = allNodeDefinitions.find((definition) => definition.type === "camera");

describe("4 → 5: camera roll turns right-handed, and a saved document frames what it framed (§T1433b)", () => {
  it("a static roll is negated, and the view is the one v4 drew: +90 still puts world up on the screen's left", () => {
    const { document } = load();
    const roll = nodeOf(document.graph, "camS").parameters["roll"];
    expect(roll).toBe(-90);
    const view = cameraPayloadMatrix(
      { eye: [0, 0, 3], lookAt: [0, 0, 0], fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2, roll: roll as number },
      1,
    );
    const up = transformPoint(view, [0, 1, 0]);
    expect(up[0] / up[3]).toBeLessThan(-0.1);
    expect(Math.abs(up[1] / up[3])).toBeLessThan(1e-6);
  });

  it("an expression roll is wrapped, -(expr), and resolves to the negated value", () => {
    const { document } = load();
    const slot = nodeOf(document.graph, "camE").parameters["roll"] as ParameterSlot;
    expect(slot.mode).toBe("expression");
    expect(slot.bindings.expression).toEqual({ kind: "expression", source: "-(30 + 0 * time)" });
    expect(slot.bindings.static).toEqual({ kind: "static", value: -30 });
    expect(resolveParameters(nodeOf(document.graph, "camE"), cameraDefinition).values["roll"]).toBe(-30);
  });

  it("an expression reading a camera's roll by reference still reads what it read", () => {
    const { document } = load();
    const slot = nodeOf(document.graph, "reader").parameters["size"] as ParameterSlot;
    expect(slot.bindings.expression).toEqual({ kind: "expression", source: "(-op('came1').par.roll) / 10" });
    const blur = allNodeDefinitions.find((definition) => definition.type === "blur");
    const options = parameterReadOptions({ graph: document.graph, registry, frame: undefined, channels: undefined, flattening: NO_FLATTENING });
    // 30 / 10 before the flip; (-(-30)) / 10 after it.
    expect(resolveParameters(nodeOf(document.graph, "reader"), blur, options).values["size"]).toBe(3);
  });

  it("a Projector's roll turns with the Camera's", () => {
    const { document } = load();
    expect(nodeOf(document.graph, "proj").parameters["roll"]).toBe(15);
  });

  it("an embedded component: its internal camera, its published roll, an instance's value and an override are negated", () => {
    const { document, system } = load();
    const definition = system.components.view().get("rig" as never, 1);
    expect(definition?.graph.nodes["cam"]?.parameters["roll"]).toBe(-20);
    expect(definition?.parameters[0]?.definition).toMatchObject({ default: -5 });
    expect(nodeOf(document.graph, "rigA").parameters["tilt"]).toBe(-9);
    // What the internal camera of each instance is flattened with: the instance value, the override.
    const flat = flattenComponents({ graph: document.graph, registry: system.nodes, components: system.components.view() });
    const rolls = Object.values(flat.graph.nodes)
      .filter((entry) => entry.type === "camera" && entry.id.startsWith("rig"))
      .map((entry) => [entry.id.startsWith("rigA") ? "A" : "B", resolveParameters(entry, cameraDefinition).values["roll"]]);
    expect(Object.fromEntries(rolls)).toEqual({ A: -9, B: -11 });
  });
});
