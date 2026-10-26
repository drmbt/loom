import { beforeEach, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { nodeByName } from "@domain/graph/names.ts";
import { parseAutomation } from "@domain/automation/model.ts";
import { parseCueList } from "@domain/presets/cue-list.ts";
import { timelineCueWarnings } from "@domain/presets/timeline-cues.ts";
import { bytesReader, writeUstar } from "@domain/import/ltc-lab/index.ts";
import type { Actor } from "@domain/types/commands.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createAgentToolSurface, type AgentToolSurface } from "./surface.ts";
import type { ImportLtcLabData } from "./tools/ltc-lab.ts";
import type { LocalFilesPort, ToolResult } from "./types.ts";

/**
 * VN100 — `import_ltc_lab` through the REAL surface and bus: the patch lands, the audio is
 * bound the way attach_asset binds it, the project takes the show's rate, a page refuses a
 * path, and the cue list it makes reads with no timeline warning.
 */

const agent: Actor = { kind: "agent", id: "claude" };
const registry = createNodeRegistry(allNodeDefinitions).view();
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const PROJECT = {
  fps: 30,
  tracks: [
    {
      id: "cloud-9",
      fileName: "03 CLOUD 9.wav",
      title: "CLOUD 9",
      startTC: "01:04:42:08",
      durationSec: 10,
      lanes: [{ id: "l1", address: "/composition/layers/4/video/opacity", min: 0, max: 1, enabled: true, keyframes: [{ time: 1, value: 0 }, { time: 2, value: 1 }] }],
      markers: [
        { id: "m1", time: 0, text: "INTRO", notes: "", actions: [{ kind: "bpm", label: "tempo 148" }] },
        { id: "m2", time: 4, text: "verse", notes: "" },
      ],
      grid: { bpm: 148, anchor: 0.029, beatsPerBar: 4 },
    },
  ],
};

const TAR = writeUstar([
  { name: "manifest.json", bytes: text(JSON.stringify({ format: "ltcshow", version: 1 })) },
  { name: "project.json", bytes: text(JSON.stringify(PROJECT)) },
  { name: "tour.json", bytes: text(JSON.stringify({ name: "TOUR", audioDir: "/audio" })) },
  { name: "media/audio/03 CLOUD 9.wav", bytes: text("RIFFfakewav") },
]);
const TAR_BASE64 = Buffer.from(TAR).toString("base64");

let bus: ReturnType<typeof createDomainBus>["bus"];

function surfaceWith(ports: { localFiles?: LocalFilesPort } = {}): AgentToolSurface {
  return createAgentToolSurface({ bus, actor: agent, projectId: "p1", ports });
}

beforeEach(() => {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  bus = createDomainBus({ store, registry }).bus;
});

const call = async (surface: AgentToolSurface, input: unknown): Promise<ToolResult<ImportLtcLabData>> =>
  (await surface.callTool("import_ltc_lab", input)) as ToolResult<ImportLtcLabData>;

describe("import_ltc_lab (VN100)", () => {
  it("imports a track from tar bytes as one patch: audio bound, lanes, cues, project rate", async () => {
    const outcome = await call(surfaceWith(), { tarBase64: TAR_BASE64, trackId: "cloud-9" });
    expect(outcome.status).toBe("ok");
    const graph = bus.store.getGraph();
    const audioId = nodeByName(graph, "audiofile_reference");
    expect(audioId).toBeDefined();
    const audio = graph.nodes[audioId!]!;
    expect(audio.parameters["file"] as string).toMatch(/^blob:.*#03%20CLOUD%209\.wav$/);
    expect(audio.parameters).toMatchObject({ playMode: "timeline", tempoMode: "declared", bpm: 148, beatOffset: 0.029, beatsPerBar: 4 });
    const lanes = parseAutomation(graph.nodes[nodeByName(graph, "automation_cloud_9")!]!.parameters["lanes"]);
    expect(lanes.ok && lanes.document.lanes.map((lane) => lane.keys.map((key) => key.t))).toEqual([[240_000, 480_000]]);
    const listId = nodeByName(graph, "cuelist_cloud_9")!;
    const cues = parseCueList(graph.nodes[listId]!.parameters["cues"]);
    expect(cues.ok && cues.list.cues.map((cue) => [cue.name, cue.at])).toEqual([["INTRO", 0], ["verse", 4]]);
    // Empty presets are a cue the timeline reads without a warning.
    expect(timelineCueWarnings(graph, registry, listId)).toEqual([]);
    expect(bus.store.getSettings()).toMatchObject({ fps: 30, frameRange: { start: 0, end: 299 } });
    expect(outcome.data?.audioBound).toBe(true);
    expect(outcome.data?.settingsApplied).toBe(true);
    expect(outcome.data?.report?.notImported.map((item) => item.what)).toContain("cue actions");
  });

  it("lists the show's tracks and changes nothing without a trackId", async () => {
    const before = bus.store.getGraph();
    const outcome = await call(surfaceWith(), { tarBase64: TAR_BASE64 });
    expect(outcome.status).toBe("ok");
    expect(outcome.data?.tracks?.map((track) => [track.id, track.lanes, track.markers, track.bpm])).toEqual([["cloud-9", 1, 2, 148]]);
    expect(bus.store.getGraph()).toBe(before);
  });

  it("refuses a path in a page, which has no local helper, and says what to pass instead", async () => {
    const outcome = await call(surfaceWith(), { path: "/shows/tinashe.ltcshow.tar", trackId: "cloud-9" });
    expect(outcome.status).toBe("error");
    expect(outcome.diagnostics[0]).toMatchObject({ code: "ltcLab.input" });
    expect(outcome.diagnostics[0]?.suggestion).toContain("tarBase64");
    expect(Object.keys(bus.store.getGraph().nodes)).toHaveLength(0);
  });

  it("reads a path through the helper's port", async () => {
    const inner = bytesReader(TAR);
    const port: LocalFilesPort = {
      size: (path) => (path === "/shows/tinashe.ltcshow.tar" ? inner.size() : Promise.reject(new Error("refused"))),
      read: (path, offset, length) => (path === "/shows/tinashe.ltcshow.tar" ? inner.read(offset, length) : Promise.reject(new Error("refused"))),
    };
    const outcome = await call(surfaceWith({ localFiles: port }), { path: "/shows/tinashe.ltcshow.tar", trackId: "cloud-9", setProjectSettings: false });
    expect(outcome.status).toBe("ok");
    expect(nodeByName(bus.store.getGraph(), "audiofile_reference")).toBeDefined();
    expect(outcome.data?.settingsApplied).toBe(false);
  });

  it("refuses two sources, an unknown track and a show that is not one, by name", async () => {
    const both = await call(surfaceWith(), { tarBase64: TAR_BASE64, projectJson: "{}", trackId: "cloud-9" });
    expect(both.diagnostics[0]).toMatchObject({ code: "ltcLab.input" });
    const unknown = await call(surfaceWith(), { tarBase64: TAR_BASE64, trackId: "nope" });
    expect(unknown.diagnostics[0]).toMatchObject({ code: "ltcLab.malformed", message: 'the show has no track "nope"; it has "cloud-9"' });
    const junk = await call(surfaceWith(), { projectJson: '{"fps":30}', trackId: "x" });
    expect(junk.diagnostics[0]).toMatchObject({ code: "ltcLab.malformed", message: "project.json has no tracks list" });
  });
});
