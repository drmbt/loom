// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeUstar } from "@domain/import/ltc-lab/index.ts";
import { parseClipTrack } from "@domain/regions/model.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { TimelinePane } from "./timeline-pane.tsx";

/**
 * VN106 — the timeline's importers through the real bus: the picked file is read and
 * previewed, and nothing changes until "import", which is ONE patch (one undo).
 */
beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const S = 240_000;
const frameAt = (): FrameInputs =>
  ({ frame: { frameIndex: 0, timeSeconds: 0, deltaSeconds: 1 / 30, mode: "realtime", randomSeed: 1, fps: 30 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [8, 8] }) as FrameInputs;

function Pane({ runtime }: { runtime: AppRuntime }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph) as GraphDocument;
  return <TimelinePane graph={graph} bus={runtime.bus} invocation={runtime.invocation} selection={[]} latestFrame={frameAt} fps={30} range={{ start: 0, end: 299 }} />;
}

/** The next `<input type=file>` the pane opens "picks" this file. */
function picks(file: File): void {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    Object.defineProperty(this, "files", { value: [file] });
    this.onchange?.(new Event("change"));
  });
}

const clip = (layer: number, column: number, media: string, ms: number) => `<Clip name="Clip" uniqueId="${layer}${column}" layerIndex="${layer}" columnIndex="${column}">
  <PreloadData><VideoFile value="${media}"/></PreloadData>
  <Transport name="Transport"><Params name="Params"><ParamRange name="Position" T="DOUBLE" default="0" value="0">
    <DurationSource defaultDuration="${ms / 1000}s"/><PhaseSourceTransportTimeline name="PhaseSourceTransportTimeline"><Params name="Params"/></PhaseSourceTransportTimeline>
    <ValueRange name="minMax" min="0" max="${ms}"/></ParamRange></Params></Transport>
  <VideoTrack name="VideoTrack"><VideoSource name="VideoSource" type="VideoFormatReaderSource"><VideoFormatReaderSource fileName="${media}"/></VideoSource></VideoTrack>
</Clip>`;

const AVC = `<?xml version="1.0" encoding="utf-8"?>
<Composition name="Composition" numDecks="1">
  <CompositionInfo name="Show" width="1920" height="1080"><DeckInfo name="Main" id="1"/></CompositionInfo>
  <TempoController name="TempoController"><Params name="Params"><ParamRange name="Tempo" T="DOUBLE" default="120" value="128"/></Params></TempoController>
  <Layer name="Layer" layerIndex="0"><Params name="Params"><Param name="Name" value="Backdrop"/></Params></Layer>
  <Deck name="Deck" deckIndex="0">
    ${clip(0, 0, "/Volumes/Show/a.mov", 2000)}
    ${clip(0, 1, "/Volumes/Show/b.mov", 3000)}
    <Clip name="Clip" uniqueId="9" layerIndex="0" columnIndex="2"><Params name="Params"><Param name="Name" value="gen"/></Params><VideoTrack name="VideoTrack"><VideoSource name="VideoSource" type="GeneratorVideoSource"/></VideoTrack></Clip>
  </Deck>
</Composition>`;

const clipTracks = (runtime: AppRuntime) => Object.values(runtime.bus.store.getGraph().nodes).filter((node) => node.type === "clipTrack");

describe("VN106 — timeline importers", () => {
  it("Import Resolume previews the counts and what is left behind, then makes clip tracks in one patch", async () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
    const view = await act(async () => render(<Pane runtime={runtime} />));
    picks(new File([AVC], "show.avc", { type: "text/xml" }));
    await act(async () => {
      fireEvent.click(view.container.querySelector("[data-import-resolume]")!);
    });
    await waitFor(() => expect(view.container.querySelector("[data-import-dialog=resolume]")).not.toBeNull());
    const dialog = view.container.querySelector("[data-import-dialog=resolume]")!;
    expect(dialog.textContent).toContain("2 regions on 1 tracks");
    expect(dialog.textContent).toContain("2 regions name files on disk");
    expect(dialog.textContent).toContain("1 generator");
    // Previewing changed nothing.
    expect(clipTracks(runtime)).toHaveLength(0);
    await act(async () => {
      fireEvent.click(view.container.querySelector("[data-import-confirm]")!);
    });
    await waitFor(() => expect(clipTracks(runtime)).toHaveLength(1));
    const node = clipTracks(runtime)[0]!;
    expect(node.label).toBe("cliptrack_backdrop");
    expect(storedStaticValue(node.parameters["tempo"])).toBe(128);
    const parsed = parseClipTrack(storedStaticValue(node.parameters["track"]));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.track.regions.map((region) => [region.media, region.timelineStart, region.length])).toEqual([
      ["/Volumes/Show/a.mov", 0, 2 * S],
      ["/Volumes/Show/b.mov", 2 * S, 3 * S],
    ]);
    // The lane draws, and the offline blocks are announced.
    expect(view.container.querySelector("[data-clip-canvas]")).not.toBeNull();
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(clipTracks(runtime)).toHaveLength(0);
  });

  it("Import ltc-lab reads the archive by ranges, binds the track's audio as the reference, and the beat grid appears", async () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
    const view = await act(async () => render(<Pane runtime={runtime} />));
    const text = (value: string) => new TextEncoder().encode(value);
    const project = {
      fps: 30,
      tracks: [{
        id: "song", fileName: "song.wav", title: "SONG", startTC: "01:00:00:00", durationSec: 4,
        lanes: [{ id: "l1", address: "/composition/master", min: 0, max: 1, keyframes: [{ time: 0, value: 0, in: { dt: 0, dv: 0 }, out: { dt: 0, dv: 0 } }, { time: 2, value: 1, in: { dt: 0, dv: 0 }, out: { dt: 0, dv: 0 } }] }],
        markers: [], grid: { bpm: 120, anchor: 0, beatsPerBar: 4, locked: false },
      }],
    };
    const archive = writeUstar([
      { name: "manifest.json", bytes: text(JSON.stringify({ format: "ltcshow", version: 1 })) },
      { name: "project.json", bytes: text(JSON.stringify(project)) },
      { name: "media/audio/song.wav", bytes: new Uint8Array(64).fill(7) },
    ]);
    URL.createObjectURL = () => "blob:song";
    picks(new File([new Uint8Array(archive)], "show.ltcshow.tar"));
    await act(async () => {
      fireEvent.click(view.container.querySelector("[data-import-ltc]")!);
    });
    await waitFor(() => expect(view.container.querySelector("[data-import-dialog=ltc]")?.textContent).toContain("1 lanes"));
    const beatSnap = () => view.container.querySelector<HTMLOptionElement>('select[aria-label="snap"] option[value="bars"]')!;
    expect(beatSnap().disabled).toBe(true);
    await act(async () => {
      fireEvent.click(view.container.querySelector("[data-import-confirm]")!);
    });
    await waitFor(() => expect(Object.values(runtime.bus.store.getGraph().nodes).some((node) => node.label === "audiofile_reference")).toBe(true));
    const audio = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === "audiofile_reference")!;
    expect(storedStaticValue(audio.parameters["file"])).toBe("blob:song#song.wav");
    // The reference declares the track's tempo: the beat snaps are offered.
    await waitFor(() => expect(beatSnap().disabled).toBe(false));
  });
});
