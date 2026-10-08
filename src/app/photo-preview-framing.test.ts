import { describe, expect, it } from "vitest";
import { hasMatchingPhotoAspect, previewPhotoPlacement } from "./photo-preview-framing.ts";

describe("preview photo registration", () => {
  it.each([
    [{ width: 3000, height: 1688 }, { width: 1672, height: 941 }],
    [{ width: 2048, height: 1152 }, { width: 1672, height: 941 }],
    [{ width: 4, height: 2 }, { width: 8, height: 4 }],
  ])("accepts pixel rounding after proportional resizing in either direction", (reference, preview) => {
    expect(hasMatchingPhotoAspect(reference, preview)).toBe(true);
    expect(hasMatchingPhotoAspect(preview, reference)).toBe(true);
  });
  it("still identifies materially different aspect ratios", () => {
    expect(hasMatchingPhotoAspect({ width: 3000, height: 1688 }, { width: 1600, height: 1200 })).toBe(false);
    expect(hasMatchingPhotoAspect({ width: 4, height: 2 }, { width: 8, height: 2 })).toBe(false);
  });
  it("preserves the whole image with centered margins on Fit", () => {
    const placed = previewPhotoPlacement({ width: 400, height: 300 }, { width: 400, height: 200 }, "fit");
    expect(placed.source).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(placed.destination).toMatchObject({ y: 0, height: 200 });
    expect(placed.destination.x).toBeCloseTo(200 / 3, 10);
    expect(placed.destination.width).toBeCloseTo(800 / 3, 10);
  });
  it("crops the center without changing proportions on Fill", () => {
    expect(previewPhotoPlacement({ width: 400, height: 300 }, { width: 400, height: 200 }, "fill")).toEqual({
      source: { x: 0, y: 50, width: 400, height: 200 },
      destination: { x: 0, y: 0, width: 400, height: 200 },
    });
  });
  it("uses the full source and destination on Stretch", () => {
    expect(previewPhotoPlacement({ width: 400, height: 300 }, { width: 400, height: 200 }, "stretch")).toEqual({
      source: { x: 0, y: 0, width: 400, height: 300 },
      destination: { x: 0, y: 0, width: 400, height: 200 },
    });
  });
  it("reads Stretch dimensions from nonenumerable prototype getters", () => {
    class BitmapSize {
      readonly #dimensions: readonly [number, number];
      constructor(dimensions: readonly [number, number]) { this.#dimensions = dimensions; }
      get width() { return this.#dimensions[0]; }
      get height() { return this.#dimensions[1]; }
    }
    const source = new BitmapSize([1448, 1086]);
    const target = new BitmapSize([360, 240]);
    expect(Object.getOwnPropertyDescriptor(BitmapSize.prototype, "width")?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(BitmapSize.prototype, "height")?.enumerable).toBe(false);
    expect(previewPhotoPlacement(source, target, "stretch")).toEqual({
      source: { x: 0, y: 0, width: 1448, height: 1086 },
      destination: { x: 0, y: 0, width: 360, height: 240 },
    });
  });
});
