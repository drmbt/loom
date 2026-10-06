import { describe, expect, it } from "vitest";
import { scopeFromFrame } from "../expressions/evaluate.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import { DEFAULT_PROJECT_FPS } from "./graph.ts";
import { ZERO_FRAME, frameFromClock } from "./frame.ts";
import type { FrameEvaluationInput } from "./frame.ts";

/**
 * T1554b — the frame constructors. What a reader sees is the contract: a frame built by the
 * constructor must read, through every clock an expression or a shader can name, exactly as
 * the reading it was built from read before (one fallback rule, not two), and must NOT
 * flatten a clock the producer did supply — the absolute clock exists to differ from the
 * timeline after a lap (T461, §V437).
 */
describe("frameFromClock (T1554b)", () => {
  const reading = { timeSeconds: 2.5, deltaSeconds: 0.5, frameIndex: 5, mode: "offline" as const, randomSeed: 3, fps: 2 };

  it("fills an absent clock from the timeline, so the frame reads as the bare reading did", () => {
    const frame = frameFromClock(reading);
    expect(frame).toMatchObject({ wallSeconds: 2.5, wallDeltaSeconds: 0.5, absTimeSeconds: 2.5, absFrameIndex: 5, fps: 2, subframes: 1 });
    // Every name an expression reads agrees — the constructor's fallback IS the readers'.
    expect(scopeFromFrame(frame)).toEqual(scopeFromFrame(reading));
  });

  it("keeps a supplied clock that disagrees with the timeline (a lapped absolute clock)", () => {
    // After a lap the timeline is back at 0.5 s and the absolute clock is at 10.5 s.
    const frame = frameFromClock({ ...reading, timeSeconds: 0.5, frameIndex: 1, absTimeSeconds: 10.5, absFrameIndex: 21, wallSeconds: 9, wallDeltaSeconds: 0.4, subframes: 4 });
    const scope = scopeFromFrame(frame);
    expect([scope.time, scope.abstime, scope.absframe, scope.walltime, scope.walldelta, scope.subframes]).toEqual([0.5, 10.5, 21, 9, 0.4, 4]);
  });

  it("publishes an epoch only when the reading names one (absent = no epoch, every morph finished)", () => {
    expect("absEpoch" in frameFromClock(reading)).toBe(false);
    expect(frameFromClock({ ...reading, absEpoch: "run-2" }).absEpoch).toBe("run-2");
  });

  it("leaves an offline render's frames as they were: a lap moves time back and abstime on", () => {
    const transport = offlineTransport({ fps: 10, subframes: 2 });
    transport.next();
    transport.next();
    transport.wrapTo?.(0); // absent, the frame below would not be at time 0 and the assertion fails
    const lapped = transport.next();
    expect(lapped).toStrictEqual({
      timeSeconds: 0,
      deltaSeconds: 0.1,
      frameIndex: 0,
      mode: "offline",
      randomSeed: 0,
      wallSeconds: 0,
      wallDeltaSeconds: 0.1,
      absFrameIndex: 2,
      absTimeSeconds: 0.2,
      fps: 5,
      subframes: 2,
    });
  });
});

describe("ZERO_FRAME (T1554b)", () => {
  /** What the four retired module-local zero frames were, byte for byte. */
  const retired: FrameEvaluationInput = { timeSeconds: 0, deltaSeconds: 0, frameIndex: 0, mode: "offline", randomSeed: 0 };

  it("reads exactly as the four zero frames it replaced, at the default project rate", () => {
    expect(scopeFromFrame(ZERO_FRAME)).toEqual(scopeFromFrame(retired));
    expect(ZERO_FRAME.fps).toBe(DEFAULT_PROJECT_FPS);
  });

  it("is frozen, because every frameless read in the app shares it", () => {
    expect(Object.isFrozen(ZERO_FRAME)).toBe(true);
  });
});
