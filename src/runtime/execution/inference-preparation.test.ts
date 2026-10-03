import { describe, expect, it, vi } from "vitest";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { createInferenceSources, type InferenceEntry } from "./inference-sources.ts";

const entry: InferenceEntry = {
  nodeId: "model", inputResourceId: "input", sourceId: "infer:model", fallback: new Uint8Array([0]),
};
function frame(index: number, mode: FrameEvaluationInput["mode"] = "realtime"): FrameEvaluationInput {
  return { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode, randomSeed: 7 };
}
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
function deferred() {
  let resolve!: (bytes: Uint8Array) => void;
  const promise = new Promise<Uint8Array>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe("only encoded inference input is consumed", () => {
  it.each(["in-flight", "held", "rate"] as const)("prepares only useful inputs while %s", async condition => {
    const waiting = deferred();
    const readBuffer = vi.fn(async () => new Uint8Array([7]).buffer);
    const run = vi.fn(async (_nodeId: string, input: ArrayBuffer) =>
      condition === "in-flight" ? await waiting.promise : new Uint8Array(input));
    const sources = createInferenceSources({ readBuffer, run });
    sources.track([{ ...entry, hold: condition === "held", minIntervalSeconds: condition === "rate" ? 0.5 : 0 }]);
    let dispatches = 0;
    for (let index = 0; index < 60; index++) {
      const current = frame(index);
      if (sources.prepare("model", current)) dispatches++;
      sources.samplePrepared(current);
      await flush();
    }
    const expected = condition === "rate" ? 2 : 1;
    expect(dispatches).toBe(expected);
    expect(readBuffer).toHaveBeenCalledTimes(expected);
    expect(run).toHaveBeenCalledTimes(expected);
    waiting.resolve(new Uint8Array([7]));
    await sources.drain();
  });

  it("T1530b: a retuned rate limit binds the next decision and keeps every node's prepared input", async () => {
    // Why `retune` and not `track`: the policy is re-read each frame, and a re-track clears
    // every node's prepared input — an encoded frame another gate already reserved.
    const readBuffer = vi.fn(async () => new Uint8Array([5]).buffer);
    const run = vi.fn(async (_nodeId: string, input: ArrayBuffer) => new Uint8Array(input));
    const sources = createInferenceSources({ readBuffer, run });
    const other: InferenceEntry = { ...entry, nodeId: "other", inputResourceId: "other-input", sourceId: "infer:other" };
    sources.track([entry, other]);
    const first = frame(0);
    expect(sources.prepare("other", first)).toBe(true);
    expect(sources.prepare("model", first)).toBe(true);
    sources.retune("model", { minIntervalSeconds: 1, hold: false });
    sources.samplePrepared(first);
    await flush();
    expect(run.mock.calls.map(([nodeId]) => nodeId).sort()).toEqual(["model", "other"]);
    // 0.6 s after the run: inside a 1 s gap, outside a 0.5 s one.
    expect(sources.prepare("model", frame(36))).toBe(false);
    sources.retune("model", { minIntervalSeconds: 0.5, hold: false });
    expect(sources.prepare("model", frame(37))).toBe(true);
    // Hold binds as soon as it is retuned on: the node has its result.
    sources.retune("model", { minIntervalSeconds: 0, hold: true });
    expect(sources.prepare("model", frame(38))).toBe(false);
    // An untracked node is ignored, not added.
    sources.retune("ghost", { minIntervalSeconds: 0, hold: false });
    expect(sources.prepare("ghost", frame(39))).toBe(false);
  });

  it("a completion after a skipped encode cannot authorize a stale readback", async () => {
    const waiting = deferred();
    let inputByte = 7;
    const readBuffer = vi.fn(async () => new Uint8Array([inputByte]).buffer);
    let runs = 0;
    const run = vi.fn(async (_nodeId: string, input: ArrayBuffer) =>
      ++runs === 1 ? await waiting.promise : new Uint8Array(input));
    const sources = createInferenceSources({ readBuffer, run });
    sources.track([entry]);
    const first = frame(0);
    expect(sources.prepare("model", first)).toBe(true);
    sources.samplePrepared(first);
    await flush();
    const skipped = frame(1);
    expect(sources.prepare("model", skipped)).toBe(false);
    waiting.resolve(new Uint8Array([7]));
    await sources.drain();
    sources.samplePrepared(skipped);
    await flush();
    expect(readBuffer).toHaveBeenCalledOnce();
    expect([...sources.currentFrame("model")!.bytes]).toEqual([7]);
    const fresh = frame(2);
    expect(sources.prepare("model", fresh)).toBe(true);
    inputByte = 11;
    sources.samplePrepared(fresh);
    await sources.drain();
    expect([...sources.currentFrame("model")!.bytes]).toEqual([11]);
  });

  it.each(["offline", "fixed-step"] as const)("drains old work and consumes current %s input once", async mode => {
    const waiting = deferred();
    let inputByte = 3;
    const readBuffer = vi.fn(async () => new Uint8Array([inputByte]).buffer);
    let runs = 0;
    const sources = createInferenceSources({ readBuffer,
      run: async (_nodeId, input) => ++runs === 1 ? await waiting.promise : new Uint8Array(input) });
    sources.track([{ ...entry, minIntervalSeconds: 10 }]);
    const live = frame(0);
    sources.prepare("model", live); sources.samplePrepared(live);
    await flush();
    const take = frame(1, mode);
    expect(sources.prepare("model", take)).toBe(true);
    inputByte = 9;
    sources.samplePrepared(take);
    const settling = sources.settlePrepared(1);
    await flush();
    expect(readBuffer).toHaveBeenCalledOnce();
    waiting.resolve(new Uint8Array([3]));
    await settling;
    await sources.settlePrepared(1);
    expect(readBuffer).toHaveBeenCalledTimes(2);
    expect([...sources.currentFrame("model")!.bytes]).toEqual([9]);
    expect(sources.resultAges(1)).toEqual([{ nodeId: "model", ageFrames: 0 }]);
  });

  it("explicit offline ownership overrides live transport cadence and never auto-samples", async () => {
    let inputByte = 1;
    const readBuffer = vi.fn(async () => new Uint8Array([inputByte]).buffer);
    const sources = createInferenceSources({ readBuffer, run: async (_nodeId, input) => new Uint8Array(input) });
    sources.track([{ ...entry, minIntervalSeconds: 10 }]);
    for (let index = 0; index < 3; index++) {
      const current = frame(index);
      expect(sources.prepare("model", current, true)).toBe(true);
      inputByte = index + 1;
      sources.samplePrepared(current, false);
      await flush();
      expect(readBuffer).toHaveBeenCalledTimes(index);
      await sources.settlePrepared(index);
      expect([...sources.currentFrame("model")!.bytes]).toEqual([index + 1]);
    }
    expect(readBuffer).toHaveBeenCalledTimes(3);
  });

  it("a held offline result still runs once and remains frozen", async () => {
    const readBuffer = vi.fn(async () => new Uint8Array([6]).buffer);
    const sources = createInferenceSources({ readBuffer, run: async (_nodeId, input) => new Uint8Array(input) });
    sources.track([{ ...entry, hold: true }]);
    const first = frame(0, "offline");
    expect(sources.prepare("model", first)).toBe(true);
    await sources.settlePrepared(0);
    expect(sources.prepare("model", frame(1, "offline"))).toBe(false);
    await sources.settlePrepared(1);
    expect(readBuffer).toHaveBeenCalledOnce();
    expect([...sources.currentFrame("model")!.bytes]).toEqual([6]);
  });

  it("replaced plans, reset and a different render at the same playhead invalidate old reservations", async () => {
    const readBuffer = vi.fn(async () => new Uint8Array([4]).buffer);
    const sources = createInferenceSources({ readBuffer, run: async (_nodeId, input) => new Uint8Array(input) });
    sources.track([entry]);
    const first = frame(0);
    sources.prepare("model", first);
    sources.track([{ ...entry, inputResourceId: "replacement" }]);
    sources.samplePrepared(first);
    await sources.settlePrepared(0);
    expect(readBuffer).not.toHaveBeenCalled();
    const next = frame(0);
    expect(sources.prepare("model", next)).toBe(true);
    sources.samplePrepared(first);
    expect(readBuffer).not.toHaveBeenCalled();
    sources.reset("model");
    sources.samplePrepared(next);
    expect(readBuffer).not.toHaveBeenCalled();
    sources.prepare("model", next);
    sources.cancelPreparation("model");
    await sources.settlePrepared(0);
    expect(readBuffer).not.toHaveBeenCalled();
    const fresh = frame(1);
    sources.prepare("model", fresh); sources.samplePrepared(fresh);
    await sources.drain();
    expect(readBuffer).toHaveBeenCalledWith("replacement");
    expect([...sources.currentFrame("model")!.bytes]).toEqual([4]);
  });

  it("untracking a first run disowns it before the same node ID is recreated", async () => {
    const zombie = deferred();
    let runs = 0;
    const sources = createInferenceSources({
      readBuffer: async () => new Uint8Array([9]).buffer,
      run: async (_nodeId, input) => ++runs === 1 ? await zombie.promise : new Uint8Array(input),
    });
    sources.track([entry]);
    const first = frame(0);
    sources.prepare("model", first); sources.samplePrepared(first);
    await flush();
    sources.track([]);
    sources.track([{ ...entry, hold: true }]);
    const recreated = frame(1);
    expect(sources.prepare("model", recreated)).toBe(true);
    sources.samplePrepared(recreated);
    await sources.drain();
    zombie.resolve(new Uint8Array([3]));
    await flush();
    expect([...sources.currentFrame("model")!.bytes]).toEqual([9]);
    expect(sources.resultAges(1)).toEqual([{ nodeId: "model", ageFrames: 0 }]);
  });
});


describe("captured input timing for compensated video", () => {
  it("counts actual renders across skipped project frames and wraps; delay includes the run", async () => {
    const waiting = deferred();
    let nextRenderIndex = 2;
    const sources = createInferenceSources({
      readBuffer: async () => new Uint8Array([9]).buffer,
      run: async () => waiting.promise,
      nextRenderIndex: () => nextRenderIndex,
    });
    sources.track([{ ...entry, channel: "matte1" }]);
    const issue = { ...frame(20), absTimeSeconds: 10.1 };
    // Live effect→preprocess read: the actual input is the preceding submitted render.
    sources.prepare("model", issue, false, { frameIndex: 17, timeSeconds: 10, renderIndex: 1 });
    sources.samplePrepared(issue);
    await flush();
    const wrapped = { ...frame(0), absTimeSeconds: 10.4 };
    nextRenderIndex = 5;
    sources.samplePrepared(wrapped);
    waiting.resolve(new Uint8Array([9]));
    await sources.drain();
    const ask = (field: string) => sources.resolver(`matte1:${field}`, { frame: wrapped } as never);
    expect(ask("ready")).toBe(1);
    expect(ask("cacheFrames")).toBe(4); // Four ring positions, regardless of project indices.
    expect(ask("delaySeconds")).toBeCloseTo(0.4); // Not zero when the result finally lands.
    sources.reset("model");
    expect(ask("ready")).toBe(0);
    expect(ask("cacheFrames")).toBe(0);
  });

  it("represents zero delay for a current-frame blocking result", async () => {
    const sources = createInferenceSources({ readBuffer: async () => new Uint8Array([1]).buffer,
      run: async (_, bytes) => new Uint8Array(bytes), nextRenderIndex: () => 1 });
    sources.track([{ ...entry, channel: "matte1" }]);
    const current = frame(0, "offline");
    sources.prepare("model", current, true, { frameIndex: 0, timeSeconds: 0, renderIndex: 1 });
    sources.samplePrepared(current, false);
    await sources.settlePrepared(0);
    expect(sources.resolver("matte1:cacheFrames", { frame: current } as never)).toBe(0);
    expect(sources.resolver("matte1:delaySeconds", { frame: current } as never)).toBe(0);
  });
});
