import v8 from "node:v8";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { fixturePlan } from "./plan-fixture.ts";
import { createPreviewSystem } from "../../previews/system.ts";
import { DEFAULT_PREVIEW_VIEW } from "../../previews/types.ts";
import type { PreviewRequest } from "../../previews/types.ts";
import type { PassDescriptor } from "../plan.ts";
import type { FrameEvaluationInput } from "../../../domain/types/frame.ts";

/**
 * T1180 — GPUBindGroup OBJECTS MUST NOT ACCUMULATE OVER A SESSION.
 *
 * §T1174 measured the leak with a closed-loop camera: cycle N does byte-identical work to
 * cycle 1, so cycle 1 is the control for cycle N in the same run on the same machine. Its
 * observable was `createBindGroup` CALLS, and that is the wrong one for the fix — a rebuilt
 * program mints new bind groups either way. What leaks is the RETAINED set: entries the
 * gpu's one bind-group cache can never reach again.
 *
 * So this measures reachability. Every GPUBindGroup the mock returns is held only by a
 * WeakRef; after a forced GC the survivors are exactly the ones vgpu's cache still holds.
 * The mock's own descriptor arrays are dropped first — it retains every descriptor it was
 * ever handed, and that harness-only growth is what sold §T1174's first run a 2.65x curve
 * that was 100% artefact.
 *
 * Both tests carry a SAME-RUN CONTROL (§V929): the identical scenario runs once with every
 * bind group PINNED by the harness, which is what a cache that never lets go looks like to
 * this measurement. The control must grow, or the WeakRef count cannot see a leak and the
 * green means nothing; the real run must be flat while it keeps minting bind groups.
 *
 * T1705b: through vgpu 0.5.0 the control was vgpu itself with Loom's `evictBindGroups` patch
 * removed, and it leaked. vgpu 0.6.0 keeps its bind groups per consumer in a weak, bounded
 * cache and drops an entry when a resource it names is destroyed, so the patch and the
 * backend's eviction calls are gone and this gate now holds upstream to that behaviour.
 *
 * The two leak shapes are different and both are here:
 *
 *  - a LIVE drawable whose binding slot ROTATES (the tile blit, re-pointed at every tile of
 *    every composite). Through 0.5.0 the eviction subscription followed the SLOT, so
 *    `set()`ing the next tile unsubscribed the previous one and its cache entry outlived the
 *    target's destroy.
 *  - a DISCARDED drawable whose bound resources SURVIVE (a shader edit on a pass with no
 *    uniform block). Nothing it names is destroyed, so through 0.5.0 nothing evicted it.
 */

/**
 * A precise GC, without demanding `--expose-gc` of the whole suite.
 *
 * The alternative is `execArgv` in `vitest.workspace.ts`, which every other project and
 * track pays for. `setFlagsFromString` + a fresh context is the local equivalent and the
 * flag is turned straight back off.
 */
function exposeGc(): () => void {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as unknown;
  v8.setFlagsFromString("--no-expose-gc");
  if (typeof gc !== "function") throw new Error("could not obtain a GC handle for the retention measurement");
  return gc as () => void;
}

interface Retention {
  /** Live GPUBindGroups after each measured step. */
  readonly samples: readonly number[];
  readonly created: number;
}

/**
 * Wraps the live mock device so every bind group it mints is held ONLY by a WeakRef. With
 * `pin`, the harness holds each one strongly as well: the control, a cache that keeps all.
 */
function trackBindGroups(host: ReturnType<typeof mockGpuHost>, pin: boolean): {
  retained: (gc: () => void) => Promise<number>;
  created: () => number;
} {
  const device = host.device as unknown as { createBindGroup: (descriptor: unknown) => object };
  const original = device.createBindGroup.bind(device);
  const refs: Array<WeakRef<object>> = [];
  const pinned: object[] = [];
  let created = 0;
  device.createBindGroup = (descriptor: unknown): object => {
    const bindGroup = original(descriptor);
    created += 1;
    refs.push(new WeakRef(bindGroup));
    if (pin) pinned.push(bindGroup);
    return bindGroup;
  };
  return {
    created: () => created,
    retained: async (gc: () => void): Promise<number> => {
      const instrumentation = host.instrumentation as unknown as Record<string, unknown>;
      for (const value of Object.values(instrumentation)) if (Array.isArray(value)) value.length = 0;
      for (let pass = 0; pass < 4; pass += 1) {
        gc();
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
      return refs.filter((ref) => ref.deref() !== undefined).length;
    },
  };
}

function frameInput(index: number): FrameEvaluationInput {
  return { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: "realtime", randomSeed: 1 };
}

const SURFACE = { x: 0, y: 0, width: 1600, height: 1000 };
const NODES = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, x: (i % 8) * 320, y: Math.floor(i / 8) * 260 }));
const CYCLE_FRAMES = 150;

/** Closed loop: step CYCLE_FRAMES returns the camera exactly to step 0. */
function requestsFor(step: number): PreviewRequest[] {
  const t = (step / CYCLE_FRAMES) * Math.PI * 2;
  const cam = { x: 500 + Math.cos(t) * 500, y: 400 + Math.sin(t) * 300, zoom: 0.85 + Math.sin(t) * 0.45 };
  return NODES.map((node) => {
    const width = 220 * cam.zoom;
    const height = 150 * cam.zoom;
    const x = (node.x - cam.x) * cam.zoom + SURFACE.width / 2;
    const y = (node.y - cam.y) * cam.zoom + SURFACE.height / 2;
    return {
      ref: { nodeId: node.id, portId: "out" },
      source: { resourceId: "output", size: [64, 64], format: "rgba8unorm", space: "linear" },
      rect: { x, y, width, height },
      area: { width: 220, height: 150 },
      visible: x + width > 0 && y + height > 0 && x < SURFACE.width && y < SURFACE.height,
      pinned: false,
      collapsed: false,
      occluded: false,
      view: DEFAULT_PREVIEW_VIEW,
    } as PreviewRequest;
  });
}

/** A canvas stub that recycles ONE surface texture — a fresh one per present is harness growth. */
function previewCanvas(host: ReturnType<typeof mockGpuHost>): Parameters<ReturnType<typeof createVgpuBackend>["previewHost"]>[0] {
  let surfaceTexture: GPUTexture | undefined;
  const context = {
    configure() {},
    unconfigure() {},
    getCurrentTexture: () => {
      const device = host.device;
      if (!device) throw new Error("no live mock device");
      surfaceTexture ??= device.createTexture({
        size: [SURFACE.width, SURFACE.height],
        format: "rgba8unorm",
        usage: ["render_attachment", "texture_binding"] as unknown as GPUTextureUsageFlags,
      });
      return surfaceTexture;
    },
  };
  return {
    width: SURFACE.width,
    height: SURFACE.height,
    getContext: (kind: string) => (kind === "webgpu" ? context : null),
  } as unknown as Parameters<ReturnType<typeof createVgpuBackend>["previewHost"]>[0];
}

/** Pans the closed-loop camera for `cycles` identical cycles, sampling retention per cycle. */
async function panScenario(gc: () => void, cycles: number, pin = false): Promise<Retention> {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  await backend.initialize({});
  const track = trackBindGroups(host, pin);
  const plan = await backend.compile(fixturePlan());
  backend.render(plan, { frame: frameInput(0), pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64] } as never);
  const system = createPreviewSystem({ host: backend.previewHost(previewCanvas(host)), capacity: 16 });

  const samples: number[] = [];
  let index = 0;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (let step = 0; step < CYCLE_FRAMES; step += 1) {
      system.update({
        requests: requestsFor(step),
        frame: frameInput(index),
        surface: SURFACE,
        devicePixelRatio: 2,
        previewFps: 15,
        previewLongEdge: 192,
      });
      index += 1;
    }
    samples.push(await track.retained(gc));
  }
  backend.dispose();
  return { samples, created: track.created() };
}

/**
 * Recompiles one effect pass whose bindings all SURVIVE the edit.
 *
 * `composite` binds a sampler, a ping-pong and a target and carries NO uniform block, so a
 * shader-only edit replaces the Effect while every resource it named lives on. `generate`
 * cannot show this: its per-pass uniform block dies with the pass and vgpu reclaims the
 * entry as a side effect of that destroy.
 */
async function editScenario(gc: () => void, edits: number, pin = false): Promise<Retention> {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  await backend.initialize({});
  const track = trackBindGroups(host, pin);

  const samples: number[] = [];
  for (let edit = 0; edit < edits; edit += 1) {
    const base = fixturePlan();
    const passes = (base.passes as ReadonlyArray<PassDescriptor>).map((pass) =>
      pass.id === "composite" && pass.kind === "effect"
        ? { ...pass, shader: edit % 2 === 0 ? pass.shader : pass.shader.replace("return textureSample", "return 1.0 * textureSample") }
        : pass,
    );
    const plan = await backend.compile({ ...base, passes } as never);
    backend.render(plan, { frame: frameInput(edit), pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64] } as never);
    samples.push(await track.retained(gc));
  }
  backend.dispose();
  return { samples, created: track.created() };
}

/** The retention a run would show if nothing were ever released: every sample after the first grows. */
function growth(retention: Retention): number {
  return retention.samples[retention.samples.length - 1]! - retention.samples[1]!;
}

describe("bind-group cache entries do not accumulate over a session (T1180, §T1174)", () => {
  it("a live blit re-pointed at every tile keeps a BOUNDED set of bind groups across identical camera cycles", async () => {
    const gc = exposeGc();
    // The control must LEAK, or the measurement proves nothing. §T1174's camera loop makes
    // every cycle byte-identical, so any growth after the first is objects nothing released.
    expect(growth(await panScenario(gc, 3, true))).toBeGreaterThan(0);

    const run = await panScenario(gc, 5);
    // Not "grows more slowly": no cycle after the second holds more than the second did. It may
    // hold one fewer: vgpu keeps a captured entry until a page's frame AND the one before it
    // left it unused (fork PR #9), so cycle 2's last frame can still hold one cycle 3 has let go.
    expect(Math.max(...run.samples.slice(2))).toBeLessThanOrEqual(run.samples[1]!);
    // And flat while minting: a scenario that stopped creating bind groups would be flat too.
    expect(run.created).toBeGreaterThan(run.samples[1]! * 5);
  }, 60_000);

  it("an effect discarded while every resource it bound survives takes its bind groups with it", async () => {
    const gc = exposeGc();
    expect(growth(await editScenario(gc, 6, true))).toBeGreaterThan(0);

    const run = await editScenario(gc, 12);
    expect(Math.max(...run.samples.slice(2))).toBeLessThanOrEqual(run.samples[1]!);
    expect(run.created).toBeGreaterThan(run.samples[1]!);
  }, 60_000);
});
