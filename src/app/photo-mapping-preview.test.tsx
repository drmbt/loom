// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePreparedMap, rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import { remapDepthValues } from "@runtime/media/depth-tools.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { PreparationPhoto } from "./photo-preparation.ts";
import type { PhotoEffectRenderRequest } from "./photo-effect-renderer.ts";
import { PHOTO_MAPPING_SHADER } from "./photo-mapping-effects.ts";
import { PhotoMappingPreview } from "./photo-mapping-preview.tsx";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./photo-effect-renderer.ts", () => ({ createPhotoEffectRenderer: mocks.create }));
const sha256 = "a".repeat(64);
function photo(name = "reference.png", width = 64, height = 64): PreparationPhoto {
  return { name, sha256, bitmap: { width, height, close: vi.fn() } as unknown as ImageBitmap };
}
function maps(source: PreparationPhoto) {
  const values = Float32Array.from({ length: 64 * 64 }, (_, index) => index % 64 / 63);
  const coverage = Float32Array.from({ length: 64 * 64 }, (_, index) => index % 64 >= 16 && index % 64 <= 48 ? 1 : 0);
  const metadata = { source: { sha256, width: source.bitmap.width, height: source.bitmap.height },
    model: { id: "test", url: "https://models.test/preview" }, inputSide: 518, registration: "stretch" as const };
  return { depth: makePreparedMap(values, 64, 64, { ...metadata, kind: "depth" }),
    mask: makePreparedMap(coverage, 64, 64, { ...metadata, kind: "mask" }) };
}
const previewMaps = (prepared: { depth: ReturnType<typeof makePreparedMap> | null; mask: ReturnType<typeof makePreparedMap> | null }) => ({ readMaps: () => prepared });
function ownedRenderer() {
  const presentation = { dispose: vi.fn() };
  return { draw: vi.fn<(frame: FrameInputs) => void>(), present: vi.fn(() => presentation), dispose: vi.fn(), presentation };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
let renderer: ReturnType<typeof ownedRenderer>;
let callbacks: Map<number, FrameRequestCallback>;
let motionListeners: Set<(event: MediaQueryListEvent) => void>;
let reduced: boolean;
let videos: HTMLVideoElement[];
let videoReady: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  renderer = ownedRenderer(); mocks.create.mockReset(); mocks.create.mockResolvedValue(renderer);
  callbacks = new Map(); motionListeners = new Set(); reduced = false;
  videos = [];
  videoReady = vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(320);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(180);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function(this: HTMLMediaElement) {
    const video = this as HTMLVideoElement;
    if (!videos.includes(video)) videos.push(video);
  });
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { const id = ++nextFrame; callbacks.set(id, callback); return id; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => callbacks.delete(id)));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced,
    addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => motionListeners.add(listener),
    removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => motionListeners.delete(listener) })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const requested = () => mocks.create.mock.calls.at(-1)![0] as PhotoEffectRenderRequest;

describe("real photo projection effect preview", () => {
  it("renders the actual shader with registered float32 maps and borrowed reference frames", async () => {
    const source = photo(), night = photo("night.png", 96, 48), prepared = maps(source);
    const original = [prepared.depth, prepared.mask].map(map => new Uint32Array(map.values.buffer).slice());
    render(<PhotoMappingPreview photo={source} previewPhoto={night} {...previewMaps(prepared)} matching
      mode={3} previewOpacity={0.7} previewFit="fill" previewFraming={{ x: 0.2, y: 0.8, zoom: 2 }} />);
    await settle();
    const request = requested();
    expect(request.shader).toBe(PHOTO_MAPPING_SHADER);
    expect(request).toMatchObject({ width: 64, height: 64, mode: 3, previewOpacity: 0.7,
      photo: { image: source.bitmap, frameId: 1 }, photoSize: [64, 64],
      previewPhoto: { image: night.bitmap, frameId: 1 }, previewPhotoSize: [96, 48],
      previewFit: "fill", previewFraming: { x: 0.2, y: 0.8, zoom: 2 } });
    expect(request.depth).toEqual(rasterizeFloatMap(prepared.depth, "depth", 64, 64));
    expect(request.mask).toEqual(prepared.mask.values);
    expect(request.depth).not.toBe(prepared.depth.values); expect(request.mask).not.toBe(prepared.mask.values);
    expect(renderer.present).toHaveBeenCalledWith(screen.getByRole("img", { name: "Animated mapping preview" }));
    expect(screen.getByText("Projection effect · depth + surface mask")).toBeDefined();
    expect([prepared.depth, prepared.mask].map(map => new Uint32Array(map.values.buffer))).toEqual(original);
    expect(source.bitmap.close).not.toHaveBeenCalled(); expect(night.bitmap.close).not.toHaveBeenCalled();
  });

  it("reuses one compiled renderer and passes the RAF clock into actual graph frames", async () => {
    const source = photo(), prepared = maps(source), readMaps = previewMaps(prepared);
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...readMaps} matching />);
    await settle();
    const [id, callback] = [...callbacks.entries()][0]!;
    act(() => { callbacks.delete(id); callback(700); });
    expect(renderer.draw).toHaveBeenCalledTimes(2);
    expect(renderer.draw.mock.calls[1]![0]).toMatchObject({ frame: { timeSeconds: 0.7, absTimeSeconds: 0.7, deltaSeconds: 0.7, mode: "realtime" }, resolution: [64, 64] });
    result.rerender(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(prepared)} matching />);
    await settle();
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(1);
    expect(requested().previewPhoto).toBeUndefined(); expect(requested().previewFraming).toBeUndefined();
  });

  it("uses explicit white full-frame coverage and neutral depth without files", async () => {
    const source = photo("wide.png", 1920, 960);
    render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps({ depth: null, mask: null })} fullFrame matching />);
    await settle();
    const request = requested();
    expect([request.width, request.height]).toEqual([960, 480]);
    expect(request.depth.every(value => value === 0.5)).toBe(true);
    expect(request.mask.every(value => value === 1)).toBe(true);
    expect(screen.getByText("Projection effect · neutral depth + full frame")).toBeDefined();
  });

  it("retains the surface mask and remaps only the working depth branch", async () => {
    const source = photo(), prepared = maps(source), original = new Uint32Array(prepared.depth.values.buffer).slice();
    const depthRange = { low: 0.25, high: 0.75, softness: 0.02 };
    render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(prepared)} matching depthRange={depthRange} maxLongEdge={32} />);
    await settle();
    expect([requested().width, requested().height]).toEqual([32, 32]);
    expect(requested().depth).toEqual(remapDepthValues(prepared.depth, 32, 32, depthRange));
    expect(requested().mask).toEqual(rasterizeFloatMap(prepared.mask, "mask", 32, 32));
    expect(new Uint32Array(prepared.depth.values.buffer)).toEqual(original);
  });

  it("rebuilds on selected effect/light changes and releases the previous surface and renderer once", async () => {
    const source = photo(), prepared = maps(source), readMaps = previewMaps(prepared);
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...readMaps} matching mode={0} previewOpacity={0} />);
    await settle();
    const previous = renderer, [oldId, oldCallback] = [...callbacks.entries()][0]!;
    renderer = ownedRenderer(); mocks.create.mockResolvedValue(renderer);
    result.rerender(<PhotoMappingPreview photo={source} previewPhoto={null} {...readMaps} matching mode={4} previewOpacity={1} />);
    await settle();
    expect(previous.presentation.dispose).toHaveBeenCalledTimes(1); expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(oldId);
    expect(requested()).toMatchObject({ mode: 4, previewOpacity: 1 });
    act(() => oldCallback(700));
    expect(previous.draw).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(1);
    result.unmount(); expect(renderer.presentation.dispose).toHaveBeenCalledTimes(1); expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0); expect(motionListeners.size).toBe(0);
  });

  it("retires a renderer that arrives after the preview closes without presenting or drawing", async () => {
    const source = photo(), loading = deferred<ReturnType<typeof ownedRenderer>>(); mocks.create.mockReturnValue(loading.promise);
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching />);
    result.unmount();
    await act(async () => { loading.resolve(renderer); await loading.promise; });
    expect(renderer.dispose).toHaveBeenCalledTimes(1); expect(renderer.present).not.toHaveBeenCalled(); expect(renderer.draw).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0); expect(motionListeners.size).toBe(0);
  });

  it("draws one reduced-motion frame and responds to preference changes", async () => {
    reduced = true;
    const source = photo();
    render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching />);
    await settle(); expect(renderer.draw).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(0);
    act(() => motionListeners.forEach(listener => listener({ matches: false } as MediaQueryListEvent)));
    expect(callbacks.size).toBe(1);
    act(() => motionListeners.forEach(listener => listener({ matches: true } as MediaQueryListEvent)));
    expect(callbacks.size).toBe(0); expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("does not start GPU work while the photo or matching mask is pending", async () => {
    const source = photo(), prepared = maps(source);
    const result = render(<PhotoMappingPreview photo={null} previewPhoto={null} {...previewMaps({ depth: null, mask: null })} matching={false} />);
    expect(screen.getByText(/Choose a reference photo/)).toBeDefined();
    result.rerender(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(prepared)} matching={false} />);
    expect(screen.getByText(/maps that match/)).toBeDefined();
    result.rerender(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps({ depth: prepared.depth, mask: null })} matching />);
    expect(screen.getByText(/Prepare or open a mask/)).toBeDefined();
    await settle(); expect(mocks.create).not.toHaveBeenCalled(); expect(callbacks.size).toBe(0);
  });

  it("reports GPU unavailability without a CPU approximation or inference", async () => {
    mocks.create.mockRejectedValue(new Error("No WebGPU adapter is available"));
    const source = photo(); render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching />);
    await settle();
    expect(screen.getByRole("note").textContent).toContain("No WebGPU adapter is available");
    expect(screen.queryByRole("img")).toBeNull(); expect(callbacks.size).toBe(0); expect(motionListeners.size).toBe(0);
  });

  it("disposes owned resources when drawing fails and never resumes its loop", async () => {
    const source = photo();
    render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching />);
    await settle();
    renderer.draw.mockImplementation(() => { throw new Error("GPU device lost"); });
    const [id, callback] = [...callbacks.entries()][0]!;
    act(() => { callbacks.delete(id); callback(800); });
    expect(screen.getByRole("note").textContent).toContain("GPU device lost");
    expect(renderer.presentation.dispose).toHaveBeenCalledTimes(1); expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0); expect(motionListeners.size).toBe(0);
  });

  it("rejects malformed numerical maps and invalid preview sizes before renderer acquisition", async () => {
    const source = photo(), prepared = maps(source);
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null}
      {...previewMaps({ depth: prepared.depth, mask: { ...prepared.mask, values: new Float32Array(1) } })} matching />);
    await settle(); expect(screen.getByRole("note").textContent).toMatch(/sample count/);
    result.rerender(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(prepared)} matching maxLongEdge={0} />);
    await settle(); expect(screen.getByRole("note").textContent).toMatch(/maximum edge/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("renders the explicit calibration pattern with normal mask coverage and no video requirement", async () => {
    const source = photo(), prepared = maps(source);
    render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(prepared)} matching mode={9} testPattern />);
    await settle();
    expect(requested().testPattern).toBe(true); expect(requested().mask).toEqual(prepared.mask.values);
    expect(requested().video).toBeUndefined(); expect(videos).toHaveLength(0);
  });

  it("requires a mapped video without substituting the reference photograph", async () => {
    const source = photo();
    render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching mode={9} />);
    await settle();
    expect(screen.getByRole("note").textContent).toContain("Choose a video"); expect(mocks.create).not.toHaveBeenCalled();
  });

  it("owns the decoded looping video and publishes new monotonic frame identities only when its time changes", async () => {
    const source = photo(), prepared = maps(source), original = prepared.mask.values.slice();
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(prepared)} matching mode={9} videoUrl="blob:video" />);
    await settle();
    const video = videos[0]!;
    expect(video.muted).toBe(true); expect(video.loop).toBe(true); expect(video.playsInline).toBe(true); expect(video.preload).toBe("auto");
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(requested().videoSize).toEqual([320, 180]);
    const provider = requested().video!;
    const first = provider.currentFrame()!;
    expect(first.image).toBe(video); expect(first.frameId).toBe(1);
    expect(provider.currentFrame()!.frameId).toBe(1);
    video.currentTime = 0.2; expect(provider.currentFrame()!.frameId).toBe(2);
    video.currentTime = 0; expect(provider.currentFrame()!.frameId).toBe(3);
    const [id, callback] = [...callbacks.entries()][0]!;
    act(() => { callbacks.delete(id); callback(500); });
    expect(renderer.draw).toHaveBeenCalledTimes(2);
    result.unmount();
    expect(video.pause).toHaveBeenCalled(); expect(video.getAttribute("src")).toBeNull();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(() => provider.currentFrame()).toThrow(/retired/);
    expect(prepared.mask.values).toEqual(original); expect(source.bitmap.close).not.toHaveBeenCalled();
  });

  it("waits for decoded data and retires the source while its load is pending", async () => {
    videoReady.mockReturnValue(0);
    const source = photo();
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching mode={9} videoUrl="blob:pending" />);
    expect(mocks.create).not.toHaveBeenCalled();
    const video = videos[0]!; result.unmount(); await settle();
    expect(video.getAttribute("src")).toBeNull(); expect(video.pause).toHaveBeenCalled();
    act(() => video.dispatchEvent(new Event("loadeddata"))); await settle();
    expect(mocks.create).not.toHaveBeenCalled(); expect(callbacks.size).toBe(0);
  });

  it("begins rendering only after loaded data and actual playback are ready", async () => {
    videoReady.mockReturnValue(0);
    const source = photo();
    render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching mode={9} videoUrl="blob:decoded" />);
    const video = videos[0]!;
    expect(video.play).not.toHaveBeenCalled();
    await act(async () => { videoReady.mockReturnValue(2); video.dispatchEvent(new Event("loadeddata")); });
    expect(video.play).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("pauses reduced-motion video without autoplay and resumes only after a deliberate preference change", async () => {
    reduced = true;
    const source = photo();
    render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching mode={9} videoUrl="blob:still" />);
    await settle();
    const video = videos[0]!;
    expect(video.play).not.toHaveBeenCalled(); expect(renderer.draw).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(0);
    await act(async () => motionListeners.forEach(listener => listener({ matches: false } as MediaQueryListEvent)));
    expect(video.play).toHaveBeenCalledTimes(1); expect(callbacks.size).toBe(1);
    act(() => motionListeners.forEach(listener => listener({ matches: true } as MediaQueryListEvent)));
    expect(video.pause).toHaveBeenCalled(); expect(callbacks.size).toBe(0);
  });

  it("reports playback or decoder failures and releases every owned video source", async () => {
    const source = photo(), prepared = maps(source);
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("Playback denied"));
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(prepared)} matching mode={9} videoUrl="blob:denied" />);
    await settle(); expect(screen.getByRole("note").textContent).toContain("Playback denied");
    expect(videos[0]!.getAttribute("src")).toBeNull(); expect(mocks.create).not.toHaveBeenCalled();
    result.rerender(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(prepared)} matching mode={9} videoUrl="blob:decode-failure" />);
    await settle();
    act(() => videos[1]!.dispatchEvent(new Event("error")));
    expect(screen.getByRole("note").textContent).toContain("could not be decoded");
    expect(videos[1]!.getAttribute("src")).toBeNull(); expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending play before renderer acquisition and ignores its late completion", async () => {
    const source = photo(), playing = deferred<void>();
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(playing.promise);
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...previewMaps(maps(source))} matching mode={9} videoUrl="blob:slow-play" />);
    await settle(); expect(mocks.create).not.toHaveBeenCalled();
    result.unmount(); await settle();
    await act(async () => { playing.resolve(undefined); });
    expect(mocks.create).not.toHaveBeenCalled(); expect(videos[0]!.getAttribute("src")).toBeNull();
  });

  it("retires the previous video and GPU owner before replacing the selected clip", async () => {
    const source = photo(), prepared = maps(source), readMaps = previewMaps(prepared);
    const result = render(<PhotoMappingPreview photo={source} previewPhoto={null} {...readMaps} matching mode={9} videoUrl="blob:first" />);
    await settle();
    const firstVideo = videos[0]!, previous = renderer, firstProvider = requested().video!;
    renderer = ownedRenderer(); mocks.create.mockResolvedValue(renderer);
    result.rerender(<PhotoMappingPreview photo={source} previewPhoto={null} {...readMaps} matching mode={9} videoUrl="blob:second" />);
    await settle();
    expect(firstVideo.getAttribute("src")).toBeNull(); expect(firstVideo.pause).toHaveBeenCalled();
    expect(previous.presentation.dispose).toHaveBeenCalledTimes(1); expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(() => firstProvider.currentFrame()).toThrow(/retired/);
    expect(requested().video!.currentFrame()!.image).toBe(videos[1]);
    expect(videos[1]!.getAttribute("src")).toBe("blob:second"); expect(callbacks.size).toBe(1);
  });
});
