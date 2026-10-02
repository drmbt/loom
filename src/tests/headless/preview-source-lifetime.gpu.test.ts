import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { ActiveSink, CompiledGraph } from "../../compiler/index.ts";
import { alice, contextFor } from "../../domain/commands/test-support.ts";
import { presetSession } from "../../domain/presets/test-support.ts";
import type { BackendCapabilities, FrameInputs } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { setListDocument } from "../../examples/documents/set-list.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { capturingHost, stubCanvas } from "../../runtime/backend/vgpu/preview-synthesis-fixture.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createPreviewSystem } from "../../runtime/previews/system.ts";
import { DEFAULT_PREVIEW_VIEW } from "../../runtime/previews/types.ts";
import type { PreviewRequest } from "../../runtime/previews/types.ts";

/**
 * B234 — A PREVIEW TILE WHOSE SOURCE THE MAIN PROGRAM DROPPED, THROUGH THE REAL STACK.
 *
 * The live report: after E82's first GO (`1 open`, which switches two layers off) Problems
 * showed `backend/frame-error` "Destroyed texture [layerFx.out.color0.resolve] used in a
 * submit", about one run in ten; the picture was right again a frame later.
 *
 * What outlives what: a preview tile's lens pass binds a target of the MAIN program. The
 * main recompile drops `layerFx.out` (a bypassed layer has no pass, so its output is the
 * stack below it) and destroys the texture. The preview program that still names it is the
 * editor's to replace, and the editor builds its requests from the plan it has ANNOUNCED —
 * React state, a commit behind the install. A preview tick that lands in between encodes
 * the lens pass over the destroyed texture; the device refuses the whole submit.
 *
 * That interleaving is forced here rather than raced: the real cue on the real bus, the
 * real compiler with the sink set the app compiles with (every previewed node), the vgpu
 * backend on Dawn, the real preview system — and one tick with the requests of the plan
 * from BEFORE the cue, after the plan from after it has been installed.
 *
 * Pictures are read from the tile targets and compared byte for byte (§V147): a tick is
 * right when every tile whose source still exists shows what a tick with fresh requests
 * shows, and the orphaned ones still show what they last drew.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();
const FPS = 60;
/** A tile's box on the shared surface, CSS px; the surface holds a 4 × 4 grid of them. */
const TILE = { width: 32, height: 18 } as const;
const SURFACE = { x: 0, y: 0, width: 4 * 40, height: 4 * 24 } as const;

/** Every node with a texture output is a preview sink — what the app compiles with. */
function previewSinks(graph: GraphDocument): ActiveSink[] {
  return Object.entries(graph.nodes).flatMap(([nodeId, node]) => {
    const port = registry.get(node.type)?.outputs.find((output) => output.type.kind === "texture2d");
    return port === undefined ? [] : [{ nodeId, portId: port.id, kind: "preview" as const }];
  });
}

function compile(graph: GraphDocument, settings: ProjectSettings, sinks: readonly ActiveSink[] = previewSinks(graph)): CompiledGraph {
  const plan = compileGraph({ graph, settings, registry, capabilities: CAPABILITIES, sinks });
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return plan;
}

/** One request per output row of `plan`, as the editor builds them from the announced plan. */
function requestsFor(plan: CompiledGraph): PreviewRequest[] {
  return [...plan.outputs]
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    .map((output, index) => ({
      ref: { nodeId: output.nodeId, portId: output.portId },
      source: { resourceId: output.resourceId, size: output.size, format: output.format, space: output.space },
      rect: { x: (index % 4) * 40, y: Math.floor(index / 4) * 24, ...TILE },
      area: TILE,
      view: DEFAULT_PREVIEW_VIEW,
      visible: true,
      collapsed: false,
      occluded: false,
      pinned: false,
      ...(output.synthesis === undefined ? {} : { synthesis: output.synthesis }),
    }));
}

function inputsAt(frameIndex: number, settings: ProjectSettings): FrameInputs {
  return {
    frame: {
      timeSeconds: frameIndex / FPS,
      deltaSeconds: 1 / FPS,
      frameIndex,
      mode: "realtime",
      randomSeed: settings.randomSeed,
      absTimeSeconds: frameIndex / FPS,
    },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [settings.outputResolution.width, settings.outputResolution.height],
  };
}

interface Stage {
  /** Installs `plan` in the main program and renders one main frame, as the frame loop does. */
  install(plan: CompiledGraph, frameIndex: number): Promise<void>;
  /** One preview tick over `requests`; returns each node's tile picture afterwards. */
  tick(requests: readonly PreviewRequest[], frameIndex: number): Promise<Map<string, Buffer>>;
  /** Everything the backend reported, as the Problems pane would be handed it. */
  reported(): Promise<string[]>;
  dispose(): void;
}

async function stage(settings: ProjectSettings): Promise<Stage> {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
  const { host, session } = capturingHost();
  const backend = createVgpuBackend({ host });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  await backend.initialize({});
  const active = session();
  if (active === undefined) throw new Error("the host produced no session");
  const device = active.gpu.gpu as unknown as GPUDevice;
  const handle = backend.previewHost(stubCanvas(device, SURFACE.width, SURFACE.height) as never);
  const previews = createPreviewSystem({ host: handle, capacity: 48 });
  return {
    async install(plan, frameIndex) {
      const compiled = await backend.compile(plan);
      backend.render(compiled, inputsAt(frameIndex, settings));
    },
    async tick(requests, frameIndex) {
      const { command } = previews.update({
        requests,
        frame: inputsAt(frameIndex, settings).frame,
        surface: SURFACE,
        devicePixelRatio: 1,
        previewFps: settings.previewFps,
        previewLongEdge: settings.previewLongEdge,
      });
      const tiles = new Map<string, Buffer>();
      for (const tile of command.composite) {
        tiles.set(String(tile.ref.nodeId), Buffer.from((await backend.readOutput(tile.resourceId)).bytes));
      }
      return tiles;
    },
    async reported() {
      await device.queue.onSubmittedWorkDone();
      // A validation verdict reaches the device's uncaptured path a turn after the submit.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return diagnostics.map((entry) => `${entry.severity} ${entry.code}: ${entry.message}`);
    },
    dispose() {
      handle.dispose();
      backend.dispose();
    },
  };
}

const tileOf = (tiles: ReadonlyMap<string, Buffer>, nodeId: string): Buffer => {
  const tile = tiles.get(nodeId);
  if (tile === undefined) throw new Error(`no tile for ${nodeId}`);
  return tile;
};

describe("B234 — a preview tile outliving its source in the main program", () => {
  it("E82 `1 open`: the tick before the editor's new requests raises nothing and still refreshes every other tile", async () => {
    const settings: ProjectSettings = { ...setListDocument.settings, outputResolution: { width: 160, height: 90 } };

    // The cue, the way the Show desk fires it: the real command on the real bus.
    const session = presetSession(structuredClone(setListDocument.graph), registry);
    const shipped = compile(session.graph(), settings);
    session.at({ epoch: "live", absTimeSeconds: 0 });
    const fired = await session.bus.execute("cue.go", { nodeId: "set" }, contextFor(alice));
    expect(fired.status).toBe("applied");
    const opened = compile(session.graph(), settings);
    // What the cue did to the plan: the two idle layers have no output of their own now.
    const sourceOf = (plan: CompiledGraph, nodeId: string) => plan.outputs.find((row) => row.nodeId === nodeId)?.resourceId;
    expect(sourceOf(shipped, "layerFx")).toBe("target:layerFx:out");
    expect(sourceOf(opened, "layerFx")).toBe(sourceOf(opened, "layerRings"));
    expect(sourceOf(opened, "layerGrid")).toBe(sourceOf(opened, "layerRings"));
    const orphaned = new Set(["layerFx", "layerGrid"]);

    const live = await stage(settings);
    try {
      await live.install(shipped, 0);
      const before = await live.tick(requestsFor(shipped), 0);
      expect(before.size).toBe(shipped.outputs.length);

      // The install lands; the editor has not committed the plan it announces yet.
      await live.install(opened, 120);
      const stale = await live.tick(requestsFor(shipped), 120);
      expect(await live.reported()).toEqual([]);

      // The editor catches up: requests of the installed plan, same main frame.
      const fresh = await live.tick(requestsFor(opened), 120);
      expect(await live.reported()).toEqual([]);

      // §V854: two seconds moved the picture, so "equal to the fresh tick" below is not
      // "nothing was drawn at all" — which is what a refused submit leaves behind.
      expect(tileOf(fresh, "tear").equals(tileOf(before, "tear"))).toBe(false);
      for (const nodeId of stale.keys()) {
        if (orphaned.has(nodeId)) {
          // Its source is gone: the tile holds the last picture it drew.
          expect(tileOf(stale, nodeId).equals(tileOf(before, nodeId)), nodeId).toBe(true);
        } else {
          // Its source is still there: the stale tick drew what a correct tick draws.
          expect(tileOf(stale, nodeId).equals(tileOf(fresh, nodeId)), nodeId).toBe(true);
        }
      }
      // And with the new requests a switched-off layer shows the stack below it.
      expect(tileOf(fresh, "layerFx").equals(tileOf(fresh, "layerRings"))).toBe(true);
      expect(tileOf(fresh, "layerGrid").equals(tileOf(fresh, "layerRings"))).toBe(true);
    } finally {
      live.dispose();
    }
  }, 120_000);

  it("a watched pointset whose node is deleted: its splat is not drawn over destroyed storage", async () => {
    const settings: ProjectSettings = { ...setListDocument.settings, outputResolution: { width: 64, height: 64 }, workingFormat: "rgba8unorm" };
    const graph = (color: number, withPoints: boolean): GraphDocument => ({
      revision: 1,
      nodes: {
        ...(withPoints
          ? { gen: { id: "gen", type: "pointLine", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 16, sizeX: 2 } } }
          : {}),
        solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 200 }, parameters: { color: [color, color, color, 1] } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 200, y: 200 }, parameters: {} },
      },
      edges: { e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
      groups: {},
    });
    const watched = compile(graph(0.25, true), settings, [
      { nodeId: "gen", portId: "out", kind: "preview" },
      { nodeId: "solid", portId: "out", kind: "preview" },
    ]);
    expect(watched.outputs.find((row) => row.nodeId === "gen")?.synthesis).toBeDefined();
    // The points node is deleted, and the Solid changes colour so a refresh is visible.
    const deleted = compile(graph(0.75, false), settings, [{ nodeId: "solid", portId: "out", kind: "preview" }]);

    const live = await stage(settings);
    try {
      await live.install(watched, 0);
      const before = await live.tick(requestsFor(watched), 0);
      // §V854: the splat drew something, so "held its last picture" is a claim about ink.
      expect(tileOf(before, "gen").some((byte) => byte !== 0)).toBe(true);

      await live.install(deleted, 120);
      const stale = await live.tick(requestsFor(watched), 120);
      expect(await live.reported()).toEqual([]);
      const fresh = await live.tick(requestsFor(deleted), 120);
      expect(await live.reported()).toEqual([]);

      expect(tileOf(fresh, "solid").equals(tileOf(before, "solid"))).toBe(false);
      expect(tileOf(stale, "solid").equals(tileOf(fresh, "solid"))).toBe(true);
      expect(tileOf(stale, "gen").equals(tileOf(before, "gen"))).toBe(true);
    } finally {
      live.dispose();
    }
  }, 120_000);
});
