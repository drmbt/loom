// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePreparedMap } from "@runtime/media/prepared-map.ts";
import type { PreparationPhoto } from "./photo-preparation.ts";
import { PhotoMappingPreview } from "./photo-mapping-preview.tsx";

const sha256 = "a".repeat(64);
function photo(name = "reference.png", width = 64, height = 64): PreparationPhoto {
  return { name, sha256, bitmap: { width, height, close: vi.fn() } as unknown as ImageBitmap };
}
function maps(source: PreparationPhoto) {
  const values = new Float32Array(64 * 64);
  const coverage = new Float32Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    values[y * 64 + x] = x / 63;
    coverage[y * 64 + x] = (x - 32) ** 2 + (y - 32) ** 2 < 26 ** 2
      && (x - 37) ** 2 + (y - 28) ** 2 >= 10 ** 2 && !(x > 42 && y < 18) ? 1 : 0;
  }
  const metadata = { source: { sha256, width: source.bitmap.width, height: source.bitmap.height },
    model: { id: "test", url: "https://models.test/preview" }, inputSide: 518, registration: "stretch" as const };
  return { depth: makePreparedMap(values, 64, 64, { ...metadata, kind: "depth" }),
    mask: makePreparedMap(coverage, 64, 64, { ...metadata, kind: "mask" }) };
}
function context() {
  const frames: Uint8ClampedArray[] = [];
  return { drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: "", frames,
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: vi.fn((image: ImageData) => frames.push(image.data.slice())) };
}
let contexts: ReturnType<typeof context>[];
let callbacks: Map<number, FrameRequestCallback>;
let motionListeners: Set<(event: MediaQueryListEvent) => void>;
let reduced: boolean;
beforeEach(() => {
  contexts = []; callbacks = new Map(); motionListeners = new Set(); reduced = false;
  let nextFrame = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => {
    const next = context(); contexts.push(next); return next;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { const id = ++nextFrame; callbacks.set(id, callback); return id; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => callbacks.delete(id)));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced,
    addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => motionListeners.add(listener),
    removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => motionListeners.delete(listener) })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("photo mapping dialog preview", () => {
  it("changes preview light without changing the photograph or float maps and replaces its animation", () => {
    const source = photo(); const night = photo("night.png"); const prepared = maps(source);
    const originalDepth = prepared.depth.values.slice(); const originalMask = prepared.mask.values.slice();
    const { rerender } = render(<PhotoMappingPreview photo={source} previewPhoto={night} {...prepared} matching previewOpacity={0} />);
    const [previousId, previousFrame] = [...callbacks.entries()][0]!;
    expect(contexts[0]!.drawImage.mock.calls[0]![0]).toBe(night.bitmap);
    for (const overlay of [contexts[1]!.frames[0]!, contexts[2]!.frames[0]!]) {
      expect(overlay.filter((_value, index) => index % 4 === 3).every(alpha => alpha === 0)).toBe(true);
    }
    rerender(<PhotoMappingPreview photo={source} previewPhoto={night} {...prepared} matching previewOpacity={1} />);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(previousId);
    expect(callbacks.has(previousId)).toBe(false);
    expect(callbacks.size).toBe(1);
    expect(motionListeners.size).toBe(1);
    expect(contexts[3]!.drawImage.mock.calls[0]).toEqual(contexts[0]!.drawImage.mock.calls[0]);
    expect(contexts[4]!.frames[0]![4 * (32 * 64 + 16) + 3]).toBe(42);
    expect(contexts[5]!.frames[0]![4 * (7 * 64 + 32) + 3]).toBe(255);
    const previousDraws = contexts[0]!.drawImage.mock.calls.length;
    act(() => previousFrame(700));
    expect(contexts[0]!.drawImage).toHaveBeenCalledTimes(previousDraws);
    expect(callbacks.size).toBe(1);
    expect(prepared.depth.values).toEqual(originalDepth);
    expect(prepared.mask.values).toEqual(originalMask);
    expect(night.bitmap.close).not.toHaveBeenCalled();
  });

  it("previews explicitly chosen full-frame coverage without a mask file", () => {
    const source = photo(); const night = photo("night.png"); const prepared = maps(source);
    const original = prepared.depth.values.slice();
    render(<PhotoMappingPreview photo={source} previewPhoto={night} depth={prepared.depth} mask={null} fullFrame matching />);
    expect(screen.getByRole("img", { name: "Animated mapping preview" })).toBeDefined();
    expect(contexts[0]!.drawImage.mock.calls[0]![0]).toBe(night.bitmap);
    const fill = contexts[1]!.frames[0]!;
    expect(fill[4 * (28 * 64 + 37) + 3]).toBeGreaterThan(0);
    expect(contexts[2]!.frames[0]![3]).toBeGreaterThan(0);
    expect(prepared.depth.values).toEqual(original);
    expect(callbacks.size).toBe(1);
  });
  it("copies float maps into a small registered view and traces the concavity and hole", () => {
    const source = photo(); const prepared = maps(source);
    const originalDepth = prepared.depth.values.slice();
    const originalMask = prepared.mask.values.slice();
    const { rerender } = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...prepared} matching />);
    const outline = contexts[2]!.frames[0]!;
    for (const [x, y] of [[32, 7], [27, 28], [42, 17]]) expect(outline[4 * (y! * 64 + x!) + 3]).toBeGreaterThan(0);
    for (const [x, y] of [[0, 0], [1, 32], [37, 28], [16, 32]]) expect(outline[4 * (y! * 64 + x!) + 3]).toBe(0);
    expect(contexts[1]!.frames[0]![4 * (28 * 64 + 37) + 3]).toBe(0);
    expect(contexts[1]!.frames[0]!.every(Number.isFinite)).toBe(true);
    expect(prepared.depth.values).toEqual(originalDepth);
    expect(prepared.mask.values).toEqual(originalMask);
    const wide = photo("wide.png", 1920, 960);
    rerender(<PhotoMappingPreview photo={wide} previewPhoto={null} depth={null} mask={maps(wide).mask} matching />);
    const canvas = screen.getByRole("img", { name: "Animated mapping preview" }) as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([480, 240]);
  });

  it("animates boundary colour and cancels its frame and media listener when closed", () => {
    const source = photo(); const prepared = maps(source);
    const { unmount } = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...prepared} matching />);
    expect(screen.getByRole("img", { name: "Animated mapping preview" })).toBeDefined();
    expect(contexts[0]!.drawImage.mock.calls[0]![0]).toBe(source.bitmap);
    const initial = contexts[2]!.frames[0]!.slice();
    const [id, callback] = [...callbacks.entries()][0]!;
    act(() => { callbacks.delete(id); callback(700); });
    expect(contexts[2]!.frames[1]).not.toEqual(initial);
    expect(contexts[2]!.frames[1]!.every(Number.isFinite)).toBe(true);
    expect(callbacks.size).toBe(1);
    unmount();
    expect(callbacks.size).toBe(0);
    expect(motionListeners.size).toBe(0);
    expect(source.bitmap.close).not.toHaveBeenCalled();
  });

  it("uses the separate night bitmap and redraws when the background or mask changes", () => {
    const source = photo(); const night = photo("night.png"); const prepared = maps(source);
    const original = prepared.mask.values.slice();
    const { rerender } = render(<PhotoMappingPreview photo={source} previewPhoto={night} {...prepared} matching />);
    expect(contexts[0]!.drawImage.mock.calls[0]![0]).toBe(night.bitmap);
    expect(contexts[0]!.fillRect).not.toHaveBeenCalled();
    const editedValues = prepared.mask.values.slice(); editedValues[28 * 64 + 37] = 1;
    const edited = { ...prepared.mask, values: editedValues };
    rerender(<PhotoMappingPreview photo={source} previewPhoto={null} depth={prepared.depth} mask={edited} matching />);
    expect(contexts[3]!.drawImage.mock.calls[0]![0]).toBe(source.bitmap);
    expect(contexts[4]!.frames[0]![4 * (28 * 64 + 37) + 3]).toBeGreaterThan(0);
    expect(prepared.mask.values).toEqual(original);
    expect(callbacks.size).toBe(1);
    expect(night.bitmap.close).not.toHaveBeenCalled();
  });

  it.each([
    { reference: [2048, 1152], preview: [1672, 941] },
    { reference: [1672, 941], preview: [2048, 1152] },
    { reference: [3000, 1688], preview: [1672, 941] },
    { reference: [1672, 941], preview: [3000, 1688] },
  ])("accepts the uploaded day/night dimensions despite rounded resize pixels: %j", ({ reference, preview }) => {
    const source = photo("day.png", reference[0]!, reference[1]!);
    const night = photo("night.png", preview[0]!, preview[1]!);
    render(<PhotoMappingPreview photo={source} previewPhoto={night} {...maps(source)} matching />);
    expect(screen.getByRole("img", { name: "Animated mapping preview" })).toBeDefined();
    expect(screen.queryByText(/matching aspect and framing/)).toBeNull();
    expect(contexts[0]!.drawImage.mock.calls[0]![0]).toBe(night.bitmap);
    expect(contexts[0]!.fillRect).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(1);
  });

  it.each([
    { fit: "stretch" as const, rectangle: [0, 0, 64, 32, 0, 0, 64, 64] },
    { fit: "fit" as const, rectangle: [0, 0, 64, 32, 0, 16, 64, 32] },
    { fit: "fill" as const, rectangle: [16, 0, 32, 32, 0, 0, 64, 64] },
  ])("draws the selected $fit framing without changing mask registration", ({ fit, rectangle }) => {
    const source = photo(); const night = photo("wide-night.png", 64, 32); const prepared = maps(source);
    const original = prepared.mask.values.slice();
    render(<PhotoMappingPreview photo={source} previewPhoto={night} {...prepared} matching previewFit={fit} />);
    expect(contexts[0]!.drawImage.mock.calls[0]).toEqual([night.bitmap, ...rectangle]);
    expect(contexts[0]!.fillRect).not.toHaveBeenCalled();
    expect(prepared.mask.values).toEqual(original);
    expect(contexts[2]!.frames[0]![4 * (28 * 64 + 37) + 3]).toBe(0);
  });

  it("protects stale maps while allowing a differently framed preview photo", () => {
    const source = photo(); const prepared = maps(source);
    const { rerender } = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...prepared} matching={false} />);
    expect(screen.getByText(/maps that match/)).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
    expect(contexts).toHaveLength(0);
    rerender(<PhotoMappingPreview photo={source} previewPhoto={photo("cropped.png", 64, 32)} {...prepared} matching />);
    expect(screen.getByRole("img", { name: "Animated mapping preview" })).toBeDefined();
    expect(callbacks.size).toBe(1);
    rerender(<PhotoMappingPreview photo={null} previewPhoto={null} depth={null} mask={null} matching={false} />);
    expect(screen.getByText(/Choose a reference photo/)).toBeDefined();
    expect(callbacks.size).toBe(0);
    rerender(<PhotoMappingPreview photo={source} previewPhoto={null} depth={null} mask={null} matching />);
    expect(screen.getByText(/Prepare or open a mask/)).toBeDefined();
  });

  it("renders the mask alone and honours reduced motion, including preference changes", () => {
    reduced = true;
    const source = photo(); const prepared = maps(source);
    render(<PhotoMappingPreview photo={source} previewPhoto={null} depth={null} mask={prepared.mask} matching />);
    expect(contexts[2]!.frames).toHaveLength(1);
    expect(callbacks.size).toBe(0);
    act(() => motionListeners.forEach(listener => listener({ matches: false } as MediaQueryListEvent)));
    expect(callbacks.size).toBe(1);
    act(() => motionListeners.forEach(listener => listener({ matches: true } as MediaQueryListEvent)));
    expect(callbacks.size).toBe(0);
  });

  it("reports missing canvas support and malformed maps explicitly", () => {
    const source = photo(); const prepared = maps(source);
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    const { rerender } = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...prepared} matching />);
    expect(screen.getByRole("alert").textContent).toMatch(/requires a 2D canvas/);
    expect(callbacks.size).toBe(0);
    rerender(<PhotoMappingPreview photo={source} previewPhoto={null} depth={prepared.depth}
      mask={{ ...prepared.mask, values: new Float32Array(1) }} matching />);
    expect(screen.getByRole("alert").textContent).toMatch(/sample count/);
    expect(callbacks.size).toBe(0);
    const invalidDepth = prepared.depth.values.slice(); invalidDepth[0] = Number.NaN;
    rerender(<PhotoMappingPreview photo={source} previewPhoto={null}
      depth={{ ...prepared.depth, values: invalidDepth }} mask={prepared.mask} matching />);
    expect(screen.getByRole("alert").textContent).toMatch(/sample must be finite/);
    expect(Number.isNaN(invalidDepth[0])).toBe(true);
    expect(callbacks.size).toBe(0);
  });
});
