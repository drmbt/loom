import { describe, expect, it, vi } from "vitest";
import { createWorkerCore, MODEL_PLANS, type InferenceSessionLike } from "./inference-worker-core.ts";
import type { InferenceResponse, WorkerLike } from "./inference-protocol.ts";
import { createWorkerRunner } from "./worker-runner.ts";
import { MATTE_RVM } from "./model-catalogue.ts";

/** Exercise the real runner/protocol/core together without model weights or a GPU. */
function harness(modelId: string, smoothing: number, session: InferenceSessionLike) {
  let deliver: ((event: { data: InferenceResponse }) => void) | undefined;
  const transferredResults: ArrayBuffer[] = [];
  const createSession = vi.fn(async () => session);
  const core = createWorkerCore({
    isolated: true,
    createSession,
    createTensor: (type, data, dims) => ({ type, data, dims }),
    post: (data, transfer) => {
      if (!deliver) throw new Error("Worker listener not installed");
      if (data.kind === "result") transferredResults.push(data.bytes);
      deliver({ data: structuredClone(data, transfer === undefined ? {} : { transfer }) });
    },
  });
  const worker: WorkerLike = {
    postMessage: (request) => { void core.handle(request); },
    addEventListener: (type: string, listener: unknown) => {
      if (type === "message") deliver = listener as typeof deliver;
    },
    terminate: () => undefined,
  };
  const target = { modelId, nodeType: "matte" as const, width: 2, height: 2,
    side: 2, sourceWidth: 2, sourceHeight: 2, providers: ["wasm"], ratio: 0.5, smoothing };
  const runner = createWorkerRunner({
    worker,
    describe: () => target,
    weightsFor: async () => new ArrayBuffer(4),
  });
  return { createSession, runner, target, transferredResults,
    run: (nodeId: string) => runner.run(nodeId, new ArrayBuffer(target.side ** 2 * 16)) };
}

describe("temporal inference state belongs to a node, not shared model weights", () => {
  it("retires deleted history but preserves an unused surviving node and shared weights", async () => {
    const fed: number[] = [];
    let frame = 0;
    const test = harness(MATTE_RVM.id, 1, {
      inputNames: ["src"], outputNames: ["pha", "r1o", "r2o", "r3o", "r4o"],
      run: async feeds => {
        fed.push((feeds.r1i as { data: Float32Array }).data[0]!);
        const state = { data: new Float32Array([++frame]) };
        return { pha: { data: new Float32Array(4) }, r1o: state, r2o: state, r3o: state, r4o: state };
      },
    });
    try {
      await test.run("a");
      await test.run("b");
      test.runner.retainNodes(["b"]);
      // b is still in the graph, although it did not run during this reconciliation.
      await test.run("b");
      await test.run("a"); // newly created node with a previously used opaque ID
      expect(fed).toEqual([0, 0, 2, 0]);
      expect(test.createSession).toHaveBeenCalledTimes(1);
    } finally { test.runner.dispose(); }
  });

  it("does not resurrect deleted history when an old inference completes after recreation", async () => {
    let completeOld!: (outputs: Awaited<ReturnType<InferenceSessionLike["run"]>>) => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const feedsSeen: number[] = [];
    let calls = 0;
    const outputs = (value: number) => {
      const state = { data: new Float32Array([value]) };
      return { pha: { data: new Float32Array(4) }, r1o: state, r2o: state, r3o: state, r4o: state };
    };
    const test = harness(MATTE_RVM.id, 1, {
      inputNames: ["src"], outputNames: ["pha", "r1o", "r2o", "r3o", "r4o"],
      run: async feeds => {
        feedsSeen.push((feeds.r1i as { data: Float32Array }).data[0]!);
        if (++calls === 1) {
          started();
          return new Promise(resolve => { completeOld = resolve; });
        }
        return outputs(calls);
      },
    });
    try {
      const old = test.run("a");
      const rejected = old.then(() => "unexpected success", error => String(error));
      await running;
      test.runner.retainNodes([]);
      expect(await rejected).toContain("retired");
      await test.run("a");
      completeOld(outputs(99));
      await Promise.resolve();
      await Promise.resolve();
      await test.run("a");
      expect(feedsSeen).toEqual([0, 0, 2]);
      expect(test.createSession).toHaveBeenCalledTimes(1);
    } finally { test.runner.dispose(); }
  });

  it("retires smoothing history as well as recurrence", async () => {
    let frame = 0;
    const test = harness("modnet-photographic", 0.5, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: new Float32Array(4).fill(frame++) } }),
    });
    try {
      await test.run("a");
      test.runner.retainNodes([]);
      const result = await test.run("a");
      expect([...new Float32Array(result.buffer)]).toEqual([1, 1, 1, 1]);
    } finally { test.runner.dispose(); }
  });

  it("restarts recurrence when the same node changes input size without changing ratio", async () => {
    const fed: number[] = [];
    let frame = 0;
    const test = harness(MATTE_RVM.id, 1, {
      inputNames: ["src", "r1i", "r2i", "r3i", "r4i", "downsample_ratio"],
      outputNames: ["pha", "r1o", "r2o", "r3o", "r4o"],
      run: async (feeds) => {
        const side = (feeds.src as { dims: number[] }).dims[2]!;
        fed.push((feeds.r1i as { data: Float32Array }).data[0]!);
        const state = { data: new Float32Array([++frame]) };
        return { pha: { data: new Float32Array(side ** 2).fill(0.5) },
          r1o: state, r2o: state, r3o: state, r4o: state };
      },
    });
    try {
      await test.run("node-a");
      test.target.side = 4;
      await test.run("node-a");
      await test.run("node-a");
      expect(fed).toEqual([0, 0, 2]);
      expect(test.createSession).toHaveBeenCalledTimes(1);
    } finally { test.runner.dispose(); }
  });

  it("shares one RVM session without feeding another node's recurrent tensors", async () => {
    const fed: number[] = [];
    let frame = 0;
    const test = harness(MATTE_RVM.id, 1, {
      inputNames: ["src", "r1i", "r2i", "r3i", "r4i", "downsample_ratio"],
      outputNames: ["pha", "r1o", "r2o", "r3o", "r4o"],
      run: async (feeds) => {
        fed.push((feeds.r1i as { data: Float32Array }).data[0]!);
        const state = { data: new Float32Array([++frame]) };
        return { pha: { data: new Float32Array(4).fill(0.5) },
          r1o: state, r2o: state, r3o: state, r4o: state };
      },
    });
    try {
      for (const nodeId of ["node-a", "node-b", "node-a", "node-b"]) await test.run(nodeId);
      expect(test.createSession).toHaveBeenCalledTimes(1);
      expect(fed).toEqual([0, 0, 1, 2]);
    } finally { test.runner.dispose(); }
  });

  it("does not blend a new node's MODNet matte with another node's previous image", async () => {
    let frame = 0;
    const test = harness("modnet-photographic", 0.5, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: new Float32Array(4).fill(frame++ % 2) } }),
    });
    try {
      await test.run("node-a");
      const second = await test.run("node-b");
      expect(test.createSession).toHaveBeenCalledTimes(1);
      expect([...new Float32Array(second.buffer, second.byteOffset, second.byteLength / 4)])
        .toEqual([1, 1, 1, 1]);
      const third = await test.run("node-a");
      expect([...new Float32Array(third.buffer, third.byteOffset, third.byteLength / 4)])
        .toEqual([0, 0, 0, 0]);
    } finally { test.runner.dispose(); }
  });
});

describe("inference results own transferable storage", () => {
  it("rejects an aliased encoder before smoothing changes model output or retained history", async () => {
    const model = "modnet-photographic";
    const encode = vi.spyOn(MODEL_PLANS[model]!, "encode");
    const outputs = [new Float32Array(4), new Float32Array(4).fill(1), new Float32Array(4).fill(1)];
    let frame = 0;
    const test = harness(model, 0.5, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: outputs[frame++]! } }),
    });
    try {
      await test.run("a");
      encode.mockImplementationOnce(output => new Uint8Array(output.buffer));
      await expect(test.run("a")).rejects.toThrow(/must return an owned exact ArrayBuffer/);
      expect([...outputs[1]!]).toEqual([1, 1, 1, 1]);
      const next = await test.run("a");
      expect([...new Float32Array(next.buffer)]).toEqual([0.5, 0.5, 0.5, 0.5]);
      expect(test.transferredResults).toHaveLength(2);
    } finally {
      test.runner.dispose();
      encode.mockRestore();
    }
  });

  it("transfers the encoder's buffer directly while retaining independent smoothing history", async () => {
    const encode = vi.spyOn(MODEL_PLANS["modnet-photographic"]!, "encode");
    let frame = 0;
    const test = harness("modnet-photographic", 0.5, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: new Float32Array(4).fill(frame++ % 2) } }),
    });
    try {
      const first = await test.run("a");
      const second = await test.run("a");
      const third = await test.run("a");
      expect([...new Float32Array(first.buffer)]).toEqual([0, 0, 0, 0]);
      expect([...new Float32Array(second.buffer)]).toEqual([0.5, 0.5, 0.5, 0.5]);
      expect([...new Float32Array(third.buffer)]).toEqual([0.25, 0.25, 0.25, 0.25]);
      for (let i = 0; i < 3; i += 1) {
        const encoded = encode.mock.results[i]!.value as Uint8Array;
        expect(test.transferredResults[i]).toBe(encoded.buffer);
        expect(encoded.byteLength).toBe(0);
      }
    } finally {
      test.runner.dispose();
      encode.mockRestore();
    }
  });

  it.each(["offset", "aliased"])("refuses an encoder's %s result instead of detaching unrelated storage", async (kind) => {
    const output = new Float32Array(4).fill(0.5);
    const bytes = kind === "offset" ? new Uint8Array(new ArrayBuffer(20), 4, 16) : new Uint8Array(output.buffer);
    const encode = vi.spyOn(MODEL_PLANS["modnet-photographic"]!, "encode").mockReturnValue(bytes);
    const test = harness("modnet-photographic", 1, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: output } }),
    });
    try {
      await expect(test.run("a")).rejects.toThrow(/must return an owned exact ArrayBuffer/);
      expect(output.byteLength).toBe(16);
      expect(test.transferredResults).toHaveLength(0);
    } finally {
      test.runner.dispose();
      encode.mockRestore();
    }
  });

  it.each(Object.entries(MODEL_PLANS))("%s encodes a fresh exact buffer without retaining or detaching model output", (_modelId, plan) => {
    const output = Float32Array.from({ length: 51 }, (_, i) => (i % 4) / 3);
    const before = output.slice();
    const first = plan.encode(output, 2, 2, 2, 2, 2);
    const second = plan.encode(output, 2, 2, 2, 2, 2);
    expect(first.byteOffset).toBe(0);
    expect(first.byteLength).toBe(first.buffer.byteLength);
    expect(first.buffer).toBeInstanceOf(ArrayBuffer);
    expect(first.buffer).not.toBe(output.buffer);
    expect(first.buffer).not.toBe(second.buffer);
    const received = structuredClone(first, { transfer: [first.buffer] });
    expect(first.byteLength).toBe(0);
    expect(received).toEqual(second);
    expect(output).toEqual(before);
    output.fill(0);
    expect(received).toEqual(second);
  });
});
