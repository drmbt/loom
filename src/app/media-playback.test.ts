import { describe, expect, it } from "vitest";

import {
  SEEK_TOLERANCE_SECONDS,
  applyMediaPlayhead,
  createMediaTransportRunner,
  durationOf,
  playableMedia,
  LOCK_RESYNC_SECONDS,
  type MediaSteppedTransport,
  type MediaTransportContext,
  type PlayableMedia,
} from "./media-playback.ts";
import { createMediaControlRegistry } from "./media-commands.ts";
import { createMovieAudioPlayback, type MovieAudioOutput } from "./movie-audio-playback.ts";
import { MEDIA_OPEN_TIMEOUT_MS, awaitMediaReady } from "./media-sources.ts";
import { mediaPlayhead, type MediaTransportValues } from "@domain/media/transport.ts";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { buildMorphIndex } from "@domain/presets/morph-index.ts";
import { presetBankNode, presetSession } from "@domain/presets/test-support.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";

/**
 * T493 — THE REACH: does the transport actually move a `<video>`?
 *
 * This file exists because of the class of bug this codebase has hit six times (B12, B23,
 * T264, B87 …): a feature built, unit-tested and never wired, with every suite green. The
 * arithmetic is gated next door in `domain/media/transport.test.ts`; what is gated HERE is
 * that a resolved parameter reaches an element, and that the element is corrected only
 * when it has actually drifted.
 */

const BASE: MediaTransportValues = {
  playMode: "timeline",
  play: true,
  speed: 1,
  cue: false,
  cuePoint: 0,
  trimStart: 0,
  trimEnd: 0,
  extend: "loop",
};

/** A `<video>`'s observable surface, and a log of what was done to it. */
function fakeElement(duration = 10, at = 0) {
  const calls: string[] = [];
  let paused = true;
  let currentTime = at;
  const element: PlayableMedia & { readonly calls: readonly string[] } = {
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      calls.push(`seek:${value}`);
    },
    playbackRate: 1,
    get duration() {
      return duration;
    },
    get paused() {
      return paused;
    },
    play() {
      paused = false;
      calls.push("play");
    },
    pause() {
      paused = true;
      calls.push("pause");
    },
    calls,
  };
  return element;
}

describe("T493 — the element is corrected on DRIFT, not every frame", () => {
  /*
   * A continuous frame plays at the RUNNER's rate and never seeks, however far off it is:
   * the runner holds the history a calm correction needs (§T1549b) and decides when a
   * drift is worth its one seek. The startup-lag case this used to cover through a bare
   * loop now runs through the real chain below ("a decoder that re-buffers after every
   * seek"), because the decision it gated moved into the runner.
   */
  it("a continuous frame writes the runner's correction and does not seek, at any drift", () => {
    const element = fakeElement(60, 2);
    expect(applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 3, 60), true, 0.03)).toBe(false);
    expect(element.playbackRate).toBe(1.03);
    expect(element.calls).toEqual(["play"]);
    // A door that dropped the correction is told so rather than playing uncorrected.
    expect(() => applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 3, 60), true)).toThrow(/correction/);
  });

  it("a deliberate discontinuity seeks exactly even inside the ordinary drift tolerance", () => {
    const element = fakeElement(10, 3);
    const head = mediaPlayhead(BASE, 3.05, 10);
    expect(applyMediaPlayhead(element, BASE, head, false)).toBe(true);
    expect(element.currentTime).toBe(head.position);
  });

  it("plays and does not seek while it is already where the playhead says", () => {
    const element = fakeElement(10, 3);
    const seeked = applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 3, 10));
    expect(seeked).toBe(false);
    expect(element.calls).toEqual(["play"]);
  });

  it("tolerates a small drift — otherwise every decode hiccup re-seeks the decoder", () => {
    const element = fakeElement(10, 3);
    const drift = SEEK_TOLERANCE_SECONDS / 2;
    expect(applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 3 + drift, 10))).toBe(false);
    expect(element.calls.filter((call) => call.startsWith("seek"))).toEqual([]);
  });

  it("corrects a large drift to EXACTLY the derived position", () => {
    const element = fakeElement(10, 3);
    applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 7.5, 10));
    expect(element.currentTime).toBe(7.5);
  });

  it("A LAP is that same correction, with no special case: 9.9 → 0.4 is one seek", () => {
    const element = fakeElement(10, 9.9);
    // t = 10.4 into a 10s window: the derived position has wrapped to 0.4.
    applyMediaPlayhead(element, BASE, mediaPlayhead(BASE, 10.4, 10));
    expect(element.currentTime).toBeCloseTo(0.4, 10);
  });

  it("carries SPEED to the element's own playbackRate rather than seeking per frame", () => {
    const element = fakeElement(10, 0);
    const fast = { ...BASE, speed: 2 };
    applyMediaPlayhead(element, fast, mediaPlayhead(fast, 0, 10));
    expect(element.playbackRate).toBe(2);
  });

  it("clamps a rate the browser would refuse instead of throwing at it", () => {
    const element = fakeElement(10, 0);
    const crawl = { ...BASE, speed: 0.001 };
    applyMediaPlayhead(element, crawl, mediaPlayhead(crawl, 0, 10));
    expect(element.playbackRate).toBe(0.0625);
  });
});

describe("T493 — held states PAUSE the element, because the position no longer advances with it", () => {
  it("a cue pauses and lands on the exact point, with no tolerance", () => {
    const element = fakeElement(10, 3);
    const cued = { ...BASE, cue: true, cuePoint: 3.05 };
    applyMediaPlayhead(element, cued, mediaPlayhead(cued, 99, 10));
    expect(element.paused).toBe(true);
    // Inside the drift tolerance, and still seeked: a cue is a scrub, and a scrub that
    // lands "close enough" is the wrong frame.
    expect(element.currentTime).toBe(3.05);
  });

  it("a NEGATIVE speed pauses and steps by hand — no browser plays a reverse rate", () => {
    const element = fakeElement(10, 0);
    const back = { ...BASE, speed: -1 };
    applyMediaPlayhead(element, back, mediaPlayhead(back, 1, 10));
    expect(element.paused).toBe(true);
    expect(element.currentTime).toBe(9);
    expect(element.playbackRate).toBe(1);
  });

  it("a stopped FREE-RUN transport holds; a stopped play under the LOCK does not (it is inactive)", () => {
    const stopped = { ...BASE, playMode: "freeRun" as const, play: false };
    const freeRun = fakeElement(10, 2);
    applyMediaPlayhead(freeRun, stopped, mediaPlayhead(stopped, 2, 10));
    expect(freeRun.paused).toBe(true);

    // Same `play: false`, locked to the timeline: §V146 says the control cannot act, and
    // the element must therefore keep running with the timeline that is still running.
    const locked = fakeElement(10, 2);
    const lockedTransport = { ...BASE, play: false };
    applyMediaPlayhead(locked, lockedTransport, mediaPlayhead(lockedTransport, 2, 10));
    expect(locked.paused).toBe(false);
  });

  it("an extend:black window past its end goes silent AND stops", () => {
    const element = fakeElement(10, 9);
    const black = { ...BASE, extend: "black" as const };
    const head = mediaPlayhead(black, 13, 10);
    expect(head.visible).toBe(false);
    applyMediaPlayhead(element, black, head);
    expect(element.paused).toBe(true);
  });

  it("Hold Last pauses at the out point rather than playing beyond a trimmed window", () => {
    const element = fakeElement(10, 2);
    const hold = { ...BASE, extend: "hold" as const, trimEnd: 2 };
    applyMediaPlayhead(element, hold, mediaPlayhead(hold, 3, 10), true);
    expect(element.paused).toBe(true);
    expect(element.currentTime).toBe(2);
  });

  it("a collapsed known trim window holds, while unknown metadata still allows playback", () => {
    const collapsed = { ...BASE, trimStart: 2, trimEnd: 2 };
    const element = fakeElement(10);
    applyMediaPlayhead(element, collapsed, mediaPlayhead(collapsed, 3, 10), true);
    expect(element.paused).toBe(true);
    expect(element.currentTime).toBe(2);
    for (const duration of [0, Infinity]) {
      const unknown = fakeElement(duration);
      applyMediaPlayhead(unknown, BASE, mediaPlayhead(BASE, 0, 0), true, 0);
      expect(unknown.paused).toBe(false);
    }
  });

  it("a fractional cue only seeks once when the native clock reports microsecond precision", () => {
    const element = fakeElement(10);
    let nativeTime = 0;
    let writes = 0;
    Object.defineProperty(element, "currentTime", {
      get: () => nativeTime,
      set: (value: number) => { nativeTime = Math.round(value * 1e6) / 1e6; writes++; },
    });
    const cue = { ...BASE, cue: true, cuePoint: 1 / 3 };
    const head = mediaPlayhead(cue, 0, 10);
    for (let frame = 0; frame < 60; frame++) applyMediaPlayhead(element, cue, head, false);
    expect(writes).toBe(1);
    expect(element.paused).toBe(true);
    expect(Math.abs(nativeTime - head.position)).toBeLessThan(1e-6);
  });
});

describe("T493 — the runner reads the node's REAL parameters, through the real resolver", () => {
  const registry = createNodeRegistry(allNodeDefinitions);
  const frame = (timeSeconds: number): FrameEvaluationInput => ({
    timeSeconds,
    deltaSeconds: 1 / 60,
    frameIndex: Math.round(timeSeconds * 60),
    mode: "realtime",
    randomSeed: 1,
  });

  const graphWith = (parameters: Record<string, unknown>): GraphDocument =>
    ({
      revision: 1,
      nodes: {
        m: {
          id: "m",
          type: "movieFileIn",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters,
        },
      },
      edges: {},
    }) as unknown as GraphDocument;

  const runnerFor = (graph: GraphDocument) =>
    createMediaTransportRunner("m", {
      graph: () => graph,
      registry,
      channels: () => undefined,
      morphs: () => undefined,
    });

  it("marks ordinary playback continuous and cue pulses, trims, scrubs and laps as discontinuities", () => {
    const graph = graphWith({ playMode: "timeline" });
    const runner = runnerFor(graph);
    expect(runner.step(frame(0), 10, null)?.continuous).toBe(false);
    expect(runner.step(frame(1 / 60), 10, null)?.continuous).toBe(true);
    expect(runner.step(frame(3), 10, null)?.continuous).toBe(false);
    expect(runner.step(frame(3 + 1 / 60), 10, null)?.continuous).toBe(true);
    graph.nodes["m"]!.parameters["trimStart"] = 1;
    expect(runner.step(frame(3 + 2 / 60), 10, null)?.continuous).toBe(false);
    runner.reset();
    expect(runner.step(frame(8.99), 10, null)?.continuous).toBe(false);
    expect(runner.step({ ...frame(9.01), deltaSeconds: 0.02 }, 10, null)?.continuous).toBe(false);
    graph.nodes["m"]!.parameters["playMode"] = "freeRun";
    graph.nodes["m"]!.parameters["cuePoint"] = 2;
    runner.reset();
    runner.step(frame(0), 10, null);
    expect(runner.step(frame(1 / 60), 10, null)?.continuous).toBe(true);
    runner.cue();
    expect(runner.step(frame(2 / 60), 10, null)?.continuous).toBe(false);
    expect(runner.step(frame(3 / 60), 10, null)?.continuous).toBe(true);
    runner.step({ ...frame(4 / 60), mode: "offline" }, 10, null);
    expect(runner.step(frame(5 / 60), 10, null)?.continuous).toBe(false);
  });

  it("a node with NO transport parameters stored reads the manifest default, which T586 moved to free run", () => {
    const stepped = runnerFor(graphWith({})).step(frame(2), 10, null);
    expect(stepped?.transport.playMode).toBe("freeRun");
  });

  /**
   * T586's CONSEQUENCE, which is the assertion that matters — "the default is free run"
   * is trivially true the moment the literal is edited and would pass on a flip that did
   * nothing (§V461: a fixture must be able to distinguish what it asserts).
   *
   * The owner's actual complaint is that a freshly dropped-in file DOES NOTHING until the
   * timeline runs. So: hold the TIMELINE clock still — `timeSeconds` never moves, which is
   * exactly a stopped transport — and feed real frame deltas. A free-run node advances
   * anyway; a timeline-locked one is pinned. Under T493's default this test reads 0.
   */
  it("a freshly instantiated node advances its playhead with the TIMELINE STOPPED — the owner's ask", () => {
    const runner = runnerFor(graphWith({}));
    // Same `timeSeconds` every frame: the timeline is not moving. Only the delta is real.
    const stopped = (): FrameEvaluationInput => ({ ...frame(0), deltaSeconds: 1 / 60 });
    const positions = [1, 2, 3, 4].map(() => runner.step(stopped(), 10, null)?.head.position ?? -1);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1] as number);
    }
    expect(positions[3]).toBeCloseTo(4 / 60, 6);
  });

  it("...and under the LOCK the same node is pinned, which is the cost the flip buys off", () => {
    // The counter-example that proves the test above is measuring the mode and not the
    // clock: identical frames, `playMode` opted back to the lock, and nothing moves.
    const runner = runnerFor(graphWith({ playMode: "timeline" }));
    const stopped = (): FrameEvaluationInput => ({ ...frame(0), deltaSeconds: 1 / 60 });
    const positions = [1, 2, 3, 4].map(() => runner.step(stopped(), 10, null)?.head.position ?? -1);
    expect(positions).toEqual([0, 0, 0, 0]);
  });

  /*
   * The parameter-plumbing trio below pins `playMode: "timeline"` EXPLICITLY. They are
   * about §V107 — that a static, an expression and a driven value each reach the playhead
   * — and they used to lean on the default to make `elapsed === frame.timeSeconds`. T586
   * moved that default out from under them, which is the right lesson to bank: a test
   * whose arithmetic depends on a mode should say which mode.
   */

  it("a STATIC speed reaches the playhead", () => {
    const stepped = runnerFor(graphWith({ speed: 3, playMode: "timeline" })).step(frame(2), 10, null);
    expect(stepped?.head.position).toBe(6);
  });

  it("an EXPRESSION on trimStart reaches it too — every mode, like everything else (§V107)", () => {
    // The assertion that the transport is not a bespoke widget: nothing in the transport
    // code knows what an expression is, and one works anyway.
    const stepped = runnerFor(
      graphWith({
        playMode: "timeline",
        trimStart: {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "1 + 2" } },
        },
      }),
    ).step(frame(0.5), 10, null);
    expect(stepped?.head.start).toBe(3);
    expect(stepped?.head.position).toBe(3.5);
  });

  it("a DRIVEN speed reaches it through the value graph's resolver", () => {
    const graph = graphWith({
      playMode: "timeline",
      speed: { mode: "driven", bindings: { driven: { kind: "driven", channel: "rate" } } },
    });
    const runner = createMediaTransportRunner("m", {
      graph: () => graph,
      registry,
      channels: () => (channel) => (channel === "rate" ? 4 : undefined),
      morphs: () => undefined,
    });
    expect(runner.step(frame(2), 10, null)?.head.position).toBe(8);
  });

  it("a node that has been DELETED steps to null rather than throwing into the frame loop", () => {
    const runner = createMediaTransportRunner("gone", {
      graph: () => graphWith({}),
      registry,
      channels: () => undefined,
      morphs: () => undefined,
    });
    expect(runner.step(frame(1), 10, null)).toBeNull();
  });
});

describe("T493 — the structural element checks", () => {
  it("playableMedia rejects a webcam-shaped element that cannot seek", () => {
    expect(playableMedia({ videoWidth: 640, videoHeight: 480 })).toBeNull();
    expect(playableMedia(null)).toBeNull();
    expect(playableMedia(fakeElement())).not.toBeNull();
  });

  it("durationOf reports 0 for the states a browser uses before metadata arrives", () => {
    expect(durationOf({ duration: Number.NaN })).toBe(0);
    expect(durationOf({ duration: Infinity })).toBe(0);
    expect(durationOf({})).toBe(0);
    expect(durationOf({ duration: 12.5 })).toBe(12.5);
  });
});

describe("T493 — the control registry is what makes the two pulses reach either door", () => {
  it("registers, resolves and releases by node id", () => {
    const registry = createMediaControlRegistry();
    const fired: string[] = [];
    const release = registry.register("m", {
      cue: () => fired.push("cue"),
      reload: () => fired.push("reload"),
    });
    expect(registry.ids()).toEqual(["m"]);
    // T1223 made `cue` optional — a still registers `reload` alone — so the call is
    // optional too. A node that HAS a playhead must still fire.
    registry.get("m")?.cue?.();
    expect(fired).toEqual(["cue"]);
    release();
    expect(registry.get("m")).toBeUndefined();
    expect(registry.ids()).toEqual([]);
  });

  it("a release from a SUPERSEDED registration does not evict the live one", () => {
    // The remount case: the effect re-runs, registers again, and only then tears the old
    // one down. Without the identity check that teardown deletes the new registration and
    // the node's pulses go dead with nothing on screen saying why (B87's shape).
    const registry = createMediaControlRegistry();
    const stale = registry.register("m", { cue: () => undefined, reload: () => undefined });
    const live = { cue: () => undefined, reload: () => undefined };
    registry.register("m", live);
    stale();
    expect(registry.get("m")).toBe(live);
  });
});

/**
 * T493, §V369 — A FILE THAT WILL NOT OPEN MUST SAY SO.
 *
 * Found by looking at the running app (§V383), not by a test: `openFile` awaited
 * `video.play()`, and a `play()` on a source that never decodes stays PENDING FOREVER —
 * it neither resolves nor rejects, because nothing tells the browser that playback will
 * never begin. The open loop therefore stranded BEFORE `registerMediaSource`, the node
 * held black, and the diagnostic that was written to name it never ran. Exactly the
 * "refuse by name rather than silently hold black" case T493 was told to close.
 */
describe("T493 — awaitMediaReady refuses by name instead of hanging (§V369)", () => {
  function openable(readyState = 0) {
    const listeners = new Map<string, Set<() => void>>();
    return {
      readyState,
      error: null as { code?: number } | null,
      addEventListener(type: string, listener: () => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
      emit(type: string) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener();
      },
      listenerCount(type: string) {
        return listeners.get(type)?.size ?? 0;
      },
    };
  }

  it("resolves on loadedmetadata, and stops listening afterwards", async () => {
    const element = openable();
    const ready = awaitMediaReady(element);
    element.emit("loadedmetadata");
    await expect(ready).resolves.toBeUndefined();
    expect(element.listenerCount("loadedmetadata")).toBe(0);
    expect(element.listenerCount("error")).toBe(0);
  });

  it("rejects on a decode error, naming the code", async () => {
    const element = openable();
    element.error = { code: 4 };
    const ready = awaitMediaReady(element);
    element.emit("error");
    await expect(ready).rejects.toThrow(/could not be decoded \(code 4\)/);
  });

  it("TIMES OUT rather than hanging — the whole point, since `play()` never settles", async () => {
    const element = openable();
    let fire: (() => void) | null = null;
    const ready = awaitMediaReady(element, 250, (callback) => {
      fire = callback;
      return 1;
    });
    expect(fire).not.toBeNull();
    (fire as unknown as () => void)();
    await expect(ready).rejects.toThrow(/Timed out after 250ms/);
    // And it let go of the element, so a late `loadedmetadata` cannot resolve a settled
    // promise or leak a listener onto a source nobody is waiting for any more.
    expect(element.listenerCount("loadedmetadata")).toBe(0);
  });

  it("does not wait at all when metadata is ALREADY there", async () => {
    // The fast path, and the one a naive event-only version hangs on forever: a cached
    // file can be at HAVE_METADATA before anyone attaches a listener, and the event that
    // would have resolved it has already been and gone.
    const element = openable(1);
    await expect(awaitMediaReady(element)).resolves.toBeUndefined();
    expect(element.listenerCount("loadedmetadata")).toBe(0);
  });

  it("ships a stated timeout rather than an unbounded wait", () => {
    expect(MEDIA_OPEN_TIMEOUT_MS).toBe(10_000);
  });
});

/**
 * ⚑ T1155 — A TRANSPORT PARAMETER DRIVEN BY A CHANNEL ACTUALLY REACHES THE ELEMENT.
 *
 * `createMediaTransportRunner`'s docblock has promised since T493 that "every transport
 * parameter takes every mode: an expression on `speed`, a `cuePoint` bound to a sibling, a
 * `trimStart` driven by an audio channel". None of it worked, and this file's twenty-six
 * other tests were all green while it did not: they resolve STATIC parameters, so the
 * missing half was invisible to every one of them.
 *
 * The missing half is `nodes` — `op('x').chan.y` is read inside the NODE REFERENCE READER
 * (§V837), not off the `channels` resolver, so a resolve handed only `channels` answers
 * every chan read with "this context has no channel resolver" and falls back to §V108's
 * retained static. §V837 already records four instances (§T593, §T1000, §T1001, §B46);
 * this was the fifth, and it is the one that decides whether E56 Vesper is a picture or a
 * still frame.
 *
 * Red-verified: with the options spelled out by hand again, the playhead reports the
 * retained 4 at every frame and the last assertion below fails on 1 distinct position.
 */
describe("T1155 — a DRIVEN transport parameter reaches the playhead", () => {
  const registry = createNodeRegistry(allNodeDefinitions);

  /** `cuePoint` reading a channel, written exactly as `drivenSlot` compiles it (§T897). */
  const drivenCue: GraphDocument = {
    revision: 1,
    nodes: {
      m: {
        id: "m",
        type: "movieFileIn",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {
          cue: true,
          playMode: "freeRun",
          cuePoint: {
            mode: "expression",
            bindings: {
              static: { kind: "static", value: 4 },
              expression: { kind: "expression", source: "op('sun1').chan.high" },
            },
          },
        },
      },
      /* The reader resolves `op('sun1')` against the GRAPH before it asks the channel
         resolver, so the publisher has to be here — which is the contract, not a fixture
         detail: an expression naming a node nobody has is a broken reference (§V890). */
      sun: {
        id: "sun",
        type: "valueMath",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        label: "sun1",
        parameters: {},
      },
    },
    edges: {},
  } as unknown as GraphDocument;

  /** A channel that MOVES, so a frozen readout cannot be mistaken for a still signal. */
  const sweeping = (frameIndex: number) => (address: string) =>
    address === "sun1:high" ? (frameIndex % 60) / 10 : undefined;

  it("holds at the CHANNEL's value, not at the retained static", () => {
    let index = 0;
    const runner = createMediaTransportRunner("m", {
      graph: () => drivenCue,
      registry,
      channels: () => sweeping(index) as never,
      morphs: () => undefined,
    });

    const positions: number[] = [];
    for (index = 0; index < 120; index += 1) {
      const stepped = runner.step(
        { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: "realtime", randomSeed: 1 },
        10,
        null,
      );
      expect(stepped).not.toBeNull();
      expect(stepped!.head.cued).toBe(true);
      positions.push(stepped!.head.position);
    }

    /* Exact, not a band: frame 7 asks for 0.7 and the cue holds the element exactly there
       (§V147). A resolve without the reader answers the retained 4 for every one of them. */
    expect(positions[7]).toBeCloseTo(0.7, 10);
    expect(positions[59]).toBeCloseTo(5.9, 10);
    expect(positions[60]).toBeCloseTo(0, 10);

    /* ⚑ LAST, and the one that names the behaviour (§V910): the playhead MOVES. Sixty
       distinct positions where the frozen fallback produces exactly one. */
    expect(new Set(positions).size).toBe(60);
    /* And the frozen fallback is not merely rarer, it is ABSENT as a fixed point: the
       retained 4 appears exactly where the sweep passes through it (frames 40 and 100)
       and nowhere else, which a resolve without the reader could never produce. */
    expect(positions.filter((value) => value === 4)).toHaveLength(2);
  });
});

/**
 * T1524b — A TRANSPORT PARAMETER A PRESET BANK IS FADING FOLLOWS THE FADE.
 *
 * A recall with a morph commits the destination at once, so a runner that resolves
 * without the morph index hands the element the END speed on the frame of the recall
 * while the picture is still on its way. The recall is the real command on the real bus;
 * the index is the real `buildMorphIndex`; what is asserted is the transport the runner
 * resolved — the value `applyMediaPlayhead` hands a `<video>` — and the playhead it gives.
 */
describe("T1524b — a morphing transport parameter reaches the runner at its half-way value", () => {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const EPOCH = "session-1";
  const frameAt = (index: number, epoch: string | null = EPOCH): FrameEvaluationInput => ({
    timeSeconds: index / 60,
    deltaSeconds: 1 / 60,
    frameIndex: index,
    mode: "realtime",
    randomSeed: 1,
    absFrameIndex: index,
    absTimeSeconds: index / 60,
    ...(epoch === null ? {} : { absEpoch: epoch }),
  });

  /** A timeline-locked movie at speed 1 and volume 0.2, and a bank that takes them to 3 and 0.8 over one second. */
  async function fading(): Promise<GraphDocument> {
    const session = presetSession(
      {
        revision: 1,
        groups: {},
        edges: {},
        nodes: {
          m: { id: "m", type: "movieFileIn", label: "movie1", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { playMode: "timeline", speed: 1, trimStart: 0 } },
          bank: presetBankNode("bank", "looks", "movie1", [{ name: "fast", values: { movie1: { speed: 3, trimStart: 2 } } }]),
        },
      } as unknown as GraphDocument,
      registry,
    );
    session.at({ epoch: EPOCH, absTimeSeconds: 0 });
    await session.recall("bank", "fast", { seconds: 1, curve: "linear" });
    return session.graph();
  }

  it("speed 1 → 3 and trimStart 0 → 2 over 1 s read 2 and 1 at frame 30, and their end values once landed", async () => {
    const graph = await fading();
    // The document holds the destination from the moment of the recall.
    expect(graph.nodes["m"]?.parameters).toMatchObject({ speed: 3, trimStart: 2 });
    const morphs = buildMorphIndex({ document: graph, registry });
    const runner = createMediaTransportRunner("m", { graph: () => graph, registry, channels: () => undefined, morphs: () => morphs });

    const start = runner.step(frameAt(0), 10, null);
    expect(start?.transport.speed).toBe(1);
    expect(start?.transport.trimStart).toBe(0);

    const half = runner.step(frameAt(30), 10, null);
    expect(half?.transport.speed).toBe(2);
    expect(half?.transport.trimStart).toBe(1);
    // The same resolve the audio door reads `volume` from (§B8's shape) carries the fade too.
    expect(half?.read("speed")).toBe(2);
    // …and it is the playhead that moves: half a second at speed 2, from the trim's 1.
    expect(half?.head.start).toBe(1);
    expect(half?.head.position).toBe(2);

    const landed = runner.step(frameAt(60), 10, null);
    expect(landed?.transport.speed).toBe(3);
    expect(landed?.transport.trimStart).toBe(2);
    expect(runner.step(frameAt(600), 10, null)?.transport.speed).toBe(3);
    // Another epoch — a take — reads the destination on every frame.
    expect(runner.step(frameAt(30, "take-1"), 10, null)?.transport.speed).toBe(3);
  });

  it("cut the wire: a runner handed no index hands over the end value at half-time", async () => {
    const graph = await fading();
    const runner = createMediaTransportRunner("m", { graph: () => graph, registry, channels: () => undefined, morphs: () => undefined });
    expect(runner.step(frameAt(30), 10, null)?.transport.speed).toBe(3);
  });
});

/**
 * T1542b, §V1027 — IN REALTIME FREE RUN THE PLAYING ELEMENT IS THE CLOCK.
 *
 * The owner: "music seems to tend to stutter when we cant really catch up" (§B236). The
 * runner used to keep its own accumulator and bend the element toward it, so every frame
 * the render clock and the sound hardware disagreed was paid in samples: `playbackRate`
 * rewritten around the speed on an ordinary frame, and 0.95× for twenty seconds per second
 * of timeline a stall dropped. §T740's rule is DROP A FRAME, NEVER A SAMPLE, and this is
 * that rule reaching the media layer: the playhead follows the element.
 *
 * ## What is asserted is what the listener gets
 *
 * `6219123f` gated "zero seeks" and a 0.95–1.05 rate band, and was green while the audio
 * ran up to 4.5% off. So every case here reads the RATE the element was left at and the
 * SECONDS it played, on an element that advances on its OWN clock — a double advanced by
 * the frame's delta could not disagree with the frame loop and would prove nothing.
 *
 * Red-verified against that commit: 45 and 24 Hz delivered leave the rate off the speed on
 * the frame-grid jitter alone, and every stall below leaves it at 0.95.
 */
describe("T1542b, §V1027 — in realtime free run the element is the clock", () => {
  const registry = createNodeRegistry(allNodeDefinitions);

  /** A `<video>` on its own clock, with every write a listener could hear counted. */
  function ownClockElement(
    duration: number,
    /**
     * §T1548b: when true the element's clock does not move while it plays — an unmuted
     * element routed into a SUSPENDED AudioContext (Chrome, measured: 0.002 s of media in
     * 1 s of wall), or a decoder that will not run before the page's first gesture at all.
     */
    stalled: (element: { readonly muted: boolean }) => boolean = () => false,
  ) {
    let paused = true;
    let currentTime = 0;
    let playbackRate = 1;
    /** §T1548b: seconds a SEEK alone costs (decode), where a routed `play()` costs nothing. */
    let decodeOnSeek = 0;
    /** Seconds of real time before a `play()` produces sound: decoder start-up. */
    let buffering = 0;
    /**
     * Seconds a SEEK, or a `play()` from paused, costs the decoder before sound resumes
     * (0: free). Chrome pays it on both (B242).
     */
    let seekBuffering = 0;
    /**
     * B242, measured in Chrome: the element plays on for about a video frame after a seek
     * or a `play()` BEFORE it freezes for its audio start. Wall seconds of that, per start.
     */
    let creep = 0;
    let seekCreep = 0;
    const seeks: number[] = [];
    /** §T1548b: the writes a listener HEARS — those made while the element plays. */
    const writesWhilePlaying: number[] = [];
    const rates: number[] = [];
    let pauses = 0;
    const element: PlayableMedia & {
      readonly seeks: readonly number[];
      readonly writesWhilePlaying: readonly number[];
      readonly rates: readonly number[];
      readonly pauses: number;
      readonly seeking: boolean;
      muted: boolean;
      volume: number;
      loop: boolean;
      advanceReal(seconds: number): void;
      buffer(seconds: number, creepSeconds?: number): void;
      rebufferOnStart(seconds: number, creepSeconds?: number): void;
      rebufferOnSeek(seconds: number): void;
      skew(seconds: number): void;
    } = {
      get currentTime() {
        return currentTime;
      },
      set currentTime(value: number) {
        currentTime = value;
        seeks.push(value);
        if (!paused) writesWhilePlaying.push(value);
        buffering = Math.max(buffering, seekBuffering, decodeOnSeek);
        creep = seekCreep;
      },
      // A real element's own loop: at the end it wraps to 0 with nothing written; without
      // it, it ends there and pauses.
      loop: false,
      // A seek's cost is decode work, which a paused element does in the background: one
      // put on a point and left there is ready to play from it once that time has passed.
      get seeking() {
        return paused && buffering > 0;
      },
      muted: true,
      volume: 1,
      get playbackRate() {
        return playbackRate;
      },
      set playbackRate(value: number) {
        playbackRate = value;
        rates.push(value);
      },
      get duration() {
        return duration;
      },
      get paused() {
        return paused;
      },
      play() {
        if (paused) {
          buffering = Math.max(buffering, seekBuffering);
          creep = seekCreep;
        }
        paused = false;
      },
      pause() {
        paused = true;
        pauses += 1;
      },
      get pauses() {
        return pauses;
      },
      seeks,
      writesWhilePlaying,
      rates,
      advanceReal(seconds: number) {
        if (paused) {
          buffering = Math.max(0, buffering - seconds);
          return;
        }
        if (stalled(element)) return;
        const early = buffering > 0 ? Math.min(creep, seconds) : 0;
        creep -= early;
        const silent = Math.min(buffering, seconds - early);
        buffering -= silent;
        currentTime += (seconds - silent) * playbackRate;
        if (currentTime < duration) return;
        if (element.loop) currentTime %= duration;
        else {
          currentTime = duration;
          paused = true;
        }
      },
      buffer(seconds: number, creepSeconds = 0) {
        buffering = seconds;
        creep = creepSeconds;
      },
      rebufferOnStart(seconds: number, creepSeconds = 0) {
        seekBuffering = seconds;
        seekCreep = creepSeconds;
      },
      rebufferOnSeek(seconds: number) {
        decodeOnSeek = seconds;
      },
      /** Move the element's own clock with no write anyone could count: injected drift. */
      skew(seconds: number) {
        currentTime += seconds;
      },
    };
    return element;
  }

  /**
   * The real chain — `liveClock` → runner → `applyMediaPlayhead` — against that element.
   * `wall` moves real time for the element and the page alike; `frame` is one delivered
   * frame. A stall, a throttled rAF and a hidden tab are all "wall without frame".
   */
  function session(
    parameters: Record<string, unknown> = {},
    duration = 3600,
    channels: MediaTransportContext["channels"] = () => undefined,
  ) {
    let nowMs = 0;
    const clock = liveClock({ fps: 60, presenting: () => true, now: () => nowMs });
    const element = ownClockElement(duration);
    const graph = {
      revision: 1,
      nodes: {
        m: { id: "m", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters },
      },
      edges: {},
    } as unknown as GraphDocument;
    const runner = createMediaTransportRunner("m", {
      graph: () => graph,
      registry,
      channels,
      morphs: () => undefined,
    });
    const wall = (seconds: number): void => {
      nowMs += seconds * 1000;
      element.advanceReal(seconds);
    };
    const frame = () => {
      const stepped = runner.step(clock.next(), durationOf(element), element.currentTime);
      if (stepped === null) throw new Error("the node is in the graph, so the runner must step");
      applyMediaPlayhead(element, stepped.transport, stepped.head, stepped.continuous, stepped.correction);
      return stepped;
    };
    /** `seconds` of playback with the browser delivering `hz` frames a second. */
    const play = (seconds: number, hz = 60, each?: (stepped: MediaSteppedTransport) => void): void => {
      for (let tick = 0; tick < Math.round(seconds * hz); tick += 1) {
        wall(1 / hz);
        const stepped = frame();
        each?.(stepped);
      }
    };
    frame();
    return { element, wall, frame, play, cue: () => runner.cue(), wallSeconds: () => nowMs / 1000 };
  }

  for (const hz of [60, 50, 45, 30, 24]) {
    it(`60 fps target, ${String(hz)} Hz delivered: the rate is the speed on every frame and nothing is sought`, () => {
      const { element, play, wallSeconds } = session();
      play(10, hz, () => expect(element.playbackRate).toBe(1));
      // Not one write of either kind: a rate that was set to 1 sixty times is still a
      // write the decoder may answer, and the claim is that the element is left alone.
      expect(element.rates).toEqual([]);
      expect(element.seeks).toEqual([]);
      expect(element.currentTime).toBeCloseTo(wallSeconds(), 9);
    });
  }

  it("a static speed is written once and the element plays wall × speed", () => {
    const { element, play, wallSeconds } = session({ speed: 2 });
    play(10, 45, () => expect(element.playbackRate).toBe(2));
    expect(element.rates).toEqual([2]);
    expect(element.seeks).toEqual([]);
    expect(element.currentTime).toBeCloseTo(wallSeconds() * 2, 9);
  });

  /**
   * `liveClock` clamps a tick to 0.25 s, so a longer stall DROPS timeline time. That loss
   * used to become the element's debt. The hidden tab is the same event at another scale,
   * and the owner's ruling on it is that the sound plays on: no pause, no seek on return.
   */
  for (const [what, stall] of [
    ["a 0.3 s stall", 0.3],
    ["a 1 s stall", 1],
    ["a 10 s stall", 10],
    ["a tab hidden for 60 s", 60],
  ] as const) {
    it(`${what}: the sound runs on and the playhead steps to it on the first frame back`, () => {
      const { element, wall, frame, play, wallSeconds } = session();
      play(2);
      wall(stall);
      const back = frame();
      expect(Math.abs(back.head.position - element.currentTime)).toBeLessThanOrEqual(1 / 60);
      expect(back.continuous).toBe(true);
      play(2, 60, () => expect(element.playbackRate).toBe(1));
      expect(element.rates).toEqual([]);
      expect(element.seeks).toEqual([]);
      expect(element.pauses).toBe(0);
      // The seconds heard are the seconds that passed, stall included.
      expect(element.currentTime).toBeCloseTo(wallSeconds(), 9);
    });
  }

  it("start-up lag is not a debt: a slow decoder is followed, not chased", () => {
    const { element, play, frame, wallSeconds } = session();
    element.buffer(0.3);
    play(5, 60, () => expect(element.playbackRate).toBe(1));
    expect(element.seeks).toEqual([]);
    expect(element.currentTime).toBeCloseTo(wallSeconds() - 0.3, 9);
    expect(frame().head.position).toBeCloseTo(element.currentTime, 9);
  });

  /**
   * The legitimate write the rule must not swallow. A lap is a frame-driven seek (the
   * element does not loop itself, §T493), so an element that ran past the out point while
   * no frame was delivered is put back — once, at the in point plus how far it overran.
   */
  it("an element that ran past the out point during a stall is lapped once, overshoot kept", () => {
    const { element, wall, frame, play } = session({ trimEnd: 10 }, 60);
    play(9.5);
    wall(2);
    const back = frame();
    expect(back.head.laps).toBe(1);
    expect(back.continuous).toBe(false);
    expect(element.seeks.length).toBe(1);
    expect(element.seeks[0]).toBeCloseTo(1.5, 9);
    play(1, 60, () => expect(element.playbackRate).toBe(1));
    expect(element.seeks.length).toBe(1);
  });

  it("a cue pulse is still an exact seek, and playback follows the element from there", () => {
    const { element, wall, frame, play, cue } = session({ cuePoint: 30 });
    play(1);
    cue();
    wall(1 / 60);
    expect(frame().continuous).toBe(false);
    expect(element.seeks.length).toBe(1);
    const landed = element.seeks[0] as number;
    expect(landed).toBeGreaterThanOrEqual(30);
    expect(landed).toBeLessThan(30 + 2 / 60);
    play(2, 45, () => expect(element.playbackRate).toBe(1));
    expect(element.seeks.length).toBe(1);
    expect(element.currentTime).toBeCloseTo(landed + 2, 9);
  });

  /**
   * §V436 and T1542b (4): the timeline lock is NOT covered. Its position is `f(frame)` —
   * that is what a scrub and an offline render stand on — so the element cannot lead it.
   * §T1549b ruled option (a): the frame stays master, and a stall the clamp turned into
   * more than a quarter second of drift is ONE seek back to the frame's position.
   */
  it("under the timeline lock the frame stays master: a 1 s stall is one seek back to the frame", () => {
    const { element, wall, frame, play } = session({ playMode: "timeline" });
    play(2);
    wall(1);
    const back = frame();
    // The lock's playhead is the timeline's second, which the clamp left 0.75 s behind
    // the element — and the element is put back there, not left leading.
    expect(back.head.position).toBeCloseTo(2.25, 9);
    expect(element.seeks).toEqual([back.head.position]);
    expect(element.rates).toEqual([]);
    play(2, 60, () => expect(element.playbackRate).toBe(1));
    expect(element.seeks.length).toBe(1);
  });

  /**
   * §T1549b, option (a) — UNDER THE LOCK THE CORRECTION IS CALM. The owner's complaint
   * (§B236) was the music stuttering; under the lock the frame must still be master
   * (§V436), so what a listener hears is HOW the element is brought back: every
   * `playbackRate` write is a resample and every seek a jump. The gate therefore reads the
   * writes themselves, on an element advancing on its OWN clock: how many rate writes a
   * second, that each is a whole percent within ±5%, how many seeks, and that it ends up
   * within one delivered frame of the playhead and stays there with nothing written.
   */
  describe("§T1549b — the timeline lock's correction: 1-frame deadband, 1% steps, one seek past 0.25 s", () => {
    /** `rates` as whole percents of the speed, or the first value that is not one. */
    const percents = (rates: readonly number[], speed = 1): number[] =>
      rates.map((rate) => {
        const percent = (rate / speed - 1) * 100;
        if (Math.abs(percent - Math.round(percent)) > 1e-9) throw new Error(`rate ${String(rate)} is not a whole percent of ${String(speed)}`);
        return Math.round(percent);
      });

    for (const hz of [60, 30]) {
      for (const drift of [0.1, -0.1, 0.3, -0.3, 1, -1]) {
        const behind = drift > 0 ? "behind" : "ahead";
        const size = Math.abs(drift);
        it(`${String(hz)} Hz delivered, element ${String(size)} s ${behind}: ${size <= LOCK_RESYNC_SECONDS ? "converges by 1% steps with no seek" : "one seek, then calm"}`, () => {
          const { element, play } = session({ playMode: "timeline" });
          const frameSeconds = 1 / hz;
          play(2, hz);
          expect([element.rates, element.seeks]).toEqual([[], []]);
          element.skew(-drift);

          /** Rate writes, bucketed by the second of playback they fell in. */
          const perSecond = new Array<number>(20).fill(0);
          let tick = 0;
          let written = 0;
          let last: MediaSteppedTransport | null = null;
          let seekedAt: number | null = null;
          play(20, hz, (stepped) => {
            perSecond[Math.floor(tick / hz)]! += element.rates.length - written;
            written = element.rates.length;
            if (seekedAt === null && element.seeks.length > 0) seekedAt = stepped.head.position;
            last = stepped;
            tick += 1;
          });
          // A few writes a second at most, never one a frame — and none at all once settled.
          expect(Math.max(...perSecond)).toBeLessThanOrEqual(4);
          expect(perSecond.slice(15)).toEqual([0, 0, 0, 0, 0]);
          // Whole percents, within ±5%.
          expect(percents(element.rates).every((percent) => Math.abs(percent) <= 5)).toBe(true);

          if (size <= LOCK_RESYNC_SECONDS) {
            expect(element.seeks).toEqual([]);
            // A correction happened (the deadband did not swallow 0.1 s), toward the target,
            // stepping DOWN to the speed: 0.1 s × the 0.25 gain is 2–3% by the frame grid.
            const steps = percents(element.rates);
            expect(Math.sign(steps[0]!)).toBe(Math.sign(drift));
            expect(Math.abs(steps[0]!)).toBeGreaterThanOrEqual(2);
            expect(steps.at(-1)).toBe(0);
          } else {
            expect(element.seeks.length).toBe(1);
            // ...to exactly the frame's position: the frame is master.
            expect(element.seeks[0]).toBe(seekedAt);
          }
          const final = last as MediaSteppedTransport | null;
          expect(Math.abs((final?.head.position ?? Infinity) - element.currentTime)).toBeLessThanOrEqual(frameSeconds);
          expect(element.playbackRate).toBe(1);
        });
      }
    }

    it("inside one delivered frame nothing is written at all — the deadband", () => {
      for (const hz of [60, 30]) {
        const { element, play } = session({ playMode: "timeline" });
        play(1, hz);
        element.skew(-0.9 / hz);
        play(10, hz);
        expect([hz, element.rates, element.seeks]).toEqual([hz, [], []]);
      }
    });

    /**
     * The frame grid's own jitter: a 45 Hz display on a 60 fps timeline puts the playhead
     * either side of real time by up to half a frame, every frame. Without the hysteresis
     * that is a rate write on most frames, forever.
     */
    it("45 Hz delivered: the frame grid's jitter does not keep the rate flickering", () => {
      const { element, play } = session({ playMode: "timeline" });
      play(2, 45);
      element.skew(-0.1);
      const before = element.rates.length;
      play(15, 45);
      const correcting = element.rates.length - before;
      play(15, 45);
      expect(correcting).toBeLessThanOrEqual(8);
      expect(element.rates.length - before - correcting).toBe(0);
      expect(element.seeks).toEqual([]);
    });

    /**
     * The trap a seek policy has to avoid (it reproduced an endless Chrome loop under
     * T493): a seek costs the decoder its buffering again, so the drift that triggered it
     * comes straight back. ONE seek, then the rate closes what the decoder lost.
     */
    /*
     * B242 changed this case: it used to assert that the 0.3 s START-UP lag cost exactly
     * one seek — the cost T1549b's row flagged as unmeasured, which Chrome turned into a
     * storm. Start-up is now alignment (no seek), and the re-buffering decoder is exercised
     * by the drift that legitimately seeks it: a 1 s jump once the element is playing.
     */
    it("a decoder that re-buffers 0.3 s after every seek is sought once, not forever", () => {
      const { element, play } = session({ playMode: "timeline" });
      element.rebufferOnStart(0.3);
      element.buffer(0.3);
      play(20);
      expect(element.seeks).toEqual([]);
      element.skew(-1);
      let last: MediaSteppedTransport | null = null;
      play(30, 60, (stepped) => { last = stepped; });
      expect(element.seeks.length).toBe(1);
      expect(percents(element.rates).every((percent) => Math.abs(percent) <= 5)).toBe(true);
      const final = last as MediaSteppedTransport | null;
      expect(Math.abs((final?.head.position ?? Infinity) - element.currentTime)).toBeLessThanOrEqual(1 / 60);
      expect(element.playbackRate).toBe(1);
    });

    /**
     * B242 — CHROME'S SEQUENCE, as the headed still-pixels run logged it. After a seek the
     * element reports `seeked`, `readyState` 4, `paused` false within a millisecond, plays
     * about one video frame past the seek point, then sits still for ~0.2 s (longer on a
     * loaded machine) until its audio output starts. Nothing on the element says it is not
     * playing. T1549b re-armed its one resync as soon as the element read past the seek
     * point — inside that first frame — so every freeze over 0.25 s was another seek:
     * 14 and 16 in the 3 s proof. Here the freeze is 0.3 s, after every `play()` and every
     * seek: start-up costs nothing, a real 1 s drift costs exactly one seek, the freeze
     * after it is not chased, and the rate steps close the rest to within one frame.
     */
    // 45 Hz on a 60 fps timeline lands the playhead either side of real time by up to half
    // a frame: the drift jitters across the threshold while the rate closes it.
    for (const hz of [60, 45, 30]) {
      it(`${String(hz)} Hz delivered, Chrome's 0.3 s start-up freeze after a one-frame creep: at most one seek, then 1% steps to within a frame`, () => {
        const { element, play } = session({ playMode: "timeline" });
        element.rebufferOnStart(0.3, 1 / hz);
        element.buffer(0.3, 1 / hz);
        play(20, hz);
        // Start-up lag is alignment: closed by the rate, never by a seek.
        expect(element.seeks).toEqual([]);
        expect(element.rates.length).toBeGreaterThan(0);
        element.skew(-1);
        let last: MediaSteppedTransport | null = null;
        let maxGap = 0;
        play(30, hz, (stepped) => {
          last = stepped;
          if (element.seeks.length === 1) maxGap = Math.max(maxGap, stepped.head.position - element.currentTime);
        });
        expect(element.seeks.length).toBe(1);
        // The freeze after that seek really did reopen a gap past the threshold — the case a
        // looser re-arm turns into the next seek — and it was closed by the rate instead.
        expect(maxGap).toBeGreaterThan(LOCK_RESYNC_SECONDS);
        expect(percents(element.rates).every((percent) => Math.abs(percent) <= 5)).toBe(true);
        const final = last as MediaSteppedTransport | null;
        expect(Math.abs((final?.head.position ?? Infinity) - element.currentTime)).toBeLessThanOrEqual(1 / hz);
        expect(element.playbackRate).toBe(1);
      });
    }

    /**
     * B242 — A LAG NO START-UP EXPLAINS. An element that starts 30 s late (autoplay blocked
     * under the lock, say) is never back inside the arming band, and 1% steps capped at 5%
     * would take ten minutes over 30 s. Once it has played, a lag past a second gets its
     * one seek armed or not — and the start-up freeze after THAT seek is alignment again.
     */
    for (const hz of [60, 30]) {
      it(`${String(hz)} Hz delivered, an element that starts 30 s late: one seek once it plays, then within a frame`, () => {
        const { element, play } = session({ playMode: "timeline" });
        element.rebufferOnStart(0.3, 1 / hz);
        element.buffer(30);
        let last: MediaSteppedTransport | null = null;
        play(55, hz, (stepped) => { last = stepped; });
        expect(element.seeks.length).toBe(1);
        // Taken after the element got going — it lands on the playhead, 30 s on.
        expect(element.seeks[0]).toBeGreaterThan(30);
        expect(percents(element.rates).every((percent) => Math.abs(percent) <= 5)).toBe(true);
        const final = last as MediaSteppedTransport | null;
        expect(Math.abs((final?.head.position ?? Infinity) - element.currentTime)).toBeLessThanOrEqual(1 / hz);
        expect(element.playbackRate).toBe(1);
      });
    }

    /**
     * B242 — RESUME IS A START. A transport pause stops the frames and the door pauses the
     * element (`setRunning(false)`); the first frame back carries up to 0.25 s of playhead
     * (`liveClock`'s clamp) while the element sits where it was paused, then the element
     * pays Chrome's start-up freeze. Together that is well past 0.25 s of lag, and none of
     * it is drift: the rate closes it, no seek.
     */
    for (const hz of [60, 30]) {
      it(`${String(hz)} Hz delivered, resume after a 2 s transport pause: no seek, then within a frame`, () => {
        const { element, wall, play } = session({ playMode: "timeline" });
        element.rebufferOnStart(0.3, 1 / hz);
        play(5, hz);
        expect(element.seeks).toEqual([]);
        element.pause();
        wall(2);
        let last: MediaSteppedTransport | null = null;
        let maxGap = 0;
        play(30, hz, (stepped) => {
          last = stepped;
          maxGap = Math.max(maxGap, stepped.head.position - element.currentTime);
        });
        // The lag an armed resync would have sought.
        expect(maxGap).toBeGreaterThan(LOCK_RESYNC_SECONDS);
        expect(element.seeks).toEqual([]);
        expect(percents(element.rates).every((percent) => Math.abs(percent) <= 5)).toBe(true);
        const final = last as MediaSteppedTransport | null;
        expect(Math.abs((final?.head.position ?? Infinity) - element.currentTime)).toBeLessThanOrEqual(1 / hz);
        expect(element.playbackRate).toBe(1);
      });
    }
  });

  /**
   * B187 — A DRIVEN SPEED MADE THE PLAYHEAD LEAP RETROACTIVELY. Free run multiplied the
   * whole elapsed history by the current speed, so speed 1 → 2 five seconds in re-priced
   * those five seconds and the playhead jumped to ten — and a speed change was a
   * discontinuity, so the element was SOUGHT there (T1542b item 5). With the element as the
   * clock a positive speed change is a `playbackRate` write and nothing else.
   */
  describe("B187 — a driven speed continues from where the playhead is", () => {
    const DRIVEN_SPEED = { mode: "driven", bindings: { driven: { kind: "driven", channel: "rate" } } };

    function driven(playMode: "freeRun" | "timeline") {
      let rate = 1;
      const run = session({ playMode, speed: DRIVEN_SPEED }, 3600, () => (channel) => (channel === "rate" ? rate : undefined));
      return { ...run, drive: (value: number) => { rate = value; } };
    }

    it("free run, speed 1 → 2 at t = 5 s: the playhead is at ~5 s, not ~10 s, and nothing is sought", () => {
      const { element, wall, frame, play, drive } = driven("freeRun");
      play(5);
      drive(2);
      wall(1 / 60);
      const changed = frame();
      expect(changed.transport.speed).toBe(2);
      expect(Math.abs(changed.head.position - 5)).toBeLessThan(0.05);
      expect(changed.continuous).toBe(true);
      expect(element.seeks).toEqual([]);
      expect(element.rates).toEqual([2]);
      // ...and it plays on from there at twice the speed, still with no seek.
      play(2, 60, () => expect(element.playbackRate).toBe(2));
      expect(element.seeks).toEqual([]);
      expect(element.currentTime).toBeCloseTo(5 + 1 / 60 + 4, 9);
    });

    it("free run, speed → -1 is the held scrub, running back from where the playhead was", () => {
      const { element, wall, frame, play, drive } = driven("freeRun");
      play(5);
      drive(-1);
      wall(1 / 60);
      const back = frame();
      expect(back.head.position).toBeCloseTo(5 - 1 / 60, 9);
      expect(element.paused).toBe(true);
      expect(element.seeks).toEqual([back.head.position]);
    });

    /** ⚠ the row's warning: an integrator under the lock would make position path-dependent. */
    it("under the lock the same change is still timeline × speed — a new target, one exact seek", () => {
      const { element, wall, frame, play, drive } = driven("timeline");
      play(5);
      drive(2);
      wall(1 / 60);
      const changed = frame();
      expect(changed.head.position).toBeCloseTo((5 + 1 / 60) * 2, 9);
      expect(changed.continuous).toBe(false);
      expect(element.seeks).toEqual([changed.head.position]);
    });
  });

  /**
   * §T1548b — GAPLESS LOOPING IN REALTIME FREE RUN. With the element as the clock a lap
   * that SEEKS is taken where the element is and then waits on the decoder, so every lap
   * lasts its window plus the seek latency — in picture and in sound (a 0.5 s window looped
   * every 0.71 s in Chrome). A second element on the same file waits paused on the in point
   * and takes the lap over. What a listener gets is read back: no write on an element while
   * it plays, and N laps lasting N windows of wall time, to within one delivered frame.
   */
  describe("§T1548b — a free-run Loop lap hands over to a second element instead of seeking", () => {
    /**
     * Two elements on one file, through the real `liveClock` → runner → movie playback chain.
     * `audio.output` routes them through a fake AudioContext door (null: their own outputs);
     * `audio.stalled` is when an element's clock stops (see `ownClockElement`).
     */
    function pairSession(
      parameters: Record<string, unknown>,
      partner = true,
      duration = 10,
      audio: { output: MovieAudioOutput | null; stalled?: (element: { readonly muted: boolean }) => boolean } = { output: null },
    ) {
      let nowMs = 0;
      const clock = liveClock({ fps: 60, presenting: () => true, now: () => nowMs });
      const first = ownClockElement(duration, audio.stalled);
      const second = ownClockElement(duration, audio.stalled);
      const graph = {
        revision: 1,
        nodes: {
          m: { id: "m", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters },
        },
        edges: {},
      } as unknown as GraphDocument;
      const runner = createMediaTransportRunner("m", {
        graph: () => graph,
        registry,
        channels: () => undefined,
        morphs: () => undefined,
      });
      const playback = createMovieAudioPlayback(first, new EventTarget(), () => undefined, audio.output);
      const shown: PlayableMedia[] = [];
      if (partner) expect(playback.attachPartner(second, (playing) => shown.push(playing))).toBe(true);
      const wall = (seconds: number): void => {
        nowMs += seconds * 1000;
        first.advanceReal(seconds);
        second.advanceReal(seconds);
      };
      const frame = () => {
        const stepped = runner.step(clock.next(), durationOf(first), playback.position());
        if (stepped === null) throw new Error("the node is in the graph, so the runner must step");
        playback.sync(stepped, "realtime");
        return stepped;
      };
      /** `seconds` of playback delivered at `hz`; returns the last frame. */
      const play = (seconds: number, hz: number, each?: (stepped: MediaSteppedTransport) => void): MediaSteppedTransport => {
        let last: MediaSteppedTransport | null = null;
        for (let tick = 0; tick < Math.round(seconds * hz); tick += 1) {
          wall(1 / hz);
          last = frame();
          each?.(last);
        }
        if (last === null) throw new Error("play at least one frame");
        return last;
      };
      const start = frame();
      return { first, second, shown, graph, play, frame, wall, start, wallSeconds: () => nowMs / 1000 };
    }
    /** §T1548b: the app's AudioContext door, faked — each route's gain, and the context's state. */
    function fakeOutput(running: boolean) {
      const gains = new Map<PlayableMedia, { value: number }>();
      const context = { running };
      const output: MovieAudioOutput = {
        route(element) {
          const gain = gains.get(element) ?? { value: 0 };
          gains.set(element, gain);
          return { gain, release: () => { gain.value = 0; } };
        },
        running: () => context.running,
      };
      return { output, gains, context };
    }
    /** Media seconds the playhead has travelled from the in point, laps included. */
    const travelled = (stepped: MediaSteppedTransport): number =>
      stepped.head.laps * (stepped.head.end - stepped.head.start) + stepped.head.position - stepped.head.start;

    for (const hz of [60, 45, 30]) {
      it(`${String(hz)} Hz delivered, 0.5 s window: 5.25 s of wall is ten laps, ten hand-overs, nothing written on a playing element`, () => {
        // Routed through a running context, as the product is: a `play()` starts at once
        // there (measured: 0.500 s laps), and the gain is what is heard.
        const { output, gains } = fakeOutput(true);
        const { first, second, shown, play, start, wallSeconds } = pairSession(
          { trimStart: 1, trimEnd: 1.5, audio: true, volume: 0.5 }, true, 10, { output },
        );
        // What a Chrome seek costs before the element plays on: 40–200 ms, measured.
        first.rebufferOnSeek(0.2);
        second.rebufferOnSeek(0.2);
        const heard = [first.writesWhilePlaying.length, second.writesWhilePlaying.length];
        const last = play(5.25, hz, () => {
          expect(first.playbackRate).toBe(1);
          expect(second.playbackRate).toBe(1);
          // The one playing is heard at the Volume, the one waiting not at all.
          const playing = shown.at(-1) ?? first;
          const waiting = playing === first ? second : first;
          expect([gains.get(playing)?.value, gains.get(waiting)?.value]).toEqual([0.5, 0]);
          expect([first.muted, second.muted, first.volume, second.volume]).toEqual([false, false, 1, 1]);
        });
        expect([first.writesWhilePlaying.length, second.writesWhilePlaying.length]).toEqual(heard);
        expect(shown).toHaveLength(10);
        expect(shown.slice(0, 2)).toEqual([second, first]);
        expect(last.head.laps).toBe(10);
        // The remainder past each out point is carried, so the error does not grow per lap.
        expect(Math.abs(travelled(last) - travelled(start) - wallSeconds())).toBeLessThanOrEqual(1 / hz);
      });
    }

    /** The same session with ONE element: the problem itself, so the gate above can fail. */
    it("with no partner each lap is a seek on the playing element and pays the decoder's latency", () => {
      const { first, play, start, wallSeconds } = pairSession({ trimStart: 1, trimEnd: 1.5 }, false, 10, fakeOutput(true));
      first.rebufferOnSeek(0.2);
      const heard = first.writesWhilePlaying.length;
      const last = play(5.25, 60);
      expect(first.writesWhilePlaying.length - heard).toBe(last.head.laps);
      // 0.2 s lost per lap: 5.25 s of wall is 7 laps and change, not 10.
      expect(last.head.laps).toBe(7);
      expect(wallSeconds() - (travelled(last) - travelled(start))).toBeGreaterThan(1.3);
    });

    it("under the timeline lock a lap stays an exact seek: the partner never plays (§V436)", () => {
      const { first, second, shown, play } = pairSession({ playMode: "timeline", trimStart: 1, trimEnd: 1.5 });
      const heard = first.writesWhilePlaying.length;
      const last = play(2, 60);
      expect(last.head.laps).toBe(4);
      expect(shown).toEqual([]);
      expect(first.writesWhilePlaying.length - heard).toBe(4);
      expect(second.paused).toBe(true);
    });

    it("a trim edit re-primes the waiting element on the new in point, and the next lap hands over there", () => {
      const { first, second, shown, graph, play } = pairSession({ trimStart: 1, trimEnd: 1.5 });
      play(0.25, 60);
      expect(second.currentTime).toBe(1);
      graph.nodes["m"]!.parameters["trimStart"] = 2;
      graph.nodes["m"]!.parameters["trimEnd"] = 2.5;
      play(0.25, 60);
      expect(second.currentTime).toBe(2);
      const heard = first.writesWhilePlaying.length;
      let handedOverAt: number | null = null;
      play(0.5, 60, () => {
        if (shown.length === 1 && handedOverAt === null) handedOverAt = second.currentTime;
      });
      expect(shown).toEqual([second]);
      expect(handedOverAt).toBe(2);
      expect(first.writesWhilePlaying.length).toBe(heard);
      expect(second.paused).toBe(false);
    });

    /**
     * §T1548b, owner's ruling — the WHOLE FILE loops on its one element (`loop = true`): no
     * partner, nothing written at the lap, and the lap lasts the file. The element runs
     * back from the end to 0 by itself; the playhead must take that as a lap, not a scrub
     * it then "corrects" with a seek.
     */
    for (const hz of [60, 45]) {
      it(`a whole-file Loop at ${String(hz)} Hz: the element loops itself, five laps in 5.25 s of a 1 s file, nothing written`, () => {
        const { first, play, start, wallSeconds } = pairSession({ audio: true, volume: 1 }, false, 1, fakeOutput(true));
        first.rebufferOnSeek(0.2);
        const last = play(5.25, hz, (stepped) => {
          expect(first.loop).toBe(true);
          expect(first.playbackRate).toBe(1);
          // The playhead IS the element, every frame, laps and all.
          expect(stepped.head.position).toBeCloseTo(first.currentTime, 9);
        });
        expect(first.seeks).toEqual([]);
        expect(last.head.laps).toBe(5);
        expect(Math.abs(travelled(last) - travelled(start) - wallSeconds())).toBeLessThanOrEqual(1e-9);
      });
    }

    it("a whole-file Loop before the gesture: the frame clock's lap is not a seek on the element looping itself", () => {
      // Suspended: the playhead runs on the frame clock, and the element (muted, so on time)
      // started a tenth late. The frame clock laps first; the element is still at 0.9.
      const { first, play } = pairSession({}, false, 1, fakeOutput(false));
      first.buffer(0.1);
      const last = play(2.5, 60, () => expect(first.loop).toBe(true));
      expect(last.head.laps).toBe(2);
      expect(first.writesWhilePlaying).toEqual([]);
      expect(first.currentTime).toBeCloseTo(0.4, 9);
    });

    it("a trim, the lock or a take turns the element's own loop off again: there a lap is the transport's", () => {
      const { first, graph, play } = pairSession({}, false, 1, fakeOutput(true));
      play(0.25, 60);
      expect(first.loop).toBe(true);
      graph.nodes["m"]!.parameters["trimEnd"] = 0.5;
      play(1 / 60, 60);
      expect(first.loop).toBe(false);
      graph.nodes["m"]!.parameters["trimEnd"] = 0;
      play(1 / 60, 60);
      expect(first.loop).toBe(true);
      graph.nodes["m"]!.parameters["playMode"] = "timeline";
      play(1 / 60, 60);
      expect(first.loop).toBe(false);
    });

    /**
     * §T1548b — THE GESTURE RULE. Before the page's first gesture the app's context is
     * suspended, and an UNMUTED routed element then nearly stops its clock (Chrome,
     * measured: 0.002 s of media in 1 s). So the element is held muted, and the free-run
     * playhead runs on the frame clock instead of adopting it; once the context runs, sound
     * starts and the playhead follows the element again (§V1027).
     */
    it("suspended context: the element is held muted and keeps time; once the context runs it is heard and followed", () => {
      const { output, gains, context } = fakeOutput(false);
      const { first, play, start } = pairSession({ audio: true, volume: 0.5 }, false, 3600, {
        output,
        stalled: (element) => !element.muted && !context.running,
      });
      const before = play(2, 60, () => expect(first.muted).toBe(true));
      // Muted, it did not stall: two seconds of media in two of wall, and the playhead too.
      expect(first.currentTime).toBeCloseTo(2, 9);
      expect(travelled(before) - travelled(start)).toBeCloseTo(2, 9);
      context.running = true;
      const heard = first.writesWhilePlaying.length;
      const from = first.currentTime;
      play(1, 60, (stepped) => {
        expect([first.muted, gains.get(first)?.value]).toEqual([false, 0.5]);
        expect(stepped.head.position).toBeCloseTo(first.currentTime, 9);
      });
      expect(first.currentTime - from).toBeCloseTo(1, 9);
      expect(first.writesWhilePlaying.length).toBe(heard);
    });

    it("suspended context, a decoder that will not run before the gesture: the playhead still advances, then adopts the element", () => {
      const { output, context } = fakeOutput(false);
      const { first, play, start } = pairSession({ audio: true, volume: 0.5 }, false, 3600, {
        output,
        stalled: () => !context.running,
      });
      const before = play(2, 60);
      expect(first.currentTime).toBe(0);
      // The element is stuck; the playhead is not: it ran two seconds on the frame clock.
      expect(travelled(before) - travelled(start)).toBeCloseTo(2, 9);
      context.running = true;
      const adopted = play(1 / 60, 60);
      expect(adopted.head.position).toBeCloseTo(first.currentTime, 9);
      expect(first.currentTime).toBeCloseTo(1 / 60, 9);
      const heard = first.writesWhilePlaying.length;
      play(1, 60, (stepped) => expect(stepped.head.position).toBeCloseTo(first.currentTime, 9));
      expect(first.writesWhilePlaying.length).toBe(heard);
    });
  });

  /** §V662: a take is silent and the frame is its master — an element's clock has no say. */
  for (const mode of ["offline", "fixed-step"] as const) {
    it(`a ${mode} frame keeps the accumulator: the element's clock is not read`, () => {
      const graph = {
        revision: 1,
        nodes: { m: { id: "m", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} } },
        edges: {},
      } as unknown as GraphDocument;
      const runner = createMediaTransportRunner("m", { graph: () => graph, registry, channels: () => undefined, morphs: () => undefined });
      const at = (index: number): FrameEvaluationInput =>
        ({ timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode, randomSeed: 1 });
      runner.step(at(0), 3600, 0);
      expect(runner.step(at(1), 3600, 40)?.head.position).toBeCloseTo(2 / 60, 12);
      expect(runner.step(at(2), 3600, 80)?.head.position).toBeCloseTo(3 / 60, 12);
    });
  }
});
