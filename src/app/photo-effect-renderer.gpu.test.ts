import { describe, expect, it, vi } from "vitest";
import { nodeGpuHost } from "../runtime/backend/vgpu/node-gpu-host.ts";
import type { FrameInputs, ReadbackImage } from "../domain/types/backend.ts";
import { PHOTO_MAPPING_SHADER } from "./photo-mapping-effects.ts";
import { createPhotoEffectRenderer } from "./photo-effect-renderer.ts";

const width = 64, height = 48;
function photograph() {
  const bytes = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) bytes.set([90, 90, 90, 255], pixel * 4);
  return { frameId: 1, bytes };
}
function depthField() {
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) values[y * width + x] = (x / (width - 1) + (y < height / 2 ? 0 : 0.6)) / 1.6;
  }
  return values;
}
function frame(timeSeconds: number, frameIndex: number): FrameInputs {
  return { frame: { timeSeconds, absTimeSeconds: timeSeconds, deltaSeconds: 1 / 60, frameIndex,
    absFrameIndex: frameIndex, mode: "offline", randomSeed: 1 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [width, height] };
}
function rgb(image: ReadbackImage): Uint8Array {
  expect(image.width).toBe(width); expect(image.height).toBe(height);
  expect(image.format).toBe("rgba8unorm-srgb");
  const result = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) result.set(image.bytes.subarray(y * image.rowStride + x * 4, y * image.rowStride + x * 4 + 3), (y * width + x) * 3);
  }
  return result;
}

describe("photo effect preview runs the real isolated mapping network", () => {
  it("keeps a flat full-frame surface uniform through its image edges without a coloured frame", async () => {
    const renderer = await createPhotoEffectRenderer({ width, height, shader: PHOTO_MAPPING_SHADER,
      photo: photograph(), photoSize: [width, height], depth: new Float32Array(width * height).fill(0.5),
      mask: new Float32Array(width * height).fill(1), mode: 0, previewOpacity: 1 }, { host: nodeGpuHost() });
    try {
      renderer.draw(frame(0, 0));
      const image = rgb(await renderer.read());
      const center = image.subarray((24 * width + 32) * 3, (24 * width + 32) * 3 + 3);
      for (const [x, y] of [[0, 0], [32, 0], [63, 24], [32, 47]]) {
        const edge = image.subarray((y! * width + x!) * 3, (y! * width + x!) * 3 + 3);
        expect(Array.from(edge).every((value, channel) => Math.abs(value - center[channel]!) <= 1)).toBe(true);
      }
    } finally { renderer.dispose(); }
  });
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])("renders mode %i with depth structure and actual animation even with an entirely white mask", async mode => {
    const depth = depthField(), mask = new Float32Array(width * height).fill(1), photo = photograph();
    const beforeDepth = new Uint32Array(depth.buffer).slice(), beforeMask = new Uint32Array(mask.buffer).slice(), beforePhoto = photo.bytes.slice();
    const renderer = await createPhotoEffectRenderer({ width, height, shader: PHOTO_MAPPING_SHADER, photo,
      photoSize: [width, height], depth, mask, mode, previewOpacity: 1 }, { host: nodeGpuHost() });
    try {
      renderer.draw(frame(0, 0));
      const first = rgb(await renderer.read());
      const colors = new Set<string>();
      for (let index = 0; index < first.length; index += 3) colors.add(`${first[index]},${first[index + 1]},${first[index + 2]}`);
      expect(colors.size).toBeGreaterThan(16);
      expect(Math.max(...first) - Math.min(...first)).toBeGreaterThan(32);
      renderer.draw(frame(7, 420));
      const animated = rgb(await renderer.read());
      const changed = animated.reduce((count, value, index) => count + Number(Math.abs(value - first[index]!) > 3), 0);
      expect(changed / animated.length).toBeGreaterThan(0.1);
      expect(new Uint32Array(depth.buffer)).toEqual(beforeDepth);
      expect(new Uint32Array(mask.buffer)).toEqual(beforeMask);
      expect(photo.bytes).toEqual(beforePhoto);
    } finally { renderer.dispose(); }
    renderer.dispose();
    expect(() => renderer.draw(frame(0, 0))).toThrow(/disposed/);
    expect(() => renderer.read()).toThrow(/disposed/);
  });

  it("renders regular calibration cells and axes through the same mask, leaving excluded pixels photo-only", async () => {
    const w = 256, h = 192, photo = { frameId: 1, bytes: new Uint8Array(w * h * 4) };
    for (let pixel = 0; pixel < w * h; pixel++) photo.bytes.set([90, 90, 90, 255], pixel * 4);
    const depth = Float32Array.from({ length: w * h }, (_, index) => index % w / (w - 1));
    const mask = Float32Array.from({ length: w * h }, (_, index) => Number(index % w >= w / 4));
    const depthBits = new Uint32Array(depth.buffer).slice(), maskBits = new Uint32Array(mask.buffer).slice();
    const options = { width: w, height: h, shader: PHOTO_MAPPING_SHADER, photo, photoSize: [w, h] as const,
      depth, mask, mode: 2, testPattern: true };
    const baseline = await createPhotoEffectRenderer({ ...options, previewOpacity: 0 }, { host: nodeGpuHost() });
    const pattern = await createPhotoEffectRenderer({ ...options, previewOpacity: 1 }, { host: nodeGpuHost() });
    try {
      const input = { ...frame(0, 0), resolution: [w, h] as const };
      baseline.draw(input); pattern.draw(input);
      const original = await baseline.read(), projected = await pattern.read();
      const at = (image: ReadbackImage, x: number, y: number) => [...image.bytes.subarray(y * image.rowStride + x * 4, y * image.rowStride + x * 4 + 4)];
      let insideLight = 0, referenceLight = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const after = at(projected, x, y), before = at(original, x, y);
          if (x < w / 4) expect(after).toEqual(before);
          else { insideLight += after[0]! + after[1]! + after[2]!; referenceLight += before[0]! + before[1]! + before[2]!; }
        }
      }
      expect(insideLight / (w * 0.75 * h * 3) - referenceLight / (w * 0.75 * h * 3)).toBeGreaterThan(10);
      // Adjacent cell centers differ; the two center axes carry distinct directions.
      expect(at(projected, 192, 29)).not.toEqual(at(projected, 218, 29));
      const vertical = at(projected, 128, 29), horizontal = at(projected, 218, 96);
      expect(vertical[0]).toBeGreaterThan(vertical[1]!);
      expect(horizontal[1]).toBeGreaterThan(horizontal[0]!);
      expect(new Uint32Array(depth.buffer)).toEqual(depthBits);
      expect(new Uint32Array(mask.buffer)).toEqual(maskBits);
    } finally { baseline.dispose(); pattern.dispose(); }
  });

  it("uploads successive Video frames by their counter while the photo, depth and independent mask stay fixed", async () => {
    const photo = photograph(), originalPhoto = photo.bytes.slice(), depth = depthField();
    const mask = Float32Array.from({ length: width * height }, (_, index) => Number(index % width >= width / 2));
    const beforeDepth = new Uint32Array(depth.buffer).slice(), beforeMask = new Uint32Array(mask.buffer).slice();
    const first = new Uint8Array(width * height * 4), second = new Uint8Array(first.length);
    for (let pixel = 0; pixel < width * height; pixel++) {
      first.set([255, 0, 0, 255], pixel * 4); second.set([0, 0, 255, 255], pixel * 4);
    }
    let current = { frameId: 1, bytes: first };
    const video = { currentFrame: vi.fn(() => current), ended: false };
    const renderer = await createPhotoEffectRenderer({ width, height, shader: PHOTO_MAPPING_SHADER, photo,
      photoSize: [width, height], video, videoSize: [width, height], depth, mask, mode: 9, previewOpacity: 1 }, { host: nodeGpuHost() });
    try {
      renderer.draw(frame(0, 0)); const red = await renderer.read();
      current = { frameId: 2, bytes: second };
      renderer.draw(frame(0, 1)); const blue = await renderer.read();
      const sample = (image: ReadbackImage, x: number) => [...image.bytes.subarray(24 * image.rowStride + x * 4, 24 * image.rowStride + x * 4 + 4)];
      expect(sample(red, 8)).toEqual(sample(blue, 8));
      expect(sample(red, 48)[0]).toBeGreaterThan(sample(red, 48)[2]!);
      expect(sample(blue, 48)[2]).toBeGreaterThan(sample(blue, 48)[0]!);
      expect(sample(red, 48)).not.toEqual(sample(blue, 48));
      expect(video.currentFrame).toHaveBeenCalled();
      expect(photo.bytes).toEqual(originalPhoto);
      expect(new Uint32Array(depth.buffer)).toEqual(beforeDepth);
      expect(new Uint32Array(mask.buffer)).toEqual(beforeMask);
    } finally { renderer.dispose(); }
  });

  it("refuses Video preview without a supplied clip before acquiring any GPU owner", async () => {
    const host = { label: "Video must be selected", create: vi.fn(async () => { throw new Error("GPU owner must not be acquired"); }) };
    await expect(createPhotoEffectRenderer({ width, height, shader: PHOTO_MAPPING_SHADER, photo: photograph(),
      photoSize: [width, height], depth: depthField(), mask: new Float32Array(width * height).fill(1), mode: 9,
      previewOpacity: 1 }, { host })).rejects.toThrow(/video.*(?:required|source|select)|(?:select|choose).*video/i);
    expect(host.create).not.toHaveBeenCalled();
  });

  it("shows only the supplied separately framed reference at zero effect opacity", async () => {
    const previewBytes = new Uint8Array(32 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 32; x++) previewBytes.set(y < 8 ? [255, 0, 0, 255] : y >= 56 ? [0, 255, 0, 255] : [0, 0, 255, 255], (y * 32 + x) * 4);
    }
    const renderer = await createPhotoEffectRenderer({ width, height, shader: PHOTO_MAPPING_SHADER,
      photo: photograph(), photoSize: [width, height], previewPhoto: { frameId: 1, bytes: previewBytes }, previewPhotoSize: [32, 64],
      previewFit: "fill", previewFraming: { x: 0.5, y: 0, zoom: 1 },
      depth: depthField(), mask: new Float32Array(width * height).fill(1), mode: 1, previewOpacity: 0 }, { host: nodeGpuHost() });
    try {
      renderer.draw(frame(0, 0));
      const image = await renderer.read();
      const top = image.bytes.subarray(32 * 4, 32 * 4 + 4);
      const bottom = image.bytes.subarray(47 * image.rowStride + 32 * 4, 47 * image.rowStride + 32 * 4 + 4);
      expect(top[0]).toBeGreaterThan(0); expect(top[1]).toBe(0); expect(top[2]).toBe(0);
      expect(bottom[0]).toBe(0); expect(bottom[1]).toBe(0); expect(bottom[2]).toBeGreaterThan(0);
      expect(top[3]).toBe(255); expect(bottom[3]).toBe(255);
    } finally { renderer.dispose(); }
  });
});
