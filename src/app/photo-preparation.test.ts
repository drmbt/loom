// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPTH_ACCURATE, PHOTO_MASK } from "@runtime/models/model-catalogue.ts";
import type { WorkerRunner, WorkerRunnerOptions } from "@runtime/models/worker-runner.ts";
import type { createModelAcquisition } from "@runtime/models/model-acquisition.ts";
import { decodeFloatMap } from "@runtime/media/float-map.ts";
import { preparedMetadata } from "@runtime/media/prepared-map.ts";
import { createFileReference, parseFileReference } from "@domain/media/file-reference.ts";
import { createPhotoPreparer, decodePreparationPhoto, savePreparedMap, type PreparationPhoto } from "./photo-preparation.ts";

const mocks = vi.hoisted(() => ({ acquisition: vi.fn(), acquire: vi.fn(), cancel: vi.fn(), cache: vi.fn(), runner: vi.fn(), remember: vi.fn() }));
vi.mock("@runtime/models/cache-model-store.ts", () => ({ cacheModelStore: mocks.cache }));
vi.mock("@runtime/models/model-acquisition.ts", async importOriginal => ({
  ...await importOriginal<typeof import("@runtime/models/model-acquisition.ts")>(), createModelAcquisition: mocks.acquisition,
}));
vi.mock("@runtime/models/worker-runner.ts", () => ({ createWorkerRunner: mocks.runner }));
vi.mock("@ui/files/retained-files.ts", () => ({ retainedFiles: () => ({ remember: mocks.remember }) }));

function photograph(): PreparationPhoto {
  return { bitmap: { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap, sha256: "a".repeat(64), name: "sculpture.png" };
}

function rawResult() {
  const values = new Float32Array(16);
  for (let index = 0; index < values.length; index++) values[index] = index - 3.125;
  values[5] = 1 + 2 ** -23;
  values[6] = -0;
  return { bytes: new Uint8Array([255]), raw: { width: 4, height: 4, values } };
}

function runnerWith(result = rawResult()) {
  let options!: WorkerRunnerOptions;
  const runner = {
    run: vi.fn(),
    runRaw: vi.fn(async (nodeId: string, bytes: ArrayBuffer) => {
      const target = options.describe(nodeId);
      if (target === undefined) throw new Error("Missing preparation target");
      expect(bytes.byteLength).toBe(target.side * target.side * 16);
      await options.weightsFor(target.modelId);
      return result;
    }),
    retainNodes: vi.fn(), dispose: vi.fn(),
  };
  mocks.runner.mockImplementation((received: WorkerRunnerOptions) => { options = received; return runner satisfies WorkerRunner; });
  return { runner, options: () => options };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Worker", class { terminate() {} });
  mocks.cache.mockReturnValue({});
  mocks.acquire.mockResolvedValue(new ArrayBuffer(8));
  mocks.acquisition.mockReturnValue({ acquire: mocks.acquire, cancel: mocks.cancel });
  mocks.remember.mockResolvedValue(createFileReference("saved-map", "binary", "depth.loom-f32"));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(128) }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });

describe("photo preparation sessions", () => {
  it("acquires no weights before explicit run, preserving native raw depth precision", async () => {
    const fake = runnerWith();
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    const map = await preparer.run("depth", photograph(), 266);
    expect(mocks.acquire).toHaveBeenCalledWith(DEPTH_ACCURATE);
    expect([map.width, map.height]).toEqual([4, 4]);
    expect(new Uint32Array(map.values.buffer)).toEqual(new Uint32Array(rawResult().raw.values.buffer));
    expect(preparedMetadata(map)).toMatchObject({ kind: "depth", inputSide: 266, registration: "letterbox", model: { id: DEPTH_ACCURATE.id } });
    const nodeId = fake.runner.runRaw.mock.calls[0]![0];
    expect(fake.options().describe(nodeId)).toBeUndefined();
    expect(fake.runner.retainNodes).toHaveBeenCalledWith([]);
    expect(fake.runner.run).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith({ phase: "preparing", message: "Preparing depth input…" });
    preparer.dispose();
  });

  it.each([100, undefined, 0])("reports actual download bytes with total %s and leaves inference indeterminate", async total => {
    const fake = runnerWith();
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    const acquisition = mocks.acquisition.mock.calls[0]![0] as Parameters<typeof createModelAcquisition>[0];
    mocks.acquire.mockImplementationOnce(async () => {
      acquisition.onStateChange!(DEPTH_ACCURATE.id, { kind: "downloading", received: 50, total });
      return new ArrayBuffer(8);
    });
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => {
      const result = await originalRun(id, bytes);
      fake.options().onMeasured!(id, { backend: "wasm", millis: 1500.4, isolated: false });
      return result;
    });
    await preparer.run("depth", photograph(), 266);
    const updates = progress.mock.calls.map(([update]) => update);
    const download = updates.find(update => update.phase === "downloading");
    expect(download.message).toContain("50 B");
    if (total === 100) expect(download.fraction).toBe(0.5);
    else expect(download).not.toHaveProperty("fraction");
    expect(updates.slice(-2)).toEqual([
      { phase: "processing", message: "Running the model on your photo…" },
      { phase: "finishing", message: "wasm · 1500 ms · preparing float32 output" },
    ]);
    expect(updates.filter(update => update.phase !== "downloading").every(update => !("fraction" in update))).toBe(true);
    expect(progress).toHaveBeenLastCalledWith({ phase: "finishing", message: "wasm · 1500 ms · preparing float32 output" });
    preparer.dispose();
  });

  it("opens cached weights and resumes processing without inventing a percentage", async () => {
    runnerWith();
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    await preparer.run("depth", photograph(), 266);
    expect(progress.mock.calls.map(([update]) => update)).toEqual([
      { phase: "preparing", message: "Preparing depth input…" },
      { phase: "processing", message: "Processing depth · 266 × 266" },
      { phase: "preparing", message: "Opening the model cache…" },
      { phase: "processing", message: "Running the model on your photo…" },
    ]);
    preparer.dispose();
  });

  it.each([1036, 1288])("requests native depth detail at %i without changing output precision or dimensions", async side => {
    const result = rawResult();
    const fake = runnerWith(result);
    let requestedTarget: ReturnType<WorkerRunnerOptions["describe"]>;
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { requestedTarget = fake.options().describe(id); return originalRun(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const map = await preparer.run("depth", photograph(), side);
    expect(requestedTarget).toMatchObject({ modelId: DEPTH_ACCURATE.id, nodeType: "depth", side, width: side, height: side, providers: ["wasm"], smoothing: 1 });
    expect(mocks.acquire).toHaveBeenCalledWith(DEPTH_ACCURATE);
    expect([map.width, map.height]).toEqual([result.raw.width, result.raw.height]);
    expect(new Uint32Array(map.values.buffer)).toEqual(new Uint32Array(result.raw.values.buffer));
    expect(preparedMetadata(map)).toMatchObject({ kind: "depth", inputSide: side, registration: "letterbox" });
    preparer.dispose();
  });

  it("defaults the independent mask model to 1024 with stretch registration", async () => {
    const fake = runnerWith({ bytes: new Uint8Array(), raw: { width: 2, height: 1, values: new Float32Array([0.1234567, 0.9876543]) } });
    let requestedTarget: ReturnType<WorkerRunnerOptions["describe"]>;
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { requestedTarget = fake.options().describe(id); return originalRun(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const map = await preparer.run("mask", photograph(), 266);
    expect(mocks.acquire).toHaveBeenCalledWith(PHOTO_MASK);
    expect(requestedTarget).toMatchObject({ modelId: PHOTO_MASK.id, nodeType: "matte", side: 1024, width: 1024, height: 1024, providers: ["wasm"], smoothing: 1 });
    expect(preparedMetadata(map)).toMatchObject({ kind: "mask", inputSide: 1024, registration: "stretch", range: { low: 0, high: 1 } });
    expect(map.values).toEqual(new Float32Array([0.1234567, 0.9876543]));
    preparer.dispose();
  });

  it("requests 1536 mask detail independently of depth detail and preserves native output", async () => {
    const values = new Float32Array([0.1234567, 0.9876543, 2 ** -24, 1 - 2 ** -24, -0, 0.5]);
    const fake = runnerWith({ bytes: new Uint8Array(), raw: { width: 3, height: 2, values } });
    let requestedTarget: ReturnType<WorkerRunnerOptions["describe"]>;
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { requestedTarget = fake.options().describe(id); return originalRun(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const map = await preparer.run("mask", photograph(), 266, 1536);
    expect(requestedTarget).toMatchObject({ modelId: PHOTO_MASK.id, nodeType: "matte", side: 1536, width: 1536, height: 1536, providers: ["wasm"], smoothing: 1 });
    expect(mocks.acquire).toHaveBeenCalledWith(PHOTO_MASK);
    expect([map.width, map.height]).toEqual([3, 2]);
    expect(new Uint32Array(map.values.buffer)).toEqual(new Uint32Array(values.buffer));
    expect(preparedMetadata(map)).toMatchObject({ kind: "mask", inputSide: 1536, registration: "stretch", range: { low: 0, high: 1 } });
    preparer.dispose();
  });

  it("refuses unsupported mask sizes before acquiring weights or invoking inference", async () => {
    const fake = runnerWith();
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run("mask", photograph(), 266, 1288)).rejects.toThrow("Unsupported mask input size");
    expect(fake.runner.runRaw).not.toHaveBeenCalled();
    expect(fake.runner.run).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
  });

  it("refuses unsupported sizes before acquiring weights and unavailable caching", async () => {
    const fake = runnerWith();
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run("depth", photograph(), 500)).rejects.toThrow("Unsupported depth input size");
    expect(fake.runner.runRaw).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
    mocks.cache.mockReturnValue(null);
    expect(() => createPhotoPreparer(() => {})).toThrow("Model caching is unavailable");
  });

  it("disposes workers and cancels acquisitions; late results cannot become usable maps", async () => {
    const fake = runnerWith();
    let finish!: (result: ReturnType<typeof rawResult>) => void;
    fake.runner.runRaw.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const preparer = createPhotoPreparer(() => {});
    const pending = preparer.run("depth", photograph(), 266);
    const rejected = expect(pending).rejects.toThrow("Photo preparation was closed");
    preparer.dispose();
    finish(rawResult());
    await rejected;
    expect(fake.runner.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.cancel.mock.calls.map(call => call[0])).toEqual([DEPTH_ACCURATE.id, PHOTO_MASK.id]);
    await expect(preparer.run("depth", photograph(), 266)).rejects.toThrow("Photo preparation was closed");
  });

  it("reports inference failures without publishing a substitute map", async () => {
    const fake = runnerWith();
    fake.runner.runRaw.mockRejectedValue(new Error("model failed"));
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run("depth", photograph(), 266)).rejects.toThrow("model failed");
    expect(fake.runner.retainNodes).toHaveBeenCalledWith([]);
    preparer.dispose();
  });
});

describe("photo decoding", () => {
  it("hashes the actual source bytes and retains its bitmap", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const bitmap = { width: 4, height: 2, close: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    const controller = new AbortController();
    const result = await decodePreparationPhoto("/photo", "object.png", controller.signal);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.bitmap).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("closes a bitmap completed after cancellation and refuses HTTP failures", async () => {
    const bitmap = { close: vi.fn() };
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { controller.abort(new Error("cancelled")); return bitmap; }));
    await expect(decodePreparationPhoto("/photo", "object.png", controller.signal)).rejects.toThrow("cancelled");
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(decodePreparationPhoto("/missing", "missing.png", new AbortController().signal)).rejects.toThrow("404");
  });
});

describe("saved prepared maps", () => {
  it("writes real float32 bytes before retaining the durable file identity", async () => {
    let written!: Uint8Array;
    const writable = { write: vi.fn(async (bytes: Uint8Array) => { written = bytes.slice(); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const handle = { name: "depth.loomf32", createWritable: vi.fn(async () => writable), getFile: async () => new File([written.buffer as ArrayBuffer], "depth.loomf32") };
    const picker = vi.fn(async (options: { types: readonly { accept: Record<string, readonly string[]> }[] }) => {
      // Match the File System Access suffix rules so this mock cannot accept a
      // filter the browser would reject before showing the save dialog.
      for (const type of options.types) {
        for (const extensions of Object.values(type.accept)) {
          for (const extension of extensions) {
            if (!extension.startsWith(".") || extension.endsWith(".") || extension.length > 16 || !/^[A-Za-z0-9+.]+$/.test(extension)) {
              throw new TypeError(`Failed to execute 'showSaveFilePicker' on 'Window': Extension '${extension}' contains invalid characters.`);
            }
          }
        }
      }
      return handle;
    });
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = picker;
    const map = rawResult().raw;
    const progress = vi.fn();
    const uri = await savePreparedMap(map, "depth", progress);
    expect(picker).toHaveBeenCalledWith({ suggestedName: "depth.loomf32", types: [{ description: "Loom float32 map", accept: { "application/x-loom-f32": [".loomf32"] } }] });
    expect(new Uint32Array(decodeFloatMap(written).values.buffer)).toEqual(new Uint32Array(map.values.buffer));
    expect(mocks.remember).toHaveBeenCalledWith(handle, "binary");
    expect(writable.close.mock.invocationCallOrder[0]!).toBeLessThan(mocks.remember.mock.invocationCallOrder[0]!);
    expect(parseFileReference(uri)?.source.kind).toBe("fileHandle");
    expect(uri).not.toContain("blob:");
    expect(writable.abort).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ phase: "saving", message: "Writing the float32 map…" });
    expect(picker.mock.invocationCallOrder[0]!).toBeLessThan(progress.mock.invocationCallOrder[0]!);
    expect(progress.mock.invocationCallOrder[0]!).toBeLessThan(writable.write.mock.invocationCallOrder[0]!);
  });

  it("reports no write progress while choosing a location or after save cancellation", async () => {
    let cancel!: (error: unknown) => void;
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi.fn(() => new Promise((_resolve, reject) => { cancel = reject; }));
    const progress = vi.fn();
    const pending = savePreparedMap(rawResult().raw, "depth", progress);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).not.toHaveBeenCalled();
    cancel(new DOMException("cancelled", "AbortError"));
    await rejected;
    expect(progress).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
  });

  it("refuses unsupported saving and aborts write failures without retaining a handle", async () => {
    await expect(savePreparedMap(rawResult().raw, "depth")).rejects.toThrow("File System Access");
    const writable = { write: vi.fn(async () => { throw new Error("disk full"); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => writable }));
    await expect(savePreparedMap(rawResult().raw, "depth")).rejects.toThrow("disk full");
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
  });
});
