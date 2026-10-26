import { describe, expect, it } from "vitest";
import { compileGraph } from "@compiler/compile.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { DEFAULT_PROJECT_SETTINGS, type GraphDocument } from "@domain/types/graph.ts";
import { parseClipTrack, serializeClipTrack, newRegion, type ClipTrack } from "@domain/regions/model.ts";
import { TICKS_PER_SECOND as S } from "@domain/time/ticks.ts";
import { allNodeDefinitions, mediaSourceIdFor } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { MediaSource } from "@runtime/backend/index.ts";
import { nodeGpuHost, probeDawn } from "@runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "@runtime/backend/vgpu/vgpu-backend.ts";
import { createClipTrackPlayer } from "./clip-track-player.ts";
import type { PresentableMedia } from "./media-playback.ts";
import type { MediaElement } from "./media-sources.ts";

/**
 * VN101 GATE — a Clip Track, through the compiler, the vgpu backend and Dawn, shows the
 * right region at the right source time, and nothing in a gap.
 *
 * The decode is the one thing stood in for: Dawn has no `<video>`. Each "element" is a
 * structural stand-in whose seek completes a task later (as a browser's does, with `seeked`
 * and a presented-frame callback) and whose frame is a solid colour naming its clip AND the
 * half of the clip it is on — clip A is red in its first half second and magenta in its
 * second, clip B is green — so a pixel says which region played and where in its source.
 * Everything else is the product: the node's compile, the plan, the external-texture upload,
 * the fitted blit, and the player's pool, pre-seek and gap frame.
 */

const SIZE = 4;
const OUT = 8;

function element(url: string) {
  const listeners = new Map<string, Set<() => void>>();
  const callbacks: Array<() => void> = [];
  let target = 0;
  const self = {
    url, videoWidth: SIZE, videoHeight: SIZE, duration: 1, playbackRate: 1, paused: true, seeking: false, readyState: 4,
    presented: 0,
    get currentTime() { return target; },
    set currentTime(value: number) {
      target = value;
      self.seeking = true;
      setTimeout(() => {
        self.presented = value;
        self.seeking = false;
        for (const listener of [...(listeners.get("seeked") ?? [])]) listener();
        for (const callback of callbacks.splice(0)) callback();
      }, 1);
    },
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
    requestVideoFrameCallback(callback: () => void) { callbacks.push(callback); return callbacks.length; },
    play() { self.paused = false; },
    pause() { self.paused = true; },
  };
  return self;
}

type Fake = ReturnType<typeof element>;

/** The decoded frame of a stand-in: its clip's colour at the time it last PRESENTED. */
function solid(fake: Fake): Uint8Array {
  const colour = fake.url === "clip-b"
    ? [0, 255, 0, 255]
    : fake.presented < 0.5 ? [255, 0, 0, 255] : [255, 0, 255, 255];
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) bytes.set(colour, i * 4);
  return bytes;
}

const TRACK: ClipTrack = {
  version: 1, id: "t", name: "t",
  regions: [
    // A: one second of source, looped for three seconds of timeline.
    newRegion("a", "clip-a", { sourceIn: 0, sourceOut: S, timelineStart: 0, length: 3 * S, playMode: "loop" }),
    // B: after a one-second gap, one second.
    newRegion("b", "clip-b", { sourceIn: 0, sourceOut: S, timelineStart: 4 * S, length: S, playMode: "onceHold" }),
  ],
};

describe("VN101 clip track through the real stack (Dawn)", () => {
  it("renders A, A's loop repeat, a transparent gap, B and transparent after, each at its exact source half", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn is unavailable: ${probe.error ?? "unknown"}`);
    expect(parseClipTrack(serializeClipTrack(TRACK)).ok).toBe(true);

    const graph: GraphDocument = {
      revision: 1, groups: {}, edges: {},
      nodes: {
        track: {
          id: "track", type: "clipTrack", definitionVersion: 1, position: { x: 0, y: 0 },
          parameters: { track: serializeClipTrack(TRACK), imageFit: "stretch" },
          resolution: { mode: "fixed", width: OUT, height: OUT },
          format: { mode: "fixed", format: "rgba8unorm" },
        },
      },
    } as unknown as GraphDocument;
    const capabilities: BackendCapabilities = {
      tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float"],
      timestampQuery: false, limits: { maxTextureDimension2D: 8192 },
    };
    const plan = compileGraph({
      graph, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities,
      settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width: OUT, height: OUT } },
      sinks: [{ nodeId: "track", kind: "readback" }],
    });
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const resources = plan.resources.map((resource) => resource["kind"] === "externalTexture"
      ? { ...resource, size: [SIZE, SIZE] } : resource);

    const opened: Fake[] = [];
    const player = createClipTrackPlayer({
      open: async (url) => {
        const fake = element(url);
        opened.push(fake);
        return fake as unknown as MediaElement & PresentableMedia;
      },
      blank: () => ({ bytes: new Uint8Array(SIZE * SIZE * 4) }),
      release: (released) => released.pause(),
      frames: (opened) => {
        const fake = opened as unknown as Fake;
        let id = 0;
        let seen = -1;
        const source: MediaSource = {
          currentFrame() {
            if (fake.presented !== seen) {
              seen = fake.presented;
              id += 1;
            }
            return { frameId: id, bytes: solid(fake) };
          },
        };
        return { source, dispose() {} };
      },
    });

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile({ ...plan, resources });
      backend.registerMediaSource(mediaSourceIdFor("track"), player.source);
      const at = async (seconds: number): Promise<number[]> => {
        const frame: FrameEvaluationInput = {
          timeSeconds: seconds, deltaSeconds: 1 / 30, frameIndex: Math.round(seconds * 30), mode: "offline", randomSeed: 1, fps: 30,
        };
        // A take's order: prepare (VNB19's seam), the step's sync, the render.
        await player.prepare(frame, TRACK, 120);
        player.sync(frame, TRACK, 120);
        backend.render(compiled, { frame, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [OUT, OUT] });
        const output = await backend.readOutput("target:track:out");
        const centre = ((OUT / 2) * OUT + OUT / 2) * 4;
        return [...output.bytes.slice(centre, centre + 4)];
      };

      const RED = [255, 0, 0, 255];
      const MAGENTA = [255, 0, 255, 255];
      const GREEN = [0, 255, 0, 255];
      const CLEAR = [0, 0, 0, 0];
      expect(await at(0.2)).toEqual(RED); // A, source 0.2 s
      expect(await at(0.7)).toEqual(MAGENTA); // A, source 0.7 s
      expect(await at(2.2)).toEqual(RED); // A's second loop repeat, source 0.2 s again
      expect(await at(1.7)).toEqual(MAGENTA); // back in time: a scrub lands exactly too
      expect(await at(3.5)).toEqual(CLEAR); // the gap
      expect(await at(4.2)).toEqual(GREEN); // B
      expect(await at(4.9)).toEqual(GREEN);
      expect(await at(6)).toEqual(CLEAR); // after the last region
      expect(player.showing()).toBeNull();
    } finally {
      player.dispose();
      backend.dispose();
    }
  }, 30_000);
});
