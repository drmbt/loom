import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { BackendDiagnosticCode } from "../diagnostics.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T1535b — A MATERIAL · WGSL ERROR IS SAID ON THE MATERIAL, ON THE AUTHOR'S LINE.
 *
 * A Material · WGSL hands its code to the Render, which pastes it into its own surface draw
 * pass behind a generated uniform block, bindings and the SurfaceIn/SurfaceOut contract, with
 * the material's `struct Params` cut out and placed ahead of the rest. The device's compiler
 * counts lines in that module, and the pass belongs to the Render — so the error used to land
 * on the Render node at a line of a module nobody wrote.
 *
 * Each case is the literal error through compiler + backend + Dawn. The authored position is
 * asserted together with the generated one being a different line, so a map that does
 * nothing cannot pass; and the node is asserted to be the material, never the Render.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const settings: ProjectSettings = {
  outputResolution: { width: 32, height: 32 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 32,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

/** One grid surface per material, all drawn by one Render (`shot`). */
function sceneGraph(sources: readonly string[], render: Record<string, unknown> = {}): GraphDocument {
  const nodes = [
    node("grid", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid1"),
    ...sources.flatMap((source, index) => [
      node(`mat${index + 1}`, "materialWgsl", { model: "lambert", source }, `material${index + 1}`),
      node(`geo${index + 1}`, "geometry", { mode: "surface", material: `material${index + 1}` }, `geometry${index + 1}`),
    ]),
    node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
    node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
    node(
      "shot",
      "render",
      { scenes: sources.map((_, index) => `geometry${index + 1}`).join(" "), camera: "cam1", lights: "sun1", ...render },
      "shot1",
    ),
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      ...Object.fromEntries(
        sources.map((_, index) => [
          `g${index + 1}`,
          { id: `g${index + 1}`, source: { nodeId: "grid", portId: "out" }, target: { nodeId: `geo${index + 1}`, portId: "points" } },
        ]),
      ),
      o: { id: "o", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

/** Every device failure for `graph`, plus the Render's surface passes' WGSL by pass id. */
async function refusal(
  graph: GraphDocument,
  sinks: ReadonlyArray<{ nodeId: string; portId: string }> = [],
): Promise<{ failures: RuntimeDiagnostic[]; shaders: Map<string, string> }> {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  try {
    const capabilities = await backend.initialize({});
    const plan = compileGraph({
      graph,
      settings,
      registry,
      capabilities,
      ...(sinks.length === 0 ? {} : { sinks: sinks.map((sink) => ({ ...sink, kind: "preview" as const })) }),
    });
    // The graph compiler does not parse WGSL: each failure here can only happen at the device.
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const shaders = new Map(
      (plan.passes as ReadonlyArray<{ id: string; nodeId?: string; shader?: string }>)
        .filter((pass) => pass.nodeId === "shot" && pass.shader !== undefined)
        .map((pass) => [pass.id, pass.shader!] as const),
    );
    await expect(backend.compile(plan)).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      failures: diagnostics.filter((d) => d.code === BackendDiagnosticCode.compileFailed),
      shaders,
    };
  } finally {
    backend.dispose();
  }
}

/** The 1-based line and column of `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; column: number } {
  const lines = text.split("\n");
  const line = lines.findIndex((entry) => entry.includes(needle));
  if (line < 0) throw new Error(`"${needle}" is not in the text`);
  return { line: line + 1, column: lines[line]!.indexOf(needle) + 1 };
}

const FINE = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  return surfaceDefaults(s);
}`;

/** The shipped shape: a shared module, a `struct Params` the generator hoists, then the code. */
const BROKEN = `// @use hash
// Glows by a knob.
struct Params {
  glow: f32, // @default 0.5  Emissive strength.
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.emissive = notAFunction(s.world) * p.glow;
  return o;
}`;

describe("a Material · WGSL device error lands on the material, on the author's line (T1535b, §V27)", () => {
  it("one material: its own node and line — in the lit pass and in every G-buffer variant", async () => {
    const authored = positionOf(BROKEN, "notAFunction");
    expect(authored).toEqual({ line: 9, column: 16 });
    const { failures, shaders } = await refusal(sceneGraph([BROKEN], { normalOutput: true, albedoOutput: true }), [
      { nodeId: "shot", portId: "out" },
      { nodeId: "shot", portId: "normal" },
      { nodeId: "shot", portId: "albedo" },
    ]);

    // Three passes paste the material: the lit draw and two G-buffer layers, each a different
    // module — and in none of them is the author's line where the device counts it.
    const pasted = [...shaders].filter(([, shader]) => shader.includes("notAFunction"));
    expect(pasted.map(([id]) => id).sort()).toEqual(["shot#shot:gbuffer:0", "shot#shot:gbuffer:albedo:0", "shot#shot:scene:0"]);
    for (const [, shader] of pasted) expect(positionOf(shader, "notAFunction").line).not.toBe(authored.line);

    expect(failures.map((d) => [d.nodeId, d.message]).sort()).toEqual(
      pasted
        .map(([id]) => [
          "mat1",
          `Pass "${id}" failed to compile on the device: source 9:16 unresolved call target 'notAFunction'`,
        ])
        .sort(),
    );
    for (const failure of failures) expect(failure.source).toEqual({ file: "source", line: 9, column: 16 });
  }, 60_000);

  it("two materials on one Render, the second broken: the error names the second", async () => {
    const second = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);

  o.albedo = notAFunction(o.albedo);
  return o;
}`;
    const { failures, shaders } = await refusal(sceneGraph([FINE, second]));
    expect(positionOf(shaders.get("shot#shot:scene:1")!, "notAFunction").line).not.toBe(4);
    expect(failures.map((d) => [d.nodeId, d.message, d.source])).toEqual([
      [
        "mat2",
        `Pass "shot#shot:scene:1" failed to compile on the device: source 4:14 unresolved call target 'notAFunction'`,
        { file: "source", line: 4, column: 14 },
      ],
    ]);
  }, 60_000);

  it("an error inside the hoisted `struct Params`: the line the author wrote it on", async () => {
    // A helper above the struct, so the declaration is cut from the middle of the source.
    const source = `// Two knobs, one badly aligned.
fn tint(c: vec4f) -> vec4f {
  return c;
}

struct Params {
  glow: f32, // @default 0.5  Emissive strength.
  @align(3) edge: f32,
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = tint(o.albedo) * p.glow;
  return o;
}`;
    const { failures, shaders } = await refusal(sceneGraph([source]));
    expect(positionOf(shaders.get("shot#shot:scene:0")!, "@align(3)").line).not.toBe(8);
    // The device points at the attribute's name, one past the `@`.
    expect(failures.map((d) => [d.nodeId, d.source])).toEqual([["mat1", { file: "source", line: 8, column: 4 }]]);
    expect(failures[0]!.message).toMatch(/^Pass "shot#shot:scene:0" failed to compile on the device: source 8:4 /);
  }, 60_000);

  it("an error in the generated code says so, on the Render, and marks no author line", async () => {
    // The author's `surface` takes one argument; the generated fragment calls it with two.
    // Every byte the author wrote is valid — the call the device rejects is the generator's.
    const oneArgument = `fn surface(s: SurfaceIn) -> SurfaceOut {
  return surfaceDefaults(s);
}`;
    const { failures } = await refusal(sceneGraph([oneArgument]));
    expect(failures.map((d) => d.nodeId)).toEqual(["shot"]);
    expect(failures[0]!.message).toMatch(
      /^Pass "shot#shot:scene:0" failed to compile on the device: \d+:\d+ of the generated module \(not your code\) too many arguments in call to 'surface'/,
    );
    expect(failures[0]!.source).toBeUndefined();
  }, 60_000);
});
