import { afterEach, describe, expect, it, vi } from "vitest";
import { refinePhotoDepth, type DepthRefinementSettings } from "./photo-depth-refinement.ts";
import { nodeGpuHost, probeDawn } from "./vgpu/node-gpu-host.ts";

const SETTINGS: DepthRefinementSettings = { radius: 2, spatialSigma: 2, colorSigma: 0.1 };
interface Size { width: number; height: number }
interface Depth extends Size { values: Float32Array }
interface Guidance extends Size { rgba: Uint8Array }

afterEach(() => vi.restoreAllMocks());

async function withDevice(run: (device: GPUDevice) => Promise<void>) {
  const probe = await probeDawn();
  expect(probe.available, probe.error).toBe(true);
  const session = await nodeGpuHost().create({});
  try { await run(session.gpu.gpu as GPUDevice); }
  finally { session.dispose(); }
}

function photo(size: Size, textured = false): Guidance {
  return { ...size, rgba: Uint8Array.from({ length: size.width * size.height * 4 }, (_, offset) => {
    const channel = offset % 4;
    const pixel = Math.floor(offset / 4);
    if (channel === 3) return 255;
    if (!textured) return 100;
    return pixel % size.width < size.width / 2 ? [255, 30, 10][channel]! : [5, 20, 255][channel]!;
  }) };
}

function bilinear(values: ArrayLike<number>, size: Size, x: number, y: number, channels = 1, channel = 0): number {
  const px = x * size.width - 0.5, py = y * size.height - 0.5;
  const bx = Math.floor(px), by = Math.floor(py), fx = px - bx, fy = py - by;
  const at = (sx: number, sy: number) => values[(Math.min(size.height - 1, Math.max(0, sy)) * size.width
    + Math.min(size.width - 1, Math.max(0, sx))) * channels + channel]!;
  return (at(bx, by) * (1 - fx) + at(bx + 1, by) * fx) * (1 - fy)
    + (at(bx, by + 1) * (1 - fx) + at(bx + 1, by + 1) * fx) * fy;
}

/** Independent scalar reference at pixel centers, with bounded image neighborhoods. */
function referencePass(input: Depth, guide: Guidance, target: Size, settings: DepthRefinementSettings): Depth {
  const values = new Float32Array(target.width * target.height);
  const color = (x: number, y: number) => [0, 1, 2].map(channel => bilinear(guide.rgba, guide,
    (x + 0.5) / target.width, (y + 0.5) / target.height, 4, channel) / 255);
  for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
    const center = color(x, y);
    let weighted = 0, total = 0;
    for (let dy = -settings.radius; dy <= settings.radius; dy++) for (let dx = -settings.radius; dx <= settings.radius; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= target.width || ny >= target.height) continue;
      const rgb = color(nx, ny);
      const colorDistance = rgb.reduce((sum, value, channel) => sum + (value - center[channel]!) ** 2, 0);
      const weight = Math.exp(-(dx * dx + dy * dy) / (2 * settings.spatialSigma ** 2))
        * Math.exp(-colorDistance / (2 * settings.colorSigma ** 2));
      weighted += weight * bilinear(input.values, input, (nx + 0.5) / target.width, (ny + 0.5) / target.height);
      total += weight;
    }
    values[y * target.width + x] = weighted / total;
  }
  return { ...target, values };
}

describe("one-shot photo depth refinement on Dawn", () => {
  it("preserves signed float depth across progressive refinement without copying RGB texture into flat geometry", async () => {
    await withDevice(async device => {
      const input = { width: 3, height: 2, values: new Float32Array(6).fill(-3.125) };
      const target = { width: 11, height: 7 };
      const original = input.values.slice();
      const stages: Size[] = [];
      const output = await refinePhotoDepth(device, input, photo(target, true), target, SETTINGS,
        { onStage: (stage, total, width, height) => {
          stages.push({ width, height }); expect(stage).toBe(stages.length); expect(total).toBe(2);
        } });
      expect(stages).toEqual([{ width: 6, height: 4 }, target]);
      expect(output).toHaveLength(77);
      for (const value of output) expect(value).toBeCloseTo(-3.125, 5);
      expect(input.values).toEqual(original);
      const flat = await refinePhotoDepth(device, input, photo(target), target, SETTINGS);
      for (let index = 0; index < flat.length; index++) expect(output[index]).toBeCloseTo(flat[index]!, 5);
    });
  });

  it.each([
    { inputSize: { width: 4, height: 3 }, target: { width: 7, height: 5 }, stages: [{ width: 7, height: 5 }] },
    { inputSize: { width: 3, height: 2 }, target: { width: 9, height: 5 }, stages: [{ width: 5, height: 3 }, { width: 9, height: 5 }] },
  ])("matches a numerical bilateral reference on non-square step/ramp depth: $inputSize -> $target", async ({ inputSize, target, stages }) => {
    await withDevice(async device => {
      const input = { ...inputSize, values: Float32Array.from({ length: inputSize.width * inputSize.height }, (_, index) =>
        index % inputSize.width < inputSize.width / 2 ? -0.125 + Math.floor(index / inputSize.width) * 0.02 : 1.5 + index * 0.004) };
      const guide = photo(target, true);
      const originalDepth = input.values.slice(), originalGuide = guide.rgba.slice();
      const output = await refinePhotoDepth(device, input, guide, target, SETTINGS);
      let expected: Depth = input;
      for (const stage of stages) expected = referencePass(expected, guide, stage, SETTINGS);
      for (let index = 0; index < output.length; index++) expect(output[index]).toBeCloseTo(expected.values[index]!, 5);
      expect(output[0]).toBeLessThan(output[target.width - 1]!);
      expect(input.values).toEqual(originalDepth); expect(guide.rgba).toEqual(originalGuide);
    });
  });

  it("performs one final cleanup for unchanged or smaller output and keeps sub-byte scalar precision", async () => {
    await withDevice(async device => {
      const input = { width: 5, height: 3, values: Float32Array.from({ length: 15 }, (_, index) => 0.5 + index * 0.0001) };
      for (const target of [{ width: 5, height: 3 }, { width: 3, height: 2 }]) {
        const progress = vi.fn();
        const guide = photo(target);
        const result = await refinePhotoDepth(device, input, guide, target, SETTINGS, { onStage: progress });
        expect(progress).toHaveBeenCalledTimes(1);
        expect(progress).toHaveBeenCalledWith(1, 1, target.width, target.height);
        const expected = referencePass(input, guide, target, SETTINGS);
        for (let index = 0; index < result.length; index++) expect(result[index]).toBeCloseTo(expected.values[index]!, 6);
        expect(new Set(result).size).toBeGreaterThan(2);
      }
    });
  });

  it("refuses malformed samples, guidance, dimensions, shader parameters and output limits", async () => {
    await withDevice(async device => {
      const input = { width: 2, height: 2, values: new Float32Array(4) };
      const target = { width: 4, height: 4 }, guide = photo(target);
      const create = vi.spyOn(device, "createComputePipelineAsync");
      await expect(refinePhotoDepth(device, { ...input, width: 0 }, guide, target, SETTINGS)).rejects.toThrow(/positive integers/);
      await expect(refinePhotoDepth(device, { ...input, height: 1.5 }, guide, target, SETTINGS)).rejects.toThrow(/positive integers/);
      await expect(refinePhotoDepth(device, { ...input, width: device.limits.maxTextureDimension2D + 1 }, guide, target, SETTINGS)).rejects.toThrow(/dimension limit/);
      if (device.limits.maxTextureDimension2D >= 8001) {
        await expect(refinePhotoDepth(device, { ...input, width: 8001, height: 8000 }, guide, target, SETTINGS)).rejects.toThrow(/64 million/);
      }
      await expect(refinePhotoDepth(device, { ...input, values: new Float32Array(1) }, guide, target, SETTINGS)).rejects.toThrow(/sample count/);
      await expect(refinePhotoDepth(device, { ...input, values: new Float32Array([0, NaN, 1, 2]) }, guide, target, SETTINGS)).rejects.toThrow(/finite/);
      await expect(refinePhotoDepth(device, { ...input, values: new Float32Array([0, Infinity, 1, 2]) }, guide, target, SETTINGS)).rejects.toThrow(/finite/);
      await expect(refinePhotoDepth(device, input, { ...guide, width: 3 }, target, SETTINGS)).rejects.toThrow(/must match/);
      await expect(refinePhotoDepth(device, input, { ...guide, rgba: new Uint8Array(1) }, target, SETTINGS)).rejects.toThrow(/RGBA/);
      for (const radius of [0, 5, 1.5]) await expect(refinePhotoDepth(device, input, guide, target, { ...SETTINGS, radius })).rejects.toThrow(/radius/);
      for (const spatialSigma of [0, 9, Infinity, NaN, 1e-100]) await expect(refinePhotoDepth(device, input, guide, target, { ...SETTINGS, spatialSigma })).rejects.toThrow(/Spatial sigma/);
      for (const colorSigma of [0, 2, Infinity]) await expect(refinePhotoDepth(device, input, guide, target, { ...SETTINGS, colorSigma })).rejects.toThrow(/Color sigma/);
      expect(create).not.toHaveBeenCalled(); create.mockRestore();
    });
  });

  it("cancels before dispatch or after queued work, cleans up and leaves the caller device usable", async () => {
    await withDevice(async device => {
      const input = { width: 2, height: 2, values: new Float32Array(4).fill(-0.25) };
      const target = { width: 9, height: 7 }, guide = photo(target, true);
      const textureDestruction: ReturnType<typeof vi.spyOn>[] = [], bufferDestruction: ReturnType<typeof vi.spyOn>[] = [];
      const createTexture = device.createTexture.bind(device), createBuffer = device.createBuffer.bind(device);
      vi.spyOn(device, "createTexture").mockImplementation(descriptor => {
        const texture = createTexture(descriptor); textureDestruction.push(vi.spyOn(texture, "destroy")); return texture;
      });
      vi.spyOn(device, "createBuffer").mockImplementation(descriptor => {
        const buffer = createBuffer(descriptor); bufferDestruction.push(vi.spyOn(buffer, "destroy")); return buffer;
      });
      const deviceDestroy = vi.spyOn(device, "destroy");
      const canceled = new AbortController(); canceled.abort();
      await expect(refinePhotoDepth(device, input, guide, target, SETTINGS, { signal: canceled.signal })).rejects.toMatchObject({ name: "AbortError" });
      const beforeDispatch = new AbortController();
      const progress = vi.fn(() => beforeDispatch.abort());
      await expect(refinePhotoDepth(device, input, guide, target, SETTINGS, { signal: beforeDispatch.signal, onStage: progress })).rejects.toMatchObject({ name: "AbortError" });
      expect(progress).toHaveBeenCalledTimes(1);
      const afterQueue = new AbortController();
      const originalDone = device.queue.onSubmittedWorkDone.bind(device.queue);
      const completion = vi.spyOn(device.queue, "onSubmittedWorkDone").mockImplementation(async () => {
        await originalDone(); afterQueue.abort();
      });
      await expect(refinePhotoDepth(device, input, guide, target, SETTINGS, { signal: afterQueue.signal })).rejects.toMatchObject({ name: "AbortError" });
      completion.mockRestore();
      const recovered = await refinePhotoDepth(device, input, guide, target, SETTINGS);
      for (const value of recovered) expect(value).toBeCloseTo(-0.25, 6);
      for (const destroy of [...textureDestruction, ...bufferDestruction]) expect(destroy).toHaveBeenCalledTimes(1);
      expect(deviceDestroy).not.toHaveBeenCalled();
    });
  });
});
