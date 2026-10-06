import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadProject } from "../../../domain/project/index.ts";
import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { starterComponentsView } from "../../../examples/component-files.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { CASTER_MESHES, castersScene, type CastersScene } from "../../../nodes/definitions/shadow-casters.fixture.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { renderPassRuns } from "../plan.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1604b on a REAL device, to the byte (§V147): ONE DEVICE RENDER PASS PER RUN DRAWS THE
 * SAME FRAME as one per draw.
 *
 * A run is draws that were already adjacent and already drew over one another in that
 * order, so grouping them is supposed to move nothing. This is where that is held: every
 * picture below is rendered twice from one document — grouped, which is how every frame is
 * encoded now, and one pass per draw (`setExactPassTiming`), which is how every frame was
 * encoded before and is still encoded while someone has the performance panel open — and
 * the two must be the same bytes. If they were not, opening that panel would change the
 * picture.
 *
 * `render-pass-runs.test.ts` holds what no picture shows: how many passes the device was
 * asked for.
 *
 * NOT HERE, and said so: a multisampled target. Its draws are deliberately left a pass each
 * (`renderPassRuns` says what was measured), and no scene in this repository reproduces the
 * one-unit difference that rule is for — it was seen on a project's own kit, which is not
 * checked in. A test of it here would pass with the rule and without it. The rule itself is
 * held at the plan (`render-pass-runs.test.ts`).
 */

type Port = "out" | "depth" | "normal";

async function requireDawn(): Promise<void> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
}

const SETTINGS = (workingFormat: ProjectSettings["workingFormat"], size = 96): ProjectSettings => ({
  outputResolution: { width: size, height: size },
  workingFormat,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
});

/** One port of the fixture scene, both ways. `runs` is how many draws its largest device pass held when grouped. */
async function bothWays(options: CastersScene, port: Port, workingFormat: ProjectSettings["workingFormat"] = "rgba16float", frames = 2) {
  const render = async (exactPassTiming: boolean) => {
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: castersScene({ ...options, render: { depthOutput: true, normalOutput: true, ...options.render } }),
      settings: SETTINGS(workingFormat),
      frames,
      fps: 60,
      outputNodeId: "render_shot",
      outputPortId: port,
      sinks: [{ nodeId: "render_shot", portId: port }],
      meshes: CASTER_MESHES,
      ...(frames > 1 ? { animate: true } : {}),
      exactPassTiming,
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return result;
  };
  const exact = await render(true);
  const grouped = await render(false);
  const longest = Math.max(...renderPassRuns(grouped.plan.passes, grouped.plan.resources).map((run) => run.passIds.length));
  return { exact: exact.frames.at(-1)!.bytes, grouped: grouped.frames.at(-1)!.bytes, longest };
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
/** A picture that is one flat value proves nothing by being equal to itself: at least three different texels (rgba16float, 8 bytes each). */
const varied = (bytes: Uint8Array): boolean => new Set(Array.from({ length: bytes.length / 8 }, (_, texel) => Buffer.from(bytes.subarray(texel * 8, texel * 8 + 8)).toString("hex"))).size > 2;

describe("one device render pass per run draws the same frame (T1604b, §V147)", () => {
  it.each(["out", "depth", "normal"] as const)("the Render's %s output: two cube shadows, the colour and a layer, each one pass", async (port) => {
    await requireDawn();
    const { exact, grouped, longest } = await bothWays({}, port);
    // The claim is about runs that actually formed: a cube's six faces and their clear are 25 draws in one pass.
    expect(longest).toBe(25);
    expect(varied(grouped), `the ${port} output is a flat picture`).toBe(true);
    expect(same(grouped, exact), `the ${port} output differs between one pass per run and one pass per draw`).toBe(true);
  }, 120_000);

  it("additive light, drawn last into the colour's pass, adds what it added in a pass of its own", async () => {
    await requireDawn();
    // The lid as additive light: it is in the colour's run (after the opaque draws) and in no other.
    const { exact, grouped } = await bothWays({ geometry: { lid: { blend: "additive" } } }, "out");
    expect(same(grouped, exact)).toBe(true);
    // And it is there to be added: the picture is not the one without it.
    const without = await bothWays({ geometry: { lid: { blend: "additive", tint: [0, 0, 0, 1] } } }, "out");
    expect(same(grouped, without.grouped)).toBe(false);
  }, 120_000);

  it("a draw that comes into its light's reach mid-run is drawn in that run", async () => {
    await requireDawn();
    // T1598b's skip inside a run: the far cube's six draws are skipped on frame 0 and two of
    // them are not on frame 1, the frame read. Its shadow is on the floor either way of encoding.
    const arriving: CastersScene = { geometry: { far: { "translate.x": expressionSlot("-abstime * 60 * 27.5", 0) } } };
    const { exact, grouped } = await bothWays(arriving, "out");
    expect(same(grouped, exact)).toBe(true);
    const standing = await bothWays({ geometry: { far: { translate: [-27.5, 0, 0] } } }, "out");
    expect(same(grouped, standing.grouped)).toBe(true);
  }, 120_000);

});

/*
 * FIVE SHIPPED EXAMPLES WITH A RENDER, read by name (this is not a walk of the set): a
 * surface under a casting sun, a lit instanced field with occlusion, PBR under an
 * environment, beams and points, and a scene with a Depth output a room is composited by.
 */
describe("five shipped Render examples draw the same frame grouped and one pass per draw (T1604b)", () => {
  const registry = createNodeRegistry(allNodeDefinitions).view();

  async function example(fileName: string, exactPassTiming: boolean): Promise<{ bytes: Uint8Array; draws: number; runs: number }> {
    const text = readFileSync(new URL(`../../../../examples/${fileName}`, import.meta.url), "utf8");
    const loaded = loadProject(text, { nodes: registry });
    if (!loaded.ok) throw new Error(`${fileName} does not load`);
    const graph: GraphDocument = loaded.document.graph;
    const output = Object.values(graph.nodes).find((node) => node.type === "output");
    if (output === undefined) throw new Error(`${fileName} has no output`);
    const result = await renderHeadless({
      host: nodeGpuHost(),
      components: await starterComponentsView(),
      graph,
      settings: { ...loaded.document.settings, outputResolution: { width: 320, height: 180 } },
      frames: 3,
      outputNodeId: output.id,
      animate: true,
      exactPassTiming,
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return {
      bytes: result.frames.at(-1)!.bytes,
      draws: result.plan.passes.filter((pass) => pass.kind === "draw").length,
      runs: renderPassRuns(result.plan.passes, result.plan.resources).length,
    };
  }

  it.each(["E13-Prism", "E28-Sundial", "E33-Obol", "E69-Burnish", "E79-Crucible"])("%s", async (name) => {
    await requireDawn();
    const exact = await example(`${name}.loom.json`, true);
    const grouped = await example(`${name}.loom.json`, false);
    // Each of them has runs to group: fewer device passes than draws.
    expect([name, grouped.runs < grouped.draws]).toEqual([name, true]);
    expect(same(grouped.bytes, exact.bytes), `${name} differs between one pass per run and one pass per draw`).toBe(true);
  }, 180_000);
});
