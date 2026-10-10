import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_FRAMING, imageFramingFromParameters, imageFramingParameters, imageFramingSchema,
  imagePlacement, type ImageFraming } from "./image-framing.ts";

describe("image framing geometry and persisted settings", () => {
  it("keeps centered legacy defaults and round trips explicit static graph fields", () => {
    expect(imageFramingFromParameters({})).toEqual(DEFAULT_IMAGE_FRAMING);
    expect(imageFramingParameters(DEFAULT_IMAGE_FRAMING)).toEqual({ imageAnchorX: 0.5, imageAnchorY: 0.5, imageZoom: 1 });
    const framing = { x: 0.1, y: 0.8, zoom: 2.5 };
    expect(imageFramingFromParameters(imageFramingParameters(framing))).toEqual(framing);
    expect(imageFramingFromParameters({ imageAnchorX: { mode: "static", bindings: { static: { kind: "static", value: 0.25 } } } })).toEqual({ x: 0.25, y: 0.5, zoom: 1 });
  });

  it("preserves whole-image Fit, center-cropped Fill and full Stretch placements", () => {
    const source = { width: 400, height: 300 }, target = { width: 400, height: 200 };
    const fit = imagePlacement(source, target, "fit");
    expect(fit.source).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(fit.destination.y).toBe(0); expect(fit.destination.height).toBe(200);
    expect(fit.destination.x).toBeCloseTo(200 / 3, 10);
    expect(fit.destination.width).toBeCloseTo(800 / 3, 10);
    expect(imagePlacement(source, target, "fill")).toEqual({ source: { x: 0, y: 50, width: 400, height: 200 },
      destination: { x: 0, y: 0, width: 400, height: 200 } });
    expect(imagePlacement(source, target, "stretch")).toEqual({ source: { x: 0, y: 0, width: 400, height: 300 },
      destination: { x: 0, y: 0, width: 400, height: 200 } });
  });

  it("pans the Fill crop to the chosen edge in either source orientation", () => {
    const source = { width: 400, height: 300 }, target = { width: 400, height: 200 };
    expect(imagePlacement(source, target, "fill", { x: 0.5, y: 0, zoom: 1 }).source.y).toBe(0);
    expect(imagePlacement(source, target, "fill", { x: 0.5, y: 1, zoom: 1 }).source.y).toBe(100);
    const portrait = imagePlacement({ width: 600, height: 300 }, { width: 200, height: 400 }, "fill", { x: 1, y: 0.5, zoom: 1 });
    expect(portrait.source).toEqual({ x: 450, y: 0, width: 150, height: 300 });
    expect(portrait.destination).toEqual({ x: 0, y: 0, width: 200, height: 400 });
  });

  it("anchors Fit borders without introducing a source crop", () => {
    const source = { width: 400, height: 300 }, target = { width: 400, height: 200 };
    const left = imagePlacement(source, target, "fit", { x: 0, y: 0.5, zoom: 1 });
    const right = imagePlacement(source, target, "fit", { x: 1, y: 0.5, zoom: 1 });
    expect(left.destination.x).toBe(0);
    expect(right.destination.x + right.destination.width).toBeCloseTo(target.width, 10);
    expect(left.source).toEqual(right.source);
    const bottom = imagePlacement({ width: 400, height: 200 }, { width: 400, height: 300 }, "fit", { x: 0.5, y: 1, zoom: 1 });
    expect(bottom.destination).toEqual({ x: 0, y: 100, width: 400, height: 200 });
  });

  it("zooms a matching-aspect frame with a movable source crop", () => {
    expect(imagePlacement({ width: 400, height: 200 }, { width: 800, height: 400 }, "fit", { x: 0.25, y: 1, zoom: 2 })).toEqual({
      source: { x: 50, y: 100, width: 200, height: 100 },
      destination: { x: 0, y: 0, width: 800, height: 400 },
    });
  });

  it("zooms Stretch independently of source and target proportions", () => {
    expect(imagePlacement({ width: 400, height: 300 }, { width: 400, height: 200 }, "stretch", { x: 1, y: 0, zoom: 4 })).toEqual({
      source: { x: 300, y: 0, width: 100, height: 75 },
      destination: { x: 0, y: 0, width: 400, height: 200 },
    });
  });

  it("bounds source and destination rectangles for all fit modes, anchors and allowed zooms", () => {
    for (const [source, target] of [[{ width: 3000, height: 1688 }, { width: 1672, height: 941 }],
      [{ width: 800, height: 100 }, { width: 50, height: 900 }]]) {
      for (const fit of ["fit", "fill", "stretch"] as const) for (const zoom of [1, 1.7, 8]) {
        for (const x of [0, 0.3, 1]) for (const y of [0, 0.6, 1]) {
          const placed = imagePlacement(source!, target!, fit, { x, y, zoom });
          for (const [rectangle, size] of [[placed.source, source!], [placed.destination, target!]] as const) {
            expect(rectangle.x).toBeGreaterThanOrEqual(0); expect(rectangle.y).toBeGreaterThanOrEqual(0);
            expect(rectangle.width).toBeGreaterThan(0); expect(rectangle.height).toBeGreaterThan(0);
            expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(size.width + 1e-9);
            expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(size.height + 1e-9);
          }
        }
      }
    }
  });

  it("reads sizes from nonenumerable bitmap-style getters", () => {
    class Size {
      get width() { return 1448; }
      get height() { return 1086; }
    }
    expect(imagePlacement(new Size(), { width: 360, height: 240 }, "stretch")).toEqual({
      source: { x: 0, y: 0, width: 1448, height: 1086 }, destination: { x: 0, y: 0, width: 360, height: 240 },
    });
  });

  it.each(["imageAnchorX", "imageAnchorY", "imageZoom"])("refuses nonstatic %s despite its retained value", key => {
    expect(() => imageFramingFromParameters({ [key]: { mode: "expression", bindings: { static: { kind: "static", value: 0.5 } } } })).toThrow(new RegExp(`${key} requires static mode`));
  });

  it.each([{ x: -0.1 }, { x: 1.1 }, { y: -1 }, { y: Infinity }, { x: NaN },
    { zoom: 0.9 }, { zoom: 8.1 }, { zoom: Infinity }, { extra: true }, { zoom: undefined }])("rejects invalid framing: %j", change => {
    const framing = { ...DEFAULT_IMAGE_FRAMING, ...change };
    expect(imageFramingSchema.safeParse(framing).success).toBe(false);
    expect(() => imagePlacement({ width: 10, height: 10 }, { width: 10, height: 10 }, "fit", framing as ImageFraming)).toThrow();
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid source and target dimensions: %s", dimension => {
    for (const size of [{ width: dimension, height: 10 }, { width: 10, height: dimension }]) {
      expect(() => imagePlacement(size, { width: 10, height: 10 }, "fit")).toThrow(/Source dimensions/);
      expect(() => imagePlacement({ width: 10, height: 10 }, size, "fit")).toThrow(/Target dimensions/);
    }
  });

  it("refuses unknown modes and invalid persisted values rather than guessing", () => {
    expect(() => imagePlacement({ width: 10, height: 10 }, { width: 10, height: 10 }, "auto" as "fit")).toThrow(/Invalid image fit mode/);
    expect(() => imageFramingFromParameters({ imageAnchorX: "0.5" })).toThrow();
    expect(() => imageFramingFromParameters({ imageZoom: 9 })).toThrow();
    expect(() => imageFramingFromParameters({ imageAnchorY: -0.5 })).toThrow();
  });
});
