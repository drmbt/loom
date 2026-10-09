// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newRegion, parseClipTrack, serializeClipTrack } from "@domain/regions/model.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { TimelinePane } from "./timeline-pane.tsx";

/**
 * VN106 — clip tracks in the timeline pane, through the REAL bus: every gesture is one write
 * of the node's `track` text, and one `graph.undo` takes the whole gesture back.
 *
 * Geometry: the default view puts tick 0 at x = 0 at 100 px a second. The clip strip is an
 * 18 px ruler, then a 30 px row per track: the first row's middle is y = 33.
 */
beforeAll(installDomStubs);
afterEach(cleanup);

const S = 240_000;
const ROW = 33;

/** A at 0..2 s (source 0..2 s), B at 4..6 s. */
const TRACK = serializeClipTrack({
  version: 1, id: "t", name: "t",
  regions: [
    newRegion("a", "blob:a#a.mp4", { sourceOut: 2 * S, length: 2 * S }),
    newRegion("b", "/Volumes/Show/b.mov", { sourceOut: 2 * S, timelineStart: 4 * S, length: 2 * S }),
  ],
});

async function runtimeWith(track = TRACK): Promise<{ runtime: AppRuntime; clipId: string }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [{ op: "addNode", ref: "$clip", type: "clipTrack", position: { x: 0, y: 0 }, label: "cliptrack_loops", parameters: { track } }],
    } as never,
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return { runtime, clipId: result.output.createdIds["$clip"]! };
}

const frameAt = (): FrameInputs =>
  ({ frame: { frameIndex: 0, timeSeconds: 0, deltaSeconds: 1 / 30, mode: "realtime", randomSeed: 1, fps: 30 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [8, 8] }) as FrameInputs;

const editors = new Map<AppRuntime, ReturnType<typeof createParameterEditor>>();

function Pane({ runtime, probe }: { runtime: AppRuntime; probe?: (file: File) => Promise<number> }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph) as GraphDocument;
  const editor = useSyncExternalStore(() => () => {}, () => editors.get(runtime)!);
  return (
    <TimelinePane graph={graph} bus={runtime.bus} invocation={runtime.invocation} selection={[]} latestFrame={frameAt}
      fps={30} range={{ start: 0, end: 299 }} editor={editor} {...(probe === undefined ? {} : { probeDuration: probe })} />
  );
}

async function mount(runtime: AppRuntime, probe?: (file: File) => Promise<number>) {
  editors.set(runtime, createParameterEditor({ bus: runtime.bus, context: runtime.invocation, schedule: (callback) => (callback(), () => {}) }));
  const view = await act(async () => render(<Pane runtime={runtime} {...(probe === undefined ? {} : { probe })} />));
  const strip = view.container.querySelector<HTMLCanvasElement>("[data-clip-canvas]")!;
  Object.defineProperty(strip, "clientWidth", { value: 1000 });
  return { view, strip };
}

const regionsOf = (runtime: AppRuntime, nodeId: string) => {
  const parsed = parseClipTrack(storedStaticValue(runtime.bus.store.getGraph().nodes[nodeId]!.parameters["track"]));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.track.regions;
};
const settle = async () => {
  await act(async () => {
    await editors.values().next().value?.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const undo = async (runtime: AppRuntime) => {
  await act(async () => {
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
  });
};
async function drag(strip: HTMLElement, from: number, path: readonly number[], options: { altKey?: boolean } = {}) {
  await act(async () => {
    fireEvent.pointerDown(strip, { clientX: from, clientY: ROW, button: 0, pointerId: 1 });
    for (const x of path) fireEvent.pointerMove(strip, { clientX: x, clientY: ROW, pointerId: 1, altKey: options.altKey ?? false });
    fireEvent.pointerUp(strip, { clientX: path[path.length - 1], clientY: ROW, pointerId: 1 });
  });
  await settle();
}

describe("VN106 — clip tracks in the timeline pane", () => {
  it("draws a lane per clip track, and \"+ track\" adds a clip track node in one patch", async () => {
    const { runtime } = await runtimeWith();
    const { view } = await mount(runtime);
    expect(view.container.querySelector("[data-clip-canvas]")).not.toBeNull();
    await act(async () => {
      fireEvent.click(view.container.querySelector("[data-add-clip-track]")!);
    });
    const tracks = Object.values(runtime.bus.store.getGraph().nodes).filter((node) => node.type === "clipTrack");
    expect(tracks).toHaveLength(2);
    await undo(runtime);
    expect(Object.values(runtime.bus.store.getGraph().nodes).filter((node) => node.type === "clipTrack")).toHaveLength(1);
  });

  it("dragging a region's body moves it, snapped to frames and clamped at its neighbour; one undo", async () => {
    const { runtime, clipId } = await runtimeWith();
    const { strip } = await mount(runtime);
    // Grab A at 1 s (x 100) and drag 1.04 s right: frame snap lands the start on frame 31.
    await drag(strip, 100, [120, 160, 204]);
    expect(regionsOf(runtime, clipId)[0]!.timelineStart).toBe(31 * 8000);
    await undo(runtime);
    expect(regionsOf(runtime, clipId)[0]!.timelineStart).toBe(0);
    // Far right: stops where B starts (A is 2 s long, so at 2 s).
    await drag(strip, 100, [300, 500, 700]);
    expect(regionsOf(runtime, clipId)[0]!.timelineStart).toBe(2 * S);
  });

  it("the right edge trims to the source's end; Alt extends it to loop; each one undo step", async () => {
    const { runtime, clipId } = await runtimeWith();
    const { strip } = await mount(runtime);
    // B's right edge is at x 600. A plain drag out stops at its 2 s of source.
    await drag(strip, 600, [650, 800]);
    expect(regionsOf(runtime, clipId)[1]!.length).toBe(2 * S);
    // Shorter: 1.5 s.
    await drag(strip, 600, [580, 550]);
    expect(regionsOf(runtime, clipId)[1]!.length).toBe(1.5 * S);
    await undo(runtime);
    expect(regionsOf(runtime, clipId)[1]!.length).toBe(2 * S);
    // Alt: out to 9 s, a loop of 2.5 passes.
    await drag(strip, 600, [700, 900], { altKey: true });
    expect(regionsOf(runtime, clipId)[1]).toMatchObject({ length: 5 * S, sourceIn: 0, sourceOut: 2 * S });
    await undo(runtime);
    expect(regionsOf(runtime, clipId)[1]!.length).toBe(2 * S);
  });

  it("the left edge trims the start and slips the source", async () => {
    const { runtime, clipId } = await runtimeWith();
    const { strip } = await mount(runtime);
    await drag(strip, 400, [420, 450]);
    expect(regionsOf(runtime, clipId)[1]).toMatchObject({ timelineStart: 4.5 * S, length: 1.5 * S, sourceIn: 0.5 * S });
  });

  it("the popover sets play mode, direction and BPM sync, each one undo step", async () => {
    const { runtime, clipId } = await runtimeWith();
    const { strip, view } = await mount(runtime);
    await act(async () => {
      fireEvent.pointerDown(strip, { clientX: 100, clientY: ROW, button: 0, pointerId: 1 });
      fireEvent.pointerUp(strip, { clientX: 100, clientY: ROW, pointerId: 1 });
    });
    const field = (name: string) => view.container.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-region-field="${name}"]`)!;
    await act(async () => {
      fireEvent.change(field("playMode"), { target: { value: "bounce" } });
    });
    await settle();
    expect(regionsOf(runtime, clipId)[0]!.playMode).toBe("bounce");
    await act(async () => {
      fireEvent.change(field("direction"), { target: { value: "reverse" } });
    });
    await act(async () => {
      fireEvent.click(field("bpmSyncOn"));
    });
    await settle();
    await act(async () => {
      fireEvent.change(field("beats"), { target: { value: "8" } });
      fireEvent.keyDown(field("beats"), { key: "Enter" });
    });
    await settle();
    expect(regionsOf(runtime, clipId)[0]).toMatchObject({ playMode: "bounce", direction: "reverse", bpmSync: { beats: 8 } });
    await undo(runtime);
    expect(regionsOf(runtime, clipId)[0]!.bpmSync).toEqual({ beats: 4 });
    await act(async () => {
      fireEvent.click(view.container.querySelector("[data-region-delete]")!);
    });
    await settle();
    expect(regionsOf(runtime, clipId).map((region) => region.id)).toEqual(["b"]);
  });

  it("a video dropped on a lane becomes a region at the drop time, as long as the media; audio is refused", async () => {
    const { runtime, clipId } = await runtimeWith();
    const { view, strip } = await mount(runtime, async () => 1.5);
    const video = new File([new Uint8Array(16)], "Loop one.webm", { type: "video/webm" });
    const audio = new File([new Uint8Array(16)], "song.wav", { type: "audio/wav" });
    const lanes = view.container.querySelector<HTMLElement>("[data-clip-lanes]")!;
    URL.createObjectURL = () => "blob:session";
    await act(async () => {
      // jsdom's drop is not a MouseEvent: build one, carrying the files.
      const event = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 700, clientY: ROW });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [video, audio], items: [] } });
      lanes.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    void strip;
    const regions = regionsOf(runtime, clipId);
    expect(regions.map((region) => region.id)).toEqual(["a", "b", "region1"]);
    expect(regions[2]).toMatchObject({ timelineStart: 7 * S, length: 1.5 * S, sourceIn: 0, sourceOut: 1.5 * S, media: "blob:session#Loop%20one.webm" });
    expect(view.container.textContent).toContain("a clip track takes video");
    await undo(runtime);
    expect(regionsOf(runtime, clipId)).toHaveLength(2);
  });

  it("a video dropped ON an offline region relinks it and keeps its timing", async () => {
    const { runtime, clipId } = await runtimeWith();
    const { view } = await mount(runtime, async () => 9);
    const lanes = view.container.querySelector<HTMLElement>("[data-clip-lanes]")!;
    URL.createObjectURL = () => "blob:proxy";
    const proxy = new File([new Uint8Array(16)], "b-proxy.mp4", { type: "video/mp4" });
    await act(async () => {
      const event = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 500, clientY: ROW });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [proxy], items: [] } });
      lanes.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    expect(regionsOf(runtime, clipId)[1]).toMatchObject({ id: "b", media: "blob:proxy#b-proxy.mp4", timelineStart: 4 * S, length: 2 * S, sourceOut: 2 * S });
    expect(regionsOf(runtime, clipId)).toHaveLength(2);
  });
});
