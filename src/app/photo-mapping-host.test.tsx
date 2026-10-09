// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { compileGraph } from "@compiler/compile.ts";
import { testCapabilities } from "@compiler/test-support.ts";
import { createFileReference } from "@domain/media/file-reference.ts";
import type { CommandInputSchema } from "@domain/commands/input-schema.ts";
import { encodeFloatMap, type FloatMap } from "@runtime/media/float-map.ts";
import { makePreparedMap, preparedMetadata } from "@runtime/media/prepared-map.ts";
import { FACADE_MASK_DEFAULTS, facadeMaskSettings, type FacadeMaskSettings } from "@runtime/media/facade-mask.ts";
import { linearToSrgb, srgbToLinear } from "@runtime/export/pixel-format.ts";
import { PHOTO_FACADE, PHOTO_MASK, PHOTO_MASK_PERSON } from "@runtime/models/model-catalogue.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import { PHOTO_MAPPING_SHADER } from "./photo-mapping-effects.ts";
import { PhotoMappingHost } from "./photo-mapping-host.tsx";
import type { PreparationPhoto, PreparationProgress } from "./photo-preparation.ts";

const mocks = vi.hoisted(() => ({ broker: vi.fn(), decode: vi.fn(), create: vi.fn(), run: vi.fn(), dispose: vi.fn(), save: vi.fn() }));
vi.mock("@ui/files/retained-files.ts", async importOriginal => ({
  ...await importOriginal<typeof import("@ui/files/retained-files.ts")>(), retainedFiles: mocks.broker,
}));
vi.mock("./photo-preparation.ts", () => ({ createPhotoPreparer: mocks.create,
  decodePreparationPhoto: mocks.decode, savePreparedMap: mocks.save }));

const photoRef = createFileReference("photo", "image", "sculpture.png");
const nightRef = createFileReference("preview-photo", "image", "night.png");
const depthRef = createFileReference("depth-original", "binary", "depth.loomf32");
const maskRef = createFileReference("mask-original", "binary", "mask.loomf32");
const sha256 = "a".repeat(64);
const maps = new Map<string, FloatMap>();
const runtimes: AppRuntime[] = [];
let photo: PreparationPhoto;
let nightPhoto: PreparationPhoto;

function map(kind: "depth" | "mask", side = kind === "depth" ? 518 : 1024): FloatMap {
  return makePreparedMap(kind === "depth" ? Float32Array.from({ length: 16 }, (_, i) => i + 0.125) : new Float32Array(8).fill(1),
    4, kind === "depth" ? 4 : 2, { kind, source: { sha256, width: 4, height: 2 },
      model: { id: kind, url: `https://models.test/${kind}` }, inputSide: side,
      registration: kind === "depth" ? "letterbox" : "stretch" });
}

function facadeMap(detailSide = 1024, settings: FacadeMaskSettings = FACADE_MASK_DEFAULTS, source = photo): FloatMap {
  const prepared = makePreparedMap(new Float32Array(detailSide * 4).fill(1), detailSide, 4, {
    kind: "mask", source: { sha256: source.sha256, width: source.bitmap.width, height: source.bitmap.height },
    model: { id: "facade-surfaces-v1", url: PHOTO_FACADE.url }, inputSide: 512, registration: "stretch",
  });
  return { ...prepared, metadata: { ...prepared.metadata, facade: { version: 1, detailSide,
    envelopeWidth: 64, envelopeHeight: 64, ...settings } } };
}

beforeEach(() => {
  vi.resetAllMocks();
  installDomStubs();
  sessionStorage.clear();
  maps.clear(); maps.set(depthRef, map("depth")); maps.set(maskRef, map("mask"));
  photo = { bitmap: { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap, sha256, name: "sculpture.png" };
  nightPhoto = { bitmap: { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap, sha256: "b".repeat(64), name: "night.png" };
  mocks.decode.mockImplementation(async (url: string) => url.includes(encodeURIComponent(nightRef)) ? nightPhoto : photo);
  mocks.create.mockReturnValue({ run: mocks.run, dispose: mocks.dispose });
  mocks.run.mockImplementation(async (kind: "depth" | "mask", reference: PreparationPhoto, side: number, maskSide?: number, facade?: FacadeMaskSettings) =>
    facade === undefined ? map(kind, kind === "depth" ? side : maskSide) : facadeMap(maskSide, facade, reference));
  let saved = 0;
  mocks.save.mockImplementation(async (prepared: FloatMap) => {
    const reference = createFileReference(`${preparedMetadata(prepared).kind}-saved-${++saved}`, "binary", "prepared.loom-f32");
    maps.set(reference, prepared); return reference;
  });
  mocks.broker.mockReturnValue({ remember: vi.fn(async (handle: { name: string }) =>
    handle.name === "depth.loomf32" ? depthRef : handle.name === "mask.loomf32" ? maskRef : handle.name === "night.png" ? nightRef : photoRef), allow: vi.fn(),
    snapshot: (reference: string) => ({ kind: "ready", url: `https://assets.test/${encodeURIComponent(reference)}` }),
    revision: () => 0, subscribe: () => () => {}, acquire: () => ({ release: vi.fn() }) });
  vi.stubGlobal("showOpenFilePicker", vi.fn(async () => [{ name: "sculpture.png" }]));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const prepared = maps.get(decodeURIComponent(new URL(url).pathname.slice(1)));
    if (prepared === undefined) throw new Error(`Unexpected map fetch ${url}`);
    return { ok: true, arrayBuffer: async () => encodeFloatMap(prepared).buffer };
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage: vi.fn(), putImageData: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(128) }),
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
});
afterEach(() => { cleanup(); runtimes.splice(0).forEach(runtime => runtime.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function runtime() {
  const next = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "projection-test" } });
  runtimes.push(next); return next;
}
async function open(target: AppRuntime, nodeId?: string, strict = false) {
  render(strict ? <StrictMode><PhotoMappingHost runtime={target} /></StrictMode> : <PhotoMappingHost runtime={target} />);
  await act(async () => { await target.bus.execute("photoMapping.prepare", nodeId === undefined ? {} : { nodeIds: [nodeId] }, target.invocation); });
  await screen.findByRole("dialog");
}
async function choosePhoto() {
  await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: "Reference photo" })).getByRole("button", { name: "choose…" })); });
  await waitFor(() => expect((screen.getByRole("button", { name: /^(?:Run|Rerun) depth$/ }) as HTMLButtonElement).disabled).toBe(false));
}
async function chooseMap(kind: "depth" | "mask") {
  vi.mocked(window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker.mockResolvedValueOnce([{ name: `${kind}.loomf32` }]);
  await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: `Existing ${kind} map` })).getByRole("button", { name: "choose…" })); });
}
async function chooseNightPhoto() {
  vi.mocked(window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker.mockResolvedValueOnce([{ name: "night.png" }]);
  await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: "Preview photo (optional)" })).getByRole("button", { name: "choose…" })); });
  await waitFor(() => expect(mocks.decode.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(nightRef)))).toBe(true));
}
async function click(name: string) { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); }
async function existing(target: AppRuntime, previewPhoto?: string) {
  const result = await target.bus.execute("photoMapping.create", { photo: photoRef, depth: depthRef, mask: maskRef,
    width: 4, height: 2, shader: PHOTO_MAPPING_SHADER, ...(previewPhoto === undefined ? {} : { previewPhoto }) }, target.invocation);
  expect(result.status).toBe("applied"); return result.output.createdIds;
}

describe("reusable photo preparation host", () => {
  it("creates full-frame coverage from saved depth with disabled mask controls and no mask work", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    const useMask = screen.getByRole("switch", { name: "Use surface mask" });
    expect(useMask.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(useMask);
    expect(screen.getByText("Full frame · no mask file needed")).toBeDefined();
    const maskPreparation = within(screen.getByRole("region", { name: "Surface mask preparation" }));
    for (const control of [
      maskPreparation.getByRole("combobox", { name: "Mask detail" }),
      maskPreparation.getByRole("button", { name: "Run mask" }),
      maskPreparation.getByRole("button", { name: "Save mask…" }),
      maskPreparation.getByRole("button", { name: "Start manual mask" }),
    ]) expect((control as HTMLButtonElement | HTMLSelectElement).disabled).toBe(true);
    expect(maskPreparation.queryByRole("combobox", { name: "Brush" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Existing mask map" })).queryByRole("button", { name: "choose…" })).toBeNull();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    const coverage = Object.values(graph.nodes).find(node => node.type === "solid")!;
    expect(coverage.parameters.color).toEqual([1, 1, 1, 1]);
    expect(Object.values(graph.nodes).filter(node => node.type === "floatMapIn").map(node => node.parameters.file)).toEqual([depthRef]);
    const maskNode = Object.values(graph.nodes).find(node => node.type === "mask")!;
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === coverage.id && edge.target.nodeId === maskNode.id && edge.target.portId === "mask")).toBe(true);
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities() });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("restores the mask requirement and preserves selected ready masks when toggled back on", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    const useMask = screen.getByRole("switch", { name: "Use surface mask" });
    fireEvent.click(useMask);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(useMask);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Run mask" }) as HTMLButtonElement).disabled).toBe(false);
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    fireEvent.click(useMask);
    expect((screen.getByRole("combobox", { name: "Brush" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Undo stroke" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save mask again…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole("img", { name: "Surface mask editor" }), { clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerUp(screen.getByRole("img", { name: "Surface mask editor" }), { pointerId: 1 });
    });
    fireEvent.click(useMask);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save mask again…" })).toBeDefined();
    await click("Create mapping network");
    expect(Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([0, 4])("warns about a valid mask with %s covered samples without replacing or refusing it", async covered => {
    const values = new Float32Array(32 * 32).fill(0.49);
    values.fill(0.75, 0, covered);
    const metadata = preparedMetadata(map("mask"));
    maps.set(maskRef, makePreparedMap(values, 32, 32, {
      kind: "mask", source: metadata.source, model: metadata.model, inputSide: 1024, registration: "stretch",
    }));
    const originalBytes = encodeFloatMap(maps.get(maskRef)!).slice();
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect(screen.getByText(/Mask covers less than 1% of the photo/)).toBeDefined();
    expect(screen.getByText(/Use full frame or restore the surface with the brush/)).toBeDefined();
    expect(screen.getByRole("switch", { name: "Use surface mask" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(Object.values(graph.nodes).some(node => node.type === "solid")).toBe(false);
    expect(encodeFloatMap(maps.get(maskRef)!)).toEqual(originalBytes);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("retains an explicit full-frame recipe across the legacy-bus reload without inference", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    fireEvent.click(screen.getByRole("switch", { name: "Use surface mask" }));
    const key = `loom.photoMapping.reload.${target.project.projectId}`;
    const replaceCommand = target.bus.replaceCommand;
    const legacyBus = target.bus as unknown as { replaceCommand: unknown };
    try {
      legacyBus.replaceCommand = undefined;
      await click("Create mapping network");
      expect(screen.getByRole("alert").textContent).toMatch(/Reload Loom once.*Saved mapping setup will reopen/i);
      expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ photo: photoRef, depth: depthRef, mask: "", useMask: false });
      expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
      cleanup();
    } finally { legacyBus.replaceCommand = replaceCommand; }
    render(<PhotoMappingHost runtime={target} />);
    await screen.findByRole("dialog"); await screen.findByRole("button", { name: "Save depth again…" });
    expect(screen.getByRole("switch", { name: "Use surface mask" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Full frame · no mask file needed")).toBeDefined();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(sessionStorage.getItem(key)).toBeNull();
    expect(Object.values(target.bus.store.getGraph().nodes).filter(node => node.type === "floatMapIn").map(node => node.parameters.file)).toEqual([depthRef]);
    expect(Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "solid")?.parameters.color).toEqual([1, 1, 1, 1]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("defaults to facade masks and requests independent refinement detail only on demand", async () => {
    const target = runtime(); await open(target);
    const depthDetail = screen.getByRole("combobox", { name: "Detail" });
    const maskDetail = screen.getByRole("combobox", { name: "Mask detail" });
    expect(within(depthDetail).getAllByRole("option").map(option => (option as HTMLOptionElement).value))
      .toEqual(["266", "392", "518", "644", "770", "896", "1036", "1288"]);
    expect(within(maskDetail).getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["1024", "1536"]);
    expect(depthDetail.closest("details")).toBeNull(); expect(maskDetail.closest("details")).toBeNull();
    expect(depthDetail.compareDocumentPosition(screen.getByTestId("depth-preview-frame")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(maskDetail.compareDocumentPosition(screen.getByTestId("mask-preview-frame")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Mask method" }) as HTMLSelectElement).value).toBe("facade");
    expect(screen.getByText(`${PHOTO_FACADE.label} · ${(PHOTO_FACADE.bytes / 1024 / 1024).toFixed(1)} MB · 512 input / 64 scene mask`)).toBeDefined();
    const cutoff = screen.getByRole("slider", { name: /^Opening cutoff/ }) as HTMLInputElement;
    expect([cutoff.value, cutoff.min, cutoff.max]).toEqual(["14", "0", "50"]);
    expect(screen.getByRole("switch", { name: "Exclude blue glass" }).getAttribute("aria-checked")).toBe("true");
    await choosePhoto();
    fireEvent.change(depthDetail, { target: { value: "1288" } });
    fireEvent.change(maskDetail, { target: { value: "1536" } });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
    await click("Run depth"); await click("Run mask");
    expect(mocks.run.mock.calls).toEqual([["depth", photo, 1288], ["mask", photo, 1288, 1536, FACADE_MASK_DEFAULTS]]);
    await click("Save mask…");
    const saved = mocks.save.mock.calls[0]![0] as FloatMap;
    expect(preparedMetadata(saved)).toMatchObject({ inputSide: 512, source: { sha256, width: 4, height: 2 },
      model: { id: "facade-surfaces-v1", url: PHOTO_FACADE.url } });
    expect(facadeMaskSettings(saved)).toEqual({ version: 1, detailSide: 1536, envelopeWidth: 64, envelopeHeight: 64, ...FACADE_MASK_DEFAULTS });
    expect(saved.values).toBeInstanceOf(Float32Array);
    expect(Math.max(saved.width, saved.height)).toBe(1536);
    expect(screen.getByText("Red is excluded · drag to erase or restore")).toBeDefined();
  });

  it.each(["opening cutoff", "blue glass"] as const)("invalidates only a saved facade recipe after changing %s without automatic inference", async setting => {
    maps.set(maskRef, facadeMap());
    const originalBytes = encodeFloatMap(maps.get(maskRef)!).slice();
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    const changed = setting === "opening cutoff" ? { ...FACADE_MASK_DEFAULTS, darkCutoff: srgbToLinear(0.25) }
      : { ...FACADE_MASK_DEFAULTS, excludeBlueGlass: false };
    if (setting === "opening cutoff") fireEvent.change(screen.getByRole("slider", { name: /^Opening cutoff/ }), { target: { value: "25" } });
    else fireEvent.click(screen.getByRole("switch", { name: "Exclude blue glass" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Mask out of date/i);
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save depth again…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(encodeFloatMap(maps.get(maskRef)!)).toEqual(originalBytes);
    await click("Rerun mask");
    expect(mocks.run.mock.calls).toEqual([["mask", photo, 518, 1024, changed]]);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    await click("Save mask…");
    expect(facadeMaskSettings(mocks.save.mock.calls[0]![0])).toMatchObject(changed);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("restores a saved facade recipe and refinement detail despite its 512 model input", async () => {
    const settings = { darkCutoff: srgbToLinear(0.23), feather: 0.025, excludeBlueGlass: false };
    maps.set(maskRef, facadeMap(1536, settings));
    const originalBytes = encodeFloatMap(maps.get(maskRef)!).slice();
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect((screen.getByRole("combobox", { name: "Mask method" }) as HTMLSelectElement).value).toBe("facade");
    expect((screen.getByRole("combobox", { name: "Mask detail" }) as HTMLSelectElement).value).toBe("1536");
    expect((screen.getByRole("slider", { name: /^Opening cutoff/ }) as HTMLInputElement).value)
      .toBe(String(Math.round(linearToSrgb(settings.darkCutoff) * 100)));
    expect(screen.getByRole("switch", { name: "Exclude blue glass" }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    expect(Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(preparedMetadata(maps.get(maskRef)!).inputSide).toBe(512);
    expect(encodeFloatMap(maps.get(maskRef)!)).toEqual(originalBytes);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("uses the explicit background method with four run arguments", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Mask method" }), { target: { value: "background" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Mask detail" }), { target: { value: "1536" } });
    expect(screen.queryByRole("slider", { name: /^Opening cutoff/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Exclude blue glass" })).toBeNull();
    expect(mocks.run).not.toHaveBeenCalled();
    await click("Run mask"); await click("Save mask…");
    expect(mocks.run.mock.calls).toEqual([["mask", photo, 518, 1536]]);
    expect(preparedMetadata(mocks.save.mock.calls[0]![0]).inputSide).toBe(1536);
    expect(facadeMaskSettings(mocks.save.mock.calls[0]![0])).toBeUndefined();
  });

  it("retains the imported facade feather and exclusions on an explicit rerun", async () => {
    const settings = { darkCutoff: 0.047, feather: 0.025, excludeBlueGlass: false };
    maps.set(maskRef, facadeMap(1536, settings));
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect(mocks.run).not.toHaveBeenCalled();
    await click("Rerun mask");
    expect(mocks.run.mock.calls).toEqual([["mask", photo, 518, 1536, settings]]);
    await click("Save mask…");
    expect(facadeMaskSettings(mocks.save.mock.calls[0]![0])).toMatchObject({ ...settings, detailSide: 1536 });
  });

  it("marks excluded facade samples with a red tint while preserving included photo samples and saved values", async () => {
    const prepared = facadeMap();
    prepared.values[0] = 0;
    maps.set(maskRef, prepared);
    const originalBytes = encodeFloatMap(prepared).slice();
    const paint = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation((() => ({
      drawImage: vi.fn(), putImageData: paint, clearRect: vi.fn(), fillRect: vi.fn(),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(128) }),
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    const image = paint.mock.calls.at(-1)![0] as ImageData;
    expect(image.data[0]).toBeGreaterThan(image.data[1]!);
    expect(image.data[0]).toBeGreaterThan(image.data[2]!);
    expect(image.data[0]).toBeGreaterThan(128);
    expect([...image.data.slice(4, 8)]).toEqual([128, 128, 128, 128]);
    expect(screen.getByText("Red is excluded · drag to erase or restore")).toBeDefined();
    expect(encodeFloatMap(prepared)).toEqual(originalBytes);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects a recognized facade mask with a missing recipe instead of reusing it as a background mask", async () => {
    const invalid = facadeMap();
    maps.set(maskRef, { ...invalid, metadata: { preparation: invalid.metadata!.preparation! } });
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Invalid facade mask.*metadata/i));
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("invalidates only the changed mask detail and requires a fresh save after rerunning", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    const maskDetail = screen.getByRole("combobox", { name: "Mask detail" });
    fireEvent.change(maskDetail, { target: { value: "1536" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Mask out of date/i);
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save depth again…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
    fireEvent.change(maskDetail, { target: { value: "1024" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(maskDetail, { target: { value: "1536" } });
    await click("Rerun mask");
    expect(mocks.run.mock.calls).toEqual([["mask", photo, 518, 1536]]);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    await click("Save mask…"); await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")?.parameters.file).toBe(depthRef);
    expect(mocks.save.mock.calls.map(call => preparedMetadata(call[0]).kind)).toEqual(["mask"]);
    expect(preparedMetadata(mocks.save.mock.calls[0]![0]).inputSide).toBe(1536);
  });

  it("keeps a saved mask ready when depth detail changes independently", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    fireEvent.change(screen.getByRole("combobox", { name: "Detail" }), { target: { value: "1288" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Depth out of date/i);
    expect((screen.getByRole("button", { name: "Save mask again…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("combobox", { name: "Mask detail" }) as HTMLSelectElement).value).toBe("1024");
    expect(mocks.run).not.toHaveBeenCalled();
    await click("Rerun depth"); await click("Save depth…"); await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(mocks.run.mock.calls).toEqual([["depth", photo, 1288]]);
    expect(mocks.save.mock.calls.map(call => preparedMetadata(call[0]).kind)).toEqual(["depth"]);
  });

  it.each(["mask", PHOTO_MASK_PERSON.id, PHOTO_MASK.id])("adopts an imported legacy %s mask as background removal without inference or resaving", async modelId => {
    const prepared = map("mask", 1536);
    const metadata = preparedMetadata(prepared);
    maps.set(maskRef, { ...prepared, metadata: { preparation: { ...metadata, model: { ...metadata.model, id: modelId } } } });
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect((screen.getByRole("combobox", { name: "Mask detail" }) as HTMLSelectElement).value).toBe("1536");
    expect((screen.getByRole("combobox", { name: "Mask method" }) as HTMLSelectElement).value).toBe("background");
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("fits a large-photo network while preserving the original bitmap and native map provenance", async () => {
    photo = { ...photo, bitmap: { width: 6512, height: 4341, close: vi.fn() } as unknown as ImageBitmap };
    const originalBitmap = photo.bitmap;
    for (const [reference, kind] of [[depthRef, "depth"], [maskRef, "mask"]] as const) {
      const prepared = map(kind); const metadata = preparedMetadata(prepared);
      maps.set(reference, { ...prepared, metadata: { preparation: { ...metadata,
        source: { sha256, width: 6512, height: 4341 } } } });
    }
    const originalMaps = [maps.get(depthRef)!, maps.get(maskRef)!].map(prepared => ({
      bytes: encodeFloatMap(prepared).slice(), metadata: preparedMetadata(prepared),
    }));
    const target = runtime(); await open(target); await choosePhoto();
    expect(screen.getByRole("note").textContent).toBe("Large photo: network fits within 4096 px, keeping the full frame");
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    expect(photo.bitmap).toBe(originalBitmap);
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull();
    const graph = target.bus.store.getGraph();
    const sources = Object.values(graph.nodes).filter(node => node.type === "movieFileIn" || node.type === "floatMapIn");
    for (const source of sources) expect(source.resolution).toEqual({ mode: "fixed", width: 4096, height: 2730 });
    expect(sources.find(node => node.type === "movieFileIn")?.parameters.file).toBe(photoRef);
    expect(sources.filter(node => node.type === "floatMapIn").map(node => node.parameters.file)).toEqual([depthRef, maskRef]);
    const corner = Object.values(graph.nodes).find(node => node.type === "cornerPin")!;
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities(),
      sinks: [{ nodeId: corner.id, kind: "readback" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(plan.outputs.find(output => output.nodeId === corner.id)?.size).toEqual([4096, 2730]);
    for (const [index, reference] of [depthRef, maskRef].entries()) {
      expect(preparedMetadata(maps.get(reference)!)).toEqual(originalMaps[index]!.metadata);
      expect(encodeFloatMap(maps.get(reference)!)).toEqual(originalMaps[index]!.bytes);
      expect(preparedMetadata(maps.get(reference)!).source).toEqual({ sha256, width: 6512, height: 4341 });
    }
    expect(originalBitmap.width).toBe(6512); expect(originalBitmap.height).toBe(4341);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("runs depth and mask only on demand, saves each separately, and creates one undoable usable network", async () => {
    const target = runtime(); await open(target);
    expect(screen.getByText("Next: Choose a reference photo to begin")).toBeDefined();
    await choosePhoto();
    expect(screen.getByText(/Next: .*depth.*run depth/)).toBeDefined();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
    await click("Run depth");
    expect(screen.getByText("Next: Save depth, then prepare the surface mask")).toBeDefined();
    expect(mocks.run.mock.calls.map(call => call[0])).toEqual(["depth"]);
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    await click("Save depth…");
    expect(screen.getByText(/Next: .*mask.*manual mask/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Save depth again…" })).toBeDefined();
    await click("Run mask");
    expect(screen.getByText("Next: Check the edges, then save the mask")).toBeDefined();
    await click("Save mask…");
    expect(screen.getByText("Next: Create the network, then align Window Out")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save mask again…" })).toBeDefined();
    expect(mocks.save.mock.calls.map(call => preparedMetadata(call[0]).kind)).toEqual(["depth", "mask"]);
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull();
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(11);
    const window = Object.values(graph.nodes).find(node => node.type === "window")!;
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities(),
      sinks: [{ nodeId: window.id, kind: "output" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(Object.keys(target.bus.store.getGraph().nodes)).toHaveLength(0);
  });

  it("creates a preview network from existing depth and mask without generating or saving either map", async () => {
    maps.set(depthRef, map("depth", 392));
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    expect((screen.getByLabelText("Detail") as HTMLSelectElement).value).toBe("392");
    const light = screen.getByRole("slider", { name: /^Preview light/ }) as HTMLInputElement;
    expect([light.value, light.min, light.max]).toEqual(["35", "0", "100"]);
    fireEvent.change(light, { target: { value: "60" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(11);
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")?.parameters)
      .toMatchObject({ file: depthRef, inputSide: "392" });
    expect(Object.values(graph.nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "mask")?.parameters.file).toBe(maskRef);
    const output = Object.values(graph.nodes).find(node => node.type === "output")!;
    const preview = Object.values(graph.nodes).find(node => node.type === "screen")!;
    expect(preview.parameters.opacity).toBe(0.6);
    const coverage = Object.values(graph.nodes).find(node => node.type === "mask")!;
    const reference = Object.values(graph.nodes).find(node => node.type === "level")!;
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === coverage.id && edge.target.nodeId === preview.id && edge.target.portId === "in1")).toBe(true);
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === reference.id && edge.target.nodeId === preview.id && edge.target.portId === "in2")).toBe(true);
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === preview.id && edge.target.nodeId === output.id)).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("can turn reference-photo preview off while retaining a wired main output", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    const previewSwitch = screen.getByRole("switch", { name: "Preview on reference photo" });
    expect(screen.getByText("Preview on reference photo", { selector: "label" })).toBeDefined();
    expect(previewSwitch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(previewSwitch);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(9);
    expect(Object.values(graph.nodes).some(node => node.type === "screen")).toBe(false);
    const output = Object.values(graph.nodes).find(node => node.type === "output")!;
    const corner = Object.values(graph.nodes).find(node => node.type === "cornerPin")!;
    expect(Object.values(graph.edges).some(edge => edge.source.nodeId === corner.id && edge.target.nodeId === output.id)).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("offers all five mapping effects with explanations for mask and depth diagnostics", async () => {
    const target = runtime(); await open(target);
    const finish = within(screen.getByRole("region", { name: "Create or update mapping" }));
    const effect = screen.getByRole("combobox", { name: "First effect" });
    expect(within(effect).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Neon contours", "Prismatic sweep", "Chromatic relief", "Surface trace", "Depth reveal",
    ]);
    fireEvent.change(effect, { target: { value: "3" } });
    expect(finish.getByText(/mask.*bound|bound.*mask/i)).toBeDefined();
    fireEvent.change(effect, { target: { value: "4" } });
    expect(finish.getByText(/depth.*bands/i)).toBeDefined();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([3, 4])("creates the selected diagnostic effect %s from reused maps", async mode => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    fireEvent.change(screen.getByRole("combobox", { name: "First effect" }), { target: { value: String(mode) } });
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    const effect = Object.values(graph.nodes).find(node => node.type === "customWgslMulti")!;
    expect(effect.parameters.mode).toBe(mode);
    const output = Object.values(graph.nodes).find(node => node.type === "output")!;
    const plan = compileGraph({ graph, registry: target.registry, settings: target.settings, capabilities: testCapabilities(),
      sinks: [{ nodeId: output.id, kind: "output" }] });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("uses an optional night photo only for the viewer while keeping the original map source", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await chooseNightPhoto();
    expect(screen.getByRole("img", { name: "Animated mapping preview" })).toBeDefined();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes)).toHaveLength(12);
    const original = Object.values(graph.nodes).find(node => node.type === "movieFileIn" && node.parameters.file === photoRef)!;
    const previewPhoto = Object.values(graph.nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)!;
    const reference = Object.values(graph.nodes).find(node => node.type === "level")!;
    const mapNodes = Object.values(graph.nodes).filter(node => node.type === "floatMapIn");
    expect(mapNodes.map(node => node.parameters.photo)).toEqual([photoRef, photoRef]);
    for (const node of mapNodes) {
      expect(Object.values(graph.edges).some(edge => edge.source.nodeId === original.id && edge.target.nodeId === node.id && edge.target.portId === "picture")).toBe(true);
    }
    expect(Object.values(graph.edges).filter(edge => edge.source.nodeId === previewPhoto.id)).toMatchObject([
      { target: { nodeId: reference.id } },
    ]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts a higher-resolution night photo with matching aspect and resamples only its movie output", async () => {
    nightPhoto = { ...nightPhoto, bitmap: { width: 8, height: 4, close: vi.fn() } as unknown as ImageBitmap };
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await chooseNightPhoto();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const previewPhoto = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)!;
    expect(previewPhoto.resolution).toEqual({ mode: "fixed", width: 4, height: 2 });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reopens the saved night preview and replaces only its movie file and fit without preparing maps", async () => {
    const target = runtime(); const ids = await existing(target, nightRef);
    const before = target.bus.store.getGraph();
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Rerun depth" });
    await screen.findByRole("button", { name: "Rerun mask" });
    const picker = within(screen.getByRole("group", { name: "Preview photo (optional)" }));
    expect(picker.getByText("night.png")).toBeDefined();
    await waitFor(() => expect(mocks.decode.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(nightRef)))).toBe(true));
    const replacement = createFileReference("preview-replacement", "image", "replacement-night.png");
    const replacementPhoto = { ...nightPhoto, name: "replacement-night.png", sha256: "c".repeat(64) };
    mocks.decode.mockImplementation(async (url: string) => url.includes(encodeURIComponent(replacement)) ? replacementPhoto
      : url.includes(encodeURIComponent(nightRef)) ? nightPhoto : photo);
    mocks.broker().remember.mockResolvedValueOnce(replacement);
    vi.mocked(window as unknown as { showOpenFilePicker: ReturnType<typeof vi.fn> }).showOpenFilePicker.mockResolvedValueOnce([{ name: "replacement-night.png" }]);
    await act(async () => { fireEvent.click(picker.getByRole("button", { name: "choose…" })); });
    await waitFor(() => expect(mocks.decode.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(replacement)))).toBe(true));
    fireEvent.change(screen.getByRole("combobox", { name: "Preview fit" }), { target: { value: "fill" } });
    await click("Apply saved maps");
    const after = target.bus.store.getGraph();
    expect(after.nodes[ids.$previewPhoto!]!.parameters.file).toBe(replacement);
    expect(after.nodes[ids.$previewPhoto!]!.parameters.imageFit).toBe("fill");
    for (const [id, node] of Object.entries(before.nodes)) {
      if (id !== ids.$previewPhoto) expect(after.nodes[id]).toEqual(node);
    }
    expect(after.edges).toEqual(before.edges);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(target.bus.store.getGraph().nodes[ids.$previewPhoto!]!.parameters.file).toBe(nightRef);
    expect(target.bus.store.getGraph().nodes[ids.$previewPhoto!]!.parameters.imageFit).toBe(before.nodes[ids.$previewPhoto!]!.parameters.imageFit);
  });

  it.each(["fit", "fill", "stretch"])("warns about different preview framing and persists the chosen %s treatment", async fit => {
    nightPhoto = { ...nightPhoto, bitmap: { width: 8, height: 2, close: vi.fn() } as unknown as ImageBitmap };
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await chooseNightPhoto();
    await screen.findByRole("note", { name: "Preview framing warning" });
    expect(screen.getByRole("note", { name: "Preview framing warning" }).textContent).toMatch(/Different aspect ratio.*alignment/i);
    const fitting = screen.getByRole("combobox", { name: "Preview fit" });
    expect(within(fitting).getAllByRole("option").map(option => option.textContent)).toEqual(["Fit whole image", "Crop to frame", "Stretch to frame"]);
    expect((fitting as HTMLSelectElement).value).toBe("stretch");
    fireEvent.change(fitting, { target: { value: fit } });
    expect(screen.getByText(fit === "fill" ? /Crop removes edges/ : fit === "stretch" ? /Stretch changes proportions/ : /Fit adds borders/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)?.parameters.imageFit).toBe(fit);
    expect(Object.values(graph.nodes).filter(node => node.type === "floatMapIn").map(node => node.parameters.photo)).toEqual([photoRef, photoRef]);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts pixel-rounded day and night resolutions without a framing warning", async () => {
    photo = { ...photo, bitmap: { width: 3000, height: 1688, close: vi.fn() } as unknown as ImageBitmap };
    nightPhoto = { ...nightPhoto, bitmap: { width: 1672, height: 941, close: vi.fn() } as unknown as ImageBitmap };
    for (const [reference, kind] of [[depthRef, "depth"], [maskRef, "mask"]] as const) {
      const prepared = map(kind); const metadata = preparedMetadata(prepared);
      maps.set(reference, { ...prepared, metadata: { preparation: { ...metadata,
        source: { ...metadata.source, width: 3000, height: 1688 } } } });
    }
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await chooseNightPhoto();
    expect(screen.queryByRole("note", { name: "Preview framing warning" })).toBeNull();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Create mapping network");
    const preview = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)!;
    expect(preview.resolution).toEqual({ mode: "fixed", width: 3000, height: 1688 });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refreshes a stale strict creation schema before applying preview fitting and preserves prior undo history", async () => {
    const target = runtime(); await existing(target); const before = target.bus.store.getGraph();
    await open(target);
    const staleHandler = vi.fn(() => { throw new Error("The obsolete creation handler must never run"); });
    // Deliberately emulate an already-running module that predates previewFit.
    const staleSchema = z.object({ photo: z.string(), depth: z.string(), mask: z.string(), width: z.number(), height: z.number(),
      shader: z.string(), effect: z.number().optional(), inputSide: z.number().optional(), previz: z.boolean().optional(),
      previewPhoto: z.string().optional() }).strict() as unknown as CommandInputSchema<"photoMapping.create">;
    target.bus.replaceCommand({ name: "photoMapping.create", inSession: "definition", inputSchema: staleSchema, handler: staleHandler });
    await choosePhoto(); await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" }); await chooseNightPhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Preview fit" }), { target: { value: "fill" } });
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(staleHandler).not.toHaveBeenCalled();
    const createdNight = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)!;
    expect(createdNight.parameters.imageFit).toBe("fill");
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(target.bus.store.getGraph().nodes).toEqual(before.nodes);
    expect(target.bus.store.getGraph().edges).toEqual(before.edges);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("retains saved mapping setup across the one-time legacy-bus reload without inference", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" }); await chooseNightPhoto();
    fireEvent.change(screen.getByRole("combobox", { name: "Preview fit" }), { target: { value: "fill" } });
    fireEvent.change(screen.getByRole("combobox", { name: "First effect" }), { target: { value: "4" } });
    const key = `loom.photoMapping.reload.${target.project.projectId}`;
    const replaceCommand = target.bus.replaceCommand;
    const legacyBus = target.bus as unknown as { replaceCommand: unknown };
    try {
      legacyBus.replaceCommand = undefined;
      await click("Create mapping network");
      expect(screen.getByRole("alert").textContent).toMatch(/Reload Loom once.*Saved mapping setup will reopen/i);
      expect(screen.getByRole("button", { name: "Reload Loom" })).toBeDefined();
      expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ photo: photoRef, depth: depthRef, mask: maskRef,
        previewPhoto: nightRef, previewFit: "fill", mode: 4, previz: true, inputSide: 518 });
      const legacyDraft = JSON.parse(sessionStorage.getItem(key)!) as Record<string, unknown>;
      delete legacyDraft.useMask;
      sessionStorage.setItem(key, JSON.stringify(legacyDraft));
      expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
      cleanup();
    } finally { legacyBus.replaceCommand = replaceCommand; }
    render(<PhotoMappingHost runtime={target} />);
    await screen.findByRole("dialog"); await screen.findByRole("button", { name: "Rerun depth" });
    await screen.findByRole("button", { name: "Rerun mask" });
    expect(screen.getByRole("switch", { name: "Use surface mask" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("combobox", { name: "First effect" }) as HTMLSelectElement).value).toBe("4");
    expect((screen.getByRole("combobox", { name: "Preview fit" }) as HTMLSelectElement).value).toBe("fill");
    expect(within(screen.getByRole("group", { name: "Reference photo" })).getByText("sculpture.png")).toBeDefined();
    expect(within(screen.getByRole("group", { name: "Preview photo (optional)" })).getByText("night.png")).toBeDefined();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull(); expect(sessionStorage.getItem(key)).toBeNull();
    const graph = target.bus.store.getGraph();
    expect(Object.values(graph.nodes).find(node => node.type === "customWgslMulti")?.parameters.mode).toBe(4);
    expect(Object.values(graph.nodes).find(node => node.type === "movieFileIn" && node.parameters.file === nightRef)?.parameters.imageFit).toBe("fill");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("runs depth and mask inference on the original reference after selecting a night preview", async () => {
    const target = runtime(); await open(target); await choosePhoto(); await chooseNightPhoto();
    await click("Run depth"); await click("Run mask");
    expect(mocks.run.mock.calls.map(call => call[0])).toEqual(["depth", "mask"]);
    for (const call of mocks.run.mock.calls) {
      expect(call[1]).toBe(photo); expect(call[1]).not.toBe(nightPhoto);
    }
  });

  it.each(["wrong-kind", "corrupt", "stale"] as const)("rejects an existing %s map without invoking inference", async failure => {
    const target = runtime(); await open(target); await choosePhoto();
    if (failure === "wrong-kind") maps.set(depthRef, map("mask"));
    if (failure === "stale") {
      const prepared = map("depth"); const metadata = preparedMetadata(prepared);
      maps.set(depthRef, { ...prepared, metadata: { preparation: { ...metadata, source: { ...metadata.source, sha256: "b".repeat(64) } } } });
    }
    if (failure === "corrupt") vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })));
    await chooseMap("depth");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(failure === "wrong-kind" ? /prepared depth/i : failure === "stale" ? /Depth out of date/i : /float|header|truncat|short/i));
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reuses saved depth while generating and saving only a missing mask", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await click("Run mask"); await click("Save mask…"); await click("Create mapping network");
    const depth = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    expect(depth.parameters.file).toBe(depthRef);
    expect(mocks.run.mock.calls.map(call => call[0])).toEqual(["mask"]);
    expect(mocks.save.mock.calls.map(call => preparedMetadata(call[0]).kind)).toEqual(["mask"]);
  });

  it.each(["depth", "mask"] as const)("shows measured %s downloads and indeterminate processing and saving only on its own preview", async kind => {
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Rerun mask" });
    const other = kind === "depth" ? "mask" : "depth";
    const label = kind === "depth" ? "Depth" : "Mask";
    const region = within(screen.getByRole("region", { name: kind === "depth" ? "Depth preparation" : "Surface mask preparation" }));
    const previewWell = screen.getByTestId(`${kind}-preview-frame`).parentElement!;
    const otherWell = screen.getByTestId(`${other}-preview-frame`).parentElement!;
    const sourceId = kind === "depth" ? ids.$depth! : ids.$mask!;
    const original = target.bus.store.getGraph().nodes[sourceId]!.parameters.file;
    let finish!: (result: FloatMap) => void;
    mocks.run.mockReturnValueOnce(new Promise<FloatMap>(resolve => { finish = resolve; }));
    const replacement = { ...map(kind), width: 6, height: 6, values: new Float32Array(36).fill(kind === "depth" ? 0.5 : 1) };
    const originalBytes = encodeFloatMap(maps.get(original as string)!).slice();
    const intervals = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await click(`Rerun ${kind}`);
    const intervalIndex = intervals.mock.calls.findIndex(([, delay]) => delay === 1000);
    expect(intervalIndex).toBeGreaterThanOrEqual(0);
    const report = mocks.create.mock.calls[0]![0] as (update: PreparationProgress) => void;
    expect(previewWell.getAttribute("aria-busy")).toBe("true");
    expect(otherWell.getAttribute("aria-busy")).toBe("false");
    expect(within(otherWell).queryByRole("progressbar")).toBeNull();
    await act(async () => { report({ phase: "downloading", message: "47 MB of 94 MB", fraction: 0.5 }); });
    const progress = region.getByRole("progressbar", { name: `${label} preparation progress` });
    expect(progress.getAttribute("max")).toBe("100");
    expect(progress.getAttribute("value")).toBe("50");
    expect(region.getByText("50%")).toBeDefined();
    for (const control of [
      screen.getByRole("button", { name: `Rerun ${kind}` }),
      screen.getByRole("button", { name: `Save ${kind} again…` }),
      screen.getByRole("combobox", { name: "Detail" }),
      screen.getByRole("combobox", { name: "Mask detail" }),
      screen.getByRole("button", { name: "Apply saved maps" }),
    ]) expect((control as HTMLButtonElement | HTMLSelectElement).disabled).toBe(true);
    await act(async () => { report({ phase: "downloading", message: "47 MB" }); });
    expect(progress.hasAttribute("value")).toBe(false);
    await act(async () => { report({ phase: "processing", message: "Running the model on your photo…" }); });
    expect(progress.hasAttribute("value")).toBe(false);
    expect(region.getByText("Process").getAttribute("data-state")).toBe("active");
    const tick = intervals.mock.calls[intervalIndex]![0] as () => void;
    await act(async () => { now = 3000; tick(); });
    expect(region.getByText("2s")).toBeDefined();
    expect(region.queryByText("6 × 6 native samples · float32")).toBeNull();
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(original);
    expect(encodeFloatMap(maps.get(original as string)!)).toEqual(originalBytes);
    await act(async () => { finish(replacement); });
    expect(region.queryByRole("progressbar")).toBeNull();
    expect(previewWell.getAttribute("aria-busy")).toBe("false");
    expect(clearInterval).toHaveBeenCalledWith(intervals.mock.results[intervalIndex]!.value);
    expect((region.getByRole("button", { name: `Save ${kind}…` }) as HTMLButtonElement).disabled).toBe(false);
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(original);
    expect(mocks.save).not.toHaveBeenCalled();
    if (kind === "depth") expect(region.getByText("6 × 6 native samples · float32")).toBeDefined();

    let saved!: (reference: string) => void;
    mocks.save.mockReturnValueOnce(new Promise<string>(resolve => { saved = resolve; }));
    await click(`Save ${kind}…`);
    expect(previewWell.getAttribute("aria-busy")).toBe("true");
    expect(otherWell.getAttribute("aria-busy")).toBe("false");
    expect(region.getByRole("progressbar").hasAttribute("value")).toBe(false);
    const writing = mocks.save.mock.calls[0]![2] as (update: PreparationProgress) => void;
    await act(async () => { writing({ phase: "saving", message: "Writing the float32 map…" }); });
    expect(region.getByText("Save").getAttribute("data-state")).toBe("active");
    expect(region.getByRole("progressbar").hasAttribute("value")).toBe(false);
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(original);
    const reference = createFileReference(`${kind}-progress-saved`, "binary", `${kind}.loomf32`);
    maps.set(reference, replacement);
    await act(async () => { saved(reference); });
    expect(region.queryByRole("progressbar")).toBeNull();
    expect(previewWell.getAttribute("aria-busy")).toBe("false");
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(original);
    await click("Apply saved maps");
    expect(target.bus.store.getGraph().nodes[sourceId]!.parameters.file).toBe(reference);
  });

  it.each(["inference", "saving", "cancelled picker"] as const)("clears progress after %s without replacing the saved map", async failure => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    let fail!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    if (failure === "inference") mocks.run.mockReturnValueOnce(pending);
    else mocks.save.mockReturnValueOnce(pending);
    await click(failure === "inference" ? "Rerun depth" : "Save depth again…");
    const previewWell = screen.getByTestId("depth-preview-frame").parentElement!;
    expect(previewWell.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("progressbar", { name: "Depth preparation progress" })).toBeDefined();
    await act(async () => { fail(failure === "cancelled picker" ? new DOMException("cancelled", "AbortError") : new Error(`${failure} failed`)); });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(previewWell.getAttribute("aria-busy")).toBe("false");
    expect((screen.getByRole("button", { name: "Rerun depth" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save depth again…" }) as HTMLButtonElement).disabled).toBe(false);
    if (failure === "cancelled picker") expect(screen.queryByRole("alert")).toBeNull();
    else expect(screen.getByRole("alert").textContent).toBe(`${failure} failed`);
    expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
    expect(maps.get(depthRef)).toBeDefined();
  });

  it("reloads the same saved depth handle when it is selected after an unsaved rerun", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    await click("Rerun depth");
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await click("Create mapping network");
    expect(screen.queryByRole("dialog")).toBeNull();
    const depth = Object.values(target.bus.store.getGraph().nodes).find(node => node.type === "floatMapIn" && node.parameters.interpretation === "depth")!;
    expect(depth.parameters.file).toBe(depthRef);
    expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("retains existing map selections made before choosing their reference photo", async () => {
    const target = runtime(); await open(target);
    await chooseMap("depth"); await screen.findByRole("button", { name: "Rerun depth" });
    await chooseMap("mask"); await screen.findByRole("button", { name: "Rerun mask" });
    await choosePhoto();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Create mapping network");
    const mapsInGraph = Object.values(target.bus.store.getGraph().nodes).filter(node => node.type === "floatMapIn");
    expect(mapsInGraph.map(node => node.parameters.file).sort()).toEqual([depthRef, maskRef].sort());
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reports an impossible imported depth letterbox without crashing the dialog", async () => {
    photo = { ...photo, bitmap: { width: 100, height: 1, close: vi.fn() } as unknown as ImageBitmap };
    mocks.decode.mockResolvedValue(photo);
    const prepared = map("depth"); const metadata = preparedMetadata(prepared);
    maps.set(depthRef, { ...prepared, width: 2, height: 2, values: new Float32Array([0, 1, 2, 3]),
      metadata: { preparation: { ...metadata, source: { ...metadata.source, width: 100, height: 1 } } } });
    const target = runtime(); await open(target); await choosePhoto(); await chooseMap("depth");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/letterbox band contains no native samples/i));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect((screen.getByRole("button", { name: "Create mapping network" }) as HTMLButtonElement).disabled).toBe(true);
    expect(Object.values(target.bus.store.getGraph().nodes)).toHaveLength(0);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("updates depth detail when an existing map is overwritten under the same retained reference", async () => {
    const target = runtime(); const ids = await existing(target);
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters.inputSide).toBe("518");
    maps.set(depthRef, map("depth", 392));
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Rerun mask" });
    await chooseMap("depth"); await screen.findByRole("button", { name: "Save depth again…" });
    await click("Apply saved maps");
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters).toMatchObject({ file: depthRef, inputSide: "392" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters.inputSide).toBe("518");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reopens saved maps without inference and reruns depth without changing mask or calibration", async () => {
    const target = runtime(); const ids = await existing(target);
    await target.bus.execute("graph.applyPatch", { baseRevision: target.bus.store.getRevision(), operations: [
      { op: "setParameters", nodeId: ids.$grid!, parameters: { p00: [0.1, 0.2] } },
    ] }, target.invocation);
    const before = target.bus.store.getGraph();
    await open(target, ids.$depth);
    await screen.findByRole("button", { name: "Rerun depth" });
    await screen.findByRole("button", { name: "Rerun mask" });
    expect(mocks.create).not.toHaveBeenCalled();
    await click("Rerun depth"); await click("Save depth…"); await click("Apply saved maps");
    const after = target.bus.store.getGraph();
    expect(after.nodes[ids.$mask!]!.parameters).toEqual(before.nodes[ids.$mask!]!.parameters);
    expect(after.nodes[ids.$grid!]).toEqual(before.nodes[ids.$grid!]);
    expect(after.nodes[ids.$corner!]).toEqual(before.nodes[ids.$corner!]);
    expect(after.nodes[ids.$depth!]!.parameters.file).not.toBe(depthRef);
    await target.bus.execute("graph.undo", {}, target.invocation);
    expect(target.bus.store.getGraph().nodes[ids.$depth!]!.parameters.file).toBe(depthRef);
    expect(mocks.run.mock.calls.map(call => call[0])).toEqual(["depth"]);
  });

  it("rejects wrong selections and dry runs without opening a dialog", async () => {
    const target = runtime(); const ids = await existing(target);
    render(<PhotoMappingHost runtime={target} />);
    const dry = await target.bus.execute("photoMapping.prepare", { nodeIds: [ids.$depth!] }, { ...target.invocation, dryRun: true });
    expect(dry.status).toBe("validated"); expect(dry.output.opened).toBe(false);
    const wrong = await target.bus.execute("photoMapping.prepare", { nodeIds: [ids.$photo!] }, target.invocation);
    expect(wrong.status).toBe("rejected"); expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.decode).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });

  it("disposes preparation on close and ignores late inference completion", async () => {
    const target = runtime(); await open(target); await choosePhoto();
    let complete!: (result: FloatMap) => void;
    mocks.run.mockReturnValue(new Promise<FloatMap>(resolve => { complete = resolve; }));
    const clearInterval = vi.spyOn(window, "clearInterval");
    await click("Run depth");
    expect(screen.getByRole("progressbar", { name: "Depth preparation progress" })).toBeDefined();
    await click("Close");
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    const report = mocks.create.mock.calls[0]![0] as (update: PreparationProgress) => void;
    await act(async () => { report({ phase: "processing", message: "Late progress" }); complete(map("depth")); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
    expect(Object.keys(target.bus.store.getGraph().nodes)).toHaveLength(0);
  });

  it("retains a working preparation session after StrictMode effect replay", async () => {
    const target = runtime(); await open(target, undefined, true); await choosePhoto();
    await click("Run depth");
    await screen.findByRole("button", { name: "Rerun depth" });
    expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("paints native high-resolution samples despite a smaller display and preserves radius edits and undo", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const prepared = makePreparedMap(new Float32Array(1536 * 1536).fill(0.75), 1536, 1536, {
      kind: "mask", source: { sha256, width: 4, height: 2 },
      model: { id: "manual", url: "loom:manual-mask" }, inputSide: 1536, registration: "stretch",
    });
    maps.set(maskRef, prepared);
    const target = runtime(); await open(target); await choosePhoto();
    await chooseMap("mask"); await screen.findByRole("button", { name: "Save mask again…" });
    const canvas = screen.getByRole("img", { name: "Surface mask editor" }) as HTMLCanvasElement;
    expect(canvas.width * canvas.height).toBeLessThan(prepared.values.length);
    fireEvent.change(screen.getByRole("slider", { name: /^Radius/ }), { target: { value: "5" } });
    await click("Save mask again…");
    const loaded = mocks.save.mock.calls[0]![0] as FloatMap;
    expect(loaded.values.every(value => Object.is(value, 0.75))).toBe(true);
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 600, clientY: 384, pointerId: 1 });
      fireEvent.pointerCancel(canvas, { pointerId: 1 });
    });
    await click("Save mask…");
    const saved = mocks.save.mock.calls[1]![0] as FloatMap;
    expect([saved.width, saved.height]).toEqual([1536, 1536]);
    expect(saved.values[768 * 1536 + 768]).toBe(0);
    expect(saved.values[768 * 1536 + 900]).toBe(0);
    expect(saved.values[0]).toBe(0.75);
    expect(prepared.values[768 * 1536 + 768]).toBe(0.75);
    await click("Undo stroke"); await click("Save mask…");
    expect(mocks.save.mock.calls[2]![0]).toBe(loaded);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("undoes an entire manual mask stroke before saving without invoking inference", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const target = runtime(); await open(target); await choosePhoto();
    await click("Start manual mask");
    const canvas = screen.getByRole("img", { name: "Surface mask editor" });
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 600, clientY: 400, pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
    });
    await click("Save mask…");
    expect([...mocks.save.mock.calls[0]![0].values]).toEqual(new Array(8).fill(0));
    await click("Undo stroke"); await click("Save mask…");
    expect([...mocks.save.mock.calls[1]![0].values]).toEqual(new Array(8).fill(1));
    expect((screen.getByRole("button", { name: "Undo stroke" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("keeps rerun depth and painted mask when older saved-file loads finish late", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const oldDepth = map("depth"), oldMask = map("mask");
    oldMask.values.fill(0.5);
    let finishDepth!: (bytes: ArrayBuffer) => void, finishMask!: (bytes: ArrayBuffer) => void;
    const depthLoad = new Promise<ArrayBuffer>(resolve => { finishDepth = resolve; });
    const maskLoad = new Promise<ArrayBuffer>(resolve => { finishMask = resolve; });
    const fetchFiles = vi.fn(async (url: string) => ({ ok: true,
      arrayBuffer: () => url.includes(encodeURIComponent(depthRef)) ? depthLoad : maskLoad }));
    vi.stubGlobal("fetch", fetchFiles);
    const metadata = preparedMetadata(oldDepth);
    const freshDepth = makePreparedMap(Float32Array.from({ length: 16 }, (_, i) => 100 + i * 0.5), 4, 4,
      { kind: "depth", source: metadata.source, model: metadata.model, inputSide: 518, registration: "letterbox" });
    mocks.run.mockResolvedValueOnce(freshDepth);
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth);
    await waitFor(() => expect(fetchFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByRole("button", { name: "Run depth" }) as HTMLButtonElement).disabled).toBe(false));
    await click("Run depth"); await click("Start manual mask");
    const canvas = screen.getByRole("img", { name: "Surface mask editor" });
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 512, clientY: 384, pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      finishDepth(encodeFloatMap(oldDepth).buffer as ArrayBuffer);
      finishMask(encodeFloatMap(oldMask).buffer as ArrayBuffer);
    });
    await click("Save depth…"); await click("Save mask…");
    expect([...mocks.save.mock.calls[0]![0].values]).toEqual([...freshDepth.values]);
    expect([...mocks.save.mock.calls[1]![0].values]).toEqual(new Array(8).fill(0));
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("does not reload saved depth when the independent mask handle becomes ready after a depth rerun", async () => {
    let maskReady = false, revision = 0;
    const listeners = new Set<() => void>();
    const broker = mocks.broker();
    mocks.broker.mockReturnValue({ ...broker,
      snapshot: (reference: string) => reference === maskRef && !maskReady ? { kind: "pending" }
        : { kind: "ready", url: `https://assets.test/${encodeURIComponent(reference)}` },
      revision: () => revision,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    });
    const fetchFiles = vi.fn(async (url: string) => {
      const reference = decodeURIComponent(new URL(url).pathname.slice(1));
      const prepared = maps.get(reference);
      if (prepared === undefined) throw new Error(`Unexpected map fetch ${reference}`);
      return { ok: true, arrayBuffer: async () => encodeFloatMap(prepared).buffer };
    });
    vi.stubGlobal("fetch", fetchFiles);
    const metadata = preparedMetadata(map("depth"));
    const freshDepth = makePreparedMap(Float32Array.from({ length: 16 }, (_, i) => 50 + i * 0.25), 4, 4,
      { kind: "depth", source: metadata.source, model: metadata.model, inputSide: 518, registration: "letterbox" });
    mocks.run.mockResolvedValueOnce(freshDepth);
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth); await screen.findByRole("button", { name: "Rerun depth" });
    expect(fetchFiles).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Run mask" })).toBeDefined();
    await click("Rerun depth");
    await act(async () => { maskReady = true; revision++; listeners.forEach(listener => listener()); });
    await screen.findByRole("button", { name: "Rerun mask" });
    expect(fetchFiles.mock.calls.filter(([url]) => url.includes(encodeURIComponent(depthRef)))).toHaveLength(1);
    expect(fetchFiles.mock.calls.filter(([url]) => url.includes(encodeURIComponent(maskRef)))).toHaveLength(1);
    await click("Save depth…");
    expect([...mocks.save.mock.calls[0]![0].values]).toEqual([...freshDepth.values]);
  });

  it("opens a fresh target when preparation is invoked again while a draft is open", async () => {
    const target = runtime(); const ids = await existing(target);
    await open(target); await choosePhoto(); await click("Run depth");
    expect(mocks.create).toHaveBeenCalledOnce();
    await act(async () => { await target.bus.execute("photoMapping.prepare", { nodeIds: [ids.$depth!] }, target.invocation); });
    await screen.findByRole("button", { name: "Apply saved maps" });
    await screen.findByRole("button", { name: "Rerun mask" });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Create mapping network" })).toBeNull();
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Apply saved maps");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(Object.keys(target.bus.store.getGraph().nodes)).toHaveLength(11);
  });

  it("rejects loaded mask samples outside the coverage range explicitly", async () => {
    const invalid = map("mask"); invalid.values[3] = 1.125;
    maps.set(maskRef, invalid);
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$mask);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/mask.*0\.\.1|probabilities.*0\.\.1/i));
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save mask…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("marks saved source dimensions stale even when the photo hash matches", async () => {
    const prepared = map("depth");
    const metadata = preparedMetadata(prepared);
    maps.set(depthRef, { ...prepared, metadata: { preparation: { ...metadata, source: { ...metadata.source, width: 8 } } } });
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Depth out of date/i));
    expect((screen.getByRole("button", { name: "Apply saved maps" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save depth…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["photo", "detail"] as const)("rejects applying when the graph's %s changed while preparation was open", async changed => {
    const target = runtime(); const ids = await existing(target);
    await open(target, ids.$depth); await screen.findByRole("button", { name: "Rerun depth" });
    await click("Rerun depth"); await click("Save depth…");
    await target.bus.execute("graph.applyPatch", { baseRevision: target.bus.store.getRevision(), operations: [
      { op: "setParameters", nodeId: changed === "photo" ? ids.$photo! : ids.$depth!,
        parameters: changed === "photo" ? { file: createFileReference("replacement", "image", "replacement.png") } : { inputSide: "266" } },
    ] }, target.invocation);
    const before = target.bus.store.getGraph();
    await click("Apply saved maps");
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/changed.*preparation|preparation.*changed/i);
    expect(target.bus.store.getGraph()).toEqual(before);
  });
});
