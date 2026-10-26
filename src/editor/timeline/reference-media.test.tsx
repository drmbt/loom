// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { projectRange } from "@domain/types/graph.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { timelineReferenceOf } from "@domain/media/timeline-reference.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { movieWithCodec } from "@editor/media-drop/testing.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { TimelinePane } from "./timeline-pane.tsx";
import { computeWaveformPeaks, type WaveformPeaks } from "./waveform-peaks.ts";

/**
 * VN64 — reference media through the real timeline pane and the real bus: a file dropped on
 * the pane becomes (or replaces the file of) the reference node, one undo takes it back, an
 * existing node is adopted by name, and "length" sets the project range from the media.
 * jsdom decodes nothing, so the waveform loader is injected; what it was asked for is the
 * file the document holds.
 */
beforeAll(() => {
  installDomStubs();
  const url = URL as unknown as { createObjectURL?: (blob: Blob) => string };
  let minted = 0;
  url.createObjectURL ??= () => `blob:test/${++minted}`;
});
afterEach(cleanup);

const frame = (): FrameInputs =>
  ({ frame: { frameIndex: 0, timeSeconds: 0, deltaSeconds: 1 / 30, mode: "realtime", randomSeed: 1, fps: 30 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [8, 8] }) as FrameInputs;

/** 12.5 s of silence: a duration and nothing else. */
const TWELVE_AND_A_HALF: WaveformPeaks = computeWaveformPeaks(new Float32Array(12.5 * 4800), 4800);

function Pane({ runtime, asked }: { runtime: AppRuntime; asked: string[] }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph) as GraphDocument;
  const settings = useSyncExternalStore(runtime.bus.store.subscribe, () => runtime.bus.store.getSettings());
  return (
    <TimelinePane graph={graph} bus={runtime.bus} invocation={runtime.invocation} selection={[]} latestFrame={frame}
      fps={30} range={projectRange(settings)} loadPeaks={async (file) => { asked.push(file); return TWELVE_AND_A_HALF; }} />
  );
}

async function mount() {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const asked: string[] = [];
  const view = await act(async () => render(<Pane runtime={runtime} asked={asked} />));
  const pane = view.container.querySelector<HTMLElement>("[data-timeline-pane]")!;
  return { runtime, asked, view, pane };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function dropOn(pane: HTMLElement, ...files: File[]): Promise<void> {
  await act(async () => {
    fireEvent.drop(pane, { dataTransfer: { files, types: ["Files"], getData: () => "", setData: () => {} } });
    await settle();
  });
}

const byName = (runtime: AppRuntime, name: string) => Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === name);
const param = (node: { parameters: Record<string, unknown> } | undefined, key: string) => storedStaticValue(node?.parameters[key] as never);

describe("reference media on the timeline (VN64)", () => {
  it("a dropped track becomes audiofile_reference, locked to the timeline, its waveform loaded; one undo removes it", async () => {
    const { runtime, asked, pane } = await mount();
    const before = Object.keys(runtime.bus.store.getGraph().nodes);

    await dropOn(pane, new File(["ID3"], "Score Mix.mp3", { type: "audio/mpeg" }));

    const node = byName(runtime, "audiofile_reference");
    expect(node?.type).toBe("audioFileIn");
    expect(String(param(node, "file"))).toMatch(/#Score%20Mix\.mp3$/);
    expect(param(node, "playMode")).toBe("timeline");
    expect(timelineReferenceOf(runtime.bus.store.getGraph())?.nodeId).toBe(node?.id);
    expect(asked).toEqual([param(node, "file")]);

    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(Object.keys(runtime.bus.store.getGraph().nodes)).toEqual(before);
  });

  it("a second drop of the same kind replaces the file; a movie takes over and the old track loses the role", async () => {
    const { runtime, pane } = await mount();
    await dropOn(pane, new File(["ID3"], "a.mp3", { type: "audio/mpeg" }));
    const audioId = byName(runtime, "audiofile_reference")!.id;
    await dropOn(pane, new File(["ID3"], "b.mp3", { type: "audio/mpeg" }));
    expect(byName(runtime, "audiofile_reference")?.id).toBe(audioId);
    expect(String(param(byName(runtime, "audiofile_reference"), "file"))).toMatch(/#b\.mp3$/);

    await dropOn(pane, new File([movieWithCodec("avc1")], "picture.mp4", { type: "video/mp4" }));
    const movie = byName(runtime, "movie_reference");
    expect(param(movie, "playMode")).toBe("timeline");
    // Heard while scored: the movie's own sound is on.
    expect(param(movie, "audio")).toBe(true);
    expect(runtime.bus.store.getGraph().nodes[audioId]?.label).toBe("audiofile1");
    expect(timelineReferenceOf(runtime.bus.store.getGraph())).toMatchObject({ nodeId: movie?.id, warning: null });
  });

  it("refuses a HAP movie by codec with 'transcode first' and makes nothing", async () => {
    const { runtime, pane, view } = await mount();
    const before = runtime.bus.store.getGraph();
    await dropOn(pane, new File([movieWithCodec("Hap1")], "loop.mov", { type: "video/quicktime" }));
    expect(runtime.bus.store.getGraph()).toBe(before);
    expect(view.container.querySelector("[data-timeline-reference-notice]")?.textContent).toContain("HAP (Hap1)");
  });

  it("adopts an existing node by renaming it to the role, rewriting what read it", async () => {
    const { runtime, view } = await mount();
    const made = await runtime.bus.execute("graph.applyPatch", {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        { op: "addNode", ref: "$m", type: "movieFileIn", position: { x: 0, y: 0 }, label: "movie_intro", parameters: { file: "blob:x#intro.mp4" } },
        {
          op: "addNode", ref: "$c", type: "constant", position: { x: 200, y: 0 }, label: "constant_reader",
          parameters: { value: { mode: "expression", bindings: { static: { kind: "static", value: 0 }, expression: { kind: "expression", source: "op('movie_intro').par.speed" } } } },
        },
      ],
    } as never, runtime.invocation);
    expect(made.status).toBe("applied");
    const movieId = made.output.createdIds["$m"]!;
    await act(async () => settle());

    const select = view.container.querySelector<HTMLSelectElement>('select[aria-label="reference media"]')!;
    await act(async () => {
      fireEvent.change(select, { target: { value: movieId } });
      await settle();
    });

    const graph = runtime.bus.store.getGraph();
    expect(graph.nodes[movieId]?.label).toBe("movie_reference");
    expect(param(graph.nodes[movieId], "playMode")).toBe("timeline");
    const reader = Object.values(graph.nodes).find((node) => node.label === "constant_reader")!;
    expect(JSON.stringify(reader.parameters["value"])).toContain("op('movie_reference')");
    // One gesture, one undo.
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(runtime.bus.store.getGraph().nodes[movieId]?.label).toBe("movie_intro");
  });

  it("'length' sets the project range to round(duration × fps) frames", async () => {
    const { runtime, pane, view } = await mount();
    await dropOn(pane, new File(["ID3"], "a.mp3", { type: "audio/mpeg" }));
    const button = Array.from(view.container.querySelectorAll("button")).find((each) => each.textContent?.trim() === "length")!;
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
      await settle();
    });
    // 12.5 s at 30 fps is 375 frames: 0..374.
    expect(projectRange(runtime.bus.store.getSettings())).toEqual({ start: 0, end: 374 });
  });
});
