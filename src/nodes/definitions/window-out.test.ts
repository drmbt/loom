import { describe, expect, it } from "vitest";
import { compileGraph, ownsSinkTarget, presentsPicture, SINK_TARGET_PORT } from "../../compiler/index.ts";
import type { ActiveSink } from "../../compiler/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { windowOutNode } from "./window-out.ts";

/**
 * §T1391b — Window Out through the real compiler. What the app reads back is the plan: is
 * there a target to present into, at what size, and does the viewer's picture stay the
 * Output's. Asserted on the plan's outputs and passes, not on the definition's fields.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 8192, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};
const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};
const registry = createNodeRegistry(allNodeDefinitions).view();

const node = (id: string, type: string, parameters: GraphNode["parameters"] = {}, label?: string): GraphNode => ({
  id,
  type,
  definitionVersion: registry.get(type)?.version ?? 1,
  position: { x: 0, y: 0 },
  parameters,
  ...(label === undefined ? {} : { label }),
});

/** `a_win` sorts BEFORE `out`: the case where "first sink by id" would pick the window. */
function graph(windowParameters: GraphNode["parameters"] = {}, wired = true): GraphDocument {
  return {
    revision: 1,
    nodes: {
      src: node("src", "checker", {}, "src"),
      a_win: node("a_win", "window", windowParameters),
      out: node("out", "output"),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      ...(wired ? { e2: { id: "e2", source: { nodeId: "src", portId: "out" }, target: { nodeId: "a_win", portId: "input" } } } : {}),
    },
    groups: {},
  };
}

const open: ActiveSink[] = [{ nodeId: "a_win", kind: "output" }];
const compile = (document: GraphDocument, sinks?: ActiveSink[]) =>
  compileGraph({ graph: document, settings, registry, capabilities, ...(sinks === undefined ? {} : { sinks }) });
const windowTarget = (plan: ReturnType<typeof compile>) =>
  plan.outputs.find((output) => output.nodeId === "a_win" && output.portId === SINK_TARGET_PORT);

describe("Window Out is a display sink (§T1391b)", () => {
  it("draws into a target of its own, and is never the picture", () => {
    expect(ownsSinkTarget(windowOutNode)).toBe(true);
    expect(presentsPicture(windowOutNode)).toBe(false);
  });

  it("renders nothing while its window is closed, and Width × Height while it is open", () => {
    const closed = compile(graph({ width: 1024, height: 256 }));
    expect(windowTarget(closed)).toBeUndefined();
    expect(closed.passes.some((pass) => "nodeId" in pass && pass.nodeId === "a_win")).toBe(false);

    const shown = compile(graph({ width: 1024, height: 256 }), open);
    expect(shown.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const target = windowTarget(shown);
    expect(target).toBeDefined();
    const resource = shown.resources.find((entry) => entry.id === target?.resourceId);
    expect(resource !== undefined && "size" in resource ? resource.size : undefined).toEqual([1024, 256]);
    expect(shown.passes.filter((pass) => "nodeId" in pass && pass.nodeId === "a_win")).toHaveLength(1);
  });

  it("keeps the Output as the first picture sink even when the window's id sorts first", () => {
    const shown = compile(graph(), open);
    // The rule the viewer (`side-panes.tsx`) and render-out (`use-render-range.ts`) both
    // apply: the first `$target` output, in plan order, whose node presents the picture.
    const document = graph();
    const pictures = shown.outputs.filter((output) => {
      const definition = registry.get(document.nodes[output.nodeId]?.type ?? "");
      return output.portId === SINK_TARGET_PORT && definition !== undefined && presentsPicture(definition);
    });
    expect(shown.outputs.map((output) => output.nodeId)).toContain("a_win");
    expect(pictures.map((output) => output.nodeId)).toEqual(["out"]);
  });

  it("shows a node by NAME when nothing is wired (the Source reference)", () => {
    const byName = compile(graph({ source: "src" }, false), open);
    expect(byName.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(byName.passes.filter((pass) => "nodeId" in pass && pass.nodeId === "a_win")).toHaveLength(1);
    const unnamed = compile(graph({}, false), open);
    expect(unnamed.passes.some((pass) => "nodeId" in pass && pass.nodeId === "a_win")).toBe(false);
  });

  it("changes the pass's placement uniform with Fit, and nothing structural", () => {
    const fit = compile(graph({ fit: "fit" }), open);
    const fill = compile(graph({ fit: "fill" }), open);
    const pass = (plan: ReturnType<typeof compile>) =>
      plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === "a_win") as { uniforms?: Record<string, number> } | undefined;
    expect(pass(fit)?.uniforms).toEqual({ mode: 0, targetAspect: 1920 / 1080 });
    expect(pass(fill)?.uniforms).toEqual({ mode: 1, targetAspect: 1920 / 1080 });
    expect(fill.signature).toBe(fit.signature);
  });
});
