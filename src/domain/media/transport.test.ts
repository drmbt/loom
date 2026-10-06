import { describe, expect, it } from "vitest";

import {
  MEDIA_TRANSPORT_KEYS,
  MEDIA_TRANSPORT_PARAMETERS,
  createMediaClock,
  hasMediaTransport,
  mediaPlayhead,
  mediaPlayheadAt,
  mediaTransportFrom,
  type MediaTransportValues,
} from "./transport.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterValue } from "../types/parameters.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { resolveStored } from "../parameters/index.ts";

/**
 * T493 — the media transport, asserted at EXACT VALUES.
 *
 * §V147's rule applied to arithmetic: a transport test that would still pass with the
 * transport ripped out proves nothing. "Speed changes the position" is satisfied by any
 * function of speed; "speed 2 at t=1 into a 10s file is at 2.0 and speed 1 is at 1.0" is
 * satisfied by one. So every case below names the number, and the cases are chosen where a
 * plausible wrong implementation gives a DIFFERENT number — a negative modulo, a mirror
 * that reflects about the wrong end, a trim window measured from zero instead of the in
 * point.
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

const at = (transport: Partial<MediaTransportValues>, elapsed: number, duration = 10) =>
  mediaPlayhead({ ...BASE, ...transport }, elapsed, duration);

describe("T493 — position derives from the clock", () => {
  it("runs at real time when speed is 1", () => {
    expect(at({}, 0).position).toBe(0);
    expect(at({}, 2.5).position).toBe(2.5);
  });

  it("speed 2.0 advances TWICE as far as speed 1.0 over the same elapsed time", () => {
    expect(at({ speed: 1 }, 3).position).toBe(3);
    expect(at({ speed: 2 }, 3).position).toBe(6);
    expect(at({ speed: 0.5 }, 3).position).toBe(1.5);
  });

  it("speed 0 freezes at the in point rather than drifting", () => {
    expect(at({ speed: 0 }, 999).position).toBe(0);
    expect(at({ speed: 0, trimStart: 4 }, 999).position).toBe(4);
  });

  it("a NEGATIVE speed runs backwards and wraps in from the END, not to -1", () => {
    // The positive-modulo case. `-1 % 10` is -1 in JavaScript, so the naive version puts
    // the playhead one second BEFORE the file starts.
    expect(at({ speed: -1 }, 1).position).toBe(9);
    expect(at({ speed: -1 }, 11).position).toBe(9);
  });
});

describe("T493 — trim is an in/out point, and the window is measured from the in point", () => {
  it("trimStart moves the in point, and t=0 lands ON it", () => {
    expect(at({ trimStart: 4 }, 0).position).toBe(4);
    expect(at({ trimStart: 4 }, 1).position).toBe(5);
  });

  it("trimEnd stops at THIS index and loops back to the in point, not to zero", () => {
    // Window is 4→7, three seconds long. At t=3 the loop has just come round.
    const head = at({ trimStart: 4, trimEnd: 7 }, 3);
    expect(head.start).toBe(4);
    expect(head.end).toBe(7);
    expect(head.position).toBe(4);
    // t=3.5 is half a second into the second pass — 4.5, NOT 0.5 and NOT 7.5.
    expect(at({ trimStart: 4, trimEnd: 7 }, 3.5).position).toBe(4.5);
  });

  it("trimEnd 0 means the end of the file, so the window is the whole duration", () => {
    expect(at({ trimEnd: 0 }, 0).end).toBe(10);
    expect(at({ trimEnd: 0 }, 12).position).toBe(2);
  });

  it("clamps a trim window that runs past the file rather than playing past the end", () => {
    expect(at({ trimEnd: 40 }, 0).end).toBe(10);
    expect(at({ trimStart: 40 }, 0).start).toBe(10);
  });
});

describe("T493 — the at-end behaviours are four DIFFERENT numbers at the same instant", () => {
  // One elapsed time, one window, four answers. If any two agreed the control would be
  // decorative, which is the shape a vacuous enum test misses.
  const elapsed = 13; // 3 seconds past the end of a 10s window.

  it("loop cycles", () => {
    expect(at({ extend: "loop" }, elapsed).position).toBe(3);
    expect(at({ extend: "loop" }, elapsed).done).toBe(false);
  });

  it("hold freezes on the last frame and reports done", () => {
    const head = at({ extend: "hold" }, elapsed);
    expect(head.position).toBe(10);
    expect(head.done).toBe(true);
    expect(head.visible).toBe(true);
  });

  it("mirror ping-pongs — 3 past the end is 3 BEFORE it, not 3 after the start", () => {
    expect(at({ extend: "mirror" }, elapsed).position).toBe(7);
    // And it comes back: one full period is two windows.
    expect(at({ extend: "mirror" }, 20).position).toBe(0);
    expect(at({ extend: "mirror" }, 25).position).toBe(5);
    expect(at({ extend: "mirror" }, elapsed).done).toBe(false);
  });

  it("black stops being visible at all — distinct from hold, which shows a frozen frame", () => {
    const head = at({ extend: "black" }, elapsed);
    expect(head.position).toBe(10);
    expect(head.visible).toBe(false);
    expect(head.done).toBe(true);
    // Inside the window it is perfectly ordinary.
    expect(at({ extend: "black" }, 4).visible).toBe(true);
  });

  it("mirror reflects about the TRIMMED window, not about zero", () => {
    // Window 2→6 (four seconds). One second past the out point is 5, not 3 and not 7.
    expect(at({ extend: "mirror", trimStart: 2, trimEnd: 6 }, 5).position).toBe(5);
  });
});

describe("T493 — cue jumps to THIS second and holds there", () => {
  it("holds at the cue point regardless of how much time has passed", () => {
    expect(at({ cue: true, cuePoint: 6 }, 0).position).toBe(6);
    expect(at({ cue: true, cuePoint: 6 }, 3).position).toBe(6);
    expect(at({ cue: true, cuePoint: 6 }, 900).position).toBe(6);
    expect(at({ cue: true, cuePoint: 6 }, 3).cued).toBe(true);
  });

  it("is a pure function of the frame, so it holds under the timeline lock too", () => {
    // The reason `cue` is NOT inactive when locked to the timeline, unlike `play`.
    expect(at({ playMode: "timeline", cue: true, cuePoint: 2.25 }, 7).position).toBe(2.25);
  });

  it("clamps the cue point into the trim window rather than escaping it", () => {
    expect(at({ cue: true, cuePoint: 9, trimStart: 1, trimEnd: 5 }, 0).position).toBe(5);
    expect(at({ cue: true, cuePoint: 0, trimStart: 1, trimEnd: 5 }, 0).position).toBe(1);
  });

  it("releases to exactly where the clock says, not to where it was cued", () => {
    expect(at({ cue: true, cuePoint: 6 }, 3).position).toBe(6);
    expect(at({ cue: false, cuePoint: 6 }, 3).position).toBe(3);
  });
});

describe("T493 — an unloaded file refuses by name rather than lying (§V369)", () => {
  it("an unknown duration advances honestly and never claims to be done", () => {
    const head = mediaPlayhead(BASE, 12, 0);
    expect(head.position).toBe(12);
    expect(head.end).toBe(0);
    expect(head.done).toBe(false);
  });

  it("a COLLAPSED window holds the one frame the user asked for, and never divides by zero", () => {
    const head = at({ trimStart: 3, trimEnd: 3 }, 5);
    expect(Number.isFinite(head.position)).toBe(true);
    expect(head.position).toBe(3);
    // ...and it stays there however long the timeline runs.
    expect(at({ trimStart: 3, trimEnd: 3 }, 5000).position).toBe(3);
  });
});

describe("T493 — the free-run clock is the only state, and only in free-run", () => {
  it("under the timeline lock it IGNORES its accumulator and returns the timeline", () => {
    const clock = createMediaClock();
    // Ten frames of a paused transport: a stateful implementation would hold at 0.
    for (let index = 0; index < 10; index += 1) {
      clock.advance({ ...BASE, play: false }, 1 / 60, index / 60);
    }
    expect(clock.advance({ ...BASE, play: false }, 1 / 60, 4)).toBe(4);
  });

  it("in free-run, PAUSE actually holds and PLAY actually advances", () => {
    const freeRun: MediaTransportValues = { ...BASE, playMode: "freeRun" };
    const clock = createMediaClock();
    expect(clock.advance(freeRun, 1, 1)).toBe(1);
    expect(clock.advance(freeRun, 1, 2)).toBe(2);
    expect(clock.advance({ ...freeRun, play: false }, 1, 3)).toBe(2);
    expect(clock.advance({ ...freeRun, play: false }, 1, 4)).toBe(2);
    expect(clock.advance(freeRun, 1, 5)).toBe(3);
  });

  it("a cue PULSE lands the playhead on the cue point and carries on from there", () => {
    const freeRun: MediaTransportValues = { ...BASE, playMode: "freeRun", speed: 2 };
    const clock = createMediaClock();
    clock.advance(freeRun, 1, 1);
    const head = mediaPlayhead(freeRun, 1, 10);
    expect(head.position).toBe(2);
    clock.cueTo(head, 7);
    // The jump is stored as the offset from the in point, so it reads back as 7.
    expect(mediaPlayheadAt(freeRun, clock.advance(freeRun, 0, 1), 10).position).toBe(7);
    // ...and one more second at speed 2 is 9, not back to 2.
    expect(mediaPlayheadAt(freeRun, clock.advance(freeRun, 1, 2), 10).position).toBe(9);
  });

  it("a cue pulse into a TRIMMED window lands on the point, not on the point plus the in", () => {
    const freeRun: MediaTransportValues = { ...BASE, playMode: "freeRun", trimStart: 3, trimEnd: 8 };
    const clock = createMediaClock();
    const head = mediaPlayheadAt(freeRun, clock.advance(freeRun, 1, 1), 10);
    clock.cueTo(head, 6);
    expect(mediaPlayheadAt(freeRun, clock.advance(freeRun, 0, 1), 10).position).toBe(6);
  });
});

/**
 * B187 — A DRIVEN SPEED MUST NOT RE-PRICE THE PAST. The free-run clock used to hold raw
 * elapsed seconds that the playhead multiplied by the CURRENT speed, so a speed that went
 * from 1 to 2 five seconds in put the playhead at ten. Free run integrates `speed dt`; the
 * timeline lock must NOT (§V436: its position is `f(frame)`, so a scrub finds the same
 * frame every time and an offline render reproduces).
 */
describe("B187 — free run integrates speed; the timeline lock stays a function of the frame", () => {
  const freeRun: MediaTransportValues = { ...BASE, playMode: "freeRun", extend: "hold" };
  const FRAME = 1 / 60;

  /** `seconds` of 60 fps frames at `speed`, continuing `clock`; returns the last offset. */
  const run = (clock: ReturnType<typeof createMediaClock>, transport: MediaTransportValues, from: number, seconds: number) => {
    let offset = 0;
    for (let index = 1; index <= Math.round(seconds * 60); index += 1) {
      offset = clock.advance(transport, FRAME, from + index * FRAME);
    }
    return offset;
  };

  it("speed 1 → 2 at t = 5 s continues from 5 s: one frame later it is at 5 + 2/60, not 10", () => {
    const clock = createMediaClock();
    expect(mediaPlayheadAt(freeRun, run(clock, freeRun, 0, 5), 60).position).toBeCloseTo(5, 9);
    const fast = { ...freeRun, speed: 2 };
    const next = mediaPlayheadAt(fast, clock.advance(fast, FRAME, 5 + FRAME), 60);
    expect(next.position).toBeCloseTo(5 + 2 * FRAME, 9);
    // ...and a second later it has gained two seconds, not re-priced the first five.
    expect(mediaPlayheadAt(fast, run(clock, fast, 5 + FRAME, 1), 60).position).toBeCloseTo(7 + 2 * FRAME, 9);
  });

  it("speed 0 freezes WHERE THE PLAYHEAD IS, and reverse runs back from there", () => {
    const clock = createMediaClock();
    run(clock, freeRun, 0, 3);
    const still = { ...freeRun, speed: 0 };
    expect(mediaPlayheadAt(still, run(clock, still, 3, 2), 60).position).toBeCloseTo(3, 9);
    const back = { ...freeRun, speed: -1 };
    expect(mediaPlayheadAt(back, run(clock, back, 5, 1), 60).position).toBeCloseTo(2, 9);
  });

  it("under the lock the same timeline second is the same position, whatever speed history led there", () => {
    const locked: MediaTransportValues = { ...BASE, extend: "hold" };
    const fast = { ...locked, speed: 2 };
    const changed = createMediaClock();
    run(changed, locked, 0, 5);
    const viaChange = run(changed, fast, 5, 1);
    const always = createMediaClock();
    const viaConstant = run(always, fast, 0, 6);
    // `timeline × speed`, exactly: path-independent, and the number `mediaPlayhead` derives.
    expect(viaChange).toBe(viaConstant);
    expect(mediaPlayheadAt(fast, viaChange, 60).position).toBe(mediaPlayhead(fast, 6, 60).position);
    expect(viaChange).toBe(12);
  });
});

/**
 * T1542b, §V1027 — the playhead follows a playing element, so the clock is re-based on the
 * element's own position. What is asserted is the round trip the runner makes: adopt, then
 * read the playhead back.
 */
describe("T1542b — adopting an element's position keeps the lap it is in", () => {
  const freeRun: MediaTransportValues = { ...BASE, playMode: "freeRun" };

  it("lands on the element's second, in the lap already reached, at any speed", () => {
    const transport: MediaTransportValues = { ...freeRun, speed: 2, trimStart: 3, trimEnd: 8 };
    const clock = createMediaClock();
    // 6.5 s at speed 2 into a 5 s window: two laps done, 3 s into the third.
    const head = mediaPlayheadAt(transport, clock.advance(transport, 6.5, 0), 10);
    expect([head.laps, head.position]).toEqual([2, 6]);
    const adopted = mediaPlayheadAt(transport, clock.adopt(head, 7.25), 10);
    expect([adopted.laps, adopted.position]).toEqual([2, 7.25]);
    // ...and carries on from there: half a second at speed 2 is the out point less nothing.
    expect(mediaPlayheadAt(transport, clock.advance(transport, 0.25, 0), 10).position).toBe(7.75);
  });

  it("an element past the out point is the NEXT lap, by how far it overran", () => {
    const transport: MediaTransportValues = { ...freeRun, trimEnd: 8 };
    const clock = createMediaClock();
    const head = mediaPlayheadAt(transport, clock.advance(transport, 7, 0), 10);
    const adopted = mediaPlayheadAt(transport, clock.adopt(head, 9.5), 10);
    expect([adopted.laps, adopted.position]).toEqual([1, 1.5]);
  });

  /**
   * THE EDGE. An element waiting on its decoder sits EXACTLY on the in point — every
   * start and every lap begins there. `laps × window / window` comes back one rounding
   * error short of `laps` for many combinations below, which reads as the END of the lap
   * before: a lap that never happened and a seek to the out point. Red-verified with the
   * edge margin at 0: 561 of these 6030 failed while the offset was divided by the speed;
   * since B187 the clock holds the offset itself and 2340 fail (the same 468 per speed).
   */
  it("an element sitting ON the in point is in this lap, never at the end of the last one", () => {
    const wrong: string[] = [];
    for (const speed of [0.3, 0.7, 1, 1.7, 3]) {
      for (const window of [0.1, 1 / 3, 4.7, 10, 29.97, 184.32]) {
        const transport: MediaTransportValues = { ...freeRun, speed, trimEnd: window };
        for (let laps = 0; laps <= 200; laps += 1) {
          const clock = createMediaClock();
          const head = { ...mediaPlayhead(transport, 0, 1000), laps };
          const adopted = mediaPlayheadAt(transport, clock.adopt(head, head.start), 1000);
          // A microsecond is the precision an element's own clock reports at.
          if (adopted.laps !== laps || Math.abs(adopted.position - head.start) > 1e-6) {
            wrong.push(`speed ${String(speed)} window ${String(window)} lap ${String(laps)}: lap ${String(adopted.laps)} @ ${String(adopted.position)}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("T493 — one vocabulary, read tolerantly (§V61, §V10)", () => {
  it("a document with none of the keys reads the SCHEMA defaults, and the reader cannot drift from them", () => {
    const transport = mediaTransportFrom(() => undefined);
    expect(transport).toEqual({
      // T586: free run, the owner's default. The `toMatchObject` pair below is what stops
      // this and the manifest becoming two answers about what a missing key means — a
      // document stores `playMode` only when the user picked one, so "missing" IS the
      // default state and a divergence here is a node that plays differently depending on
      // which reader looked at it.
      playMode: "freeRun",
      play: true,
      speed: 1,
      cue: false,
      cuePoint: 0,
      trimStart: 0,
      trimEnd: 0,
      extend: "loop",
    });
    // ...and those defaults are the manifest's, not a second copy that can drift.
    const schema = MEDIA_TRANSPORT_PARAMETERS;
    expect(schema["playMode"]).toMatchObject({ default: transport.playMode });
    expect(schema["speed"]).toMatchObject({ default: transport.speed });
    expect(schema["extend"]).toMatchObject({ default: transport.extend });
  });

  it("a wrong-typed or unknown value falls back rather than producing NaN", () => {
    const values: Record<string, ParameterValue> = {
      speed: "fast" as unknown as ParameterValue,
      playMode: "sequential",
      extend: "cycle",
      cue: 1 as unknown as ParameterValue,
    };
    const transport = mediaTransportFrom((key) => values[key]);
    expect(transport.speed).toBe(1);
    expect(transport.playMode).toBe("freeRun");
    expect(transport.extend).toBe("loop");
    expect(transport.cue).toBe(false);
  });

  it("reads real values through", () => {
    const values: Record<string, ParameterValue> = {
      playMode: "freeRun",
      play: false,
      speed: -2,
      cue: true,
      cuePoint: 1.5,
      trimStart: 2,
      trimEnd: 8,
      extend: "mirror",
    };
    expect(mediaTransportFrom((key) => values[key])).toEqual(values);
  });
});

describe("T493 — §V146: a control that cannot act says so", () => {
  const inactive = (key: string, playMode: string) =>
    MEDIA_TRANSPORT_PARAMETERS[key]?.inactiveWhen?.({ playMode });

  it("Play is inactive under the timeline lock, and the reason names the timeline", () => {
    const reason = inactive("play", "timeline");
    expect(reason).toBeTypeOf("string");
    expect(reason).toContain("Locked to Timeline");
    expect(inactive("play", "freeRun")).toBeNull();
  });

  /**
   * T586 — THE OWNER'S SYMPTOM, asserted where it actually happens.
   *
   * The two cases above hand `inactiveWhen` a literal `playMode`, which can never see the
   * bug the owner hit: they dropped in a file and found Play DIMMED, and the value that
   * dimmed it came from `resolveParameters` filling in the manifest default for a node
   * that stores nothing. So this goes through the real resolver on a real registry node —
   * the storage read of the resolver `inspector.tsx` reads through — and asserts the control is LIVE.
   *
   * §V146's logic is untouched and still right; it is simply now describing the mode you
   * opted into rather than the one you were dropped in.
   */
  it("Play is ACTIVE on a freshly dropped-in node, through the resolver the inspector uses", () => {
    const registry = createNodeRegistry(allNodeDefinitions);
    for (const type of ["audioFileIn", "movieFileIn"]) {
      const definition = registry.get(type);
      const node = {
        id: "n",
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      } as unknown as Parameters<typeof resolveStored>[0];
      const resolved = resolveStored(node, definition as NodeDefinition);
      expect(resolved.values["playMode"], type).toBe("freeRun");
      // The whole point of the flip: no dimming, no "this control cannot act" sentence.
      expect(MEDIA_TRANSPORT_PARAMETERS["play"]?.inactiveWhen?.(resolved.values), type).toBeNull();
      expect(
        MEDIA_TRANSPORT_PARAMETERS["cuePulse"]?.inactiveWhen?.(resolved.values),
        type,
      ).toBeNull();
    }
  });

  it("Cue Pulse is inactive under the lock, but Cue itself is NOT", () => {
    expect(inactive("cuePulse", "timeline")).toBeTypeOf("string");
    expect(inactive("cuePulse", "freeRun")).toBeNull();
    // The distinction the whole clock argument rests on: holding is pure, jumping is not.
    // T1223 MOVED THESE THREE FROM "has no gate" TO "the gate is silent here", for the
    // same reason T1190 moved `speed`: a still has no clock, so EVERY verb dims for one,
    // and "has no gate at all" would now be a claim about the implementation rather than
    // about what the user is misled by. The claim itself is unchanged and is stronger
    // asserted this way — under the lock, on a video, these three are live.
    const video = { playMode: "timeline", file: "clip.mp4" };
    expect(MEDIA_TRANSPORT_PARAMETERS["cue"]?.inactiveWhen?.(video) ?? null).toBeNull();
    expect(MEDIA_TRANSPORT_PARAMETERS["trimStart"]?.inactiveWhen?.(video) ?? null).toBeNull();
    expect(MEDIA_TRANSPORT_PARAMETERS["trimEnd"]?.inactiveWhen?.(video) ?? null).toBeNull();
  });

  /**
   * ⚑ T1190 — THE OWNER'S SECOND SYMPTOM, and it is the same shape as T586's.
   *
   * Driving a `cuePoint` from audio, he asked *"do we have reverse now? We don't have
   * reverse play."* Reverse HAS shipped since T493: `speed` goes to -4 and
   * `applyMediaPlayhead` scrubs backwards by hand. It did nothing for him because
   * `mediaPlayhead` answers a HELD CUE before it reads the clock at all — so Speed, Play
   * and At End were live controls doing nothing, with nothing saying so.
   *
   * Asserted against `mediaPlayhead` itself rather than against the schema alone, because
   * "this control is inactive" is only honest if the control really is not read. If a
   * future change made a cue consult `speed`, the dimming would become the lie.
   */
  it("with Cue HELD, Speed / Play / At End say they do nothing — and really do nothing", () => {
    const held = { playMode: "freeRun", cue: true };
    for (const key of ["speed", "play", "extend", "cuePulse"]) {
      const reason = MEDIA_TRANSPORT_PARAMETERS[key]?.inactiveWhen?.(held);
      expect(reason, key).toBeTypeOf("string");
      expect(reason, key).toContain("Cue");
    }
    // Cue Point and the trim are read UNDER a cue, so they must stay active.
    expect(MEDIA_TRANSPORT_PARAMETERS["cuePoint"]?.inactiveWhen?.(held) ?? null).toBeNull();
    expect(MEDIA_TRANSPORT_PARAMETERS["cue"]?.inactiveWhen?.(held) ?? null).toBeNull();

    // And with the cue OFF, every one of them is live again.
    const running = { playMode: "freeRun", cue: false };
    for (const key of ["speed", "play", "extend", "cuePulse"]) {
      expect(MEDIA_TRANSPORT_PARAMETERS[key]?.inactiveWhen?.(running) ?? null, key).toBeNull();
    }

    // THE CLAIM THE DIMMING MAKES: under a cue the playhead ignores speed and extend
    // entirely. Same cue point, three transports that differ in nothing else, one answer.
    const base: MediaTransportValues = {
      playMode: "freeRun", play: true, cue: true, cuePoint: 4,
      trimStart: 0, trimEnd: 0, speed: 1, extend: "loop",
    };
    const at = (over: Partial<typeof base>) => mediaPlayhead({ ...base, ...over }, 3, 10).position;
    expect(at({})).toBe(4);
    expect(at({ speed: -4 })).toBe(4);
    expect(at({ speed: 0 })).toBe(4);
    expect(at({ extend: "mirror" })).toBe(4);
    expect(at({ play: false })).toBe(4);
    // ...and with the cue OFF the same three transports disagree, so the check above is
    // not vacuous: it is a fact about the cue, not about these parameters being inert.
    const running3 = { ...base, cue: false };
    expect(mediaPlayhead(running3, 3, 10).position).toBe(3);
    expect(mediaPlayhead({ ...running3, speed: -4 }, 3, 10).position).toBe(8);
  });
});

describe("T493 — hasMediaTransport derives from the schema (§V316, §V453)", () => {
  const definition = (parameters: Record<string, unknown>) =>
    ({ type: "x", version: 1, title: "X", category: "input", inputs: [], outputs: [], parameters } as unknown as NodeDefinition);

  it("is true only when EVERY transport key is present", () => {
    expect(hasMediaTransport(definition({ ...MEDIA_TRANSPORT_PARAMETERS }))).toBe(true);
    const { play: _play, ...missingOne } = MEDIA_TRANSPORT_PARAMETERS;
    expect(hasMediaTransport(definition(missingOne))).toBe(false);
    expect(hasMediaTransport(definition({ file: { type: "asset" } }))).toBe(false);
  });

  it("names every key the vocabulary owns", () => {
    expect([...MEDIA_TRANSPORT_KEYS].sort()).toEqual([
      "cue",
      "cuePoint",
      "cuePulse",
      "extend",
      "play",
      "playMode",
      "reload",
      "speed",
      "trimEnd",
      "trimStart",
    ]);
  });
});
