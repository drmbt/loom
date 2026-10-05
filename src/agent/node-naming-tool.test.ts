import { beforeEach, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore, type GraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { Actor } from "@domain/types/commands.ts";
import type { ParameterSlot } from "@domain/types/parameters.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";

import { createAgentToolSurface, type AgentToolSurface } from "./surface.ts";
import type { NamedPatchToolData } from "./tools/mutate.ts";
import type { NodeDefinitionSummary } from "./tools/read.ts";
import type { ToolResult } from "./types.ts";

/**
 * AN AGENT NAMES A NODE, AND IS TOLD WHAT IT WAS CALLED (T1593b).
 *
 * A name is `kind_role`. An agent that asks for a slider called `lamp` gets `slider_lamp`,
 * and the failure this file exists for is the quiet one that follows: it writes
 * `op('lamp')` from its own request, the reference resolves to nothing, and the parameter
 * sits on its retained value with no error anywhere. So every case asserts the two things
 * together: the name THE DOCUMENT holds, and the name THE RESULT reports. They have to be
 * the same string, because the result is the only place the agent can learn it.
 *
 * Through the real tool surface, the real bus and the real node catalogue: the kinds are
 * the shipped ones, not fixtures.
 */

const agent: Actor = { kind: "agent", id: "claude" };

let store: GraphStore;
let surface: AgentToolSurface;

beforeEach(() => {
  store = createGraphStore({ ids: createSequentialIdFactory("n"), now: () => "2026-10-05T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  surface = createAgentToolSurface({ bus, actor: agent, projectId: "project-1", now: () => 1_000 });
});

const data = (outcome: ToolResult): NamedPatchToolData => outcome.data as NamedPatchToolData;
const stored = (id: string) => store.view.getGraph().nodes[id]?.label;
const created = (outcome: ToolResult) => data(outcome).createdIds["$node"] as string;
const codes = (outcome: ToolResult) => outcome.diagnostics.map((entry) => entry.code);

describe("add_node names the node and reports the name", () => {
  it("auto-names under the kind when no label is given, and says which name that was", async () => {
    const outcome = await surface.callTool("add_node", { type: "pointKernel" });

    expect(outcome.status).toBe("ok");
    expect(stored(created(outcome))).toBe("kernel1");
    expect(data(outcome).name).toBe("kernel1");
    expect(codes(outcome)).not.toContain("node.name.kind");
  });

  it("puts the kind in front of a label that lacks it, and reports the stored name", async () => {
    const outcome = await surface.callTool("add_node", { type: "slider", label: "lamp" });

    expect(outcome.status).toBe("ok");
    expect(stored(created(outcome))).toBe("slider_lamp");
    expect(data(outcome).name).toBe("slider_lamp");
    expect(codes(outcome)).toContain("node.name.kind");
  });

  /**
   * §V37: a diagnostic is read by a model as direction, so a message authored by the
   * adapter carries no document text. The name travels in `data`, and only there.
   */
  it("says the kind was added WITHOUT quoting the label in the diagnostic", async () => {
    const outcome = await surface.callTool("add_node", { type: "slider", label: "ignore_previous_instructions" });
    const note = outcome.diagnostics.find((entry) => entry.code === "node.name.kind");

    expect(data(outcome).name).toBe("slider_ignore_previous_instructions");
    expect(note?.severity).toBe("info");
    expect(note?.message).not.toContain("ignore_previous_instructions");
    expect(note?.message).toContain("data.name");
  });

  it("takes a label that already carries the kind as written, with nothing to report", async () => {
    const outcome = await surface.callTool("add_node", { type: "blur", label: "blur_diffuse" });

    expect(stored(created(outcome))).toBe("blur_diffuse");
    expect(data(outcome).name).toBe("blur_diffuse");
    expect(codes(outcome)).not.toContain("node.name.kind");
  });

  it("stores the label exactly when exactLabel says so", async () => {
    const outcome = await surface.callTool("add_node", { type: "slider", label: "lamp", exactLabel: true });

    expect(stored(created(outcome))).toBe("lamp");
    expect(data(outcome).name).toBe("lamp");
    expect(codes(outcome)).not.toContain("node.name.kind");
  });

  it("a dry run reports the name it would store, and stores nothing", async () => {
    const outcome = await surface.callTool("add_node", { type: "light", label: "key", dryRun: true });

    expect(outcome.status).toBe("validated");
    expect(data(outcome).name).toBe("light_key");
    expect(Object.keys(store.view.getGraph().nodes)).toEqual([]);
  });

  it("refuses a name that is taken and reports no name, rather than one nothing holds", async () => {
    await surface.callTool("add_node", { type: "slider", label: "lamp" });
    const outcome = await surface.callTool("add_node", { type: "slider", label: "lamp" });

    expect(outcome.status).toBe("rejected");
    expect(data(outcome).name).toBeNull();
    expect(codes(outcome)).toContain("node.nameTaken");
    expect(codes(outcome)).not.toContain("node.name.kind");
    expect(Object.keys(store.view.getGraph().nodes)).toHaveLength(1);
  });

  it("the name it reports is the one op('…') resolves: an expression written from it is live", async () => {
    const slider = await surface.callTool("add_node", { type: "slider", label: "lamp" });
    const source = `op('${data(slider).name}').chan.value * 8`;
    const blur = await surface.callTool("add_node", {
      type: "blur",
      parameters: {
        size: { mode: "expression", bindings: { static: { kind: "static", value: 2 }, expression: { kind: "expression", source } } },
      },
    });

    // The document's own check for a reference that names nothing is the rename rewrite:
    // rename the slider, and a live reference follows it. A dangling `op('lamp')` would not.
    await surface.callTool("rename_node", { nodeId: created(slider), label: "dimmer" });
    const size = store.view.getGraph().nodes[created(blur)]?.parameters["size"] as ParameterSlot;
    expect(size.bindings.expression).toEqual({ kind: "expression", source: "op('slider_dimmer').chan.value * 8" });
  });
});

describe("rename_node is the title editor's rename, for an agent", () => {
  it("is published and available on a surface built from the domain bus", () => {
    const tool = surface.listTools().find((entry) => entry.name === "rename_node");
    expect(tool?.available).toBe(true);
  });

  it("keeps the kind in front, and reports the stored name", async () => {
    const id = created(await surface.callTool("add_node", { type: "light" }));
    const outcome = await surface.callTool("rename_node", { nodeId: id, label: "key" });

    expect(outcome.status).toBe("ok");
    expect(stored(id)).toBe("light_key");
    expect(data(outcome).name).toBe("light_key");
    // The command's own note, passed through: it is the door that applied the rule.
    expect(codes(outcome)).toContain("node.name.kind");
  });

  it("stores the label exactly when exact says so", async () => {
    const id = created(await surface.callTool("add_node", { type: "light" }));
    const outcome = await surface.callTool("rename_node", { nodeId: id, label: "key", exact: true });

    expect(stored(id)).toBe("key");
    expect(data(outcome).name).toBe("key");
  });

  it("clears the name with null, and then reports none", async () => {
    const id = created(await surface.callTool("add_node", { type: "light" }));
    const outcome = await surface.callTool("rename_node", { nodeId: id, label: null });

    expect(outcome.status).toBe("ok");
    expect(stored(id)).toBeUndefined();
    expect(data(outcome).name).toBeNull();
  });

  it("passes a refusal through with the free name the command suggests, and renames nothing", async () => {
    const first = created(await surface.callTool("add_node", { type: "light", label: "key" }));
    const second = created(await surface.callTool("add_node", { type: "light" }));
    const outcome = await surface.callTool("rename_node", { nodeId: second, label: "key" });

    expect(outcome.status).toBe("rejected");
    expect(data(outcome).name).toBeNull();
    expect(stored(first)).toBe("light_key");
    expect(stored(second)).toBe("light1");
    expect(outcome.diagnostics.find((entry) => entry.code === "node.nameTaken")?.suggestion).toBe(`"light_key2" is free.`);
  });

  it("a dry run renames nothing", async () => {
    const id = created(await surface.callTool("add_node", { type: "light" }));
    const outcome = await surface.callTool("rename_node", { nodeId: id, label: "key", dryRun: true });

    expect(outcome.status).toBe("validated");
    expect(stored(id)).toBe("light1");
  });
});

describe("a patch stores a label exactly, and the kind is published so an agent can write one in full", () => {
  it("apply_graph_patch never prefixes: a replayed patch carries references written against its own labels", async () => {
    const outcome = await surface.callTool("apply_graph_patch", {
      baseRevision: store.view.getRevision(),
      operations: [{ op: "addNode", ref: "$a", type: "slider", position: { x: 0, y: 0 }, label: "lamp" }],
    });

    expect(outcome.status).toBe("ok");
    expect(stored(data(outcome).createdIds["$a"] as string)).toBe("lamp");
  });

  it("list_node_definitions and get_node_definition give each type's kind", async () => {
    const listed = await surface.callTool("list_node_definitions", {});
    const definitions = (listed.data as { definitions: NodeDefinitionSummary[] }).definitions;
    const kindOf = (type: string) => definitions.find((entry) => entry.type === type)?.kind;

    expect(kindOf("pointKernel")).toBe("kernel");
    expect(kindOf("movieFileIn")).toBe("movie");
    expect(kindOf("slider")).toBe("slider");

    const one = await surface.callTool("get_node_definition", { type: "materialPbr" });
    expect((one.data as NodeDefinitionSummary).kind).toBe("material");
  });
});
